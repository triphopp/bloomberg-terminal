"""
BC Layer — Sigmoid threshold calibration vs NBER recession dates.

Finds optimal center/sharpness for the sigmoid soft-assignment so that
p_contraction is maximised during NBER recessions and p_expansion during
expansions.  Outputs params to data/models/bc_thresholds.json which
sector_bc.py loads at startup.

Usage (run once, or whenever FRED data is refreshed):
    cd backend
    python -m analytics.bc_calibration

Ref: NBER Business Cycle Dating Committee — https://www.nber.org/research/business-cycles
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from statistics import mean, stdev
from typing import Optional

import numpy as np

# ---------------------------------------------------------------------------
# NBER recession periods (YYYYMMDD)
# Source: https://www.nber.org/research/business-cycles
# ---------------------------------------------------------------------------

NBER_RECESSIONS: list[tuple[str, str]] = [
    ("1990-07-01", "1991-03-31"),   # Gulf War recession
    ("2001-03-01", "2001-11-30"),   # Dot-com / 9-11
    ("2007-12-01", "2009-06-30"),   # Global Financial Crisis
    ("2020-02-01", "2020-04-30"),   # COVID-19
]

_BC_THRESHOLDS_PATH = Path(__file__).parent.parent.parent / "data" / "models" / "bc_thresholds.json"

# ---------------------------------------------------------------------------
# Helper — also used by sector_bc.py for disk cache
# ---------------------------------------------------------------------------

def _is_recession(date_str: str) -> bool:
    """Return True if date falls within a NBER recession."""
    for start, end in NBER_RECESSIONS:
        if start <= date_str <= end:
            return True
    return False


def load_bc_thresholds() -> Optional[dict]:
    """Load calibrated BC thresholds from disk.  Returns None if file missing."""
    if not _BC_THRESHOLDS_PATH.exists():
        return None
    try:
        return json.loads(_BC_THRESHOLDS_PATH.read_text())
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Core calibration
# ---------------------------------------------------------------------------

def _fetch_series(series_id: str, days_back: int = 9000) -> dict[str, float]:
    """Fetch a FRED series via JSON API.  Returns {date: value} dict."""
    try:
        import requests
        sys.path.insert(0, str(Path(__file__).parent.parent))
        from config import FRED_API_KEY, FRED_CSV_URL
    except Exception as e:
        raise RuntimeError(f"Cannot import config: {e}")

    FRED_API_BASE = "https://api.stlouisfed.org/fred/series/observations"
    end   = datetime.utcnow()
    start = end - timedelta(days=days_back)

    # JSON API first (if key available)
    if FRED_API_KEY:
        try:
            r = requests.get(
                FRED_API_BASE,
                params={
                    "series_id":  series_id,
                    "api_key":    FRED_API_KEY,
                    "file_type":  "json",
                    "sort_order": "asc",
                    "observation_start": start.strftime("%Y-%m-%d"),
                },
                timeout=20,
                headers={"User-Agent": "Mozilla/5.0"},
            )
            if r.ok:
                out: dict[str, float] = {}
                for obs in r.json().get("observations", []):
                    v = obs.get("value", ".")
                    if v not in (".", ""):
                        try:
                            out[obs["date"]] = float(v)
                        except ValueError:
                            pass
                if out:
                    print(f"  {series_id}: {len(out)} obs from JSON API")
                    return out
        except Exception as e:
            print(f"  {series_id} JSON API failed: {e}")

    # CSV fallback
    import csv, io, requests
    url = (
        f"{FRED_CSV_URL}?id={series_id}"
        f"&cosd={start.strftime('%Y-%m-%d')}"
        f"&coed={end.strftime('%Y-%m-%d')}"
    )
    r = requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    out = {}
    reader = csv.reader(io.StringIO(r.text))
    next(reader)
    for row in reader:
        if len(row) < 2 or row[1].strip() in (".", ""):
            continue
        try:
            out[row[0]] = float(row[1])
        except ValueError:
            pass
    print(f"  {series_id}: {len(out)} obs from CSV")
    return out


def _rolling_z(values: list[float], window: int) -> list[float | None]:
    """Compute rolling z-score for each index (returns None for warm-up period)."""
    out: list[float | None] = []
    for i, v in enumerate(values):
        if i < window - 1:
            out.append(None)
            continue
        hist = values[i - window + 1 : i + 1]
        mu = mean(hist)
        sd = stdev(hist) if len(hist) > 1 else 1.0
        if sd < 1e-8:
            out.append(0.0)
        else:
            out.append((v - mu) / sd)
    return out


def _forward_fill(data: dict[str, float], dates: list[str]) -> list[float | None]:
    """Map data dict to a date list, forward-filling missing values (monthly → daily)."""
    out: list[float | None] = []
    last = None
    for d in dates:
        if d in data:
            last = data[d]
        out.append(last)
    return out


def sigmoid(x: float, center: float, sharpness: float) -> float:
    return 1.0 / (1.0 + np.exp(-sharpness * (x - center)))


def compute_cycle_scores(
    slope_z: list[float | None],
    pmi_z:   list[float | None],
    spread_z: list[float | None],
    dpmi_z:  list[float | None],
) -> list[float | None]:
    out = []
    for s, p, sp, dp in zip(slope_z, pmi_z, spread_z, dpmi_z):
        if None in (s, p, sp, dp):
            out.append(None)
        else:
            cs = 0.30 * s + 0.30 * p + 0.25 * sp + 0.15 * dp  # type: ignore[operator]
            out.append(float(np.clip(cs, -3.0, 3.0)))
    return out


def calibrate() -> dict:
    """
    Fetch 25 years of FRED data, compute historical cycle_scores, and
    grid-search for optimal sigmoid center/sharpness that best separates
    NBER recessions from expansions.

    Returns dict with optimal params + validation metrics.
    """
    print("Fetching FRED data (~25 years)...")
    t10y2y_data = _fetch_series("T10Y2Y",       days_back=9500)   # daily
    cfnai_data  = _fetch_series("CFNAI",         days_back=9500)   # monthly
    hy_data     = _fetch_series("BAMLH0A0HYM2",  days_back=9500)   # daily

    # Build sorted date list (daily from oldest to newest)
    all_dates_set = set(t10y2y_data) | set(cfnai_data) | set(hy_data)
    dates = sorted(d for d in all_dates_set if d >= "2000-01-01")
    print(f"Date range: {dates[0]} → {dates[-1]}  ({len(dates)} days)")

    # Forward-fill monthly series to daily
    t10y2y_ff  = _forward_fill(t10y2y_data, dates)
    cfnai_ff   = _forward_fill(cfnai_data,  dates)
    hy_ff      = _forward_fill(hy_data,     dates)

    # Compute z-scores
    # T10Y2Y: daily window 252
    t10y2y_vals = [v for v in t10y2y_ff if v is not None]
    # Build parallel series handling None
    slope_z: list[float | None] = []
    pmi_z:   list[float | None] = []
    spread_z: list[float | None] = []

    # Z-score over a running window — do it over full arrays
    def z_series(ff: list[float | None], window: int, invert: bool = False) -> list[float | None]:
        vals = [v if v is not None else float("nan") for v in ff]
        out: list[float | None] = []
        for i in range(len(vals)):
            if np.isnan(vals[i]):
                out.append(None)
                continue
            hist = [v for v in vals[max(0, i - window + 1):i + 1] if not np.isnan(v)]
            if len(hist) < max(window // 2, 10):
                out.append(None)
                continue
            mu = float(np.mean(hist))
            sd = float(np.std(hist))
            if sd < 1e-8:
                out.append(0.0)
            else:
                z = float((vals[i] - mu) / sd)
                out.append(-z if invert else z)
        return out

    slope_z  = z_series(t10y2y_ff, window=252)
    pmi_z    = z_series(cfnai_ff,  window=36)   # monthly proxy
    spread_z = z_series(hy_ff,     window=252, invert=True)  # wider spread = bad

    # Momentum: 3-lag difference for CFNAI
    dpmi_z: list[float | None] = []
    cfnai_clean = [v for v in cfnai_ff if v is not None]
    cfnai_full: list[float | None] = []
    c_ptr = 0
    for v in cfnai_ff:
        cfnai_full.append(v)

    for i in range(len(cfnai_ff)):
        v = cfnai_ff[i]
        if v is None:
            dpmi_z.append(None)
            continue
        lag = 3
        if i < lag:
            dpmi_z.append(None)
            continue
        prev = cfnai_ff[i - lag]
        if prev is None:
            dpmi_z.append(None)
            continue
        dpmi_z.append(None)  # placeholder — compute below

    # Better dpmi_z
    dpmi_z = []
    for i, v in enumerate(cfnai_ff):
        if v is None:
            dpmi_z.append(None)
            continue
        lag = 3
        if i < lag:
            dpmi_z.append(0.0)
            continue
        prev = cfnai_ff[i - lag]
        if prev is None:
            dpmi_z.append(0.0)
            continue
        delta = v - prev
        # z-score delta over past 36 obs
        hist_delta = []
        for j in range(lag, i + 1):
            a, b = cfnai_ff[j], cfnai_ff[j - lag]
            if a is not None and b is not None:
                hist_delta.append(a - b)
        if len(hist_delta) < 5:
            dpmi_z.append(0.0)
        else:
            mu_d = mean(hist_delta)
            sd_d = stdev(hist_delta) if len(hist_delta) > 1 else 1.0
            dpmi_z.append(0.0 if sd_d < 1e-8 else (delta - mu_d) / sd_d)

    cycle_scores = compute_cycle_scores(slope_z, pmi_z, spread_z, dpmi_z)

    # Build (date, cycle_score, is_recession) rows — drop None
    rows = [
        (d, cs, _is_recession(d))
        for d, cs in zip(dates, cycle_scores)
        if cs is not None
    ]
    print(f"Valid rows for calibration: {len(rows)}")
    n_rec = sum(1 for _, _, r in rows if r)
    print(f"  Recession days: {n_rec} ({100*n_rec/len(rows):.1f}%)")

    if len(rows) < 500:
        raise RuntimeError("Insufficient valid rows — check FRED data availability")

    # ── Grid search ─────────────────────────────────────────────────────────
    # Optimize: maximize F1 for recession classification.
    # Recession predicted when p_contraction >= 0.50
    # p_contraction = 1.0 - sigmoid(cs, center=center_cont, sharpness=sharpness)

    best_f1  = -1.0
    best_params: dict = {}

    # Grid: center from -2.0 to 0.0, sharpness from 0.5 to 5.0
    centers    = np.arange(-2.0, 0.1, 0.1)
    sharpnesses = np.arange(0.5, 5.5, 0.5)

    cs_arr   = np.array([cs for _, cs, _ in rows])
    rec_arr  = np.array([int(r) for _, _, r in rows])

    for center in centers:
        for sharpness in sharpnesses:
            p_cont = 1.0 - (1.0 / (1.0 + np.exp(-sharpness * (cs_arr - center))))
            pred   = (p_cont >= 0.5).astype(int)
            tp = int(np.sum((pred == 1) & (rec_arr == 1)))
            fp = int(np.sum((pred == 1) & (rec_arr == 0)))
            fn = int(np.sum((pred == 0) & (rec_arr == 1)))
            prec = tp / (tp + fp + 1e-9)
            rec  = tp / (tp + fn + 1e-9)
            f1   = 2 * prec * rec / (prec + rec + 1e-9)
            acc  = float(np.mean(pred == rec_arr))
            if f1 > best_f1:
                best_f1 = f1
                best_params = {
                    "contraction_center":    round(float(center), 2),
                    "contraction_sharpness": round(float(sharpness), 2),
                    "f1_recession":          round(f1, 4),
                    "accuracy":              round(acc, 4),
                    "precision":             round(prec, 4),
                    "recall":                round(rec, 4),
                }

    print(f"\nBest params (contraction sigmoid):")
    for k, v in best_params.items():
        print(f"  {k}: {v}")

    # Also find expansion center (symmetric: best F1 for non-recession)
    # Expansion predicted when p_expansion >= 0.5
    # p_expansion = sigmoid(cs, center=center_exp, sharpness=sharpness_exp)
    best_f1_exp = -1.0
    best_exp: dict = {}
    exp_arr = 1 - rec_arr
    for center in np.arange(0.0, 2.1, 0.1):
        for sharpness in np.arange(0.5, 5.5, 0.5):
            p_exp = 1.0 / (1.0 + np.exp(-sharpness * (cs_arr - center)))
            pred  = (p_exp >= 0.5).astype(int)
            tp = int(np.sum((pred == 1) & (exp_arr == 1)))
            fp = int(np.sum((pred == 1) & (exp_arr == 0)))
            fn = int(np.sum((pred == 0) & (exp_arr == 1)))
            prec = tp / (tp + fp + 1e-9)
            rec  = tp / (tp + fn + 1e-9)
            f1   = 2 * prec * rec / (prec + rec + 1e-9)
            if f1 > best_f1_exp:
                best_f1_exp = f1
                best_exp = {
                    "expansion_center":    round(float(center), 2),
                    "expansion_sharpness": round(float(sharpness), 2),
                    "f1_expansion":        round(f1, 4),
                }

    print(f"\nBest params (expansion sigmoid):")
    for k, v in best_exp.items():
        print(f"  {k}: {v}")

    # Phase label thresholds: find cycle_score cutoffs that match NBER
    # recession_threshold = cs where p_contraction transitions
    # use contraction_center as the threshold (sigmoid midpoint = 50%)
    result = {
        **best_params,
        **best_exp,
        "recession_threshold": best_params["contraction_center"],
        "expansion_threshold": best_exp["expansion_center"],
        "n_days_calibrated":   len(rows),
        "nber_recessions_used": NBER_RECESSIONS,
        "calibrated_at":       datetime.utcnow().isoformat(),
        "interpretation": {
            "contraction_center":  "cycle_score at which p_contraction=0.5 (recession boundary)",
            "expansion_center":    "cycle_score at which p_expansion=0.5 (expansion boundary)",
            "recession_threshold": "use as phase_label RECESSION cutoff (replaces hardcoded -1.0)",
            "expansion_threshold": "use as phase_label EARLY_RECOVERY cutoff (replaces hardcoded +1.0)",
        },
    }

    # Save to disk
    _BC_THRESHOLDS_PATH.parent.mkdir(parents=True, exist_ok=True)
    _BC_THRESHOLDS_PATH.write_text(json.dumps(result, indent=2))
    print(f"\nSaved to {_BC_THRESHOLDS_PATH}")

    return result


def needs_calibration() -> bool:
    """True if calibration file missing or older than 90 days."""
    if not _BC_THRESHOLDS_PATH.exists():
        return True
    age_days = (time.time() - _BC_THRESHOLDS_PATH.stat().st_mtime) / 86400
    return age_days > 90


def ensure_calibrated(triggered_by: str = "startup") -> None:
    """Auto-calibrate in background if file missing or stale.  Safe to call at startup."""
    import threading
    if not needs_calibration():
        return

    def _run():
        try:
            print(f"[bc_calibration] Auto-calibrating BC thresholds (triggered_by={triggered_by})...")
            calibrate()
            # Reload thresholds into sector_bc module
            try:
                import analytics.sector_bc as _bc
                fresh = load_bc_thresholds() or {}
                _bc._BC_THRESHOLDS   = fresh
                _bc._CONT_CENTER     = fresh.get("contraction_center",  -0.8)
                _bc._CONT_SHARP      = fresh.get("contraction_sharpness", 2.0)
                _bc._EXP_CENTER      = fresh.get("expansion_center",    +0.8)
                _bc._EXP_SHARP       = fresh.get("expansion_sharpness",   2.0)
                _bc._REC_THRESHOLD   = fresh.get("recession_threshold",  -0.8)
                _bc._EXP_THRESHOLD   = fresh.get("expansion_threshold",  +0.8)
                _bc.clear_bc_cache()   # force recompute with new thresholds
                print("[bc_calibration] Thresholds reloaded into sector_bc.")
            except Exception as e:
                print(f"[bc_calibration] Reload warning: {e}")
        except Exception as e:
            print(f"[bc_calibration] Auto-calibration failed: {e}")

    threading.Thread(target=_run, daemon=True, name="bc-calibration").start()


if __name__ == "__main__":
    calibrate()
