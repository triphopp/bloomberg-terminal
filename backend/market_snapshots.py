"""Shared Yahoo quote and adjusted OHLCV data for watchlists, charts and alerts.

Quote payload deliberately retains regular-session and timestamped pre/post fields.
Keys include provider, adjustment policy, interval and lookback; incompatible data
is never silently substituted. Consumers must not mutate cached DataFrames.
"""
from datetime import datetime, timezone
from typing import Any
import threading
import time
from types import SimpleNamespace
import math
from numbers import Real
import pandas as pd
from fastapi import HTTPException
from market_session import is_today_at, local_date_of
from market_requests import market_requests, as_http_error, collect
from sources import market_data


def _safe_float(val: Any):
    try:
        return float(val) if val is not None and not pd.isna(val) else None
    except (TypeError, ValueError):
        return None



def get_raw_info(symbol: str, ttl: float = 60):
    """ttl is how old an answer this caller accepts — one shared cache entry,
    so a fundamentals reader (long ttl) reuses any fresh fetch."""
    symbol = symbol.strip().upper()
    def load():
        info = market_data.get_ticker(symbol).info
        if not info:
            raise HTTPException(502, f"Quote details unavailable for {symbol}", headers={"Retry-After": "5"})
        return info
    return market_requests.get("yfinance", ("info", symbol), load, ttl=ttl)


# ── Batched Yahoo quote (/v7/finance/quote) ─────────────────────────────────
# One request answers up to 50 symbols. yfinance's fast_info costs 3–5
# requests PER symbol (chart for price, chart metadata for timezone, and
# fundamentals-timeseries for `shares`/`market_cap` — even on FX pairs and VIX,
# where there are no shares). At ~150 symbols polled every minute that was
# ~150 Yahoo calls/min (logs/upstream.jsonl, 2026-09-28). Every price field the
# app reads from fast_info is in the v7 payload, so fast_info is the fallback.
_V7_URL = "https://query1.finance.yahoo.com/v7/finance/quote"
_V7_CHUNK = 50
_V7_TTL = 30.0
_V7_MISS_TTL = 300.0  # Yahoo answered without this symbol — don't re-ask every poll
_V7_WAIT_S = 12.0     # longest a caller waits on another caller's batch
_v7_cache: dict[str, tuple[float, dict | None]] = {}  # symbol → (expires_at, row | None)
_v7_inflight: dict[str, threading.Event] = {}
_v7_lock = threading.Lock()  # guards the two dicts only — never held across I/O


def _v7_fetch(chunk: list[str]) -> list[dict]:
    """The one network call — yfinance's session carries the cookie/crumb and
    yahoo_gate records it in the upstream log. Tests stub this."""
    from yfinance.data import YfData
    raw = YfData().get_raw_json(
        _V7_URL, params={"symbols": ",".join(chunk), "formatted": "false"}, timeout=10)
    return (raw.get("quoteResponse") or {}).get("result") or []


def _v7_load(chunk: list[str]) -> None:
    """Fetch one chunk and publish it. A failed batch is a short (normal-TTL)
    miss: callers fall back to fast_info now, the batch is retried in 30 s —
    not once per symbol per request while Yahoo is down."""
    got: dict[str, dict] = {}
    ok = True
    try:
        for q in _v7_fetch(chunk):
            sym = str(q.get("symbol") or "").upper()
            if sym and q.get("regularMarketPrice") is not None:
                got[sym] = q
    except Exception as exc:  # noqa: BLE001 — callers fall back per symbol
        ok = False
        print(f"[v7-quote] batch of {len(chunk)} failed: {exc}")
    now = time.monotonic()
    with _v7_lock:
        for s in chunk:
            row = got.get(s)
            ttl = _V7_TTL if (row is not None or not ok) else _V7_MISS_TTL
            _v7_cache[s] = (now + ttl, row)
            ev = _v7_inflight.pop(s, None)
            if ev is not None:
                ev.set()
        if len(_v7_cache) > 5000:
            for k in [k for k, (exp, _) in _v7_cache.items() if exp < now]:
                _v7_cache.pop(k, None)


def v7_quotes(symbols) -> dict[str, dict]:
    """symbol → raw v7 quote dict, fetched in batches of 50 and cached ~30 s.

    Concurrent callers share work: a symbol already being fetched by another
    thread is waited on, not fetched again, and no lock is held during I/O.
    Symbols Yahoo does not answer are absent from the result (caller falls back)."""
    syms = list(dict.fromkeys(s.strip().upper() for s in symbols if s and s.strip()))
    if not syms:
        return {}
    mine: list[str] = []
    waits: list[threading.Event] = []
    with _v7_lock:
        now = time.monotonic()
        for s in syms:
            hit = _v7_cache.get(s)
            if hit is not None and hit[0] > now:
                continue
            ev = _v7_inflight.get(s)
            if ev is not None:
                waits.append(ev)
            else:
                _v7_inflight[s] = threading.Event()
                mine.append(s)
    try:
        for start in range(0, len(mine), _V7_CHUNK):
            _v7_load(mine[start:start + _V7_CHUNK])
    finally:
        # Never strand a waiter, whatever happened above.
        with _v7_lock:
            for s in mine:
                ev = _v7_inflight.pop(s, None)
                if ev is not None:
                    ev.set()
    deadline = time.monotonic() + _V7_WAIT_S
    for ev in waits:
        ev.wait(max(0.0, deadline - time.monotonic()))
    with _v7_lock:
        out: dict[str, dict] = {}
        for s in syms:
            hit = _v7_cache.get(s)
            if hit is not None and hit[1] is not None:
                out[s] = hit[1]
        return out


def _fast_info_from_v7(q: dict) -> SimpleNamespace:
    """The fast_info fields fast_info_future exposes, from one v7 row."""
    prev = q.get("regularMarketPreviousClose")
    return SimpleNamespace(
        last_price=q.get("regularMarketPrice"),
        previous_close=prev,
        regular_market_previous_close=prev,
        timezone=q.get("exchangeTimezoneName"),
        exchange=q.get("exchange"),
        regular_market_volume=q.get("regularMarketVolume"),
        three_month_average_volume=q.get("averageDailyVolume3Month"),
        # ETFs carry AUM as netAssets and no marketCap.
        market_cap=q.get("marketCap") or q.get("netAssets"),
        year_high=q.get("fiftyTwoWeekHigh"),
        year_low=q.get("fiftyTwoWeekLow"),
        open=q.get("regularMarketOpen"),
        shares=q.get("sharesOutstanding"),
    )


def fast_info_future(symbol: str):
    symbol = symbol.strip().upper()
    def load():
        q = v7_quotes([symbol]).get(symbol)
        if q is not None:
            return _fast_info_from_v7(q)
        fi = market_data.get_ticker(symbol).fast_info
        # Materialize lazy fields INSIDE the bounded provider worker.
        fields = ("last_price", "previous_close", "regular_market_previous_close",
            "timezone", "exchange", "regular_market_volume", "three_month_average_volume",
            "market_cap", "year_high", "year_low", "open", "shares")
        result = SimpleNamespace(**{key: getattr(fi, key, None) for key in fields})
        if result.last_price is None:
            raise HTTPException(404, f"Quote unavailable for {symbol}")
        return result
    return market_requests.submit("yfinance", ("fast-info", symbol), load, ttl=60)


def get_raw_fast_info(symbol: str):
    from concurrent.futures import TimeoutError
    try:
        return fast_info_future(symbol).result(timeout=22)
    except TimeoutError as exc:
        raise HTTPException(504, "Quote still loading", headers={"Retry-After": "2"}) from exc


class _FastInfoFallback:
    """Do not fetch fast_info when the rich payload already has the field."""
    def __init__(self, symbol):
        self.symbol = symbol
        self.value = None

    def __getattr__(self, name):
        if self.value is None:
            self.value = get_raw_fast_info(self.symbol)
        return getattr(self.value, name, None)


# Session fields: the ones a 30-minute-old `info` would get wrong.
_SESSION_PREFIXES = ("regularMarket", "preMarket", "postMarket")
_SESSION_KEYS = frozenset({"previousClose", "currentPrice", "open", "dayLow", "dayHigh",
                           "volume", "bid", "ask", "bidSize", "askSize", "marketState"})
FUNDAMENTALS_TTL = 1800


def _quote_info(symbol: str, fundamentals: bool = True) -> dict:
    """`info`-shaped dict for the rich quote at a fraction of the calls.

    `ticker.info` = quoteSummary (fundamentals) + v7 quote (price/session), two
    requests per symbol. Price and session come from the batched v7 row (30 s);
    fundamentals — margins, debt, sector — move quarterly, so the quoteSummary
    half is reused for 30 min. Its session fields are dropped, never shown: a
    stale previousClose would print yesterday's move as today's. Fundamentals
    failing (even 429) leaves a price-only quote rather than no quote.
    No v7 row → the plain 60 s `info`, exactly as before.
    `fundamentals=False` (lite quote): the v7 row alone."""
    row = v7_quotes([symbol]).get(symbol)
    if row is None:
        return get_raw_info(symbol)
    if not fundamentals:
        return dict(row)
    try:
        slow = get_raw_info(symbol, ttl=FUNDAMENTALS_TTL)
    except Exception:  # noqa: BLE001 — incl. 429: the price is in hand, serve it
        slow = {}
    base = {k: v for k, v in slow.items()
            if k not in _SESSION_KEYS and not k.startswith(_SESSION_PREFIXES)}
    return {**base, **row}


def _load_quote(symbol: str, lite: bool = False):
    try:

        # ── Prefer ticker.info for accurate price & change data ──────────
        # fast_info.previous_close is often stale/wrong, causing CHG% to
        # diverge from Yahoo Finance and other sources. ticker.info returns
        # Yahoo's own computed change values which match external sources.
        info: dict = {}
        try:
            info = _quote_info(symbol, fundamentals=not lite)
        except HTTPException as exc:
            if exc.status_code == 429:
                raise
        except Exception:
            pass

        fi = _FastInfoFallback(symbol)

        # Price: prefer info (Yahoo's regularMarketPrice), fall back to fast_info
        price = info.get("regularMarketPrice") or info.get("currentPrice") or fi.last_price
        price = _safe_float(price)
        if price is None or not math.isfinite(price):
            raise HTTPException(status_code=404, detail=f"Symbol '{symbol}' not found")

        # Change: prefer Yahoo's pre-computed change value, always derive % from change/prev
        # (regularMarketChangePercent is unreliable across yfinance versions — decimal vs %-form)
        prev = info.get("previousClose") or info.get("regularMarketPreviousClose") or fi.previous_close or price
        if info.get("regularMarketChange") is not None:
            change = round(info["regularMarketChange"], 4)
        else:
            change = round(price - prev, 4)
        pct = round((change / prev) * 100, 4) if prev else 0.0

        # ── Session freshness ────────────────────────────────────────────
        # Yahoo keeps serving the last completed session after a market shuts,
        # so `change`/`pct` above can be a previous day's move. Publish the real
        # trade timestamp and a verdict so callers can label or suppress it.
        tz_name = info.get("exchangeTimezoneName")
        market_time = info.get("regularMarketTime")
        quote_date = local_date_of(market_time, tz_name)
        is_current = is_today_at(market_time, tz_name)

        # Extended-hours prices carry their own timestamps; drop whichever is
        # not from today. `marketState` alone is not enough — it reads CLOSED
        # all weekend while last Friday's postMarketPrice sits in the payload.
        pre_fresh = is_today_at(info.get("preMarketTime"), tz_name)
        post_fresh = is_today_at(info.get("postMarketTime"), tz_name)

        data = {
            "symbol":                     symbol.upper(),
            "longName":                   info.get("longName"),
            "shortName":                  info.get("shortName"),
            "fullExchangeName":           info.get("fullExchangeName"),
            "exchange":                   info.get("exchange") or getattr(fi, "exchange", None),
            "currency":                   info.get("currency"),
            "regularMarketPrice":         round(price, 4),
            "regularMarketChange":        change,
            "regularMarketChangePercent": pct,
            # Yahoo's own trade timestamp — NOT datetime.now(). Stamping "now"
            # here made every quote look live and hid exactly the staleness the
            # consumers below need to detect.
            "regularMarketTime":          market_time,
            "quoteDate":                  quote_date,
            "isCurrentSession":           is_current,
            "exchangeTimezone":           tz_name,
            "marketCap":                  info.get("marketCap") or getattr(fi, "market_cap", None),
            "trailingPE":                 info.get("trailingPE"),
            "forwardPE":                  info.get("forwardPE"),
            "beta":                       info.get("beta"),
            "regularMarketVolume":        info.get("regularMarketVolume") or getattr(fi, "regular_market_volume", None),
            "averageDailyVolume3Month":   info.get("averageVolume3Month") or getattr(fi, "three_month_average_volume", None),
            "fiftyTwoWeekHigh":           info.get("fiftyTwoWeekHigh") or getattr(fi, "year_high", None),
            "fiftyTwoWeekLow":            info.get("fiftyTwoWeekLow") or getattr(fi, "year_low", None),
            "dividendYield":              info.get("dividendYield"),
            "epsTrailingTwelveMonths":    info.get("trailingEps"),
            "regularMarketOpen":          info.get("regularMarketOpen") or getattr(fi, "open", None),
            "regularMarketPreviousClose": round(prev, 4),
            # ── Profitability ratios ───────────────────────────────────
            "returnOnEquity":             info.get("returnOnEquity"),
            "returnOnAssets":             info.get("returnOnAssets"),
            "grossMargins":               info.get("grossMargins"),
            "operatingMargins":           info.get("operatingMargins"),
            "profitMargins":              info.get("profitMargins"),
            # ── Valuation multiples ────────────────────────────────────
            "enterpriseValue":            info.get("enterpriseValue"),
            "enterpriseToEbitda":         info.get("enterpriseToEbitda"),
            "ebitda":                     info.get("ebitda"),
            "priceToBook":                info.get("priceToBook"),
            "priceToSalesTrailing12Months": info.get("priceToSalesTrailing12Months"),
            "bookValue":                  info.get("bookValue"),
            # ── Leverage & liquidity ───────────────────────────────────
            "debtToEquity":               info.get("debtToEquity"),
            "totalDebt":                  info.get("totalDebt"),
            "totalCash":                  info.get("totalCash"),
            "totalStockholdersEquity":    info.get("totalStockholdersEquity"),
            # ── Cash flow ──────────────────────────────────────────────
            "operatingCashflow":          info.get("operatingCashflow"),
            "capitalExpenditures":        info.get("capitalExpenditures"),
            "totalRevenue":               info.get("totalRevenue"),
            "sharesOutstanding":          info.get("sharesOutstanding") or getattr(fi, "shares", None),
            # ── Market session ─────────────────────────────────────────
            "marketState":               info.get("marketState"),
            "preMarketPrice":            info.get("preMarketPrice") if pre_fresh else None,
            "preMarketChange":           _safe_float(info.get("preMarketChange")) if pre_fresh else None,
            "preMarketChangePercent":    _safe_float(info.get("preMarketChangePercent")) if pre_fresh else None,
            "postMarketPrice":           info.get("postMarketPrice") if post_fresh else None,
            "postMarketChange":          _safe_float(info.get("postMarketChange")) if post_fresh else None,
            "postMarketChangePercent":   _safe_float(info.get("postMarketChangePercent")) if post_fresh else None,
            "sector":                    info.get("sector"),
            "industry":                  info.get("industry"),
        }

        data = {k: None if isinstance(v, Real) and not math.isfinite(v) else v for k, v in data.items()}
        data["source"] = "yfinance"
        data["fetchedAt"] = datetime.now(timezone.utc).isoformat()
        if lite:
            # Every LITE key present (None included): the client merges this
            # over its cached full quote, so a pre/post price that went stale
            # must arrive as null, not be missing and keep the old value.
            return {k: data.get(k) for k in LITE_QUOTE_KEYS}
        return data

    except HTTPException:
        raise
    except Exception as exc:
        print(f"[quote] {symbol}: {exc}")
        raise as_http_error(exc) from exc


# The rich quote's fields that move within a session — what a poll needs.
# Everything else (names, margins, debt, sector…) comes with the full quote,
# which clients refresh on a slow clock (lib/market-data-client.ts).
LITE_QUOTE_KEYS = (
    "symbol", "regularMarketPrice", "regularMarketChange", "regularMarketChangePercent",
    "regularMarketTime", "quoteDate", "isCurrentSession", "exchangeTimezone",
    "regularMarketVolume", "regularMarketOpen", "regularMarketPreviousClose",
    "marketState", "marketCap", "trailingPE", "forwardPE", "priceToBook", "dividendYield",
    "fiftyTwoWeekHigh", "fiftyTwoWeekLow", "averageDailyVolume3Month",
    "preMarketPrice", "preMarketChange", "preMarketChangePercent",
    "postMarketPrice", "postMarketChange", "postMarketChangePercent",
    "source", "fetchedAt",
)


def lite_quote_future(symbol: str):
    """Price/session subset of the rich quote from the batched v7 row only —
    no quoteSummary call, about half the payload."""
    symbol = symbol.strip().upper()
    return market_requests.submit("quote-build", ("quote-lite", symbol),
                                  lambda: _load_quote(symbol, lite=True), ttl=60)


def quote_future(symbol: str):
    symbol = symbol.strip().upper()
    return market_requests.submit("quote-build", ("quote", symbol), lambda: _load_quote(symbol), ttl=60)


def get_quote(symbol: str):
    symbol = symbol.strip().upper()
    return market_requests.get("quote-build", ("quote", symbol), lambda: _load_quote(symbol), ttl=60)


def history_future(symbol: str, period: str, interval: str, *, ttl: int = 300,
                   auto_adjust: bool = True):
    symbol = symbol.strip().upper()
    def load():
        frame = market_data.get_ticker(symbol).history(
            period=period, interval=interval, auto_adjust=auto_adjust, timeout=12,
            raise_errors=True,
        )
        if frame is None or frame.empty:
            raise HTTPException(404, f"No history for {symbol}")
        return frame
    return market_requests.submit(
        "yfinance", ("history", symbol, period, interval, "adjusted" if auto_adjust else "raw"),
        load, ttl=ttl,
    )


def get_history(symbol: str, period: str, interval: str, *, ttl: int = 300,
                auto_adjust: bool = True):
    from concurrent.futures import TimeoutError
    try:
        return history_future(symbol, period, interval, ttl=ttl,
                              auto_adjust=auto_adjust).result(timeout=22)
    except TimeoutError as exc:
        raise HTTPException(504, "History still loading", headers={"Retry-After": "2"}) from exc


def daily_frames(symbols: list[str]):
    # Chunking bounds the queue even for scheduler scans of thousands of symbols.
    result = {}
    unique = list(dict.fromkeys(s.strip().upper() for s in symbols))
    for start in range(0, len(unique), 60):
        frames, statuses = collect({s: history_future(s, "2y", "1d", ttl=900) for s in unique[start:start+60]})
        failed = next((v for v in statuses.values() if v["status"] != "ready" and v["httpStatus"] != 404), None)
        if failed:
            # Alert evaluation must not silently claim a complete scan on failures.
            raise HTTPException(failed["httpStatus"], failed["error"], headers={"Retry-After": str(failed["retryAfter"])})
        result.update(frames)
    return result
