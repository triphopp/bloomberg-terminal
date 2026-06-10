"""
Layer MOM — Cross-Sectional Sector Momentum.

3-horizon composite (12M-1M + 6M + 3M) with short-term reversal
adjustment (Jegadeesh 1990).  Cross-sectional z-score ranks each
sector against the other 10 at the same point in time.

References:
  Moskowitz & Grinblatt (1999) — Do Industries Explain Momentum?
  Asness, Moskowitz & Pedersen (2013) — Value and Momentum Everywhere
  Jegadeesh (1990) — Evidence of Predictable Behavior of Security Returns
"""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from statistics import mean, stdev

import numpy as np

from sources import market_data

from .sector_bc import SECTOR_ETFS  # shared constant

# ── Cache ──────────────────────────────────────────────────────────────────────

_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()
CACHE_TTL = 1800  # 30 min


# ── Helpers ────────────────────────────────────────────────────────────────────

def _compute_one_momentum(ticker: str) -> dict:
    """Fetch 2-year history and compute momentum components for one ETF."""
    try:
        frame = market_data.get_history(ticker, period="2y", interval="1d")
        df = frame.df
        if df is None or df.empty:
            return {"ticker": ticker, "error": f"no history for {ticker}"}

        close = df["Close"].dropna()
        n = len(close)
        if n < 64:
            return {"ticker": ticker, "error": f"insufficient history ({n}d)"}

        p = close.values

        mom_12_1 = float(p[-22] / p[-253] - 1) if n >= 253 else 0.0
        mom_6m   = float(p[-22] / p[-127] - 1) if n >= 127 else 0.0
        mom_3m   = float(p[-6]  / p[-64]  - 1) if n >= 64  else 0.0
        r_1m     = float(p[-1]  / p[-21]  - 1) if n >= 21  else 0.0

        # 3-horizon composite
        composite = 0.50 * mom_12_1 + 0.30 * mom_6m + 0.20 * mom_3m
        # Reversal dampening (Jegadeesh 1990)
        composite -= 0.30 * r_1m

        # Daily returns for vol scaling
        daily_ret = np.diff(p) / p[:-1]
        realized_vol = float(np.std(daily_ret[-22:]) * np.sqrt(252)) if len(daily_ret) >= 22 else None

        return {
            "ticker":        ticker,
            "mom_12_1":      round(mom_12_1, 6),
            "mom_6m":        round(mom_6m, 6),
            "mom_3m":        round(mom_3m, 6),
            "r_1m":          round(r_1m, 6),
            "composite":     round(composite, 6),
            "realized_vol":  round(realized_vol, 6) if realized_vol else None,
            "error":         None,
        }
    except Exception as e:
        print(f"[sector_mom] {ticker}: {e}")
        return {"ticker": ticker, "error": str(e)}


# ── Main computation ───────────────────────────────────────────────────────────

def compute_momentum() -> dict[str, dict]:
    """Return {ticker: {z_score, mom_12_1, mom_6m, mom_3m, r_1m, ...}}."""
    now = time.time()
    with _cache_lock:
        if "m" in _cache:
            ts, val = _cache["m"]
            if now - ts < CACHE_TTL:
                return val

    # Fetch all 11 ETFs in parallel
    results_raw: list[dict] = []
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(_compute_one_momentum, s): s for s in SECTOR_ETFS}
        for fut in as_completed(futures):
            results_raw.append(fut.result())

    # Build raw composite dict
    raw_M: dict[str, float] = {}
    result: dict[str, dict] = {}
    for r in results_raw:
        t = r.pop("ticker")
        if r.get("error"):
            raw_M[t] = 0.0
            result[t] = {"z_score": 0.0, "error": r["error"]}
        else:
            raw_M[t] = r["composite"]
            result[t] = r

    # Cross-sectional z-score
    vals = list(raw_M.values())
    if len(vals) > 1 and any(v != 0 for v in vals):
        mu  = mean(vals)
        sd  = stdev(vals) or 1.0
    else:
        mu, sd = 0.0, 1.0

    for s in SECTOR_ETFS:
        z = (raw_M.get(s, 0.0) - mu) / sd if sd > 1e-8 else 0.0
        result[s]["z_score"] = round(float(np.clip(z, -2.5, 2.5)), 4)

    # Volatility scaling (Moreira & Muir 2017)
    vols = [result[s].get("realized_vol") for s in SECTOR_ETFS
            if result[s].get("realized_vol")]
    if vols:
        vol_target = float(np.median(vols))
        for s in SECTOR_ETFS:
            rv = result[s].get("realized_vol")
            if rv and rv > 0:
                result[s]["vol_adj_z"] = round(
                    result[s]["z_score"] * (vol_target / max(rv, vol_target)), 4)
            else:
                result[s]["vol_adj_z"] = result[s]["z_score"]

    with _cache_lock:
        _cache["m"] = (now, result)
    return result


def clear_momentum_cache() -> None:
    """Clear the MOM layer cache."""
    with _cache_lock:
        _cache.pop("m", None)
