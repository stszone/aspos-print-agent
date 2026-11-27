/**
 * Job handling shared by live delivery, local reprint and the retry loop.
 *
 * Idempotent re-delivery: the backend may re-send a job (same job_id) whose
 * result report never arrived. If that job_id was already printed we must NOT
 * print again (duplicate kitchen ticket) — we only re-report "ok".
 *
 * Also counts jobs in flight so the self-updater never restarts mid-print.
 */

import logger from './logger.js';

export function createJobHandler({ buffer, history, processJob, reportResult }) {
    let inFlight = 0;

    async function track(fn) {
        inFlight++;
        try { return await fn(); } finally { inFlight--; }
    }

    function onPrinted(job) {
        try { history.markPrinted(job.job_id); } catch (err) {
            logger.warn('history: markPrinted failed (non-fatal)', { err: err.message });
        }
        if (job.kind === 'receipt' || job.kind === 'reprint') {
            try { history.record(job); } catch (err) {
                logger.warn('history: record failed (non-fatal)', { err: err.message });
            }
        }
    }

    /**
     * @param {object} job
     * @param {{force?: boolean}} [opts] force: operator-initiated local reprint — print even if seen before
     */
    function handle(job, { force = false } = {}) {
        return track(async () => {
            if (!force && history.wasPrinted(job.job_id)) {
                logger.info('worker: job already printed — re-reporting ok, not printing again', { job_id: job.job_id });
                buffer.remove(job.job_id);
                await reportResult(job.job_id, 'ok');
                return;
            }

            buffer.enqueue(job);
            const ok = await processJob(job);
            if (ok) {
                buffer.remove(job.job_id);
                onPrinted(job);
            } else {
                buffer.recordFailure(job.job_id);
            }
        });
    }

    async function retryBuffered() {
        for (const job of buffer.dueJobs()) {
            if (history.wasPrinted(job.job_id)) {
                // Printed earlier but the row survived (crash between print and delete).
                buffer.remove(job.job_id);
                await reportResult(job.job_id, 'ok');
                continue;
            }
            logger.info('retry: attempting buffered job', { job_id: job.job_id });
            const ok = await track(() => processJob(job));
            if (ok) {
                buffer.remove(job.job_id);
                onPrinted(job);
            } else {
                buffer.recordFailure(job.job_id);
            }
        }

        for (const job of buffer.abandonedJobs()) {
            logger.warn('retry: reporting abandoned job', { job_id: job.job_id });
            await reportResult(job.job_id, 'fail', 'Abandoned after max retries');
            buffer.removeAbandoned(job.job_id);
        }
    }

    /** True while a job is being printed or any non-abandoned job waits in the buffer. */
    function isBusy() {
        return inFlight > 0 || buffer.activeCount() > 0;
    }

    return { handle, retryBuffered, isBusy };
}
