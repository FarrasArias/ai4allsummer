# image_gen.py
# Image generation engine using Stable Diffusion WebUI API (AUTOMATIC1111)
# with optional Ollama-based prompt enhancement.

import base64
import json
import logging
import requests
from typing import Dict, Any, Optional

import ollama
from utilities.prompt_config import get_system_prompt

# =============================================================================
#  Configuration Constants
# =============================================================================

# Ollama model used for prompt enhancement (refining user text into SD prompts)
DEFAULT_ENHANCER_MODEL = "qwen2.5:7b"

# Stable Diffusion WebUI API base URL (AUTOMATIC1111 / Forge / etc.)
SD_API_BASE = "http://127.0.0.1:7860"

# Fallback system prompt for the prompt-enhancer LLM
DEFAULT_SYSTEM_PROMPT = (
    "You are an expert Stable Diffusion prompt engineer. "
    "The user will describe an image they want. You must reply with ONLY the "
    "optimised Stable Diffusion prompt text — no explanations, no markdown, no "
    "surrounding quotes. Include relevant style, lighting, camera, and quality "
    "tags. Keep the prompt under 200 words."
)

# Default generation parameters
DEFAULT_PARAMS = {
    "width": 512,
    "height": 512,
    "steps": 25,
    "cfg_scale": 7.0,
    "sampler_name": "Euler a",
    "negative_prompt": "lowres, bad anatomy, bad hands, text, watermark, blurry",
}

# =============================================================================
#  Logging Setup
# =============================================================================
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


# =============================================================================
#  ImageGenEngine Class
# =============================================================================
class ImageGenEngine:
    """
    Two-stage image generation:
      1. (Optional) Use an Ollama LLM to enhance the user's plain-English
         description into an optimised Stable Diffusion prompt.
      2. Send the prompt to a local Stable Diffusion WebUI API and retrieve
         the generated image as base64 PNG.
    """

    def __init__(
        self,
        enhancer_model: str = DEFAULT_ENHANCER_MODEL,
        sd_api_base: str = SD_API_BASE,
    ):
        self.enhancer_model = enhancer_model
        self.sd_api_base = sd_api_base.rstrip("/")
        self.history: list[Dict[str, Any]] = []

    # -----------------------------------------------------------------
    # Prompt enhancement via Ollama
    # -----------------------------------------------------------------
    def enhance_prompt(self, user_prompt: str) -> str:
        """Use an Ollama model to rewrite the user prompt into SD-optimised text."""
        system_prompt = get_system_prompt("image_gen", DEFAULT_SYSTEM_PROMPT)

        try:
            response = ollama.chat(
                model=self.enhancer_model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                options={"temperature": 0.7, "num_predict": 300},
            )
            enhanced = response["message"]["content"].strip()
            logger.info(f"Enhanced prompt: {enhanced[:120]}...")
            return enhanced
        except Exception as e:
            logger.warning(f"Prompt enhancement failed ({e}); using raw prompt")
            return user_prompt

    # -----------------------------------------------------------------
    # SD WebUI txt2img call
    # -----------------------------------------------------------------
    def generate(
        self,
        prompt: str,
        negative_prompt: Optional[str] = None,
        width: int = DEFAULT_PARAMS["width"],
        height: int = DEFAULT_PARAMS["height"],
        steps: int = DEFAULT_PARAMS["steps"],
        cfg_scale: float = DEFAULT_PARAMS["cfg_scale"],
        sampler_name: str = DEFAULT_PARAMS["sampler_name"],
        enhance: bool = True,
    ) -> Dict[str, Any]:
        """
        Generate an image.

        Returns dict with:
          - image_b64: base64-encoded PNG string
          - prompt_used: the final prompt sent to SD
          - original_prompt: the user's original input
          - parameters: generation parameters used
        """
        original_prompt = prompt

        # Step 1: optionally enhance
        if enhance:
            prompt = self.enhance_prompt(prompt)

        final_negative = negative_prompt or DEFAULT_PARAMS["negative_prompt"]

        payload = {
            "prompt": prompt,
            "negative_prompt": final_negative,
            "width": width,
            "height": height,
            "steps": steps,
            "cfg_scale": cfg_scale,
            "sampler_name": sampler_name,
            "batch_size": 1,
            "n_iter": 1,
        }

        url = f"{self.sd_api_base}/sdapi/v1/txt2img"
        logger.info(f"Calling SD API: {url}")

        try:
            r = requests.post(url, json=payload, timeout=120)
            r.raise_for_status()
            data = r.json()
        except requests.ConnectionError:
            raise ConnectionError(
                "Could not connect to Stable Diffusion WebUI API at "
                f"{self.sd_api_base}. Make sure the SD WebUI is running "
                "with --api flag enabled."
            )
        except Exception as e:
            raise RuntimeError(f"Image generation failed: {e}")

        images = data.get("images", [])
        if not images:
            raise RuntimeError("SD API returned no images")

        image_b64 = images[0]

        result = {
            "image_b64": image_b64,
            "prompt_used": prompt,
            "original_prompt": original_prompt,
            "parameters": {
                "width": width,
                "height": height,
                "steps": steps,
                "cfg_scale": cfg_scale,
                "sampler_name": sampler_name,
                "negative_prompt": final_negative,
            },
        }

        # Keep a history entry
        self.history.append(
            {
                "original_prompt": original_prompt,
                "prompt_used": prompt,
                "parameters": result["parameters"],
            }
        )

        return result

    # -----------------------------------------------------------------
    # Check if SD WebUI is reachable
    # -----------------------------------------------------------------
    def sd_available(self) -> bool:
        """Return True if the SD WebUI API is reachable."""
        try:
            r = requests.get(f"{self.sd_api_base}/sdapi/v1/sd-models", timeout=5)
            return r.ok
        except Exception:
            return False

    def get_sd_models(self) -> list[str]:
        """Return list of checkpoint names from the SD WebUI."""
        try:
            r = requests.get(f"{self.sd_api_base}/sdapi/v1/sd-models", timeout=5)
            r.raise_for_status()
            return [m["title"] for m in r.json()]
        except Exception:
            return []

    def reset(self):
        """Clear generation history."""
        self.history = []
        logger.info("ImageGenEngine reset")
