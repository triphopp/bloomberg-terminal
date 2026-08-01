"""
Alert Rule Engine — indicator series for IndicatorOperand resolution.

Phase-2/3 subset (rsi, ema, macd histogram, rvol, bollinger family) — the
set that memory/plans/alert-rule-engine.md §12 phase 3 wires alert labels up
to (components/bloomberg/chart/indicators/alertLabels.ts). RSI/EMA/MACD/RVOL
math mirrors routers/watchlist_signals.py exactly; the Bollinger math mirrors
components/bloomberg/chart/indicators/{bollinger,bollinger-b,bollinger-width}.ts
(population std — divide by `period`, not `period - 1` — same as the
frontend's manual variance calc) so a label's reading matches what the chart
already shows for the same symbol.
"""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from .eval import Bars, IndicatorResolver


def _ema_series(values: pd.Series, period: int) -> pd.Series:
    return values.ewm(span=period, adjust=False).mean()


def _rsi_series(closes: pd.Series, period: int) -> np.ndarray:
    """Wilder RSI, full series. watchlist_signals._rsi computes only the
    last value; the AST evaluator needs every bar (NaN during warm-up)."""
    arr = closes.to_numpy(dtype=float)
    out = np.full(len(arr), np.nan)
    if len(arr) < period + 1:
        return out
    deltas = np.diff(arr)
    gains = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)
    avg_g = float(np.mean(gains[:period]))
    avg_l = float(np.mean(losses[:period]))
    out[period] = 100.0 if avg_l == 0 else 100.0 - 100.0 / (1.0 + avg_g / avg_l)
    for i in range(period, len(gains)):
        avg_g = (avg_g * (period - 1) + gains[i]) / period
        avg_l = (avg_l * (period - 1) + losses[i]) / period
        out[i + 1] = 100.0 if avg_l == 0 else 100.0 - 100.0 / (1.0 + avg_g / avg_l)
    return out


def _macd_hist_series(closes: pd.Series, fast: int, slow: int, signal: int) -> np.ndarray:
    macd_line = _ema_series(closes, fast) - _ema_series(closes, slow)
    hist = macd_line - _ema_series(macd_line, signal)
    return hist.to_numpy(dtype=float)


def _rvol_series(volume: pd.Series, lookback: int) -> np.ndarray:
    # trailing average EXCLUDING today (shift(1)), same as watchlist_signals —
    # otherwise a spike bar dilutes its own baseline.
    baseline = volume.rolling(lookback).mean().shift(1)
    return (volume / baseline).to_numpy(dtype=float)


def _sma_series(values: pd.Series, period: int) -> pd.Series:
    return values.rolling(period).mean()


def _bollinger_bands(close: pd.Series, period: int, std_dev: float) -> tuple[pd.Series, pd.Series, pd.Series]:
    """(middle, upper, lower). ddof=0 (population std, divide by N) to match
    the frontend's manual `variance = sum((v-mean)**2) / period` — pandas
    defaults to ddof=1 (sample std, divide by N-1), which would silently
    disagree with the chart by a few percent."""
    middle = _sma_series(close, period)
    std = close.rolling(period).std(ddof=0)
    dev = std_dev * std
    return middle, middle + dev, middle - dev


def _bollinger_b_series(close: pd.Series, period: int, std_dev: float) -> np.ndarray:
    middle, upper, lower = _bollinger_bands(close, period, std_dev)
    bandwidth = upper - lower
    # bandwidth==0 (flat price for a full period) -> NaN, i.e. invalid, not a
    # fabricated 0.5 — the frontend's chart rendering defaults to 0.5 there
    # for display continuity, but an alert should never fire off a made-up value.
    b = (close - lower) / bandwidth.replace(0, np.nan)
    return b.to_numpy(dtype=float)


def _bb_width_series(close: pd.Series, period: int, std_dev: float) -> np.ndarray:
    middle, upper, lower = _bollinger_bands(close, period, std_dev)
    width = (upper - lower) / middle.abs()
    return width.to_numpy(dtype=float)


def _stochastic_series(
    high: pd.Series, low: pd.Series, close: pd.Series, k_period: int, d_period: int, smooth: int
) -> tuple[np.ndarray, np.ndarray]:
    """(%K, %D). Matches chart/indicators/stochastic.ts: raw %K smoothed by
    an SMA(smooth), then %D = SMA(%K, d_period). A zero range (flat high==low
    for the whole window) reads as 50 — dead center, not a divide-by-zero."""
    lowest_low = low.rolling(k_period).min()
    highest_high = high.rolling(k_period).max()
    rng = highest_high - lowest_low
    pct = (close - lowest_low) / rng.replace(0, np.nan) * 100.0
    raw_k = pct.fillna(50.0)
    # ...except where the rolling window itself hasn't formed yet — that's a
    # real "not computable", not a flat-range 50.
    raw_k[lowest_low.isna()] = np.nan
    smoothed_k = raw_k.rolling(smooth).mean()
    d = smoothed_k.rolling(d_period).mean()
    return smoothed_k.to_numpy(dtype=float), d.to_numpy(dtype=float)


_SUPPORTED = (
    "rsi", "ema", "sma", "macd", "rvol", "stochastic",
    "bollinger", "bollinger-b", "bb-width",
)


def make_resolver(bars: Bars) -> IndicatorResolver:
    """IndicatorResolver closure bound to one symbol's bars. Unknown
    indicator ids raise rather than silently returning all-NaN — a rule
    referencing an indicator this phase hasn't wired up yet should fail
    loudly at scan time, not evaluate to 'always invalid'."""
    close = pd.Series(bars.close)
    high = pd.Series(bars.high)
    low = pd.Series(bars.low)
    volume = pd.Series(bars.volume)

    def resolve(indicator_id: str, params: dict[str, Any], output: str) -> np.ndarray:
        if indicator_id == "rsi":
            return _rsi_series(close, int(params.get("period", 14)))
        if indicator_id == "ema":
            return _ema_series(close, int(params.get("period", 20))).to_numpy(dtype=float)
        if indicator_id == "sma":
            return _sma_series(close, int(params.get("period", 20))).to_numpy(dtype=float)
        if indicator_id == "stochastic" and output in ("k", "d"):
            k, d = _stochastic_series(
                high, low, close,
                int(params.get("kPeriod", 14)), int(params.get("dPeriod", 3)), int(params.get("smooth", 3)),
            )
            return k if output == "k" else d
        if indicator_id == "macd" and output == "hist":
            return _macd_hist_series(
                close, int(params.get("fast", 12)), int(params.get("slow", 26)),
                int(params.get("signal", 9)),
            )
        if indicator_id == "rvol":
            return _rvol_series(volume, int(params.get("lookback", 20)))
        if indicator_id == "bollinger":
            period, std_dev = int(params.get("period", 20)), float(params.get("stdDev", 2))
            middle, upper, lower = _bollinger_bands(close, period, std_dev)
            if output == "upper":
                return upper.to_numpy(dtype=float)
            if output == "middle":
                return middle.to_numpy(dtype=float)
            if output == "lower":
                return lower.to_numpy(dtype=float)
        if indicator_id == "bollinger-b" and output == "b":
            return _bollinger_b_series(close, int(params.get("period", 20)), float(params.get("stdDev", 2)))
        if indicator_id == "bb-width" and output == "width":
            return _bb_width_series(close, int(params.get("period", 20)), float(params.get("stdDev", 2)))
        raise ValueError(
            f"indicator '{indicator_id}'.{output} isn't wired up yet — supported: "
            f"{', '.join(_SUPPORTED)} (phase 3 adds the full registry)"
        )

    return resolve
