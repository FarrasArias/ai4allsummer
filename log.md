# U.ness App v2 — Running Log


Run it by start.bat  
  
it came from https://github.com/FarrasArias/ai4allsummer

Ongoing log of changes and decisions, added to as we go (see `CHANGELOG-2026-07-15.md` for the dated snapshot changelog).

## 2026-08-28  


- Cloned from repo  - even thought it is not finished – tested it and most is working. Added a image model and that works. 

- Started this log (`log.md`) to track changes and decisions going forward.

- **Session Energy popup — made the grade line stand out.** The "Energy grade: A / Excellent" line in the sidebar's Session Energy panel was the same small, dim font as the detail rows below it, easy to miss next to the large Wh number above.

  - Bumped its font size up to match body text size and made it bold.

  - Colored it to match the existing grade meter bar's color coding (green for A, `\#66bb6a` for B, yellow for C, `\#ff9800` for D, red for E) instead of a flat dim gray.

  - Files: `energy-chat-dashboard/src/components/Sidebar.tsx` (added `data-grade=\{grade\}` to the label div), `energy-chat-dashboard/src/styles/layout.css` (`.sidebar-energy-grade-label` rules).

## 2026-08-30

- **Added the Conduct feature (steps 1–4 of the brief).** A markdown log the user builds up from the chat, so the decisions made while prompting get recorded on disk instead of only living in the conversation.

  - Backend: `backend/utilities/conduct_store.py` handles storage and append-only writes — a `.md` file for the human (never rewritten or reformatted, only appended to) plus a `.json` sidecar for phase counts. New endpoints in `backend/server.py`: `GET /api/conduct/content`, `GET /api/conduct/logs`, `POST /api/conduct/log/{slug}/append`, `POST /api/conduct/open` (open-in-editor / reveal-in-folder, with the target path validated to stay inside the log folder).

  - Log files live at `conduct_logs/` in the project root rather than nested inside `backend/`, so they're easy to find and open in an external editor — moved there partway through at the user's request. `backend/conduct_defaults/` ships the default `reference.md` / `snippets.md`; they're copied in on first run and never overwritten after that.

  - Frontend: merged the redundant `.md` toolbar button into `Save`, and added a `→ Log` button + popover (`energy-chat-dashboard/src/components/LogPopover.tsx`) to `HeaderBar.tsx` for tagging the last exchange with a phase (Frame / Explore / Refine / Commit) and a note. New fifth sidebar tab, **Conduct** (`ConductPane.tsx`), shows the reference doc, copyable prompt snippets, and one card per log file with Open in editor / Reveal in folder.

  - Not yet done: registering a log file into the model's knowledge layer, and the Settings toggle to hide the Conduct tools.

- **Added an "About Uness" page.** New sidebar item above Settings, and the "Uness" title in the sidebar header is now a link to the same page. Renders `backend/configs/about.md`, seeded once from `backend/configs_defaults/about.md` and never overwritten after that — hand edits stick. External links on the page open in a new tab.

  - Files: `backend/utilities/about_store.py`, `backend/configs_defaults/about.md`, `energy-chat-dashboard/src/components/AboutPane.tsx`, `Sidebar.tsx`, `HeaderBar.tsx`, `App.tsx`.

- **Fixed the Clear button only clearing Chat.** It now resets Chat, Code, Web, and Image Analysis together, regardless of which tab is active — each pane keeps its own transcript, so before this a click on Clear looked like it "did nothing" on Code/Web/Image.

  - File: `App.tsx` (`handleClearChat`).

- **Fixed the Image Analysis tab losing its image on tab switch.** The uploaded image is now stored as a data URL in `localStorage`, the same way the Q&A history already was, so leaving and returning to the tab keeps the current image. Choosing a new file (or pasting/dropping one) still replaces it immediately.

  - File: `ImageAnalysisPane.tsx`.

- **Added a privacy warning to the Web tab's greeting.** Explains that the Web tool is the one part of Uness that doesn't run fully locally — it calls Ollama's hosted web-search service, which Ollama states doesn't retain queries, but does see the requesting network address.

  - File: `WebChatPane.tsx` (`WEB_GREETING`).

- **Changed the Conduct icon** from the original baton glyph to a `user-check` icon, redrawn at the same 16×16 grid and 1.6px stroke used by every other sidebar icon.

  - Files: `Sidebar.tsx`, `HeaderBar.tsx`.

