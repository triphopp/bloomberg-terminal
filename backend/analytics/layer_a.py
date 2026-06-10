"""
Layer A — Market Sentiment (Relative Performance Z-score).

SPY = equity proxy, AGG = bond proxy.
Compute 20d relative return z-score vs rolling 252d window.
Optional volatility scaling per Moreira & Muir (2017).
"""
from statistics import mean, stdev

import numpy as np


def _rolling_mean_std(series: np.ndarray, window: int) -> tuple[float, float]:
    """Return mean and std of the last `window` elements."""
    w = series[-window:]
    return float(mean(w)), float(stdev(w)) if len(w) > 1 else 0.0


def compute_layer_a(
    spy_prices: list[float],
    agg_prices: list[float],
    lookback_days: int = 20,
    z_window: int = 252,
    vol_scale: bool = True,
) -> dict:
    """
    Compute Layer A sentiment score.

    Args:
        spy_prices: SPY daily closes, oldest first
        agg_prices: AGG daily closes, oldest first
        lookback_days: return window (default 20 = ~1 month)
        z_window: rolling z-score window (default 252 = ~1 year)
        vol_scale: apply volatility scaling (Moreira & Muir 2017)

    Returns:
        {
            "score": int {-1, 0, +1},
            "z_score": float,
            "r_rel_20d": float,
            "r_equity_20d": float,
            "r_bond_20d": float,
            "mu_A": float, "sigma_A": float,
            "realized_vol": float | None,
        }
    """
    if len(spy_prices) < lookback_days + 1 or len(agg_prices) < lookback_days + 1:
        return {"score": 0, "z_score": 0.0, "r_rel_20d": 0.0,
                "r_equity_20d": 0.0, "r_bond_20d": 0.0,
                "mu_A": 0.0, "sigma_A": 0.0, "realized_vol": None,
                "error": "insufficient data"}

    spy = np.array(spy_prices, dtype=float)
    agg = np.array(agg_prices, dtype=float)

    # 20d returns
    r_equity = float(spy[-1] / spy[-lookback_days - 1] - 1)
    r_bond   = float(agg[-1] / agg[-lookback_days - 1] - 1)
    r_rel    = r_equity - r_bond

    # Rolling daily relative returns for z-score
    spy_daily = spy[1:] / spy[:-1] - 1
    agg_daily = agg[1:] / agg[:-1] - 1
    rel_daily = spy_daily[-min(len(spy_daily), z_window):] - agg_daily[-min(len(agg_daily), z_window):]

    if len(rel_daily) < 2:
        return {"score": 0, "z_score": 0.0, "r_rel_20d": round(r_rel, 6),
                "r_equity_20d": round(r_equity, 6), "r_bond_20d": round(r_bond, 6),
                "mu_A": 0.0, "sigma_A": 0.0, "realized_vol": None}

    mu_A, sigma_A = _rolling_mean_std(rel_daily, min(len(rel_daily), z_window))

    if sigma_A < 1e-8:
        z_A = 0.0
    else:
        z_A = float((r_rel - mu_A) / sigma_A)

    # Volatility scaling (Moreira & Muir 2017)
    realized_vol = None
    if vol_scale:
        vol_window = min(22, len(rel_daily))
        rv = float(stdev(rel_daily[-vol_window:])) if len(rel_daily[-vol_window:]) > 1 else 0.0
        realized_vol = rv * np.sqrt(252) if rv > 0 else 0.0
        if realized_vol > 1e-8 and sigma_A > 1e-8:
            target_vol = sigma_A  # long-run σ as target
            z_A = z_A * (target_vol / realized_vol)

    # Score with ±0.5 threshold
    if z_A > 0.5:
        score = 1
    elif z_A < -0.5:
        score = -1
    else:
        score = 0

    return {
        "score": score,
        "z_score": round(z_A, 6),
        "r_rel_20d": round(r_rel, 6),
        "r_equity_20d": round(r_equity, 6),
        "r_bond_20d": round(r_bond, 6),
        "mu_A": round(mu_A, 8),
        "sigma_A": round(sigma_A, 8),
        "realized_vol": round(realized_vol, 8) if realized_vol else None,
    }
