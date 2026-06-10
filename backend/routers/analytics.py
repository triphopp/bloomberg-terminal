"""
Analytics router — quantitative functions for the terminal command system.

Endpoints (all GET):
  /api/analytics/corr      Pearson correlation between two symbols
  /api/analytics/beta      Beta vs benchmark
  /api/analytics/vol       Annualised historical volatility
  /api/analytics/return    Total return for period
  /api/analytics/drawdown  Maximum drawdown
  /api/analytics/sharpe    Sharpe ratio  (rf = 4.3 % annualised T-bill)
  /api/analytics/zscore    Z-score of current price vs rolling window
  /api/analytics/compare   Side-by-side table for N symbols
  /api/analytics/rank      compare + sort by chosen metric
  /api/analytics/rsi       RSI (Wilder smoothing)

All computation is done on log-returns of adjusted daily closes from yfinance.
Results are cached via TTLCache.get_or_set — stampede-safe.
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np
import yfinance as yf
import pandas as pd
from fastapi import APIRouter, Query, HTTPException

from cache import TTLCache

router = APIRouter(prefix="/api/analytics", tags=["analytics"])
_cache = TTLCache(ttl=300, maxsize=200)   # 5-min cache, analytics can be slow

# ── Risk-free rate (US 3-month T-bill proxy, annualised) ─────────────────────
_RF_ANNUAL = 0.043   # update occasionally; not worth a live fetch

# ── Period mapping  user-facing → yfinance ───────────────────────────────────
_PERIOD_MAP: dict[str, str] = {
    "1d": "5d",    "5d": "5d",    "1w": "5d",
    "2w": "1mo",   "1m": "1mo",   "2m": "2mo",
    "3m": "3mo",   "6m": "6mo",   "1y": "1y",
    "2y": "2y",    "3y": "3y",    "5y": "5y",   "10y": "10y",
}


def _yf_period(p: str) -> str:
    return _PERIOD_MAP.get(p.lower(), "1y")


# ── Core data helpers ─────────────────────────────────────────────────────────

def _closes(symbol: str, period: str) -> pd.Series:
    """Download adjusted daily closes; raise ValueError if empty."""
    df = yf.download(symbol, period=_yf_period(period),
                     auto_adjust=True, progress=False, threads=False)
    if df.empty:
        raise ValueError(f"No data for {symbol!r}")
    col = df["Close"] if "Close" in df.columns else df.iloc[:, 0]
    s = col.squeeze().dropna()
    if len(s) < 3:
        raise ValueError(f"Too little data for {symbol!r} ({len(s)} rows)")
    return s


def _log_returns(closes: pd.Series) -> np.ndarray:
    arr = closes.values.astype(float)
    return np.log(arr[1:] / arr[:-1])


def _p_value(r: float, n: int) -> float:
    """Two-tailed p-value for Pearson r (t-distribution approximation)."""
    if n <= 2 or abs(r) >= 1.0:
        return 0.0
    t = r * math.sqrt(n - 2) / math.sqrt(1.0 - r ** 2)
    # Normal approximation — accurate enough for n > 20
    z = abs(t)
    p = 2.0 * (1.0 - 0.5 * (1.0 + math.erf(z / math.sqrt(2.0))))
    return max(0.0, min(1.0, p))


def _annualised_vol(log_ret: np.ndarray) -> float:
    return float(np.std(log_ret, ddof=1) * math.sqrt(252))


def _total_return(closes: pd.Series) -> float:
    arr = closes.values.astype(float)
    return float((arr[-1] - arr[0]) / arr[0])


def _max_drawdown(closes: pd.Series) -> tuple[float, str]:
    """Returns (max_drawdown_fraction, trough_date_str)."""
    arr = closes.values.astype(float)
    peak = arr[0]
    max_dd = 0.0
    trough_idx = 0
    peak_run = arr[0]
    for i, v in enumerate(arr):
        if v > peak_run:
            peak_run = v
        dd = (peak_run - v) / peak_run
        if dd > max_dd:
            max_dd = dd
            trough_idx = i
    trough_date = str(closes.index[trough_idx].date()) if hasattr(closes.index[trough_idx], "date") else ""
    return float(max_dd), trough_date


def _sharpe(log_ret: np.ndarray) -> float:
    """Annualised Sharpe ratio."""
    ann_ret = float(np.mean(log_ret) * 252)
    ann_vol = _annualised_vol(log_ret)
    if ann_vol == 0:
        return 0.0
    return (ann_ret - _RF_ANNUAL) / ann_vol


def _rsi_value(closes: pd.Series, window: int = 14) -> float:
    """Wilder RSI of the last data point."""
    arr = closes.values.astype(float)
    if len(arr) < window + 1:
        return float("nan")
    deltas = np.diff(arr)
    gains  = np.where(deltas > 0,  deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)

    avg_g = float(np.mean(gains[:window]))
    avg_l = float(np.mean(losses[:window]))
    for i in range(window, len(gains)):
        avg_g = (avg_g * (window - 1) + gains[i]) / window
        avg_l = (avg_l * (window - 1) + losses[i]) / window

    if avg_l == 0.0:
        return 100.0
    rs = avg_g / avg_l
    return round(100.0 - 100.0 / (1.0 + rs), 2)


# ── Per-symbol summary (used by compare + rank) ───────────────────────────────

def _symbol_summary(symbol: str, period: str) -> dict:
    closes  = _closes(symbol, period)
    log_ret = _log_returns(closes)
    ret     = _total_return(closes)
    vol     = _annualised_vol(log_ret)
    sharpe  = _sharpe(log_ret)
    dd, _   = _max_drawdown(closes)
    return {
        "symbol":   symbol,
        "return":   round(ret,    4),
        "vol":      round(vol,    4),
        "sharpe":   round(sharpe, 4),
        "drawdown": round(-dd,    4),   # stored as negative fraction
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/corr")
def get_corr(
    a:      str = Query(..., description="First symbol"),
    b:      str = Query(..., description="Second symbol"),
    period: str = Query("3m"),
):
    """Pearson correlation of log-returns between a and b."""
    key = f"corr:{a}:{b}:{period}"

    def compute():
        ca = _closes(a, period)
        cb = _closes(b, period)
        idx = ca.index.intersection(cb.index)
        if len(idx) < 5:
            raise ValueError(f"Only {len(idx)} overlapping trading days")
        ra = _log_returns(ca.loc[idx])
        rb = _log_returns(cb.loc[idx])
        n  = min(len(ra), len(rb))
        ra, rb = ra[:n], rb[:n]
        r  = float(np.corrcoef(ra, rb)[0, 1])
        p  = _p_value(r, n)
        return {"correlation": round(r, 6), "p_value": round(p, 6), "n": n,
                "a": a.upper(), "b": b.upper(), "period": period}

    try:
        return _cache.get_or_set(key, compute)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.get("/beta")
def get_beta(
    asset:     str = Query(...),
    benchmark: str = Query("^GSPC"),
    period:    str = Query("1y"),
):
    """Beta, alpha, R² of asset vs benchmark (OLS on log-returns)."""
    key = f"beta:{asset}:{benchmark}:{period}"

    def compute():
        ca = _closes(asset,     period)
        cb = _closes(benchmark, period)
        idx = ca.index.intersection(cb.index)
        if len(idx) < 5:
            raise ValueError(f"Only {len(idx)} overlapping trading days")
        ra = _log_returns(ca.loc[idx])
        rb = _log_returns(cb.loc[idx])
        n  = min(len(ra), len(rb))
        ra, rb = ra[:n], rb[:n]
        # OLS: ra = alpha + beta * rb
        cov_matrix = np.cov(ra, rb)
        beta  = float(cov_matrix[0, 1] / cov_matrix[1, 1]) if cov_matrix[1, 1] != 0 else 0.0
        alpha = float(np.mean(ra) - beta * np.mean(rb))
        r2    = float(np.corrcoef(ra, rb)[0, 1] ** 2)
        return {"beta": round(beta, 4), "alpha": round(alpha, 6),
                "r2": round(r2, 4), "n": n,
                "asset": asset.upper(), "benchmark": benchmark.upper(), "period": period}

    try:
        return _cache.get_or_set(key, compute)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.get("/vol")
def get_vol(
    symbol: str = Query(...),
    period: str = Query("1y"),
):
    """Annualised historical volatility (std of log-returns × √252)."""
    key = f"vol:{symbol}:{period}"

    def compute():
        closes  = _closes(symbol, period)
        log_ret = _log_returns(closes)
        ann_vol = _annualised_vol(log_ret)
        daily   = float(np.std(log_ret, ddof=1))
        return {"annualised_vol": round(ann_vol, 6), "daily_std": round(daily, 6),
                "n": len(log_ret), "symbol": symbol.upper(), "period": period}

    try:
        return _cache.get_or_set(key, compute)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.get("/return")
def get_return(
    symbol: str = Query(...),
    period: str = Query("1y"),
):
    """Total price return for the period."""
    key = f"return:{symbol}:{period}"

    def compute():
        closes = _closes(symbol, period)
        ret    = _total_return(closes)
        start  = str(closes.index[0].date())  if hasattr(closes.index[0],  "date") else ""
        end    = str(closes.index[-1].date()) if hasattr(closes.index[-1], "date") else ""
        return {"return": round(ret, 6), "start_price": round(float(closes.iloc[0]), 4),
                "end_price": round(float(closes.iloc[-1]), 4),
                "start_date": start, "end_date": end,
                "symbol": symbol.upper(), "period": period}

    try:
        return _cache.get_or_set(key, compute)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.get("/drawdown")
def get_drawdown(
    symbol: str = Query(...),
    period: str = Query("1y"),
):
    """Maximum drawdown (peak-to-trough) for the period."""
    key = f"drawdown:{symbol}:{period}"

    def compute():
        closes = _closes(symbol, period)
        dd, trough = _max_drawdown(closes)
        return {"max_drawdown": round(-dd, 6), "trough_date": trough,
                "symbol": symbol.upper(), "period": period}

    try:
        return _cache.get_or_set(key, compute)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.get("/sharpe")
def get_sharpe(
    symbol: str = Query(...),
    period: str = Query("1y"),
):
    """Annualised Sharpe ratio (rf = 4.3 %)."""
    key = f"sharpe:{symbol}:{period}"

    def compute():
        closes  = _closes(symbol, period)
        log_ret = _log_returns(closes)
        s       = _sharpe(log_ret)
        ann_ret = float(np.mean(log_ret) * 252)
        ann_vol = _annualised_vol(log_ret)
        return {"sharpe": round(s, 4), "annualised_return": round(ann_ret, 4),
                "annualised_vol": round(ann_vol, 4), "rf": _RF_ANNUAL,
                "n": len(log_ret), "symbol": symbol.upper(), "period": period}

    try:
        return _cache.get_or_set(key, compute)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.get("/zscore")
def get_zscore(
    symbol: str = Query(...),
    period: str = Query("1y"),
):
    """Z-score of current price relative to period closing prices."""
    key = f"zscore:{symbol}:{period}"

    def compute():
        closes = _closes(symbol, period)
        arr    = closes.values.astype(float)
        mean   = float(np.mean(arr))
        std    = float(np.std(arr, ddof=1))
        z      = (arr[-1] - mean) / std if std > 0 else 0.0
        return {"zscore": round(z, 4), "current": round(arr[-1], 4),
                "mean": round(mean, 4), "std": round(std, 4),
                "n": len(arr), "symbol": symbol.upper(), "period": period}

    try:
        return _cache.get_or_set(key, compute)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.get("/rsi")
def get_rsi(
    symbol: str  = Query(...),
    window: int  = Query(14, ge=2, le=50),
):
    """RSI (Wilder smoothing) using last 6 months of data."""
    key = f"rsi:{symbol}:{window}"

    def compute():
        closes = _closes(symbol, "6m")
        rsi    = _rsi_value(closes, window)
        label  = ("OVERBOUGHT" if rsi >= 70 else
                  "OVERSOLD"   if rsi <= 30 else "NEUTRAL")
        return {"rsi": rsi, "window": window, "label": label,
                "symbol": symbol.upper()}

    try:
        return _cache.get_or_set(key, compute)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.get("/compare")
def get_compare(
    symbols: str = Query(..., description="Comma-separated symbols"),
    period:  str = Query("1y"),
):
    """Side-by-side metrics table for multiple symbols."""
    sym_list = [s.strip().upper() for s in symbols.split(",") if s.strip()][:8]
    if len(sym_list) < 1:
        raise HTTPException(status_code=422, detail="At least 1 symbol required")

    key = f"compare:{','.join(sorted(sym_list))}:{period}"

    def compute():
        rows = []
        errors = []
        for sym in sym_list:
            try:
                rows.append(_symbol_summary(sym, period))
            except Exception as e:
                errors.append(f"{sym}: {e}")
        # Sort by return descending
        rows.sort(key=lambda r: r["return"], reverse=True)
        return {"rows": rows, "period": period, "errors": errors}

    try:
        return _cache.get_or_set(key, compute)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/rank")
def get_rank(
    symbols: str = Query(..., description="Comma-separated symbols"),
    by:      str = Query("return", description="return | vol | sharpe | drawdown"),
    period:  str = Query("1y"),
):
    """compare + sorted by chosen metric."""
    valid_metrics = {"return", "vol", "sharpe", "drawdown"}
    if by not in valid_metrics:
        raise HTTPException(status_code=422, detail=f"'by' must be one of {valid_metrics}")

    sym_list = [s.strip().upper() for s in symbols.split(",") if s.strip()][:8]
    key = f"rank:{','.join(sorted(sym_list))}:{by}:{period}"

    def compute():
        rows = []
        for sym in sym_list:
            try:
                rows.append(_symbol_summary(sym, period))
            except Exception:
                pass
        reverse = by != "drawdown"   # drawdown: smaller absolute = better → ascending
        rows.sort(key=lambda r: r[by], reverse=reverse)
        return {"rows": rows, "by": by, "period": period}

    try:
        return _cache.get_or_set(key, compute)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
