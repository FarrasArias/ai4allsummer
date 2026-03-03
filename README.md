
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

## Notes

- Any issues, send an email to raa60@sfu.ca
