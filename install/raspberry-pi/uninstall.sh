#!/usr/bin/env bash
# ASPOS Print Agent — Raspberry Pi uninstaller
# Removes the systemd service, install directory, and service user.
# Same logic as the Linux uninstaller; kept as a separate file so a future
# Pi-specific cleanup (GPIO state, etc.) has a home.
#
# Usage:
#   sudo bash uninstall.sh
#
# One-liner from ASPOS UI:
#   curl -fsSL https://aspos.io/install/agent/raspberry-pi/uninstall.sh | sudo bash
#
# Idempotent — running on a machine with no agent installed prints
# informational messages and exits 0.

set -euo pipefail

INSTALL_DIR="/opt/aspos-agent"
SERVICE_FILE="/etc/systemd/system/aspos-agent.service"
SERVICE_USER="aspos-agent"

log() { echo "[aspos-uninstall] $*"; }
die() { echo "[aspos-uninstall] ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash uninstall.sh"

# ── 1. systemd service ────────────────────────────────────────────────────────
if systemctl list-unit-files aspos-agent.service &>/dev/null \
    && systemctl list-unit-files aspos-agent.service | grep -q aspos-agent; then
    log "Stopping aspos-agent service..."
    systemctl stop aspos-agent 2>/dev/null || true
    log "Disabling aspos-agent service..."
    systemctl disable aspos-agent 2>/dev/null || true
else
    log "aspos-agent service not registered — skipping stop/disable."
fi

if [ -f "$SERVICE_FILE" ]; then
    log "Removing service unit file: $SERVICE_FILE"
    rm -f "$SERVICE_FILE"
    systemctl daemon-reload
else
    log "Service unit file not present — skipping."
fi

# ── 2. Install directory ──────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR" ]; then
    log "Removing install directory: $INSTALL_DIR"
    rm -rf "$INSTALL_DIR"
else
    log "Install directory not present at $INSTALL_DIR — skipping."
fi

# ── 3. Service user ───────────────────────────────────────────────────────────
if id "$SERVICE_USER" &>/dev/null; then
    log "Removing service user: $SERVICE_USER"
    userdel "$SERVICE_USER" 2>/dev/null || true
else
    log "Service user '$SERVICE_USER' not present — skipping."
fi

log "Done. ASPOS Print Agent has been removed from this Raspberry Pi."
log "Note: the agent record on the ASPOS dashboard must be deleted separately."
