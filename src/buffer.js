/**
 * sql.js-backed offline job buffer.
 *
 * Jobs are inserted when received from Reverb. Successful prints delete them.
 * Failed prints increment attempt_count and set next_retry_at.
 * After MAX_ATTEMPTS or 24 h the job is marked abandoned for upstream reporting.
 *
 * Durability: every write is flushed to disk synchronously (db.export →
 * writeFileSync) so no jobs are lost if the process crashes between operations.
 */

import fs from 'node:fs';
import logger from './logger.js';
import { getSqlJs } from './sqljs.js';

const MAX_ATTEMPTS = 30;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 h

export class JobBuffer {
    constructor(db, dbPath) {
        this.db      = db;
        this._dbPath = dbPath;
    }

    static async create(dbPath = './agent-buffer.db') {
        const SQL    = await getSqlJs();
        const stored = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
        const db     = new SQL.Database(stored);
        const buf    = new JobBuffer(db, dbPath);
        buf._migrate();
        buf._persist();
        return buf;
    }

    _migrate() {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS jobs (
                job_id          TEXT PRIMARY KEY,
                payload_json    TEXT NOT NULL,
                received_at     INTEGER NOT NULL,
                attempt_count   INTEGER NOT NULL DEFAULT 0,
                next_retry_at   INTEGER NOT NULL DEFAULT 0,
                abandoned       INTEGER NOT NULL DEFAULT 0
            );
        `);
    }

    _persist() {
        try {
            fs.writeFileSync(this._dbPath, this.db.export());
        } catch (err) {
            logger.error('buffer: failed to persist', { err: err.message });
        }
    }

    _get(sql, params = []) {
        const stmt = this.db.prepare(sql);
        stmt.bind(params);
        const row = stmt.step() ? stmt.getAsObject() : null;
        stmt.free();
        return row;
    }

    _all(sql, params = []) {
        const stmt = this.db.prepare(sql);
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
    }

    /** Persist a newly received job. No-op if already present (idempotent). */
    enqueue(job) {
        this.db.run(
            'INSERT OR IGNORE INTO jobs (job_id, payload_json, received_at) VALUES (?, ?, ?)',
            [job.job_id, JSON.stringify(job), Date.now()]
        );
        this._persist();
        logger.debug('buffer: enqueued job', { job_id: job.job_id });
    }

    /** Remove a successfully printed job. */
    remove(jobId) {
        this.db.run('DELETE FROM jobs WHERE job_id = ?', [jobId]);
        this._persist();
        logger.debug('buffer: removed job', { job_id: jobId });
    }

    /**
     * Record a failed attempt. Computes exponential backoff delay.
     * Marks abandoned if over MAX_ATTEMPTS or TTL exceeded.
     */
    recordFailure(jobId) {
        const row = this._get('SELECT * FROM jobs WHERE job_id = ?', [jobId]);
        if (!row) return;

        const attempts  = row.attempt_count + 1;
        const ageMs     = Date.now() - row.received_at;
        const abandoned = attempts >= MAX_ATTEMPTS || ageMs >= TTL_MS ? 1 : 0;

        // Exponential backoff: 2^attempt seconds, max 5 min
        const backoffMs = Math.min(Math.pow(2, attempts) * 1000, 5 * 60 * 1000);
        const nextRetry = Date.now() + backoffMs;

        this.db.run(
            'UPDATE jobs SET attempt_count = ?, next_retry_at = ?, abandoned = ? WHERE job_id = ?',
            [attempts, nextRetry, abandoned, jobId]
        );
        this._persist();

        if (abandoned) {
            logger.warn('buffer: job abandoned after max attempts/TTL', { job_id: jobId, attempts });
        }
    }

    /** Return jobs that are due for retry (not abandoned, next_retry_at <= now). */
    dueJobs() {
        return this._all(
            'SELECT payload_json FROM jobs WHERE abandoned = 0 AND next_retry_at <= ?',
            [Date.now()]
        ).map(r => JSON.parse(r.payload_json));
    }

    /** Return all jobs that exceeded limits — caller should report them upstream. */
    abandonedJobs() {
        return this._all('SELECT payload_json FROM jobs WHERE abandoned = 1')
            .map(r => JSON.parse(r.payload_json));
    }

    /** Remove a job from the abandoned list after reporting it. */
    removeAbandoned(jobId) {
        this.db.run('DELETE FROM jobs WHERE job_id = ? AND abandoned = 1', [jobId]);
        this._persist();
    }

    /** Reset next_retry_at to 0 so the job is immediately due. Test helper only. */
    _resetRetryForTest(jobId) {
        this.db.run('UPDATE jobs SET next_retry_at = 0 WHERE job_id = ?', [jobId]);
    }

    close() {
        this.db.close();
    }
}
