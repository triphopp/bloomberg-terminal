"""
Business-cycle readings router — official indicators by their published definitions.

Endpoint:
  GET /api/cycle — recession rules, yield-curve probit, OECD CLI phase, output and
                   unemployment gaps, inflation against the FOMC goal, policy rate
                   against the SEP longer-run median and Taylor (1993), NFCI; each
                   with its rule, source and track record. Definitions and the
                   arithmetic live in backend/cycle.py.

The series are monthly or slower, so one pull is kept six hours and the last
good pull is served (and reported stale) when FRED does not answer.
"""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import pandas as pd
import requests
from fastapi import APIRouter

import cycle
import last_good
from analytics import alloc_rules
from cache import TTLCache
from config import FRED_API_KEY, FRED_JSON_URL

router = APIRouter(prefix="/api/cycle", tags=["cycle"])

_FRED_TTL = 6 * 3600
_MARKET_TTL = 6 * 3600
_PAYLOAD_TTL = 600
#: A failed pull is not tried again for this long — an empty answer is not "expired".
_RETRY_AFTER = 600

_cache = TTLCache(ttl=_FRED_TTL, maxsize=16)
_failed_at: dict[str, float] = {}
_lock = threading.Lock()


def _fetch_series(series_id: str) -> pd.Series | None:
    try:
        r = requests.get(
            FRED_JSON_URL,
            params={"series_id": series_id, "api_key": FRED_API_KEY, "file_type": "json", "sort_order": "asc"},
            headers={"User-Agent": "Mozilla/5.0"}, timeout=20,
        )
        if not r.ok:
            print(f"[cycle] FRED {series_id}: HTTP {r.status_code}")
            return None
        rows = {o["date"]: float(o["value"]) for o in r.json().get("observations", [])
                if o.get("value") not in (".", "", None)}
        return pd.Series(rows, name=series_id, dtype=float) if rows else None
    except Exception as exc:
        # Type only: the exception text embeds the request URL, API key included.
        print(f"[cycle] FRED {series_id} failed: {type(exc).__name__}")
        return None


def _fetch_fred() -> pd.DataFrame | None:
    if not FRED_API_KEY:
        return None
    with ThreadPoolExecutor(max_workers=4) as pool:
        got = list(pool.map(_fetch_series, cycle.FRED_SERIES))
    cols = {s.name: s for s in got if s is not None}
    if not cols:
        return None
    frame = pd.DataFrame(cols)
    frame.index = pd.to_datetime(frame.index)
    return frame.sort_index()


def _fetch_market() -> pd.DataFrame | None:
    """S&P 500 (track record) and SPY (trend) daily closes, side by side.

    Yahoo's monthly bars for ^GSPC start in 1985; the daily ones go back to 1927.
    """
    from sources import market_data

    out: dict[str, pd.Series] = {}
    for column, symbol, period, interval in (("SP500", "^GSPC", "max", "1d"), ("SPY", "SPY", "2y", "1d")):
        try:
            frame = market_data.get_history(symbol, period=period, interval=interval)
            closes = frame.df["Close"].dropna() if frame is not None and frame.df is not None else None
            if closes is not None and len(closes):
                closes.index = pd.to_datetime(closes.index).tz_localize(None)
                out[column] = closes
        except Exception as exc:
            print(f"[cycle] {symbol} history failed: {type(exc).__name__}")
    return pd.DataFrame(out).sort_index() if out else None


def _pull(key: str, fn, ttl: int, label: str, source: str) -> tuple[pd.DataFrame | None, float | None]:
    """Fresh frame, else the last good one — and no second attempt for a while after a miss."""
    def guarded():
        with _lock:
            if time.time() - _failed_at.get(key, 0.0) < _RETRY_AFTER:
                return None
        frame = fn()
        with _lock:
            if frame is None:
                _failed_at[key] = time.time()
            else:
                _failed_at.pop(key, None)
        return frame

    frame, age = last_good.cached_fetch(_cache, key, guarded, ttl=ttl, label=label, source=source)
    if age is not None or frame is None:
        _cache.delete(key)      # the cache holds the miss itself; `_failed_at` is what spaces the retries
    return frame, age


def _trend(spy: pd.Series | None, today: pd.Period) -> dict | None:
    if spy is None or spy.empty:
        return None
    closes = alloc_rules.month_end_closes(spy.dropna())
    closes = closes[closes.index < today]              # the running month has no month-end yet
    weight = alloc_rules.trend_weight(closes)
    if weight is None:
        return None
    average = float(closes.iloc[-alloc_rules.TREND_MONTHS:].mean())
    on = pd.Series([c > closes.iloc[max(0, i - alloc_rules.TREND_MONTHS + 1):i + 1].mean()
                    for i, c in enumerate(closes)], index=closes.index)
    return {
        "id": "trend_10m", "label": "SPY 10-MONTH TREND", "series": "SPY", "url": None,
        "value": (float(closes.iloc[-1]) / average - 1.0) * 100.0, "unit": "%", "as_of": str(closes.index[-1]),
        "on": weight > 0, "state": "ABOVE AVERAGE" if weight > 0 else "BELOW AVERAGE",
        "tone": "good" if weight > 0 else "bad", "since": str(cycle.since(on)), "line": "0 = 10-month average",
        "rule": "Month-end close (dividends included) against the average of the last ten month-end closes. "
                "Tested here on 1994–2026: max drawdown −26% against −55% for buy-and-hold, CAGR 1.2pp lower, "
                "Sharpe gain not distinguishable from luck — verdict WEAK.",
        "source": "Faber (2007) · research/sector_allocation/RESULTS.md", "revised": False,
        "verdict": "WEAK", "official": False,
    }


def _build() -> dict:
    fred, fred_age = _pull("cycle_fred", _fetch_fred, _FRED_TTL, "Cycle indicators", "FRED")
    market, _ = _pull("cycle_market", _fetch_market, _MARKET_TTL, "Cycle market history", "Yahoo")
    now = datetime.now(timezone.utc)
    stamp = {"ts": now.isoformat().replace("+00:00", "Z")}
    if fred is None or fred.empty:
        return {**stamp, "ok": False, "detail": "FRED did not answer and no earlier pull is stored"
                                                if FRED_API_KEY else "FRED_API_KEY is not set"}

    series = {sid: fred[sid].dropna() for sid in fred.columns}
    today = pd.Timestamp(now.date()).to_period("M")
    sp500 = None
    if market is not None and "SP500" in market:
        sp500 = alloc_rules.month_end_closes(market["SP500"].dropna())
        sp500 = sp500[sp500.index < today]
    spy = market["SPY"] if market is not None and "SPY" in market else None

    out = cycle.build(series, sp500, _trend(spy, today))
    out.update(stamp, ok=True, stale_hours=None if fred_age is None else round(fred_age / 3600, 1),
               market_ok=sp500 is not None)
    return out


@router.get("")
def get_cycle():  # sync: blocking requests / yfinance — FastAPI runs it in a threadpool
    hit = _cache.get("payload", ttl=_PAYLOAD_TTL)
    # A reading with a series missing is kept only a minute, so one slow answer does not stick.
    if hit is not None and (not hit.get("missing") or _cache.get("payload", ttl=60) is not None):
        return hit
    out = _build()
    if out.get("ok"):
        _cache.set("payload", out)
    return out
