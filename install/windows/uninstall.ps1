# ASPOS Print Agent — Windows PowerShell uninstaller
# Run in an elevated (Administrator) PowerShell prompt.
#
# Usage:
#   Uninstall-AsposAgent [-InstallDir <path>]
#
# One-liner from ASPOS UI:
#   iwr -useb https://aspos.io/install/agent/windows/uninstall.ps1 | iex; Uninstall-AsposAgent
#
# Idempotent — running on a machine that has no agent installed prints
# informational messages and exits 0.

#Requires -RunAsAdministrator

function Uninstall-AsposAgent {
    [CmdletBinding()]
    param(
        [string]$InstallDir = "C:\Program Files\ASPOS Agent"
    )

    $ErrorActionPreference = "Stop"

    $WinswExe   = Join-Path $InstallDir "AsposAgent.exe"
    $ServiceName = "AsposAgent"

    function Write-Log { param([string]$Msg) Write-Host "[aspos-uninstall] $Msg" }

    # ── 1. Stop and uninstall service ────────────────────────────────────────
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc) {
        Write-Log "Stopping service '$ServiceName'..."
        if (Test-Path $WinswExe) {
            & $WinswExe stop 2>&1 | Out-Null
        } else {
            Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        }

        Write-Log "Uninstalling service '$ServiceName'..."
        if (Test-Path $WinswExe) {
            & $WinswExe uninstall 2>&1 | Out-Null
        } else {
            # WinSW binary is missing but service exists — fall back to sc.exe.
            sc.exe delete $ServiceName | Out-Null
        }
    } else {
        Write-Log "Service '$ServiceName' is not installed — skipping service removal."
    }

    # ── 2. Remove install directory ──────────────────────────────────────────
    if (Test-Path $InstallDir) {
        Write-Log "Removing install directory: $InstallDir"
        # Retry once if file handles are still being released after service stop.
        $attempts = 0
        while (Test-Path $InstallDir -and $attempts -lt 2) {
            try {
                Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction Stop
            } catch {
                Start-Sleep -Seconds 2
                $attempts++
                if ($attempts -ge 2) { throw }
            }
        }
    } else {
        Write-Log "Install directory not present at $InstallDir — skipping."
    }

    Write-Log "Done. ASPOS Print Agent has been removed from this machine."
    Write-Log "Note: the agent record on the ASPOS dashboard must be deleted separately."
}
