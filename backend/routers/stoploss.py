"""
Stop Loss Engine — ATR-adaptive + Exceedance Correlation Regime

GET /api/stoploss/regime   — market regime via exceedance correlation (Longin & Solnik 2001)
GET /api/stoploss/atr      — adaptive ATR + vol percentile + trend factor per symbol
"""
from __future__ import annotations

import math
import threading
import time
from typing import Any

import numpy as np
import pandas as pd
import yfinance as yf
from fastapi import APIRouter, Query

from routers.risk import _get_yf_symbol

router = APIRouter(prefix="/api/stoploss", tags=["stoploss"])

# ── Cache ─────────────────────────────────────────────────────────────────────

_cache: dict[str, tuple[float, Any]] = {}
_lock = threading.Lock()
_TTL = 300  # 5 min


def _get_cached(key: str, factory):
    now = time.time()
    with _lock:
        if key in _cache and now - _cache[key][0] < _TTL:
            return _cache[key][1]
    val = factory()
    with _lock:
        _cache[key] = (now, val)
    return val


# ── Regime constants ──────────────────────────────────────────────────────────

REGIME_PARAMS = {
    "CRISIS":    {"base_mult": 1.5, "buffer": 0.25, "n_bars": 1, "color": "#FF4444"},
    "RISK-OFF":  {"base_mult": 2.0, "buffer": 0.50, "n_bars": 2, "color": "#FF9800"},
    "TRENDING":  {"base_mult": 2.5, "buffer": 0.50, "n_bars": 2, "color": "#FFD700"},
    "DIVERGENT": {"base_mult": 3.0, "buffer": 1.00, "n_bars": 3, "color": "#00FF88"},
}

REGIME_ASSETS = ["SPY", "TLT", "GLD", "BTC-USD"]  # ^VIX fetched separately


# ── Helpers ───────────────────────────────────────────────────────────────────

def _fetch_close(symbols: list[str], days: int = 252) -> pd.DataFrame:
    try:
        raw = yf.download(
            symbols, period=f"{int(days * 1.5 / 252 * 365)}d",
            interval="1d", auto_adjust=True, progress=False, threads=True,
        )
        if raw.empty:
            return pd.DataFrame()
        close = raw["Close"] if isinstance(raw.columns, pd.MultiIndex) else raw
        if not hasattr(close, "columns"):
            close = close.to_frame(name=symbols[0])
        return close.dropna(how="all")
    except Exception:
        return pd.DataFrame()


def _fetch_ohlc(symbol: str, days: int = 60) -> pd.DataFrame:
    try:
        raw = yf.download(
            symbol, period=f"{days}d",
            interval="1d", auto_adjust=True, progress=False,
        )
        if raw.empty:
            return pd.DataFrame()
        if isinstance(raw.columns, pd.MultiIndex):
            raw.columns = raw.columns.get_level_values(0)
        return raw[["High", "Low", "Close"]].dropna()
    except Exception:
        return pd.DataFrame()


def _vix_percentile(days: int = 252) -> float:
    """Returns VIX percentile rank in [0, 1] over last `days` trading days."""
    try:
        raw = yf.download("^VIX", period=f"{int(days * 1.5 / 252 * 365)}d",
                          interval="1d", auto_adjust=True, progress=False)
        if raw.empty:
            return 0.5
        close = raw["Close"] if "Close" in raw.columns else raw.iloc[:, 0]
        close = close.dropna()
        if len(close) < 10:
            return 0.5
        series = close.values[-days:]
        current = float(series[-1])
        pct = float(np.sum(series < current) / len(series))
        return round(pct, 4)
    except Exception:
        return 0.5


def _atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int) -> float:
    """Wilder ATR. Returns last ATR value."""
    n = len(close)
    if n < period + 1:
        return float(np.mean(high[-period:] - low[-period:]))
    tr = np.maximum(
        high[1:] - low[1:],
        np.maximum(
            np.abs(high[1:] - close[:-1]),
            np.abs(low[1:] - close[:-1]),
        )
    )
    # Wilder smoothing
    atr_val = float(np.mean(tr[:period]))
    for i in range(period, len(tr)):
        atr_val = (atr_val * (period - 1) + tr[i]) / period
    return round(atr_val, 6)


def _vol_percentile(close: np.ndarray, window: int = 252) -> float:
    """Percentile rank of current 14d realized vol vs past `window` days."""
    if len(close) < 20:
        return 0.5
    ret = np.diff(np.log(close))
    if len(ret) < 14:
        return 0.5
    # rolling 14d vol
    vols = [float(np.std(ret[i:i+14])) for i in range(len(ret) - 13)]
    if len(vols) < 2:
        return 0.5
    current_vol = vols[-1]
    history = np.array(vols[-window:])
    pct = float(np.sum(history < current_vol) / len(history))
    return round(pct, 4)


def _trend_factor(close: np.ndarray) -> float:
    """SMA50/SMA200 trend filter → multiplier adjustment."""
    if len(close) < 50:
        return 1.0
    sma50 = float(np.mean(close[-50:]))
    sma200 = float(np.mean(close[-200:])) if len(close) >= 200 else sma50
    cur = float(close[-1])
    if cur > sma50 > sma200:
        return 1.3   # uptrend → wider trailing stop
    elif cur < sma50 < sma200:
        return 0.8   # downtrend → tighter stop, cut fast
    return 1.0


# ── Exceedance Correlation Regime ─────────────────────────────────────────────

def _exceedance_regime(vix_pct: float) -> dict:
    """
    Compute market regime from exceedance correlation (Longin & Solnik 2001).
    Uses Spearman corr on returns <= 10th percentile across SPY, TLT, GLD, BTC-USD.
    Higher avg exceedance corr = more crisis-like.
    """
    closes = _fetch_close(REGIME_ASSETS, days=252)
    if closes.empty or len(closes) < 20:
        label = "TRENDING"
        return {**REGIME_PARAMS[label], "regime_label": label,
                "exceedance_corr": None, "vix_percentile": vix_pct}

    available = [s for s in REGIME_ASSETS if s in closes.columns]
    if len(available) < 2:
        label = "TRENDING"
        return {**REGIME_PARAMS[label], "regime_label": label,
                "exceedance_corr": None, "vix_percentile": vix_pct}

    ret = closes[available].pct_change().dropna()

    # Exceedance tail: keep rows where AT LEAST ONE asset is <= its own 10th percentile.
    # NOTE: this is .any() ON PURPOSE — .all() across 4 assets yields ~0 rows (0.1^4),
    # forcing avg_corr=0 → always DIVERGENT. Do NOT "fix" to .all(). See stoploss_math.md §6.
    thresholds = ret.quantile(0.10)
    mask = (ret <= thresholds).any(axis=1)
    tail_ret = ret[mask]

    if len(tail_ret) < 5:
        avg_exc_corr = 0.0
    else:
        corr_matrix = tail_ret.corr(method="spearman")
        n = len(available)
        total, count = 0.0, 0
        for i in range(n):
            for j in range(i + 1, n):
                v = corr_matrix.iloc[i, j]
                if not math.isnan(v):
                    # Crisis = assets CO-CRASH (positive co-movement of losses).
                    # Use the positive part, not abs(): a negative pair (e.g. SPY↓/TLT↑
                    # flight-to-quality) means diversification is WORKING and must LOWER
                    # the crisis score — abs() wrongly counted it as crisis. Negative
                    # pairs contribute 0 but still count in the denominator, so active
                    # hedging dilutes the average → pushes toward DIVERGENT (wider stop).
                    total += max(float(v), 0.0)
                    count += 1
        avg_exc_corr = round(total / count, 4) if count else 0.0

    # VIX percentile adjusts threshold sensitivity
    # High VIX → lower threshold needed to trigger CRISIS
    vix_adj = avg_exc_corr * (1 + vix_pct * 0.3)

    if vix_adj > 0.70:
        label = "CRISIS"
    elif vix_adj > 0.50:
        label = "RISK-OFF"
    elif vix_adj > 0.30:
        label = "TRENDING"
    else:
        label = "DIVERGENT"

    return {
        **REGIME_PARAMS[label],
        "regime_label": label,
        "exceedance_corr": avg_exc_corr,
        "vix_percentile": vix_pct,
        "vix_adjusted_score": round(vix_adj, 4),
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/regime")
def get_regime():
    def compute():
        vix_pct = _vix_percentile(252)
        result = _exceedance_regime(vix_pct)
        return result
    return _get_cached("stoploss:regime", compute)


@router.get("/atr")
def get_atr(
    symbols: str = Query(..., description="Comma-separated symbols"),
    account_id: str = Query("dime", description="Account ID for symbol mapping"),
):
    sym_list = [s.strip() for s in symbols.split(",") if s.strip()]
    if not sym_list:
        return {"error": "No symbols provided", "results": {}}

    def compute():
        # Get VIX percentile to determine adaptive ATR period
        vix_pct = _vix_percentile(252)
        if vix_pct > 0.75:
            period = 10
        elif vix_pct > 0.50:
            period = 14
        elif vix_pct > 0.25:
            period = 21
        else:
            period = 30

        results = {}
        for sym in sym_list:
            yf_sym = _get_yf_symbol(sym, account_id)
            if not yf_sym:
                results[sym] = {"error": "Cannot map symbol"}
                continue

            # Need ~290 calendar days for SMA200 (200 trading days × 365/252)
            # plus buffer for vol percentile history
            ohlc = _fetch_ohlc(yf_sym, days=max(300, period + 10))
            if ohlc.empty or len(ohlc) < period + 2:
                results[sym] = {"error": "Insufficient data"}
                continue

            high  = ohlc["High"].values
            low   = ohlc["Low"].values
            close = ohlc["Close"].values

            atr_val      = _atr(high, low, close, period)
            vol_pct      = _vol_percentile(close, window=252)
            trend_f      = _trend_factor(close)
            current_price = float(close[-1])

            results[sym] = {
                "yf_symbol":      yf_sym,
                "atr":            round(atr_val, 6),
                "adaptive_period": period,
                "vix_percentile": vix_pct,
                "vol_percentile": vol_pct,
                "trend_factor":   trend_f,
                "current_price":  round(current_price, 6),
            }

        return {"vix_percentile": vix_pct, "adaptive_period": period, "results": results}

    cache_key = f"stoploss:atr:{','.join(sorted(sym_list))}:{account_id}"
    return _get_cached(cache_key, compute)


@router.get("/compute")
def compute_stops(
    symbols: str = Query(..., description="Comma-separated symbols"),
    account_id: str = Query("dime"),
    entry_prices: str = Query("", description="Comma-separated entry prices (optional, same order as symbols)"),
):
    """
    Convenience endpoint: fetch regime + ATR and return final stop prices.
    stop_dynamic = current_price - ATR * multiplier - buffer * ATR
    """
    sym_list = [s.strip() for s in symbols.split(",") if s.strip()]
    entry_list = [float(e) for e in entry_prices.split(",") if e.strip()] if entry_prices else []

    def compute():
        regime_data = get_regime()
        atr_data    = get_atr(symbols=symbols, account_id=account_id)

        base_mult  = regime_data.get("base_mult", 2.5)
        buffer_mult = regime_data.get("buffer", 0.5)
        vix_pct    = regime_data.get("vix_percentile", 0.5)
        n_bars     = regime_data.get("n_bars", 2)
        regime_label = regime_data.get("regime_label", "TRENDING")

        stops = {}
        for i, sym in enumerate(sym_list):
            atr_info = atr_data.get("results", {}).get(sym, {})
            if "error" in atr_info:
                stops[sym] = {"error": atr_info["error"]}
                continue

            atr       = atr_info["atr"]
            vol_pct   = atr_info["vol_percentile"]
            trend_f   = atr_info["trend_factor"]
            cur_price = atr_info["current_price"]

            dynamic_mult = (
                base_mult
                * (1.0 + vix_pct)
                * (0.5 + vol_pct)
                * trend_f
            )
            stop_dynamic = cur_price - atr * dynamic_mult - atr * buffer_mult
            # Floor at 0: with a large ATR relative to a low price the raw stop can go
            # negative, which is meaningless and makes dist_pct exceed 100%. Clamping to
            # 0 caps dist_pct at 100% automatically (stop=0 → dist=cur/cur=100%).
            stop_dynamic = max(stop_dynamic, 0.0)

            entry = entry_list[i] if i < len(entry_list) else None
            dist_pct = round((cur_price - stop_dynamic) / cur_price * 100, 2) if cur_price > 0 else None

            stops[sym] = {
                "current_price":   round(cur_price, 4),
                "stop_dynamic":    round(stop_dynamic, 4),
                "dist_pct":        dist_pct,
                "dynamic_mult":    round(dynamic_mult, 4),
                "atr":             round(atr, 6),
                "n_bars_trigger":  n_bars,
                "entry_price":     entry,
            }

        return {
            "regime_label":   regime_label,
            "vix_percentile": vix_pct,
            "stops":          stops,
        }

    cache_key = f"stoploss:compute:{','.join(sorted(sym_list))}:{account_id}"
    return _get_cached(cache_key, compute)
