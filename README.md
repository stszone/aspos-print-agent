# ASPOS Print Agent

A lightweight Node.js service that runs on-site (PC, Raspberry Pi, or any Linux/macOS/Windows machine) and relays ESC/POS print jobs from the ASPOS cloud backend to local receipt printers over TCP.

The agent connects to the ASPOS backend via a persistent WebSocket (Laravel Reverb), receives print jobs in real time, and dispatches raw ESC/POS bytes to printers on the local network — no polling, no manual driver installation.

> **Note:** This is the device-side agent for [ASPOS](https://aspos.io) — a multi-tenant cloud POS system. The backend is proprietary. The agent itself is open source so operators can inspect, audit, and self-host it.

---

## Features

- **Zero-driver printing** — sends raw ESC/POS bytes over TCP (port 9100); works with any network-capable receipt printer
- **Offline queue** — jobs are buffered in a local SQLite database (via sql.js) and retried with exponential back-off if the printer or network is unavailable
- **Real-time delivery** — WebSocket connection to Reverb; sub-second latency from order to print
- **Auto-reconnect** — exponential back-off (1 s → 60 s) on WebSocket disconnect; survives router reboots
- **Health endpoint** — `GET localhost:8585/health` for watchdog integration and admin-panel status display
- **Emergency reprint** — `GET localhost:8585/local-receipts` lists recent jobs; `POST localhost:8585/reprint` retriggers a job without backend connectivity
- **Multi-platform** — one-command installer for Raspberry Pi, Linux (Debian/Ubuntu/RHEL), macOS, and Windows; runs as a system service on all platforms
- **No native compilation** — pure JavaScript + WebAssembly (sql.js); installs without Visual Studio Build Tools or node-gyp

---

## Installation

Get your **Agent Token** and **Agent ID** from the ASPOS admin panel: **Store Setup → Print Agents → Install Instructions**.

The one-liner install scripts handle everything: Node.js 22 LTS, cloning this repo, writing `.env`, and registering a system service.

### Raspberry Pi

```bash
curl -fsSL https://aspos.io/install/agent/raspberry-pi/install.sh | \
  sudo bash -s -- <AGENT_TOKEN> <AGENT_ID> https://pos.yourbrand.com <REVERB_APP_KEY>
```

### Linux (Debian/Ubuntu/RHEL/Fedora)

```bash
curl -fsSL https://aspos.io/install/agent/linux/install.sh | \
  sudo bash -s -- <AGENT_TOKEN> <AGENT_ID> https://pos.yourbrand.com <REVERB_APP_KEY>
```

### macOS

```bash
curl -fsSL https://aspos.io/install/agent/macos/install.sh | \
  sudo bash -s -- <AGENT_TOKEN> <AGENT_ID> https://pos.yourbrand.com <REVERB_APP_KEY>
```

### Windows (PowerShell — run as Administrator)

```powershell
iwr -useb https://aspos.io/install/agent/windows/install.ps1 | iex
Install-AsposAgent -Token "<AGENT_TOKEN>" -AgentId <AGENT_ID> `
  -BackendUrl "https://pos.yourbrand.com" -ReverbAppKey "<REVERB_APP_KEY>"
```

Full install script source is available at `https://aspos.io/install/agent/latest.json`.

---

## Architecture

```text
ASPOS Cloud Backend
       │  WebSocket (Reverb / Laravel Echo)
       ▼
 ┌─────────────────────────────────────────┐
 │            ASPOS Print Agent            │
 │                                         │
 │  connection.js  ──►  worker.js          │
 │  (WebSocket)        (job processor)     │
 │                          │              │
 │  buffer.js  ◄────────────┘              │
 │  (SQLite queue,           │             │
 │   retry/back-off)         ▼             │
 │                      printer.js         │
 │                      (TCP dispatch)     │
 │                                         │
 │  health.js  (localhost:8585)            │
 └─────────────────────────────────────────┘
                       │  TCP :9100
                       ▼
             Network Receipt Printer
```

**Job lifecycle:**

1. `connection.js` receives a `PrintJobReady` event over WebSocket and calls `worker.js`
2. `worker.js` decodes the base64 ESC/POS payload and calls `printer.js`
3. `printer.js` opens a TCP socket to the printer, sends the bytes, and closes
4. On success the job is removed from `buffer.js` and the result reported to the backend
5. On failure `buffer.js` schedules a retry with exponential back-off (up to 30 attempts / 24 h TTL)

---

## Tech stack

| Component | Technology |
|---|---|
| Runtime | Node.js 22 LTS |
| WebSocket | pusher-js + laravel-echo (Reverb) |
| Job queue | sql.js (SQLite via WebAssembly — no native compilation) |
| Logging | winston + winston-daily-rotate-file |
| Service wrapper (Windows) | WinSW |
| Service wrapper (Linux/Pi) | systemd |
| Service wrapper (macOS) | launchd |
| Tests | Jest (ESM mode) |

---

## Service management

### Linux / Raspberry Pi

```bash
systemctl status  aspos-agent
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

### Windows (elevated PowerShell)

```powershell
cd "C:\Program Files\ASPOS Agent"
.\AsposAgent.exe status
.\AsposAgent.exe restart
Get-Content logs\agent.log -Tail 50 -Wait
```

---

## Configuration

The agent reads `.env` in the install directory. See [`.env.example`](.env.example) for all options.

| Variable | Required | Description |
|---|---|---|
| `BACKEND_URL` | Yes | ASPOS backend base URL (no trailing slash) |
| `REVERB_APP_KEY` | Yes | Reverb WebSocket application key |
| `REVERB_HOST` | Yes | Reverb WebSocket host |
| `REVERB_PORT` | No | Reverb port (default `443`) |
| `REVERB_SCHEME` | No | `https` or `http` (default `https`) |
| `AGENT_ID` | Yes | Numeric agent ID from ASPOS admin panel |
| `AGENT_TOKEN` | Yes | Agent authentication token |
| `HEALTH_PORT` | No | Health endpoint port (default `8585`) |
| `ADMIN_UI_ORIGIN` | No | Trusted CORS origin for `/local-receipts` and `/reprint` (default: derived from `BACKEND_URL`) |
| `LOG_LEVEL` | No | `error` / `warn` / `info` / `debug` (default `info`) |

---

## Development

```bash
git clone https://github.com/stszone/aspos-print-agent.git
cd aspos-print-agent
npm install
cp .env.example .env   # fill in your values
npm start              # run the agent
npm test               # run the test suite
npm run lint           # lint src/ and test/
```

Tests run entirely offline — no live backend or printer required.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Security

To report a security vulnerability, see [SECURITY.md](SECURITY.md).

---

## License

MIT — see [LICENSE](LICENSE).

Copyright (c) 2026 Smart Telecom Solutions (STS).
