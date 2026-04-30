#!/usr/bin/env bash
# ASPOS Print Agent — Raspberry Pi installer
# Run as root on a fresh Raspberry Pi OS (Bookworm or Bullseye)
# Usage: sudo bash install.sh

set -euo pipefail

INSTALL_DIR="/opt/aspos-agent"
SERVICE_FILE="/etc/systemd/system/aspos-agent.service"
NODE_VERSION="20"

log() { echo "[aspos-install] $*"; }

# ── 1. Node.js ────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')" -lt "$NODE_VERSION" ]]; then
    log "Installing Node.js ${NODE_VERSION}..."
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
    apt-get install -y nodejs
else
    log "Node.js $(node --version) already installed."
fi

# ── 2. Clone / update agent code ─────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
    log "Updating existing installation..."
    git -C "$INSTALL_DIR" pull --ff-only
else
    log "Cloning aspos-print-agent to $INSTALL_DIR..."
    git clone https://github.com/stszone/aspos-print-agent.git "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
npm ci --omit=dev

# ── 3. .env ───────────────────────────────────────────────────────────────────
if [ ! -f "$INSTALL_DIR/.env" ]; then
    cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
    log ""
    log "┌─────────────────────────────────────────────────────────┐"
    log "│  Edit $INSTALL_DIR/.env and fill in:                   │"
    log "│    BACKEND_URL, REVERB_APP_KEY, REVERB_HOST,           │"
    log "│    AGENT_ID, AGENT_TOKEN                                │"
    log "└─────────────────────────────────────────────────────────┘"
fi

# ── 4. systemd service ────────────────────────────────────────────────────────
cp "$INSTALL_DIR/install/raspberry-pi/aspos-agent.service" "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable aspos-agent
systemctl restart aspos-agent

log "Installation complete. Check status with: systemctl status aspos-agent"
