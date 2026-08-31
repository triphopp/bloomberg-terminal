"""
Measured rate sensitivity from prices, and the honest limits on using it.

Regressing daily returns on changes in the 2Y and 10Y gives a beta that is well
identified for rate-sensitive names (AMT t=-6.1, PLD t=-5.9) and
indistinguishable from zero for most others (AT&T t=-0.2), which is itself a
usable answer. Mean R-squared across 34 names is 2.1%: the level of a single
name's return is not predictable from rates, only its expected value and its
rank.

The beta does not survive a regime change. Estimated on everything except 2022
and then asked to predict 2022, it missed by 18.6pp on average and flipped sign
on MSFT, AAPL and SPG — before 2022 a rising yield signalled growth and tech had
a positive rate beta; in 2022 it signalled inflation and tech was crushed. So
this module refuses to extrapolate past +/-200bp, and the transferable object is
the characteristic (duration, leverage), not the name's own beta. See
plans/cirst-validation-harness.md 2.4.
"""
from __future__ import annotations

import math
import threading
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError as FutureTimeout
from datetime import date, timedelta

from cache import TTLCache

_cache = TTLCache(ttl=21600, maxsize=256)

LOOKBACK_YEARS = 5
EXTRAPOLATION_LIMIT_BP = 200
MIN_OBS = 250

# The regression needs five years of daily prices, which is the one slow step in
# a stress run. Everything else reads a cached balance sheet or a handful of FRED
# points. When the IV recorder and the alert scanner are already competing for
# yfinance, a cold download can take minutes — well past the proxy's 60s budget —
# and the whole tab would fail on a channel that is the least reliable of the
# three. So the wait is bounded: the caller gets a degraded price channel, the
# download keeps running, and the next request finds it in the cache.
BETA_WAIT_SECONDS = 20

_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="ir-beta")
_inflight: dict[str, Future] = {}
_inflight_lock = threading.Lock()


def _fred_series(series_id: str, start: str) -> dict[str, float]:
    """Cached across symbols: the curve is the same for every name on the screen."""
    key = f"fred:{series_id}:{start}"
    hit = _cache.get(key)
    if hit is not None:
        return hit

    import requests
    from config import FRED_API_KEY

    r = requests.get(
        "https://api.stlouisfed.org/fred/series/observations",
        params={
            "series_id": series_id,
            "api_key": FRED_API_KEY,
            "file_type": "json",
            "observation_start": start,
        },
        timeout=30,
    )
    r.raise_for_status()
    out = {
        o["date"]: float(o["value"])
        for o in r.json().get("observations", [])
        if o.get("value") not in (".", "", None)
    }
    _cache.set(key, out)
    return out


def _flatten(frame):
    """yfinance hands back a single-column DataFrame or a Series depending on call."""
    return frame.iloc[:, 0] if hasattr(frame, "columns") else frame


def rate_beta(symbol: str) -> dict:
    """OLS of daily log returns on changes in the 10Y and 2Y, plus the market."""
    sym = symbol.upper()
    cached = _cache.get(f"beta:{sym}")
    if cached is not None:
        return cached

    import numpy as np
    import pandas as pd
    import yfinance as yf

    start = (date.today() - timedelta(days=365 * LOOKBACK_YEARS + 30)).isoformat()
    try:
        # SPY is the market leg for every name, so downloading it once per symbol
        # doubled the Yahoo traffic of a watchlist screen for no new information —
        # enough, with a dozen symbols in flight, to get the whole process
        # throttled and knock unrelated calls like sector lookups out with it.
        spy = _cache.get(f"spy:{start}")
        if spy is None:
            spy = yf.download("SPY", start=start, auto_adjust=True, progress=False)["Close"]
            _cache.set(f"spy:{start}", spy)

        one = yf.download(sym, start=start, auto_adjust=True, progress=False)["Close"]
        px = pd.DataFrame({sym: _flatten(one), "SPY": _flatten(spy)})
        y10 = pd.Series(_fred_series("DGS10", start))
        y2 = pd.Series(_fred_series("DGS2", start))
        for s in (y10, y2):
            s.index = pd.to_datetime(s.index)

        rets = np.log(px).diff()
        frame = pd.concat(
            [rets, y10.diff().rename("d10"), y2.diff().rename("d2")], axis=1
        ).dropna()
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "detail": str(exc)}

    if len(frame) < MIN_OBS or sym not in frame:
        return {"status": "insufficient_data", "n": len(frame)}

    y = frame[sym].values
    X = np.column_stack([
        np.ones(len(frame)),
        frame["SPY"].values,
        frame["d10"].values,
        frame["d2"].values,
    ])
    coef, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ coef

    dof = len(frame) - X.shape[1]
    xtx_inv = np.linalg.inv(X.T @ X)
    sigma2 = float(resid @ resid) / dof
    se = np.sqrt(np.diag(xtx_inv) * sigma2)

    # Rate-only fit, to report how much of the variance rates explain on their
    # own rather than net of the market factor they partly drive.
    Xr = np.column_stack([np.ones(len(frame)), frame["d10"].values, frame["d2"].values])
    cr, *_ = np.linalg.lstsq(Xr, y, rcond=None)
    rr = y - Xr @ cr
    r2_rate = 1 - rr.var() / y.var() if y.var() > 0 else None

    # Coefficients are per one percentage point of yield, so scaling to 100bp is
    # the identity; expressed in percent for display.
    k10 = float(coef[2]) * 100
    k10_se = float(se[2]) * 100

    data = {
        "status": "ok",
        "n": int(len(frame)),
        "market_beta": float(coef[1]),
        "kappa_10y_pct_per_100bp": k10,
        "kappa_10y_se": k10_se,
        "kappa_10y_t": (k10 / k10_se) if k10_se > 0 else None,
        "kappa_10y_ci95": [k10 - 1.96 * k10_se, k10 + 1.96 * k10_se],
        "kappa_2y_pct_per_100bp": float(coef[3]) * 100,
        "r2_full": float(1 - resid.var() / y.var()) if y.var() > 0 else None,
        "r2_rate_only": float(r2_rate) if r2_rate is not None else None,
        "significant": bool(k10_se > 0 and abs(k10 / k10_se) >= 2.0),
        "window": f"{LOOKBACK_YEARS}y daily",
        "caveat": (
            "Correlation over one rate cycle, not a structural constant. Fitted "
            "ex-2022 this class of beta mispredicted 2022 by 18.6pp on average "
            "and flipped sign on several names."
        ),
    }
    _cache.set(f"beta:{sym}", data)
    return data


def rate_beta_bounded(symbol: str, timeout: float = BETA_WAIT_SECONDS) -> dict:
    """rate_beta with a ceiling on how long the caller waits for it."""
    sym = symbol.upper()
    cached = _cache.get(f"beta:{sym}")
    if cached is not None:
        return cached

    with _inflight_lock:
        fut = _inflight.get(sym)
        if fut is None or fut.done():
            fut = _pool.submit(rate_beta, sym)
            _inflight[sym] = fut

    try:
        return fut.result(timeout=timeout)
    except FutureTimeout:
        return {
            "status": "pending",
            "note": (
                f"Five years of daily prices are still downloading (waited "
                f"{timeout:.0f}s). The earnings and solvency channels are "
                f"unaffected; reload for the price channel."
            ),
        }
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "detail": str(exc)}


def empirical_impact(beta: dict, headline_bp: float) -> dict:
    """Apply a measured beta to a scenario, refusing to reach past the record."""
    if beta.get("status") != "ok":
        return {"status": beta.get("status", "unavailable"), "value": None}

    if abs(headline_bp) > EXTRAPOLATION_LIMIT_BP:
        return {
            "status": "not_extrapolable",
            "value": None,
            "limit_bp": EXTRAPOLATION_LIMIT_BP,
            "note": (
                "Per-name rate betas do not transfer across regimes; use the "
                "characteristic-based duration channel for shocks this large."
            ),
        }

    if not beta.get("significant"):
        return {
            "status": "not_significant",
            "value": None,
            "t": beta.get("kappa_10y_t"),
            "note": "This name's return does not respond measurably to rates.",
        }

    scale = headline_bp / 100
    lo, hi = beta["kappa_10y_ci95"]
    return {
        "status": "ok",
        "value": beta["kappa_10y_pct_per_100bp"] * scale / 100,
        "ci95": [lo * scale / 100, hi * scale / 100],
        "t": beta.get("kappa_10y_t"),
        "r2_rate_only": beta.get("r2_rate_only"),
    }


def implied_theta(beta: dict, spread: float | None) -> dict:
    """Back the discount-rate pass-through out of the measured beta.

    From dP/P = -theta*dr / (spread + theta*dr), first order:
        theta = -kappa * spread / dr
    with kappa quoted per 100bp, dr = 0.01, so the factor is just -kappa*spread.

    A negative theta is not a low pass-through, it is the wrong mechanism. It
    means the price rose while rates rose, which discounting cannot produce: the
    beta is picking up whatever else moved with rates — oil for an energy name,
    a growth signal for a tech name in a pre-inflation sample. Feeding it back
    into Gordon would print a *gain* from a rate rise and attribute it to the
    discount rate. So it is rejected rather than used, and the conflict is
    reported so the screen can say which channel disagrees.
    """
    if beta.get("status") != "ok" or not spread or not beta.get("significant"):
        return {"theta": None, "status": "unavailable"}

    kappa = beta["kappa_10y_pct_per_100bp"] / 100
    theta = -kappa * spread / 0.01
    if not math.isfinite(theta):
        return {"theta": None, "status": "unavailable"}

    if theta <= 0:
        return {
            "theta": None,
            "status": "mechanism_conflict",
            "rejected_theta": theta,
            "note": (
                "Measured price response to rising rates is positive, which the "
                "discount-rate mechanism cannot produce. The rate beta is "
                "capturing a co-moving driver, not discounting."
            ),
        }

    return {"theta": theta, "status": "ok"}
