"""A missing vendor daily Close must not hide an otherwise complete final bar."""

import pandas as pd
import pytest
from fastapi import HTTPException

from cache import TTLCache
import routers.stock as stock


@pytest.fixture
def frames(monkeypatch):
    monkeypatch.setattr(stock, "_stock_cache", TTLCache(ttl=300))
    dates = pd.DatetimeIndex(["2026-09-21", "2026-09-22"], tz="America/New_York")
    raw = pd.DataFrame(
        {
            "Open": [1826.0, 1758.55],
            "High": [1834.49, 1909.48],
            "Low": [1737.01, 1758.14],
            "Close": [1766.64, float("nan")],
            "Volume": [10442700, 12806071],
        },
        index=dates,
    )
    adjusted = raw.copy()
    adjusted.loc[dates[-1], ["Open", "High", "Low"]] = float("nan")
    return adjusted, raw


def test_recovers_sndk_final_day_without_inventing_ohlc(frames, monkeypatch):
    adjusted, raw = frames
    calls = []

    def history(_symbol, _period, _interval, *, ttl, auto_adjust=True):
        calls.append(auto_adjust)
        return adjusted if auto_adjust else raw

    monkeypatch.setattr(stock, "get_history", history)
    monkeypatch.setattr(
        stock,
        "get_quote",
        lambda _symbol: {"quoteDate": "2026-09-22", "regularMarketPrice": 1887.04},
    )

    result = stock.stock_history("SNDK", "1m", "1d")
    assert calls == [True, False]
    assert result["quotes"][-1] == {
        "date": "2026-09-22",
        "close": 1887.04,
        "open": 1758.55,
        "high": 1909.48,
        "low": 1758.14,
        "volume": 12806071,
    }


@pytest.mark.parametrize("bad_case", ["wrong_date", "out_of_range", "missing_raw_low"])
def test_rejects_unmatched_or_incomplete_last_bar(frames, monkeypatch, bad_case):
    adjusted, raw = frames
    quote = {"quoteDate": "2026-09-22", "regularMarketPrice": 1887.04}
    if bad_case == "wrong_date":
        quote["quoteDate"] = "2026-09-21"
    elif bad_case == "out_of_range":
        quote["regularMarketPrice"] = 2100.0
    else:
        raw = raw.copy()
        raw.loc[raw.index[-1], "Low"] = float("nan")
    monkeypatch.setattr(
        stock, "get_history", lambda *args, auto_adjust=True, **kwargs: adjusted if auto_adjust else raw
    )
    monkeypatch.setattr(stock, "get_quote", lambda _symbol: quote)

    result = stock.stock_history(f"BAD-{bad_case}", "1m", "1d")
    assert [bar["date"] for bar in result["quotes"]] == ["2026-09-21"]


def test_optional_recovery_error_keeps_existing_history(frames, monkeypatch):
    adjusted, raw = frames
    provider_ready = False

    def history(*args, auto_adjust=True, **kwargs):
        if not auto_adjust and not provider_ready:
            raise HTTPException(429, "provider busy")
        return adjusted if auto_adjust else raw

    monkeypatch.setattr(stock, "get_history", history)
    monkeypatch.setattr(
        stock,
        "get_quote",
        lambda _symbol: {"quoteDate": "2026-09-22", "regularMarketPrice": 1887.04},
    )

    assert stock.stock_history("FALLBACK", "1m", "1d")["quotes"][-1]["close"] == 1766.64
    provider_ready = True
    assert stock.stock_history("FALLBACK", "1m", "1d")["quotes"][-1]["close"] == 1887.04


def test_complete_daily_bar_needs_no_quote_or_raw_refetch(frames, monkeypatch):
    _adjusted, raw = frames
    complete = raw.copy()
    complete.loc[complete.index[-1], "Close"] = 1887.04
    calls = []

    def history(*args, auto_adjust=True, **kwargs):
        calls.append(auto_adjust)
        return complete

    monkeypatch.setattr(stock, "get_history", history)
    monkeypatch.setattr(stock, "get_quote", lambda _symbol: pytest.fail("unexpected quote request"))

    assert stock.stock_history("COMPLETE", "1m", "1d")["quotes"][-1]["close"] == 1887.04
    assert calls == [True]
