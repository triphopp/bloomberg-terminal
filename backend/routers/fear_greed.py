"""
Fear & Greed Index — sourced from CNN's unofficial API.

Primary:  CNN dataviz endpoint (requires browser-like headers, 15-min cache)
Fallback: Synthetic 5-component composite from yfinance (percentile-ranked)

GET /api/fear-greed          — current value + components (5-min cache)
GET /api/fear-greed/history  — historical series (15-min cache)
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Optional

import requests
from fastapi import APIRouter, Query

from cache import TTLCache

router = APIRouter(prefix="/api/fear-greed", tags=["fear-greed"])

_cache_current = TTLCache(ttl=300)    # 5-min for current value
_cache_history = TTLCache(ttl=900)    # 15-min for historical (CNN)

_CNN_URL     = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"
_CNN_HEADERS = {
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept":          "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin":          "https://edition.cnn.com",
    "Referer":         "https://edition.cnn.com/",
}

CNN_ZONE_MAP = {
    "extreme_fear":  "extreme_fear",
    "fear":          "fear",
    "neutral":       "neutral",
    "greed":         "greed",
    "extreme_greed": "extreme_greed",
    # CNN sometimes uses these variants
    "Extreme Fear":  "extreme_fear",
    "Fear":          "fear",
    "Neutral":       "neutral",
    "Greed":         "greed",
    "Extreme Greed": "extreme_greed",
}

ZONE_LABELS = {
    "extreme_fear":  "EXTREME FEAR",
    "fear":          "FEAR",
    "neutral":       "NEUTRAL",
    "greed":         "GREED",
    "extreme_greed": "EXTREME GREED",
}


def _zone_from_value(v: float) -> str:
    if v < 25:  return "extreme_fear"
    if v < 45:  return "fear"
    if v < 55:  return "neutral"
    if v < 75:  return "greed"
    return "extreme_greed"


def _zone_from_cnn(rating: str) -> str:
    return CNN_ZONE_MAP.get(rating, _zone_from_value(50))


def _fetch_cnn() -> dict | None:
    """Fetch raw JSON from CNN endpoint. Returns None on any failure."""
    try:
        r = requests.get(
            _CNN_URL,
            headers=_CNN_HEADERS,
            timeout=10,
        )
        if r.ok:
            return r.json()
    except Exception as e:
        print(f"[fear-greed] CNN fetch error: {e}")
    return None


def _build_history_from_cnn(raw: dict) -> list[dict]:
    """Convert CNN historical data to our standard format."""
    hist_raw = raw.get("fear_and_greed_historical", {}).get("data", [])
    result: list[dict] = []
    seen_dates: set[str] = set()
    for row in hist_raw:
        try:
            ts_ms   = row["x"]
            value   = float(row["y"])
            rating  = row.get("rating", "")
            # CNN timestamp is milliseconds since epoch
            date_str = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            if date_str in seen_dates:
                continue
            seen_dates.add(date_str)
            result.append({
                "time":  date_str,
                "value": round(value, 1),
                "zone":  _zone_from_cnn(rating),
            })
        except Exception:
            continue
    return sorted(result, key=lambda x: x["time"])


def _build_current_from_cnn(raw: dict) -> dict:
    """Extract current F&G info from CNN payload."""
    fg = raw.get("fear_and_greed", {})
    v  = float(fg.get("score", 50))
    return {
        "value":          round(v, 1),
        "zone":           _zone_from_cnn(fg.get("rating", "")),
        "label":          ZONE_LABELS.get(_zone_from_cnn(fg.get("rating", "")), "NEUTRAL"),
        "previous_close": fg.get("previous_close"),
        "previous_1_week":  fg.get("previous_1_week"),
        "previous_1_month": fg.get("previous_1_month"),
        "previous_1_year":  fg.get("previous_1_year"),
        "source":         "CNN",
        "timestamp":      datetime.now(timezone.utc).isoformat(),
    }


# ── Synthetic fallback (percentile-ranked, matches CNN methodology better) ────

def _synthetic_current() -> dict:
    """Compute approximate F&G from yfinance (fallback when CNN unreachable)."""
    try:
        import yfinance as yf
        import pandas as pd
        SYMS = ["^VIX", "SPY", "TLT", "HYG", "LQD", "RSP"]
        raw  = yf.download(SYMS, period="2y", auto_adjust=True, progress=False, threads=True)
        if raw.empty:
            raise RuntimeError("empty download")
        close = (raw["Close"] if isinstance(raw.columns, pd.MultiIndex) else raw).ffill().dropna(how="all")
        for s in SYMS:
            if s not in close.columns:
                close[s] = float("nan")

        def pct_rank(series: pd.Series, window: int = 504) -> pd.Series:
            """Rolling percentile rank (0-100), 0=all-time low, 100=all-time high."""
            return series.rolling(window, min_periods=63).apply(
                lambda x: (x[-1] > x[:-1]).mean() * 100, raw=True
            )

        # 1. VIX percentile — inverted (low VIX = greed)
        c1 = 100 - pct_rank(close["^VIX"])

        # 2. Momentum: SPY vs 125-day SMA percentile
        mom  = (close["SPY"] - close["SPY"].rolling(125, min_periods=63).mean()) / close["SPY"].rolling(125, min_periods=63).mean() * 100
        c2   = pct_rank(mom)

        # 3. Safe-haven demand: SPY vs TLT 20-day relative return percentile
        diff = (close["SPY"].pct_change(20) - close["TLT"].pct_change(20)) * 100
        c3   = pct_rank(diff)

        # 4. Junk bond demand: HYG/LQD ratio percentile
        c4 = pct_rank(close["HYG"] / close["LQD"])

        # 5. Breadth: RSP/SPY ratio percentile
        c5 = pct_rank(close["RSP"] / close["SPY"])

        composite = (
            c1.fillna(50) * 0.25 +
            c2.fillna(50) * 0.25 +
            c3.fillna(50) * 0.20 +
            c4.fillna(50) * 0.15 +
            c5.fillna(50) * 0.15
        )
        v = float(composite.rolling(3, min_periods=1).mean().dropna().iloc[-1])
    except Exception as e:
        print(f"[fear-greed] synthetic error: {e}")
        v = 50.0

    return {
        "value":    round(v, 1),
        "zone":     _zone_from_value(v),
        "label":    ZONE_LABELS[_zone_from_value(v)],
        "source":   "synthetic",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def _synthetic_history(period: str = "1y") -> list[dict]:
    """Compute historical synthetic F&G."""
    try:
        import yfinance as yf
        import pandas as pd
        SYMS = ["^VIX", "SPY", "TLT", "HYG", "LQD", "RSP"]
        raw  = yf.download(SYMS, period="3y", auto_adjust=True, progress=False, threads=True)
        if raw.empty:
            return []
        close = (raw["Close"] if isinstance(raw.columns, pd.MultiIndex) else raw).ffill().dropna(how="all")
        for s in SYMS:
            if s not in close.columns:
                close[s] = float("nan")

        def pct_rank(series: pd.Series, window: int = 504) -> pd.Series:
            return series.rolling(window, min_periods=63).apply(
                lambda x: (x[-1] > x[:-1]).mean() * 100, raw=True
            )

        c1 = 100 - pct_rank(close["^VIX"])
        mom = (close["SPY"] - close["SPY"].rolling(125, min_periods=63).mean()) / close["SPY"].rolling(125, min_periods=63).mean() * 100
        c2  = pct_rank(mom)
        diff = (close["SPY"].pct_change(20) - close["TLT"].pct_change(20)) * 100
        c3  = pct_rank(diff)
        c4  = pct_rank(close["HYG"] / close["LQD"])
        c5  = pct_rank(close["RSP"] / close["SPY"])

        composite = (
            c1.fillna(50) * 0.25 +
            c2.fillna(50) * 0.25 +
            c3.fillna(50) * 0.20 +
            c4.fillna(50) * 0.15 +
            c5.fillna(50) * 0.15
        ).rolling(3, min_periods=1).mean()

        # Trim to period
        if period == "1m":   composite = composite.iloc[-21:]
        elif period == "3m": composite = composite.iloc[-63:]
        elif period == "ytd":
            import pandas as pd
            composite = composite[composite.index >= pd.Timestamp(datetime.now().year, 1, 1)]
        elif period == "1y": composite = composite.iloc[-252:]

        result = []
        for date, v in composite.dropna().items():
            if math.isnan(float(v)):
                continue
            val = round(float(v), 1)
            result.append({"time": date.strftime("%Y-%m-%d"), "value": val, "zone": _zone_from_value(val)})
        return result
    except Exception as e:
        print(f"[fear-greed] synthetic history error: {e}")
        return []


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("")
def get_current():
    """Current Fear & Greed value + zone (CNN primary, synthetic fallback)."""
    cached = _cache_current.get("fg:current")
    if cached:
        return cached

    raw = _fetch_cnn()
    if raw:
        result = _build_current_from_cnn(raw)
    else:
        result = _synthetic_current()

    _cache_current.set("fg:current", result)
    return result


@router.get("/history")
def get_history(period: str = Query("1y", description="1m|3m|ytd|1y")):
    """Historical Fear & Greed series (CNN primary, synthetic fallback)."""
    cache_key = f"fg:hist:{period}"
    cached = _cache_history.get(cache_key)
    if cached:
        return cached

    history: list[dict] = []
    source  = "CNN"

    raw = _fetch_cnn()
    if raw:
        all_hist = _build_history_from_cnn(raw)
        # Trim to requested period
        if period == "1m":
            history = all_hist[-21:]
        elif period == "3m":
            history = all_hist[-63:]
        elif period == "ytd":
            ytd_start = f"{datetime.now().year}-01-01"
            history   = [h for h in all_hist if h["time"] >= ytd_start]
        else:
            history = all_hist  # CNN returns ~1y by default
    else:
        source  = "synthetic"
        history = _synthetic_history(period)

    current_val = history[-1]["value"] if history else 50.0
    result = {
        "history":   history,
        "current":   current_val,
        "zone":      _zone_from_value(current_val),
        "label":     ZONE_LABELS[_zone_from_value(current_val)],
        "period":    period,
        "count":     len(history),
        "source":    source,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    _cache_history.set(cache_key, result)
    return result
