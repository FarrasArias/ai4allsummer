# backend/utilities/energy.py
"""
Per-prompt energy: measurement, per-user totals, and the report file.

A prompt's energy is the Mac's power draw above idle, multiplied by how long
the prompt ran. Model jobs run one at a time (utilities/inference_queue.py),
so every reading taken during a prompt belongs to that prompt alone. See
SERVER_STAGE1.md §5.

Idle baseline (D11). A background thread samples power only while no job is
running, and only once the machine has had a few seconds to settle after the
last one; the baseline is the median of the last minute of those readings.
Previously each prompt took the reading at its own start as idle. With a
queue, prompts start right after one another while power is still elevated,
which under-counted every queued prompt.

Report file (D5). Each metered prompt appends {date, power, model, mode,
user} to reports/power_consumption_reports.json. Entries written before
user tagging existed are the owner's.
"""

from __future__ import annotations

import json
import logging
import os
import statistics
import threading
import time
from collections import deque
import csv
import io
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

from utilities.access import OWNER_NAME, User
from utilities.date_time import get_datetime
from utilities.inference_queue import QUEUE
from utilities.power_usage import get_gpu_power_usage

logger = logging.getLogger(__name__)

REPORTS_PATH = Path(__file__).resolve().parent.parent / "reports" / "power_consumption_reports.json"

_SAMPLE_SECONDS = 1.0   # powermetrics reports once a second
_SETTLE_SECONDS = 3.0   # skip readings this soon after a job, while power ramps down
_IDLE_WINDOW = 60       # idle readings kept, about a minute's worth
_METER_SAMPLE_SECONDS = 0.2

_lock = threading.Lock()
_idle_readings: deque[float] = deque(maxlen=_IDLE_WINDOW)
_sessions: dict[str, dict[str, float]] = {}   # username -> {"latest", "session"}
_today: dict = {"date": None, "by_user": {}}  # today's totals, rebuilt once a day
_sampler_started = False


# -- idle baseline ------------------------------------------------------------

def start_sampler() -> None:
    """Start the idle-baseline sampler thread (once)."""
    global _sampler_started
    with _lock:
        if _sampler_started:
            return
        _sampler_started = True
    threading.Thread(target=_sample_idle, name="energy-idle-sampler", daemon=True).start()


def _sample_idle() -> None:
    while True:
        try:
            watts, _ = get_gpu_power_usage()
            if watts is not None and QUEUE.idle_seconds() >= _SETTLE_SECONDS:
                with _lock:
                    _idle_readings.append(watts)
        except Exception:
            pass  # telemetry errors must never kill the thread
        time.sleep(_SAMPLE_SECONDS)


def idle_baseline() -> Optional[float]:
    with _lock:
        return statistics.median(_idle_readings) if _idle_readings else None


def _reading() -> Optional[float]:
    try:
        watts, _ = get_gpu_power_usage()
        return watts
    except Exception:
        return None


# -- metering one prompt --------------------------------------------------------

class EnergyMeter:
    """Measures the energy of one model job.

        meter = EnergyMeter(user, model, "chat")
        meter.start()
        for chunk in stream:      # streaming: sample as chunks arrive
            meter.sample()
            ...
        energy_wh, ms = meter.finish()
    """

    def __init__(self, user: User, model: str, mode: str) -> None:
        self.user = user
        self.model = model
        self.mode = mode
        self.idle_w = 0.0
        self.start_time = 0.0
        self.samples: list[float] = []
        self._last_sample_time = 0.0

    def start(self) -> None:
        baseline = idle_baseline()
        if baseline is None:
            # Nothing sampled yet (just started, or never idle since): fall
            # back to the reading now, as the meter always used to
            baseline = _reading()
        self.idle_w = baseline or 0.0
        self.start_time = time.time()
        self._last_sample_time = self.start_time

    def sample(self) -> None:
        now = time.time()
        if now - self._last_sample_time >= _METER_SAMPLE_SECONDS:
            watts = _reading()
            if watts:
                self.samples.append(watts)
            self._last_sample_time = now

    def finish(self) -> tuple[float, int]:
        watts = _reading()
        if watts:
            self.samples.append(watts)

        elapsed_s = time.time() - self.start_time
        inference_time_ms = int(elapsed_s * 1000)

        avg_power_w = sum(self.samples) / len(self.samples) if self.samples else self.idle_w
        energy_wh = max(0.0, (avg_power_w - self.idle_w) * elapsed_s / 3600.0)

        # No readings means metering is unavailable on this machine: report
        # 0 Wh to the user as before, but don't write it into the history
        _record(self.user.username, self.model, self.mode, energy_wh, inference_time_ms,
                write=bool(self.samples))
        return energy_wh, inference_time_ms


# -- totals and the report file ----------------------------------------------------

def _entry_user(entry: dict) -> str:
    return entry.get("user") or OWNER_NAME


def _load_report() -> list:
    try:
        with open(REPORTS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def _today_totals() -> dict[str, float]:
    # Caller holds _lock. Rebuilt from the file when the date changes (and on
    # first use), then kept up to date in memory by _record.
    today = date.today().isoformat()
    if _today["date"] != today:
        by_user: dict[str, float] = {}
        for entry in _load_report():
            if str(entry.get("date", "")).startswith(today):
                by_user[_entry_user(entry)] = by_user.get(_entry_user(entry), 0.0) + float(entry.get("power", 0))
        _today["date"], _today["by_user"] = today, by_user
    return _today["by_user"]


def _record(username: str, model: str, mode: str, energy_wh: float, ms: int, write: bool) -> None:
    with _lock:
        totals = _sessions.setdefault(username, {"latest": 0.0, "session": 0.0})
        totals["latest"] = energy_wh
        totals["session"] += energy_wh
        if not write:
            return
        today = _today_totals()
        today[username] = today.get(username, 0.0) + energy_wh
        data = _load_report()
        data.append({
            "date": get_datetime(),
            "power": energy_wh,
            "model": model,
            "mode": mode,
            "user": username,
            "ms": ms,
        })
        try:
            REPORTS_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp = REPORTS_PATH.with_suffix(".json.tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            os.replace(tmp, REPORTS_PATH)  # never leave a half-written file
        except OSError as e:
            logger.warning("Could not write energy report: %s", e)


def reset_session(user: User) -> None:
    """Zero the user's per-session counters (a new chat, or a reset)."""
    with _lock:
        _sessions[user.username] = {"latest": 0.0, "session": 0.0}


def summary(user: User) -> dict:
    with _lock:
        totals = _sessions.get(user.username, {"latest": 0.0, "session": 0.0})
        return {
            "latest_prompt_Wh": totals["latest"],
            "session_total_Wh": totals["session"],
            "today_total_Wh": _today_totals().get(user.username, 0.0),
        }


def history(user: Optional[User]) -> list[dict]:
    """Report entries for one user, or everyone's when user is None."""
    with _lock:
        entries = _load_report()
    if user is None:
        return entries
    return [e for e in entries if _entry_user(e) == user.username]


# -- the admin Energy page ---------------------------------------------------------------

def _rows(entries: list) -> list[dict]:
    rows = []
    for e in entries:
        stamp = str(e.get("date", ""))
        if len(stamp) < 10:
            continue
        rows.append({
            "date": stamp,
            "day": stamp[:10],
            "user": _entry_user(e),
            "mode": e.get("mode") or "unknown",
            "model": e.get("model") or "unknown",
            "wh": float(e.get("power", 0) or 0),
            "ms": e.get("ms"),
        })
    return rows


def _totals(rows: list[dict], key: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for r in rows:
        t = out.setdefault(r[key], {"prompts": 0, "wh": 0.0, "last": None})
        t["prompts"] += 1
        t["wh"] += r["wh"]
        t["last"] = max(t["last"] or "", r["date"])
    return out


def report(days: Optional[int], usernames: list[str]) -> dict:
    """Totals for the last `days` days (all time when None): overall, per
    person, per mode, per model and per day. `usernames` are the current
    accounts, so people with no prompts yet are listed too."""
    today = date.today()
    start = today - timedelta(days=days - 1) if days else None
    rows = [r for r in _rows(history(None)) if not start or r["day"] >= start.isoformat()]

    people = _totals(rows, "user")
    for name in usernames:
        people.setdefault(name, {"prompts": 0, "wh": 0.0, "last": None})

    first = start or (date.fromisoformat(min(r["day"] for r in rows)) if rows else today)
    per_day = _totals(rows, "day")
    day_list = []
    d = first
    while d <= today:
        t = per_day.get(d.isoformat(), {"prompts": 0, "wh": 0.0})
        day_list.append({"day": d.isoformat(), "prompts": t["prompts"], "wh": t["wh"]})
        d += timedelta(days=1)

    def listed(groups: dict[str, dict], name: str) -> list[dict]:
        items = [{name: k, "prompts": v["prompts"], "wh": v["wh"], "last": v.get("last")} for k, v in groups.items()]
        return sorted(items, key=lambda i: (-i["wh"], i[name]))

    people_list = listed(people, "user")
    for p in people_list:
        p["deleted"] = p["user"] not in usernames
    return {
        "from": first.isoformat(),
        "to": today.isoformat(),
        "totals": {
            "wh": sum(r["wh"] for r in rows),
            "prompts": len(rows),
            "people_active": sum(1 for p in people.values() if p["prompts"]),
            "people": len(usernames),
        },
        "people": people_list,
        "modes": listed(_totals(rows, "mode"), "mode"),
        "models": listed(_totals(rows, "model"), "model"),
        "days": day_list,
    }


def _cell(value) -> str:
    # A cell starting with = + - @ is run as a formula by spreadsheet apps.
    # Model names arrive from the browser, so neutralise them.
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def csv_text() -> str:
    """Every recorded prompt, oldest first, for analysis elsewhere."""
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["date", "user", "mode", "model", "energy_wh", "duration_ms"])
    for r in sorted(_rows(history(None)), key=lambda r: r["date"]):
        writer.writerow([r["date"], _cell(r["user"]), _cell(r["mode"]), _cell(r["model"]),
                         f"{r['wh']:.9f}", "" if r["ms"] is None else r["ms"]])
    return out.getvalue()
