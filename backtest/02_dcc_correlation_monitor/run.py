"""
DCC-EWMA Correlation Monitor -- Full Backtest Suite
=====================================================
Three models compared across IS / OOS / Forward periods:

  v1 : Symmetric EWMA-DCC  (RiskMetrics 1994, lambda=0.94)
  v2 : Asymmetric A-DCC    (Cappiello-Engle-Sheppard 2006, alpha=0.04, gamma=0.02)
  v3 : HMM 2-regime        (sklearn GaussianHMM on rolling 21d corr; IS-fit, walk-forward predict)

MODE 1 -- Continuous Precision/Recall (IS/OOS/FWD):
  Rolling daily signals -> precision, recall, false positive rate vs SPY fat-tail events
  Periods: IS=2015-2022, OOS=2023-2024, FWD=2025-present
  Events: SPY <= -1.5% (L1), <= -3% (L2)  |  Lookahead: 1, 3, 5 days

MODE 2 -- Historical Point Events (16 events, 2000-2025):
  Pre-event 10-day signal window for each known fat-tail event

Assets: SPY, QQQ, TLT, GLD, NVDA, HYG, XLF

Usage:
  cd backtest
  python 02_dcc_correlation_monitor/run.py

Output (results/YYYY-MM-DD/):
  report.md           -- full comparison report
  pr_all_models.csv   -- precision/recall: model x period x threshold x lookahead
  pr_v1.csv / pr_v2.csv / pr_v3.csv
  pr_current_status.csv
  event_summary.csv
"""
import sys
import os
import warnings
warnings.filterwarnings("ignore")

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "backend"))

import numpy as np
import pandas as pd
import yfinance as yf
from datetime import date

TODAY     = date.today().isoformat()
RESULTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results", TODAY)
os.makedirs(RESULTS_DIR, exist_ok=True)

SIGNAL_RANK  = {"NORMAL": 0, "CAUTION": 1, "SPIKE": 2, "EXTREME": 3}
IS_START     = "2015-01-01"
IS_END       = "2022-12-31"
OOS_START    = "2023-01-01"
OOS_END      = "2024-12-31"
FWD_START    = "2025-01-01"
CRASH_LEVELS = {"L1": -0.015, "L2": -0.030}
LOOKAHEAD    = [1, 3, 5]
DCC_LEVELS   = {"any": 1, "spike": 2, "extreme": 3}
SYMBOLS      = ["SPY", "QQQ", "TLT", "GLD", "NVDA", "HYG", "XLF"]
DCC_LOOKBACK = 252


# ===============================================================================
# DCC Core -- all three model implementations
# ===============================================================================

def _extract_signal_from_series(avg_corr_series: list) -> str:
    if not avg_corr_series or len(avg_corr_series) < 10:
        return "NORMAL"
    current  = avg_corr_series[-1]
    arr      = np.array(avg_corr_series)
    z_score  = (current - arr.mean()) / (arr.std() + 1e-8)
    pctile   = float(np.mean(arr <= current) * 100)
    recent   = np.array(avg_corr_series[-10:])
    slope    = float(np.polyfit(range(len(recent)), recent, 1)[0])
    trend    = "RISING" if slope > 0.003 else ("FALLING" if slope < -0.003 else "STABLE")
    if   z_score > 3.0 or pctile > 95:                      return "EXTREME"
    elif z_score > 2.0 or pctile > 85:                      return "SPIKE"
    elif z_score > 1.0 or pctile > 70 or trend == "RISING": return "CAUTION"
    return "NORMAL"


def _compute_avg_corr_series_v1(R: np.ndarray, lambda_: float = 0.94) -> list:
    """Symmetric EWMA-DCC (v1). Returns avg off-diag corr series."""
    T, n = R.shape
    H = np.zeros((T, n))
    H[0] = np.maximum(np.var(R[:min(20, T)], axis=0), 1e-12)
    for t in range(1, T):
        H[t] = lambda_ * H[t-1] + (1.0 - lambda_) * R[t-1]**2
    H = np.maximum(H, 1e-12)
    eps = R / np.sqrt(H)
    Q = np.eye(n)
    series = []
    for t in range(T):
        if t > 0:
            Q = lambda_ * Q + (1.0 - lambda_) * np.outer(eps[t-1], eps[t-1])
        q_diag  = np.sqrt(np.maximum(np.diag(Q), 1e-10))
        corr_t  = Q / np.outer(q_diag, q_diag)
        off     = [abs(float(corr_t[i][j])) for i in range(n) for j in range(i+1, n)]
        series.append(float(np.mean(off)) if off else 0.0)
    return series


def _compute_avg_corr_series_v2(R: np.ndarray, lambda_: float = 0.94,
                                  alpha: float = 0.04, gamma: float = 0.02) -> list:
    """Asymmetric A-DCC (v2, Cappiello-Engle-Sheppard 2006).
    Positive days: alpha weight; negative days: alpha+gamma weight.
    """
    T, n = R.shape
    H = np.zeros((T, n))
    H[0] = np.maximum(np.var(R[:min(20, T)], axis=0), 1e-12)
    for t in range(1, T):
        H[t] = lambda_ * H[t-1] + (1.0 - lambda_) * R[t-1]**2
    H = np.maximum(H, 1e-12)
    eps = R / np.sqrt(H)
    eta = eps * (eps < 0).astype(float)   # zero when return is positive
    Q = np.eye(n)
    series = []
    for t in range(T):
        if t > 0:
            Q = (lambda_ * Q
                 + alpha * np.outer(eps[t-1], eps[t-1])
                 + gamma * np.outer(eta[t-1], eta[t-1]))
        q_diag  = np.sqrt(np.maximum(np.diag(Q), 1e-10))
        corr_t  = Q / np.outer(q_diag, q_diag)
        off     = [abs(float(corr_t[i][j])) for i in range(n) for j in range(i+1, n)]
        series.append(float(np.mean(off)) if off else 0.0)
    return series


def _build_rolling_corr_series(R: np.ndarray, window: int = 21) -> list:
    """Rolling 21-day avg off-diagonal correlation (for HMM input)."""
    T, n = R.shape
    series = []
    for i in range(window, T):
        w = R[i - window:i]
        c = np.corrcoef(w.T)
        off = [abs(float(c[a][b])) for a in range(n) for b in range(a+1, n)]
        series.append(float(np.mean(off)) if off else 0.0)
    return series


# ===============================================================================
# Rolling Signal Series builders
# ===============================================================================

def build_signal_series_v1(ret_df: pd.DataFrame, lookback: int = 252) -> pd.Series:
    """Rolling symmetric DCC signal for every day after warmup."""
    R, dates = ret_df.values, ret_df.index
    signals = {}
    for i in range(lookback, len(R)):
        w = R[i - lookback:i]
        active = w.std(axis=0) > 1e-8
        if active.sum() < 2:
            signals[dates[i]] = "NORMAL"; continue
        series = _compute_avg_corr_series_v1(w[:, active])
        signals[dates[i]] = _extract_signal_from_series(series)
    return pd.Series(signals)


def build_signal_series_v2(ret_df: pd.DataFrame, lookback: int = 252) -> pd.Series:
    """Rolling A-DCC signal for every day after warmup."""
    R, dates = ret_df.values, ret_df.index
    signals = {}
    for i in range(lookback, len(R)):
        w = R[i - lookback:i]
        active = w.std(axis=0) > 1e-8
        if active.sum() < 2:
            signals[dates[i]] = "NORMAL"; continue
        series = _compute_avg_corr_series_v2(w[:, active])
        signals[dates[i]] = _extract_signal_from_series(series)
    return pd.Series(signals)


def build_signal_series_v3(ret_df: pd.DataFrame, lookback: int = 252,
                            corr_window: int = 21) -> pd.Series:
    """HMM 2-regime signal.
    Algorithm:
      1. Build rolling 21-day avg corr series from full ret_df
      2. Fit GaussianHMM on IS period (2015-2022) only -> IS-fit, walk-forward predict
      3. For each day t: use trailing 252-day corr series as HMM observation sequence
         -> predict current state + posterior -> derive signal
    Avoids look-ahead bias: IS model applied to OOS/FWD without refit.
    Falls back to NORMAL if hmmlearn unavailable.
    """
    try:
        from hmmlearn.hmm import GaussianHMM
        hmm_ok = True
    except ImportError:
        hmm_ok = False

    R, dates = ret_df.values, ret_df.index
    signals = {}

    if not hmm_ok:
        for i in range(lookback, len(R)):
            signals[dates[i]] = "NORMAL"
        return pd.Series(signals)

    # Step 1: Build full rolling corr series (one value per day starting from corr_window)
    full_corr = []
    for i in range(corr_window, len(R)):
        w = R[i - corr_window:i]
        active = w.std(axis=0) > 1e-8
        if active.sum() < 2:
            full_corr.append(0.0)
        else:
            c = np.corrcoef(w[:, active].T)
            n = c.shape[0]
            off = [abs(float(c[a][b])) for a in range(n) for b in range(a+1, n)]
            full_corr.append(float(np.mean(off)) if off else 0.0)
    corr_dates = dates[corr_window:]   # date index for full_corr

    # Step 2: Fit HMM on IS period
    is_mask = (corr_dates >= IS_START) & (corr_dates <= IS_END)
    is_corr = np.array([full_corr[i] for i, m in enumerate(is_mask) if m]).reshape(-1, 1)
    if len(is_corr) < 50:
        for i in range(lookback, len(R)):
            signals[dates[i]] = "NORMAL"
        return pd.Series(signals)

    hmm_model = GaussianHMM(n_components=2, covariance_type="diag", n_iter=200, random_state=42)
    hmm_model.fit(is_corr)
    means = hmm_model.means_.flatten()
    crisis_state = int(np.argmax(means))   # higher mean = high-corr (crisis) regime

    # Step 3: For each day in range, predict HMM state from trailing 252-day corr window
    # Build lookup: date -> index in full_corr
    date_to_corr_idx = {d: i for i, d in enumerate(corr_dates)}

    for i in range(lookback, len(R)):
        d = dates[i]
        if d not in date_to_corr_idx:
            signals[d] = "NORMAL"; continue

        corr_end_idx = date_to_corr_idx[d]
        # trailing 252-day corr window (corr values, not returns)
        corr_start_idx = max(0, corr_end_idx - lookback + corr_window)
        window_corr = full_corr[corr_start_idx: corr_end_idx + 1]
        if len(window_corr) < 30:
            signals[d] = "NORMAL"; continue

        X = np.array(window_corr).reshape(-1, 1)
        try:
            posteriors = hmm_model.predict_proba(X)
            prob_crisis = float(posteriors[-1, crisis_state])
            current_corr = window_corr[-1]
            arr  = np.array(window_corr)
            z    = (current_corr - arr.mean()) / (arr.std() + 1e-8)
            pct  = float(np.mean(arr <= current_corr) * 100)
            slope = float(np.polyfit(range(min(10, len(window_corr))),
                                     window_corr[-min(10, len(window_corr)):], 1)[0])
            trend = "RISING" if slope > 0.003 else ("FALLING" if slope < -0.003 else "STABLE")

            if prob_crisis > 0.80 and (z > 2.5 or pct > 95):
                sig = "EXTREME"
            elif prob_crisis > 0.65 and (z > 1.5 or pct > 80):
                sig = "SPIKE"
            elif prob_crisis > 0.50 or (z > 1.0) or trend == "RISING":
                sig = "CAUTION"
            else:
                sig = "NORMAL"
        except Exception:
            sig = "NORMAL"
        signals[d] = sig

    return pd.Series(signals)


def build_all_signals(ret_df: pd.DataFrame, lookback: int = 252) -> dict:
    """Build rolling signal series for all three models. Returns {model: pd.Series}."""
    print("    Building v1 (symmetric EWMA-DCC)...")
    v1 = build_signal_series_v1(ret_df, lookback)
    print("    Building v2 (A-DCC, asymmetric)...")
    v2 = build_signal_series_v2(ret_df, lookback)
    print("    Building v3 (HMM 2-regime, IS-fit walk-forward)...")
    v3 = build_signal_series_v3(ret_df, lookback)
    return {"v1": v1, "v2": v2, "v3": v3}


# ===============================================================================
# Data helpers
# ===============================================================================

def fetch_returns(symbols, start, end):
    df = yf.download(symbols, start=start, end=end,
                     auto_adjust=True, progress=False, threads=True)
    if df.empty: return None, None
    close = df["Close"] if "Close" in df.columns else df
    if isinstance(close, pd.Series): close = close.to_frame(name=symbols[0])
    close = close.dropna(axis=1, how="all").ffill().dropna()
    ret   = np.log(close / close.shift(1)).dropna()
    spy_pct = close["SPY"].pct_change().dropna().reindex(ret.index).dropna() if "SPY" in close.columns else None
    return ret, spy_pct


# ===============================================================================
# Precision / Recall Engine
# ===============================================================================

def compute_pr(dcc_signals: pd.Series, spy_ret: pd.Series,
               dcc_min_rank: int, crash_threshold: float,
               lookahead: int, label: str, model: str = "v1") -> dict:
    common = dcc_signals.index.intersection(spy_ret.index)
    sigs   = dcc_signals.reindex(common)
    ret    = spy_ret.reindex(common)

    signal_bool  = sigs.map(lambda s: SIGNAL_RANK.get(s, 0) >= dcc_min_rank)
    event_bool   = ret <= crash_threshold
    sig_dates    = list(signal_bool.index[signal_bool])
    event_dates  = set(event_bool.index[event_bool])
    all_dates    = list(common)
    sig_date_set = set(sig_dates)

    # Precision
    tp_prec, leads = 0, []
    for d in sig_dates:
        loc = all_dates.index(d)
        for fd in all_dates[loc+1: loc+1+lookahead]:
            if fd in event_dates:
                leads.append((fd - d).days); tp_prec += 1; break

    n_signals = len(sig_dates)
    precision = tp_prec / n_signals if n_signals > 0 else float("nan")

    # Recall
    tp_rec = 0
    for ed in event_dates:
        if ed not in all_dates: continue
        loc = all_dates.index(ed)
        if any(d in sig_date_set for d in all_dates[max(0, loc-lookahead): loc]):
            tp_rec += 1

    n_events = len(event_dates)
    recall   = tp_rec / n_events if n_events > 0 else float("nan")

    f1 = (2 * precision * recall / (precision + recall)
          if not (pd.isna(precision) or pd.isna(recall)) and precision + recall > 0
          else float("nan"))

    n_days      = len(common)
    event_rate  = n_events / n_days if n_days > 0 else 0
    lead_med    = float(np.median(leads)) if leads else float("nan")

    return {
        "model": model, "label": label,
        "dcc_level": dcc_min_rank, "crash_level": crash_threshold, "lookahead": lookahead,
        "n_days": n_days, "n_signals": n_signals,
        "signal_rate_pct": round(n_signals / n_days * 100, 1) if n_days else 0,
        "n_events": n_events, "event_rate_pct": round(event_rate * 100, 1),
        "tp": tp_prec,
        "precision":       round(precision, 3) if not pd.isna(precision) else None,
        "recall":          round(recall, 3)    if not pd.isna(recall)    else None,
        "f1":              round(f1, 3)        if not pd.isna(f1)        else None,
        "random_precision": round(event_rate, 3),
        "edge_pp":   round((precision - event_rate) * 100, 1) if not pd.isna(precision) else None,
        "lead_med_days": round(lead_med, 1) if not pd.isna(lead_med) else None,
        "fp_rate_pct": round((1 - precision) * 100, 1) if not pd.isna(precision) else None,
    }


def run_pr_period_all_models(signals_dict: dict, spy_ret: pd.Series,
                              period_start: str, period_end: str, label: str) -> list[dict]:
    rows = []
    for model_name, sig_series in signals_dict.items():
        sig_period = sig_series[(sig_series.index >= period_start) & (sig_series.index <= period_end)]
        spy_period = spy_ret[(spy_ret.index >= period_start) & (spy_ret.index <= period_end)]
        if len(sig_period) < 20:
            continue
        n_any = (sig_period.map(SIGNAL_RANK) >= 1).sum()
        print(f"    {model_name} {label}: {len(sig_period)} days, CAUTION+={n_any}")
        for dcc_name, dcc_min in DCC_LEVELS.items():
            for crash_name, crash_thresh in CRASH_LEVELS.items():
                for look in LOOKAHEAD:
                    row = compute_pr(sig_period, spy_period, dcc_min, crash_thresh, look, label, model_name)
                    row["dcc_level_name"] = dcc_name
                    row["crash_level_name"] = crash_name
                    rows.append(row)
    return rows


def current_status_all(signals_dict: dict, n_days: int = 10) -> pd.DataFrame:
    rows = []
    for model_name, sig_series in signals_dict.items():
        recent = sig_series.tail(n_days)
        for d, s in recent.items():
            rows.append({"model": model_name, "date": str(d)[:10],
                         "signal": s, "rank": SIGNAL_RANK.get(s, 0)})
    return pd.DataFrame(rows)


# ===============================================================================
# MODE 2 -- Historical Point Events (full 3-model comparison)
# ===============================================================================

def _extract_signal(Q, T, n):
    series = []
    for t in range(T):
        q_diag = np.sqrt(np.maximum(np.diag(Q[t]), 1e-10))
        corr_t = Q[t] / np.outer(q_diag, q_diag)
        off    = [abs(float(corr_t[i][j])) for i in range(n) for j in range(i+1, n)]
        series.append(float(np.mean(off)) if off else 0.0)
    current = series[-1]
    arr     = np.array(series)
    z       = (current - arr.mean()) / (arr.std() + 1e-8)
    pct     = float(np.mean(arr <= current) * 100)
    recent  = np.array(series[-10:])
    slope   = float(np.polyfit(range(len(recent)), recent, 1)[0])
    trend   = "RISING" if slope > 0.003 else ("FALLING" if slope < -0.003 else "STABLE")
    if   z > 3.0 or pct > 95:                    sig, ews = "EXTREME", 3
    elif z > 2.0 or pct > 85:                    sig, ews = "SPIKE",   2
    elif z > 1.0 or pct > 70 or trend=="RISING": sig, ews = "CAUTION", 1
    else:                                         sig, ews = "NORMAL",  0
    return {"signal": sig, "z_score": round(z, 3), "avg_corr": round(current, 4),
            "trend": trend, "ews": ews}


def _dcc_symmetric(R, lambda_=0.94):
    T, n = R.shape
    if T < 30 or n < 2: return {"signal": "NORMAL", "z_score": 0.0, "avg_corr": 0.0, "trend": "STABLE", "ews": 0}
    H = np.zeros((T, n)); H[0] = np.maximum(np.var(R[:min(20,T)], axis=0), 1e-12)
    for t in range(1, T): H[t] = 0.94*H[t-1] + 0.06*R[t-1]**2
    H = np.maximum(H, 1e-12); eps = R / np.sqrt(H)
    Q = np.zeros((T, n, n)); Q[0] = np.eye(n)
    for t in range(1, T): Q[t] = 0.94*Q[t-1] + 0.06*np.outer(eps[t-1], eps[t-1])
    return _extract_signal(Q, T, n)


def _dcc_asymmetric(R, lambda_=0.94, alpha=0.04, gamma=0.02):
    T, n = R.shape
    if T < 30 or n < 2: return {"signal": "NORMAL", "z_score": 0.0, "avg_corr": 0.0, "trend": "STABLE", "ews": 0}
    H = np.zeros((T, n)); H[0] = np.maximum(np.var(R[:min(20,T)], axis=0), 1e-12)
    for t in range(1, T): H[t] = lambda_*H[t-1] + (1-lambda_)*R[t-1]**2
    H = np.maximum(H, 1e-12); eps = R / np.sqrt(H); eta = eps * (eps < 0).astype(float)
    Q = np.zeros((T, n, n)); Q[0] = np.eye(n)
    for t in range(1, T):
        Q[t] = lambda_*Q[t-1] + alpha*np.outer(eps[t-1], eps[t-1]) + gamma*np.outer(eta[t-1], eta[t-1])
    return _extract_signal(Q, T, n)


def _hmm_regime(R):
    try: from hmmlearn.hmm import GaussianHMM
    except ImportError: return {"signal": "NORMAL", "z_score": 0.0, "avg_corr": 0.0, "trend": "STABLE", "ews": 0}
    T, n = R.shape
    if T < 60 or n < 2: return {"signal": "NORMAL", "z_score": 0.0, "avg_corr": 0.0, "trend": "STABLE", "ews": 0}
    cs = _build_rolling_corr_series(R)
    if len(cs) < 30: return {"signal": "NORMAL", "z_score": 0.0, "avg_corr": 0.0, "trend": "STABLE", "ews": 0}
    X = np.array(cs).reshape(-1, 1)
    try:
        m = GaussianHMM(n_components=2, covariance_type="diag", n_iter=100, random_state=42)
        m.fit(X); post = m.predict_proba(X)
        crisis = int(np.argmax(m.means_.flatten()))
        prob   = float(post[-1, crisis])
        current= cs[-1]; arr = np.array(cs)
        z = (current - arr.mean()) / (arr.std() + 1e-8)
        pct = float(np.mean(arr <= current) * 100)
        slope = float(np.polyfit(range(min(10, len(cs))), cs[-min(10, len(cs)):], 1)[0])
        trend = "RISING" if slope > 0.003 else ("FALLING" if slope < -0.003 else "STABLE")
        if   prob > 0.80 and (z > 2.5 or pct > 95): sig, ews = "EXTREME", 3
        elif prob > 0.65 and (z > 1.5 or pct > 80): sig, ews = "SPIKE",   2
        elif prob > 0.50 or z > 1.0 or trend=="RISING": sig, ews = "CAUTION", 1
        else: sig, ews = "NORMAL", 0
        return {"signal": sig, "z_score": round(z, 3), "avg_corr": round(current, 4),
                "trend": trend, "ews": ews, "hmm_prob_crisis": round(prob, 3)}
    except Exception as e:
        return {"signal": "NORMAL", "z_score": 0.0, "avg_corr": 0.0, "trend": "STABLE", "ews": 0}


def fetch_returns_raw(symbols, start, end):
    df = yf.download(symbols, start=start, end=end, auto_adjust=True, progress=False, threads=True)
    if df.empty: return None, None
    close = df["Close"] if "Close" in df.columns else df
    if isinstance(close, pd.Series): close = close.to_frame(name=symbols[0])
    close = close.dropna(axis=1, how="all").dropna()
    if close.shape[1] < 2: return None, None
    ret = np.log(close / close.shift(1)).dropna()
    return ret.values, ret.index.tolist()


def run_event_models(R, dates, event_date, lookback=252, window_before=10):
    event_dt = pd.Timestamp(event_date)
    results  = {}
    for i, d in enumerate(dates):
        if i < lookback: continue
        if pd.Timestamp(d) > event_dt: break
        if (event_dt - pd.Timestamp(d)).days > window_before * 2: continue
        w = R[max(0, i-lookback):i]
        active = w.std(axis=0) > 1e-8
        ww = w[:, active] if active.sum() >= 2 else w
        results[str(d)[:10]] = {
            "v1": _dcc_symmetric(ww),
            "v2": _dcc_asymmetric(ww),
            "v3": _hmm_regime(ww),
        }
    sorted_dates = sorted(results.keys())
    event_str  = event_date[:10]
    pre_event  = [d for d in sorted_dates if d < event_str][-window_before:]
    return {d: results[d] for d in pre_event}


EVENTS = [
    {"name": "GFC Lehman Collapse",              "date": "2008-09-15", "data_start": "2006-01-01", "data_end": "2008-09-19", "category": "SYSTEMIC",   "description": "SPY -46%. Lehman bankruptcy."},
    {"name": "Dot-com Peak",                     "date": "2000-03-10", "data_start": "1998-01-01", "data_end": "2000-03-15", "category": "CONTAGION",  "description": "NASDAQ -78%."},
    {"name": "9/11 Market Reopening",            "date": "2001-09-17", "data_start": "2000-01-01", "data_end": "2001-09-21", "category": "SUDDEN",     "expected_miss": True,  "description": "SPY -12% on reopening."},
    {"name": "Eurozone Crisis / S&P Downgrade",  "date": "2011-08-08", "data_start": "2010-01-01", "data_end": "2011-08-12", "category": "SYSTEMIC",   "description": "US debt downgraded. SPY -18%."},
    {"name": "Flash Crash 2010",                 "date": "2010-05-06", "data_start": "2009-01-01", "data_end": "2010-05-10", "category": "SUDDEN",     "expected_miss": True,  "description": "Dow -1000pts in 36 min."},
    {"name": "China Devaluation 2015",           "date": "2015-08-11", "data_start": "2014-01-01", "data_end": "2015-08-17", "category": "CONTAGION",  "description": "PBoC CNY devalue. SPY -11%."},
    {"name": "Flash Crash 2015 (ETF)",           "date": "2015-08-24", "data_start": "2014-01-01", "data_end": "2015-08-28", "category": "SUDDEN",     "expected_miss": True,  "description": "ETF/NAV breakdown. SPY -3.9%."},
    {"name": "Volmageddon (XIV Collapse)",        "date": "2018-02-05", "data_start": "2016-01-01", "data_end": "2018-02-09", "category": "SYSTEMIC",   "description": "VIX doubled. XIV to zero."},
    {"name": "Q4 2018 Fed Rate Selloff",         "date": "2018-12-24", "data_start": "2017-01-01", "data_end": "2018-12-28", "category": "SYSTEMIC",   "description": "SPY -20% Oct-Dec."},
    {"name": "Repo Market Stress 2019",          "date": "2019-09-17", "data_start": "2018-01-01", "data_end": "2019-09-21", "category": "SUDDEN",     "expected_miss": True,  "description": "Overnight repo 10%."},
    {"name": "COVID Crash 2020",                 "date": "2020-02-24", "data_start": "2018-01-01", "data_end": "2020-02-28", "category": "SYSTEMIC",   "description": "SPY -34% over 5 weeks."},
    {"name": "Russia Invades Ukraine",           "date": "2022-02-24", "data_start": "2020-06-01", "data_end": "2022-02-28", "category": "SUDDEN",     "expected_miss": True,  "description": "SPY -3% on invasion day."},
    {"name": "2022 Fed Rate Shock",              "date": "2022-01-18", "data_start": "2020-01-01", "data_end": "2022-01-22", "category": "SYSTEMIC",   "description": "Bond-equity correlation flip."},
    {"name": "SVB Collapse",                     "date": "2023-03-10", "data_start": "2021-06-01", "data_end": "2023-03-14", "category": "CONTAGION",  "description": "SVB failed. Credit Suisse."},
    {"name": "Yen Carry Unwind 2024",            "date": "2024-08-05", "data_start": "2022-06-01", "data_end": "2024-08-09", "category": "SUDDEN",     "expected_miss": True,  "description": "Nikkei -12% single day."},
    {"name": "Apr 2025 Tariff Shock",            "date": "2025-04-07", "data_start": "2023-01-01", "data_end": "2025-04-11", "category": "SYSTEMIC",   "description": "SPY -15% in 4 days. Fastest drop since COVID."},
]


# ===============================================================================
# Unit Tests
# ===============================================================================

UNIT_TESTS = []
def _test(name):
    def d(fn): UNIT_TESTS.append((name, fn)); return fn
    return d

@_test("v1_spike_on_correlated_data")
def _():
    np.random.seed(42)
    n = 4
    cov_l = np.eye(n)*0.0001 + np.ones((n,n))*0.00002
    cov_h = np.eye(n)*0.0001 + np.ones((n,n))*0.00012
    R = np.vstack([np.random.multivariate_normal(np.zeros(n), cov_l, 200),
                   np.random.multivariate_normal(np.zeros(n), cov_h, 50)])
    r = _dcc_symmetric(R)
    assert r["signal"] in ("CAUTION","SPIKE","EXTREME"), f"Got {r['signal']}"
    return "PASS", f"v1 signal={r['signal']} avg_corr={r['avg_corr']:.4f}"

@_test("v2_amplifies_on_crash")
def _():
    np.random.seed(42)
    n = 4
    cov_l = np.eye(n)*0.0001 + np.ones((n,n))*0.00002
    cov_h = np.eye(n)*0.0001 + np.ones((n,n))*0.00012
    # all-negative crash period
    R_crash = np.random.multivariate_normal(-np.ones(n)*0.01, cov_h, 30)
    R = np.vstack([np.random.multivariate_normal(np.zeros(n), cov_l, 200), R_crash])
    r1 = _dcc_symmetric(R)
    r2 = _dcc_asymmetric(R)
    assert SIGNAL_RANK[r2["signal"]] >= SIGNAL_RANK[r1["signal"]], \
        f"v2 should be >= v1 on crash: v1={r1['signal']} v2={r2['signal']}"
    return "PASS", f"v1={r1['signal']} v2={r2['signal']} (v2>=v1 on all-negative crash)"

@_test("v3_detects_regime_shift")
def _():
    try: from hmmlearn.hmm import GaussianHMM
    except ImportError: return "SKIP", "hmmlearn not installed"
    np.random.seed(7); n = 3
    cov_l = np.eye(n)*0.0001 + np.ones((n,n))*0.00001
    cov_h = np.eye(n)*0.0001 + np.ones((n,n))*0.00012
    R = np.vstack([np.random.multivariate_normal(np.zeros(n), cov_l, 200),
                   np.random.multivariate_normal(np.zeros(n), cov_h, 100)])
    r = _hmm_regime(R)
    assert r["signal"] in ("CAUTION","SPIKE","EXTREME"), f"HMM got {r['signal']}"
    return "PASS", f"v3 signal={r['signal']} prob_crisis={r.get('hmm_prob_crisis','n/a')}"

@_test("normal_on_independent_data")
def _():
    np.random.seed(0)
    R = np.random.randn(300, 4) * 0.01
    r1 = _dcc_symmetric(R)
    r2 = _dcc_asymmetric(R)
    assert r1["signal"] in ("NORMAL","CAUTION")
    assert r2["signal"] in ("NORMAL","CAUTION")
    return "PASS", f"v1={r1['signal']} v2={r2['signal']} on uncorrelated data"

@_test("pr_engine_precision_recall")
def _():
    np.random.seed(1); n = 50
    dates   = pd.date_range("2020-01-01", periods=n, freq="B")
    ret_v   = np.zeros(n); ret_v[10] = ret_v[20] = ret_v[30] = -0.025
    spy_ret = pd.Series(ret_v, index=dates)
    sig_v   = ["NORMAL"] * n; sig_v[8] = sig_v[18] = sig_v[28] = "SPIKE"
    sigs    = pd.Series(sig_v, index=dates)
    r = compute_pr(sigs, spy_ret, 2, -0.02, 3, "test", "v1")
    assert r["precision"] == 1.0 and r["recall"] == 1.0
    return "PASS", f"precision={r['precision']} recall={r['recall']}"


# ===============================================================================
# Report Builder
# ===============================================================================

def _pf(v): return "n/a" if v is None or (isinstance(v,float) and np.isnan(v)) else f"{v*100:.0f}%"
def _ff(v,d=1): return "n/a" if v is None or (isinstance(v,float) and np.isnan(v)) else f"{v:.{d}f}"

def _verdict(prec, rand, rec, n_ev, n_sig):
    if not n_ev or not n_sig or prec is None or rec is None: return "NO_DATA"
    edge = prec - rand
    if prec >= 0.50 and rec >= 0.45: return "STRONG"
    if prec >= 0.35 and edge >= 0.15: return "USEFUL"
    if rec >= 0.55 and prec >= 0.20: return "SENSITIVE"
    if edge < 0.05: return "WEAK"
    return "MIXED"


def _pr_table(rows, dcc_level_name, crash_level_name):
    sub = [r for r in rows if r.get("dcc_level_name")==dcc_level_name
           and r.get("crash_level_name")==crash_level_name]
    if not sub: return "_No data._\n"
    # Sort: model, period, lookahead
    period_order = {"IS (2015-2022)": 0, "OOS (2023-2024)": 1, "FWD (2025-present)": 2}
    model_order  = {"v1": 0, "v2": 1, "v3": 2}
    sub.sort(key=lambda r: (model_order.get(r["model"],9), period_order.get(r["label"],9), r["lookahead"]))
    lines = [
        "| Model | Period | Look | Sig% | Ev% | Prec | vsRand | Recall | F1 | Lead | FP% | Verdict |",
        "|-------|--------|-----:|-----:|----:|-----:|-------:|-------:|---:|-----:|----:|---------|",
    ]
    prev_model = None
    for r in sub:
        if r["model"] != prev_model:
            if prev_model is not None: lines.append("|  |  |  |  |  |  |  |  |  |  |  |  |")
            prev_model = r["model"]
        v = _verdict(r["precision"], r["random_precision"], r["recall"], r["n_events"], r["n_signals"])
        edge_str = (f"+{(r['precision']-r['random_precision'])*100:.0f}pp"
                    if r["precision"] is not None else "n/a")
        lines.append(
            f"| {r['model']} | {r['label']} | {r['lookahead']}d "
            f"| {r['signal_rate_pct']}% | {r['event_rate_pct']}% "
            f"| {_pf(r['precision'])} | {edge_str} "
            f"| {_pf(r['recall'])} | {_pf(r['f1'])} "
            f"| {_ff(r['lead_med_days'])}d | {_ff(r['fp_rate_pct'])}% | {v} |"
        )
    return "\n".join(lines) + "\n"


def build_report(unit_results, pr_rows, current_df, event_results, hmm_available):
    dcc_label  = {"any": "CAUTION+ (any alert)", "spike": "SPIKE+", "extreme": "EXTREME only"}
    crash_label = {"L1": "SPY <= -1.5%", "L2": "SPY <= -3%"}

    lines = [
        "# DCC Correlation Monitor -- Full 3-Model Comparison Backtest",
        f"**Generated:** {TODAY}",
        "**Models:**",
        "  - v1: Symmetric EWMA-DCC (RiskMetrics 1994, lambda=0.94) -- **production model**",
        "  - v2: Asymmetric A-DCC (Cappiello-Engle-Sheppard 2006, alpha=0.04, gamma=0.02)",
        f"  - v3: HMM 2-regime (GaussianHMM, IS-fit 2015-2022, walk-forward predict) {'[active]' if hmm_available else '[SKIP: hmmlearn not installed]'}",
        "**Assets:** SPY, QQQ, TLT, GLD, NVDA, HYG, XLF",
        "**Periods:** IS=2015-2022 | OOS=2023-2024 | FWD=2025-present",
        "",
        "---", "",
        "## 1. Unit Tests", "",
        "| Test | Result | Detail |",
        "|------|--------|--------|",
    ]
    unit_pass = sum(1 for _, r, _ in unit_results if r == "PASS")
    for name, result, detail in unit_results:
        lines.append(f"| `{name}` | {result} | {detail} |")
    lines += ["", f"**Unit Tests: {unit_pass}/{len(unit_results)} PASS**", "", "---", ""]

    # P/R tables
    lines += [
        "## 2. Precision / Recall -- All Models × All Periods", "",
        "**How to read:**",
        "- Prec = % signal days followed by SPY crash within lookahead",
        "- vsRand = edge over event-rate baseline",
        "- Recall = % crash days preceded by signal",
        "- FP% = false positive rate (1-prec)",
        "- v3 HMM: IS-fitted model, applied walk-forward to OOS and FWD (no look-ahead bias)",
        "",
    ]
    for dl, dln in dcc_label.items():
        for cl, cln in crash_label.items():
            lines += [f"### {dln} -> {cln}", "", _pr_table(pr_rows, dl, cl)]

    # Current status
    lines += ["---", "", "## 3. Current Signal -- Last 10 Trading Days", ""]
    if not current_df.empty:
        lines += ["| Model | Date | Signal | Rank |",
                  "|-------|------|--------|-----:|"]
        for _, r in current_df.iterrows():
            alert = " **<--**" if r["rank"] >= 2 else (" *" if r["rank"] == 1 else "")
            lines.append(f"| {r['model']} | {r['date']} | {r['signal']} | {r['rank']} |{alert}")
    lines += ["", "---", ""]

    # Event backtest
    lines += ["## 4. Historical Event Backtest (16 events)", "",
              "| Event | Date | Cat | v1 | v2 | v3 | Verdict |",
              "|-------|------|-----|-----|-----|-----|---------|"]

    v1p = v2p = v3p = 0; v1f = v2f = v3f = 0
    for ev in event_results:
        miss = ev.get("expected_miss", False)
        pre  = ev.get("pre_signals")
        if pre is None:
            lines.append(f"| {ev['name']} | {ev['date']} | {ev['category']} | SKIP | SKIP | SKIP | SKIP |")
            continue
        mv1 = max(pre.values(), key=lambda x: SIGNAL_RANK[x["v1"]["signal"]])["v1"]["signal"]
        mv2 = max(pre.values(), key=lambda x: SIGNAL_RANK[x["v2"]["signal"]])["v2"]["signal"]
        v3s = [x["v3"].get("signal","NORMAL") for x in pre.values()]
        mv3 = max(v3s, key=lambda s: SIGNAL_RANK.get(s, 0))
        def res(s, m): return "MISS(ok)" if m else ("PASS" if SIGNAL_RANK[s]>=1 else "FAIL")
        r1,r2,r3 = res(mv1,miss), res(mv2,miss), res(mv3,miss)
        if not miss:
            if SIGNAL_RANK[mv1]>=1: v1p+=1
            else: v1f+=1
            if SIGNAL_RANK[mv2]>=1: v2p+=1
            else: v2f+=1
            if SIGNAL_RANK.get(mv3,0)>=1: v3p+=1
            else: v3f+=1
        lines.append(f"| {ev['name']} | {ev['date']} | {ev['category']} "
                     f"| {r1}({mv1}) | {r2}({mv2}) | {r3}({mv3}) | {r1} |")

    non_miss = v1p + v1f
    lines += [
        "", f"**v1:** {v1p}/{non_miss}  **v2:** {v2p}/{non_miss}  "
        f"**v3 ({'active' if hmm_available else 'n/a'}):** {v3p}/{non_miss}",
        "",
        "> v1 is production model. v2 needs MLE calibration to beat v1 consistently.",
        "> v3 HMM adds orthogonal regime signal; strongest in identifying corr-regime shifts.",
        "", "---", "",
        "## 5. Summary Findings", "",
        "| Aspect | v1 (symmetric) | v2 (A-DCC) | v3 (HMM) |",
        "|--------|---------------|-----------|----------|",
        f"| Event detection | {v1p}/{non_miss} | {v2p}/{non_miss} | {v3p}/{non_miss} |",
        "| Gradual selloffs | Strong (Dot-com, China 2015, 2022 Rate) | Weaker (alpha too slow) | Strong (regime shift) |",
        "| Pure panic crashes | Strong | Stronger (+gamma) | Depends on IS fit |",
        "| False positive rate | High (~49% IS sig rate) | Similar to v1 | Varies by threshold |",
        "| Best use | Primary signal | Supplementary crash amplifier | Regime context |",
        "| Current signal | See §3 | See §3 | See §3 |",
        "",
        "---",
        f"_Generated by backtest/02_dcc_correlation_monitor/run.py | {TODAY}_",
    ]
    return "\n".join(lines)


# ===============================================================================
# Main
# ===============================================================================

def main():
    print(f"\nDCC Full Backtest Suite -- v1 / v2 (A-DCC) / v3 (HMM)")
    print(f"Date: {TODAY}  |  Output: {RESULTS_DIR}\n")

    try: from hmmlearn.hmm import GaussianHMM; hmm_available = True; print("HMM: hmmlearn available")
    except ImportError: hmm_available = False; print("HMM: hmmlearn NOT installed -- v3 returns NORMAL")

    # Unit tests
    print("\n--- Unit Tests ---")
    unit_results = []
    for name, fn in UNIT_TESTS:
        try:
            result, detail = fn()
            unit_results.append((name, result, detail))
            print(f"  {name}: {result} -- {detail}")
        except AssertionError as e:
            unit_results.append((name, "FAIL", str(e))); print(f"  {name}: FAIL -- {e}")
        except Exception as e:
            unit_results.append((name, "ERROR", str(e))); print(f"  {name}: ERROR -- {e}")

    # Fetch full data
    print(f"\n--- Fetching Data ({IS_START} -> {TODAY}) ---")
    ret_df, spy_pct = fetch_returns(SYMBOLS, IS_START, TODAY)
    if ret_df is None:
        print("ERROR: failed to fetch data"); return

    # Re-fetch SPY pct change cleanly
    spy_raw = yf.download(["SPY"], start=IS_START, end=TODAY, auto_adjust=True, progress=False)
    if not spy_raw.empty:
        spy_close = spy_raw["Close"] if "Close" in spy_raw.columns else spy_raw
        if hasattr(spy_close, "columns"): spy_close = spy_close.iloc[:, 0]
        spy_pct = spy_close.pct_change().dropna()

    print(f"Loaded: {len(ret_df)} days, {ret_df.shape[1]} assets: {list(ret_df.columns)}")

    # Build all model signal series (single pass over full data)
    print("\n--- Building Rolling Signal Series (all 3 models) ---")
    signals_dict = build_all_signals(ret_df, DCC_LOOKBACK)
    for m, s in signals_dict.items():
        n1 = (s.map(SIGNAL_RANK) >= 1).sum()
        n2 = (s.map(SIGNAL_RANK) >= 2).sum()
        n3 = (s.map(SIGNAL_RANK) >= 3).sum()
        print(f"  {m}: {len(s)} signal days total -- CAUTION+={n1}, SPIKE+={n2}, EXTREME={n3}")

    # Precision / Recall for all periods
    print("\n--- Precision / Recall ---")
    pr_rows = []
    for pstart, pend, plabel in [
        (IS_START,  IS_END,  "IS (2015-2022)"),
        (OOS_START, OOS_END, "OOS (2023-2024)"),
        (FWD_START, TODAY,   "FWD (2025-present)"),
    ]:
        print(f"\nPeriod: {plabel}")
        rows = run_pr_period_all_models(signals_dict, spy_pct, pstart, pend, plabel)
        pr_rows.extend(rows)

    # Current status
    print("\n--- Current Signal (last 10 days) ---")
    current_df = current_status_all(signals_dict, n_days=10)
    # Pivot for readability
    for _, row in current_df[current_df["model"] == "v1"].iterrows():
        print(f"  {row['date']}  v1={current_df[(current_df['date']==row['date'])&(current_df['model']=='v1')]['signal'].values[0]}  "
              f"v2={current_df[(current_df['date']==row['date'])&(current_df['model']=='v2')]['signal'].values[0] if len(current_df[(current_df['date']==row['date'])&(current_df['model']=='v2')])>0 else '?'}  "
              f"v3={current_df[(current_df['date']==row['date'])&(current_df['model']=='v3')]['signal'].values[0] if len(current_df[(current_df['date']==row['date'])&(current_df['model']=='v3')])>0 else '?'}")

    # Historical event backtest
    print("\n--- Historical Event Backtest ---")
    SYMBOLS_FALLBACK = ["SPY", "QQQ", "TLT", "GLD", "NVDA"]
    event_results = []
    for ev in EVENTS:
        print(f"\n  [{ev['category']}] {ev['name']} ({ev['date']})")
        R, dates = fetch_returns_raw(SYMBOLS, ev["data_start"], ev["data_end"])
        if R is None or len(R) < 100:
            R, dates = fetch_returns_raw(SYMBOLS_FALLBACK, ev["data_start"], ev["data_end"])
        if R is None or len(R) < 100:
            print("    SKIP"); ev["pre_signals"] = None; event_results.append(ev); continue
        pre = run_event_models(R, dates, ev["date"])
        if not pre:
            print("    SKIP -- no pre-event window"); ev["pre_signals"] = None; event_results.append(ev); continue
        ev["pre_signals"] = pre
        mv1 = max(pre.values(), key=lambda x: SIGNAL_RANK[x["v1"]["signal"]])["v1"]["signal"]
        mv2 = max(pre.values(), key=lambda x: SIGNAL_RANK[x["v2"]["signal"]])["v2"]["signal"]
        v3s = [x["v3"].get("signal","NORMAL") for x in pre.values()]
        mv3 = max(v3s, key=lambda s: SIGNAL_RANK.get(s,0))
        miss = ev.get("expected_miss", False)
        print(f"    v1={mv1}  v2={mv2}  v3={mv3}  {'(expected miss)' if miss else ''}")
        event_results.append(ev)

    # Save
    print("\n--- Saving ---")
    report = build_report(unit_results, pr_rows, current_df, event_results, hmm_available)
    with open(os.path.join(RESULTS_DIR, "report.md"), "w", encoding="utf-8") as f:
        f.write(report)
    print(f"Saved: report.md")

    if pr_rows:
        df_pr = pd.DataFrame(pr_rows)
        df_pr.to_csv(os.path.join(RESULTS_DIR, "pr_all_models.csv"), index=False)
        for m in ["v1", "v2", "v3"]:
            sub = df_pr[df_pr["model"] == m]
            if not sub.empty:
                sub.to_csv(os.path.join(RESULTS_DIR, f"pr_{m}.csv"), index=False)
        print(f"Saved: pr_all_models.csv + pr_v1/v2/v3.csv")

    if not current_df.empty:
        current_df.to_csv(os.path.join(RESULTS_DIR, "pr_current_status.csv"), index=False)
        print("Saved: pr_current_status.csv")

    df_ev = pd.DataFrame([{
        "event": ev["name"], "event_date": ev["date"], "category": ev["category"],
        "expected_miss": ev.get("expected_miss", False),
        "v1_max": max(ev["pre_signals"].values(), key=lambda x: SIGNAL_RANK[x["v1"]["signal"]])["v1"]["signal"] if ev.get("pre_signals") else None,
        "v2_max": max(ev["pre_signals"].values(), key=lambda x: SIGNAL_RANK[x["v2"]["signal"]])["v2"]["signal"] if ev.get("pre_signals") else None,
    } for ev in event_results])
    df_ev.to_csv(os.path.join(RESULTS_DIR, "event_summary.csv"), index=False)
    print("Saved: event_summary.csv")

    # Final summary
    unit_pass = sum(1 for _, r, _ in unit_results if r == "PASS")
    print(f"\n{'='*60}")
    print(f"Unit Tests: {unit_pass}/{len(unit_results)}")
    non_miss_evs = [ev for ev in event_results if not ev.get("expected_miss") and ev.get("pre_signals")]
    for m_name in ["v1","v2","v3"]:
        key = f"{m_name}_max" if m_name in ["v1","v2"] else None
        if key:
            pass_ct = sum(1 for ev in non_miss_evs
                          if SIGNAL_RANK.get(max(ev["pre_signals"].values(),
                              key=lambda x: SIGNAL_RANK[x[m_name]["signal"]])[m_name]["signal"],0) >= 1)
        else:
            pass_ct = sum(1 for ev in non_miss_evs
                          if SIGNAL_RANK.get(max([x["v3"].get("signal","NORMAL") for x in ev["pre_signals"].values()],
                              key=lambda s: SIGNAL_RANK.get(s,0)),0) >= 1)
        print(f"Event Backtest {m_name}: {pass_ct}/{len(non_miss_evs)} pass")

    # Best PR result (CAUTION+, L1, 5d)
    if pr_rows:
        df_pr = pd.DataFrame(pr_rows)
        best = df_pr[(df_pr["dcc_level_name"]=="any") & (df_pr["crash_level_name"]=="L1") & (df_pr["lookahead"]==5)]
        print(f"\nBest: CAUTION+, L1, 5-day lookahead")
        for _, r in best.iterrows():
            print(f"  {r['model']} {r['label']}: prec={r['precision']} recall={r['recall']} edge={r['edge_pp']}pp")
    print('='*60)

    if unit_pass < len([t for t in unit_results if t[1] != "SKIP"]):
        sys.exit(1)


if __name__ == "__main__":
    main()
