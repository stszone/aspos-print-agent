import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { extractTarGz } from '../src/tar.js';
import { buildTarGz } from './helpers/tar-builder.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-test-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('extractTarGz', () => {
    test('extracts files and directories, stripping ./ prefixes', () => {
        const n = extractTarGz(buildTarGz([
            { name: './src/', type: '5' },
            { name: './src/a.js', data: 'hello' },
            { name: 'b/c.txt', data: 'x' },
        ]), dir);
        expect(n).toBe(2);
        expect(fs.readFileSync(path.join(dir, 'src/a.js'), 'utf8')).toBe('hello');
        expect(fs.existsSync(path.join(dir, 'b/c.txt'))).toBe(true);
    });

    test('rejects path traversal and writes nothing outside destination', () => {
        const outside = path.join(path.dirname(dir), 'evil.txt');
        expect(() => extractTarGz(buildTarGz([{ name: '../evil.txt', data: 'x' }]), dir)).toThrow(/unsafe path/);
        expect(fs.existsSync(outside)).toBe(false);
    });

    test('rejects absolute paths', () => {
        expect(() => extractTarGz(buildTarGz([{ name: '/etc/passwd', data: 'x' }]), dir)).toThrow(/unsafe path/);
    });

    test('skips symlinks', () => {
        const n = extractTarGz(buildTarGz([{ name: 'link', type: '2' }, { name: 'f', data: '1' }]), dir);
        expect(n).toBe(1);
        expect(fs.existsSync(path.join(dir, 'link'))).toBe(false);
    });

    test('rejects a corrupt header (checksum mismatch)', () => {
        const tar = zlib.gunzipSync(buildTarGz([{ name: 'file.txt', data: '1' }]));
        tar[0] ^= 0x01; // damage the name field without fixing the checksum
        expect(() => extractTarGz(zlib.gzipSync(tar), dir)).toThrow(/checksum/);
    });
});
