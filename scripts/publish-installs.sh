#!/usr/bin/env bash
# Publish install/uninstall scripts to the live aspos.io install host.
#
# Run on AS POS APP SERVER from a checkout of aspos-print-agent (main, after
# merge). Prefer the GitHub Actions "Deploy Install Scripts" workflow; this
# script is the on-box fallback when that workflow cannot run (e.g. no
# self-hosted runners registered for this repo, or ubuntu-latest billing).
#
# Usage:
#   sudo -u deploy bash scripts/publish-installs.sh
#   # or as root (will chown to deploy:www-data):
#   bash scripts/publish-installs.sh
#
# Destination: /var/www/aspos-installs/  (nginx alias for /install/agent/)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${ASPOS_INSTALLS_DIR:-/var/www/aspos-installs}"
BASE_URL="https://aspos.io/install/agent"

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[publish-installs] $*"; }

[ -d "$ROOT/install/windows" ] || die "run from aspos-print-agent checkout (missing install/windows)"
[ -d "$DEST" ] || die "destination missing: $DEST"

VERSION="$(jq -r .version "$ROOT/package.json")"
[ -n "$VERSION" ] && [ "$VERSION" != "null" ] || die "could not read version from package.json"

# Contract guard — same checks as CI. Do not publish a drift that breaks the
# dashboard paste-from-UI command (PrintAgentController installInstructions).
grep -qE '\[string\]\$TenantId' "$ROOT/install/windows/install.ps1" \
  || die "windows/install.ps1 missing -TenantId"
grep -qE 'TENANT_ID=\$TenantId' "$ROOT/install/windows/install.ps1" \
  || die "windows/install.ps1 missing TENANT_ID=.env write"
for os in linux macos raspberry-pi; do
  grep -qF 'TENANT_ID="${3' "$ROOT/install/${os}/install.sh" \
    || die "${os}/install.sh missing TENANT_ID as arg 3"
  grep -qF 'TENANT_ID=${TENANT_ID}' "$ROOT/install/${os}/install.sh" \
    || die "${os}/install.sh missing TENANT_ID=.env write"
done

STAGE="$(mktemp -d /tmp/aspos-installs-stage.XXXXXX)"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

mkdir -p "$STAGE"/{linux,macos,raspberry-pi,windows}
cp "$ROOT/install/linux/install.sh"          "$STAGE/linux/install.sh"
cp "$ROOT/install/linux/uninstall.sh"        "$STAGE/linux/uninstall.sh"
cp "$ROOT/install/macos/install.sh"          "$STAGE/macos/install.sh"
cp "$ROOT/install/macos/uninstall.sh"        "$STAGE/macos/uninstall.sh"
cp "$ROOT/install/raspberry-pi/install.sh"   "$STAGE/raspberry-pi/install.sh"
cp "$ROOT/install/raspberry-pi/uninstall.sh" "$STAGE/raspberry-pi/uninstall.sh"
cp "$ROOT/install/windows/install.ps1"       "$STAGE/windows/install.ps1"
cp "$ROOT/install/windows/uninstall.ps1"     "$STAGE/windows/uninstall.ps1"

RELEASED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
jq -n \
  --arg version "$VERSION" \
  --arg released_at "$RELEASED_AT" \
  --arg base_url "$BASE_URL" \
  '{
    version: $version,
    released_at: $released_at,
    scripts: {
      "linux":        "\($base_url)/linux/install.sh",
      "macos":        "\($base_url)/macos/install.sh",
      "raspberry-pi": "\($base_url)/raspberry-pi/install.sh",
      "windows":      "\($base_url)/windows/install.ps1"
    },
    uninstall_scripts: {
      "linux":        "\($base_url)/linux/uninstall.sh",
      "macos":        "\($base_url)/macos/uninstall.sh",
      "raspberry-pi": "\($base_url)/raspberry-pi/uninstall.sh",
      "windows":      "\($base_url)/windows/uninstall.ps1"
    }
  }' > "$STAGE/latest.json"

BACKUP="/var/www/aspos-installs.backup-$(date -u +%Y%m%dT%H%M%SZ)"
log "Backing up $DEST → $BACKUP"
cp -a "$DEST" "$BACKUP"

log "Publishing version $VERSION → $DEST"
rsync -rlpt --delete \
  --exclude '.backup*' \
  "$STAGE/" "$DEST/"

# Ownership for nginx read + deploy write
if id deploy >/dev/null 2>&1; then
  chown -R deploy:www-data "$DEST" 2>/dev/null || chown -R deploy:deploy "$DEST"
fi
find "$DEST" -type d -exec chmod 755 {} \;
find "$DEST" -type f -exec chmod 644 {} \;

log "Verifying live host"
PS1="$(curl -fsSL "${BASE_URL}/windows/install.ps1?t=$(date +%s)")"
echo "$PS1" | grep -qE '\[string\]\$TenantId' || die "live windows/install.ps1 missing -TenantId"
echo "$PS1" | grep -qE 'TENANT_ID=\$TenantId' || die "live windows/install.ps1 missing TENANT_ID write"
SH="$(curl -fsSL "${BASE_URL}/linux/install.sh?t=$(date +%s)")"
echo "$SH" | grep -qF 'TENANT_ID="${3' || die "live linux/install.sh missing TENANT_ID arg 3"
VER="$(curl -fsSL "${BASE_URL}/latest.json?t=$(date +%s)" | jq -r .version)"
[ "$VER" = "$VERSION" ] || die "latest.json version '$VER' != '$VERSION'"

log "OK — published $VERSION (backup at $BACKUP)"
