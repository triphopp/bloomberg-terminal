"""
Portfolio Risk Engine — Emotion-free systematic risk analysis.
Supports per-account and combined (all accounts) risk metrics.

Complexity target: O(n*T) where n=positions, T=lookback days.
All covariance uses Ledoit-Wolf shrinkage (O(n^2*T)) — no matrix inversion needed for basic metrics.
"""
import json
import logging
import math
import threading
import time
import uuid
from datetime import date, datetime, timedelta
from typing import Literal, Optional

import numpy as np
import pandas as pd
import yfinance as yf
from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from cache import TTLCache
from db import get_db
from portfolio_currency import (
    convert_amount,
    normalize_currency,
    report_currency,
    trade_currency,
)

logger = logging.getLogger(__name__)
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


# Minimum price history a holding needs before it may enter a regression or a
# covariance matrix. A freshly-listed name used to drag the WHOLE book down to
# its own length (see `_aligned_returns`), so one 19-bar IPO reduced a 252-day
# portfolio beta to 23 observations.
MIN_HISTORY_DAYS = 60

# Symbols that trade 7 days a week (crypto). Their weekend bars must not define
# the trading calendar for an equity book, or every equity gets ~100 fabricated
# zero-return days a year.
_ALWAYS_ON_BARS_PER_YEAR = 300


def _fetch_close_frame(symbols: list[str], days: int = 252) -> "pd.DataFrame":
    """Adjusted closes for `symbols`, indexed by DATE. Cached 5min.

    Returning the DatetimeIndex is the whole point: every consumer here pairs
    one asset's day against another's, and the previous `.values` return threw
    the dates away — leaving callers to line series up by ROW POSITION. A Thai
    holiday, or crypto's weekend bars, then silently paired different dates.
    """
    symbols = [s for s in dict.fromkeys(symbols) if s]
    if not symbols:
        return pd.DataFrame()
    cache_key = f"frame:{','.join(sorted(symbols))}_{days}"
    cached = _returns_cache.get(cache_key)
    if cached is not None:
        return cached

    end = datetime.utcnow()
    # 1.5x for weekends/holidays + fixed cushion so short windows (e.g. 21d ≈ 1M)
    # still clear the observation gates below.
    start = end - timedelta(days=int(days * 1.5) + 14)

    def _download() -> "pd.DataFrame":
        df = yf.download(
            symbols, start=start.strftime("%Y-%m-%d"),
            end=end.strftime("%Y-%m-%d"),
            progress=False, auto_adjust=True, threads=True,
        )
        if df.empty:
            return pd.DataFrame()
        close = df["Close"] if "Close" in df.columns else df
        if not hasattr(close, "columns"):          # single symbol → Series
            close = close.to_frame(name=symbols[0])
        return close.reindex(columns=[s for s in symbols if s in close.columns])

    # yf.download() resets yfinance's MODULE-GLOBAL result dicts on every call
    # (yfinance/multi.py: shared._DFS = {}), so a download running at the same
    # moment in another router can wipe ours: 2026-09-27 the heatmap's failing
    # DX=F download left nav-index a 64×0 frame, which was then cached for 5
    # minutes and the SPY line vanished from ANALYTICS INDEX. A wipe loses
    # every column, so a frame with NONE of our symbols is retried once and never
    # cached. A partial frame is kept as before: one holding with no Yahoo data
    # must not turn every CAPM call into two downloads.
    try:
        close = _download()
        if close.shape[1] == 0:
            time.sleep(0.4)
            close = _download()
        if close.shape[1] > 0:
            _returns_cache.set(cache_key, close)
        return close
    except Exception:
        return pd.DataFrame()


def _fetch_returns(symbols: list[str], days: int = 252) -> dict[str, np.ndarray]:
    """Per-symbol log-return arrays (each on its OWN calendar).

    Kept for single-symbol callers (Kelly sizing) where there is nothing to
    align against. Anything that combines two or more series must use
    `_aligned_returns` instead — bare arrays cannot be date-matched.
    """
    close = _fetch_close_frame(symbols, days)
    if close.empty:
        return {}
    out: dict[str, np.ndarray] = {}
    for sym in symbols:
        if sym not in close.columns:
            continue
        s = close[sym].dropna()
        if len(s) >= 20:
            out[sym] = np.log(s / s.shift(1)).dropna().values[-days:]
    return out


def _usd_leg(ccy: str, days: int) -> Optional["pd.Series"]:
    """Close series of `ccy` per 1 USD (1.0 for USD itself)."""
    ccy = (ccy or "USD").upper()
    if ccy == "USD":
        return None                     # caller treats None as the constant 1.0
    frame = _fetch_close_frame([f"{ccy}=X"], days)
    if frame.empty or f"{ccy}=X" not in frame.columns:
        return None
    return frame[f"{ccy}=X"].dropna()


def _fx_close(from_ccy: str, to_ccy: str, days: int) -> Optional["pd.Series"]:
    """`to_ccy` units per one `from_ccy` unit, as a dated series.

    Cross rates go through USD (rate = usd_to(to) / usd_to(from)), which is how
    both legs are quoted by the provider.
    """
    from_ccy, to_ccy = (from_ccy or "USD").upper(), (to_ccy or "USD").upper()
    if from_ccy == to_ccy:
        return None
    to_leg, from_leg = _usd_leg(to_ccy, days), _usd_leg(from_ccy, days)
    if to_leg is None and from_leg is None:
        return None
    if from_leg is None:                # from == USD
        return to_leg
    if to_leg is None:                  # to == USD
        return 1.0 / from_leg
    joined = pd.concat([to_leg.rename("t"), from_leg.rename("f")], axis=1).dropna()
    return joined["t"] / joined["f"]


def _aligned_returns(
    symbols: list[str],
    days: int,
    ccy_map: Optional[dict[str, str]] = None,
    base_currency: Optional[str] = None,
    calendar: Optional["pd.DatetimeIndex"] = None,
    min_history: int = MIN_HISTORY_DAYS,
    common_only: bool = True,
    close: Optional["pd.DataFrame"] = None,
) -> tuple["pd.DataFrame", list[dict]]:
    """Date-aligned log-return matrix, optionally translated to `base_currency`.

    Returns `(returns_df, excluded)`. `excluded` lists symbols dropped for want
    of history — dropping them is what keeps ONE new listing from truncating
    every other holding's series (the old `min_len` behaviour).

    Alignment: every series is reindexed onto a single trading calendar and
    forward-filled, so a day a market was shut reads as a 0 return for that
    market instead of shifting its whole history by one row. The calendar is
    the union of the non-24/7 symbols' own trading days — crypto's weekend bars
    would otherwise invent ~100 zero-return days a year for every equity.

    `common_only=False` keeps the days before a symbol was listed as NaN
    instead of cutting every symbol down to the youngest one's history (the
    Monte Carlo fills those days itself — `port_mc.backfill`). `close` = a
    close frame the caller already fetched (and repaired), used as is.
    """
    if close is None:
        close = _fetch_close_frame(symbols, days)
    if close.empty:
        return pd.DataFrame(), [{"symbol": s, "reason": "no data", "bars": 0} for s in symbols]

    keep, excluded = [], []
    for sym in symbols:
        bars = int(close[sym].dropna().shape[0]) if sym in close.columns else 0
        if bars >= max(20, min(min_history, days)):
            keep.append(sym)
        else:
            excluded.append({
                "symbol": sym,
                "reason": "no data" if bars == 0 else "insufficient history",
                "bars": bars,
            })
    if not keep:
        return pd.DataFrame(), excluded

    if calendar is None:
        equity_like = [s for s in keep
                       if close[s].dropna().shape[0] <= _ALWAYS_ON_BARS_PER_YEAR * days / 252]
        idx = None
        for sym in (equity_like or keep):
            days_idx = close[sym].dropna().index
            idx = days_idx if idx is None else idx.union(days_idx)
        calendar = idx

    aligned = close[keep].reindex(calendar).ffill()
    rets = np.log(aligned / aligned.shift(1))

    if base_currency and ccy_map:
        base = report_currency(base_currency)
        fx_cache: dict[str, Optional[pd.Series]] = {}
        for sym in keep:
            ccy = normalize_currency(ccy_map.get(sym) or base)
            if ccy == base:
                continue
            if ccy not in fx_cache:
                fx_cache[ccy] = _fx_close(ccy, base, days)
            fx = fx_cache[ccy]
            if fx is None:
                continue
            # An asset's return to a base-currency investor is its local return
            # PLUS the currency's move. Converting only the position VALUE (as
            # the weights already do) leaves the FX out of risk entirely.
            fx_ret = np.log(fx.reindex(calendar).ffill()).diff()
            rets[sym] = rets[sym] + fx_ret

    rets = rets.dropna() if common_only else rets.dropna(how="all")
    if len(rets) > days:
        rets = rets.iloc[-days:]
    return rets, excluded


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


def _var_backtest_oos(
    port_returns: np.ndarray, confidence: float, window: Optional[int] = None,
) -> tuple[int, int, float, str]:
    """Rolling OUT-OF-SAMPLE historical-VaR backtest.

    Day t is judged against the VaR estimated from the `window` days BEFORE it,
    never from a sample that contains day t. The in-sample count (_var_backtest)
    scores a percentile against its own sample and lands on 1−confidence by
    construction — it could not fail. Returns (exceptions, n_obs, rate, signal).
    Still the CURRENT basket replayed backwards: the live forecast log
    (`var_forecasts`, GET /risk/var-backtest) is the test of the real book.
    """
    T = len(port_returns)
    w = window or max(60, min(126, T // 2))
    if T - w < 30:
        return 0, max(T - w, 0), 0.0, "INSUFFICIENT_DATA"
    q = (1 - confidence) * 100
    exc = 0
    for t in range(w, T):
        if port_returns[t] < np.percentile(port_returns[t - w:t], q):  # perf-ok: ≤250 obs, once per request
            exc += 1
    n = T - w
    rate = exc / n
    expected = 1.0 - confidence
    signal = "GREEN" if rate <= expected else ("YELLOW" if rate <= expected * 1.6 else "RED")
    return exc, n, float(rate), signal


def _var_backtest_series(
    port_returns: "pd.Series", confidence: float, window: Optional[int] = None,
) -> list[dict]:
    """The days behind `_var_backtest_oos`, one row each, for the chart that
    shows WHEN the line was crossed (clustered = a regime the window had not
    seen; scattered = a line that is simply too tight).

    Same rule: day t against the VaR of the `window` days before it. → rows
    {d: date, r: that day's return %, v: the VaR line that day % (negative),
    x: crossed}. Empty when there are too few days to judge.
    """
    vals = np.asarray(port_returns.values, dtype=float)
    T = len(vals)
    w = window or max(60, min(126, T // 2))
    if T - w < 30:
        return []
    q = (1 - confidence) * 100
    out = []
    for t in range(w, T):
        line = float(np.percentile(vals[t - w:t], q))  # perf-ok: ≤250 obs, once per request
        out.append({
            "d": port_returns.index[t].strftime("%Y-%m-%d"),
            "r": round(float(vals[t]) * 100, 3),
            "v": round(line * 100, 3),
            "x": bool(vals[t] < line),
        })
    return out


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
    positions: list[dict], lookback: int, confidence: float, base_currency: str = "THB",
    cash_base: float = 0.0,
    extra_exposure: Optional[dict[str, tuple[float, str, str]]] = None,
):
    """
    Compute full risk metrics for a set of positions.
    Returns dict with all metrics.

    Weights are on a NAV basis (2026-09-29): NAV = net market value + cash, so
    cash dilutes risk instead of being ignored, a short lot (negative volume)
    is a negative weight instead of being dropped, and `extra_exposure`
    ({yf_symbol: (signed base value, currency, label)}) adds option legs as
    delta-equivalent underlying exposure — linear, no gamma.
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

    sym_ccy_map: dict[str, str] = {}           # yf_sym → instrument currency

    for pos in positions:
        yf_sym = _position_yf_symbol(pos)
        if not yf_sym:
            continue
        price = pos.get("current_price") or pos.get("price_entry", 0)
        vol = float(pos.get("volume", 0))
        native_val = float(price or 0) * vol
        val = convert_amount(native_val, trade_currency(pos), report_currency(base_currency))
        sym_ccy_map.setdefault(yf_sym, trade_currency(pos))
        if val != 0:
            sym_value_map[yf_sym] = sym_value_map.get(yf_sym, 0.0) + val
            if price:
                sym_price_map[yf_sym] = float(price)
            sym_to_yf[yf_sym] = pos["symbol"]  # last display name wins
        entry_price = float(pos.get("price_entry") or 0)
        if entry_price > 0 and vol > 0:
            sym_entry_value_map[yf_sym] = sym_entry_value_map.get(yf_sym, 0.0) + entry_price * vol
            sym_volume_map[yf_sym] = sym_volume_map.get(yf_sym, 0.0) + vol

    option_value = 0.0
    for yf_sym, (val, ccy, label) in (extra_exposure or {}).items():
        if not val:
            continue
        sym_value_map[yf_sym] = sym_value_map.get(yf_sym, 0.0) + val
        sym_ccy_map.setdefault(yf_sym, ccy)
        sym_to_yf.setdefault(yf_sym, label)
        option_value += val

    if not sym_value_map:
        return _empty_metrics()

    symbols = list(sym_value_map.keys())
    values  = [sym_value_map[s] for s in symbols]

    net_value = sum(values)
    gross_value = sum(abs(v) for v in values)
    short_value = sum(v for v in values if v < 0)
    total_value = net_value + float(cash_base or 0.0)      # NAV
    if total_value <= 0:
        total_value = gross_value                           # degenerate book: fall back to gross
    weights = np.array(values) / total_value

    # Date-aligned, base-currency return matrix. Symbols without enough history
    # are dropped and their weight redistributed — the old code instead cut every
    # symbol's series down to the shortest one, so a single new listing could
    # leave a 252-day request with 23 usable days.
    returns_df, excluded = _aligned_returns(
        symbols, lookback, ccy_map=sym_ccy_map, base_currency=base_currency
    )
    valid_syms = list(returns_df.columns) if not returns_df.empty else []
    if len(valid_syms) < 1:
        return _empty_metrics()

    R = returns_df.values
    w = np.array([weights[symbols.index(s)] for s in valid_syms])
    # Symbols without history lend their weight to the rest, keeping the book's
    # net invested share (cash stays cash).
    if abs(w.sum()) > 1e-12:
        w = w * (weights.sum() / w.sum())

    T, n = R.shape

    # Portfolio returns series (dated — CAPM regresses this against a benchmark
    # and must join on the date, not on the row number).
    #
    # Log returns add across TIME, not across ASSETS: a portfolio's return is the
    # weighted mean of its holdings' SIMPLE returns. Weighting log returns
    # directly (`R @ w`) understates by the Jensen gap — small per day, but it
    # compounds: it put the annualized figure 53 percentage points low on this
    # book, and pushed Jensen's alpha down by 16.
    port_simple = np.expm1(R) @ w
    port_returns = np.log1p(port_simple)
    port_returns_dated = pd.Series(port_returns, index=returns_df.index)

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
    # Out-of-sample (rolling): the in-sample count could never fail.
    bt_exceptions, bt_obs, bt_rate, bt_signal = _var_backtest_oos(port_returns, confidence)

    # ── Breach detection: most-recent return vs each VaR threshold ────────────
    # NOT the live day. It is the last COMPLETED daily bar of the history the
    # model is fitted on: today's basket at today's weights, close to close, in
    # the base currency (FX included). While a session is open that is
    # yesterday's move — `last_return_date` says which day, and the screen
    # shows the live day (TRADE GUARD's price vs previous close) beside it.
    today_return = float(port_returns[-1]) if len(port_returns) > 0 else 0.0
    last_return_date = returns_df.index[-1].strftime("%Y-%m-%d") if len(returns_df.index) else None
    breach_hist = today_return < -var_hist_pct
    breach_cf   = today_return < -var_cf_pct
    breach_mc   = today_return < -cvar_mc_pct

    # Kupiec POF test p-value
    kupiec_pvalue = _kupiec_pvalue(bt_exceptions, bt_obs, confidence)
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
    div_ratio = float(np.sum(np.abs(w) * individual_vols) / port_vol_daily)

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
        # NAV basis (cash in the denominator, shorts negative, options by delta)
        "nav_value": round(total_value, 2),
        "cash_value": round(float(cash_base or 0.0), 2),
        "gross_exposure_pct": round(gross_value / total_value * 100, 2) if total_value else None,
        "net_exposure_pct": round(net_value / total_value * 100, 2) if total_value else None,
        "short_value": round(short_value, 2),
        "option_delta_value": round(option_value, 2),
        "n_positions": len(valid_syms),
        "lookback_days": int(T),
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
        "var_backtest_obs": bt_obs,
        "var_backtest_method": "rolling_oos_current_basket",
        "var_backtest_series": _var_backtest_series(port_returns_dated, confidence),
        # Breach checker
        "today_return_pct": round(today_return * 100, 3),
        "last_return_date": last_return_date,
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
        # Holdings left out of the risk math for want of price history, with
        # their book weight — a silent exclusion is how a number lies.
        "excluded_symbols": [
            {**e, "weight_pct": round(
                100 * sym_value_map.get(e["symbol"], 0.0) / total_value, 2
            )}
            for e in excluded
        ],
        "return_days": int(T),
        # Internal: popped before JSON serialization, used for backfill
        "_port_returns": port_returns,
        "_port_returns_dated": port_returns_dated,
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
    HMM regime adds orthogonal signal — see D:/Agents/Claude/backtest-idea/02_dcc_correlation_monitor/run.py
    (the backtest suite lives outside this repo).

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
        "excluded_symbols": [], "return_days": 0,
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

def _risk_parity_weights(cov: np.ndarray, budget: Optional[np.ndarray] = None) -> np.ndarray:
    """Equal Risk Contribution weights (or risk shares = `budget`).

    Was a coordinate descent that re-normalised w inside the loop — that moves
    the fixed point, so the result was NOT equal risk (five holdings came out
    13–30% each instead of 20%). Now the convex formulation in
    risk_balance.erc_weights, which is exact and unique.
    """
    import risk_balance

    return risk_balance.erc_weights(cov, budget)


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

def _open_positions_priced(account_id: Optional[str]) -> list[dict]:
    """Open lots (win_loss 'P') with `current_price` filled from the batch quote."""
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
    return positions


def _option_exposure(account_id: Optional[str], base: str) -> dict[str, tuple[float, str, str]]:
    """Open option lots as delta-equivalent underlying value in `base`:
    {underlying: (signed value, currency, label)}. Lots without a delta
    (no quote) are left out — `option_unpriced` in the metrics says so."""
    out: dict[str, tuple[float, str, str]] = {}
    try:
        from portfolio_options import open_option_positions, option_currency
        lots = open_option_positions(None if account_id in (None, "all") else account_id, base)
    except Exception:
        return out
    for lot in lots:
        v = lot.get("delta_notional_base")
        u = str(lot.get("underlying") or "").upper()
        if v is None or not u:
            continue
        prev = out.get(u, (0.0, option_currency(lot), f"{u} (options Δ)"))
        out[u] = (prev[0] + float(v), prev[1], prev[2])
    return out


def _risk_extras(account_id: Optional[str], base: str, summ: Optional[dict] = None):
    """(cash, option exposure) for `_compute_portfolio_risk`'s NAV basis."""
    cash = _guard_cash(account_id if account_id not in (None, "all") else None, base, summ)
    return float(cash or 0.0), _option_exposure(account_id, base)


@router.get("/metrics")
def get_risk_metrics(
    account_id: Optional[str] = Query(None),
    confidence: float = Query(0.95),
    lookback: int = Query(252),
    base_currency: str = Query("THB"),
):
    """Full risk analysis for portfolio. Supports per-account or all."""
    base_currency = report_currency(base_currency)
    positions = _open_positions_priced(account_id)

    try:
        from routers.portfolio_v2 import get_summary
        summ = get_summary(base_currency=base_currency)
    except Exception:
        summ = None
    cash, opt = _risk_extras(account_id, base_currency, summ)
    metrics = _compute_portfolio_risk(positions, lookback, confidence, base_currency,
                                      cash_base=cash, extra_exposure=opt)

    # Pop internal numpy/pandas series before JSON serialization
    port_returns_arr = metrics.pop("_port_returns", None)
    metrics.pop("_port_returns_dated", None)

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
            a_cash, a_opt = _risk_extras(aid, base_currency, summ)
            acct_metrics = _compute_portfolio_risk(
                group, lookback, confidence, base_currency, cash_base=a_cash, extra_exposure=a_opt
            )
            account_breakdown[aid] = {
                "portfolio_value": acct_metrics["portfolio_value"],
                "var_parametric_pct": acct_metrics["var_parametric_pct"],
                "cvar_pct": acct_metrics["cvar_pct"],
                "volatility_daily_pct": acct_metrics["volatility_daily_pct"],
                "volatility_annual_pct": acct_metrics["volatility_annual_pct"],
                "vol_regime": acct_metrics["vol_regime"],
                "max_drawdown_pct": acct_metrics["max_drawdown_pct"],
                "sharpe_ratio": acct_metrics["sharpe_ratio"],
                "risk_score": acct_metrics["risk_score"],
                "n_positions": acct_metrics["n_positions"],
            }
        metrics["account_breakdown"] = account_breakdown

    return metrics


# ── CAPM / Jensen's alpha ────────────────────────────────────────────────────

def _min_regression_days(lookback: int) -> int:
    """Observations a regression must have before its beta is worth printing.

    Scales with the window so the 1M button still works, with a hard floor at
    20. The old flat `n < 20` let a 252-day request answer from 23 days (a
    truncation bug upstream) and print an annualized alpha of −178%.
    """
    return max(20, int(lookback * 0.6))


def _regress_capm(port_returns, bench_returns, rf_annual: float, lookback: int = 252) -> dict:
    """Regress current-holdings portfolio returns on a benchmark.

    Both arguments are DATED daily log-return series (`pd.Series`). They are
    joined on the date — a bare array cannot be, and pairing by row position is
    what made a crypto account (365 bars/yr) regress against SPY (251 bars/yr)
    over a different eight months and report a negative beta.
    """
    empty = {
        "beta": None, "alpha_annual_pct": None, "r_squared": None, "n_days": 0,
        "port_return_annual_pct": None, "bench_return_annual_pct": None,
        "alpha_t_stat": None, "alpha_significant": None,
        "excess_vs_benchmark_annual_pct": None,
    }
    if port_returns is None or bench_returns is None:
        return empty
    if not isinstance(port_returns, pd.Series) or not isinstance(bench_returns, pd.Series):
        return empty
    joined = pd.concat(
        [port_returns.rename("y"), bench_returns.rename("x")], axis=1, join="inner"
    ).dropna()
    n = len(joined)
    if n < _min_regression_days(lookback):
        return {**empty, "n_days": int(n)}
    y = joined["y"].to_numpy(dtype=float)
    x = joined["x"].to_numpy(dtype=float)
    rf_daily = rf_annual / 252.0
    ye, xe = y - rf_daily, x - rf_daily      # excess returns
    var_x = float(xe.var())
    if var_x <= 0:
        return {**empty, "n_days": int(n)}
    beta = float(np.cov(ye, xe, bias=True)[0, 1] / var_x)
    alpha_daily = float(ye.mean() - beta * xe.mean())
    corr = float(np.corrcoef(y, x)[0, 1])

    # Annualize BOTH sides geometrically, then take alpha as the difference of
    # annual figures. Reporting alpha as `alpha_daily * 252` (arithmetic, in log
    # units) next to a geometric return column put two different units under the
    # same "%" sign: it read +52.6% where the actual excess over the CAPM
    # expectation was +94.4%.
    port_annual = float(np.expm1(y.mean() * 252))
    bench_annual = float(np.expm1(x.mean() * 252))
    expected_annual = rf_annual + beta * (bench_annual - rf_annual)
    alpha_annual = port_annual - expected_annual

    # Is the alpha distinguishable from luck? A concentrated book can post a
    # huge alpha whose standard error is wider than the alpha itself — Dime's
    # +94% carried a 95% CI of [-4%, +109%], i.e. zero is inside it.
    resid = ye - (alpha_daily + beta * xe)
    se_daily = float(resid.std(ddof=2)) / np.sqrt(n) if n > 2 else float("inf")
    t_stat = alpha_daily / se_daily if se_daily > 0 else 0.0

    return {
        "beta": round(beta, 3),
        "alpha_annual_pct": round(alpha_annual * 100, 2),
        # Raw lead over the index, before any risk adjustment — the "did I beat
        # the index" question, which is not the same as beating CAPM.
        "excess_vs_benchmark_annual_pct": round((port_annual - bench_annual) * 100, 2),
        "alpha_t_stat": round(float(t_stat), 2),
        "alpha_significant": bool(abs(t_stat) >= 2.0),
        "r_squared": round(corr * corr, 3),
        "n_days": int(n),
        # Geometric (compounded) annualization from daily log-returns → simple % that
        # matches realized reality: exp(mean_log * 252) - 1. Arithmetic mean*252 understated it.
        "port_return_annual_pct": round(port_annual * 100, 2),
        "bench_return_annual_pct": round(bench_annual * 100, 2),
        "expected_return_annual_pct": round(expected_annual * 100, 2),
    }


# ── Risk-free rate ───────────────────────────────────────────────────────────
# The rf in a CAPM regression has to be quoted in the SAME currency as the
# returns being regressed, and at the SAME horizon as the return interval.
#
#   * Currency: these returns are translated to `base_currency`, so a THB report
#     needs a THB risk-free rate. Plugging a US Treasury yield into a THB series
#     silently books the whole THB–USD rate differential (≈2.5pp today) as
#     negative alpha.
#   * Horizon: the regression is on DAILY excess returns, so the right rate is a
#     short one (policy / 3-month bill), not a 10-year bond yield. The 10y term
#     premium is compensation for duration nobody in this book is holding.
#
# Damodaran's country-premium table is NOT this number: it publishes equity risk
# PREMIUMS and country default spreads for forward-looking cost-of-equity work.
# It also states an rf only as an input convention, twice a year. Realized-alpha
# regression wants today's actual short rate — hence live FRED / BOT below.

def _rf_from_fred() -> Optional[dict]:
    """US 3-month Treasury, constant maturity. Needs FRED_API_KEY."""
    try:
        from routers.global_yields import _fred_fetch
        rows = _fred_fetch("DGS3MO", limit=10)
    except Exception:
        return None
    if not rows:
        return None
    return {
        "rate": round(float(rows[-1]["value"]) / 100, 6),
        "source": "FRED DGS3MO — US 3-month Treasury (constant maturity)",
        "series": "DGS3MO",
        "as_of": rows[-1]["date"],
    }


def _rf_from_yf_tbill() -> Optional[dict]:
    """13-week T-bill yield via yfinance (`^IRX`) — no API key, so it covers the
    case where FRED_API_KEY is unset or the FRED call fails. Quoted in percent
    already (3.70 = 3.70%). Slightly below DGS3MO because ^IRX is the discount
    rate rather than the bond-equivalent yield; close enough for a hurdle."""
    frame = _fetch_close_frame(["^IRX"], 30)
    if frame.empty or "^IRX" not in frame.columns:
        return None
    series = frame["^IRX"].dropna()
    if series.empty:
        return None
    return {
        "rate": round(float(series.iloc[-1]) / 100, 6),
        "source": "^IRX (yfinance) — US 13-week T-bill yield",
        "series": "^IRX",
        "as_of": str(series.index[-1].date()),
    }


_rf_cache: TTLCache = TTLCache(ttl=43200, maxsize=8)   # 12h — these move slowly

RF_FALLBACK: dict[str, float] = {"THB": 0.0175, "USD": 0.0425}


def _risk_free(base_currency: str) -> dict:
    """Live short-term risk-free rate for the report currency, with provenance.

    Returns {rate (decimal), source, series, as_of, currency}. Every field is
    echoed to the UI: a rate whose origin is not shown is a rate nobody can
    check.
    """
    ccy = report_currency(base_currency)
    cached = _rf_cache.get(f"rf:{ccy}")
    if cached is not None:
        return cached

    out: Optional[dict] = None
    if ccy == "USD":
        for probe in (_rf_from_fred, _rf_from_yf_tbill):
            out = probe()
            if out:
                break
    elif ccy == "THB":
        try:
            from routers.bot import get_policy_rate
            pol = get_policy_rate() or {}
            rate = pol.get("rate")
            if rate is not None:
                out = {
                    "rate": round(float(rate) / 100, 6),
                    "source": "BOT policy rate (1-day repurchase)",
                    "series": "BOT/PolicyRate",
                    "as_of": pol.get("effective_datetime") or pol.get("announcement_date"),
                }
        except Exception:
            out = None

    if out is None:
        out = {
            "rate": RF_FALLBACK.get(ccy, 0.02),
            "source": f"fallback constant (live {ccy} rate unavailable)",
            "series": None,
            "as_of": None,
        }
    out["currency"] = ccy
    _rf_cache.set(f"rf:{ccy}", out)
    return out


@router.get("/risk-free")
def get_risk_free(base_currency: Optional[str] = Query(None)):
    """Live short-term risk-free rates, with provenance.

    Returns every supported currency, not just the requested one, so the UI can
    show what it is NOT using — a rate the user cannot compare is a rate they
    cannot sanity-check.
    """
    rates = {ccy: _risk_free(ccy) for ccy in ("THB", "USD")}
    # Every source that answered, not just the one that won the race — a rate
    # the user cannot compare against an alternative is a rate they cannot
    # sanity-check.
    alternatives = [r for r in (_rf_from_fred(), _rf_from_yf_tbill()) if r]
    for a in alternatives:
        a["currency"] = "USD"
    return {
        "rates": rates,
        "alternatives": alternatives,
        "active": report_currency(base_currency) if base_currency else None,
        "fallback": RF_FALLBACK,
    }


def _benchmark_currency(symbol: str) -> str:
    """Quote currency of an index/ETF ticker. Suffix-driven, like the rest of
    the symbol handling here — no extra network call for a single field."""
    sym = (symbol or "").upper()
    if sym.endswith(".BK"):
        return "THB"
    if sym.endswith(".T"):
        return "JPY"
    if sym.endswith((".L",)):
        return "GBP"
    if sym.endswith((".HK",)):
        return "HKD"
    return "USD"


def _portfolio_return_series(
    positions: list[dict],
    lookback: int,
    base_currency: str,
    fx_adjust: bool,
    calendar: Optional["pd.DatetimeIndex"] = None,
) -> tuple[Optional["pd.Series"], list[dict], float]:
    """Weighted daily log-return series for a set of open positions.

    Deliberately light: CAPM needs the return series only, so this skips the
    VaR/Monte-Carlo/bootstrap machinery in `_compute_portfolio_risk` (which
    would otherwise run once per account on every page load).

    Returns `(series, excluded, covered_weight_pct)`.
    """
    value_map: dict[str, float] = {}
    ccy_map: dict[str, str] = {}
    for pos in positions:
        yf_sym = _position_yf_symbol(pos)
        if not yf_sym:
            continue
        price = pos.get("current_price") or pos.get("price_entry", 0)
        val = convert_amount(
            float(price or 0) * float(pos.get("volume", 0) or 0),
            trade_currency(pos), report_currency(base_currency),
        )
        if val > 0:
            value_map[yf_sym] = value_map.get(yf_sym, 0.0) + val
            ccy_map.setdefault(yf_sym, trade_currency(pos))
    if not value_map:
        return None, [], 0.0

    total = sum(value_map.values())
    symbols = list(value_map)
    returns_df, excluded = _aligned_returns(
        symbols, lookback, calendar=calendar,
        ccy_map=ccy_map if fx_adjust else None,
        base_currency=base_currency if fx_adjust else None,
    )
    if returns_df.empty:
        return None, excluded, 0.0

    valid = list(returns_df.columns)
    w = np.array([value_map[s] for s in valid])
    covered = float(w.sum() / total * 100)
    w = w / w.sum()
    excluded = [
        {**e, "weight_pct": round(100 * value_map.get(e["symbol"], 0.0) / total, 2)}
        for e in excluded
    ]
    return pd.Series(returns_df.values @ w, index=returns_df.index), excluded, covered


def _index_return(symbol: str, since: Optional[str], base_currency: str) -> Optional[dict]:
    """Benchmark total return from `since` to today, in `base_currency`.

    The portfolio return this is compared against covers a specific span, so the
    index has to cover the SAME span — an index number from a different window
    is not a comparison, it is two unrelated facts subtracted.
    """
    if not since:
        return None
    frame = _fetch_close_frame([symbol], 900)
    if frame.empty or symbol not in frame.columns:
        return None
    px = frame[symbol].dropna()
    if len(px) < 2:
        return None
    base = report_currency(base_currency)
    ccy = _benchmark_currency(symbol)
    if ccy != base:
        fx = _fx_close(ccy, base, 900)
        if fx is not None:
            px = (px * fx.reindex(px.index).ffill().bfill()).dropna()
    try:
        window = px[px.index >= pd.to_datetime(since)]
    except Exception:
        return None
    if len(window) < 2:
        return None
    days = max((window.index[-1] - window.index[0]).days, 1)
    cum = float(window.iloc[-1] / window.iloc[0] - 1)
    return {
        "cumulative_pct": round(cum * 100, 2),
        "annual_pct": round(((1 + cum) ** (365 / days) - 1) * 100, 2),
        "from": str(window.index[0].date()),
        "to": str(window.index[-1].date()),
        "days": days,
    }


@router.get("/capm")
def get_capm(
    account_id: Optional[str] = Query(None),
    lookback: int = Query(252),
    benchmark: str = Query("SPY"),
    rf_annual: Optional[float] = Query(
        None, description="Override the risk-free rate (decimal). Omit to use the live "
                          "short rate for base_currency."
    ),
    base_currency: str = Query("THB"),
):
    """CAPM beta + Jensen's alpha for the open portfolio, regressed on `benchmark`.

    Alpha is the plain CAPM identity on numbers that can be checked by hand:

        alpha = Rp - [rf + beta x (Rm - rf)]

    `Rp` comes from the RETURNS card (cost-based CAGR / XIRR over the account's
    own holding span), `Rm` is the benchmark over that SAME span, and `beta` is
    the book held today. None of the three needs the trade log's DATES — which
    matters, because 20 of 79 lots carry a bulk-import placeholder date whose
    recorded price is up to 487% away from the market on that day. The previous
    version rebuilt daily weights from those dates and reported +96% alpha for
    an account that actually returned 3.3%/yr.
    """
    where_open = ["win_loss = 'P'"]
    params: list = []
    if account_id and account_id != "all":
        where_open.append("account_id = ?")
        params.append(account_id)

    with get_db() as conn:
        rows = conn.execute(
            "SELECT t.*, a.currency acc_currency, a.name acc_name "
            "FROM trades t JOIN portfolio_accounts a ON t.account_id = a.id "
            f"WHERE {' AND '.join(where_open)} ORDER BY t.date_entry DESC",
            params,
        ).fetchall()
    positions = [dict(r) for r in rows]

    # Realized return comes from the RETURNS endpoint (cost-based CAGR/XIRR over
    # each account's own span) rather than being rebuilt here.
    from routers.portfolio_v2 import get_portfolio_returns
    try:
        returns = get_portfolio_returns(account_id, base_currency)
    except Exception:
        returns = {}

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

    base = report_currency(base_currency)
    bench_ccy = _benchmark_currency(benchmark)

    # rf must be in the report currency — see _risk_free().
    if rf_annual is None:
        rf_info = _risk_free(base)
        rf_annual = float(rf_info["rate"])
    else:
        rf_info = {
            "rate": float(rf_annual), "source": "manual override",
            "series": None, "as_of": None, "currency": base,
        }

    # The benchmark's own trading days ARE the regression calendar: every
    # holding is reindexed onto it, so a Thai holiday reads as a flat day for
    # that holding instead of shifting its entire history by a row.
    bench_close = _fetch_close_frame([benchmark], lookback)
    bench_local = bench_dated = None
    bench_last_date = None
    if not bench_close.empty and benchmark in bench_close.columns:
        series = bench_close[benchmark].dropna()
        if len(series) >= 20:
            bench_last_date = str(series.index[-1].date())
            bench_local = np.log(series / series.shift(1)).dropna()
            if bench_ccy == base:
                bench_dated = bench_local
            else:
                fx = _fx_close(bench_ccy, base, lookback)
                if fx is None:
                    bench_dated = bench_local
                else:
                    fx_ret = np.log(fx.reindex(bench_local.index).ffill()).diff()
                    bench_dated = (bench_local + fx_ret).dropna()

    calendar = bench_local.index if bench_local is not None else None

    def _capm_for(pos_list: list[dict], ret: Optional[dict]) -> dict:
        # Beta of the book held today. Needs prices only — no trade dates.
        port_base, excluded, covered = _portfolio_return_series(
            pos_list, lookback, base, fx_adjust=True, calendar=calendar
        )
        row = _regress_capm(port_base, bench_dated, rf_annual, lookback)
        port_local, _, _ = _portfolio_return_series(
            pos_list, lookback, base, fx_adjust=False, calendar=calendar
        )
        local = _regress_capm(port_local, bench_local, rf_annual, lookback)

        # What a hedge needs: beta x market value = the index notional to short.
        market_value = sum(
            convert_amount(
                float(p.get("current_price") or p.get("price_entry") or 0)
                * float(p.get("volume") or 0),
                trade_currency(p), base,
            )
            for p in pos_list
        )
        beta = row.get("beta")
        hedge_notional = round(market_value * beta, 2) if beta is not None else None

        # ── The alpha ────────────────────────────────────────────────────────
        idx = _index_return(benchmark, (ret or {}).get("first_date"), base)
        # XIRR, not CAGR: `/returns` divides by the SUM OF EVERY BUY, so an
        # account that recycles capital is measured against a denominator it
        # never had. Dime bought 4.70M worth over time on 763k of contributed
        # capital — its CAGR is diluted 6.2x (3.3% where XIRR says 13.1%).
        # XIRR discounts the actual dated cashflows, so returned capital does
        # not double-count.
        rp_xirr = (ret or {}).get("xirr_pct")
        rp_cagr = (ret or {}).get("cagr_pct")
        expected = alpha_xirr = alpha_cagr = None
        if idx and beta is not None:
            rf_pct = rf_annual * 100
            expected = round(rf_pct + beta * (idx["annual_pct"] - rf_pct), 2)
            if rp_xirr is not None:
                alpha_xirr = round(rp_xirr - expected, 2)
            if rp_cagr is not None:
                alpha_cagr = round(rp_cagr - expected, 2)

        return {
            **row,
            "market_value": round(market_value, 2),
            "hedge_notional": hedge_notional,
            "beta_local": local["beta"],
            # Performance side — cost-based, from the RETURNS card.
            "return_annual_pct": rp_xirr,          # headline: money-weighted
            "return_cagr_pct": rp_cagr,            # cost-based, turnover-diluted
            "invested_gross": (ret or {}).get("invested"),
            "holding_days": (ret or {}).get("holding_days"),
            "first_date": (ret or {}).get("first_date"),
            "index_annual_pct": (idx or {}).get("annual_pct"),
            "index_cumulative_pct": (idx or {}).get("cumulative_pct"),
            "expected_annual_pct": expected,
            "alpha_annual_pct": alpha_xirr,
            "alpha_cagr_annual_pct": alpha_cagr,
            "excess_vs_index_pct": (
                round(rp_xirr - idx["annual_pct"], 2)
                if idx and rp_xirr is not None else None
            ),
            "excluded_symbols": excluded,
            "covered_weight_pct": round(covered, 2),
            # R² this low means the benchmark is not the market this book trades
            # in — beta is then a number without a meaning, and so is the alpha
            # built on top of it.
            "benchmark_fit": (
                "WEAK" if (row.get("r_squared") or 0) < 0.10
                else "MODERATE" if (row.get("r_squared") or 0) < 0.30
                else "OK"
            ),
        }

    result: dict = {
        "benchmark": benchmark,
        "benchmark_currency": bench_ccy,
        "benchmark_last_date": bench_last_date,
        "base_currency": base,
        "lookback": lookback,
        "min_days_required": _min_regression_days(lookback),
        "min_history_days": MIN_HISTORY_DAYS,
        "rf_annual": rf_annual,
        "rf_source": rf_info["source"],
        "rf_series": rf_info["series"],
        "rf_as_of": rf_info["as_of"],
        "rf_currency": rf_info["currency"],
        "benchmark_available": bench_dated is not None,
        "portfolio": _capm_for(positions, (returns or {}).get("total")),
    }

    if not account_id or account_id == "all":
        groups: dict[str, list[dict]] = {}
        for pos in positions:
            groups.setdefault(pos["account_id"], []).append(pos)
        per_acc = (returns or {}).get("accounts") or {}
        result["accounts"] = {
            aid: {**_capm_for(g, per_acc.get(aid)), "name": g[0].get("acc_name") or aid}
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

    # Current prices: weights are MARKET value. Cost (price_entry) weights froze
    # each holding at its entry size, so a winner that doubled looked unchanged
    # and the ERC trades were sized off the wrong book (fixed 2026-10-02).
    try:
        from routers.portfolio_v2 import _batch_fetch_prices
        price_map = _batch_fetch_prices(
            sorted({y for y in (_position_yf_symbol(p) for p in positions) if y}))
    except Exception:
        price_map = {}

    def _px(yf_sym: str) -> Optional[float]:
        snap = price_map.get(yf_sym)
        v = snap.get("price") if isinstance(snap, dict) else snap
        return float(v) if v else None

    # Aggregate values by yf_symbol — fixes bug where duplicate positions were ignored
    sym_value_map: dict[str, float] = {}
    sym_name_map: dict[str, str] = {}
    sym_currency_map: dict[str, str] = {}
    for pos in positions:
        yf_sym = _position_yf_symbol(pos)
        if yf_sym:
            native_val = (_px(yf_sym) or float(pos["price_entry"])) * float(pos["volume"])
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

    # Date-aligned covariance — same reason as the risk path: pairing two
    # markets' returns by row position mixes different dates, and one short
    # history must not truncate every other holding's.
    returns_df, _ = _aligned_returns(symbols, lookback)
    valid_syms = list(returns_df.columns) if not returns_df.empty else []
    valid_idx = [i for i, s in enumerate(symbols) if s in valid_syms]
    if len(valid_idx) < 2:
        return {"current_weights": [], "optimal_weights": [], "rebalance_actions": []}

    valid_syms = [symbols[i] for i in valid_idx]
    R = returns_df[valid_syms].values

    cov = _ledoit_wolf_shrinkage(R)
    optimal_w = _risk_parity_weights(cov)

    current_valid = np.array([current_w[i] for i in valid_idx])
    current_valid = current_valid / current_valid.sum()

    # Rebalance actions
    actions = []
    for i, idx in enumerate(valid_idx):
        drift = float(optimal_w[i] - current_valid[i])
        if abs(drift) > 0.03:  # >3% drift
            action = "BUY" if drift > 0 else "TRIM"
            trade_val = drift * total
            yf_sym = valid_syms[i]
            cur_price = _px(yf_sym)
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


_balance_cache: TTLCache = TTLCache(ttl=300, maxsize=64)


BALANCE_LEVELS = ("symbol", "sector", "thesis", "account")


@router.get("/balance")
def get_risk_balance(
    account_id: Optional[str] = Query(None),
    cash: Optional[float] = Query(None, ge=0, description="New money for the add-only plan, base "
                                  "currency; omitted = whatever the full plan takes"),
    lookback: int = Query(252),
    base_currency: str = Query("THB"),
    level: str = Query("symbol", description="What the targets are set on: symbol | sector | thesis | account"),
    target: Literal["auto", "equal"] = Query(
        "auto", description="auto = the user's saved targets at `level` when any is set; "
                            "equal = every holding / group the same share regardless"),
):
    """What to trade so that every part of the book carries its TARGET share of the risk.

    `level` says what a "part" is — a holding, a sector, a thesis, or an account
    (the book as its sub-portfolios; all-accounts view only). The targets are
    the user's, saved by PUT /risk/budget with scope = level (the symbol /
    sector / thesis sets are the ones the BUDGET page shows). A part without a
    target takes an equal piece of what is left of 100%; a group's share is
    split equally among its holdings. With no target at all, or `target=equal`,
    every part gets the same share.

    Two plans from one covariance (backend/risk_balance.py):
      `rebalance` — sell + buy, money in the book unchanged, lands on the targets;
      `add`       — buy only. `cash_to_balance` is the new money that lands on
                    them; a smaller `cash` scales the same buys down.
    At level=account a symbol held in two accounts is two rows — the trade says
    in which account. Stock positions only (no options, no cash).
    """
    import risk_balance
    from fastapi import HTTPException

    if level not in BALANCE_LEVELS:
        raise HTTPException(status_code=400, detail=f"level must be one of {BALANCE_LEVELS}")
    base = report_currency(base_currency)
    scope = account_id if account_id and account_id != "all" else None
    budget = _risk_budget_saved(scope)
    saved = budget.of(level)
    key = (f"{scope or 'all'}:{base}:{lookback}:{cash}:{_mc_book_stamp(scope)}:{level}:{target}:"
           f"{json.dumps(saved, sort_keys=True)}")
    hit = _balance_cache.get(key)
    if hit is not None:
        return hit

    # One unit per holding — per (account, holding) when the targets are per account.
    per_account = level == "account"
    value: dict[tuple, float] = {}
    label: dict[str, str] = {}
    ccy: dict[str, str] = {}
    price: dict[str, float] = {}
    sector: dict[str, str] = {}
    acc_name: dict[str, str] = {}
    lots: dict[str, list[tuple[str, str, float]]] = {}
    for pos in _open_positions_priced(scope):
        sym = _position_yf_symbol(pos)
        px = pos.get("current_price") or pos.get("price_entry")
        if not sym or not px:
            continue
        v = convert_amount(float(px) * float(pos.get("volume", 0)), trade_currency(pos), base)
        if not v or v <= 0:
            continue
        acct = str(pos["account_id"])
        unit = (acct, sym) if per_account else ("", sym)
        value[unit] = value.get(unit, 0.0) + v
        label[sym] = pos["symbol"]
        ccy.setdefault(sym, trade_currency(pos))
        price[sym] = float(px)
        acc_name.setdefault(acct, str(pos.get("acc_name") or acct))
        if str(pos.get("sector") or "").strip():
            sector.setdefault(sym, str(pos["sector"]).strip())
        lots.setdefault(sym, []).append((str(pos.get("id") or ""), str(pos["symbol"]), v))
    empty = {"rows": [], "base_currency": base, "level": level,
             "note": "need at least 2 holdings with price history"}
    held = list(dict.fromkeys(u[1] for u in value))
    if len(value) < 2:
        return empty

    returns_df, excluded = _aligned_returns(held, lookback, ccy_map=ccy, base_currency=base)
    ok = set(returns_df.columns) if not returns_df.empty else set()
    units = [u for u in value if u[1] in ok]
    if len(units) < 2:
        return empty
    # Two units of one symbol share its return series: perfectly correlated, as they are.
    cov = _ledoit_wolf_shrinkage(returns_df[[u[1] for u in units]].values)
    v0 = np.array([value[u] for u in units])
    total = float(v0.sum())

    # ── which group each unit belongs to, and what the group is called ──
    if level == "symbol":
        group = [u[1] for u in units]
        g_label = {u[1]: label[u[1]] for u in units}
    elif level == "sector":
        group = [sector.get(u[1]) or "Other" for u in units]
        g_label = {g: g for g in group}
    elif level == "thesis":
        theses = _budget_theses({"symbols": [u[1] for u in units], "lots": lots, "name": label})
        group = [theses[u[1]][0] for u in units]
        g_label = {theses[u[1]][0]: theses[u[1]][1] for u in units}
    else:
        group = [u[0] for u in units]
        g_label = {u[0]: acc_name.get(u[0], u[0]) for u in units}
    if level == "account" and len(set(group)) < 2:
        return {**empty, "note": "targets per account need the all-accounts view with at least 2 accounts"}

    shares, g_share, g_source = risk_balance.group_target_shares(group, saved if target != "equal" else {})
    target_w = risk_balance.erc_weights(cov, shares)
    g_keys = list(g_share)

    def plan(delta: np.ndarray) -> dict:
        v1 = v0 + delta
        sh0, sh1 = risk_balance.risk_shares(v0, cov), risk_balance.risk_shares(v1, cov)
        rows = []
        for i, u in enumerate(units):
            s_ = u[1]
            px_base = convert_amount(price[s_], ccy[s_], base) or 0.0
            rows.append({
                "key": f"{u[0]}|{s_}", "symbol": label[s_], "yf_symbol": s_, "currency": ccy[s_],
                "account_id": u[0] or None, "account": acc_name.get(u[0]) if u[0] else None,
                "group": group[i], "group_label": g_label[group[i]],
                "price": round(price[s_], 4),
                "weight_now_pct": round(float(v0[i] / total) * 100, 2),
                "weight_after_pct": round(float(v1[i] / v1.sum()) * 100, 2),
                "risk_now_pct": round(float(sh0[i]) * 100, 2),
                "risk_after_pct": round(float(sh1[i]) * 100, 2),
                "target_risk_pct": round(float(shares[i]) * 100, 2),
                "target_source": g_source[group[i]],
                "trade_value": round(float(delta[i]), 2),
                "shares": round(float(delta[i]) / px_base, 4) if px_base > 0 else None,
            })
        rows.sort(key=lambda r: -r["risk_now_pct"])
        groups = []
        for g in g_keys:
            idx = [i for i, x in enumerate(group) if x == g]
            groups.append({
                "key": g, "label": g_label[g], "n": len(idx),
                "target_pct": round(g_share[g] * 100, 2), "source": g_source[g],
                "budget_pct": saved.get(g),
                "weight_now_pct": round(float(v0[idx].sum() / total) * 100, 2),
                "weight_after_pct": round(float(v1[idx].sum() / v1.sum()) * 100, 2),
                "risk_now_pct": round(float(sh0[idx].sum()) * 100, 2),
                "risk_after_pct": round(float(sh1[idx].sum()) * 100, 2),
                "trade_value": round(float(delta[idx].sum()), 2),
            })
        groups.sort(key=lambda r: -r["risk_now_pct"])
        top2 = sorted(range(len(groups)), key=lambda i: -groups[i]["risk_now_pct"])[:2]
        return {
            "rows": rows, "groups": groups,
            "buy_value": round(float(delta[delta > 0].sum()), 2),
            "sell_value": round(float(-delta[delta < 0].sum()), 2),
            "vol_now_pct": round(risk_balance.book_vol_annual(v0, cov) * 100, 2),
            "vol_after_pct": round(risk_balance.book_vol_annual(v1, cov) * 100, 2),
            "top2": [groups[i]["label"] for i in top2],
            "top2_risk_now_pct": round(sum(groups[i]["risk_now_pct"] for i in top2), 1),
            "top2_risk_after_pct": round(sum(groups[i]["risk_after_pct"] for i in top2), 1),
            "max_risk_after_pct": round(float(sh1.max()) * 100, 1),
        }

    full = risk_balance.add_to_balance(v0, target_w)
    need = float(full.sum())
    frac = 1.0 if cash is None or need <= 0 else min(1.0, cash / need)
    out = {
        "base_currency": base, "account_id": scope or "all", "lookback_days": int(len(returns_df)),
        "level": level, "invested_value": round(total, 2),
        "equal_share_pct": round(100 / len(g_keys), 2), "n_groups": len(g_keys),
        "target_mode": "budget" if "budget" in g_source.values() else "equal",
        "budgets": {k: v for k, v in saved.items() if k in g_share},
        "budgets_all": dict(saved),
        "budget_total_pct": round(sum(v for k, v in saved.items() if k in g_share), 2),
        "rebalance": plan(risk_balance.rebalance(v0, target_w)),
        "add": {**plan(full * frac), "cash": round(float(full.sum() * frac), 2),
                "cash_to_balance": round(need, 2), "fraction_pct": round(frac * 100, 1)},
        "excluded": [{"symbol": label.get(e["symbol"], e["symbol"])} for e in excluded if e["symbol"] in held],
    }
    _balance_cache.set(key, out)
    return out


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


# ── Trade guard (fast-turnover rules) ────────────────────────────────────────
#
# Rules live in backend/trade_guard.py (pure). This section only does I/O:
# open lots, live prices, ATR history, cash, real-NAV drawdown, overrides.

_guard_cache: TTLCache = TTLCache(ttl=900, maxsize=32)


def _guard_lots(account_id: Optional[str], open_only: bool) -> tuple[list[dict], list[dict]]:
    """Trade rows (open or closed) with `yf_symbol` + `currency` resolved."""
    where, params = ["t.win_loss = 'P'" if open_only else "t.win_loss != 'P'"], []
    if not open_only:
        where.append("t.price_exit > 0")
    if account_id and account_id != "all":
        where.append("t.account_id = ?")
        params.append(account_id)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT t.*, a.currency acc_currency FROM trades t "
            "JOIN portfolio_accounts a ON t.account_id = a.id "
            f"WHERE {' AND '.join(where)}",
            params,
        ).fetchall()
    lots, skipped = [], []
    for r in rows:
        lot = dict(r)
        yf_sym = _position_yf_symbol(lot)
        if not yf_sym:
            skipped.append({"symbol": lot.get("symbol"), "reason": "no market symbol (option?)"})
            continue
        lot["yf_symbol"] = yf_sym
        lot["currency"] = trade_currency(lot)
        lots.append(lot)
    return lots, skipped


def _guard_atr(asof_by_symbol: dict[str, Optional[str]], timeout: float = 15) -> tuple[dict, list[str]]:
    """ATR fraction per symbol at the given date (None = latest bar)."""
    import trade_guard
    from market_requests import collect
    from market_snapshots import history_future

    symbols = sorted(asof_by_symbol)
    if not symbols:
        return {}, []
    frames, statuses = collect(
        {s: history_future(s, "2y", "1d", ttl=900) for s in symbols}, timeout=timeout
    )
    atr = {s: trade_guard.atr_pct_asof(frames.get(s), asof_by_symbol[s]) for s in symbols}
    pending = sorted(s for s in symbols if atr.get(s) is None
                     and statuses.get(s, {}).get("status") != "ready")
    return atr, pending


def _guard_overrides(account_id: Optional[str], active_only: bool = True) -> list[dict]:
    q = "SELECT * FROM guard_overrides"
    clauses, params = [], []
    if active_only:
        clauses.append("cleared_at IS NULL")
    if account_id and account_id != "all":
        clauses.append("account_id = ?")
        params.append(account_id)
    if clauses:
        q += " WHERE " + " AND ".join(clauses)
    with get_db() as conn:
        rows = [dict(r) for r in conn.execute(q + " ORDER BY created_at", params).fetchall()]
    for r in rows:
        try:
            r["codes"] = json.loads(r.get("codes") or "[]")
        except ValueError:
            r["codes"] = []
    return rows


def _guard_cash(account_id: Optional[str], base: str, summ: Optional[dict] = None) -> Optional[float]:
    """Cash in `base` from the same summary the header shows (None = unknown)."""
    if summ is None:
        try:
            from routers.portfolio_v2 import get_summary
            summ = get_summary(base_currency=base)
        except Exception:
            return None
    if not account_id or account_id == "all":
        v = summ.get("total_cash_base")
        return float(v) if v is not None else None
    for a in summ.get("accounts") or []:
        acct = a.get("account")
        acct_id = acct.get("id") if isinstance(acct, dict) else (acct or a.get("id") or a.get("account_id"))
        if str(acct_id or "") == account_id:
            v = a.get("cash_base")
            return float(v) if v is not None else None
    return None


def _guard_nav_drawdown(account_id: Optional[str], base: str) -> Optional[float]:
    """Current drawdown of the REAL time-weighted NAV index from its 1y peak, %.

    Not /risk/metrics' drawdown — that one replays today's basket backwards.
    """
    key = f"navdd:{account_id or 'all'}:{base}"
    hit = _guard_cache.get(key)
    if hit is not None:
        return hit.get("v")
    value = None
    failed = False
    try:
        from routers.portfolio_v2 import get_nav_index
        d = get_nav_index(account_id=account_id if account_id != "all" else None,
                          days=365, benchmark="SPY", base_currency=base)
        idx = [float(p["port_index"]) for p in d.get("points") or []
               if p.get("port_index") is not None]
        if len(idx) >= 2:
            value = (idx[-1] / max(idx) - 1) * 100
    except Exception:
        logger.warning("guard: NAV drawdown failed for %s", account_id or "all", exc_info=True)
        value, failed = None, True
    if not failed:  # a failure retries next call instead of sticking for 15 min
        _guard_cache.set(key, {"v": value})
    return value


def _guard_snapshot(account_id: Optional[str], base_currency: str) -> dict:
    """Full guard evaluation — shared by the endpoint, sizing and the notifier."""
    import trade_guard
    from routers.portfolio_v2 import _batch_fetch_prices

    base = report_currency(base_currency)
    lots, skipped = _guard_lots(account_id, open_only=True)
    positions = trade_guard.aggregate_lots(lots)
    atr, pending = _guard_atr({p["yf_symbol"]: p["first_entry"] for p in positions})

    symbols = sorted({p["yf_symbol"] for p in positions})
    prices = _batch_fetch_prices(symbols) if symbols else {}
    fx_cache: dict[str, float] = {}
    for p in positions:
        snap = prices.get(p["yf_symbol"])
        snap = snap if isinstance(snap, dict) else {"price": snap}
        p["price"] = snap.get("price")
        p["prev_close"] = snap.get("prev_close")
        ccy = p.get("currency") or base
        if ccy not in fx_cache:
            fx_cache[ccy] = convert_amount(1.0, ccy, base) or 1.0
        p["fx"] = fx_cache[ccy]

    overrides = {
        trade_guard.override_key(o["account_id"], o["yf_symbol"], o["first_entry"]): o
        for o in _guard_overrides(account_id)
    }
    closed, _ = _guard_lots(account_id, open_only=False)
    nav_dd = _guard_nav_drawdown(account_id, base)
    out = trade_guard.evaluate(
        positions, atr,
        overrides=overrides,
        nav_drawdown_pct=nav_dd,
        streak=trade_guard.loss_streak(closed),
        cash_value=_guard_cash(account_id, base),
        # Holdings but no drawdown = unknown, which sizes as half (fail closed).
        nav_drawdown_unknown=nav_dd is None and bool(positions),
    )
    out["skipped"] = skipped + out["skipped"]
    out["base_currency"] = base
    out["atr_pending"] = pending
    import guard_scheduler
    out["scan"] = guard_scheduler.status()
    return out


@router.get("/guard")
def get_trade_guard(
    account_id: Optional[str] = Query(None),
    base_currency: str = Query("THB"),
):
    """Traffic light + per-position stops for a fast-turnover book.

    Every open long gets a stop without the user entering one (manual
    `price_stoploss` wins; else 2×ATR14 at the entry date, clamped 5–12%).
    Book-level: day loss, real-NAV drawdown (−5% half size, −10% stop) and a
    losing streak. History frames still loading leave that symbol on the 8%
    default stop — `atr_pending` names them.
    """
    return _guard_snapshot(account_id, base_currency)


class GuardOverrideIn(BaseModel):
    account_id: str
    yf_symbol: str
    first_entry: str
    symbol: Optional[str] = None
    codes: list[str]
    reason: str = ""
    # When the hold ends by itself. Omitted → HOLD_REVIEW_DAYS / stop − 1R.
    review_days: Optional[int] = None
    floor_price: Optional[float] = None


@router.post("/guard/override")
def create_guard_override(body: GuardOverrideIn):
    """Record "hold anyway" for one holding period. The flag stays on the row;
    the action drops to INFO and stops colouring the light — until the review
    date or until price breaks the floor, then it is loud again."""
    import trade_guard

    codes = sorted({c.upper() for c in body.codes if c})
    if not codes:
        return {"ok": False, "error": "codes required"}
    if not body.reason.strip():
        # The UI already insists; the API must too (MCP, scripts).
        return {"ok": False, "error": "reason required"}
    days = body.review_days if body.review_days is not None else trade_guard.HOLD_REVIEW_DAYS
    if not 1 <= days <= 365:
        return {"ok": False, "error": "review_days must be 1–365"}
    if body.floor_price is not None and body.floor_price <= 0:
        return {"ok": False, "error": "floor_price must be > 0"}
    review_on = (date.today() + timedelta(days=days)).isoformat()
    oid = str(uuid.uuid4())
    with get_db() as conn:
        # One live decision per holding: a new HOLD replaces the previous one.
        conn.execute(
            "UPDATE guard_overrides SET cleared_at = datetime('now') "
            "WHERE account_id = ? AND yf_symbol = ? AND first_entry = ? AND cleared_at IS NULL",
            (body.account_id, body.yf_symbol.upper(), body.first_entry[:10]),
        )
        conn.execute(
            "INSERT INTO guard_overrides (id, account_id, yf_symbol, symbol, first_entry, codes, reason, "
            "review_on, floor_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (oid, body.account_id, body.yf_symbol.upper(), body.symbol, body.first_entry[:10],
             json.dumps(codes), body.reason.strip()[:500], review_on, body.floor_price),
        )
        # The same decision in the journal that also holds rebalance and
        # stop-level decisions, so "why did I not sell" is one list.
        import risk_journal
        risk_journal.record(
            conn, kind="STOP", decision="HOLD", reason=body.reason, account_id=body.account_id,
            symbol=body.symbol or body.yf_symbol, yf_symbol=body.yf_symbol,
            snapshot={"codes": codes, "floor_price": body.floor_price, "first_entry": body.first_entry[:10]},
            review_on=review_on, ref_id=oid, source="guard",
        )
        conn.commit()
    return {"ok": True, "id": oid, "codes": codes, "review_on": review_on,
            "floor_price": body.floor_price}


@router.delete("/guard/override/{override_id}")
def delete_guard_override(override_id: str):
    """UNDO a hold (a mis-click), so the report never counts it. A hold that
    was superseded by a newer one keeps its row with `cleared_at` set."""
    with get_db() as conn:
        cur = conn.execute("DELETE FROM guard_overrides WHERE id = ?", (override_id,))
        # An undone mis-click was never a decision: its journal row goes too.
        conn.execute("DELETE FROM risk_decisions WHERE ref_id = ? AND source = 'guard'", (override_id,))
        conn.commit()
    return {"ok": True, "deleted": cur.rowcount}


@router.get("/guard/size")
def get_guard_size(
    symbol: str = Query(..., description="Yahoo symbol, e.g. AOT.BK / AAPL"),
    price: Optional[float] = Query(None, description="Planned entry; default = last price"),
    currency: Optional[str] = Query(None, description="Instrument currency; default inferred"),
    account_id: Optional[str] = Query(None),
    base_currency: str = Query("THB"),
    stop: Optional[float] = Query(None, description="Manual stop, if the user has one"),
    risk: Optional[float] = Query(None, description="Money the user accepts to lose, in base_currency"),
    notional: Optional[float] = Query(None, description="Money the user wants to put in, in base_currency"),
    risk_stop: Optional[float] = Query(None, description="Stop the form holds (auto or typed) — sizes the risk plan's STOP row"),
):
    """S / M / L volumes for a planned entry — pre-trade layer of the guard.

    NAV = invested market value + cash of `account_id` (all accounts if none),
    scaled by the guard's size multiplier (half after −5% NAV drawdown or a
    losing streak, zero after −10%).

    With `risk` the response also carries `risk_plan` (trade_guard.risk_size):
    the volume per stop distance that loses exactly `risk`, buy + sell fees
    included when the account has a fee schedule, and — with `notional` — the
    stop that amount implies. The guard multiplier is NOT applied to it: the
    user named the money; the multiplier is reported beside it instead.
    """
    import trade_guard
    from portfolio_currency import infer_instrument_currency
    from routers.portfolio_v2 import _batch_fetch_prices

    base = report_currency(base_currency)
    sym = symbol.strip().upper()
    snap = _guard_snapshot(account_id, base)
    nav = snap.get("nav_value") or snap.get("invested_value") or 0.0

    px = price
    if not px:
        q = _batch_fetch_prices([sym]).get(sym)
        px = (q.get("price") if isinstance(q, dict) else q) or None
    if not px or px <= 0:
        return {"ok": False, "error": f"no price for {sym}"}
    ccy = normalize_currency(currency) if currency else None
    if not ccy:
        ccy = normalize_currency(infer_instrument_currency(None, sym)) or "USD"
    fx = convert_amount(1.0, ccy, base) or 1.0
    atr, pending = _guard_atr({sym: None}, timeout=10)

    out = trade_guard.size_buckets(
        nav, float(px), fx, atr.get(sym),
        multiplier=snap.get("size_multiplier", 1.0), manual_stop=stop,
        lot=100.0 if sym.endswith(".BK") else 0.0,   # SET board lot
    )
    if risk and risk > 0:
        import broker_fees
        fee_fn = None
        profile = None
        if account_id and account_id != "all":
            with get_db() as conn:
                profile = broker_fees.profile_for(conn, account_id, ccy)
        if profile:
            def fee_fn(side: str, qty: float, price_: float, _p: str = profile) -> float:
                return broker_fees.estimate(_p, side, qty, price_)["total"]
        out["risk_plan"] = {
            **trade_guard.risk_size(
                float(risk), float(px), fx, atr.get(sym), nav_base=nav or None,
                fee_fn=fee_fn, lot=100.0 if sym.endswith(".BK") else 0.0,
                manual_stop=risk_stop or stop, notional_base=notional,
            ),
            "fee_profile": profile,
        }
    return {
        "ok": True, "symbol": sym, "price": float(px), "currency": ccy, "fx": fx,
        "base_currency": base, "nav_value": nav,
        "nav_includes_cash": snap.get("cash_value") is not None,
        "light": snap.get("light"),
        "multiplier_why": snap.get("size_multiplier_why", []),
        "atr_pending": bool(pending),
        **out,
    }


@router.get("/guard/report")
def get_guard_report(account_id: Optional[str] = Query(None)):
    """Closed trades in R-multiples: expectancy, rule breaks, followed vs broke,
    monthly and per-strategy. Cached 15 min (one ATR history per symbol)."""
    import trade_guard

    key = f"report:{account_id or 'all'}"
    hit = _guard_cache.get(key)
    if hit is not None:
        return hit
    closed, skipped = _guard_lots(account_id, open_only=False)
    # ATR measured at each symbol's EARLIEST closed entry is a simplification
    # only when one symbol was traded in very different regimes; per-lot ATR
    # would multiply the history work for a report that is read monthly.
    first: dict[str, str] = {}
    for c in closed:
        d = str(c.get("date_entry") or "")[:10]
        if c["yf_symbol"] not in first or d < first[c["yf_symbol"]]:
            first[c["yf_symbol"]] = d
    atr, pending = _guard_atr(first, timeout=25)
    overridden = {
        trade_guard.override_key(o["account_id"], o["yf_symbol"], o["first_entry"])
        for o in _guard_overrides(account_id, active_only=False)
    }
    # Raw (unadjusted) bars so a replayed stop compares with broker fills; a
    # dividend-adjusted series sits below the prices actually traded.
    from market_requests import collect
    from market_snapshots import history_future
    raw, raw_status = collect(
        {sym: history_future(sym, "2y", "1d", ttl=900, auto_adjust=False) for sym in first},
        timeout=25,
    )
    out = trade_guard.trade_report(closed, atr, overridden, frames=raw)
    out["atr_pending"] = pending
    out["bars_pending"] = sorted(s_ for s_, st in raw_status.items() if st.get("status") == "pending")
    out["skipped"] = skipped
    if not pending and not out["bars_pending"]:
        _guard_cache.set(key, out)
    return out


class GuardApplyStopsIn(BaseModel):
    account_id: Optional[str] = None
    dry_run: bool = True


def _backup_db(tag: str) -> str:
    """Online SQLite backup under backend/backups/ before a bulk write."""
    import sqlite3
    from pathlib import Path

    from db import connect

    dst = Path(__file__).resolve().parent.parent / "backups" / (
        f"portfolio.db.bak-{datetime.now():%Y%m%d-%H%M%S}-{tag}")
    dst.parent.mkdir(exist_ok=True)
    src = connect(readonly=True)
    out = sqlite3.connect(dst)  # db-ok: fresh backup file, not the book
    try:
        src.backup(out)
    finally:
        out.close()
        src.close()
    return str(dst)


@router.post("/guard/apply-stops")
def apply_guard_stops(body: GuardApplyStopsIn):
    """Write the guard's ATR auto stop into `price_stoploss` of every OPEN lot
    that has none, so the stop lives on the trade (TradeEdit, exports, MCP)
    instead of only being recomputed by the guard.

    Only ATR stops are written — an 8% DEFAULT (no price history yet) is a
    placeholder, not a decision. Lots with a stop already are left alone.
    `dry_run` (default) lists what would change; a real run backs the DB up first.
    """
    snap = _guard_snapshot(body.account_id, "THB")
    plan, skipped = [], []
    lots, _ = _guard_lots(body.account_id, open_only=True)
    for r in snap.get("positions", []):
        if r.get("stop_source") != "ATR":
            if r.get("stop_source") == "DEFAULT":
                skipped.append({"symbol": r["symbol"], "reason": "no ATR history (8% default)"})
            continue
        ids = [l["id"] for l in lots
               if l["account_id"] == r["account_id"] and l["yf_symbol"] == r["yf_symbol"]
               and not float(l.get("price_stoploss") or 0) > 0]
        if ids:
            plan.append({"symbol": r["symbol"], "account_id": r["account_id"],
                         "stop": round(float(r["stop"]), 4), "stop_distance_pct": r["stop_distance_pct"],
                         "price": r["price"], "below_stop": "STOP_HIT" in r.get("flags", []),
                         "lot_ids": ids})
    if body.dry_run or not plan:
        return {"dry_run": True, "plan": plan, "skipped": skipped,
                "lots": sum(len(p["lot_ids"]) for p in plan)}

    backup = _backup_db("pre-guard-stops")
    n = 0
    with get_db() as conn:
        for p in plan:
            for tid in p["lot_ids"]:
                cur = conn.execute(
                    "UPDATE trades SET price_stoploss = ? WHERE id = ? AND win_loss = 'P' "
                    "AND (price_stoploss IS NULL OR price_stoploss <= 0)",
                    (p["stop"], tid),
                )
                n += cur.rowcount
        conn.commit()
    return {"dry_run": False, "backup": backup, "plan": plan, "skipped": skipped, "lots": n}


# ── Stop-discipline simulator ────────────────────────────────────────────────

# Home-market factor per holding. Gold and crypto are their own market.
# Yahoo serves ^SET.BK as a single bar (2026-09-29), so the SET factor is the
# SET50 ETF TDEX.BK (THB, Thai calendar); THD (iShares Thailand, USD, US
# calendar) is the fallback when TDEX has no history.
_SIM_FACTORS = {"US": "^GSPC", "TH": "TDEX.BK", "CRYPTO": "BTC-USD", "GOLD": "GC=F"}
_SIM_TH_FALLBACK = "THD"
_SIM_FACTOR_LABEL = {"^GSPC": "S&P 500", "TDEX.BK": "SET50 (TDEX)", "THD": "Thailand (THD)",
                     "BTC-USD": "BTC", "GC=F": "GOLD"}
_sim_cache: TTLCache = TTLCache(ttl=600, maxsize=16)


def _sim_factor_for(yf_symbol: str) -> str:
    s = (yf_symbol or "").upper()
    if s.endswith(".BK"):
        return _SIM_FACTORS["TH"]
    if s.endswith(("-USD", "-THB", "-USDT")):
        return _SIM_FACTORS["CRYPTO"]
    if s in ("GC=F", "SI=F", "GLD", "IAU"):
        return _SIM_FACTORS["GOLD"]
    return _SIM_FACTORS["US"]


def _sim_beta(asset: "pd.Series", factor: "pd.Series") -> tuple[float, float, int]:
    """(β, residual daily σ, n) from date-joined log returns (last 250)."""
    df = pd.concat([asset.rename("a"), factor.rename("f")], axis=1).dropna()
    df = np.log(df / df.shift(1)).dropna().iloc[-250:]
    n = len(df)
    if n < MIN_HISTORY_DAYS:
        return 1.0, 0.02, n
    var = float(df["f"].var())
    beta = float(df["a"].cov(df["f"]) / var) if var > 0 else 1.0
    resid = float((df["a"] - beta * df["f"]).std())
    return beta, max(resid, 0.001), n


def _sim_key(row: dict) -> str:
    return f"{row.get('account_id') or ''}|{row['yf_symbol']}"


def _sim_inputs(account_id: Optional[str], fresh: bool = False) -> dict:
    """Everything the simulator needs that is slow to get: the guard snapshot
    (positions, stops, flags), β / residual vol per holding and the factor
    covariance. Cached 10 min — the simulation itself is cheap and re-runs
    for every what-if the user ticks."""
    import stop_sim

    key = f"inputs:{account_id or 'all'}"
    hit = None if fresh else _sim_cache.get(key)
    if hit is not None:
        return hit

    snap = _guard_snapshot(account_id, "THB")
    rows = snap.get("positions", [])
    if not rows:
        return {"rows": [], "holdings": [], "note": "no open positions"}

    factor_of = {r["yf_symbol"]: _sim_factor_for(r["yf_symbol"]) for r in rows}
    factors = sorted(set(factor_of.values()))
    close = _fetch_close_frame(sorted(set(factor_of) | set(factors) | {_SIM_TH_FALLBACK}), 400)
    th = _SIM_FACTORS["TH"]
    if th in factors and (th not in close.columns
                          or close[th].dropna().shape[0] < MIN_HISTORY_DAYS):
        factor_of = {k: (_SIM_TH_FALLBACK if v == th else v) for k, v in factor_of.items()}
        factors = sorted(set(factor_of.values()))

    holdings, thin = [], []
    for r in rows:
        f = factor_of[r["yf_symbol"]]
        if r["yf_symbol"] in close.columns and f in close.columns:
            beta, resid, n = _sim_beta(close[r["yf_symbol"]], close[f])
        else:
            beta, resid, n = 1.0, 0.02, 0
        if n < MIN_HISTORY_DAYS:
            thin.append(r["symbol"])
        holdings.append(stop_sim.Holding(
            symbol=r["symbol"], value=float(r["market_value"]), price=float(r["price"]),
            stop=float(r["stop"]) if r.get("stop") else None,
            factor=f, beta=beta, resid_vol=resid, key=_sim_key(r),
        ))

    fr, _ = _aligned_returns([f for f in factors if f in close.columns], 252)
    usable = list(fr.columns)
    missing = [f for f in factors if f not in usable]
    if missing:
        # A factor with no history: treat it as independent with 1.5%/day.
        cov = np.eye(len(factors)) * 0.015 ** 2
        if usable:
            sub = np.cov(fr[usable].values, rowvar=False).reshape(len(usable), len(usable))
            ix = [factors.index(u) for u in usable]
            cov[np.ix_(ix, ix)] = sub
    else:
        cov = np.cov(fr[factors].values, rowvar=False).reshape(len(factors), len(factors))

    out = {
        "rows": rows, "holdings": holdings, "cov": cov, "factors": factors,
        "missing": missing, "thin": thin,
        "cash": float(snap.get("cash_value") or 0.0), "as_of": snap.get("as_of"),
    }
    _sim_cache.set(key, out)
    return out


def _sim_run(inp: dict, horizon: int, n_paths: int,
             scale: Optional[list[float]] = None, follow_stops: bool = True,
             market: str = "sd") -> dict:
    import stop_sim

    cov, factors = inp["cov"], inp["factors"]
    out = stop_sim.simulate(
        inp["holdings"], cov, factors, cash=inp["cash"],
        horizon=horizon, n_paths=n_paths, scale=scale, follow_stops=follow_stops,
        market=market,
    )
    fvol = np.sqrt(np.diag(cov))
    out["factors"] = [
        {"key": f, "label": _SIM_FACTOR_LABEL.get(f, f),
         "daily_vol_pct": round(float(fvol[i]) * 100, 3),
         "sd_horizon_pct": round(float(np.expm1(fvol[i] * np.sqrt(horizon))) * 100, 2),
         "estimated": f not in inp["missing"]}
        for i, f in enumerate(factors)
    ]
    out["thin_history"] = inp["thin"]
    out["base_currency"] = "THB"
    out["as_of"] = inp["as_of"]
    return out


@router.get("/stop-sim")
def get_stop_sim(
    account_id: Optional[str] = Query(None),
    horizon: int = Query(20, ge=5, le=120),
    n_paths: int = Query(1000, ge=100, le=5000),
    fresh: bool = Query(False, description="Skip the 10-min cache"),
):
    """Book NAV over `horizon` trading days if every home market moves
    +1 / 0 / −1 / −2 SD — obeying stops vs holding everything.

    Stops = the guard's (manual S/L, else 2×ATR auto). β and residual vol per
    holding from the last ~250 daily returns against its home-market factor;
    factor co-movement from their joint history. Model + caveats:
    backend/stop_sim.py. The UI uses POST /what-if-sim, which is this with trades.
    """
    inp = _sim_inputs(account_id, fresh)
    if not inp["holdings"]:
        return {"scenarios": [], "holdings": [], "note": inp.get("note", "no open positions")}
    return _sim_run(inp, horizon, n_paths)


class WhatIfSimIn(BaseModel):
    account_id: Optional[str] = None
    horizon: int = Field(20, ge=5, le=120)
    n_paths: int = Field(1000, ge=100, le=5000)
    # key (account|yf_symbol) → shares after the trade. Missing = unchanged.
    target_volume: dict[str, float] = Field(default_factory=dict)
    follow_stops: bool = True
    # "sd" = market pinned at +1/0/−1/−2 SD; "random" = market not pinned.
    market: Literal["sd", "random"] = "sd"
    fresh: bool = False


def _what_if_suggestions(rows: list[dict]) -> list[dict]:
    """The guard's own advice, as trades: sell what broke its stop, cut what is
    over the single-name cap back to the cap. ERC trims come from
    /risk/metrics (`trim_signals`) and are merged in by the UI."""
    import trade_guard

    total = sum(float(r["market_value"]) for r in rows) or 0.0
    out = []
    for r in rows:
        key, vol = _sim_key(r), float(r["volume"])
        if "STOP_HIT" in (r.get("flags") or []):
            out.append({"key": key, "code": "STOP_HIT", "target_volume": 0.0,
                        "text": f"ขายทั้งหมด — หลุด stop {trade_guard.fmt_px(r['stop'])}",
                        "overridden": bool(r.get("override"))})
        if "OVERWEIGHT" in (r.get("flags") or []) and total > 0 and r["market_value"] > 0:
            cap_value = trade_guard.MAX_WEIGHT * total
            target = vol * min(1.0, cap_value / float(r["market_value"]))
            out.append({"key": key, "code": "OVERWEIGHT", "target_volume": round(target, 7),
                        "text": f"ลดเหลือ {trade_guard.MAX_WEIGHT * 100:.0f}% ของพอร์ต "
                                f"(ตอนนี้ {r['weight_pct']:.1f}%)",
                        "overridden": bool(r.get("override"))})
    return out


@router.post("/what-if-sim")
def post_what_if_sim(body: WhatIfSimIn):
    """The real book, two ways, over +1 / 0 / −1 / −2 SD markets:
    DO (`disciplined`) = the trades in `target_volume` filled today at today's
    price (no fees), then stops obeyed if `follow_stops`; DON'T (`hold`) = the
    book exactly as it is, held. Same random draws for both, so the gap
    between them is the decision and nothing else. Model: backend/stop_sim.py.
    """
    inp = _sim_inputs(body.account_id, body.fresh)
    if not inp["holdings"]:
        return {"scenarios": [], "holdings": [], "positions": [], "suggestions": [],
                "note": inp.get("note", "no open positions")}
    rows_by_key = {_sim_key(r): r for r in inp["rows"]}
    scale = []
    for h in inp["holdings"]:
        vol = float(rows_by_key[h.key]["volume"])
        tgt = body.target_volume.get(h.key)
        scale.append(1.0 if tgt is None or vol <= 0 else max(float(tgt), 0.0) / vol)
    out = _sim_run(inp, body.horizon, body.n_paths, scale=scale,
                   follow_stops=body.follow_stops, market=body.market)
    out["positions"] = [
        {"key": _sim_key(r), "account_id": r.get("account_id"), "symbol": r["symbol"],
         "yf_symbol": r["yf_symbol"], "currency": r.get("currency"), "sector": r.get("sector"),
         "volume": r["volume"], "price": r["price"], "entry_price": r["entry_price"],
         "stop": r["stop"], "stop_source": r.get("stop_source"), "to_stop_pct": r.get("to_stop_pct"),
         "market_value": r["market_value"], "weight_pct": r["weight_pct"],
         "return_pct": r.get("return_pct"), "flags": r.get("flags") or [],
         "override": bool(r.get("override"))}
        for r in inp["rows"]
    ]
    out["suggestions"] = _what_if_suggestions(inp["rows"])
    return out


# ── Monte Carlo (filtered historical simulation) ─────────────────────────────

MC_WINDOW_DAYS = 750          # ~3y of whole days to draw from
_mc_cache: TTLCache = TTLCache(ttl=600, maxsize=64)


def _mc_book_stamp(account_id: Optional[str]) -> str:
    """What is held, as a short hash: open stock lots (account, symbol, shares)
    and open option lots. Part of the cache key, so a buy or a sell is in the
    next run instead of waiting out the 10 minutes."""
    import hashlib

    where, params = "", []
    if account_id:
        where, params = " AND account_id = ?", [account_id]
    with get_db() as conn:
        rows = [tuple(r) for r in conn.execute(
            "SELECT account_id, symbol, ROUND(SUM(volume), 7) FROM trades "
            f"WHERE win_loss = 'P'{where} GROUP BY account_id, symbol ORDER BY 1, 2", params)]
        try:
            rows += [tuple(r) for r in conn.execute(
                "SELECT account_id, occ_symbol, ROUND(SUM(quantity), 7) FROM v_option_open_lots "
                f"WHERE 1 = 1{where} GROUP BY account_id, occ_symbol ORDER BY 1, 2", params)]
        except Exception:
            pass                                   # no option tables: stocks alone decide
    return hashlib.md5(repr(rows).encode()).hexdigest()[:12]


def _mc_inputs(account_id: Optional[str], base: str, fresh: bool = False) -> dict:
    """The slow half of a Monte Carlo run: the book as held (positions, cash,
    option deltas) and ~3y of base-currency daily returns filtered into
    residual days. Cached 10 min per book — a trade changes the book stamp and
    so builds new inputs at once; prices and cash refresh with the 10 minutes.
    The simulation itself takes ~0.1 s and re-runs for every horizon / path
    count / volatility choice."""
    import port_mc

    key = f"in:{account_id or 'all'}:{base}:{_mc_book_stamp(account_id)}"
    hit = None if fresh else _mc_cache.get(key)
    if hit is not None:
        return hit

    positions = _open_positions_priced(account_id)
    try:
        from routers.portfolio_v2 import get_summary
        summ = get_summary(base_currency=base)
    except Exception:
        summ = None
    cash, opt = _risk_extras(account_id, base, summ)

    # Same book as /risk/metrics: one row per market symbol, base-currency value.
    value: dict[str, float] = {}
    label: dict[str, str] = {}
    ccy: dict[str, str] = {}
    by_account: dict[str, dict[str, float]] = {}
    for pos in positions:
        sym = _position_yf_symbol(pos)
        if not sym:
            continue
        price = pos.get("current_price") or pos.get("price_entry", 0)
        v = convert_amount(float(price or 0) * float(pos.get("volume", 0)), trade_currency(pos), base)
        if not v:
            continue
        value[sym] = value.get(sym, 0.0) + v
        label[sym] = pos["symbol"]
        ccy.setdefault(sym, trade_currency(pos))
        acct = by_account.setdefault(str(pos["account_id"]), {})
        acct[sym] = acct.get(sym, 0.0) + v
    nav = sum(value.values()) + cash
    option_value = 0.0
    for sym, (v, c, lab) in opt.items():
        if not v:
            continue
        value[sym] = value.get(sym, 0.0) + v       # exposure only — not part of NAV
        label.setdefault(sym, lab)
        ccy.setdefault(sym, c)
        option_value += v
        acct = by_account.setdefault("options Δ", {})
        acct[sym] = acct.get(sym, 0.0) + v
    if nav <= 0:
        nav = sum(abs(v) for v in value.values())   # degenerate book: fall back to gross
    if not value or nav <= 0:
        return {"symbols": [], "note": "no open positions"}

    symbols = list(value)
    factor_of = {s: _sim_factor_for(s) for s in symbols}
    extra = sorted(set(factor_of.values()) - set(symbols))
    # A joint download can come back without one of its symbols (yfinance's
    # shared result dict, see `_fetch_close_frame`) and the frame is then cached
    # for 5 min. Here that would silently drop a holding from the simulation,
    # so whatever is missing is asked for once more on its own.
    close = _fetch_close_frame(symbols + extra, MC_WINDOW_DAYS)
    lost = [s for s in symbols + extra if s not in close.columns or not close[s].notna().any()]
    if lost and not close.empty:
        again = _fetch_close_frame(lost, MC_WINDOW_DAYS)
        found = [s for s in lost if s in again.columns and again[s].notna().any()]
        if found:
            close = close.drop(columns=[s for s in found if s in close.columns]).join(
                again[found], how="outer").sort_index()
    rets, excluded = _aligned_returns(symbols + extra, MC_WINDOW_DAYS, ccy_map=ccy,
                                      base_currency=base, common_only=False, close=close)
    keep = [s for s in symbols if s in rets.columns]
    excluded = [e for e in excluded if e["symbol"] in value]
    for e in excluded:
        e["weight_pct"] = round(100 * value[e["symbol"]] / nav, 2)
        e["symbol"] = label.get(e["symbol"], e["symbol"])
    if not keep:
        return {"symbols": [], "note": "no price history", "excluded": excluded}

    cols = keep + [f for f in extra if f in rets.columns]
    col_of = {c: i for i, c in enumerate(cols)}
    R = np.expm1(rets[cols].values)             # simple returns — port_mc's unit
    Z_all, s2_all, lr_all = port_mc.garch_filter(R)
    n = len(keep)
    factor_Z = np.column_stack([
        Z_all[:, col_of[factor_of[s]]] if factor_of[s] in col_of else np.full(len(R), np.nan)
        for s in keep
    ])
    Z, filled = port_mc.backfill(Z_all[:, :n], factor_Z)

    # No history = no simulation: those names lend their exposure to the rest,
    # as /risk/metrics does, so the invested share of the book stays what it is.
    exposure = np.array([value[s] for s in keep])
    scale = sum(value.values()) / exposure.sum() if excluded and abs(exposure.sum()) > 1e-9 else 1.0
    groups = {
        acct: np.array([vals.get(s, 0.0) for s in keep]) * scale
        for acct, vals in by_account.items()
    } if len(by_account) > 1 else {}

    out = {
        "symbols": keep, "labels": [label[s] for s in keep],
        "factors": [_SIM_FACTOR_LABEL.get(factor_of[s], factor_of[s]) for s in keep],
        "exposure": exposure * scale, "nav": float(nav), "cash": float(cash),
        "option_delta_value": float(option_value),
        "Z": Z, "s2": s2_all[:n], "lr": lr_all[:n], "groups": groups,
        "history_days": (~np.isnan(R[:, :n])).sum(axis=0).tolist(), "filled": filled.tolist(),
        "window_days": int(len(R)), "window_from": rets.index[0].strftime("%Y-%m-%d"),
        "as_of": rets.index[-1].strftime("%Y-%m-%d"),
        "excluded": excluded, "stamp": time.time(),
    }
    _mc_cache.set(key, out)
    return out


@router.get("/monte-carlo")
def get_monte_carlo(
    account_id: Optional[str] = Query(None),
    horizon: int = Query(63, ge=5, le=252, description="Trading days"),
    n_paths: int = Query(20_000, ge=1_000, le=50_000),
    vol: Literal["current", "longrun"] = Query(
        "current", description="Day-1 volatility: today's regime, or each holding's 3y average"),
    drift_annual_pct: float = Query(0.0, ge=-50, le=100, description="Expected return per year, every holding"),
    base_currency: str = Query("THB"),
    fresh: bool = Query(False, description="Skip the 10-min cache"),
):
    """The book as held today, simulated `n_paths` ways over `horizon` trading
    days — nothing traded. ALL = every account in one book (holdings in two
    accounts move as one); an account id = that account's holdings and cash
    only. Fan bands, loss lines (VaR / CVaR at the horizon) with their sampling
    error, loss and drawdown probabilities, and who carries the worst 5%.

    Model + why + speed: backend/port_mc.py (filtered historical simulation).
    """
    import port_mc

    base = report_currency(base_currency)
    scope = account_id if account_id and account_id != "all" else None
    inp = _mc_inputs(scope, base, fresh)
    if not inp.get("symbols"):
        return {"holdings": [], "note": inp.get("note", "no open positions"),
                "excluded": inp.get("excluded", [])}

    key = f"out:{scope or 'all'}:{base}:{inp['stamp']}:{horizon}:{n_paths}:{vol}:{drift_annual_pct}"
    hit = _mc_cache.get(key)
    if hit is not None:
        return hit

    t0 = time.perf_counter()
    out = port_mc.simulate(
        inp["exposure"], inp["nav"], inp["Z"],
        inp["s2"] if vol == "current" else inp["lr"], inp["lr"],
        horizon=horizon, n_paths=n_paths,
        drift_daily=math.log1p(drift_annual_pct / 100) / 252,
        groups=inp["groups"],
    )
    elapsed = (time.perf_counter() - t0) * 1000

    nav = inp["nav"]
    assets = out.pop("assets")
    out["holdings"] = sorted((
        {"symbol": inp["labels"][j], "yf_symbol": s,
         "exposure": round(float(inp["exposure"][j]), 2),
         "weight_pct": round(float(inp["exposure"][j]) / nav * 100, 2),
         "vol_now_pct": round(float(np.sqrt(inp["s2"][j] * 252)) * 100, 1),
         "vol_longrun_pct": round(float(np.sqrt(inp["lr"][j] * 252)) * 100, 1),
         "history_days": inp["history_days"][j], "filled_days": inp["filled"][j],
         "factor": inp["factors"][j], **assets[j]}
        for j, s in enumerate(inp["symbols"])
    ), key=lambda h: -h["tail_share_pct"])
    out.update({
        "model": "FHS", "vol": vol, "drift_annual_pct": drift_annual_pct,
        "account_id": scope or "all", "base_currency": base,
        "nav": round(nav, 2), "cash": round(inp["cash"], 2),
        "option_delta_value": round(inp["option_delta_value"], 2),
        "window_days": inp["window_days"], "window_from": inp["window_from"], "as_of": inp["as_of"],
        "excluded": inp["excluded"], "elapsed_ms": round(elapsed, 1),
    })
    _mc_cache.set(key, out)
    return out


# ── Take-profit rebalance ────────────────────────────────────────────────────

_rebal_cache: TTLCache = TTLCache(ttl=300, maxsize=16)


def _rebalance_rules():
    import rebalance

    with get_db() as conn:
        row = conn.execute("SELECT rules_json FROM rebalance_rules WHERE id = 1").fetchone()
    try:
        return rebalance.Rules.from_dict(json.loads(row["rules_json"]) if row else None)
    except (ValueError, TypeError):
        logger.warning("rebalance_rules row is invalid — using defaults")
        return rebalance.Rules()


def _rebalance_dates(account_id: Optional[str]) -> tuple[dict, dict]:
    """symbol → first open-lot entry date, symbol → last sell date (closed lots)."""
    acct, params = "", []
    if account_id and account_id != "all":
        acct, params = " AND account_id = ?", [account_id]
    with get_db() as conn:
        first = {r["s"]: r["d"] for r in conn.execute(
            "SELECT UPPER(symbol) s, MIN(date_entry) d FROM trades "
            f"WHERE win_loss = 'P'{acct} GROUP BY UPPER(symbol)", params).fetchall()}
        last = {r["s"]: r["d"] for r in conn.execute(
            "SELECT UPPER(symbol) s, MAX(date_exit) d FROM trades "
            f"WHERE win_loss != 'P' AND price_exit > 0 AND date_exit IS NOT NULL{acct} "
            "GROUP BY UPPER(symbol)", params).fetchall()}
    return first, last


def _rebalance_earnings(yf_by_symbol: dict[str, str], timeout: float = 12) -> dict[str, Optional[list]]:
    """symbol → report dates. Missing key = not asked; [] / None = unknown.
    Only called for holdings that would trim, so a handful of cached lookups."""
    from concurrent.futures import ThreadPoolExecutor, wait

    from routers.stock import stock_earnings_calendar

    def one(yf_sym: str) -> list:
        return [d["date"][:10] for d in stock_earnings_calendar(yf_sym).get("earningsDates", [])]

    out: dict[str, Optional[list]] = {s: None for s in yf_by_symbol}
    if not yf_by_symbol:
        return out
    pool = ThreadPoolExecutor(max_workers=4)
    futs = {pool.submit(one, y): s for s, y in yf_by_symbol.items()}
    done, _ = wait(futs, timeout=timeout)
    pool.shutdown(wait=False, cancel_futures=True)
    for f in done:
        try:
            out[futs[f]] = f.result()
        except Exception as e:  # noqa: BLE001 — unknown, not fatal
            logger.info("rebalance: earnings dates for %s unavailable: %s", futs[f], e)
    return out


def _rebalance_plan(account_id: Optional[str], fresh: bool = False) -> dict:
    """Allocation-detail weights + the take-profit rules (rebalance.py)."""
    import rebalance
    from routers.portfolio_v2 import get_allocation_detail

    rules = _rebalance_rules()
    key = f"{account_id or 'all'}:{json.dumps(rules.as_dict(), sort_keys=True)}"
    hit = None if fresh else _rebal_cache.get(key)
    if hit is not None:
        return hit
    alloc = get_allocation_detail(account_id=account_id, base_currency="THB")
    symbols = alloc.get("symbols", [])
    for s in symbols:
        if s.get("instrument") != "option":
            s["yf_symbol"] = _position_yf_symbol(s) or s["symbol"]
    total = float(alloc.get("totals", {}).get("market_value") or 0)
    first, last = _rebalance_dates(account_id)
    today = date.today()
    out = rebalance.plan(symbols, total, rules, today, first, last)
    # Earnings blackout only matters for the ones that would trade.
    cand = {r["symbol"]: r["yf_symbol"] for r in out["rows"]
            if r["status"] in ("TRIM", "WAIT", "SMALL") and r.get("yf_symbol")}
    if cand:
        earn = _rebalance_earnings(cand)
        out = rebalance.plan(symbols, total, rules, today, first, last,
                             earnings={s: v or [] for s, v in earn.items()})
    # "Not yet, because …" decisions (risk_decisions) take a TRIM off the list
    # until their review date. Symbol-wide: a hold made in one account view is
    # the same decision in ALL.
    import risk_journal
    with get_db() as conn:
        holds = risk_journal.rebalance_holds(conn)
    out = rebalance.apply_holds(out, holds, today)
    out["base_currency"] = "THB"
    _rebal_cache.set(key, out)
    return out


@router.get("/rebalance")
def get_rebalance(account_id: Optional[str] = Query(None), fresh: bool = Query(False)):
    """Take-profit rebalance: which winners grew past their target slice and
    how much to sell. Target = explicit allocation_targets row, else the cost
    weight. Rules (gain, 5/25 band, min hold, min gap, earnings blackout,
    rebal_to) live in `rebalance_rules`; model: backend/rebalance.py."""
    return _rebalance_plan(account_id, fresh)


class RebalanceRulesIn(BaseModel):
    min_gain_pct: Optional[float] = None
    band_abs_pp: Optional[float] = None
    band_rel_pct: Optional[float] = None
    rebal_to: Optional[str] = None
    min_hold_days: Optional[int] = None
    min_gap_days: Optional[int] = None
    earn_before_days: Optional[int] = None
    earn_after_days: Optional[int] = None


@router.put("/rebalance/rules")
def put_rebalance_rules(body: RebalanceRulesIn):
    """Merge into the saved rules. Fields left out keep their value."""
    import rebalance
    from fastapi import HTTPException

    cur = _rebalance_rules().as_dict()
    cur.update({k: v for k, v in body.model_dump().items() if v is not None})
    try:
        rules = rebalance.Rules.from_dict(cur)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    with get_db() as conn:
        conn.execute(
            "INSERT INTO rebalance_rules (id, rules_json, updated_at) VALUES (1, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET rules_json = excluded.rules_json, updated_at = excluded.updated_at",
            (json.dumps(rules.as_dict()), datetime.now().isoformat(timespec="seconds")),
        )
        conn.commit()
    _rebal_cache.clear()
    return {"rules": rules.as_dict()}


@router.delete("/rebalance/rules")
def reset_rebalance_rules():
    import rebalance

    with get_db() as conn:
        conn.execute("DELETE FROM rebalance_rules")
        conn.commit()
    _rebal_cache.clear()
    return {"rules": rebalance.Rules().as_dict()}


# ── Risk decision journal ────────────────────────────────────────────────────

class RiskDecisionIn(BaseModel):
    kind: str                                  # STOP | REBALANCE | BUDGET | OTHER
    decision: str                              # HOLD | FOLLOW | CHANGE | NOTE
    reason: str
    account_id: Optional[str] = None
    symbol: Optional[str] = None
    yf_symbol: Optional[str] = None
    snapshot: Optional[dict] = None
    # HOLD only: when the decision comes back for review (default 14 days).
    review_days: Optional[int] = None


@router.get("/decisions")
def get_risk_decisions(
    account_id: Optional[str] = Query(None),
    kind: Optional[str] = Query(None),
    symbol: Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=1000),
):
    """The journal of risk decisions, newest first: why a stop or a rebalance
    was held, followed or changed (backend/risk_journal.py). `active` = a HOLD
    still inside its review date."""
    import risk_journal

    with get_db() as conn:
        rows = risk_journal.list_decisions(conn, account_id, kind, symbol, limit)
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["kind"]] = counts.get(r["kind"], 0) + 1
    return {"decisions": rows, "counts": counts,
            "active_holds": sum(1 for r in rows if r["active"]),
            "kinds": list(risk_journal.KINDS), "decision_types": list(risk_journal.DECISIONS)}


@router.post("/decisions")
def post_risk_decision(body: RiskDecisionIn):
    """Write one decision. A REBALANCE HOLD needs a symbol; it replaces the live
    hold on that symbol and takes it off the TRIM list until `review_on`.
    A STOP HOLD is written by POST /guard/override, not here — it needs the
    holding period and a floor."""
    import risk_journal
    from fastapi import HTTPException

    kind, decision = body.kind.upper(), body.decision.upper()
    if kind == "STOP" and decision == "HOLD":
        raise HTTPException(status_code=400,
                            detail="a stop HOLD is recorded from TRADE GUARD (POST /guard/override)")
    review_on = None
    try:
        if decision == "HOLD":
            if not (body.symbol or "").strip():
                raise ValueError("symbol required for a HOLD")
            review_on = risk_journal.review_date(body.review_days)
        with get_db() as conn:
            if decision == "HOLD":
                risk_journal.end_previous_holds(conn, kind, body.symbol)
            did = risk_journal.record(
                conn, kind=kind, decision=decision, reason=body.reason, account_id=body.account_id,
                symbol=body.symbol, yf_symbol=body.yf_symbol, snapshot=body.snapshot, review_on=review_on,
            )
            conn.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if kind == "REBALANCE":
        _rebal_cache.clear()
    return {"ok": True, "id": did, "review_on": review_on}


@router.delete("/decisions/{decision_id}")
def end_risk_decision(decision_id: str):
    """End a live HOLD now (the row stays in the journal with `cleared_at`).
    Guard holds are ended from TRADE GUARD, which owns their state."""
    from fastapi import HTTPException

    with get_db() as conn:
        row = conn.execute("SELECT kind, decision, source, cleared_at FROM risk_decisions WHERE id = ?",
                           (decision_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="decision not found")
        if row["source"] == "guard":
            raise HTTPException(status_code=400, detail="end a stop HOLD from TRADE GUARD")
        if row["decision"] != "HOLD" or row["cleared_at"]:
            raise HTTPException(status_code=400, detail="only a live HOLD can be ended")
        conn.execute("UPDATE risk_decisions SET cleared_at = ? WHERE id = ?",
                     (datetime.now().isoformat(timespec="seconds"), decision_id))
        conn.commit()
    _rebal_cache.clear()
    return {"ok": True}


# ── Down-tilted paths (stress on the Monte Carlo) ────────────────────────────

@router.get("/bear-paths")
def get_bear_paths(
    account_id: Optional[str] = Query(None),
    p_down: float = Query(0.6, ge=0.5, le=0.95, description="Chance a day is a losing day for the book"),
    n_paths: int = Query(10_000, ge=1_000, le=30_000),
    vol: Literal["current", "longrun"] = Query("current"),
    base_currency: str = Query("THB"),
    fresh: bool = Query(False, description="Skip the 10-min cache"),
):
    """The book as held, run through random paths that hold MORE losing days
    than winning ones, at 3 / 5 / 7 / 21 / 42 trading days — with a neutral run
    beside each. A stress, not a forecast. Model: backend/bear_paths.py; inputs
    are the Monte Carlo's (`_mc_inputs`)."""
    import bear_paths

    base = report_currency(base_currency)
    scope = account_id if account_id and account_id != "all" else None
    inp = _mc_inputs(scope, base, fresh)
    if not inp.get("symbols"):
        return {"horizons": [], "note": inp.get("note", "no open positions"),
                "excluded": inp.get("excluded", [])}

    key = f"bear:{scope or 'all'}:{base}:{inp['stamp']}:{p_down}:{n_paths}:{vol}"
    hit = _mc_cache.get(key)
    if hit is not None:
        return hit

    t0 = time.perf_counter()
    try:
        out = bear_paths.simulate(
            inp["exposure"], inp["nav"], inp["Z"],
            inp["s2"] if vol == "current" else inp["lr"], inp["lr"],
            p_down=p_down, n_paths=n_paths, labels=inp["labels"],
        )
    except ValueError as e:
        return {"horizons": [], "note": str(e), "excluded": inp.get("excluded", [])}
    out.update({
        "model": "FHS, down-tilted", "vol": vol, "account_id": scope or "all", "base_currency": base,
        "nav": round(inp["nav"], 2), "cash": round(inp["cash"], 2),
        "window_days": inp["window_days"], "window_from": inp["window_from"], "as_of": inp["as_of"],
        "excluded": inp["excluded"], "elapsed_ms": round((time.perf_counter() - t0) * 1000, 1),
    })
    _mc_cache.set(key, out)
    return out


# ── Factor exposure + risk budget ────────────────────────────────────────────

_factor_cache: TTLCache = TTLCache(ttl=300, maxsize=32)
_FACTOR_COL = "F:"       # factor legs ride in the close frame under this prefix


def _risk_book(account_id: Optional[str], base_currency: str) -> dict:
    """The open book on the NAV basis `_compute_portfolio_risk` uses: value per
    yf symbol in `base_currency` (lots summed, shorts negative, options as
    delta-equivalent underlying), cash in the denominator."""
    base = report_currency(base_currency)
    positions = _open_positions_priced(account_id)
    try:
        from routers.portfolio_v2 import get_summary
        summ = get_summary(base_currency=base)
    except Exception:
        summ = None
    cash, opt = _risk_extras(account_id, base, summ)

    value: dict[str, float] = {}
    ccy: dict[str, str] = {}
    name: dict[str, str] = {}
    sector: dict[str, str] = {}
    lots: dict[str, list[tuple[str, str, float]]] = {}   # yf → (trade id, symbol, value)
    for pos in positions:
        yf_sym = _position_yf_symbol(pos)
        if not yf_sym:
            continue
        price = pos.get("current_price") or pos.get("price_entry", 0)
        val = convert_amount(float(price or 0) * float(pos.get("volume", 0)),
                             trade_currency(pos), base)
        ccy.setdefault(yf_sym, trade_currency(pos))
        if val == 0:
            continue
        value[yf_sym] = value.get(yf_sym, 0.0) + val
        name[yf_sym] = pos["symbol"]
        if str(pos.get("sector") or "").strip():
            sector.setdefault(yf_sym, str(pos["sector"]).strip())
        lots.setdefault(yf_sym, []).append((str(pos.get("id") or ""), str(pos["symbol"]), val))
    for yf_sym, (val, c, label) in opt.items():
        if not val:
            continue
        value[yf_sym] = value.get(yf_sym, 0.0) + val
        ccy.setdefault(yf_sym, c)
        name.setdefault(yf_sym, label)

    value = {s: v for s, v in value.items() if v != 0}
    nav = sum(value.values()) + cash
    if nav <= 0:
        nav = sum(abs(v) for v in value.values())
    return {"base": base, "symbols": list(value), "value": value, "ccy": ccy, "name": name,
            "sector": sector, "lots": lots, "nav": nav, "cash": cash}


def _book_weights(book: dict, valid: list[str]) -> np.ndarray:
    """NAV weights of `valid`; symbols without history lend theirs to the rest
    (as `_compute_portfolio_risk` does), so cash stays cash."""
    nav = book["nav"] or 1.0
    w = np.array([book["value"][s] / nav for s in valid], dtype=float)
    total = sum(book["value"].values()) / nav
    if abs(w.sum()) > 1e-12:
        w = w * (total / w.sum())
    return w


@router.get("/factors")
def get_factor_exposure(
    account_id: Optional[str] = Query(None),
    lookback: int = Query(252, ge=120, le=1260),
    base_currency: str = Query("THB"),
    fresh: bool = Query(False),
):
    """What the book is betting on: betas to market-wide factors (ETF proxies),
    each one's share of the book's risk, and which holdings bring it.
    Model and factor list: backend/factor_exposure.py."""
    import factor_exposure as fx

    base = report_currency(base_currency)
    key = f"{account_id or 'all'}:{lookback}:{base}"
    hit = None if fresh else _factor_cache.get(key)
    if hit is not None:
        return hit

    book = _risk_book(account_id, base)
    out = {"account_id": account_id or "all", "base_currency": base,
           "as_of": date.today().isoformat(), "lookback_days": lookback,
           "nav": round(book["nav"], 2), "excluded": [], "missing_factors": []}
    if not book["symbols"]:
        out.update(fx.analyze(pd.DataFrame(), {}, pd.DataFrame()))
        _factor_cache.set(key, out)
        return out

    fset = fx.factor_set(book["symbols"])
    legs = fx.tickers(fset)
    close = _fetch_close_frame(list(dict.fromkeys(book["symbols"] + legs)), lookback)
    # A factor leg the book also holds (SPY, GLD, BTC-USD) must stay in its own
    # currency while the holding is translated — so the legs get their own columns.
    for t in legs:
        if not close.empty and t in close.columns:
            close = close.assign(**{_FACTOR_COL + t: close[t]})
    leg_cols = [_FACTOR_COL + t for t in legs]
    rets, excluded = _aligned_returns(
        book["symbols"] + leg_cols, lookback, ccy_map=book["ccy"], base_currency=base,
        min_history=fx.MIN_HISTORY, close=close,
    )
    out["excluded"] = [e for e in excluded if not e["symbol"].startswith(_FACTOR_COL)]
    valid = [s for s in book["symbols"] if not rets.empty and s in rets.columns]
    if not valid:
        out.update(fx.analyze(pd.DataFrame(), {}, pd.DataFrame()))
        _factor_cache.set(key, out)
        return out

    simple = np.expm1(rets)
    leg_rets = simple[[c for c in leg_cols if c in simple.columns]].rename(
        columns=lambda c: c[len(_FACTOR_COL):])
    factors, missing = fx.factor_returns(leg_rets, fset)
    out["missing_factors"] = missing
    weights = dict(zip(valid, _book_weights(book, valid)))
    out.update(fx.analyze(simple[valid], weights, factors, nav=book["nav"],
                          names=book["name"], factor_defs=fset))
    _factor_cache.set(key, out)
    return out


def _risk_budget_saved(account_id: Optional[str]):
    import risk_budget

    with get_db() as conn:
        row = conn.execute("SELECT budget_json FROM risk_budgets WHERE account_id = ?",
                           (account_id or "all",)).fetchone()
    try:
        return risk_budget.Budget.from_dict(json.loads(row["budget_json"]) if row else None)
    except (ValueError, TypeError):
        logger.warning("risk_budgets row for %s is invalid — treating as unset", account_id or "all")
        return risk_budget.Budget()


def _budget_theses(book: dict) -> dict[str, tuple[str, str, Optional[int]]]:
    """yf symbol → (thesis id, title, conviction). An explicit thesis_links row
    wins; else the newest live thesis on the same symbol; else NONE_KEY. A
    symbol whose lots point at different theses goes with the larger value."""
    import sqlite3

    from risk_budget import NONE_KEY

    try:
        with get_db() as conn:
            theses = [dict(r) for r in conn.execute(
                "SELECT id, symbol, title, conviction, status FROM theses "
                "WHERE deleted_at IS NULL ORDER BY COALESCE(updated_at, created_at) DESC").fetchall()]
            links = conn.execute("SELECT thesis_id, trade_id FROM thesis_links").fetchall()
    except sqlite3.OperationalError:
        theses, links = [], []
    by_id = {t["id"]: t for t in theses}
    by_symbol: dict[str, dict] = {}
    for t in theses:
        if t["status"] not in ("invalidated", "closed"):
            by_symbol.setdefault(str(t["symbol"] or "").upper(), t)
    linked = {r["trade_id"]: r["thesis_id"] for r in links if r["thesis_id"] in by_id}

    out: dict[str, tuple[str, str, Optional[int]]] = {}
    for yf_sym in book["symbols"]:
        tally: dict[str, float] = {}
        # Option exposure on a symbol with no stock lot: match on the underlying
        # (its label reads "NVDA (options Δ)").
        lots = book["lots"].get(yf_sym) or [("", book["name"].get(yf_sym, yf_sym).split(" ")[0], 1.0)]
        for trade_id, symbol, val in lots:
            t = by_id.get(linked.get(trade_id, "")) or by_symbol.get(symbol.upper())
            tid = t["id"] if t else NONE_KEY
            tally[tid] = tally.get(tid, 0.0) + abs(val)
        tid = max(tally, key=tally.get)
        t = by_id.get(tid)
        out[yf_sym] = (tid, (t["title"] or t["symbol"]) if t else "ไม่มี thesis",
                       t["conviction"] if t else None)
    return out


@router.get("/budget")
def get_risk_budget(
    account_id: Optional[str] = Query(None),
    scope: str = Query("symbol"),
    lookback: int = Query(252),
    base_currency: str = Query("THB"),
):
    """Risk in use against the budget, per bucket (`scope` = symbol | sector |
    thesis) and for the whole book (volatility cap). Same weights and
    covariance as /metrics. Model: backend/risk_budget.py."""
    import risk_budget
    from fastapi import HTTPException

    if scope not in risk_budget.SCOPES:
        raise HTTPException(status_code=400, detail=f"scope must be one of {risk_budget.SCOPES}")
    base = report_currency(base_currency)
    budget = _risk_budget_saved(account_id)
    book = _risk_book(account_id, base)
    out = {"account_id": account_id or "all", "base_currency": base,
           "as_of": date.today().isoformat(), "budget": budget.as_dict(),
           "lookback_days": 0, "excluded": []}

    rets, excluded = (pd.DataFrame(), [])
    if book["symbols"]:
        rets, excluded = _aligned_returns(book["symbols"], lookback, ccy_map=book["ccy"],
                                          base_currency=base)
    valid = list(rets.columns) if not rets.empty else []
    out["excluded"] = excluded
    if not valid:
        return {**out, **risk_budget.plan([], np.zeros((0, 0)), budget, scope, book["nav"])}

    cov = _ledoit_wolf_shrinkage(rets.values)
    w = _book_weights(book, valid)
    theses = _budget_theses(book) if scope == "thesis" else {}
    items = []
    for s, wi in zip(valid, w):
        item = {"symbol": book["name"].get(s, s), "weight": float(wi), "value": book["value"][s]}
        if scope == "symbol":
            item.update(key=s, label=book["name"].get(s, s))
        elif scope == "sector":
            sec = book["sector"].get(s) or ("Options" if not book["lots"].get(s) else "Other")
            item.update(key=sec, label=sec)
        else:
            tid, title, conviction = theses[s]
            item.update(key=tid, label=title, meta={"conviction": conviction})
        items.append(item)
    out["lookback_days"] = int(len(rets))
    return {**out, **risk_budget.plan(items, cov, budget, scope, book["nav"])}


class RiskBudgetIn(BaseModel):
    account_id: Optional[str] = None
    scope: Optional[str] = None                 # with `budgets`: the scope they replace
    budgets: Optional[dict[str, float]] = None  # key → % of total risk; replaces the scope's set
    vol_cap_pct: Optional[float] = None         # sent as null = clear the cap
    band_pp: Optional[float] = None


@router.put("/budget")
def put_risk_budget(body: RiskBudgetIn):
    """Save budgets. `budgets` replaces the whole set of `scope`; the cap and
    the band change only when sent."""
    import risk_budget
    from fastapi import HTTPException

    cur = _risk_budget_saved(body.account_id).as_dict()
    if body.budgets is not None:
        if body.scope not in risk_budget.TARGET_SCOPES:
            raise HTTPException(status_code=400,
                                detail=f"scope must be one of {risk_budget.TARGET_SCOPES}")
        cur[body.scope] = {k: v for k, v in body.budgets.items() if v is not None}
    if "vol_cap_pct" in body.model_fields_set:
        cur["vol_cap_pct"] = body.vol_cap_pct
    if body.band_pp is not None:
        cur["band_pp"] = body.band_pp
    try:
        budget = risk_budget.Budget.from_dict(cur)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    with get_db() as conn:
        conn.execute(
            "INSERT INTO risk_budgets (account_id, budget_json, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(account_id) DO UPDATE SET budget_json = excluded.budget_json, "
            "updated_at = excluded.updated_at",
            (body.account_id or "all", json.dumps(budget.as_dict(), ensure_ascii=False),
             datetime.now().isoformat(timespec="seconds")),
        )
        conn.commit()
    return {"budget": budget.as_dict()}


@router.delete("/budget")
def delete_risk_budget(account_id: Optional[str] = Query(None)):
    """Forget every budget of this book view (all scopes, cap, band)."""
    import risk_budget

    with get_db() as conn:
        conn.execute("DELETE FROM risk_budgets WHERE account_id = ?", (account_id or "all",))
        conn.commit()
    return {"budget": risk_budget.Budget().as_dict()}


# ── VaR forecast log (live out-of-sample test) ───────────────────────────────

def _record_var_forecast(account_id: str = "all", confidence: float = 0.95) -> Optional[dict]:
    """Write today's VaR forecast for the book once (no-op if already written).

    Judged later against the NEXT trading day's return of exactly these
    holdings (GET /risk/var-backtest), so it can never see its own outcome.
    """
    today = datetime.now().date().isoformat()
    with get_db() as conn:
        if conn.execute(
            "SELECT 1 FROM var_forecasts WHERE forecast_date = ? AND account_id = ?",
            (today, account_id),
        ).fetchone():
            return None
    positions = _open_positions_priced(None if account_id == "all" else account_id)
    cash, opt = _risk_extras(account_id, "THB")
    m = _compute_portfolio_risk(positions, 252, confidence, "THB", cash_base=cash, extra_exposure=opt)
    assets = m.get("assets") or []
    if not assets:
        return None
    ccy = {}
    for p in positions:
        y = _position_yf_symbol(p)
        if y:
            ccy.setdefault(y, trade_currency(p))
    holdings = {a["yf_symbol"]: {"w": a["weight_pct"] / 100, "ccy": ccy.get(a["yf_symbol"], "THB")}
                for a in assets}
    row = {
        "forecast_date": today, "account_id": account_id, "confidence": confidence,
        "var_hist_pct": m.get("var_historical_pct"), "cvar_pct": m.get("cvar_pct"),
        "var_cf_pct": m.get("var_cf_pct"), "cvar_mc_pct": m.get("cvar_mc_pct"),
        "ensemble_pct": m.get("ensemble_conservative_pct"),
        "portfolio_value": m.get("portfolio_value"),
    }
    with get_db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO var_forecasts (forecast_date, account_id, confidence, var_hist_pct, "
            "cvar_pct, var_cf_pct, cvar_mc_pct, ensemble_pct, portfolio_value, holdings) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (*row.values(), json.dumps(holdings)),
        )
        conn.commit()
    return row


def _evaluate_var_forecasts(forecasts: list[dict], returns: "pd.DataFrame") -> dict:
    """Pure: score each forecast against the first return dated AFTER it.

    `returns` = date-indexed base-currency LOG returns per yf symbol. A
    forecast's realized loss is the next trading day's simple return of its
    own weights (renormalised over the symbols that have a return that day).
    """
    methods = {"hist": "var_hist_pct", "cvar": "cvar_pct", "cf": "var_cf_pct", "ensemble": "ensemble_pct"}
    rows, pending = [], 0
    idx = returns.index if not returns.empty else pd.DatetimeIndex([])
    for f in sorted(forecasts, key=lambda r: r["forecast_date"]):
        d = pd.Timestamp(f["forecast_date"])
        later = idx[idx > d]
        if not len(later):
            pending += 1
            continue
        day = later[0]
        h = json.loads(f["holdings"]) if isinstance(f["holdings"], str) else f["holdings"]
        r = returns.loc[day]
        w = {s: v["w"] for s, v in h.items() if s in r.index and pd.notna(r[s])}
        tot = sum(w.values())
        w_all = sum(v["w"] for v in h.values())
        if tot <= 0:
            pending += 1
            continue
        # Weights are NAV-basis (cash = the missing part), so the book's return
        # is Σ w·r; only a symbol with no return that day is spread over the rest.
        realized = sum(wi * float(np.expm1(r[s])) for s, wi in w.items()) * (w_all / tot) * 100
        row = {"forecast_date": f["forecast_date"], "return_date": day.date().isoformat(),
               "realized_pct": round(realized, 3),
               "coverage_pct": round(tot / w_all * 100, 1) if w_all else 0.0}
        for k, col in methods.items():
            v = f.get(col)
            row[k] = v
            row[f"{k}_exception"] = bool(v is not None and realized < -float(v))
        rows.append(row)

    conf = float(forecasts[0]["confidence"]) if forecasts else 0.95
    summary = {}
    for k in methods:
        n = sum(1 for r in rows if r.get(k) is not None)
        e = sum(1 for r in rows if r.get(f"{k}_exception"))
        rate = e / n if n else 0.0
        exp = 1 - conf
        summary[k] = {
            "n": n, "exceptions": e, "rate_pct": round(rate * 100, 2),
            "expected_pct": round(exp * 100, 2),
            "kupiec_p": round(_kupiec_pvalue(e, n, conf), 4) if n >= 30 else None,
            "signal": ("INSUFFICIENT_DATA" if n < 30 else
                       "GREEN" if rate <= exp else "YELLOW" if rate <= exp * 1.6 else "RED"),
        }
    return {"rows": list(reversed(rows)), "summary": summary, "pending": pending,
            "confidence": conf, "first_forecast": forecasts[0]["forecast_date"] if forecasts else None}


@router.get("/var-backtest")
def get_var_backtest(account_id: str = Query("all")):
    """Live VaR test: each day's logged forecast vs the next trading day's
    return of the holdings it was made for. Needs ~30 days before Kupiec means
    anything; until then `signal` = INSUFFICIENT_DATA."""
    with get_db() as conn:
        forecasts = [dict(r) for r in conn.execute(
            "SELECT * FROM var_forecasts WHERE account_id = ? ORDER BY forecast_date",
            (account_id,),
        ).fetchall()]
    if not forecasts:
        return {"rows": [], "summary": {}, "pending": 0, "first_forecast": None,
                "note": "no forecasts logged yet — the guard notifier writes one per day"}
    ccy: dict[str, str] = {}
    for f in forecasts:
        for s, v in json.loads(f["holdings"]).items():
            ccy.setdefault(s, v.get("ccy") or "THB")
    first = pd.Timestamp(forecasts[0]["forecast_date"])
    days = max(30, int((pd.Timestamp.now() - first).days * 0.8) + 15)
    rets, _ = _aligned_returns(sorted(ccy), days, ccy_map=ccy, base_currency="THB", min_history=1)
    out = _evaluate_var_forecasts(forecasts, rets)
    out["account_id"] = account_id
    return out
