"""
Factor exposure — "what is this book actually betting on".

The covariance in routers/risk.py says HOW MUCH the book moves. This says WITH
WHAT: the book's returns are regressed on a short list of market-wide drivers,
each one a liquid ETF (or a spread of two), so a 12-name portfolio reads as
"0.9 of the S&P, short the dollar, long momentum" instead of twelve tickers.

Factors (Yahoo, free; local-currency returns):
    MKT_US   SPY                 MKT_TH   TDEX.BK (only with .BK holdings)
    SIZE     IWM − SPY           VALUE    IWD − IWF
    MOM      MTUM − SPY          RATES    IEF            (up = yields down)
    CREDIT   HYG − IEF           USDTHB   THB=X          (up = dollar stronger)
    OIL      USO                 GOLD     GLD
    CRYPTO   BTC-USD (only with crypto holdings)

Method:
    * Returns are summed over `HORIZON` trading days, overlapping. A Thai stock
      closes before New York opens, so on DAILY data it answers yesterday's
      S&P and its beta reads near zero; over five days the lag is inside the
      window. Overlap makes the errors serially correlated — the t-statistics
      use Newey-West (Bartlett, 2·(h−1) lags), the betas need no correction.
    * One multiple OLS for the book and the same one per holding. Sums of
      SIMPLE returns keep it linear, so book beta = Σ weight × holding beta
      exactly — the "who brings it" column is an identity, not an estimate.
    * Risk share of factor k = β_k · cov(f_k, fitted) / var(book). The shares
      add up to R²; the rest is `specific_pct` — risk no factor explains.
    * `impact_1sd`: what a one-standard-deviation month of the factor does to
      the book, so factors with different volatilities compare.

Asset returns arrive in the report currency (FX inside), factor returns in the
factor's own currency — the currency bet then shows up on the USDTHB line
instead of being smeared over every USD factor.

Pure: no I/O. routers/risk.py GET /risk/factors does the I/O.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

import numpy as np
import pandas as pd

HORIZON = 5
MIN_OBS = 60            # h-day observations a regression needs
MIN_HISTORY = 120       # bars a holding needs to enter (routers/risk.py passes it on)
T_SIGNIFICANT = 2.0
VIF_HIGH = 5.0
DAYS_1M = 21


@dataclass(frozen=True)
class Factor:
    key: str
    label: str
    long: str
    short: Optional[str] = None
    reads: str = ""             # what a positive beta means, one line (shown and sent to ASK)
    needs: str = ""             # "" always · "th" · "crypto"

    @property
    def proxy(self) -> str:
        return f"{self.long} − {self.short}" if self.short else self.long


FACTORS: tuple[Factor, ...] = (
    Factor("MKT_US", "ตลาดหุ้นสหรัฐ", "SPY", None, "บวก = ขึ้นลงตาม S&P 500"),
    Factor("MKT_TH", "ตลาดหุ้นไทย", "TDEX.BK", None, "บวก = ขึ้นลงตาม SET50", "th"),
    Factor("SIZE", "หุ้นเล็ก − หุ้นใหญ่", "IWM", "SPY", "บวก = เอียงไปหุ้นเล็ก"),
    Factor("VALUE", "Value − Growth", "IWD", "IWF", "บวก = เอียง value · ลบ = เอียง growth"),
    Factor("MOM", "Momentum", "MTUM", "SPY", "บวก = ถือตัวที่วิ่งมาแล้ว"),
    Factor("RATES", "พันธบัตร 7–10 ปี", "IEF", None, "บวก = ได้เมื่อดอกเบี้ยลง · ลบ = เจ็บเมื่อดอกเบี้ยลง"),
    Factor("CREDIT", "เครดิต (HY − พันธบัตร)", "HYG", "IEF", "บวก = ได้เมื่อ credit spread แคบลง"),
    Factor("USDTHB", "ดอลลาร์เทียบบาท", "THB=X", None, "บวก = ได้เมื่อดอลลาร์แข็ง / บาทอ่อน"),
    Factor("OIL", "น้ำมัน", "USO", None, "บวก = ได้เมื่อน้ำมันขึ้น"),
    Factor("GOLD", "ทอง", "GLD", None, "บวก = ได้เมื่อทองขึ้น"),
    Factor("CRYPTO", "Bitcoin", "BTC-USD", None, "บวก = ขึ้นลงตาม Bitcoin", "crypto"),
)

_CRYPTO_SUFFIX = ("-USD", "-THB", "-USDT")


def factor_set(yf_symbols: list[str]) -> list[Factor]:
    """The factors worth fitting for this book: a home-market factor only for a
    market the book holds, so a US-only book is not asked about the SET."""
    syms = [str(s or "").upper() for s in yf_symbols]
    have = {
        "": True,
        "th": any(s.endswith(".BK") for s in syms),
        "crypto": any(s.endswith(_CRYPTO_SUFFIX) for s in syms),
    }
    return [f for f in FACTORS if have[f.needs]]


def tickers(factors: list[Factor]) -> list[str]:
    out: list[str] = []
    for f in factors:
        out.append(f.long)
        if f.short:
            out.append(f.short)
    return list(dict.fromkeys(out))


def factor_returns(legs: pd.DataFrame, factors: list[Factor]) -> tuple[pd.DataFrame, list[str]]:
    """Daily SIMPLE factor returns from the legs' daily simple returns.
    A factor whose leg has no data is left out and named in the second value."""
    cols, missing = {}, []
    for f in factors:
        if f.long not in legs.columns or (f.short and f.short not in legs.columns):
            missing.append(f.key)
            continue
        cols[f.key] = legs[f.long] - legs[f.short] if f.short else legs[f.long]
    return pd.DataFrame(cols, index=legs.index), missing


def _hac_se(X: np.ndarray, resid: np.ndarray, xtx_inv: np.ndarray, lags: int) -> np.ndarray:
    """Newey-West standard errors (Bartlett kernel). lags=0 is White's."""
    u = X * resid[:, None]
    S = u.T @ u
    for lag in range(1, min(lags, len(u) - 1) + 1):
        g = u[lag:].T @ u[:-lag]
        S += (1.0 - lag / (lags + 1.0)) * (g + g.T)
    V = xtx_inv @ S @ xtx_inv
    return np.sqrt(np.clip(np.diag(V), 0.0, None))


def _r(v: float, d: int = 3) -> Optional[float]:
    return round(float(v), d) if math.isfinite(float(v)) else None


def analyze(
    assets: pd.DataFrame,
    weights: dict[str, float],
    factors: pd.DataFrame,
    *,
    nav: float = 0.0,
    names: Optional[dict[str, str]] = None,
    factor_defs: Optional[list[Factor]] = None,
    horizon: int = HORIZON,
) -> dict:
    """`assets` / `factors`: daily simple returns on one shared date index.
    `weights`: NAV weights by asset column (cash is whatever they leave of 1)."""
    names = names or {}
    defs = {f.key: f for f in (factor_defs or FACTORS)}
    cols = [c for c in assets.columns if weights.get(c)]
    fkeys = list(factors.columns)
    empty = {"n_obs": 0, "horizon_days": horizon, "r_squared": None, "specific_pct": None,
             "factors": [], "assets": []}
    if not cols or not fkeys:
        return {**empty, "error": "no holdings or no factor data"}

    joined = pd.concat(
        [assets[cols].rolling(horizon).sum(), factors.rolling(horizon).sum()], axis=1
    ).dropna()
    n, k = len(joined), len(fkeys)
    if n < max(MIN_OBS, 3 * (k + 1)):
        return {**empty, "n_obs": int(n), "error": "not enough history"}

    Y = joined[cols].to_numpy(dtype=float)
    F = joined[fkeys].to_numpy(dtype=float)
    X = np.column_stack([np.ones(n), F])
    xtx_inv = np.linalg.pinv(X.T @ X)
    B = xtx_inv @ X.T @ Y                      # (k+1) × assets
    w = np.array([float(weights[c]) for c in cols])

    y = Y @ w
    b = B @ w                                  # book betas = Σ w · asset betas
    fitted = X @ b
    resid = y - fitted
    var_y = float(y.var())
    if var_y <= 0:
        return {**empty, "n_obs": int(n), "error": "book has no variance"}
    r2 = 1.0 - float(resid.var()) / var_y
    se = _hac_se(X, resid, xtx_inv, 2 * (horizon - 1))

    fit_c = fitted - fitted.mean()
    corr_f = np.corrcoef(F, rowvar=False) if k > 1 else np.ones((1, 1))
    vif = np.diag(np.linalg.pinv(np.atleast_2d(corr_f)))
    sd_1m = factors[fkeys].std().to_numpy(dtype=float) * math.sqrt(DAYS_1M)

    contrib = B[1:, :] * w[None, :]            # factor × asset: weight × beta
    rows = []
    for j, key in enumerate(fkeys):
        f = defs.get(key)
        beta = float(b[j + 1])
        t = beta / se[j + 1] if se[j + 1] > 0 else 0.0
        share = beta * float((F[:, j] - F[:, j].mean()) @ fit_c) / n / var_y
        sd_f, sd_y = float(F[:, j].std()), math.sqrt(var_y)
        corr = float(np.cov(F[:, j], y, bias=True)[0, 1] / (sd_f * sd_y)) if sd_f > 0 else 0.0
        order = np.argsort(-np.abs(contrib[j]))[:3]
        rows.append({
            "key": key,
            "label": f.label if f else key,
            "proxy": f.proxy if f else key,
            "reads": f.reads if f else "",
            "beta": _r(beta),
            "t_stat": _r(t, 2),
            "significant": bool(abs(t) >= T_SIGNIFICANT),
            "risk_share_pct": _r(share * 100, 1),
            "corr": _r(corr, 2),
            "vif": _r(vif[j], 1),
            "collinear": bool(vif[j] >= VIF_HIGH),
            "sd_1m_pct": _r(sd_1m[j] * 100, 2),
            "impact_1sd_pct": _r(beta * sd_1m[j] * 100, 2),
            "impact_1sd_amount": _r(beta * sd_1m[j] * nav, 2),
            "top": [
                {"symbol": names.get(cols[i], cols[i]), "beta": _r(B[j + 1, i]),
                 "contribution": _r(contrib[j, i])}
                for i in order if abs(contrib[j, i]) > 1e-9
            ],
        })
    rows.sort(key=lambda r: -abs(r["risk_share_pct"] or 0.0))

    resid_a = Y - X @ B
    var_a = Y.var(axis=0)
    asset_rows = [
        {
            "symbol": names.get(c, c),
            "yf_symbol": c,
            "weight_pct": _r(w[i] * 100, 2),
            "r_squared": _r(1.0 - resid_a[:, i].var() / var_a[i], 3) if var_a[i] > 0 else None,
            "betas": {key: _r(B[j + 1, i]) for j, key in enumerate(fkeys)},
        }
        for i, c in enumerate(cols)
    ]
    asset_rows.sort(key=lambda r: -abs(r["weight_pct"] or 0.0))

    return {
        "n_obs": int(n),
        "horizon_days": horizon,
        "r_squared": _r(r2, 3),
        "specific_pct": _r((1.0 - r2) * 100, 1),
        "factors": rows,
        "assets": asset_rows,
    }
