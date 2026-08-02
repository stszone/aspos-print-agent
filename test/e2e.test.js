/**
 * Agent E2E integration tests — mock HTTP backend.
 *
 * Spins up a real HTTP server that mimics the ASPOS backend's two agent
 * endpoints (channel-auth + result). Uses real fetch() calls through backend.js
 * so the full transport path is exercised without a live server.
 *
 * Does NOT require Reverb, a real printer, or a database.
 */

import { jest }      from '@jest/globals';
import http          from 'node:http';
import net           from 'node:net';
import path          from 'node:path';
import os            from 'node:os';
import fs            from 'node:fs';

// ---------------------------------------------------------------------------
// Minimal config mock — override BACKEND_URL after we know the mock port.
// The config mock must be registered before importing backend.js.
// ---------------------------------------------------------------------------
let mockBackendUrl = 'http://localhost:9999'; // placeholder; updated in beforeAll

jest.unstable_mockModule('../src/config.js', () => ({
    default: {
        get backendUrl()   { return mockBackendUrl; },
        reverbAppKey: 'test_key',
        reverbHost:   'localhost',
        reverbPort:   443,
        reverbScheme: 'https',
        agentId:      7,
        agentToken:   'aspos_agt_test',
        healthPort:   8585,
        logLevel:     'error',
    },
}));

jest.unstable_mockModule('../src/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { channelAuth, reportResult } = await import('../src/backend.js');
const { processJob }                = await import('../src/worker.js');
const { JobBuffer }                 = await import('../src/buffer.js');

// ---------------------------------------------------------------------------
// Mock backend server helpers
// ---------------------------------------------------------------------------

function createMockBackend({ authStatus = 200, resultStatus = 200 } = {}) {
    const received = { auth: [], results: [] };

    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');

            if (req.url.includes('/broadcasting/agent-auth')) {
                received.auth.push({ headers: req.headers, body });
                if (authStatus === 200) {
                    res.writeHead(200);
                    res.end(JSON.stringify({ auth: 'mock_key:mock_sig' }));
                } else {
                    res.writeHead(authStatus);
                    res.end(JSON.stringify({ message: 'Unauthorized' }));
                }
                return;
            }

            if (req.url.includes('/print-agents/result')) {
                received.results.push({ headers: req.headers, body: JSON.parse(body || '{}') });
                if (resultStatus === 200) {
                    res.writeHead(200);
                    res.end(JSON.stringify({ status: 'success', message: '' }));
                } else {
                    res.writeHead(resultStatus);
                    res.end(JSON.stringify({ message: 'Error' }));
                }
                return;
            }

            res.writeHead(404);
            res.end(JSON.stringify({ message: 'Not found' }));
        });
    });

    return { server, received };
}

function listenAsync(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closeAsync(server) {
    return new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
}

// ---------------------------------------------------------------------------
// channelAuth() — real HTTP, mock backend
// ---------------------------------------------------------------------------

describe('channelAuth() — real HTTP to mock backend', () => {
    let server, received, port;

    beforeEach(async () => {
        ({ server, received } = createMockBackend({ authStatus: 200 }));
        port = await listenAsync(server);
        mockBackendUrl = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
        await closeAsync(server);
        jest.clearAllMocks();
    });

    test('sends Authorization header and returns auth token from server', async () => {
        const result = await channelAuth('socket.123', 'private-aspos.agents.testtenant.7');

        expect(result).toEqual({ auth: 'mock_key:mock_sig' });
        expect(received.auth).toHaveLength(1);

        const req = received.auth[0];
        expect(req.headers.authorization).toBe('Bearer aspos_agt_test');
        expect(req.body).toContain('socket_id=socket.123');
        expect(req.body).toContain('channel_name=private-aspos.agents.testtenant.7');
    });

    test('throws on non-200 response', async () => {
        await closeAsync(server);
        ({ server, received } = createMockBackend({ authStatus: 401 }));
        port = await listenAsync(server);
        mockBackendUrl = `http://127.0.0.1:${port}`;

        await expect(channelAuth('socket.1', 'private-aspos.agents.testtenant.7'))
            .rejects.toThrow(/401/);
    });
});

// ---------------------------------------------------------------------------
// reportResult() — real HTTP, mock backend
// ---------------------------------------------------------------------------

describe('reportResult() — real HTTP to mock backend', () => {
    let server, received, port;

    beforeEach(async () => {
        ({ server, received } = createMockBackend({ resultStatus: 200 }));
        port = await listenAsync(server);
        mockBackendUrl = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
        await closeAsync(server);
        jest.clearAllMocks();
    });

    test('reports ok result with correct payload and auth header', async () => {
        await reportResult('job-abc', 'ok');

        expect(received.results).toHaveLength(1);
        const req = received.results[0];
        expect(req.headers.authorization).toBe('Bearer aspos_agt_test');
        expect(req.body).toMatchObject({ job_id: 'job-abc', status: 'ok' });
    });

    test('reports fail result with error string', async () => {
        await reportResult('job-abc', 'fail', 'Connection refused');

        expect(received.results).toHaveLength(1);
        const req = received.results[0];
        expect(req.body).toMatchObject({
            job_id: 'job-abc',
            status: 'fail',
            error:  'Connection refused',
        });
    });

    test('does not throw on backend error response — logs warning instead', async () => {
        await closeAsync(server);
        ({ server, received } = createMockBackend({ resultStatus: 500 }));
        port = await listenAsync(server);
        mockBackendUrl = `http://127.0.0.1:${port}`;

        // reportResult swallows HTTP errors (it's best-effort)
        await expect(reportResult('job-xyz', 'ok')).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// processJob() + reportResult() — end-to-end with mock TCP printer + mock backend
// ---------------------------------------------------------------------------

describe('processJob() end-to-end: mock printer TCP + mock backend HTTP', () => {
    let backendServer, backendReceived, backendPort;
    let printerServer, printerPort, printerReceived;
    let dbPath, buffer;

    beforeEach(async () => {
        // Mock backend
        ({ server: backendServer, received: backendReceived } = createMockBackend());
        backendPort = await listenAsync(backendServer);
        mockBackendUrl = `http://127.0.0.1:${backendPort}`;

        // Mock TCP printer
        printerReceived = [];
        printerServer = net.createServer(sock => {
            sock.on('data', chunk => printerReceived.push(chunk));
        });
        await new Promise(resolve => printerServer.listen(0, '127.0.0.1', resolve));
        printerPort = printerServer.address().port;

        // Buffer
        dbPath = path.join(os.tmpdir(), `e2e-${Date.now()}.db`);
        buffer = await JobBuffer.create(dbPath);
    });

    afterEach(async () => {
        buffer.close();
        fs.rmSync(dbPath, { force: true });
        jest.clearAllMocks();
        if (backendServer.listening)  await closeAsync(backendServer);
        if (printerServer.listening)  await closeAsync(printerServer);
    });

    function makeJob(overrides = {}) {
        return {
            job_id:      'e2e-job-001',
            printer_id:  1,
            driver:      'network_escpos',
            connection:  { host: '127.0.0.1', port: printerPort },
            payload_b64: Buffer.from('ESC @ receipt data').toString('base64'),
            metadata:    { order_id: 1, kind: 'receipt' },
            ...overrides,
        };
    }

    test('full path: job dispatched → bytes sent to printer → result reported ok', async () => {
        const job = makeJob();
        buffer.enqueue(job);

        const ok = await processJob(job);

        expect(ok).toBe(true);

        // Allow printer server async data event to fire
        await new Promise(r => setTimeout(r, 50));
        const sent = Buffer.concat(printerReceived).toString();
        expect(sent).toContain('receipt data');

        expect(backendReceived.results).toHaveLength(1);
        expect(backendReceived.results[0].body).toMatchObject({ job_id: 'e2e-job-001', status: 'ok' });
    });

    test('printer unreachable: result reported as fail', async () => {
        await closeAsync(printerServer);

        const job = makeJob();
        const ok = await processJob(job);

        expect(ok).toBe(false);
        expect(backendReceived.results).toHaveLength(1);
        expect(backendReceived.results[0].body.status).toBe('fail');
        expect(backendReceived.results[0].body.error).toBeTruthy();
    });

    test('offline buffer scenario: jobs accumulate while backend is down, flush on reconnect', async () => {
        // Phase 1: backend goes offline — simulate by closing backend server
        await closeAsync(backendServer);

        // Queue up 3 jobs in the buffer (simulates agent is alive but can't report)
        const jobs = [makeJob({ job_id: 'buf-1' }), makeJob({ job_id: 'buf-2' }), makeJob({ job_id: 'buf-3' })];
        for (const j of jobs) buffer.enqueue(j);
        expect(buffer.dueJobs()).toHaveLength(3);

        // Phase 2: backend comes back — create new backend server on same port reference
        ({ server: backendServer, received: backendReceived } = createMockBackend());
        backendPort = await listenAsync(backendServer);
        mockBackendUrl = `http://127.0.0.1:${backendPort}`;

        // Process all buffered jobs (simulates agent reconnect flush)
        for (const j of buffer.dueJobs()) {
            await processJob(j);
            buffer.remove(j.job_id);
        }

        expect(buffer.dueJobs()).toHaveLength(0);
        expect(backendReceived.results).toHaveLength(3);
        const reportedIds = backendReceived.results.map(r => r.body.job_id).sort();
        expect(reportedIds).toEqual(['buf-1', 'buf-2', 'buf-3']);
    });
});
