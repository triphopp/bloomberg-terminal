"""
Portfolio Risk Engine — Emotion-free systematic risk analysis.
Supports per-account and combined (all accounts) risk metrics.

Complexity target: O(n*T) where n=positions, T=lookback days.
All covariance uses Ledoit-Wolf shrinkage (O(n^2*T)) — no matrix inversion needed for basic metrics.
"""
import math
import threading
import time
import uuid
from datetime import datetime, timedelta
from typing import Optional

import numpy as np
import pandas as pd
import yfinance as yf
from fastapi import APIRouter, Query
from pydantic import BaseModel

from cache import TTLCache
from db import get_db
from portfolio_currency import convert_amount, report_currency, trade_currency

router = APIRouter(prefix="/api/v2/portfolio/risk")

_returns_cache: TTLCache = TTLCache(ttl=300, maxsize=100)

# ── Sector Regime Signal (5-min cache) ───────────────────────────────────────

_SECTOR_ETFS = ["XLK", "XLF", "XLV", "XLE", "XLI", "XLY", "XLP", "XLRE", "XLU", "XLB", "XLC"]
_regime_cache: dict = {}
_regime_cache_ts: float = 0.0
_regime_cache_lock = threading.Lock()


def _get_market_regime() -> dict:
    """Sector correlation regime signal. Cached 5 min.
    Returns: {label, avg_corr, avg_wedge}
    avg_wedge = mean |sin θ| = mean √(1−ρ²):
      → 0 = sectors fully co-moving (fat tail risk max)
      → 1 = sectors fully independent (orthogonal, low tail risk)
    """
    global _regime_cache, _regime_cache_ts
    now = time.time()
    with _regime_cache_lock:
        if now - _regime_cache_ts < 300 and _regime_cache:
            return _regime_cache.copy()
    try:
        raw = yf.download(
            _SECTOR_ETFS, period="3mo", interval="1d",
            auto_adjust=True, progress=False, threads=True,
        )
        closes = raw["Close"] if isinstance(raw.columns, pd.MultiIndex) else raw
        ret = closes.pct_change().dropna()
        if len(ret) < 20:
            raise ValueError("insufficient data")
        corr = ret.corr().values.astype(float)
        n = corr.shape[0]
        off_corr  = [abs(corr[i][j]) for i in range(n) for j in range(i + 1, n)]
        off_wedge = [math.sqrt(max(0.0, 1.0 - corr[i][j] ** 2))
                     for i in range(n) for j in range(i + 1, n)]
        avg_corr  = float(np.mean(off_corr))
        avg_wedge = float(np.mean(off_wedge))
        label = "CONVERGENT" if avg_corr >= 0.65 else ("NEUTRAL" if avg_corr >= 0.45 else "DIVERGENT")
        result = {"label": label, "avg_corr": round(avg_corr, 4), "avg_wedge": round(avg_wedge, 4)}
    except Exception:
        result = {"label": "UNKNOWN", "avg_corr": 0.0, "avg_wedge": 0.5}
    with _regime_cache_lock:
        _regime_cache = result
        _regime_cache_ts = now
    return result.copy()


# ── Helpers ──────────────────────────────────────────────────────────────────

def _get_yf_symbol(symbol: str, account_id: str) -> Optional[str]:
    if not symbol:
        return None
    sym = symbol.strip().upper()
    if sym.startswith(("PUT_", "CALL_")):
        return None
    if account_id == "finansia":
        return f"{sym}.BK"
    if account_id == "innovestx":
        if "-" in sym:
            return sym
        if sym.endswith("THB") and len(sym) > 3:
            return f"{sym[:-3]}-THB"
        return None
    return sym


def _position_yf_symbol(row: dict) -> Optional[str]:
    resolved = str(row.get("resolved_symbol") or "").strip().upper()
    if resolved:
        return resolved
    return _get_yf_symbol(str(row.get("symbol") or ""), str(row.get("account_id") or ""))


def _fetch_returns(symbols: list[str], days: int = 252) -> dict[str, np.ndarray]:
    """Fetch daily log-returns for symbols. Cached 5min."""
    cache_key = f"{','.join(sorted(symbols))}_{days}"
    cached = _returns_cache.get(cache_key)
    if cached is not None:
        return cached

    end = datetime.utcnow()
    # 1.5x for weekends/holidays + fixed cushion so short windows (e.g. 21d ≈ 1M)
    # still clear the >=20-observation gate below.
    start = end - timedelta(days=int(days * 1.5) + 14)

    try:
        df = yf.download(
            symbols, start=start.strftime("%Y-%m-%d"),
            end=end.strftime("%Y-%m-%d"),
            progress=False, auto_adjust=True, threads=True,
        )
        if df.empty:
            return {}

        close = df["Close"] if "Close" in df.columns else df
        if hasattr(close, "columns"):
            result = {}
            for sym in symbols:
                if sym in close.columns:
                    s = close[sym].dropna()
                    if len(s) >= 20:
                        log_ret = np.log(s / s.shift(1)).dropna().values[-days:]
                        result[sym] = log_ret
            _returns_cache.set(cache_key, result)
            return result
        else:
            s = close.dropna()
            if len(s) >= 20:
                log_ret = np.log(s / s.shift(1)).dropna().values[-days:]
                result = {symbols[0]: log_ret}
                _returns_cache.set(cache_key, result)
                return result
    except Exception:
        pass
    return {}


def _ledoit_wolf_shrinkage(returns: np.ndarray) -> np.ndarray:
    """Ledoit-Wolf linear shrinkage to identity * mean_variance.
    O(n^2 * T) — no matrix inversion.
    """
    T, n = returns.shape
    if T < 2 or n < 2:
        return np.eye(n) * np.var(returns)

    # Sample covariance
    X = returns - returns.mean(axis=0)
    S = (X.T @ X) / T

    # Shrinkage target: scaled identity
    mu = np.trace(S) / n
    F = mu * np.eye(n)

    # Optimal shrinkage intensity (Ledoit-Wolf 2004 formula)
    d2 = np.sum((S - F) ** 2) / n
    # Estimate variance of off-diagonal elements
    b2 = 0.0
    for t in range(T):
        xt = X[t:t+1].T @ X[t:t+1]
        b2 += np.sum((xt - S) ** 2)
    b2 = b2 / (T * T * n)

    delta = max(0.0, min(1.0, b2 / d2)) if d2 > 0 else 1.0

    return (1 - delta) * S + delta * F


def _get_thb_per_usd() -> float:
    try:
        from routers.portfolio_v2 import _get_thb_per_usd as get_rate
        return get_rate()
    except Exception:
        return 33.5


# ── Ensemble Risk Helpers ────────────────────────────────────────────────────

def _cornish_fisher_var(port_returns: np.ndarray, confidence: float) -> float:
    """Parametric VaR adjusted for skew + excess kurtosis (Cornish-Fisher expansion)."""
    from scipy.stats import norm
    import pandas as pd
    z = norm.ppf(1 - confidence)
    s = float(pd.Series(port_returns).skew())
    k = float(pd.Series(port_returns).kurtosis())  # excess kurtosis
    z_cf = (z
            + (z**2 - 1) * s / 6
            + (z**3 - 3 * z) * k / 24
            - (2 * z**3 - 5 * z) * s**2 / 36)
    return float(-(port_returns.mean() + z_cf * port_returns.std(ddof=1)))


def _monte_carlo_cvar(
    port_returns: np.ndarray, cov: np.ndarray, weights: np.ndarray,
    confidence: float, n_sim: int = 10_000, seed: int = 42,
) -> tuple[float, float]:
    """Monte Carlo VaR + CVaR via Cholesky decomposition of supplied covariance."""
    rng = np.random.default_rng(seed)
    n = len(weights)
    try:
        L = np.linalg.cholesky(cov + np.eye(n) * 1e-8)
    except np.linalg.LinAlgError:
        L = np.diag(np.sqrt(np.maximum(np.diag(cov), 1e-10)))
    mu = port_returns.mean()
    Z = rng.standard_normal((n_sim, n))
    port_sim = (Z @ L.T + mu) @ weights
    threshold = float(np.percentile(port_sim, (1 - confidence) * 100))
    var_mc = -threshold
    tail = port_sim[port_sim <= threshold]
    cvar_mc = float(-tail.mean()) if len(tail) > 0 else var_mc
    return float(var_mc), float(cvar_mc)


def _bootstrap_cvar_ci(
    port_returns: np.ndarray, confidence: float, n_boot: int = 300,
) -> tuple[float, float]:
    """Bootstrap 90% CI for historical CVaR. Returns (lo_5pct, hi_95pct)."""
    rng = np.random.default_rng(0)
    n = len(port_returns)
    cvar_samples = []
    for _ in range(n_boot):
        sample = rng.choice(port_returns, size=n, replace=True)
        thresh = np.percentile(sample, (1 - confidence) * 100)
        tail = sample[sample <= thresh]
        if len(tail) > 0:
            cvar_samples.append(-float(tail.mean()))
    if len(cvar_samples) < 10:
        return 0.0, 0.0
    return float(np.percentile(cvar_samples, 5)), float(np.percentile(cvar_samples, 95))


def _vol_regime(port_returns: np.ndarray) -> str:
    """Classify current vol regime from rolling 21-day vol percentile."""
    if len(port_returns) < 42:
        return "UNKNOWN"
    vols = [float(port_returns[i - 21:i].std(ddof=1)) for i in range(21, len(port_returns))]
    current = vols[-1]
    p75 = float(np.percentile(vols, 75))
    p90 = float(np.percentile(vols, 90))
    if current >= p90:
        return "STRESSED"
    if current >= p75:
        return "ELEVATED"
    return "CALM"


def _stressed_cov(cov: np.ndarray) -> np.ndarray:
    """Stress-scenario covariance: vol ×1.3, off-diagonal correlations pulled 50% toward 1."""
    std = np.sqrt(np.diag(cov))
    corr = cov / np.outer(std + 1e-10, std + 1e-10)
    np.fill_diagonal(corr, 1.0)
    stressed_corr = corr + (1.0 - corr) * 0.5
    np.fill_diagonal(stressed_corr, 1.0)
    stressed_std = std * 1.3
    return np.outer(stressed_std, stressed_std) * stressed_corr


def _var_backtest(
    port_returns: np.ndarray, var_pct: float, confidence: float,
) -> tuple[int, float, str]:
    """Count VaR exceptions (actual loss > VaR threshold).
    Returns (exception_count, exception_rate, signal: GREEN|YELLOW|RED).
    Basel traffic light: ≤expected_rate=GREEN, ≤1.6×=YELLOW, >1.6×=RED.
    """
    n = len(port_returns)
    if n < 30:
        return 0, 0.0, "INSUFFICIENT_DATA"
    exceptions = int(np.sum(port_returns < -var_pct))
    rate = exceptions / n
    expected = 1.0 - confidence
    signal = "GREEN" if rate <= expected else ("YELLOW" if rate <= expected * 1.6 else "RED")
    return exceptions, float(rate), signal


def _kupiec_pvalue(n_exceptions: int, n_obs: int, confidence: float) -> float:
    """Kupiec POF test: H0 = VaR exception rate equals 1-confidence.
    Returns p-value; p > 0.05 means model is adequate (fail to reject H0).
    """
    from scipy.stats import chi2
    if n_obs < 30 or n_exceptions == 0:
        return 1.0
    p = 1.0 - confidence
    hat_p = n_exceptions / n_obs
    if hat_p >= 1.0:
        return 0.0
    lr = -2.0 * (
        n_exceptions * np.log(p / hat_p)
        + (n_obs - n_exceptions) * np.log((1.0 - p) / (1.0 - hat_p))
    )
    return float(1.0 - chi2.cdf(max(lr, 0.0), df=1))


# ── Core Risk Computations ───────────────────────────────────────────────────

def _compute_portfolio_risk(
    positions: list[dict], lookback: int, confidence: float, base_currency: str = "THB"
):
    """
    Compute full risk metrics for a set of positions.
    Returns dict with all metrics.
    """
    if not positions:
        return _empty_metrics()

    # Build symbol list and weights — aggregate by yf_symbol to avoid
    # duplicate rows (same symbol in multiple lots/accounts).
    # Duplicate rows → sample corr = 1.0 → Ledoit-Wolf shrinks to < 1.0
    # → correlation matrix shows e.g. MSFT/MSFT = 0.89 (wrong).
    sym_value_map: dict[str, float] = {}
    sym_price_map: dict[str, float] = {}       # yf_sym → latest market price
    sym_entry_value_map: dict[str, float] = {} # yf_sym → sum(price_entry * volume) for avg cost
    sym_volume_map: dict[str, float] = {}      # yf_sym → total shares held
    sym_to_yf: dict[str, str] = {}             # yf_sym → display name

    for pos in positions:
        yf_sym = _position_yf_symbol(pos)
        if not yf_sym:
            continue
        price = pos.get("current_price") or pos.get("price_entry", 0)
        vol = float(pos.get("volume", 0))
        native_val = float(price or 0) * vol
        val = convert_amount(native_val, trade_currency(pos), report_currency(base_currency))
        if val > 0:
            sym_value_map[yf_sym] = sym_value_map.get(yf_sym, 0.0) + val
            if price:
                sym_price_map[yf_sym] = float(price)
            sym_to_yf[yf_sym] = pos["symbol"]  # last display name wins
        entry_price = float(pos.get("price_entry") or 0)
        if entry_price > 0 and vol > 0:
            sym_entry_value_map[yf_sym] = sym_entry_value_map.get(yf_sym, 0.0) + entry_price * vol
            sym_volume_map[yf_sym] = sym_volume_map.get(yf_sym, 0.0) + vol

    if not sym_value_map:
        return _empty_metrics()

    symbols = list(sym_value_map.keys())
    values  = [sym_value_map[s] for s in symbols]

    total_value = sum(values)
    weights = np.array(values) / total_value

    # Fetch returns
    returns_map = _fetch_returns(symbols, lookback)
    valid_syms = [s for s in symbols if s in returns_map]
    if len(valid_syms) < 1:
        return _empty_metrics()

    # Align returns matrix (T x n) — one column per unique yf_sym
    min_len = min(len(returns_map[s]) for s in valid_syms)
    R = np.column_stack([returns_map[s][-min_len:] for s in valid_syms])
    w = np.array([weights[symbols.index(s)] for s in valid_syms])
    w = w / w.sum()  # renormalize to valid symbols

    T, n = R.shape

    # Portfolio returns series
    port_returns = R @ w

    # Covariance (Ledoit-Wolf)
    cov = _ledoit_wolf_shrinkage(R)

    # Portfolio volatility (annualized)
    port_vol_daily = float(np.sqrt(w @ cov @ w))
    port_vol_annual = port_vol_daily * np.sqrt(252)

    # VaR (parametric, Gaussian) — legacy, shown for reference
    from scipy.stats import norm
    z = norm.ppf(1 - confidence)
    var_pct = -(port_returns.mean() + z * port_returns.std())
    var_amount = float(var_pct * total_value)

    # Historical VaR
    var_hist_pct = float(-np.percentile(port_returns, (1 - confidence) * 100))
    var_hist_amount = var_hist_pct * total_value

    # Historical CVaR (Expected Shortfall) — Basel IV standard
    threshold = np.percentile(port_returns, (1 - confidence) * 100)
    tail = port_returns[port_returns <= threshold]
    cvar_pct = float(-tail.mean()) if len(tail) > 0 else var_pct
    cvar_amount = cvar_pct * total_value

    # ── Ensemble Layer 1: Cornish-Fisher VaR (fat-tail adjusted) ─────────────
    var_cf_pct = _cornish_fisher_var(port_returns, confidence)
    var_cf_amount = float(var_cf_pct * total_value)

    # ── Ensemble Layer 2: Monte Carlo CVaR ───────────────────────────────────
    vol_regime_label = _vol_regime(port_returns)
    mc_cov = _stressed_cov(cov) if vol_regime_label == "STRESSED" else cov
    var_mc_pct, cvar_mc_pct = _monte_carlo_cvar(port_returns, mc_cov, w, confidence)
    cvar_mc_amount = float(cvar_mc_pct * total_value)

    # Stressed VaR (always computed with stressed cov, useful in ELEVATED too)
    _, cvar_stressed_pct = _monte_carlo_cvar(port_returns, _stressed_cov(cov), w, confidence)
    cvar_stressed_amount = float(cvar_stressed_pct * total_value)

    # ── Ensemble Layer 3: Bootstrap CI on historical CVaR ────────────────────
    cvar_ci_lo, cvar_ci_hi = _bootstrap_cvar_ci(port_returns, confidence, n_boot=300)
    cvar_ci_width_ratio = float(cvar_ci_hi / cvar_ci_lo) if cvar_ci_lo > 1e-6 else 99.0

    # ── Ensemble Signal (divergence detection) ────────────────────────────────
    cf_vs_hist = var_cf_pct / max(var_hist_pct, 1e-6)
    mc_vs_hist = cvar_mc_pct / max(cvar_pct, 1e-6)
    if mc_vs_hist > 1.3:
        ensemble_signal = "CORRELATION_RISK"
    elif cf_vs_hist > 1.2:
        ensemble_signal = "FAT_TAIL_RISK"
    else:
        ensemble_signal = "STABLE"

    ensemble_conservative_pct = float(max(cvar_pct, var_cf_pct, cvar_mc_pct))
    ensemble_conservative_amount = ensemble_conservative_pct * total_value

    # ── Ensemble Layer 4: VaR Backtest (exception counting) ──────────────────
    bt_exceptions, bt_rate, bt_signal = _var_backtest(port_returns, var_hist_pct, confidence)

    # ── Breach detection: most-recent return vs each VaR threshold ────────────
    today_return = float(port_returns[-1]) if len(port_returns) > 0 else 0.0
    breach_hist = today_return < -var_hist_pct
    breach_cf   = today_return < -var_cf_pct
    breach_mc   = today_return < -cvar_mc_pct

    # Kupiec POF test p-value
    kupiec_pvalue = _kupiec_pvalue(bt_exceptions, len(port_returns), confidence)
    kupiec_pass   = kupiec_pvalue > 0.05

    # Max Drawdown
    cum = np.cumsum(port_returns)
    peak = np.maximum.accumulate(cum)
    dd = cum - peak
    max_dd = float(-dd.min()) if len(dd) > 0 else 0.0

    # Current Drawdown
    current_dd = float(-dd[-1]) if len(dd) > 0 else 0.0

    # Sharpe (annualized, rf=0 for simplicity)
    sharpe = float(port_returns.mean() / port_returns.std() * np.sqrt(252)) if port_returns.std() > 0 else 0.0

    # Sortino (downside deviation)
    downside = port_returns[port_returns < 0]
    downside_std = float(np.sqrt(np.mean(downside**2))) if len(downside) > 0 else port_returns.std()
    sortino = float(port_returns.mean() / downside_std * np.sqrt(252)) if downside_std > 0 else 0.0

    # Calmar
    calmar = float((port_returns.mean() * 252) / max_dd) if max_dd > 0 else 0.0

    # Risk Contribution per asset
    marginal_risk = cov @ w
    rc = w * marginal_risk / port_vol_daily
    rc_pct = rc / rc.sum() * 100

    # Concentration (Herfindahl of risk contributions)
    hhi = float(np.sum((rc / rc.sum())**2))
    effective_n = 1.0 / hhi if hhi > 0 else n

    # Diversification ratio
    individual_vols = np.sqrt(np.diag(cov))
    div_ratio = float(np.sum(w * individual_vols) / port_vol_daily)

    # Correlation matrix
    std_diag = np.diag(1.0 / (individual_vols + 1e-10))
    corr = std_diag @ cov @ std_diag

    # Per-asset details
    asset_details = []
    for i, sym in enumerate(valid_syms):
        asset_details.append({
            "symbol": sym_to_yf.get(sym, sym),
            "yf_symbol": sym,
            "weight_pct": round(float(w[i]) * 100, 2),
            "risk_contribution_pct": round(float(rc_pct[i]), 2),
            "volatility_annual": round(float(individual_vols[i] * np.sqrt(252)) * 100, 2),
            "var_contribution": round(float(rc_pct[i] / 100 * var_amount), 0),
        })

    # Risk score (0-100): composite — uses ensemble conservative bound (not plain Normal VaR)
    var_score = min(ensemble_conservative_pct / 0.05, 1.0) * 30
    dd_score = min(current_dd / 0.10, 1.0) * 25
    conc_score = min(hhi / 0.5, 1.0) * 25
    vol_score = min(port_vol_annual / 0.40, 1.0) * 20
    risk_score = round(var_score + dd_score + conc_score + vol_score, 1)

    return {
        "portfolio_value": round(total_value, 2),
        "base_currency": report_currency(base_currency),
        "n_positions": len(valid_syms),
        "lookback_days": min_len,
        "confidence": confidence,
        # VaR — legacy Gaussian (reference only)
        "var_parametric_pct": round(float(var_pct) * 100, 3),
        "var_parametric_amount": round(var_amount, 0),
        "var_historical_pct": round(float(var_hist_pct) * 100, 3),
        "var_historical_amount": round(var_hist_amount, 0),
        # CVaR — Historical ES (Basel IV standard)
        "cvar_pct": round(float(cvar_pct) * 100, 3),
        "cvar_amount": round(cvar_amount, 0),
        # Cornish-Fisher VaR (fat-tail adjusted)
        "var_cf_pct": round(float(var_cf_pct) * 100, 3),
        "var_cf_amount": round(var_cf_amount, 0),
        # Monte Carlo CVaR
        "cvar_mc_pct": round(float(cvar_mc_pct) * 100, 3),
        "cvar_mc_amount": round(cvar_mc_amount, 0),
        # Stressed CVaR (stressed covariance, always)
        "cvar_stressed_pct": round(float(cvar_stressed_pct) * 100, 3),
        "cvar_stressed_amount": round(cvar_stressed_amount, 0),
        # Bootstrap CI on historical CVaR (90%)
        "cvar_ci_lo": round(float(cvar_ci_lo) * 100, 3),
        "cvar_ci_hi": round(float(cvar_ci_hi) * 100, 3),
        "cvar_ci_width_ratio": round(cvar_ci_width_ratio, 2),
        # Ensemble
        "ensemble_signal": ensemble_signal,            # STABLE | FAT_TAIL_RISK | CORRELATION_RISK
        "ensemble_conservative_pct": round(ensemble_conservative_pct * 100, 3),
        "ensemble_conservative_amount": round(ensemble_conservative_amount, 0),
        # Backtest
        "var_backtest_exceptions": bt_exceptions,
        "var_backtest_rate": round(bt_rate * 100, 2),
        "var_backtest_signal": bt_signal,              # GREEN | YELLOW | RED | INSUFFICIENT_DATA
        # Breach checker
        "today_return_pct": round(today_return * 100, 3),
        "breach_hist": breach_hist,
        "breach_cf": breach_cf,
        "breach_mc": breach_mc,
        "kupiec_pvalue": round(kupiec_pvalue, 4),
        "kupiec_pass": kupiec_pass,
        # Vol regime
        "vol_regime": vol_regime_label,               # CALM | ELEVATED | STRESSED | UNKNOWN
        # Volatility
        "volatility_daily_pct": round(port_vol_daily * 100, 3),
        "volatility_annual_pct": round(port_vol_annual * 100, 2),
        # Drawdown
        "max_drawdown_pct": round(max_dd * 100, 2),
        "current_drawdown_pct": round(current_dd * 100, 2),
        # Ratios
        "sharpe_ratio": round(sharpe, 3),
        "sortino_ratio": round(sortino, 3),
        "calmar_ratio": round(calmar, 3),
        # Diversification
        "diversification_ratio": round(div_ratio, 3),
        "effective_n": round(effective_n, 2),
        "herfindahl_index": round(hhi, 4),
        # Score
        "risk_score": min(risk_score, 100),
        # Per-asset
        "assets": sorted(asset_details, key=lambda x: -x["risk_contribution_pct"]),
        # Correlation matrix
        "correlation_matrix": {
            "symbols": [sym_to_yf.get(s, s) for s in valid_syms],
            "matrix": [[round(float(corr[i][j]), 3) for j in range(n)] for i in range(n)],
        },
        # Trim signals
        "trim_signals": _compute_trim_signals(
            asset_details, w, cov, valid_syms, sym_to_yf, port_vol_daily,
            sym_value_map, sym_price_map, sym_entry_value_map, sym_volume_map,
        ),
        # DCC-EWMA correlation monitor
        "dcc": _dcc_ewma_correlation(R),
        # Internal: popped before JSON serialization, used for backfill
        "_port_returns": port_returns,
    }


def _compute_trim_signals(
    assets: list, weights: np.ndarray, cov: np.ndarray,
    symbols: list, sym_map: dict, port_vol: float,
    sym_value_map: dict | None = None,
    sym_price_map: dict | None = None,
    sym_entry_value_map: dict | None = None,
    sym_volume_map: dict | None = None,
) -> list:
    """Generate TRIM + BUY recommendations based on ERC deviation."""
    n = len(weights)
    target_rc = 1.0 / n  # equal risk contribution target
    signals = []

    marginal = cov @ weights
    rc = weights * marginal / port_vol
    rc_norm = rc / rc.sum()

    _val = sym_value_map or {}
    _price = sym_price_map or {}
    _entry_val = sym_entry_value_map or {}
    _vol = sym_volume_map or {}

    for i, sym in enumerate(symbols):
        rc_i = float(rc_norm[i])
        excess = rc_i - target_rc  # positive = overweight, negative = underweight

        current_value = _val.get(sym, 0.0)
        current_price = _price.get(sym, 0.0)
        total_vol = _vol.get(sym, 0.0)
        entry_total = _entry_val.get(sym, 0.0)
        avg_entry_price = entry_total / total_vol if total_vol > 0 else 0.0
        current_shares = round(total_vol, 4) if total_vol > 0 else None

        if excess > 0.05:  # TRIM: >5pp above ERC target
            trim_fraction = min(excess / rc_i, 0.5)
            trim_pct = trim_fraction * 100
            trim_value = current_value * trim_fraction
            shares_to_trim = round(total_vol * trim_fraction, 4) if total_vol > 0 else None

            # P&L if sold at current price vs avg cost
            trim_pnl: float | None = None
            trim_pnl_pct: float | None = None
            if shares_to_trim is not None and avg_entry_price > 0 and current_price > 0:
                trim_pnl = round((current_price - avg_entry_price) * shares_to_trim, 2)
                trim_pnl_pct = round((current_price / avg_entry_price - 1) * 100, 2)

            signals.append({
                "symbol": sym_map.get(sym, sym),
                "action": "TRIM",
                "reason": f"Risk contribution {rc_i*100:.1f}% vs target {target_rc*100:.1f}%",
                "excess_rc_pct": round(excess * 100, 2),
                "suggested_trim_pct": round(trim_pct, 1),
                "current_shares": current_shares,
                "shares_to_trim": shares_to_trim,
                "current_price": round(current_price, 4) if current_price > 0 else None,
                "avg_entry_price": round(avg_entry_price, 4) if avg_entry_price > 0 else None,
                "trim_value": round(trim_value, 2) if current_value > 0 else None,
                "trim_pnl": trim_pnl,
                "trim_pnl_pct": trim_pnl_pct,
                # BUY-only fields
                "shares_to_buy": None,
                "buy_value": None,
            })

        elif excess < -0.05:  # BUY: >5pp below ERC target
            deficit = -excess  # how far below target
            # Fraction of current position value to add to reach target
            buy_fraction = min(deficit / target_rc, 1.0)
            buy_value = current_value * buy_fraction
            shares_to_buy = round(total_vol * buy_fraction, 4) if total_vol > 0 else None

            signals.append({
                "symbol": sym_map.get(sym, sym),
                "action": "BUY",
                "reason": f"Risk contribution {rc_i*100:.1f}% vs target {target_rc*100:.1f}%",
                "excess_rc_pct": round(excess * 100, 2),  # negative for BUY
                "suggested_trim_pct": 0.0,
                "current_shares": current_shares,
                "shares_to_trim": None,
                "current_price": round(current_price, 4) if current_price > 0 else None,
                "avg_entry_price": round(avg_entry_price, 4) if avg_entry_price > 0 else None,
                "trim_value": None,
                "trim_pnl": None,
                "trim_pnl_pct": None,
                "shares_to_buy": shares_to_buy,
                "buy_value": round(buy_value, 2) if current_value > 0 else None,
            })

    # Sort: TRIM (excess > 0) first by severity, then BUY (excess < 0) by severity
    return sorted(signals, key=lambda x: -abs(x["excess_rc_pct"]))


def _dcc_empty() -> dict:
    return {
        "avg_corr_series": [],
        "current_avg_corr": 0.0,
        "corr_z_score": 0.0,
        "corr_spike": False,
        "corr_trend": "STABLE",
        "corr_pctile": 50.0,
        "signal": "NORMAL",
        "ews_contrib": 0,
        "model": "EWMA-DCC",
    }


def _dcc_ewma_correlation(R: np.ndarray, lambda_: float = 0.94) -> dict:
    """EWMA Dynamic Conditional Correlation (RiskMetrics 1994).

    Tracks time-varying cross-asset correlation to detect pre-crash
    correlation spikes that static Ledoit-Wolf snapshots miss.

    Backtest note (2026-06-06): Symmetric EWMA-DCC outperforms hand-tuned A-DCC (8/9 vs 5/9).
    A-DCC requires MLE calibration of alpha/gamma to outperform symmetric baseline.
    HMM regime adds orthogonal signal — see backtest/02_dcc_correlation_monitor/run.py.

    lambda_=0.94 is the RiskMetrics daily decay constant.
    Returns last-90-day series + spike/trend/signal for EWS integration.
    """
    T, n = R.shape
    if T < 30 or n < 2:
        return _dcc_empty()

    # Step 1: EWMA conditional variance per asset
    H = np.zeros((T, n))
    H[0] = np.maximum(np.var(R[:min(20, T)], axis=0), 1e-12)
    for t in range(1, T):
        H[t] = lambda_ * H[t - 1] + (1.0 - lambda_) * R[t - 1] ** 2
    H = np.maximum(H, 1e-12)

    # Step 2: Standardize returns
    eps = R / np.sqrt(H)  # (T, n)

    # Step 3: EWMA covariance of standardized returns (Q matrix)
    Q = np.zeros((T, n, n))
    Q[0] = np.eye(n)
    for t in range(1, T):
        Q[t] = lambda_ * Q[t - 1] + (1.0 - lambda_) * np.outer(eps[t - 1], eps[t - 1])

    # Step 4: Normalize Q_t → correlation; extract avg off-diagonal
    avg_corr_series: list[float] = []
    for t in range(T):
        q_diag = np.sqrt(np.maximum(np.diag(Q[t]), 1e-10))
        corr_t = Q[t] / np.outer(q_diag, q_diag)
        off = [abs(float(corr_t[i][j])) for i in range(n) for j in range(i + 1, n)]
        avg_corr_series.append(float(np.mean(off)) if off else 0.0)

    current = avg_corr_series[-1]
    hist_arr = np.array(avg_corr_series)
    hist_mean = float(hist_arr.mean())
    hist_std = float(hist_arr.std()) + 1e-8

    z_score = (current - hist_mean) / hist_std
    corr_spike = z_score > 2.0

    # 10-day trend slope
    recent = np.array(avg_corr_series[-10:])
    slope = float(np.polyfit(range(len(recent)), recent, 1)[0])
    if slope > 0.003:
        trend = "RISING"
    elif slope < -0.003:
        trend = "FALLING"
    else:
        trend = "STABLE"

    pctile = float(np.mean(hist_arr <= current) * 100)

    if z_score > 3.0 or pctile > 95:
        signal = "EXTREME"
        ews = 3
    elif z_score > 2.0 or pctile > 85:
        signal = "SPIKE"
        ews = 2
    elif z_score > 1.0 or pctile > 70 or trend == "RISING":
        signal = "CAUTION"
        ews = 1
    else:
        signal = "NORMAL"
        ews = 0

    return {
        "avg_corr_series": [round(x, 4) for x in avg_corr_series[-90:]],
        "current_avg_corr": round(current, 4),
        "corr_z_score": round(z_score, 3),
        "corr_spike": corr_spike,
        "corr_trend": trend,
        "corr_pctile": round(pctile, 1),
        "signal": signal,
        "ews_contrib": ews,
        "model": "EWMA-DCC",
    }


def _empty_metrics():
    return {
        "portfolio_value": 0, "n_positions": 0, "lookback_days": 0,
        "confidence": 0.95,
        "var_parametric_pct": 0, "var_parametric_amount": 0,
        "var_historical_pct": 0, "var_historical_amount": 0,
        "cvar_pct": 0, "cvar_amount": 0,
        "var_cf_pct": 0, "var_cf_amount": 0,
        "cvar_mc_pct": 0, "cvar_mc_amount": 0,
        "cvar_stressed_pct": 0, "cvar_stressed_amount": 0,
        "cvar_ci_lo": 0, "cvar_ci_hi": 0, "cvar_ci_width_ratio": 0,
        "ensemble_signal": "STABLE",
        "ensemble_conservative_pct": 0, "ensemble_conservative_amount": 0,
        "var_backtest_exceptions": 0, "var_backtest_rate": 0,
        "var_backtest_signal": "INSUFFICIENT_DATA",
        "today_return_pct": 0, "breach_hist": False, "breach_cf": False, "breach_mc": False,
        "kupiec_pvalue": 1.0, "kupiec_pass": True,
        "vol_regime": "UNKNOWN",
        "volatility_daily_pct": 0, "volatility_annual_pct": 0,
        "max_drawdown_pct": 0, "current_drawdown_pct": 0,
        "sharpe_ratio": 0, "sortino_ratio": 0, "calmar_ratio": 0,
        "diversification_ratio": 0, "effective_n": 0, "herfindahl_index": 0,
        "risk_score": 0, "assets": [], "correlation_matrix": {"symbols": [], "matrix": []},
        "trim_signals": [],
        "dcc": _dcc_empty(),
    }


# ── Position Sizing (Kelly) ──────────────────────────────────────────────────

def _kelly_size(symbol: str, account_id: str, portfolio_value: float,
                max_risk_pct: float = 0.02, kelly_fraction: float = 0.3,
                lookback: int = 252) -> dict:
    """Fractional Kelly position sizing."""
    yf_sym = _get_yf_symbol(symbol, account_id)
    if not yf_sym:
        return {"error": "Cannot resolve symbol"}

    returns_map = _fetch_returns([yf_sym], lookback)
    if yf_sym not in returns_map:
        return {"error": "No return data"}

    r = returns_map[yf_sym]
    mu = float(r.mean() * 252)  # annualized
    sigma = float(r.std() * np.sqrt(252))

    if sigma <= 0:
        return {"error": "Zero volatility"}

    # Full Kelly: f* = mu / sigma^2
    kelly_full = mu / (sigma ** 2)
    kelly_adj = kelly_full * kelly_fraction

    # Position value
    kelly_value = kelly_adj * portfolio_value
    max_risk_value = max_risk_pct * portfolio_value

    # ATR-based stop (use daily vol as proxy)
    atr_proxy = float(r.std()) * 2  # 2-sigma daily move
    stop_distance_pct = atr_proxy * 2  # 2 ATR stop

    # Risk-based sizing: max_loss / stop_distance
    risk_based_value = max_risk_value / stop_distance_pct if stop_distance_pct > 0 else 0

    # Take minimum of Kelly and risk-based (conservative)
    final_value = max(0, min(kelly_value, risk_based_value, portfolio_value * 0.15))

    return {
        "symbol": symbol,
        "mu_annual": round(mu * 100, 2),
        "sigma_annual": round(sigma * 100, 2),
        "kelly_full_pct": round(kelly_full * 100, 2),
        "kelly_fraction_pct": round(kelly_adj * 100, 2),
        "suggested_value": round(final_value, 0),
        "suggested_pct_of_portfolio": round(final_value / portfolio_value * 100, 2) if portfolio_value > 0 else 0,
        "max_loss_2pct": round(max_risk_value, 0),
        "stop_distance_pct": round(stop_distance_pct * 100, 2),
    }


# ── Risk Parity Weights ──────────────────────────────────────────────────────

def _risk_parity_weights(cov: np.ndarray, budget: Optional[np.ndarray] = None,
                          max_iter: int = 500, tol: float = 1e-8) -> np.ndarray:
    """Cyclical Coordinate Descent for Risk Parity (Griveau-Billion 2013).
    O(n * max_iter) — very fast for small n.
    """
    n = cov.shape[0]
    if budget is None:
        budget = np.ones(n) / n

    w = np.ones(n) / n

    for _ in range(max_iter):
        w_old = w.copy()
        for i in range(n):
            # Marginal risk excluding i
            others = cov[i] @ w - cov[i, i] * w[i]
            # Solve quadratic for w_i
            a = cov[i, i]
            b = others
            c = -budget[i]
            disc = b * b - 4 * a * c
            if disc < 0:
                continue
            w[i] = (-b + np.sqrt(disc)) / (2 * a)

        # Normalize
        w = w / w.sum()
        if np.max(np.abs(w - w_old)) < tol:
            break

    return w


# ── Early Warning Score ──────────────────────────────────────────────────────

def _compute_ews(m: dict) -> int:
    """Early Warning Score 0–21 (includes sector regime + wedge product + DCC-EWMA).
    ≥5 = WARNING · ≥8 = ALERT · ≥12 = CRITICAL (pre-fat-tail zone)

    Signal breakdown:
      Vol regime      0/1/3  — portfolio rolling vol percentile
      Ensemble signal 0/2    — CF or MC divergence from Hist CVaR
      CF/Hist ratio   0/1/2  — Cornish-Fisher fat-tail divergence
      CI width        0/1/2  — bootstrap uncertainty on CVaR estimate
      Backtest rate   0/1/2  — exception rate vs expected 5%
      Breach count    0-3    — VaR methods exceeded today
      Regime label    0/1/2  — sector correlation regime (DIVERGENT→CONVERGENT)
      Avg wedge       0/1/2  — |sin θ| sector spread: low = co-moving = risk up
      DCC-EWMA        0/1/2/3 — time-varying correlation spike detection
    """
    score = 0
    # Portfolio signals
    score += {"CALM": 0, "ELEVATED": 1, "STRESSED": 3, "UNKNOWN": 0}.get(m.get("vol_regime", "UNKNOWN"), 0)
    score += {"STABLE": 0, "FAT_TAIL_RISK": 2, "CORRELATION_RISK": 2}.get(m.get("ensemble_signal", "STABLE"), 0)
    hist_pct = m.get("var_historical_pct", 0)
    cf_pct   = m.get("var_cf_pct", 0)
    cf_ratio = cf_pct / hist_pct if hist_pct > 0.001 else 1.0
    score += 0 if cf_ratio < 1.1 else (1 if cf_ratio < 1.2 else 2)
    ci_w = m.get("cvar_ci_width_ratio", 1.0)
    score += 0 if ci_w < 1.5 else (1 if ci_w < 2.0 else 2)
    expected_rate = (1.0 - m.get("confidence", 0.95)) * 100
    bt_rate = m.get("var_backtest_rate", 0)
    rate_ratio = bt_rate / expected_rate if expected_rate > 0 else 1.0
    score += 0 if rate_ratio < 1.0 else (1 if rate_ratio < 1.6 else 2)
    score += int(m.get("breach_count", 0))
    # Market regime signals (sector ETF correlation)
    score += {"DIVERGENT": 0, "NEUTRAL": 1, "CONVERGENT": 2, "UNKNOWN": 0}.get(m.get("regime_label", "UNKNOWN"), 0)
    avg_wedge = float(m.get("avg_wedge", 0.5))
    score += 0 if avg_wedge >= 0.45 else (1 if avg_wedge >= 0.30 else 2)
    # DCC-EWMA correlation spike signal
    dcc = m.get("dcc", {})
    score += int(dcc.get("ews_contrib", 0))
    return score


def _save_risk_snapshot(metrics: dict, account_id: str, regime: dict | None = None) -> None:
    """Persist one daily risk snapshot (INSERT OR IGNORE — once per day per account)."""
    from datetime import date as _date
    today = _date.today().isoformat()

    symbols = metrics.get("correlation_matrix", {}).get("symbols", [])
    matrix  = metrics.get("correlation_matrix", {}).get("matrix", [])
    n = len(symbols)
    avg_corr = 0.0
    if n > 1:
        off = [matrix[i][j] for i in range(n) for j in range(i + 1, n)]
        avg_corr = sum(off) / len(off) if off else 0.0

    breach_count = sum([
        bool(metrics.get("breach_hist")),
        bool(metrics.get("breach_cf")),
        bool(metrics.get("breach_mc")),
    ])
    hist_pct = metrics.get("var_historical_pct", 0)
    cf_pct   = metrics.get("var_cf_pct", 0)
    cvar_pct = metrics.get("cvar_pct", 0)
    mc_pct   = metrics.get("cvar_mc_pct", 0)
    cf_hist_ratio = cf_pct / hist_pct if hist_pct > 0.001 else 1.0
    mc_hist_ratio = mc_pct / cvar_pct if cvar_pct > 0.001 else 1.0

    regime_label = (regime or {}).get("label", "UNKNOWN")
    avg_wedge    = (regime or {}).get("avg_wedge", 0.5)

    ews = _compute_ews({
        **metrics,
        "breach_count": breach_count,
        "regime_label": regime_label,
        "avg_wedge": avg_wedge,
    })

    try:
        with get_db() as conn:
            conn.execute("""
                INSERT OR IGNORE INTO risk_snapshots (
                    account_id, snapshot_date,
                    portfolio_value, today_return_pct, breach_count,
                    ensemble_signal, vol_regime,
                    cf_hist_ratio, mc_hist_ratio, ci_width_ratio,
                    avg_correlation, current_drawdown_pct, var_backtest_rate,
                    risk_score, ews, is_fat_tail_event,
                    regime_label, avg_wedge
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                account_id, today,
                metrics.get("portfolio_value", 0),
                metrics.get("today_return_pct", 0),
                breach_count,
                metrics.get("ensemble_signal", "STABLE"),
                metrics.get("vol_regime", "UNKNOWN"),
                round(cf_hist_ratio, 4),
                round(mc_hist_ratio, 4),
                round(metrics.get("cvar_ci_width_ratio", 1.0), 4),
                round(avg_corr, 4),
                metrics.get("current_drawdown_pct", 0),
                metrics.get("var_backtest_rate", 0),
                metrics.get("risk_score", 0),
                ews,
                1 if breach_count == 3 else 0,
                regime_label,
                round(avg_wedge, 4),
            ))
    except Exception:
        pass  # never block the metrics response


# ── EWS Backfill (historical rolling computation) ────────────────────────────

_backfill_done: set = set()


def _build_sector_regime_history() -> dict:
    """Download 1yr sector ETF history, compute rolling 21-day correlation+wedge per calendar day.
    Returns {date_str: {"label": str, "avg_corr": float, "avg_wedge": float}}.
    Uses same logic as _get_market_regime() but applied per-day over full history.
    """
    try:
        raw = yf.download(
            _SECTOR_ETFS, period="1y", interval="1d",
            auto_adjust=True, progress=False, threads=True,
        )
        closes = raw["Close"] if isinstance(raw.columns, pd.MultiIndex) else raw
        ret = closes.pct_change().dropna()
        if len(ret) < 22:
            return {}

        ret_arr = ret.values.astype(float)
        dates = ret.index.normalize()
        n_etf = ret_arr.shape[1]
        result: dict = {}

        for i in range(21, len(ret_arr)):
            window = ret_arr[i - 21: i]
            try:
                corr = np.corrcoef(window.T)
                off_corr  = [abs(corr[a][b]) for a in range(n_etf) for b in range(a + 1, n_etf)]
                off_wedge = [math.sqrt(max(0.0, 1.0 - corr[a][b] ** 2))
                             for a in range(n_etf) for b in range(a + 1, n_etf)]
                ac  = float(np.mean(off_corr))
                aw  = float(np.mean(off_wedge))
                lbl = "CONVERGENT" if ac >= 0.65 else ("NEUTRAL" if ac >= 0.45 else "DIVERGENT")
                result[dates[i].strftime("%Y-%m-%d")] = {
                    "label": lbl, "avg_corr": round(ac, 4), "avg_wedge": round(aw, 4),
                }
            except Exception:
                continue
        return result
    except Exception:
        return {}


def _backfill_ews_history(port_returns: np.ndarray, account_id: str, confidence: float) -> None:
    """Compute rolling per-day EWS + sector regime for all historical days.
    Runs once per account per server session in a background thread.
    Uses UPSERT to also patch existing rows that were stored with regime_label='UNKNOWN'.
    """
    global _backfill_done
    if account_id in _backfill_done:
        return
    _backfill_done.add(account_id)

    try:
        from scipy.stats import norm as _norm

        T = len(port_returns)
        if T < 42:
            return

        end_date = pd.Timestamp.utcnow().normalize() - pd.Timedelta(days=1)
        dates = pd.bdate_range(end=end_date, periods=T)
        if len(dates) != T:
            return

        # Build per-day sector regime from historical ETF data (same window as live signal)
        sector_regime: dict = _build_sector_regime_history()

        z_base = float(_norm.ppf(1 - confidence))
        rows = []

        for i in range(42, T):
            day_returns = port_returns[: i + 1]
            day_ret = float(port_returns[i])
            d_str = dates[i].strftime("%Y-%m-%d")

            # Vol regime
            vols = [float(day_returns[j - 21:j].std(ddof=1)) for j in range(21, len(day_returns))]
            if len(vols) < 2:
                vol_regime = "UNKNOWN"
            else:
                cur = vols[-1]
                p75 = float(np.percentile(vols, 75))
                p90 = float(np.percentile(vols, 90))
                vol_regime = "STRESSED" if cur >= p90 else ("ELEVATED" if cur >= p75 else "CALM")

            # Historical VaR + CVaR
            var_hist = float(-np.percentile(day_returns, (1 - confidence) * 100))
            thresh = np.percentile(day_returns, (1 - confidence) * 100)
            tail = day_returns[day_returns <= thresh]
            hist_cvar = float(-tail.mean()) if len(tail) > 0 else var_hist

            # Cornish-Fisher VaR
            s = float(pd.Series(day_returns).skew())
            k = float(pd.Series(day_returns).kurtosis())
            z_cf = (z_base + (z_base ** 2 - 1) * s / 6
                    + (z_base ** 3 - 3 * z_base) * k / 24
                    - (2 * z_base ** 3 - 5 * z_base) * s ** 2 / 36)
            cf_var = float(-(day_returns.mean() + z_cf * day_returns.std(ddof=1)))

            ref = hist_cvar if hist_cvar > 0.001 else (var_hist if var_hist > 0.001 else 0.001)
            cf_hist_ratio = cf_var / ref
            ensemble_signal = "FAT_TAIL_RISK" if cf_hist_ratio > 1.2 else "STABLE"

            # Backtest exception rate
            exceptions = int(np.sum(day_returns < -var_hist))
            bt_rate = exceptions / len(day_returns) * 100

            # Breach count
            breach_hist_b = day_ret < -var_hist
            breach_cf_b   = day_ret < -cf_var
            breach_count  = int(breach_hist_b) + int(breach_cf_b)
            is_fat        = 1 if (breach_count == 2 and vol_regime == "STRESSED") else 0

            # Per-day sector regime (real historical data, or UNKNOWN if ETF data missing)
            day_regime   = sector_regime.get(d_str, {})
            regime_label = day_regime.get("label", "UNKNOWN")
            avg_wedge    = day_regime.get("avg_wedge", 0.5)

            m_approx = {
                "vol_regime": vol_regime,
                "ensemble_signal": ensemble_signal,
                "var_historical_pct": var_hist * 100,
                "var_cf_pct": cf_var * 100,
                "cvar_ci_width_ratio": 1.0,
                "confidence": confidence,
                "var_backtest_rate": bt_rate,
                "breach_count": breach_count,
                "regime_label": regime_label,
                "avg_wedge": avg_wedge,
            }
            ews = _compute_ews(m_approx)

            rows.append((
                account_id, d_str,
                0.0, round(day_ret * 100, 3), breach_count,
                ensemble_signal, vol_regime,
                round(cf_hist_ratio, 4), 1.0, 1.0,
                0.0, 0.0, round(bt_rate, 2),
                0.0, ews, is_fat,
                regime_label, round(avg_wedge, 4),
            ))

        if not rows:
            return

        with get_db() as conn:
            # UPSERT: insert new rows; for existing rows with UNKNOWN regime, patch them.
            # Rows from live snapshots (regime ≠ UNKNOWN) are never touched.
            conn.executemany("""
                INSERT INTO risk_snapshots (
                    account_id, snapshot_date,
                    portfolio_value, today_return_pct, breach_count,
                    ensemble_signal, vol_regime,
                    cf_hist_ratio, mc_hist_ratio, ci_width_ratio,
                    avg_correlation, current_drawdown_pct, var_backtest_rate,
                    risk_score, ews, is_fat_tail_event,
                    regime_label, avg_wedge
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(account_id, snapshot_date) DO UPDATE SET
                    regime_label = CASE
                        WHEN risk_snapshots.regime_label IS NULL
                          OR risk_snapshots.regime_label = 'UNKNOWN'
                        THEN excluded.regime_label
                        ELSE risk_snapshots.regime_label END,
                    avg_wedge = CASE
                        WHEN risk_snapshots.regime_label IS NULL
                          OR risk_snapshots.regime_label = 'UNKNOWN'
                        THEN excluded.avg_wedge
                        ELSE risk_snapshots.avg_wedge END,
                    ews = CASE
                        WHEN risk_snapshots.regime_label IS NULL
                          OR risk_snapshots.regime_label = 'UNKNOWN'
                        THEN excluded.ews
                        ELSE risk_snapshots.ews END
            """, rows)
    except Exception:
        pass


# ── API Endpoints ────────────────────────────────────────────────────────────

@router.get("/metrics")
def get_risk_metrics(
    account_id: Optional[str] = Query(None),
    confidence: float = Query(0.95),
    lookback: int = Query(252),
    base_currency: str = Query("THB"),
):
    """Full risk analysis for portfolio. Supports per-account or all."""
    base_currency = report_currency(base_currency)
    where = ["win_loss = 'P'"]
    params = []
    if account_id and account_id != "all":
        where.append("account_id = ?")
        params.append(account_id)

    with get_db() as conn:
        rows = conn.execute(
            "SELECT t.*, a.currency acc_currency, a.name acc_name "
            "FROM trades t JOIN portfolio_accounts a ON t.account_id = a.id "
            f"WHERE {' AND '.join(where)} ORDER BY t.date_entry DESC",
            params,
        ).fetchall()

    positions = [dict(r) for r in rows]

    # Enrich with current prices (reuse batch fetch from portfolio_v2)
    try:
        from routers.portfolio_v2 import _batch_fetch_prices
        yf_syms = []
        pos_yf = {}
        for i, pos in enumerate(positions):
            yf_sym = _position_yf_symbol(pos)
            if yf_sym:
                yf_syms.append(yf_sym)
                pos_yf[i] = yf_sym

        prices = _batch_fetch_prices(list(set(yf_syms)))
        for i, pos in enumerate(positions):
            if i in pos_yf:
                # _batch_fetch_prices returns {"price": ..., "prev_close": ...}
                snap = prices.get(pos_yf[i])
                pos["current_price"] = snap.get("price") if isinstance(snap, dict) else snap
    except Exception:
        pass

    metrics = _compute_portfolio_risk(positions, lookback, confidence, base_currency)

    # Pop internal numpy array before JSON serialization
    port_returns_arr = metrics.pop("_port_returns", None)

    # Fetch market regime (cached 5min, thread-safe)
    regime = _get_market_regime()

    # Auto-save daily snapshot for EWS history (fire-and-forget, errors suppressed)
    # Snapshot values have historically been THB. Keep that invariant even
    # when the caller asks the UI response to be reported in USD.
    snapshot_metrics = metrics
    if base_currency != "THB":
        snapshot_metrics = {
            **metrics,
            "portfolio_value": convert_amount(
                metrics.get("portfolio_value", 0), base_currency, "THB"
            ),
        }
    _save_risk_snapshot(snapshot_metrics, account_id or "all", regime=regime)

    # One-time backfill of historical EWS from existing return series (background thread)
    if port_returns_arr is not None and len(port_returns_arr) > 42:
        threading.Thread(
            target=_backfill_ews_history,
            args=(port_returns_arr, account_id or "all", confidence),
            daemon=True,
        ).start()

    # Add account breakdown if "all"
    if not account_id or account_id == "all":
        account_breakdown = {}
        acct_groups = {}
        for pos in positions:
            aid = pos["account_id"]
            if aid not in acct_groups:
                acct_groups[aid] = []
            acct_groups[aid].append(pos)

        for aid, group in acct_groups.items():
            acct_metrics = _compute_portfolio_risk(
                group, lookback, confidence, base_currency
            )
            account_breakdown[aid] = {
                "portfolio_value": acct_metrics["portfolio_value"],
                "var_parametric_pct": acct_metrics["var_parametric_pct"],
                "cvar_pct": acct_metrics["cvar_pct"],
                "volatility_annual_pct": acct_metrics["volatility_annual_pct"],
                "max_drawdown_pct": acct_metrics["max_drawdown_pct"],
                "sharpe_ratio": acct_metrics["sharpe_ratio"],
                "risk_score": acct_metrics["risk_score"],
                "n_positions": acct_metrics["n_positions"],
            }
        metrics["account_breakdown"] = account_breakdown

    return metrics


# ── CAPM / Jensen's alpha ────────────────────────────────────────────────────

def _regress_capm(port_returns, bench_returns, rf_annual: float) -> dict:
    """Regress current-holdings portfolio returns on a benchmark.
    Returns CAPM beta, annualized Jensen's alpha, R², and annualized returns.
    port_returns / bench_returns are daily log-return arrays.
    """
    empty = {
        "beta": None, "alpha_annual_pct": None, "r_squared": None, "n_days": 0,
        "port_return_annual_pct": None, "bench_return_annual_pct": None,
    }
    if port_returns is None or bench_returns is None:
        return empty
    n = min(len(port_returns), len(bench_returns))
    if n < 20:  # 20 ≈ 1 trading month; below this beta is too noisy to report
        return {**empty, "n_days": int(n)}
    y = np.asarray(port_returns[-n:], dtype=float)
    x = np.asarray(bench_returns[-n:], dtype=float)
    rf_daily = rf_annual / 252.0
    ye, xe = y - rf_daily, x - rf_daily      # excess returns
    var_x = float(xe.var())
    if var_x <= 0:
        return {**empty, "n_days": int(n)}
    beta = float(np.cov(ye, xe, bias=True)[0, 1] / var_x)
    alpha_daily = float(ye.mean() - beta * xe.mean())
    corr = float(np.corrcoef(y, x)[0, 1])
    return {
        "beta": round(beta, 3),
        "alpha_annual_pct": round(alpha_daily * 252 * 100, 2),
        "r_squared": round(corr * corr, 3),
        "n_days": int(n),
        # Geometric (compounded) annualization from daily log-returns → simple % that
        # matches realized reality: exp(mean_log * 252) - 1. Arithmetic mean*252 understated it.
        "port_return_annual_pct": round(float(np.expm1(y.mean() * 252)) * 100, 2),
        "bench_return_annual_pct": round(float(np.expm1(x.mean() * 252)) * 100, 2),
    }


@router.get("/capm")
def get_capm(
    account_id: Optional[str] = Query(None),
    lookback: int = Query(252),
    benchmark: str = Query("SPY"),
    rf_annual: float = Query(0.02),
):
    """CAPM beta + Jensen's alpha for the open portfolio, regressed on `benchmark`.
    Beta is computed on the current book held constant over the lookback window
    (holdings-based). Per-account breakdown returned when account_id is omitted/all.
    """
    where = ["win_loss = 'P'"]
    params: list = []
    if account_id and account_id != "all":
        where.append("account_id = ?")
        params.append(account_id)

    with get_db() as conn:
        rows = conn.execute(
            "SELECT t.*, a.currency acc_currency, a.name acc_name "
            "FROM trades t JOIN portfolio_accounts a ON t.account_id = a.id "
            f"WHERE {' AND '.join(where)} ORDER BY t.date_entry DESC",
            params,
        ).fetchall()
    positions = [dict(r) for r in rows]

    # Enrich with live prices (same shape handling as /metrics)
    try:
        from routers.portfolio_v2 import _batch_fetch_prices
        yf_syms, pos_yf = [], {}
        for i, pos in enumerate(positions):
            yf_sym = _position_yf_symbol(pos)
            if yf_sym:
                yf_syms.append(yf_sym)
                pos_yf[i] = yf_sym
        prices = _batch_fetch_prices(list(set(yf_syms)))
        for i, pos in enumerate(positions):
            if i in pos_yf:
                snap = prices.get(pos_yf[i])
                pos["current_price"] = snap.get("price") if isinstance(snap, dict) else snap
    except Exception:
        pass

    bench_map = _fetch_returns([benchmark], lookback)
    bench = bench_map.get(benchmark)

    def _capm_for(pos_list: list[dict]) -> dict:
        m = _compute_portfolio_risk(pos_list, lookback, 0.95)
        return _regress_capm(m.get("_port_returns"), bench, rf_annual)

    result: dict = {
        "benchmark": benchmark,
        "lookback": lookback,
        "rf_annual": rf_annual,
        "benchmark_available": bench is not None,
        "portfolio": _capm_for(positions),
    }

    if not account_id or account_id == "all":
        groups: dict[str, list[dict]] = {}
        for pos in positions:
            groups.setdefault(pos["account_id"], []).append(pos)
        result["accounts"] = {
            aid: {**_capm_for(g), "name": g[0].get("acc_name") or aid}
            for aid, g in groups.items()
        }

    return result


@router.get("/history")
def get_risk_history(
    account_id: Optional[str] = Query(None),
    days: int = Query(30),
):
    """30-day EWS signal history for heatmap visualization."""
    acc = account_id if (account_id and account_id != "all") else "all"
    with get_db() as conn:
        rows = conn.execute("""
            SELECT snapshot_date, today_return_pct, breach_count,
                   ensemble_signal, vol_regime, cf_hist_ratio, mc_hist_ratio,
                   ci_width_ratio, avg_correlation, current_drawdown_pct,
                   var_backtest_rate, risk_score, ews, is_fat_tail_event,
                   COALESCE(regime_label, 'UNKNOWN') AS regime_label,
                   COALESCE(avg_wedge, 0.5)          AS avg_wedge
            FROM risk_snapshots
            WHERE account_id = ?
              AND snapshot_date >= date('now', ?)
            ORDER BY snapshot_date ASC
        """, (acc, f"-{days} days")).fetchall()

    snapshots = [dict(r) for r in rows]
    fat_tail_dates = [s["snapshot_date"] for s in snapshots if s["is_fat_tail_event"]]
    return {"snapshots": snapshots, "fat_tail_dates": fat_tail_dates, "days": days}


@router.get("/history/export")
def export_risk_history(
    account_id: Optional[str] = Query(None),
    days: int = Query(365),
    fmt: str = Query("csv"),
):
    """Export full EWS history as CSV or JSON for offline analysis."""
    from fastapi.responses import PlainTextResponse
    acc = account_id if (account_id and account_id != "all") else "all"
    with get_db() as conn:
        rows = conn.execute("""
            SELECT snapshot_date, today_return_pct, breach_count,
                   ensemble_signal, vol_regime, cf_hist_ratio, mc_hist_ratio,
                   ci_width_ratio, avg_correlation, current_drawdown_pct,
                   var_backtest_rate, risk_score, ews, is_fat_tail_event,
                   COALESCE(regime_label, 'UNKNOWN') AS regime_label,
                   COALESCE(avg_wedge, 0.5)          AS avg_wedge
            FROM risk_snapshots
            WHERE account_id = ?
              AND snapshot_date >= date('now', ?)
            ORDER BY snapshot_date ASC
        """, (acc, f"-{days} days")).fetchall()

    data = [dict(r) for r in rows]
    if fmt == "json":
        import json
        from fastapi.responses import JSONResponse
        return JSONResponse(content=data)

    # CSV
    if not data:
        return PlainTextResponse("snapshot_date\n", media_type="text/csv")
    cols = list(data[0].keys())
    lines = [",".join(cols)]
    for r in data:
        lines.append(",".join(str(r[c]) for c in cols))
    content = "\n".join(lines) + "\n"
    return PlainTextResponse(
        content, media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="ews_history_{acc}_{days}d.csv"'},
    )


@router.get("/position-size")
def get_position_size(
    symbol: str = Query(...),
    account_id: str = Query("dime"),
    portfolio_value: float = Query(0),
    max_risk_pct: float = Query(0.02),
    kelly_fraction: float = Query(0.3),
):
    """Optimal position size using fractional Kelly + risk constraints."""
    if portfolio_value <= 0:
        # Auto-compute from open positions
        with get_db() as conn:
            rows = conn.execute(
                """SELECT t.*, a.currency acc_currency FROM trades t
                   JOIN portfolio_accounts a ON a.id = t.account_id
                   WHERE t.win_loss = 'P' AND t.account_id = ?""",
                (account_id,),
            ).fetchall()
        portfolio_value = sum(
            convert_amount(
                float(r["price_entry"]) * float(r["volume"]),
                trade_currency(dict(r)),
                "THB",
            )
            for r in rows
        )

    return _kelly_size(symbol, account_id, portfolio_value, max_risk_pct, kelly_fraction)


@router.get("/risk-parity")
def get_risk_parity_allocation(
    account_id: Optional[str] = Query(None),
    lookback: int = Query(252),
):
    """Compute Risk Parity (ERC) optimal weights vs current weights."""
    where = ["win_loss = 'P'"]
    params = []
    if account_id and account_id != "all":
        where.append("account_id = ?")
        params.append(account_id)

    with get_db() as conn:
        rows = conn.execute(
            "SELECT t.symbol, t.resolved_symbol, t.market, t.currency, t.account_id, "
            "t.price_entry, t.volume, a.currency acc_currency "
            "FROM trades t JOIN portfolio_accounts a ON t.account_id = a.id "
            f"WHERE {' AND '.join(where)}",
            params,
        ).fetchall()

    positions = [dict(r) for r in rows]
    if not positions:
        return {"current_weights": [], "optimal_weights": [], "rebalance_actions": []}

    # Aggregate values by yf_symbol — fixes bug where duplicate positions were ignored
    sym_value_map: dict[str, float] = {}
    sym_name_map: dict[str, str] = {}
    sym_currency_map: dict[str, str] = {}
    for pos in positions:
        yf_sym = _position_yf_symbol(pos)
        if yf_sym:
            native_val = float(pos["price_entry"]) * float(pos["volume"])
            val = convert_amount(native_val, trade_currency(pos), "THB")
            if val > 0:
                sym_value_map[yf_sym] = sym_value_map.get(yf_sym, 0.0) + val
                sym_name_map[yf_sym] = pos["symbol"]
                sym_currency_map[yf_sym] = trade_currency(pos)

    symbols = list(sym_value_map.keys())
    values = [sym_value_map[s] for s in symbols]
    sym_names = [sym_name_map[s] for s in symbols]

    if len(symbols) < 2:
        return {"current_weights": [], "optimal_weights": [], "rebalance_actions": []}

    total = sum(values)
    current_w = np.array(values) / total

    # Fetch returns & compute covariance
    returns_map = _fetch_returns(symbols, lookback)
    valid_idx = [i for i, s in enumerate(symbols) if s in returns_map]
    if len(valid_idx) < 2:
        return {"current_weights": [], "optimal_weights": [], "rebalance_actions": []}

    valid_syms = [symbols[i] for i in valid_idx]
    min_len = min(len(returns_map[s]) for s in valid_syms)
    R = np.column_stack([returns_map[s][-min_len:] for s in valid_syms])

    cov = _ledoit_wolf_shrinkage(R)
    optimal_w = _risk_parity_weights(cov)

    current_valid = np.array([current_w[i] for i in valid_idx])
    current_valid = current_valid / current_valid.sum()

    # Fetch current prices for shares calculation
    try:
        from routers.portfolio_v2 import _batch_fetch_prices
        price_map = _batch_fetch_prices(valid_syms)
    except Exception:
        price_map = {}

    # Rebalance actions
    actions = []
    for i, idx in enumerate(valid_idx):
        drift = float(optimal_w[i] - current_valid[i])
        if abs(drift) > 0.03:  # >3% drift
            action = "BUY" if drift > 0 else "TRIM"
            trade_val = drift * total
            yf_sym = valid_syms[i]
            snap = price_map.get(yf_sym)
            cur_price = snap.get("price") if isinstance(snap, dict) else snap
            price_base = convert_amount(
                float(cur_price or 0), sym_currency_map.get(yf_sym, "THB"), "THB"
            )
            shares_change = round(trade_val / price_base, 2) if price_base > 0 else None
            actions.append({
                "symbol": sym_names[idx],
                "action": action,
                "current_weight_pct": round(float(current_valid[i]) * 100, 2),
                "optimal_weight_pct": round(float(optimal_w[i]) * 100, 2),
                "drift_pct": round(drift * 100, 2),
                "trade_value": round(trade_val, 0),
                "current_price": round(cur_price, 4) if cur_price else None,
                "shares_change": shares_change,
            })

    return {
        "current_weights": [
            {"symbol": sym_names[i], "weight_pct": round(float(current_valid[j]) * 100, 2)}
            for j, i in enumerate(valid_idx)
        ],
        "optimal_weights": [
            {"symbol": sym_names[valid_idx[i]], "weight_pct": round(float(optimal_w[i]) * 100, 2)}
            for i in range(len(valid_idx))
        ],
        "rebalance_actions": sorted(actions, key=lambda x: -abs(x["drift_pct"])),
        "method": "ERC_CCD_LedoitWolf",
        "portfolio_value": round(total, 2),
    }


@router.get("/stress-test")
def stress_test(
    account_id: Optional[str] = Query(None),
    scenario: str = Query("historical"),
):
    """
    Run stress scenarios on portfolio.
    Scenarios: historical (2008, 2020, 2022), custom_shock.
    """
    # Historical stress multipliers (empirical from those periods)
    SCENARIOS = {
        "covid_2020": {"label": "COVID-19 Mar 2020", "equity": -0.34, "crypto": -0.50, "fx_thb": 0.05},
        "gfc_2008": {"label": "GFC 2008", "equity": -0.55, "crypto": 0, "fx_thb": 0.10},
        "rate_hike_2022": {"label": "Rate Hike 2022", "equity": -0.25, "crypto": -0.65, "fx_thb": 0.08},
        "flash_crash": {"label": "Flash Crash (1-day)", "equity": -0.07, "crypto": -0.15, "fx_thb": 0.02},
        "thai_crisis_97": {"label": "Thai Crisis 1997", "equity": -0.75, "crypto": 0, "fx_thb": 0.50},
    }

    where = ["win_loss = 'P'"]
    params = []
    if account_id and account_id != "all":
        where.append("account_id = ?")
        params.append(account_id)

    with get_db() as conn:
        rows = conn.execute(
            "SELECT t.symbol, t.resolved_symbol, t.market, t.currency, "
            "t.account_id, t.price_entry, t.volume, "
            "a.currency acc_currency "
            "FROM trades t JOIN portfolio_accounts a ON t.account_id = a.id "
            f"WHERE {' AND '.join(where)}",
            params,
        ).fetchall()

    positions = [dict(r) for r in rows]
    if not positions:
        return {"scenarios": []}

    thb_per_usd = _get_thb_per_usd()

    # Common THB denominator is mandatory for mixed-market portfolios.
    total_value = sum(
        convert_amount(
            float(pos["price_entry"] or 0) * float(pos["volume"]),
            trade_currency(pos),
            "THB",
            stored_thb_rate=thb_per_usd,
        )
        for pos in positions
    )
    if total_value <= 0:
        return {"scenarios": []}

    results = []
    for key, sc in SCENARIOS.items():
        total_loss = 0.0
        for pos in positions:
            price = float(pos["price_entry"] or 0)
            vol = float(pos["volume"])
            val = price * vol
            pos_ccy = trade_currency(pos)
            val_thb = convert_amount(val, pos_ccy, "THB", stored_thb_rate=thb_per_usd)

            is_crypto = str(pos.get("market") or "").upper() == "CRYPTO" or "-" in str(pos.get("resolved_symbol") or "")
            shock = sc["crypto"] if is_crypto else sc["equity"]

            loss_thb = val_thb * shock
            if pos_ccy in ("USD", "USDT"):
                # Positive fx_thb means THB weakens, partly cushioning USD losses.
                loss_thb += val_thb * sc["fx_thb"]

            total_loss += loss_thb

        results.append({
            "scenario": key,
            "label": sc["label"],
            "portfolio_loss_thb": round(total_loss, 0),
            "portfolio_loss_pct": round(total_loss / total_value * 100, 2),
        })

    return {"scenarios": sorted(results, key=lambda x: x["portfolio_loss_thb"])}
