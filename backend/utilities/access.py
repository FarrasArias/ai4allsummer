# backend/utilities/access.py
"""
Who is making a request, and from where.

Local vs online is decided by the socket a request arrived on, never by
headers: the local listener (UNESS_LOCAL_PORT) reached from a loopback
address acts as the owner; everything else is online and must log in.
This fails safe — a LAN client hitting a 0.0.0.0 bind of the local port is
online, not local. See SERVER_STAGE1.md §1.

AccessMiddleware is a plain ASGI middleware (not BaseHTTPMiddleware) so it
doesn't interfere with streaming responses or client-disconnect handling.
Every /api route needs a user unless listed in OPEN_PATHS / OPEN_PREFIXES —
new routes are protected by default. Admin and local-only routes add `require_admin` /
`require_local` as dependencies.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Callable, Optional

from fastapi import HTTPException, Request
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

LOCAL_PORT = int(os.environ.get("UNESS_LOCAL_PORT", "8000"))
PUBLIC_PORT = int(os.environ.get("UNESS_PUBLIC_PORT", "8100"))
PUBLIC_HOST = os.environ.get("UNESS_PUBLIC_HOST", "").strip().lower()
OWNER_NAME = os.environ.get("UNESS_OWNER", "").strip().lower() or "owner"

# Every non-GET request must carry this header. Browsers can't add a custom
# header to a cross-site request without a CORS preflight, which fails, so
# this blocks other websites from submitting forms to the API (CSRF).
CLIENT_HEADER = "x-uness-client"

_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
_LOOPBACK_CLIENTS = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}

SESSION_COOKIE = "uness_session"

# /api paths reachable without a user. Under /api/auth/, endpoints that do
# need one (changing your password) ask for it themselves.
OPEN_PATHS = {"/api/health", "/api/me"}
OPEN_PREFIXES = ("/api/auth/",)

# Non-API paths only served on the local listener (FastAPI's API explorer)
_LOCAL_ONLY_PATHS = {"/docs", "/docs/oauth2-redirect", "/redoc", "/openapi.json"}

_SECURITY_HEADERS = (
    ("x-frame-options", "DENY"),
    ("x-content-type-options", "nosniff"),
    ("referrer-policy", "same-origin"),
)


@dataclass(frozen=True)
class User:
    id: int
    username: str
    role: str  # "admin" | "user"
    is_owner: bool = False

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


def _hostname(host_header: str) -> str:
    """'localhost:5173' → 'localhost', '[::1]:8000' → '::1'."""
    host = host_header.strip().lower()
    if host.startswith("["):
        return host[1:].split("]", 1)[0]
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def _host_allowed(hostname: str, port: int | None) -> bool:
    # Rejecting unexpected Host values stops DNS rebinding: a page on an
    # attacker's domain resolved to 127.0.0.1 would otherwise be same-origin
    # with the local listener.
    if hostname in _LOOPBACK_HOSTS:
        return True
    return port == PUBLIC_PORT and bool(PUBLIC_HOST) and hostname == PUBLIC_HOST


def _with_security_headers(send: Send) -> Send:
    async def wrapped(message: Message) -> None:
        if message["type"] == "http.response.start":
            headers = MutableHeaders(scope=message)
            for key, value in _SECURITY_HEADERS:
                headers.setdefault(key, value)
        await send(message)

    return wrapped


def _cookie(headers: Headers, name: str) -> Optional[str]:
    for part in headers.get("cookie", "").split(";"):
        key, _, value = part.strip().partition("=")
        if key == name:
            return value
    return None


class AccessMiddleware:
    """`owner()` returns the owner account; `session_user(token)` the user a
    session cookie belongs to (or None); `seen(user, path)`, if given, is told
    about each allowed request from a known user. Passed in so this module
    doesn't depend on the accounts store."""

    def __init__(
        self,
        app: ASGIApp,
        owner: Callable[[], User],
        session_user: Callable[[Optional[str]], Optional[User]],
        seen: Optional[Callable[[User, str], None]] = None,
    ) -> None:
        self.app = app
        self.owner = owner
        self.session_user = session_user
        self.seen = seen

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        send = _with_security_headers(send)
        headers = Headers(scope=scope)
        port = (scope.get("server") or (None, None))[1]
        client = (scope.get("client") or ("", 0))[0]
        is_local = port == LOCAL_PORT and client in _LOOPBACK_CLIENTS

        async def reject(status: int, message: str) -> None:
            await JSONResponse({"error": message}, status_code=status)(scope, receive, send)

        if not _host_allowed(_hostname(headers.get("host", "")), port):
            await reject(400, "Unexpected host")
            return

        state = scope.setdefault("state", {})
        state["is_local"] = is_local
        state["is_public"] = port == PUBLIC_PORT
        # Only Funnel connects to the public listener, so its X-Forwarded-For
        # can be trusted there (login throttling uses it); nowhere else
        forwarded = headers.get("x-forwarded-for", "") if port == PUBLIC_PORT else ""
        state["client_ip"] = forwarded.split(",")[0].strip() or client
        if is_local:
            state["user"] = self.owner()
        else:
            # Session lookup is a quick SQLite read; done off the event loop
            token = _cookie(headers, SESSION_COOKIE)
            state["user"] = await run_in_threadpool(self.session_user, token) if token else None

        if scope["method"] not in _SAFE_METHODS and headers.get(CLIENT_HEADER) != "1":
            await reject(403, "Missing X-Uness-Client header")
            return

        path = scope["path"]
        if path in _LOCAL_ONLY_PATHS and not is_local:
            await reject(404, "Not found")
            return
        is_open = path in OPEN_PATHS or path.startswith(OPEN_PREFIXES)
        if path.startswith("/api/") and not is_open and state["user"] is None:
            await reject(401, "Login required")
            return

        if self.seen is not None and state["user"] is not None:
            self.seen(state["user"], path)
        await self.app(scope, receive, send)


def current_user(request: Request) -> User:
    user = request.state.user
    if user is None:  # unreachable behind AccessMiddleware, kept as a guard
        raise HTTPException(status_code=401, detail="Login required")
    return user


def session_token(request: Request) -> Optional[str]:
    return _cookie(Headers(scope=request.scope), SESSION_COOKIE)


def require_admin(request: Request) -> None:
    if not current_user(request).is_admin:
        raise HTTPException(status_code=403, detail="Admins only")


def require_local(request: Request) -> None:
    if not request.state.is_local:
        raise HTTPException(status_code=403, detail="Available only on the host Mac")
