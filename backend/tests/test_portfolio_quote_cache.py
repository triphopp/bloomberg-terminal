"""
Quote-cache behaviour behind DAY P&L and the pre-market column.

Two bugs motivated these:

  * DAY P&L kept showing yesterday's move after midnight. The stale-while-
    revalidate layer never expired, so the first request of a new day was
    answered with yesterday's (price, prev_close) pair — whose difference is,
    by construction, yesterday's day move.

  * The pre-market column dropped symbols at random. A failed `.info` call
    returned {} and that {} was written into a 30s TTL cache, so one transient
    error blanked the row on every poll for the next 30 seconds.
"""

import routers.portfolio_v2 as pv2


def _clear_caches():
    pv2._stale_quotes.clear()
    pv2._session_last_good.clear()
    pv2._price_cache.clear()
    pv2._prev_cache.clear()


# ── Stale-while-revalidate must not cross a day boundary ────────────────────

def test_stale_quote_from_today_is_served():
    _clear_caches()
    pv2._store_quote("AAPL", 190.0, 188.0)
    assert pv2._get_fresh_stale("AAPL") == {"price": 190.0, "prev_close": 188.0}


def test_stale_quote_from_yesterday_is_dropped():
    """The regression: a yesterday-stamped pair must not be served."""
    _clear_caches()
    pv2._stale_quotes["AAPL"] = {"price": 190.0, "prev_close": 188.0, "day": "2020-01-01"}
    assert pv2._get_fresh_stale("AAPL") is None
    # and it is evicted, so it cannot be handed out later either
    assert "AAPL" not in pv2._stale_quotes


def test_batch_fetch_treats_yesterday_stale_as_cold(monkeypatch):
    """A stale-but-yesterday symbol must trigger a real fetch, not be served."""
    _clear_caches()
    pv2._stale_quotes["MSFT"] = {"price": 100.0, "prev_close": 99.0, "day": "2020-01-01"}

    fetched: list[list[str]] = []

    def fake_fetch_now(syms):
        fetched.append(list(syms))
        return {s: {"price": 420.0, "prev_close": 410.0} for s in syms}

    monkeypatch.setattr(pv2, "_fetch_symbols_now", fake_fetch_now)
    out = pv2._batch_fetch_prices(["MSFT"])

    assert fetched == [["MSFT"]], "yesterday's stale value should force a blocking fetch"
    assert out["MSFT"] == {"price": 420.0, "prev_close": 410.0}


def test_day_pnl_would_be_todays_move_not_yesterdays(monkeypatch):
    """End-to-end arithmetic: the served pair must produce today's move."""
    _clear_caches()
    # Yesterday: closed at 188 after opening from 180 → yesterday's move = +8
    pv2._stale_quotes["AAPL"] = {"price": 188.0, "prev_close": 180.0, "day": "2020-01-01"}

    monkeypatch.setattr(
        pv2, "_fetch_symbols_now",
        lambda syms: {s: {"price": 191.0, "prev_close": 188.0} for s in syms},
    )
    q = pv2._batch_fetch_prices(["AAPL"])["AAPL"]
    day_move = q["price"] - q["prev_close"]

    assert day_move == 3.0, "should be today's move (191-188), not yesterday's (188-180)"


# ── Per-symbol fallback must fill a missing prev_close ──────────────────────

def test_fallback_runs_when_only_prev_close_is_missing(monkeypatch):
    """Price present but prev_close absent still means no DAY P&L — so refetch."""
    _clear_caches()

    class _Snap:
        last_price = 50.0
        previous_close = None

    class _Batch:
        quotes = {"XYZ": _Snap()}

    monkeypatch.setattr(pv2.market_data, "download_quotes", lambda syms: _Batch())
    monkeypatch.setattr(pv2, "_fetch_one_quote", lambda s: {"price": None, "prev_close": 48.0})

    out = pv2._fetch_symbols_now(["XYZ"])
    # Merged, not replaced: batch supplied the price, the fallback the prev_close.
    assert out["XYZ"] == {"price": 50.0, "prev_close": 48.0}


# ── Session quotes: a failed fetch must not blank a known symbol ────────────

def test_session_quote_falls_back_to_last_good_on_exception(monkeypatch):
    _clear_caches()
    good = {
        "market_state": "PRE", "regular_price": 100.0,
        "pre_price": 101.0, "pre_change": 1.0, "pre_change_pct": 1.0,
        "post_price": None, "post_change": None, "post_change_pct": None,
    }
    pv2._session_last_good["AAPL"] = {**good, "day": pv2._today_key()}

    def boom(_sym):
        raise RuntimeError("rate limited")

    monkeypatch.setattr(pv2.market_data, "get_info", boom)
    assert pv2._fetch_session_quote("AAPL") == good


def test_session_quote_falls_back_when_info_is_a_husk(monkeypatch):
    """yfinance sometimes returns a dict with no marketState — not a real quote."""
    _clear_caches()
    good = {
        "market_state": "REGULAR", "regular_price": 100.0,
        "pre_price": None, "pre_change": None, "pre_change_pct": None,
        "post_price": None, "post_change": None, "post_change_pct": None,
    }
    pv2._session_last_good["AAPL"] = {**good, "day": pv2._today_key()}

    class _Info:
        raw = {"someUnrelatedField": 1}

    monkeypatch.setattr(pv2.market_data, "get_info", lambda s: _Info())
    assert pv2._fetch_session_quote("AAPL") == good


def test_session_quote_returns_empty_when_never_seen(monkeypatch):
    """No last-good value → {} so the caller knows not to cache it."""
    _clear_caches()

    def boom(_sym):
        raise RuntimeError("nope")

    monkeypatch.setattr(pv2.market_data, "get_info", boom)
    assert pv2._fetch_session_quote("NEVERSEEN") == {}


def test_session_last_good_expires_next_day(monkeypatch):
    _clear_caches()
    pv2._session_last_good["AAPL"] = {"market_state": "PRE", "day": "2020-01-01"}
    assert pv2._session_last_good_get("AAPL") is None
