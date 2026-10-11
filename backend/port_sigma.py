"""Daily sigma for PORT → POSITIONS — "is today's move unusual?" (2026-10-09).

Pure math, no network: the router hands in date-aligned return matrices and
the open lots, this hands back one block per symbol, per account, per sub-port
and for the book.

Method
- sigma = EWMA of squared daily returns, lambda 0.94 (RiskMetrics), zero mean.
  It follows the current level of volatility; a 252-day SD does not.
- A group's sigma is the EWMA of the GROUP'S OWN return series built with
  today's weights — the same number as sqrt(w' Sigma w) on an EWMA covariance
  matrix. Per-symbol sigmas are never added together.
- VaR / CVaR = filtered historical simulation: every past day is divided by the
  sigma it was expected to have, and the 5% tail of those standardized days is
  scaled by today's sigma. Fat tails stay, and so does the current vol level.
  Fewer than MIN_FHS_OBS days → the normal quantile, and `method` says so.

Two bases, on purpose
- `sigma_pct` is PRICE ONLY (local currency). The Today figure it is compared
  with is (price − previous close) converted at one FX rate, so it holds no
  currency move either.
- `var_*` / `cvar_*` INCLUDE the currency: that is the money that can be lost.
"""
from __future__ import annotations

import math
from typing import Iterable, Optional

import numpy as np

LAMBDA = 0.94
MIN_OBS = 60            # days of history before a sigma is printed
MIN_FHS_OBS = 120       # days before the tail is read from history
BURN_IN = 20            # first days of an EWMA are its seed, not a forecast
MIN_DAY_COVER = 0.5     # share of a group's weight that must have traded that day

_NORMAL = {0.90: (1.2816, 1.7550), 0.95: (1.6449, 2.0627), 0.99: (2.3263, 2.6652)}

# SET price spreads (stocks), upper bound of the price band → tick.
_SET_TICKS = ((2, 0.01), (5, 0.02), (10, 0.05), (25, 0.10), (100, 0.25),
              (200, 0.50), (400, 1.00), (math.inf, 2.00))


def set_tick(price: float) -> float:
    for upper, tick in _SET_TICKS:
        if price < upper:
            return tick
    return 2.00


def tick_pct(yf_symbol: str, price: Optional[float]) -> Optional[float]:
    """One price step as % of the price — only where the step is known (SET)."""
    if not price or price <= 0 or not str(yf_symbol or "").upper().endswith(".BK"):
        return None
    return set_tick(float(price)) / float(price) * 100.0


def ewma_path(r: np.ndarray, lam: float = LAMBDA) -> tuple[np.ndarray, float]:
    """(variance expected FOR each day, variance expected for the next day).

    `path[t]` uses returns up to t−1 only, so r[t] / sqrt(path[t]) is an honest
    out-of-sample standardized day.
    """
    r = np.asarray(r, dtype=float)
    n = len(r)
    path = np.empty(n)
    seed = float(np.mean(r[: min(n, BURN_IN)] ** 2)) if n else 0.0
    v = seed
    for t in range(n):
        path[t] = v
        v = lam * v + (1.0 - lam) * r[t] * r[t]
    return path, v


def _tail(r: np.ndarray, confidence: float, lam: float) -> Optional[dict]:
    """sigma + VaR/CVaR of one return series, all as fractions (0.02 = 2%)."""
    r = np.asarray(r, dtype=float)
    r = r[np.isfinite(r)]
    if len(r) < MIN_OBS:
        return None
    path, nxt = ewma_path(r, lam)
    sigma = math.sqrt(max(nxt, 0.0))
    if sigma <= 0:
        return None
    zq, zes = _NORMAL.get(round(confidence, 2), _NORMAL[0.95])
    method = "normal"
    if len(r) >= MIN_FHS_OBS:
        ok = path[BURN_IN:] > 0
        z = r[BURN_IN:][ok] / np.sqrt(path[BURN_IN:][ok])
        if len(z) >= MIN_FHS_OBS - BURN_IN:
            q = float(np.percentile(z, (1.0 - confidence) * 100.0))
            tail = z[z <= q]
            if q < 0 and len(tail):
                zq, zes, method = -q, -float(tail.mean()), "filtered-historical"
    return {"sigma": sigma, "var": zq * sigma, "cvar": zes * sigma,
            "method": method, "obs": int(len(r))}


def _series(R: np.ndarray, w: np.ndarray) -> np.ndarray:
    """Simple-return series of a basket with fixed weights `w` (summing to 1
    over the columns given). A day a column has no bar (not listed yet) is
    carried by the others; days with under MIN_DAY_COVER of the weight are NaN.
    """
    simple = np.expm1(R)
    have = np.isfinite(simple)
    gross = np.abs(w)
    cover = (have * gross).sum(axis=1)
    total = gross.sum()
    num = np.where(have, simple, 0.0) @ w
    out = np.full(len(R), np.nan)
    ok = cover >= MIN_DAY_COVER * total
    out[ok] = num[ok] * (total / cover[ok])
    return out


def _block(cols: list[str], values: dict[str, float], idx: dict[str, int],
           R_px: np.ndarray, R_base: np.ndarray, confidence: float, lam: float) -> dict:
    """One group: sigma on price, VaR/CVaR in base currency, money on its MV."""
    mv = float(sum(values.values()))
    gross = float(sum(abs(v) for v in values.values()))
    covered = [s for s in cols if s in idx and values.get(s)]
    cov_gross = float(sum(abs(values[s]) for s in covered))
    out = {"mv": round(mv, 2), "n": len(values), "n_covered": len(covered),
           "coverage_pct": round(cov_gross / gross * 100, 1) if gross else 0.0,
           "sigma_pct": None, "sigma_amt": None, "var_pct": None, "var_amt": None,
           "cvar_pct": None, "cvar_amt": None, "method": None, "obs": 0}
    if not covered or cov_gross <= 0:
        return out
    j = [idx[s] for s in covered]
    w = np.array([values[s] for s in covered], dtype=float) / cov_gross
    px = _tail(_series(R_px[:, j], w), confidence, lam)
    base = _tail(_series(R_base[:, j], w), confidence, lam)
    if px:
        out.update(sigma_pct=round(px["sigma"] * 100, 4),
                   sigma_amt=round(px["sigma"] * gross, 2), obs=px["obs"])
    if base:
        out.update(var_pct=round(base["var"] * 100, 4), var_amt=round(base["var"] * gross, 2),
                   cvar_pct=round(base["cvar"] * 100, 4), cvar_amt=round(base["cvar"] * gross, 2),
                   method=base["method"])
    return out


def compute(
    lots: Iterable[dict],
    symbols: list[str],
    R_px: np.ndarray,
    R_base: np.ndarray,
    prices: Optional[dict[str, float]] = None,
    confidence: float = 0.95,
    lam: float = LAMBDA,
) -> dict:
    """`lots`: {yf_symbol, account_id, sub_port, value} with value = market
    value in the report currency (signed). `symbols` names the columns of both
    matrices (T×n log returns, NaN before a listing): `R_px` in each
    instrument's own currency, `R_base` translated to the report currency.
    """
    idx = {s: i for i, s in enumerate(symbols)}
    prices = prices or {}
    total: dict[str, float] = {}
    accounts: dict[str, dict[str, float]] = {}
    subs: dict[str, dict[str, float]] = {}
    for lot in lots:
        sym, val = lot.get("yf_symbol"), float(lot.get("value") or 0.0)
        if not sym or not val:
            continue
        acct = str(lot.get("account_id") or "")
        total[sym] = total.get(sym, 0.0) + val
        a = accounts.setdefault(acct, {})
        a[sym] = a.get(sym, 0.0) + val
        s = subs.setdefault(f"{acct}::{lot.get('sub_port') or ''}", {})
        s[sym] = s.get(sym, 0.0) + val

    sym_out: dict[str, dict] = {}
    for sym in total:
        row = {"sigma_pct": None, "sigma_eff_pct": None, "tick_pct": None,
               "coarse": False, "obs": 0}
        if sym in idx:
            t = _tail(np.expm1(R_px[:, idx[sym]]), confidence, lam)
            if t:
                sig = t["sigma"] * 100
                tp = tick_pct(sym, prices.get(sym))
                # A price that moves in steps as large as its own sigma cannot
                # be read finer than one step: DCON at 0.16 moves 6.25% or not
                # at all, so one tick must not read as a 1.5-sigma day.
                coarse = tp is not None and tp > 0.5 * sig
                row = {"sigma_pct": round(sig, 4),
                       "sigma_eff_pct": round(max(sig, tp) if coarse else sig, 4),
                       "tick_pct": round(tp, 4) if tp is not None else None,
                       "coarse": bool(coarse), "obs": t["obs"]}
        sym_out[sym] = row

    cols = list(symbols)
    return {
        "symbols": sym_out,
        "accounts": {k: _block(cols, v, idx, R_px, R_base, confidence, lam)
                     for k, v in accounts.items()},
        "sub_ports": {k: _block(cols, v, idx, R_px, R_base, confidence, lam)
                      for k, v in subs.items()},
        "total": _block(cols, total, idx, R_px, R_base, confidence, lam),
    }
