/**
 * SQLite-backed offline job buffer.
 *
 * Jobs are inserted when received from Reverb. Successful prints delete them.
 * Failed prints increment attempt_count and set next_retry_at.
 * After MAX_ATTEMPTS or 24 h the job is marked abandoned for upstream reporting.
 */

import Database from 'better-sqlite3';
import logger from './logger.js';

const MAX_ATTEMPTS = 30;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 h

export class JobBuffer {
    constructor(dbPath = './agent-buffer.db') {
        this.db = new Database(dbPath);
        this._migrate();
    }

    _migrate() {
        this.db.exec(`
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

    /** Persist a newly received job. No-op if already present (idempotent). */
    enqueue(job) {
        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO jobs (job_id, payload_json, received_at)
            VALUES (?, ?, ?)
        `);
        stmt.run(job.job_id, JSON.stringify(job), Date.now());
        logger.debug('buffer: enqueued job', { job_id: job.job_id });
    }

    /** Remove a successfully printed job. */
    remove(jobId) {
        this.db.prepare('DELETE FROM jobs WHERE job_id = ?').run(jobId);
        logger.debug('buffer: removed job', { job_id: jobId });
    }

    /**
     * Record a failed attempt. Computes exponential backoff delay.
     * Marks abandoned if over MAX_ATTEMPTS or TTL exceeded.
     */
    recordFailure(jobId) {
        const row = this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId);
        if (!row) return;

        const attempts = row.attempt_count + 1;
        const ageMs    = Date.now() - row.received_at;
        const abandoned = attempts >= MAX_ATTEMPTS || ageMs >= TTL_MS ? 1 : 0;

        // Exponential backoff: 2^attempt seconds, max 5 min
        const backoffMs = Math.min(Math.pow(2, attempts) * 1000, 5 * 60 * 1000);
        const nextRetry  = Date.now() + backoffMs;

        this.db.prepare(`
            UPDATE jobs
            SET attempt_count = ?, next_retry_at = ?, abandoned = ?
            WHERE job_id = ?
        `).run(attempts, nextRetry, abandoned, jobId);

        if (abandoned) {
            logger.warn('buffer: job abandoned after max attempts/TTL', { job_id: jobId, attempts });
        }
    }

    /** Return jobs that are due for retry (not abandoned, next_retry_at <= now). */
    dueJobs() {
        return this.db.prepare(`
            SELECT payload_json FROM jobs
            WHERE abandoned = 0 AND next_retry_at <= ?
        `).all(Date.now()).map(r => JSON.parse(r.payload_json));
    }

    /** Return all jobs that exceeded limits — caller should report them upstream. */
    abandonedJobs() {
        return this.db.prepare(`
            SELECT payload_json FROM jobs WHERE abandoned = 1
        `).all().map(r => JSON.parse(r.payload_json));
    }

    /** Remove a job from the abandoned list after reporting it. */
    removeAbandoned(jobId) {
        this.db.prepare('DELETE FROM jobs WHERE job_id = ? AND abandoned = 1').run(jobId);
    }

    close() {
        this.db.close();
    }
}
