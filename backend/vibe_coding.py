
import ollama
from pathlib import Path
from typing import List, Dict, Any

from utilities.main_model import KEEP_ALIVE, MAIN_MODEL
from utilities.cloud_estimate import new_tokens
import json
import logging

from utilities.prompt_config import get_system_prompt

# =============================================================================
# Configuration Constants
# =============================================================================

# Coding-specific model
DEFAULT_MODEL = MAIN_MODEL

# Fallback system prompt if not overridden in configs/prompts.json
DEFAULT_SYSTEM_PROMPT = """You are an expert software development assistant specializing in code generation, debugging, and optimization.

Your core capabilities:
- Write clean, efficient, production-ready code
- Debug errors and explain what went wrong
- Optimize existing code for performance and readability
- Explain complex programming concepts clearly
- Follow best practices and design patterns
- Generate complete, functional code solutions
- Review code and suggest improvements
- Help with algorithms, data structures, and architecture

Code formatting rules:
- Always use proper markdown code blocks with language tags (```python, ```javascript, etc.)
- Provide complete, runnable code when possible
- Include helpful comments for complex logic
- Show both the code AND explain your approach when helpful

When debugging:
- Identify the root cause of errors
- Explain why the error occurred
- Provide the corrected code
- Suggest how to prevent similar issues

Be concise but thorough. Focus on solving the actual problem."""

# =============================================================================
# Logging Setup
# =============================================================================
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


# =============================================================================
# VibeCodingChat Class
# =============================================================================
class VibeCodingChat:
    def __init__(self, model: str = DEFAULT_MODEL):
        self.model = model
        self.conversation_history: List[Dict[str, str]] = []
        self.code_context: str = ""  # For loaded code files
        # Tokens the last answer processed: new input and output (for the
        # cloud comparison, utilities/cloud_estimate.py)
        self._prompt_tokens = 0
        self.answer_tokens: Dict[str, int] = {"input": 0, "output": 0}
        self.loaded_files: List[str] = []

        # Verify model is available
        try:
            ollama.show(self.model)
            logger.info(f"✓ Coding model **{self.model}** is ready")
        except Exception as e:
            logger.error(f"Model **{self.model}** not found. Pull it with: ollama pull {self.model}")
            raise

    # ----------------------
    # Code file loading
    # ----------------------
    def load_code_file(self, file_path: str) -> Dict[str, Any]:
        """Load a code file for context (supports common code file types)."""
        path = Path(file_path)

        if not path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")

        # Support common code file extensions
        code_extensions = {
            ".py",
            ".js",
            ".ts",
            ".jsx",
            ".tsx",
            ".java",
            ".c",
            ".cpp",
            ".h",
            ".cs",
            ".go",
            ".rs",
            ".php",
            ".rb",
            ".swift",
            ".kt",
            ".scala",
            ".html",
            ".css",
            ".scss",
            ".sql",
            ".sh",
            ".bash",
            ".yaml",
            ".yml",
            ".json",
            ".xml",
            ".md",
            ".txt",
            ".env",
            ".config",
        }

        if path.suffix.lower() not in code_extensions:
            logger.warning(f"Unusual file type: {path.suffix}. Loading anyway.")

        # Check file size
        file_size_mb = path.stat().st_size / (1024 * 1024)
        if file_size_mb > 5:
            logger.warning(f"Large file: {file_size_mb:.1f}MB - may take time to process")

        try:
            # Try multiple encodings
            encodings = ["utf-8", "latin-1", "cp1252"]
            content = None

            for encoding in encodings:
                try:
                    with open(file_path, "r", encoding=encoding) as f:
                        content = f.read()
                    break
                except UnicodeDecodeError:
                    continue

            if content is None:
                raise UnicodeDecodeError(
                    "Unknown", b"", 0, 1, "could not decode file with common encodings"
                )

            # Append to context
            banner = (
                "\n\n"
                + "=" * 60
                + f"\n=== Code file: {path.name} ===\n"
                + "=" * 60
                + "\n"
            )
            self.code_context += banner + content
            self.loaded_files.append(path.name)

            result = {
                "filename": path.name,
                "size_mb": file_size_mb,
                "chars": len(content),
            }

            logger.info(f"✓ Loaded code file {path.name} ({len(content)} chars)")
            return result

        except Exception as e:
            logger.error(f"Failed to load code file {file_path}: {e}")
            raise

    def clear_context(self):
        """Clear loaded code context, but keep conversation."""
        self.code_context = ""
        self.loaded_files = []
        logger.info("✓ Cleared code context")

    # ----------------------
    # Main coding interaction
    # ----------------------
    def code(self, user_message: str, stream: bool = False, temperature: float = 0.7) -> str:
        """
        Coding assistance:

        - Uses shared system prompt (from configs/prompts.json if provided)
        - Includes any loaded code files in a separate context section
        """
        # Build messages
        messages: List[Dict[str, str]] = []

        base_system = get_system_prompt("vibe_coding", DEFAULT_SYSTEM_PROMPT)

        system_content = base_system
        if self.code_context:
            system_content += (
                "\n\nYou also have the following code context loaded. Use it when helpful:\n"
                f"{self.code_context}"
            )

        messages.append({"role": "system", "content": system_content})

        # Add conversation history
        messages.extend(self.conversation_history)

        # Add user message
        user_msg = {"role": "user", "content": user_message}
        messages.append(user_msg)

        # Update history
        self.conversation_history.append(user_msg)

        try:
            response = ollama.chat(
                model=self.model,
                keep_alive=KEEP_ALIVE,
                messages=messages,
                stream=stream,
                options={
                    "temperature": temperature,
                    "num_predict": -1,
                },
            )

            if stream:
                full_response = ""
                for chunk in response:
                    content = chunk["message"]["content"]
                    print(content, end="", flush=True)
                    full_response += content
                    final = chunk
                print()
            else:
                full_response = response["message"]["content"]
                print(full_response)
                final = response

            prompt_tokens = final.get("prompt_eval_count") or 0
            self.answer_tokens = {
                "input": new_tokens(prompt_tokens, self._prompt_tokens),
                "output": final.get("eval_count") or 0,
            }
            self._prompt_tokens = prompt_tokens

            self.conversation_history.append(
                {
                    "role": "assistant",
                    "content": full_response,
                }
            )

            return full_response

        except Exception as e:
            logger.error(f"Error during coding: {e}")
            # Remove the failed user message from history
            if self.conversation_history and self.conversation_history[-1]["role"] == "user":
                self.conversation_history.pop()
            raise

    # ----------------------
    # Introspection / housekeeping
    # ----------------------
    def clear_history(self):
        """Clear conversation history but keep loaded files."""
        turns = len(self.conversation_history) // 2
        self.conversation_history = []
        logger.info(f"✓ Cleared conversation history ({turns} turns)")

    def reset(self):
        """Clear everything - history and loaded files."""
        self.conversation_history = []
        self.code_context = ""
        self.loaded_files = []
        logger.info("✓ Reset complete")

    def get_status(self) -> Dict:
        """Get current system status."""
        return {
            "model": self.model,
            "loaded_files": self.loaded_files,
            "num_files": len(self.loaded_files),
            "conversation_turns": len(self.conversation_history) // 2,
        }

    def export_conversation(self, filepath: str):
        """Export conversation history to JSON."""
        export_data = {
            "model": self.model,
            "loaded_files": self.loaded_files,
            "conversation": self.conversation_history,
        }
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(export_data, f, indent=2, ensure_ascii=False)
        logger.info(f"✓ Exported conversation to {filepath}")
