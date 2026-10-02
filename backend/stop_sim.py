"""
Stop-discipline simulator — what the book looks like over the next H trading
days if the market moves +1 / 0 / −1 / −2 SD, WITH and WITHOUT obeying stops.

Model (one factor per home market, fat-tailed stock-specific noise):

    r_i,t = β_i · f_g(i),t + ε_i,t          log returns, daily
    f     = correlated market factors (S&P 500, SET, BTC, gold …), each forced by
            a Brownian bridge to end the horizon at  k · σ_f · √H  (scenario k)
            — the path in between still wanders with the factor's own vol, and
            factor co-movement comes from their historical covariance
    ε_i,t = Student-t (df 4), scaled to the holding's residual daily vol

DISCIPLINED: a holding exits the first day its close is at or below its stop.
    Fill = the stop, unless the close is more than one daily σ beneath it (a
    gap) — then the close. A holding already below its stop today is sold on
    day 0 at today's price. Exited money sits in cash at 0%.
HOLD: nobody sells; every holding rides to the horizon.

WHAT-IF (`scale`, `follow_stops`): the DISCIPLINED side becomes "do the
trades, then (optionally) obey stops". `scale[i]` = shares after ÷ shares now,
filled today at today's price with no fees or slippage; the money sold goes to
cash at 0% and the money bought comes out of it (cash may go negative — the
caller shows it). The HOLD side is always the book as it is ("don't"). With
no scale and follow_stops=True this is exactly the stop simulator above.

RANDOM MARKET (`market="random"`): one extra way to run it with the factors
NOT pinned — zero drift, historical covariance. The SD scenarios answer "if
the market does X"; with them the p10–p90 band is stock-specific noise only,
so it says nothing about the chance of a loss. The random run puts market
uncertainty back in the band, so P(loss) is a (model) probability.

Same random draws for both, so the difference between the two lines is the
stop rule and nothing else. Everything is in base-currency value with today's
FX held constant (currency moves are not simulated).

This is an illustration of the rule's effect under stated assumptions, not a
forecast: β and vols come from the last year, and the SD path is imposed.
Pure numpy; routers/risk.py GET /risk/stop-sim does the I/O.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

import numpy as np

T_DF = 4                  # Student-t degrees of freedom for stock-specific noise
DEFAULT_SCENARIOS = (1.0, 0.0, -1.0, -2.0)


@dataclass
class Holding:
    symbol: str
    value: float          # base-currency market value today
    price: float          # native price today
    stop: Optional[float]  # native stop; None = no stop (never exits)
    factor: str           # key into factors
    beta: float
    resid_vol: float      # daily σ of ε (log-return)
    key: str = ""         # unique id (account|yf_symbol); defaults to symbol


def _t_noise(rng: np.random.Generator, shape: tuple, scale: np.ndarray) -> np.ndarray:
    """Student-t draws with unit variance, times `scale` (broadcast on last axis)."""
    z = rng.standard_t(T_DF, size=shape) / np.sqrt(T_DF / (T_DF - 2))
    return z * scale


def _factor_paths(
    rng: np.random.Generator, n: int, horizon: int, cov: np.ndarray, k: Optional[float],
) -> np.ndarray:
    """(n, horizon, F) daily factor log-returns whose horizon sum is exactly
    k·σ_f·√H for every factor (Brownian bridge on correlated increments).
    k=None = no bridge: the market wanders freely (zero drift, historical cov)."""
    F = cov.shape[0]
    try:
        L = np.linalg.cholesky(cov + np.eye(F) * 1e-12)
    except np.linalg.LinAlgError:
        L = np.diag(np.sqrt(np.maximum(np.diag(cov), 1e-12)))
    inc = rng.standard_normal((n, horizon, F)) @ L.T          # (n, H, F)
    if k is None:
        return inc
    total = inc.sum(axis=1, keepdims=True)                      # (n, 1, F)
    target = k * np.sqrt(np.diag(cov) * horizon)                # (F,)
    # Spread the correction evenly: bridge increments = inc − (W_H − target)/H
    return inc - (total - target) / horizon


def _max_drawdown(nav: np.ndarray) -> np.ndarray:
    """nav (n, T) → max drawdown per path as a NEGATIVE fraction."""
    peak = np.maximum.accumulate(nav, axis=1)
    return (nav / peak - 1).min(axis=1)


def simulate(
    holdings: list[Holding],
    factor_cov: np.ndarray,
    factor_keys: list[str],
    cash: float = 0.0,
    horizon: int = 20,
    scenarios: tuple[float, ...] = DEFAULT_SCENARIOS,
    n_paths: int = 1000,
    seed: int = 7,
    scale: Optional[list[float]] = None,
    follow_stops: bool = True,
    market: str = "sd",
) -> dict[str, Any]:
    """Run every scenario for both rules. See the module docstring.
    market="random": one scenario (k=None) where the market is NOT pinned —
    the band then holds market uncertainty too, so P(loss) reads as a chance."""
    if market == "random":
        scenarios = (None,)
    if not holdings:
        return {"scenarios": [], "holdings": [], "start_value": cash}
    keys = [h.key or h.symbol for h in holdings]
    fidx = {k: i for i, k in enumerate(factor_keys)}
    m = len(holdings)
    value0 = np.array([h.value for h in holdings])
    price0 = np.array([h.price for h in holdings])
    stop = np.array([h.stop if h.stop and h.stop > 0 else -np.inf for h in holdings])
    beta = np.array([h.beta for h in holdings])
    resid = np.array([h.resid_vol for h in holdings])
    gidx = np.array([fidx[h.factor] for h in holdings])
    fvol = np.sqrt(np.diag(factor_cov))
    total_vol = np.sqrt((beta * fvol[gidx]) ** 2 + resid ** 2)   # daily σ per holding
    start = float(value0.sum() + cash)
    already = price0 <= stop                                     # below stop today
    sc = np.ones(m) if scale is None else np.maximum(np.asarray(scale, dtype=float), 0.0)
    do_value0 = value0 * sc                                      # after today's trades
    do_cash = cash + float((value0 - do_value0).sum())

    out = []
    for k in scenarios:
        rng = np.random.default_rng(seed)        # same draws for every scenario's noise
        f = _factor_paths(rng, n_paths, horizon, factor_cov, k)    # (n, H, F)
        eps = _t_noise(rng, (n_paths, horizon, m), resid)          # (n, H, m)
        r = beta * f[:, :, gidx] + eps                              # (n, H, m)
        cum = np.exp(np.cumsum(r, axis=1))                          # price / price0
        px = price0 * cum                                           # (n, H, m)

        # HOLD: everything rides.
        hold_val = value0 * cum                                     # (n, H, m)
        hold_nav = np.concatenate(
            [np.full((n_paths, 1), start), hold_val.sum(axis=2) + cash], axis=1)

        # DO: today's trades, then (optionally) the first close ≤ stop exits.
        do_hold = do_value0 * cum                                   # (n, H, m)
        hit = (px <= stop) if follow_stops else np.zeros_like(px, dtype=bool)
        any_hit = hit.any(axis=1)                                   # (n, m)
        first = np.where(any_hit, hit.argmax(axis=1), horizon)      # (n, m) day index
        day_px = np.take_along_axis(px, np.minimum(first, horizon - 1)[:, None, :], axis=1)[:, 0, :]
        gap = day_px < stop * (1 - total_vol)
        # No stop (−inf) never exits; fill with the close so 0 × −inf never runs.
        fill = np.where(gap | ~np.isfinite(stop), day_px, stop)     # native
        exit_val = do_value0 * fill / price0                        # base value at exit
        # Already below stop today → sold now at today's price.
        now_out = already & follow_stops
        exit_day = np.where(now_out, -1, first)
        exit_val = np.where(now_out, do_value0, exit_val)
        stopped = (now_out | any_hit) & (do_value0 > 0)

        t_idx = np.arange(horizon)[None, :, None]                   # (1, H, 1)
        alive = t_idx < exit_day[:, None, :]                        # held that close
        disc_val = np.where(alive, do_hold,
                            np.where(stopped[:, None, :], exit_val[:, None, :], do_hold))
        disc_nav = np.concatenate(
            [np.full((n_paths, 1), start), disc_val.sum(axis=2) + do_cash], axis=1)

        if k is None:
            fmove = np.expm1(f.sum(axis=1)) * 100                   # (n, F)
            res = {"k": None, "random": True,
                   "market_move_pct": {key: round(float(np.median(fmove[:, i])), 2)
                                       for key, i in fidx.items()},
                   "market_move_range": {key: [round(float(np.percentile(fmove[:, i], q)), 2)
                                               for q in (10, 50, 90)]
                                         for key, i in fidx.items()}}
        else:
            res = {"k": k, "market_move_pct": {
                key: round(float(np.expm1(k * fvol[i] * np.sqrt(horizon))) * 100, 2)
                for key, i in fidx.items()}}
        for name, nav in (("disciplined", disc_nav), ("hold", hold_nav)):
            idx = nav / start * 100
            dd = _max_drawdown(nav) * 100
            final = idx[:, -1] - 100
            res[name] = {
                "p10": np.percentile(idx, 10, axis=0).round(3).tolist(),
                "p50": np.percentile(idx, 50, axis=0).round(3).tolist(),
                "p90": np.percentile(idx, 90, axis=0).round(3).tolist(),
                "dd_p50": np.percentile(
                    nav / np.maximum.accumulate(nav, axis=1) * 100 - 100, 50, axis=0
                ).round(3).tolist(),
                "dd_p90": np.percentile(
                    nav / np.maximum.accumulate(nav, axis=1) * 100 - 100, 10, axis=0
                ).round(3).tolist(),
                "final_p10": round(float(np.percentile(final, 10)), 2),
                "final_p50": round(float(np.percentile(final, 50)), 2),
                "final_p90": round(float(np.percentile(final, 90)), 2),
                "maxdd_p50": round(float(np.percentile(dd, 50)), 2),
                "maxdd_p90": round(float(np.percentile(dd, 10)), 2),   # worse tail
                "p_loss": round(float((final < 0).mean()) * 100, 1),
                "p_loss_gt_5": round(float((final <= -5).mean()) * 100, 1),
                "p_loss_gt_10": round(float((final <= -10).mean()) * 100, 1),
            }
        # Paired: same draws on both sides, so the per-path gap IS the decision.
        # (Differencing the two rounded medians quantised it to 0.01% of NAV.)
        gap = disc_nav[:, -1] - hold_nav[:, -1]
        res["diff_value"] = {f"p{q}": round(float(np.percentile(gap, q)), 2) + 0.0 for q in (10, 50, 90)}
        # Half a satang/cent: float noise on identical books is not "better".
        res["p_do_better"] = round(float((gap > 0.005).mean()) * 100, 1)
        res["stop_prob"] = {keys[j]: round(float(stopped[:, j].mean()) * 100, 1)
                            for j in range(m)}
        res["avg_stops"] = round(float(stopped.sum(axis=1).mean()), 2)
        out.append(res)

    return {
        "scenarios": out,
        "start_value": round(start, 2),
        "cash": round(cash, 2),
        "horizon": horizon,
        "n_paths": n_paths,
        "follow_stops": follow_stops,
        "market": "random" if market == "random" else "sd",
        "do_cash": round(do_cash, 2),
        "do_turnover": round(float(np.abs(value0 - do_value0).sum()), 2),
        "holdings": [
            {"key": keys[j], "scale": round(float(sc[j]), 6),
             "do_value": round(float(do_value0[j]), 2),
             "symbol": h.symbol, "value": round(h.value, 2), "weight_pct": round(h.value / start * 100, 2),
             "price": h.price, "stop": h.stop, "factor": h.factor, "beta": round(h.beta, 2),
             "resid_vol_pct": round(h.resid_vol * 100, 2),
             "below_stop_now": bool(already[j] and h.value > 0)}
            for j, h in enumerate(holdings)
        ],
    }
