# backend/utilities/engine_registry.py
"""
Per-(user, model) engines.

Each chat/web/code/image-generation engine holds one conversation's history
and one set of loaded documents, so they must never be shared between users
(SERVER_STAGE1.md §3). History lives in memory only — a backend restart
already loses it — so an engine left idle for a day is simply dropped; its
documents stay indexed on disk and are picked up again next time.
"""

from __future__ import annotations

import threading
import time
from typing import Callable, Generic, Optional, TypeVar

from utilities.access import User

T = TypeVar("T")

IDLE_SECONDS = 24 * 3600


class EngineRegistry(Generic[T]):
    def __init__(self, factory: Callable[[User, str], T]) -> None:
        self._factory = factory
        self._lock = threading.Lock()
        self._items: dict[tuple[int, str], tuple[T, float]] = {}

    def get(self, user: User, model: str) -> T:
        """The user's engine for `model`, created on first use. Creating one
        can raise (e.g. the model isn't installed); nothing is stored then."""
        now = time.monotonic()
        key = (user.id, model)
        with self._lock:
            self._sweep(now)
            item = self._items.get(key)
            engine = item[0] if item else self._factory(user, model)
            self._items[key] = (engine, now)
            return engine

    def peek(self, user: User, model: str) -> Optional[T]:
        """The engine if it already exists — for resets, which shouldn't
        create one (creating checks the model with Ollama and can fail)."""
        with self._lock:
            item = self._items.get((user.id, model))
            return item[0] if item else None

    def drop_user(self, user_id: int) -> None:
        with self._lock:
            for key in [k for k in self._items if k[0] == user_id]:
                del self._items[key]

    def drop_model(self, model: str) -> None:
        with self._lock:
            for key in [k for k in self._items if k[1] == model]:
                del self._items[key]

    def _sweep(self, now: float) -> None:
        # Caller holds the lock
        for key in [k for k, (_, used) in self._items.items() if now - used > IDLE_SECONDS]:
            del self._items[key]
