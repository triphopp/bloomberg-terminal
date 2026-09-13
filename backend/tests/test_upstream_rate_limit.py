"""
A vendor throttle must never be reported as an internal error.

The bug this locks down: yfinance rate-limits the terminal, routers/options.py
catches the exception and re-raises it as a 500, and main.py's handler — doing
its job of never leaking internals out of a 5xx — replaces the message with
"Internal server error". The reader is told the terminal is broken when the
only true statement is "wait a minute and try again", and goes looking for a
bug that does not exist. It cost a real debugging session.

Run: cd backend && python -m pytest tests/test_upstream_rate_limit.py -q
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from sources.errors import RETRY_AFTER_SECONDS, UpstreamRateLimited, is_rate_limit
from sources.yfinance_source import _RateLimitAwareTicker


class _Throttled:
    """Stand-in for a yfinance Ticker whose lazy fetches are being throttled."""

    message = "Too Many Requests. Rate limited. Try after a while."

    @property
    def options(self):
        raise RuntimeError(self.message)

    def history(self, **_):
        raise RuntimeError(self.message)

    @property
    def info(self):
        return {"shortName": "Fine"}

    def working_call(self):
        return "fine"

    @property
    def broken(self):
        raise ValueError("a genuine failure, not a throttle")


# ── Classification ──────────────────────────────────────────────────────────

def test_a_throttle_is_recognised_by_class_name_or_message():
    # Matching on both means a yfinance version that renames or moves the
    # exception cannot silently turn every throttle back into a 500.
    class YFRateLimitError(Exception):
        pass

    assert is_rate_limit(YFRateLimitError())
    assert is_rate_limit(RuntimeError("Too Many Requests. Rate limited."))
    assert is_rate_limit(RuntimeError("429 rate limited"))


def test_a_real_failure_is_not_mistaken_for_a_throttle():
    assert not is_rate_limit(ValueError("boom"))
    assert not is_rate_limit(KeyError("missing"))
    assert not is_rate_limit(TimeoutError("slow"))


def test_the_error_carries_what_the_reader_needs_to_act():
    err = UpstreamRateLimited("Yahoo Finance", "MSFT")
    assert err.status_code == 429, "429 is below 500, so the detail survives the global handler"
    assert err.headers["Retry-After"] == str(RETRY_AFTER_SECONDS)
    assert "MSFT" in err.detail
    assert "Nothing is broken" in err.detail
    assert isinstance(err, HTTPException), (
        "must subclass HTTPException so the routers' existing "
        "`except HTTPException: raise` guards let it through"
    )


# ── The proxy ───────────────────────────────────────────────────────────────

def test_a_throttled_attribute_becomes_a_429():
    ticker = _RateLimitAwareTicker(_Throttled(), "MSFT")
    with pytest.raises(UpstreamRateLimited) as caught:
        ticker.options
    assert caught.value.status_code == 429
    assert "MSFT" in caught.value.detail


def test_a_throttled_method_call_becomes_a_429():
    # `.history(...)` fetches when CALLED, not when looked up, so the wrapper
    # has to survive one more hop than a plain attribute.
    ticker = _RateLimitAwareTicker(_Throttled(), "AMD")
    with pytest.raises(UpstreamRateLimited):
        ticker.history(period="1y")


def test_a_genuine_error_is_left_alone():
    # The whole point of matching narrowly: a wrapper that relabelled real
    # failures as "retry in a minute" would hide actual bugs.
    ticker = _RateLimitAwareTicker(_Throttled(), "KO")
    with pytest.raises(ValueError):
        ticker.broken


def test_working_attributes_and_calls_pass_straight_through():
    ticker = _RateLimitAwareTicker(_Throttled(), "KO")
    assert ticker.info == {"shortName": "Fine"}
    assert ticker.working_call() == "fine"


def test_the_proxy_names_the_symbol_it_wraps():
    assert "KO" in repr(_RateLimitAwareTicker(_Throttled(), "KO"))


# ── The escape hatch ────────────────────────────────────────────────────────

def test_a_throttle_that_bypasses_a_ticker_still_reports_as_429():
    """`yf.download` called straight from an analytics module never touches the
    proxy, so main.py's catch-all has to recognise the throttle too."""
    import main

    class _Req:
        method = "GET"

        class url:
            path = "/api/whatever"

    response = main._rate_limited_response(_Req(), RuntimeError("Too Many Requests"))
    assert response.status_code == 429
    assert response.headers["Retry-After"] == str(RETRY_AFTER_SECONDS)


# ── Throttled into silence ──────────────────────────────────────────────────

def test_an_empty_result_right_after_a_throttle_is_attributed_to_it():
    """yfinance answers some throttled requests with an empty list instead of
    an error, and an empty expiry list is indistinguishable from a symbol with
    no options — so MSFT gets reported as having no chain."""
    from sources import errors

    errors.reset_rate_limit_memory()
    assert not errors.recently_rate_limited()

    errors.note_rate_limit()
    assert errors.recently_rate_limited()
    errors.reset_rate_limit_memory()


def test_the_attribution_window_expires():
    # Narrow on purpose: a symbol that genuinely has no options must stop being
    # reported as throttled well before the client's own retry window closes.
    from sources import errors

    errors.reset_rate_limit_memory()
    errors.note_rate_limit()
    assert errors.recently_rate_limited(within=60)
    assert not errors.recently_rate_limited(within=0)
    assert errors.SILENCE_WINDOW_SECONDS < RETRY_AFTER_SECONDS, (
        "the silence window must close before the client is told to retry"
    )
    errors.reset_rate_limit_memory()


def test_the_proxy_records_the_throttle_it_converts():
    """The empty-result path can only consult this memory if every conversion
    writes to it."""
    from sources import errors

    errors.reset_rate_limit_memory()
    ticker = _RateLimitAwareTicker(_Throttled(), "MSFT")
    with pytest.raises(UpstreamRateLimited):
        ticker.options
    assert errors.recently_rate_limited(), "a conversion that does not record is invisible downstream"
    errors.reset_rate_limit_memory()
