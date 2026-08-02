#!/usr/bin/env bash
# ASPOS Print Agent — macOS installer
# Requires: Node.js 22.x (install via https://nodejs.org or `brew install node@22`)
#
# Usage:
#   sudo bash install.sh <AGENT_TOKEN> <AGENT_ID> <TENANT_ID> [BACKEND_URL] [REVERB_APP_KEY] [REVERB_HOST]
#
# Example (pipe from ASPOS UI command):
#   curl -fsSL https://aspos.io/install/agent/macos/install.sh | \
#     sudo bash -s -- aspos_agt_xxx 42 abushakra https://pos.mybrand.com rev_key_xxx

set -euo pipefail

AGENT_TOKEN="${1:-}"
AGENT_ID="${2:-}"
TENANT_ID="${3:-}"
BACKEND_URL="${4:-https://aspos.io}"
REVERB_APP_KEY="${5:-}"
REVERB_HOST="${6:-}"
INSTALL_DIR="/opt/aspos-agent"
PLIST_SRC="$INSTALL_DIR/install/macos/com.aspos.agent.plist"
PLIST_DEST="/Library/LaunchDaemons/com.aspos.agent.plist"
NODE_MIN_VERSION="22"
SERVICE_USER="aspos-agent"
HEALTH_URL="http://localhost:8585/health"
HEALTH_RETRIES=12
HEALTH_WAIT=5

log()  { echo "[aspos-install] $*"; }
die()  { echo "[aspos-install] ERROR: $*" >&2; exit 1; }

# ── 0. Validate ───────────────────────────────────────────────────────────────
[ -n "$AGENT_TOKEN" ] || die "AGENT_TOKEN is required (arg 1)."
[ -n "$AGENT_ID" ]    || die "AGENT_ID is required (arg 2)."
[ -n "$TENANT_ID" ]  || die "TENANT_ID is required (arg 3) — the tenant slug, e.g. abushakra."
[[ "$AGENT_ID" =~ ^[1-9][0-9]*$ ]] || die "AGENT_ID must be a positive integer, got: '${AGENT_ID}'."
[ -n "$REVERB_APP_KEY" ] || die "REVERB_APP_KEY is required (arg 5)."
[ "$(id -u)" -eq 0 ]  || die "Run as root: sudo bash install.sh ..."

if [ -z "$REVERB_HOST" ]; then
    REVERB_HOST=$(echo "$BACKEND_URL" | sed -E 's|^https?://||' | sed 's|/.*||')
fi

# ── 1. Node.js ────────────────────────────────────────────────────────────────
node_major() { node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || echo 0; }

if ! command -v node &>/dev/null || [ "$(node_major)" -ne "$NODE_MIN_VERSION" ]; then
    log "Node.js ${NODE_MIN_VERSION}.x not found. Installing via official package..."
    # Fetch the latest v${NODE_MIN_VERSION}.x version number from the SHASUMS file
    LATEST_V=$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MIN_VERSION}.x/SHASUMS256.txt" \
        | grep -oE "node-v[0-9]+\.[0-9]+\.[0-9]+" | head -1 | sed 's/node-v//')
    [ -n "$LATEST_V" ] || die "Could not determine latest Node.js ${NODE_MIN_VERSION}.x version."
    PKG_URL="https://nodejs.org/dist/v${LATEST_V}/node-v${LATEST_V}.pkg"
    log "Downloading Node.js v${LATEST_V}..."
    curl -fsSL "$PKG_URL" -o /tmp/nodejs.pkg
    installer -pkg /tmp/nodejs.pkg -target /
    rm -f /tmp/nodejs.pkg
    log "Node.js v${LATEST_V} installed."
    # Pin NODE_BIN to the just-installed binary — PATH may still resolve a
    # different major (e.g. a Homebrew Node 24 that precedes /usr/local/bin)
    NODE_BIN=""
    for _bin in /usr/local/bin/node /opt/homebrew/bin/node; do
        [ -x "$_bin" ] || continue
        _maj=$("$_bin" -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null)
        [ "$_maj" = "$NODE_MIN_VERSION" ] && NODE_BIN="$_bin" && break
    done
    [ -n "$NODE_BIN" ] || die "Node.js ${NODE_MIN_VERSION}.x was installed but could not be located."
else
    log "Node.js $(node --version) already installed."
    NODE_BIN=$(command -v node)
fi
log "Using node at: $NODE_BIN"

# ── 2. Service user ───────────────────────────────────────────────────────────
if ! dscl . -read "/Users/$SERVICE_USER" &>/dev/null; then
    log "Creating service user '$SERVICE_USER'..."
    NEXT_UID=502
    while dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx "$NEXT_UID"; do
        NEXT_UID=$((NEXT_UID + 1))
    done
    dscl . -create "/Users/$SERVICE_USER"
    dscl . -create "/Users/$SERVICE_USER" UserShell /usr/bin/false
    dscl . -create "/Users/$SERVICE_USER" UniqueID "$NEXT_UID"
    dscl . -create "/Users/$SERVICE_USER" PrimaryGroupID 20
    dscl . -create "/Users/$SERVICE_USER" NFSHomeDirectory "$INSTALL_DIR"
fi

# ── 3. Clone / update agent code ─────────────────────────────────────────────
command -v git &>/dev/null || die "git is not installed. Install Xcode Command Line Tools (xcode-select --install) and re-run."
if [ -d "$INSTALL_DIR/.git" ]; then
    log "Updating existing installation..."
    git -C "$INSTALL_DIR" pull --ff-only
else
    if [ -d "$INSTALL_DIR" ]; then
        log "Removing broken installation at $INSTALL_DIR..."
        rm -rf "$INSTALL_DIR"
    fi
    log "Cloning ASPOS Print Agent to $INSTALL_DIR..."
    git clone https://github.com/stszone/aspos-print-agent.git "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
"$NODE_BIN" "$(dirname "$NODE_BIN")/npm" ci --omit=dev
mkdir -p "$INSTALL_DIR/logs"
chown -R "$SERVICE_USER": "$INSTALL_DIR"

# ── 4. .env ───────────────────────────────────────────────────────────────────
log "Writing .env..."
TMPENV=$(mktemp)
chmod 600 "$TMPENV"
cat > "$TMPENV" <<ENV
BACKEND_URL=${BACKEND_URL}
REVERB_APP_KEY=${REVERB_APP_KEY}
REVERB_HOST=${REVERB_HOST}
REVERB_PORT=443
REVERB_SCHEME=https
AGENT_ID=${AGENT_ID}
TENANT_ID=${TENANT_ID}
AGENT_TOKEN=${AGENT_TOKEN}
HEALTH_PORT=8585
LOG_LEVEL=info
ENV
chown "$SERVICE_USER": "$TMPENV"
mv "$TMPENV" "$INSTALL_DIR/.env"

# ── 5. launchd plist ─────────────────────────────────────────────────────────
cp "$PLIST_SRC" "$PLIST_DEST"
# Replace the /usr/bin/env + node two-token wrapper with the pinned NODE_BIN path
# Uses perl slurp mode (-0777) because the two <string> elements span two lines
perl -0777 -i -pe "s|<string>/usr/bin/env</string>\\s*<string>node</string>|<string>${NODE_BIN}</string>|g" "$PLIST_DEST"
chown root:wheel "$PLIST_DEST"
chmod 644 "$PLIST_DEST"

if launchctl list | grep -q "com.aspos.agent"; then
    log "Reloading existing service..."
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
fi
launchctl load "$PLIST_DEST"
log "Service loaded. Waiting for health check..."

# ── 6. Health check ───────────────────────────────────────────────────────────
for i in $(seq 1 $HEALTH_RETRIES); do
    if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
        log "✓ Health check passed."
        log "Done. Manage with: launchctl {load|unload} $PLIST_DEST"
        exit 0
    fi
    log "  Attempt $i/$HEALTH_RETRIES — retrying in ${HEALTH_WAIT}s..."
    sleep "$HEALTH_WAIT"
done

die "Health check failed after $((HEALTH_RETRIES * HEALTH_WAIT))s. Logs: tail -f $INSTALL_DIR/logs/agent.log"