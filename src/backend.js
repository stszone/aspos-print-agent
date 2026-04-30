/**
 * HTTP client for ASPOS backend API calls made by the agent.
 *
 * Two endpoints (both defined in Phase 2.1):
 *   POST /api/brand_admin/broadcasting/agent-auth  — Pusher channel auth
 *   POST /api/brand_admin/print-agents/result      — report print outcome
 */

import config from './config.js';
import logger from './logger.js';

const BACKEND_TIMEOUT_MS = 10_000;

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

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Channel auth failed ${res.status}: ${text}`);
    }

    return res.json();
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

    const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Authorization': authHeader(),
            'Content-Type':  'application/json',
            'Accept':        'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.warn('backend: result report failed', { job_id: jobId, status: res.status, body: text });
    } else {
        logger.info('backend: result reported', { job_id: jobId, status });
    }
}
