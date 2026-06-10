"""
Layer VAL — Relative Sector Valuation.

Combines P/E contrarian z-score (60%) with Earnings Yield spread vs
10Y Treasury (40%).  PE values are validated (5 < pe < 200) and
unavailable sectors fall back to neutral.

References:
  Asness, Porter & Stevens (2000) — Predicting Stock Returns
  Fama & French (1997) — Industry Costs of Equity
  Campbell & Shiller (1988) — The Dividend-Price Ratio
"""
from __future__ import annotations

import csv
import io
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from statistics import mean, stdev

import numpy as np
import requests

from config import FRED_CSV_URL, FRED_API_KEY  # for 10Y yield

_FRED_API_BASE = "https://api.stlouisfed.org/fred/series/observations"
from sources import market_data

from .sector_bc import SECTOR_ETFS  # shared constant

# ── Historical PE anchors ─────────────────────────────────────────────────────

PE_HIST_MEAN: dict[str, float] = {
    "XLK":  28.5, "XLF":  14.2, "XLV":  21.3, "XLY":  26.4,
    "XLC":  22.1, "XLI":  20.8, "XLP":  22.0, "XLE":  14.5,
    "XLRE": 35.0, "XLB":  19.7, "XLU":  20.5,
}
PE_HIST_STD: dict[str, float] = {
    "XLK":   8.5, "XLF":   4.1, "XLV":   4.8, "XLY":   7.2,
    "XLC":   5.5, "XLI":   4.3, "XLP":   3.9, "XLE":   8.0,
    "XLRE":  8.0, "XLB":   5.2, "XLU":   4.0,
}

# Approximate EY spread mean/std per sector (annual review needed)
EY_SPREAD_MEAN: dict[str, float] = {
    s: (1.0 / pe - 0.03) if pe > 0 else 0.0
    for s, pe in PE_HIST_MEAN.items()
}
EY_SPREAD_STD: dict[str, float] = {s: 0.02 for s in SECTOR_ETFS}

# ── Cache ──────────────────────────────────────────────────────────────────────

_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()
CACHE_TTL = 86400  # 1 day — PE changes slowly


# ── Helpers ────────────────────────────────────────────────────────────────────

def _get_10y_yield() -> float:
    """Fetch latest 10Y Treasury yield.  JSON API first, CSV fallback."""
    # ── JSON API (api.stlouisfed.org — avoids SSL issue on Windows Store Python) ──
    if FRED_API_KEY:
        try:
            r = requests.get(
                _FRED_API_BASE,
                params={"series_id": "DGS10", "api_key": FRED_API_KEY,
                        "file_type": "json", "sort_order": "desc", "limit": 5},
                timeout=8,
                headers={"User-Agent": "Mozilla/5.0"},
            )
            if r.ok:
                for obs in r.json().get("observations", []):
                    v = obs.get("value", ".")
                    if v not in (".", ""):
                        return float(v) / 100.0
        except Exception:
            pass

    # ── CSV fallback ──────────────────────────────────────────────────────────
    try:
        end   = datetime.utcnow()
        start = end - timedelta(days=5)
        url   = (
            f"{FRED_CSV_URL}?id=DGS10"
            f"&cosd={start.strftime('%Y-%m-%d')}"
            f"&coed={end.strftime('%Y-%m-%d')}"
        )
        r = requests.get(url, timeout=10, headers={"User-Agent": "Mozilla/5.0"})
        if r.ok:
            reader = csv.reader(io.StringIO(r.text))
            next(reader)
            for row in reader:
                if len(row) >= 2 and row[1].strip() not in (".", ""):
                    return float(row[1]) / 100.0
    except Exception:
        pass
    return 0.04  # fallback: 4%


def _normalize_pe(pe: float | None) -> float | None:
    """Validate PE: must be 5 < pe < 200.  Returns None if invalid."""
    if pe is None:
        return None
    try:
        v = float(pe)
        return v if 5.0 < v < 200.0 else None
    except (TypeError, ValueError):
        return None


def _fetch_one_pe(ticker: str) -> dict:
    """Fetch PE ratio for one ETF via TickerDetail."""
    try:
        detail = market_data.get_info(ticker)
        pe = _normalize_pe(detail.pe_ratio)
        return {
            "ticker": ticker,
            "pe_current": pe,
            "error": None if pe is not None else "PE unavailable or invalid",
        }
    except Exception as e:
        print(f"[sector_val] {ticker}: {e}")
        return {"ticker": ticker, "pe_current": None, "error": str(e)}


# ── Main computation ───────────────────────────────────────────────────────────

def compute_valuation() -> dict[str, dict]:
    """Return {ticker: {z_score, z_PE, z_EY, pe_current, ...}}."""
    now = time.time()
    with _cache_lock:
        if "v" in _cache:
            ts, val = _cache["v"]
            if now - ts < CACHE_TTL:
                return val

    # Fetch PE for all 11 ETFs in parallel
    pe_results: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(_fetch_one_pe, s): s for s in SECTOR_ETFS}
        for fut in as_completed(futures):
            r = fut.result()
            pe_results[r.pop("ticker")] = r

    # Get 10Y yield
    yield_10y = _get_10y_yield()

    # ── Component 1: P/E contrarian z-score ────────────────────────────────
    z_PE: dict[str, float] = {}
    for s in SECTOR_ETFS:
        pe = pe_results.get(s, {}).get("pe_current")
        if pe is not None:
            mu_pe = PE_HIST_MEAN.get(s, 20.0)
            sd_pe = PE_HIST_STD.get(s, 5.0)
            z_PE[s] = -(pe - mu_pe) / max(sd_pe, 0.1)  # contrarian
        else:
            z_PE[s] = 0.0

    # ── Component 2: Earnings Yield spread ──────────────────────────────────
    z_EY: dict[str, float] = {}
    for s in SECTOR_ETFS:
        pe = pe_results.get(s, {}).get("pe_current")
        if pe is not None:
            ey = 1.0 / pe
            ey_spread = ey - yield_10y
            ey_mean = EY_SPREAD_MEAN.get(s, 0.0)
            ey_std  = max(EY_SPREAD_STD.get(s, 0.02), 0.001)
            z_EY[s] = (ey_spread - ey_mean) / ey_std
        else:
            z_EY[s] = 0.0

    # ── Combined raw VAL ────────────────────────────────────────────────────
    raw_V: dict[str, float] = {}
    for s in SECTOR_ETFS:
        raw_V[s] = 0.60 * z_PE[s] + 0.40 * z_EY[s]

    # Cross-sectional z-score
    vals = list(raw_V.values())
    mu_V  = mean(vals)
    sd_V  = stdev(vals) if len(vals) > 1 else 1.0
    if sd_V < 1e-8:
        sd_V = 1.0

    result: dict[str, dict] = {}
    for s in SECTOR_ETFS:
        z = float(np.clip((raw_V[s] - mu_V) / sd_V, -2.5, 2.5))
        result[s] = {
            "z_score":    round(z, 4),
            "z_PE":       round(z_PE[s], 4),
            "z_EY":       round(z_EY[s], 4),
            "pe_current": pe_results.get(s, {}).get("pe_current"),
            "ey_spread": (
                round((1.0 / pe_results[s]["pe_current"] - yield_10y), 6)
                if s in pe_results and pe_results[s].get("pe_current")
                else None
            ),
            "error": pe_results.get(s, {}).get("error"),
        }

    with _cache_lock:
        _cache["v"] = (now, result)
    return result


def clear_valuation_cache() -> None:
    """Clear the VAL layer cache."""
    with _cache_lock:
        _cache.pop("v", None)
