"""
Down-tilted paths — "what if the next 3 / 5 / 7 / 21 / 42 trading days hold more
losing days than winning ones?" A stress on top of the Monte Carlo, not a
forecast: the tilt is an assumption the user picks, and every number here is
conditional on it.

Model: the same filtered historical simulation as port_mc.py (whole historical
days of standardized residuals, GARCH(1,1) volatility that starts from today's
regime), with ONE change — which day is drawn is no longer uniform.

    down day  = a day of the window on which TODAY'S book (today's weights,
                each holding at its long-run volatility) lost money
    up day    = every other day
    a path    = H days of which k are down days, k drawn from Binomial(H, p_down)
                and kept only when k > H / 2 — so every path has MORE down days
                than up days, whatever p_down is. Which of the H days are the
                down ones is random.

Not every day falls and a path can still end up: a few large up days can
outweigh many small down ones. `p_end_up` says how often that happens.

Because whole days are drawn, holdings fall together the way they really did on
the book's losing days — correlation in a sell-off is what happened, not an
estimate. Volatility clusters as in port_mc: a run of down days raises tomorrow's
σ (capped at 4× long-run).

Each horizon is its own run (the "more down than up" condition is per horizon),
with a neutral run through the same code beside it (`base`: no tilt, no
condition) so the cost of the tilt reads directly.

Not modelled: stops and trades (the book is held as is), option gamma (options
are delta-equivalent exposure), a day worse than the window holds.

Pure numpy; routers/risk.py GET /risk/bear-paths does the I/O.
"""
from __future__ import annotations

from typing import Any, Optional

import numpy as np

from port_mc import ALPHA, BETA, S2_CAP

HORIZONS = (3, 5, 7, 21, 42)          # trading days; 42 ≈ 2 months
LOSS_STEPS = (5, 10, 20)              # "worse than −x% of NAV"
BANDS = (5, 25, 50, 75, 95)
TOP_HOLDINGS = 6


def classify_days(Z: np.ndarray, weights: np.ndarray, lr_var: np.ndarray) -> np.ndarray:
    """True where today's book would have lost money on that historical day."""
    book = (np.asarray(Z, dtype=float) * np.sqrt(np.asarray(lr_var, dtype=float))) @ np.asarray(
        weights, dtype=float)
    return book < 0


def _down_counts(rng: np.random.Generator, n: int, H: int, p_down: float) -> np.ndarray:
    """k ~ Binomial(H, p_down) given k > H/2 — inverse CDF over the allowed k."""
    from math import comb

    ks = np.arange(H // 2 + 1, H + 1)
    pmf = np.array([comb(H, int(k)) * p_down ** int(k) * (1 - p_down) ** (H - int(k)) for k in ks])
    if pmf.sum() <= 0:                         # p_down = 0: the condition cannot hold
        return np.full(n, ks[0])
    return rng.choice(ks, size=n, p=pmf / pmf.sum())


def _run(
    w: np.ndarray, rest: float, Z: np.ndarray, s2_0: np.ndarray, om: np.ndarray, cap: np.ndarray,
    H: int, n: int, rng: np.random.Generator,
    down_idx: Optional[np.ndarray] = None, up_idx: Optional[np.ndarray] = None,
    p_down: Optional[float] = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """→ (NAV index per day (n, H+1), holding growth P_H/P_0 − 1 (n, m), max drawdown (n,)).
    `p_down` None = neutral: any day, no condition."""
    T, m = Z.shape
    if p_down is None:
        is_down = None
    else:
        k = _down_counts(rng, n, H, p_down)
        order = rng.random((n, H)).argsort(axis=1).argsort(axis=1)
        is_down = order < k[:, None]           # (n, H): which days of each path are down days
    nav = np.empty((n, H + 1))
    nav[:, 0] = 1.0
    price = np.ones((n, m))
    s2 = np.tile(s2_0, (n, 1))
    peak = np.ones(n)
    mdd = np.zeros(n)
    for t in range(1, H + 1):
        if is_down is None:
            pick = rng.integers(0, T, size=n)
        else:
            d = down_idx[rng.integers(0, len(down_idx), size=n)]
            u = up_idx[rng.integers(0, len(up_idx), size=n)]
            pick = np.where(is_down[:, t - 1], d, u)
        z = Z[pick]
        ret = np.maximum(1.0 + np.sqrt(s2) * z, 0.01)
        price *= ret
        s2 = np.minimum(om + s2 * (ALPHA * z * z + BETA), cap)
        v = price @ w + rest
        np.maximum(peak, v, out=peak)
        np.minimum(mdd, v / peak - 1, out=mdd)
        nav[:, t] = v
    return nav, price - 1, mdd


def _summary(fin: np.ndarray, mdd: np.ndarray, nav0: float) -> dict[str, Any]:
    q = np.percentile(fin, BANDS) * 100
    out: dict[str, Any] = {f"p{p}": round(float(v), 2) for p, v in zip(BANDS, q)}
    out["mean"] = round(float(fin.mean()) * 100, 2)
    out["p_loss"] = round(float((fin < 0).mean()) * 100, 1)
    out["p_end_up"] = round(float((fin > 0).mean()) * 100, 1)
    out["loss_prob"] = [{"worse_than_pct": x, "prob_pct": round(float((fin < -x / 100).mean()) * 100, 1)}
                        for x in LOSS_STEPS]
    out["max_dd_p50"] = round(float(np.median(mdd)) * 100, 2)
    out["max_dd_p95"] = round(float(np.percentile(mdd, 5)) * 100, 2)      # the worse tail
    out["amount_p50"] = round(float(np.percentile(fin, 50)) * nav0, 2)
    out["amount_p5"] = round(float(np.percentile(fin, 5)) * nav0, 2)
    return out


def simulate(
    exposure: np.ndarray,
    nav0: float,
    Z: np.ndarray,
    s2_start: np.ndarray,
    lr_var: np.ndarray,
    p_down: float = 0.6,
    horizons: tuple[int, ...] = HORIZONS,
    n_paths: int = 10_000,
    seed: int = 11,
    labels: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Run the book through down-tilted paths. Arguments as port_mc.simulate.

    Every % is of NAV. `fan` is the NAV index (100 = today) of the longest
    horizon, tilted and neutral.
    """
    if not 0.5 <= p_down <= 0.95:
        raise ValueError("p_down must be between 0.5 and 0.95")
    exposure = np.asarray(exposure, dtype=float)
    Z = np.ascontiguousarray(Z, dtype=float)
    lr = np.asarray(lr_var, dtype=float)
    w = exposure / nav0
    rest = 1.0 - w.sum()
    om = (1 - ALPHA - BETA) * lr
    cap = S2_CAP * lr
    s2_0 = np.minimum(np.asarray(s2_start, dtype=float), cap)

    down = classify_days(Z, w, lr)
    down_idx, up_idx = np.flatnonzero(down), np.flatnonzero(~down)
    if len(down_idx) == 0 or len(up_idx) == 0:
        raise ValueError("the window has no losing days (or no winning days) for this book")

    names = labels or [str(j) for j in range(len(w))]
    seeds = np.random.SeedSequence(seed).spawn(2 * len(horizons))
    rows = []
    fan: dict[str, Any] = {}
    for i, H in enumerate(horizons):
        nav, growth, mdd = _run(w, rest, Z, s2_0, om, cap, H, n_paths, np.random.default_rng(seeds[2 * i]),
                                down_idx, up_idx, p_down)
        b_nav, _, b_mdd = _run(w, rest, Z, s2_0, om, cap, H, n_paths, np.random.default_rng(seeds[2 * i + 1]))
        fin = nav[:, -1] - 1
        contrib = growth.mean(axis=0) * w * 100              # pp of NAV, sums to mean − cash drift
        top = np.argsort(contrib)[:TOP_HOLDINGS]
        row = {"days": H, **_summary(fin, mdd, nav0),
               "base": {k: v for k, v in _summary(b_nav[:, -1] - 1, b_mdd, nav0).items()
                        if k in ("p5", "p50", "p95", "p_loss", "max_dd_p50")},
               "holdings": [{"symbol": names[j], "contrib_pct": round(float(contrib[j]), 2),
                             "ret_p50": round(float(np.median(growth[:, j])) * 100, 1)}
                            for j in top if contrib[j] < 0]}
        rows.append(row)
        if H == max(horizons):
            idx = np.percentile(nav * 100, (5, 50, 95), axis=0)
            b_idx = np.percentile(b_nav * 100, (5, 50, 95), axis=0)
            fan = {"days": list(range(H + 1)),
                   "p5": idx[0].round(2).tolist(), "p50": idx[1].round(2).tolist(),
                   "p95": idx[2].round(2).tolist(),
                   "base_p5": b_idx[0].round(2).tolist(), "base_p50": b_idx[1].round(2).tolist(),
                   "sample_paths": (nav[:12] * 100).round(2).tolist()}

    return {
        "p_down": p_down,
        "n_paths": int(n_paths),
        "down_days_in_window": int(len(down_idx)),
        "up_days_in_window": int(len(up_idx)),
        "avg_down_day_pct": round(float(((Z[down_idx] * np.sqrt(lr)) @ w).mean()) * 100, 2),
        "avg_up_day_pct": round(float(((Z[up_idx] * np.sqrt(lr)) @ w).mean()) * 100, 2),
        "horizons": rows,
        "fan": fan,
    }
