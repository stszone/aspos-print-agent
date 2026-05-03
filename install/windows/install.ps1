# ASPOS Print Agent — Windows PowerShell installer
# Run in an elevated (Administrator) PowerShell prompt.
#
# Usage:
#   Install-AsposAgent -Token <token> -AgentId <id> [-BackendUrl <url>] [-ReverbAppKey <key>] [-ReverbHost <host>]
#
# One-liner from ASPOS UI (copy-paste into elevated PowerShell):
#   iwr -useb https://aspos.io/install/agent/windows/install.ps1 | iex; `
#     Install-AsposAgent -Token "aspos_agt_xxx" -AgentId 42 -BackendUrl "https://pos.mybrand.com" -ReverbAppKey "rev_key_xxx"

#Requires -RunAsAdministrator

function Install-AsposAgent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]
        [ValidateNotNullOrEmpty()]
        [string]$Token,

        [Parameter(Mandatory=$true)]
        [ValidateRange(1, [int]::MaxValue)]
        [int]$AgentId,

        [ValidateNotNullOrEmpty()]
        [string]$BackendUrl    = "https://aspos.io",
        [string]$ReverbAppKey  = "",
        [string]$ReverbHost    = "",
        [int]$ReverbPort       = 443,
        [string]$ReverbScheme  = "https"
    )

    $ErrorActionPreference = "Stop"

    $InstallDir  = "C:\Program Files\ASPOS Agent"
    $WinswUrl    = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe"
    $WinswExe    = Join-Path $InstallDir "AsposAgent.exe"
    $ServiceXml  = Join-Path $InstallDir "AsposAgent.xml"
    $EnvFile     = Join-Path $InstallDir ".env"
    $LogDir      = Join-Path $InstallDir "logs"
    $HealthUrl   = "http://localhost:8585/health"
    $NodeMinVer  = 22

    function Write-Log { param([string]$Msg) Write-Host "[aspos-install] $Msg" }

    # Validate required parameters
    if ([string]::IsNullOrEmpty($ReverbAppKey)) {
        throw "[aspos-install] ERROR: -ReverbAppKey is required. Obtain it from your ASPOS dashboard."
    }
    $uri = $null
    if (-not [Uri]::TryCreate($BackendUrl, [UriKind]::Absolute, [ref]$uri)) {
        throw "[aspos-install] ERROR: -BackendUrl '$BackendUrl' is not a valid absolute URI."
    }

    # Derive REVERB_HOST from BackendUrl if not supplied
    if ([string]::IsNullOrEmpty($ReverbHost)) {
        $ReverbHost = $uri.Host
    }

    # ── 1. Node.js ────────────────────────────────────────────────────────────
    $nodeOk = $false
    try {
        $nodeVer = [int](node -e 'process.stdout.write(process.versions.node.split(".")[0])' -ErrorAction Stop)
        if ($nodeVer -eq $NodeMinVer) { $nodeOk = $true }
    } catch { # ignore: node may not be installed — treat as not present }

    if (-not $nodeOk) {
        Write-Log "Node.js ${NodeMinVer}+ not found. Installing..."
        $needMsi = $true
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
            if ($LASTEXITCODE -ne 0) { throw "[aspos-install] ERROR: winget failed (exit $LASTEXITCODE)." }
            # Refresh PATH and re-run version detection; winget installs the current
            # LTS which may be a newer major than $NodeMinVer
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                        [System.Environment]::GetEnvironmentVariable("Path","User")
            try {
                $nodeVer = [int](node -e 'process.stdout.write(process.versions.node.split(".")[0])')
                if ($nodeVer -eq $NodeMinVer) { $needMsi = $false }
            } catch { Write-Warning "[aspos-install] Could not detect Node.js version after winget install." }
            if ($needMsi) {
                Write-Log "winget installed Node.js $nodeVer, need ${NodeMinVer} — falling back to MSI..."
            }
        }
        if ($needMsi) {
            # Download the MSI directly (exact major version)
            Write-Log "winget not available — downloading Node.js MSI..."
            $nodeIndex = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing
            $nodeEntry = $nodeIndex | Where-Object { ([int]($_.version -replace '^v(\d+)\..*','$1')) -eq $NodeMinVer } | Select-Object -First 1
            if (-not $nodeEntry) { throw "Could not find Node.js v${NodeMinVer}.x in distribution index." }
            $nodeVersion = $nodeEntry.version
            $msiUrl = "https://nodejs.org/dist/${nodeVersion}/node-${nodeVersion}-x64.msi"
            $msiPath = Join-Path $env:TEMP "nodejs.msi"
            Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
            $proc = Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qn" -Wait -PassThru
            Remove-Item $msiPath -Force
            if ($proc.ExitCode -ne 0) { throw "[aspos-install] ERROR: Node.js MSI install failed (exit $($proc.ExitCode))." }
        }
        # Refresh PATH after any installation
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("Path","User")
    } else {
        Write-Log "Node.js $(node --version) already installed."
    }

    # ── 2. Install directory ──────────────────────────────────────────────────
    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

    # ── 3. Clone / update agent code ─────────────────────────────────────────
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "[aspos-install] ERROR: git is not installed. Install Git from https://git-scm.com/download/win and re-run."
    }
    if (Test-Path (Join-Path $InstallDir ".git")) {
        Write-Log "Updating existing installation..."
        git -C $InstallDir pull --ff-only
        if ($LASTEXITCODE -ne 0) { throw "[aspos-install] ERROR: 'git pull' failed (exit $LASTEXITCODE)." }
    } else {
        Write-Log "Cloning ASPOS Print Agent to $InstallDir..."
        git clone https://github.com/stszone/aspos-print-agent.git $InstallDir
        if ($LASTEXITCODE -ne 0) { throw "[aspos-install] ERROR: 'git clone' failed (exit $LASTEXITCODE)." }
    }
    Set-Location $InstallDir
    npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "[aspos-install] ERROR: 'npm ci' failed (exit $LASTEXITCODE)." }

    # ── 4. .env ───────────────────────────────────────────────────────────────
    Write-Log "Writing .env..."
    # Write env file without displaying token in output
    $envContent = @"
BACKEND_URL=$BackendUrl
REVERB_APP_KEY=$ReverbAppKey
REVERB_HOST=$ReverbHost
REVERB_PORT=$ReverbPort
REVERB_SCHEME=$ReverbScheme
AGENT_ID=$AgentId
AGENT_TOKEN=$Token
HEALTH_PORT=8585
LOG_LEVEL=info
"@
    [System.IO.File]::WriteAllText($EnvFile, $envContent, [System.Text.Encoding]::UTF8)
    # Restrict file permissions to SYSTEM + Administrators only
    $acl = Get-Acl $EnvFile
    $acl.SetAccessRuleProtection($true, $false)
    $acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
    $rule1 = New-Object System.Security.AccessControl.FileSystemAccessRule("SYSTEM","FullControl","Allow")
    $rule2 = New-Object System.Security.AccessControl.FileSystemAccessRule("Administrators","FullControl","Allow")
    $acl.AddAccessRule($rule1)
    $acl.AddAccessRule($rule2)
    Set-Acl $EnvFile $acl

    # ── 5. WinSW service ─────────────────────────────────────────────────────
    # Download WinSW if not already present
    if (-not (Test-Path $WinswExe)) {
        Write-Log "Downloading WinSW service wrapper..."
        Invoke-WebRequest -Uri $WinswUrl -OutFile $WinswExe -UseBasicParsing
    }

    # Copy service descriptor XML and patch it with actual install paths
    $srcXml = Join-Path $InstallDir "install\windows\aspos-agent.xml"
    Copy-Item $srcXml $ServiceXml -Force
    $xml = [xml](Get-Content $ServiceXml -Raw)
    $xml.service.workingdirectory = $InstallDir
    $xml.service.log.logpath = $LogDir
    foreach ($node in @($xml.service.SelectNodes("env"))) { $xml.service.RemoveChild($node) | Out-Null }
    $xml.Save($ServiceXml)

    # Stop and uninstall existing service before re-installing (idempotent)
    if (Get-Service -Name "AsposAgent" -ErrorAction SilentlyContinue) {
        Write-Log "Removing existing service..."
        & $WinswExe stop 2>$null  # ignore — service may already be stopped
        & $WinswExe uninstall
        if ($LASTEXITCODE -ne 0) { throw "[aspos-install] ERROR: WinSW uninstall failed (exit $LASTEXITCODE)." }
    }

    Write-Log "Installing Windows service..."
    & $WinswExe install
    if ($LASTEXITCODE -ne 0) { throw "[aspos-install] ERROR: WinSW install failed (exit $LASTEXITCODE)." }
    & $WinswExe start
    if ($LASTEXITCODE -ne 0) { throw "[aspos-install] ERROR: WinSW start failed (exit $LASTEXITCODE)." }

    # ── 6. Health check ───────────────────────────────────────────────────────
    Write-Log "Waiting for health check..."
    $retries       = 12
    $wait          = 5
    $lastErrMsg    = ""
    for ($i = 1; $i -le $retries; $i++) {
        try {
            $r = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            if ($r.StatusCode -eq 200) {
                Write-Log "✓ Health check passed."
                Write-Log "Done. Manage with: AsposAgent.exe {start|stop|status}"
                return
            }
        } catch { $lastErrMsg = $_.Exception.Message }
        Write-Log "  Attempt $i/$retries — retrying in ${wait}s..."
        Start-Sleep -Seconds $wait
    }
    throw "[aspos-install] ERROR: Health check at $HealthUrl failed after $($retries * $wait)s ($lastErrMsg). Check logs in $LogDir"
}