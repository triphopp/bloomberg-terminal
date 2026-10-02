"""
Portfolio Monte Carlo — where the book as it is held today could be after H
trading days, over many simulated paths. Buy-and-hold: nothing is traded.

Model: Filtered Historical Simulation (FHS).

    P_i,t    = P_i,t−1 · (1 + σ_i,t · z_i,t + drift)   daily simple return, base currency
    z_·,t    = ONE WHOLE historical day of standardized residuals, drawn at
               random — every holding takes the same day, so how they move
               together (and fall together) is whatever really happened; no
               correlation matrix and no bell curve is assumed
    σ²_i,t+1 = ω_i + σ²_i,t · (α z² + β)               GARCH(1,1), α/β fixed,
               ω_i = (1 − α − β) × long-run variance (variance targeting),
               capped at S2_CAP × long-run so one re-scaled outlier cannot
               snowball into a +200% day

Why this one. NOT a better backtest: on the real book (2026-10-02, this
module, 1,010 walk-forward days, 14 long-history holdings, 250-day window) the
95% loss line was crossed 5.0 / 4.0 / 3.6 / 5.3% of the time at 1 / 10 / 21 /
63 days and the 99% line 1.3 / 1.2 / 1.5 / 1.6%; a normal model and a plain
bootstrap through the same code scored 3.6–5.0% and 0.5–2.4% — the three are
inside that test's noise (the normal one was the weakest at 99%: 2.0 / 2.4% at
10 / 21 days). So read a 99% number as slightly optimistic. Past ~10 days the
shape of one day's distribution washes out; what moves the answer is the
volatility level, the drift and the window. FHS is here because it
assumes the least (no bell curve, no correlation matrix to estimate), starts
from today's volatility regime, lets bad days cluster — which is what makes a
drawdown — and is the cheapest to run: one row gather per step, no matrix
product. `s2_start = lr_var` turns the regime off (≈ a plain bootstrap).

The residuals have mean 0, so every price is a martingale: expected return 0
(plus `drift`), exactly, whatever the tails look like. Simple returns are used
for that reason — with log returns the correction is σ²/2 only under a bell
curve. The mean must be re-checked after `backfill`: synthesized days that
average +0.03σ put +3.4% a quarter of free drift into the DIME book.
The median path still sits below today: volatility drag, not a forecast. Drift
is the biggest single assumption — "zero mean LOG return" would put the 63-day
median ~4 pp higher by handing a 90%-vol stock +10% a quarter.

Paths (63 days, 16 holdings, sd over 30 seeds, pp of NAV): the 95% loss line
moved ±0.55 at 1,000 paths, ±0.19 at 10,000, ±0.13 at 20,000, ±0.09 at 50,000;
the 99% CVaR ±1.08 / ±0.33 / ±0.20 / ±0.14. Today's vs long-run volatility
alone moves that line by ~1 pp, so past ~20,000 paths the assumptions are the
error, not the path count. 10,000 is the floor for a 95% number; `se` in the
result (batch means) is that sampling error and matched the seed test.

Speed: the state is (paths, assets) and the loop runs over days, so memory is
O(paths × assets + paths × kept days) — never (paths, days, assets). Max
drawdown is a running peak; only ≤ MAX_POINTS days are kept for the fan chart;
paths run in fixed blocks on ≤ 4 threads (numpy releases the GIL), each block
with its own seeded stream, so the result is identical on any machine.
20,000 paths × 63 days × 16 holdings ≈ 0.07 s (0.09 s on one thread); 50,000 ×
252 ≈ 0.55 s. The price history download is the slow part — the caller caches it.

Not modelled: trades and stops (WHAT-IF does that), option gamma (options enter
as delta-equivalent exposure), interest on cash, and any single day worse than
the window holds after it is re-scaled to today's volatility.

Pure numpy; routers/risk.py GET /risk/monte-carlo does the I/O.
"""
from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Optional

import numpy as np

ALPHA, BETA = 0.06, 0.92      # shock half-life ≈ 34 trading days
S2_CAP = 16.0                 # simulated σ never above 4× the holding's long-run σ
MAX_POINTS = 126              # days kept per path (fan-chart resolution)
SAMPLE_PATHS = 40
SE_BATCHES = 10
BANDS = (5, 25, 50, 75, 95)
LOSS_STEPS = (0, 5, 10, 20, 30)
DD_STEPS = (10, 20, 30)
MIN_OVERLAP = 30              # shared days needed to tie a new listing to its market
BLOCK = 2_500                 # paths per thread job
MAX_THREADS = 4               # more than 4 was slower here (memory-bound)


def garch_filter(R: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """R (T, m) daily SIMPLE returns, NaN where a holding has no bar yet.

    → (Z, s2_next, lr_var): standardized residuals (mean 0, sd 1 per column,
    NaN kept), the variance the filter expects tomorrow, the long-run variance.
    Every column needs at least one observation.
    """
    R = np.asarray(R, dtype=float)
    X = R - np.nanmean(R, axis=0)
    lr = np.maximum(np.nanvar(X, axis=0), 1e-12)
    om = (1 - ALPHA - BETA) * lr
    s2 = lr.copy()
    Z = np.empty_like(X)
    for t in range(X.shape[0]):
        x = X[t]
        Z[t] = x / np.sqrt(s2)
        s2 = np.where(np.isnan(x), s2, om + ALPHA * x * x + BETA * s2)
    Z = (Z - np.nanmean(Z, axis=0)) / np.maximum(np.nanstd(Z, axis=0), 1e-12)
    return Z, s2, lr


def backfill(
    Z: np.ndarray, factor_Z: Optional[np.ndarray] = None, seed: int = 7,
) -> tuple[np.ndarray, np.ndarray]:
    """Give a recently listed holding a residual for the days before it existed.

    Without this a whole day can only be drawn from the days EVERY holding
    traded, so one 6-month-old listing would cut a 3-year window to 6 months
    for the entire book. A missing day becomes ρ·(its home market that day) +
    √(1−ρ²)·(one of its own leftover moves), ρ from the days both have.
    `factor_Z` (T, m): column j = residuals of holding j's home market (NaN
    allowed); with none, or too little overlap, the holding's own residuals
    are reused at random (uncorrelated on those days).

    → (Z without NaN, days synthesized per column).
    """
    Z = np.array(Z, dtype=float)
    rng = np.random.default_rng(seed)
    filled = np.zeros(Z.shape[1], dtype=int)
    for j in range(Z.shape[1]):
        miss = np.isnan(Z[:, j])
        if not miss.any():
            continue
        obs = ~miss
        if not obs.any():
            raise ValueError(f"column {j} has no history")
        own = Z[obs, j]
        f = factor_Z[:, j] if factor_Z is not None else np.full(Z.shape[0], np.nan)
        both = obs & ~np.isnan(f)
        if both.sum() >= MIN_OVERLAP and np.std(f[both]) > 0 and np.std(Z[both, j]) > 0:
            rho = float(np.clip(np.corrcoef(Z[both, j], f[both])[0, 1], -0.95, 0.95))
            idio = (Z[both, j] - rho * f[both]) / np.sqrt(1 - rho * rho)
            use = miss & ~np.isnan(f)
            Z[use, j] = rho * f[use] + np.sqrt(1 - rho * rho) * rng.choice(idio, size=int(use.sum()))
        rest = np.isnan(Z[:, j])
        Z[rest, j] = rng.choice(own, size=int(rest.sum()))
        # The market's residuals do not average 0 over just the filled days, and
        # a mean of +0.03 on a 5%-a-day stock is +10% a quarter of drift.
        Z[:, j] = (Z[:, j] - Z[:, j].mean()) / max(Z[:, j].std(), 1e-12)
        filled[j] = int(miss.sum())
    return Z, filled


def _risk_numbers(fin: np.ndarray) -> dict[str, float]:
    """Loss lines of the horizon return `fin` (fraction of NAV), in % of NAV."""
    q1, q5, q50 = (float(x) for x in np.percentile(fin, [1, 5, 50]))
    return {
        "var95_pct": -q5 * 100,
        "cvar95_pct": -float(fin[fin <= q5].mean()) * 100,
        "var99_pct": -q1 * 100,
        "cvar99_pct": -float(fin[fin <= q1].mean()) * 100,
        "p_loss": float((fin < 0).mean()) * 100,
        "p50": q50 * 100,
    }


def simulate(
    exposure: np.ndarray,
    nav0: float,
    Z: np.ndarray,
    s2_start: np.ndarray,
    lr_var: np.ndarray,
    horizon: int = 63,
    n_paths: int = 20_000,
    seed: int = 7,
    drift_daily: float = 0.0,
    groups: Optional[dict[str, np.ndarray]] = None,
) -> dict[str, Any]:
    """Run the book forward. See the module docstring.

    exposure (m,)  signed base-currency exposure per holding (a short is
                   negative; an option leg is its delta-equivalent value)
    nav0           NAV today = holdings + cash; NAV_t = nav0 + Σ exposure·(P_t/P_0 − 1)
    drift_daily    expected simple return per day, every holding (0 = no view)
    Z (T, m)       residual days to draw from (no NaN — see `backfill`)
    s2_start (m,)  daily variance on day 1: the filter's (today's regime) or
                   `lr_var` (the long-run average)
    groups         {key: exposure (m,)} — slices of `exposure` (accounts); each
                   gets its share of the worst-5% loss

    Every % is of NAV; `bands` / `sample_paths` are a NAV index (100 = today).
    """
    exposure = np.asarray(exposure, dtype=float)
    Z = np.ascontiguousarray(Z, dtype=float)
    T, m = Z.shape
    N, H = int(n_paths), int(horizon)
    step = max(1, -(-H // MAX_POINTS))
    days = list(range(step, H + 1, step))
    if days[-1] != H:
        days.append(H)
    slot = {d: k + 1 for k, d in enumerate(days)}

    om = (1 - ALPHA - BETA) * np.asarray(lr_var, dtype=float)
    cap = S2_CAP * np.asarray(lr_var, dtype=float)
    s2_0 = np.minimum(np.asarray(s2_start, dtype=float), cap)
    w = exposure / nav0
    rest = 1.0 - w.sum()                       # cash and anything not simulated

    def block(job: tuple[np.random.SeedSequence, int]):
        """`n` paths → (NAV index at day 0 + the kept days, P_H/P_0 − 1, max drawdown)."""
        rng, n = np.random.default_rng(job[0]), job[1]
        nav = np.empty((n, len(days) + 1))
        nav[:, 0] = 1.0
        price = np.ones((n, m))                  # P_t / P_0
        s2 = np.tile(s2_0, (n, 1))
        z = np.empty((n, m))
        ret = np.empty((n, m))
        peak = np.ones(n)
        mdd = np.zeros(n)
        for t in range(1, H + 1):
            np.take(Z, rng.integers(0, T, size=n), axis=0, out=z)
            np.sqrt(s2, out=ret)
            ret *= z
            ret += 1.0 + drift_daily
            np.maximum(ret, 0.01, out=ret)       # a price does not go below zero
            price *= ret
            np.multiply(z, z, out=z)             # z² — the residual is not needed again
            z *= ALPHA
            z += BETA
            s2 *= z
            s2 += om
            np.minimum(s2, cap, out=s2)
            v = price @ w + rest
            np.maximum(peak, v, out=peak)
            np.minimum(mdd, v / peak - 1, out=mdd)
            k = slot.get(t)
            if k:
                nav[:, k] = v
        return nav, price - 1, mdd

    # Fixed-size blocks, each with its own seeded stream: the answer does not
    # depend on how many threads ran them. numpy releases the GIL in the loop.
    sizes = [min(BLOCK, N - a) for a in range(0, N, BLOCK)]
    jobs = list(zip(np.random.SeedSequence(seed).spawn(len(sizes)), sizes))
    workers = min(len(jobs), MAX_THREADS, os.cpu_count() or 1)
    if workers > 1:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            parts = list(pool.map(block, jobs))
    else:
        parts = [block(j) for j in jobs]
    nav = np.concatenate([x[0] for x in parts])
    growth = np.concatenate([x[1] for x in parts])       # (N, m)
    mdd = np.concatenate([x[2] for x in parts])

    fin = nav[:, -1] - 1
    q = np.percentile(fin, [1, 5, 25, 50, 75, 95, 99]) * 100
    risk = _risk_numbers(fin)
    batches = [_risk_numbers(x) for x in np.array_split(fin, SE_BATCHES)]
    se = {k: float(np.std([x[k] for x in batches], ddof=1) / np.sqrt(SE_BATCHES)) for k in risk}

    tail = fin <= np.percentile(fin, 5)
    cvar = float(-fin[tail].mean())
    contrib = (growth[tail] * w).mean(axis=0)              # sums to −cvar95
    a_q = np.percentile(growth, [5, 50, 95], axis=0) * 100

    def share(c: float) -> float:
        return round(-c / cvar * 100, 1) if cvar > 1e-12 else 0.0

    lo, hi = np.percentile(fin, [0.5, 99.5]) * 100
    if hi - lo < 1e-9:
        lo, hi = lo - 0.5, hi + 0.5
    counts, edges = np.histogram(np.clip(fin * 100, lo, hi), bins=40, range=(lo, hi))
    idx = nav * 100
    bands = np.percentile(idx, BANDS, axis=0)   # one call: 5 separate ones cost 3× the loop's share

    return {
        "horizon": H,
        "n_paths": N,
        "days": [0] + days,
        "bands": {f"p{p}": bands[i].round(3).tolist() for i, p in enumerate(BANDS)},
        "sample_paths": idx[:SAMPLE_PATHS].round(2).tolist(),
        "final": {
            "mean": round(float(fin.mean()) * 100, 3),
            **{f"p{p}": round(float(v), 3) for p, v in zip((1, 5, 25, 50, 75, 95, 99), q)},
        },
        **{k: round(float(v), 3) for k, v in risk.items() if k != "p50"},
        "se": {k: round(v, 3) for k, v in se.items()},
        "loss_prob": [{"worse_than_pct": x, "prob_pct": round(float((fin < -x / 100).mean()) * 100, 2)
                       if x else round(risk["p_loss"], 2)} for x in LOSS_STEPS],
        "max_dd": {
            "p50": round(float(np.median(mdd)) * 100, 2),
            "p95": round(float(np.percentile(mdd, 5)) * 100, 2),      # the worse tail
            "prob": [{"worse_than_pct": x, "prob_pct": round(float((mdd < -x / 100).mean()) * 100, 2)}
                     for x in DD_STEPS],
        },
        "hist": {"edges": edges.round(3).tolist(), "pct": (counts / N * 100).round(3).tolist()},
        "assets": [
            {"tail_contrib_pct": round(float(contrib[j]) * 100, 3), "tail_share_pct": share(contrib[j]),
             "ret_p5": round(float(a_q[0, j]), 2), "ret_p50": round(float(a_q[1, j]), 2),
             "ret_p95": round(float(a_q[2, j]), 2)}
            for j in range(m)
        ],
        "groups": [
            {"key": key, "tail_contrib_pct": round(c * 100, 3), "tail_share_pct": share(c)}
            for key, c in ((key, float((growth[tail] @ (np.asarray(g, dtype=float) / nav0)).mean()))
                           for key, g in (groups or {}).items())
        ],
    }
