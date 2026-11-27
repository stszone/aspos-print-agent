/**
 * Self-update. See README "Auto-update" and launcher.js (rollback rule).
 *
 * Flow of checkForUpdate():
 *   manifest (latest.json) -> newer than running? -> not a known-bad version?
 *   -> agent idle? -> download package -> sha256 + size check -> extract to
 *   versions/<ver> -> idle again? -> write update-state.json + current.json
 *   -> ask the service manager to restart us (non-zero exit).
 *
 * Nothing here throws: every failure is logged and leaves the running
 * version untouched.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isNewer } from './semver.js';
import { extractTarGz } from './tar.js';
import {
    POINTER_FILE, STATE_FILE, readJson, writeJsonAtomic, versionDir,
} from './launcher.js';

/** Exit code that makes systemd (on-failure), WinSW (onfailure) and launchd (KeepAlive) restart us. */
export const RESTART_EXIT_CODE = 75;

export const MAX_PACKAGE_BYTES = 150 * 1024 * 1024;
const MANIFEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const STABLE_CONFIRM_MS   = 15 * 60_000;
const HEALTH_POLL_MS      = 10_000;

function noop() {}

async function fetchJson(fetchImpl, url, timeoutMs) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
}

function validPackage(pkg, manifestUrl) {
    if (!pkg || typeof pkg.url !== 'string' || !/^[a-f0-9]{64}$/i.test(String(pkg.sha256 ?? ''))) return false;
    let u; let m;
    try { u = new URL(pkg.url); m = new URL(manifestUrl); } catch { return false; }
    // Same host as the manifest, https only (tests may use http via allowInsecure).
    return u.host === m.host && (u.protocol === 'https:' || u.protocol === m.protocol);
}

function isPackageDirValid(dir, version) {
    try {
        const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        return pj.version === version
            && fs.existsSync(path.join(dir, 'src', 'app.js'))
            && fs.existsSync(path.join(dir, 'node_modules'));
    } catch { return false; }
}

async function downloadVerified(fetchImpl, pkg, log) {
    const res = await fetchImpl(pkg.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_PACKAGE_BYTES) throw new Error(`package size out of range: ${buf.length}`);
    if (pkg.size !== undefined && Number(pkg.size) !== buf.length) {
        log('warn', 'updater: package size differs from manifest', { expected: pkg.size, got: buf.length });
    }
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    if (actual !== String(pkg.sha256).toLowerCase()) {
        return { ok: false, expected: pkg.sha256, actual };
    }
    return { ok: true, buf };
}

/** Keep the new version, the one we came from and the base clone; drop the rest. */
export function pruneVersions(home, keep) {
    const root = path.join(home, 'versions');
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { return; }
    for (const name of entries) {
        if (!keep.includes(name)) {
            try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); } catch { /* ignore */ }
        }
    }
}

let running = false;

/**
 * @param {object} o
 * @param {string} o.home             install dir (ASPOS_HOME)
 * @param {string} o.currentVersion   version of the running code
 * @param {string} o.manifestUrl
 * @param {() => boolean} o.isBusy    true while a job is in flight or buffered
 * @param {(code:number) => void} o.restart  stops the agent with the given exit code
 * @param {typeof fetch} [o.fetchImpl]
 * @param {(level:string,msg:string,meta?:object) => void} [o.log]
 * @param {() => number} [o.now]
 * @returns {Promise<{status:string, [k:string]:any}>}
 */
export async function checkForUpdate(o) {
    const {
        home, currentVersion, manifestUrl, isBusy, restart,
        fetchImpl = fetch, log = noop, now = Date.now,
    } = o;
    if (running) return { status: 'already-running' };
    running = true;
    const partial = path.join(home, 'versions', '.partial');
    try {
        const manifest = await fetchJson(fetchImpl, manifestUrl, MANIFEST_TIMEOUT_MS);
        const latest = manifest?.version;
        if (!isNewer(latest, currentVersion)) return { status: 'up-to-date', latest };

        const state = readJson(path.join(home, STATE_FILE)) ?? {};
        if ((state.bad ?? []).includes(latest)) {
            log('info', 'updater: latest version previously failed on this device — skipping', { latest });
            return { status: 'skipped-bad', latest };
        }
        if (!validPackage(manifest.package, manifestUrl)) {
            log('warn', 'updater: manifest has no usable package entry', { latest });
            return { status: 'no-package', latest };
        }
        if (isBusy()) {
            log('info', 'updater: update available but agent is busy — deferring', { latest });
            return { status: 'deferred', latest };
        }

        const target = versionDir(home, latest);
        if (!isPackageDirValid(target, latest)) {
            const dl = await downloadVerified(fetchImpl, manifest.package, log);
            if (!dl.ok) {
                log('error', 'updater: sha256 mismatch — aborting, keeping current version', { latest, expected: dl.expected, actual: dl.actual });
                return { status: 'hash-mismatch', latest };
            }
            fs.rmSync(partial, { recursive: true, force: true });
            extractTarGz(dl.buf, partial);
            if (!isPackageDirValid(partial, latest)) throw new Error('extracted package failed validation');
            fs.rmSync(target, { recursive: true, force: true });
            fs.renameSync(partial, target);
        }

        // Re-check right before switching: a job may have arrived during the download.
        if (isBusy()) {
            log('info', 'updater: agent became busy during download — deferring switch', { latest });
            return { status: 'deferred', latest };
        }

        writeJsonAtomic(path.join(home, STATE_FILE), {
            from: currentVersion, to: latest, switched_at: now(),
            confirmed: false, starts: 0, bad: state.bad ?? [],
        });
        writeJsonAtomic(path.join(home, POINTER_FILE), { version: latest });
        pruneVersions(home, [latest, currentVersion]);

        log('info', 'updater: switched — restarting into new version', { from: currentVersion, to: latest });
        restart(RESTART_EXIT_CODE);
        return { status: 'updated', from: currentVersion, to: latest };
    } catch (err) {
        log('warn', 'updater: check failed (will retry later)', { err: err.message });
        try { fs.rmSync(partial, { recursive: true, force: true }); } catch { /* ignore */ }
        return { status: 'error', error: err.message };
    } finally {
        running = false;
    }
}

/**
 * Schedules checks. Returns a stop() function, or null when disabled.
 * @param {object} o  everything checkForUpdate takes, plus:
 * @param {boolean} o.enabled
 * @param {number} o.intervalMs
 * @param {number} [o.initialDelayMs]
 */
export function startAutoUpdate(o) {
    const { enabled, intervalMs, initialDelayMs = 120_000, log = noop } = o;
    if (!enabled) {
        log('info', 'updater: AUTO_UPDATE disabled — not checking for updates');
        return null;
    }
    const tick = () => { checkForUpdate(o).catch(() => {}); };
    const first = setTimeout(() => {
        tick();
        timer = setInterval(tick, intervalMs);
        timer.unref?.();
    }, initialDelayMs);
    first.unref?.();
    let timer = null;
    return () => { clearTimeout(first); if (timer) clearInterval(timer); };
}

/**
 * Marks a freshly switched version as healthy once it is connected to the
 * backend, or after it has simply stayed up for 15 minutes (e.g. the site's
 * internet is down — that is not the new version's fault).
 * Returns a stop() function, or null if nothing needs confirming.
 */
export function startHealthConfirmation({
    home, runningVersion, isConnected, log = noop, now = Date.now,
    pollMs = HEALTH_POLL_MS, stableMs = STABLE_CONFIRM_MS,
}) {
    const statePath = path.join(home, STATE_FILE);
    const state = readJson(statePath);
    if (!state || state.confirmed !== false || state.to !== runningVersion) return null;

    const startedAt = now();
    const confirm = (why) => {
        try {
            writeJsonAtomic(statePath, { ...state, confirmed: true, confirmed_at: now(), starts: undefined });
            log('info', 'updater: new version confirmed healthy', { version: runningVersion, why });
        } catch (err) {
            log('warn', 'updater: could not write confirmation', { err: err.message });
        }
    };
    const timer = setInterval(() => {
        if (isConnected()) { clearInterval(timer); confirm('connected'); }
        else if (now() - startedAt >= stableMs) { clearInterval(timer); confirm('stable'); }
    }, pollMs);
    timer.unref?.();
    return () => clearInterval(timer);
}
