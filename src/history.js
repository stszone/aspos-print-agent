/**
 * sql.js-backed print history store (last MAX_HISTORY receipts).
 *
 * Used by the EmergencyReprint feature: if the backend is unreachable, staff
 * can browse recent receipts via the local health server and trigger a reprint
 * directly from the agent.
 *
 * Durability: writes are debounced (5 s) because history is informational —
 * losing the last few entries on a crash is acceptable.
 */

import fs from 'node:fs';
import logger from './logger.js';
import { getSqlJs } from './sqljs.js';

const MAX_HISTORY   = 50;
const SAVE_DEBOUNCE = 5_000;

export class PrintHistory {
    constructor(db, dbPath) {
        this.db      = db;
        this._dbPath = dbPath;
        this._timer  = null;
    }

    static async create(dbPath = './agent-history.db') {
        const SQL = await getSqlJs();
        let db;
        try {
            const stored = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
            db = new SQL.Database(stored);
        } catch (err) {
            logger.error('history: failed to open existing DB, starting fresh', { err: err.message });
            db = new SQL.Database();
        }
        const hist = new PrintHistory(db, dbPath);
        hist._migrate();
        hist._scheduleSave();
        return hist;
    }

    _migrate() {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS print_history (
                job_id       TEXT PRIMARY KEY,
                store_id     INTEGER,
                kind         TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                printed_at   INTEGER NOT NULL
            );
        `);
    }

    _scheduleSave() {
        if (this._timer) clearTimeout(this._timer);
        this._timer = setTimeout(() => {
            this._timer = null;
            this._writeToDisk();
        }, SAVE_DEBOUNCE);
    }

    _writeToDisk() {
        try {
            fs.writeFileSync(this._dbPath, this.db.export());
        } catch (err) {
            logger.error('history: failed to persist', { err: err.message });
        }
    }

    /**
     * Record a successfully printed job.
     * Trims the table to MAX_HISTORY entries after insert.
     */
    record(job) {
        const { job_id, store_id, kind } = job;
        this.db.run(
            'INSERT OR REPLACE INTO print_history (job_id, store_id, kind, payload_json, printed_at) VALUES (?, ?, ?, ?, ?)',
            [job_id, store_id ?? null, kind ?? 'receipt', JSON.stringify(job), Date.now()]
        );
        this.db.run(
            `DELETE FROM print_history WHERE job_id NOT IN (
                SELECT job_id FROM print_history ORDER BY printed_at DESC LIMIT ?
             )`,
            [MAX_HISTORY]
        );
        this._scheduleSave();
        logger.debug('history: recorded job', { job_id });
    }

    /**
     * Return the most recent `limit` history entries (newest first).
     * Each entry includes all original job fields plus `printed_at_ms`.
     */
    recent(limit = 20) {
        const stmt = this.db.prepare(
            'SELECT payload_json, printed_at FROM print_history ORDER BY printed_at DESC LIMIT ?'
        );
        stmt.bind([limit]);
        const rows = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            try {
                rows.push({ ...JSON.parse(row.payload_json), printed_at_ms: row.printed_at });
            } catch {
                logger.warn('history: skipping row with malformed payload_json', { printed_at: row.printed_at });
            }
        }
        stmt.free();
        return rows;
    }

    close() {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
            this._writeToDisk();
        }
        this.db.close();
    }
}
