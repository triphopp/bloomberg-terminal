"""Process-local market I/O coordinator. No threads start until the first request.

I/O loaders must not wait on their own provider pool. Separate quote-build/pm-build
assembly pools join Yahoo/Gamma leaf work; neither leaf pool calls back into them.
A timed-out HTTP consumer leaves the shared future alive: its worker remains
counted until the vendor finishes, and the next reader joins the same work.
"""
from __future__ import annotations

import math
import threading
import time
from collections import Counter, OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError, wait
from email.utils import parsedate_to_datetime
from typing import Callable, Any

from fastapi import HTTPException
from sources.errors import is_rate_limit


def retry_seconds(value: str | None, default: int = 60) -> int:
    try:
        return max(1, math.ceil(float(value)))
    except (TypeError, ValueError):
        try:
            return max(1, math.ceil(parsedate_to_datetime(value).timestamp() - time.time()))
        except (TypeError, ValueError, OverflowError):
            return default


def as_http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, HTTPException):
        return exc
    if is_rate_limit(exc):
        return HTTPException(429, "Market data provider is rate limiting requests", headers={"Retry-After": "60"})
    return HTTPException(502, "Market data provider unavailable", headers={"Retry-After": "5"})


def error_item(exc: Exception) -> dict:
    err = as_http_error(exc)
    return {"status": "error", "error": str(err.detail), "httpStatus": err.status_code,
            "retryAfter": retry_seconds((err.headers or {}).get("Retry-After"), 5)}


class MarketRequests:
    def __init__(self, *, workers: int = 6, max_pending: int = 256, max_cache: int = 8192):
        self.workers = workers
        self.max_pending = max_pending
        self.max_cache = max_cache
        self._lock = threading.RLock()
        self._pools: dict[str, ThreadPoolExecutor] = {}
        self._cache: OrderedDict[tuple, tuple[float, Any]] = OrderedDict()
        self._failures: OrderedDict[tuple, tuple[float, HTTPException]] = OrderedDict()
        self._inflight: dict[tuple, Future] = {}
        self._cooldown: dict[str, float] = {}
        self._stats = Counter()

    @staticmethod
    def _ready(value=None, error=None):
        future = Future()
        if error is not None:
            future.set_exception(error)
        else:
            future.set_result(value)
        return future

    def submit(self, provider: str, key: tuple, loader: Callable, *, ttl: float) -> Future:
        identity = (provider, *key)
        with self._lock:
            now = time.monotonic()
            cached = self._cache.get(identity)
            if cached is not None and now - cached[0] < ttl:
                self._cache.move_to_end(identity)
                self._stats['cache_hits'] += 1
                return self._ready(cached[1])
            if identity in self._inflight:
                self._stats['joined'] += 1
                return self._inflight[identity]
            failure = self._failures.get(identity)
            if failure and now < failure[0]:
                return self._ready(error=failure[1])
            remaining = self._cooldown.get(provider, 0) - now
            if remaining > 0:
                return self._ready(error=HTTPException(429, "Provider cooling down", headers={"Retry-After": str(math.ceil(remaining))}))
            if len(self._inflight) >= self.max_pending:
                self._stats['queue_full'] += 1
                return self._ready(error=HTTPException(503, "Market data queue busy", headers={"Retry-After": "2"}))
            if provider not in self._pools:
                self._pools[provider] = ThreadPoolExecutor(
                    max_workers={'gamma': 2, 'pm-build': 3, 'quote-build': 4}.get(provider, self.workers),
                    thread_name_prefix=f'market-{provider}',
                )
            future = self._pools[provider].submit(self._run, provider, loader)
            self._inflight[identity] = future
            future.add_done_callback(lambda f: self._complete(identity, provider, f))
            self._stats['submitted'] += 1
            return future

    def _run(self, provider, loader):
        with self._lock:
            remaining = self._cooldown.get(provider, 0) - time.monotonic()
            if remaining > 0:
                raise HTTPException(429, "Provider cooling down", headers={"Retry-After": str(math.ceil(remaining))})
            self._stats['provider_attempts'] += 1
        try:
            return loader()
        except Exception as exc:
            err = as_http_error(exc)
            if err.status_code == 429:
                with self._lock:
                    self._cooldown[provider] = max(self._cooldown.get(provider, 0),
                        time.monotonic() + retry_seconds((err.headers or {}).get('Retry-After')))
            raise err from exc

    def _complete(self, identity, provider, future):
        with self._lock:
            self._inflight.pop(identity, None)
            try:
                result = future.result()
            except Exception as exc:
                err = as_http_error(exc)
                seconds = retry_seconds((err.headers or {}).get('Retry-After'), 5)
                self._failures[identity] = (time.monotonic() + seconds, err)
                while len(self._failures) > self.max_cache:
                    self._failures.popitem(last=False)
                self._stats['failed'] += 1
            else:
                self._failures.pop(identity, None)
                self._cache[identity] = (time.monotonic(), result)
                self._cache.move_to_end(identity)
                while len(self._cache) > self.max_cache:
                    self._cache.popitem(last=False)
                self._stats['completed'] += 1

    def get(self, provider: str, key: tuple, loader: Callable, *, ttl: float, timeout: float = 22):
        future = self.submit(provider, key, loader, ttl=ttl)
        try:
            return future.result(timeout=timeout)
        except TimeoutError as exc:
            raise HTTPException(504, "Market data still loading", headers={"Retry-After": "2"}) from exc

    def stats(self):
        with self._lock:
            return {**self._stats, 'inflight': len(self._inflight), 'cached': len(self._cache)}

    def close(self):
        for pool in self._pools.values():
            pool.shutdown(wait=True, cancel_futures=True)


market_requests = MarketRequests()


def collect(futures: dict[str, Future], *, timeout: float = 18) -> tuple[dict, dict]:
    """Account for EVERY requested symbol without waiting for the slowest forever."""
    if futures:
        wait(futures.values(), timeout=timeout)
    values, statuses = {}, {}
    for symbol, future in futures.items():
        if not future.done():
            statuses[symbol] = {"status": "pending", "httpStatus": 503, "retryAfter": 2,
                                "error": "Still loading"}
            continue
        try:
            values[symbol] = future.result()
            statuses[symbol] = {"status": "ready"}
        except Exception as exc:
            statuses[symbol] = error_item(exc)
    return values, statuses


def parse_symbols(raw: str, *, limit: int = 60) -> list[str]:
    symbols = list(dict.fromkeys(s.strip().upper() for s in raw.split(',') if s.strip()))
    if not symbols or len(symbols) > limit or any(len(s) > 64 for s in symbols):
        raise HTTPException(422, f"Provide 1–{limit} symbols per batch; split larger lists into batches")
    return symbols
