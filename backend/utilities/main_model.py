# backend/utilities/main_model.py
"""
The one model U.ness uses for everything: Chat (Fast = thinking off, Deep
think = thinking on), Code / Agent, Image analysis, Web, and writing image
generation prompts. Everyone on the same model keeps energy readings
comparable across people.

backend/configs/models.json names it too; these are the fallbacks when that
file is missing, and the defaults for code that doesn't read it.
"""

import os

MAIN_MODEL = "qwen3.8:27b"

# Document search embeddings — not a chat model, and stays installed
EMBED_MODEL = "nomic-embed-text"

# How long Ollama keeps the model loaded after a request. Its default is 5
# minutes; reloading the 27B model takes several seconds and that energy
# would be charged to whoever asks next.
KEEP_ALIVE = os.environ.get("UNESS_KEEP_ALIVE", "60m")
