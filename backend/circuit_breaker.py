"""
Minimal circuit breaker — prevents repeated calls to failing external APIs.

After `failure_threshold` consecutive failures, the source enters cooldown
and `allow()` returns False until `cooldown_seconds` elapses.
A single success resets the counter.
"""
import threading
import time


class CircuitBreaker:
    def __init__(self, failure_threshold: int = 3, cooldown_seconds: int = 300):
        self._states: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._threshold = failure_threshold
        self._cooldown = cooldown_seconds

    def allow(self, source: str) -> bool:
        with self._lock:
            s = self._states.get(source)
            return not (s and s["cooldown_until"] > time.time())

    def record_success(self, source: str) -> None:
        with self._lock:
            self._states.pop(source, None)

    def record_failure(self, source: str) -> None:
        with self._lock:
            s = self._states.get(source)
            if s is None:
                s = {"failures": 0, "cooldown_until": 0}
                self._states[source] = s
            s["failures"] += 1
            if s["failures"] >= self._threshold:
                s["cooldown_until"] = time.time() + self._cooldown

    def status(self, source: str) -> str:
        with self._lock:
            s = self._states.get(source)
            if not s:
                return "ok"
            if s["cooldown_until"] > time.time():
                return "open"
            return "degraded"

    def reset(self) -> None:
        with self._lock:
            self._states.clear()


_cb = CircuitBreaker()


def allow(source: str) -> bool:
    return _cb.allow(source)


def success(source: str) -> None:
    _cb.record_success(source)


def failure(source: str) -> None:
    _cb.record_failure(source)


def status(source: str) -> str:
    return _cb.status(source)


def reset_all() -> None:
    _cb.reset()
