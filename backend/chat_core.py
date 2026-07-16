# chat_core.py

import json
import logging
from pathlib import Path
from typing import List, Dict, Optional

import ollama

from utilities.rag_store import RagStore
from utilities.doc_loaders import extract_document, segments_to_text

# Logging setup
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


class OllamaChat:
    """
    Shared chat engine with:
      - Conversation memory
      - Document window (PDF/DOCX/TXT/CSV)
      - Approximate context tracking
    Designed to be reusable by both a CLI and a FastAPI server.
    """
    #qwen3:30b-a3b
    def __init__(self, model: str = "qwen3:1.7b", max_context_tokens: int = 120_000):
        self.model = model
        self.max_context_tokens = max_context_tokens

        # Full conversation history: list of {"role": ..., "content": ...}
        # (user messages may also carry an "images" list of base64 strings)
        self.conversation_history: List[Dict[str, object]] = []

        # Concatenated text of all loaded documents (fallback when RAG is unavailable)
        self.document_context: str = ""

        # RAG store: uploaded documents are chunked + embedded here, and only
        # the chunks relevant to each question are injected into the prompt.
        # Persisted under rag_cache/ so uploads survive backend restarts.
        safe_model = "".join(c if c.isalnum() or c in "._-" else "_" for c in model)
        self.rag = RagStore(persist_dir=Path("rag_cache") / f"chat_{safe_model}")

        # Names of loaded files (restored from a persisted store for dedup)
        self.loaded_files: List[str] = list(self.rag.document_names())

        # Token counts from the most recent streaming response
        self._last_eval_count: int = 0
        self._last_prompt_eval_count: int = 0
        self._last_user_prompt_tokens: int = 0

        # Verify model is present locally (will raise if missing)
        try:
            ollama.show(self.model)
            logger.info(f"✓ Model {self.model} is ready")
        except Exception as e:
            logger.error(
                f"Model {self.model} not found. "
                f"Pull it with: ollama pull {self.model}"
            )
            raise

    # ----------------------
    # Context / token helpers
    # ----------------------
    def _estimate_tokens(self, text: str) -> int:
        """
        Rough token estimation: ≈ 1 token per 4 characters (English-ish).
        """
        return len(text) // 4

    def _check_context_size(self) -> Dict[str, float]:
        """
        Compute current document + conversation token usage.
        """
        doc_tokens = self._estimate_tokens(self.document_context)
        # Estimate from message text only — base64 image payloads would
        # massively inflate a character-based token estimate
        conv_text = " ".join(
            str(m.get("content", "") or "") for m in self.conversation_history
        )
        conv_tokens = self._estimate_tokens(conv_text)
        total_tokens = doc_tokens + conv_tokens

        return {
            "document_tokens": doc_tokens,
            "conversation_tokens": conv_tokens,
            "total_tokens": total_tokens,
            "remaining_tokens": self.max_context_tokens - total_tokens,
            "utilization_pct": (total_tokens / self.max_context_tokens) * 100
            if self.max_context_tokens > 0 else 0.0,
        }

    # -------------
    # Load documents (text extraction lives in utilities/doc_loaders.py,
    # shared with the web mode)
    # -------------
    def add_document(self, file_path: str) -> Dict[str, object]:
        """
        Add a document file into the running context.

        - Supports PDF, DOCX/DOC, TXT, CSV.
        - Appends text into self.document_context with a clear header.
        - Tracks approximate context usage and logs warnings if high.

        Returns summary metadata about the loaded file.
        """
        path = Path(file_path)

        if not path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")

        # The frontend re-sends loaded files with every prompt — skip
        # re-indexing a document we already have
        if path.name in self.loaded_files:
            return {"filename": path.name, "skipped": True}

        # Size in MB (for logging / UX)
        file_size_mb = path.stat().st_size / (1024 * 1024)
        if file_size_mb > 10:
            logger.warning(
                f"Large file detected: {file_size_mb:.1f} MB – may take time to process."
            )

        try:
            # Extract text segments (per-page for PDFs, so excerpts can cite
            # pages; figures are flagged but not processed)
            segments = extract_document(str(path))
            content = segments_to_text(segments)

            # Prefer RAG indexing: chunks are embedded now and only the
            # relevant ones are retrieved per question. If embeddings are
            # unavailable, fall back to stuffing the full text into context.
            rag_info = self.rag.add_document(path.name, segments)
            if rag_info is None:
                banner = (
                    "\n\n"
                    + "=" * 60
                    + f"\n=== Document: {path.name} ===\n"
                    + "=" * 60
                    + "\n"
                )
                self.document_context += banner + content
            self.loaded_files.append(path.name)

            context_info = self._check_context_size()
            estimated_tokens = self._estimate_tokens(content)

            result = {
                "filename": path.name,
                "size_mb": file_size_mb,
                "chars": len(content),
                "estimated_tokens": estimated_tokens,
                "context_utilization": f"{context_info['utilization_pct']:.1f}%",
                "rag_chunks": rag_info.get("chunks") if rag_info else None,
            }

            logger.info(
                f"✓ Loaded {path.name} "
                f"({len(content)} chars, ~{estimated_tokens} tokens)"
            )

            if context_info["utilization_pct"] > 80:
                logger.warning(
                    f"⚠ Context usage high: {context_info['utilization_pct']:.1f}%"
                )

            return result

        except Exception as e:
            logger.error(f"Failed to load {file_path}: {e}")
            raise

    def clear_documents(self) -> None:
        """
        Clear all loaded documents from context.
        """
        self.document_context = ""
        self.loaded_files = []
        self.rag.clear()
        logger.info("✓ Cleared all documents")

    # -------------
    # Conversation
    # -------------
    def clear_history(self) -> None:
        """
        Clear conversation history but leave documents loaded.
        """
        self.conversation_history = []
        logger.info("✓ Cleared conversation history")

    def reset(self) -> None:
        """
        Clear both conversation history and documents.
        """
        self.conversation_history = []
        self.document_context = ""
        self.loaded_files = []
        self.rag.clear()
        logger.info("✓ Reset complete")

    def _build_messages(self, retrieved_context: str = "") -> List[Dict[str, object]]:
        """
        Build the list of messages to send to Ollama, including:

          - One system message with base study instructions (always).
          - Retrieved document excerpts (RAG) for the current question, if any;
            otherwise the full document context (legacy fallback).
          - Full conversation history (user + assistant turns).
        """
        messages: List[Dict[str, object]] = []

        # Base study + no-charts instruction (always on)
        base_system = (
            "You are a helpful assistant for a research study on how people use large "
            "language models.\n"
            "For now, do NOT create, describe, or suggest any charts, graphs, plots, "
            "figures, or other visualizations. If the user asks for a chart, respond "
            "with a written/text explanation instead."
        )

        if retrieved_context:
            doc_system = (
                "Relevant excerpts retrieved from the user's uploaded documents are "
                "shown below. Use them to answer when relevant, and mention which "
                "document you are referencing. If the excerpts don't contain the "
                "answer, use your general knowledge to help the user.\n\n"
                f"{retrieved_context}"
            )
            system_content = base_system + "\n\n" + doc_system
        elif self.document_context:
            doc_system = (
                "You have access to the following documents. Use them to answer "
                "questions when relevant. If the documents don't contain the answer, "
                "use your general knowledge to help the user.\n"
                "When citing information from documents, mention which document you "
                "are referencing.\n\n"
                f"{self.document_context}"
            )
            system_content = base_system + "\n\n" + doc_system
        else:
            system_content = base_system

        messages.append({"role": "system", "content": system_content})
        messages.extend(self.conversation_history)
        return messages


    def chat(
        self,
        user_message: str,
        temperature: float = 0.7,
        images: Optional[List[str]] = None,
    ) -> str:
        """
        Non-streaming chat convenience method.

        - Updates conversation history.
        - Returns the full assistant response as a string.
        """
        # Pre-check context utilization
        context_info = self._check_context_size()
        if context_info["utilization_pct"] > 90:
            logger.warning(
                "Context near limit – consider clearing history or documents."
            )

        # Retrieve document excerpts relevant to this question (RAG)
        retrieved_context = ""
        if self.rag.has_documents():
            retrieved_context = self.rag.build_context(user_message)

        # Append user message to history (images are base64 strings and
        # require a vision-capable model, e.g. qwen2.5vl)
        user_msg: Dict[str, object] = {"role": "user", "content": user_message}
        if images:
            user_msg["images"] = images
        self.conversation_history.append(user_msg)

        messages = self._build_messages(retrieved_context)

        try:
            response = ollama.chat(
                model=self.model,
                messages=messages,
                stream=False,
                options={"temperature": temperature, "num_predict": -1},
            )
            full_response = response["message"]["content"]

            # Save assistant turn
            self.conversation_history.append(
                {"role": "assistant", "content": full_response}
            )

            return full_response

        except Exception as e:
            logger.error(f"Error during chat: {e}")
            # Roll back the last user message on failure
            if self.conversation_history and self.conversation_history[-1]["role"] == "user":
                self.conversation_history.pop()
            raise

    def stream_chat(
        self,
        user_message: str,
        thinking_mode: str = "fast",
        images: Optional[List[str]] = None,
    ):
        """
        Streaming chat generator for use by servers:

          for chunk in ollama_chat.stream_chat("hello", thinking_mode="fast"):
              ...

        - thinking_mode controls generation style (fast vs deep) for the SAME model.
        - images: optional base64-encoded images attached to this message
          (requires a vision-capable model, e.g. qwen2.5vl).
        """
        context_info = self._check_context_size()
        if context_info["utilization_pct"] > 90:
            logger.warning(
                "Context near limit – consider clearing history or documents."
            )

        # Qwen3 native thinking toggle:
        #   think=True  → model uses its internal chain-of-thought reasoning before answering.
        #                  Reasoning tokens go into message.thinking (not streamed to user).
        #   think=False → model answers directly without the reasoning pass.
        #
        # Temperatures follow Qwen3's official recommendations:
        #   deep  → 0.6  (slightly lower to keep reasoning coherent)
        #   fast  → 0.7  (standard)
        if thinking_mode == "deep":
            temperature = 0.6
            num_predict = -1   # let it think as long as needed
            think = True
        else:
            temperature = 0.6
            num_predict = -1
            think = False

        # Retrieve document excerpts relevant to this question (RAG).
        # This embeds the query on the GPU, so it happens inside the
        # energy-metered window in server.py.
        # NOTE: this generator yields str chunks (response text) and dict
        # events ({"status": ...} progress traces) — the server tells them apart.
        retrieved_context = ""
        if self.rag.has_documents():
            yield {"status": "Searching your documents…"}
            retrieved_context = self.rag.build_context(user_message)

        # Append user message, then build messages
        user_msg: Dict[str, object] = {"role": "user", "content": user_message}
        if images:
            user_msg["images"] = images
        self.conversation_history.append(user_msg)
        self._last_user_prompt_tokens = self._estimate_tokens(user_message)
        messages = self._build_messages(retrieved_context)

        full_response = ""

        try:
            stream = ollama.chat(
                model=self.model,
                messages=messages,
                stream=True,
                think=think,
                options={"temperature": temperature, "num_predict": num_predict},
            )
            reasoning_signaled = False
            for chunk in stream:
                msg = chunk.get("message", {}) or {}
                text = msg.get("content", "") or ""
                # Deep-think models emit reasoning tokens before any visible
                # text — surface that as a real progress trace once
                if not full_response and not text and not reasoning_signaled:
                    thinking_text = msg.get("thinking", "") or ""
                    if thinking_text:
                        reasoning_signaled = True
                        yield {"status": "Reasoning…"}
                if text:
                    full_response += text
                    yield text
                # Capture token counts from the final chunk
                if chunk.get("done"):
                    self._last_eval_count = chunk.get("eval_count", 0) or 0
                    self._last_prompt_eval_count = chunk.get("prompt_eval_count", 0) or 0

            # On success, record assistant response
            self.conversation_history.append(
                {"role": "assistant", "content": full_response}
            )

        except Exception as e:
            logger.error(f"Error during streaming chat: {e}")
            # On error, roll back last user message
            if self.conversation_history and self.conversation_history[-1]["role"] == "user":
                self.conversation_history.pop()
            raise

    # -------------
    # Introspection
    # -------------
    def get_status(self) -> Dict[str, object]:
        """
        Summarize current model, docs, turns, and context usage.
        """
        ctx = self._check_context_size()
        return {
            "model": self.model,
            "loaded_documents": self.loaded_files,
            "num_documents": len(self.loaded_files),
            "conversation_turns": len(self.conversation_history) // 2,
            "context_usage": ctx,
        }

    def export_conversation(self, filepath: str) -> None:
        """
        Export conversation + loaded files to JSON.
        """
        export_data = {
            "model": self.model,
            "loaded_files": self.loaded_files,
            "conversation": self.conversation_history,
        }
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(export_data, f, indent=2, ensure_ascii=False)
        logger.info(f"✓ Exported conversation to {filepath}")
