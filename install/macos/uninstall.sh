#!/usr/bin/env bash
# ASPOS Print Agent — macOS uninstaller
# Removes the launchd LaunchDaemon, install directory, and service user.
#
# Usage:
#   sudo bash uninstall.sh
#
# One-liner from ASPOS UI:
#   curl -fsSL https://aspos.io/install/agent/macos/uninstall.sh | sudo bash
#
# Idempotent — running on a machine with no agent installed prints
# informational messages and exits 0.

set -euo pipefail

INSTALL_DIR="/opt/aspos-agent"
PLIST_DEST="/Library/LaunchDaemons/com.aspos.agent.plist"
SERVICE_USER="aspos-agent"

log() { echo "[aspos-uninstall] $*"; }
die() { echo "[aspos-uninstall] ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash uninstall.sh"

# ── 1. launchd service ────────────────────────────────────────────────────────
# `launchctl unload` was deprecated in macOS Ventura (13) — Apple replaced it
# with `launchctl bootout`. Try bootout first; fall back to unload only if
# bootout fails (older macOS where bootout doesn't recognize the service).
# Surface both errors to the log so a stuck service is visible in install logs.
if launchctl list 2>/dev/null | grep -q "com.aspos.agent"; then
    log "Stopping launchd service via 'launchctl bootout system'..."
    if ! bootout_err=$(launchctl bootout "system/com.aspos.agent" 2>&1); then
        log "bootout failed: $bootout_err — falling back to legacy 'launchctl unload'"
        if ! unload_err=$(launchctl unload "$PLIST_DEST" 2>&1); then
            log "unload also failed: $unload_err — continuing with file removal anyway"
        fi
    fi
else
    log "launchd service not loaded — skipping stop."
fi

if [ -f "$PLIST_DEST" ]; then
    log "Removing LaunchDaemon plist: $PLIST_DEST"
    rm -f "$PLIST_DEST"
else
    log "LaunchDaemon plist not present — skipping."
fi

# ── 2. Install directory ──────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR" ]; then
    log "Removing install directory: $INSTALL_DIR"
    rm -rf "$INSTALL_DIR"
else
    log "Install directory not present at $INSTALL_DIR — skipping."
fi

# ── 3. Service user ───────────────────────────────────────────────────────────
# Always removed via dscl. See AGENT-LIFECYCLE.md "Known limitations" for the
# multi-agent-on-one-machine caveat (rare; not yet supported).
if dscl . -read "/Users/$SERVICE_USER" &>/dev/null; then
    log "Removing service user: $SERVICE_USER"
    if ! dscl_err=$(dscl . -delete "/Users/$SERVICE_USER" 2>&1); then
        log "dscl delete failed for '$SERVICE_USER': $dscl_err — continuing"
    fi
else
    log "Service user '$SERVICE_USER' not present — skipping."
fi

log "Done. ASPOS Print Agent has been removed from this Mac."
log "Note: the agent record on the ASPOS dashboard must be deleted separately."
