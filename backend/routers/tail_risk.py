"""
Tail Risk Monitor — aggregates existing routers + computes VIX-specific signals.

GET /api/tail-risk/signals   — current signal status + 30-day history + precision metadata
GET /api/tail-risk/vix-term  — VIX9D / VIX / VIX3M term structure

Architecture (no FRED duplication):
  - Credit/stress signals  -> pulled from /api/crisis (already cached, FRED-backed)
  - Fear & Greed           -> pulled from /api/fear-greed (already cached, CNN primary)
  - Regime/sector          -> pulled from /api/ticker (already cached, regime router)
  - VIX backwardation/mom  -> yfinance: ^VIX, ^VIX9D, ^VIX3M only
  - RSI, Volume, Layer A   -> yfinance: SPY, AGG only
  - DCC v1 + v3 (HMM)     -> yfinance: 7 cross-assets (separate 5-min cache)
  Precision stats from backtest 2026-06-07 (IS/OOS/FWD, all 3 models).
"""
from __future__ import annotations

import math
import warnings
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import requests
import yfinance as yf
from fastapi import APIRouter

from cache import TTLCache

router = APIRouter(prefix="/api/tail-risk", tags=["tail-risk"])

_cache     = TTLCache(ttl=300)   # 5-min result cache
_yf_cache  = TTLCache(ttl=270)   # 4.5-min yfinance data cache
_dcc_cache = TTLCache(ttl=290)   # DCC data + signal cache (7 assets, 400d)

# ─── Internal base URL (same process, hits the router cache) ──────────────────
_BASE = "http://localhost:8000"

# ─── DCC v1 + v3 (HMM) ────────────────────────────────────────────────────────
# Assets: SPY, QQQ, TLT, GLD, NVDA, HYG, XLF — same as backtest suite
# Backtest 2026-06-07: v1 8/10 events, v3 HMM 9/10 events
# Best config: SPIKE+, L1=-1.5%, 5d lookahead
#   v1 OOS prec=21%/+18pp  FWD prec=15%/+8pp
#   v3 OOS prec=33%/+30pp  FWD prec=24%/+18pp  (v3 EXTREME OOS=58%/+55pp)

_DCC_ASSETS = ["SPY", "QQQ", "TLT", "GLD", "NVDA", "HYG", "XLF"]
_DCC_RANK   = {"NORMAL": 0, "CAUTION": 1, "SPIKE": 2, "EXTREME": 3}


def _fetch_dcc_prices() -> pd.DataFrame | None:
    """
    Download 7 DCC assets, return aligned log-return DataFrame (last 400 trading days).
    Uses separate cache to avoid bloating the 70-day VIX/SPY fetch.
    """
    cached = _dcc_cache.get("prices")
    if cached is not None:
        return cached

    start = (datetime.now() - timedelta(days=600)).strftime("%Y-%m-%d")
    try:
        raw = yf.download(_DCC_ASSETS, start=start, auto_adjust=True, progress=False)
        if raw.empty:
            return None
        # Handle MultiIndex columns from multi-ticker download
        if isinstance(raw.columns, pd.MultiIndex):
            close = raw["Close"]
        elif "Close" in raw.columns:
            close = raw["Close"]
        else:
            close = raw
        # Align columns, drop all-NaN rows, keep last 400 trading days
        close = close.dropna(how="all").tail(420)
        # Require at least 4 of 7 assets present
        available = close.columns[close.notna().sum() >= 20].tolist()
        if len(available) < 4:
            return None
        close = close[available].ffill(limit=3).dropna()
        ret = np.log(close / close.shift(1)).dropna().tail(400)
        if len(ret) < 50:
            return None
        _dcc_cache.set("prices", ret)
        return ret
    except Exception as e:
        print(f"[tail_risk] DCC fetch error: {e}")
        return None


def _compute_dcc_v1_signal(ret: pd.DataFrame, lambda_: float = 0.94) -> str:
    """EWMA-DCC symmetric signal (v1, production model)."""
    R = ret.values
    T, n = R.shape
    if T < 30 or n < 2:
        return "NORMAL"

    H = np.zeros((T, n))
    H[0] = np.maximum(np.var(R[:min(20, T)], axis=0), 1e-12)
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
    elif z > 2.0 or pctile > 85:
        return "SPIKE"
    elif z > 1.0 or pctile > 70 or trend_slope > 0.003:
        return "CAUTION"
    return "NORMAL"


def _compute_dcc_v3_signal(ret: pd.DataFrame, corr_window: int = 21) -> str:
    """
    HMM 2-regime signal (v3). Fits GaussianHMM on first 70% of window (IS proxy),
    predicts current regime on last 21-day correlation observations.
    Falls back to NORMAL if hmmlearn unavailable.
    """
    try:
        from hmmlearn.hmm import GaussianHMM
        warnings.filterwarnings("ignore")
    except ImportError:
        return "NORMAL"

    R = ret.values
    T, n = R.shape
    if T < corr_window + 30 or n < 2:
        return "NORMAL"

    # Build rolling corr_window avg off-diagonal correlation series
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
    is_obs = arr[:is_len].reshape(-1, 1)

    try:
        model = GaussianHMM(n_components=2, covariance_type="diag", n_iter=100)
        model.fit(is_obs)
    except Exception:
        return "NORMAL"

    # Crisis state = state with higher mean correlation
    crisis_state = int(np.argmax(model.means_.flatten()))

    # Predict on last corr_window observations
    pred_obs = arr[-corr_window:].reshape(-1, 1)
    try:
        states = model.predict(pred_obs)
        probs  = model.predict_proba(pred_obs)
        crisis_frac = float(np.mean(states == crisis_state))
        crisis_prob = float(probs[-1, crisis_state])
    except Exception:
        return "NORMAL"

    if crisis_prob > 0.80 and crisis_frac > 0.50:
        return "EXTREME"
    elif crisis_prob > 0.55 or crisis_frac > 0.55:
        return "SPIKE"
    elif crisis_prob > 0.35:
        return "CAUTION"
    return "NORMAL"


def get_cached_dcc_signals() -> tuple[str, str]:
    """Public: returns (v1_signal, v3_signal) from cache. Used by ticker.py for alerts."""
    cached = _cache.get("signals")
    if cached:
        return cached.get("dcc_v1_signal", "NORMAL"), cached.get("dcc_v3_signal", "NORMAL")
    return "NORMAL", "NORMAL"

def _get(path: str) -> dict:
    try:
        r = requests.get(f"{_BASE}{path}", timeout=10)
        r.raise_for_status()
        return r.json()
    except Exception:
        return {}

# ─── Backtest precision stats (IS 2015-2022, L2, 5-day lookahead) ─────────────
_BACKTEST_STATS: dict[str, dict] = {
    "g1_vix_backwardation": {
        "prec_is_l2_5d": 0.168, "rec_is_l2_5d": 0.875,
        "fires_pct_is": 0.254,   "fires_pct_oos": 0.278, "verdict": "USEFUL",
    },
    "g1_vix_spike": {
        "prec_is_l2_5d": 0.198, "rec_is_l2_5d": 0.844,
        "fires_pct_is": 0.170,   "fires_pct_oos": 0.089, "verdict": "USEFUL",
    },
    "g1_vix_momentum": {
        "prec_is_l2_5d": 0.186, "rec_is_l2_5d": 0.656,
        "fires_pct_is": 0.107,   "fires_pct_oos": 0.063, "verdict": "USEFUL",
    },
    "g2_hy_static": {
        "prec_is_l2_5d": 0.055, "rec_is_l2_5d": 0.219,
        "fires_pct_is": 0.026,   "fires_pct_oos": 0.000, "verdict": "WEAK",
    },
    "g3_stl_fsi": {
        "prec_is_l2_5d": 0.080, "rec_is_l2_5d": 0.531,
        "fires_pct_is": 0.286,   "fires_pct_oos": 0.020, "verdict": "USEFUL",
    },
    "g3_nfci": {
        "prec_is_l2_5d": 0.333, "rec_is_l2_5d": 0.156,
        "fires_pct_is": 0.018,   "fires_pct_oos": 0.000, "verdict": "SENSITIVE",
    },
    "g4_yc_10y2y": {
        "prec_is_l2_5d": 0.077, "rec_is_l2_5d": 0.063,
        "fires_pct_is": 0.064,   "fires_pct_oos": 0.831, "verdict": "WEAK",
    },
    "g4_yc_10y3m": {
        "prec_is_l2_5d": 0.091, "rec_is_l2_5d": 0.188,
        "fires_pct_is": 0.082,   "fires_pct_oos": 0.970, "verdict": "WEAK",
    },
    "g5_fg_extreme_fear": {
        "prec_is_l2_5d": 0.143, "rec_is_l2_5d": 0.438,
        "fires_pct_is": 0.124,   "fires_pct_oos": 0.028, "verdict": "USEFUL",
    },
    "g6_sector_convergent": {
        "prec_is_l2_5d": 0.055, "rec_is_l2_5d": 0.906,
        "fires_pct_is": 0.504,   "fires_pct_oos": 0.581, "verdict": "SENSITIVE",
    },
    "g7_rsi_oversold": {
        "prec_is_l2_5d": 0.265, "rec_is_l2_5d": 0.219,
        "fires_pct_is": 0.026,   "fires_pct_oos": 0.012, "verdict": "USEFUL",
    },
    "g8_layer_a_bearish": {
        "prec_is_l2_5d": 0.098, "rec_is_l2_5d": 0.781,
        "fires_pct_is": 0.487,   "fires_pct_oos": 0.496, "verdict": "SENSITIVE",
    },
    "g9_crisis_composite_red": {
        "prec_is_l2_5d": 1.000, "rec_is_l2_5d": 0.031,
        "fires_pct_is": 0.004,   "fires_pct_oos": 0.000, "verdict": "SENSITIVE",
    },
    "g10_volume_surge": {
        "prec_is_l2_5d": 0.125, "rec_is_l2_5d": 0.156,
        "fires_pct_is": 0.080,   "fires_pct_oos": 0.028, "verdict": "USEFUL",
    },
    "g12_composite": {
        "prec_is_l2_5d": 0.127, "rec_is_l2_5d": 0.750,
        "fires_pct_is": 0.362,   "fires_pct_oos": 0.194, "verdict": "USEFUL",
    },
    # DCC v1+v3 stats from backtest 2026-06-07 (SPIKE+, L1=-1.5%, 5d lookahead)
    "g13_dcc_v1": {
        "prec_is_l2_5d": 0.35,  "rec_is_l2_5d": 0.41,
        "fires_pct_is":  0.229,  "fires_pct_oos": 0.028, "verdict": "MIXED",
        "prec_oos": 0.21, "prec_fwd": 0.15, "edge_fwd_pp": 8,
    },
    "g14_dcc_hmm": {
        "prec_is_l2_5d": 0.32,  "rec_is_l2_5d": 0.30,
        "fires_pct_is":  0.211,  "fires_pct_oos": 0.048, "verdict": "MIXED",
        "prec_oos": 0.33, "prec_fwd": 0.24, "edge_fwd_pp": 18,
        "note": "EXTREME on OOS: 58% prec / +55pp edge",
    },
}

SIGNAL_META: dict[str, dict] = {
    "g1_vix_backwardation": {
        "label": "VIX Backwardation", "group": "VIX", "tier": 1,
        "description": "Front inversion (VIX9D>VIX) or back inversion (VIX>VIX3M) — panic bid on near-term options",
    },
    "g1_vix_spike": {
        "label": "VIX Spike", "group": "VIX", "tier": 1,
        "description": "VIX z-score>1.5 (rolling 20d) or VIX>30 absolute",
    },
    "g1_vix_momentum": {
        "label": "VIX Momentum", "group": "VIX", "tier": 1,
        "description": "VIX rose ≥20% over 5 days — accelerating fear",
    },
    "g2_hy_static": {
        "label": "HY Spread >5%", "group": "Credit", "tier": 3,
        "description": "US HY OAS > 5% (crisis.py threshold) — currently 2.7%, threshold too high",
    },
    "g3_stl_fsi": {
        "label": "STL Stress Index", "group": "Stress", "tier": 2,
        "description": "St. Louis Fed FSI > 0 — broad financial system stress (weekly)",
    },
    "g3_nfci": {
        "label": "Chicago NFCI", "group": "Stress", "tier": 3,
        "description": "Chicago Fed NFCI > 0 — tight financial conditions (weekly, low sensitivity)",
    },
    "g4_yc_10y2y": {
        "label": "Yield Curve 10Y-2Y", "group": "Rates", "tier": 4,
        "description": "10Y-2Y inverted — persistent signal (fires 83% in OOS), not a crash predictor",
    },
    "g4_yc_10y3m": {
        "label": "Yield Curve 10Y-3M", "group": "Rates", "tier": 4,
        "description": "10Y-3M inverted — persistent signal (fires 97% in OOS), not a crash predictor",
    },
    "g5_fg_extreme_fear": {
        "label": "Fear & Greed <25", "group": "Sentiment", "tier": 1,
        "description": "CNN F&G (primary) or synthetic composite < 25 = Extreme Fear",
    },
    "g6_sector_convergent": {
        "label": "Sector Correlation", "group": "Regime", "tier": 2,
        "description": "Regime = CONVERGENT — 11 sectors moving together, risk-off herding",
    },
    "g7_rsi_oversold": {
        "label": "RSI Oversold", "group": "Technical", "tier": 1,
        "description": "SPY 14d RSI < 35 — oversold / panic selling",
    },
    "g8_layer_a_bearish": {
        "label": "Layer A Bearish", "group": "Allocation", "tier": 2,
        "description": "SPY vs AGG 20d relative return z-score < -0.5 (252d window)",
    },
    "g9_crisis_composite_red": {
        "label": "Crisis Composite", "group": "Composite", "tier": 2,
        "description": "Crisis level ≥ 2 from /api/crisis — multi-indicator composite",
    },
    "g10_volume_surge": {
        "label": "Volume Surge", "group": "Flow", "tier": 1,
        "description": "SPY volume z-score > 2 (rolling 63d) — institutional panic/liquidation",
    },
    "g12_composite": {
        "label": "Composite Gate", "group": "Composite", "tier": 1,
        "description": "3+ validated Tier-1 signals active simultaneously",
    },
    "g13_dcc_v1": {
        "label": "DCC Corr Spike (V1)", "group": "Correlation", "tier": 1,
        "description": "EWMA-DCC symmetric: cross-asset correlation >= SPIKE (z>2 or pctile>85). "
                       "Backtest: 35% IS prec / +28pp edge at SPIKE+. Production model.",
    },
    "g14_dcc_hmm": {
        "label": "DCC HMM Regime (V3)", "group": "Correlation", "tier": 1,
        "description": "HMM 2-regime: crisis state probability >= 55%. "
                       "Backtest: 33% OOS prec / +30pp edge. 58% EXTREME prec on OOS.",
    },
}

VALIDATED = [
    "g1_vix_backwardation", "g1_vix_spike", "g1_vix_momentum",
    "g5_fg_extreme_fear", "g6_sector_convergent",
    "g7_rsi_oversold", "g8_layer_a_bearish", "g10_volume_surge",
    "g13_dcc_v1", "g14_dcc_hmm",
]

# ─── yfinance fetch (SPY+AGG+VIX trio only) ───────────────────────────────────

_YF_NEEDED = {
    "SPY": "SPY", "AGG": "AGG",
    "VIX": "^VIX", "VIX9D": "^VIX9D", "VIX3M": "^VIX3M",
}

def _fetch_yf(lookback_days: int = 90) -> dict[str, pd.DataFrame]:
    cache_key = f"yf_{lookback_days}"
    cached = _yf_cache.get(cache_key)
    if cached is not None:
        return cached

    start = (datetime.now() - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    data: dict[str, pd.DataFrame] = {}
    for name, ticker in _YF_NEEDED.items():
        try:
            df = yf.download(ticker, start=start, auto_adjust=True, progress=False)
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.get_level_values(0)
            if not df.empty:
                data[name] = df
        except Exception:
            pass

    _yf_cache.set(cache_key, data)
    return data


def _close(data: dict, name: str) -> pd.Series:
    df = data.get(name)
    if df is None or df.empty:
        return pd.Series(dtype=float, name=name)
    col = "Close" if "Close" in df.columns else df.columns[0]
    return df[col].rename(name)


def _volume(data: dict, name: str) -> pd.Series:
    df = data.get(name)
    if df is None or df.empty:
        return pd.Series(dtype=float, name=name)
    return df["Volume"].rename(f"{name}_vol")

# ─── Signal helpers ───────────────────────────────────────────────────────────

def _zscore(s: pd.Series, window: int, thresh: float, direction: str = "above") -> pd.Series:
    mu = s.rolling(window, min_periods=window // 2).mean()
    sd = s.rolling(window, min_periods=window // 2).std()
    z  = (s - mu) / sd.replace(0, np.nan)
    return (z > thresh) if direction == "above" else (z < thresh)


def _rsi(prices: pd.Series, period: int = 14) -> pd.Series:
    delta = prices.diff()
    gain  = delta.clip(lower=0).rolling(period, min_periods=period).mean()
    loss  = (-delta.clip(upper=0)).rolling(period, min_periods=period).mean()
    rs    = gain / loss.replace(0, np.nan)
    return 100 - 100 / (1 + rs)

# ─── Main computation ─────────────────────────────────────────────────────────

def _compute(yf_data: dict, crisis: dict, fg: dict, ticker_data: dict) -> dict:
    """
    Compute all signals. Crisis/FG/regime pulled from existing router cache.
    Only VIX-specific and technicals computed from yfinance.
    """
    spy   = _close(yf_data, "SPY")
    agg   = _close(yf_data, "AGG")
    vix   = _close(yf_data, "VIX")
    vix9d = _close(yf_data, "VIX9D")
    vix3m = _close(yf_data, "VIX3M")
    spy_v = _volume(yf_data, "SPY")

    c_sigs = crisis.get("signals", {})

    # If yfinance ^VIX unavailable (occasional data gap), use ticker scalar for current value
    vix_current: float | None = None
    if not vix.isna().all():
        vix_current = float(vix.dropna().iloc[-1])
    else:
        for item in ticker_data.get("items", []):
            if item.get("label") == "VIX" and item.get("value") is not None:
                vix_current = float(item["value"])
                break

    idx = spy.dropna().index
    if len(idx) == 0:
        return {}

    def ri(s: pd.Series) -> pd.Series:
        return s.reindex(idx).ffill(limit=5) if not s.empty else s

    spy = ri(spy); agg = ri(agg)
    vix9d = ri(vix9d); vix3m = ri(vix3m)
    spy_v = ri(spy_v)
    vix = ri(vix)  # VIX from crisis series, reindexed to SPY trading days

    signals: dict[str, bool] = {}

    # ── G1 VIX (yfinance + ticker fallback) ───────────────────────────────────
    vix9d_cur = float(vix9d.dropna().iloc[-1]) if not vix9d.isna().all() else None
    vix3m_cur = float(vix3m.dropna().iloc[-1]) if not vix3m.isna().all() else None

    if vix9d_cur is not None and vix_current is not None:
        front_inv = vix9d_cur > vix_current
        back_inv  = (vix3m_cur is not None) and (vix_current > vix3m_cur)
        signals["g1_vix_backwardation"] = front_inv or back_inv

    if not vix.isna().all():
        z_sig = _zscore(vix, 20, 1.5)
        signals["g1_vix_spike"]    = bool(not z_sig.isna().all() and z_sig.iloc[-1]) or (vix_current is not None and vix_current > 30)
        mom_sig = vix.pct_change(5)
        signals["g1_vix_momentum"] = bool(not mom_sig.isna().all() and mom_sig.iloc[-1] >= 0.20)
    elif vix_current is not None:
        # scalar-only fallback: can't compute z-score, use absolute threshold only
        signals["g1_vix_spike"] = vix_current > 30

    # ── G2 HY spread (crisis router) ──────────────────────────────────────────
    if "hy_spread" in c_sigs:
        signals["g2_hy_static"] = bool(c_sigs["hy_spread"].get("triggered", False))

    # ── G3 Stress indices (crisis router) ─────────────────────────────────────
    if "stl_fsi" in c_sigs:
        signals["g3_stl_fsi"] = bool(c_sigs["stl_fsi"].get("triggered", False))
    if "nfci" in c_sigs:
        signals["g3_nfci"]    = bool(c_sigs["nfci"].get("triggered", False))

    # ── G4 Yield curves (crisis router) ───────────────────────────────────────
    if "yield_10y2y" in c_sigs:
        signals["g4_yc_10y2y"] = bool(c_sigs["yield_10y2y"].get("triggered", False))
    if "yield_10y3m" in c_sigs:
        signals["g4_yc_10y3m"] = bool(c_sigs["yield_10y3m"].get("triggered", False))

    # ── G5 Fear & Greed (fear-greed router) ───────────────────────────────────
    fg_value = fg.get("value")
    if fg_value is not None:
        signals["g5_fg_extreme_fear"] = bool(float(fg_value) < 25)

    # ── G6 Sector regime (ticker router — regime label) ───────────────────────
    regime_label = None
    for item in ticker_data.get("items", []):
        if item.get("type") == "regime":
            regime_label = item.get("regime_label")
            break
    if regime_label is not None:
        signals["g6_sector_convergent"] = (regime_label == "CONVERGENT")

    # ── G7 RSI (yfinance SPY) ─────────────────────────────────────────────────
    if not spy.isna().all():
        rsi_val = _rsi(spy, 14).iloc[-1]
        signals["g7_rsi_oversold"] = bool(not math.isnan(rsi_val) and rsi_val < 35)

    # ── G8 Layer A (yfinance SPY + AGG) ───────────────────────────────────────
    if not (spy.isna().all() or agg.isna().all()):
        rel20 = spy.pct_change(20) - agg.pct_change(20)
        daily = spy.pct_change() - agg.pct_change()
        mu    = daily.rolling(252, min_periods=60).mean()
        sigma = daily.rolling(252, min_periods=60).std()
        z     = (rel20 - mu) / sigma.replace(0, np.nan)
        if not z.isna().all():
            signals["g8_layer_a_bearish"] = bool(z.iloc[-1] < -0.5)

    # ── G9 Crisis composite (crisis router level) ─────────────────────────────
    crisis_level = crisis.get("level", 0)
    signals["g9_crisis_composite_red"] = (int(crisis_level) >= 2)

    # ── G10 Volume surge (yfinance SPY volume) ────────────────────────────────
    if not spy_v.isna().all():
        vol_sig = _zscore(spy_v, 63, 2.0)
        if not vol_sig.isna().all():
            signals["g10_volume_surge"] = bool(vol_sig.iloc[-1])

    # ── G13/G14 DCC v1 + v3 (separate asset pool, separate cache) ────────────
    dcc_v1_signal = "NORMAL"
    dcc_v3_signal = "NORMAL"
    dcc_ret = _fetch_dcc_prices()
    if dcc_ret is not None:
        dcc_v1_signal = _compute_dcc_v1_signal(dcc_ret)
        dcc_v3_signal = _compute_dcc_v3_signal(dcc_ret)
        signals["g13_dcc_v1"]  = _DCC_RANK.get(dcc_v1_signal, 0) >= 2
        signals["g14_dcc_hmm"] = _DCC_RANK.get(dcc_v3_signal, 0) >= 2

    # ── G12 Composite gate ────────────────────────────────────────────────────
    validated_active = [s for s in VALIDATED if signals.get(s, False)]
    signals["g12_composite"] = len(validated_active) >= 3

    # ── Rolling 30-day history (VIX-computed signals only, proxy for trend) ───
    history: list[dict] = []
    if not vix.isna().all():
        vix_bkwd  = (vix9d > vix) | (vix > vix3m) if not (vix9d.isna().all() or vix3m.isna().all()) else vix > 30
        vix_spike = _zscore(vix, 20, 1.5) | (vix > 30)
        vix_mom   = vix.pct_change(5) >= 0.20
        rsi_s     = _rsi(spy, 14) < 35 if not spy.isna().all() else pd.Series(False, index=idx)

        hist_df = pd.DataFrame({
            "g1_vix_backwardation": vix_bkwd.reindex(idx).fillna(False),
            "g1_vix_spike":         vix_spike.reindex(idx).fillna(False),
            "g1_vix_momentum":      vix_mom.reindex(idx).fillna(False),
            "g7_rsi_oversold":      rsi_s.reindex(idx).fillna(False),
        }).tail(30)

        for date, row in hist_df.iterrows():
            active_n = int(row.sum())
            history.append({
                "date":            date.strftime("%Y-%m-%d"),
                "active_count":    active_n,
                "validated_count": active_n,
                "composite":       active_n >= 3,
            })

    # ── VIX term values ───────────────────────────────────────────────────────
    def last_val(s: pd.Series) -> float | None:
        v = s.dropna()
        if v.empty: return None
        return round(float(v.iloc[-1]), 2)

    vix_term = {
        "vix9d": round(vix9d_cur, 2) if vix9d_cur is not None else None,
        "vix":   round(vix_current, 2) if vix_current is not None else None,
        "vix3m": round(vix3m_cur, 2) if vix3m_cur is not None else None,
        "backwardation_front": (vix9d_cur is not None and vix_current is not None and vix9d_cur > vix_current),
        "backwardation_back":  (vix_current is not None and vix3m_cur is not None and vix_current > vix3m_cur),
    }

    # ── Build signal list ─────────────────────────────────────────────────────
    signals_out = []
    for sig_id in sorted(SIGNAL_META.keys()):
        meta  = SIGNAL_META[sig_id]
        stats = _BACKTEST_STATS.get(sig_id, {})
        active = signals.get(sig_id, False)
        signals_out.append({
            "id":          sig_id,
            "label":       meta["label"],
            "group":       meta["group"],
            "tier":        meta["tier"],
            "active":      active,
            "verdict":     stats.get("verdict", "UNKNOWN"),
            "description": meta["description"],
            "stats": {
                "prec_is_l2_5d":  stats.get("prec_is_l2_5d"),
                "rec_is_l2_5d":   stats.get("rec_is_l2_5d"),
                "prec_oos_l2_5d": None,
                "fires_pct_is":   stats.get("fires_pct_is"),
                "fires_pct_oos":  stats.get("fires_pct_oos"),
            },
        })

    composite_active = signals.get("g12_composite", False)
    validated_active_sigs = [s for s in VALIDATED if signals.get(s, False)]

    rsi_val = None
    if not spy.isna().all():
        r = _rsi(spy, 14).dropna()
        if not r.empty:
            rsi_val = round(float(r.iloc[-1]), 1)

    return {
        "ts":                      datetime.utcnow().isoformat() + "Z",
        "data_date":               idx[-1].strftime("%Y-%m-%d") if len(idx) else "N/A",
        "signals":                 signals_out,
        "composite_active":        composite_active,
        "active_count":            sum(1 for s in signals.values() if s),
        "validated_active_count":  len(validated_active_sigs),
        "validated_active_signals": validated_active_sigs,
        "vix_term":                vix_term,
        "fg_synthetic":            round(float(fg_value), 1) if fg_value is not None else None,
        "rsi":                     rsi_val,
        "crisis_score":            float(crisis_level) * 25 if crisis_level is not None else None,
        "sector_corr":             None,
        "history":                 history,
        # DCC v1 + v3 raw levels (NORMAL/CAUTION/SPIKE/EXTREME) for ribbon + alerts
        "dcc_v1_signal":           dcc_v1_signal,
        "dcc_v3_signal":           dcc_v3_signal,
    }

# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/signals")
def get_signals():  # sync: calls blocking requests/yfinance — runs in FastAPI threadpool, not event loop
    cached = _cache.get("signals")
    if cached is not None:
        return cached

    # Pull from existing cached routers (fast — usually sub-10ms cache hits)
    crisis      = _get("/api/crisis")
    fg          = _get("/api/fear-greed")
    ticker_data = _get("/api/ticker")

    # Minimal yfinance fetch (4 tickers, 70 days — enough for RSI/layer-A/volume)
    yf_data = _fetch_yf(lookback_days=70)

    result = _compute(yf_data, crisis, fg, ticker_data)
    if result:
        _cache.set("signals", result)
    return result


@router.get("/vix-term")
def get_vix_term():  # sync: blocking yfinance fetch — runs in threadpool, not event loop
    cached = _cache.get("vix_term")
    if cached is not None:
        return cached

    yf_data = _fetch_yf(lookback_days=10)

    def last(name: str) -> float | None:
        s = _close(yf_data, name).dropna()
        if s.empty: return None
        return round(float(s.iloc[-1]), 2)

    v9d = last("VIX9D")
    v   = last("VIX")
    v3m = last("VIX3M")
    result = {
        "ts":   datetime.utcnow().isoformat() + "Z",
        "vix9d": v9d, "vix": v, "vix3m": v3m,
        "backwardation_front": (v9d is not None and v is not None and v9d > v),
        "backwardation_back":  (v is not None and v3m is not None and v > v3m),
    }
    _cache.set("vix_term", result)
    return result
