/**
 * Health endpoint on localhost:8585/health
 *
 * Used by systemd/winsw watchdogs and the ASPOS admin UI's "ping agent" feature.
 * Returns 200 with a JSON payload; non-200 means unhealthy.
 */

import http     from 'node:http';
import config   from './config.js';
import logger   from './logger.js';

export function startHealthServer(getStatus) {
    const server = http.createServer((req, res) => {
        if (req.method !== 'GET' || req.url !== '/health') {
            res.writeHead(404);
            res.end();
            return;
        }

        const status = getStatus();
        const body = JSON.stringify({
            status:     status.connected ? 'ok' : 'degraded',
            connected:  status.connected,
            agent_id:   config.agentId,
            uptime_s:   Math.floor(process.uptime()),
            version:    process.env.npm_package_version ?? 'unknown',
        });

        res.writeHead(status.connected ? 200 : 503, {
            'Content-Type': 'application/json',
        });
        res.end(body);
    });

    server.listen(config.healthPort, '127.0.0.1', () => {
        logger.info('health: listening', { port: config.healthPort });
    });

    server.on('error', (err) => {
        logger.error('health: server error', { err: err.message });
    });

    return server;
}
