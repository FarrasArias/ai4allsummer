# U.ness — Server mode (stage 1) implementation brief

Stack: React + TypeScript + Vite frontend (`energy-chat-dashboard/`), Python FastAPI backend
(`backend/server.py`), Ollama on `127.0.0.1:11434`. Line numbers come from a survey on
2026-10-05 — verify them before editing, they will drift as steps land.

---

## What this is

Today U.ness is a single-person app: one browser on the Mac that runs it. This turns that Mac
into a small server. Invited people anywhere open a public HTTPS link, log in, and use the app
with their own private chats. Their prompts run on this Mac's models, one at a time, with energy
measured per prompt the same way as today (plus one baseline fix, D11).

**Stage 1 goals**

- A public HTTPS URL that works from anywhere, with no router or firewall changes
- Accounts by invite only, with a small admin panel
- Each user's data private to them (chats, documents, conduct logs, energy totals)
- A fair first-come-first-served queue for model work, with "waiting in line" feedback
- Agent mode, the test runner and anything that touches the host OS **locked for online access**
- The owner's local experience (sitting at the Mac) unchanged: no login, all features

**Not in stage 1**

- Agent mode for online users (stage 2, needs a per-user sandbox)
- Email (invites and password resets are links the admin copies and sends)
- Per-user usage quotas beyond the queue rule (see D4 for the one exception)
- More than one Mac

---

## Decisions

All approved on 2026-10-05 (D1–D12 as recommended, D13 added later); the rest of the brief assumes them.

| # | Decision | Recommendation |
|---|---|---|
| D1 | How the owner uses the app at the Mac | **No login locally.** Requests on the local listener act as the owner account (admin). |
| D2 | Where the owner's existing data lives | **Stays where it is** (`backend/chats/`, `backend/images/`, `backend/rag_cache/`, `/conduct_logs/`). Only new users get `backend/userdata/<user>/`. No migration step. |
| D3 | Model management (pull / delete / create / preload) online | **Admin role, from anywhere.** Lets the owner download a model while away. Regular users only pick from installed models. |
| D4 | Web tab for online users | Web search spends the owner's `OLLAMA_WEB_API_KEY` quota. **Allowed, with a per-user daily cap** (default 30 web prompts/day, set in `.env`; the owner is exempt). |
| D5 | How the energy report file is written | **From the per-prompt meter, tagged with user and mode** — replacing the background accumulator's entries (see §5). Historical entries are kept and attributed to the owner. |
| D6 | Conduct `reference.md` / `snippets.md` | **Shared, read-only for everyone except the owner.** Logs are per-user. |
| D7 | Who sees energy analytics | **Each user sees their own; admins can switch to "all users".** |
| D8 | Queue limits | One request running at a time; **at most one request per user in progress** (running or waiting); a single request is cut off after 10 minutes. |
| D9 | Public URL provider | **Tailscale Funnel**: free, stable `https://<name>.<tailnet>.ts.net` URL, no domain needed, invitees only need a browser. |
| D10 | Deleting a user | Account and sessions removed; their data folder is **moved to `userdata/_deleted/`**, not erased. Hard deletion stays a manual step. |
| D11 | Idle baseline for per-prompt energy | Today the meter takes the GPU reading at the moment a prompt starts as "idle". With a queue, prompts start right after each other while the GPU is still busy, so that reading is high and energy is under-counted. **Use the idle baseline tracked by the background thread while nothing runs** (see §5). This changes how numbers are computed — flagging it because it's research data. |
| D12 | Agent mode at the Mac while online users are active | Agent runs make many model calls with tool work in between, and are metered as one block. **In stage 1 an agent run holds the queue for its whole run** (clean energy, online users wait and see "The host is running an agent task"). Per-call turns come with stage 2. Agent is usable only at the Mac — an admin logged in online doesn't get it either. |
| D13 | The Code tab online | Found in step 2: the Code tab (`VibeCodingPane`) runs the **agent** (`/api/agent/chat`, shell access), not the text-only `/api/vibe/code`, which no screen calls. So locking Agent online also locks the Code tab. **Decided 2026-10-05: hide the Code tab online** (step 6); at the Mac it stays the full agent. |

---

## Architecture

```
  Invited user's browser ──HTTPS──▶ Tailscale Funnel ──▶ 127.0.0.1:8100  (public listener)
                                                               │
  Owner's browser at the Mac ─────────────────────────▶ 127.0.0.1:8000  (local listener)
                                                               │
                                     one Python process: FastAPI app + built frontend
                                     ├── auth + per-user context (middleware)
                                     ├── inference queue (one at a time)
                                     └── Ollama ▶ 127.0.0.1:11434
```

**Local vs online is decided by which socket the request arrived on**, not by headers. One
process runs two uvicorn listeners on the same app object (so the queue, engines and energy state
are shared). Middleware reads the listening port from the ASGI scope (`scope["server"]`):

- Local = port `UNESS_LOCAL_PORT` (8000) **and** client address is loopback. Acts as the owner.
- Everything else = online. Requires a session cookie.

This fails safe: today `start.sh` binds `0.0.0.0:8000`, so anyone on the same Wi-Fi reaches the
local port — under this rule they are treated as online and must log in. Funnel's proxy connects
from loopback, but only to 8100, so it can never be mistaken for local.

---

## Access tiers — every endpoint

Four tiers. Enforced in the backend with FastAPI dependencies; the frontend only hides what the
backend already refuses.

- **Open** — no login
- **User** — any logged-in user (or local owner); data scoped to that user
- **Admin** — admin role (the local owner is always admin)
- **Local** — local listener only, regardless of role

| Endpoint(s) | Tier | Change needed |
|---|---|---|
| `GET /api/health` | Open | — |
| *new* `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me` | Open | §2 |
| *new* `GET/POST /api/auth/invite/{token}`, `GET/POST /api/auth/reset/{token}` | Open | §2 |
| *new* `POST /api/auth/password` (change own) | User | §2 |
| `GET /api/models`, `GET /api/modes/default-models` | User | — |
| `POST /api/chat`, `POST /api/chat/reset` | User | per-user engine, uploads, queue, energy |
| `POST /api/vibe/code`, `POST /api/vibe/reset` | User | per-user engine, uploads, queue, energy |
| `POST /api/web/chat`, `POST /api/web/reset` | User | per-user session, uploads, queue, energy, daily cap (D4) |
| `GET /api/rag/documents` | User | per-user cache path |
| `POST /api/image/analyze` | User | per-request temp file, queue, energy |
| `POST /api/image-gen/generate`, `GET .../status`, `POST .../reset` | User | per-user engine, queue, energy |
| `GET/POST /api/chats*`, `GET /api/chats-search` | User | per-user dir, name sanitising |
| `GET/POST /api/analyses*` | User | per-user dir, name sanitising |
| `GET /api/conduct/content` | User | shared content (D6) |
| `GET /api/conduct/logs`, `GET .../log/{slug}`, `POST .../append` | User | per-user conduct dir |
| `POST/DELETE /api/conduct/log/{slug}/index` | User | per-user engine; per-user "last model" fallback; `POST` queues (embedding) |
| `GET /api/about` | User | — |
| `GET /api/power/summary`, `GET /api/power/stream` | User | per-user totals; stream made async |
| `GET /api/analytics/power` | User | own rows; admin may request all (D7) |
| *new* `GET /api/queue` | User | §4 |
| `POST /api/models/pull`, `DELETE /api/models`, `POST /api/models/create`, `POST /api/models/load` | Admin | D3; `load` also goes through the queue |
| *new* `/api/admin/users*`, `/api/admin/invites*` | Admin | §2 |
| `POST /api/agent/chat`, `POST /api/agent/reset` | **Local** | locked online (stage 2) |
| `GET /api/test/prompt-files`, `POST /api/test/run`, `POST /api/test/stop` | **Local** | runs subprocesses, takes arbitrary file paths |
| `POST /api/conduct/open` | **Local** | opens an editor / Finder on the Mac's own screen |

43 existing endpoints, all accounted for above.

---

## 1. Network hardening (needed before anything is exposed)

The survey found problems that are harmless on a single-user laptop but not once the app is
reachable from the internet. Several also affect the app **today**, locally.

### 1a. Request context middleware

New `backend/utilities/access.py`:

- Determines `local` vs `online` from `scope["server"]` port + `scope["client"]` (above).
- Resolves the user: local → owner; online → session cookie lookup, else anonymous.
- Stores `request.state.user` and `request.state.is_local`.
- **Default deny:** the middleware refuses every `/api` path without a user unless it's in
  `OPEN_PATHS`, so a route added later is protected without anyone remembering to. Admin and
  Local routes add `require_admin` / `require_local` as dependencies; handlers that need the user
  take `current_user`.
- It's a plain ASGI middleware, not `BaseHTTPMiddleware`, so streaming and client-disconnect
  handling (which the §4 queue relies on) pass through untouched.
- FastAPI's `/docs` and `/openapi.json` are local-only.

### 1b. Host header check (DNS rebinding)

A malicious site can point its own domain at `127.0.0.1` and then talk to the local listener as
"same-origin". Reject requests whose `Host` isn't expected:

- Local listener: `localhost`, `127.0.0.1`, `[::1]` (any port — Vite's dev proxy keeps `localhost:5173`)
- Public listener: `UNESS_PUBLIC_HOST` from `.env` (the `*.ts.net` name), plus `localhost` /
  `127.0.0.1` so it can be tested from the Mac before Funnel is set up. That's safe: the listener
  only accepts loopback connections, and a rebinding page has no session cookie for it.

### 1c. CORS and CSRF

- `server.py:331` uses `allow_origins=["*"]` with `allow_credentials=True`. Starlette answers that
  combination by echoing back whatever origin asked, so once cookies exist, any website could make
  logged-in requests and read the answers. **Remove the CORS middleware.** Frontend and API become
  same-origin (§7). Keep an opt-in allowlist via `UNESS_CORS_ORIGINS` for unusual dev setups.
- **Existing issue, local:** any web page the owner visits can submit a plain HTML form to
  `http://localhost:8000/api/agent/chat` today, with no CORS preflight, and the agent runs shell
  commands. Fix for both listeners: every non-GET request must carry a custom header
  (`X-Uness-Client: 1`). Browsers can't add custom headers cross-site without a preflight, and the
  preflight now fails. The frontend adds it in one place (§7).
- Session cookie: `HttpOnly`, `SameSite=Lax`, `Secure` on the public listener.

### 1d. Path sanitising

User-supplied names are joined straight onto directories:

- Chat names: `server.py:1041` (save), `:1085` (load), `:1094` (delete — `shutil.rmtree` on
  `chats/..` would delete the whole backend folder), `:1103` (rename)
- Analysis names: `server.py:1183`, `:1198`
- Upload filenames: `server.py:460`, `:572`, `:641`
- Test runner: accepts absolute `prompts_file` / `output_file` (`:1331`) — becomes Local-only

One helper, `safe_child(base_dir, name)`, resolves the path and refuses anything outside
`base_dir`. Upload filenames reduce to their basename and get a short random prefix (so two
uploads of `notes.pdf` don't overwrite each other).

### 1e. Shared temp files

- `server.py:931` writes every image analysis to one `images/_tmp_image.png`. Two users at once
  would read each other's image. → per-request temp file, deleted after encoding.
- Upload scratch dirs `chats/_tmp`, `chats/_vibe`, `chats/_web` sit inside the chats folder
  (the frontend filters `_tmp` out of the history list for this reason). → move to
  `<user data>/uploads/{chat,vibe,web}/`.

### 1f. Limits and headers

- Upload size cap (default 25 MB per file, `.env`), checked while copying.
- Login throttling (§2).
- The queue's one-request-per-user rule (§4) is the main protection against flooding.
- Response headers on everything: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: same-origin` (keeps `/invite/<token>` out of referrers).

### 1g. Internal callers

`backend/automated_test_runner.py` calls the backend over HTTP (`BASE_URL`, line 37). Its POSTs
must send `X-Uness-Client: 1` or step 1 breaks the test runner.

---

## 2. Accounts and invites

### Storage

`backend/userdata/users.db` (SQLite, stdlib `sqlite3`; `*.db` is already git-ignored). Tables:

- `users` — id, username (unique, lowercase), password_hash, role (`admin`|`user`),
  status (`active`|`disabled`), created_at, last_seen_at, data_dir
- `sessions` — token_hash, user_id, created_at, expires_at, last_used_at
- `tokens` — token_hash, kind (`invite`|`reset`), user_id (reset only), role (invite only),
  note, created_by, created_at, expires_at, used_at
- `login_failures` — username, ip, ts
- `usage` — user_id, day, web_prompts (for the D4 daily cap)

All tokens are 32 random bytes (`secrets.token_urlsafe`); only their SHA-256 is stored.
Passwords: `hashlib.scrypt` with a per-user salt (stdlib, **no new dependencies**). The database
runs in WAL mode with a short-lived connection per call, since requests arrive on many threads.

Usernames: 3–32 characters of `a-z 0-9 _ -`, not starting with `_` (reserved for `_deleted`).
They double as folder names, so this rule is what keeps them safe on disk.

### The owner account

Created automatically on first start (username from `UNESS_OWNER`, default `owner`) with no
password and `data_dir` pointing at the legacy paths (D2). Locally the owner never logs in (D1).
To log in from elsewhere, the owner sets a password once under Settings → Account.

### Flows

- **Invite** — admin creates an invite (optional note like "Ana", role user/admin, expires in 7
  days) → gets a link `https://<public host>/invite/<token>` → sends it themselves → invitee picks
  a username and password → account created, logged in. Single use.
- **Login** — username + password → session cookie (30-day sliding expiry).
- **Throttling** — after 5 failures for a username within 15 minutes, that username is locked
  for 15 minutes; same per client IP (taken from `X-Forwarded-For`, trusted only on the public
  listener since only Funnel connects there). Response never reveals whether a username exists.
- **Password reset** — admin generates a reset link (24-hour expiry) → user sets a new password →
  all their sessions end.
- **Disable / enable** — disabling ends all sessions immediately; data kept.
- **Delete** — see D10.
- **Role change** — admin can promote/demote; the owner can't be demoted, disabled or deleted.
- Password rule: at least 10 characters. That's it.

### Admin endpoints

`GET /api/admin/users`, `POST /api/admin/users/{id}` (role/status), `DELETE /api/admin/users/{id}`,
`POST /api/admin/users/{id}/reset-link`, `GET/POST/DELETE /api/admin/invites`.

### As built (step 4)

- `utilities/accounts.py`; `backend/serve.py` runs both listeners (one signal handler stops both).
- `users` has an `is_owner` column instead of `data_dir` — `paths_for(user)` derives folders.
- `GET /api/me` always answers 200 (`user: null` when signed out) with `local`, `has_password`
  and `capabilities` (`agent`, `code_tab`, `test_runner`, `conduct_open`, `manage_models`,
  `manage_users`) for the frontend to hide what's locked.
- Login on the local listener is refused ("No sign-in is needed on this Mac").
- Changing your password signs you out everywhere else and re-issues your own session.
- Admin endpoints refuse to act on the caller's own account.
- The middleware gets `owner()` and `session_user()` passed in, so `access.py` doesn't depend on
  the account store. The owner is cached in memory (asked for on every local request).
- The D4 web cap is counted once the request is in line, so a 429 doesn't use it up.

---

## 3. Per-user data

### Layout

```
backend/userdata/
  users.db
  <username>/
    chats/            # was backend/chats/
    images/           # was backend/images/        (saved image analyses)
    rag_cache/        # was backend/rag_cache/     (document search index)
    conduct_logs/     # was /conduct_logs/          (logs only — D6)
    uploads/{chat,vibe,web}/
  _deleted/
```

The owner's `data_dir` maps to the legacy locations (D2), except uploads, which go to
`userdata/<owner>/uploads/` like everyone else's; the old `chats/_tmp`, `chats/_vibe`,
`chats/_web` scratch folders can then be deleted. Every path in the backend goes through one
function, `paths_for(user)`, so the owner exception lives in exactly one place.

### Engines

The four engine maps (`server.py:201-214`) are keyed by model alone, so all users would share one
conversation and one set of documents. Key them by `(user_id, model)`. The engines' `RagStore`
`persist_dir` (`chat_core.py:45`, `web_chat.py:175`, and the lookup in `server.py:713`) takes the
user's `rag_cache/` instead of the hard-coded relative path.

Engines hold conversation history in memory only — a backend restart already loses it today. An
engine idle for 24 hours is dropped (the documents survive on disk, as now). Disabling or deleting
a user drops their engines immediately.

### Conduct

`conduct_store` uses module-level paths (`conduct_store.py:34-41`). Change its functions to take
a base directory; logs read/write under the user's `conduct_logs/`. `reference.md` and
`snippets.md` keep living in `/conduct_logs/` and are read by everyone (D6). The conduct index
endpoints fall back to the **user's** last-used chat model instead of the global
`_latest_chat_model`.

### Reset endpoints

`/api/{chat,vibe,web,image-gen}/reset` currently zero the global energy counters. They reset only
the caller's engine and the caller's session counters.

### As built (step 5)

- `utilities/engine_registry.py`: one registry per engine type, keyed by `(user id, model)`,
  sweeping out engines idle for 24 h on access. Disabling or deleting a user drops theirs at once;
  deleting a model drops it for everyone.
- `OllamaChat` / `WebChatSession` take `rag_dir`; `/api/rag/documents` reads the caller's.
- Chats, analyses and Conduct logs read and write `paths_for(user)` folders, created on first use.
  `conduct_store` functions take `logs_dir` (default: the owner's `conduct_logs/`).
- The conduct append response gives `conduct_logs/<slug>.md`, not the absolute path on this Mac.
- The last-used model (conduct index fallback) is per user.
- Agent sessions stay keyed by model only — the agent is local-only, so only the owner has any.

---

## 4. Inference queue

New `backend/utilities/inference_queue.py`. One instance shared by both listeners.

### Rules (D8)

- Exactly one model job runs at a time, strictly first come, first served.
- A user may have **one** job in progress (running or waiting). A second one gets
  `429 "You already have a request in progress"`.
- A job longer than 10 minutes is stopped and its slot released (`.env`, `UNESS_MAX_JOB_SECONDS`).
- **Settling gap:** after a job ends, the next one starts 2 seconds later
  (`UNESS_QUEUE_GAP_SECONDS`). Found in step 3: `powermetrics` reports once a second, averaged
  over the second before, so a job started the instant the previous one ended was charged for
  that job's last second. Measured on this Mac (M5 Pro, qwen3:1.7b, same 99-in/231-out prompt,
  4 runs each): alone 9.6–11.9 W above idle; queued with no gap 26.3–31.1 W; queued with the 2 s
  gap 11.3–16.6 W (vs 9.2–13.7 W alone in that run). Cost: 2 s between back-to-back jobs.
- Only model work queues: chat, vibe, web, image analysis, image generation, model preload,
  document indexing on upload, and conduct log indexing (embedding is GPU work too). Login, chats,
  settings, model downloads and the power stream never wait.
- The local owner queues like everyone else — otherwise the owner's prompts would corrupt online
  users' energy readings.
- **Agent (local only):** one ticket for the whole run (D12), exempt from the 10-minute cap.
  Others see "The host is running an agent task".
- **Test runner (local only):** needs nothing special — it sends each prompt through `/api/chat`
  as the owner, so every benchmark prompt queues and is metered cleanly; online users' prompts
  slot in between. Side effect: the owner can't chat interactively while a benchmark runs (one
  request per user).

### Mechanics

- Ticket lock: a `threading.Lock` plus a `deque` of tickets, with a non-blocking
  `try_acquire(ticket)` and a blocking `acquire(ticket, timeout)`. Each waiting ticket knows its
  position.
- **Streaming endpoints** (chat, web, image analysis) are wrapped in an **async** generator. It
  polls `try_acquire` every half second with `asyncio.sleep` (so waiting holds no thread) and
  yields a position update whenever it changes. Once it has the slot, it steps the existing sync
  stream in worker threads, one `next()` at a time under a lock — a cancelled request can leave a
  thread mid-`next()`, and closing must wait for it rather than fail. Its `finally` closes the
  model stream and only then releases the ticket, so the slot is held until GPU work stops. Starlette cancels the response when the client disconnects, which raises inside the
  async generator, so a closed tab always frees its place — waiting or running.
- Status event shapes differ per pane and must match what each one already parses: chat
  `{"status": …}` (already displayed — that's how "Searching your documents…" appears), web
  `{"type": "status", "text": …}` (already displayed), image analysis `{"status": …}` (new
  handling in `ImageAnalysisPane`).
- Document indexing for uploads moves from the request handler into the generator, after the
  ticket is taken. Files are still *saved* in the handler (FastAPI may close uploads once the
  handler returns).
- **Non-streaming endpoints** (vibe, image generation, model preload, conduct indexing) block in
  the handler with the same rules and a 10-minute wait timeout (`503 "Server busy"`). No extra
  frontend work needed: `/api/vibe/code` isn't called by the frontend at all (the Code tab uses
  the agent — see D13), and Image generation already shows "Generating image…" while it waits.
- Model preload takes a turn but doesn't count toward the one-request limit — otherwise switching
  models with auto-preload on would block the user's next prompt.
- Errors the server sends (429/503, a model error, the 10-minute stop) are now shown as their
  actual text in Chat and Image analysis, instead of a generic "something went wrong".
- `GET /api/queue` → `{running: bool, waiting: n, mine: position|null}` for a small "Server busy"
  indicator in the header.

### Threads

FastAPI runs sync endpoints and sync streaming generators in a thread pool (40 threads by
default). Each open power stream holds a thread permanently (`server.py:1230`, `time.sleep` loop).
Every user has the dashboard open, so with a few dozen browser tabs the pool runs dry and the
whole server freezes.
- Make `/api/power/stream` an async generator (`asyncio.sleep`) — no thread held.
- Streaming waiters hold no thread (above); non-streaming waiters do, but at most one per user.
- Raise the thread limit to 200 at startup as headroom.

---

## 5. Energy accounting

With jobs serialised, `_EnergyMeter` (`server.py:126`) measures each prompt cleanly, as it does
today for one user. What changes is bookkeeping:

- `_latest_prompt_Wh` / `_session_total_Wh` become per-user (dict keyed by user id).
- **D5:** the background thread (`server.py:266`) currently writes report entries from its own
  accumulator, triggered by the global `_llm_running_flag`, and can't know who a prompt belonged
  to. It also races with `_EnergyMeter.finish()` (both touch `_session_total_Wh` and
  `_calculated_accumulator`). Change: `_EnergyMeter.finish()` appends the report entry
  `{date, power, model, mode, user}` under a file lock; the thread keeps only the idle-baseline
  sampling it also does. Entries without `user` are the owner's.
- **D11:** `_EnergyMeter.start()` stops using the instantaneous GPU reading as idle. It uses the
  idle baseline the background thread keeps (`_normal_consumption`, only updated while nothing
  runs), falling back to the instantaneous reading if no baseline exists yet. Verify in step 3 by
  running the same prompt alone and back-to-back behind another: the two numbers should now match.
- `today_total_Wh` and `/api/analytics/power` filter to the caller; admins can ask for all (D7).
- Found in step 3: the report file was never actually written before. The background thread
  only wrote an entry if it caught the instant between a prompt clearing the "running" flag and
  the meter zeroing the accumulator — in practice never. So "today" and the Analytics history
  were always empty. Writing from the meter (D5) fixes this.
- The code now lives in `backend/utilities/energy.py`; the old accumulator thread, the running
  flag and the global totals are gone from `server.py`. (The Analytics screen,
  `AnalyticsPane.tsx`, isn't linked from anywhere in the app — D7 is backend-only for now.)
- `_llm_running_flag` / `_latest_chat_model` / `_latest_image_meta` stay global — with one job at
  a time they correctly mean "what's running now".

---

## 6. What "locked online" means

Backend: `require_local` on agent, test runner and `conduct/open` → `403 "Available only on the
host Mac"`. Frontend (from `GET /api/me` capabilities):

- Chat input: **Agent** pill hidden
- Sidebar: **Code** tab hidden (it runs the agent — D13)
- Sidebar: **Testing** tab hidden
- Settings → models: pull / delete / create / auto-preload hidden for non-admins
- Conduct page: "Open in editor" / "Reveal" buttons hidden

The claw agent itself is untouched — stage 2 puts it in a sandbox.

---

## 7. Frontend

### Same origin

- `api.ts:1`: `API_BASE` defaults to `""` (same origin) instead of `http://localhost:8000`.
- `vite.config.ts`: dev proxy `/api → http://127.0.0.1:8000`, so `npm run dev` keeps working on
  macOS and Windows.
- One `apiFetch()` wrapper adds `X-Uness-Client: 1`, and on `401` switches the app to the login
  screen. All 38 `fetch` calls in `api.ts` plus the one in `AnalyticsPane.tsx:11` use it.
  `EventSource` (power stream) is GET, sends the cookie automatically on same origin, and needs no
  header.

### New screens

- **Auth gate** (in `main.tsx`): calls `/api/me`; shows Login, the invite page (path
  `/invite/<token>`) or the reset page (`/reset/<token>`), else the app. No router library — the
  app already switches views by state; these three read `location.pathname` once.
- **Account menu** in the sidebar footer: username, Change password, Log out. Locally it shows
  "This Mac (owner)" and Set password.
- **Settings → Users** (admins): create invite (shows link + Copy), pending invites (revoke),
  users table (role, status, last seen) with Disable/Enable, Reset link, Make admin, Delete.

### Behaviour changes

- Capability-based hiding (§6).
- Queue feedback: streaming panes show the server's status text (Chat already does; Web and Image
  analysis need the same handling); non-streaming panes show "Waiting for the server…"; a 429 shows
  "You already have a request running."
- **Browser storage on shared computers.** Chats in progress live in `localStorage`
  (`ai4all.chat.messages`, `ai4all.vibe.entries`, `ai4all.web.messages`, `ai4all.image.*`,
  `ai4all.imagegen.history`). On logout, and on login as a different user than last time, clear
  those keys. Preferences (theme, models, study settings) stay.
- Study settings (`participantId`) unchanged; per-browser as now.

### As built (step 6)

- `AuthGate` (the new root in `main.tsx`) asks `/api/me` and shows the sign-in screen, an
  invite or reset page, or the app. A 401 from any API call fires `uness:signed-out` and returns
  to sign-in (tested: disabling a signed-in user sends them there on their next action).
- **The account control is in the header, not the sidebar footer.** The sidebar is hidden below
  768 px wide, so a sidebar-only control would leave phone users unable to reach Settings or sign
  out. The header button ("This Mac" at the host, the username online) opens Settings → Account.
  Follow-up, not in this stage: on phones the other tabs still can't be reached (pre-existing —
  the sidebar is the only navigation).
- Settings → Account (sign out, change/set password) and Settings → Users (admins: invite links
  with Copy, pending invites, people with Make/Remove admin, Disable/Enable, Reset link, Delete).
  Links built at the host before `UNESS_PUBLIC_HOST` is set carry a note that they only work there.
- Hidden when the capability is off: Code tab, Agent button, Testing tab, model preload /
  download / create / delete ("Not installed" shown instead), Conduct Open / Reveal.
- Dropped: the header "Server busy" indicator. Each request already shows "Waiting in line —
  N ahead of you" where its answer will appear; `GET /api/queue` stays for later use.
- Browser storage: chat drafts, pinned chats and image state are cleared on sign-out and when a
  different user signs in on the same browser (`session.ts`).
- Vite's dev proxy keeps the browser's `Host` header (`changeOrigin: false`) so invite/reset links
  made in dev point at the dev server, not the backend port.
- An account's "last seen" is also updated at sign-in, not only hourly while a session is used.

---

## 8. Serving and running as a service

### Process

- `npm run build` → `energy-chat-dashboard/dist/`; FastAPI serves it with an SPA fallback (any
  non-`/api` path returns `index.html`, so `/invite/...` links work).
- New `backend/serve.py`: starts both listeners in one process (two `uvicorn.Server` objects under
  one asyncio loop), local on `127.0.0.1:8000`, public on `127.0.0.1:8100`. No `--reload`.
- `start.sh` / `start.bat` (dev mode) stay as they are, apart from binding to `127.0.0.1` and
  `--timeout-graceful-shutdown 3` (done in step 1). Without the timeout, `--reload` hangs forever
  on any backend edit while the app is open: uvicorn waits for the never-ending power stream to
  close before restarting. `serve.py` needs the same timeout for clean service restarts.
- **Dev mode vs the service.** Both use port 8000, and `start.sh` force-kills whatever holds 8000
  on startup — with the service installed, launchd would restart it and the two would fight.
  `start.sh` checks for the LaunchAgent first and, if it's running, exits with "The server is
  running — open http://localhost:8000, or stop it with server/uninstall_service.sh".
- Static files (the built frontend) are Open tier — the login page has to load without a session.

### Scripts (`server/`)

- `server/start_server.sh` — rebuilds the frontend if sources changed, checks Ollama, runs
  `serve.py` in the foreground. For testing.
- `server/install_service.sh` — writes `~/Library/LaunchAgents/com.uness.server.plist`
  (starts at login, restarts on crash, logs to `backend/userdata/logs/`), wrapped in
  `caffeinate -i` so the Mac doesn't sleep while serving; starts Ollama with
  `brew services start ollama` and `OLLAMA_KEEP_ALIVE=30m`. `uninstall_service.sh` reverses it.
- A LaunchAgent only runs while the owner is logged in. After a reboot (e.g. macOS update) the
  server is down until someone logs in. Acceptable for stage 1; noted in the README.

### Tailscale Funnel (owner does these once — account steps are theirs)

Free on the Personal plan; only the owner needs a Tailscale account, visitors just use the URL.
**On macOS only the open-source CLI variant (`tailscaled`) supports Funnel** — the App Store and
Standalone apps from tailscale.com don't. It also runs before login, which suits a server.

1. `brew install tailscale`, then `sudo brew services start tailscale` (runs `tailscaled` as a
   system daemon).
2. `tailscale up` and sign in via the printed link. If the GUI Tailscale app is installed, quit
   and remove it first — two variants on one Mac conflict.
3. Enable MagicDNS, HTTPS certificates and Funnel for the tailnet in the admin console.
4. `tailscale funnel --bg 8100` → prints the public `https://<name>.<tailnet>.ts.net` URL.
5. Put that host in `backend/.env` as `UNESS_PUBLIC_HOST`.

### `.env` additions (`.env.example` updated)

`UNESS_LOCAL_PORT=8000`, `UNESS_PUBLIC_PORT=8100`, `UNESS_PUBLIC_HOST=`, `UNESS_OWNER=owner`,
`UNESS_MAX_UPLOAD_MB=25`, `UNESS_MAX_JOB_SECONDS=600`, `UNESS_WEB_DAILY_LIMIT=30`,
`UNESS_CORS_ORIGINS=`.

### Backups

Everything a user creates is under `backend/userdata/` plus the owner's legacy folders. README
gets a one-paragraph "what to back up".

---

## 9. Build order

Each step is testable on its own, and the app keeps working locally after every step.

| Step | Contents | Verify |
|---|---|---|
| 0 | Commit the pending fixes (script permissions, chat model fallback) on their own | `git status` clean |
| 1 | §1 hardening: `access.py` (local-only so far), Host check, CORS removal, `X-Uness-Client` (frontend + test runner), `safe_child`, temp-file fixes, upload limit, headers; frontend `apiFetch` + same-origin + Vite proxy | Local app works end to end; test runner still runs; cross-site form POST to `/api/agent/chat` refused; `../` chat name refused |
| 2 | §4 queue + async power stream + thread limit | Two browser tabs (temporarily allow two owner jobs): second prompt shows "Waiting in line", runs after; closing a waiting tab frees its slot |
| 3 | §5 energy bookkeeping + D11 baseline | Same prompt alone vs queued right behind another gives matching Wh; report entries carry user/mode |
| 4 | §2 accounts (backend) + `serve.py` second listener | Public listener refuses everything without a cookie; invite → signup → login works with `curl` |
| 5 | §3 per-user data | Two test users: separate chats, docs, conduct logs, energy totals; owner's existing chats still there |
| 6 | §6 locks + §7 screens (login, invite, reset, account menu, Users panel, capability hiding, queue UI, storage clearing) | Full flow in two different browsers through `127.0.0.1:8100` |
| 7 | §8 build/serve, scripts, Funnel, README. First fix the 4 TypeScript errors in `App.tsx:130` and `ConductPane.tsx` (present before this work) — `npm run build` runs `tsc -b` and fails on them | From a phone on mobile data: open link, accept invite, chat, see queue while owner chats at the Mac |

Rough size: steps 1–3 about 2 days, 4–5 about 3 days, 6 about 2 days, 7 about 1 day.

---

## Risks to check during implementation

- **Funnel and streaming**: SSE responses must arrive token by token through Funnel, not buffered.
  Check in step 7 before relying on it; fall back to Cloudflare Tunnel if not.
- **Funnel is beta, with unpublished bandwidth limits.** Text chat is tiny; image uploads and
  generated images are the heaviest traffic. If limits bite, the same Cloudflare fallback applies.
- **Host header through Funnel**: confirm the `Host` Funnel forwards (public name vs
  `127.0.0.1:8100`) before finalising the §1b allowlist.
- **Memory**: per-user engines × models. Watch `ollama ps` and process memory with 3–4 users.
- **Privacy**: the owner can read every user's files on disk. Tell users that when inviting them.

---

## Stage 2 (not now)

Agent mode for online users, each in a container that only sees their own workspace folder. The
agent then takes a queue turn per model call instead of per run (D12), and energy is metered per
call segment so other users' prompts in between aren't counted against it. The agent reaches
Ollama through its own OpenAI-compatible client (`claw_agent_wrapper.py:28`), so that's the hook
point.
