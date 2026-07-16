# U.ness App — Change Log (July 15, 2026)

## Energy metering
- Per-prompt GPU energy is now measured on **every** mode (was: Chat only): Vibe Coding, Web, Image Analysis, Image Gen, and the coding Agent. All endpoints return `energy_wh` + `inference_time_ms`. Fixed a double-counting bug in the Chat path.
- Energy sidebar now shows on all tabs (intervention group), not just Chat.
- **macOS support**: on Apple Silicon, power is read via `powermetrics` (whole-SoC CPU+GPU+ANE). `setup.sh` asks consent to install a narrow sudoers rule (passwordless `powermetrics` only); declining just disables metering. NVIDIA path unchanged. *Still needs a smoke test on a real Mac.*

## RAG for attached documents (Chat + Web)
- New local RAG pipeline, fully DIY: paragraph-aware chunking (~375 tokens, overlapping) → `nomic-embed-text` embeddings via Ollama → numpy cosine retrieval → only the top-4 relevant excerpts enter the prompt (was: entire document pasted into every prompt — large energy + context saving).
- PDF excerpts cite **page numbers** ("Excerpt 1 — from report.pdf, page 4").
- Embeddings persist to disk (`backend/rag_cache/`), so uploaded documents survive backend restarts.
- Graceful fallback to the old full-document behavior if the embedding model isn't installed. Embedding model is swappable via config (`models.json` → `embedding`, or `OLLAMA_EMBED_MODEL` env).
- Fixed: re-sent attachments were re-indexed on every prompt (compounding context growth).

## Web tab overhaul
- Accepts document attachments (pdf/docx/txt/csv) with RAG, same as Chat. Images are refused with a pointer to the Image tab (per the design doc's separation principle).
- Responses now stream over SSE with **real orchestration status messages**: "Searching your documents…", "Searching the web for: …", "Reading <url>…".
- Web search API key removed from source code → `OLLAMA_WEB_API_KEY` in `backend/.env` (loaded automatically at startup; template created by setup).

## Images: explicit, human-in-the-loop (per design doc)
- Documents remain **text-only**; figures in PDFs/DOCX are now detected and flagged inline ("page N contains figures — use the Image tool"), never silently processed.
- Image tab accepts **paste (Ctrl+V) and drag-and-drop** — screenshot a figure from a PDF and paste it directly.
- Main Chat additionally supports explicit image attachments (vision model required, e.g. qwen2.5vl:7b) — user-initiated only.

## Agentic chat
- Main Chat has a third mode next to Fast/Deep think: **Agent** — the local claw coding agent with file/shell tools, tool calls rendered inline. Fixed two integration bugs (tool-call signature mismatch; agent was sandboxed to `backend/` instead of the project root).

## Reliability fixes (reported issues)
- **"Web chats blank when you leave and return" / "autosave unreliable"**: all tabs (Chat, Web, Vibe, Image, Image Gen) now persist transcripts across tab switches and page refreshes; reset buttons clear them.

## Setup
- Setup scripts are explicitly **safe to re-run** — after a `git pull`, double-click setup and only missing pieces are installed (new packages, embedding model, `.env` scaffold).
- Auto-installs `nomic-embed-text` (~274 MB) for RAG.

## Actions needed
1. On the current Windows box: run `ollama pull nomic-embed-text` (or re-run `setup.bat`), then restart the backend — until then RAG falls back to full-document mode.
2. Put the real web-search key in `backend/.env` (`OLLAMA_WEB_API_KEY=…`).
3. Smoke-test energy metering on the Mac (`setup.sh` → accept the powermetrics prompt → check sidebar shows non-zero Wh).
4. `test_rag_document.txt` (repo root) contains buried "needle" facts for demoing RAG retrieval.

## Not done (out of scope, per plan review)
- Mac Mini vs RTX 3090 energy comparison experiment (methodology/measurement work, not app code).
- MLX / LM Studio engines — app remains Ollama-based.
