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

import threading
import time
from collections import OrderedDict
from typing import Any


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
