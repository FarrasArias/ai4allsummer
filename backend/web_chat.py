# backend/web_chat.py
"""
Web-aware chat helper using Ollama tool calling.

- Implements web_search/web_fetch tools without any API key: search through
  the ddgs library, pages read by this Mac directly (utilities/web_tools.py,
  which refuses anything that isn't a public internet address).
- Supports uploaded documents via the shared RagStore (retrieval per question),
  with full-text fallback when the embedding model is unavailable.
- ask_events() yields real orchestration status events ("Searching the web
  for…", "Reading <url>", …) so the frontend can stream progress traces.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Union
import json
import logging

from ollama import chat as ollama_chat

from utilities.prompt_config import get_system_prompt
from utilities.rag_store import RagStore
from utilities.doc_loaders import extract_document, segments_to_text
from utilities import web_tools


# ============================================================
# LOGGING (print to terminal)
# ============================================================
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

SEARCH_PRIVACY_RULE = (
    "Privacy: web searches leave this computer. Write search queries about the topic only: "
    "never include anyone's name, email, phone number, address, ID numbers or other personal "
    "details, even if the user mentioned them. Generalise instead (for example, search for "
    "'symptoms of migraine' rather than the user's name and condition)."
)

DEFAULT_SYSTEM_PROMPT = """You are a helpful AI assistant with access to web search.
When you need current information, use the web_search tool.
When you need to read a specific webpage, use the web_fetch tool.
Be concise and accurate in your responses.
"""

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
      Search results: title, url and a short snippet for each.
    """
    return web_tools.search(query, max_results)


def web_fetch(url: str) -> Dict[str, Any]:
    """
    Fetch a webpage and return its content and links.

    Args:
      url: URL to fetch

    Returns:
      The page's title, text content and links.
    """
    return web_tools.fetch(url)


def _normalize_tool_args(tool_args: Union[str, Dict[str, Any], None]) -> Dict[str, Any]:
    """
    Tool call args can be returned as dict OR JSON string depending on
    ollama-python version. Normalize to a dict.
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
            raise ValueError(f"Tool arguments were not valid JSON: {tool_args}")
    raise TypeError(f"Unsupported tool_args type: {type(tool_args)}")


def _tool_status_text(tool_name: str, tool_args: Dict[str, Any]) -> str:
    """Human-readable progress line for a tool invocation."""
    if tool_name == "web_search":
        # What actually leaves this Mac, after personal details are removed
        query = web_tools.scrub_query(str(tool_args.get("query", "")))
        return f'Searching the web for: "{query}"' if query else "Searching the web…"
    if tool_name == "web_fetch":
        url = str(tool_args.get("url", "")).strip()
        return f"Reading {url}" if url else "Reading a webpage…"
    return f"Running {tool_name}…"


# ============================================================
# SESSION
# ============================================================
class WebChatSession:
    """
    Maintains conversation history, uploaded documents (RAG), and multi-step
    tool use. The system message is rebuilt on every call so freshly retrieved
    document excerpts can be injected without polluting the history.
    """

    def __init__(self, model: str = MODEL_NAME, rag_dir: Path = Path("rag_cache")):
        self.model = model
        # The privacy rule is added in code, so editing prompts.json can't drop it
        self.base_system = (
            (get_system_prompt("web", DEFAULT_SYSTEM_PROMPT) or DEFAULT_SYSTEM_PROMPT).rstrip()
            + "\n\n" + SEARCH_PRIVACY_RULE
        )

        # Conversation history WITHOUT the system message
        self.messages: List[Any] = []

        # Uploaded documents: RAG store (persisted across restarts) with
        # full-text fallback when embeddings are unavailable
        safe_model = "".join(c if c.isalnum() or c in "._-" else "_" for c in model)
        self.rag = RagStore(persist_dir=Path(rag_dir) / f"web_{safe_model}")
        self.document_context: str = ""
        self.loaded_files: List[str] = list(self.rag.document_names())

        # tool name -> function
        self.available_tools = {
            "web_search": web_search,
            "web_fetch": web_fetch,
        }

    # ── documents ──
    def add_document(self, file_path: str) -> Dict[str, Any]:
        """Index an uploaded document (RAG preferred, full-text fallback)."""
        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")

        # The frontend re-sends loaded files with every prompt — skip
        # re-indexing a document we already have
        if path.name in self.loaded_files:
            return {"filename": path.name, "skipped": True}

        segments = extract_document(str(path))
        rag_info = self.rag.add_document(path.name, segments)
        if rag_info is None:
            banner = "\n\n" + "=" * 60 + f"\n=== Document: {path.name} ===\n" + "=" * 60 + "\n"
            self.document_context += banner + segments_to_text(segments)
        self.loaded_files.append(path.name)

        result = {
            "filename": path.name,
            "rag_chunks": rag_info.get("chunks") if rag_info else None,
        }
        logger.info("✓ Web session loaded %s (rag_chunks=%s)", path.name, result["rag_chunks"])
        return result

    def reset(self):
        """Reset conversation history and clear uploaded documents."""
        self.messages = []
        self.document_context = ""
        self.loaded_files = []
        self.rag.clear()

    # ── prompting ──
    def _system_content(self, retrieved_context: str = "") -> str:
        content = self.base_system
        if retrieved_context:
            content += (
                "\n\nRelevant excerpts retrieved from the user's uploaded documents "
                "are shown below. Use them to answer when relevant, and mention "
                "which document (and page, if given) you are referencing.\n\n"
                f"{retrieved_context}"
            )
        elif self.document_context:
            content += (
                "\n\nYou have access to the following documents. Use them to answer "
                "questions when relevant, and mention which document you are "
                "referencing.\n\n"
                f"{self.document_context}"
            )
        return content

    def ask_events(self, user_input: str) -> Iterator[Dict[str, Any]]:
        """
        Multi-iteration tool loop as an event stream. Yields:
          {"type": "status", "text": ...}      — real progress traces
          {"type": "assistant", "content": ...} — model text per iteration
          {"type": "error", "error": ...}       — fatal model errors
        """
        # Retrieve document excerpts relevant to this question (RAG).
        # The query embedding runs on the GPU inside the caller's metered window.
        retrieved_context = ""
        if self.rag.has_documents():
            yield {"type": "status", "text": "Searching your documents…"}
            retrieved_context = self.rag.build_context(user_input)

        self.messages.append({"role": "user", "content": user_input})
        got_assistant_reply = False

        for iteration in range(1, MAX_ITERATIONS + 1):
            logger.info("WebChat iteration %d/%d", iteration, MAX_ITERATIONS)

            call_messages = [
                {"role": "system", "content": self._system_content(retrieved_context)}
            ] + self.messages

            try:
                response = ollama_chat(
                    model=self.model,
                    messages=call_messages,
                    tools=[web_search, web_fetch],
                    think=ENABLE_THINKING,
                )
            except Exception as e:
                logger.exception("ERROR calling model: %s", e)
                if not got_assistant_reply:
                    # Keep history consistent: drop the failed user turn
                    if self.messages and isinstance(self.messages[-1], dict) \
                            and self.messages[-1].get("role") == "user":
                        self.messages.pop()
                yield {"type": "error", "error": str(e)}
                return

            content = getattr(response.message, "content", None)
            if content:
                got_assistant_reply = True
                yield {"type": "assistant", "content": content}

            self.messages.append(response.message)

            tool_calls = getattr(response.message, "tool_calls", None)
            if not tool_calls:
                break

            for tool_call in tool_calls:
                tool_name = tool_call.function.name
                try:
                    tool_args = _normalize_tool_args(tool_call.function.arguments)
                except (ValueError, TypeError) as e:
                    self.messages.append(
                        {"role": "tool", "tool_name": tool_name, "content": f"Bad arguments: {e}"}
                    )
                    continue

                yield {"type": "status", "text": _tool_status_text(tool_name, tool_args)}

                fn = self.available_tools.get(tool_name)
                if not fn:
                    msg = f"Tool {tool_name} not found"
                    logger.error(msg)
                    self.messages.append(
                        {"role": "tool", "tool_name": tool_name, "content": msg}
                    )
                    continue

                try:
                    # Never the arguments: they're the search or the page address
                    logger.info("Calling tool %s", tool_name)
                    result = fn(**tool_args)
                    result_str = str(result)[:MAX_TOOL_RESULT_LENGTH]
                    self.messages.append(
                        {"role": "tool", "tool_name": tool_name, "content": result_str}
                    )
                    logger.info("Tool %s OK", tool_name)
                except Exception as e:
                    # 401s, timeouts, etc. — non-fatal, the model sees the error
                    logger.warning("Tool %s failed (%s)", tool_name, type(e).__name__)
                    yield {"type": "status", "text": f"{tool_name} failed: {e}"}
                    self.messages.append(
                        {
                            "role": "tool",
                            "tool_name": tool_name,
                            "content": f"Error calling {tool_name}: {e}",
                        }
                    )

    def ask(self, user_input: str) -> str:
        """
        Single-turn convenience wrapper over ask_events(); returns final text.
        """
        final_chunks: List[str] = []
        for event in self.ask_events(user_input):
            if event.get("type") == "assistant":
                final_chunks.append(str(event.get("content", "")))
            elif event.get("type") == "error":
                raise RuntimeError(str(event.get("error")))
        return ("\n\n".join(c for c in final_chunks if c).strip()) or "I couldn't generate a response."


# Convenience alias for default model (server.py imports this)
DEFAULT_MODEL = MODEL_NAME
