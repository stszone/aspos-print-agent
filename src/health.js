/**
 * Health endpoint on localhost:8585/health
 *
 * Used by systemd/winsw watchdogs and the ASPOS admin UI's "ping agent" feature.
 * Returns 200 with a JSON payload; non-200 means unhealthy.
 */

import http     from 'node:http';
import fs       from 'node:fs';
import { fileURLToPath } from 'node:url';
import path     from 'node:path';
import config   from './config.js';
import logger   from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
);

export function startHealthServer(getStatus, history, onReprint) {
    const server = http.createServer((req, res) => {
        const corsHeaders = {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        };

        if (req.method === 'GET' && req.url === '/health') {
            const status = getStatus();
            const body = JSON.stringify({
                status:     status.connected ? 'ok' : 'degraded',
                connected:  status.connected,
                agent_id:   config.agentId,
                uptime_s:   Math.floor(process.uptime()),
                version,
            });
            res.writeHead(status.connected ? 200 : 503, corsHeaders);
            res.end(body);
            return;
        }

        if (req.method === 'GET' && req.url.startsWith('/local-receipts')) {
            const url  = new URL(req.url, 'http://localhost');
            const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 50);
            const receipts = history ? history.recent(limit) : [];
            res.writeHead(200, corsHeaders);
            res.end(JSON.stringify({ status: 'ok', data: receipts }));
            return;
        }

        if (req.method === 'POST' && req.url === '/reprint') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                let job;
                try { job = JSON.parse(body); } catch {
                    res.writeHead(400, corsHeaders);
                    res.end(JSON.stringify({ status: 'error', message: 'invalid JSON' }));
                    return;
                }
                if (typeof onReprint === 'function') {
                    onReprint(job).catch(err => logger.error('reprint: error', { err: err.message }));
                }
                res.writeHead(202, corsHeaders);
                res.end(JSON.stringify({ status: 'accepted' }));
            });
            return;
        }

        res.writeHead(404, corsHeaders);
        res.end(JSON.stringify({ status: 'not_found' }));
    });

    server.listen(config.healthPort, '127.0.0.1', () => {
        logger.info('health: listening', { port: config.healthPort });
    });

    server.on('error', (err) => {
        logger.error('health: server error', { err: err.message });
    });

    return server;
}
