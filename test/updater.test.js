import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { compareSemver, isNewer } from '../src/semver.js';
import { checkForUpdate, startAutoUpdate, startHealthConfirmation, RESTART_EXIT_CODE } from '../src/updater.js';
import { readJson } from '../src/launcher.js';
import { buildTarGz, packageEntries } from './helpers/tar-builder.js';

const MANIFEST_URL = 'https://aspos.test/install/agent/latest.json';
const PKG_URL = 'https://aspos.test/install/agent/aspos-agent-1.3.0.tar.gz';

let home;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-test-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

function makeFetch({ version = '1.3.0', tgz = buildTarGz(packageEntries(version)), sha, pkgUrl = PKG_URL, withPackage = true, manifestSize, streamed = false } = {}) {
    const digest = sha ?? crypto.createHash('sha256').update(tgz).digest('hex');
    const calls = [];
    const fn = jest.fn(async (url) => {
        calls.push(url);
        if (url === MANIFEST_URL) {
            const body = { version, scripts: {}, ...(withPackage && { package: { url: pkgUrl, sha256: digest, size: manifestSize ?? tgz.length } }) };
            return { ok: true, status: 200, json: async () => body };
        }
        if (url === pkgUrl) {
            if (streamed) {
                const chunkSize = 1024;
                let off = 0;
                const reads = { n: 0, cancelled: false };
                fn.reads = reads;
                return { ok: true, status: 200, body: { getReader: () => ({
                    read: async () => {
                        reads.n++;
                        if (off >= tgz.length) return { done: true };
                        const value = tgz.subarray(off, off + chunkSize); off += chunkSize;
                        return { done: false, value };
                    },
                    cancel: async () => { reads.cancelled = true; },
                }) } };
            }
            return { ok: true, status: 200, arrayBuffer: async () => tgz.buffer.slice(tgz.byteOffset, tgz.byteOffset + tgz.byteLength) };
        }
        return { ok: false, status: 404 };
    });
    fn.calls = calls;
    return fn;
}

const run = (over = {}) => {
    const restart = jest.fn();
    const p = checkForUpdate({
        home, currentVersion: '1.2.0', manifestUrl: MANIFEST_URL,
        isBusy: () => false, restart, fetchImpl: makeFetch(), ...over,
    });
    return p.then(r => ({ r, restart }));
};

describe('semver', () => {
    test('compares numerically, not lexically', () => {
        expect(compareSemver('1.10.0', '1.9.0')).toBe(1);
        expect(compareSemver('1.2.0', 'v1.2.0')).toBe(0);
    });
    test('never downgrades; invalid input is never newer', () => {
        expect(isNewer('1.1.9', '1.2.0')).toBe(false);
        expect(isNewer('1.2.0', '1.2.0')).toBe(false);
        expect(isNewer('2.0.0-beta.1', '1.2.0')).toBe(false);
        expect(isNewer(undefined, '1.2.0')).toBe(false);
        expect(isNewer('1.2.1', '1.2.0')).toBe(true);
    });
});

describe('checkForUpdate', () => {
    test('older or equal manifest version: nothing downloaded, no restart', async () => {
        const f = makeFetch({ version: '1.1.0' });
        const { r, restart } = await run({ fetchImpl: f });
        expect(r.status).toBe('up-to-date');
        expect(f.calls).toEqual([MANIFEST_URL]);
        expect(restart).not.toHaveBeenCalled();
    });

    test('newer version: verifies, extracts, switches pointer, writes unconfirmed state, restarts with code 75', async () => {
        const { r, restart } = await run();
        expect(r.status).toBe('updated');
        expect(restart).toHaveBeenCalledWith(RESTART_EXIT_CODE);
        expect(fs.existsSync(path.join(home, 'versions', '1.3.0', 'src', 'app.js'))).toBe(true);
        expect(readJson(path.join(home, 'current.json'))).toEqual({ version: '1.3.0' });
        expect(readJson(path.join(home, 'update-state.json'))).toMatchObject({ from: '1.2.0', to: '1.3.0', confirmed: false, starts: 0 });
    });

    test('sha256 mismatch aborts: current version kept, nothing extracted, no restart', async () => {
        const { r, restart } = await run({ fetchImpl: makeFetch({ sha: 'a'.repeat(64) }) });
        expect(r.status).toBe('hash-mismatch');
        expect(restart).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(home, 'current.json'))).toBe(false);
        expect(fs.existsSync(path.join(home, 'versions', '1.3.0'))).toBe(false);
    });

    test('deferred (no download) while a job is in flight or buffered', async () => {
        const f = makeFetch();
        const { r, restart } = await run({ fetchImpl: f, isBusy: () => true });
        expect(r.status).toBe('deferred');
        expect(f.calls).toEqual([MANIFEST_URL]);
        expect(restart).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(home, 'current.json'))).toBe(false);
    });

    test('becoming busy during the download defers the switch', async () => {
        let calls = 0;
        const { r, restart } = await run({ isBusy: () => ++calls > 1 });
        expect(r.status).toBe('deferred');
        expect(restart).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(home, 'current.json'))).toBe(false);
    });

    test('a version marked bad by a previous rollback is not retried', async () => {
        fs.writeFileSync(path.join(home, 'update-state.json'), JSON.stringify({ bad: ['1.3.0'] }));
        const f = makeFetch();
        const { r } = await run({ fetchImpl: f });
        expect(r.status).toBe('skipped-bad');
        expect(f.calls).toEqual([MANIFEST_URL]);
    });

    test('streamed download works and is verified', async () => {
        const { r } = await run({ fetchImpl: makeFetch({ streamed: true }) });
        expect(r.status).toBe('updated');
    });

    test('streamed body larger than the manifest size is aborted while reading (cap enforced)', async () => {
        const f = makeFetch({ streamed: true, manifestSize: 100 });
        const { r, restart } = await run({ fetchImpl: f });
        expect(r.status).toBe('error');
        expect(r.error).toMatch(/exceeds/);
        expect(f.reads.cancelled).toBe(true);
        expect(restart).not.toHaveBeenCalled();
    });

    test('body smaller than the manifest size is rejected (not just warned)', async () => {
        const tgz = buildTarGz(packageEntries('1.3.0'));
        const { r, restart } = await run({ fetchImpl: makeFetch({ tgz, manifestSize: tgz.length + 10 }) });
        expect(r.status).toBe('error');
        expect(r.error).toMatch(/size/);
        expect(restart).not.toHaveBeenCalled();
    });

    test('manifest package without a size is unusable', async () => {
        const f = makeFetch();
        const orig = f.getMockImplementation();
        f.mockImplementation(async (url) => {
            const res = await orig(url);
            if (url === MANIFEST_URL) { const b = await res.json(); delete b.package.size; return { ok: true, json: async () => b }; }
            return res;
        });
        const { r } = await run({ fetchImpl: f });
        expect(r.status).toBe('no-package');
    });

    test('a bad version whose TTL expired is retried', async () => {
        fs.writeFileSync(path.join(home, 'update-state.json'), JSON.stringify({ bad: ['1.3.0'], bad_at: { '1.3.0': 1 } }));
        const { r } = await run();
        expect(r.status).toBe('updated');
    });

    test('package from a different host is refused', async () => {
        const { r } = await run({ fetchImpl: makeFetch({ pkgUrl: 'https://evil.test/p.tar.gz' }) });
        expect(r.status).toBe('no-package');
    });

    test('manifest without package field (older latest.json) does nothing', async () => {
        const { r, restart } = await run({ fetchImpl: makeFetch({ withPackage: false }) });
        expect(r.status).toBe('no-package');
        expect(restart).not.toHaveBeenCalled();
    });

    test('network failure never throws and never restarts', async () => {
        const { r, restart } = await run({ fetchImpl: jest.fn(async () => { throw new Error('offline'); }) });
        expect(r.status).toBe('error');
        expect(restart).not.toHaveBeenCalled();
    });

    test('package whose version does not match the manifest is rejected', async () => {
        const tgz = buildTarGz(packageEntries('9.9.9'));
        const { r, restart } = await run({ fetchImpl: makeFetch({ tgz }) });
        expect(r.status).toBe('error');
        expect(restart).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(home, 'current.json'))).toBe(false);
    });

    test('old versions are pruned, keeping new + previous', async () => {
        for (const v of ['1.0.0', '1.2.0']) fs.mkdirSync(path.join(home, 'versions', v), { recursive: true });
        await run();
        expect(fs.readdirSync(path.join(home, 'versions')).sort()).toEqual(['1.2.0', '1.3.0']);
    });
});

describe('startAutoUpdate', () => {
    test('AUTO_UPDATE=false: no timers, no network', () => {
        const f = jest.fn();
        const log = jest.fn();
        const stop = startAutoUpdate({ enabled: false, intervalMs: 1000, fetchImpl: f, log });
        expect(stop).toBeNull();
        expect(f).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith('info', expect.stringContaining('disabled'));
    });

    test('enabled: first check fires after the initial delay', async () => {
        jest.useFakeTimers();
        try {
            const f = makeFetch({ version: '1.1.0' });
            const stop = startAutoUpdate({
                enabled: true, intervalMs: 3_600_000, initialDelayMs: 120_000,
                home, currentVersion: '1.2.0', manifestUrl: MANIFEST_URL, isBusy: () => false, restart: jest.fn(), fetchImpl: f,
            });
            expect(f).not.toHaveBeenCalled();
            await jest.advanceTimersByTimeAsync(120_001);
            expect(f).toHaveBeenCalledTimes(1);
            stop();
        } finally { jest.useRealTimers(); }
    });
});

describe('startHealthConfirmation', () => {
    const writeState = (extra = {}) => fs.writeFileSync(path.join(home, 'update-state.json'),
        JSON.stringify({ from: '1.2.0', to: '1.3.0', switched_at: 1, confirmed: false, starts: 1, bad: [], ...extra }));

    test('marks the new version confirmed once connected', async () => {
        jest.useFakeTimers();
        try {
            writeState();
            let connected = false;
            startHealthConfirmation({ home, runningVersion: '1.3.0', isConnected: () => connected, pollMs: 1000 });
            await jest.advanceTimersByTimeAsync(2000);
            expect(readJson(path.join(home, 'update-state.json')).confirmed).toBe(false);
            connected = true;
            await jest.advanceTimersByTimeAsync(1000);
            expect(readJson(path.join(home, 'update-state.json')).confirmed).toBe(true);
        } finally { jest.useRealTimers(); }
    });

    test('backend reachable but websocket never connects: NOT confirmed, onUnhealthy fires', async () => {
        jest.useFakeTimers();
        try {
            writeState();
            const onUnhealthy = jest.fn();
            startHealthConfirmation({
                home, runningVersion: '1.3.0', isConnected: () => false, isBackendReachable: () => true,
                onUnhealthy, pollMs: 1000, stableMs: 5000,
            });
            await jest.advanceTimersByTimeAsync(6000);
            expect(onUnhealthy).toHaveBeenCalledTimes(1);
            expect(readJson(path.join(home, 'update-state.json')).confirmed).toBe(false);
        } finally { jest.useRealTimers(); }
    });

    test('backend unreachable (site internet down): confirmed after the stable period', async () => {
        jest.useFakeTimers();
        try {
            writeState();
            const onUnhealthy = jest.fn();
            startHealthConfirmation({
                home, runningVersion: '1.3.0', isConnected: () => false, isBackendReachable: () => false,
                onUnhealthy, pollMs: 1000, stableMs: 5000,
            });
            await jest.advanceTimersByTimeAsync(6000);
            expect(onUnhealthy).not.toHaveBeenCalled();
            expect(readJson(path.join(home, 'update-state.json')).confirmed).toBe(true);
        } finally { jest.useRealTimers(); }
    });

    test('does nothing when the running version is not the unconfirmed one', () => {
        writeState();
        expect(startHealthConfirmation({ home, runningVersion: '1.2.0', isConnected: () => true })).toBeNull();
    });
});
