/**
 * PrintHistory — stores the last N successfully printed receipts in SQLite.
 *
 * Used by the EmergencyReprint feature: if the backend is unreachable, staff
 * can browse recent receipts via the local health server and trigger a reprint
 * directly from the agent.
 */

import Database from 'better-sqlite3';
import logger from './logger.js';

const MAX_HISTORY = 50;

export class PrintHistory {
    constructor(dbPath = './agent-history.db') {
        this.db = new Database(dbPath);
        this._migrate();
    }

    _migrate() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS print_history (
                job_id       TEXT PRIMARY KEY,
                store_id     INTEGER,
                kind         TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                printed_at   INTEGER NOT NULL
            );
        `);
    }

    /**
     * Record a successfully printed job.
     * Trims the table to MAX_HISTORY entries after insert.
     */
    record(job) {
        const { job_id, store_id, kind } = job;
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO print_history (job_id, store_id, kind, payload_json, printed_at)
            VALUES (?, ?, ?, ?, ?)
        `);
        stmt.run(job_id, store_id ?? null, kind ?? 'receipt', JSON.stringify(job), Date.now());

        // Keep only the most recent MAX_HISTORY rows
        this.db.prepare(`
            DELETE FROM print_history
            WHERE job_id NOT IN (
                SELECT job_id FROM print_history
                ORDER BY printed_at DESC
                LIMIT ?
            )
        `).run(MAX_HISTORY);

        logger.debug('history: recorded job', { job_id });
    }

    /**
     * Return the most recent `limit` history entries (newest first).
     * Each entry includes all original job fields plus `printed_at_ms`.
     */
    recent(limit = 20) {
        return this.db.prepare(`
            SELECT job_id, store_id, kind, payload_json, printed_at
            FROM print_history
            ORDER BY printed_at DESC
            LIMIT ?
        `).all(limit).map(row => ({
            ...JSON.parse(row.payload_json),
            printed_at_ms: row.printed_at,
        }));
    }

    close() {
        this.db.close();
    }
}
