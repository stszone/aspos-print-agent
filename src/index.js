/**
 * ASPOS Print Agent — entry point
 *
 * Start order:
 *   1. Validate config (throws early on missing env vars)
 *   2. Open SQLite buffer
 *   3. Start health endpoint
 *   4. Connect to Reverb and subscribe to agent channel
 *   5. Start buffer retry loop (every 30 s)
 */

import 'dotenv/config';

import config              from './config.js';
import logger              from './logger.js';
import { JobBuffer }       from './buffer.js';
import { AgentConnection } from './connection.js';
import { startHealthServer } from './health.js';
import { processJob }      from './worker.js';
import { reportResult }    from './backend.js';

const buffer = new JobBuffer();

async function handleJob(jobData) {
    buffer.enqueue(jobData);

    const ok = await processJob(jobData);
    if (ok) {
        buffer.remove(jobData.job_id);
    } else {
        buffer.recordFailure(jobData.job_id);
    }
}

const connection = new AgentConnection(handleJob);

startHealthServer(() => ({ connected: connection.isConnected }));
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

const retryInterval = setInterval(retryBufferedJobs, 30_000);

async function shutdown(signal) {
    logger.info(`shutdown: received ${signal}`);
    clearInterval(retryInterval);
    connection.stop();
    buffer.close();
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

logger.info('agent: started', { agent_id: config.agentId, backend: config.backendUrl });
