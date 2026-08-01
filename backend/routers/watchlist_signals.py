"""
Watchlist technical scanner — batch indicator states for decision support.

GET /api/watchlist/signals?symbols=AAPL,MSFT,NVDA

One yfinance batch download per request (cached 15 min) covering every symbol,
then a fixed indicator panel computed per symbol on DAILY bars:

    trend     EMA20/50/200 stack + slope        UP / DOWN / FLAT
    rsi       Wilder RSI(14)                    OB (>=70) / OS (<=30) / NEUTRAL
    rvol      volume / 20d average volume       SPIKE at >= 2.0, QUIET at <= 0.5
    macd      MACD(12,26,9) histogram sign      BULL / BEAR + bars since the cross
    breakout  20d Donchian channel break        UP / DOWN / NONE
    range52w  position inside the 52w range     0..1 (HIGH >= 0.95, LOW <= 0.05)
    atr       ATR(14) as % of price             volatility budget for stops

Each symbol also gets a composite `score` in [-6, +6] and a `flags` list naming
the conditions that fired, so the UI can rank rows without re-deriving anything.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

import numpy as np
import pandas as pd
import yfinance as yf
from fastapi import APIRouter, HTTPException, Query

from cache import TTLCache

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/watchlist", tags=["Watchlist"])

# Daily signals only shift once per session; 15 min keeps a busy watchlist off
# yfinance without ever showing yesterday's state.
_cache = TTLCache(ttl=900, maxsize=200)

MAX_SYMBOLS = 60
_LOOKBACK = "2y"  # enough for EMA200 to be defined with room to spare

RSI_PERIOD = 14
ATR_PERIOD = 14
DONCHIAN = 20
RVOL_WINDOW = 20

RSI_OVERBOUGHT = 70.0
RSI_OVERSOLD = 30.0
RVOL_SPIKE = 2.0
RVOL_QUIET = 0.5
RANGE_HIGH = 0.95
RANGE_LOW = 0.05


# ── Indicator math ────────────────────────────────────────────────────────────


def _ema(values: pd.Series, period: int) -> Optional[float]:
    if len(values) < period:
        return None
    return float(values.ewm(span=period, adjust=False).mean().iloc[-1])


def _ema_series(values: pd.Series, period: int) -> pd.Series:
    return values.ewm(span=period, adjust=False).mean()


def _rsi(closes: pd.Series, period: int = RSI_PERIOD) -> Optional[float]:
    """Wilder RSI of the last bar. Mirrors analytics._rsi_value."""
    arr = closes.to_numpy(dtype=float)
    if len(arr) < period + 1:
        return None
    deltas = np.diff(arr)
    gains = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)

    avg_g = float(np.mean(gains[:period]))
    avg_l = float(np.mean(losses[:period]))
    for i in range(period, len(gains)):
        avg_g = (avg_g * (period - 1) + gains[i]) / period
        avg_l = (avg_l * (period - 1) + losses[i]) / period

    if avg_l == 0.0:
        return 100.0
    rs = avg_g / avg_l
    return round(100.0 - 100.0 / (1.0 + rs), 2)


def _atr_pct(high: pd.Series, low: pd.Series, close: pd.Series) -> Optional[float]:
    """ATR(14) expressed as a percentage of the last close."""
    if len(close) < ATR_PERIOD + 1:
        return None
    prev_close = close.shift(1)
    tr = pd.concat(
        [high - low, (high - prev_close).abs(), (low - prev_close).abs()], axis=1
    ).max(axis=1)
    atr = float(tr.ewm(alpha=1 / ATR_PERIOD, adjust=False).mean().iloc[-1])
    last = float(close.iloc[-1])
    if last <= 0:
        return None
    return round(atr / last * 100, 2)


def _macd_state(closes: pd.Series) -> dict[str, Any]:
    """Histogram sign plus how many bars ago it last flipped."""
    if len(closes) < 35:
        return {"state": "NONE", "barsSinceCross": None, "hist": None}
    macd_line = _ema_series(closes, 12) - _ema_series(closes, 26)
    hist = macd_line - _ema_series(macd_line, 9)
    signs = np.sign(hist.to_numpy(dtype=float))
    last_sign = signs[-1]
    if last_sign == 0:
        return {"state": "NONE", "barsSinceCross": None, "hist": round(float(hist.iloc[-1]), 4)}

    bars = 0
    for s in signs[-2::-1]:
        if s == last_sign or s == 0:
            bars += 1
            continue
        break
    else:
        # Never flipped inside the window — report it as "at least this long".
        bars = len(signs) - 1

    return {
        "state": "BULL" if last_sign > 0 else "BEAR",
        "barsSinceCross": bars,
        "hist": round(float(hist.iloc[-1]), 4),
    }


def _trend_state(close: float, e20: Optional[float], e50: Optional[float]) -> str:
    """UP/DOWN need price on the same side of BOTH EMAs and the EMAs stacked."""
    if e20 is None or e50 is None:
        return "FLAT"
    if close > e20 and e20 > e50:
        return "UP"
    if close < e20 and e20 < e50:
        return "DOWN"
    return "FLAT"


# ── Per-symbol scan ───────────────────────────────────────────────────────────


def _scan(df: pd.DataFrame) -> Optional[dict[str, Any]]:
    """Compute the full signal panel for one symbol's OHLCV frame."""
    df = df.dropna(subset=["Close"])
    if len(df) < 30:
        return None

    close = df["Close"].astype(float)
    high = df["High"].astype(float)
    low = df["Low"].astype(float)
    volume = df["Volume"].astype(float) if "Volume" in df else pd.Series(dtype=float)

    last = float(close.iloc[-1])
    e20, e50, e200 = _ema(close, 20), _ema(close, 50), _ema(close, 200)
    trend = _trend_state(last, e20, e50)

    rsi = _rsi(close)
    rsi_state = "NEUTRAL"
    if rsi is not None:
        rsi_state = "OB" if rsi >= RSI_OVERBOUGHT else "OS" if rsi <= RSI_OVERSOLD else "NEUTRAL"

    # RVOL vs the trailing average EXCLUDING today, so a spike can't dilute its
    # own baseline.
    rvol = None
    if len(volume) > RVOL_WINDOW:
        baseline = float(volume.iloc[-(RVOL_WINDOW + 1) : -1].mean())
        if baseline > 0:
            rvol = round(float(volume.iloc[-1]) / baseline, 2)

    macd = _macd_state(close)

    # Donchian break measured against the PRIOR 20 bars — comparing today's close
    # to a window that contains it would make a break impossible.
    breakout = "NONE"
    don_hi = don_lo = None
    if len(close) > DONCHIAN + 1:
        window_hi = high.iloc[-(DONCHIAN + 1) : -1]
        window_lo = low.iloc[-(DONCHIAN + 1) : -1]
        don_hi, don_lo = float(window_hi.max()), float(window_lo.min())
        if last > don_hi:
            breakout = "UP"
        elif last < don_lo:
            breakout = "DOWN"

    # 52w position from daily bars (not the quote's own 52w fields, so every
    # symbol uses the same definition).
    tail = close.iloc[-252:] if len(close) >= 252 else close
    hi52, lo52 = float(tail.max()), float(tail.min())
    pos52 = round((last - lo52) / (hi52 - lo52), 4) if hi52 > lo52 else None

    atr_pct = _atr_pct(high, low, close)

    # ── Composite score ──
    score = 0
    flags: list[str] = []

    if trend == "UP":
        score += 2
        flags.append("TREND_UP")
    elif trend == "DOWN":
        score -= 2
        flags.append("TREND_DOWN")

    if e50 is not None and e200 is not None:
        if e50 > e200:
            score += 1
            flags.append("GOLDEN_CROSS")
        else:
            score -= 1
            flags.append("DEATH_CROSS")

    if rsi_state == "OB":
        score -= 1
        flags.append("RSI_OVERBOUGHT")
    elif rsi_state == "OS":
        score += 1
        flags.append("RSI_OVERSOLD")

    if macd["state"] == "BULL":
        score += 1
    elif macd["state"] == "BEAR":
        score -= 1
    if macd["barsSinceCross"] is not None and macd["barsSinceCross"] <= 3:
        flags.append("MACD_CROSS_FRESH")

    if breakout == "UP":
        score += 1
        flags.append("BREAKOUT_UP")
    elif breakout == "DOWN":
        score -= 1
        flags.append("BREAKDOWN")

    if rvol is not None:
        if rvol >= RVOL_SPIKE:
            flags.append("VOL_SPIKE")
        elif rvol <= RVOL_QUIET:
            flags.append("VOL_QUIET")

    if pos52 is not None:
        if pos52 >= RANGE_HIGH:
            flags.append("NEAR_52W_HIGH")
        elif pos52 <= RANGE_LOW:
            flags.append("NEAR_52W_LOW")

    # Last bar's date — when it is today the session is still open, so `rvol`
    # only counts volume so far and the UI should not read it as "quiet".
    idx = df.index[-1]
    as_of = str(idx.date()) if hasattr(idx, "date") else str(idx)

    return {
        "asOf": as_of,
        "trend": {
            "state": trend,
            "ema20": round(e20, 2) if e20 is not None else None,
            "ema50": round(e50, 2) if e50 is not None else None,
            "ema200": round(e200, 2) if e200 is not None else None,
        },
        "rsi": {"value": rsi, "state": rsi_state},
        "rvol": rvol,
        "macd": macd,
        "breakout": {"state": breakout, "high": don_hi, "low": don_lo},
        "range52w": {"pct": pos52, "high": round(hi52, 2), "low": round(lo52, 2)},
        "atrPct": atr_pct,
        "score": score,
        "flags": flags,
    }


# ── Batch download ────────────────────────────────────────────────────────────


def _download(symbols: list[str]) -> dict[str, pd.DataFrame]:
    """One yfinance call for the whole list → {symbol: OHLCV frame}."""
    raw = yf.download(
        symbols,
        period=_LOOKBACK,
        interval="1d",
        auto_adjust=True,
        progress=False,
        threads=True,
        group_by="ticker",
    )
    if raw is None or raw.empty:
        return {}

    # Older yfinance versions returned a flat frame for a single symbol and
    # only used a 2-level column MultiIndex for several. The installed
    # version now returns a MultiIndex even for one symbol, so check the
    # actual shape instead of trusting len(symbols) == 1.
    if not isinstance(raw.columns, pd.MultiIndex):
        return {symbols[0]: raw}
    if len(symbols) == 1:
        return {symbols[0]: raw.droplevel(0, axis=1)}
    out: dict[str, pd.DataFrame] = {}
    for sym in symbols:
        if sym in raw.columns.get_level_values(0):
            out[sym] = raw[sym]
    return out


@router.get("/signals")
def get_watchlist_signals(
    symbols: str = Query(..., description="Comma-separated symbols"),
):
    """Batch daily-timeframe indicator scan for a watchlist."""
    sym_list = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    # Preserve caller order but drop duplicates.
    sym_list = list(dict.fromkeys(sym_list))[:MAX_SYMBOLS]
    if not sym_list:
        raise HTTPException(status_code=422, detail="At least 1 symbol required")

    key = f"signals:{','.join(sorted(sym_list))}"
    cached = _cache.get(key)
    if cached is not None:
        return cached

    try:
        frames = _download(sym_list)
    except Exception as exc:
        logger.exception("watchlist signal download failed")
        raise HTTPException(status_code=502, detail=f"Price download failed: {exc}")

    results: dict[str, Any] = {}
    errors: list[str] = []
    for sym in sym_list:
        df = frames.get(sym)
        if df is None or df.empty:
            errors.append(f"{sym}: no data")
            continue
        try:
            scan = _scan(df)
        except Exception as exc:
            logger.warning("scan failed for %s: %s", sym, exc)
            errors.append(f"{sym}: {exc}")
            continue
        if scan is None:
            errors.append(f"{sym}: insufficient history")
            continue
        results[sym] = scan

    payload = {"signals": results, "errors": errors, "count": len(results)}
    _cache.set(key, payload)
    return payload
