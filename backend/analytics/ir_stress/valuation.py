"""
Discount-rate channel: what a rate shock does to the equity value.

Gordon with an assumed growth rate does not work. Running g = ROE x (1 - payout)
across 15 large caps on 2026-08-31 pushed 8 of them into the g >= k_e guard, so
they all returned the same -66.7% per 100bp and the mean came out at -46.9%
against a measured -3.6%. The failure is not the model, it is that a
perpetuity's value is hypersensitive to a growth rate nobody can observe.

Inverting it removes the guess entirely. P0 = CF1 / (k_e - g) means the market
has already told us the spread:

    k_e - g = CF1 / P0 = shareholder yield        D_E = 1 / yield

CF1 has to include buybacks. Exxon returns more through repurchases (3.1% of cap)
than dividends (2.7%), so a dividend-only yield halves its spread and doubles its
duration.

The second correction is pass-through. Textbook treatment sets d(k_e) = d(r_f),
i.e. theta = 1. Backing theta out of the measured rate betas gives a median of
0.12 — a 100bp move in the risk-free rate reaches the equity discount spread as
about 12bp, the rest absorbed by a compressing equity risk premium and nominal
growth moving with inflation. Using theta = 1 overstates the hit by 8-30x.
"""
from __future__ import annotations

from typing import Any

# Equity risk premium. A constant here is a simplification: the whole point of
# theta below is that the ERP is not constant when rates move.
ERP = 0.045

# Measured on 2026-08-31 from theta = -kappa_10 / dr * (k_e - g). Used only when a
# name has no usable regression of its own; the dispersion between these groups
# is the substance, so a single global number would erase it.
THETA_SECTOR_DEFAULT: dict[str, float] = {
    "Real Estate": 0.21,
    "Utilities": 0.21,
    "Consumer Defensive": 0.06,
    "Technology": 0.06,
    "Communication Services": 0.08,
    "Energy": -0.24,
}
THETA_FALLBACK = 0.12  # cross-sectional median


def _cf_yield(ticker: Any, market_cap: float | None) -> dict:
    """Total shareholder yield: dividends plus buybacks over market cap."""
    if not market_cap:
        return {"total": None, "dividend": None, "buyback": None}

    cf = ticker.cashflow

    def row(name: str) -> float:
        try:
            v = cf.loc[name].iloc[0]
            return abs(float(v)) if v == v else 0.0
        except Exception:  # noqa: BLE001
            return 0.0

    divs = row("Cash Dividends Paid") or row("Common Stock Dividend Paid")
    buybacks = row("Repurchase Of Capital Stock")
    dy = divs / market_cap
    by = buybacks / market_cap
    return {
        "total": dy + by,
        "dividend": dy,
        "buyback": by,
        "source": "yfinance cashflow / market cap",
    }


def valuation_profile(symbol: str, beta: float | None, sector: str | None,
                      theta_measured: float | None = None,
                      info: dict | None = None) -> dict:
    """Equity duration and the pass-through used to shock it.

    `info` is the heaviest call yfinance makes and the first to fail under
    throttling, so the caller passes in the one it already fetched rather than
    each layer asking for its own.
    """
    from routers import market as _market
    from analytics.ir_stress import curve as _curve

    ticker = _market.market_data.get_ticker(symbol.upper())
    if info is None:
        info = ticker.info or {}
    mcap = info.get("marketCap")

    crv = _curve.get_curve()
    rf = crv["points"].get("10Y")

    yields = _cf_yield(ticker, mcap)
    spread = yields["total"]

    k_e = (rf + beta * ERP) if (rf is not None and beta is not None) else None
    g_implied = (k_e - spread) if (k_e is not None and spread) else None

    theta = theta_measured
    theta_src = "regression"
    if theta is None:
        theta = THETA_SECTOR_DEFAULT.get(sector or "", THETA_FALLBACK)
        theta_src = "sector default" if sector in THETA_SECTOR_DEFAULT else "cross-sectional median"

    return {
        "market_cap": mcap,
        "risk_free": rf,
        "beta": beta,
        "k_e": k_e,
        "shareholder_yield": yields,
        "spread": spread,
        "g_implied": g_implied,
        "duration": (1 / spread) if spread else None,
        "theta": theta,
        "theta_source": theta_src,
        "method": "Gordon inverted: k_e - g = CF1/P0, so duration = 1/yield",
    }


def price_impact(profile: dict, d_rf: float) -> dict:
    """Exact Gordon revaluation for a shock of `d_rf` in decimal rate units.

    Linearising this is only safe for small moves. For a REIT-like spread of
    4.3% and theta 0.33 the exact and linear answers differ by 0.5pp at 100bp and
    by 10.7pp at 500bp, with the linear version overstating by nearly 40% of its
    own value — so the exact form is what gets returned and the linear one is
    carried alongside purely as the diagnostic.
    """
    spread = profile.get("spread")
    theta = profile.get("theta")
    if not spread or theta is None:
        return {"exact": None, "linear": None, "convexity": None}

    dk = theta * d_rf
    denom = spread + dk
    if denom <= 0:
        return {
            "exact": None,
            "linear": None,
            "convexity": None,
            "status": "invalid_terminal_assumption",
            "note": "shocked discount rate falls to or below the growth rate",
        }

    exact = (spread / denom) - 1
    linear = -dk / spread
    return {
        "exact": exact,
        "linear": linear,
        "convexity": exact - linear,
        "status": "ok",
    }
