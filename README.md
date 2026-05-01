# ASPOS Print Agent

A lightweight Node.js service that relays ESC/POS print jobs from the ASPOS backend to local printers over TCP.

## How it works

The agent runs as a system service on a PC or Raspberry Pi on the same local network as your printers. It connects to the ASPOS backend via WebSocket (Reverb), receives print jobs, and sends ESC/POS bytes to the printer over TCP port 9100.

## Distribution model

The agent is distributed as **source + install scripts**. Each install script:

1. Installs Node.js LTS if not already present
2. Clones this repository to the install directory
3. Writes `.env` with the agent credentials
4. Registers a system service (auto-starts on boot)
5. Verifies the health endpoint

---

## Installation

Get your **Agent Token** and **Agent ID** from the ASPOS admin panel: **Store Setup → Print Agents → Install Instructions**.

### Raspberry Pi / Linux

```bash
curl -fsSL https://aspos.io/install/agent/raspberry-pi/install.sh | \
  sudo bash -s -- <AGENT_TOKEN> <AGENT_ID> https://pos.yourbrand.com <REVERB_APP_KEY>
```

For a generic Linux server:

```bash
curl -fsSL https://aspos.io/install/agent/linux/install.sh | \
  sudo bash -s -- <AGENT_TOKEN> <AGENT_ID> https://pos.yourbrand.com <REVERB_APP_KEY>
```

Supports Debian/Ubuntu (apt) and Fedora/RHEL (dnf/yum).

### macOS

Requires Node.js 20+. If not installed, the script installs the official Node.js package automatically.

```bash
curl -fsSL https://aspos.io/install/agent/macos/install.sh | \
  sudo bash -s -- <AGENT_TOKEN> <AGENT_ID> https://pos.yourbrand.com <REVERB_APP_KEY>
```

### Windows

Run in an elevated (Administrator) PowerShell prompt:

```powershell
iwr -useb https://aspos.io/install/agent/windows/install.ps1 | iex
Install-AsposAgent -Token "<AGENT_TOKEN>" -AgentId <AGENT_ID> `
  -BackendUrl "https://pos.yourbrand.com" -ReverbAppKey "<REVERB_APP_KEY>"
```

---

## Service management

### Linux / Raspberry Pi

```bash
systemctl status  aspos-agent
systemctl stop    aspos-agent
systemctl restart aspos-agent
journalctl -u aspos-agent -n 50 --follow
```

### macOS

```bash
launchctl list com.aspos.agent
launchctl unload /Library/LaunchDaemons/com.aspos.agent.plist
launchctl load   /Library/LaunchDaemons/com.aspos.agent.plist
tail -f /opt/aspos-agent/logs/agent.log
```

### Windows

In an elevated PowerShell prompt from `C:\Program Files\ASPOS Agent\`:

```powershell
.\AsposAgent.exe status
.\AsposAgent.exe stop
.\AsposAgent.exe start
Get-Content "logs\agent.log" -Tail 50 -Wait
```

---

## Configuration

The agent reads configuration from `.env` in the install directory (`/opt/aspos-agent/.env` on Linux/macOS, `C:\Program Files\ASPOS Agent\.env` on Windows). See `.env.example` for all available options.

Required variables:

| Variable | Description |
|---|---|
| `BACKEND_URL` | ASPOS backend base URL (no trailing slash) |
| `REVERB_APP_KEY` | Reverb WebSocket application key |
| `REVERB_HOST` | Reverb WebSocket host |
| `AGENT_ID` | Numeric agent ID from ASPOS admin panel |
| `AGENT_TOKEN` | Agent authentication token |

---

## Health endpoint

The agent exposes `GET http://localhost:8585/health`. Returns `200 OK` when the service is running and connected.

---

## Development

```bash
npm install
cp .env.example .env   # fill in values
npm start
npm test
```