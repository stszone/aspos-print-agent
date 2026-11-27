/**
 * Start-up selector. src/index.js (the service entry point, identical on every
 * OS and in every already-installed unit file) calls prepareStart() to decide
 * WHICH copy of the app to run:
 *
 *   <home>/src/app.js                 the original git-clone copy ("base")
 *   <home>/versions/<x.y.z>/src/app.js  a self-updated copy
 *
 * Two small JSON files in <home> drive that choice (works on Windows, no symlinks):
 *   current.json       {"version":"1.2.0"}            -> run versions/1.2.0
 *   update-state.json  {from,to,switched_at,confirmed,starts,bad[],rolled_back}
 *
 * Rollback rule (the only one): after an update the new version is
 * "unconfirmed" until it reaches the backend ("connected") or survives
 * 15 min (see updater.js). If it is started MAX_UNCONFIRMED_STARTS times
 * without being confirmed (crash loop), or is still unconfirmed more than
 * MAX_UNCONFIRMED_AGE_MS after the switch, the next start switches back to
 * `from` and records the bad version so it is never retried.
 *
 * Keep this file tiny and dependency-free: it runs before anything else.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isNewer } from './semver.js';

export const POINTER_FILE = 'current.json';
export const STATE_FILE   = 'update-state.json';
export const MAX_UNCONFIRMED_STARTS = 3;
export const MAX_UNCONFIRMED_AGE_MS = 60 * 60 * 1000;

export function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Write via temp file + rename so a power cut never leaves a half-written file. */
export function writeJsonAtomic(file, obj) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
}

export function versionDir(home, version) {
    return path.join(home, 'versions', version);
}

function hasApp(dir) {
    return fs.existsSync(path.join(dir, 'src', 'app.js'));
}

/**
 * @param {{home:string, baseVersion:string, now?:number, log?:(m:string)=>void}} o
 * @returns {{entry:string, version:string, rolledBack:boolean}}
 */
export function prepareStart({ home, baseVersion, now = Date.now(), log = () => {} }) {
    const pointerPath = path.join(home, POINTER_FILE);
    const statePath   = path.join(home, STATE_FILE);
    let pointer = readJson(pointerPath);
    let state   = readJson(statePath);
    let rolledBack = false;

    if (state && state.confirmed === false && !state.rolled_back && pointer?.version === state.to) {
        const starts = Number(state.starts) || 0;
        const age    = now - (Number(state.switched_at) || now);
        if (starts >= MAX_UNCONFIRMED_STARTS || age > MAX_UNCONFIRMED_AGE_MS) {
            log(`launcher: ${state.to} never became healthy (starts=${starts}, age=${Math.round(age / 1000)}s) — rolling back to ${state.from}`);
            const bad = Array.from(new Set([...(state.bad ?? []), state.to]));
            state = { ...state, bad, rolled_back: true, rolled_back_at: now };
            writeJsonAtomic(statePath, state);
            if (state.from === baseVersion) {
                try { fs.rmSync(pointerPath, { force: true }); } catch { /* ignore */ }
                pointer = null;
            } else {
                pointer = { version: state.from };
                writeJsonAtomic(pointerPath, pointer);
            }
            rolledBack = true;
        } else {
            state = { ...state, starts: starts + 1 };
            writeJsonAtomic(statePath, state);
        }
    }

    // Use the pointed version only if it is newer than the clone's own code
    // (a re-run installer does `git pull`, which may overtake an old pointer)
    // and its files are really there; otherwise fall back to the base copy.
    if (pointer?.version && isNewer(pointer.version, baseVersion)) {
        const dir = versionDir(home, pointer.version);
        if (hasApp(dir)) {
            return { entry: path.join(dir, 'src', 'app.js'), version: pointer.version, rolledBack };
        }
        log(`launcher: ${pointer.version} files missing — running base ${baseVersion}`);
    }
    return { entry: path.join(home, 'src', 'app.js'), version: baseVersion, rolledBack };
}
