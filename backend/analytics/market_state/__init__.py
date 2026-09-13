"""
Quant Market State — a per-symbol latent-state view of the market.

    OHLCV → features → redundancy check → Gaussian HMM
          → regime probability + trend / momentum / volatility scores
          → market interpretation → strategy compatibility

The design rule the whole package is built around: **market interpretation and
trading decision are separate layers**. `interpret.py` says what the market is
doing and is not allowed to mention strategies; `strategy.py` measures which
styles have historically suited that environment and is not allowed to restate
the interpretation. Anything that merges the two produces a recommendation the
reader cannot disagree with piece by piece.

── What is honest here and what is not ──────────────────────────────────────

`get_market_state` fits ONE model on the symbol's whole history and labels every
bar with a filtered posterior. The labels are causal — no bar is labelled using
anything after it — but the model PARAMETERS saw the whole sample. So:

    "what state is this symbol in now"        — answered here, honestly
    "what tends to follow this state"         — NOT answerable here

The second question needs `validate.py`, which refits walk-forward. The payload
carries that split explicitly (`basis` on each block) so the UI cannot blur it.
"""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import hmm, interpret, scores as scores_mod, strategy
from .features import build_features, redundancy_report

# Rows of usable features (i.e. after the ~252-bar warm-up) below which a
# 4-state full-covariance HMM is fitting more parameters than it has data for.
MIN_BARS = 300

# Bars of history returned for the charts. Two years of sessions: enough to see
# several regime changes, small enough that the payload stays a sane size.
DEFAULT_HISTORY = 504
MAX_HISTORY = 2000

PERIOD_START = {
    "3y": "2019-01-01",
    "5y": "2015-01-01",
    "10y": "2010-01-01",
    "max": "2000-01-01",
}


def fetch_ohlcv(symbol: str, period: str = "10y") -> pd.DataFrame | None:
    """Daily OHLCV, oldest first, lowercase columns.

    Deliberately generous by default: the feature stack burns ~252 bars before
    it produces anything and the model wants several hundred more, so a "1y"
    request would leave nothing to fit.
    """
    import yfinance as yf

    start = PERIOD_START.get(period, PERIOD_START["10y"])
    raw = yf.download(symbol, start=start, auto_adjust=True, progress=False)
    if raw is None or len(raw) == 0:
        return None
    raw.columns = [c[0].lower() if isinstance(c, tuple) else str(c).lower() for c in raw.columns]
    need = ["open", "high", "low", "close"]
    if any(c not in raw.columns for c in need):
        return None
    if "volume" not in raw.columns:
        raw["volume"] = np.nan
    return raw[["open", "high", "low", "close", "volume"]].dropna(subset=["close"])


def _iso(idx) -> list[str]:
    return [pd.Timestamp(t).strftime("%Y-%m-%d") for t in idx]


def _series(s: pd.Series, n: int) -> list[float | None]:
    tail = s.iloc[-n:]
    return [None if v is None or not np.isfinite(v) else round(float(v), 4) for v in tail]


def get_market_state(
    symbol: str,
    period: str = "10y",
    n_states: int = hmm.DEFAULT_N_STATES,
    history_bars: int = DEFAULT_HISTORY,
) -> dict:
    """The dashboard payload. See the module docstring for what it can claim."""
    ohlcv = fetch_ohlcv(symbol, period)
    if ohlcv is None or len(ohlcv) < MIN_BARS:
        return {
            "symbol": symbol.upper(),
            "status": "insufficient",
            "detail": f"{symbol.upper()} has too little daily history to fit a state model "
            f"({0 if ohlcv is None else len(ohlcv)} bars, {MIN_BARS}+ needed after warm-up).",
        }

    fs = build_features(ohlcv)
    if fs.bars_out < MIN_BARS:
        return {
            "symbol": symbol.upper(),
            "status": "insufficient",
            "detail": f"{symbol.upper()} left only {fs.bars_out} usable bars after the feature "
            f"warm-up ({MIN_BARS}+ needed).",
        }

    values = fs.frame.to_numpy()
    try:
        fm = hmm.fit(values, fs.used, n_states=n_states)
    except Exception as exc:
        return {
            "symbol": symbol.upper(),
            "status": "error",
            "detail": f"State model failed to fit for {symbol.upper()}: {exc}",
        }

    posterior = hmm.filtered_posterior(fm, values)
    labels = hmm.hard_labels(posterior)
    score_frame = scores_mod.compute_scores(fs.candidates, ohlcv)
    snap = scores_mod.snapshot(score_frame)

    current = labels[-1]
    current_p = float(posterior[-1][current])

    # How long the symbol has already been in this state — the reading that
    # turns "BULL 80%" into something you can act on, since a state on day 1 and
    # the same state on day 40 are different situations.
    bars_in_state = 1
    for i in range(len(labels) - 2, -1, -1):
        if labels[i] != current:
            break
        bars_in_state += 1

    durations = hmm.expected_durations(fm)
    n = min(max(history_bars, 60), MAX_HISTORY, len(fs.frame))
    idx = fs.frame.index[-n:]
    close = ohlcv["close"].reindex(fs.frame.index).astype(float)

    states = [
        {
            "key": fm.keys[i],
            "label": fm.labels[i],
            "color": fm.colors[i],
            "blurb": hmm.ARCHETYPE_BY_KEY[fm.keys[i]].blurb,
            "probability": round(float(posterior[-1][i]), 4),
            "expected_duration": None
            if not np.isfinite(durations[i])
            else round(durations[i], 1),
            "share": round(float(np.mean(np.asarray(labels) == i)), 4),
        }
        for i in range(fm.n_states)
    ]

    summary = interpret.build_summary(fm.labels[current], current_p, snap)
    note = interpret.transition_note(posterior, fm.labels)

    return {
        "symbol": symbol.upper(),
        "status": "ok",
        "as_of": _iso(fs.frame.index[-1:])[0],
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "bars": fs.bars_out,
        "period": period,
        "basis": {
            "labels": "causal — filtered posterior, no bar uses data after itself",
            "parameters": "in-sample — the model is fitted on the whole history",
            "claim": "Describes what state the symbol is in. For what FOLLOWS a state, "
            "use the validation endpoint, which refits walk-forward.",
        },
        "regime": {
            "key": fm.keys[current],
            "label": fm.labels[current],
            "color": fm.colors[current],
            "probability": round(current_p, 4),
            "confidence": interpret.regime_confidence_word(current_p),
            "bars_in_state": bars_in_state,
            "expected_duration": states[current]["expected_duration"],
            "states": states,
            "transition_note": note,
        },
        "scores": snap,
        "summary": summary,
        # The Market State Vector itself, in the order the brief writes it.
        "vector": {
            "regime_probability": {s["key"]: s["probability"] for s in states},
            "trend": (snap.get("trend") or {}).get("score"),
            "momentum": (snap.get("momentum") or {}).get("score"),
            "volatility": (snap.get("volatility") or {}).get("sigma"),
        },
        "history": {
            "times": _iso(idx),
            "close": _series(close, n),
            "state": [int(x) for x in labels[-n:]],
            "posterior": [[round(float(p), 4) for p in row] for row in posterior[-n:]],
            "trend": _series(score_frame["trend"], n),
            "momentum": _series(score_frame["momentum"], n),
            "volatility": _series(score_frame["volatility"], n),
            "trend_change": _series(score_frame["trend_change"], n),
            "momentum_change": _series(score_frame["momentum_change"], n),
            "volatility_change": _series(score_frame["volatility_change"], n),
        },
        "strategy": {
            **strategy.compatibility(ohlcv, fs.frame.index, labels, current),
            "state": fm.keys[current],
            "state_label": fm.labels[current],
            "basis": "in-sample state labels — descriptive, not a backtest",
        },
        "diagnostics": {
            "redundancy": redundancy_report(fs),
            "model": {
                "family": "gaussian_hmm",
                "n_states": fm.n_states,
                "covariance": "full",
                "features": fs.used,
                "dropped_features": fs.dropped,
                "bars_in": fs.bars_in,
                "bars_used": fs.bars_out,
                "hysteresis": hmm.HYSTERESIS,
                "state_labels": fm.labels,
                "expected_durations": [
                    None if not np.isfinite(d) else round(d, 1) for d in durations
                ],
                "transition_matrix": hmm.transition_matrix(fm),
            },
        },
    }
