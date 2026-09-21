# U.ness — Conduct (stage 1) implementation brief

Stack: React + TypeScript + Vite frontend (`energy-chat-dashboard/`), Python backend
(`backend/server.py`). Line numbers below come from a prior survey of the repo — verify them
before editing, they may have drifted.

---

## What this is

U.ness's design position is that the human conducts and the AI executes. The app already has the
separated instruments — model choice, web, code, image, documents. What it lacks is any way to
record the human's decisions, or any surface that reminds the user those decisions are theirs.

This adds one: a markdown log on disk that the user builds up from the chat, plus a Conduct page
that explains the practice and points at the file.

**This is instrumentation, not enforcement.** Nothing warns, nothing gates, nothing fires
unsolicited, nothing is scored. A user who ignores all of it must experience the app exactly as
it behaves today.

---

## Scope

1. Backend: a `conduct` module — storage, append, content files, open-in-editor
2. Frontend: merge `.md` into `Save`; add `→ Log` to the toolbar with an append popover
3. Frontend: a `Conduct` page as a fifth mode
4. A settings toggle that hides both

---

## 1. Backend

### Storage location

Follow the existing convention — everything relative to the backend working directory, alongside
`backend/chats/` and `backend/images/`:

```
backend/conduct/
  reference.md          # user-editable, content in §5
  snippets.md           # user-editable, content in §5
  logs/
    <slug>.md           # the human-readable log
    <slug>.json         # sidecar, machine-readable (see below)
```

Create `backend/conduct/` on server start. Copy bundled defaults for `reference.md` and
`snippets.md` **only if those files do not already exist** — an update must never overwrite a
user's edits. Ship the defaults in the repo (e.g. `backend/conduct_defaults/`) and copy on first
run.

> Note for review: this stays inside `backend/` for consistency with `chats/`. The alternative is
> `~/uness/conduct/`, which is more findable for a user who wants to open the log in Obsidian.
> There's currently no `Path.home()` usage anywhere in the app. Implement `backend/conduct/` but
> put the base path in a single module-level constant so it can be switched in one line.

### The sidecar JSON

The survey found no per-entry persisted store: `metrics.json` holds `{ts, text, words, chars}`
with no response text and no energy, and `session.json` holds session-level energy totals only.
Per-turn energy exists transiently as `Msg.metrics.energy_wh` in `ChatPane` and is never
persisted.

So the conduct log carries its own sidecar rather than annotating an existing file. One JSON per
log, an array of entries:

```json
[
  {
    "ts": 1756500000,
    "phase": "explore",
    "note": "going with the second framing",
    "prompt": "give me three ways to frame this brief",
    "response": "A) Budget-focused …",
    "model": "qwen3.6:27b",
    "mode": "chat",
    "energy_wh": 0.718
  }
]
```

`energy_wh`, `model` and `mode` come from the client at append time — pass whatever
`Msg.metrics.energy_wh` holds for that message, null if absent. This sidecar is the research
artifact: phase sequences, prompts per phase, energy per phase. Nothing else in the app records
any of it. It also backs the phase counts on the Conduct page, so it must stay in sync with the
`.md`.

### Endpoints

```
GET  /api/conduct/content            -> { reference: str, snippets: str }
GET  /api/conduct/logs               -> [{ slug, title, path, updated_at,
                                           entry_count, phase_counts }]
POST /api/conduct/log/<slug>/append  -> { ok, path }
POST /api/conduct/log/<slug>/index   -> { ok }        # register into knowledge layer
POST /api/conduct/open               -> { ok }        # open in editor / reveal in folder
```

There is deliberately **no endpoint that returns the log markdown**. The app never displays the
log's contents — see §3.

`append` body:

```json
{
  "phase": "explore",
  "note": "…",
  "prompt": "…",
  "response": "…",
  "model": "qwen3.6:27b",
  "mode": "chat",
  "energy_wh": 0.718,
  "title": "Postsecondary brief"
}
```

- `title` is used only when creating the file.
- All of `note`, `prompt`, `response` may be empty. **A note-only entry is valid and must be
  written** — that's how a user records a Commit with no AI turn attached. Reject only if all
  three are empty.
- Appending writes both the `.md` and the `.json`. If they ever disagree, the `.md` is the user's
  copy and wins; never rewrite the `.md` from the JSON.
- The user may have edited or reordered the `.md` between appends. Append to whatever is there —
  never reformat, never re-derive the file from the sidecar.

`open` body: `{ "path": "...", "reveal": false }`. Use `os.startfile` on Windows, `open` on
macOS, `xdg-open` on Linux; with `reveal: true` use `explorer /select,` / `open -R` / the
containing directory. Validate the path resolves inside `backend/conduct/` before executing
anything.

### Knowledge-layer registration

The programmatic entry point is `ChatEngine.add_document(path)` for chat mode
(`backend/chat_core.py:101`, called at `server.py:472`) or `WebChatSession.add_document(dst)` for
web (`server.py:641`).

**Register on an explicit button press, not on every append.** The RAG index is per mode+model
(`backend/rag_cache/<mode>_<safe_model>/`), so re-adding a growing file on every append would
re-embed repeatedly and may duplicate segments — check whether `RagStore.add_document`
(`rag_store.py:165`) dedupes by name; if it doesn't, remove the prior entry before re-adding.
Manual triggering is also more in keeping with the rule that nothing happens unsolicited.

---

## 2. Chat toolbar and append popover

### The Save / .md merge

`HeaderBar.tsx` lines 125–177. `Save` and `.md` both call `onSaveResponse` →
`App.tsx:handleSaveLastResponse()` (line 271) — identical handlers, one Blob download of the last
bot message as `text/markdown`.

Since they are literally the same action, delete the `.md` button and keep `Save`. No format
dropdown needed. Target row:

```
0 files · 0 prompts · 1 response — [model] — Save · Copy · → Log · Clear
```

`→ Log` sits between `Copy` and `Clear`, styled like its neighbours. It is not a primary action.

### The popover

Anchored to the `→ Log` button. Not a modal, not a page change. Escape and click-outside dismiss
without appending.

- **Title field** — shown only on the first append of a session. Pre-fill from the first ~4 words
  of the session's first user message, slugified for the filename. Hold the resulting slug in App
  state for the rest of the session; don't ask again.
- **Four phase buttons** — `Frame` `Explore` `Refine` `Commit`. Single-select, required. Short
  explanatory line under each (text in §5).
- **Note field** — optional textarea, 2–3 rows.
- **Append** button.

### Where the data comes from

Use the same source of truth `onSaveResponse` and `onCopyResponse` already use for "the last bot
message" — don't introduce a second path. Alongside the response text, send the preceding user
message, plus `metrics.energy_wh` and the model/mode for that message if present.

`HeaderBar` is shared across modes, so `→ Log` will appear in Web mode too. That's correct — just
make sure the handler resolves the last bot message for the *active* tab the same way the
existing Save handler does.

After a successful append: brief non-blocking confirmation (button label flicks to `Added`, same
pattern as the existing `Copied!` flash at `App.tsx:259`), then close.

### File header, written once at creation

```markdown
# Postsecondary brief
Conducting log · U.ness · started 2026-08-30

Entries below are moments you chose to keep, tagged by phase —
Frame, Explore, Refine, Commit. This file is yours: edit it freely,
reorder it, delete what turned out not to matter.

---
```

Keep it to roughly this length. The file gets fed back into the knowledge layer as a source
document, so a long preamble becomes content the model reasons about. Identify the file, say what
the tags mean, give permission to edit, stop.

### Entry format

```markdown
## Explore · 14:22 · qwen3.6:27b · 0.718 Wh

**Note:** going with the second framing — it's the only one my dean would fund

**Prompt:** give me three ways to frame this brief

**Response:**
> A) Budget-focused …
> B) Access-focused …

---

## Commit · 14:51

**Note:** rejected the critic's point about tone — the audience expects blunt

---
```

Blockquote the response so headings and lists inside it don't break the log's structure. Omit the
model/Wh segment of the heading when there's no response. Entries append chronologically — never
group or re-sort by phase; the sequence is the data.

### Commit template

Written at file creation, and kept pinned at the end as entries are inserted above it:

```markdown
---

## Commit — to be completed by you

**Why this version over the alternatives I explored?**


**Which critiques did I overrule, and why?**


**Would I put my name on this and send it?**

```

**Never fill these in.** Not from the model, not from heuristics. The blank prompts are the point.

---

## 3. The Conduct page

New fifth mode. From the survey, the touch points are:

- `Sidebar.tsx:4` — add `"conduct"` to the `ModeTab` type
- `Sidebar.tsx:181` — add an icon case to `ModeIcon`
- `Sidebar.tsx:193` — add `MODE_LABELS.conduct = "Conduct"`
- `Sidebar.tsx:322` — add `"conduct"` to the array literal
- `App.tsx` — add a `{tab === "conduct" && <ConductPane … />}` branch
- `HeaderBar.tsx` — matching `TAB_LABELS` / `TabIcon` entry

New component `components/ConductPane.tsx`. Two columns wide, stacked narrow.

### Left column, top — reference

`reference.md` rendered as markdown. Reuse whatever markdown renderer `ChatHistory` already uses.
No in-app editing.

### Left column, below — snippets

`snippets.md` parsed into copy buttons:

- Each `##` heading starts a snippet; the heading text is the button label
- The first fenced code block under it is what goes to the clipboard
- Prose between heading and code block renders as a note under the button and is **not** copied
- A heading with no code block is skipped

Render each as: label, note, a preview of the text, and a `Copy` button.

### Right column — log files

**The log's contents are never displayed in the app.** The user keeps the markdown file open in
their own editor; rendering it here would be a redundant second copy of something they're already
looking at, and a read-only view invites requests to make it editable, which creates a
two-writers-to-one-file problem. The panel's job is discoverability, confirmation, and access —
not reading.

One card per log file:

```
uness-brief.md
backend/conduct/logs/uness-brief.md
12 entries · updated 14:51 · Frame 1 · Explore 6 · Refine 4 · Commit 1

[Open in editor]  [Reveal in folder]  [Add to knowledge layer]
```

Phase counts come from the sidecar JSON. **Counts only** — no percentages, no grade, no
completeness indicator, no nudge about unused phases.

Several logs = a list of these cards, newest first. No dropdown, no selection state, no project
manager.

### Empty states

- No logs yet: show the directory path where they'll be created and a line saying `→ Log` in a
  chat starts one. Must not look broken.
- Missing `reference.md` / `snippets.md`: name the expected path rather than showing an error or
  a blank panel.

---

## 4. Content files, editable at runtime

`GET /api/conduct/content` re-reads both files from disk on every call, so editing them in a text
editor and revisiting the page shows the change immediately. No restart, no rebuild. This is
intentional — the reference and snippet text will be iterated on constantly.

---

## 5. Default content

### `reference.md`

```markdown
# Conducting

Real work is never one-shot. The dominant pattern — you prompt, AI produces — hands the whole
process to the machine: no reflection, no iteration, no real ownership of the result.

Conducting is the opposite. You break a goal into steps and direct each one. You chain models
and tools, and every hand-off is your decision. You fork down a promising path, run a critique
loop, discard what fails verification, and synthesize a result that is genuinely yours.

**You direct. AI executes. You verify.**

## The four phases

**Frame** — State the goal, the audience, the constraints. Hand over the real documents, not
descriptions of them. Never ask for the first draft here.

**Explore** — Ask for options, not answers. Three framings, not one. Stress-test them against
each other. Verify a claim against its source before you build on it.

**Refine** — Draft, then attack the draft. A critic in a fresh chat with no files finds problems
the working chat will not. Accept some critiques, reject others, and write down why you rejected
them.

**Commit** — No AI in this phase. Choose, write your rationale, and answer honestly whether you
would put your name on it. If the answer is no, loop back — never polish a bad direction.

## Loop, fork, abandon

The phases are firm; the path through them is yours.

- **Loop** — Refine sends work back around. Critique, revise, critique again.
- **Fork** — Explore in a new direction mid-stream. Different sources, a sharper question.
- **Abandon** — The most important one. If the options are all weak, don't polish. Re-route.

## Your log

The log is the record of the decisions that were yours. It lives as a markdown file on your
machine — open it in any editor, edit it freely, and feed it back in as a source document for
your next session.

---

The four-phase structure here is FERC (Frame, Explore, Refine, Commit), from the Hybrid
Intelligence research group. [hi-infinity.ai/ferc](https://hi-infinity.ai/ferc/)
```

### `snippets.md`

````markdown
## Three options

```
Give me three distinct options, labeled A/B/C, with the tradeoff of each.
No recommendation yet.
```

## Stress-test

```
Stress-test what you just said. Where is it weakest? What am I most likely
wrong about? Be specific, not polite.
```

## Assumptions

```
What did you assume in that answer that I didn't tell you? List them.
```

## Which source

```
For each claim above, say which source it came from. Flag anything you
inferred rather than found.
```

## Hostile critic

Paste into a **new chat with no files attached** — and switch the model if you can. The critic's
value is clean eyes.

```
Below is a draft I have no stake in. Find the weakest claims, logical gaps,
and unsupported assertions. Do not be polite and do not suggest rewrites.
```

## Directed revision

Back in your working chat, after you've judged the critiques.

```
I accept these critiques: [list them]. I reject the others. Revise to address
only the accepted ones. Do not soften my framing.
```
````

### Phase hints for the popover

- Frame — *goal, audience, constraints, real documents*
- Explore — *options not answers; verify before building*
- Refine — *draft, then attack the draft*
- Commit — *your choice, your rationale, no AI*

---

## 6. Settings

One toggle in the Settings tab: **Show Conduct tools** (default on). Persist in `localStorage`
under the existing `ai4all.*` key convention.

When off: hide the `→ Log` toolbar button and the `Conduct` sidebar item. Nothing else changes;
existing log files are untouched.

---

## Constraints

- **Nothing fires unsolicited.** No popups, no prompts to use the feature, no coaching, no nags.
- **Nothing is scored or graded.** The energy panel already has one grade. Do not add a second
  indicator of any kind, and do not add counts to the sidebar.
- **No acronyms in the UI**, and none in the log file. The interface says Conduct, Log, Frame,
  Explore, Refine, Commit. FERC appears only in `reference.md`.
- **The phase is declared, never inferred.** Do not classify entries with a model or heuristics.
- **The app assembles, it never composes.** It writes the user's own words and the model's
  responses into the log. It never generates log content, and never fills the Commit template.
- **The log file belongs to the user.** The app appends to it and never reformats, re-sorts, or
  rewrites what's already there.
- **Everything is additive.** The only existing behaviour that changes is removing the redundant
  `.md` button.

---

## Explicitly out of scope

Do not build these, even if they look like natural extensions:

- Displaying or editing log contents in the app
- Phase gates, warnings, or any check on whether the user is "doing it right"
- A second model, coach, or any commentary on the user's prompting
- Chips or quick-action buttons in the chat composer
- A one-click critic hand-off from the chat view
- A project manager or multi-project UI
- Accept/reject checkboxes on critique points
- Auto-summarization of a session into the log
- Backfilling energy or phase into `metrics.json` / `history.json`

---

## Build order

1. Backend `conduct` module: storage paths, defaults copy-on-first-run, `append`, `logs`,
   `content`
2. `Save`/`.md` merge, plus the `→ Log` button and popover writing through to the backend
3. `ConductPane` — reference and snippets
4. Log file cards, `Open in editor`, `Reveal in folder`
5. `Add to knowledge layer`
6. Settings toggle

**Stop after step 2 and show me.** That's the first independently demonstrable slice: a real
markdown file on disk, built from the chat, with phases and energy in it.
