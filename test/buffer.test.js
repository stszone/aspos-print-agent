import { JobBuffer } from '../src/buffer.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

function tmpDb() {
    return path.join(os.tmpdir(), `test-buffer-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('JobBuffer', () => {
    let buf;
    let dbPath;

    beforeEach(() => {
        dbPath = tmpDb();
        buf = new JobBuffer(dbPath);
    });

    afterEach(() => {
        buf.close();
        fs.rmSync(dbPath, { force: true });
    });

    const job = () => ({ job_id: 'abc-123', payload_b64: 'AABB', driver: 'network_escpos' });

    test('enqueue persists job', () => {
        buf.enqueue(job());
        const due = buf.dueJobs();
        expect(due).toHaveLength(1);
        expect(due[0].job_id).toBe('abc-123');
    });

    test('enqueue is idempotent', () => {
        buf.enqueue(job());
        buf.enqueue(job());
        expect(buf.dueJobs()).toHaveLength(1);
    });

    test('remove deletes job', () => {
        buf.enqueue(job());
        buf.remove('abc-123');
        expect(buf.dueJobs()).toHaveLength(0);
    });

    test('recordFailure increments attempt count', () => {
        buf.enqueue(job());
        buf.recordFailure('abc-123');
        // After first failure backoff is 2^1 * 1000 = 2 s — not immediately due
        expect(buf.dueJobs()).toHaveLength(0);
    });

    test('job becomes abandoned after MAX_ATTEMPTS', () => {
        buf.enqueue(job());
        for (let i = 0; i < 30; i++) buf.recordFailure('abc-123');
        expect(buf.abandonedJobs()).toHaveLength(1);
        expect(buf.dueJobs()).toHaveLength(0);
    });

    test('removeAbandoned cleans abandoned job', () => {
        buf.enqueue(job());
        for (let i = 0; i < 30; i++) buf.recordFailure('abc-123');
        buf.removeAbandoned('abc-123');
        expect(buf.abandonedJobs()).toHaveLength(0);
    });

    test('job becomes abandoned after TTL exceeded', () => {
        // Manually insert a very old job
        buf.enqueue(job());
        const old = Date.now() - 25 * 60 * 60 * 1000; // 25 h ago
        buf.db.prepare('UPDATE jobs SET received_at = ? WHERE job_id = ?').run(old, 'abc-123');
        buf.recordFailure('abc-123');
        expect(buf.abandonedJobs()).toHaveLength(1);
    });
});
