import 'dotenv/config';

function required(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
}

function parseEnvInt(name, rawValue) {
    const trimmed = (rawValue ?? '').trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
        throw new Error(`Env var ${name} must be an integer, got: ${JSON.stringify(rawValue)}`);
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n)) {
        throw new Error(`Env var ${name} must be an integer, got: ${JSON.stringify(rawValue)}`);
    }
    return n;
}

export default {
    backendUrl:   required('BACKEND_URL').replace(/\/$/, ''),
    reverbAppKey: required('REVERB_APP_KEY'),
    reverbHost:   required('REVERB_HOST'),
    reverbPort:   parseEnvInt('REVERB_PORT',  process.env.REVERB_PORT  ?? '443'),
    reverbScheme: process.env.REVERB_SCHEME ?? 'https',
    agentId:      parseEnvInt('AGENT_ID',     required('AGENT_ID')),
    agentToken:   required('AGENT_TOKEN'),
    healthPort:   parseEnvInt('HEALTH_PORT',  process.env.HEALTH_PORT  ?? '8585'),
    logLevel:     process.env.LOG_LEVEL ?? 'info',
};
