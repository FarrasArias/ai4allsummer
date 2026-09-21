# backend/utilities/about_store.py
"""
Storage for the "About Uness" content shown in-app.

Same copy-on-first-run convention as backend/conduct_defaults/: about.md is
seeded from configs_defaults/about.md the first time the server starts, and
is never overwritten afterward — a later app update can ship a new default
without clobbering a hand-edited about.md.
"""

from __future__ import annotations

from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parent.parent

ABOUT_PATH = _BACKEND_DIR / "configs" / "about.md"
_DEFAULT_PATH = _BACKEND_DIR / "configs_defaults" / "about.md"


def ensure_initialized() -> None:
    """Seed configs/about.md from the bundled default if it doesn't exist yet.
    Never overwrites an existing (possibly hand-edited) copy."""
    ABOUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    if ABOUT_PATH.exists():
        return
    try:
        ABOUT_PATH.write_text(
            _DEFAULT_PATH.read_text(encoding="utf-8"), encoding="utf-8", newline=""
        )
    except OSError:
        pass


def read_about() -> str:
    """Re-read about.md from disk on every call, so a hand edit shows up
    without a restart."""
    ensure_initialized()
    try:
        return ABOUT_PATH.read_text(encoding="utf-8")
    except OSError:
        return ""
