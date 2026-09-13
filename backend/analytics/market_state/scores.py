"""
Trend, Momentum and Volatility as continuous scores — the three axes the regime
label does not carry.

── Why these are not read off the HMM ───────────────────────────────────────

The HMM answers one question: which of K discrete states is the market in. But
"BULL TREND at 62%" says nothing about whether the trend is strengthening, and a
discrete label cannot express "positive but fading". So the three scores are
deterministic transforms of the same features the model sees, computed for every
bar regardless of how confident the model is. They are readable when the
posterior is a three-way tie, which is exactly when a label is least useful.

── Scaling ──────────────────────────────────────────────────────────────────

Each raw input is first standardised against the symbol's OWN trailing
distribution, so +0.74 means the same thing on a utility and on a biotech, then
squashed with tanh rather than clipped. Clipping is the tempting choice and the
wrong one: it maps every sufficiently strong reading to exactly ±1, so the
derivative — the thing the brief cares most about, because transitions matter
more than levels — goes to zero precisely where the move is strongest.

── Derivatives ──────────────────────────────────────────────────────────────

Every score is returned with its change over `DERIV_BARS`. The words
(Accelerating / Weakening / Expanding / …) come from the pair (level, change),
never from the level alone.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

# Trailing window the scores are standardised against. 252 ≈ one year: long
# enough that a single quarter cannot redefine "normal", short enough that a
# structural change in the symbol eventually lands.
Z_WINDOW = 252
Z_MIN_PERIODS = 60

# Bars over which a score's rate of change is measured. One week of sessions —
# short enough to catch a turn, long enough not to read daily noise as a trend
# in the trend.
DERIV_BARS = 5

# tanh divisor. At x = 1.5σ the score reaches ≈0.76, so a "strong" reading sits
# around ±0.75 and the scale keeps resolution beyond it instead of saturating.
TANH_SCALE = 1.5

# |change| below this over DERIV_BARS is noise, not a direction.
FLAT_CHANGE = 0.05

# |score| below this is "no meaningful reading in this direction".
NEUTRAL_BAND = 0.15

# Volatility σ bands. ±0.75 rather than ±1: realized-vol distributions are
# right-skewed even in logs, so ±1σ would report "normal" for most of a calm
# year and "high" only in a crisis.
VOL_HIGH = 0.75
VOL_LOW = -0.75

MOM_WINDOW = 10


def _trailing_z(s: pd.Series) -> pd.Series:
    """Standardise against the trailing window INCLUDING the current bar.

    Including bar t is not lookahead — it uses no future information. Excluding
    it would leave the newest reading standardised by a window that does not
    contain it, which distorts exactly the bar the dashboard is about.
    """
    mean = s.rolling(Z_WINDOW, min_periods=Z_MIN_PERIODS).mean()
    sd = s.rolling(Z_WINDOW, min_periods=Z_MIN_PERIODS).std()
    return (s - mean) / sd.where(sd > 0)


def _squash(s: pd.Series) -> pd.Series:
    return np.tanh(s / TANH_SCALE)


def compute_scores(candidates: pd.DataFrame, ohlcv: pd.DataFrame) -> pd.DataFrame:
    """→ DataFrame with trend / momentum / volatility + their changes.

    `candidates` is the full feature frame from features.build_features (indexed
    to the model rows); `ohlcv` supplies close for the short-horizon momentum.
    """
    idx = candidates.index
    close = ohlcv["close"].reindex(idx).astype(float)
    log_px = np.log(close.where(close > 0))

    # ── Trend: where price is AND how cleanly it got there ──
    # Two components rather than one because they disagree in the informative
    # case: a big 20-bar return on a ragged path is not the same object as a
    # smaller one on a straight line, and only the second is a trend.
    trend_raw = 0.5 * _trailing_z(candidates["ret_z"]) + 0.5 * _trailing_z(candidates["slope_z"])
    trend = _squash(trend_raw)

    # ── Momentum: a SHORTER horizon than trend, so the two can disagree ──
    # If momentum were built from the same 20/60-bar windows as trend it would
    # be a copy of it, and "trend up, momentum fading" — the reading the whole
    # dashboard exists to surface — could never occur.
    roc = log_px - log_px.shift(MOM_WINDOW)
    momentum = _squash(_trailing_z(roc))

    # ── Volatility: already a z-score of log realized vol vs its own year ──
    volatility = candidates["rvol_z"]

    out = pd.DataFrame(index=idx)
    out["trend"] = trend
    out["momentum"] = momentum
    out["volatility"] = volatility
    for col in ("trend", "momentum", "volatility"):
        out[f"{col}_change"] = out[col] - out[col].shift(DERIV_BARS)
    return out


# ── Words ────────────────────────────────────────────────────────────────────

def trend_word(score: float) -> str:
    if score >= 0.6:
        return "Strong Bullish"
    if score >= NEUTRAL_BAND:
        return "Bullish"
    if score > -NEUTRAL_BAND:
        return "Neutral"
    if score > -0.6:
        return "Bearish"
    return "Strong Bearish"


def momentum_word(score: float, change: float) -> str:
    """Accelerating / Stable / Weakening / Reversing from (level, change).

    "Reversing" is reserved for a score that has actually crossed into the other
    sign — a positive score falling is weakening, not reversing, and conflating
    the two would turn every pullback into a turn.
    """
    if abs(change) < FLAT_CHANGE:
        return "Stable"
    if abs(score) < NEUTRAL_BAND and abs(change) >= FLAT_CHANGE:
        # Near zero and moving: it has just crossed, or is about to.
        return "Reversing"
    if score > 0:
        return "Accelerating" if change > 0 else "Weakening"
    return "Accelerating" if change < 0 else "Weakening"


def momentum_sign_word(score: float) -> str:
    if score >= NEUTRAL_BAND:
        return "Positive"
    if score <= -NEUTRAL_BAND:
        return "Negative"
    return "Flat"


def volatility_level_word(sigma: float) -> str:
    if sigma >= VOL_HIGH * 2:
        return "Very High"
    if sigma >= VOL_HIGH:
        return "High"
    if sigma <= VOL_LOW:
        return "Low"
    return "Normal"


def volatility_direction_word(change: float) -> str:
    if change > FLAT_CHANGE * 2:
        return "Expanding"
    if change < -FLAT_CHANGE * 2:
        return "Contracting"
    return "Stable"


def snapshot(scores: pd.DataFrame) -> dict:
    """The last row of each score, plus its change and its words."""
    if len(scores) == 0:
        return {}
    last = scores.iloc[-1]

    def _f(v) -> float | None:
        return None if v is None or not np.isfinite(v) else round(float(v), 3)

    t, tc = _f(last["trend"]), _f(last["trend_change"])
    m, mc = _f(last["momentum"]), _f(last["momentum_change"])
    v, vc = _f(last["volatility"]), _f(last["volatility_change"])

    return {
        "trend": {
            "score": t,
            "change": tc,
            "word": trend_word(t) if t is not None else None,
            "direction": _change_word(tc),
        },
        "momentum": {
            "score": m,
            "change": mc,
            "sign": momentum_sign_word(m) if m is not None else None,
            "word": momentum_word(m, mc) if m is not None and mc is not None else None,
        },
        "volatility": {
            "sigma": v,
            "change": vc,
            "level": volatility_level_word(v) if v is not None else None,
            "direction": volatility_direction_word(vc) if vc is not None else None,
        },
    }


def _change_word(change: float | None) -> str | None:
    if change is None:
        return None
    if change > FLAT_CHANGE:
        return "Rising"
    if change < -FLAT_CHANGE:
        return "Falling"
    return "Flat"
