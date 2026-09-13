"""
Upstream failures that are NOT our bug, and must not be reported as one.

A vendor rate limit is transient, retryable, and entirely outside this
codebase. Reported as a 500 it reads as "the terminal is broken": the global
handler in main.py replaces every 5xx detail with a generic message so internal
paths cannot leak, so the one fact the reader needs — wait and try again —
never reaches them. They go looking for a bug that does not exist.

429 is the honest status. It is below 500, so the detail passes through the
handler untouched and the UI can show it, and `Retry-After` gives the client
something to act on rather than a guess.
"""
from __future__ import annotations

import time

from fastapi import HTTPException

# yfinance gives no header and no reset timestamp, so this is a stated default
# rather than a measurement. A minute is long enough for the limiter to relax
# and short enough that a user who waits it out does not assume it is stuck.
RETRY_AFTER_SECONDS = 60


class UpstreamRateLimited(HTTPException):
    """Raised when a data vendor throttles us.

    Subclasses HTTPException on purpose: every router in this codebase that
    converts errors to a 500 already re-raises HTTPException first, so a rate
    limit travels out through the handlers that exist rather than needing each
    of them to learn about a new exception type.
    """

    def __init__(self, vendor: str = "the data provider", symbol: str | None = None):
        subject = f" for {symbol}" if symbol else ""
        super().__init__(
            status_code=429,
            detail=(
                f"{vendor} is rate limiting this terminal{subject}. "
                f"Nothing is broken — retry in about {RETRY_AFTER_SECONDS}s. "
                "Heavy back-to-back model fits and chain downloads are the usual cause."
            ),
            headers={"Retry-After": str(RETRY_AFTER_SECONDS)},
        )


def is_rate_limit(exc: BaseException) -> bool:
    """True when an exception is a vendor throttle rather than a real failure.

    Matches on the class name and message rather than importing yfinance's
    exception directly: the class has moved between yfinance versions, and a
    missing import here would turn every error into an unrecognised one.
    """
    if isinstance(exc, UpstreamRateLimited):
        return True
    name = type(exc).__name__
    if "RateLimit" in name or "TooManyRequests" in name:
        return True
    text = str(exc).lower()
    return "too many requests" in text or "rate limited" in text


# ── "Throttled into silence" ─────────────────────────────────────────────────
#
# A throttle does not always raise. yfinance sometimes answers a limited
# request with an EMPTY result instead of an error, and an empty expiry list is
# indistinguishable from a symbol that genuinely has no options — so the caller
# reports "No options available for MSFT", which is false and sends the reader
# looking for the wrong thing.
#
# The only evidence available is timing: if this process was explicitly
# throttled seconds ago, an empty answer now is far more likely to be the same
# limiter than a real absence. That is a heuristic, and it is deliberately
# narrow — it only ever upgrades an EMPTY result to a 429, never a populated
# one, so it cannot mask real data.

_last_rate_limit_at: float = 0.0

# How long after a throttle an empty answer is still attributed to it. Shorter
# than RETRY_AFTER so a symbol that really has no options stops being reported
# as throttled well before the client's own retry window closes.
SILENCE_WINDOW_SECONDS = 45


def note_rate_limit() -> None:
    """Record that the vendor just throttled us."""
    global _last_rate_limit_at
    _last_rate_limit_at = time.time()


def recently_rate_limited(within: float = SILENCE_WINDOW_SECONDS) -> bool:
    """True when a throttle was seen recently enough to explain an empty result."""
    return (time.time() - _last_rate_limit_at) < within


def reset_rate_limit_memory() -> None:
    """Test hook — the module-level clock would otherwise leak between tests."""
    global _last_rate_limit_at
    _last_rate_limit_at = 0.0
