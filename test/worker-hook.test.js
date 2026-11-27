import net from 'node:net';
import { jest } from '@jest/globals';
import { processJob } from '../src/worker.js';

test('onPrinted runs after the printer write succeeded and BEFORE the result report', async () => {
    const received = [];
    const server = net.createServer(sock => sock.on('data', d => received.push(d)));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const realFetch = global.fetch;
    const fetchSpy = jest.fn(async () => ({ ok: true, status: 200, text: async () => '', clone() { return this; }, json: async () => ({}) }));
    global.fetch = fetchSpy;
    try {
        let fetchCallsAtHook = -1;
        const ok = await processJob({
            job_id: 'w1', printer_id: 1, driver: 'network_escpos',
            connection: { host: '127.0.0.1', port: server.address().port },
            payload_b64: Buffer.from('hello').toString('base64'),
        }, { onPrinted: () => { fetchCallsAtHook = fetchSpy.mock.calls.length; } });
        expect(ok).toBe(true);
        expect(fetchCallsAtHook).toBe(0);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
        global.fetch = realFetch;
        await new Promise(r => server.close(r));
    }
});
