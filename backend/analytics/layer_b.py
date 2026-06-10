"""
Layer B — Flow Direction (ETF Flow Proxy).

Tracks net flow into equity vs bond ETFs using price-adjusted AUM.
Shares outstanding would be ideal but yfinance only provides snapshots.
Fallback: adjust AUM by index return to strip price appreciation bias.

References:
  Ben-David, Franzoni & Moussawi (2018) — Do ETFs Increase Volatility?
  ICI — ETF Creation/Redemption Mechanics
"""
from statistics import mean, stdev
import numpy as np


# Equity and bond ETF baskets
EQUITY_ETFS = ["SPY", "QQQ", "VT", "EFA", "EEM"]
BOND_ETFS   = ["AGG", "BND", "TLT", "IEF"]


def _compute_aum(prices: np.ndarray, shares: float | None) -> np.ndarray | None:
    """Estimate AUM time series = price × shares_outstanding."""
    if shares is None:
        return None
    return prices * shares


def compute_layer_b(
    etf_data: dict[str, dict],
    lookback_days: int = 20,
    z_window: int = 252,
) -> dict:
    """
    Compute Layer B flow score from ETF data.

    Args:
        etf_data: {ticker: {prices: [oldest..newest], shares_outstanding: float | None}}
        lookback_days: flow accumulation window (default 20)
        z_window: rolling z-score window

    Returns:
        {
            "score": int {-1, 0, +1},
            "z_score": float,
            "flow_ratio": float,
            "equity_flow_20d": float,
            "bond_flow_20d": float,
            "mu_B": float, "sigma_B": float,
            "method": "shares_outstanding" | "price_adjusted_aum",
        }
    """
    equity_flows = []
    bond_flows = []
    method = "price_adjusted_aum"

    for ticker, info in etf_data.items():
        prices = np.array(info.get("prices", []), dtype=float)
        if len(prices) < lookback_days + 1:
            continue

        shares = info.get("shares_outstanding")
        has_shares_ts = isinstance(shares, list) and len(shares) == len(prices)

        if has_shares_ts:
            # Flow proxy: Δ shares × avg price (creation/redemption)
            method = "shares_outstanding"
            shares_arr = np.array(shares, dtype=float)
            aum = prices * shares_arr
            aum_prev = np.roll(prices, 1) * np.roll(shares_arr, 1)
            daily_flow = aum - aum_prev
            daily_flow[0] = 0.0
        else:
            # Fallback: price-adjusted AUM
            # AUM ~ price (shares constant over short window), so:
            # adj_AUM(t) = price(t) / price(t-1) - 1  →  same as return
            # But flow needs dollar magnitude. Use AUM ≈ price × snapshot_shares.
            snapshot_shares = shares if shares else 1e9  # default large for major ETFs
            aum = prices * snapshot_shares
            aum_prev = np.roll(aum, 1)
            daily_flow = aum - aum_prev
            daily_flow[0] = 0.0

            # Subtract price-driven component: ΔAUM - AUM_prev × (Δprice/price_prev)
            price_ret = prices[1:] / prices[:-1] - 1
            price_driven = np.zeros_like(daily_flow)
            price_driven[1:] = aum_prev[1:] * price_ret
            daily_flow = daily_flow - price_driven

        flow_20d = float(np.sum(daily_flow[-lookback_days:]))
        if ticker in EQUITY_ETFS:
            equity_flows.append(flow_20d)
        elif ticker in BOND_ETFS:
            bond_flows.append(flow_20d)

    if not equity_flows or not bond_flows:
        return {"score": 0, "z_score": 0.0, "flow_ratio": 0.0,
                "equity_flow_20d": 0.0, "bond_flow_20d": 0.0,
                "mu_B": 0.0, "sigma_B": 0.0, "method": method,
                "error": "insufficient ETF data"}

    equity_flow_20d = float(sum(equity_flows))
    bond_flow_20d   = float(sum(bond_flows))
    total_flow      = abs(equity_flow_20d) + abs(bond_flow_20d)

    if total_flow < 1e-8:
        flow_ratio = 0.0
    else:
        flow_ratio = equity_flow_20d / total_flow

    # For z-score we need a rolling series of flow_ratios.
    # With only a single cross-sectional point, we approximate:
    # Use the raw flow_ratio as a z-proxy — ratios bounded [-1, 1].
    # μ ~ 0 (equity/bond flows roughly balance long-term), σ ~ 0.3.
    mu_B = 0.0
    sigma_B = 0.3
    z_B = float((flow_ratio - mu_B) / sigma_B) if sigma_B > 1e-8 else 0.0

    if z_B > 0.5:
        score = 1
    elif z_B < -0.5:
        score = -1
    else:
        score = 0

    return {
        "score": score,
        "z_score": round(z_B, 6),
        "flow_ratio": round(flow_ratio, 6),
        "equity_flow_20d": round(equity_flow_20d, 2),
        "bond_flow_20d": round(bond_flow_20d, 2),
        "mu_B": mu_B,
        "sigma_B": sigma_B,
        "method": method,
    }
