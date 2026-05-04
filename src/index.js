/**
 * ASPOS Print Agent — entry point
 *
 * Start order:
 *   1. Validate config (throws early on missing env vars)
 *   2. Open SQLite buffer
 *   3. Start health endpoint
 *   4. Connect to Reverb and subscribe to agent channel
 *   5. Start buffer retry loop (every 30 s)
 *
 * Shutdown is idempotent — SIGTERM, SIGINT and a backend-issued "agent
 * revoked" signal all funnel through the same path. Exit code 0 tells WinSW
 * (Windows) and systemd's Restart=on-failure (Linux/Pi) NOT to restart us,
 * which is the correct behavior when the agent has been deleted server-side.
 */

import 'dotenv/config';

import config              from './config.js';
import logger              from './logger.js';
import { JobBuffer }       from './buffer.js';
import { PrintHistory }    from './history.js';
import { AgentConnection } from './connection.js';
import { startHealthServer } from './health.js';
import { processJob }      from './worker.js';
import { reportResult, reportHeartbeat, setRevokedHandler } from './backend.js';

const buffer  = await JobBuffer.create();
const history = await PrintHistory.create();

async function handleJob(jobData) {
    buffer.enqueue(jobData);

    const ok = await processJob(jobData);
    if (ok) {
        buffer.remove(jobData.job_id);
        if (jobData.kind === 'receipt' || jobData.kind === 'reprint') {
            try { history.record(jobData); } catch (err) {
                logger.warn('history: record failed (non-fatal)', { err: err.message });
            }
        }
    } else {
        buffer.recordFailure(jobData.job_id);
    }
}

const connection = new AgentConnection(handleJob);

startHealthServer(() => ({ connected: connection.isConnected }), history, handleJob);
connection.connect();

async function retryBufferedJobs() {
    for (const job of buffer.dueJobs()) {
        logger.info('retry: attempting buffered job', { job_id: job.job_id });
        const ok = await processJob(job);
        if (ok) {
            buffer.remove(job.job_id);
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

const retryInterval = setInterval(() => {
    reportHeartbeat();
    retryBufferedJobs().catch(err => logger.error('retry: unhandled error', { err: err.message }));
}, 30_000);

let shuttingDown = false;
async function shutdown(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`shutdown: ${reason}`);
    try { clearInterval(retryInterval); } catch (_) {}
    try { connection.stop(); }          catch (_) {}
    try { buffer.close(); }             catch (_) {}
    try { history.close(); }            catch (_) {}
    process.exit(exitCode);
}

// When the backend reports "agent_revoked" (410), retrying is pointless —
// the agent record is gone and the token will never authenticate again.
// Exit cleanly so the service manager leaves us stopped.
setRevokedHandler(() => {
    logger.error('agent: revoked by backend — shutting down (run uninstall script to remove this service)');
    shutdown('agent revoked by backend', 0);
});

process.on('SIGTERM', () => shutdown('SIGTERM', 0));
process.on('SIGINT',  () => shutdown('SIGINT',  0));

logger.info('agent: started', { agent_id: config.agentId, backend: config.backendUrl });
