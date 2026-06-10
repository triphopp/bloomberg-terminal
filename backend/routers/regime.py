"""
Regime Detection — US Sector ETF Correlation + Geometric Analysis

GET /api/regime/correlation?period=3m&mode=corr
GET /api/regime/correlation?period=3m&mode=geom
"""
from __future__ import annotations

import json as _json
import math
import os
import threading
import time
from typing import Any

import numpy as np
import pandas as pd
import yfinance as yf
from fastapi import APIRouter, Query
from analytics.regime_calibration import (
    RMTCalibrator, get_mrs, _heuristic_corr_label,
    _train_in_background, _training_state, model_age_days, needs_training,
    _validate_in_background, _validation_state, _VALIDATION_FILE,
    _MODEL_FILE, _THRESHOLDS_FILE,
)

router = APIRouter(prefix="/api/regime", tags=["regime"])

SECTORS = [
    {"symbol": "XLK",  "name": "Technology",     "abbr": "TECH"},
    {"symbol": "XLF",  "name": "Financials",      "abbr": "FIN"},
    {"symbol": "XLV",  "name": "Health Care",     "abbr": "HLTH"},
    {"symbol": "XLE",  "name": "Energy",          "abbr": "ENRG"},
    {"symbol": "XLI",  "name": "Industrials",     "abbr": "INDU"},
    {"symbol": "XLY",  "name": "Cons Discret",    "abbr": "COND"},
    {"symbol": "XLP",  "name": "Cons Staples",    "abbr": "CONS"},
    {"symbol": "XLRE", "name": "Real Estate",     "abbr": "REIT"},
    {"symbol": "XLU",  "name": "Utilities",       "abbr": "UTIL"},
    {"symbol": "XLB",  "name": "Materials",       "abbr": "MATR"},
    {"symbol": "XLC",  "name": "Comm Services",   "abbr": "COMM"},
]

PERIOD_MAP: dict[str, tuple[str, str]] = {
    "1m": ("1mo",  "1d"),
    "3m": ("3mo",  "1d"),
    "6m": ("6mo",  "1d"),
    "1y": ("1y",   "1d"),
    "2y": ("2y",   "1wk"),
}

_cache: dict[str, tuple[float, Any]] = {}
_lock = threading.Lock()
_TTL = 300


def _get_cached(key: str, factory):
    now = time.time()
    with _lock:
        if key in _cache and now - _cache[key][0] < _TTL:
            return _cache[key][1]
    val = factory()
    with _lock:
        _cache[key] = (now, val)
    return val


def _fetch_returns(period: str) -> pd.DataFrame | None:
    yf_period, interval = PERIOD_MAP.get(period, ("3mo", "1d"))
    symbols = [s["symbol"] for s in SECTORS]
    try:
        raw = yf.download(
            symbols, period=yf_period, interval=interval,
            auto_adjust=True, progress=False, threads=True,
        )
        if isinstance(raw.columns, pd.MultiIndex):
            closes = raw["Close"]
        else:
            closes = raw
        available = [s for s in symbols if s in closes.columns]
        if len(available) < 3:
            return None
        ret = closes[available].pct_change().dropna()
        return ret if len(ret) >= 10 else None
    except Exception:
        return None


# ── PCA 2D projection of sector return vectors ────────────────────────────────
# The correlation matrix IS the Gram matrix of unit-normalised return vectors:
# C_ij = <r̂_i, r̂_j> = cos(θ_ij).
# Eigendecomposition gives the principal axes of this vector set.
# Coordinates: (√λ₁·v₁[i], √λ₂·v₂[i]) — optimal 2D embedding preserving angles.
# Close arrows → correlated sectors; orthogonal arrows → independent.

def _pca_2d(corr_matrix: np.ndarray) -> tuple[list[list[float]], list[float]]:
    """
    Returns (positions_2d, variance_explained).
    positions_2d: list of [x, y] in [-1, 1], one per sector.
    variance_explained: [pct_pc1, pct_pc2] in [0, 1].
    """
    try:
        eigenvalues, eigenvectors = np.linalg.eigh(corr_matrix)
        # Sort descending
        idx = np.argsort(eigenvalues)[::-1]
        ev = eigenvalues[idx]
        ec = eigenvectors[:, idx]

        total = float(np.sum(ev[ev > 0]))
        var_exp = [round(float(ev[k]) / total, 4) if total > 0 else 0.0 for k in range(2)]

        # Scale by sqrt(eigenvalue) so that inner-product in 2D ≈ actual correlation
        x = ec[:, 0] * math.sqrt(max(0.0, float(ev[0])))
        y = ec[:, 1] * math.sqrt(max(0.0, float(ev[1])))

        # Normalise to fit in [-1, 1]
        scale = max(np.max(np.abs(x)), np.max(np.abs(y)), 1e-9)
        x, y = x / scale, y / scale

        positions = [[round(float(x[i]), 4), round(float(y[i]), 4)] for i in range(len(x))]
        return positions, var_exp
    except Exception:
        return [], [0.0, 0.0]


# ── Regime from Gram determinant — RMT-calibrated (GEOM mode) ────────────────
# Label now comes from k_signal (eigenvalues above Marchenko-Pastur bound),
# not arbitrary heuristic thresholds.
# Ref: Laloux et al. (1999) PRL; Plerou et al. (2002) PRE

def _regime_gram(returns: pd.DataFrame) -> tuple[float, str, str, int, float]:
    """Returns (score, label, color, k_signal, lambda_max)."""
    try:
        G = returns.corr().values.astype(float)
        T = len(returns)
        result = RMTCalibrator.analyze(G, T)
        return (
            result["score"],
            result["label"],
            result["color"],
            result["k_signal"],
            result["lambda_max"],
        )
    except Exception:
        return 0.0, "CORRELATED", "#FF4444", 0, 2.0


# ── Regime from average |ρ| (CORR mode) ──────────────────────────────────────
# Uses MRS-calibrated thresholds if trained model exists; falls back to
# heuristic thresholds (0.40, 0.55, 0.70) when model is absent.
# Ref: Hamilton (1989) Econometrica; Ang & Bekaert (2002) RFS

def _regime_avg_corr(matrix: list[list[float]], n: int) -> tuple[float, str, str, str]:
    """Returns (score, label, color, calibration_method)."""
    total, count = 0.0, 0
    for i in range(n):
        for j in range(i + 1, n):
            total += abs(matrix[i][j])
            count += 1
    avg = round(total / count, 4) if count else 0.0

    mrs = get_mrs()
    if mrs.ready:
        label, color = mrs.label_from_score(avg)
        return avg, label, color, "MRS"

    label, color = _heuristic_corr_label(avg)
    return avg, label, color, "heuristic"


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.get("/correlation")
def get_correlation(
    period: str = Query("3m", pattern="^(1m|3m|6m|1y|2y)$"),
    mode:   str = Query("corr", pattern="^(corr|geom)$"),
):
    def compute():
        returns = _fetch_returns(period)
        if returns is None:
            return {
                "error": "Insufficient data",
                "sectors": [], "abbrs": [], "symbols": [],
                "matrix": [], "regime_score": 0,
                "regime_label": "N/A", "regime_color": "#888",
            }

        meta = {s["symbol"]: s for s in SECTORS}
        syms = [s for s in returns.columns if s in meta]
        if len(syms) < 3:
            return {"error": "Too few sectors", "sectors": [], "abbrs": [], "symbols": [],
                    "matrix": [], "regime_score": 0, "regime_label": "N/A", "regime_color": "#888"}

        ret = returns[syms]
        corr = ret.corr()

        corr_arr = corr.values.astype(float)
        positions_2d, variance_explained = _pca_2d(corr_arr)

        if mode == "geom":
            # Cell (i,j) = |sin θ_ij| = √(1 − ρ²) — magnitude of the 2-blade
            # (wedge product) of normalised return vectors.
            # 0 = co-moving (parallel), 1 = fully independent (orthogonal).
            matrix = []
            for ri in syms:
                row = []
                for ci in syms:
                    rho = float(corr.loc[ri, ci])
                    row.append(round(math.sqrt(max(0.0, 1.0 - rho * rho)), 4))
                matrix.append(row)
            regime_score, regime_label, regime_color, k_signal, lambda_max = _regime_gram(ret)
            description = "Wedge magnitude |sin θᵢⱼ|=√(1−ρ²): 0=co-move, 1=orthogonal"
            extra = {
                "k_signal":           k_signal,
                "lambda_max":         lambda_max,
                "calibration_method": "RMT",
            }
        else:
            matrix = [[round(float(corr.loc[ri, ci]), 4) for ci in syms] for ri in syms]
            regime_score, regime_label, regime_color, cal_method = _regime_avg_corr(matrix, len(syms))
            description = "Pearson ρ: +1=positive, 0=none, −1=negative correlation"
            extra = {"calibration_method": cal_method}

        return {
            "sectors":            [meta[s]["name"] for s in syms],
            "abbrs":              [meta[s]["abbr"] for s in syms],
            "symbols":            syms,
            "matrix":             matrix,
            "positions_2d":       positions_2d,
            "variance_explained": variance_explained,
            "regime_score":       regime_score,
            "regime_label":       regime_label,
            "regime_color":       regime_color,
            "description":        description,
            "mode":               mode,
            "period":             period,
            "n":                  len(syms),
            **extra,
        }

    return _get_cached(f"regime:{period}:{mode}", compute)


# ── Trend endpoint — all periods in one call ──────────────────────────────────

@router.get("/trend")
def get_regime_trend(
    mode: str = Query("corr", pattern="^(corr|geom)$"),
):
    """
    Returns regime scores for ALL periods (1m, 3m, 6m, 1y) in one call.
    Also computes trend direction: CONTRACTING (risk rising) vs EXPANDING (risk falling).

    Trend logic:
      CORR:  score↑ recent vs history = sectors more correlated = risk rising = CONTRACTING
      GEOM:  score↓ recent vs history = volume collapsing = risk rising = CONTRACTING

    risk_delta > 0 → CONTRACTING (1m riskier than 1y)
    risk_delta < 0 → EXPANDING   (1m safer than 1y)
    |risk_delta| < 0.05 → STABLE
    """
    import concurrent.futures

    def _score_for_period(period: str) -> dict:
        """
        Return {score, label, color} for a period.
        Uses a SEPARATE cache namespace ("regime:score:…") to avoid colliding
        with the full correlation endpoint cache ("regime:…") which returns a
        different shape (regime_score vs score).
        If the full-correlation cache already exists, adapt from it instead of
        re-fetching data.
        """
        # Try to adapt from full correlation cache first (free — already computed)
        full = _cache.get(f"regime:{period}:{mode}")
        if full and isinstance(full, tuple) and len(full) == 2:
            cached_val = full[1]
            if isinstance(cached_val, dict):
                if "score" in cached_val:
                    return cached_val  # already the compact form
                if "regime_score" in cached_val:
                    return {
                        "score": cached_val["regime_score"],
                        "label": cached_val["regime_label"],
                        "color": cached_val["regime_color"],
                    }

        # Otherwise compute fresh with own cache key
        def compute():
            returns = _fetch_returns(period)
            if returns is None:
                return None
            meta = {s["symbol"]: s for s in SECTORS}
            syms = [s for s in returns.columns if s in meta]
            if len(syms) < 3:
                return None
            ret = returns[syms]
            if mode == "geom":
                score, label, color, *_ = _regime_gram(ret)
            else:
                corr = ret.corr()
                matrix = [[round(float(corr.loc[ri, ci]), 4) for ci in syms] for ri in syms]
                score, label, color, *_ = _regime_avg_corr(matrix, len(syms))
            return {"score": score, "label": label, "color": color}

        result = _get_cached(f"regime:score:{period}:{mode}", compute)
        return result if result else {"score": 0.0, "label": "N/A", "color": "#888"}

    periods_list = ["1m", "3m", "6m", "1y"]

    def _fetch_all():
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
            futures = {p: ex.submit(_score_for_period, p) for p in periods_list}
            results = {p: f.result() for p, f in futures.items()}

        # Normalise to "risk score" for trend calculation
        # CORR: risk = score (higher = more correlated = more risk)
        # GEOM: risk = 1 - score (lower volume = more risk)
        def risk(p: str) -> float:
            s = results[p]["score"]
            return s if mode == "corr" else (1.0 - s)

        risk_1m = risk("1m")
        risk_1y = risk("1y")
        delta = round(risk_1m - risk_1y, 4)   # + = CONTRACTING, - = EXPANDING

        if abs(delta) < 0.05:
            trend = "STABLE"
            trend_color = "#888888"
        elif delta > 0:
            trend = "CONTRACTING"
            trend_color = "#FF4444"   # risk rising
        else:
            trend = "EXPANDING"
            trend_color = "#00FF88"   # risk falling

        return {
            "mode": mode,
            "periods": results,
            "trend": trend,
            "trend_color": trend_color,
            "risk_delta": delta,
            "note": (
                "risk_delta = risk_1m - risk_1y. "
                "CONTRACTING = more correlated recently (risk ↑). "
                "EXPANDING = more divergent recently (risk ↓)."
            ),
        }

    return _get_cached(f"regime:trend:{mode}", _fetch_all)


# ── Calibrated endpoint — RMT (GEOM) + MRS (CORR) combined ──────────────────

@router.get("/calibrated")
def get_calibrated(
    period: str = Query("3m", pattern="^(1m|3m|6m|1y)$"),
):
    """
    Returns both CORR and GEOM regime analysis with calibrated thresholds.

    GEOM: Random Matrix Theory — k_signal from Marchenko-Pastur bound.
    CORR: MRS-calibrated thresholds if model trained, else heuristic fallback.

    Train the MRS model with: python scripts/train_hmm.py
    """
    def compute():
        returns = _fetch_returns(period)
        if returns is None:
            return {"error": "Insufficient data"}

        meta = {s["symbol"]: s for s in SECTORS}
        syms = [s for s in returns.columns if s in meta]
        if len(syms) < 3:
            return {"error": "Too few sectors"}

        ret = returns[syms]
        corr_matrix_df = ret.corr()
        corr_matrix = corr_matrix_df.values.astype(float)
        T = len(ret)

        # GEOM — RMT
        rmt_result = RMTCalibrator.analyze(corr_matrix, T)

        # CORR — avg|ρ|
        flat_matrix = [[round(float(corr_matrix_df.loc[ri, ci]), 4) for ci in syms] for ri in syms]
        corr_score, corr_label, corr_color, corr_method = _regime_avg_corr(flat_matrix, len(syms))

        # Conflict detection using raw risk scores (avoids label-rank asymmetry bug).
        # CORR risk = score (higher avg|ρ| = riskier).
        # GEOM risk = 1 − score (lower det^(1/N) = more correlated = riskier).
        # Conflict when the two modes disagree on risk by > 0.20 absolute units.
        geom_risk = round(1.0 - rmt_result["score"], 4)
        corr_risk  = corr_score
        risk_gap   = round(abs(geom_risk - corr_risk), 4)
        conflict   = risk_gap > 0.20

        mrs = get_mrs()

        return {
            "period": period,
            "geom": {
                "score":          rmt_result["score"],
                "label":          rmt_result["label"],
                "color":          rmt_result["color"],
                "risk":           geom_risk,
                "k_signal":       rmt_result["k_signal"],
                "lambda_max":     rmt_result["lambda_max"],
                "lambda_1":       rmt_result["lambda_1"],
                "factor_regime":  rmt_result["factor_regime"],
                "eigenvalues_top5": rmt_result["eigenvalues_top5"],
                "method":         "RMT",
            },
            "corr": {
                "score":  corr_score,
                "risk":   corr_risk,
                "label":  corr_label,
                "color":  corr_color,
                "method": corr_method,
                "calibrated_thresholds": mrs.get_thresholds() if mrs.ready else {
                    "divergent_trending": 0.40,
                    "trending_riskoff":   0.55,
                    "riskoff_crisis":     0.70,
                    "note": "heuristic — run scripts/train_hmm.py to calibrate",
                },
            },
            "conflict":   conflict,
            "risk_gap":   risk_gap,
            "mrs_ready":  mrs.ready,
            "n_sectors":  len(syms),
            "n_obs":      T,
        }

    return _get_cached(f"regime:calibrated:{period}", compute)


# ── Model status ──────────────────────────────────────────────────────────────

@router.get("/model-status")
def get_model_status():
    """
    Returns MRS model age, training state, and calibrated thresholds.
    Use to check if retraining is needed or in progress.
    """
    age = model_age_days()
    mrs = get_mrs()
    return {
        "mrs_ready":       mrs.ready,
        "model_age_days":  round(age, 1) if age is not None else None,
        "needs_retrain":   needs_training(),
        "retrain_after_days": 30,
        "training": {
            "running":       _training_state["running"],
            "last_started":  _training_state["last_started"],
            "last_finished": _training_state["last_finished"],
            "last_error":    _training_state["last_error"],
            "triggered_by":  _training_state["triggered_by"],
        },
        "calibrated_thresholds": mrs.get_thresholds(),
        "state_means":           mrs.thresholds.get("state_means") if mrs.ready else None,
        "model_path":            _MODEL_FILE,
    }


# ── Manual retrain trigger ────────────────────────────────────────────────────

@router.post("/retrain")
def trigger_retrain():
    """
    Trigger MRS model retraining in background.
    Downloads SPDR sector data and trains 4-state Gaussian HMM (~2-5 min).
    Poll GET /api/regime/model-status to check progress.
    """
    if _training_state["running"]:
        return {"status": "already_running", "message": "Training already in progress"}
    _train_in_background(triggered_by="manual-api")
    return {
        "status":  "started",
        "message": "Training started in background. Poll /api/regime/model-status for progress.",
    }


# ── Walk-forward validation ───────────────────────────────────────────────────

@router.get("/validation")
def get_validation():
    """
    Return cached walk-forward validation results.

    Fields:
      n_folds              — number of expanding folds evaluated
      threshold_stability  — mean/std/min/max per threshold across folds
                             std < 0.02 = stable; > 0.05 = structural drift
      hit_rate             — fraction of known regime periods correctly labeled
                             >= 0.80 = model correctly identifies known regimes
      spot_checks          — per-period: expected vs actual label, avg_score, n_obs
      fold_details         — per-fold: train/test dates, thresholds, state_means

    Run POST /api/regime/validate to regenerate (takes ~5-10 min).
    Ref: Guidolin & Timmermann (2007) JEDC 31(12):3982-4013
    """
    if os.path.exists(_VALIDATION_FILE):
        with open(_VALIDATION_FILE, encoding="utf-8") as f:
            data = _json.load(f)
        data["validation_state"] = _validation_state
        return data
    return {
        "error": "No validation results yet.",
        "hint":  "Run POST /api/regime/validate to generate (takes ~5-10 min).",
        "validation_state": _validation_state,
    }


@router.post("/validate")
def trigger_validation():
    """
    Run walk-forward validation in background (~5-10 min).
    Downloads full SPDR history, trains HMM on each expanding fold,
    computes threshold stability and spot-checks known regime periods.
    Poll GET /api/regime/validation to check progress and results.
    """
    if _validation_state["running"]:
        return {"status": "already_running", "message": "Validation already in progress"}
    if _training_state["running"]:
        return {"status": "blocked", "message": "Wait for retraining to finish first"}
    _validate_in_background()
    return {
        "status":  "started",
        "message": "Validation started in background. Poll /api/regime/validation for results.",
    }
