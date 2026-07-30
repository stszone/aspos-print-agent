import 'dotenv/config';

function required(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
}

function parseEnvInt(name, rawValue, { min, max } = {}) {
    const trimmed = (rawValue ?? '').trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
        throw new Error(`Env var ${name} must be an integer, got: ${JSON.stringify(rawValue)}`);
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n)) {
        throw new Error(`Env var ${name} must be an integer, got: ${JSON.stringify(rawValue)}`);
    }
    if (min !== undefined && n < min) {
        throw new Error(`Env var ${name} must be >= ${min}, got: ${n}`);
    }
    if (max !== undefined && n > max) {
        throw new Error(`Env var ${name} must be <= ${max}, got: ${n}`);
    }
    return n;
}

export default {
    backendUrl:   required('BACKEND_URL').replace(/\/$/, ''),
    reverbAppKey: required('REVERB_APP_KEY'),
    reverbHost:   required('REVERB_HOST'),
    reverbPort:   parseEnvInt('REVERB_PORT',  process.env.REVERB_PORT  ?? '443',  { min: 1, max: 65535 }),
    reverbScheme: process.env.REVERB_SCHEME ?? 'https',
    agentId:      parseEnvInt('AGENT_ID',     required('AGENT_ID'),               { min: 1 }),
    // Tenant slug (e.g. "abushakra") — the broadcast channel is tenant-scoped
    // (private-aspos.agents.{tenantId}.{agentId}) because per-tenant agent ids
    // collide on the shared Reverb app. Required since agent 1.1.0; install
    // scripts write it from the dashboard-generated command.
    tenantId:     required('TENANT_ID'),
    agentToken:   required('AGENT_TOKEN'),
    healthPort:   parseEnvInt('HEALTH_PORT',  process.env.HEALTH_PORT  ?? '8585', { min: 1, max: 65535 }),
    logLevel:     process.env.LOG_LEVEL ?? 'info',
};
