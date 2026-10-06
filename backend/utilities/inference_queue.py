# backend/utilities/inference_queue.py
"""
One model job at a time, first come, first served.

Per-prompt energy is measured as the Mac's GPU power above idle while a
prompt runs. Two prompts running together would each be charged for the
other, so model work is serialised here (SERVER_STAGE1.md §4). Requests that
don't touch a model — login, saved chats, settings, the power stream — never
come through this.

Streaming endpoints wrap their existing sync SSE generator in
`queued_stream`, which waits without holding a thread, tells the user their
place in line, and frees the slot when the client goes away. Non-streaming
endpoints call `acquire` (blocking) and `release`.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import os
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import AsyncIterator, Callable, Iterator, Optional

import anyio
from starlette.responses import StreamingResponse
from starlette.types import Receive, Scope, Send

logger = logging.getLogger(__name__)

MAX_JOB_SECONDS = int(os.environ.get("UNESS_MAX_JOB_SECONDS", "600"))
MAX_JOBS_PER_USER = int(os.environ.get("UNESS_MAX_JOBS_PER_USER", "1"))
# How long a non-streaming request may wait for its turn
MAX_WAIT_SECONDS = MAX_JOB_SECONDS

_POLL_SECONDS = 0.5
# An SSE comment now and then keeps proxies from dropping a long wait as idle
_KEEPALIVE_SECONDS = 15


class QueueBusy(Exception):
    """The user already has as many requests in progress as allowed."""

    def __init__(self) -> None:
        super().__init__("You already have a request in progress. Wait for it to finish.")


class QueueTimeout(Exception):
    def __init__(self) -> None:
        super().__init__("The server is busy. Try again in a few minutes.")


@dataclass(eq=False)
class Ticket:
    id: int
    user_id: int
    label: str      # what others are told is running, e.g. "an agent task"
    exempt: bool    # no time cap (agent runs, SERVER_STAGE1.md D12)
    counted: bool   # counts toward the user's in-progress limit
    started: Optional[float] = None


class InferenceQueue:
    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._waiting: deque[Ticket] = deque()
        self._running: Optional[Ticket] = None
        self._ids = itertools.count(1)

    # -- entering and leaving ------------------------------------------------

    def enter(self, user_id: int, label: str, *, exempt: bool = False, counted: bool = True) -> Ticket:
        """Join the back of the line. Raises QueueBusy if the user is at their limit."""
        with self._cond:
            if counted:
                mine = sum(1 for t in self._tickets() if t.user_id == user_id and t.counted)
                if mine >= MAX_JOBS_PER_USER:
                    raise QueueBusy()
            ticket = Ticket(next(self._ids), user_id, label, exempt, counted)
            self._waiting.append(ticket)
            return ticket

    def release(self, ticket: Ticket) -> None:
        """Leave the line or give up the slot. Safe to call more than once."""
        with self._cond:
            if self._running is ticket:
                self._running = None
            else:
                try:
                    self._waiting.remove(ticket)
                except ValueError:
                    pass
            self._cond.notify_all()

    # -- taking a turn ---------------------------------------------------------

    def try_acquire(self, ticket: Ticket) -> bool:
        with self._cond:
            return self._take_if_next(ticket)

    def acquire(self, ticket: Ticket, timeout: float = MAX_WAIT_SECONDS) -> None:
        """Block until it's this ticket's turn. Raises QueueTimeout (and leaves
        the line) if that takes longer than `timeout`."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while not self._take_if_next(ticket):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    try:
                        self._waiting.remove(ticket)
                    except ValueError:
                        pass
                    self._cond.notify_all()
                    raise QueueTimeout()
                # Wake at least once a second so an overdue job gets expired
                self._cond.wait(min(remaining, 1.0))

    def _take_if_next(self, ticket: Ticket) -> bool:
        # Caller holds the lock
        self._expire_overdue()
        if self._running is None and self._waiting and self._waiting[0] is ticket:
            self._waiting.popleft()
            ticket.started = time.monotonic()
            self._running = ticket
            return True
        return False

    def _expire_overdue(self) -> None:
        # Caller holds the lock. Streaming jobs stop themselves at the cap; this
        # catches a non-streaming call that can't be interrupted, so it can't
        # hold everyone else up forever. Its release() later is a no-op.
        job = self._running
        if job and not job.exempt and time.monotonic() - job.started > MAX_JOB_SECONDS:
            logger.warning("Queue: job %s (%s) passed %ss, giving up its slot", job.id, job.label, MAX_JOB_SECONDS)
            self._running = None
            self._cond.notify_all()

    # -- reporting -------------------------------------------------------------

    def _tickets(self) -> list[Ticket]:
        return ([self._running] if self._running else []) + list(self._waiting)

    def wait_message(self, ticket: Ticket) -> str:
        with self._cond:
            try:
                ahead = self._waiting.index(ticket) + (1 if self._running else 0)
            except ValueError:
                ahead = 0
            running = self._running
        if ahead == 0:
            return "Starting…"
        msg = f"Waiting in line — {ahead} ahead of you"
        if running is not None and running.exempt:
            msg += f" (the host is running {running.label})"
        return msg

    def snapshot(self, user_id: int) -> dict:
        with self._cond:
            mine: Optional[int] = None
            if self._running is not None and self._running.user_id == user_id:
                mine = 0
            else:
                for i, t in enumerate(self._waiting):
                    if t.user_id == user_id:
                        mine = i + (1 if self._running else 0)
                        break
            return {"running": self._running is not None, "waiting": len(self._waiting), "mine": mine}


QUEUE = InferenceQueue()


def _sse(payload: dict) -> bytes:
    return f"data: {json.dumps(payload)}\n\n".encode("utf-8")


_DONE = object()


class _ThreadedStream:
    """Steps a sync generator in worker threads, one step at a time.

    A cancelled request can leave a worker thread still inside next() (e.g.
    waiting on the model's next token). The lock makes close() wait for that
    step to finish instead of failing with "generator already executing" —
    and so the queue slot stays taken until the GPU work has actually stopped.
    """

    def __init__(self, stream: Iterator[bytes]) -> None:
        self._stream = stream
        self._lock = threading.Lock()

    def next(self):
        with self._lock:
            return next(self._stream, _DONE)

    def close(self) -> None:
        with self._lock:
            close = getattr(self._stream, "close", None)
            if close is None:
                return
            try:
                close()
            except RuntimeError:
                # The existing generators yield their final "done" event from
                # a finally block; closing one early makes that yield raise.
                # Its cleanup (energy metering) has already run by then.
                pass


async def queued_stream(
    ticket: Ticket,
    make_stream: Callable[[], Iterator[bytes]],
    event: Callable[[str, str], dict],
    cleanup: Optional[Callable[[], None]] = None,
) -> AsyncIterator[bytes]:
    """Wait for `ticket`'s turn, then relay the sync SSE generator `make_stream()`.

    `event(kind, text)` builds this endpoint's own payload shape for
    kind "status" or "error", so each pane shows it the way it already shows
    its other status lines. `cleanup` runs however the stream ends — including
    a client that leaves while still waiting, before `make_stream` ever ran.
    """
    stream: Optional[_ThreadedStream] = None
    try:
        last_msg, last_sent = None, time.monotonic()
        while not QUEUE.try_acquire(ticket):
            msg = QUEUE.wait_message(ticket)
            now = time.monotonic()
            if msg != last_msg:
                yield _sse(event("status", msg))
                last_msg, last_sent = msg, now
            elif now - last_sent >= _KEEPALIVE_SECONDS:
                yield b": keepalive\n\n"
                last_sent = now
            await asyncio.sleep(_POLL_SECONDS)

        stream = _ThreadedStream(make_stream())
        while (chunk := await anyio.to_thread.run_sync(stream.next)) is not _DONE:
            yield chunk
            if not ticket.exempt and time.monotonic() - ticket.started > MAX_JOB_SECONDS:
                minutes = MAX_JOB_SECONDS // 60
                yield _sse(event("error", f"Stopped: this request ran longer than {minutes} minutes."))
                break
    finally:
        # Shielded: when the client disconnects this runs inside a cancelled
        # scope, and the slot must still be freed.
        with anyio.CancelScope(shield=True):
            try:
                if stream is not None:
                    await anyio.to_thread.run_sync(stream.close)
                if cleanup is not None:
                    await anyio.to_thread.run_sync(cleanup)
            finally:
                QUEUE.release(ticket)


class _ClosingStreamingResponse(StreamingResponse):
    """Closes its body iterator however the response ends. If the client
    disconnects while Starlette is mid-send (rather than inside the
    generator), the generator would otherwise only be finalised whenever it's
    garbage-collected — and until then its queue slot stays taken."""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            with anyio.CancelScope(shield=True):
                await self.body_iterator.aclose()


def queued_response(
    ticket: Ticket,
    make_stream: Callable[[], Iterator[bytes]],
    event: Callable[[str, str], dict],
    cleanup: Optional[Callable[[], None]] = None,
) -> StreamingResponse:
    return _ClosingStreamingResponse(
        queued_stream(ticket, make_stream, event, cleanup),
        media_type="text/event-stream",
    )
