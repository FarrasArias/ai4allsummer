"""
Thin wrapper around claw_agent.LocalCodingAgent that provides
a streaming iterator suitable for FastAPI SSE responses.

The agent's run() method is blocking, so we execute it in a background
thread and monkey-patch the session to push events into a queue that
the main thread drains as SSE payloads.
"""

from __future__ import annotations

import json
import queue
import threading
from pathlib import Path
from typing import Any, Iterator

from claw_agent import (
    LocalCodingAgent,
    AgentPermissions,
    AgentRuntimeConfig,
    ModelConfig,
)
from claw_agent.agent_types import BudgetConfig
from claw_agent.agent_tools import default_tool_registry

# Ollama exposes an OpenAI-compatible API at this URL
OLLAMA_OPENAI_BASE = "http://127.0.0.1:11434/v1"

# Default coding model (should match what's installed in Ollama)
DEFAULT_AGENT_MODEL = "qwen2.5-coder:7b"

# Maximum agent turns per prompt to prevent runaway loops
MAX_AGENT_TURNS = 20

# Only expose these core coding tools to the model.
# Fewer tools = less confusion for smaller local models.
ALLOWED_TOOLS = {
    "list_dir",
    "read_file",
    "write_file",
    "edit_file",
    "glob_search",
    "grep_search",
    "bash",
}

# Focused system prompt for the coding agent — replaces the massive default
# prompt which includes guidance for plugins, MCP, accounts, teams, etc.
CODING_SYSTEM_PROMPT = """\
You are a coding assistant that helps users write, debug, and refactor code.

You have access to these tools:
- **read_file**: Read a file's contents.
- **write_file**: Create or overwrite a file.
- **edit_file**: Replace text inside a file using exact string matching.
- **list_dir**: List files and directories.
- **glob_search**: Find files matching a glob pattern.
- **grep_search**: Search for text or regex inside files.
- **bash**: Run a shell command.

## How to work
1. Read relevant files before making changes.
2. Use edit_file for targeted changes; use write_file for new files.
3. After making changes, verify them (e.g., run tests, check syntax).
4. Explain what you did and why.

## Rules
- Always use the tools to interact with the filesystem. Do NOT just print code — actually create or edit the files.
- Be concise. Focus on solving the user's request.
- Use markdown code blocks with language tags when showing code in your responses.
- When debugging, identify the root cause and fix it.
"""


def _make_model_config(model: str) -> ModelConfig:
    return ModelConfig(
        model=model,
        base_url=OLLAMA_OPENAI_BASE,
        api_key="ollama",          # Ollama ignores this but the field is required
        temperature=0.0,
        timeout_seconds=300.0,
    )


def _make_runtime_config(cwd: Path) -> AgentRuntimeConfig:
    return AgentRuntimeConfig(
        cwd=cwd,
        max_turns=MAX_AGENT_TURNS,
        command_timeout_seconds=30.0,
        max_output_chars=12_000,
        permissions=AgentPermissions(
            allow_file_write=True,
            allow_shell_commands=True,
            allow_destructive_shell_commands=False,
        ),
        budget_config=BudgetConfig(
            max_tool_calls=40,
            max_model_calls=MAX_AGENT_TURNS,
        ),
        disable_claude_md_discovery=True,
    )


def _filtered_tool_registry() -> dict:
    """Return only the core coding tools from the full registry."""
    full = default_tool_registry()
    return {name: tool for name, tool in full.items() if name in ALLOWED_TOOLS}


# ── Per-model agent instances (preserves session between prompts) ──

_agents: dict[str, LocalCodingAgent] = {}
_agents_lock = threading.Lock()


def get_or_create_agent(model: str, cwd: Path) -> LocalCodingAgent:
    with _agents_lock:
        if model not in _agents:
            _agents[model] = LocalCodingAgent(
                model_config=_make_model_config(model),
                runtime_config=_make_runtime_config(cwd),
                tool_registry=_filtered_tool_registry(),
                override_system_prompt=CODING_SYSTEM_PROMPT,
            )
        return _agents[model]


def reset_agent(model: str) -> None:
    with _agents_lock:
        if model in _agents:
            try:
                _agents[model].clear_runtime_state()
            except Exception:
                pass
            del _agents[model]


# ── Streaming wrapper ──

def _sse(payload: dict[str, Any]) -> bytes:
    return f"data: {json.dumps(payload, default=str)}\n\n".encode("utf-8")


def run_agent_streaming(
    model: str,
    prompt: str,
    cwd: Path,
) -> Iterator[bytes]:
    """
    Run the coding agent and yield SSE events for each turn.

    Events emitted:
      {"type": "thinking"}                    — agent is starting
      {"type": "assistant", "content": "..."}  — text from the model
      {"type": "tool_start", "tool": "...", "args": {...}}
      {"type": "tool_result", "tool": "...", "ok": bool, "content": "..."}
      {"type": "done", "output": "...", "turns": N, "tool_calls": N, "usage": {...}}
      {"type": "error", "error": "..."}
    """
    agent = get_or_create_agent(model, cwd)
    eq: queue.Queue[dict[str, Any] | None] = queue.Queue()

    # ── Monkey-patch the session builder to intercept events ──
    original_build_session = agent.build_session

    def _patched_build_session(*args: Any, **kwargs: Any):
        session = original_build_session(*args, **kwargs)
        _hook_session(session, eq)
        return session

    def _hook_session(session, event_queue):
        """Wrap session methods to emit SSE events."""
        _orig_append_assistant = session.append_assistant
        _orig_finalize_tool = session.finalize_tool
        _orig_start_tool = session.start_tool

        def hooked_append_assistant(content, tool_calls=(), **kw):
            _orig_append_assistant(content, tool_calls, **kw)
            if content:
                event_queue.put({"type": "assistant", "content": content})
            for tc in tool_calls:
                fn = tc.get("function", {})
                args_raw = fn.get("arguments", "{}")
                try:
                    args = json.loads(args_raw) if isinstance(args_raw, str) else args_raw
                except (json.JSONDecodeError, TypeError):
                    args = {"raw": str(args_raw)}
                event_queue.put({
                    "type": "tool_start",
                    "tool": fn.get("name", "unknown"),
                    "args": _truncate_args(args),
                })

        def hooked_start_tool(*, name, tool_call_id, **kw):
            idx = _orig_start_tool(name=name, tool_call_id=tool_call_id, **kw)
            return idx

        def hooked_finalize_tool(index, *, content="", **kw):
            _orig_finalize_tool(index, content=content, **kw)
            # Extract tool name from the message
            try:
                msg = session.messages[index]
                tool_name = msg.name or "tool"
            except (IndexError, AttributeError):
                tool_name = "tool"
            event_queue.put({
                "type": "tool_result",
                "tool": tool_name,
                "ok": True,
                "content": content[:2000] if content else "",
            })

        session.append_assistant = hooked_append_assistant
        session.start_tool = hooked_start_tool
        session.finalize_tool = hooked_finalize_tool

    agent.build_session = _patched_build_session

    # ── Run agent in background thread ──
    def _run():
        try:
            eq.put({"type": "thinking"})
            result = agent.run(prompt)
            eq.put({
                "type": "done",
                "output": result.final_output,
                "turns": result.turns,
                "tool_calls": result.tool_calls,
                "usage": result.usage.to_dict(),
                "stop_reason": result.stop_reason,
            })
        except Exception as e:
            eq.put({"type": "error", "error": str(e)})
        finally:
            # Restore original method
            agent.build_session = original_build_session
            eq.put(None)  # sentinel

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()

    # ── Drain queue as SSE events ──
    while True:
        try:
            event = eq.get(timeout=600)  # 10 min max
        except queue.Empty:
            yield _sse({"type": "error", "error": "Agent timed out"})
            break
        if event is None:
            break
        yield _sse(event)


def _truncate_args(args: dict, max_len: int = 300) -> dict:
    """Truncate long argument values for display."""
    out = {}
    for k, v in args.items():
        sv = str(v)
        out[k] = sv[:max_len] + "..." if len(sv) > max_len else v
    return out
