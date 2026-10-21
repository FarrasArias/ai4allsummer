# backend/utilities/presence.py
"""
Who has used U.ness in the last few minutes, for the "Right now" display:
a count for everyone, names for admins on the Energy report page.

Kept in memory only: it answers "who was here just now", so losing it on a
restart doesn't matter. The access middleware reports every API request;
the ones a page makes on its own (the energy stream, queue checks) don't
count, so a tab left open drops off after ACTIVE_SECONDS.
"""

from __future__ import annotations

import threading
import time
from typing import Dict, List, Tuple

ACTIVE_SECONDS = 5 * 60

# Requests an open page makes by itself, without the person doing anything
PASSIVE_PATHS = frozenset({"/api/power/stream", "/api/queue", "/api/admin/activity"})

_lock = threading.Lock()
_last: Dict[int, Tuple[float, str]] = {}  # user id -> (monotonic time, username)


def request(user, path: str) -> None:
    """Called by the access middleware for each request from a known user."""
    if path.startswith("/api/") and path not in PASSIVE_PATHS:
        with _lock:
            _last[user.id] = (time.monotonic(), user.username)


def recent() -> List[dict]:
    """People with a request in the last ACTIVE_SECONDS, most recent first."""
    now = time.monotonic()
    with _lock:
        for uid in [uid for uid, (t, _) in _last.items() if now - t > ACTIVE_SECONDS]:
            del _last[uid]
        people = [
            {"user_id": uid, "username": name, "seconds_ago": round(now - t)}
            for uid, (t, name) in _last.items()
        ]
    return sorted(people, key=lambda p: p["seconds_ago"])
