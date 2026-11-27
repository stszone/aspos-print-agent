/**
 * Minimal, dependency-free tar.gz extractor (Node has none built in, and
 * Windows installs cannot be assumed to have a usable `tar`).
 *
 * Supports ustar, GNU long names (L) and pax path headers (x). Symlinks and
 * hard links are skipped on purpose (node_modules/.bin only; they need
 * privileges on Windows and the agent never uses them). Every entry path is
 * confined to the destination directory — absolute paths, drive letters and
 * `..` segments abort the whole extraction.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BLOCK = 512;
export const MAX_UNPACKED_BYTES = 400 * 1024 * 1024;

function cstr(buf, start, len) {
    const slice = buf.subarray(start, start + len);
    const end = slice.indexOf(0);
    return slice.subarray(0, end === -1 ? len : end).toString('utf8');
}

function octal(buf, start, len) {
    const s = cstr(buf, start, len).trim();
    return s ? parseInt(s, 8) : 0;
}

function checksumOk(header) {
    const stored = octal(header, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += (i >= 148 && i < 156) ? 32 : header[i];
    return sum === stored;
}

function parsePax(data) {
    const out = {};
    let pos = 0;
    while (pos < data.length) {
        const sp = data.indexOf(0x20, pos);
        if (sp === -1) break;
        const len = parseInt(data.subarray(pos, sp).toString('utf8'), 10);
        if (!Number.isInteger(len) || len <= 0) break;
        const rec = data.subarray(sp + 1, pos + len - 1).toString('utf8');
        const eq = rec.indexOf('=');
        if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
        pos += len;
    }
    return out;
}

function safeTarget(destDir, entryName) {
    const name = entryName.replace(/\\/g, '/');
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) {
        throw new Error(`unsafe path in archive: ${entryName}`);
    }
    const target = path.resolve(destDir, name);
    const root = path.resolve(destDir);
    if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error(`path escapes destination: ${entryName}`);
    }
    return target;
}

/**
 * @param {Buffer} gz   gzip-compressed tar bytes
 * @param {string} destDir  created if missing
 * @returns {number} number of files written
 */
export function extractTarGz(gz, destDir) {
    const tar = zlib.gunzipSync(gz, { maxOutputLength: MAX_UNPACKED_BYTES });
    fs.mkdirSync(destDir, { recursive: true });

    let pos = 0;
    let files = 0;
    let longName = null;
    let paxPath = null;

    while (pos + BLOCK <= tar.length) {
        const header = tar.subarray(pos, pos + BLOCK);
        if (header.every(b => b === 0)) break;
        if (!checksumOk(header)) throw new Error('tar header checksum mismatch (corrupt archive)');

        const type = String.fromCharCode(header[156] || 0x30);
        const size = octal(header, 124, 12);
        const dataStart = pos + BLOCK;
        const data = tar.subarray(dataStart, dataStart + size);
        if (data.length !== size) throw new Error('tar entry truncated');
        pos = dataStart + Math.ceil(size / BLOCK) * BLOCK;

        if (type === 'L') { longName = cstr(data, 0, data.length); continue; }
        if (type === 'x') { paxPath = parsePax(data).path ?? null; continue; }
        if (type === 'g' || type === 'K') continue;

        let name = cstr(header, 0, 100);
        const prefix = cstr(header, 345, 155);
        if (prefix) name = `${prefix}/${name}`;
        if (longName) name = longName;
        if (paxPath) name = paxPath;
        longName = null;
        paxPath = null;

        const clean = name.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
        if (clean === '' || clean === '.') continue;
        const target = safeTarget(destDir, clean);

        if (type === '5') {
            fs.mkdirSync(target, { recursive: true });
        } else if (type === '0' || type === '\0') {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, data);
            if ((octal(header, 100, 8) & 0o111) !== 0) {
                try { fs.chmodSync(target, 0o755); } catch { /* best effort (Windows) */ }
            }
            files++;
        }
        // symlinks / hard links / devices: skipped
    }
    return files;
}
