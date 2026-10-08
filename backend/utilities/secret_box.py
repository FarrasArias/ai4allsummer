# backend/utilities/secret_box.py
"""
Encryption for secrets users give the app (their own web search keys).

Values are encrypted with a key kept in backend/userdata/secret.key, readable
only by the account the server runs as. A copy of users.db on its own — a
backup, or a file shared to debug something — then doesn't expose anyone's
key. It can't protect against whoever controls this Mac: the server has to
decrypt a key to use it. Losing secret.key only means people re-enter keys.
"""

from __future__ import annotations

import os
import threading
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

from utilities.user_paths import USERDATA_DIR

KEY_PATH = USERDATA_DIR / "secret.key"

_lock = threading.Lock()
_fernet: Optional[Fernet] = None


def _box() -> Fernet:
    global _fernet
    with _lock:
        if _fernet is None:
            USERDATA_DIR.mkdir(parents=True, exist_ok=True)
            if not KEY_PATH.exists():
                # Created owner-read/write only, never world-readable even briefly
                fd = os.open(KEY_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as f:
                    f.write(Fernet.generate_key())
            _fernet = Fernet(KEY_PATH.read_bytes().strip())
        return _fernet


def encrypt(value: str) -> str:
    return _box().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt(token: str) -> Optional[str]:
    """None if it can't be read (e.g. secret.key was replaced)."""
    try:
        return _box().decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        return None
