#!/usr/bin/env bash
# ASPOS Print Agent — Linux installer
# Supports: Debian/Ubuntu (apt), Fedora/RHEL/CentOS (dnf/yum)
#
# Usage:
#   sudo bash install.sh <AGENT_TOKEN> <AGENT_ID> [BACKEND_URL] [REVERB_APP_KEY] [REVERB_HOST]
#
# Example (pipe from ASPOS UI command):
#   curl -fsSL https://aspos.io/install/agent/linux/install.sh | \
#     sudo bash -s -- aspos_agt_xxx 42 https://pos.mybrand.com rev_key_xxx

set -euo pipefail

AGENT_TOKEN="${1:-}"
AGENT_ID="${2:-}"
BACKEND_URL="${3:-https://aspos.io}"
REVERB_APP_KEY="${4:-}"
REVERB_HOST="${5:-}"
INSTALL_DIR="/opt/aspos-agent"
SERVICE_FILE="/etc/systemd/system/aspos-agent.service"
NODE_MIN_VERSION="20"
SERVICE_USER="aspos-agent"
HEALTH_URL="http://localhost:8585/health"
HEALTH_RETRIES=12
HEALTH_WAIT=5

log()  { echo "[aspos-install] $*"; }
die()  { echo "[aspos-install] ERROR: $*" >&2; exit 1; }

# ── 0. Validate ───────────────────────────────────────────────────────────────
[ -n "$AGENT_TOKEN" ] || die "AGENT_TOKEN is required (arg 1)."
[ -n "$AGENT_ID" ]    || die "AGENT_ID is required (arg 2)."
[[ "$AGENT_ID" =~ ^[1-9][0-9]*$ ]] || die "AGENT_ID must be a positive integer, got: '${AGENT_ID}'."
[ -n "$REVERB_APP_KEY" ] || die "REVERB_APP_KEY is required (arg 4)."
[ "$(id -u)" -eq 0 ]  || die "Run as root: sudo bash install.sh ..."

# Derive REVERB_HOST from BACKEND_URL if not supplied
if [ -z "$REVERB_HOST" ]; then
    REVERB_HOST=$(echo "$BACKEND_URL" | sed -E 's|^https?://||' | sed 's|/.*||')
fi

# ── 1. Node.js ────────────────────────────────────────────────────────────────
node_major() { node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || echo 0; }

if ! command -v node &>/dev/null || [ "$(node_major)" -lt "$NODE_MIN_VERSION" ]; then
    if command -v apt-get &>/dev/null; then
        log "Installing Node.js ${NODE_MIN_VERSION} via NodeSource (apt)..."
        curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN_VERSION}.x" | bash -
        apt-get install -y nodejs
    elif command -v dnf &>/dev/null; then
        log "Installing Node.js ${NODE_MIN_VERSION} via NodeSource (dnf)..."
        curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MIN_VERSION}.x" | bash -
        dnf install -y nodejs
    elif command -v yum &>/dev/null; then
        log "Installing Node.js ${NODE_MIN_VERSION} via NodeSource (yum)..."
        curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MIN_VERSION}.x" | bash -
        yum install -y nodejs
    else
        die "Unsupported package manager. Install Node.js ${NODE_MIN_VERSION}+ manually from https://nodejs.org then re-run."
    fi
else
    log "Node.js $(node --version) already installed."
fi

# ── 2. Service user ───────────────────────────────────────────────────────────
if ! id "$SERVICE_USER" &>/dev/null; then
    log "Creating service user '$SERVICE_USER'..."
    useradd -r -s /bin/false "$SERVICE_USER"
fi

# ── 3. Clone / update agent code ─────────────────────────────────────────────
command -v git &>/dev/null || die "git is not installed. Install it (e.g. apt-get install git) and re-run."
if [ -d "$INSTALL_DIR/.git" ]; then
    log "Updating existing installation..."
    git -C "$INSTALL_DIR" pull --ff-only
else
    log "Cloning ASPOS Print Agent to $INSTALL_DIR..."
    git clone https://github.com/stszone/aspos-print-agent.git "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
npm ci --omit=dev
mkdir -p "$INSTALL_DIR/logs"
chown -R "$SERVICE_USER": "$INSTALL_DIR"

# ── 4. .env ───────────────────────────────────────────────────────────────────
log "Writing .env..."
TMPENV=$(mktemp)
chmod 600 "$TMPENV"
# Write without echoing token to stdout
cat > "$TMPENV" <<ENV
BACKEND_URL=${BACKEND_URL}
REVERB_APP_KEY=${REVERB_APP_KEY}
REVERB_HOST=${REVERB_HOST}
REVERB_PORT=443
REVERB_SCHEME=https
AGENT_ID=${AGENT_ID}
AGENT_TOKEN=${AGENT_TOKEN}
HEALTH_PORT=8585
LOG_LEVEL=info
ENV
chown "$SERVICE_USER": "$TMPENV"
mv "$TMPENV" "$INSTALL_DIR/.env"

# ── 5. systemd service ────────────────────────────────────────────────────────
cp "$INSTALL_DIR/install/linux/aspos-agent.service" "$SERVICE_FILE"
sed -i "s/^User=.*/User=${SERVICE_USER}/" "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable aspos-agent
systemctl restart aspos-agent
log "Service started. Waiting for health check..."

# ── 6. Health check ───────────────────────────────────────────────────────────
for i in $(seq 1 $HEALTH_RETRIES); do
    if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
        log "✓ Health check passed."
        log "Done. Manage with: systemctl {status|stop|restart} aspos-agent"
        exit 0
    fi
    log "  Attempt $i/$HEALTH_RETRIES — retrying in ${HEALTH_WAIT}s..."
    sleep "$HEALTH_WAIT"
done

die "Health check failed after $((HEALTH_RETRIES * HEALTH_WAIT))s. Logs: journalctl -u aspos-agent -n 50"