"""
Last-good datasets: serve the previous successful pull when a fresh one fails,
and say so.

Two failure modes this replaces (both seen 2026-09-24):
  * a failed pull returned None, the router rendered NO DATA, and a daily
    dataset that was perfectly usable an hour earlier vanished;
  * a failed pull returned an empty container, the TTL cache counted it as a
    hit, and the outage stuck for the full TTL.

`recall()` reports the stale serve to `upstream_health`, so the UI alert names
which dataset is old and by how much. `remember()` clears that report.

DataFrames are also written to `backend/cache/<key>.pkl` (gitignored) so a
backend restart during an outage still has something to serve.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any, Callable

import pandas as pd

import upstream_health

#: Older than this, a last-good dataset is not served — NO DATA is more honest.
MAX_AGE_S = 36 * 3600
#: A copy younger than this is not reported as stale: TAIL's 5-min refresh and
#: two requests racing a cold cache produced stale/fresh pairs with age 0s.
STALE_REPORT_AFTER_S = 600

#: At most one disk write per key in this window.
_PERSIST_EVERY_S = 600

DIR = Path(__file__).resolve().parent / "cache"

_store: dict[str, tuple[float, Any]] = {}
_lock = threading.Lock()


def _usable(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, (pd.DataFrame, pd.Series)):
        return not value.empty
    if isinstance(value, (dict, list, tuple, set)):
        return len(value) > 0
    return True


def remember(key: str, value: Any) -> Any:
    now = time.time()
    with _lock:
        prev = _store.get(key)
        _store[key] = (now, value)
    upstream_health.clear_stale(key)
    if isinstance(value, pd.DataFrame) and (prev is None or now - prev[0] > _PERSIST_EVERY_S):
        try:
            DIR.mkdir(exist_ok=True)
            value.to_pickle(DIR / f"{key}.pkl")
        except Exception as exc:
            print(f"[last_good] could not persist {key}: {type(exc).__name__}")
    return value


def recall(key: str, label: str | None = None, source: str | None = None) -> tuple[Any, float | None]:
    """(value, age_seconds) of the last good pull, or (None, None). Reports the
    stale serve to the health board under `label`."""
    with _lock:
        hit = _store.get(key)
    if hit is None:
        f = DIR / f"{key}.pkl"
        try:
            if f.exists():
                hit = (f.stat().st_mtime, pd.read_pickle(f))
                with _lock:
                    _store.setdefault(key, hit)
        except Exception as exc:
            print(f"[last_good] could not read {f.name}: {type(exc).__name__}")
    if hit is None:
        return None, None
    age = time.time() - hit[0]
    if age > MAX_AGE_S:
        return None, None
    if age >= STALE_REPORT_AFTER_S:
        upstream_health.mark_stale(key, label or key, age, source)
    return hit[1], age


def cached_fetch(cache, key: str, fn: Callable[[], Any], *, ttl: int | None = None,
                 label: str | None = None, source: str | None = None) -> tuple[Any, float | None]:
    """Fresh value via `cache.get_or_set`, else the last good one.

    Returns (value, stale_age_seconds) — stale_age is None when fresh. `fn`
    should return None on failure; an empty result is treated as a failure too
    and evicted, so it cannot sit in the cache as a hit.
    """
    fresh = cache.get_or_set(key, fn, ttl=ttl)
    if _usable(fresh):
        return remember(key, fresh), None
    if fresh is not None:
        cache.delete(key) if hasattr(cache, "delete") else None
    value, age = recall(key, label, source)
    return value, age


def reset() -> None:
    """Tests only."""
    with _lock:
        _store.clear()
