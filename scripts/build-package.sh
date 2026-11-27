#!/usr/bin/env bash
# Build the self-update package: a platform-neutral tar.gz holding src/,
# package.json, package-lock.json and PRODUCTION node_modules.
#
# Why node_modules are bundled (instead of `npm ci` on the device): the update
# must work on a restaurant PC with flaky internet and no build tools, and a
# failed `npm ci` half-way would leave a broken version. Every runtime
# dependency is pure JavaScript / WASM (sql.js), so one tarball serves
# Windows, macOS, Linux and Raspberry Pi. The script FAILS if a native addon
# (*.node) ever sneaks in.
#
# Usage: scripts/build-package.sh <out-dir>
# Writes <out-dir>/aspos-agent-<version>.tar.gz and prints, on stdout:
#   FILE=<name>
#   SHA256=<64 hex>
#   SIZE=<bytes>
set -euo pipefail

OUT="${1:?usage: build-package.sh <out-dir>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(jq -r .version "$ROOT/package.json")"
[ -n "$VERSION" ] && [ "$VERSION" != "null" ] || { echo "ERROR: could not read version" >&2; exit 1; }

mkdir -p "$OUT"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -r "$ROOT/src" "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGE/"
( cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >&2 )
rm -rf "$STAGE/node_modules/.bin"   # symlinks; unused at runtime

if [ -n "$(find "$STAGE/node_modules" -name '*.node' -print -quit)" ]; then
  echo "ERROR: native addon found in production dependencies — package would not be platform-neutral" >&2
  exit 1
fi
[ -f "$STAGE/src/app.js" ] && [ -d "$STAGE/node_modules/sql.js" ] \
  || { echo "ERROR: package staging incomplete" >&2; exit 1; }

FILE="aspos-agent-${VERSION}.tar.gz"
tar -czf "$OUT/$FILE" -C "$STAGE" --owner=0 --group=0 --numeric-owner .

SHA256="$(sha256sum "$OUT/$FILE" | cut -d' ' -f1)"
[ "${#SHA256}" -eq 64 ] || { echo "ERROR: empty/invalid sha256 for $FILE" >&2; exit 1; }
SIZE="$(stat -c%s "$OUT/$FILE")"
[ "$SIZE" -gt 0 ] || { echo "ERROR: empty package" >&2; exit 1; }

echo "FILE=$FILE"
echo "SHA256=$SHA256"
echo "SIZE=$SIZE"
