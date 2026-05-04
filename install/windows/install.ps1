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

    $InstallDir      = "C:\Program Files\ASPOS Agent"
    $TargetNodeMajor = 24
    $NodeDir         = "C:\Program Files\nodejs-${TargetNodeMajor}"
    $WinswUrl    = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe"
    $WinswExe    = Join-Path $InstallDir "AsposAgent.exe"
    $ServiceXml  = Join-Path $InstallDir "AsposAgent.xml"
    $EnvFile     = Join-Path $InstallDir ".env"
    $LogDir      = Join-Path $InstallDir "logs"
    $HealthUrl   = "http://localhost:8585/health"

    function Write-Log { param([string]$Msg) Write-Host "[aspos-install] $Msg" }

    # Validate required parameters
    if ([string]::IsNullOrEmpty($ReverbAppKey)) {
        throw "[aspos-install] ERROR: -ReverbAppKey is required. Obtain it from your ASPOS dashboard."
    }
    $uri = $null
    if (-not [Uri]::TryCreate($BackendUrl, [UriKind]::Absolute, [ref]$uri)) {
        throw "[aspos-install] ERROR: -BackendUrl '$BackendUrl' is not a valid absolute URI."
    }

    # Derive REVERB_HOST, REVERB_SCHEME, REVERB_PORT from BackendUrl if not supplied
    if ([string]::IsNullOrEmpty($ReverbHost)) {
        $ReverbHost = $uri.Host
        if (-not $PSBoundParameters.ContainsKey('ReverbScheme')) {
            $ReverbScheme = $uri.Scheme
        }
        if (-not $PSBoundParameters.ContainsKey('ReverbPort')) {
            $ReverbPort = if ($uri.Port -eq -1) { if ($uri.Scheme -eq 'https') { 443 } else { 80 } } else { $uri.Port }
        }
    }

    # ── Helpers ───────────────────────────────────────────────────────────────

    function Get-NodeDistEntry {
        $idx = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing -TimeoutSec 30
        $entry = $idx | Where-Object { ([int]($_.version -replace '^v(\d+)\..*','$1')) -eq $TargetNodeMajor } | Select-Object -First 1
        if (-not $entry) { throw "[aspos-install] ERROR: Could not find Node.js v${TargetNodeMajor}.x in distribution index." }
        return $entry
    }

    function Assert-NodeSha256 {
        param([string]$FilePath, [string]$Filename, [string]$NodeVersion)
        $shasums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/${NodeVersion}/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 30).Content
        $expectedHash = (($shasums -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape($Filename))$" } | Select-Object -First 1) -replace '\s.*', ''
        if ([string]::IsNullOrEmpty($expectedHash)) {
            Remove-Item $FilePath -Force
            throw "[aspos-install] ERROR: SHASUMS256 entry for ${Filename} not found in manifest."
        }
        $actualHash = (Get-FileHash -Path $FilePath -Algorithm SHA256).Hash
        if ($actualHash.ToLower() -ne $expectedHash.ToLower()) {
            Remove-Item $FilePath -Force
            throw "[aspos-install] ERROR: SHA256 mismatch for ${Filename} — expected ${expectedHash}, got ${actualHash}."
        }
    }

    # ZIP install: extracts to $NodeDir, preserving any existing system Node on PATH.
    # Used when an older Node version is already installed on the machine.
    function Install-NodeZip {
        $entry = Get-NodeDistEntry
        $ver  = $entry.version
        $file = "node-${ver}-win-x64.zip"
        $tmp  = Join-Path $env:TEMP "nodejs-${TargetNodeMajor}.zip"
        Write-Log "Downloading Node.js ${ver} ZIP..."
        Invoke-WebRequest -Uri "https://nodejs.org/dist/${ver}/${file}" -OutFile $tmp -UseBasicParsing -TimeoutSec 120
        Assert-NodeSha256 -FilePath $tmp -Filename $file -NodeVersion $ver
        Write-Log "Extracting to ${NodeDir}..."
        $extractRoot = Join-Path $env:TEMP "nodejs-${TargetNodeMajor}-extract"
        if (Test-Path $extractRoot) { Remove-Item $extractRoot -Recurse -Force }
        Expand-Archive -Path $tmp -DestinationPath $extractRoot -Force
        Remove-Item $tmp -Force
        $extracted = Get-ChildItem $extractRoot -Directory | Select-Object -First 1
        if (-not $extracted) { throw "[aspos-install] ERROR: ZIP extraction produced no directory in $extractRoot." }
        if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
        Move-Item $extracted.FullName $NodeDir
        Remove-Item $extractRoot -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path "$NodeDir\node.exe")) { throw "[aspos-install] ERROR: ZIP extracted but node.exe not found at $NodeDir." }
        # CRITICAL: dot in split('.') must be quoted; unquoted dot causes SyntaxError in node -e. Regressed in PR #6, #8, #9.
        $got = [int](& "$NodeDir\node.exe" -e "process.stdout.write(process.versions.node.split('.')[0])")
        if ($got -ne $TargetNodeMajor) { throw "[aspos-install] ERROR: Expected v${TargetNodeMajor}.x but ZIP contained v${got}.x." }
        Write-Log "Node.js $(& "$NodeDir\node.exe" --version) installed at $NodeDir."
        return "$NodeDir\node.exe"
    }

    # MSI install: registers in Add/Remove Programs at the default system path.
    # Used on fresh machines with no existing Node installation.
    function Install-NodeMsi {
        $entry = Get-NodeDistEntry
        $ver  = $entry.version
        $file = "node-${ver}-x64.msi"
        $tmp  = Join-Path $env:TEMP "nodejs-${TargetNodeMajor}.msi"
        Write-Log "Downloading Node.js ${ver} MSI..."
        Invoke-WebRequest -Uri "https://nodejs.org/dist/${ver}/${file}" -OutFile $tmp -UseBasicParsing -TimeoutSec 120
        Assert-NodeSha256 -FilePath $tmp -Filename $file -NodeVersion $ver
        $proc = Start-Process msiexec.exe -Wait -PassThru -ArgumentList "/i `"$tmp`" /quiet /norestart"
        Remove-Item $tmp -Force
        if ($proc.ExitCode -ne 0) { throw "[aspos-install] ERROR: Node.js MSI install failed (exit $($proc.ExitCode))." }
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("Path","User")
        $bin = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not $bin -or -not (Test-Path $bin)) { throw "[aspos-install] ERROR: Node.js MSI installed but node.exe not found on PATH." }
        # CRITICAL: dot in split('.') must be quoted; unquoted dot causes SyntaxError in node -e. Regressed in PR #6, #8, #9.
        $got = [int](& $bin -e "process.stdout.write(process.versions.node.split('.')[0])")
        if ($got -ne $TargetNodeMajor) { throw "[aspos-install] ERROR: Expected v${TargetNodeMajor}.x but MSI installed v${got}.x." }
        Write-Log "Node.js $(& $bin --version) installed at $bin."
        return $bin
    }

    # ── 1. Node.js ────────────────────────────────────────────────────────────
    $NodeBin = $null

    # 1a. Probe $NodeDir first — present when this script ran previously (ZIP install)
    if (Test-Path "$NodeDir\node.exe") {
        try {
            # CRITICAL: dot in split('.') must be quoted; unquoted dot causes SyntaxError in node -e. Regressed in PR #6, #8, #9.
            $v = [int](& "$NodeDir\node.exe" -e "process.stdout.write(process.versions.node.split('.')[0])")
            if ($v -ge $TargetNodeMajor) { $NodeBin = "$NodeDir\node.exe"; Write-Log "Using existing Node.js $v at $NodeDir." }
        } catch { Write-Warning "[aspos-install] Node detection failed for ${NodeDir}: $($_.Exception.Message)" }
    }

    # 1b. Check PATH node — only accept system-wide installs under Program Files;
    #     user-scoped runtimes (nvm, fnm, WinGet user-scope shims) are ignored
    #     because they can change version or disappear outside our control.
    if (-not $NodeBin) {
        $pathNode = (Get-Command node -ErrorAction SilentlyContinue).Source
        if ($pathNode) {
            $pf64 = [System.Environment]::GetFolderPath('ProgramFiles')
            $pf32 = [System.Environment]::GetFolderPath('ProgramFilesX86')
            $inProgramFiles = $pathNode.StartsWith($pf64, [System.StringComparison]::OrdinalIgnoreCase) -or
                              $pathNode.StartsWith($pf32, [System.StringComparison]::OrdinalIgnoreCase)
            if (-not $inProgramFiles) {
                Write-Log "Ignoring user-scoped Node.js at $pathNode (nvm/fnm/store shim) — will install a managed runtime."
                $pathNode = $null
            }
        }
        if ($pathNode) {
            $pathVer = -1
            # CRITICAL: dot in split('.') must be quoted; unquoted dot causes SyntaxError in node -e. Regressed in PR #6, #8, #9.
            try { $pathVer = [int](& $pathNode -e "process.stdout.write(process.versions.node.split('.')[0])") }
            catch { Write-Warning "[aspos-install] Could not detect version at ${pathNode}: $($_.Exception.Message)" }
            if ($pathVer -ge $TargetNodeMajor) {
                $NodeBin = $pathNode
                Write-Log "Using existing Node.js $pathVer at $pathNode."
            } elseif ($pathVer -ge 0) {
                Write-Log "Found Node.js $pathVer at $pathNode — older than required v${TargetNodeMajor}; installing alongside via ZIP."
                $NodeBin = Install-NodeZip
            }
        }
    }

    # 1c. No suitable Node found — fresh MSI install
    if (-not $NodeBin) {
        Write-Log "No Node.js found — installing Node.js ${TargetNodeMajor}.x via MSI."
        $NodeBin = Install-NodeMsi
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
    $NpmCmd = Join-Path (Split-Path $NodeBin) "npm.cmd"
    if (-not (Test-Path $NpmCmd)) {
        throw "[aspos-install] ERROR: npm.cmd not found at $NpmCmd. Verify the Node.js installation alongside $NodeBin."
    }
    & $NpmCmd ci --omit=dev
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
        Invoke-WebRequest -Uri $WinswUrl -OutFile $WinswExe -UseBasicParsing -TimeoutSec 60
    }
    $sig = Get-AuthenticodeSignature -FilePath $WinswExe
    if ($sig.Status -ne 'Valid') {
        Remove-Item $WinswExe -Force
        throw "[aspos-install] ERROR: WinSW binary failed Authenticode verification (status: $($sig.Status)). Aborting to prevent running an unverified executable."
    }

    # Copy service descriptor XML and patch it with actual install paths
    $srcXml = Join-Path $InstallDir "install\windows\aspos-agent.xml"
    Copy-Item $srcXml $ServiceXml -Force
    $xml = [xml](Get-Content $ServiceXml -Raw)
    $xml.service.executable = $NodeBin
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