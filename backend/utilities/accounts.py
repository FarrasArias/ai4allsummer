# backend/utilities/accounts.py
"""
Accounts, sessions, invites and password resets (SERVER_STAGE1.md §2).

Stored in backend/userdata/users.db (SQLite, standard library only). Every
token — session cookie, invite link, reset link — is 32 random bytes; only
its SHA-256 is stored, so a copy of the database can't be used to log in.
Passwords are hashed with scrypt.

The owner account is created on first start with no password: at the Mac the
owner never logs in, and to log in from elsewhere they set one first.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import secrets
import shutil
import sqlite3
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator, Optional

from utilities.access import OWNER_NAME, User
from utilities.user_paths import USERDATA_DIR, paths_for

DB_PATH = USERDATA_DIR / "users.db"

SESSION_DAYS = 30
INVITE_DAYS = 7
RESET_HOURS = 24
MIN_PASSWORD = 10
MAX_FAILURES = 5
LOCKOUT_SECONDS = 15 * 60
WEB_DAILY_LIMIT = int(os.environ.get("UNESS_WEB_DAILY_LIMIT", "30"))

# Usernames double as folder names, so this rule is what keeps them safe on disk
_USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,31}$")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    is_owner      INTEGER NOT NULL DEFAULT 0,
    created_at    REAL NOT NULL,
    last_seen_at  REAL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash   TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   REAL NOT NULL,
    expires_at   REAL NOT NULL,
    last_used_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
    id         INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    kind       TEXT NOT NULL CHECK (kind IN ('invite', 'reset')),
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT,
    note       TEXT,
    created_by INTEGER,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL,
    used_at    REAL
);
CREATE TABLE IF NOT EXISTS login_failures (
    username TEXT NOT NULL,
    ip       TEXT,
    ts       REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day         TEXT NOT NULL,
    web_prompts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);
"""


class AccountError(ValueError):
    """A problem to show the user as-is (bad password, taken username...)."""


# -- storage --------------------------------------------------------------------

_init_lock = threading.Lock()
_initialized = False


@contextmanager
def _db() -> Iterator[sqlite3.Connection]:
    # A short-lived connection per call: requests arrive on many threads
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        with conn:  # commits, or rolls back on error
            yield conn
    finally:
        conn.close()


def init() -> None:
    """Create the database and the owner account if needed. Idempotent."""
    global _initialized
    with _init_lock:
        if _initialized:
            return
        USERDATA_DIR.mkdir(parents=True, exist_ok=True)
        with _db() as db:
            db.execute("PRAGMA journal_mode = WAL")
            db.executescript(_SCHEMA)
            if db.execute("SELECT 1 FROM users WHERE is_owner = 1").fetchone() is None:
                db.execute(
                    "INSERT INTO users (username, role, is_owner, created_at) VALUES (?, 'admin', 1, ?)",
                    (OWNER_NAME, time.time()),
                )
        _initialized = True


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _user(row: sqlite3.Row) -> User:
    return User(id=row["id"], username=row["username"], role=row["role"], is_owner=bool(row["is_owner"]))


# -- passwords ------------------------------------------------------------------

_SCRYPT = {"n": 2**14, "r": 8, "p": 1}


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, dklen=32, **_SCRYPT)
    b64 = lambda b: base64.b64encode(b).decode("ascii")
    return f"scrypt${_SCRYPT['n']}${_SCRYPT['r']}${_SCRYPT['p']}${b64(salt)}${b64(digest)}"


def _verify_password(password: str, stored: Optional[str]) -> bool:
    if not stored:
        # Still do the work, so a missing account takes as long as a wrong password
        hash_password(password)
        return False
    _, n, r, p, salt, digest = stored.split("$")
    expected = base64.b64decode(digest)
    actual = hashlib.scrypt(
        password.encode("utf-8"), salt=base64.b64decode(salt), dklen=len(expected),
        n=int(n), r=int(r), p=int(p),
    )
    return hmac.compare_digest(actual, expected)


def _check_new_password(password: str) -> None:
    if len(password or "") < MIN_PASSWORD:
        raise AccountError(f"Passwords need at least {MIN_PASSWORD} characters.")


def _check_username(username: str) -> str:
    username = (username or "").strip().lower()
    if not _USERNAME_RE.match(username):
        raise AccountError(
            "Usernames are 3–32 characters: lowercase letters, numbers, '-' and '_', "
            "starting with a letter or number."
        )
    return username


# -- users ------------------------------------------------------------------------

_owner: Optional[User] = None


def owner() -> User:
    # Asked for on every local request; the owner row never changes identity,
    # so it's read once
    global _owner
    if _owner is None:
        init()
        with _db() as db:
            _owner = _user(db.execute("SELECT * FROM users WHERE is_owner = 1").fetchone())
    return _owner


def owner_has_password() -> bool:
    init()
    with _db() as db:
        return db.execute("SELECT password_hash FROM users WHERE is_owner = 1").fetchone()[0] is not None


def list_users() -> list[dict]:
    init()
    with _db() as db:
        rows = db.execute("SELECT * FROM users ORDER BY is_owner DESC, created_at").fetchall()
    return [
        {
            "id": r["id"], "username": r["username"], "role": r["role"], "status": r["status"],
            "is_owner": bool(r["is_owner"]), "created_at": r["created_at"],
            "last_seen_at": r["last_seen_at"], "has_password": r["password_hash"] is not None,
        }
        for r in rows
    ]


def _target(db: sqlite3.Connection, user_id: int) -> sqlite3.Row:
    row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        raise AccountError("No such user.")
    if row["is_owner"]:
        raise AccountError("The owner account can't be changed here.")
    return row


def set_role(user_id: int, role: str) -> None:
    if role not in ("admin", "user"):
        raise AccountError("Role must be 'admin' or 'user'.")
    init()
    with _db() as db:
        _target(db, user_id)
        db.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))


def set_status(user_id: int, status: str) -> None:
    if status not in ("active", "disabled"):
        raise AccountError("Status must be 'active' or 'disabled'.")
    init()
    with _db() as db:
        _target(db, user_id)
        db.execute("UPDATE users SET status = ? WHERE id = ?", (status, user_id))
        if status == "disabled":
            db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))


def delete_user(user_id: int) -> User:
    """Remove the account. Their files are moved to userdata/_deleted/, not
    erased (SERVER_STAGE1.md D10)."""
    init()
    with _db() as db:
        user = _user(_target(db, user_id))
        db.execute("DELETE FROM users WHERE id = ?", (user_id,))
    root = paths_for(user).root
    if root.exists():
        dest = USERDATA_DIR / "_deleted" / f"{user.username}-{time.strftime('%Y%m%d-%H%M%S')}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(root), str(dest))
    return user


# -- sessions ------------------------------------------------------------------------

def login(username: str, password: str, ip: Optional[str]) -> tuple[User, str]:
    """Returns (user, session token). Raises AccountError with a message that
    never reveals whether the username exists."""
    init()
    username = (username or "").strip().lower()
    now = time.time()
    with _db() as db:
        since = now - LOCKOUT_SECONDS
        by_name = db.execute(
            "SELECT COUNT(*) FROM login_failures WHERE username = ? AND ts > ?", (username, since)
        ).fetchone()[0]
        by_ip = db.execute(
            "SELECT COUNT(*) FROM login_failures WHERE ip = ? AND ts > ?", (ip, since)
        ).fetchone()[0] if ip else 0
        if by_name >= MAX_FAILURES or by_ip >= MAX_FAILURES * 2:
            raise AccountError("Too many attempts. Try again in 15 minutes.")
        row = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()

    ok = _verify_password(password or "", row["password_hash"] if row else None)
    if not ok or row["status"] != "active":
        with _db() as db:
            db.execute("INSERT INTO login_failures (username, ip, ts) VALUES (?, ?, ?)", (username, ip, now))
            db.execute("DELETE FROM login_failures WHERE ts < ?", (now - 24 * 3600,))
        raise AccountError("Wrong username or password.")

    with _db() as db:
        db.execute("DELETE FROM login_failures WHERE username = ?", (username,))
    return _user(row), _new_session(row["id"])


def _new_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    with _db() as db:
        db.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?)",
            (_hash_token(token), user_id, now, now + SESSION_DAYS * 86400, now),
        )
        db.execute("UPDATE users SET last_seen_at = ? WHERE id = ?", (now, user_id))
        db.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
    return token


def user_for_session(token: Optional[str]) -> Optional[User]:
    if not token:
        return None
    init()
    now = time.time()
    with _db() as db:
        row = db.execute(
            "SELECT s.token_hash, s.last_used_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'",
            (_hash_token(token), now),
        ).fetchone()
        if row is None:
            return None
        # Sliding expiry, written at most hourly rather than on every request
        if now - row["last_used_at"] > 3600:
            db.execute(
                "UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?",
                (now, now + SESSION_DAYS * 86400, row["token_hash"]),
            )
            db.execute("UPDATE users SET last_seen_at = ? WHERE id = ?", (now, row["id"]))
    return _user(row)


def logout(token: Optional[str]) -> None:
    if token:
        init()
        with _db() as db:
            db.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash_token(token),))


def change_password(user: User, new_password: str, current_password: Optional[str]) -> str:
    """current_password is required unless None is passed deliberately (the
    owner setting theirs at the Mac). Signs the user out everywhere else and
    returns a fresh session token for the browser that made the change."""
    _check_new_password(new_password)
    init()
    with _db() as db:
        row = db.execute("SELECT * FROM users WHERE id = ?", (user.id,)).fetchone()
    if current_password is not None and not _verify_password(current_password, row["password_hash"]):
        raise AccountError("Your current password is wrong.")
    with _db() as db:
        db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(new_password), user.id))
        db.execute("DELETE FROM sessions WHERE user_id = ?", (user.id,))
    return _new_session(user.id)


# -- invite and reset links --------------------------------------------------------------

def create_invite(created_by: User, role: str = "user", note: str = "") -> str:
    if role not in ("admin", "user"):
        raise AccountError("Role must be 'admin' or 'user'.")
    return _new_token("invite", None, role, note.strip()[:100], created_by.id, INVITE_DAYS * 86400)


def create_reset(user_id: int, created_by: User) -> str:
    init()
    with _db() as db:
        _target(db, user_id)
        # Only the newest reset link works
        db.execute("DELETE FROM tokens WHERE kind = 'reset' AND user_id = ? AND used_at IS NULL", (user_id,))
    return _new_token("reset", user_id, None, "", created_by.id, RESET_HOURS * 3600)


def _new_token(kind, user_id, role, note, created_by, lifetime) -> str:
    init()
    token = secrets.token_urlsafe(32)
    now = time.time()
    with _db() as db:
        db.execute(
            "INSERT INTO tokens (token_hash, kind, user_id, role, note, created_by, created_at, expires_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (_hash_token(token), kind, user_id, role, note, created_by, now, now + lifetime),
        )
    return token


def _live_token(db: sqlite3.Connection, token: str, kind: str) -> Optional[sqlite3.Row]:
    return db.execute(
        "SELECT * FROM tokens WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?",
        (_hash_token(token or ""), kind, time.time()),
    ).fetchone()


def describe_token(token: str, kind: str) -> Optional[dict]:
    """What an invite/reset page shows before the form is submitted."""
    init()
    with _db() as db:
        row = _live_token(db, token, kind)
        if row is None:
            return None
        if kind == "invite":
            return {"role": row["role"], "note": row["note"]}
        user = db.execute("SELECT username FROM users WHERE id = ?", (row["user_id"],)).fetchone()
        return {"username": user["username"]} if user else None


def accept_invite(token: str, username: str, password: str) -> tuple[User, str]:
    username = _check_username(username)
    _check_new_password(password)
    init()
    with _db() as db:
        row = _live_token(db, token, "invite")
        if row is None:
            raise AccountError("This invite link has expired or was already used.")
        if db.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            raise AccountError("That username is taken.")
        cur = db.execute(
            "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
            (username, hash_password(password), row["role"], time.time()),
        )
        db.execute("UPDATE tokens SET used_at = ? WHERE id = ?", (time.time(), row["id"]))
        user_id = cur.lastrowid
    with _db() as db:
        user = _user(db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())
    return user, _new_session(user.id)


def accept_reset(token: str, password: str) -> tuple[User, str]:
    _check_new_password(password)
    init()
    with _db() as db:
        row = _live_token(db, token, "reset")
        if row is None:
            raise AccountError("This reset link has expired or was already used.")
        db.execute("UPDATE tokens SET used_at = ? WHERE id = ?", (time.time(), row["id"]))
        db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(password), row["user_id"]))
        db.execute("DELETE FROM sessions WHERE user_id = ?", (row["user_id"],))
        user = _user(db.execute("SELECT * FROM users WHERE id = ?", (row["user_id"],)).fetchone())
    return user, _new_session(user.id)


def list_invites() -> list[dict]:
    init()
    with _db() as db:
        rows = db.execute(
            "SELECT id, role, note, created_at, expires_at FROM tokens "
            "WHERE kind = 'invite' AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC",
            (time.time(),),
        ).fetchall()
    return [dict(r) for r in rows]


def revoke_invite(invite_id: int) -> None:
    init()
    with _db() as db:
        db.execute("DELETE FROM tokens WHERE id = ? AND kind = 'invite'", (invite_id,))


# -- daily web cap (D4) ----------------------------------------------------------------------

def count_web_prompt(user: User) -> None:
    """Count one web prompt against the user's daily cap. The owner, whose
    API key it is, has no cap. Raises AccountError when the cap is reached."""
    if user.is_owner:
        return
    init()
    day = time.strftime("%Y-%m-%d")
    with _db() as db:
        row = db.execute("SELECT web_prompts FROM usage WHERE user_id = ? AND day = ?", (user.id, day)).fetchone()
        used = row["web_prompts"] if row else 0
        if used >= WEB_DAILY_LIMIT:
            raise AccountError(f"You've used today's {WEB_DAILY_LIMIT} web searches. They reset at midnight.")
        db.execute(
            "INSERT INTO usage (user_id, day, web_prompts) VALUES (?, ?, 1) "
            "ON CONFLICT (user_id, day) DO UPDATE SET web_prompts = web_prompts + 1",
            (user.id, day),
        )
