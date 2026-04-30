/**
 * Network ESC/POS printer communication.
 *
 * Opens a TCP socket, streams the raw ESC/POS bytes, then closes the socket.
 * Returns a Promise<void> that resolves on success or rejects with an error.
 */

import net from 'node:net';
import logger from './logger.js';

const CONNECT_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS   = 30_000;

/**
 * @param {string} host  - Printer IP address or hostname
 * @param {number} port  - TCP port (typically 9100)
 * @param {Buffer} bytes - Raw ESC/POS bytes to send
 * @returns {Promise<void>}
 */
export function sendToPrinter(host, port, bytes) {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        let settled  = false;
        let connectTimer;
        let writeTimer;

        function settle(err) {
            if (settled) return;
            settled = true;
            clearTimeout(connectTimer);
            clearTimeout(writeTimer);
            if (err) {
                socket.destroy();
                reject(err);
            } else {
                resolve();
            }
        }

        connectTimer = setTimeout(
            () => settle(new Error(`TCP connect timeout to ${host}:${port}`)),
            CONNECT_TIMEOUT_MS,
        );

        socket.connect(port, host, () => {
            clearTimeout(connectTimer);
            logger.debug('printer: TCP connected', { host, port });

            writeTimer = setTimeout(
                () => settle(new Error(`TCP write timeout to ${host}:${port}`)),
                WRITE_TIMEOUT_MS,
            );

            socket.write(bytes, (err) => {
                if (err) {
                    settle(err);
                } else {
                    socket.end();
                    socket.on('close', () => settle(null));
                }
            });
        });

        socket.on('error', settle);
    });
}
