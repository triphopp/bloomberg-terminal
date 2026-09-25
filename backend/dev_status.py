"""Is this backend running the code that is on disk?

The launcher starts uvicorn as a hidden child. Without --reload it keeps the
modules it imported at start-up for as long as it lives, so a router edited
afterwards simply is not there — and the symptom (a 404, a field silently
dropped by an old pydantic model) looks exactly like a coding mistake.

At import this snapshots the mtime of every backend source file. `status()`
compares the disk against that snapshot, so the UI can say "running old code:
these files changed since start" instead of leaving it to guesswork.

Must be imported before the routers (main.py does), so the snapshot predates
any module that could be edited.
"""
from __future__ import annotations

import os
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# Not part of the running server: editing a test or a one-off script must not
# report the backend as stale (and uvicorn --reload excludes them the same way).
_SKIP_DIRS = {"tests", "scripts", "__pycache__", ".venv", "venv", ".pytest_cache"}

# uvicorn --reload waits for writes to settle before it restarts the worker; a
# file saved a moment ago is "about to be reloaded", not stale.
RELOAD_GRACE_S = 5.0


def _scan() -> dict[str, float]:
    out: dict[str, float] = {}
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            if name.endswith(".py"):
                p = os.path.join(dirpath, name)
                try:
                    out[os.path.relpath(p, ROOT).replace(os.sep, "/")] = os.stat(p).st_mtime
                except OSError:
                    pass
    return out


_SNAPSHOT = _scan()
STARTED_AT = datetime.now(timezone.utc).isoformat(timespec="seconds")


def reload_mode() -> bool:
    """uvicorn --reload re-imports on every save, so it cannot go stale.
    The launcher says so explicitly; argv covers a hand-started server (a
    spawned reload worker inherits the parent's argv)."""
    return os.environ.get("BT_BACKEND_RELOAD") == "1" or "--reload" in sys.argv


def supervised() -> bool:
    """Started by BloombergTerminal.exe, which restarts a backend that exits."""
    return os.environ.get("BT_SUPERVISOR") == "launcher"


def status() -> dict:
    now = time.time()
    current = _scan()
    changed = []
    for path, mtime in current.items():
        old = _SNAPSHOT.get(path)
        if old is None:
            changed.append({"file": path, "change": "added", "mtime": mtime})
        elif mtime > old + 1e-6:
            changed.append({"file": path, "change": "modified", "mtime": mtime})
    for path in _SNAPSHOT.keys() - current.keys():
        changed.append({"file": path, "change": "deleted", "mtime": now})
    reload = reload_mode()
    if reload:
        changed = [c for c in changed if now - c["mtime"] > RELOAD_GRACE_S]
    changed.sort(key=lambda c: -c["mtime"])
    return {
        "pid": os.getpid(),
        "started_at": STARTED_AT,
        "reload": reload,
        "supervised": supervised(),
        "stale": bool(changed),
        "changed": [
            {"file": c["file"], "change": c["change"],
             "at": datetime.fromtimestamp(c["mtime"], timezone.utc).isoformat(timespec="seconds")}
            for c in changed[:20]
        ],
        "changed_count": len(changed),
        "restart": "reload" if reload else ("launcher" if supervised() else None),
    }


def request_restart() -> str | None:
    """Restart the way this process CAN be restarted; None if it cannot.

    reload   — touch main.py; the reloader sees the write and swaps the worker.
    launcher — exit; the launcher's watchdog starts a fresh process (5s).
    Otherwise it was started by hand and only its owner can restart it.
    """
    if reload_mode():
        os.utime(ROOT / "main.py", None)
        return "reload"
    if supervised():
        # Let the HTTP response go out first.
        threading.Timer(0.5, lambda: os._exit(0)).start()
        return "launcher"
    return None
