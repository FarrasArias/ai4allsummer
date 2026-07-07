# backend/web_chat.py
"""
Web-aware chat helper using Ollama tool calling.

IMPORTANT:
- We implement our own web_search/web_fetch tools by calling Ollama's web APIs
  directly using the hardcoded API key (Authorization: Bearer ...).
- This avoids issues where ollama-python caches OLLAMA_API_KEY at import time
  across uvicorn reload/workers.
"""

from __future__ import annotations

from typing import List, Dict, Any, Optional, Union
import json
import logging

import httpx
from ollama import chat as ollama_chat

from utilities.prompt_config import get_system_prompt


# ============================================================
# API KEY — loaded from OLLAMA_WEB_API_KEY env var
# ============================================================
import os
API_KEY = os.environ.get("OLLAMA_WEB_API_KEY", "")


# ============================================================
# LOGGING (print to terminal)
# ============================================================
# uvicorn + reload can spawn subprocesses; each process needs logging configured.
# Only configure if no handlers exist (prevents duplicate logs if configured elsewhere).
_root = logging.getLogger()
if not _root.handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

logger = logging.getLogger(__name__)


# ============================================================
# CONFIGURATION
# ============================================================
MODEL_NAME = "qwen2.5:7b"
ENABLE_THINKING = False

MAX_ITERATIONS = 5
MAX_TOOL_RESULT_LENGTH = 8000

DEFAULT_SYSTEM_PROMPT = """You are a helpful AI assistant with access to web search.
When you need current information, use the web_search tool.
When you need to read a specific webpage, use the web_fetch tool.
Be concise and accurate in your responses.
"""

# Ollama web tools endpoints
_OLLAMA_WEB_BASE = "https://ollama.com/api"


# ============================================================
# TOOL IMPLEMENTATIONS (these are what the model can call)
# ============================================================
def web_search(query: str, max_results: int = 5) -> Dict[str, Any]:
    """
    Search the web for relevant results.

    Args:
      query: search query string
      max_results: number of results to return

    Returns:
      JSON response from Ollama web_search endpoint.
    """
    if not API_KEY:
        raise RuntimeError("API_KEY is empty; web_search cannot authorize.")

    resp = httpx.post(
        f"{_OLLAMA_WEB_BASE}/web_search",
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
        json={"query": query, "max_results": max_results},
        timeout=20.0,
    )
    # If auth is wrong, you'll see a 401 here
    resp.raise_for_status()
    return resp.json()


def web_fetch(url: str) -> Dict[str, Any]:
    """
    Fetch a webpage and return its content and links.

    Args:
      url: URL to fetch

    Returns:
      JSON response from Ollama web_fetch endpoint.
    """
    if not API_KEY:
        raise RuntimeError("API_KEY is empty; web_fetch cannot authorize.")

    resp = httpx.post(
        f"{_OLLAMA_WEB_BASE}/web_fetch",
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
        json={"url": url},
        timeout=20.0,
    )
    resp.raise_for_status()
    return resp.json()


def _normalize_tool_args(tool_args: Union[str, Dict[str, Any], None]) -> Dict[str, Any]:
    """
    Tool call args can be returned as dict OR JSON string depending on ollama-python version.
    Normalize to a dict.
    """
    if tool_args is None:
        return {}
    if isinstance(tool_args, dict):
        return tool_args
    if isinstance(tool_args, str):
        tool_args = tool_args.strip()
        if not tool_args:
            return {}
        try:
            return json.loads(tool_args)
        except json.JSONDecodeError:
            # sometimes models return sloppy JSON; surface it
            raise ValueError(f"Tool arguments were not valid JSON: {tool_args}")
    raise TypeError(f"Unsupported tool_args type: {type(tool_args)}")


# ============================================================
# SESSION
# ============================================================
class WebChatSession:
    """
    Maintains conversation history and allows asking a question
    with optional multi-step tool use.
    """

    def __init__(self, model: str = MODEL_NAME):
        self.model = model
        self.messages: List[Dict[str, Any]] = []

        system_prompt = get_system_prompt("web", DEFAULT_SYSTEM_PROMPT)
        if system_prompt:
            self.messages.append({"role": "system", "content": system_prompt})

        # tool name -> function
        self.available_tools = {
            "web_search": web_search,
            "web_fetch": web_fetch,
        }

        if not API_KEY:
            logger.warning("API_KEY is empty. Web tools will fail with authorization errors.")

    def reset(self):
        """Reset conversation history but keep the model."""
        self.messages = []
        system_prompt = get_system_prompt("web", DEFAULT_SYSTEM_PROMPT)
        if system_prompt:
            self.messages.append({"role": "system", "content": system_prompt})

    def ask(self, user_input: str) -> str:
        """
        Single-turn entry point.
        Handles multi-iteration tool calls internally, returns final text.
        """
        self.messages.append({"role": "user", "content": user_input})

        final_chunks: List[str] = []

        for iteration in range(1, MAX_ITERATIONS + 1):
            logger.info("WebChat iteration %d/%d", iteration, MAX_ITERATIONS)

            # Call the model. We pass our tool callables (web_search/web_fetch).
            try:
                response = ollama_chat(
                    model=self.model,
                    messages=self.messages,
                    tools=[web_search, web_fetch],
                    think=ENABLE_THINKING,
                )
            except Exception as e:
                logger.exception("ERROR calling model: %s", e)
                raise

            # Capture assistant content
            if getattr(response.message, "content", None):
                final_chunks.append(response.message.content)

            # Save assistant message
            self.messages.append(response.message)

            # If no tools requested, we�re done
            tool_calls = getattr(response.message, "tool_calls", None)
            if not tool_calls:
                break

            # Execute requested tools
            for tool_call in tool_calls:
                tool_name = tool_call.function.name
                tool_args = _normalize_tool_args(tool_call.function.arguments)

                fn = self.available_tools.get(tool_name)
                if not fn:
                    msg = f"Tool {tool_name} not found"
                    logger.error(msg)
                    self.messages.append(
                        {"role": "tool", "tool_name": tool_name, "content": msg}
                    )
                    continue

                try:
                    logger.info("Calling tool %s args=%s", tool_name, tool_args)
                    result = fn(**tool_args)
                    result_str = str(result)[:MAX_TOOL_RESULT_LENGTH]
                    self.messages.append(
                        {"role": "tool", "tool_name": tool_name, "content": result_str}
                    )
                    logger.info("Tool %s OK", tool_name)
                except Exception as e:
                    # This is where you�ll see 401s, timeouts, etc.
                    logger.exception("Tool %s FAILED args=%s", tool_name, tool_args)
                    self.messages.append(
                        {
                            "role": "tool",
                            "tool_name": tool_name,
                            "content": f"Error calling {tool_name}: {e}",
                        }
                    )

            # Loop again to let the model read tool results and respond
            continue

        return ("\n\n".join([c for c in final_chunks if c]).strip()) or "I couldn't generate a response."


# Convenience alias for default model (server.py imports this)
DEFAULT_MODEL = MODEL_NAME
