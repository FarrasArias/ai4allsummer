# server.py

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
import json
import time
import shutil
import threading
import subprocess
import signal
from datetime import date
from typing import List, Optional, AsyncGenerator

import fitz  # PyMuPDF (kept for compatibility. TODO: Remove?)
import ollama
import requests
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from utilities.ollama_utils import extract_model_names
from utilities.power_usage import (
    get_cpu_power_usage,
    get_gpu_power_usage,
    get_power_usage_history,
    get_default_power_usages,
)
from utilities.date_time import get_datetime

# Shared chat engine with memory + doc window
from chat_core import OllamaChat

# -----------------------------
# Global state 
# -----------------------------
CHAT_DIR = "chats"
IMG_DIR = "images"
REPORTS_DIR = "reports"
os.makedirs(CHAT_DIR, exist_ok=True)
os.makedirs(IMG_DIR, exist_ok=True)
os.makedirs(REPORTS_DIR, exist_ok=True)

# Power tracking
_llm_running_flag = {"mode": "None"}  # "Chat" | "Image" | "None"
_normal_consumption = 0.0
_decay = 0.5
_latest_prompt_Wh = 0.0
_session_total_Wh = 0.0
_calculated_accumulator = 0.0
_update_period = 0.2  # seconds
_latest_image_meta = {"date": None, "model": None}
_latest_chat_model: Optional[str] = None
_power_thread_started = False
_power_thread_lock = threading.Lock()

# Per-model chat engines to preserve memory per model
_CHAT_ENGINES: dict[str, OllamaChat] = {}
_CHAT_ENGINES_LOCK = threading.Lock()

# Per-model VibeCoding engines (code assistant)
_VIBE_ENGINES: dict[str, VibeCodingChat] = {}
_VIBE_ENGINES_LOCK = threading.Lock()

# Per-model Web chat sessions (tools-enabled web assistant)
_WEB_SESSIONS: dict[str, WebChatSession] = {}
_WEB_SESSIONS_LOCK = threading.Lock()

# Per-model Image generation engines (prompt enhancer model)
_IMGGEN_ENGINES: dict[str, ImageGenEngine] = {}
_IMGGEN_ENGINES_LOCK = threading.Lock()


def _get_chat_engine(model: str) -> OllamaChat:
    """
    Return an OllamaChat instance for the requested model.
    Each model gets its own conversation history + document context.
    """
    with _CHAT_ENGINES_LOCK:
        engine = _CHAT_ENGINES.get(model)
        if engine is None:
            engine = OllamaChat(model=model)
            _CHAT_ENGINES[model] = engine
        return engine

def _get_vibe_engine(model: str) -> VibeCodingChat:
    """
    Return a VibeCodingChat instance for the requested model.
    Each model gets its own code context + conversation history.
    """
    with _VIBE_ENGINES_LOCK:
        engine = _VIBE_ENGINES.get(model)
        if engine is None:
            engine = VibeCodingChat(model=model)
            _VIBE_ENGINES[model] = engine
        return engine


def _get_web_session(model: str) -> WebChatSession:
    """
    Return a WebChatSession instance for the requested model.
    """
    with _WEB_SESSIONS_LOCK:
        sess = _WEB_SESSIONS.get(model)
        if sess is None:
            sess = WebChatSession(model=model)
            _WEB_SESSIONS[model] = sess
        return sess


def _get_imggen_engine(model: str) -> ImageGenEngine:
    """
    Return an ImageGenEngine for the requested enhancer model.
    """
    with _IMGGEN_ENGINES_LOCK:
        engine = _IMGGEN_ENGINES.get(model)
        if engine is None:
            engine = ImageGenEngine(enhancer_model=model)
            _IMGGEN_ENGINES[model] = engine
        return engine


def _ensure_power_thread():
    global _power_thread_started
    if _power_thread_started:
        return
    _power_thread_started = True

    def _runner():
        global _normal_consumption, _calculated_accumulator
        global _latest_prompt_Wh, _session_total_Wh

        # This call is unused here but kept for parity with previous behavior
        _ = get_default_power_usages()

        while True:
            try:
                cpu = get_cpu_power_usage()
                gpu, _ = get_gpu_power_usage()
                gpu = gpu or 0.0

                if _llm_running_flag["mode"] in ("Chat", "Image"):
                    _calculated_accumulator += (gpu - _normal_consumption) * _update_period
                else:
                    # When an operation ends, compute Wh and persist
                    if _calculated_accumulator > 0:
                        _latest_prompt_Wh = _calculated_accumulator / 3600.0
                        _session_total_Wh += _latest_prompt_Wh

                        entry = {
                            "date": get_datetime(),
                            "power": _latest_prompt_Wh,
                            "model": (
                                f"{_latest_chat_model}"
                                if _latest_chat_model
                                else f"{_latest_image_meta.get('model')}(image_analysis)"
                            ),
                        }
                        path = os.path.join(REPORTS_DIR, "power_consumption_reports.json")
                        if os.path.exists(path) and os.path.getsize(path) > 0:
                            try:
                                with open(path, "r", encoding="utf-8") as f:
                                    data = json.load(f)
                            except json.JSONDecodeError:
                                data = []
                        else:
                            data = []

                        data.append(entry)
                        with open(path, "w", encoding="utf-8") as f:
                            json.dump(data, f, indent=2)

                        _calculated_accumulator = 0.0
                        _llm_running_flag["mode"] = "None"

                    _normal_consumption = _normal_consumption * _decay + gpu * (1 - _decay)
            except Exception:
                # Don't kill the thread; just ignore telemetry errors
                pass

            time.sleep(_update_period)

    t = threading.Thread(target=_runner, daemon=True)
    t.start()


app = FastAPI(title="React <> Python API (Ollama)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------------
# Model management endpoints
# -----------------------------
@app.get("/api/models")
def list_models():
    return {"models": list(extract_model_names().keys())}


@app.post("/api/models/pull")
def pull_model(name: str = Form(...)):
    try:
        ollama.pull(name)
        return {"ok": True}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@app.delete("/api/models")
def delete_models(models: List[str]):
    results = {}
    for m in models:
        try:
            ollama.delete(m)
            results[m] = "deleted"
            # Also drop any in-memory chat engine for this model
            with _CHAT_ENGINES_LOCK:
                _CHAT_ENGINES.pop(m, None)
        except Exception as e:
            results[m] = f"error: {e}"
    return {"results": results}


@app.post("/api/models/load")
def load_model_endpoint(model: str = Form(...)):
    """
    Preload a model into Ollama GPU memory without generating any output.
    Blocks until the model is fully loaded. Use this to warm up the GPU
    before the first prompt so the initial response isn't delayed.
    """
    try:
        r = requests.post(
            "http://localhost:11434/api/generate",
            json={"model": model, "prompt": "", "keep_alive": -1, "stream": False},
            timeout=120,
        )
        r.raise_for_status()
        return {"ok": True, "model": model}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@app.post("/api/models/create")
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
) -> StreamingResponse:
    """
    Streams text chunks as Server-Sent Events (text/event-stream).
    Endpoint signature and path remain unchanged.
    """

    # Persist any uploaded files and add them to this model's document context
    context_files: List[str] = []
    if files:
        tmpdir = os.path.join(CHAT_DIR, "_tmp")
        os.makedirs(tmpdir, exist_ok=True)
        for f in files:
            dst = os.path.join(tmpdir, f.filename)
            with open(dst, "wb") as out:
                shutil.copyfileobj(f.file, out)
            context_files.append(dst)

    # Get or create the chat engine for this model
    engine = _get_chat_engine(model)

    # Load uploaded docs into the engine's document window
    for path in context_files:
        try:
            engine.add_document(path)
        except Exception as e:
            # Non-fatal: we log, but still attempt to answer the prompt
            print(f"Error loading document {path}: {e}")

    def _gen() -> AsyncGenerator[bytes, None]:
        global _latest_chat_model, _latest_prompt_Wh, _session_total_Wh
        _ensure_power_thread()
        _llm_running_flag["mode"] = "Chat"
        _latest_chat_model = model

        # Track inference start time and sample GPU power for per-prompt energy
        start_time = time.time()
        last_sample_time = start_time
        power_samples: list[float] = []

        # Initial GPU power sample
        try:
            gpu_w, _ = get_gpu_power_usage()
            if gpu_w:
                power_samples.append(gpu_w)
        except Exception:
            pass

        try:
            # Stream chunks from the shared chat engine (with memory + docs)
            for chunk in engine.stream_chat(prompt, thinking_mode=thinking_mode):
                payload = {"delta": chunk}
                yield f"data: {json.dumps(payload)}\n\n".encode("utf-8")

                # Sample GPU power every ~0.5s during streaming
                now = time.time()
                if now - last_sample_time >= 0.5:
                    try:
                        gpu_w, _ = get_gpu_power_usage()
                        if gpu_w:
                            power_samples.append(gpu_w)
                    except Exception:
                        pass
                    last_sample_time = now
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n".encode("utf-8")
        finally:
            _llm_running_flag["mode"] = "None"

            # Final GPU power sample
            try:
                gpu_w, _ = get_gpu_power_usage()
                if gpu_w:
                    power_samples.append(gpu_w)
            except Exception:
                pass

            # Calculate inference time
            elapsed_s = time.time() - start_time
            inference_time_ms = int(elapsed_s * 1000)

            # Compute per-prompt energy from sampled GPU power
            if power_samples:
                avg_power_w = sum(power_samples) / len(power_samples)
                prompt_energy_wh = max(0.0, (avg_power_w - _normal_consumption) * elapsed_s / 3600.0)
            else:
                prompt_energy_wh = 0.0

            _latest_prompt_Wh = prompt_energy_wh
            _session_total_Wh += prompt_energy_wh

            # Tell the client we're done, include metrics
            done_payload = {
                "done": True,
                "inference_time_ms": inference_time_ms,
                "energy_wh": prompt_energy_wh,
                "input_tokens": engine._last_prompt_eval_count,
                "output_tokens": engine._last_eval_count,
                "user_prompt_tokens": engine._last_user_prompt_tokens,
            }
            yield f"data: {json.dumps(done_payload)}\n\n".encode("utf-8")

    return StreamingResponse(_gen(), media_type="text/event-stream")

@app.post("/api/chat/reset")
def reset_chat(model: str = Form(...)):
    """
    Reset conversation history + loaded documents for the given model,
    and zero out per-session energy counters so the dashboard starts fresh.
    Safe to call before any prompt has been sent — if no engine exists yet,
    just zero the counters and return OK without creating a new engine.
    """
    global _session_total_Wh, _latest_prompt_Wh, _calculated_accumulator

    # Only reset the engine if one already exists — avoid creating a new one
    # (which verifies the model via ollama.show and can fail before first prompt)
    with _CHAT_ENGINES_LOCK:
        engine = _CHAT_ENGINES.get(model)
        if engine is not None:
            engine.reset()

    _session_total_Wh = 0.0
    _latest_prompt_Wh = 0.0
    _calculated_accumulator = 0.0

    return {"ok": True}

# -----------------------------
# Vibe coding (non-streaming JSON)
# -----------------------------
@app.post("/api/vibe/code")
def vibe_code(
    prompt: str = Form(...),
    model: str = Form(...),
    files: Optional[List[UploadFile]] = File(None),
):
    """
    Non-streaming coding assistant endpoint.

    - Uses VibeCodingChat (per-model session)
    - Optionally loads uploaded code files into context
    - Returns JSON: { ok: bool, response?: str, error?: str }
    """
    global _latest_chat_model

    _ensure_power_thread()
    _llm_running_flag["mode"] = "Chat"
    _latest_chat_model = model

    engine = _get_vibe_engine(model)

    # Save any uploaded code files and load them into the vibe engine
    file_paths: List[str] = []
    if files:
        tmpdir = os.path.join(CHAT_DIR, "_vibe")
        os.makedirs(tmpdir, exist_ok=True)
        for f in files:
            dst = os.path.join(tmpdir, f.filename)
            with open(dst, "wb") as out:
                shutil.copyfileobj(f.file, out)
            file_paths.append(dst)

    for path in file_paths:
        try:
            engine.load_code_file(path)
        except Exception as e:
            # Non-fatal: still answer the question
            print(f"Error loading code file {path}: {e}")

    try:
        reply = engine.code(prompt, stream=False)
        return {"ok": True, "response": reply}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    finally:
        _llm_running_flag["mode"] = "None"

@app.post("/api/vibe/reset")
def reset_vibe(model: str = Form(...)):
    """
    Reset VibeCodingChat state for the given model,
    and reset per-session energy counters.
    """
    global _session_total_Wh, _latest_prompt_Wh, _calculated_accumulator

    engine = _get_vibe_engine(model)
    engine.reset()

    _session_total_Wh = 0.0
    _latest_prompt_Wh = 0.0
    _calculated_accumulator = 0.0

    return {"ok": True}

# -----------------------------
# Web chat (non-streaming JSON)
# -----------------------------
@app.post("/api/web/chat")
def web_chat_endpoint(
    prompt: str = Form(...),
    model: str = Form(...),
):
    """
    Web-enabled chat endpoint.

    - Uses WebChatSession (per-model session)
    - Internally may call Ollama tools web_search / web_fetch
    - Returns JSON: { ok: bool, response?: str, error?: str }
    """
    global _latest_chat_model

    _ensure_power_thread()
    _llm_running_flag["mode"] = "Chat"
    _latest_chat_model = model

    session = _get_web_session(model)

    try:
        reply = session.ask(prompt)
        return {"ok": True, "response": reply}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    finally:
        _llm_running_flag["mode"] = "None"


@app.post("/api/web/reset")
def reset_web(model: str = Form(...)):
    """
    Reset WebChatSession for the given model and clear session energy.
    """
    global _session_total_Wh, _latest_prompt_Wh, _calculated_accumulator

    session = _get_web_session(model)
    session.reset()

    _session_total_Wh = 0.0
    _latest_prompt_Wh = 0.0
    _calculated_accumulator = 0.0

    return {"ok": True}


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
):
    """
    Generate an image via local Stable Diffusion WebUI API.
    `model` is the Ollama model used for prompt enhancement.
    Returns JSON with base64 image and metadata.
    """
    global _latest_chat_model

    _ensure_power_thread()
    _llm_running_flag["mode"] = "Chat"
    _latest_chat_model = model

    engine = _get_imggen_engine(model)
    do_enhance = enhance.lower() in ("true", "1", "yes")

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
        return {
            "ok": True,
            "image_b64": result["image_b64"],
            "prompt_used": result["prompt_used"],
            "original_prompt": result["original_prompt"],
            "parameters": result["parameters"],
        }
    except ConnectionError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=503)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    finally:
        _llm_running_flag["mode"] = "None"


@app.get("/api/image-gen/status")
def image_gen_status():
    """Check if the SD WebUI API is reachable and list available SD models."""
    engine = _get_imggen_engine(IMGGEN_DEFAULT_MODEL)
    available = engine.sd_available()
    sd_models = engine.get_sd_models() if available else []
    return {
        "sd_available": available,
        "sd_models": sd_models,
    }


@app.post("/api/image-gen/reset")
def reset_image_gen(model: str = Form(...)):
    """Reset ImageGenEngine history for the given model."""
    global _session_total_Wh, _latest_prompt_Wh, _calculated_accumulator

    engine = _get_imggen_engine(model)
    engine.reset()

    _session_total_Wh = 0.0
    _latest_prompt_Wh = 0.0
    _calculated_accumulator = 0.0

    return {"ok": True}


# -----------------------------
# Image analysis (streaming SSE)
# -----------------------------
@app.post("/api/image/analyze")
def analyze_image(
    prompt: str = Form(...),
    model: str = Form(...),
    image: UploadFile = File(...),
) -> StreamingResponse:
    # Persist temp image
    os.makedirs(IMG_DIR, exist_ok=True)
    path = os.path.join(IMG_DIR, "_tmp_image.png")
    with open(path, "wb") as out:
        shutil.copyfileobj(image.file, out)

    # Base64 encode for Ollama multimodal endpoint
    import base64

    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()

    def _gen():
        _ensure_power_thread()
        _llm_running_flag["mode"] = "Image"
        _latest_image_meta.update({"date": get_datetime(), "model": model})

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
            _llm_running_flag["mode"] = "None"
            yield b'data: {"done": true}\n\n'

    return StreamingResponse(_gen(), media_type="text/event-stream")


# -----------------------------
# Save / Load chat sessions
# -----------------------------
@app.get("/api/chats")
def list_chats():
    items = [
        d
        for d in os.listdir(CHAT_DIR)
        if os.path.isdir(os.path.join(CHAT_DIR, d))
    ]
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
):
    path = os.path.join(CHAT_DIR, name)
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

    return {"ok": True}


@app.get("/api/chats/{name}")
def load_chat_endpoint(name: str):
    path = os.path.join(CHAT_DIR, name, "history.json")
    if not os.path.exists(path):
        return JSONResponse({"error": "not found"}, status_code=404)
    with open(path, "r", encoding="utf-8") as f:
        return JSONResponse(json.load(f))


@app.get("/api/chats-search")
def search_chats(q: str = ""):
    """
    Search all saved chats for a query string.
    Returns list of { chatName, matches: [{ role, snippet, index }] }
    """
    if not q or len(q) < 2:
        return {"results": []}

    query = q.lower()
    results = []

    for chat_name in os.listdir(CHAT_DIR):
        chat_path = os.path.join(CHAT_DIR, chat_name)
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
def list_analyses():
    items = [
        d
        for d in os.listdir(IMG_DIR)
        if os.path.isdir(os.path.join(IMG_DIR, d))
    ]
    return {"analyses": items}


@app.post("/api/analyses/save")
def save_analysis(
    name: str = Form(...),
    history_json: str = Form(...),
    image: UploadFile = File(None),
):
    path = os.path.join(IMG_DIR, name)
    os.makedirs(path, exist_ok=True)

    with open(os.path.join(path, "history.json"), "w", encoding="utf-8") as f:
        f.write(history_json)

    if image:
        with open(os.path.join(path, "image.png"), "wb") as out:
            shutil.copyfileobj(image.file, out)

    return {"ok": True}


@app.get("/api/analyses/{name}")
def load_analysis_endpoint(name: str):
    path = os.path.join(IMG_DIR, name, "history.json")
    if not os.path.exists(path):
        return JSONResponse({"error": "not found"}, status_code=404)

    with open(path, "r", encoding="utf-8") as f:
        payload = json.load(f)

    img_path = os.path.join(IMG_DIR, name, "image.png")
    img_exists = os.path.exists(img_path)

    return {"history": payload, "has_image": img_exists}


# -----------------------------
# Power endpoints
# -----------------------------
@app.get("/api/power/summary")
def power_summary():
    path = os.path.join(REPORTS_DIR, "power_consumption_reports.json")
    df = get_power_usage_history(path)
    today_total = 0.0
    if not df.empty:
        today = date.today()
        today_rows = df[df["date"].dt.date == today]
        today_total = float(today_rows["power"].sum())
    return {
        "latest_prompt_Wh": _latest_prompt_Wh,
        "session_total_Wh": _session_total_Wh,
        "today_total_Wh": today_total,
    }


@app.get("/api/power/stream")
def power_stream():
    def _gen():
        _ensure_power_thread()
        while True:
            try:
                summary = power_summary()
                yield f"data: {json.dumps(summary)}\n\n".encode("utf-8")
                time.sleep(1.0)
            except Exception:
                break

    return StreamingResponse(_gen(), media_type="text/event-stream")


@app.get("/api/analytics/power")
def analytics_power():
    local_path = os.path.join(REPORTS_DIR, "power_consumption_reports.json")
    df_local = get_power_usage_history(local_path)
    df_default = get_default_power_usages()

    local = df_local.to_dict(orient="records") if not df_local.empty else []
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
# Test Runner  (runs automated_test_runner.py as subprocess)
# -----------------------------
_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
_test_process: Optional[subprocess.Popen] = None
_test_process_lock = threading.Lock()


@app.get("/api/test/prompt-files")
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


@app.post("/api/test/run")
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


@app.post("/api/test/stop")
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
