"""Batched /v7/finance/quote layer (market_snapshots.v7_quotes)."""
import market_snapshots as ms


def _row(sym, px=100.0, **kw):
    return {"symbol": sym, "regularMarketPrice": px, "regularMarketPreviousClose": px - 1,
            "exchangeTimezoneName": "America/New_York", **kw}


def test_one_request_per_chunk_and_cached(monkeypatch):
    calls = []
    monkeypatch.setattr(ms, "_v7_fetch", lambda chunk: calls.append(list(chunk)) or [_row(s) for s in chunk])
    syms = [f"S{i}" for i in range(120)]
    out = ms.v7_quotes(syms)
    assert len(out) == 120
    assert [len(c) for c in calls] == [50, 50, 20]
    ms.v7_quotes(syms[:10])  # within TTL → no new request
    assert len(calls) == 3


def test_unanswered_symbol_is_absent_and_negative_cached(monkeypatch):
    calls = []
    monkeypatch.setattr(ms, "_v7_fetch", lambda chunk: calls.append(chunk) or [_row("AAA")])
    assert set(ms.v7_quotes(["AAA", "NOPE"])) == {"AAA"}
    ms.v7_quotes(["NOPE"])
    assert len(calls) == 1


def test_failed_batch_falls_back_without_raising(monkeypatch):
    def boom(chunk):
        raise RuntimeError("yahoo down")
    monkeypatch.setattr(ms, "_v7_fetch", boom)
    assert ms.v7_quotes(["AAA"]) == {}


def test_fast_info_mapping_uses_net_assets_for_etfs():
    ns = ms._fast_info_from_v7(_row("SPY", 500.0, netAssets=8e11, averageDailyVolume3Month=5e7))
    assert ns.last_price == 500.0
    assert ns.regular_market_previous_close == 499.0
    assert ns.timezone == "America/New_York"
    assert ns.market_cap == 8e11
    assert ns.three_month_average_volume == 5e7


def test_fast_info_future_prefers_v7_over_ticker(monkeypatch):
    from market_requests import MarketRequests
    monkeypatch.setattr(ms, "market_requests", MarketRequests(workers=2))
    monkeypatch.setattr(ms, "_v7_fetch", lambda chunk: [_row(s, 42.0) for s in chunk])

    def no_ticker(sym):
        raise AssertionError("per-symbol yfinance path must not run")
    monkeypatch.setattr(ms.market_data, "get_ticker", no_ticker)
    assert ms.fast_info_future("zzz").result(timeout=5).last_price == 42.0


def test_quote_info_keeps_fundamentals_but_never_stale_session(monkeypatch):
    monkeypatch.setattr(ms, "_v7_fetch", lambda chunk: [_row(s, 110.0, regularMarketChange=1.0) for s in chunk])
    slow = {"returnOnEquity": 0.3, "sector": "Tech", "previousClose": 50.0,
            "regularMarketPrice": 60.0, "postMarketPrice": 61.0, "marketState": "CLOSED"}
    seen = {}

    def fake_info(symbol, ttl=60):
        seen["ttl"] = ttl
        return slow
    monkeypatch.setattr(ms, "get_raw_info", fake_info)
    info = ms._quote_info("AAA")
    assert seen["ttl"] == ms.FUNDAMENTALS_TTL
    assert info["sector"] == "Tech" and info["returnOnEquity"] == 0.3
    assert info["regularMarketPrice"] == 110.0
    assert info["regularMarketPreviousClose"] == 109.0
    for stale in ("previousClose", "postMarketPrice", "marketState"):
        assert stale not in info


def test_quote_info_without_v7_row_is_the_plain_60s_info(monkeypatch):
    calls = []
    monkeypatch.setattr(ms, "get_raw_info", lambda symbol, ttl=60: calls.append(ttl) or {"regularMarketPrice": 5})
    assert ms._quote_info("NOV7")["regularMarketPrice"] == 5
    assert calls == [60]


def test_concurrent_callers_share_one_request_and_no_lock_during_io(monkeypatch):
    import threading
    import time
    calls = []
    gate = threading.Event()

    def slow_fetch(chunk):
        calls.append(list(chunk))
        gate.wait(2)
        return [_row(s) for s in chunk]
    monkeypatch.setattr(ms, "_v7_fetch", slow_fetch)
    out = {}
    t1 = threading.Thread(target=lambda: out.update(a=ms.v7_quotes(["X", "Y"])))
    t1.start()
    time.sleep(0.05)
    # Lock is free while t1 is inside the network call: a cached-miss-free
    # read of an unrelated symbol must not block behind it.
    monkeypatch.setattr(ms, "_v7_fetch", lambda chunk: calls.append(list(chunk)) or [_row(s) for s in chunk])
    t0 = time.monotonic()
    assert "Z" in ms.v7_quotes(["Z"])
    assert time.monotonic() - t0 < 0.5
    t2 = threading.Thread(target=lambda: out.update(b=ms.v7_quotes(["X"])))
    t2.start()
    time.sleep(0.05)
    gate.set()
    t1.join(2)
    t2.join(2)
    assert set(out["a"]) == {"X", "Y"} and set(out["b"]) == {"X"}
    assert calls == [["X", "Y"], ["Z"]]  # X fetched once, shared with t2


def test_quote_info_serves_price_when_fundamentals_rate_limited(monkeypatch):
    from fastapi import HTTPException
    monkeypatch.setattr(ms, "_v7_fetch", lambda chunk: [_row(s, 7.0) for s in chunk])

    def limited(symbol, ttl=60):
        raise HTTPException(429, "slow down")
    monkeypatch.setattr(ms, "get_raw_info", limited)
    assert ms._quote_info("RL")["regularMarketPrice"] == 7.0


def test_lite_quote_has_every_lite_key_and_never_calls_fundamentals(monkeypatch):
    monkeypatch.setattr(ms, "_v7_fetch", lambda chunk: [_row(s, 12.0, regularMarketChange=0.5, marketState="REGULAR") for s in chunk])

    def boom(*a, **k):
        raise AssertionError("lite quote must not fetch quoteSummary/info")
    monkeypatch.setattr(ms, "get_raw_info", boom)
    q = ms._load_quote("LITE", lite=True)
    assert tuple(q) == ms.LITE_QUOTE_KEYS
    assert q["regularMarketPrice"] == 12.0 and q["marketState"] == "REGULAR"
    assert q["postMarketPrice"] is None  # present as null, so a client merge clears a stale value
