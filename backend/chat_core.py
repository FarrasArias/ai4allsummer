# chat_core.py

import json
import logging
from pathlib import Path
from typing import List, Dict

import ollama
import PyPDF2
import docx
import pandas as pd

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

        # Full conversation history: list of {"role": "user"|"assistant", "content": "..."}
        self.conversation_history: List[Dict[str, str]] = []

        # Concatenated text of all loaded documents
        self.document_context: str = ""

        # Names of loaded files
        self.loaded_files: List[str] = []

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
        conv_tokens = self._estimate_tokens(json.dumps(self.conversation_history))
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
    # Load documents
    # -------------
    def load_pdf(self, pdf_path: str) -> str:
        """
        Extract text from a PDF file, with page markers.
        """
        try:
            text = ""
            with open(pdf_path, "rb") as file:
                reader = PyPDF2.PdfReader(file)
                for page_num, page in enumerate(reader.pages):
                    page_text = page.extract_text()
                    if page_text:
                        text += f"\n--- Page {page_num + 1} ---\n{page_text}"
            return text
        except Exception as e:
            logger.error(f"Error reading PDF {pdf_path}: {e}")
            raise

    def load_docx(self, docx_path: str) -> str:
        """
        Extract text from a DOCX file.
        """
        try:
            doc = docx.Document(docx_path)
            text = "\n\n".join(
                paragraph.text for paragraph in doc.paragraphs if paragraph.text
            )
            return text
        except Exception as e:
            logger.error(f"Error reading DOCX {docx_path}: {e}")
            raise

    def load_txt(self, txt_path: str) -> str:
        """
        Load a text file with basic encoding fallback.
        """
        encodings = ["utf-8", "latin-1", "cp1252", "iso-8859-1"]
        for enc in encodings:
            try:
                with open(txt_path, "r", encoding=enc) as f:
                    return f.read()
            except UnicodeDecodeError:
                continue
        raise ValueError(f"Could not decode {txt_path} with any common encoding")

    def load_csv(self, csv_path: str) -> str:
        """
        Summarize a CSV file as readable text instead of dumping the whole thing.
        """
        try:
            df = pd.read_csv(csv_path)

            text = "CSV File Summary:\n"
            text += f"Rows: {len(df)}, Columns: {len(df.columns)}\n"
            text += f"Column Names: {', '.join(df.columns)}\n\n"
            text += "First 20 rows:\n"
            text += f"{df.head(20).to_string()}\n\n"
            text += "Data Types:\n"
            text += f"{df.dtypes.to_string()}\n\n"
            text += "Basic Statistics:\n"
            text += f"{df.describe().to_string()}"

            return text
        except Exception as e:
            logger.error(f"Error reading CSV {csv_path}: {e}")
            raise

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

        # Size in MB (for logging / UX)
        file_size_mb = path.stat().st_size / (1024 * 1024)
        if file_size_mb > 10:
            logger.warning(
                f"Large file detected: {file_size_mb:.1f} MB – may take time to process."
            )

        suffix = path.suffix.lower()

        try:
            if suffix == ".pdf":
                content = self.load_pdf(str(path))
            elif suffix in [".docx", ".doc"]:
                content = self.load_docx(str(path))
            elif suffix == ".txt":
                content = self.load_txt(str(path))
            elif suffix == ".csv":
                content = self.load_csv(str(path))
            else:
                raise ValueError(f"Unsupported file type: {suffix}")

            # Append to global document context
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
        logger.info("✓ Reset complete")

    def _build_messages(self) -> List[Dict[str, str]]:
        """
        Build the list of messages to send to Ollama, including:

          - One system message with base study instructions (always).
          - Optional document context if any docs are loaded.
          - Full conversation history (user + assistant turns).
        """
        messages: List[Dict[str, str]] = []

        # Base study + no-charts instruction (always on)
        base_system = (
            "You are a helpful assistant for a research study on how people use large "
            "language models.\n"
            "For now, do NOT create, describe, or suggest any charts, graphs, plots, "
            "figures, or other visualizations. If the user asks for a chart, respond "
            "with a written/text explanation instead."
        )

        if self.document_context:
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


    def chat(self, user_message: str, temperature: float = 0.7) -> str:
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

        # Append user message to history
        self.conversation_history.append(
            {"role": "user", "content": user_message}
        )

        messages = self._build_messages()

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

    def stream_chat(self, user_message: str, thinking_mode: str = "fast"):
        """
        Streaming chat generator for use by servers:

          for chunk in ollama_chat.stream_chat("hello", thinking_mode="fast"):
              ...

        - thinking_mode controls generation style (fast vs deep) for the SAME model.
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

        # Append user message, then build messages
        self.conversation_history.append(
            {"role": "user", "content": user_message}
        )
        self._last_user_prompt_tokens = self._estimate_tokens(user_message)
        messages = self._build_messages()

        full_response = ""

        try:
            stream = ollama.chat(
                model=self.model,
                messages=messages,
                stream=True,
                think=think,
                options={"temperature": temperature, "num_predict": num_predict},
            )
            for chunk in stream:
                msg = chunk.get("message", {}) or {}
                text = msg.get("content", "") or ""
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
