import net from 'node:net';
import { sendToPrinter } from '../src/printer.js';

describe('sendToPrinter', () => {
    let server;
    let port;
    let received;

    beforeEach((done) => {
        received = [];
        server = net.createServer((socket) => {
            socket.on('data', (chunk) => received.push(chunk));
        });
        server.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            done();
        });
    });

    afterEach((done) => {
        if (server.listening) server.close(done);
        else done();
    });

    test('sends bytes to TCP target', async () => {
        const bytes = Buffer.from([0x1b, 0x40, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
        await sendToPrinter('127.0.0.1', port, bytes);

        // Give the server socket time to flush
        await new Promise(r => setTimeout(r, 50));

        const total = Buffer.concat(received);
        expect(total).toEqual(bytes);
    });

    test('rejects on connection refused', async () => {
        await new Promise(resolve => server.close(resolve));
        await expect(sendToPrinter('127.0.0.1', port, Buffer.from([0x42])))
            .rejects.toThrow();
    });

    test('rejects on connect timeout to unreachable host', async () => {
        // 192.0.2.0/24 is TEST-NET — routed to nowhere. Some kernels return
        // ENETUNREACH/EHOSTUNREACH immediately rather than timing out.
        await expect(
            sendToPrinter('192.0.2.1', 9100, Buffer.from([0x42]))
        ).rejects.toThrow(/(timeout|unreachable|ENETUNREACH|EHOSTUNREACH|EADDRNOTAVAIL)/i);
    }, 15_000);
});
