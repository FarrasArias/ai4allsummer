#!/usr/bin/env bash
# ============================================================
#  U.ness server mode (macOS) — SERVER_STAGE1.md §8
#
#    server/server.sh start      run in this terminal (Ctrl+C stops it)
#    server/server.sh install    run in the background: starts at login,
#                                restarts if it crashes
#    server/server.sh uninstall  stop the background service
#    server/server.sh status     is it up, and is it reachable online?
#    server/server.sh logs       follow the server log
#
#  At this Mac the app is http://localhost:8000. Invited people reach it
#  through Tailscale Funnel, which forwards to port 8100 (see README).
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/energy-chat-dashboard"
PY="$BACKEND/.venv/bin/python"
LABEL="com.uness.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$BACKEND/userdata/logs"
DOMAIN="gui/$(id -u)"

# Same settings serve.py reads: environment first, then backend/.env
env_setting() {
    local value="${!1:-}"
    [ -z "$value" ] && [ -f "$BACKEND/.env" ] && value="$(sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$BACKEND/.env" | tail -1)"
    echo "${value:-$2}"
}
LOCAL_PORT="$(env_setting UNESS_LOCAL_PORT 8000)"
PUBLIC_PORT="$(env_setting UNESS_PUBLIC_PORT 8100)"
LOCAL_URL="http://127.0.0.1:$LOCAL_PORT"
PUBLIC_URL="http://127.0.0.1:$PUBLIC_PORT"

say() { echo "  $*"; }
fail() { echo ""; say "[X] $*"; echo ""; exit 1; }

need_setup() {
    [ -x "$PY" ] || fail "The backend isn't set up yet. Run ./setup.sh first."
    [ -d "$FRONTEND/node_modules" ] || fail "The frontend isn't set up yet. Run ./setup.sh first."
}

service_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

port_busy() { lsof -ti "tcp:$1" -sTCP:LISTEN >/dev/null 2>&1; }

build_frontend() {
    # Rebuild only when something changed since the last build
    local stamp="$FRONTEND/dist/index.html"
    if [ ! -f "$stamp" ] || [ -n "$(find "$FRONTEND/src" "$FRONTEND/index.html" "$FRONTEND/vite.config.ts" "$FRONTEND/package.json" -newer "$stamp" -print -quit)" ]; then
        say "Building the app..."
        (cd "$FRONTEND" && npm run build --silent) || fail "The app didn't build (see the errors above)."
    fi
}

ensure_ollama() {
    curl -s -m 2 http://127.0.0.1:11434/api/tags >/dev/null && return
    if command -v brew >/dev/null && brew list --formula ollama >/dev/null 2>&1; then
        say "Starting Ollama as a background service..."
        brew services start ollama >/dev/null
    else
        fail "Ollama isn't running. Open the Ollama app, or: brew install ollama && brew services start ollama"
    fi
    for _ in $(seq 1 20); do
        curl -s -m 2 http://127.0.0.1:11434/api/tags >/dev/null && return
        sleep 1
    done
    fail "Ollama didn't start."
}

ports_free() {
    for port in "$LOCAL_PORT" "$PUBLIC_PORT"; do
        if port_busy "$port"; then
            fail "Port $port is in use — probably ./start.sh. Stop it first (Ctrl+C in its terminal)."
        fi
    done
}

wait_healthy() {
    for _ in $(seq 1 30); do
        curl -s -m 2 "$LOCAL_URL/api/health" >/dev/null && return 0
        sleep 1
    done
    return 1
}

cmd_start() {
    need_setup
    service_loaded && fail "The background service is already running. Stop it first: server/server.sh uninstall"
    ports_free
    build_frontend
    ensure_ollama
    say "Starting. At this Mac: http://localhost:$LOCAL_PORT   (Ctrl+C to stop)"
    cd "$BACKEND" && exec "$PY" serve.py
}

cmd_install() {
    need_setup
    if service_loaded; then
        say "Replacing the running service..."
        launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
        sleep 2
    fi
    ports_free
    build_frontend
    ensure_ollama
    mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"

    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PY</string>
        <string>$BACKEND/serve.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$BACKEND</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>PYTHONUNBUFFERED</key>
        <string>1</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/server.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/server.log</string>
</dict>
</plist>
EOF

    launchctl bootstrap "$DOMAIN" "$PLIST"
    if wait_healthy; then
        echo ""
        say "U.ness is running in the background, and will start again when you log in."
        say "At this Mac: http://localhost:$LOCAL_PORT"
        say "Status: server/server.sh status    Logs: server/server.sh logs"
        echo ""
    else
        fail "It didn't come up within 30 seconds. See: server/server.sh logs"
    fi
}

cmd_uninstall() {
    if service_loaded; then
        launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
        say "Stopped the background service."
    else
        say "The background service wasn't running."
    fi
    rm -f "$PLIST"
    say "Ollama is left running. To stop it too: brew services stop ollama"
}

cmd_status() {
    if service_loaded; then say "Background service: installed"; else say "Background service: not installed"; fi
    if curl -s -m 2 "$LOCAL_URL/api/health" >/dev/null; then say "At this Mac ($LOCAL_PORT): up"; else say "At this Mac ($LOCAL_PORT): down"; fi
    if curl -s -m 2 "$PUBLIC_URL/api/health" >/dev/null; then say "Online listener ($PUBLIC_PORT): up"; else say "Online listener ($PUBLIC_PORT): down"; fi
    if curl -s -m 2 http://127.0.0.1:11434/api/tags >/dev/null; then say "Ollama: up"; else say "Ollama: down"; fi
    if command -v tailscale >/dev/null; then
        say "Tailscale Funnel:"
        tailscale funnel status 2>/dev/null | sed 's/^/      /' || say "    (couldn't read it — try: sudo tailscale funnel status)"
    else
        say "Tailscale: not installed (see README → Running as a server)"
    fi
}

cmd_logs() {
    [ -f "$LOG_DIR/server.log" ] || fail "No log yet. Is the service installed? (server/server.sh install)"
    tail -n 100 -f "$LOG_DIR/server.log"
}

case "${1:-}" in
    start) cmd_start ;;
    install) cmd_install ;;
    uninstall) cmd_uninstall ;;
    status) cmd_status ;;
    logs) cmd_logs ;;
    *) sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
