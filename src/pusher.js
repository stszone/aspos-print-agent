// Wraps the CJS pusher-js require so the rest of the codebase uses a plain
// ESM import. createRequire bypasses ESM/CJS interop, which is unreliable for
// webpack bundles on Windows Node 24 when using static import {Pusher} syntax.
import { createRequire } from 'module';
export const Pusher = createRequire(import.meta.url)('pusher-js').Pusher;
