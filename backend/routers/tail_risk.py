"""
Tail Risk Monitor v2 — six risk dimensions over fresh volatility data.

GET /api/tail-risk/signals   — dimension scores, signal states, vol table, history
GET /api/tail-risk/vix-term  — VIX9D / VIX / VIX3M / VIX6M term structure

Three rules this module is built around, each of which v1 broke:

1. **Never judge on stale data.** Every signal is tri-state — `on`, `off`, or
   `unknown` — and a series that fails `vol_indices` freshness checks yields
   `unknown` with a reason. v1 read `dropna().iloc[-1]` off a VIX9D feed that
   had been frozen for 28 days and reported a term-structure inversion that did
   not exist; that was the only "active" signal on the board.

2. **One code path per signal.** The vol and flow signals are computed as full
   boolean Series; "today" is the last row and "history" is the last 90 rows of
   the *same* frame. v1 computed the header and the history chart separately and
   they disagreed on the same day.

3. **Count evidence, not restatements.** Three VIX signals firing together is
   one observation about equity vol, not three. The composite gate counts
   dimensions in ALERT, not raw signals.

Signals with no backtest behind them (the VVIX/SKEW/OVX/GVZ family added in v2)
are labelled UNVALIDATED rather than shown with blank statistics.
"""

from __future__ import annotations

import warnings
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import yfinance as yf
from fastapi import APIRouter

from cache import TTLCache
from vol_indices import VolFrame, load_vol_indices

router = APIRouter(prefix="/api/tail-risk", tags=["tail-risk"])

_cache = TTLCache(ttl=300)       # 5-min result cache
_yf_cache = TTLCache(ttl=270)    # SPY/AGG OHLCV
_dcc_cache = TTLCache(ttl=290)   # DCC asset returns

# ─── Dimensions ───────────────────────────────────────────────────────────────

DIMENSIONS: dict[str, dict] = {
    "equity_vol": {
        "label": "EQUITY VOL",
        "question": "Is equity volatility abnormal right now?",
        "order": 1,
    },
    "tail_pricing": {
        "label": "TAIL PRICING",
        "question": "Is the market paying up for crash protection?",
        "order": 2,
    },
    "cross_asset_vol": {
        "label": "CROSS-ASSET VOL",
        "question": "Is the stress confined to equities or spreading?",
        "order": 3,
    },
    "credit_stress": {
        "label": "CREDIT / STRESS",
        "question": "Are financial conditions tightening?",
        "order": 4,
    },
    "flow_positioning": {
        "label": "FLOW / POSITIONING",
        "question": "Is there actual selling, or just nerves?",
        "order": 5,
    },
    "correlation": {
        "label": "CORRELATION",
        "question": "Is everything starting to move as one?",
        "order": 6,
    },
}

# ─── Backtest stats (2026-06-07 suite, IS 2015-2022 @ L2 −3% / 5-day) ─────────
# Only the signals that were actually backtested appear here. Anything missing
# is reported as UNVALIDATED instead of rendering empty statistic slots.

_BACKTEST: dict[str, dict] = {
    "vix_term_inversion": {"prec_is": 0.168, "rec_is": 0.875, "fires_is": 0.254, "fires_oos": 0.278, "verdict": "USEFUL"},
    "vix_level":          {"prec_is": 0.198, "rec_is": 0.844, "fires_is": 0.170, "fires_oos": 0.089, "verdict": "USEFUL"},
    "vix_momentum":       {"prec_is": 0.186, "rec_is": 0.656, "fires_is": 0.107, "fires_oos": 0.063, "verdict": "USEFUL"},
    "hy_spread":          {"prec_is": 0.055, "rec_is": 0.219, "fires_is": 0.026, "fires_oos": 0.000, "verdict": "WEAK"},
    "stl_fsi":            {"prec_is": 0.080, "rec_is": 0.531, "fires_is": 0.286, "fires_oos": 0.020, "verdict": "USEFUL"},
    "nfci":               {"prec_is": 0.333, "rec_is": 0.156, "fires_is": 0.018, "fires_oos": 0.000, "verdict": "SENSITIVE"},
    "fg_extreme_fear":    {"prec_is": 0.143, "rec_is": 0.438, "fires_is": 0.124, "fires_oos": 0.028, "verdict": "USEFUL"},
    "sector_convergent":  {"prec_is": 0.055, "rec_is": 0.906, "fires_is": 0.504, "fires_oos": 0.581, "verdict": "SENSITIVE"},
    "rsi_oversold":       {"prec_is": 0.265, "rec_is": 0.219, "fires_is": 0.026, "fires_oos": 0.012, "verdict": "USEFUL"},
    "layer_a_bearish":    {"prec_is": 0.098, "rec_is": 0.781, "fires_is": 0.487, "fires_oos": 0.496, "verdict": "SENSITIVE"},
    "volume_surge":       {"prec_is": 0.125, "rec_is": 0.156, "fires_is": 0.080, "fires_oos": 0.028, "verdict": "USEFUL"},
    "crisis_composite":   {"prec_is": 1.000, "rec_is": 0.031, "fires_is": 0.004, "fires_oos": 0.000, "verdict": "SENSITIVE"},
    # DCC backtest 2026-06-07 (SPIKE+, L1 −1.5%, 5-day lookahead)
    "dcc_v1":  {"prec_is": 0.35, "rec_is": 0.41, "fires_is": 0.229, "fires_oos": 0.028,
                "verdict": "MIXED", "prec_oos": 0.21, "prec_fwd": 0.15, "edge_fwd_pp": 8},
    "dcc_hmm": {"prec_is": 0.32, "rec_is": 0.30, "fires_is": 0.211, "fires_oos": 0.048,
                "verdict": "MIXED", "prec_oos": 0.33, "prec_fwd": 0.24, "edge_fwd_pp": 18,
                "note": "EXTREME level alone: 58% precision / +55pp edge on OOS"},
}

SIGNAL_META: dict[str, dict] = {
    # ── equity_vol ────────────────────────────────────────────────────────────
    "vix_level": {
        "label": "VIX Spike", "dimension": "equity_vol",
        "rule": "VIX 20d z-score > 1.5, or VIX > 30 absolute",
        "why": "Realized panic bid in index options",
    },
    "vix_momentum": {
        "label": "VIX Momentum", "dimension": "equity_vol",
        "rule": "VIX up ≥ 20% over 5 sessions",
        "why": "Fear accelerating, not just elevated",
    },
    "vix_term_inversion": {
        "label": "VIX Term Inversion", "dimension": "equity_vol",
        "rule": "VIX9D > VIX (front) or VIX > VIX3M (back)",
        "why": "Near-dated hedges bid above longer ones — classic stress shape",
    },
    # ── tail_pricing ──────────────────────────────────────────────────────────
    "skew_elevated": {
        "label": "SKEW > 145", "dimension": "tail_pricing",
        "rule": "CBOE SKEW index > 145",
        "why": "OTM puts expensive relative to ATM — crash insurance being bought",
    },
    "vvix_elevated": {
        "label": "VVIX > 110", "dimension": "tail_pricing",
        "rule": "VVIX > 110",
        "why": "Vol-of-vol bid: the options on VIX itself are being hedged",
    },
    "vvix_vix_ratio": {
        "label": "VVIX/VIX Stretch", "dimension": "tail_pricing",
        "rule": "VVIX ÷ VIX 63d z-score > 1.5",
        "why": "Convexity demand outrunning spot vol — hedging ahead of the move",
    },
    # ── cross_asset_vol ───────────────────────────────────────────────────────
    "ovx_spike": {
        "label": "Oil Vol (OVX)", "dimension": "cross_asset_vol",
        "rule": "OVX 63d z-score > 1.5",
        "why": "Energy shock channel — separate driver from equity vol",
    },
    "gvz_spike": {
        "label": "Gold Vol (GVZ)", "dimension": "cross_asset_vol",
        "rule": "GVZ 63d z-score > 1.5",
        "why": "Stress in the haven itself — monetary/currency rather than growth",
    },
    "vxn_vix_spread": {
        "label": "VXN−VIX Spread", "dimension": "cross_asset_vol",
        "rule": "(VXN − VIX) 63d z-score > 1.5",
        "why": "Risk concentrated in tech rather than the broad market",
    },
    # ── credit_stress ─────────────────────────────────────────────────────────
    "hy_spread": {
        "label": "HY Spread", "dimension": "credit_stress",
        "rule": "US HY OAS above crisis.py threshold",
        "why": "Corporate credit repricing default risk",
    },
    "stl_fsi": {
        "label": "STL Financial Stress", "dimension": "credit_stress",
        "rule": "St. Louis Fed FSI > 0 (weekly)",
        "why": "Broad funding/market stress composite",
    },
    "nfci": {
        "label": "Chicago NFCI", "dimension": "credit_stress",
        "rule": "Chicago Fed NFCI > 0 (weekly)",
        "why": "Financial conditions tighter than average",
    },
    "crisis_composite": {
        "label": "Crisis Composite", "dimension": "credit_stress",
        "rule": "/api/crisis level ≥ 2",
        "why": "Multi-indicator crisis gate from the credit router",
    },
    # ── flow_positioning ──────────────────────────────────────────────────────
    "rsi_oversold": {
        "label": "SPY RSI < 35", "dimension": "flow_positioning",
        "rule": "SPY 14d Wilder RSI < 35",
        "why": "Price already in forced-selling territory",
    },
    "volume_surge": {
        "label": "Volume Surge", "dimension": "flow_positioning",
        "rule": "SPY volume 63d z-score > 2",
        "why": "Institutional liquidation leaves a volume print",
    },
    "layer_a_bearish": {
        "label": "SPY vs AGG (Layer A)", "dimension": "flow_positioning",
        "rule": "20d SPY−AGG relative return, 252d z-score < −0.5",
        "why": "Money actually rotating from equities into bonds",
    },
    "fg_extreme_fear": {
        "label": "Fear & Greed < 25", "dimension": "flow_positioning",
        "rule": "CNN Fear & Greed < 25",
        "why": "Sentiment at capitulation levels",
    },
    # ── correlation ───────────────────────────────────────────────────────────
    "dcc_v1": {
        "label": "DCC Corr Spike (V1)", "dimension": "correlation",
        "rule": "EWMA-DCC cross-asset correlation ≥ SPIKE (z > 2 or pctile > 85)",
        "why": "Diversification failing across the 7-asset pool",
    },
    "dcc_hmm": {
        "label": "DCC HMM Regime (V3)", "dimension": "correlation",
        "rule": "HMM crisis-state probability ≥ 55%",
        "why": "Correlation regime shift rather than a single spike",
    },
    "sector_convergent": {
        "label": "Sector Convergence", "dimension": "correlation",
        "rule": "Regime label = CONVERGENT",
        "why": "All 11 sectors moving together — risk-off herding",
    },
}

# Signals whose history can be reconstructed from a continuous daily series.
# The rest (credit, DCC, regime) are point-in-time only and are excluded from
# the history chart rather than back-filled with a guess.
_HISTORICAL_SIGNALS = (
    "vix_level", "vix_momentum", "vix_term_inversion",
    "skew_elevated", "vvix_elevated", "vvix_vix_ratio",
    "ovx_spike", "gvz_spike", "vxn_vix_spread",
    "rsi_oversold", "volume_surge", "layer_a_bearish",
)

_DCC_ASSETS = ["SPY", "QQQ", "TLT", "GLD", "NVDA", "HYG", "XLF"]
_DCC_RANK = {"NORMAL": 0, "CAUTION": 1, "SPIKE": 2, "EXTREME": 3}

# ─── Small helpers ────────────────────────────────────────────────────────────


def _call_internal(name: str) -> tuple[dict, bool]:
    """Read another router's data by calling its handler in this process.

    v1 issued an HTTP request to its own port for each of these. That hardcoded
    the port, burned a second threadpool slot per dependency, and — the
    reason it actually mattered — timed out at 10s whenever the upstream cache
    was cold, which downgraded every credit and regime signal to `unknown` on
    exactly the requests that took the longest. The handlers are plain sync
    functions over their own module-level caches, so calling them directly is
    both faster and honest about what it is doing.

    Imports are local to dodge a module-level cycle: ticker.py reads this
    module's DCC cache.
    """
    try:
        if name == "crisis":
            from routers.crisis import get_crisis

            return get_crisis(), True
        if name == "fear_greed":
            from routers.fear_greed import get_current

            return get_current(), True
        if name == "ticker":
            from routers.ticker import get_ticker

            return get_ticker(account_id="all"), True
        raise ValueError(f"unknown internal source {name!r}")
    except Exception as exc:
        print(f"[tail_risk] internal call failed {name}: {exc}")
        return {}, False


def _rolling_z(s: pd.Series, window: int) -> pd.Series:
    mu = s.rolling(window, min_periods=window).mean()
    sd = s.rolling(window, min_periods=window).std()
    return (s - mu) / sd.replace(0, np.nan)


def _wilder_rsi(prices: pd.Series, period: int = 14) -> pd.Series:
    """Wilder smoothing — matches the RSI drawn on the app's charts. v1 used a
    simple moving average here, so the number on this page disagreed with the
    number on the chart for the same symbol and period."""
    delta = prices.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - 100 / (1 + rs)
    # A window with no down-closes divides by zero above. That is RSI 100, not
    # "no reading" — leaving it NaN would silently turn the signal unknown.
    warmed = avg_gain.notna() & avg_loss.notna()
    rsi = rsi.mask(warmed & (avg_loss == 0) & (avg_gain > 0), 100.0)
    rsi = rsi.mask(warmed & (avg_loss == 0) & (avg_gain == 0), 50.0)
    return rsi


def _last_bool(s: pd.Series | None) -> bool | None:
    """Last value of a boolean series as a tri-state. None when there is no
    usable observation, so the caller reports `unknown`."""
    if s is None or len(s) == 0:
        return None
    v = s.dropna()
    if v.empty:
        return None
    return bool(v.iloc[-1])


# ─── DCC (unchanged maths, v1 + v3) ───────────────────────────────────────────


def _fetch_dcc_prices() -> pd.DataFrame | None:
    def compute() -> pd.DataFrame | None:
        start = (datetime.now() - timedelta(days=600)).strftime("%Y-%m-%d")
        try:
            raw = yf.download(_DCC_ASSETS, start=start, auto_adjust=True, progress=False)
            if raw.empty:
                return None
            close = raw["Close"] if isinstance(raw.columns, pd.MultiIndex) or "Close" in raw.columns else raw
            close = close.dropna(how="all").tail(420)
            available = close.columns[close.notna().sum() >= 20].tolist()
            if len(available) < 4:
                return None
            close = close[available].ffill(limit=3).dropna()
            ret = np.log(close / close.shift(1)).dropna().tail(400)
            return ret if len(ret) >= 50 else None
        except Exception as exc:
            print(f"[tail_risk] DCC fetch error: {exc}")
            return None

    return _dcc_cache.get_or_set("prices", compute)


def _compute_dcc_v1_signal(ret: pd.DataFrame, lambda_: float = 0.94) -> str:
    """EWMA-DCC symmetric signal (v1, production model)."""
    R = ret.values
    T, n = R.shape
    if T < 30 or n < 2:
        return "NORMAL"

    H = np.zeros((T, n))
    H[0] = np.maximum(np.var(R[: min(20, T)], axis=0), 1e-12)
    for t in range(1, T):
        H[t] = lambda_ * H[t - 1] + (1 - lambda_) * R[t - 1] ** 2
    H = np.maximum(H, 1e-12)
    eps = R / np.sqrt(H)

    Q = np.zeros((T, n, n))
    Q[0] = np.eye(n)
    for t in range(1, T):
        Q[t] = lambda_ * Q[t - 1] + (1 - lambda_) * np.outer(eps[t - 1], eps[t - 1])

    avg_corr: list[float] = []
    for t in range(T):
        q_diag = np.sqrt(np.maximum(np.diag(Q[t]), 1e-10))
        c = Q[t] / np.outer(q_diag, q_diag)
        off = [abs(float(c[i][j])) for i in range(n) for j in range(i + 1, n)]
        avg_corr.append(float(np.mean(off)) if off else 0.0)

    arr = np.array(avg_corr)
    current = arr[-1]
    z = (current - arr.mean()) / (arr.std() + 1e-8)
    pctile = float(np.mean(arr <= current) * 100)
    trend_slope = float(np.polyfit(range(min(10, len(arr))), arr[-min(10, len(arr)):], 1)[0])

    if z > 3.0 or pctile > 95:
        return "EXTREME"
    if z > 2.0 or pctile > 85:
        return "SPIKE"
    if z > 1.0 or pctile > 70 or trend_slope > 0.003:
        return "CAUTION"
    return "NORMAL"


def _compute_dcc_v3_signal(ret: pd.DataFrame, corr_window: int = 21) -> str:
    """HMM 2-regime signal (v3). Returns NORMAL when hmmlearn is absent."""
    try:
        from hmmlearn.hmm import GaussianHMM

        warnings.filterwarnings("ignore")
    except ImportError:
        return "NORMAL"

    R = ret.values
    T, n = R.shape
    if T < corr_window + 30 or n < 2:
        return "NORMAL"

    corr_series: list[float] = []
    for t in range(corr_window, T + 1):
        w = R[t - corr_window:t]
        c = np.corrcoef(w.T)
        off = [abs(float(c[i][j])) for i in range(n) for j in range(i + 1, n)]
        corr_series.append(float(np.mean(off)) if off else 0.0)

    if len(corr_series) < 40:
        return "NORMAL"

    arr = np.array(corr_series)
    is_len = max(30, int(len(arr) * 0.70))
    try:
        # Seeded: hmmlearn initialises from a global RNG, so the same input
        # produced different regimes on consecutive refreshes (observed
        # NORMAL then SPIKE minutes apart on identical data) and the ticker
        # alert flapped with it. The model spec is unchanged — only the draw
        # is now reproducible.
        model = GaussianHMM(n_components=2, covariance_type="diag", n_iter=100, random_state=42)
        model.fit(arr[:is_len].reshape(-1, 1))
        crisis_state = int(np.argmax(model.means_.flatten()))
        pred_obs = arr[-corr_window:].reshape(-1, 1)
        states = model.predict(pred_obs)
        probs = model.predict_proba(pred_obs)
        crisis_frac = float(np.mean(states == crisis_state))
        crisis_prob = float(probs[-1, crisis_state])
    except Exception:
        return "NORMAL"

    if crisis_prob > 0.80 and crisis_frac > 0.50:
        return "EXTREME"
    if crisis_prob > 0.55 or crisis_frac > 0.55:
        return "SPIKE"
    if crisis_prob > 0.35:
        return "CAUTION"
    return "NORMAL"


def _dcc_levels() -> tuple[str, str]:
    """(v1, v3) correlation levels, computed once per cache window.

    Own cache key so `get_cached_dcc_signals` can serve the ticker without
    waiting on — or duplicating — the full signal computation.
    """

    def compute() -> tuple[str, str]:
        ret = _fetch_dcc_prices()
        if ret is None:
            return "UNKNOWN", "UNKNOWN"
        return _compute_dcc_v1_signal(ret), _compute_dcc_v3_signal(ret)

    return _dcc_cache.get_or_set("levels", compute)


def get_cached_dcc_signals() -> tuple[str, str]:
    """Public: (v1, v3) levels for ticker.py alerts. Cache-only by design — the
    ticker refreshes every 60s and must not block on a 7-asset download plus an
    HMM fit.

    Returns UNKNOWN, not NORMAL, on a cold cache. v1 returned NORMAL, which the
    ticker could not distinguish from a genuine all-clear, so a cold start
    reported calm correlation rather than "not measured yet".
    """
    cached = _dcc_cache.get("levels")
    if cached:
        return cached
    return "UNKNOWN", "UNKNOWN"


# ─── Market data (SPY / AGG) ──────────────────────────────────────────────────


def _fetch_market() -> pd.DataFrame | None:
    """Two years of SPY + AGG. v1 pulled 70 calendar days (~48 trading days),
    which silently starved the Layer-A signal's 252d/60-min_periods window — it
    could never produce a value, so it never once fired."""

    def compute() -> pd.DataFrame | None:
        try:
            raw = yf.download(["SPY", "AGG"], period="2y", auto_adjust=True, progress=False)
            if raw is None or raw.empty:
                return None
            out = pd.DataFrame(
                {
                    "spy": raw["Close"]["SPY"],
                    "agg": raw["Close"]["AGG"],
                    "spy_vol": raw["Volume"]["SPY"],
                }
            ).dropna(subset=["spy"])
            return out
        except Exception as exc:
            print(f"[tail_risk] market fetch error: {exc}")
            return None

    return _yf_cache.get_or_set("spy_agg", compute)


# ─── Signal frames — one code path for "now" and for "history" ────────────────


def _vol_signal_frame(vf: VolFrame) -> tuple[pd.DataFrame, dict[str, str]]:
    """Boolean series per vol-based signal, plus a reason for each omission.

    A signal is present as a column only when its inputs passed the freshness
    check. Missing column ⇒ the caller reports `unknown`, never `off`.
    """
    cols: dict[str, pd.Series] = {}
    missing: dict[str, str] = {}

    def reason(*names: str) -> str:
        bad = [n for n in names if not vf.usable(n)]
        details = []
        for n in bad:
            h = vf.health.get(n)
            details.append(f"{n}: {h.reason if h else 'unavailable'}")
        return "; ".join(details) or "unavailable"

    vix = vf.get("VIX")

    # ── equity_vol ────────────────────────────────────────────────────────────
    if vix is not None:
        cols["vix_level"] = (_rolling_z(vix, 20) > 1.5) | (vix > 30)
        cols["vix_momentum"] = vix.pct_change(5) >= 0.20
    else:
        missing["vix_level"] = reason("VIX")
        missing["vix_momentum"] = reason("VIX")

    v9d, v3m = vf.get("VIX9D"), vf.get("VIX3M")
    if vix is not None and (v9d is not None or v3m is not None):
        # Each CBOE series has its own start date, so align to the VIX calendar
        # before comparing — pandas refuses to compare differently-labelled
        # Series, and silently unioning them would invent bars.
        blank = pd.Series(False, index=vix.index)
        front = (v9d.reindex(vix.index) > vix) if v9d is not None else blank
        back = (vix > v3m.reindex(vix.index)) if v3m is not None else blank
        cols["vix_term_inversion"] = front.fillna(False) | back.fillna(False)
    else:
        missing["vix_term_inversion"] = reason("VIX", "VIX9D", "VIX3M")

    # ── tail_pricing ──────────────────────────────────────────────────────────
    skew = vf.get("SKEW")
    if skew is not None:
        cols["skew_elevated"] = skew > 145
    else:
        missing["skew_elevated"] = reason("SKEW")

    vvix = vf.get("VVIX")
    if vvix is not None:
        cols["vvix_elevated"] = vvix > 110
    else:
        missing["vvix_elevated"] = reason("VVIX")

    if vvix is not None and vix is not None:
        ratio = (vvix / vix.replace(0, np.nan)).dropna()
        cols["vvix_vix_ratio"] = _rolling_z(ratio, 63) > 1.5
    else:
        missing["vvix_vix_ratio"] = reason("VVIX", "VIX")

    # ── cross_asset_vol ───────────────────────────────────────────────────────
    for sig, name in (("ovx_spike", "OVX"), ("gvz_spike", "GVZ")):
        s = vf.get(name)
        if s is not None:
            cols[sig] = _rolling_z(s, 63) > 1.5
        else:
            missing[sig] = reason(name)

    vxn = vf.get("VXN")
    if vxn is not None and vix is not None:
        spread = (vxn - vix).dropna()
        cols["vxn_vix_spread"] = _rolling_z(spread, 63) > 1.5
    else:
        missing["vxn_vix_spread"] = reason("VXN", "VIX")

    if not cols:
        return pd.DataFrame(), missing

    # Align everything to the VIX calendar (or the longest series available).
    base = vix.index if vix is not None else max(
        (s.index for s in cols.values()), key=len
    )
    # reindex(fill_value=...) rather than reindex().fillna(): the latter goes
    # through an object-dtype round trip that pandas now warns about.
    frame = pd.DataFrame(
        {k: v.reindex(base, fill_value=False).astype(bool) for k, v in cols.items()}, index=base
    )
    return frame, missing


def _flow_signal_frame(market: pd.DataFrame | None) -> tuple[pd.DataFrame, dict[str, str]]:
    if market is None or market.empty:
        return pd.DataFrame(), {
            s: "SPY/AGG price data unavailable"
            for s in ("rsi_oversold", "volume_surge", "layer_a_bearish")
        }

    spy, agg, vol = market["spy"], market["agg"], market["spy_vol"]
    cols: dict[str, pd.Series] = {}
    missing: dict[str, str] = {}

    rsi = _wilder_rsi(spy, 14)
    cols["rsi_oversold"] = rsi < 35

    if len(vol.dropna()) >= 63:
        cols["volume_surge"] = _rolling_z(vol, 63) > 2.0
    else:
        missing["volume_surge"] = f"only {len(vol.dropna())} volume bars, need 63"

    rel20 = spy.pct_change(20) - agg.pct_change(20)
    daily = spy.pct_change() - agg.pct_change()
    if len(daily.dropna()) >= 252:
        z = (rel20 - daily.rolling(252).mean()) / daily.rolling(252).std().replace(0, np.nan)
        cols["layer_a_bearish"] = z < -0.5
    else:
        missing["layer_a_bearish"] = f"only {len(daily.dropna())} bars, need 252"

    frame = pd.DataFrame(
        {k: v.reindex(spy.index, fill_value=False).astype(bool) for k, v in cols.items()},
        index=spy.index,
    )
    return frame, missing


# ─── Assembly ─────────────────────────────────────────────────────────────────


def _state(active: bool | None, *, value=None, detail=None, reason=None) -> dict:
    return {
        "state": "unknown" if active is None else ("on" if active else "off"),
        "active": bool(active) if active is not None else None,
        "value": value,
        "detail": detail,
        "reason": reason,
    }


def _vol_table(vf: VolFrame) -> list[dict]:
    """The raw board: every index with level, 1-day change, z and percentile."""
    spec = [
        ("VIX", "S&P 500 30d implied vol"),
        ("VIX9D", "S&P 500 9d implied vol"),
        ("VIX3M", "S&P 500 3-month implied vol"),
        ("VIX6M", "S&P 500 6-month implied vol"),
        ("VVIX", "Vol-of-vol (options on VIX)"),
        ("SKEW", "Tail pricing, 100–150 typical"),
        ("VXN", "Nasdaq-100 implied vol"),
        ("OVX", "Crude oil implied vol"),
        ("GVZ", "Gold implied vol"),
    ]
    out = []
    for name, desc in spec:
        h = vf.health.get(name)
        out.append(
            {
                "name": name,
                "description": desc,
                "value": vf.value(name),
                "change_1d": vf.change_1d(name),
                "z63": vf.zscore(name, 63),
                "pctile_1y": vf.percentile(name, 252),
                "ok": bool(h and h.ok),
                "last_date": h.last_date if h else None,
                "source": h.source if h else None,
                "reason": h.reason if h else None,
            }
        )
    return out


def _compute() -> dict:
    vf = load_vol_indices()
    market = _fetch_market()

    vol_frame, vol_missing = _vol_signal_frame(vf)
    flow_frame, flow_missing = _flow_signal_frame(market)

    states: dict[str, dict] = {}

    # ── Series-derived signals: "now" is literally the last row of the frame
    #    used to draw the history, so the two can never disagree. ─────────────
    for frame, missing in ((vol_frame, vol_missing), (flow_frame, flow_missing)):
        for sig in frame.columns:
            states[sig] = _state(_last_bool(frame[sig]))
        for sig, why in missing.items():
            states[sig] = _state(None, reason=why)

    # Attach the readings behind the vol signals so the UI can show evidence.
    if "vix_level" in states:
        states["vix_level"]["value"] = vf.value("VIX")
        states["vix_level"]["detail"] = f"z63 {vf.zscore('VIX', 63)}"
    if "vix_momentum" in states and vf.get("VIX") is not None:
        chg = vf.get("VIX").pct_change(5).iloc[-1]
        states["vix_momentum"]["value"] = round(float(chg) * 100, 1) if pd.notna(chg) else None
        states["vix_momentum"]["detail"] = "5d %"
    for sig, name in (
        ("skew_elevated", "SKEW"),
        ("vvix_elevated", "VVIX"),
        ("ovx_spike", "OVX"),
        ("gvz_spike", "GVZ"),
    ):
        if sig in states:
            states[sig]["value"] = vf.value(name)
            states[sig]["detail"] = f"z63 {vf.zscore(name, 63)}"

    vix_v, v9_v, v3_v = vf.value("VIX"), vf.value("VIX9D"), vf.value("VIX3M")
    if "vix_term_inversion" in states and vix_v is not None:
        states["vix_term_inversion"]["detail"] = (
            f"9D {v9_v if v9_v is not None else '--'} / 30D {vix_v} / 3M {v3_v if v3_v is not None else '--'}"
        )
    if "vxn_vix_spread" in states:
        vxn_v = vf.value("VXN")
        if vxn_v is not None and vix_v is not None:
            states["vxn_vix_spread"]["value"] = round(vxn_v - vix_v, 2)
            states["vxn_vix_spread"]["detail"] = f"VXN {vxn_v} − VIX {vix_v}"
    if "vvix_vix_ratio" in states and vf.value("VVIX") is not None and vix_v:
        states["vvix_vix_ratio"]["value"] = round(vf.value("VVIX") / vix_v, 2)
        states["vvix_vix_ratio"]["detail"] = "VVIX ÷ VIX"

    rsi_now: float | None = None
    if market is not None and not market.empty:
        r = _wilder_rsi(market["spy"], 14).dropna()
        if not r.empty:
            rsi_now = round(float(r.iloc[-1]), 1)
    if "rsi_oversold" in states:
        states["rsi_oversold"]["value"] = rsi_now
        states["rsi_oversold"]["detail"] = "SPY 14d Wilder"

    if market is not None and not market.empty:
        vz = _rolling_z(market["spy_vol"], 63).dropna()
        if not vz.empty and states.get("volume_surge", {}).get("state") != "unknown":
            states["volume_surge"]["value"] = round(float(vz.iloc[-1]), 2)
            states["volume_surge"]["detail"] = "volume z63"
        daily = market["spy"].pct_change() - market["agg"].pct_change()
        rel20 = market["spy"].pct_change(20) - market["agg"].pct_change(20)
        if len(daily.dropna()) >= 252 and states.get("layer_a_bearish", {}).get("state") != "unknown":
            la = ((rel20 - daily.rolling(252).mean()) / daily.rolling(252).std().replace(0, np.nan)).dropna()
            if not la.empty:
                states["layer_a_bearish"]["value"] = round(float(la.iloc[-1]), 2)
                states["layer_a_bearish"]["detail"] = "SPY−AGG z252"

    # ── Credit / stress — from the crisis router ──────────────────────────────
    crisis, crisis_ok = _call_internal("crisis")
    c_sigs = crisis.get("signals", {}) if crisis_ok else {}
    for sig, key in (("hy_spread", "hy_spread"), ("stl_fsi", "stl_fsi"), ("nfci", "nfci")):
        if not crisis_ok:
            states[sig] = _state(None, reason="crisis router unavailable")
        elif key in c_sigs:
            entry = c_sigs[key]
            states[sig] = _state(
                bool(entry.get("triggered", False)),
                value=entry.get("value"),
                detail=entry.get("label") or entry.get("description"),
            )
        else:
            states[sig] = _state(None, reason=f"crisis router has no '{key}'")

    if crisis_ok and crisis.get("level") is not None:
        lvl = int(crisis["level"])
        states["crisis_composite"] = _state(lvl >= 2, value=lvl, detail=f"crisis level {lvl}/4")
    else:
        states["crisis_composite"] = _state(None, reason="crisis router unavailable")

    # ── Sentiment ─────────────────────────────────────────────────────────────
    fg, fg_ok = _call_internal("fear_greed")
    fg_value = fg.get("value") if fg_ok else None
    if fg_value is not None:
        states["fg_extreme_fear"] = _state(float(fg_value) < 25, value=round(float(fg_value), 1))
    else:
        states["fg_extreme_fear"] = _state(None, reason="fear & greed unavailable")

    # ── Regime ────────────────────────────────────────────────────────────────
    ticker_data, ticker_ok = _call_internal("ticker")
    regime_label, regime_score = None, None
    for item in ticker_data.get("items", []):
        if item.get("type") == "regime":
            regime_label = item.get("regime_label")
            regime_score = item.get("regime_score")
            break
    if regime_label is not None:
        states["sector_convergent"] = _state(
            regime_label == "CONVERGENT", value=regime_score, detail=f"regime {regime_label}"
        )
    else:
        states["sector_convergent"] = _state(
            None, reason="regime unavailable" if ticker_ok else "ticker router unavailable"
        )

    # ── Correlation (DCC) ─────────────────────────────────────────────────────
    dcc_v1, dcc_v3 = _dcc_levels()
    dcc_ok = dcc_v1 != "UNKNOWN"
    if dcc_ok:
        states["dcc_v1"] = _state(_DCC_RANK.get(dcc_v1, 0) >= 2, value=dcc_v1, detail=dcc_v1)
        states["dcc_hmm"] = _state(_DCC_RANK.get(dcc_v3, 0) >= 2, value=dcc_v3, detail=dcc_v3)
    else:
        states["dcc_v1"] = _state(None, reason="DCC asset download failed")
        states["dcc_hmm"] = _state(None, reason="DCC asset download failed")

    # ── Build signal payload ──────────────────────────────────────────────────
    signals_out = []
    for sig_id, meta in SIGNAL_META.items():
        st = states.get(sig_id) or _state(None, reason="not computed")
        bt = _BACKTEST.get(sig_id)
        signals_out.append(
            {
                "id": sig_id,
                "label": meta["label"],
                "dimension": meta["dimension"],
                "rule": meta["rule"],
                "why": meta["why"],
                "state": st["state"],
                "active": st["active"],
                "value": st["value"],
                "detail": st["detail"],
                "reason": st["reason"],
                "validated": bt is not None,
                "verdict": bt["verdict"] if bt else "UNVALIDATED",
                "stats": (
                    {
                        "prec_is": bt.get("prec_is"),
                        "rec_is": bt.get("rec_is"),
                        "fires_is": bt.get("fires_is"),
                        "fires_oos": bt.get("fires_oos"),
                        "prec_oos": bt.get("prec_oos"),
                        "prec_fwd": bt.get("prec_fwd"),
                        "edge_fwd_pp": bt.get("edge_fwd_pp"),
                        "note": bt.get("note"),
                    }
                    if bt
                    else None
                ),
            }
        )

    # ── Dimension scoring ─────────────────────────────────────────────────────
    dimensions_out = []
    for dim_id, dim in sorted(DIMENSIONS.items(), key=lambda kv: kv[1]["order"]):
        members = [s for s in signals_out if s["dimension"] == dim_id]
        on = [s for s in members if s["state"] == "on"]
        unknown = [s for s in members if s["state"] == "unknown"]
        if len(on) >= 2:
            status = "ALERT"
        elif len(on) == 1:
            status = "WATCH"
        elif len(unknown) == len(members) and members:
            status = "UNKNOWN"
        else:
            status = "NORMAL"
        dimensions_out.append(
            {
                "id": dim_id,
                "label": dim["label"],
                "question": dim["question"],
                "status": status,
                "on_count": len(on),
                "total": len(members),
                "unknown_count": len(unknown),
                "degraded": bool(unknown),
                "active_signals": [s["id"] for s in on],
                "unknown_signals": [s["id"] for s in unknown],
            }
        )

    alert_dims = [d["id"] for d in dimensions_out if d["status"] == "ALERT"]
    watch_dims = [d["id"] for d in dimensions_out if d["status"] == "WATCH"]

    # Counting dimensions, not signals: three VIX signals firing together is one
    # observation about equity vol restated three ways, and v1's ≥3-signal gate
    # could trip on that alone.
    if len(alert_dims) >= 3:
        risk_level = "HIGH"
    elif len(alert_dims) >= 2:
        risk_level = "ELEVATED"
    elif alert_dims or len(watch_dims) >= 2:
        risk_level = "CAUTION"
    else:
        risk_level = "NORMAL"

    # ── History — same frames, 90 sessions ────────────────────────────────────
    history: list[dict] = []
    hist_cols = [c for c in _HISTORICAL_SIGNALS if c in vol_frame.columns or c in flow_frame.columns]
    if hist_cols:
        parts = []
        if not vol_frame.empty:
            parts.append(vol_frame)
        if not flow_frame.empty:
            parts.append(flow_frame.reindex(vol_frame.index) if not vol_frame.empty else flow_frame)
        combined = pd.concat(parts, axis=1).fillna(False) if parts else pd.DataFrame()
        if not combined.empty:
            dim_of = {s: SIGNAL_META[s]["dimension"] for s in combined.columns if s in SIGNAL_META}
            tail = combined.tail(90)
            for date, row in tail.iterrows():
                per_dim: dict[str, int] = {}
                for sig, on in row.items():
                    if bool(on) and sig in dim_of:
                        per_dim[dim_of[sig]] = per_dim.get(dim_of[sig], 0) + 1
                history.append(
                    {
                        "date": date.strftime("%Y-%m-%d"),
                        "signals_on": int(sum(bool(v) for v in row.values)),
                        "alert_dimensions": sum(1 for c in per_dim.values() if c >= 2),
                    }
                )

    health = vf.health_payload()
    health["sources"] = {
        "cboe_vol_indices": health["ok"],
        "crisis_router": crisis_ok,
        "fear_greed_router": fg_ok,
        "ticker_router": ticker_ok,
        "spy_agg_prices": market is not None and not market.empty,
        "dcc_assets": dcc_ok,
    }
    health["unknown_signals"] = [s["id"] for s in signals_out if s["state"] == "unknown"]
    health["degraded_count"] = len(health["unknown_signals"])

    return {
        "ok": True,
        "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "data_date": vf.reference_date or "N/A",
        "risk_level": risk_level,
        "alert_dimensions": alert_dims,
        "watch_dimensions": watch_dims,
        "dimensions": dimensions_out,
        "signals": signals_out,
        "vol_table": _vol_table(vf),
        "vix_term": {
            "vix9d": vf.value("VIX9D"),
            "vix": vf.value("VIX"),
            "vix3m": vf.value("VIX3M"),
            "vix6m": vf.value("VIX6M"),
            "backwardation_front": (
                None if (v9_v is None or vix_v is None) else v9_v > vix_v
            ),
            "backwardation_back": (
                None if (vix_v is None or v3_v is None) else vix_v > v3_v
            ),
        },
        "fear_greed": round(float(fg_value), 1) if fg_value is not None else None,
        "spy_rsi": rsi_now,
        "sector_regime": regime_label,
        "sector_corr": regime_score,
        "crisis_level": crisis.get("level") if crisis_ok else None,
        "dcc_v1_signal": dcc_v1,
        "dcc_v3_signal": dcc_v3,
        "history": history,
        "data_health": health,
    }


# ─── Endpoints ────────────────────────────────────────────────────────────────


@router.get("/signals")
def get_signals():  # sync: blocking requests/yfinance — FastAPI runs it in a threadpool
    def build() -> dict:
        try:
            return _compute()
        except Exception as exc:  # never hand the UI a bare {}
            print(f"[tail_risk] compute failed: {exc}")
            return {
                "ok": False,
                "error": "signal computation failed",
                "detail": str(exc),
                "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "dimensions": [],
                "signals": [],
                "vol_table": [],
                "history": [],
                "data_health": {"ok": False, "degraded": ["all"], "indices": []},
            }

    return _cache.get_or_set("signals", build)


@router.get("/vix-term")
def get_vix_term():
    """Term structure only. Reads the same loader as /signals, so the two can no
    longer report different VIX9D values for the same day (they did in v1 —
    different yfinance windows landed in different caches)."""
    vf = load_vol_indices(("VIX", "VIX9D", "VIX3M", "VIX6M"))
    v9, v, v3, v6 = (vf.value(n) for n in ("VIX9D", "VIX", "VIX3M", "VIX6M"))
    return {
        "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "data_date": vf.reference_date,
        "vix9d": v9,
        "vix": v,
        "vix3m": v3,
        "vix6m": v6,
        "backwardation_front": None if (v9 is None or v is None) else v9 > v,
        "backwardation_back": None if (v is None or v3 is None) else v > v3,
        "health": vf.health_payload(),
    }
