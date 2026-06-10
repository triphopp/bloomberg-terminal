"""
Credit Risk / Stress Indicators router — crisis level 0-3 based on FRED data.
"""
import io
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any

import requests
from fastapi import APIRouter

from config import FRED_API_KEY, MEM_CACHE_TTL
from routers.macro import (
    _fetch_fred_raw,
    _apply_transform,
    _get_yield_realtime,
    _pack,
    _unpack,
    _is_fresh,
    _load_series_cache,
)

router = APIRouter()

# ── Credit/Stress indicator configuration ─────────────────────────────────────

_CREDIT_CFG: dict[str, dict] = {
    # Spread signals — FRED reports in % (e.g. 2.79 = 279 bps); thresholds are in same % scale
    "hy_spread":       {"fred_id": "BAMLH0A0HYM2",  "signal_when": "above", "threshold": 5.0,  "label": "US HY OAS",          "unit": "%",   "category": "spreads"},
    "ig_spread":       {"fred_id": "BAMLC0A0CM",    "signal_when": "above", "threshold": 2.0,  "label": "US IG OAS",          "unit": "%",   "category": "spreads"},
    "em_hy_spread":    {"fred_id": "BAMLHE00EHY0D", "signal_when": "above", "threshold": 6.0,  "label": "EM HY OAS",          "unit": "%",   "category": "spreads"},
    "ted_spread":      {"fred_id": "TEDRATE",        "signal_when": "above", "threshold": 1.0,  "label": "TED Spread†",        "unit": "%",   "category": "spreads"},
    # Financial stress indices — trigger ABOVE 0
    "stl_fsi":         {"fred_id": "STLFSI4",        "signal_when": "above", "threshold": 0,    "label": "STL Stress Index",   "unit": "",    "category": "stress"},
    "nfci":            {"fred_id": "NFCI",            "signal_when": "above", "threshold": 0,    "label": "Chicago NFCI",       "unit": "",    "category": "stress"},
    "vix":             {"fred_id": "VIXCLS",          "signal_when": "above", "threshold": 30,   "label": "VIX Fear Index",     "unit": "",    "category": "stress"},
    # Yield curve — trigger BELOW 0 (inversion)
    "yield_10y2y":     {"fred_id": "T10Y2Y",          "signal_when": "below", "threshold": 0,    "label": "10Y−2Y Spread",      "unit": "%",   "category": "stress"},
    "yield_10y3m":     {"fred_id": "T10Y3M",          "signal_when": "below", "threshold": 0,    "label": "10Y−3M Spread",      "unit": "%",   "category": "stress"},
    # Valuation
    "cape":            {"fred_id": None,               "signal_when": "above", "threshold": 30,   "label": "Shiller CAPE",       "unit": "",    "category": "valuation"},
    # Reference / consumer (no signal threshold)
    "breakeven_5y":    {"fred_id": "T5YIE",           "signal_when": None,    "threshold": None, "label": "5Y Breakeven Infl.", "unit": "%",   "category": "consumer"},
    "breakeven_10y":   {"fred_id": "T10YIE",          "signal_when": None,    "threshold": None, "label": "10Y Breakeven Infl.","unit": "%",   "category": "consumer"},
    "mortgage_30y":    {"fred_id": "MORTGAGE30US",    "signal_when": None,    "threshold": None, "label": "30Y Mortgage Rate",  "unit": "%",   "category": "consumer"},
    "cc_delinquency":  {"fred_id": "DRCCLACBS",       "signal_when": None,    "threshold": None, "label": "CC Delinquency",     "unit": "%",   "category": "consumer"},
    "mtg_delinquency": {"fred_id": "DRSFRMACBS",      "signal_when": None,    "threshold": None, "label": "Mortgage Delinq.",   "unit": "%",   "category": "consumer"},
}

_CREDIT_TTL: dict[str, int] = {
    **{k: 6 * 3600 for k in _CREDIT_CFG},  # 6h default (daily FRED)
    "stl_fsi": 24 * 3600,  # weekly release
    "nfci":    24 * 3600,
    "cc_delinquency":  7 * 86400,   # quarterly
    "mtg_delinquency": 7 * 86400,
    "cape":            7 * 86400,   # updated monthly — 7-day cache is sufficient
    # Real-time overrides — yfinance primary (~15-min delay), not FRED daily
    "vix":          900,
    "yield_10y2y":  900,
    "yield_10y3m":  900,
}

# Keys with real-time yfinance source — bypass FRED, use yf as primary
_REALTIME_KEYS = {"vix", "yield_10y2y", "yield_10y3m"}

_SHILLER_URL = "http://www.econ.yale.edu/~shiller/data/ie_data.xls"


def _fetch_shiller_cape() -> float | None:
    """Download Shiller ie_data.xls and return the latest CAPE value."""
    try:
        import pandas as pd
        resp = requests.get(
            _SHILLER_URL, timeout=30,
            headers={"User-Agent": "Mozilla/5.0"},
        )
        resp.raise_for_status()
        df = pd.read_excel(
            io.BytesIO(resp.content),
            sheet_name="Data",
            header=7,
            engine="openpyxl",
        )
        cape_col = next(
            (c for c in df.columns
             if "cape" in str(c).lower() or "cyclically" in str(c).lower()),
            None,
        )
        if cape_col is None:
            return None
        series = df[cape_col].dropna()
        if series.empty:
            return None
        return float(series.iloc[-1])
    except Exception as exc:
        print(f"[cape] fetch failed: {exc}")
        return None

_CREDIT_CACHE_FILE = Path(__file__).parent.parent / "credit_series.json"
_credit_mem: dict[str, Any] = {}
_CREDIT_MEM_TTL = MEM_CACHE_TTL   # 5-minute in-memory TTL


# ── Cache I/O ─────────────────────────────────────────────────────────────────

def _load_credit_cache() -> dict:
    try:
        if _CREDIT_CACHE_FILE.exists():
            return json.loads(_CREDIT_CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def _save_credit_cache(cache: dict) -> None:
    try:
        _CREDIT_CACHE_FILE.write_text(
            json.dumps(cache, separators=(",", ":")), encoding="utf-8"
        )
    except Exception:
        pass


# ── Refresh logic ─────────────────────────────────────────────────────────────

def _refresh_credit(cache: dict) -> bool:
    """Fetch only expired credit/stress series. yfinance primary for real-time keys; FRED for daily series."""
    expired = [k for k in _CREDIT_CFG if not _is_fresh(cache.get(k))]
    if not expired:
        return False

    changed = False

    # Phase 1: real-time keys — yfinance primary (~15-min delay, not FRED daily)
    rt_expired = [k for k in expired if k in _REALTIME_KEYS]
    if rt_expired:
        _yf_fallback_credit(cache, rt_expired)
        for k in rt_expired:
            if cache.get(k):
                changed = True

    # Phase 2: FRED concurrent for daily/weekly series only
    fred_expired = [k for k in expired if k not in _REALTIME_KEYS]
    if fred_expired:
        with ThreadPoolExecutor(max_workers=min(len(fred_expired), 8)) as pool:
            futs = {k: pool.submit(_fetch_fred_raw, _CREDIT_CFG[k]["fred_id"])
                    for k in fred_expired if _CREDIT_CFG[k]["fred_id"]}
            fred_results = {k: f.result() for k, f in futs.items()}

        still_empty = []
        for k, raw in fred_results.items():
            data = _apply_transform(raw, "direct")
            if data:
                cache[k] = {
                    "ts":  time.time(),
                    "ttl": _CREDIT_TTL[k],
                    "v":   data[0]["value"],
                    "p":   (data[1] if len(data) > 1 else data[0])["value"],
                    "d":   data[0]["date"][:7],
                    "s":   _pack(data, 60),
                }
                changed = True
            else:
                still_empty.append(k)

        # Fallback: FRED failed for non-realtime, non-cape keys → try yfinance
        yf_fallback = [k for k in still_empty if k != "cape" and k not in _REALTIME_KEYS]
        if yf_fallback:
            _yf_fallback_credit(cache, yf_fallback)
            for k in yf_fallback:
                if cache.get(k):
                    changed = True

    # Phase 3: Shiller CAPE (fetches Yale Excel file, 7-day cache)
    if not _is_fresh(cache.get("cape")):
        cape_val = _fetch_shiller_cape()
        if cape_val:
            today = datetime.utcnow().strftime("%Y-%m")
            cache["cape"] = {
                "ts":  time.time(),
                "ttl": 7 * 86400,
                "v":   round(cape_val, 2),
                "p":   cache.get("cape", {}).get("v", cape_val),
                "d":   today,
                "s":   [],
            }
            changed = True

    return changed


def _yf_fallback_credit(cache: dict, keys: list[str]) -> None:
    """Populate select credit signals via yfinance when FRED is unreachable."""
    today = datetime.utcnow().strftime("%Y-%m")

    def _store(key: str, value: float | None, prev: float | None = None) -> None:
        if value is None:
            return
        ttl = _CREDIT_TTL.get(key, 6 * 3600)
        cache[key] = {
            "ts":  time.time(),
            "ttl": ttl,
            "v":   round(value, 3),
            "p":   round(prev, 3) if prev is not None else round(value, 3),
            "d":   today,
            "s":   [],        # no history without FRED
            "src": "yfinance",  # real-time source tag
        }

    try:
        if "vix" in keys:
            v = _get_yield_realtime("^VIX")
            _store("vix", v)

        # Yield spreads: compute from live yfinance yield symbols
        y10 = _get_yield_realtime("^TNX")   # 10Y
        y3m = _get_yield_realtime("^IRX")   # 3M (approx 90-day T-bill)
        if "yield_10y3m" in keys and y10 is not None and y3m is not None:
            spread = round(y10 - y3m, 3)
            # prev: estimate from existing macro yield_curve cache if available
            mc = _load_series_cache()
            rt = mc.get("yields_rt", {})
            prev_10y = rt.get("10y", y10)
            prev_3m  = rt.get("3m",  y3m)
            prev_sp  = round(prev_10y - prev_3m, 3) if prev_10y and prev_3m else spread
            _store("yield_10y3m", spread, prev_sp)

        # 10Y-2Y: use macro cache (DGS2/AV 2Y + yfinance 10Y)
        if "yield_10y2y" in keys:
            mc   = _load_series_cache()
            y2_e = mc.get("yield_2y")
            if y2_e and y10 is not None:
                y2   = y2_e.get("v")
                spread = round(y10 - y2, 3) if y2 is not None else None
                rt   = mc.get("yields_rt", {})
                prev_2y = rt.get("2y", y2)
                prev_sp = round((rt.get("10y", y10) or y10) - (prev_2y or y2 or 0), 3)
                _store("yield_10y2y", spread, prev_sp)
    except Exception:
        pass


# ── Assemble response ─────────────────────────────────────────────────────────

def _assemble_crisis(cache: dict) -> dict:
    """Build CrisisData response from per-series credit cache."""
    signals: dict[str, Any] = {}
    triggered: list[str] = []

    for key, cfg in _CREDIT_CFG.items():
        entry = cache.get(key)
        if not entry:
            signals[key] = None
            continue
        value        = entry["v"]
        threshold    = cfg.get("threshold")
        signal_when  = cfg.get("signal_when")
        is_triggered = False
        if threshold is not None and signal_when:
            if signal_when == "above":
                is_triggered = value > threshold
            elif signal_when == "below":
                is_triggered = value < threshold
        signals[key] = {
            "label":     cfg["label"],
            "unit":      cfg["unit"],
            "category":  cfg["category"],
            "value":     value,
            "prev":      entry["p"],
            "date":      entry["d"] + "-01",
            "threshold": threshold,
            "triggered": is_triggered,
            "series":    _unpack(entry.get("s", [])),
            "source":    entry.get("src", "fred"),
        }
        if is_triggered:
            triggered.append(key)

    n     = len(triggered)
    level = 3 if n >= 5 else 2 if n >= 3 else 1 if n >= 1 else 0

    return {
        "level":     level,
        "triggered": triggered,
        "signals":   signals,
        "as_of":     datetime.utcnow().isoformat() + "Z",
    }


# ── API endpoints ─────────────────────────────────────────────────────────────

@router.get("/api/crisis")
def get_crisis():
    """Return credit stress indicators + crisis level (0-3). 3-layer cache."""
    mem = _credit_mem.get("data")
    if mem and time.time() - _credit_mem.get("ts", 0) < _CREDIT_MEM_TTL:
        return mem

    cache   = _load_credit_cache()
    changed = _refresh_credit(cache)
    if changed:
        _save_credit_cache(cache)

    result = _assemble_crisis(cache)
    _credit_mem["data"] = result
    _credit_mem["ts"]   = time.time()
    return result


@router.get("/api/crisis/composite")
def get_crisis_composite():
    """
    Layer 3 — Systemic Risk Radar composite score (0-100) + traffic light.
    Weights: CAPE 30%, HY Spread 25%, VIX 20%, Yield Curve 15%, TED Spread 10%.
    """
    mem = _credit_mem.get("data")
    if not (mem and time.time() - _credit_mem.get("ts", 0) < _CREDIT_MEM_TTL):
        cache   = _load_credit_cache()
        changed = _refresh_credit(cache)
        if changed:
            _save_credit_cache(cache)
        result = _assemble_crisis(cache)
        _credit_mem["data"] = result
        _credit_mem["ts"]   = time.time()
    else:
        result = mem

    sigs = result.get("signals", {})

    def _val(key: str) -> float | None:
        s = sigs.get(key)
        return s["value"] if s else None

    cape_v   = _val("cape")
    vix_v    = _val("vix")
    hy_v     = _val("hy_spread")
    yc_v     = _val("yield_10y2y")
    ted_v    = _val("ted_spread")

    # Normalize each indicator to 0-100 score (higher = more risk)
    def cape_score(v: float | None) -> float:
        if v is None:
            return 50.0
        if v < 20:   return v / 20 * 20
        if v < 25:   return 20 + (v - 20) / 5 * 20
        if v < 30:   return 40 + (v - 25) / 5 * 25
        if v < 40:   return 65 + (v - 30) / 10 * 20
        return min(85 + (v - 40) / 10 * 15, 100)

    def vix_score(v: float | None) -> float:
        if v is None: return 30.0
        return min((v / 80) * 100, 100)

    def hy_score(v: float | None) -> float:
        if v is None: return 20.0
        return min((v / 20) * 100, 100)

    def yc_score(v: float | None) -> float:
        if v is None: return 30.0
        if v >= 1.0:  return 0.0
        if v >= 0:    return (1.0 - v) * 30
        return min(30 + abs(v) * 35, 100)

    def ted_score(v: float | None) -> float:
        if v is None: return 10.0
        return min((v / 5.0) * 100, 100)

    cs = cape_score(cape_v)
    vs = vix_score(vix_v)
    hs = hy_score(hy_v)
    ys = yc_score(yc_v)
    ts = ted_score(ted_v)

    composite = round(cs * 0.30 + hs * 0.25 + vs * 0.20 + ys * 0.15 + ts * 0.10, 1)

    if composite <= 33:
        traffic = "GREEN"
    elif composite <= 66:
        traffic = "YELLOW"
    else:
        traffic = "RED"

    return {
        "composite_score": composite,
        "traffic_light":   traffic,
        "indicators": {
            "cape":       {"value": cape_v, "score": round(cs, 1), "weight": 0.30},
            "vix":        {"value": vix_v,  "score": round(vs, 1), "weight": 0.20},
            "hy_spread":  {"value": hy_v,   "score": round(hs, 1), "weight": 0.25},
            "yield_10y2y":{"value": yc_v,   "score": round(ys, 1), "weight": 0.15},
            "ted_spread": {"value": ted_v,   "score": round(ts, 1), "weight": 0.10},
        },
        "as_of": datetime.utcnow().isoformat() + "Z",
    }


@router.delete("/api/crisis/cache")
def clear_crisis_cache():
    """Reset TTLs so all credit series re-fetch on next GET."""
    _credit_mem.clear()
    try:
        cache = _load_credit_cache()
        for entry in cache.values():
            if isinstance(entry, dict):
                entry["ts"] = 0
        _save_credit_cache(cache)
    except Exception:
        pass
    return {"cleared": True}
