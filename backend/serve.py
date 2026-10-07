# backend/serve.py
"""
Run U.ness as a server: one process, two listeners (SERVER_STAGE1.md §8).

- Local  (127.0.0.1:UNESS_LOCAL_PORT,  default 8000): the owner at this Mac,
  no login, every feature.
- Public (127.0.0.1:UNESS_PUBLIC_PORT, default 8100): what Tailscale Funnel
  forwards to. Login required; Agent, Code and the test runner are locked.

Both serve the same app object, so the queue, the engines and the energy
totals are shared. Which one a request came through is what decides local vs
online (utilities/access.py) — so neither binds anything but loopback.

    cd backend && .venv/bin/python serve.py
"""

import asyncio
import contextlib
import os
import signal
import subprocess
import sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))  # the app uses paths relative to backend/

import uvicorn

from server import app  # loads backend/.env before anything reads UNESS_* settings
from utilities.access import LOCAL_PORT, PUBLIC_PORT


class _Server(uvicorn.Server):
    # Each uvicorn.Server installs its own signal handlers, so with two of them
    # only the last one would see Ctrl+C. main() handles signals for both.
    @contextlib.contextmanager
    def capture_signals(self):
        yield


def keep_awake() -> None:
    """Stop the Mac sleeping while the server runs (the display may still
    sleep). caffeinate -w exits by itself when this process does, however it
    ends. -s only holds on mains power: on battery the Mac can still sleep.
    UNESS_KEEP_AWAKE=0 turns this off."""
    if sys.platform == "darwin" and os.environ.get("UNESS_KEEP_AWAKE", "1") != "0":
        subprocess.Popen(["/usr/bin/caffeinate", "-i", "-s", "-w", str(os.getpid())])


async def main() -> None:
    def config(port: int, lifespan: str) -> uvicorn.Config:
        return uvicorn.Config(
            app, host="127.0.0.1", port=port, lifespan=lifespan,
            # Open power streams never end on their own; don't wait on them forever
            timeout_graceful_shutdown=3,
            # No per-request log: it grows forever, and invite/reset links carry
            # their token in the path. Errors are still logged.
            access_log=False,
        )

    servers = [
        _Server(config(LOCAL_PORT, "on")),    # runs the app's startup once
        _Server(config(PUBLIC_PORT, "off")),
    ]

    def stop(*_):
        for s in servers:
            # A second Ctrl+C skips the graceful wait, as with plain uvicorn
            if s.should_exit:
                s.force_exit = True
            s.should_exit = True

    keep_awake()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop)

    print(f"U.ness: local http://127.0.0.1:{LOCAL_PORT}  ·  public listener 127.0.0.1:{PUBLIC_PORT}", flush=True)
    await asyncio.gather(*(s.serve() for s in servers))


if __name__ == "__main__":
    asyncio.run(main())
