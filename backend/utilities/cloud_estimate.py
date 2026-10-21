# backend/utilities/cloud_estimate.py
"""
The "GPT-4o, estimated" figure shown next to each answer's measured energy:
roughly what the same answer would take on a large cloud model.

Source: Epoch AI, "How much energy does ChatGPT use?" (Josh You, Feb 2025),
https://epoch.ai/gradient-updates/how-much-energy-does-chatgpt-use — GPT-4o
at about 0.3 Wh for a typical 500-token answer, and about 2.4 Wh and 40 Wh
with 10,000 and 100,000 tokens of input. Their figures include server and
data-centre overhead. Fitted here as

    Wh = 0.0006 x output + 1.95e-4 x input + 2.0e-9 x input^2

which gives back those three points (0.30, 2.45 and 39.8 Wh).

The tokens are the ones our model processed for the answer, across every
step: its thinking, web searches and the pages read, the image. Input counts
only what's new in this answer (the question, documents, pages, the image):
Ollama reuses the conversation it has already read, as cloud services'
prompt caching does, so re-reading history is charged to neither side. It's
an estimate from published research, not a measurement, and a cloud model
may write a different (often better) answer.

Our side, for comparison: this Mac's chips (CPU, GPU, Neural Engine) above
idle — about 0.24 mWh per output token on qwen3.8:27b (October 2026).
"""

from __future__ import annotations

from typing import Optional

REFERENCE = "GPT-4o"

_WH_PER_OUTPUT_TOKEN = 0.3 / 500
_WH_PER_INPUT_TOKEN = 1.95e-4
_WH_PER_INPUT_TOKEN_SQUARED = 2.0e-9


def new_tokens(prompt_tokens: Optional[int], previous_prompt_tokens: Optional[int]) -> int:
    """How much of a model call's prompt is new since the previous call in the
    same conversation. Ollama reports the whole prompt every time; a prompt
    shorter than the previous one means the conversation was reset, so all
    of it is new."""
    p, prev = int(prompt_tokens or 0), int(previous_prompt_tokens or 0)
    return p - prev if p >= prev else p


def estimate_wh(input_tokens: Optional[int], output_tokens: Optional[int]) -> Optional[float]:
    """Estimated Wh for the same tokens on GPT-4o; None if the counts are unknown."""
    if not output_tokens:
        return None
    n_in = max(int(input_tokens or 0), 0)
    return (
        _WH_PER_OUTPUT_TOKEN * int(output_tokens)
        + _WH_PER_INPUT_TOKEN * n_in
        + _WH_PER_INPUT_TOKEN_SQUARED * n_in * n_in
    )
