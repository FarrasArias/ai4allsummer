
# AI4ALL Energy Chat Dashboard

A local AI assistant with multiple modes (Chat, Code, Web, Image Analysis) and energy usage tracking.

## Quick Start (Windows)

1. **Extract** this folder anywhere on your computer
2. **Double-click `setup.bat`** (one-time — installs everything you need)
3. **Double-click `start.bat`** (launches the app each time you want to use it)

The app will open in your browser automatically at http://localhost:5173.

## What `setup.bat` Does

The setup script checks for and installs all prerequisites:
- **Python** — if missing, opens the download page for you
- **Node.js** — if missing, opens the download page for you
- **Ollama** — downloads and installs automatically if missing
- Sets up the backend (Python virtual environment + packages)
- Sets up the frontend (npm packages)
- Downloads the default AI model (~1 GB)

You only need to run setup once. It's safe to re-run if something goes wrong.

## What `start.bat` Does

- Starts Ollama (AI model server) if not already running
- Starts the backend API server
- Starts the frontend dev server
- Opens the app in your browser

To stop everything, close the "AI4ALL" window.

## Available Modes

| Mode | Description | Default Model |
|------|-------------|---------------|
| Chat | General conversation with fast/deep thinking modes | qwen3:1.7b |
| Vibe Coding | Code assistant for writing and debugging code | qwen2.5-coder:7b |
| Web | Chat with web search capabilities | qwen2.5:7b |
| Image Analysis | Upload and analyze images | qwen2.5vl:7b |

You can download additional models from the **Models** tab in the app, or from the command line:
```
ollama pull <model-name>
```

## Manual Setup (Developers)

If you prefer to set things up manually:

### Backend
```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000 --reload
```

### Frontend
```bash
cd energy-chat-dashboard
npm install
npm run dev
```

### Ollama
```bash
ollama serve
ollama pull qwen3:1.7b
```

## Requirements

- Windows 10 or 11
- ~4 GB free disk space (for the default model + dependencies)
- NVIDIA GPU (optional — enables GPU power monitoring in the energy dashboard)

## Running as a server (macOS)

Lets people you invite use the app from anywhere, each with their own private chats, documents
and energy totals, while their prompts run on this Mac. Design and decisions: `SERVER_STAGE1.md`.

Before you start:
- The Mac has to stay on, awake and logged in to your account.
- Prompts run one at a time. Others see "Waiting in line — N ahead of you".
- You can read everyone's files on this Mac. Tell people that when you invite them.
- If this is an institution's machine or network, check with IT before putting it online.

### 1. Run it in the background

```bash
server/server.sh install
```

This builds the app, makes sure Ollama is running, starts the server, and starts it again at
every login or if it crashes. While it runs, the Mac won't go to sleep on mains power; on battery,
or with the lid closed, it still can.

At this Mac the app is **http://localhost:8000**, with no sign-in and every feature.

| Command | |
|---|---|
| `server/server.sh status` | what's up, and whether Funnel is on |
| `server/server.sh logs` | follow the server log |
| `server/server.sh uninstall` | stop the background server |
| `server/server.sh start` | run it in the terminal instead (Ctrl+C stops it) |

`./start.sh` (development mode) won't start while the background server is installed.

### 2. Put it online with Tailscale Funnel (once)

Free, and only you need a Tailscale account; people you invite just open a link. On macOS,
Funnel needs Tailscale's open-source command-line version from Homebrew. The App Store app and
the app from tailscale.com don't support Funnel, so quit and remove them first if you have them.

```bash
brew install --formula tailscale
```
```bash
sudo brew services start tailscale
```
```bash
sudo tailscale up
```
(prints a link: sign in to create your Tailscale account)
```bash
sudo tailscale funnel --bg 8100
```
The first time, this prints a link to approve Funnel for your account. Approve it and run the
command again. It then shows your public address, like `https://my-mac.tail1234.ts.net`. If it
mentions MagicDNS or HTTPS, turn those on at login.tailscale.com/admin/dns and try again.

Put that address, without `https://`, in `backend/.env`:

```
UNESS_PUBLIC_HOST=my-mac.tail1234.ts.net
```

and restart the server so it picks it up: `server/server.sh install`.

Check it: on your phone, with Wi-Fi off, open the address. You should see the sign-in page.

To take it offline again: `sudo tailscale funnel --https=443 off`.

### 3. Invite people

At http://localhost:8000: click **This Mac** (top right) → **Users** → **Create invite link**, and
send the link yourself. It works once, for 7 days. The same page lets you make someone an admin,
disable them, send a password-reset link, or delete them.

To sign in as yourself from another device, first set a password under **This Mac → Account**.

### Web search

The Web tab needs no API key. It searches with DuckDuckGo and other engines (through the `ddgs`
package) and reads pages directly from this Mac.

Privacy:
- Search engines and websites only see this Mac, never who asked: no account details or cookies.
- Before a search leaves the Mac, emails, phone numbers, IP addresses and long ID, card or account
  numbers are removed, and the model is told to keep names and other personal details out of its
  searches. The status line ("Searching the web for: …") shows exactly what was sent.
- Searches and page addresses aren't written to the server log.
- Pages are only read from public internet addresses, so nobody can use Web to reach this Mac or
  your local network.

Search engines may briefly slow down bursts of automated searches; if that happens, Web says so
and you can try again a minute later.

### Energy report (admins)

**Energy report** in the sidebar (or **This Mac → Users → Energy report** on a phone) shows energy
use for the last 7, 30 or 90 days or all time: totals, a chart per day, and breakdowns by
person, mode and model. **Download CSV** gives every recorded prompt (date, user, mode, model,
energy in Wh, and duration in ms for prompts recorded from now on) for analysis elsewhere.

### What people online can't use

Agent mode and the Code tab (they run commands on this Mac), the test runner, downloading or
deleting models, and opening files on this Mac. These still work for you at the Mac.

### Backups and files

- `backend/userdata/`: the accounts database and everyone else's data. Deleted users' files go
  to `backend/userdata/_deleted/`.
- Yours stay where they always were: `backend/chats/`, `backend/images/`, `backend/rag_cache/`,
  `backend/reports/` (energy history) and `conduct_logs/`.
- Settings: `backend/.env`. Every option is listed in `backend/.env.example`.

## Notes

- Any issues, send an email to raa60@sfu.ca
