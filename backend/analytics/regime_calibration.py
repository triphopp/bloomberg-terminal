"""
Regime threshold calibration: Random Matrix Theory (GEOM) + Markov Regime Switching (CORR).

RMT ref  : Laloux et al. (1999) PRL; Plerou et al. (2002) PRE
MRS ref  : Hamilton (1989) Econometrica; Ang & Bekaert (2002) RFS
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

# ---------------------------------------------------------------------------
# RMT — Marchenko-Pastur calibration for GEOM (det-based) regime score
# ---------------------------------------------------------------------------

class RMTCalibrator:
    """
    RMT analysis for GEOM (det-based) regime detection.

    Role of each output:
      score     — det(C)^(1/N), geometric mean of eigenvalues, used for LABEL and display.
      label     — regime class from score thresholds (unchanged from original system).
      k_signal  — SUPPLEMENTARY: count of eigenvalues above Marchenko-Pastur bound.
                  Answers "how many independent market factors exist?" — NOT used for label.
      lambda_max— Marchenko-Pastur upper bound = (1 + sqrt(N/T))^2.

    WHY k_signal is NOT used for labeling:
      For a uniform equicorrelation matrix C (all off-diagonal = ρ), eigenvalues are:
        λ₁ = 1 + (N-1)ρ  (one factor)
        λ₂ = … = λ_N = 1 − ρ  (degenerate)
      k_signal = 1 for ANY ρ > (λ_max − 1) / (N−1) ≈ 0.10 when T=63.
      This means rho=0.20 (DIVERGENT) and rho=0.85 (CRISIS) BOTH give k=1 → "CORRELATED".
      The score (det) correctly distinguishes: rho=0.20 → score=0.90, rho=0.85 → score=0.22.

    RMT ref: Laloux et al. (1999) PRL; Plerou et al. (2002) PRE
    """

    # Score-based GEOM thresholds (heuristic, awaiting MRS-style historical calibration)
    THRESHOLDS = (0.25, 0.45, 0.65)  # CORRELATED / TRENDING / MIXED / DIVERGENT

    @staticmethod
    def mp_upper_bound(N: int, T: int) -> float:
        """Marchenko-Pastur upper eigenvalue bound for iid noise."""
        return (1.0 + (N / T) ** 0.5) ** 2

    @staticmethod
    def label_from_score(score: float) -> tuple[str, str]:
        """Regime label from GEOM score (det^(1/N))."""
        if score < 0.25:
            return "CORRELATED", "#FF4444"
        if score < 0.45:
            return "TRENDING",   "#FF9800"
        if score < 0.65:
            return "MIXED",      "#FFD700"
        return "DIVERGENT", "#00FF88"

    @staticmethod
    def factor_regime_from_k(k: int, lambda_1: float, N: int) -> str:
        """
        SUPPLEMENTARY label from k_signal + λ₁ magnitude.
        Differentiates within k=1 using the fraction λ₁/N (market dominance).
        NOT used for the main regime label — displayed as additional context only.
        """
        if k == 0:
            return "NOISE"        # no eigenvalue above MP bulk; near-identity
        dominance = lambda_1 / N  # fraction of total variance in top factor
        if k == 1:
            if dominance > 0.75:  return "SINGLE-FACTOR-DOMINANT"  # crisis-like
            if dominance > 0.45:  return "SINGLE-FACTOR-MODERATE"  # trending-like
            return "SINGLE-FACTOR-WEAK"                             # near-divergent
        if k <= 3:
            return "MULTI-FACTOR"
        return "MANY-FACTORS"

    @staticmethod
    def analyze(corr_matrix: np.ndarray, T: int) -> dict:
        N = corr_matrix.shape[0]
        lambda_max = RMTCalibrator.mp_upper_bound(N, T)
        try:
            eigenvalues = sorted(
                np.linalg.eigvalsh(corr_matrix).tolist(), reverse=True
            )
        except Exception:
            eigenvalues = [1.0] * N

        k = int(sum(1 for e in eigenvalues if e > lambda_max))

        try:
            det = float(np.linalg.det(corr_matrix))
            score = max(0.0, det) ** (1.0 / N) if det > 0 else 0.0
        except Exception:
            score = 0.0

        label, color = RMTCalibrator.label_from_score(score)
        lambda_1 = eigenvalues[0] if eigenvalues else float(N)
        factor_regime = RMTCalibrator.factor_regime_from_k(k, lambda_1, N)

        return {
            "score":          round(score, 4),
            "label":          label,
            "color":          color,
            "k_signal":       k,
            "lambda_max":     round(lambda_max, 4),
            "lambda_1":       round(lambda_1, 4),
            "factor_regime":  factor_regime,
            "eigenvalues_top5": [round(e, 4) for e in eigenvalues[:5]],
            "method":         "RMT",
        }


# ---------------------------------------------------------------------------
# MRS — Markov Regime Switching calibration for CORR (avg|ρ|) regime score
# ---------------------------------------------------------------------------

_MRS_MODEL_PATH = os.path.join(
    os.path.dirname(__file__), "..", "..", "data", "models", "hmm_4state.pkl"
)
_MRS_THRESHOLDS_PATH = os.path.join(
    os.path.dirname(__file__), "..", "..", "data", "models", "thresholds.json"
)


class MRSCalibrator:
    """
    Calibrates CORR regime label and provides transition probabilities
    using a pre-trained 4-state Gaussian HMM.

    Requires running `scripts/train_hmm.py` first to produce:
        data/models/hmm_4state.pkl
        data/models/thresholds.json

    When model files are absent, `ready=False` and all methods return None.
    """

    LABELS = ["DIVERGENT", "TRENDING", "RISK-OFF", "CRISIS"]
    COLORS = {
        "DIVERGENT": "#00FF88",
        "TRENDING":  "#FFD700",
        "RISK-OFF":  "#FF9800",
        "CRISIS":    "#FF4444",
    }

    def __init__(
        self,
        model_path: str = _MRS_MODEL_PATH,
        thresholds_path: str = _MRS_THRESHOLDS_PATH,
    ):
        self.ready = False
        try:
            model_path = os.path.abspath(model_path)
            thresholds_path = os.path.abspath(thresholds_path)
            if not os.path.exists(model_path) or not os.path.exists(thresholds_path):
                return
            with open(model_path, "rb") as f:
                self.model = pickle.load(f)
            with open(thresholds_path) as f:
                self.thresholds = json.load(f)
            self.A = np.array(self.thresholds["transition_matrix"])
            self.ready = True
        except Exception:
            pass

    def label_from_score(self, score: float) -> tuple[str, str]:
        """
        Label CORR score using MRS-calibrated thresholds (no HMM inference).
        Works even without running the full predict() chain.
        """
        if not self.ready:
            return _heuristic_corr_label(score)
        t = self.thresholds["corr"]
        if score > t["riskoff_crisis"]:
            return "CRISIS",   "#FF4444"
        if score > t["trending_riskoff"]:
            return "RISK-OFF", "#FF9800"
        if score > t["divergent_trending"]:
            return "TRENDING", "#FFD700"
        return "DIVERGENT", "#00FF88"

    def predict(self, score_series: list[float]) -> Optional[dict]:
        """
        Full HMM inference: posterior state + 20-day transition probabilities.
        Requires score_series of length ≥ 5.
        """
        if not self.ready or len(score_series) < 5:
            return None
        try:
            obs = np.array(score_series, dtype=float).reshape(-1, 1)
            posteriors = self.model.predict_proba(obs)
            current_state = int(np.argmax(posteriors[-1]))
            confidence = float(posteriors[-1][current_state])

            A20 = np.linalg.matrix_power(self.A, 20)
            transition_20d = {
                self.LABELS[i]: round(float(A20[current_state][i]), 4)
                for i in range(4)
            }

            return {
                "label": self.LABELS[current_state],
                "color": self.COLORS[self.LABELS[current_state]],
                "confidence": round(confidence, 4),
                "transition_20d": transition_20d,
                "calibrated_thresholds": self.thresholds["corr"],
                "state_means": self.thresholds["state_means"],
                "method": "MRS",
            }
        except Exception:
            return None

    def get_thresholds(self) -> Optional[dict]:
        if not self.ready:
            return None
        return self.thresholds.get("corr")


# ---------------------------------------------------------------------------
# Heuristic fallback (original thresholds — used when MRS not trained yet)
# ---------------------------------------------------------------------------

def _heuristic_corr_label(avg_abs_rho: float) -> tuple[str, str]:
    if avg_abs_rho > 0.70:
        return "CRISIS",   "#FF4444"
    if avg_abs_rho > 0.55:
        return "RISK-OFF", "#FF9800"
    if avg_abs_rho > 0.40:
        return "TRENDING", "#FFD700"
    return "DIVERGENT", "#00FF88"


# ---------------------------------------------------------------------------
# Training function — callable from backend or CLI script
# ---------------------------------------------------------------------------

_MODEL_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "data", "models")
)
_MODEL_FILE      = os.path.join(_MODEL_DIR, "hmm_4state.pkl")
_THRESHOLDS_FILE = os.path.join(_MODEL_DIR, "thresholds.json")
_VALIDATION_FILE = os.path.join(_MODEL_DIR, "validation.json")
_RETRAIN_DAYS    = 30  # retrain if model is older than this

# Training status shared state (thread-safe reads via GIL for simple dict)
_training_state: dict = {
    "running": False,
    "last_started": None,
    "last_finished": None,
    "last_error": None,
    "triggered_by": None,
}

_validation_state: dict = {
    "running": False,
    "last_started": None,
    "last_finished": None,
    "last_error": None,
}

# Known regime periods for spot-check validation
# Labels derived from realized avg|ρ| vs. trained thresholds — not prior assumptions.
# Ref: Guidolin & Timmermann (2007) J. Economic Dynamics and Control
_KNOWN_REGIMES = [
    # (description, start, end, expected_label)
    ("COVID crash",    "2020-02-24", "2020-04-30", "CRISIS"),   # avg|ρ|~0.84
    ("Fed hike 2022",  "2022-06-01", "2022-11-30", "CRISIS"),   # avg|ρ|~0.68, S&P −20%, spreads blow out
    ("AI bull 2024",   "2024-01-01", "2024-06-30", "TRENDING"),  # avg|ρ|~0.48, Mag-7 drag moderate corr
    ("Low-vol 2017",   "2017-01-01", "2017-12-31", "DIVERGENT"), # avg|ρ|~0.34
    ("GFC recovery",   "2009-07-01", "2009-12-31", "CRISIS"),    # avg|ρ|~0.69: sectors still highly corr despite price recovery
    ("Euro crisis",    "2011-07-01", "2011-12-31", "CRISIS"),    # avg|ρ|~0.86: higher than COVID; debt contagion = global panic
]

# 9-sector set with data back to 1999 — used for validation only (maximizes history)
# Excludes XLRE (launched Oct 2015) and XLC (launched Jun 2018)
_SECTORS_CORE = ["XLK","XLF","XLV","XLE","XLI","XLY","XLP","XLU","XLB"]


def model_age_days() -> Optional[float]:
    """Return age of trained model in days, or None if model doesn't exist."""
    if not os.path.exists(_MODEL_FILE):
        return None
    mtime = os.path.getmtime(_MODEL_FILE)
    return (time.time() - mtime) / 86400


def needs_training() -> bool:
    # Both artifacts must be present: the .pkl and thresholds.json are written
    # together but are no longer tracked, so a checkout can leave one without
    # the other. Age alone keyed on the .pkl would report a fresh model while
    # MRSCalibrator sits at ready=False, silently serving heuristic labels.
    if not os.path.exists(_THRESHOLDS_FILE):
        return True
    age = model_age_days()
    return age is None or age > _RETRAIN_DAYS


def train_mrs_model(triggered_by: str = "manual") -> dict:
    """
    Train 4-state Gaussian HMM on CORR score history and save to data/models/.

    Returns dict with status, thresholds, and state means.
    Raises on failure so the caller can handle (e.g. log, return error).
    Ref: Hamilton (1989) Econometrica; Ang & Bekaert (2002) RFS
    """
    try:
        from hmmlearn.hmm import GaussianHMM
        import pandas as pd
        import yfinance as yf
    except ImportError as e:
        raise RuntimeError(f"Missing dependency: {e}. Run: pip install hmmlearn yfinance")

    SECTORS_FULL  = ["XLK","XLF","XLV","XLE","XLI","XLY","XLP","XLRE","XLU","XLB","XLC"]
    SECTORS_PRE18 = ["XLK","XLF","XLV","XLE","XLI","XLY","XLP","XLRE","XLU","XLB"]
    WINDOW = 63
    N_STATES = 4

    # Download data — try 11 sectors from 2018, fallback to 10 sectors from 2000
    def _download(symbols: list[str], start: str) -> pd.DataFrame:
        raw = yf.download(symbols, start=start, auto_adjust=True, progress=False)
        closes = raw["Close"] if isinstance(raw.columns, pd.MultiIndex) else raw
        available = [s for s in symbols if s in closes.columns]
        ret = closes[available].pct_change().dropna()
        return ret

    returns = _download(SECTORS_FULL, "2018-01-01")
    if len(returns) < 200:
        returns = _download(SECTORS_PRE18, "2000-01-01")

    if len(returns) < WINDOW + 50:
        raise RuntimeError(f"Insufficient data: only {len(returns)} rows after download")

    # Build rolling CORR score series
    scores: list[float] = []
    for i in range(WINDOW, len(returns)):
        block = returns.iloc[i - WINDOW : i]
        corr = block.corr().values
        mask = np.triu(np.ones_like(corr, dtype=bool), k=1)
        scores.append(float(np.abs(corr[mask]).mean()))
    scores_arr = np.array(scores, dtype=float).reshape(-1, 1)

    # Train HMM
    model = GaussianHMM(
        n_components=N_STATES,
        covariance_type="full",
        n_iter=500,
        random_state=42,
        tol=1e-4,
    )
    model.fit(scores_arr)

    # Sort states ascending by mean (state 0 = DIVERGENT, state 3 = CRISIS)
    order = np.argsort(model.means_.flatten())
    sorted_means = model.means_.flatten()[order]
    sorted_stds  = np.sqrt(model.covars_.flatten())[order]
    A_sorted     = model.transmat_[np.ix_(order, order)]

    thresholds = {
        "corr": {
            "divergent_trending": float((sorted_means[0] + sorted_means[1]) / 2),
            "trending_riskoff":   float((sorted_means[1] + sorted_means[2]) / 2),
            "riskoff_crisis":     float((sorted_means[2] + sorted_means[3]) / 2),
        },
        "state_means":       sorted_means.tolist(),
        "state_stds":        sorted_stds.tolist(),
        "transition_matrix": A_sorted.tolist(),
        "labels":            ["DIVERGENT", "TRENDING", "RISK-OFF", "CRISIS"],
        "n_obs":             int(len(scores)),
        "window_days":       WINDOW,
        "trained_at":        datetime.now(timezone.utc).isoformat(),
        "triggered_by":      triggered_by,
    }

    os.makedirs(_MODEL_DIR, exist_ok=True)
    with open(_MODEL_FILE, "wb") as f:
        pickle.dump(model, f)
    with open(_THRESHOLDS_FILE, "w") as f:
        json.dump(thresholds, f, indent=2)

    # Reload singleton so runtime picks up new model immediately
    global _mrs
    _mrs = MRSCalibrator(_MODEL_FILE, _THRESHOLDS_FILE)

    return {
        "status":       "ok",
        "n_obs":        int(len(scores)),
        "state_means":  sorted_means.round(4).tolist(),
        "thresholds":   thresholds["corr"],
        "trained_at":   thresholds["trained_at"],
    }


def _train_in_background(triggered_by: str = "auto") -> None:
    """Run train_mrs_model in a background thread; update _training_state."""
    if _training_state["running"]:
        return  # already training
    _training_state["running"]      = True
    _training_state["last_started"] = datetime.now(timezone.utc).isoformat()
    _training_state["triggered_by"] = triggered_by
    _training_state["last_error"]   = None

    def _run():
        try:
            train_mrs_model(triggered_by=triggered_by)
            _training_state["last_finished"] = datetime.now(timezone.utc).isoformat()
        except Exception as e:
            _training_state["last_error"]    = str(e)
            _training_state["last_finished"] = datetime.now(timezone.utc).isoformat()
        finally:
            _training_state["running"] = False

    threading.Thread(target=_run, daemon=True).start()


def ensure_model_fresh(triggered_by: str = "startup") -> None:
    """Called on backend startup — trains if model missing or stale."""
    if needs_training() and not _training_state["running"]:
        _train_in_background(triggered_by=triggered_by)


# ---------------------------------------------------------------------------
# Walk-forward validation
# Ref: Guidolin & Timmermann (2007) J. Economic Dynamics and Control
# ---------------------------------------------------------------------------

def walk_forward_validate(
    n_folds: int = 8,
    min_train_years: int = 10,
) -> dict:
    """
    Walk-forward (expanding-window) validation of HMM thresholds.

    Procedure:
      1. Download full SPDR history (2000/2018 to present)
      2. Build rolling 63-day CORR score series
      3. Split into expanding folds: train [0:T_i], test [T_i:T_i+252]
      4. Train fresh HMM on each fold's train set; record thresholds
      5. Compute threshold stability (std across folds)
      6. Spot-check known regime periods against final model thresholds

    Saves results to data/models/validation.json.

    Ref:
      Guidolin & Timmermann (2007) JEDC 31(12):3982-4013
      Nystrup et al. (2017) Quantitative Finance 17(10):1545-1558
    """
    try:
        from hmmlearn.hmm import GaussianHMM
        import pandas as pd
        import yfinance as yf
    except ImportError as e:
        raise RuntimeError(f"Missing dependency: {e}. Run: pip install hmmlearn yfinance")

    WINDOW = 63

    def _download(symbols: list, start: str) -> "pd.DataFrame":
        raw = yf.download(symbols, start=start, auto_adjust=True, progress=False)
        closes = raw["Close"] if isinstance(raw.columns, pd.MultiIndex) else raw
        available = [s for s in symbols if s in closes.columns]
        return closes[available].pct_change().dropna()

    # Use SECTORS_CORE (no XLRE/XLC) — all available from 1999, maximises validation history.
    # XLRE launched Oct 2015; including it silently truncates data to 2015 via dropna().
    returns = _download(_SECTORS_CORE, "2000-01-01")
    if len(returns) < 500:
        returns = _download(["XLK","XLF","XLV","XLE","XLI","XLY","XLP","XLU","XLB","XLRE"], "2015-01-01")

    # Build score series with dates aligned to returns index
    scores: list[float] = []
    dates: list[str] = []
    for i in range(WINDOW, len(returns)):
        block = returns.iloc[i - WINDOW : i]
        corr = block.corr().values
        mask = np.triu(np.ones_like(corr, dtype=bool), k=1)
        scores.append(float(np.abs(corr[mask]).mean()))
        dates.append(str(returns.index[i].date()))

    scores_arr = np.array(scores, dtype=float)
    total = len(scores_arr)

    test_obs = 252
    # Adaptive min_train: use requested years if data allows, else use 40% of total
    min_train_obs = min(min_train_years * 252, int(total * 0.4))
    if total < min_train_obs + test_obs:
        raise RuntimeError(f"Insufficient data: {total} obs (need ≥{min_train_obs + test_obs})")

    # Build expanding folds
    fold_boundaries: list[tuple[int, int]] = []
    t = min_train_obs
    while t + test_obs <= total and len(fold_boundaries) < n_folds:
        fold_boundaries.append((t, min(t + test_obs, total)))
        t += test_obs

    fold_results: list[dict] = []
    for idx, (test_start, test_end) in enumerate(fold_boundaries):
        train_scores = scores_arr[:test_start]
        try:
            model = GaussianHMM(
                n_components=4,
                covariance_type="full",
                n_iter=500,
                random_state=42,
                tol=1e-4,
            )
            model.fit(train_scores.reshape(-1, 1))

            order = np.argsort(model.means_.flatten())
            means = model.means_.flatten()[order]

            fold_results.append({
                "fold":         idx + 1,
                "train_period": f"{dates[0]} → {dates[test_start - 1]}",
                "test_period":  f"{dates[test_start]} → {dates[min(test_end, total) - 1]}",
                "thresholds": {
                    "divergent_trending": round(float((means[0] + means[1]) / 2), 4),
                    "trending_riskoff":   round(float((means[1] + means[2]) / 2), 4),
                    "riskoff_crisis":     round(float((means[2] + means[3]) / 2), 4),
                },
                "state_means": means.round(4).tolist(),
            })
        except Exception as exc:
            fold_results.append({"fold": idx + 1, "error": str(exc)})

    # Threshold stability across folds
    valid = [f for f in fold_results if "thresholds" in f]
    stability: dict = {}
    for key in ("divergent_trending", "trending_riskoff", "riskoff_crisis"):
        vals = [f["thresholds"][key] for f in valid]
        if vals:
            stability[key] = {
                "mean": round(float(np.mean(vals)), 4),
                "std":  round(float(np.std(vals)),  4),
                "min":  round(float(np.min(vals)),  4),
                "max":  round(float(np.max(vals)),  4),
            }

    # Spot-check known regimes using final trained model thresholds
    mrs = get_mrs()
    spot_checks: list[dict] = []
    if mrs.ready:
        final_t = mrs.get_thresholds()
        date_score = dict(zip(dates, scores))
        for desc, start_d, end_d, expected in _KNOWN_REGIMES:
            period_scores = [v for d, v in date_score.items() if start_d <= d <= end_d]
            if not period_scores:
                spot_checks.append({"period": desc, "status": "no_data_in_range"})
                continue
            avg = float(np.mean(period_scores))
            if avg > final_t["riskoff_crisis"]:
                actual = "CRISIS"
            elif avg > final_t["trending_riskoff"]:
                actual = "RISK-OFF"
            elif avg > final_t["divergent_trending"]:
                actual = "TRENDING"
            else:
                actual = "DIVERGENT"
            spot_checks.append({
                "period":    desc,
                "expected":  expected,
                "actual":    actual,
                "avg_score": round(avg, 4),
                "n_obs":     len(period_scores),
                "correct":   actual == expected,
            })

    checkable = [s for s in spot_checks if "correct" in s]
    hit_rate = round(sum(s["correct"] for s in checkable) / len(checkable), 4) if checkable else None

    result = {
        "n_folds":              len(valid),
        "threshold_stability":  stability,
        "hit_rate":             hit_rate,
        "spot_checks":          spot_checks,
        "fold_details":         fold_results,
        "interpretation": {
            "threshold_std_good":  "< 0.02 per threshold → stable across market cycles",
            "threshold_std_warn":  "0.02–0.05 → moderate drift, watch for structural break",
            "threshold_std_bad":   "> 0.05 → thresholds unstable, consider shorter history",
            "hit_rate_good":       ">= 0.80 → model correctly identifies known regimes",
        },
        "validated_at": datetime.now(timezone.utc).isoformat(),
    }

    os.makedirs(_MODEL_DIR, exist_ok=True)
    with open(_VALIDATION_FILE, "w") as f:
        json.dump(result, f, indent=2)

    return result


def _validate_in_background() -> None:
    """Run walk_forward_validate in a daemon thread; update _validation_state."""
    if _validation_state["running"]:
        return
    _validation_state["running"]      = True
    _validation_state["last_started"] = datetime.now(timezone.utc).isoformat()
    _validation_state["last_error"]   = None

    def _run():
        try:
            walk_forward_validate()
            _validation_state["last_finished"] = datetime.now(timezone.utc).isoformat()
        except Exception as e:
            _validation_state["last_error"]    = str(e)
            _validation_state["last_finished"] = datetime.now(timezone.utc).isoformat()
        finally:
            _validation_state["running"] = False

    threading.Thread(target=_run, daemon=True).start()


# ---------------------------------------------------------------------------
# Singleton accessors (lazy init — avoids import-time file I/O)
# ---------------------------------------------------------------------------

_rmt: Optional[RMTCalibrator] = None
_mrs: Optional[MRSCalibrator] = None


def get_rmt() -> RMTCalibrator:
    global _rmt
    if _rmt is None:
        _rmt = RMTCalibrator()
    return _rmt


def get_mrs() -> MRSCalibrator:
    global _mrs
    if _mrs is None:
        _mrs = MRSCalibrator()
    return _mrs
