"""
Thread-safe TTLCache with LRU eviction.

Replaces the ad-hoc dict pattern repeated ~30+ times across routers:
    cached = _cache.get(key)
    if cached and time.time() - cached["ts"] < TTL: ...

Usage:
    from cache import TTLCache
    _cache = TTLCache(ttl=300, maxsize=500)
    cached = _cache.get(key)
    if cached is not None:
        return cached
    _cache.set(key, data)
"""

import pickle
import re
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable

#: Where `get_or_refresh(persist=...)` keeps the last good value across
#: restarts — the same gitignored folder `last_good.py` writes to.
PERSIST_DIR = Path(__file__).resolve().parent / "cache"

#: A refresh that failed is not tried again by the next request for this long,
#: or every poll during an outage would start another background pull.
REFRESH_RETRY_S = 30


class TTLCache:
    """Thread-safe LRU + TTL cache.

    Args:
        ttl: Default TTL in seconds for all entries.
        maxsize: Maximum number of entries before oldest are evicted (LRU).
    """

    def __init__(self, ttl: int, maxsize: int = 500):
        if ttl <= 0:
            raise ValueError("ttl must be > 0")
        if maxsize < 1:
            raise ValueError("maxsize must be >= 1")
        self._ttl = ttl
        self._maxsize = maxsize
        self._store: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._lock = threading.Lock()
        self._inflight: dict[str, threading.Event] = {}  # per-key coalescing
        self._retry_at: dict[str, float] = {}  # get_or_refresh: failed refresh backoff

    def get(self, key: str, ttl: int | None = None) -> Any:
        """Return cached data if fresh, None otherwise.

        Args:
            key: Cache key.
            ttl: Override the default TTL for this lookup (seconds).
                 When None, uses the TTL passed to __init__.
        """
        effective_ttl = ttl if ttl is not None else self._ttl
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            if time.time() - entry["ts"] < effective_ttl:
                self._store.move_to_end(key)
                return entry["data"]
            del self._store[key]
            return None

    def peek(self, key: str, ttl: int | None = None) -> Any:
        """Like get(), but an expired entry stays — get() deletes it, which
        would throw away the stale value get_or_refresh serves during a refresh."""
        effective_ttl = ttl if ttl is not None else self._ttl
        with self._lock:
            entry = self._store.get(key)
        if entry is None or time.time() - entry["ts"] >= effective_ttl:
            return None
        return entry["data"]

    def set(self, key: str, data: Any) -> None:
        """Store data under key with the current timestamp."""
        with self._lock:
            if len(self._store) >= self._maxsize:
                self._store.popitem(last=False)
            self._store[key] = {"data": data, "ts": time.time()}

    def get_or_set(self, key: str, fn, ttl: int | None = None) -> Any:
        """Atomic get-or-compute with per-key coalescing.

        Only ONE thread calls fn() per key; all other threads for the same key
        wait on an Event and read the cached result.  Threads for different keys
        are never blocked by each other.

        Args:
            key: Cache key.
            fn:  Zero-argument callable that computes the value (may be slow).
            ttl: Override TTL for this entry (seconds).  None → default TTL.
        """
        # Fast path — no locking
        val = self.get(key, ttl=ttl)
        if val is not None:
            return val

        # Slow path — one creator, N waiters per key
        with self._lock:
            # Re-check inside lock (another thread may have just set it)
            entry = self._store.get(key)
            effective_ttl = ttl if ttl is not None else self._ttl
            if entry is not None and time.time() - entry["ts"] < effective_ttl:
                self._store.move_to_end(key)
                return entry["data"]

            if key in self._inflight:
                # Another thread is computing — register as waiter
                event: threading.Event = self._inflight[key]
                waiter = True
            else:
                event = threading.Event()
                self._inflight[key] = event
                waiter = False

        if waiter:
            event.wait(timeout=30)
            # Read whatever the creator stored (None on error)
            return self.get(key, ttl=ttl)

        # We are the creator
        try:
            data = fn()
            self.set(key, data)
            return data
        finally:
            with self._lock:
                self._inflight.pop(key, None)
            event.set()

    def get_or_refresh(
        self,
        key: str,
        fn: Callable[[], Any],
        *,
        ttl: int | None = None,
        max_stale: float | None = None,
        persist: str | None = None,
        valid: Callable[[Any], bool] | None = None,
    ) -> Any:
        """Stale-while-revalidate: a request never waits on a refresh it can skip.

        * fresh entry (younger than `ttl`)        → returned.
        * stale entry (younger than `max_stale`)  → returned at once; ONE
          background thread recomputes it (coalesced per key, failures back
          off REFRESH_RETRY_S).
        * nothing usable                          → computed in the request,
          coalesced like `get_or_set`.

        Why: a 5-min TTL that recomputes inside the request made every
        expiry a 6–170 s wait (TAIL ribbon, 2026-10-21), and a browser holds
        only six connections per host, so one such wait stalled WATCHLIST too.

        `persist` names a file in PERSIST_DIR that keeps the last good value
        across restarts — only for data whose timestamp travels with it, since
        a restart serves it (up to `max_stale` old) until the refresh lands.
        `valid(value)` False = a failed compute: it is returned only when
        there is nothing older to serve, and never stored over a good value.
        """
        effective_ttl = ttl if ttl is not None else self._ttl
        now = time.time()
        with self._lock:
            entry = self._store.get(key)
        if entry is None and persist:
            entry = self._load_persisted(key, persist, max_stale)
        if entry is not None:
            age = now - entry["ts"]
            if age < effective_ttl:
                return entry["data"]
            if max_stale is None or age < max_stale:
                self._refresh_in_background(key, fn, persist, valid)
                return entry["data"]

        def compute() -> Any:
            data = fn()
            if valid is None or valid(data):
                self._persist(persist, data)
            return data

        data = self.get_or_set(key, compute, ttl=effective_ttl)
        if valid is not None and data is not None and not valid(data):
            self.delete(key)  # a failure is not a hit: the next request retries
        return data

    def _refresh_in_background(self, key, fn, persist, valid) -> None:
        with self._lock:
            if key in self._inflight or time.time() < self._retry_at.get(key, 0):
                return
            event = threading.Event()
            self._inflight[key] = event

        def run() -> None:
            try:
                data = fn()
                if data is not None and (valid is None or valid(data)):
                    self.set(key, data)
                    self._persist(persist, data)
                    with self._lock:
                        self._retry_at.pop(key, None)
                else:
                    with self._lock:
                        self._retry_at[key] = time.time() + REFRESH_RETRY_S
            except Exception as exc:  # noqa: BLE001 — the stale value keeps serving
                print(f"[cache] background refresh of {key} failed: {type(exc).__name__}: {exc}")
                with self._lock:
                    self._retry_at[key] = time.time() + REFRESH_RETRY_S
            finally:
                with self._lock:
                    self._inflight.pop(key, None)
                event.set()

        threading.Thread(target=run, name=f"cache-refresh:{key}"[:60], daemon=True).start()

    @classmethod
    def drop_persisted(cls, name: str) -> None:
        """Forget a persisted copy — a "clear cache" must not be answered from disk."""
        try:
            cls._persist_path(name).unlink(missing_ok=True)
        except OSError:
            pass

    @staticmethod
    def _persist_path(name: str) -> Path:
        return PERSIST_DIR / f"swr_{re.sub(r'[^A-Za-z0-9_.-]', '_', name)[:120]}.pkl"

    def _persist(self, name: str | None, data: Any) -> None:
        if not name or data is None:
            return
        path = self._persist_path(name)
        try:
            PERSIST_DIR.mkdir(exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(pickle.dumps(data, protocol=pickle.HIGHEST_PROTOCOL))
            tmp.replace(path)
        except Exception as exc:  # noqa: BLE001 — persistence is best effort
            print(f"[cache] could not persist {name}: {type(exc).__name__}")

    def _load_persisted(self, key: str, name: str, max_stale: float | None):
        """Seed the in-memory entry from disk, dated by the file's mtime."""
        path = self._persist_path(name)
        try:
            if not path.exists():
                return None
            ts = path.stat().st_mtime
            if max_stale is not None and time.time() - ts >= max_stale:
                return None
            data = pickle.loads(path.read_bytes())
        except Exception as exc:  # noqa: BLE001 — a bad file is just a cold cache
            print(f"[cache] could not read {path.name}: {type(exc).__name__}")
            return None
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                entry = {"data": data, "ts": ts}
                self._store[key] = entry
                while len(self._store) > self._maxsize:
                    self._store.popitem(last=False)
        return entry

    def delete(self, key: str) -> None:
        """Remove a specific key from the cache."""
        with self._lock:
            self._store.pop(key, None)

    def delete_prefix(self, prefix: str) -> int:
        """Remove every key starting with `prefix`. Returns how many went.

        For invalidating a whole family of entries at once when the underlying
        data changes — a cache key that encodes its query parameters (symbol,
        period, mode…) fans out into many keys per subject, and forgetting to
        drop them all means a write is invisible until the TTL expires.
        """
        with self._lock:
            doomed = [k for k in self._store if k.startswith(prefix)]
            for k in doomed:
                del self._store[k]
            return len(doomed)

    def clear(self) -> None:
        """Remove all entries."""
        with self._lock:
            self._store.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._store)
