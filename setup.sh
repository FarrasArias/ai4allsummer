#!/usr/bin/env bash
set -e

# ============================================================
#  AI4ALL - Setup (macOS / Linux)
#  Run this after extracting the folder, and again after every
#  update (git pull) — it is safe to re-run and only installs
#  what is missing or outdated.
# ============================================================

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo ""
echo "  ============================================"
echo "   AI4ALL - Setup"
echo "  ============================================"
echo "   (Safe to re-run: anything already installed is skipped)"
echo ""

# ----------------------------------------------------------
# Step 1: Check for Python
# ----------------------------------------------------------
echo "  [1/6] Checking for Python..."

PYTHON_CMD=""
if command -v python3 &>/dev/null; then
    PYVER="$(python3 --version 2>&1)"
    echo "        Found: $PYVER"
    PYTHON_CMD="python3"
elif command -v python &>/dev/null; then
    PYVER="$(python --version 2>&1)"
    echo "        Found: $PYVER"
    PYTHON_CMD="python"
else
    echo ""
    echo "  [X] Python is not installed."
    echo ""
    echo "      On macOS, install with Homebrew:"
    echo "        brew install python"
    echo ""
    echo "      Or download from: https://www.python.org/downloads/"
    echo ""
    exit 1
fi

# ----------------------------------------------------------
# Step 2: Check for Node.js / npm
# ----------------------------------------------------------
echo "  [2/6] Checking for Node.js..."

if command -v node &>/dev/null; then
    NODEVER="$(node --version 2>&1)"
    echo "        Found: Node $NODEVER"
else
    echo ""
    echo "  [X] Node.js is not installed."
    echo ""
    echo "      On macOS, install with Homebrew:"
    echo "        brew install node"
    echo ""
    echo "      Or download from: https://nodejs.org/"
    echo ""
    exit 1
fi

if ! command -v npm &>/dev/null; then
    echo "  [X] npm not found. It should come with Node.js."
    echo "      Try reinstalling Node.js."
    exit 1
fi

# ----------------------------------------------------------
# Step 3: Check for / Install Ollama
# ----------------------------------------------------------
echo "  [3/6] Checking for Ollama..."

if command -v ollama &>/dev/null; then
    echo "        Found: Ollama is installed."
elif [ -f "/usr/local/bin/ollama" ]; then
    echo "        Found: Ollama at /usr/local/bin/ollama."
else
    echo "        Ollama is not installed."
    echo ""

    if command -v brew &>/dev/null; then
        read -p "  Install Ollama via Homebrew? (Y/n): " INSTALL_OLLAMA
        if [ "$(echo "$INSTALL_OLLAMA" | tr '[:upper:]' '[:lower:]')" != "n" ]; then
            echo "        Installing Ollama via Homebrew..."
            brew install ollama
        else
            echo "        Skipped. Install manually from: https://ollama.com/download"
            echo "        Then run setup.sh again."
            exit 1
        fi
    else
        echo "      Please install Ollama from: https://ollama.com/download"
        echo "      Or install Homebrew first: https://brew.sh"
        echo "      Then run setup.sh again."
        exit 1
    fi
fi

# ----------------------------------------------------------
# Step 4: Set up Python backend
# ----------------------------------------------------------
echo "  [4/6] Setting up Python backend..."

if [ -f "$ROOT/backend/.venv/bin/python" ]; then
    if "$ROOT/backend/.venv/bin/python" -c "print('ok')" &>/dev/null; then
        echo "        Virtual environment already exists. Updating packages..."
    else
        echo "        Existing virtual environment is stale. Recreating..."
        rm -rf "$ROOT/backend/.venv"
        $PYTHON_CMD -m venv "$ROOT/backend/.venv"
    fi
else
    echo "        Creating virtual environment..."
    $PYTHON_CMD -m venv "$ROOT/backend/.venv"
fi

echo "        Installing Python packages (this may take a minute)..."
"$ROOT/backend/.venv/bin/pip" install -r "$ROOT/backend/requirements.txt" --quiet

# Create backend/.env from the template on first run
if [ ! -f "$ROOT/backend/.env" ] && [ -f "$ROOT/backend/.env.example" ]; then
    cp "$ROOT/backend/.env.example" "$ROOT/backend/.env"
    echo "        Created backend/.env from template."
    echo "        (Optional) Edit backend/.env and set OLLAMA_WEB_API_KEY"
    echo "        to enable web search in the Web tab."
fi

echo "        Backend ready."

# ----------------------------------------------------------
# Step 5: Set up Frontend
# ----------------------------------------------------------
echo "  [5/6] Setting up frontend..."

cd "$ROOT/energy-chat-dashboard"
npm install --silent 2>/dev/null || npm install
cd "$ROOT"
echo "        Frontend ready."

# ----------------------------------------------------------
# Step 6: Pull default AI model
# ----------------------------------------------------------
echo "  [6/6] Setting up AI models..."
echo ""

# Make sure Ollama service is running
echo "        Starting Ollama service..."
ollama serve &>/dev/null &
OLLAMA_PID=$!
sleep 3

# Check if default model is already pulled
if ollama list 2>/dev/null | grep -qi "qwen3:1.7b"; then
    echo "        Default model (qwen3:1.7b) is already downloaded."
else
    echo ""
    echo "  The app needs at least one AI model to work."
    echo "  The default model (qwen3:1.7b) is about ~1 GB to download."
    echo ""
    read -p "  Download the default model now? (Y/n): " PULL_MODEL
    if [ "$(echo "$PULL_MODEL" | tr '[:upper:]' '[:lower:]')" != "n" ]; then
        echo ""
        echo "        Downloading qwen3:1.7b (this may take a few minutes)..."
        ollama pull qwen3:1.7b || echo "  [!] Model download failed. Try: ollama pull qwen3:1.7b"
    else
        echo ""
        echo "  Skipped. You can download models later from the Models tab in the app,"
        echo "  or run:  ollama pull qwen3:1.7b"
    fi
fi

# Embedding model for document search (RAG). Small download, so no prompt —
# without it the app falls back to pasting whole documents into the prompt.
if ollama list 2>/dev/null | grep -qi "nomic-embed-text"; then
    echo "        Embedding model (nomic-embed-text) is already downloaded."
else
    echo ""
    echo "        Downloading nomic-embed-text (~274 MB) — lets the app search"
    echo "        uploaded documents efficiently instead of re-reading them fully..."
    ollama pull nomic-embed-text || echo "  [!] Download failed. Try later: ollama pull nomic-embed-text"
fi

# Kill the Ollama we started (user will start it properly with start.sh)
kill $OLLAMA_PID 2>/dev/null || true

echo ""
echo "  ============================================"
echo "   Optional: Additional Models"
echo "  ============================================"
echo ""
echo "  The app supports several modes, each with a recommended model:"
echo ""
echo "    Chat (fast):      qwen2.5:14b   (~8 GB)"
echo "    Chat (deep):      qwen3:14b     (~9 GB)"
echo "    Code assistant:   qwen2.5-coder:7b  (~4 GB)"
echo "    Image analysis:   qwen2.5vl:7b  (~5 GB)"
echo "    Web search:       qwen2.5:7b    (~4 GB)"
echo ""
echo "  You can download these anytime from the Models tab in the app,"
echo "  or by running:  ollama pull <model-name>"
echo ""

# ----------------------------------------------------------
# macOS only: energy metering via powermetrics
# ----------------------------------------------------------
if [ "$(uname)" = "Darwin" ]; then
    echo ""
    echo "  [+] Energy metering (macOS)..."
    SUDOERS_FILE="/etc/sudoers.d/ai4all-powermetrics"
    if [ -f "$SUDOERS_FILE" ]; then
        echo "      powermetrics permission already configured."
    else
        echo ""
        echo "  The energy dashboard reads Apple Silicon power draw via"
        echo "  'powermetrics', which requires administrator rights."
        echo "  This installs a rule allowing ONLY powermetrics to run"
        echo "  without a password prompt:"
        echo "    $SUDOERS_FILE"
        echo ""
        read -p "  Enable energy metering now? (Y/n): " ENABLE_PM
        if [ "$(echo "$ENABLE_PM" | tr '[:upper:]' '[:lower:]')" != "n" ]; then
            PM_PATH="$(command -v powermetrics || echo /usr/bin/powermetrics)"
            if echo "%admin ALL=(root) NOPASSWD: $PM_PATH" | sudo tee "$SUDOERS_FILE" >/dev/null \
                && sudo chmod 440 "$SUDOERS_FILE"; then
                echo "      Energy metering enabled."
            else
                echo "  [!] Could not install the rule. Energy readings will show 0."
                echo "      You can retry by re-running setup.sh."
            fi
        else
            echo "      Skipped. The app works fine; energy readings show 0 on this Mac."
            echo "      Re-run setup.sh anytime to enable it."
        fi
    fi
fi

# ============================================================
#  Done!
# ============================================================
echo "  ============================================"
echo "   Setup complete!"
echo "  ============================================"
echo ""
echo "   To start the app:"
echo "     ./start.sh"
echo ""
echo "   To download more models later:"
echo "     ollama pull <model-name>"
echo ""
