#!/usr/bin/env bash
set -e

# ============================================================
#  AI4ALL - One-Time Setup (macOS / Linux)
#  Run this once after extracting the folder.
#  It installs all dependencies so the app is ready to use.
# ============================================================

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo ""
echo "  ============================================"
echo "   AI4ALL - One-Time Setup"
echo "  ============================================"
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
