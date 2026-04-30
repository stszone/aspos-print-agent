/**
 * Integration test — wires buffer + worker + mock printer TCP server.
 *
 * Does NOT require a live Reverb or ASPOS backend. Tests the full
 * handleJob path: receive → buffer → dispatch TCP → report result.
 */

import { jest }        from '@jest/globals';
import net             from 'node:net';
import path            from 'node:path';
import os              from 'node:os';
import fs              from 'node:fs';

// Mock backend HTTP calls
jest.unstable_mockModule('../src/backend.js', () => ({
    channelAuth:  jest.fn().mockResolvedValue({ auth: 'key:sig' }),
    reportResult: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../src/config.js', () => ({
    default: {
        reverbAppKey: 'test_key',
        reverbHost:   'localhost',
        reverbPort:   443,
        reverbScheme: 'https',
        agentId:      7,
        backendUrl:   'http://localhost',
        agentToken:   'aspos_agt_test',
        healthPort:   8585,
        logLevel:     'error',
    },
}));

jest.unstable_mockModule('../src/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { JobBuffer }    = await import('../src/buffer.js');
const { processJob }   = await import('../src/worker.js');
const { reportResult } = await import('../src/backend.js');

describe('integration: processJob', () => {
    let server;
    let serverPort;
    let received;
    let dbPath;
    let buffer;

    beforeEach((done) => {
        received = [];
        server = net.createServer((sock) => { sock.on('data', c => received.push(c)); });
        server.listen(0, '127.0.0.1', () => {
            serverPort = server.address().port;
            dbPath = path.join(os.tmpdir(), `int-${Date.now()}.db`);
            buffer = new JobBuffer(dbPath);
            done();
        });
    });

    afterEach((done) => {
        buffer.close();
        fs.rmSync(dbPath, { force: true });
        jest.clearAllMocks();
        if (server.listening) server.close(done);
        else done();
    });

    function makeJob(overrides = {}) {
        const payload = Buffer.from('ESC @ Hello').toString('base64');
        return {
            job_id:     'job-001',
            printer_id: 1,
            driver:     'network_escpos',
            connection: { host: '127.0.0.1', port: serverPort },
            payload_b64: payload,
            metadata:   { order_id: 1, kind: 'receipt' },
            ...overrides,
        };
    }

    test('successful job: bytes reach mock printer + result reported ok', async () => {
        const job = makeJob();
        buffer.enqueue(job);

        const ok = await processJob(job);

        expect(ok).toBe(true);
        await new Promise(r => setTimeout(r, 50));
        const sent = Buffer.concat(received).toString();
        expect(sent).toContain('Hello');
        expect(reportResult).toHaveBeenCalledWith('job-001', 'ok');
    });

    test('failed job: result reported fail on TCP error', async () => {
        server.close();
        const job = makeJob();
        const ok = await processJob(job);

        expect(ok).toBe(false);
        expect(reportResult).toHaveBeenCalledWith('job-001', 'fail', expect.any(String));
    });

    test('unsupported driver: job fails with driver error', async () => {
        const job = makeJob({ driver: 'clodop' });
        const ok = await processJob(job);

        expect(ok).toBe(false);
        expect(reportResult).toHaveBeenCalledWith('job-001', 'fail', expect.stringContaining('clodop'));
    });

    test('buffer retains job on failure, removes on success', async () => {
        const job = makeJob();
        buffer.enqueue(job);

        // Simulate failure by closing server before processing
        server.close();
        await new Promise(r => setTimeout(r, 20));

        const ok1 = await processJob(job);
        expect(ok1).toBe(false);
        buffer.recordFailure(job.job_id);
        expect(buffer.dueJobs()).toHaveLength(0); // backoff applied

        // Reopen server
        await new Promise((resolve) => {
            server = net.createServer((sock) => { sock.on('data', c => received.push(c)); });
            server.listen(serverPort, '127.0.0.1', resolve);
        });

        // Force job back into due queue by resetting next_retry_at
        buffer.db.prepare('UPDATE jobs SET next_retry_at = 0 WHERE job_id = ?').run(job.job_id);

        const due = buffer.dueJobs();
        expect(due).toHaveLength(1);
        const ok2 = await processJob(due[0]);
        expect(ok2).toBe(true);
        buffer.remove(job.job_id);
        expect(buffer.dueJobs()).toHaveLength(0);
    });
});
