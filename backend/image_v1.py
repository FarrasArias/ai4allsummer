
import ollama
from pathlib import Path
from typing import List, Dict, Any
import json
import logging
import base64

from utilities.prompt_config import get_system_prompt
from utilities.main_model import KEEP_ALIVE, MAIN_MODEL

# =============================================================================
#  Configuration Constants
# =============================================================================

# Vision model for image analysis
DEFAULT_MODEL = MAIN_MODEL

# Fallback system prompt if not overridden in configs/prompts.json
DEFAULT_SYSTEM_PROMPT = """You are an expert image analysis assistant with advanced vision capabilities.

Your role is to:
- Provide detailed, accurate descriptions of images
- Identify objects, people, scenes, and activities
- Analyze composition, colors, lighting, and visual elements
- Read and extract text from images (OCR)
- Detect patterns, logos, symbols, and signs
- Assess image quality and technical aspects
- Answer specific questions about image content
- Compare multiple images when provided

Be thorough, precise, and objective in your analysis. When uncertain, acknowledge limitations rather than guessing."""

# =============================================================================
#  Logging Setup
# =============================================================================
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


# =============================================================================
# ImageAnalysisChat Class
# =============================================================================
class ImageAnalysisChat:
    def __init__(self, model: str = DEFAULT_MODEL):
        self.model = model
        self.conversation_history: List[Dict[str, Any]] = []
        self.loaded_images: List[Dict[str, str]] = []

        # Verify model is available
        try:
            ollama.show(self.model)
            logger.info(f"✓ Vision model **{self.model}** is ready")
        except Exception as e:
            logger.error(f"Model **{self.model}** not found. Pull it with: ollama pull {self.model}")
            raise

    def load_image(self, image_path: str) -> Dict[str, Any]:
        """Load an image file and encode it in base64."""
        path = Path(image_path)

        if not path.exists():
            raise FileNotFoundError(f"Image not found: {image_path}")

        # Check if it's an image file
        valid_extensions = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif"}
        if path.suffix.lower() not in valid_extensions:
            raise ValueError(
                f"Unsupported image type: {path.suffix}. Supported: {', '.join(valid_extensions)}"
            )

        # Check file size
        file_size_mb = path.stat().st_size / (1024 * 1024)
        if file_size_mb > 20:
            logger.warning(f"Large image detected: {file_size_mb:.1f}MB - may take time to process")

        try:
            # Read and encode image as base64
            with open(image_path, "rb") as img_file:
                image_data = base64.b64encode(img_file.read()).decode("utf-8")

            # Store image info
            image_info = {
                "filename": path.name,
                "path": str(path),
                "data": image_data,
            }
            self.loaded_images.append(image_info)

            result = {
                "filename": path.name,
                "size_mb": file_size_mb,
                "format": path.suffix.lower(),
            }

            logger.info(f"✓ Loaded image {path.name} ({file_size_mb:.2f}MB)")

            return result

        except Exception as e:
            logger.error(f"Failed to load image {image_path}: {e}")
            raise

    def clear_images(self):
        """Clear all loaded images."""
        num_images = len(self.loaded_images)
        self.loaded_images = []
        logger.info(f"✓ Cleared {num_images} image(s)")

    def analyze(self, user_message: str, stream: bool = False, temperature: float = 0.7) -> str:
        """Analyze images with the given prompt."""
        if not self.loaded_images:
            logger.warning("No images loaded.")
            return "Please load an image first."

        # Prepare the user message with images
        user_msg = {
            "role": "user",
            "content": user_message,
            "images": [img["data"] for img in self.loaded_images],
        }

        # Add user message to history
        self.conversation_history.append(user_msg)

        # Prepare messages with system prompt
        system_prompt = get_system_prompt("image", DEFAULT_SYSTEM_PROMPT)

        messages = [
            {
                "role": "system",
                "content": system_prompt,
            }
        ]

        # Add conversation history
        messages.extend(self.conversation_history)

        # Get response from Ollama
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

            # Handle streaming vs non-streaming
            if stream:
                full_response = ""
                for chunk in response:
                    content = chunk["message"]["content"]
                    print(content, end="", flush=True)
                    full_response += content
                print()  # New line after streaming
            else:
                full_response = response["message"]["content"]
                print(full_response)

            # Add assistant response to history
            self.conversation_history.append({"role": "assistant", "content": full_response})

            return full_response

        except Exception as e:
            logger.error(f"Error during analysis: {e}")
            # Remove the failed user message from history
            if self.conversation_history and self.conversation_history[-1]["role"] == "user":
                self.conversation_history.pop()
            raise

    def clear_history(self):
        """Clear conversation history but keep images loaded."""
        turns = len(self.conversation_history) // 2
        self.conversation_history = []
        logger.info(f"✓ Cleared conversation history ({turns} turns)")

    def reset(self):
        """Clear everything - history and images."""
        self.conversation_history = []
        self.loaded_images = []
        logger.info("✓ Reset complete - all images and history cleared")

    def get_status(self) -> Dict:
        """Get current system status."""
        return {
            "model": self.model,
            "loaded_images": [img["filename"] for img in self.loaded_images],
            "num_images": len(self.loaded_images),
            "conversation_turns": len(self.conversation_history) // 2,
        }

    def export_conversation(self, filepath: str):
        """Export conversation history to JSON (without image data)."""
        export_data = {
            "model": self.model,
            "loaded_images": [img["filename"] for img in self.loaded_images],
            "conversation": [
                {k: v for k, v in msg.items() if k != "images"}  # Exclude base64 data
                for msg in self.conversation_history
            ],
        }
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(export_data, f, indent=2, ensure_ascii=False)
        logger.info(f"✓ Exported conversation to {filepath}")
