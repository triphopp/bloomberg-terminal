"""
Sovereign Country Data router — World Bank Development Indicators.
"""
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any

import requests
from fastapi import APIRouter, HTTPException, Query

from config import MEM_CACHE_TTL

router = APIRouter()

# ── Country list ──��─────────────────────────────────���─────────────────────────

_COUNTRIES: dict[str, str] = {
    # ASEAN
    "TH": "Thailand",      "ID": "Indonesia",  "MY": "Malaysia",
    "SG": "Singapore",     "VN": "Vietnam",    "PH": "Philippines",
    "MM": "Myanmar",       "KH": "Cambodia",
    # East Asia
    "CN": "China",         "JP": "Japan",      "KR": "South Korea",
    "HK": "Hong Kong",     "TW": "Taiwan",
    # South Asia / Oceania
    "IN": "India",         "AU": "Australia",  "NZ": "New Zealand",
    "PK": "Pakistan",      "BD": "Bangladesh",
    # Americas
    "US": "United States", "CA": "Canada",     "BR": "Brazil",
    "MX": "Mexico",        "AR": "Argentina",  "CL": "Chile",
    "CO": "Colombia",      "PE": "Peru",
    # Europe
    "GB": "United Kingdom","DE": "Germany",    "FR": "France",
    "IT": "Italy",         "ES": "Spain",      "PL": "Poland",
    "TR": "Turkey",
    # Middle East / Africa
    "SA": "Saudi Arabia",  "AE": "UAE",        "EG": "Egypt",
    "ZA": "South Africa",  "NG": "Nigeria",    "KE": "Kenya",
    # CIS
    "RU": "Russia",
}

# World Bank Development Indicators
# Keys marked "score": True are used in risk_score computation.
_WB_INDICATORS: dict[str, dict] = {
    # ── Economic output ───────────────────────────────────────────────────────
    "gdp_usd":      {"id": "NY.GDP.MKTP.CD",       "label": "GDP",               "unit": "USD",   "score": False},
    "gdp_per_cap":  {"id": "NY.GDP.PCAP.CD",        "label": "GDP per Capita",    "unit": "USD",   "score": False},
    "gdp_growth":   {"id": "NY.GDP.MKTP.KD.ZG",    "label": "GDP Growth",        "unit": "% YoY", "score": True},
    "population":   {"id": "SP.POP.TOTL",           "label": "Population",        "unit": "",      "score": False},
    # ── Prices & labour ────────���──────────────────────────────────────────────
    "cpi":          {"id": "FP.CPI.TOTL.ZG",        "label": "Inflation (CPI)",   "unit": "% YoY", "score": True},
    "unemployment": {"id": "SL.UEM.TOTL.ZS",        "label": "Unemployment",      "unit": "%",     "score": True},
    # ── Fiscal ────────────────────────────────────────────────────────────────
    "debt_gdp":     {"id": "GC.DOD.TOTL.GD.ZS",    "label": "Govt Debt / GDP",   "unit": "%",     "score": True},
    "fiscal_bal":   {"id": "GC.NLD.TOTL.GD.ZS",    "label": "Fiscal Balance/GDP","unit": "%",     "score": False},
    "tax_rev":      {"id": "GC.TAX.TOTL.GD.ZS",    "label": "Tax Revenue / GDP", "unit": "%",     "score": False},
    # ── External ─────���───────────────────────────────��────────────────────────
    "current_acct": {"id": "BN.CAB.XOKA.GD.ZS",    "label": "Current Acct / GDP","unit": "%",     "score": True},
    "exports_gdp":  {"id": "NE.EXP.GNFS.ZS",        "label": "Exports / GDP",     "unit": "%",     "score": False},
    "fdi_net":      {"id": "BX.KLT.DINV.WD.GD.ZS", "label": "FDI Net / GDP",     "unit": "%",     "score": False},
    "reserves_mo":  {"id": "FI.RES.TOTL.MO",        "label": "FX Reserves",       "unit": "mo",    "score": True},
    "ext_debt":     {"id": "DT.DOD.DECT.GN.ZS",    "label": "Ext. Debt / GNI",   "unit": "%",     "score": False},
    # ── Prices & Labour (additions) ─────────���──────────────────────────────
    "ppi":              {"id": "FP.WPI.TOTL.ZG",        "label": "PPI (WPI proxy)",     "unit": "% YoY", "score": False},
    # ── Trade ───────���────────────────────────────────────���─────────────────
    "trade_balance":    {"id": "NE.RSB.GNFS.ZS",        "label": "Trade Balance/GDP",   "unit": "%",     "score": False},
    "imports_gdp":      {"id": "NE.IMP.GNFS.ZS",        "label": "Imports / GDP",       "unit": "%",     "score": False},
    # ── Monetary ────────────���──────────────────────────────────────────────
    "broad_money":      {"id": "FM.LBL.BMNY.GD.ZS",    "label": "Broad Money / GDP",   "unit": "%",     "score": False},
    "domestic_credit":  {"id": "FS.AST.DOMS.GD.ZS",     "label": "Domestic Credit/GDP", "unit": "%",     "score": False},
    # ── Real Economy ───────────��───────────────────────────────────────────
    "industry_va":      {"id": "NV.IND.TOTL.ZS",        "label": "Industry VA / GDP",   "unit": "%",     "score": False},
    "services_va":      {"id": "NV.SRV.TOTL.ZS",        "label": "Services VA / GDP",   "unit": "%",     "score": False},
    "agriculture_va":   {"id": "NV.AGR.TOTL.ZS",        "label": "Agriculture VA/GDP",  "unit": "%",     "score": False},
    "gfcf":             {"id": "NE.GDI.FTOT.ZS",        "label": "Gross Capital Form",  "unit": "% GDP", "score": False},
    "listed_companies": {"id": "CM.MKT.LDOM.NO",       "label": "Listed Companies",    "unit": "",      "score": False},
    # ── Social / Quality of Life ────���──────────────────────────────────────
    "life_expectancy":  {"id": "SP.DYN.LE00.IN",        "label": "Life Expectancy",     "unit": "years", "score": False},
    "pop_growth":       {"id": "SP.POP.GROW",           "label": "Population Growth",   "unit": "% YoY", "score": False},
    "gini":             {"id": "SI.POV.GINI",           "label": "Gini Coefficient",    "unit": "",      "score": False},
    "literacy":         {"id": "SE.ADT.LITR.ZS",        "label": "Literacy Rate",       "unit": "%",     "score": False},
    "hdi_proxy_gni":    {"id": "NY.GNP.PCAP.PP.CD",     "label": "GNI per Capita PPP",  "unit": "USD",   "score": False},
    # ── Competitiveness / Governance ─────────���─────────────────────────────
    "ease_business":    {"id": "IC.BUS.EASE.XQ",        "label": "Ease of Business",    "unit": "rank",  "score": False},
    "political_stab":   {"id": "PV.EST",                "label": "Political Stability", "unit": "score", "score": False},
    "rule_of_law":      {"id": "RL.EST",                "label": "Rule of Law",         "unit": "score", "score": False},
    "gov_effectiveness":{"id": "GE.EST",                "label": "Govt Effectiveness",  "unit": "score", "score": False},
    "control_corrupt":  {"id": "CC.EST",                "label": "Control Corruption",  "unit": "score", "score": False},
}

_WB_BASE = "https://api.worldbank.org/v2/country"
_SOVEREIGN_CACHE_FILE = Path(__file__).parent.parent / "sovereign_cache.json"
_sovereign_mem: dict[str, Any] = {}
_SOVEREIGN_MEM_TTL = MEM_CACHE_TTL
_SOVEREIGN_TTL     = 7 * 86400   # WB data is annual — 7-day cache is plenty


# ── Cache I/O ─────────────────────────────────────────���───────────────────────

def _load_sovereign_cache() -> dict:
    try:
        if _SOVEREIGN_CACHE_FILE.exists():
            return json.loads(_SOVEREIGN_CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def _save_sovereign_cache(cache: dict) -> None:
    try:
        _SOVEREIGN_CACHE_FILE.write_text(
            json.dumps(cache, separators=(",", ":")), encoding="utf-8"
        )
    except Exception:
        pass


# ── Data fetching ─────────────────────────────────────────────────────────────

def _fetch_wb_indicator(country_code: str, indicator_id: str) -> dict | None:
    """Fetch one World Bank indicator for one country. Returns {value, year, series} or None."""
    try:
        url = f"{_WB_BASE}/{country_code}/indicator/{indicator_id}"
        r = requests.get(url, params={"format": "json", "mrv": 10, "per_page": 10}, timeout=8)
        if not r.ok:
            return None
        payload = r.json()
        if not payload or len(payload) < 2 or not payload[1]:
            return None
        rows = sorted(payload[1], key=lambda x: x.get("date", ""), reverse=True)
        # Build time series of all non-null values
        series = []
        latest = None
        for row in rows:
            v = row.get("value")
            if v is not None:
                entry = {"value": round(float(v), 3), "year": row["date"]}
                series.append(entry)
                if latest is None:
                    latest = entry
        if latest is None:
            return None
        return {"value": latest["value"], "year": latest["year"], "series": series}
    except Exception:
        pass
    return None


def _fetch_country_data(country_code: str) -> dict | None:
    """Fetch all WB indicators for one country concurrently."""
    cc = country_code.upper()
    if cc not in _COUNTRIES:
        return None
    indicators = {}
    with ThreadPoolExecutor(max_workers=min(len(_WB_INDICATORS), 5)) as pool:
        futs = {
            key: pool.submit(_fetch_wb_indicator, cc, cfg["id"])
            for key, cfg in _WB_INDICATORS.items()
        }
        for key, fut in futs.items():
            indicators[key] = fut.result()

    # Risk score 0-100 (higher = healthier sovereign).
    # Base 50; each indicator adds +/-5-15 points. Max ~ 80, min -> 0 (capped).
    score = 50
    score_detail: dict[str, dict] = {}
    try:
        # GDP Growth: +10 >=2%, 0 for 0-2%, -10 <0%
        gd = indicators.get("gdp_growth")
        if gd:
            d = 10 if gd["value"] >= 2.0 else (-10 if gd["value"] < 0 else 0)
            score += d;  score_detail["gdp_growth"] = {"delta": d, "value": gd["value"]}

        # CPI: +5 <3%, 0 for 3-6%, -5 for 6-10%, -15 >10%
        ci = indicators.get("cpi")
        if ci:
            d = 5 if ci["value"] < 3 else (-5 if ci["value"] > 6 else (-15 if ci["value"] > 10 else 0))
            score += d;  score_detail["cpi"] = {"delta": d, "value": ci["value"]}

        # Unemployment: +3 <4%, 0 for 4-8%, -5 for 8-12%, -10 >12%
        um = indicators.get("unemployment")
        if um:
            d = 3 if um["value"] < 4 else (-5 if um["value"] > 8 else (-10 if um["value"] > 12 else 0))
            score += d;  score_detail["unemployment"] = {"delta": d, "value": um["value"]}

        # Debt/GDP: +5 <40%, 0 for 40-70%, -5 for 70-100%, -10 >100%
        dg = indicators.get("debt_gdp")
        if dg:
            d = 5 if dg["value"] < 40 else (-5 if dg["value"] > 70 else (-10 if dg["value"] > 100 else 0))
            score += d;  score_detail["debt_gdp"] = {"delta": d, "value": dg["value"]}

        # Current Account: +5 >3%, 0 for -3-3%, -5 for -5- -3%, -10 <-5%
        ca = indicators.get("current_acct")
        if ca:
            d = 5 if ca["value"] > 3 else (-5 if ca["value"] < -3 else (-10 if ca["value"] < -5 else 0))
            score += d;  score_detail["current_acct"] = {"delta": d, "value": ca["value"]}

        # FX Reserves: +5 >6mo, 0 for 3-6mo, -5 for 2-3mo, -10 <2mo
        rv = indicators.get("reserves_mo")
        if rv:
            d = 5 if rv["value"] > 6 else (-5 if rv["value"] < 3 else (-10 if rv["value"] < 2 else 0))
            score += d;  score_detail["reserves_mo"] = {"delta": d, "value": rv["value"]}

        score = max(0, min(100, score))
    except Exception:
        score = 50

    return {
        "code":         cc,
        "name":         _COUNTRIES[cc],
        "indicators":   indicators,
        "score_detail": score_detail,
        "risk_score":   score,
        "risk_label":   "LOW" if score >= 60 else "MEDIUM" if score >= 40 else "HIGH",
    }


def _get_country_cached(country_code: str, cache: dict) -> dict | None:
    cc   = country_code.upper()
    entry = cache.get(cc)
    if entry and time.time() - entry.get("ts", 0) < _SOVEREIGN_TTL:
        return entry.get("data")
    # Fetch fresh
    data = _fetch_country_data(cc)
    if data:
        cache[cc] = {"ts": time.time(), "data": data}
    return data


# ── API endpoints ─────────────────────────────────────────────────────────────

@router.get("/api/sovereign/list")
def get_sovereign_list(search: str = Query(default="", alias="q")):
    """Return list of all supported countries (with cached WB data if available)."""
    cache = _load_sovereign_cache()
    q     = search.strip().lower()
    result = []
    for code, name in _COUNTRIES.items():
        if q and q not in name.lower() and q not in code.lower():
            continue
        entry = cache.get(code)
        cached_data = entry.get("data") if entry else None
        result.append({
            "code":       code,
            "name":       name,
            "risk_score": cached_data.get("risk_score") if cached_data else None,
            "risk_label": cached_data.get("risk_label") if cached_data else None,
            "has_data":   cached_data is not None,
            "indicators": cached_data.get("indicators") if cached_data else None,
        })
    # Sort: has_data first, then alphabetical by name
    result.sort(key=lambda x: (not x["has_data"], x["name"]))
    return {"countries": result, "total": len(result)}


@router.get("/api/sovereign/compare")
def get_sovereign_compare(
    codes: str = Query(default="US,CN,JP,GB,DE,IN,BR,KR,TH,SG,ID,AU,FR,CA,MX"),
    indicator: str = Query(default="listed_companies"),
):
    """Return one WB indicator for N countries — latest value + full series, sorted descending."""
    if indicator not in _WB_INDICATORS:
        raise HTTPException(status_code=400, detail=f"Unknown indicator '{indicator}'")

    code_list = [c.strip().upper() for c in codes.split(",") if c.strip()]
    cache = _load_sovereign_cache()

    # Fetch all countries concurrently (same pattern as _fetch_country_data)
    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=min(len(code_list), 5)) as pool:
        futs = {cc: pool.submit(_get_country_cached, cc, cache) for cc in code_list if cc in _COUNTRIES}
        for cc, fut in futs.items():
            data = fut.result()
            if not data:
                continue
            wb_val = data.get("indicators", {}).get(indicator)
            if not wb_val:
                continue
            results.append({
                "code":   cc,
                "name":   _COUNTRIES[cc],
                "value":  wb_val.get("value"),
                "year":   wb_val.get("year"),
                "series": wb_val.get("series", []),
            })

    _save_sovereign_cache(cache)

    ind_meta = _WB_INDICATORS[indicator]
    results.sort(key=lambda x: (x["value"] is None, -(x["value"] or 0)))

    return {
        "indicator": indicator,
        "label":     ind_meta["label"],
        "unit":      ind_meta["unit"],
        "data":      results,
    }


@router.get("/api/sovereign/{country_code}")
def get_sovereign_detail(country_code: str):
    """Return full World Bank macro data for one country. Fetches if not cached."""
    cc = country_code.upper()
    if cc not in _COUNTRIES:
        raise HTTPException(status_code=404, detail=f"Country '{cc}' not in supported list")
    cache   = _load_sovereign_cache()
    data    = _get_country_cached(cc, cache)
    _save_sovereign_cache(cache)
    if not data:
        raise HTTPException(status_code=503, detail="World Bank API unavailable")
    return data


@router.delete("/api/sovereign/cache")
def clear_sovereign_cache():
    """Reset sovereign cache TTLs."""
    _sovereign_mem.clear()
    try:
        cache = _load_sovereign_cache()
        for entry in cache.values():
            if isinstance(entry, dict):
                entry["ts"] = 0
        _save_sovereign_cache(cache)
    except Exception:
        pass
    return {"cleared": True}


