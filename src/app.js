/**
 * ASPOS Print Agent — entry point
 *
 * (Launched via src/index.js, which selects this base copy or a self-updated
 * versions/<x.y.z>/ copy — see launcher.js.)
 *
 * Start order:
 *   1. Validate config (throws early on missing env vars)
 *   2. Open SQLite buffer
 *   3. Start health endpoint
 *   4. Connect to Reverb and subscribe to agent channel
 *   5. Start buffer retry loop (every 30 s)
 *   6. Start the auto-updater (first check after ~2 min, then every 6 h)
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
import { reportResult, reportHeartbeat, setRevokedHandler, isBackendReachable } from './backend.js';
import { createJobHandler } from './job-handler.js';
import { startAutoUpdate, startHealthConfirmation } from './updater.js';
import { version } from './version.js';

const buffer  = await JobBuffer.create();
const history = await PrintHistory.create();

const jobs = createJobHandler({ buffer, history, processJob, reportResult });

const handleJob = (job) => jobs.handle(job);

const connection = new AgentConnection(handleJob);

// Local emergency reprint is an explicit operator action: never de-duplicated.
startHealthServer(() => ({ connected: connection.isConnected }), history, (job) => jobs.handle(job, { force: true }));
connection.connect();

const retryInterval = setInterval(() => {
    reportHeartbeat();
    jobs.retryBuffered().catch(err => logger.error('retry: unhandled error', { err: err.message }));
}, 30_000);

let stopUpdater = null;
let stopConfirm = null;
let shuttingDown = false;
// Plain function — nothing here is async. Marking it async would wrap the
// return in a Promise that no caller awaits, and process.exit() ends the
// runtime before any continuation could fire anyway.
function shutdown(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`shutdown: ${reason}`);
    try { clearInterval(retryInterval); } catch (_) {}
    try { stopUpdater?.(); stopConfirm?.(); } catch (_) {}
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

const home = process.env.ASPOS_HOME ?? process.cwd();
stopConfirm = startHealthConfirmation({
    home,
    runningVersion: version,
    isConnected: () => connection.isConnected,
    isBackendReachable: () => isBackendReachable(),
    // Exit non-zero: service manager restarts us; launcher counts the start and rolls back after 3.
    onUnhealthy: () => shutdown('new version unhealthy (backend reachable, websocket down)', 1),
    log: (level, msg, meta) => logger[level](msg, meta),
});
stopUpdater = startAutoUpdate({
    enabled:        config.autoUpdate,
    intervalMs:     config.updateIntervalMs,
    home,
    currentVersion: version,
    manifestUrl:    config.updateManifestUrl,
    isBusy:         jobs.isBusy,
    // Non-zero exit => systemd/WinSW/launchd restart us into the new version.
    restart:        (code) => shutdown('self-update: restarting into new version', code),
    log:            (level, msg, meta) => logger[level](msg, meta),
});

logger.info('agent: started', { agent_id: config.agentId, backend: config.backendUrl, version, auto_update: config.autoUpdate });
