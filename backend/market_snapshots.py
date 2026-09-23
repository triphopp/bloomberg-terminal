"""Shared Yahoo quote and adjusted OHLCV data for watchlists, charts and alerts.

Quote payload deliberately retains regular-session and timestamped pre/post fields.
Keys include provider, adjustment policy, interval and lookback; incompatible data
is never silently substituted. Consumers must not mutate cached DataFrames.
"""
from datetime import datetime, timezone
from typing import Any
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



def get_raw_info(symbol: str):
    symbol = symbol.strip().upper()
    def load():
        info = market_data.get_ticker(symbol).info
        if not info:
            raise HTTPException(502, f"Quote details unavailable for {symbol}", headers={"Retry-After": "5"})
        return info
    return market_requests.get("yfinance", ("info", symbol), load, ttl=60)


def fast_info_future(symbol: str):
    symbol = symbol.strip().upper()
    def load():
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


def _load_quote(symbol: str):
    try:

        # ── Prefer ticker.info for accurate price & change data ──────────
        # fast_info.previous_close is often stale/wrong, causing CHG% to
        # diverge from Yahoo Finance and other sources. ticker.info returns
        # Yahoo's own computed change values which match external sources.
        info: dict = {}
        try:
            info = get_raw_info(symbol)
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
        return data

    except HTTPException:
        raise
    except Exception as exc:
        print(f"[quote] {symbol}: {exc}")
        raise as_http_error(exc) from exc


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
