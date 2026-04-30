import 'dotenv/config';

function required(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
}

export default {
    backendUrl:  required('BACKEND_URL').replace(/\/$/, ''),
    reverbAppKey: required('REVERB_APP_KEY'),
    reverbHost:  required('REVERB_HOST'),
    reverbPort:  parseInt(process.env.REVERB_PORT ?? '443', 10),
    reverbScheme: process.env.REVERB_SCHEME ?? 'https',
    agentId:     parseInt(required('AGENT_ID'), 10),
    agentToken:  required('AGENT_TOKEN'),
    healthPort:  parseInt(process.env.HEALTH_PORT ?? '8585', 10),
    logLevel:    process.env.LOG_LEVEL ?? 'info',
};
