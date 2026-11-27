import zlib from 'node:zlib';

function field(str, len) {
    const b = Buffer.alloc(len);
    b.write(str, 0, 'utf8');
    return b;
}

function header(name, size, type, mode = 0o644) {
    const h = Buffer.alloc(512);
    field(name, 100).copy(h, 0);
    field(mode.toString(8).padStart(7, '0'), 8).copy(h, 100);
    field('0000000', 8).copy(h, 108);
    field('0000000', 8).copy(h, 116);
    field(size.toString(8).padStart(11, '0'), 12).copy(h, 124);
    field('00000000000', 12).copy(h, 136);
    h.fill(0x20, 148, 156);
    h.write(type, 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const byte of h) sum += byte;
    field(sum.toString(8).padStart(6, '0') + '\0 ', 8).copy(h, 148);
    return h;
}

/** @param {Array<{name:string, data?:string|Buffer, type?:string, mode?:number}>} entries */
export function buildTarGz(entries) {
    const parts = [];
    for (const e of entries) {
        const data = Buffer.from(e.data ?? '');
        parts.push(header(e.name, data.length, e.type ?? '0', e.mode));
        parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    parts.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(parts));
}

export function packageEntries(version) {
    return [
        { name: './', type: '5', mode: 0o755 },
        { name: './package.json', data: JSON.stringify({ name: 'aspos-print-agent', version }) },
        { name: './src/app.js', data: 'export {};\n' },
        { name: './node_modules/dep/index.js', data: 'module.exports = 1;\n' },
    ];
}
