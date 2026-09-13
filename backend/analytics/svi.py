"""Descriptive Raw SVI slice calibration, using spot-referenced log strike.

Gatheral/Jacquier eq. (3.1): w(k)=a+b*(rho*(k-m)+hypot(k-m,sigma)).
Fit TOTAL variance IV^2*T with robust soft-L1 residuals. Positive minimum
variance is enforced; independent slices are not an arbitrage-free surface.
"""
import math

import numpy as np
from scipy.optimize import least_squares

MIN_SVI_POINTS = 8


def raw_svi(k, a: float, b: float, rho: float, m: float, sigma: float):
    x = np.asarray(k) - m
    return a + b * (rho * x + np.hypot(x, sigma))


def fit_raw_svi(samples: list[dict], reference_price: float, time_years: float) -> dict:
    base = {
        "status": "unavailable", "reason": None, "parameters": None,
        "rmseIvPct": None, "usedPoints": 0, "minStrike": None, "maxStrike": None,
        "referencePrice": reference_price, "timeYears": time_years,
    }
    if not (math.isfinite(reference_price) and reference_price > 0
            and math.isfinite(time_years) and time_years > 0):
        return {**base, "reason": "Positive reference price and time to expiry are required."}
    # Median duplicate strikes: duplicates must not change the number of observations.
    by_strike: dict[float, list[float]] = {}
    for row in samples:
        strike, iv_pct = row.get("strike"), row.get("ivPercent")
        if not isinstance(strike, (int, float)) or not isinstance(iv_pct, (int, float)):
            continue
        if not (math.isfinite(strike) and strike > 0 and math.isfinite(iv_pct) and iv_pct > 0.01):
            continue
        by_strike.setdefault(strike, []).append(iv_pct / 100)
    strikes = np.array(sorted(by_strike), dtype=float)
    count = len(strikes)
    base.update(usedPoints=count, minStrike=float(strikes[0]) if count else None,
                maxStrike=float(strikes[-1]) if count else None)
    if count < MIN_SVI_POINTS:
        return {**base, "reason": f"Need at least {MIN_SVI_POINTS} distinct usable strikes ({count} available)."}
    ivs = np.array([np.median(by_strike[strike]) for strike in strikes])
    k = np.log(strikes / reference_price)
    if float(np.ptp(k)) < 0.05:
        return {**base, "reason": "Strike coverage is too narrow for a five-parameter fit."}
    w = ivs ** 2 * time_years
    scale = float(np.median(w))
    y = w / scale

    def unpack(z):
        q, b, rho, m, sigma = z
        # q is the global minimum of w, so positivity holds at every log strike.
        return q - b * sigma * np.sqrt(1 - rho * rho), b, rho, m, sigma

    def residual(z):
        return raw_svi(k, *unpack(z)) - y

    if float(np.ptp(y)) < 1e-8:
        params = {"a": scale, "b": 0.0, "rho": 0.0, "m": 0.0, "sigma": 0.1}
    else:
        slope = max(0.05, float(np.ptp(y) / np.ptp(k)))
        lower = [1e-8, 0, -0.995, float(k.min()) - 1, 0.001]
        upper = [max(100, float(y.max()) * 10), max(100, slope * 10),
                 0.995, float(k.max()) + 1, 2]
        best = None
        # Deterministic multistart avoids relying on one local optimizer basin.
        for rho in (-0.6, 0, 0.6):
            for sigma in (0.05, 0.3):
                initial = [max(1e-6, float(y.min()) * 0.5), slope, rho,
                           float(k[np.argmin(y)]), sigma]
                try:
                    result = least_squares(
                        residual, initial, bounds=(lower, upper), loss="soft_l1",
                        f_scale=0.1, max_nfev=600, x_scale="jac",
                        ftol=1e-9, xtol=1e-9, gtol=1e-9,
                    )
                except (ValueError, FloatingPointError):
                    continue
                if (result.success and np.isfinite(result.cost)
                        and (best is None or result.cost < best.cost)):
                    best = result
        if best is None:
            return {**base, "reason": "SVI optimizer did not converge. Observed quotes remain available."}
        a, b, rho, m, sigma = unpack(best.x)
        params = {"a": float(a * scale), "b": float(b * scale), "rho": float(rho),
                  "m": float(m), "sigma": float(sigma)}
    fitted_w = raw_svi(k, **params)
    if not np.all(np.isfinite(fitted_w)) or np.any(fitted_w <= 0):
        return {**base, "reason": "SVI produced invalid total variance."}
    rmse = float(np.sqrt(np.mean((100 * np.sqrt(fitted_w / time_years) - 100 * ivs) ** 2)))
    return {**base, "status": "ok", "parameters": params, "rmseIvPct": rmse}
