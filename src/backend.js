/**
 * HTTP client for ASPOS backend API calls made by the agent.
 *
 * Endpoints:
 *   POST /api/brand_admin/broadcasting/agent-auth  — Pusher channel auth
 *   POST /api/brand_admin/print-agents/heartbeat   — keepalive (every 30 s)
 *   POST /api/brand_admin/print-agents/result      — report print outcome
 *
 * If the backend has deleted the agent record, every endpoint here returns
 * 410 Gone with body {"error":"agent_revoked"}. We detect that shape and
 * fire the registered revoked handler so index.js can shut the service down
 * cleanly instead of retrying forever.
 */

import config from './config.js';
import logger from './logger.js';

const BACKEND_TIMEOUT_MS = 10_000;

export class AgentRevokedError extends Error {
    constructor() {
        super('Agent has been revoked by the backend');
        this.name = 'AgentRevokedError';
    }
}

let revokedHandler = null;

export function setRevokedHandler(fn) {
    revokedHandler = fn;
}

function signalRevoked() {
    if (!revokedHandler) return;
    const fn = revokedHandler;
    revokedHandler = null; // fire only once even if multiple endpoints 410 concurrently
    try { fn(); } catch (err) {
        logger.error('backend: revoked handler threw', { err: err.message });
    }
}

/**
 * Detect the specific 410 + {"error":"agent_revoked"} shape. A bare 410 from
 * an upstream proxy (URL gone, CDN purge) must NOT trigger graceful shutdown.
 *
 * @param {Response} res
 * @returns {Promise<boolean>} true if this is a real revoked signal
 */
async function isRevokedResponse(res) {
    if (res.status !== 410) return false;
    try {
        const body = await res.clone().json();
        return body?.error === 'agent_revoked';
    } catch (_) {
        return false;
    }
}

function authHeader() {
    return `Bearer ${config.agentToken}`;
}

async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Authenticate the agent for a private Reverb channel.
 * Called by the Pusher client's custom authorizer.
 *
 * @param {string} socketId
 * @param {string} channelName  e.g. "private-aspos.agents.7"
 * @returns {Promise<{auth: string}>}
 * @throws {AgentRevokedError} when the backend reports the agent has been deleted
 */
export async function channelAuth(socketId, channelName) {
    const url = `${config.backendUrl}/api/brand_admin/broadcasting/agent-auth`;

    const body = new URLSearchParams({ socket_id: socketId, channel_name: channelName });

    const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Authorization': authHeader(),
            'Content-Type':  'application/x-www-form-urlencoded',
            'Accept':        'application/json',
        },
        body: body.toString(),
    });

    if (await isRevokedResponse(res)) {
        signalRevoked();
        throw new AgentRevokedError();
    }

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Channel auth failed ${res.status}: ${text}`);
    }

    return res.json();
}

/**
 * Send a heartbeat so the backend knows this agent is still alive.
 * Called every 30 s from the main retry interval.
 * Transport failures are silently swallowed — a missed heartbeat is non-fatal.
 * A 410 agent_revoked response triggers graceful shutdown.
 */
export async function reportHeartbeat() {
    const url = `${config.backendUrl}/api/brand_admin/print-agents/heartbeat`;
    try {
        const res = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Authorization': authHeader(), 'Accept': 'application/json' },
        });

        if (await isRevokedResponse(res)) {
            signalRevoked();
            return;
        }

        if (!res.ok) {
            logger.warn('backend: heartbeat rejected', { status: res.status });
        }
    } catch (_) {
        // non-fatal: backend will mark offline after threshold expires
    }
}

/**
 * Report a print result to the backend.
 *
 * @param {string} jobId
 * @param {'ok'|'fail'} status
 * @param {string|null} [error]
 */
export async function reportResult(jobId, status, error = null) {
    const url = `${config.backendUrl}/api/brand_admin/print-agents/result`;

    const payload = { job_id: jobId, status };
    if (error) payload.error = String(error).slice(0, 500);

    try {
        const res = await fetchWithTimeout(url, {
            method: 'POST',
            headers: {
                'Authorization': authHeader(),
                'Content-Type':  'application/json',
                'Accept':        'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (await isRevokedResponse(res)) {
            signalRevoked();
            return;
        }

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            logger.warn('backend: result report failed', { job_id: jobId, status: res.status, body: text });
        } else {
            logger.info('backend: result reported', { job_id: jobId, status });
        }
    } catch (err) {
        logger.warn('backend: result report transport error', { job_id: jobId, status, err: err.message });
    }
}
