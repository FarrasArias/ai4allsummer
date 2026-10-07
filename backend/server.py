# server.py

import os

# Load backend/.env into the environment BEFORE importing modules that read
# env vars at import time (web_chat, rag_store). Shell env vars take
# precedence over .env values. Tiny parser — no python-dotenv dependency.
def _load_dotenv():
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                os.environ.setdefault(key.strip(), value.strip())
    except OSError:
        pass

_load_dotenv()

from image_v1 import DEFAULT_MODEL as IMAGE_DEFAULT_MODEL
from vibe_coding import DEFAULT_MODEL as VIBE_DEFAULT_MODEL, VibeCodingChat
from web_chat import DEFAULT_MODEL as WEB_DEFAULT_MODEL, WebChatSession
from image_gen import DEFAULT_ENHANCER_MODEL as IMGGEN_DEFAULT_MODEL, ImageGenEngine

# Load model configuration from external config file
def _load_model_config():
    config_path = os.path.join(os.path.dirname(__file__), "configs", "models.json")
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"Warning: Could not load models.json config: {e}")
        return {
            "chat": {"fast": "qwen2.5:14b", "thinking": "qwen3:14b", "default": "qwen3:1.7b"},
            "vibe_coding": {"default": "qwen2.5-coder:7b"},
            "image": {"default": "qwen2.5vl:7b"},
            "web": {"default": "qwen2.5:7b"},
            "image_gen": {"default": "qwen2.5:7b"}
        }

# Defer loading until after imports
_MODEL_CONFIG = None

def get_model_config():
    global _MODEL_CONFIG
    if _MODEL_CONFIG is None:
        _MODEL_CONFIG = _load_model_config()
    return _MODEL_CONFIG

# Legacy constant for backwards compatibility
CHAT_DEFAULT_MODEL = "qwen3:1.7b"  # Overridden by config if available

import os
import io
import base64
import json
from pathlib import Path as _Path
import time
import shutil
import threading
import subprocess
import signal
import asyncio
from datetime import date
from contextlib import asynccontextmanager
from typing import List, Optional, AsyncGenerator

import anyio
import fitz  # PyMuPDF (kept for compatibility. TODO: Remove?)
import ollama
import requests
from fastapi import FastAPI, UploadFile, File, Form, Depends, Request
from fastapi.responses import FileResponse, Response, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware

from utilities import accounts
from utilities.access import (
    AccessMiddleware,
    CLIENT_HEADER,
    PUBLIC_HOST,
    SESSION_COOKIE,
    User,
    current_user,
    require_admin,
    require_local,
    session_token,
)
from utilities.inference_queue import QUEUE, QueueBusy, QueueTimeout, queued_response
from utilities import energy
from utilities.energy import EnergyMeter
from utilities.engine_registry import EngineRegistry
from utilities.user_paths import InvalidName, paths_for, safe_child
from utilities.uploads import (
    UploadTooLarge,
    clean_filename,
    new_upload_dir,
    read_upload,
    remove_dir,
    save_upload,
)

from claw_agent_wrapper import (
    run_agent_streaming,
    reset_agent as claw_reset_agent,
    DEFAULT_AGENT_MODEL,
)

from utilities.ollama_utils import extract_model_names
from utilities.power_usage import get_default_power_usages
from utilities import conduct_store
from utilities import about_store

# Shared chat engine with memory + doc window
from chat_core import OllamaChat

# -----------------------------
# Global state
# -----------------------------
CHAT_DIR = "chats"
IMG_DIR = "images"
REPORTS_DIR = "reports"

# Uploads with these extensions are treated as vision inputs for the chat
# model rather than as text documents
IMAGE_UPLOAD_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
os.makedirs(CHAT_DIR, exist_ok=True)
os.makedirs(IMG_DIR, exist_ok=True)
os.makedirs(REPORTS_DIR, exist_ok=True)
conduct_store.ensure_initialized()
about_store.ensure_initialized()

# Each user's last-used model — the conduct index endpoints' fallback
_last_model: dict[int, str] = {}

# Engines per (user, model): each holds one conversation and its documents,
# so they're never shared between users (SERVER_STAGE1.md §3)
CHAT_ENGINES: EngineRegistry[OllamaChat] = EngineRegistry(
    lambda user, model: OllamaChat(model=model, rag_dir=paths_for(user).rag_cache))
VIBE_ENGINES: EngineRegistry[VibeCodingChat] = EngineRegistry(
    lambda user, model: VibeCodingChat(model=model))
WEB_SESSIONS: EngineRegistry[WebChatSession] = EngineRegistry(
    lambda user, model: WebChatSession(model=model, rag_dir=paths_for(user).rag_cache))
IMGGEN_ENGINES: EngineRegistry[ImageGenEngine] = EngineRegistry(
    lambda user, model: ImageGenEngine(enhancer_model=model))
_ALL_ENGINES = (CHAT_ENGINES, VIBE_ENGINES, WEB_SESSIONS, IMGGEN_ENGINES)


def _user_dir(path) -> str:
    """A per-user folder, created on first use."""
    os.makedirs(path, exist_ok=True)
    return str(path)


@asynccontextmanager
async def _lifespan(_app):
    # Sync endpoints, and model streams while they generate, each borrow a
    # worker thread; the default 40 is tight once several people use the app.
    anyio.to_thread.current_default_thread_limiter().total_tokens = 200
    accounts.init()
    energy.start_sampler()
    yield


app = FastAPI(title="React <> Python API (Ollama)", lifespan=_lifespan)
app.add_middleware(AccessMiddleware, owner=accounts.owner, session_user=accounts.user_for_session)

# The frontend is served from the same origin (directly, or through Vite's
# dev proxy), so no CORS by default. A wildcard origin with credentials would
# let any website make logged-in requests and read the answers.
_cors_origins = [o.strip() for o in os.environ.get("UNESS_CORS_ORIGINS", "").split(",") if o.strip()]
if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*", CLIENT_HEADER],
    )


@app.exception_handler(UploadTooLarge)
def _upload_too_large(_request, exc: UploadTooLarge):
    return JSONResponse({"error": str(exc)}, status_code=413)


@app.exception_handler(InvalidName)
def _invalid_name(_request, exc: InvalidName):
    return JSONResponse({"error": str(exc)}, status_code=400)


@app.exception_handler(accounts.AccountError)
def _account_error(_request, exc: accounts.AccountError):
    return JSONResponse({"error": str(exc)}, status_code=400)


@app.exception_handler(QueueBusy)
def _queue_busy(_request, exc: QueueBusy):
    return JSONResponse({"error": str(exc)}, status_code=429)


@app.exception_handler(QueueTimeout)
def _queue_timeout(_request, exc: QueueTimeout):
    return JSONResponse({"error": str(exc)}, status_code=503)


# Queue status/error events in each stream's own shape (see queued_stream):
# chat and image analysis use {"status"}/{"error"}; web and agent use "type".
def _chat_event(kind: str, text: str) -> dict:
    return {kind: text}


def _typed_event(kind: str, text: str) -> dict:
    return {"type": "status", "text": text} if kind == "status" else {"type": "error", "error": text}

# -----------------------------
# Model management endpoints
# -----------------------------
@app.get("/api/models")
def list_models():
    return {"models": list(extract_model_names().keys())}


@app.post("/api/models/pull", dependencies=[Depends(require_admin)])
def pull_model(name: str = Form(...)):
    try:
        ollama.pull(name)
        return {"ok": True}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@app.delete("/api/models", dependencies=[Depends(require_admin)])
def delete_models(models: List[str]):
    results = {}
    for m in models:
        try:
            ollama.delete(m)
            results[m] = "deleted"
            # Also drop any in-memory chat engine for this model
            for registry in _ALL_ENGINES:
                registry.drop_model(m)
        except Exception as e:
            results[m] = f"error: {e}"
    return {"results": results}


@app.post("/api/models/load", dependencies=[Depends(require_admin)])
def load_model_endpoint(model: str = Form(...), user: User = Depends(current_user)):
    """
    Preload a model into Ollama GPU memory without generating any output.
    Blocks until the model is fully loaded. Use this to warm up the GPU
    before the first prompt so the initial response isn't delayed.
    """
    # Loading uses the GPU, so it takes a turn — but doesn't count toward the
    # user's one-request limit, or switching models would block their next prompt
    ticket = QUEUE.enter(user.id, "a model load", counted=False)
    try:
        QUEUE.acquire(ticket)
        r = requests.post(
            "http://localhost:11434/api/generate",
            json={"model": model, "prompt": "", "keep_alive": -1, "stream": False},
            timeout=120,
        )
        r.raise_for_status()
        return {"ok": True, "model": model}
    except QueueTimeout:
        raise
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    finally:
        QUEUE.release(ticket)


@app.post("/api/models/create", dependencies=[Depends(require_admin)])
def create_model(name: str = Form(...), modelfile: str = Form(...)):
    try:
        ollama.create(model=name, modelfile=modelfile)
        return {"ok": True}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


from typing import Dict

@app.get("/api/modes/default-models")
def get_mode_defaults():
    """
    Return backend-defined default model per high-level mode, and whether it is
    currently installed in Ollama. Also includes fast/thinking presets for chat mode.
    """
    model_names = extract_model_names().keys()  # e.g. {"qwen2.5:7b", ...}
    config = get_model_config()

    def info(model: str) -> Dict[str, object]:
        return {
            "default": model,
            "installed": model in model_names,
        }

    # Get chat config with fast/thinking models
    chat_config = config.get("chat", {})
    chat_default = chat_config.get("default", CHAT_DEFAULT_MODEL)
    chat_fast = chat_config.get("fast", chat_default)
    chat_thinking = chat_config.get("thinking", chat_default)

    return {
        "chat": {
            **info(chat_default),
            "fast": chat_fast,
            "fast_installed": chat_fast in model_names,
            "thinking": chat_thinking,
            "thinking_installed": chat_thinking in model_names,
        },
        "vibe_coding": info(config.get("vibe_coding", {}).get("default", VIBE_DEFAULT_MODEL)),
        "image": info(config.get("image", {}).get("default", IMAGE_DEFAULT_MODEL)),
        "web": info(config.get("web", {}).get("default", WEB_DEFAULT_MODEL)),
        "image_gen": info(config.get("image_gen", {}).get("default", IMGGEN_DEFAULT_MODEL)),
    }


# -----------------------------
# Chat (streaming SSE)
# -----------------------------
@app.post("/api/chat")
def chat(
    prompt: str = Form(...),
    model: str = Form(...),
    thinking_mode: str = Form("fast"),
    files: Optional[List[UploadFile]] = File(None),
    user: User = Depends(current_user),
) -> StreamingResponse:
    """
    Streams text chunks as Server-Sent Events (text/event-stream).
    Endpoint signature and path remain unchanged.
    """

    ticket = QUEUE.enter(user.id, "a chat")

    # Images become vision inputs for this prompt; other files are added to
    # the model's document context (RAG-indexed)
    context_files: List[str] = []
    images_b64: List[str] = []
    upload_dir = new_upload_dir(paths_for(user).uploads / "chat") if files else None
    try:
        for f in files or []:
            if os.path.splitext(clean_filename(f.filename))[1].lower() in IMAGE_UPLOAD_EXTS:
                images_b64.append(base64.b64encode(read_upload(f)).decode("ascii"))
            else:
                context_files.append(str(save_upload(f, upload_dir)))

        # Get or create the chat engine for this model
        engine = CHAT_ENGINES.get(user, model)
    except BaseException:
        QUEUE.release(ticket)
        if upload_dir:
            remove_dir(upload_dir)
        raise

    def _gen() -> AsyncGenerator[bytes, None]:

        # Load uploaded docs into the engine's document window. Indexing
        # embeds them on the GPU, so it happens here, once it's our turn.
        if context_files:
            yield f"data: {json.dumps({'status': 'Reading your documents…'})}\n\n".encode("utf-8")
        for path in context_files:
            try:
                engine.add_document(path)
            except Exception as e:
                # Non-fatal: we log, but still attempt to answer the prompt
                print(f"Error loading document {path}: {e}")

        _last_model[user.id] = model

        meter = EnergyMeter(user, model, "chat")
        meter.start()

        try:
            for chunk in engine.stream_chat(
                prompt,
                thinking_mode=thinking_mode,
                images=images_b64 or None,
            ):
                # str chunks are response text; dict chunks are progress
                # events like {"status": "Searching your documents…"}
                payload = chunk if isinstance(chunk, dict) else {"delta": chunk}
                yield f"data: {json.dumps(payload)}\n\n".encode("utf-8")
                meter.sample()
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n".encode("utf-8")
        finally:
            energy_wh, inference_time_ms = meter.finish()

            done_payload = {
                "done": True,
                "inference_time_ms": inference_time_ms,
                "energy_wh": energy_wh,
                "input_tokens": engine._last_prompt_eval_count,
                "output_tokens": engine._last_eval_count,
                "user_prompt_tokens": engine._last_user_prompt_tokens,
            }
            yield f"data: {json.dumps(done_payload)}\n\n".encode("utf-8")

    return queued_response(
        ticket, _gen, _chat_event,
        cleanup=(lambda: remove_dir(upload_dir)) if upload_dir else None,
    )

@app.post("/api/chat/reset")
def reset_chat(model: str = Form(...), user: User = Depends(current_user)):
    """
    Reset conversation history + loaded documents for the given model,
    and zero out per-session energy counters so the dashboard starts fresh.
    Safe to call before any prompt has been sent — if no engine exists yet,
    just zero the counters and return OK without creating a new engine.
    """
    # Only reset the engine if one already exists — avoid creating a new one
    # (which verifies the model via ollama.show and can fail before first prompt)
    engine = CHAT_ENGINES.peek(user, model)
    if engine is not None:
        engine.reset()

    energy.reset_session(user)

    return {"ok": True}

# -----------------------------
# Vibe coding (non-streaming JSON)
# -----------------------------
@app.post("/api/vibe/code")
def vibe_code(
    prompt: str = Form(...),
    model: str = Form(...),
    files: Optional[List[UploadFile]] = File(None),
    user: User = Depends(current_user),
):
    """
    Non-streaming coding assistant endpoint.

    - Uses VibeCodingChat (per-model session)
    - Optionally loads uploaded code files into context
    - Returns JSON: { ok: bool, response?: str, error?: str }
    """

    ticket = QUEUE.enter(user.id, "a code request")
    try:
        engine = VIBE_ENGINES.get(user, model)

        # Save any uploaded code files and load them into the vibe engine
        if files:
            upload_dir = new_upload_dir(paths_for(user).uploads / "vibe")
            try:
                for f in files:
                    path = save_upload(f, upload_dir)
                    try:
                        engine.load_code_file(str(path))
                    except Exception as e:
                        print(f"Error loading code file {path}: {e}")
            finally:
                remove_dir(upload_dir)

        QUEUE.acquire(ticket)

        _last_model[user.id] = model

        meter = EnergyMeter(user, model, "code")
        meter.start()
        try:
            reply = engine.code(prompt, stream=False)
            energy_wh, inference_time_ms = meter.finish()
            return {"ok": True, "response": reply, "energy_wh": energy_wh, "inference_time_ms": inference_time_ms}
        except Exception as e:
            meter.finish()
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    finally:
        QUEUE.release(ticket)

@app.post("/api/vibe/reset")
def reset_vibe(model: str = Form(...), user: User = Depends(current_user)):
    """
    Reset VibeCodingChat state for the given model,
    and reset per-session energy counters.
    """
    engine = VIBE_ENGINES.get(user, model)
    engine.reset()

    energy.reset_session(user)

    return {"ok": True}

# -----------------------------
# Web chat (SSE streaming with orchestration status events)
# -----------------------------
@app.post("/api/web/chat")
def web_chat_endpoint(
    prompt: str = Form(...),
    model: str = Form(...),
    files: Optional[List[UploadFile]] = File(None),
    user: User = Depends(current_user),
):
    """
    Web-enabled chat endpoint (SSE).

    - Accepts document uploads (pdf/docx/txt/csv) which are RAG-indexed
    - Streams real progress events: {"type":"status"|"assistant"|"error"|"done"}
    - The final done event carries per-prompt energy metrics
    """
    ticket = QUEUE.enter(user.id, "a web search")
    try:
        accounts.count_web_prompt(user)
    except BaseException:
        QUEUE.release(ticket)
        raise

    # Persist uploads (documents only — images are handled exclusively by the
    # Image tab, per the HITL energy policy); they're indexed once it's our turn
    doc_notes: List[str] = []
    saved_docs: List[tuple] = []
    upload_dir = new_upload_dir(paths_for(user).uploads / "web") if files else None
    try:
        session = WEB_SESSIONS.get(user, model)
        for f in files or []:
            name = clean_filename(f.filename)
            if os.path.splitext(name)[1].lower() in IMAGE_UPLOAD_EXTS:
                doc_notes.append(f"Skipped {name}: images are analyzed in the Image tab.")
                continue
            saved_docs.append((name, save_upload(f, upload_dir)))
    except BaseException:
        QUEUE.release(ticket)
        if upload_dir:
            remove_dir(upload_dir)
        raise

    def _gen():

        for name, dst in saved_docs:
            try:
                info = session.add_document(str(dst))
                if info.get("skipped"):
                    continue
                chunks = info.get("rag_chunks")
                doc_notes.append(
                    f"Loaded {name}"
                    + (f" ({chunks} sections indexed)" if chunks else "")
                )
            except Exception as e:
                doc_notes.append(f"Could not load {name}: {e}")

        _last_model[user.id] = model

        meter = EnergyMeter(user, model, "web")
        meter.start()
        try:
            for note in doc_notes:
                yield f"data: {json.dumps({'type': 'status', 'text': note})}\n\n".encode("utf-8")
            for event in session.ask_events(prompt):
                yield f"data: {json.dumps(event)}\n\n".encode("utf-8")
                meter.sample()
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n".encode("utf-8")
        finally:
            energy_wh, inference_time_ms = meter.finish()
            done = {"type": "done", "energy_wh": energy_wh, "inference_time_ms": inference_time_ms}
            yield f"data: {json.dumps(done)}\n\n".encode("utf-8")

    return queued_response(
        ticket, _gen, _typed_event,
        cleanup=(lambda: remove_dir(upload_dir)) if upload_dir else None,
    )


@app.post("/api/web/reset")
def reset_web(model: str = Form(...), user: User = Depends(current_user)):
    """
    Reset WebChatSession for the given model and clear session energy.
    """
    session = WEB_SESSIONS.get(user, model)
    session.reset()

    energy.reset_session(user)

    return {"ok": True}


# -----------------------------
# RAG: list persisted documents for a mode+model
# -----------------------------
@app.get("/api/rag/documents")
def rag_documents(mode: str = "chat", model: str = "", user: User = Depends(current_user)):
    """
    Return document names stored in the RAG cache for a mode+model, so the
    frontend can show that previously uploaded documents are still loaded
    after a restart (the file-picker itself can't be restored).
    """
    from utilities.rag_store import RagStore

    if mode not in ("chat", "web"):
        return JSONResponse({"error": "mode must be 'chat' or 'web'"}, status_code=400)
    safe_model = "".join(c if c.isalnum() or c in "._-" else "_" for c in model)
    store = RagStore(persist_dir=paths_for(user).rag_cache / f"{mode}_{safe_model}")
    return {"documents": store.document_names()}


# -----------------------------
# Conduct: reference/snippets content, and the append-only log
# -----------------------------
@app.get("/api/conduct/content")
def conduct_content():
    """reference.md + snippets.md, re-read from disk on every call so edits
    made in an external editor show up without a restart."""
    return conduct_store.read_content()


@app.get("/api/conduct/logs")
def conduct_logs(user: User = Depends(current_user)):
    return {"logs": conduct_store.list_logs(paths_for(user).conduct_logs)}


@app.get("/api/conduct/log/{slug}")
def conduct_log_content(slug: str, user: User = Depends(current_user)):
    """A log's raw markdown, for the read-only view on the Conduct page.
    Display only — the app never writes through this."""
    try:
        return {"content": conduct_store.read_log(slug, paths_for(user).conduct_logs)}
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@app.post("/api/conduct/log/{slug}/append")
def conduct_append(slug: str, payload: dict, user: User = Depends(current_user)):
    """Append one entry to a conduct log (creating it on first use).

    Note/prompt/response may each be empty, but not all three — a note-only
    entry (e.g. a Commit with no AI turn) is valid and must be written.
    """
    try:
        logs_dir = paths_for(user).conduct_logs
        path = conduct_store.append_entry(slug, payload, logs_dir)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    # Same form as the log list ("conduct_logs/<slug>.md") — not where this
    # Mac keeps it, which is nobody's business online
    return {"ok": True, "path": path.relative_to(logs_dir.parent).as_posix()}


@app.post("/api/conduct/open", dependencies=[Depends(require_local)])
def conduct_open(payload: dict):
    """Open a conduct log in the OS default editor, or reveal it in its
    containing folder. The path is validated to resolve inside
    conduct_logs/ before anything is executed."""
    try:
        conduct_store.open_path(payload.get("path", ""), bool(payload.get("reveal", False)))
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    return {"ok": True}


@app.post("/api/conduct/log/{slug}/index")
def conduct_index(slug: str, payload: dict | None = None, user: User = Depends(current_user)):
    """Register a conduct log with a chat model's knowledge layer, so later
    questions can retrieve it as a source document.

    Deliberately a button press rather than something that happens on every
    append: indexing embeds the whole file, and the log only grows. The
    engine re-indexes rather than adds, so pressing this repeatedly replaces
    the previous copy instead of stacking duplicates.
    """
    payload = payload or {}
    try:
        path = conduct_store.log_path(slug, paths_for(user).conduct_logs)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    model = (
        payload.get("model")
        or _last_model.get(user.id)
        or get_model_config().get("chat", {}).get("default", CHAT_DEFAULT_MODEL)
    )
    # Embedding the log is GPU work, so it waits for a turn
    ticket = QUEUE.enter(user.id, "document indexing")
    try:
        QUEUE.acquire(ticket)
        info = CHAT_ENGINES.get(user, model).reindex_document(str(path))
    except QueueTimeout:
        raise
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    finally:
        QUEUE.release(ticket)

    return {
        "ok": True,
        "model": model,
        "chunks": info.get("rag_chunks"),
        "skipped": bool(info.get("skipped")),
    }


@app.delete("/api/conduct/log/{slug}/index")
def conduct_unindex(slug: str, model: str = "", user: User = Depends(current_user)):
    """Remove a conduct log from a chat model's knowledge layer.

    The inverse of the index endpoint. Indexing is per mode+model, so this
    only affects the model given (or the last chat model used).
    """
    try:
        path = conduct_store.log_path(slug, paths_for(user).conduct_logs)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    model = (
        model
        or _last_model.get(user.id)
        or get_model_config().get("chat", {}).get("default", CHAT_DEFAULT_MODEL)
    )
    removed = CHAT_ENGINES.get(user, model).remove_document(path.name)
    return {"ok": True, "model": model, "removed": removed}


# -----------------------------
# About Uness
# -----------------------------
@app.get("/api/about")
def about_content():
    """about.md, re-read from disk on every call so a hand edit shows up
    without a restart."""
    return {"content": about_store.read_about()}


# -----------------------------
# Image generation (SD WebUI + Ollama prompt enhancement)
# -----------------------------
@app.post("/api/image-gen/generate")
def image_gen_endpoint(
    prompt: str = Form(...),
    model: str = Form(...),
    enhance: str = Form("true"),
    negative_prompt: str = Form(""),
    width: int = Form(512),
    height: int = Form(512),
    steps: int = Form(25),
    cfg_scale: float = Form(7.0),
    user: User = Depends(current_user),
):
    """
    Generate an image via local Stable Diffusion WebUI API.
    `model` is the Ollama model used for prompt enhancement.
    Returns JSON with base64 image and metadata.
    """
    ticket = QUEUE.enter(user.id, "an image generation")
    try:
        QUEUE.acquire(ticket)
        return _generate_image(user, prompt, model, enhance, negative_prompt, width, height, steps, cfg_scale)
    finally:
        QUEUE.release(ticket)


def _generate_image(user, prompt, model, enhance, negative_prompt, width, height, steps, cfg_scale):

    _last_model[user.id] = model

    engine = IMGGEN_ENGINES.get(user, model)
    do_enhance = enhance.lower() in ("true", "1", "yes")

    meter = EnergyMeter(user, model, "image_generation")
    meter.start()
    try:
        result = engine.generate(
            prompt=prompt,
            negative_prompt=negative_prompt or None,
            width=width,
            height=height,
            steps=steps,
            cfg_scale=cfg_scale,
            enhance=do_enhance,
        )
        energy_wh, inference_time_ms = meter.finish()
        return {
            "ok": True,
            "image_b64": result["image_b64"],
            "prompt_used": result["prompt_used"],
            "original_prompt": result["original_prompt"],
            "parameters": result["parameters"],
            "energy_wh": energy_wh,
            "inference_time_ms": inference_time_ms,
        }
    except ConnectionError as e:
        meter.finish()
        return JSONResponse({"ok": False, "error": str(e)}, status_code=503)
    except Exception as e:
        meter.finish()
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@app.get("/api/image-gen/status")
def image_gen_status():
    """Check if the SD WebUI API is reachable and list available SD models."""
    engine = ImageGenEngine(enhancer_model=IMGGEN_DEFAULT_MODEL)  # only asks SD WebUI what it has
    available = engine.sd_available()
    sd_models = engine.get_sd_models() if available else []
    return {
        "sd_available": available,
        "sd_models": sd_models,
    }


@app.post("/api/image-gen/reset")
def reset_image_gen(model: str = Form(...), user: User = Depends(current_user)):
    """Reset ImageGenEngine history for the given model."""
    engine = IMGGEN_ENGINES.get(user, model)
    engine.reset()

    energy.reset_session(user)

    return {"ok": True}


# -----------------------------
# Image analysis (streaming SSE)
# -----------------------------
@app.post("/api/image/analyze")
def analyze_image(
    prompt: str = Form(...),
    model: str = Form(...),
    image: UploadFile = File(...),
    user: User = Depends(current_user),
) -> StreamingResponse:
    # Base64 encode for Ollama multimodal endpoint. Kept in memory: a shared
    # temp file would let two concurrent requests read each other's image.
    b64 = base64.b64encode(read_upload(image)).decode()
    ticket = QUEUE.enter(user.id, "an image analysis")

    def _gen():

        meter = EnergyMeter(user, model, "image_analysis")
        meter.start()

        try:
            r = requests.post(
                "http://localhost:11434/api/generate",
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                json={
                    "model": model,
                    "prompt": prompt,
                    "images": [b64],
                    "stream": True,
                },
                stream=True,
                timeout=60,
            )
            r.raise_for_status()

            for line in r.iter_lines():
                if not line:
                    continue
                meter.sample()
                try:
                    payload = json.loads(line)
                    if "response" in payload:
                        yield f"data: {json.dumps({'delta': payload['response']})}\n\n".encode(
                            "utf-8"
                        )
                except json.JSONDecodeError:
                    continue

        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n".encode("utf-8")
        finally:
            energy_wh, inference_time_ms = meter.finish()
            done_payload = {"done": True, "energy_wh": energy_wh, "inference_time_ms": inference_time_ms}
            yield f"data: {json.dumps(done_payload)}\n\n".encode("utf-8")

    return queued_response(ticket, _gen, _chat_event)


# -----------------------------
# Save / Load chat sessions
# -----------------------------
@app.get("/api/chats")
def list_chats(user: User = Depends(current_user)):
    chat_dir = _user_dir(paths_for(user).chats)
    items = []
    for d in os.listdir(chat_dir):
        chat_path = os.path.join(chat_dir, d)
        if not os.path.isdir(chat_path):
            continue
        entry = {"name": d}
        meta_path = os.path.join(chat_path, "meta.json")
        if os.path.exists(meta_path):
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    entry.update(json.load(f))
            except (json.JSONDecodeError, IOError):
                pass
        if "updated_at" not in entry:
            try:
                entry["updated_at"] = os.path.getmtime(chat_path)
            except OSError:
                pass
        if "created_at" not in entry:
            try:
                entry["created_at"] = os.path.getctime(chat_path)
            except OSError:
                pass
        items.append(entry)
    items.sort(key=lambda x: x.get("updated_at", 0), reverse=True)
    return {"chats": items}


@app.post("/api/chats/save")
def save_chat(
    name: str = Form(...),
    history_json: str = Form(...),
    metrics_json: str | None = Form(
        None
    ),  # per-prompt words/chars and timestamps
    session_json: str | None = Form(
        None
    ),  # participantId, group, session, timer, energy totals
    interview_text: str | None = Form(
        None
    ),  # optional qualitative notes
    meta_json: str | None = Form(
        None
    ),  # mode, created_at, updated_at
    user: User = Depends(current_user),
):
    chat_dir = _user_dir(paths_for(user).chats)
    path = safe_child(chat_dir, name)
    is_new = not os.path.isdir(path)
    os.makedirs(path, exist_ok=True)

    with open(os.path.join(path, "history.json"), "w", encoding="utf-8") as f:
        f.write(history_json)

    if metrics_json:
        with open(os.path.join(path, "metrics.json"), "w", encoding="utf-8") as f:
            f.write(metrics_json)

    if session_json:
        with open(os.path.join(path, "session.json"), "w", encoding="utf-8") as f:
            f.write(session_json)

    if interview_text:
        with open(os.path.join(path, "interview.txt"), "w", encoding="utf-8") as f:
            f.write(interview_text)

    # Persist / update metadata (mode, timestamps)
    meta_path = os.path.join(path, "meta.json")
    meta = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    if meta_json:
        try:
            meta.update(json.loads(meta_json))
        except json.JSONDecodeError:
            pass
    if is_new and "created_at" not in meta:
        meta["created_at"] = time.time()
    meta["updated_at"] = time.time()
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f)

    return {"ok": True}


@app.get("/api/chats/{name}")
def load_chat_endpoint(name: str, user: User = Depends(current_user)):
    chat_dir = _user_dir(paths_for(user).chats)
    path = os.path.join(safe_child(chat_dir, name), "history.json")
    if not os.path.exists(path):
        return JSONResponse({"error": "not found"}, status_code=404)
    with open(path, "r", encoding="utf-8") as f:
        return JSONResponse(json.load(f))


@app.delete("/api/chats/{name}")
def delete_chat_endpoint(name: str, user: User = Depends(current_user)):
    chat_dir = _user_dir(paths_for(user).chats)
    path = safe_child(chat_dir, name)
    if not os.path.isdir(path):
        return JSONResponse({"error": "not found"}, status_code=404)
    shutil.rmtree(path)
    return {"ok": True}


@app.post("/api/chats/rename")
def rename_chat_endpoint(old_name: str = Form(...), new_name: str = Form(...), user: User = Depends(current_user)):
    chat_dir = _user_dir(paths_for(user).chats)
    old_path = safe_child(chat_dir, old_name)
    new_path = safe_child(chat_dir, new_name)
    if not os.path.isdir(old_path):
        return JSONResponse({"error": "not found"}, status_code=404)
    if os.path.exists(new_path):
        return JSONResponse({"error": "name already exists"}, status_code=409)
    os.rename(old_path, new_path)
    return {"ok": True}


@app.get("/api/chats-search")
def search_chats(q: str = "", user: User = Depends(current_user)):
    """
    Search all saved chats for a query string.
    Returns list of { chatName, matches: [{ role, snippet, index }] }
    """
    chat_dir = _user_dir(paths_for(user).chats)
    if not q or len(q) < 2:
        return {"results": []}

    query = q.lower()
    results = []

    for chat_name in os.listdir(chat_dir):
        chat_path = os.path.join(chat_dir, chat_name)
        if not os.path.isdir(chat_path):
            continue

        history_path = os.path.join(chat_path, "history.json")
        if not os.path.exists(history_path):
            continue

        try:
            with open(history_path, "r", encoding="utf-8") as f:
                history = json.load(f)

            matches = []
            for idx, msg in enumerate(history):
                text = msg.get("text", "") or msg.get("content", "")
                if query in text.lower():
                    # Return a snippet around the match
                    pos = text.lower().find(query)
                    start = max(0, pos - 50)
                    end = min(len(text), pos + len(query) + 50)
                    snippet = ("..." if start > 0 else "") + text[start:end] + ("..." if end < len(text) else "")
                    matches.append({
                        "role": msg.get("role", "unknown"),
                        "snippet": snippet,
                        "index": idx,
                    })

            if matches:
                results.append({
                    "chatName": chat_name,
                    "matches": matches[:5],  # Limit to 5 matches per chat
                })
        except (json.JSONDecodeError, IOError):
            continue

    return {"results": results[:20]}  # Limit total results


# -----------------------------
# Save / Load image analyses
# -----------------------------
@app.get("/api/analyses")
def list_analyses(user: User = Depends(current_user)):
    img_dir = _user_dir(paths_for(user).images)
    items = [
        d
        for d in os.listdir(img_dir)
        if os.path.isdir(os.path.join(img_dir, d))
    ]
    return {"analyses": items}


@app.post("/api/analyses/save")
def save_analysis(
    name: str = Form(...),
    history_json: str = Form(...),
    image: UploadFile = File(None),
    user: User = Depends(current_user),
):
    img_dir = _user_dir(paths_for(user).images)
    path = safe_child(img_dir, name)
    image_bytes = read_upload(image) if image else None
    os.makedirs(path, exist_ok=True)

    with open(os.path.join(path, "history.json"), "w", encoding="utf-8") as f:
        f.write(history_json)

    if image_bytes is not None:
        with open(os.path.join(path, "image.png"), "wb") as out:
            out.write(image_bytes)

    return {"ok": True}


@app.get("/api/analyses/{name}")
def load_analysis_endpoint(name: str, user: User = Depends(current_user)):
    img_dir = _user_dir(paths_for(user).images)
    analysis_dir = safe_child(img_dir, name)
    path = os.path.join(analysis_dir, "history.json")
    if not os.path.exists(path):
        return JSONResponse({"error": "not found"}, status_code=404)

    with open(path, "r", encoding="utf-8") as f:
        payload = json.load(f)

    img_path = os.path.join(analysis_dir, "image.png")
    img_exists = os.path.exists(img_path)

    return {"history": payload, "has_image": img_exists}


# -----------------------------
# Power endpoints
# -----------------------------
@app.get("/api/power/summary")
def power_summary(user: User = Depends(current_user)):
    return energy.summary(user)


@app.get("/api/power/stream")
async def power_stream(user: User = Depends(current_user)):
    # Async so an open dashboard doesn't hold a worker thread for as long as
    # the tab stays open; only the summary read borrows one briefly.
    async def _gen():
        while True:
            try:
                summary = await run_in_threadpool(energy.summary, user)
            except Exception:
                break
            yield f"data: {json.dumps(summary)}\n\n".encode("utf-8")
            await asyncio.sleep(1.0)

    return StreamingResponse(_gen(), media_type="text/event-stream")


@app.get("/api/queue")
def queue_status(user: User = Depends(current_user)):
    """Whether a model job is running, how many are waiting, and the caller's
    place in line (0 = running, null = nothing queued)."""
    return QUEUE.snapshot(user.id)


@app.get("/api/analytics/power")
def analytics_power(scope: str = "mine", user: User = Depends(current_user)):
    """The caller's metered prompts; an admin may pass scope=all for everyone's
    (SERVER_STAGE1.md D7)."""
    local = energy.history(None if scope == "all" and user.is_admin else user)
    df_default = get_default_power_usages()

    default = (
        df_default.to_dict(orient="records")
        if df_default is not None and not df_default.empty
        else []
    )

    return {"local": local, "default": default}


# -----------------------------
# Health
# -----------------------------
@app.get("/api/health")
def health():
    return {"ok": True}


# -----------------------------
# Accounts (SERVER_STAGE1.md §2)
# -----------------------------
def _user_json(user: User) -> dict:
    return {"id": user.id, "username": user.username, "role": user.role, "is_owner": user.is_owner}


def _with_session(response: JSONResponse, request: Request, token: str) -> JSONResponse:
    # Secure only when the browser reached us over HTTPS (Funnel terminates
    # TLS and says so); testing the public port over plain http still works
    https = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    response.set_cookie(
        SESSION_COOKIE, token, max_age=accounts.SESSION_DAYS * 86400,
        httponly=True, samesite="lax", secure=request.state.is_public and https, path="/",
    )
    return response


def _link(request: Request, path: str) -> str:
    """A link to send someone: on the public address when there is one, since
    the admin making it may be sitting at the Mac."""
    if PUBLIC_HOST:
        return f"https://{PUBLIC_HOST}{path}"
    return str(request.base_url).rstrip("/") + path


@app.get("/api/me")
def me(request: Request):
    """Who the app is talking to and what they may use. Open: the frontend
    asks this first to decide between the login screen and the app."""
    user = request.state.user
    if user is None:
        return {"user": None, "local": False}
    local = request.state.is_local
    return {
        "user": _user_json(user),
        "local": local,
        "has_password": accounts.owner_has_password() if user.is_owner else True,
        "capabilities": {
            # Agent mode and the Code tab run shell commands on this Mac (D13)
            "agent": local,
            "code_tab": local,
            "test_runner": local,
            "conduct_open": local,
            "manage_models": user.is_admin,
            "manage_users": user.is_admin,
        },
    }


@app.post("/api/auth/login")
def auth_login(payload: dict, request: Request):
    if request.state.is_local:
        return JSONResponse({"error": "No sign-in is needed on this Mac."}, status_code=400)
    user, token = accounts.login(payload.get("username", ""), payload.get("password", ""), request.state.client_ip)
    return _with_session(JSONResponse({"ok": True, "user": _user_json(user)}), request, token)


@app.post("/api/auth/logout")
def auth_logout(request: Request):
    accounts.logout(session_token(request))
    response = JSONResponse({"ok": True})
    response.delete_cookie(SESSION_COOKIE, path="/")
    return response


@app.get("/api/auth/invite/{token}")
def auth_invite_info(token: str):
    info = accounts.describe_token(token, "invite")
    if info is None:
        return JSONResponse({"error": "This invite link has expired or was already used."}, status_code=404)
    return info


@app.post("/api/auth/invite/{token}")
def auth_invite_accept(token: str, payload: dict, request: Request):
    user, session = accounts.accept_invite(token, payload.get("username", ""), payload.get("password", ""))
    return _with_session(JSONResponse({"ok": True, "user": _user_json(user)}), request, session)


@app.get("/api/auth/reset/{token}")
def auth_reset_info(token: str):
    info = accounts.describe_token(token, "reset")
    if info is None:
        return JSONResponse({"error": "This reset link has expired or was already used."}, status_code=404)
    return info


@app.post("/api/auth/reset/{token}")
def auth_reset_accept(token: str, payload: dict, request: Request):
    user, session = accounts.accept_reset(token, payload.get("password", ""))
    return _with_session(JSONResponse({"ok": True, "user": _user_json(user)}), request, session)


@app.post("/api/auth/password")
def auth_change_password(payload: dict, request: Request, user: User = Depends(current_user)):
    # At the Mac the owner sets or changes theirs without the current one;
    # everyone else has to prove they know it
    current = None if request.state.is_local and user.is_owner else payload.get("current_password", "")
    session = accounts.change_password(user, payload.get("new_password", ""), current)
    response = JSONResponse({"ok": True})
    return response if request.state.is_local else _with_session(response, request, session)


def _not_self(user_id: int, user: User) -> None:
    if user_id == user.id:
        raise accounts.AccountError("You can't change your own account here.")


@app.get("/api/admin/users", dependencies=[Depends(require_admin)])
def admin_users():
    return {"users": accounts.list_users()}


@app.post("/api/admin/users/{user_id}", dependencies=[Depends(require_admin)])
def admin_update_user(user_id: int, payload: dict, user: User = Depends(current_user)):
    _not_self(user_id, user)
    if "role" in payload:
        accounts.set_role(user_id, payload["role"])
    if "status" in payload:
        accounts.set_status(user_id, payload["status"])
        if payload["status"] == "disabled":
            for registry in _ALL_ENGINES:
                registry.drop_user(user_id)
    return {"ok": True}


@app.delete("/api/admin/users/{user_id}", dependencies=[Depends(require_admin)])
def admin_delete_user(user_id: int, user: User = Depends(current_user)):
    _not_self(user_id, user)
    accounts.delete_user(user_id)
    for registry in _ALL_ENGINES:
        registry.drop_user(user_id)
    return {"ok": True}


@app.post("/api/admin/users/{user_id}/reset-link", dependencies=[Depends(require_admin)])
def admin_reset_link(user_id: int, request: Request, user: User = Depends(current_user)):
    _not_self(user_id, user)
    token = accounts.create_reset(user_id, user)
    return {"url": _link(request, f"/reset/{token}"), "expires_hours": accounts.RESET_HOURS}


@app.get("/api/admin/invites", dependencies=[Depends(require_admin)])
def admin_invites():
    return {"invites": accounts.list_invites()}


@app.post("/api/admin/invites", dependencies=[Depends(require_admin)])
def admin_create_invite(payload: dict, request: Request, user: User = Depends(current_user)):
    token = accounts.create_invite(user, payload.get("role", "user"), payload.get("note", ""))
    return {"url": _link(request, f"/invite/{token}"), "expires_days": accounts.INVITE_DAYS}


@app.get("/api/admin/energy", dependencies=[Depends(require_admin)])
def admin_energy(days: int = 30):
    """Totals for the admin Energy page; days=0 for all time."""
    usernames = [u["username"] for u in accounts.list_users()]
    return energy.report(days if days > 0 else None, usernames)


@app.get("/api/admin/energy.csv", dependencies=[Depends(require_admin)])
def admin_energy_csv():
    name = f"uness-energy-{date.today().isoformat()}.csv"
    return Response(
        energy.csv_text(), media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@app.delete("/api/admin/invites/{invite_id}", dependencies=[Depends(require_admin)])
def admin_revoke_invite(invite_id: int):
    accounts.revoke_invite(invite_id)
    return {"ok": True}


# -----------------------------
# Test Runner  (runs automated_test_runner.py as subprocess)
# -----------------------------
_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
_test_process: Optional[subprocess.Popen] = None
_test_process_lock = threading.Lock()


@app.get("/api/test/prompt-files", dependencies=[Depends(require_local)])
def test_prompt_files():
    """List .csv and .txt files in the backend dir that could be prompt files."""
    files: list[str] = []
    for f in sorted(os.listdir(_BACKEND_DIR)):
        if f.startswith(".") or f.startswith("_"):
            continue
        if f.lower().endswith((".csv", ".txt")):
            # Exclude known non-prompt files
            if f in ("requirements.txt",):
                continue
            # Exclude result files (they have columns like inference_time_ms)
            path = os.path.join(_BACKEND_DIR, f)
            try:
                if f.lower().endswith(".csv"):
                    with open(path, newline="", encoding="utf-8") as fh:
                        header = fh.readline().lower()
                        if "inference_time_ms" in header or "response" in header:
                            continue  # looks like an output/results file
            except Exception:
                pass
            files.append(f)
    return {"files": files}


@app.post("/api/test/run", dependencies=[Depends(require_local)])
def test_run(
    prompts_file: str = Form(...),
    output_file: str = Form("test_results.csv"),
    model: str = Form("qwen3:1.7b"),
    thinking_mode: str = Form("fast"),
    reset_every: int = Form(5),
):
    """
    Start the automated test runner as a subprocess and stream its
    stdout line by line as SSE events.
    """
    global _test_process

    with _test_process_lock:
        if _test_process is not None and _test_process.poll() is None:
            return JSONResponse(
                {"error": "A test run is already in progress."},
                status_code=409,
            )

    script = os.path.join(_BACKEND_DIR, "automated_test_runner.py")
    if not os.path.exists(script):
        return JSONResponse(
            {"error": "automated_test_runner.py not found"},
            status_code=404,
        )

    # Resolve prompts file path (relative to backend dir)
    prompts_path = (
        prompts_file
        if os.path.isabs(prompts_file)
        else os.path.join(_BACKEND_DIR, prompts_file)
    )
    output_path = (
        output_file
        if os.path.isabs(output_file)
        else os.path.join(_BACKEND_DIR, output_file)
    )

    cmd = [
        "python", script,
        "--prompts", prompts_path,
        "--output", output_path,
        "--model", model,
        "--thinking", thinking_mode,
        "--reset-every", str(reset_every),
    ]

    def _gen():
        global _test_process
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                cwd=_BACKEND_DIR,
                bufsize=1,  # line-buffered
            )
            with _test_process_lock:
                _test_process = proc

            for line in iter(proc.stdout.readline, ""):
                payload = {"line": line.rstrip("\n\r")}
                yield f"data: {json.dumps(payload)}\n\n".encode("utf-8")

            proc.wait()
            done_payload = {"done": True, "exit_code": proc.returncode}
            yield f"data: {json.dumps(done_payload)}\n\n".encode("utf-8")
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n".encode("utf-8")
        finally:
            with _test_process_lock:
                _test_process = None

    return StreamingResponse(_gen(), media_type="text/event-stream")


@app.post("/api/test/stop", dependencies=[Depends(require_local)])
def test_stop():
    """Kill a running test subprocess."""
    global _test_process
    with _test_process_lock:
        if _test_process is None or _test_process.poll() is not None:
            return {"ok": True, "message": "No test running"}
        try:
            _test_process.terminate()
            _test_process.wait(timeout=5)
        except Exception:
            _test_process.kill()
        _test_process = None
    return {"ok": True, "message": "Test stopped"}


# =============================================================
# Coding Agent (claw-code-agent)  ── SSE streaming
# =============================================================
_AGENT_CWD = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@app.post("/api/agent/chat", dependencies=[Depends(require_local)])
def agent_chat(
    prompt: str = Form(...),
    model: str = Form(DEFAULT_AGENT_MODEL),
    user: User = Depends(current_user),
):
    """
    Run the coding agent with the given prompt and stream events
    (thinking, assistant text, tool calls, results, done) as SSE.
    """
    from pathlib import Path

    cwd = Path(_AGENT_CWD)
    # One turn for the whole run, with no time cap: its energy is metered as
    # one block, so nothing else may run in between (SERVER_STAGE1.md D12)
    ticket = QUEUE.enter(user.id, "an agent task", exempt=True)

    def _gen_with_energy():
        _last_model[user.id] = model

        meter = EnergyMeter(user, model, "agent")
        meter.start()
        try:
            for chunk in run_agent_streaming(model=model, prompt=prompt, cwd=cwd):
                meter.sample()
                yield chunk
        finally:
            energy_wh, inference_time_ms = meter.finish()
            payload = {"type": "energy", "energy_wh": energy_wh, "inference_time_ms": inference_time_ms}
            yield f"data: {json.dumps(payload)}\n\n".encode("utf-8")

    return queued_response(ticket, _gen_with_energy, _typed_event)


@app.post("/api/agent/reset", dependencies=[Depends(require_local)])
def agent_reset(model: str = Form(DEFAULT_AGENT_MODEL)):
    """Reset the coding agent session for a given model."""
    claw_reset_agent(model)
    return {"ok": True}


# =============================================================
# The built frontend (server mode, SERVER_STAGE1.md §8)
# Defined last: the catch-all must never shadow an API route.
# =============================================================
_DIST = _Path(__file__).resolve().parent.parent / "energy-chat-dashboard" / "dist"

if (_DIST / "index.html").exists():
    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def frontend(path: str):
        """Files from the build, else index.html — so /invite/<token> and
        /reset/<token> links open the app, which routes them itself."""
        if path == "api" or path.startswith("api/"):
            return JSONResponse({"error": "Not found"}, status_code=404)
        candidate = (_DIST / path).resolve()
        if path and candidate.is_file() and _DIST.resolve() in candidate.parents:
            return FileResponse(candidate)
        # Always re-checked, so a rebuild is picked up on the next page load
        return FileResponse(_DIST / "index.html", headers={"Cache-Control": "no-cache"})
