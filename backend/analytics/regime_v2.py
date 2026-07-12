"""
Regime Detection v2 — multivariate HMM risk dial.

Six features (corr, realized vol, VIX, credit, breadth, trend) -> 4-state
Gaussian HMM -> causal prefix-Viterbi labeling with hysteresis. Spec is a
1:1 port of the walk-forward-validated pipeline in
research/regime_v2/validate_regime_v2.py — do not change constants here
without re-running that study.

Validated (walk-forward 2013-2026, purge 63 / embargo 21, one-shot):
  - Risk gate: MaxDD -59% vs B&H, CAGR kept 67%, Sharpe 0.94 vs 0.86
  - Stability: median regime run 22 sessions, 5.8 switches/yr
  - NOT validated as a volatility forecast (T1 p=0.148) — present this as a
    risk dial, never as a prediction.
"""
from __future__ import annotations

import json
import os
import pickle
import threading
import time
from datetime import datetime, timezone
from typing import Optional

import numpy as np

# ── Spec constants (frozen: mirror research/regime_v2/PLAN.md) ───────────────

SECTORS = ["XLK", "XLF", "XLV", "XLE", "XLI", "XLY", "XLP", "XLU", "XLB"]
LABELS = ["DIVERGENT", "TRENDING", "RISK-OFF", "CRISIS"]
COLORS = {
    "DIVERGENT": "#00FF88",
    "TRENDING":  "#FFD700",
    "RISK-OFF":  "#FF9800",
    "CRISIS":    "#FF4444",
}

# Plain-language meaning per regime — no quant jargon, safe to show directly in
# the UI. `headline` describes what the market is doing; `posture` is the
# suggested risk stance. Deliberately never says "will" / "expect" — this reads
# the present, it does not predict.
LABEL_INFO = {
    "DIVERGENT": {
        "plain": "Calm and broadly healthy",
        "headline": "Sectors are moving independently and most are trending up — "
                    "a settled, low-stress market.",
        "posture": "Normal risk-taking is reasonable.",
    },
    "TRENDING": {
        "plain": "Steady, one-directional",
        "headline": "The market is moving together in one direction with moderate "
                    "stress — orderly, but watch for a turn.",
        "posture": "Stay invested; keep an eye on the trend.",
    },
    "RISK-OFF": {
        "plain": "Under stress",
        "headline": "Sectors are falling together, credit is weakening and fewer "
                    "stocks hold their uptrend — money is moving to safety.",
        "posture": "Reduce risk and tighten protection.",
    },
    "CRISIS": {
        "plain": "Severe stress",
        "headline": "Nearly everything is selling off at once with sharp volatility "
                    "— a rare, high-stress environment.",
        "posture": "Defensive; capital preservation first.",
    },
}

# One-line, plain-language meaning of each input signal (for feature tooltips).
FEATURE_INFO = {
    "corr": "How closely the 9 sectors move together (high = they rise and fall as one)",
    "rvol": "How much the market has been swinging lately (annualized)",
    "vix": "The market's expected near-term swings — the 'fear gauge'",
    "credit": "How risky corporate bonds are doing vs safe government bonds (falling = stress)",
    "breadth": "Share of sectors still in an uptrend (1.0 = all of them)",
    "trend": "How far the market sits above or below its long-term average",
}

CORR_WINDOW = 63
VOL_WINDOW = 21
CREDIT_WINDOW = 63
DMA = 200
FEATURES = ["corr", "rvol", "vix", "credit", "breadth", "trend"]

N_STATES = 4
HYSTERESIS = 5
VITERBI_CONTEXT = 252
LABEL_HISTORY_DAYS = 300   # causal labels recomputed over this trailing span
RISK_ON_STATES = (0, 1)

_MODEL_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "data", "models")
_MODEL_FILE = os.path.join(_MODEL_DIR, "hmm_v2.pkl")
_META_FILE = os.path.join(_MODEL_DIR, "regime_v2.json")
_RETRAIN_DAYS = 30

_training_state = {
    "running": False,
    "last_started": None,
    "last_finished": None,
    "last_error": None,
    "triggered_by": None,
}

_feature_cache: dict = {"df": None, "ts": 0.0}
_FEATURE_TTL = 3600  # rebuild features at most hourly


# ── Feature construction (identical to the validated study) ──────────────────

def _build_features():
    import pandas as pd
    import yfinance as yf

    now = time.time()
    if _feature_cache["df"] is not None and now - _feature_cache["ts"] < _FEATURE_TTL:
        return _feature_cache["df"]

    tickers = SECTORS + ["SPY", "^VIX", "HYG", "IEF"]
    raw = yf.download(tickers, start="2004-01-01", auto_adjust=True,
                      progress=False)["Close"]
    # The union calendar with ^VIX inserts rows where equities are NaN; one
    # such NaN poisons rolling(200) for the next 200 sessions (this silently
    # froze the trend feature). Keep genuine US equity sessions only, then
    # forward-fill sporadic single-ticker gaps.
    raw = raw[raw["SPY"].notna()].ffill()

    sec = raw[SECTORS].pct_change().dropna()
    mask = np.triu(np.ones((len(SECTORS), len(SECTORS)), dtype=bool), k=1)
    corr = {}
    vals = sec.values
    for i in range(CORR_WINDOW, len(sec)):
        c = np.corrcoef(vals[i - CORR_WINDOW:i].T)
        corr[sec.index[i]] = float(np.abs(c[mask]).mean())

    f = pd.DataFrame(index=raw.index)
    f["corr"] = pd.Series(corr)
    f["rvol"] = raw["SPY"].pct_change().rolling(VOL_WINDOW).std() * np.sqrt(252)
    f["vix"] = raw["^VIX"]
    f["credit"] = (raw["HYG"] / raw["IEF"]).pct_change(CREDIT_WINDOW)
    above = raw[SECTORS] > raw[SECTORS].rolling(DMA).mean()
    f["breadth"] = above.mean(axis=1)
    f["trend"] = raw["SPY"] / raw["SPY"].rolling(DMA).mean() - 1
    f = f.dropna()

    _feature_cache["df"] = f
    _feature_cache["ts"] = now
    return f


# ── Training ──────────────────────────────────────────────────────────────────

def train_v2_model(triggered_by: str = "manual") -> dict:
    """Fit the 6-feature HMM on full history and persist model + scaler meta."""
    try:
        from hmmlearn.hmm import GaussianHMM
    except ImportError as e:
        raise RuntimeError(f"Missing dependency: {e}. Run: pip install hmmlearn")

    f = _build_features()
    if len(f) < 1000:
        raise RuntimeError(f"Insufficient feature history: {len(f)} rows")

    mu = f.values.mean(axis=0)
    sd = f.values.std(axis=0)
    X = (f.values - mu) / sd

    model = GaussianHMM(n_components=N_STATES, covariance_type="full",
                        n_iter=500, random_state=42, tol=1e-4)
    model.fit(X)

    # Risk ordering by the rvol dimension (col 1): 0 = calmest, 3 = crisis
    order = np.argsort(model.means_[:, 1])
    inv = np.empty(N_STATES, dtype=int)
    inv[order] = np.arange(N_STATES)

    meta = {
        "features": FEATURES,
        "scaler_mean": mu.tolist(),
        "scaler_std": sd.tolist(),
        "state_order": inv.tolist(),
        "n_obs": int(len(f)),
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "triggered_by": triggered_by,
        "validation": "research/regime_v2 (risk dial only — not a forecast)",
    }

    os.makedirs(_MODEL_DIR, exist_ok=True)
    with open(_MODEL_FILE, "wb") as fh:
        pickle.dump(model, fh)
    with open(_META_FILE, "w") as fh:
        json.dump(meta, fh, indent=2)

    global _v2
    _v2 = RegimeV2(_MODEL_FILE, _META_FILE)
    return {"status": "ok", "n_obs": meta["n_obs"], "trained_at": meta["trained_at"]}


def model_age_days_v2() -> Optional[float]:
    if not os.path.exists(_MODEL_FILE):
        return None
    return (time.time() - os.path.getmtime(_MODEL_FILE)) / 86400


def needs_training_v2() -> bool:
    age = model_age_days_v2()
    return age is None or age > _RETRAIN_DAYS


def _train_in_background_v2(triggered_by: str = "auto") -> None:
    if _training_state["running"]:
        return
    _training_state["running"] = True
    _training_state["last_started"] = datetime.now(timezone.utc).isoformat()
    _training_state["triggered_by"] = triggered_by
    _training_state["last_error"] = None

    def _run():
        try:
            train_v2_model(triggered_by=triggered_by)
        except Exception as e:
            _training_state["last_error"] = str(e)
        finally:
            _training_state["last_finished"] = datetime.now(timezone.utc).isoformat()
            _training_state["running"] = False

    threading.Thread(target=_run, daemon=True).start()


def ensure_v2_fresh(triggered_by: str = "startup") -> None:
    """Called on backend startup — trains if model missing or stale."""
    if needs_training_v2() and not _training_state["running"]:
        _train_in_background_v2(triggered_by=triggered_by)


# ── Runtime labeling ──────────────────────────────────────────────────────────

class RegimeV2:
    def __init__(self, model_path: str = _MODEL_FILE, meta_path: str = _META_FILE):
        self.ready = False
        try:
            if not (os.path.exists(model_path) and os.path.exists(meta_path)):
                return
            with open(model_path, "rb") as fh:
                self.model = pickle.load(fh)
            with open(meta_path) as fh:
                self.meta = json.load(fh)
            self.mu = np.array(self.meta["scaler_mean"])
            self.sd = np.array(self.meta["scaler_std"])
            self.inv = np.array(self.meta["state_order"])
            self.ready = True
        except Exception:
            pass

    def causal_labels(self, f) -> list[int]:
        """Per-day prefix-Viterbi over trailing context + hysteresis smoothing.
        Matches the validated study's labeling exactly."""
        X = (f.values - self.mu) / self.sd
        start = max(0, len(X) - LABEL_HISTORY_DAYS)
        raw = []
        for t in range(start, len(X)):
            lo = max(0, t - VITERBI_CONTEXT + 1)
            seq = self.model.predict(X[lo:t + 1])
            raw.append(int(self.inv[seq[-1]]))

        smoothed, cur, streak, cand = [], raw[0], 0, None
        for s in raw:
            if s == cur:
                cand, streak = None, 0
            elif s == cand:
                streak += 1
                if streak >= HYSTERESIS:
                    cur, cand, streak = s, None, 0
            else:
                cand, streak = s, 1
            smoothed.append(cur)
        return smoothed

    def causal_proba(self, f, n_days: int = 1) -> np.ndarray:
        """Filtered posterior P(state | data up to t) for the last `n_days`.

        Causal by construction: forward-backward over a prefix ending at t has
        β_t = 1 at the final step, so the smoothed posterior of the LAST row
        equals the filtered (online) posterior — no future data leaks in.
        Columns are reordered into risk order (0=DIVERGENT … 3=CRISIS).
        Returns shape (n_days, N_STATES)."""
        X = (f.values - self.mu) / self.sd
        start = max(0, len(X) - n_days)
        out = np.zeros((len(X) - start, N_STATES))
        for k, t in enumerate(range(start, len(X))):
            lo = max(0, t - VITERBI_CONTEXT + 1)
            post = self.model.predict_proba(X[lo:t + 1])[-1]  # raw-state order
            out[k, self.inv] = post  # scatter into risk-ordered columns
        return out


_v2 = RegimeV2()


def get_v2() -> RegimeV2:
    global _v2
    if not _v2.ready:
        _v2 = RegimeV2()
    return _v2


def get_regime_v2() -> dict:
    """Full payload for GET /api/regime/v2."""
    v2 = get_v2()
    if not v2.ready:
        return {
            "ready": False,
            "training": _training_state["running"],
            "last_error": _training_state["last_error"],
        }

    f = _build_features()
    labels = v2.causal_labels(f)
    dates = f.index[-len(labels):]

    state = labels[-1]
    since_idx = len(labels) - 1
    while since_idx > 0 and labels[since_idx - 1] == state:
        since_idx -= 1

    latest = f.iloc[-1]
    label = LABELS[state]
    info = LABEL_INFO[label]

    # Causal per-day posterior for the last 90 sessions (for a stacked chart);
    # the final row is today's live distribution.
    proba = v2.causal_proba(f, n_days=90)
    today = proba[-1]
    proba_history = [
        {"date": str(d.date()), **{LABELS[i]: round(float(row[i]), 3) for i in range(N_STATES)}}
        for d, row in zip(dates[-90:], proba)
    ]
    history = [
        {"date": str(d.date()), "label": LABELS[s]}
        for d, s in zip(dates[-90:], labels[-90:])
    ]

    return {
        "ready": True,
        "label": label,
        "plain_label": info["plain"],
        "headline": info["headline"],
        "posture": info["posture"],
        "color": COLORS[label],
        "state": state,
        "risk_on": state in RISK_ON_STATES,
        # Live posterior probability of each regime, P(regime | data so far).
        # confidence = how much of that probability sits on the shown label.
        # The shown label is the hysteresis-smoothed regime, so on a fresh
        # transition it can briefly trail the highest-probability regime — that
        # lag is intentional (it stops the dial from flickering).
        "probabilities": {LABELS[i]: round(float(today[i]), 3) for i in range(N_STATES)},
        "confidence": round(float(today[state]), 3),
        "since": str(dates[since_idx].date()),
        "days_in_state": len(labels) - since_idx,
        "as_of": str(dates[-1].date()),
        "features": {
            k: {"value": round(float(latest[k]), 4), "about": FEATURE_INFO[k]}
            for k in FEATURES
        },
        "history": history,
        "proba_history": proba_history,
        "trained_at": v2.meta["trained_at"],
        "model_age_days": model_age_days_v2(),
        # Shown to users: plain-language scope, no quant jargon. This gauge reads
        # today's market conditions; it does not forecast where prices will go.
        "note": ("This gauge reads how much stress is in the market right now — "
                 "it is a guide for how much risk to take, not a prediction of "
                 "where prices are headed."),
    }
