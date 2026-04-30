#!/usr/bin/env bash
# ASPOS Print Agent — Raspberry Pi installer
# Run as root on a fresh Raspberry Pi OS (Bookworm or Bullseye)
# Usage: sudo bash install.sh

set -euo pipefail

INSTALL_DIR="/opt/aspos-agent"
SERVICE_FILE="/etc/systemd/system/aspos-agent.service"
NODE_VERSION="20"
SERVICE_USER="aspos-agent"

log() { echo "[aspos-install] $*"; }

# ── 1. Node.js ────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')" -lt "$NODE_VERSION" ]]; then
    log "Installing Node.js ${NODE_VERSION}..."
    # Note: pipe-to-bash requires trusting nodesource.com. Review the script at
    # https://deb.nodesource.com/setup_${NODE_VERSION}.x before running in production.
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
    apt-get install -y nodejs
else
    log "Node.js $(node --version) already installed."
fi

# ── 2. Service user ───────────────────────────────────────────────────────────
if ! id "$SERVICE_USER" &>/dev/null; then
    log "Creating service user '$SERVICE_USER'..."
    useradd -r -s /bin/false "$SERVICE_USER"
fi

# ── 3. Clone / update agent code ─────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
    log "Updating existing installation..."
    git -C "$INSTALL_DIR" pull --ff-only
else
    log "Cloning aspos-print-agent to $INSTALL_DIR..."
    git clone https://github.com/stszone/aspos-print-agent.git "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
npm ci --omit=dev
chown -R "$SERVICE_USER": "$INSTALL_DIR"

# ── 4. .env ───────────────────────────────────────────────────────────────────
FRESH_ENV=false
if [ ! -f "$INSTALL_DIR/.env" ]; then
    cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
    FRESH_ENV=true
    log ""
    log "┌─────────────────────────────────────────────────────────┐"
    log "│  Edit $INSTALL_DIR/.env and fill in:                   │"
    log "│    BACKEND_URL, REVERB_APP_KEY, REVERB_HOST,           │"
    log "│    AGENT_ID, AGENT_TOKEN                                │"
    log "└─────────────────────────────────────────────────────────┘"
fi

# Detect unconfigured .env (still contains placeholder angle brackets)
if grep -q '<' "$INSTALL_DIR/.env" 2>/dev/null; then
    FRESH_ENV=true
fi

# ── 5. systemd service ────────────────────────────────────────────────────────
cp "$INSTALL_DIR/install/raspberry-pi/aspos-agent.service" "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable aspos-agent

if [ "$FRESH_ENV" = true ]; then
    log ""
    log "⚠  .env is not yet configured — skipping service start."
    log "   Edit $INSTALL_DIR/.env, then run: systemctl start aspos-agent"
else
    systemctl restart aspos-agent
    log "Installation complete. Check status with: systemctl status aspos-agent"
fi
