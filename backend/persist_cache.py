"""Keyed last-result store that survives a backend restart.

`TTLCache` lives in memory, and the backend runs with `--reload`: every saved
`.py` file empties it, so the first NEWS open after any edit paid the full
cold fan-out (26 symbols × 6 sources, 3–7 s). Entries here are also written to
`backend/cache/<name>.json` (gitignored, machine-local) and read back at
import, so a restart serves the previous pull at once while the refresh runs.

An entry is a JSON-able dict the caller owns; the store only reads its `ts`
(epoch seconds of the pull the data came from) to drop what is too old.
Entries are replaced, never mutated in place.
"""
from __future__ import annotations

import atexit
import json
import os
import threading
import time
from pathlib import Path

DIR = Path(__file__).resolve().parent / "cache"
_VERSION = 1


class PersistentStore:
    def __init__(self, name: str | None, *, max_age: float, maxsize: int = 5000,
                 flush_after: float = 5.0, directory: Path | None = None):
        """`name=None` keeps the store in memory only (tests)."""
        self._path = (directory or DIR) / f"{name}.json" if name else None
        self._max_age = max_age
        self._maxsize = maxsize
        self._flush_after = flush_after
        self._data: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._timer: threading.Timer | None = None
        self._dirty = False
        if self._path is not None:
            self._load()
            atexit.register(self.flush)

    # ── read / write ─────────────────────────────────────────────────────────
    def get(self, key: str) -> dict | None:
        with self._lock:
            entry = self._data.get(key)
            if entry is None:
                return None
            if time.time() - entry.get("ts", 0) > self._max_age:
                del self._data[key]
                return None
            return entry

    def put(self, key: str, entry: dict) -> None:
        with self._lock:
            self._data[key] = entry
            if len(self._data) > self._maxsize:
                self._prune()
            self._schedule_flush()

    def clear(self) -> None:
        with self._lock:
            self._data.clear()
            self._schedule_flush()

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)

    # ── disk ─────────────────────────────────────────────────────────────────
    def _prune(self) -> None:
        """Lock held. Drop the expired, then the oldest beyond `maxsize`."""
        cutoff = time.time() - self._max_age
        live = {k: v for k, v in self._data.items() if v.get("ts", 0) >= cutoff}
        if len(live) > self._maxsize:
            keep = sorted(live, key=lambda k: live[k].get("ts", 0), reverse=True)[: self._maxsize]
            live = {k: live[k] for k in keep}
        self._data = live

    def _schedule_flush(self) -> None:
        """Lock held. One pending write at a time — a 150-job fan-out is one file write."""
        self._dirty = True
        if self._path is None or self._timer is not None:
            return
        self._timer = threading.Timer(self._flush_after, self.flush)
        self._timer.daemon = True
        self._timer.start()

    def _load(self) -> None:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            entries = raw.get("entries") if raw.get("version") == _VERSION else None
        except FileNotFoundError:
            return
        except Exception as exc:  # noqa: BLE001 - a bad cache file is just a cold start
            print(f"[persist_cache] {self._path.name} unreadable: {type(exc).__name__}")
            return
        if not isinstance(entries, dict):
            return
        cutoff = time.time() - self._max_age
        self._data = {
            k: v for k, v in entries.items()
            if isinstance(v, dict) and v.get("ts", 0) >= cutoff
        }

    def flush(self) -> None:
        if self._path is None:
            return
        with self._lock:
            self._timer = None
            # Nothing changed here: leave the file alone — another process (the
            # running backend, while a test or a script imported this) may have
            # written a newer one.
            if not self._dirty:
                return
            self._dirty = False
            self._prune()
            snapshot = dict(self._data)
        try:
            self._path.parent.mkdir(exist_ok=True)
            tmp = self._path.with_suffix(f".{os.getpid()}.tmp")
            tmp.write_text(
                json.dumps({"version": _VERSION, "entries": snapshot}, ensure_ascii=False),
                encoding="utf-8",
            )
            os.replace(tmp, self._path)
        except Exception as exc:  # noqa: BLE001 - persistence is a bonus, never a failure
            print(f"[persist_cache] could not write {self._path.name}: {type(exc).__name__}")
