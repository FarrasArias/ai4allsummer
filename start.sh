#!/usr/bin/env bash
set -e

# ============================================================
#  AI4ALL - Start the App (macOS / Linux)
#  Launches the backend, frontend, and opens the browser.
# ============================================================

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo ""
echo "  ============================================"
echo "   AI4ALL - Starting..."
echo "  ============================================"
echo ""

# ----------------------------------------------------------
# Pre-flight checks
# ----------------------------------------------------------
if [ ! -f "$ROOT/backend/.venv/bin/python" ]; then
    echo "  [X] Backend not set up yet."
    echo "      Please run ./setup.sh first."
    echo ""
    exit 1
fi

if [ ! -d "$ROOT/energy-chat-dashboard/node_modules" ]; then
    echo "  [X] Frontend not set up yet."
    echo "      Please run ./setup.sh first."
    echo ""
    exit 1
fi

# Cleanup function to kill child processes on exit
cleanup() {
    echo ""
    echo "  Shutting down..."
    [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null
    [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null
    # Kill anything on our ports
    lsof -ti:8000 2>/dev/null | xargs kill -9 2>/dev/null || true
    lsof -ti:5173 2>/dev/null | xargs kill -9 2>/dev/null || true
    echo "  Stopped."
    exit 0
}
trap cleanup SIGINT SIGTERM

# ----------------------------------------------------------
# Kill any leftover server processes from previous runs
# ----------------------------------------------------------
echo "  Cleaning up old processes..."
lsof -ti:8000 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti:5173 2>/dev/null | xargs kill -9 2>/dev/null || true
echo "        Done."
echo ""

# ----------------------------------------------------------
# Start Ollama (if not already running)
# ----------------------------------------------------------
echo "  [1/3] Starting Ollama..."

if ollama list &>/dev/null; then
    echo "        Ollama is already running."
else
    if command -v ollama &>/dev/null; then
        ollama serve &>/dev/null &
        echo "        Waiting for Ollama to start..."
        for i in $(seq 1 15); do
            sleep 1
            if ollama list &>/dev/null; then
                echo "        Ollama is ready."
                break
            fi
        done
    else
        echo "  [!] Ollama not found. The app may not work without it."
        echo "      Install Ollama from https://ollama.com/download"
        echo "      or run ./setup.sh again."
        echo ""
    fi
fi

# ----------------------------------------------------------
# Start Backend
# ----------------------------------------------------------
echo "  [2/3] Starting backend server..."

(
    cd "$ROOT/backend"
    source .venv/bin/activate
    python -m uvicorn server:app --host 0.0.0.0 --port 8000 --reload
) &
BACKEND_PID=$!

echo "        Waiting for backend..."
for i in $(seq 1 15); do
    sleep 1
    if curl -s http://localhost:8000/api/health &>/dev/null; then
        echo "        Backend is ready."
        break
    fi
done

# ----------------------------------------------------------
# Start Frontend
# ----------------------------------------------------------
echo "  [3/3] Starting frontend..."

(
    cd "$ROOT/energy-chat-dashboard"
    npm run dev
) &
FRONTEND_PID=$!

sleep 4

# ----------------------------------------------------------
# Open browser
# ----------------------------------------------------------
echo ""
echo "        Opening app in browser..."
if command -v open &>/dev/null; then
    open "http://localhost:5173/"
elif command -v xdg-open &>/dev/null; then
    xdg-open "http://localhost:5173/"
else
    echo "        Open http://localhost:5173/ in your browser."
fi

# ----------------------------------------------------------
# Keep running
# ----------------------------------------------------------
echo ""
echo "  ============================================"
echo "   AI4ALL is running!"
echo "  ============================================"
echo ""
echo "   App:      http://localhost:5173"
echo "   Backend:  http://localhost:8000"
echo ""
echo "   Press Ctrl+C to stop."
echo "  ============================================"
echo ""

wait
