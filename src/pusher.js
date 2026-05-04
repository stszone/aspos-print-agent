// Dynamic import resolves the CJS module.exports object as mod.default,
// guaranteeing the Pusher class regardless of cjs-module-lexer behaviour
// (which is unreliable for webpack bundles on Windows Node 24).
const mod = await import('pusher-js');
export const Pusher = mod.default?.Pusher ?? mod.Pusher;
