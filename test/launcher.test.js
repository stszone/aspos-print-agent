import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    prepareStart, writeJsonAtomic, readJson,
    MAX_UNCONFIRMED_STARTS, MAX_UNCONFIRMED_AGE_MS,
} from '../src/launcher.js';

let home;
const NOW = 1_800_000_000_000;

function installVersion(v) {
    const d = path.join(home, 'versions', v, 'src');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'app.js'), '');
}
const state = (extra = {}) => ({ from: '1.1.0', to: '1.2.0', switched_at: NOW, confirmed: false, starts: 0, bad: [], ...extra });

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-test-'));
    installVersion('1.2.0');
    installVersion('1.1.5');
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('prepareStart', () => {
    test('no pointer -> base copy', () => {
        const r = prepareStart({ home, baseVersion: '1.1.0', now: NOW });
        expect(r.entry).toBe(path.join(home, 'src', 'app.js'));
        expect(r.rolledBack).toBe(false);
    });

    test('pointer to newer version -> versioned copy, start counter incremented', () => {
        writeJsonAtomic(path.join(home, 'current.json'), { version: '1.2.0' });
        writeJsonAtomic(path.join(home, 'update-state.json'), state());
        const r = prepareStart({ home, baseVersion: '1.1.0', now: NOW + 1000 });
        expect(r.version).toBe('1.2.0');
        expect(readJson(path.join(home, 'update-state.json')).starts).toBe(1);
    });

    test('confirmed version is never rolled back, whatever the start count', () => {
        writeJsonAtomic(path.join(home, 'current.json'), { version: '1.2.0' });
        writeJsonAtomic(path.join(home, 'update-state.json'), state({ confirmed: true, starts: 99 }));
        expect(prepareStart({ home, baseVersion: '1.1.0', now: NOW + 5 * MAX_UNCONFIRMED_AGE_MS }).version).toBe('1.2.0');
    });

    test('crash loop (unconfirmed, too many starts) rolls back to previous and marks new version bad', () => {
        writeJsonAtomic(path.join(home, 'current.json'), { version: '1.2.0' });
        writeJsonAtomic(path.join(home, 'update-state.json'), state({ from: '1.1.5', starts: MAX_UNCONFIRMED_STARTS }));
        const r = prepareStart({ home, baseVersion: '1.1.0', now: NOW + 1000 });
        expect(r.rolledBack).toBe(true);
        expect(r.version).toBe('1.1.5');
        expect(readJson(path.join(home, 'current.json')).version).toBe('1.1.5');
        const st = readJson(path.join(home, 'update-state.json'));
        expect(st.bad).toEqual(['1.2.0']);
        expect(st.rolled_back).toBe(true);
    });

    test('rolling back to the base clone removes the pointer', () => {
        writeJsonAtomic(path.join(home, 'current.json'), { version: '1.2.0' });
        writeJsonAtomic(path.join(home, 'update-state.json'), state({ starts: MAX_UNCONFIRMED_STARTS }));
        const r = prepareStart({ home, baseVersion: '1.1.0', now: NOW + 1000 });
        expect(r.entry).toBe(path.join(home, 'src', 'app.js'));
        expect(fs.existsSync(path.join(home, 'current.json'))).toBe(false);
    });

    test('unconfirmed for longer than the age limit rolls back even with few starts', () => {
        writeJsonAtomic(path.join(home, 'current.json'), { version: '1.2.0' });
        writeJsonAtomic(path.join(home, 'update-state.json'), state({ starts: 1 }));
        const r = prepareStart({ home, baseVersion: '1.1.0', now: NOW + MAX_UNCONFIRMED_AGE_MS + 1 });
        expect(r.rolledBack).toBe(true);
    });

    test('stale pointer older than the clone (installer re-run) is ignored', () => {
        writeJsonAtomic(path.join(home, 'current.json'), { version: '1.2.0' });
        const r = prepareStart({ home, baseVersion: '1.3.0', now: NOW });
        expect(r.entry).toBe(path.join(home, 'src', 'app.js'));
    });

    test('pointer to a missing directory falls back to base', () => {
        writeJsonAtomic(path.join(home, 'current.json'), { version: '1.9.0' });
        expect(prepareStart({ home, baseVersion: '1.1.0', now: NOW }).version).toBe('1.1.0');
    });
});
