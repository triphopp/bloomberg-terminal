"""Cache policy of /api/ticker.

The bar used to show "MARKET DATA LOADING..." mid-session: every fetcher
swallows its own errors and returns empty, and the empty result was cached
like any other, so one upstream 429 blanked the crawl for a full minute.
These cover the three rules that replaced that.
"""
import time

import pytest

import routers.ticker as tk


@pytest.fixture(autouse=True)
def clean_cache():
    tk._cache.clear() if hasattr(tk._cache, "clear") else tk._cache._store.clear()
    with tk._refresh_lock:
        tk._inflight.clear()
        tk._last_attempt.clear()
    yield


def _payload(n_items: int) -> tuple[dict, bool]:
    items = [{"label": f"X{i}", "value": i, "type": "index"} for i in range(n_items)]
    return (
        {"items": items, "alerts": [], "has_critical": False,
         "timestamp": "t", "stale": False, "degraded": not items},
        not items,
    )


def test_degraded_build_does_not_replace_a_good_payload(monkeypatch):
    key = "ticker:test"
    monkeypatch.setattr(tk, "_build_ticker", lambda acct: _payload(3))
    good = tk._build_and_store(key, "test")
    assert len(good["items"]) == 3

    # Upstream now fails: every fetcher returns empty.
    monkeypatch.setattr(tk, "_build_ticker", lambda acct: _payload(0))
    after = tk._build_and_store(key, "test")

    assert len(after["items"]) == 3, "an empty build must not blank the crawl"
    assert after["stale"] is True
    assert len(tk._cache.get(key)[1]["items"]) == 3, "cache kept the empty payload"


def test_degraded_build_is_stored_when_there_is_nothing_better(monkeypatch):
    monkeypatch.setattr(tk, "_build_ticker", lambda acct: _payload(0))
    out = tk._build_and_store("ticker:empty", "empty")
    assert out["items"] == []
    assert out["degraded"] is True


def test_stale_entry_is_served_and_refreshed_in_background(monkeypatch):
    key = "ticker:all"
    monkeypatch.setattr(tk, "_build_ticker", lambda acct: _payload(2))
    tk._build_and_store(key, "all")

    # Age the entry past FRESH_TTL without waiting for it.
    fetched_at, payload = tk._cache.get(key)
    tk._cache.set(key, (fetched_at - tk.FRESH_TTL - 1, payload))

    calls: list[str] = []

    def slower(acct):
        calls.append(acct)
        return _payload(5)

    monkeypatch.setattr(tk, "_build_ticker", slower)

    t0 = time.monotonic()
    out = tk.get_ticker(account_id="all")
    elapsed = time.monotonic() - t0

    assert out["stale"] is True
    assert len(out["items"]) == 2, "serves the old payload, not the new one"
    assert elapsed < 0.5, "stale read must not wait on the refresh"

    for _ in range(100):           # let the background thread land
        if calls:
            break
        time.sleep(0.02)
    assert calls == ["all"], "a stale read must trigger exactly one refresh"


def test_fresh_entry_triggers_no_refresh(monkeypatch):
    key = "ticker:all"
    monkeypatch.setattr(tk, "_build_ticker", lambda acct: _payload(2))
    tk._build_and_store(key, "all")

    def boom(acct):
        raise AssertionError("a fresh entry must be served with no work at all")

    monkeypatch.setattr(tk, "_build_ticker", boom)
    out = tk.get_ticker(account_id="all")
    assert out["stale"] is False


def test_fresh_window_sits_under_the_frontend_poll():
    # The bug this replaced: a 60s cache polled every 60s expired exactly as the
    # next request arrived, so nearly every poll paid the full cold fan-out.
    assert tk.FRESH_TTL < 90, "frontend polls /api/ticker every 90s"
    assert tk.FRESH_TTL < tk.STALE_TTL
