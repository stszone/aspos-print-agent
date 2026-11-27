#!/usr/bin/env node
// The agent's package.json `engines.node` is the one source for the Node major.
// Every installer must install exactly that major; a drift (installers on 22
// while the code required 24) only showed up as an EBADENGINE warning on
// customer machines. Exit 0 = all agree, 1 = drift, 2 = could not read a file
// or find its version line (never treated as "agree").
import { readFileSync } from "node:fs";

const fail = (code, msg) => { console.error(`installer-node-version: ${msg}`); process.exit(code); };
const read = (path) => { try { return readFileSync(path, "utf8"); } catch (e) { fail(2, `cannot read ${path}: ${e.message}`); } };

const engines = JSON.parse(read("package.json"))?.engines?.node;
const want = engines?.match(/(\d+)/)?.[1];
if (!want) fail(2, `package.json engines.node missing or unparseable: ${engines}`);

const installers = [
  ["install/linux/install.sh", /^NODE_MIN_VERSION="(\d+)"/m],
  ["install/raspberry-pi/install.sh", /^NODE_MIN_VERSION="(\d+)"/m],
  ["install/macos/install.sh", /^NODE_MIN_VERSION="(\d+)"/m],
  ["install/windows/install.ps1", /^\s*\$TargetNodeMajor\s*=\s*(\d+)/m],
];

const drift = [];
for (const [path, re] of installers) {
  const got = read(path).match(re)?.[1];
  if (!got) fail(2, `${path}: no Node version line matching ${re}`);
  if (got !== want) drift.push(`${path} installs Node ${got}`);
}
if (drift.length) fail(1, `package.json engines.node requires ${want} but:\n  ${drift.join("\n  ")}`);
console.log(`installer-node-version: all ${installers.length} installers install Node ${want} = package.json engines (${engines}).`);
