"""
Black-Scholes Greeks + Gram-Charlier fat-tail adjustment (Corrado-Su 1996).

Standard Greeks:  delta, gamma, theta, vega, rho
Adjusted Greeks:  delta_adj, gamma_adj, theta_adj, vega_adj, rho_adj
                  (subscripted _adj = GC correction for skewness + excess kurtosis)

All Greeks use finite differences on adjusted price for consistency.
Theta is per-calendar-day, vega is per 1pp IV move.
"""

import math
from datetime import date, datetime

import numpy as np
from scipy.stats import norm


# ── Risk-free rate proxy (US 10Y approximation — update periodically) ─────────
_RISK_FREE_RATE = 0.0525


def _days_to_expiry(expiry_str: str) -> float:
    """Return T in years. Returns 0.0 if expired."""
    today = date.today()
    try:
        exp = datetime.strptime(expiry_str, "%Y-%m-%d").date()
    except ValueError:
        return 0.0
    delta = (exp - today).days
    return max(delta / 365.0, 0.0)


# ── Black-Scholes price ───────────────────────────────────────────────────────

def _bs_price(S: float, K: float, T: float, r: float, sigma: float, opt: str) -> float:
    if T <= 0 or sigma <= 0:
        intrinsic = max(S - K, 0) if opt == "call" else max(K - S, 0)
        return intrinsic
    d1 = (math.log(S / K) + (r + 0.5 * sigma**2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    if opt == "call":
        return S * norm.cdf(d1) - K * math.exp(-r * T) * norm.cdf(d2)
    return K * math.exp(-r * T) * norm.cdf(-d2) - S * norm.cdf(-d1)


# ── Gram-Charlier Q correction terms ─────────────────────────────────────────

def _gc_correction(S: float, K: float, T: float, r: float, sigma: float,
                   skew: float, kurt: float) -> float:
    """
    Corrado-Su (1996) correction to BS price.
    skew = standardized 3rd moment, kurt = excess kurtosis (Normal=0).
    """
    if T <= 0 or sigma <= 0:
        return 0.0

    sqT = math.sqrt(T)
    d1  = (math.log(S / K) + (r + 0.5 * sigma**2) * T) / (sigma * sqT)

    # Clamp skew/kurt to reasonable bounds (prevent explosive corrections)
    skew = max(min(skew, 3.0), -3.0)
    kurt = max(min(kurt, 10.0), -1.5)

    d2     = d1 - sigma * sqT
    pdf_d1 = norm.pdf(d1)
    # Corrado-Su (1996): Q3 uses d1, Q4 uses d2=d1-σ√T
    Q3 = S * sigma * sqT * (2 * sigma * sqT - d1) * pdf_d1
    Q4 = S * sigma * sqT * pdf_d1 * (d1**2 - 1 - 3 * sigma * sqT * d2)

    return (skew / 6.0) * Q3 + (kurt / 24.0) * Q4


def _gc_price(S: float, K: float, T: float, r: float, sigma: float,
              opt: str, skew: float, kurt: float) -> float:
    return _bs_price(S, K, T, r, sigma, opt) + _gc_correction(S, K, T, r, sigma, skew, kurt)


# ── Greeks via finite differences ────────────────────────────────────────────

def _finite_diff_greeks(price_fn, S, K, T, r, sigma):
    eps_S     = S * 0.001
    eps_sigma = 0.001
    eps_T     = 1 / 365
    eps_r     = 0.0001

    p0   = price_fn(S,        K, T,        r,        sigma)
    p_su = price_fn(S+eps_S,  K, T,        r,        sigma)
    p_sd = price_fn(S-eps_S,  K, T,        r,        sigma)
    p_td = price_fn(S,        K, T-eps_T,  r,        sigma) if T > eps_T else p0
    p_vu = price_fn(S,        K, T,        r,        sigma+eps_sigma)
    p_ru = price_fn(S,        K, T,        r+eps_r,  sigma)

    delta = (p_su - p_sd) / (2 * eps_S)
    gamma = (p_su - 2*p0 + p_sd) / (eps_S**2)
    theta = (p_td - p0) / eps_T          # per year → divide below for per-day
    vega  = (p_vu - p0) / eps_sigma      # per unit sigma → scale to per 1pp
    rho   = (p_ru - p0) / eps_r

    return {
        "price":  round(p0, 4),
        "delta":  round(delta, 4),
        "gamma":  round(gamma, 6),
        "theta":  round(theta / 365, 4),   # per calendar day
        "vega":   round(vega / 100, 4),    # per 1pp IV
        "rho":    round(rho / 100, 4),     # per 1pp rate
    }


# ── Public API ────────────────────────────────────────────────────────────────

def compute_greeks(
    spot: float,
    strike: float,
    expiry: str,
    option_type: str,  # "call" | "put"
    implied_vol: float,
    skew: float = 0.0,
    kurt: float = 0.0,
    risk_free: float = _RISK_FREE_RATE,
) -> dict:
    """
    Returns both BS and GC-adjusted Greeks for one contract.
    implied_vol: decimal (0.25 = 25% IV)
    skew, kurt: from estimate_moments(); defaults=0 → pure Black-Scholes
    """
    T = _days_to_expiry(expiry)

    if T <= 0:
        return {"error": "expired", "T_years": 0.0}

    if implied_vol <= 0:
        return {"error": "no_iv", "T_years": round(T, 4)}

    S, K, sigma = spot, strike, implied_vol

    bs = _finite_diff_greeks(
        lambda s, k, t, r, v: _bs_price(s, k, t, r, v, option_type),
        S, K, T, risk_free, sigma,
    )
    adj = _finite_diff_greeks(
        lambda s, k, t, r, v: _gc_price(s, k, t, r, v, option_type, skew, kurt),
        S, K, T, risk_free, sigma,
    )

    return {
        "T_years":    round(T, 4),
        "days_to_exp": round(T * 365),
        "spot":       round(S, 4),
        "strike":     strike,
        "iv":         round(sigma * 100, 2),   # show as %
        "skew_input": round(skew, 4),
        "kurt_input": round(kurt, 4),
        # Standard BS Greeks
        "price":      bs["price"],
        "delta":      bs["delta"],
        "gamma":      bs["gamma"],
        "theta":      bs["theta"],
        "vega":       bs["vega"],
        "rho":        bs["rho"],
        # Gram-Charlier adjusted (fat-tail aware)
        "price_adj":  adj["price"],
        "delta_adj":  adj["delta"],
        "gamma_adj":  adj["gamma"],
        "theta_adj":  adj["theta"],
        "vega_adj":   adj["vega"],
        "rho_adj":    adj["rho"],
        # Difference (impact of fat-tail correction)
        "delta_diff": round(adj["delta"] - bs["delta"], 4),
        "gamma_diff": round(adj["gamma"] - bs["gamma"], 6),
        "theta_diff": round(adj["theta"] - bs["theta"], 4),
        "vega_diff":  round(adj["vega"]  - bs["vega"],  4),
    }


def estimate_moments(symbol: str, lookback_days: int = 252) -> dict:
    """
    Estimate skewness and excess kurtosis from historical log-returns.
    Falls back to (0, 0) on any error so Greeks still compute.
    """
    try:
        from sources import market_data
        hist = market_data.get_ticker(symbol).history(period=f"{lookback_days}d")["Close"]
        ret  = np.log(hist / hist.shift(1)).dropna()
        if len(ret) < 30:
            return {"skew": 0.0, "kurt": 0.0}
        std = ret.std()
        if std == 0:
            return {"skew": 0.0, "kurt": 0.0}
        r_std = (ret - ret.mean()) / std
        skew  = float((r_std**3).mean())
        kurt  = float((r_std**4).mean()) - 3.0
        return {
            "skew": round(max(min(skew, 3.0), -3.0), 4),
            "kurt": round(max(min(kurt, 10.0), -1.5), 4),
        }
    except Exception:
        return {"skew": 0.0, "kurt": 0.0}
