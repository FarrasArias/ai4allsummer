# backend/utilities/conduct_store.py
"""
Storage for U.ness's Conduct feature: a user-owned markdown log per project,
plus the reference/snippets content shown on the Conduct page.

Log files are meant to be found and opened by the user (in Obsidian, VS
Code, whatever), so they live in conduct_logs/ at the repo root rather
than nested inside backend/ alongside chats/ and images/ — see CONDUCT_DIR
below. Located via __file__ rather than a relative path, so it resolves
correctly regardless of the backend process's working directory. Every
path derives from this one constant, so moving it again (e.g. to
~/uness/conduct/) is a one-line change.

The log markdown (<slug>.md) is the user's copy: this module only ever
appends to it, and never rewrites or reformats what's already there. The
sidecar (<slug>.json) is the machine-readable record of the same entries,
used for phase counts — if the two ever disagree, the .md wins.
"""

from __future__ import annotations

import json
import os
import platform
import re
import subprocess
import time
from pathlib import Path
from typing import Optional

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

# Single module-level constant: switch storage location by changing this.
CONDUCT_DIR = _PROJECT_ROOT / "conduct_logs"
DEFAULTS_DIR = Path(__file__).resolve().parent.parent / "conduct_defaults"

# Log files sit directly in CONDUCT_DIR (alongside reference.md /
# snippets.md) so the folder name promises exactly what's in it.
LOGS_DIR = CONDUCT_DIR
REFERENCE_PATH = CONDUCT_DIR / "reference.md"
SNIPPETS_PATH = CONDUCT_DIR / "snippets.md"
_CONTENT_FILENAMES = {REFERENCE_PATH.name, SNIPPETS_PATH.name}

PHASES = ("frame", "explore", "refine", "commit")

_SLUG_RE = re.compile(r"[^a-z0-9]+")

COMMIT_TEMPLATE_HEADING = "## Commit — to be completed by you"

_COMMIT_TEMPLATE = (
    f"{COMMIT_TEMPLATE_HEADING}\n\n"
    "**Why this version over the alternatives I explored?**\n\n\n"
    "**Which critiques did I overrule, and why?**\n\n\n"
    "**Would I put my name on this and send it?**\n"
)


def ensure_initialized() -> None:
    """Create conduct_logs/, and seed defaults on first run.

    Never overwrites reference.md / snippets.md if they already exist —
    those are user-editable.
    """
    CONDUCT_DIR.mkdir(parents=True, exist_ok=True)

    for name, dest in (("reference.md", REFERENCE_PATH), ("snippets.md", SNIPPETS_PATH)):
        if dest.exists():
            continue
        src = DEFAULTS_DIR / name
        try:
            dest.write_text(src.read_text(encoding="utf-8"), encoding="utf-8", newline="")
        except OSError:
            pass


def slugify(text: str, max_words: int = 4) -> str:
    """Slug from the first few words of a title, for use as a filename stem."""
    words = text.strip().split()[:max_words]
    slug = _SLUG_RE.sub("-", " ".join(words).lower()).strip("-")
    return slug or "conduct-log"


_RESERVED_SLUGS = {Path(name).stem for name in _CONTENT_FILENAMES}


def _is_safe_slug(slug: str) -> bool:
    if not re.fullmatch(r"[a-z0-9-]{1,120}", slug or ""):
        return False
    # Log files live next to reference.md / snippets.md — don't let a
    # log's slug collide with those filenames.
    return slug not in _RESERVED_SLUGS


def read_content() -> dict:
    """Re-read reference.md / snippets.md from disk on every call."""
    ensure_initialized()

    def _read(path: Path) -> str:
        try:
            return path.read_text(encoding="utf-8")
        except OSError:
            return ""

    return {"reference": _read(REFERENCE_PATH), "snippets": _read(SNIPPETS_PATH)}


def _sidecar_path(slug: str) -> Path:
    return LOGS_DIR / f"{slug}.json"


def _md_path(slug: str) -> Path:
    return LOGS_DIR / f"{slug}.md"


def _load_sidecar(slug: str) -> list:
    path = _sidecar_path(slug)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def _save_sidecar(slug: str, entries: list) -> None:
    _sidecar_path(slug).write_text(
        json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _blockquote(text: str) -> str:
    lines = text.splitlines() or [""]
    return "\n".join(f"> {line}" if line else ">" for line in lines)


def _entry_markdown(phase: str, ts: float, note: str, prompt: str, response: str,
                     model: Optional[str], energy_wh: Optional[float]) -> str:
    time_str = time.strftime("%H:%M", time.localtime(ts))
    heading = f"## {phase.capitalize()} · {time_str}"
    if response.strip():
        if model:
            heading += f" · {model}"
        if energy_wh is not None:
            heading += f" · {energy_wh:.3f} Wh"

    lines = [heading, ""]
    if note.strip():
        lines.append(f"**Note:** {note.strip()}")
        lines.append("")
    if prompt.strip():
        lines.append(f"**Prompt:** {prompt.strip()}")
        lines.append("")
    if response.strip():
        lines.append("**Response:**")
        lines.append(_blockquote(response.strip()))
        lines.append("")
    lines.append("---")
    # Trailing blank line so whatever follows (the next entry, or the
    # pinned Commit template) starts with a clean paragraph break.
    return "\n".join(lines) + "\n\n"


def _header_markdown(title: str) -> str:
    date_str = time.strftime("%Y-%m-%d")
    return (
        f"# {title}\n"
        f"Conducting log · U.ness · started {date_str}\n\n"
        "Entries below are moments you chose to keep, tagged by phase —\n"
        "Frame, Explore, Refine, Commit. This file is yours: edit it freely,\n"
        "reorder it, delete what turned out not to matter.\n\n"
        "---\n\n"
    )


def _insert_before_commit_template(content: str, entry_md: str) -> str:
    """Insert entry_md immediately before the pinned Commit template — never
    touching whatever already precedes it (the header's separator, or a
    prior entry's own trailing '---'). If the template was removed by the
    user, append to the end instead — never re-derive the file."""
    idx = content.find(COMMIT_TEMPLATE_HEADING)
    if idx == -1:
        return content.rstrip("\n") + "\n\n" + entry_md
    return content[:idx] + entry_md + content[idx:]


def append_entry(slug: str, payload: dict) -> Path:
    """Append one entry to <slug>.md and <slug>.json. Creates both files
    (with header + pinned Commit template) if this is the first entry for
    the slug. Raises ValueError on invalid input."""
    if not _is_safe_slug(slug):
        raise ValueError("invalid slug")

    phase = (payload.get("phase") or "").strip().lower()
    if phase not in PHASES:
        raise ValueError("phase must be one of: " + ", ".join(PHASES))

    note = payload.get("note") or ""
    prompt = payload.get("prompt") or ""
    response = payload.get("response") or ""
    if not (note.strip() or prompt.strip() or response.strip()):
        raise ValueError("at least one of note, prompt, response is required")

    model = payload.get("model") or None
    mode = payload.get("mode") or None
    energy_wh = payload.get("energy_wh", None)
    title = (payload.get("title") or "").strip() or slug

    ensure_initialized()

    md_path = _md_path(slug)
    ts = time.time()

    if not md_path.exists():
        md_path.write_text(_header_markdown(title) + _COMMIT_TEMPLATE, encoding="utf-8", newline="")

    entry_md = _entry_markdown(phase, ts, note, prompt, response, model, energy_wh)
    current = md_path.read_text(encoding="utf-8")
    md_path.write_text(_insert_before_commit_template(current, entry_md), encoding="utf-8", newline="")

    entries = _load_sidecar(slug)
    entries.append({
        "ts": int(ts),
        "phase": phase,
        "note": note,
        "prompt": prompt,
        "response": response,
        "model": model,
        "mode": mode,
        "energy_wh": energy_wh,
    })
    _save_sidecar(slug, entries)

    return md_path


def log_path(slug: str) -> Path:
    """Absolute path to a log's markdown file. Raises ValueError if the slug
    is malformed or no such log exists — callers hand this straight to the
    knowledge layer, so it must never resolve outside CONDUCT_DIR."""
    if not _is_safe_slug(slug):
        raise ValueError("invalid slug")
    path = _md_path(slug)
    if not path.exists():
        raise ValueError("no such log")
    return path


def read_log(slug: str) -> str:
    """A log's markdown, for the read-only view on the Conduct page.

    CONDUCT_STAGE1.md deliberately had no way to read a log back: the file
    was to be read in the user's own editor. That assumed the editor was
    open alongside the app — when it isn't, a log you append to is never
    seen again. This reads for display only; the app still only ever
    appends, and never rewrites what is there.
    """
    return log_path(slug).read_text(encoding="utf-8")


def list_logs() -> list:
    """Summaries of every log, newest-updated first."""
    ensure_initialized()
    summaries = []
    for md_path in LOGS_DIR.glob("*.md"):
        if md_path.name in _CONTENT_FILENAMES:
            continue
        slug = md_path.stem
        entries = _load_sidecar(slug)
        phase_counts = {p: 0 for p in PHASES}
        for e in entries:
            p = (e.get("phase") or "").lower()
            if p in phase_counts:
                phase_counts[p] += 1

        title = slug
        try:
            first_line = md_path.read_text(encoding="utf-8").splitlines()[0]
            if first_line.startswith("# "):
                title = first_line[2:].strip() or slug
        except (OSError, IndexError):
            pass

        try:
            display_path = md_path.relative_to(_PROJECT_ROOT).as_posix()
        except ValueError:
            display_path = str(md_path)

        summaries.append({
            "slug": slug,
            "title": title,
            "path": display_path,
            "updated_at": md_path.stat().st_mtime,
            "entry_count": len(entries),
            "phase_counts": phase_counts,
        })

    summaries.sort(key=lambda s: s["updated_at"], reverse=True)
    return summaries


def _resolve_within_conduct_dir(path_str: str) -> Path:
    if not path_str:
        raise ValueError("path is required")
    candidate = Path(path_str)
    if not candidate.is_absolute():
        candidate = _PROJECT_ROOT / candidate
    try:
        resolved = candidate.resolve(strict=True)
    except OSError:
        raise ValueError("path does not exist")

    conduct_resolved = CONDUCT_DIR.resolve()
    if resolved != conduct_resolved and conduct_resolved not in resolved.parents:
        raise ValueError("path is outside the conduct log folder")
    return resolved


def open_path(path_str: str, reveal: bool = False) -> None:
    """Open a conduct file with the OS default handler, or reveal it in its
    containing folder. Only ever touches paths inside CONDUCT_DIR."""
    resolved = _resolve_within_conduct_dir(path_str)
    system = platform.system()

    if reveal:
        if system == "Windows":
            subprocess.run(["explorer", f"/select,{resolved}"])
        elif system == "Darwin":
            subprocess.run(["open", "-R", str(resolved)])
        else:
            subprocess.run(["xdg-open", str(resolved.parent)])
    else:
        if system == "Windows":
            os.startfile(str(resolved))  # type: ignore[attr-defined]
        elif system == "Darwin":
            subprocess.run(["open", str(resolved)])
        else:
            subprocess.run(["xdg-open", str(resolved)])
