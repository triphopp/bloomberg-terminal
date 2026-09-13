"""
Strategy compatibility — the decision layer, kept strictly downstream of the
market interpretation.

The brief asks for this NOT to be an arbitrary rule table, so every number here
is measured on the symbol's own history, restricted to the bars that carry the
regime label the symbol is in right now. The question each answers is literally
"when this symbol was last in this state, did this kind of edge exist?".

── What these numbers are and are not ───────────────────────────────────────

They are descriptive statistics with a sample size attached, not forecasts and
not a backtest: no costs, no position sizing, no entry rule, and the state
labels come from a model fitted on the whole history (see the module docstring
in __init__). `validate.py` is where the same questions get asked walk-forward.
A score computed on 40 bars of a rare state is noise, so `n` and `z` travel with
every score and the UI is expected to show them.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

# Forward horizon every statistic is measured over. Two weeks of sessions: long
# enough for a continuation to show, short enough to stay attributable to the
# state the bar was in.
HORIZON = 10

# Bars of a state below which its statistics are reported but flagged unreliable.
MIN_SAMPLE = 60

# Distance from the 20-bar mean, in σ, that counts as "stretched" for the
# mean-reversion test.
STRETCH_SIGMA = 1.0

# Half-width of the tanh map from edge to score. An edge of this size maps to
# ≈88/100; it is a presentation constant and changes no statistic.
EDGE_SCALE = 0.12


def _scores_from_edge(edge: float | None, n: int, stderr: float | None) -> dict:
    if edge is None or not np.isfinite(edge):
        return {"score": None, "edge": None, "n": n, "z": None, "reliable": False}
    score = 50.0 + 50.0 * float(np.tanh(edge / EDGE_SCALE))
    z = float(edge / stderr) if stderr and stderr > 0 and np.isfinite(stderr) else None
    return {
        "score": round(score, 1),
        "edge": round(float(edge), 4),
        "n": int(n),
        "z": round(z, 2) if z is not None else None,
        "reliable": bool(n >= MIN_SAMPLE),
    }


def compatibility(
    ohlcv: pd.DataFrame,
    index: pd.Index,
    labels: list[int],
    state: int,
    horizon: int = HORIZON,
) -> dict:
    """Trend-following / mean-reversion / breakout edges inside `state`.

    `labels[i]` is the state of bar `index[i]`; `state` is the one to condition
    on (normally the current one).
    """
    close = ohlcv["close"].reindex(index).astype(float)
    log_px = np.log(close.where(close > 0))
    ret = log_px.diff()

    lab = np.asarray(labels)
    in_state = lab == state
    # A bar can only be used if its forward window exists, so the last `horizon`
    # bars are excluded from every statistic — including them with a truncated
    # window would quietly bias the most recent (and most tempting) readings.
    usable = np.zeros(len(index), dtype=bool)
    usable[: len(index) - horizon] = True
    sel = in_state & usable

    fwd = (log_px.shift(-horizon) - log_px).to_numpy()
    trail = (log_px - log_px.shift(20)).to_numpy()

    # ── Trend following: does a move keep going while in this state ──
    m = sel & np.isfinite(fwd) & np.isfinite(trail) & (np.abs(trail) > 0)
    n_tf = int(m.sum())
    if n_tf > 0:
        cont = float(np.mean(np.sign(fwd[m]) == np.sign(trail[m])))
        edge_tf = cont - 0.5
        se_tf = float(np.sqrt(0.25 / n_tf))
    else:
        cont, edge_tf, se_tf = float("nan"), None, None

    # ── Mean reversion: lag-1 autocorrelation + does a stretched price come back ──
    r = ret.to_numpy()
    m_ac = sel & np.isfinite(r) & np.isfinite(np.roll(r, 1))
    n_ac = int(m_ac.sum())
    if n_ac > 30:
        a = r[m_ac]
        b = np.roll(r, 1)[m_ac]
        rho1 = float(np.corrcoef(a, b)[0, 1])
        se_rho = float(1.0 / np.sqrt(n_ac))
    else:
        rho1, se_rho = float("nan"), None

    ma20 = close.rolling(20).mean()
    sd20 = close.rolling(20).std()
    stretch = ((close - ma20) / sd20.where(sd20 > 0)).to_numpy()
    m_mr = sel & np.isfinite(stretch) & (np.abs(stretch) >= STRETCH_SIGMA) & np.isfinite(fwd)
    n_mr = int(m_mr.sum())
    if n_mr > 0:
        # Came back = the forward move ran AGAINST the stretch.
        came_back = float(np.mean(np.sign(fwd[m_mr]) != np.sign(stretch[m_mr])))
        edge_mr = came_back - 0.5
        se_mr = float(np.sqrt(0.25 / n_mr))
    else:
        came_back, edge_mr, se_mr = float("nan"), None, None

    # ── Breakout: does a close beyond the 20-bar range extend ──
    hi20 = ohlcv["high"].reindex(index).astype(float).rolling(20).max().shift(1)
    lo20 = ohlcv["low"].reindex(index).astype(float).rolling(20).min().shift(1)
    broke_up = (close > hi20).to_numpy()
    broke_dn = (close < lo20).to_numpy()
    m_bo = sel & (broke_up | broke_dn) & np.isfinite(fwd)
    n_bo = int(m_bo.sum())
    if n_bo > 0:
        direction = np.where(broke_up[m_bo], 1.0, -1.0)
        extended = float(np.mean(np.sign(fwd[m_bo]) == direction))
        edge_bo = extended - 0.5
        se_bo = float(np.sqrt(0.25 / n_bo))
    else:
        extended, edge_bo, se_bo = float("nan"), None, None

    # Mean reversion gets two ingredients; average the two edges so neither a
    # noisy autocorrelation nor a thin stretched-bar sample decides alone.
    edge_rho = -rho1 if np.isfinite(rho1) else None
    if edge_rho is not None and edge_mr is not None:
        edge_mr_total = 0.5 * edge_rho + 0.5 * edge_mr
        se_mr_total = 0.5 * np.sqrt((se_rho or 0) ** 2 + (se_mr or 0) ** 2)
    else:
        edge_mr_total = edge_mr if edge_mr is not None else edge_rho
        se_mr_total = se_mr or se_rho

    return {
        "horizon": horizon,
        "state_bars": int(in_state.sum()),
        "items": [
            {
                "id": "trend_following",
                "name": "Trend Following",
                "metric": "continuation rate",
                "value": None if not np.isfinite(cont) else round(cont, 3),
                "baseline": 0.5,
                "detail": f"sign of the next {horizon} bars matched the trailing 20-bar move",
                **_scores_from_edge(edge_tf, n_tf, se_tf),
            },
            {
                "id": "mean_reversion",
                "name": "Mean Reversion",
                "metric": "snap-back rate / −ρ₁",
                "value": None if not np.isfinite(came_back) else round(came_back, 3),
                "baseline": 0.5,
                "rho1": None if not np.isfinite(rho1) else round(rho1, 3),
                "detail": f"price ≥{STRETCH_SIGMA}σ from its 20-bar mean moved back within {horizon} bars",
                **_scores_from_edge(edge_mr_total, n_mr, se_mr_total),
            },
            {
                "id": "breakout",
                "name": "Breakout",
                "metric": "follow-through rate",
                "value": None if not np.isfinite(extended) else round(extended, 3),
                "baseline": 0.5,
                "detail": f"a close beyond the prior 20-bar range kept going for {horizon} bars",
                **_scores_from_edge(edge_bo, n_bo, se_bo),
            },
        ],
    }
