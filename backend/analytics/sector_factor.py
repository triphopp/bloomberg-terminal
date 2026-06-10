"""
Layer F — Macro Factor Sensitivity (APT 5-factor).

Replaces the original Layer INT (rate sensitivity only).  Uses
Arbitrage Pricing Theory with 5 macro factors:

  f_yield — 10Y-2Y spread (z-score)
  f_cpi   — CPI YoY% (z-score)
  f_cs    — Credit spread (HYG−LQD return diff, z-score)
  f_dxy   — USD strength (DXY 20d return, z-score)
  f_oil   — Oil price (CL=F 20d return, z-score)

Each sector has a static beta vector (11×5 matrix).  Factor scores
are combined via dot product then cross-sectionally z-scored.

References:
  Chen, Roll & Ross (1986) — Economic Forces and the Stock Market
  Ilmanen (2011) — Expected Returns, Chapters 7-8
  Conover, Jensen, Johnson & Mercer (2008) — Sector Rotation and
    Monetary Conditions (yield column betas)
"""
from __future__ import annotations

import csv
import io
import json
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from statistics import mean, stdev

import numpy as np
import requests

from config import FRED_CSV_URL, FRED_API_KEY
from sources import market_data

_FRED_API_BASE   = "https://api.stlouisfed.org/fred/series/observations"
_DISK_CACHE_DIR  = Path(__file__).parent.parent / "cache" / "fred"
_DISK_TTL: dict[str, int] = {
    "T10Y2Y":        86_400,    # 1 day
    "CPIAUCSL":   2_592_000,    # 30 days (monthly)
    "BAMLH0A0HYM2":  86_400,    # 1 day
}

from .sector_bc import SECTOR_ETFS  # shared constant

# ── APT Beta Matrix ──────────────────────────────────────────────────────────
# [yield, cpi, credit_spread, dxy, oil]
# Yield column uses Conover et al. (2008) empirical estimates.
# Other columns: Ilmanen (2011) Ch.8 + Chen, Roll & Ross (1986).

BETAS: dict[str, list[float]] = {
    "XLF":  [+1.50,  0.00, -0.60, +0.20,  0.00],
    "XLU":  [-2.50, -0.10, +0.20, -0.10,  0.00],
    "XLRE": [-2.00, +0.10, +0.10, -0.10,  0.00],
    "XLK":  [+0.30, -0.20, -0.20, +0.10,  0.00],
    "XLI":  [-0.10, +0.30, -0.10, -0.10, +0.10],
    "XLB":  [-0.20, +0.50, -0.10, -0.30, +0.30],
    "XLE":  [+0.20, +0.40, -0.10, -0.50, +0.80],
    "XLV":  [-0.80,  0.00, +0.10,  0.00,  0.00],
    "XLP":  [-1.20, +0.10, +0.20, -0.10,  0.00],
    "XLY":  [+0.10, -0.30, -0.30, +0.10, -0.10],
    "XLC":  [-0.30, -0.10, -0.10,  0.00,  0.00],
}

# ── Cache ────────────────────────────────────────────────────────────────────

_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()
CACHE_TTL = 3600  # 1 hour


# ── FRED helper ──────────────────────────────────────────────────────────────

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


def _fetch_fred_values(series_id: str, days: int = 400) -> list[float]:
    """Fetch a FRED series.  JSON API first (P1/P2 fix), CSV fallback.
    Disk-caches results so restarts don't re-fetch.
    Returns chronological list of float values (oldest first)."""

    # ── 1. Disk cache ──────────────────────────────────────────────────────────
    cached = _disk_get(series_id)
    if cached:
        return [r["raw"] for r in reversed(cached)]   # newest-first → reverse → chrono

    rows: list[dict] = []

    # ── 2. JSON API (api.stlouisfed.org — avoids SSL issue on Windows Store Python) ──
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
                for obs in r.json().get("observations", []):
                    v = obs.get("value", ".")
                    if v not in (".", ""):
                        try:
                            rows.append({"date": obs["date"], "raw": float(v)})
                        except ValueError:
                            pass
        except Exception as e:
            print(f"[sector_factor] FRED JSON {series_id}: {e}")

    # ── 3. CSV fallback (fred.stlouisfed.org) ─────────────────────────────────
    if not rows:
        end   = datetime.utcnow()
        start = end - timedelta(days=days)
        url   = (
            f"{FRED_CSV_URL}?id={series_id}"
            f"&cosd={start.strftime('%Y-%m-%d')}"
            f"&coed={end.strftime('%Y-%m-%d')}"
        )
        try:
            r = requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
            if r.ok:
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
        except Exception as e:
            print(f"[sector_factor] FRED CSV {series_id}: {e}")

    if rows:
        _disk_set(series_id, rows)
        return [r["raw"] for r in reversed(rows)]  # newest-first → reverse → chrono
    return []


def _rolling_z(series: list[float], window: int = 252) -> float:
    """Z-score of latest value vs trailing window."""
    if len(series) < max(window, 10):
        return 0.0
    hist = series[-window:]
    mu = mean(hist)
    sd = stdev(hist) if len(hist) > 1 else 1.0
    return float((series[-1] - mu) / sd) if sd > 1e-8 else 0.0


# ── Main computation ─────────────────────────────────────────────────────────

def compute_factor() -> dict:
    """Return {sectors: {ticker: {z_score, raw_factor}}, factors: {...}}."""
    now = time.time()
    with _cache_lock:
        if "f" in _cache:
            ts, val = _cache["f"]
            if now - ts < CACHE_TTL:
                return val

    result: dict = {
        "sectors": {},
        "factors": {},
        "error": None,
    }

    try:
        # 1. Fetch macro data ──────────────────────────────────────────────

        t10y2y = _fetch_fred_values("T10Y2Y")
        cpi    = _fetch_fred_values("CPIAUCSL")

        # CPI YoY%
        if len(cpi) >= 13:
            cpi_yoy_vals = [cpi[i] / cpi[i - 12] - 1 for i in range(12, len(cpi))]
        else:
            cpi_yoy_vals = []

        # Credit spread: HYG − LQD 20d return difference
        try:
            h_frame = market_data.get_history("HYG", period="6mo", interval="1d")
            l_frame = market_data.get_history("LQD", period="6mo", interval="1d")
            hyg_close = h_frame.df["Close"].dropna().values
            lqd_close = l_frame.df["Close"].dropna().values
            min_len = min(len(hyg_close), len(lqd_close))
            if min_len > 21:
                hyg_20d = float(hyg_close[-1] / hyg_close[-21] - 1)
                lqd_20d = float(lqd_close[-1] / lqd_close[-21] - 1)
                cs_return = [hyg_20d - lqd_20d]
            else:
                cs_return = [0.0]
        except Exception as e:
            print(f"[sector_factor] credit spread: {e}")
            cs_return = [0.0]

        # DXY + Oil 20d returns
        try:
            dx_frame = market_data.get_history("DX-Y.NYB", period="6mo", interval="1d")
            cl_frame = market_data.get_history("CL=F", period="6mo", interval="1d")
            dxy_close = dx_frame.df["Close"].dropna().values
            oil_close = cl_frame.df["Close"].dropna().values

            dxy_20d = []
            oil_20d = []
            for arr, out in [(dxy_close, dxy_20d), (oil_close, oil_20d)]:
                if len(arr) > 21:
                    out.append(float((arr[-1] / arr[-21] - 1)))
            dxy_20d_val = dxy_20d[0] if dxy_20d else 0.0
            oil_20d_val = oil_20d[0] if oil_20d else 0.0
        except Exception as e:
            print(f"[sector_factor] DXY/Oil: {e}")
            dxy_20d_val = 0.0
            oil_20d_val = 0.0

        # 2. Factor z-scores ────────────────────────────────────────────────

        f_yield = _rolling_z(t10y2y) if t10y2y else 0.0
        f_cpi   = _rolling_z(cpi_yoy_vals, window=36) if cpi_yoy_vals else 0.0
        f_cs    = _rolling_z(cs_return, window=20) if cs_return else 0.0
        f_dxy   = dxy_20d_val  # raw 20d return — z-scoring not meaningful for single value
        f_oil   = oil_20d_val  # same as above

        factors = [f_yield, f_cpi, f_cs, f_dxy, f_oil]

        # 3. APT scores (dot product) ──────────────────────────────────────

        raw_F: dict[str, float] = {}
        for s in SECTOR_ETFS:
            raw_F[s] = float(np.dot(BETAS[s], factors))

        # Cross-sectional z-score
        vals = list(raw_F.values())
        mu_F  = mean(vals)
        sd_F  = stdev(vals) if len(vals) > 1 else 1.0
        if sd_F < 1e-8:
            sd_F = 1.0

        for s in SECTOR_ETFS:
            z = float(np.clip((raw_F[s] - mu_F) / sd_F, -2.5, 2.5))
            result["sectors"][s] = {
                "z_score":    round(z, 4),
                "raw_factor": round(raw_F[s], 4),
            }

        result["factors"] = {
            "f_yield": round(f_yield, 4),
            "f_cpi":   round(f_cpi, 4),
            "f_cs":    round(f_cs, 4),
            "f_dxy":   round(f_dxy, 4),
            "f_oil":   round(f_oil, 4),
        }

    except Exception as e:
        print(f"[sector_factor] compute_factor error: {e}")
        result["error"] = str(e)
        for s in SECTOR_ETFS:
            result["sectors"][s] = {"z_score": 0.0, "raw_factor": 0.0}

    with _cache_lock:
        _cache["f"] = (now, result)
    return result


def clear_factor_cache() -> None:
    """Clear the F layer cache."""
    with _cache_lock:
        _cache.pop("f", None)
