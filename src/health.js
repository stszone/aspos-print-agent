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

const trustedOrigin = process.env.ADMIN_UI_ORIGIN ??
    (() => {
        try { const u = new URL(config.backendUrl); return `${u.protocol}//${u.host}`; }
        catch { return null; }
    })();

export function startHealthServer(getStatus, history, onReprint) {
    const jsonHeaders = {
        'Content-Type': 'application/json',
        ...(trustedOrigin && { 'Access-Control-Allow-Origin': trustedOrigin }),
    };

    const server = http.createServer((req, res) => {
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                ...(trustedOrigin && {
                    'Access-Control-Allow-Origin':  trustedOrigin,
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                }),
            });
            res.end();
            return;
        }

        const corsHeaders = jsonHeaders;

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
            if (url.pathname === '/local-receipts') {
                const parsedLimit = parseInt(url.searchParams.get('limit') ?? '20', 10);
                const limit = Math.min(Number.isNaN(parsedLimit) || parsedLimit <= 0 ? 20 : parsedLimit, 50);
                const receipts = history ? history.recent(limit) : [];
                res.writeHead(200, corsHeaders);
                res.end(JSON.stringify({ status: 'ok', data: receipts }));
                return;
            }
        }

        if (req.method === 'POST' && req.url === '/reprint') {
            const MAX_BODY = 1_048_576; // 1 MB
            let body = '';
            let bodyLen = 0;
            req.on('data', chunk => {
                bodyLen += chunk.length;
                if (bodyLen > MAX_BODY) {
                    res.writeHead(413, corsHeaders);
                    res.end(JSON.stringify({ status: 'error', message: 'request body too large' }));
                    req.destroy();
                    return;
                }
                body += chunk;
            });
            req.on('end', () => {
                if (bodyLen > MAX_BODY) return; // already responded
                let job;
                try { job = JSON.parse(body); } catch {
                    res.writeHead(400, corsHeaders);
                    res.end(JSON.stringify({ status: 'error', message: 'invalid JSON' }));
                    return;
                }
                if (typeof job.job_id !== 'string' || !job.job_id ||
                    typeof job.driver  !== 'string' || !job.driver) {
                    res.writeHead(400, corsHeaders);
                    res.end(JSON.stringify({ status: 'error', message: 'job_id and driver are required' }));
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
