/**
 * ASPOS Print Agent — service entry point (stable shim).
 *
 * All service definitions (systemd, WinSW, launchd) run `node src/index.js`
 * from the install directory. This shim picks the active app copy (see
 * launcher.js) and imports its src/app.js. The real start-up logic is in app.js.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareStart } from './launcher.js';

const home = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseVersion = JSON.parse(fs.readFileSync(path.join(home, 'package.json'), 'utf8')).version;

// ASPOS_HOME = install dir that owns logs/, versions/, current.json, *.db
process.env.ASPOS_HOME = home;

const { entry, version, rolledBack } = prepareStart({
    home,
    baseVersion,
    log: (m) => process.stderr.write(`${m}\n`),
});
process.stderr.write(`launcher: starting v${version}${rolledBack ? ' (after rollback)' : ''}\n`);

await import(pathToFileURL(entry).href);
