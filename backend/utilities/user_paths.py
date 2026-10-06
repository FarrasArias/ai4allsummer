# backend/utilities/user_paths.py
"""
Where each user's data lives on disk, and safe joining of user-supplied
names onto those folders.

Every user gets backend/userdata/<username>/. The owner is the one
exception: their chats, image analyses, document index and conduct logs
stay in the locations the app has always used (SERVER_STAGE1.md, D2), so
upgrading needs no migration. That exception lives only in paths_for().
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from utilities.access import User

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_DIR.parent
USERDATA_DIR = BACKEND_DIR / "userdata"


@dataclass(frozen=True)
class UserPaths:
    root: Path
    chats: Path
    images: Path
    rag_cache: Path
    conduct_logs: Path
    uploads: Path


def paths_for(user: User) -> UserPaths:
    root = USERDATA_DIR / user.username
    if user.is_owner:
        return UserPaths(
            root=root,
            chats=BACKEND_DIR / "chats",
            images=BACKEND_DIR / "images",
            rag_cache=BACKEND_DIR / "rag_cache",
            conduct_logs=PROJECT_ROOT / "conduct_logs",
            uploads=root / "uploads",
        )
    return UserPaths(
        root=root,
        chats=root / "chats",
        images=root / "images",
        rag_cache=root / "rag_cache",
        conduct_logs=root / "conduct_logs",
        uploads=root / "uploads",
    )


class InvalidName(ValueError):
    pass


def safe_child(base: Path | str, name: str) -> Path:
    """base/name, refusing any name that isn't a single path component inside
    base (so '..', 'a/b' or an absolute path can never escape it)."""
    if (
        not name
        or name in (".", "..")
        or len(name) > 200
        or any(c in name for c in "/\\\0")
    ):
        raise InvalidName(f"Invalid name: {name!r}")
    base_path = Path(base).resolve()
    child = (base_path / name).resolve()
    if child.parent != base_path:
        raise InvalidName(f"Invalid name: {name!r}")
    return child
