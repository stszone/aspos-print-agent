// Minimal env vars so config.js can load in tests that don't mock it
process.env.BACKEND_URL    = process.env.BACKEND_URL    || 'http://localhost';
process.env.REVERB_APP_KEY = process.env.REVERB_APP_KEY || 'test_key';
process.env.REVERB_HOST    = process.env.REVERB_HOST    || 'localhost';
process.env.AGENT_ID       = process.env.AGENT_ID       || '7';
process.env.TENANT_ID      = process.env.TENANT_ID      || 'testtenant';
process.env.AGENT_TOKEN    = process.env.AGENT_TOKEN    || 'aspos_agt_test';
