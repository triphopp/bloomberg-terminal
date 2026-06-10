"""
Layer BC — Business Cycle Phase Detection.

Determines the current business cycle phase via a 4-indicator composite
z-score, then applies sigmoid soft assignment to compute continuous phase
probabilities.  Each sector is scored via the Stovall (1996) favorability
matrix (11 sectors × 4 phases), validated out-of-sample by Stangl et al.
(2009).

References:
  Stovall (1996) — Standard & Poor's Guide to Sector Investing
  Stangl, Jacobsen & Visaltanachoti (2009) — Sector Rotation over Business Cycles
  Conover, Jensen, Johnson & Mercer (2008) — Sector Rotation and Monetary Conditions
"""
from __future__ import annotations

import csv
import io
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from statistics import mean, stdev

import numpy as np
import requests

from config import FRED_CSV_URL, FRED_API_KEY
from analytics.bc_calibration import load_bc_thresholds

_FRED_API_BASE  = "https://api.stlouisfed.org/fred/series/observations"

# ── Calibrated thresholds (P4) — loaded from data/models/bc_thresholds.json ──
# Run `python -m analytics.bc_calibration` to generate.
# Falls back to literature-based defaults if file missing.
_BC_THRESHOLDS: dict = load_bc_thresholds() or {}
_CONT_CENTER    = _BC_THRESHOLDS.get("contraction_center",  -0.8)   # default: ~1σ below neutral
_CONT_SHARP     = _BC_THRESHOLDS.get("contraction_sharpness", 2.0)
_EXP_CENTER     = _BC_THRESHOLDS.get("expansion_center",    +0.8)   # default: ~1σ above neutral
_EXP_SHARP      = _BC_THRESHOLDS.get("expansion_sharpness",   2.0)
_REC_THRESHOLD  = _BC_THRESHOLDS.get("recession_threshold",  -0.8)
_EXP_THRESHOLD  = _BC_THRESHOLDS.get("expansion_threshold",  +0.8)
_DISK_CACHE_DIR = Path(__file__).parent.parent / "cache" / "fred"
_DISK_TTL: dict[str, int] = {
    "T10Y2Y":        86_400,    # 1 day (daily)
    "CFNAI":      2_592_000,    # 30 days (monthly) — P5: replaces MANEMP
    "MANEMP":     2_592_000,    # 30 days (legacy — kept for cache compatibility)
    "BAMLH0A0HYM2":  86_400,    # 1 day (daily)
}

# ── Constants ──────────────────────────────────────────────────────────────────

SECTOR_ETFS = [
    "XLK", "XLF", "XLV", "XLI", "XLY",
    "XLP", "XLE", "XLB", "XLRE", "XLC", "XLU",
]

SECTOR_NAMES: dict[str, str] = {
    "XLK":  "Technology",
    "XLF":  "Financials",
    "XLV":  "Health Care",
    "XLI":  "Industrials",
    "XLY":  "Consumer Discretionary",
    "XLC":  "Communication Services",
    "XLP":  "Consumer Staples",
    "XLE":  "Energy",
    "XLRE": "Real Estate",
    "XLB":  "Materials",
    "XLU":  "Utilities",
}

# Stovall (1996) favorability matrix — 11 sectors × 4 phases
# +2 = top pick, +1 = overweight, 0 = neutral, -1 = underweight, -2 = avoid
# Phases: [Recovery, Expansion, Slowdown, Contraction]
FAV: dict[str, list[int]] = {
    "XLY":  [+2, +1, -1, -2],
    "XLF":  [+2, +1,  0, -1],
    "XLI":  [+1, +2, -1, -1],
    "XLB":  [+1, +1, +2, -2],
    "XLE":  [ 0, +1, +2, -1],
    "XLK":  [+1, +2,  0, -1],
    "XLC":  [+1, +1,  0, -1],
    "XLV":  [-1,  0, +1, +2],
    "XLP":  [-1, -1, +1, +2],
    "XLRE": [+1,  0, -1, +1],
    "XLU":  [ 0, -1,  0, +2],
}

# ── Cache ──────────────────────────────────────────────────────────────────────

_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()
CACHE_TTL = 3600  # 1 hour — cycle phase changes slowly


# ── FRED helper ────────────────────────────────────────────────────────────────

def _disk_get(series_id: str) -> list[dict] | None:
    """Load cached FRED data from disk.  Returns None if missing or expired."""
    path = _DISK_CACHE_DIR / f"{series_id}.json"
    if not path.exists():
        return None
    try:
        meta = json.loads(path.read_text())
        ttl  = _DISK_TTL.get(series_id, 86_400)
        if time.time() - meta.get("ts", 0) > ttl:
            return None
        return meta.get("data")
    except Exception:
        return None


def _disk_set(series_id: str, data: list[dict]) -> None:
    """Persist FRED rows to disk cache."""
    try:
        _DISK_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        (_DISK_CACHE_DIR / f"{series_id}.json").write_text(
            json.dumps({"ts": time.time(), "data": data})
        )
    except Exception:
        pass


def _fetch_fred(series_id: str, days_back: int = 400) -> list[dict]:
    """Fetch a FRED series.  Disk cache → JSON API → CSV fallback.
    Returns newest-first list of {date, raw}."""

    # ── 1. Disk cache ─────────────────────────────────────────────────────────
    cached = _disk_get(series_id)
    if cached:
        return cached  # already newest-first

    # ── 2. JSON API on api.stlouisfed.org (different host = different SSL path) ──
    if FRED_API_KEY:
        try:
            r = requests.get(
                _FRED_API_BASE,
                params={
                    "series_id":  series_id,
                    "api_key":    FRED_API_KEY,
                    "file_type":  "json",
                    "sort_order": "desc",
                    "limit":      500,
                },
                timeout=10,
                headers={"User-Agent": "Mozilla/5.0"},
            )
            if r.ok:
                rows: list[dict] = []
                for obs in r.json().get("observations", []):
                    v = obs.get("value", ".")
                    if v not in (".", ""):
                        try:
                            rows.append({"date": obs["date"], "raw": float(v)})
                        except ValueError:
                            pass
                if rows:
                    _disk_set(series_id, rows)
                    return rows  # already desc from API
        except Exception as e:
            print(f"[sector_bc] FRED JSON {series_id}: {e}")

    # ── 3. CSV endpoint (fred.stlouisfed.org) ─────────────────────────────────
    end   = datetime.utcnow()
    start = end - timedelta(days=days_back)
    url   = (
        f"{FRED_CSV_URL}?id={series_id}"
        f"&cosd={start.strftime('%Y-%m-%d')}"
        f"&coed={end.strftime('%Y-%m-%d')}"
    )
    try:
        r = requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
        if not r.ok:
            return []
        rows = []
        reader = csv.reader(io.StringIO(r.text))
        next(reader)
        for row in reader:
            if len(row) < 2 or row[1].strip() in (".", ""):
                continue
            try:
                rows.append({"date": row[0], "raw": float(row[1])})
            except ValueError:
                pass
        rows.sort(key=lambda x: x["date"], reverse=True)
        if rows:
            _disk_set(series_id, rows)
        return rows
    except Exception as e:
        print(f"[sector_bc] FRED CSV {series_id}: {e}")
        return []


def _compute_hyg_lqd_z() -> float:
    """P7 fallback: compute credit spread z-score from HYG-LQD return spread.
    Returns 0.0 on any failure (neutral)."""
    try:
        from sources import market_data
        fh = market_data.get_history("HYG", period="6mo", interval="1d")
        fl = market_data.get_history("LQD", period="6mo", interval="1d")
        if fh is None or fl is None:
            return 0.0
        hyg_r = fh.df["Close"].pct_change(20).dropna().values
        lqd_r = fl.df["Close"].pct_change(20).dropna().values
        n = min(len(hyg_r), len(lqd_r))
        if n < 10:
            return 0.0
        spread = hyg_r[-n:] - lqd_r[-n:]
        # Invert: when HYG underperforms LQD (negative spread) → risk-off → z negative
        return float(_to_rolling_z(list(-spread), window=min(len(spread), 126)) or 0.0)
    except Exception:
        return 0.0


def _check_above_ma200(sector: str) -> bool:
    """Return True if sector ETF is above its 200-day MA (for breadth calculation)."""
    try:
        from sources import market_data
        frame = market_data.get_history(sector, period="1y", interval="1d")
        df    = frame.df
        if df is None or df.empty or "Close" not in df.columns:
            return True  # neutral
        close = df["Close"].dropna()
        if len(close) < 200:
            return True
        ma200 = close.rolling(200).mean()
        return bool(close.iloc[-1] > ma200.iloc[-1])
    except Exception:
        return True  # neutral fallback


def _to_rolling_z(values: list[float], window: int = 252) -> float | None:
    """Compute z-score of the *latest* value vs a trailing window."""
    if len(values) < max(window, 10):
        return None
    hist = values[-window:]
    mu = mean(hist)
    sd = stdev(hist) if len(hist) > 1 else 1.0
    if sd < 1e-8:
        return 0.0
    return float((values[-1] - mu) / sd)


# ── Main computation ───────────────────────────────────────────────────────────

def compute_bc() -> dict:
    """
    Return a dict with per-sector BC scores plus cycle metadata.

    Keys:
        sectors:      {ticker: {z_score, raw_bc, phase_label}, ...}
        cycle_score:  float — composite z-score
        phase_label:  str   — human-readable phase
        probabilities: dict — p_expansion, p_recovery, p_slowdown, p_contraction
    """
    now = time.time()
    with _cache_lock:
        if "bc" in _cache:
            ts, val = _cache["bc"]
            if now - ts < CACHE_TTL:
                return val

    result: dict = {
        "sectors": {},
        "cycle_score": 0.0,
        "phase_label": "MID_EXPANSION",
        "probabilities": {},
        "error": None,
    }

    try:
        # ── Fetch FRED indicators ──────────────────────────────────────────

        t10y2y_rows = _fetch_fred("T10Y2Y")             # daily → 400 days = ~400 obs
        # CFNAI is monthly → need ≥ 36 months (window) + buffer = ~1500 days
        # Using days_back=1500 to get ~50 monthly observations (enough for window=36)
        cycle_rows  = _fetch_fred("CFNAI", days_back=1500)
        if not cycle_rows:
            cycle_rows = _fetch_fred("MANEMP", days_back=1500)  # fallback
        hy_rows     = _fetch_fred("BAMLH0A0HYM2")

        if not t10y2y_rows or not cycle_rows:
            result["error"] = "FRED data unavailable for BC layer"
            for s in SECTOR_ETFS:
                result["sectors"][s] = {
                    "z_score": 0.0, "raw_bc": 0.0,
                    "phase_label": "UNKNOWN",
                }
            return result

        # Extract raw values (newest-first → reverse → chronological)
        slope_vals = [r["raw"] for r in reversed(t10y2y_rows)]
        cycle_vals = [r["raw"] for r in reversed(cycle_rows)]

        z_slope = _to_rolling_z(slope_vals, window=252) or 0.0   # daily: 252 = 1 year
        # CFNAI is monthly → window=36 months (3 years), not 252 days
        # _to_rolling_z with window=36 needs ≥36 monthly observations
        z_pmi   = _to_rolling_z(cycle_vals, window=36) or 0.0

        # Credit spread: inverted (wider spread = bad)
        if hy_rows:
            hy_vals  = [r["raw"] for r in reversed(hy_rows)]
            z_spread = _to_rolling_z([-v for v in hy_vals]) or 0.0
        else:
            # P7 fallback: HYG−LQD 20d return spread via yfinance
            z_spread = _compute_hyg_lqd_z()

        # Cycle momentum (3-month change, z-scored)
        # For CFNAI: 3-month change captures acceleration/deceleration of activity
        if len(cycle_vals) >= 4:
            # CFNAI monthly → 3 months back = index -4 (0-indexed, 3 months = 3 lags)
            n_lag = min(3, len(cycle_vals) - 1)
            dpmi = cycle_vals[-1] - cycle_vals[-(n_lag + 1)]
            if len(cycle_vals) >= 5:
                dpmi_hist = [cycle_vals[i] - cycle_vals[i - n_lag]
                             for i in range(n_lag, len(cycle_vals))]
                if len(dpmi_hist) > 1:
                    mu_d = mean(dpmi_hist)
                    sd_d = stdev(dpmi_hist) or 1.0
                    z_dpmi = float((dpmi - mu_d) / sd_d) if sd_d > 1e-8 else 0.0
                else:
                    z_dpmi = 0.0
            else:
                z_dpmi = 0.0
        else:
            z_dpmi = 0.0

        # ── Composite cycle score ──────────────────────────────────────────

        cycle_score = 0.30 * z_slope + 0.30 * z_pmi + 0.25 * z_spread + 0.15 * z_dpmi
        cycle_score = float(np.clip(cycle_score, -3.0, 3.0))

        # ── Sigmoid soft assignment ────────────────────────────────────────

        def sigmoid(x: float, center: float = 0.0, sharpness: float = 2.0) -> float:
            return 1.0 / (1.0 + np.exp(-sharpness * (x - center)))

        # P4: use calibrated centers/sharpness (loaded from bc_thresholds.json)
        # Fallback to literature-based defaults if calibration not run yet
        p_expansion   = sigmoid(cycle_score, center=_EXP_CENTER,  sharpness=_EXP_SHARP)
        p_recovery    = sigmoid(cycle_score, center=0.0) * (1.0 - sigmoid(cycle_score, center=_EXP_CENTER))
        p_contraction = 1.0 - sigmoid(cycle_score, center=_CONT_CENTER, sharpness=_CONT_SHARP)
        p_slowdown    = max(0.0, 1.0 - p_expansion - p_recovery - p_contraction)

        # Normalize so FAV matrix weights sum to exactly 1.0
        # (raw sigmoid values can sum to > 1 — distorts raw_bc without normalization)
        _p_arr = np.array([p_recovery, p_expansion, p_slowdown, p_contraction], dtype=float)
        _p_arr = np.maximum(_p_arr, 0.0)
        _p_sum = _p_arr.sum()
        if _p_sum > 1e-8:
            _p_arr /= _p_sum
        else:
            _p_arr = np.array([0.25, 0.25, 0.25, 0.25])
        p_recovery_n, p_expansion_n, p_slowdown_n, p_contraction_n = _p_arr

        # ── FAV matrix × NORMALIZED phase probabilities → raw BC score ────

        raw_bc_all: dict[str, float] = {}
        for s in SECTOR_ETFS:
            fav = FAV[s]
            raw = (p_recovery_n    * fav[0]
                 + p_expansion_n   * fav[1]
                 + p_slowdown_n    * fav[2]
                 + p_contraction_n * fav[3])
            raw_bc_all[s] = float(np.tanh(raw / 2.0))

        # Cross-sectional z-score
        vals = list(raw_bc_all.values())
        mu_bc  = mean(vals)
        sd_bc  = stdev(vals) if len(vals) > 1 else 1.0
        if sd_bc < 1e-8:
            sd_bc = 1.0

        for s in SECTOR_ETFS:
            z = float(np.clip((raw_bc_all[s] - mu_bc) / sd_bc, -2.5, 2.5))
            result["sectors"][s] = {
                "z_score":     round(z, 4),        # BC layer rank: how well sector performs in current cycle
                "raw_bc":      round(raw_bc_all[s], 4),
                "p_expansion": round(float(p_expansion_n), 4),
                "p_recovery":  round(float(p_recovery_n), 4),
                "p_contraction": round(float(p_contraction_n), 4),
                "p_slowdown":  round(float(p_slowdown_n), 4),
                # phase_label filled after phase computation (line ~417)
            }

        # ── Phase label (hard classification — display only) ───────────────

        # Compute breadth — parallel fetch (P3 fix: ThreadPoolExecutor 6 workers)
        try:
            with ThreadPoolExecutor(max_workers=6) as pool:
                above = list(pool.map(_check_above_ma200, SECTOR_ETFS))
            breadth = sum(above) / len(SECTOR_ETFS)
        except Exception:
            breadth = 0.5  # neutral fallback

        # Get VIX for phase determination
        vix = None
        try:
            from sources import market_data
            info = market_data.get_info("^VIX")
            vix = info.regular_market_price
        except Exception:
            pass

        # ── Phase label — derived from cycle_score + probabilities ──────────
        # Bug fix: เดิมใช้ raw yc_level + VIX thresholds → ตก else (MID_EXPANSION) เสมอ
        # เพราะ conditions เข้มงวดมาก (ต้องครบ 2–3 เงื่อนไขพร้อมกัน)
        # Fix: ใช้ cycle_score (z-score normalized, -3 to +3) ที่คำนวณแล้ว
        # Thresholds จะถูก calibrate ใน P4 (vs NBER recession dates)
        # ปัจจุบันใช้ ±1σ เป็นค่าเริ่มต้น

        # P4: use calibrated thresholds (loaded from bc_thresholds.json)
        # Defaults: ±0.8σ (literature: CFNAI < -0.70 = recession, symmetric expansion)
        if cycle_score >= _EXP_THRESHOLD:
            phase_label = "EARLY_RECOVERY"    # above calibrated expansion threshold
        elif cycle_score >= 0.0:
            phase_label = "MID_EXPANSION"     # above neutral
        elif cycle_score >= _REC_THRESHOLD:
            phase_label = "LATE_CYCLE"        # below neutral, above recession threshold
        else:
            phase_label = "RECESSION"         # below calibrated recession threshold

        # Breadth/VIX override — veto EARLY_RECOVERY if market internals weak
        if phase_label == "EARLY_RECOVERY" and (breadth < 0.45 or (vix or 0) > 28):
            phase_label = "MID_EXPANSION"

        # Update sector dicts with phase_label (computed after sector z-scores)
        for s in SECTOR_ETFS:
            if s in result["sectors"]:
                result["sectors"][s]["phase_label"] = phase_label

        result["cycle_score"] = round(cycle_score, 4)
        result["phase_label"] = phase_label
        result["breadth"]     = round(breadth, 4)   # % sectors above MA200
        result["vix"]         = round(vix, 1) if vix else None
        result["probabilities"] = {
            # Normalized probabilities (sum = 1.0)
            "p_recovery":    round(float(p_recovery_n), 4),
            "p_expansion":   round(float(p_expansion_n), 4),
            "p_slowdown":    round(float(p_slowdown_n), 4),
            "p_contraction": round(float(p_contraction_n), 4),
        }
        result["indicators"] = {
            "z_slope":  round(z_slope, 4),   # yield curve (T10Y2Y)
            "z_pmi":    round(z_pmi, 4),     # CFNAI activity
            "z_spread": round(z_spread, 4),  # credit spread (inverted)
            "z_dpmi":   round(z_dpmi, 4),    # activity momentum
        }

    except Exception as e:
        print(f"[sector_bc] compute_bc error: {e}")
        result["error"] = str(e)
        for s in SECTOR_ETFS:
            if s not in result["sectors"]:
                result["sectors"][s] = {
                    "z_score": 0.0, "raw_bc": 0.0,
                    "phase_label": "UNKNOWN",
                }

    with _cache_lock:
        _cache["bc"] = (now, result)
    return result


def clear_bc_cache() -> None:
    """Clear the BC layer cache (called by cache-clear endpoint)."""
    with _cache_lock:
        _cache.pop("bc", None)
