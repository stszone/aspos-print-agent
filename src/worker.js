/**
 * Job worker — processes a single print job.
 *
 * Called both for live jobs (received from Reverb) and buffered retries.
 * Returns true on success, false on failure.
 */

import { sendToPrinter } from './printer.js';
import { reportResult }  from './backend.js';
import logger from './logger.js';

/**
 * @param {object} job - The PrintJobReady event data from Reverb
 * @param {{onPrinted?: (job: object) => void}} [hooks] onPrinted runs right after the
 *        printer accepted the bytes, BEFORE the (slow) result report, so a crash while
 *        reporting cannot cause a duplicate print after restart.
 * @returns {Promise<boolean>}
 */
export async function processJob(job, { onPrinted } = {}) {
    const { job_id, printer_id, driver, connection, payload_b64 } = job;

    logger.info('worker: processing job', { job_id, printer_id, driver });

    if (driver !== 'network_escpos') {
        logger.warn('worker: unsupported driver — skipping', { job_id, driver });
        await reportResult(job_id, 'fail', `Unsupported driver: ${driver}`);
        return false;
    }

    if (!connection?.host || !connection?.port) {
        logger.error('worker: missing connection config', { job_id, connection });
        await reportResult(job_id, 'fail', 'Missing printer connection config');
        return false;
    }

    let bytes;
    try {
        if (!payload_b64 ||
            payload_b64.length % 4 !== 0 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(payload_b64)) {
            throw new Error('invalid base64 format');
        }
        bytes = Buffer.from(payload_b64, 'base64');
        if (bytes.toString('base64') !== payload_b64) {
            throw new Error('base64 round-trip mismatch');
        }
    } catch (err) {
        logger.error('worker: invalid base64 payload', { job_id, err: err.message });
        await reportResult(job_id, 'fail', 'Invalid base64 payload');
        return false;
    }

    try {
        await sendToPrinter(connection.host, connection.port, bytes);
        try { onPrinted?.(job); } catch (err) { logger.warn('worker: onPrinted hook failed', { err: err.message }); }
        logger.info('worker: print sent successfully', { job_id, host: connection.host, port: connection.port });
        await reportResult(job_id, 'ok');
        return true;
    } catch (err) {
        logger.error('worker: print failed', { job_id, host: connection.host, port: connection.port, err: err.message });
        await reportResult(job_id, 'fail', err.message);
        return false;
    }
}
