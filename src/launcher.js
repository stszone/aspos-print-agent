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
 * "unconfirmed" until it reaches the backend ("connected"), or survives
 * 15 min with the backend unreachable (see updater.js; if the backend IS
 * reachable but the websocket never connects the process exits itself).
 * If it is started MAX_UNCONFIRMED_STARTS times without being confirmed
 * (crash loop) the next start switches back to `from` and records the bad
 * version (retried only after BAD_VERSION_TTL_MS or when a newer one ships).
 * There is deliberately NO wall-clock age rule: a PC switched off overnight
 * must not look like a failed release.
 *
 * File writes here never abort start-up: on any I/O error we run the base copy.
 *
 * Keep this file tiny and dependency-free: it runs before anything else.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isNewer } from './semver.js';

export const POINTER_FILE = 'current.json';
export const STATE_FILE   = 'update-state.json';
export const MAX_UNCONFIRMED_STARTS = 3;
export const BAD_VERSION_TTL_MS = 24 * 60 * 60 * 1000;

export function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Write via temp file + rename so a power cut never leaves a half-written file. */
export function writeJsonAtomic(file, obj) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
}

/** True while `version` is blacklisted (entries expire after BAD_VERSION_TTL_MS). */
export function isBadVersion(state, version, now = Date.now()) {
    if (!(state?.bad ?? []).includes(version)) return false;
    const at = state?.bad_at?.[version];
    return at === undefined || now - at < BAD_VERSION_TTL_MS;
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
    const base = { entry: path.join(home, 'src', 'app.js'), version: baseVersion, rolledBack: false };
    try {
        return select({ home, baseVersion, now, log });
    } catch (err) {
        log(`launcher: cannot update state files (${err.code ?? err.message}) — running base ${baseVersion}`);
        return base;
    }
}

function select({ home, baseVersion, now, log }) {
    const pointerPath = path.join(home, POINTER_FILE);
    const statePath   = path.join(home, STATE_FILE);
    let pointer = readJson(pointerPath);
    let state   = readJson(statePath);
    let rolledBack = false;

    if (state && state.confirmed === false && !state.rolled_back && pointer?.version === state.to) {
        const starts = Number(state.starts) || 0;
        if (starts >= MAX_UNCONFIRMED_STARTS) {
            log(`launcher: ${state.to} never became healthy (starts=${starts}) — rolling back to ${state.from}`);
            const bad = Array.from(new Set([...(state.bad ?? []), state.to]));
            state = { ...state, bad, bad_at: { ...(state.bad_at ?? {}), [state.to]: now }, rolled_back: true, rolled_back_at: now };
            writeJsonAtomic(statePath, state);
            if (state.from === baseVersion) {
                fs.rmSync(pointerPath, { force: true });
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
