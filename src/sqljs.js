import initSqlJs from 'sql.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const wasmDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', 'node_modules', 'sql.js', 'dist'
);

let _sqlPromise = null;

export function getSqlJs() {
    if (!_sqlPromise) {
        _sqlPromise = initSqlJs({ locateFile: f => path.join(wasmDir, f) });
    }
    return _sqlPromise;
}
