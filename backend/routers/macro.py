"""
Macro Economics router — FRED primary, Alpha Vantage fallback, yfinance real-time yields.
"""
import csv
import io
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any

import requests
from fastapi import APIRouter, Query

from config import ALPHA_VANTAGE_KEY, FRED_API_KEY, MEM_CACHE_TTL
from event_calendar import calendar_payload, next_fomc
from sources import market_data

router = APIRouter()

# ── Cache layer 1: in-memory (5 min) — avoids repeated disk reads ────────────
_macro_mem: dict[str, Any] = {}
_MEM_TTL = MEM_CACHE_TTL

# ── Cache layer 2: per-series disk (variable TTL) ─────────────────────────────
# Stores compact series data; survives server restarts.
# Only expired series are re-fetched, so AV quota is preserved.
_SERIES_CACHE_FILE = Path(__file__).parent.parent / "macro_series.json"

# Release-frequency-based TTLs (seconds) — fetch only what actually changed
_SERIES_TTL: dict[str, int] = {
    "cpi":                7  * 86400,   # monthly BLS release (~10th of month)
    "cpi_core":           7  * 86400,   # same release, ex food & energy
    "pce":                7  * 86400,   # monthly BEA (~last business day)
    "pce_core":           7  * 86400,   # the Fed's actual 2% target
    "ism_proxy":          3  * 86400,   # regional Feds print through the month
    "gdp":                30 * 86400,   # quarterly BEA advance (~4 wks after quarter)
    "unemployment":       7  * 86400,   # monthly BLS (first Friday)
    "nfp":                7  * 86400,   # monthly BLS (first Friday, same day)
    "fed_rate":           1  * 86400,   # effective rate updates daily
    "retail_sales":       7  * 86400,   # monthly Census Bureau (~mid month)
    "consumer_sentiment": 14 * 86400,   # monthly U. Michigan final (~last Friday)
    "yield_2y":           4  * 3600,    # daily market rate — refresh 4x/day
    "yield_5y":           4  * 3600,
    "yields_rt":          1  * 3600,    # real-time yfinance — refresh 1x/hour
}

# Max data points stored per series (enough for 2-year charts; saves ~40% vs 36-60 pts)
_SERIES_PTS: dict[str, int] = {
    "cpi": 24, "cpi_core": 24, "pce": 24, "pce_core": 24, "ism_proxy": 24, "gdp": 8, "unemployment": 24, "nfp": 24,
    "fed_rate": 36, "retail_sales": 24, "consumer_sentiment": 24,
    "yield_2y": 24, "yield_5y": 24,
}

_AV_BASE       = "https://www.alphavantage.co/query"
_FRED_BASE     = "https://fred.stlouisfed.org/graph/fredgraph.csv"   # CSV fallback
_FRED_API_BASE = "https://api.stlouisfed.org/fred/series/observations"  # JSON API (different domain)

# Combined indicator config — FRED series ID/transform + AV function/interval as fallback
_INDICATOR_CFG: dict[str, dict] = {
    "cpi": {
        "fred_id":    "CPIAUCSL",        "fred_xform": "yoy_pct",
        "av_fn":      "CPI",             "av_interval": "monthly",
    },
    # Ex food & energy — the one the Fed's own forecasts are written in. Headline
    # CPI moves on oil and groceries, which monetary policy does not reach.
    "cpi_core": {
        "fred_id":    "CPILFESL",        "fred_xform": "yoy_pct",
        "av_fn":      None,              "av_interval": "monthly",
    },
    # PCE, not CPI, is the 2% target. It differs from CPI by 0.3-0.5pp most
    # years (different weights, substitution), so reading CPI as "the target
    # measure" is a systematic misread of how far policy is from home.
    "pce": {
        "fred_id":    "PCEPI",           "fred_xform": "yoy_pct",
        "av_fn":      None,              "av_interval": "monthly",
    },
    "pce_core": {
        "fred_id":    "PCEPILFE",        "fred_xform": "yoy_pct",
        "av_fn":      None,              "av_interval": "monthly",
    },
    "gdp": {
        "fred_id":    "A191RL1Q225SBEA", "fred_xform": "direct",       # FRED: SAAR % change directly
        "av_fn":      "REAL_GDP",        "av_interval": "quarterly",
        "av_xform":   "yoy_pct_q",       # AV: level -> YoY % (same quarter vs year ago, avoids seasonal noise)
    },
    "unemployment": {
        "fred_id":    "UNRATE",          "fred_xform": "direct",
        "av_fn":      "UNEMPLOYMENT",    "av_interval": "monthly",
    },
    "nfp": {
        "fred_id":    "PAYEMS",          "fred_xform": "mom_diff",
        "av_fn":      "NONFARM_PAYROLL", "av_interval": "monthly",
    },
    "fed_rate": {
        "fred_id":    "FEDFUNDS",        "fred_xform": "direct",
        "av_fn":      "FEDERAL_FUNDS_RATE", "av_interval": "monthly",
    },
    "retail_sales": {
        "fred_id":    "RSXFS",           "fred_xform": "mom_pct",
        "av_fn":      "RETAIL_SALES",    "av_interval": "monthly",
    },
    "consumer_sentiment": {
        "fred_id":    "UMCSENT",         "fred_xform": "direct",
        "av_fn":      "CONSUMER_SENTIMENT", "av_interval": "monthly",
    },
    "yield_2y": {
        "fred_id":    "DGS2",            "fred_xform": "direct",
        "av_fn":      "TREASURY_YIELD",  "av_interval": "monthly", "av_maturity": "2year",
    },
    "yield_5y": {
        "fred_id":    "DGS5",            "fred_xform": "direct",
        "av_fn":      "TREASURY_YIELD",  "av_interval": "monthly", "av_maturity": "5year",
    },
}

# Real-time yield levels from yfinance (intraday; FRED is T+1)
_YIELD_SYMBOLS: dict[str, str] = {
    "3m":  "^IRX",
    "5y":  "^FVX",
    "10y": "^TNX",
    "30y": "^TYX",
}



# ── Data fetching functions ──────────────────────────────────────────────────

def _fetch_fred_api(series_id: str, limit: int = 80) -> list[dict]:
    """Fetch FRED series via JSON API (api.stlouisfed.org). Requires FRED_API_KEY.
    Returns newest-first [{date, raw}]. Different domain from CSV — avoids firewall blocks."""
    if not FRED_API_KEY:
        return []
    try:
        r = requests.get(
            _FRED_API_BASE,
            params={
                "series_id":  series_id,
                "api_key":    FRED_API_KEY,
                "file_type":  "json",
                "sort_order": "desc",
                "limit":      limit,
            },
            timeout=10,
            headers={"User-Agent": "Mozilla/5.0"},
        )
        if not r.ok:
            return []
        rows: list[dict] = []
        for obs in r.json().get("observations", []):
            v = obs.get("value", ".")
            if v in (".", ""):
                continue
            try:
                rows.append({"date": obs["date"], "raw": float(v)})
            except ValueError:
                continue
        return rows   # already desc from API (sort_order=desc)
    except Exception:
        return []


def _fetch_fred_raw(series_id: str) -> list[dict]:
    """Fetch a FRED series. Tries JSON API first (if key set), then CSV fallback."""
    # Primary: JSON API via api.stlouisfed.org (different domain from fred.stlouisfed.org)
    if FRED_API_KEY:
        result = _fetch_fred_api(series_id)
        if result:
            return result
    # Fallback: CSV endpoint (original implementation)
    try:
        r = requests.get(
            f"{_FRED_BASE}?id={series_id}",
            timeout=5,
            headers={"User-Agent": "Mozilla/5.0"},
        )
        if not r.ok:
            return []
        rows: list[dict] = []
        reader = csv.reader(io.StringIO(r.text))
        next(reader)
        for row in reader:
            if len(row) < 2 or row[1].strip() in (".", ""):
                continue
            try:
                rows.append({"date": row[0], "raw": float(row[1])})
            except ValueError:
                continue
        rows.sort(key=lambda x: x["date"], reverse=True)
        return rows
    except Exception:
        return []


def _apply_transform(rows: list[dict], transform: str) -> list[dict]:
    """Convert raw FRED level data to display values."""
    if not rows:
        return []
    if transform == "direct":
        return [{"date": r["date"], "value": round(r["raw"], 4)} for r in rows]
    if transform == "yoy_pct":
        # Need 12 months of extra history to compute first YoY value
        result = []
        for i in range(len(rows)):
            if i + 12 < len(rows) and rows[i + 12]["raw"] != 0:
                pct = round(
                    (rows[i]["raw"] - rows[i + 12]["raw"]) / rows[i + 12]["raw"] * 100, 2
                )
                result.append({"date": rows[i]["date"], "value": pct})
        return result
    if transform == "mom_diff":
        return [
            {"date": rows[i]["date"], "value": round(rows[i]["raw"] - rows[i + 1]["raw"], 1)}
            for i in range(len(rows) - 1)
        ]
    if transform == "mom_pct":
        result = []
        for i in range(len(rows) - 1):
            if rows[i + 1]["raw"] != 0:
                pct = round(
                    (rows[i]["raw"] - rows[i + 1]["raw"]) / rows[i + 1]["raw"] * 100, 2
                )
                result.append({"date": rows[i]["date"], "value": pct})
        return result
    if transform == "yoy_pct_q":
        # For quarterly GDP level data: compare same quarter vs one year ago (i+4)
        # Much more stable than QoQ annualised — avoids seasonal/front-loading distortion
        result = []
        for i in range(len(rows)):
            if i + 4 < len(rows) and rows[i + 4]["raw"] != 0:
                pct = round(
                    (rows[i]["raw"] - rows[i + 4]["raw"]) / rows[i + 4]["raw"] * 100, 2
                )
                result.append({"date": rows[i]["date"], "value": pct})
        return result
    return []


def _fetch_av_raw(av_fn: str, av_interval: str, av_maturity: str | None = None) -> list[dict]:
    """Fetch one AV series -> newest-first list of {date, raw}. Returns [] on error."""
    if not ALPHA_VANTAGE_KEY:
        return []
    params: dict[str, str] = {
        "function": av_fn,
        "interval": av_interval,
        "apikey":   ALPHA_VANTAGE_KEY,
    }
    if av_maturity:
        params["maturity"] = av_maturity
    try:
        r = requests.get(_AV_BASE, params=params, timeout=15)
        if not r.ok:
            return []
        body = r.json()
        # AV rate-limit responses use "Note" or "Information" keys instead of "data"
        if "Note" in body or "Information" in body:
            return []
        raw = body.get("data", [])
        rows = [{"date": d["date"], "raw": float(d["value"])}
                for d in raw if d.get("value") not in (".", "", None)]
        rows.sort(key=lambda x: x["date"], reverse=True)
        return rows[:60]
    except Exception:
        return []


def _fetch_indicator(cfg: dict) -> list[dict]:
    """Try FRED first; fall back to Alpha Vantage if FRED is unreachable.
    Some AV series need a different transform (av_xform) than FRED (fred_xform)."""
    fred_raw = _fetch_fred_raw(cfg["fred_id"])
    if fred_raw:
        return _apply_transform(fred_raw, cfg["fred_xform"])
    # AV fallback — use av_xform if provided, otherwise reuse fred_xform
    av_raw   = _fetch_av_raw(cfg["av_fn"], cfg["av_interval"], cfg.get("av_maturity"))
    av_xform = cfg.get("av_xform", cfg["fred_xform"])
    return _apply_transform(av_raw, av_xform)


# ── ISM proxy ─────────────────────────────────────────────────────────────────
# ISM's own PMI is not obtainable for free: FRED dropped every NAPM* series in
# 2022 over licensing (they 404 today) and the aggregator copies run months
# behind. The regional Federal Reserve manufacturing surveys are free, ask the
# same question of the same people, and land BEFORE the ISM print each month —
# Philadelphia and New York publish mid-month, ISM on the first business day of
# the next one. So this is a leading proxy, and every surface that shows it must
# say PROXY: it tracks the direction of the ISM, not its level.
_ISM_PROXY_PARTS: dict[str, str] = {
    "philly": "GACDFSA066MSFRBPHI",   # Philadelphia Fed, current general activity
    "empire": "GACDISA066MSFRBNY",    # New York Fed, Empire State general business
    "dallas": "BACTSAMFRBDAL",        # Dallas Fed, general business activity
}

#: Months a component needs before its scale can be trusted (10 years).
_ISM_SD_WINDOW = 120

#: How far from neutral counts as a real reading rather than noise, in units of
#: each survey's own standard deviation.
ISM_PROXY_STALL_BAND = 0.25


def _fetch_ism_proxy() -> tuple[list[dict], dict]:
    """Composite of the regional Fed manufacturing surveys, newest first.

    These are **diffusion indices**: percent of firms reporting better minus
    percent reporting worse, so 0 is neutral and the sign is the whole message.
    They are NOT on the ISM's 50-centred scale, and rescaling them onto one
    would invent a precision nobody can check — so the composite keeps 0 as
    neutral and is quoted in units of each survey's own standard deviation.

    Each component is divided by its own 10-year sd before averaging, because a
    straight mean would be Philadelphia's answer alone: its swings are three
    times Dallas's. A month needs at least two of the three to count.
    """
    raw: dict[str, list[dict]] = {}
    with ThreadPoolExecutor(max_workers=3) as pool:
        futs = {k: pool.submit(_fetch_fred_raw, sid) for k, sid in _ISM_PROXY_PARTS.items()}
        for k, f in futs.items():
            try:
                raw[k] = f.result() or []
            except Exception:
                raw[k] = []

    scaled: dict[str, dict[str, float]] = {}   # part -> {YYYY-MM: value / sd}
    latest: dict[str, float] = {}
    for part, rows in raw.items():
        vals = [r["raw"] for r in rows[:_ISM_SD_WINDOW]]
        if len(vals) < 24:
            continue
        mean = sum(vals) / len(vals)
        sd = (sum((v - mean) ** 2 for v in vals) / (len(vals) - 1)) ** 0.5
        if not sd:
            continue
        scaled[part] = {r["date"][:7]: r["raw"] / sd for r in rows}
        latest[part] = round(rows[0]["raw"], 2)

    if len(scaled) < 2:
        return [], {}

    months = sorted({m for pm in scaled.values() for m in pm}, reverse=True)
    series: list[dict] = []
    for m in months:
        have = [pm[m] for pm in scaled.values() if m in pm]
        if len(have) < 2:
            continue
        series.append({"date": f"{m}-01", "value": round(sum(have) / len(have), 3)})

    components = {
        "parts": latest,
        "as_of": {p: (raw[p][0]["date"][:10] if raw.get(p) else None) for p in scaled},
        "note": "diffusion indices (0 = neutral), scaled by each survey's own 10y sd",
    }
    return series, components


def _get_yield_realtime(sym: str) -> float | None:
    try:
        return round(market_data.get_fast_info(sym).last_price or 0, 3) or None
    except Exception:
        return None


def _next_fomc(today: str) -> dict:
    # Single source: event_calendar (federalreserve.gov dates). The old local
    # list used the day AFTER each decision, so decision day read "tomorrow".
    nxt = next_fomc(datetime.strptime(today, "%Y-%m-%d").date())
    if nxt is None:
        return {"date": "TBA", "days_until": None}
    return {"date": nxt["date"], "days_until": nxt["days_until"]}


# ── Compact series helpers ────────────────────────────────────────────────────
# Store as [[YYYY-MM, value], ...] instead of [{"date": "YYYY-MM-DD", "value": v}]
# Saves ~35% storage; dates are restored to YYYY-MM-01 on read.

def _pack(series: list[dict], n: int) -> list:
    """Convert full series to compact [[YYYY-MM-DD, v], ...] capped at n points."""
    return [[s["date"], round(s["value"], 4)] for s in series[:n]]


def _unpack(packed: list) -> list[dict]:
    """Restore compact series to [{date, value}, ...].
    Handles both legacy YYYY-MM format and current YYYY-MM-DD format."""
    return [{"date": d if len(d) > 7 else f"{d}-01", "value": v} for d, v in packed]


# ── Per-series disk cache ─────────────────────────────────────────────────────

def _load_series_cache() -> dict:
    """Load per-series cache from disk. Returns {} if missing or corrupt."""
    try:
        if _SERIES_CACHE_FILE.exists():
            return json.loads(_SERIES_CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def _save_series_cache(cache: dict) -> None:
    """Write per-series cache to disk (minified JSON)."""
    try:
        _SERIES_CACHE_FILE.write_text(
            json.dumps(cache, separators=(",", ":")), encoding="utf-8"
        )
    except Exception:
        pass


def _is_fresh(entry: dict | None) -> bool:
    """Return True if the cache entry exists and has not exceeded its TTL."""
    return bool(entry and time.time() - entry.get("ts", 0) < entry.get("ttl", 0))


# ── Incremental refresh ───────────────────────────────────────────────────────

def _refresh_series(cache: dict) -> bool:
    """Fetch only expired indicator series. Returns True if anything changed."""
    changed = False

    # Phase 1: try FRED concurrently for all expired indicators (fast, no quota)
    expired = [k for k in _INDICATOR_CFG if not _is_fresh(cache.get(k))]
    if expired:
        fred_results: dict[str, list] = {}
        with ThreadPoolExecutor(max_workers=min(len(expired), 4)) as pool:
            futs = {
                k: pool.submit(
                    lambda c: _apply_transform(_fetch_fred_raw(c["fred_id"]), c["fred_xform"]),
                    _INDICATOR_CFG[k],
                )
                for k in expired
            }
            fred_results = {k: f.result() for k, f in futs.items()}

        # Phase 2: AV fallback (sequential, 350ms apart) for any FRED misses
        # A series with no Alpha Vantage equivalent (core CPI, PCE) has av_fn
        # None — asking AV for it would send function=None and burn a quota slot.
        still_empty = [
            k for k in expired
            if not fred_results.get(k) and _INDICATOR_CFG[k].get("av_fn")
        ]
        for i, k in enumerate(still_empty):
            cfg    = _INDICATOR_CFG[k]
            av_raw = _fetch_av_raw(cfg["av_fn"], cfg["av_interval"], cfg.get("av_maturity"))
            xform  = cfg.get("av_xform", cfg["fred_xform"])
            fred_results[k] = _apply_transform(av_raw, xform)
            if i < len(still_empty) - 1:
                time.sleep(0.35)   # stay under AV 5 req/min

        # Write successful fetches into cache
        for k, data in fred_results.items():
            if data:
                pts = _SERIES_PTS.get(k, 24)
                cache[k] = {
                    "ts":  time.time(),
                    "ttl": _SERIES_TTL[k],
                    "v":   data[0]["value"],
                    "p":   (data[1] if len(data) > 1 else data[0])["value"],
                    "d":   data[0]["date"][:7],   # YYYY-MM
                    "s":   _pack(data, pts),
                }
                changed = True

    # Phase 2b: the ISM proxy, which is three FRED series rather than one and so
    # does not fit _INDICATOR_CFG.
    if not _is_fresh(cache.get("ism_proxy")):
        try:
            ism, parts = _fetch_ism_proxy()
        except Exception:
            ism, parts = [], {}
        if ism:
            cache["ism_proxy"] = {
                "ts":  time.time(),
                "ttl": _SERIES_TTL["ism_proxy"],
                "v":   ism[0]["value"],
                "p":   (ism[1] if len(ism) > 1 else ism[0])["value"],
                "d":   ism[0]["date"][:7],
                "s":   _pack(ism, _SERIES_PTS["ism_proxy"]),
                "c":   parts,
            }
            changed = True

    # Phase 3: real-time yields from yfinance (if expired)
    if not _is_fresh(cache.get("yields_rt")):
        with ThreadPoolExecutor(max_workers=4) as pool:
            yfuts = {m: pool.submit(_get_yield_realtime, sym) for m, sym in _YIELD_SYMBOLS.items()}
            rt = {m: f.result() for m, f in yfuts.items()}
        cache["yields_rt"] = {"ts": time.time(), "ttl": _SERIES_TTL["yields_rt"], **rt}
        changed = True

    return changed


# ── Assemble MacroData response from cache ────────────────────────────────────

def _assemble_macro(cache: dict) -> dict:
    """Build the full MacroData response dict from the per-series cache."""
    today = datetime.utcnow().strftime("%Y-%m-%d")

    def ind(key: str) -> dict | None:
        e = cache.get(key)
        if not e or e.get("v") is None:
            return None
        return {
            "value":  e["v"],
            "prev":   e["p"],
            "date":   e["d"] + "-01",
            "series": _unpack(e.get("s", [])),
        }

    # Real-time yields (yfinance) + 2y/5y history (FRED/AV)
    rt       = cache.get("yields_rt", {})
    y2_entry = cache.get("yield_2y", {})
    y5_entry = cache.get("yield_5y", {})

    y2  = rt.get("2y")  or (y2_entry.get("v") if y2_entry else None)
    y5  = rt.get("5y")  or (y5_entry.get("v") if y5_entry else None)
    y10 = rt.get("10y")
    y3m = rt.get("3m")
    y30 = rt.get("30y")

    sp10_2  = round(y10 - y2,  3) if y10 and y2  else None
    sp10_3m = round(y10 - y3m, 3) if y10 and y3m else None

    # Fed stance from FEDFUNDS direction
    fed_entry  = cache.get("fed_rate", {})
    fed_series = _unpack(fed_entry.get("s", []))
    fed_stance = "HOLD"
    if len(fed_series) >= 3:
        if fed_series[0]["value"] > fed_series[2]["value"]:
            fed_stance = "HIKING"
        elif fed_series[0]["value"] < fed_series[2]["value"]:
            fed_stance = "CUTTING"

    ism_entry = cache.get("ism_proxy") or {}
    return {
        "ism_proxy_components": ism_entry.get("c") or None,
        "indicators": {
            k: ind(k)
            for k in ["cpi", "cpi_core", "pce", "pce_core", "ism_proxy", "gdp",
                      "unemployment", "nfp", "fed_rate", "retail_sales",
                      "consumer_sentiment"]
        },
        "yield_curve": {
            "3m":  y3m, "2y": y2, "5y": y5, "10y": y10, "30y": y30,
            "spread_10y_2y":   sp10_2,
            "spread_10y_3m":   sp10_3m,
            "is_inverted":     bool(sp10_2 is not None and sp10_2 < 0),
            "yield_2y_series": _unpack(y2_entry.get("s", [])),
            "yield_5y_series": _unpack(y5_entry.get("s", [])),
        },
        "fed": {
            "current_rate": fed_entry.get("v"),
            "stance":       fed_stance,
            "series":       fed_series[:36],
            "next_fomc":    _next_fomc(today),
        },
        "has_av_key": True,
        "as_of":      datetime.utcnow().isoformat() + "Z",
    }


# ── API endpoints ─────────────────────────────────────────────────────────────

@router.get("/api/macro")
def get_macro():
    """Return macro indicators. Uses 3-layer cache: memory -> per-series disk -> fetch."""
    # Layer 1: in-memory (5 min) — fastest, no I/O
    mem = _macro_mem.get("data")
    if mem and time.time() - _macro_mem.get("ts", 0) < _MEM_TTL:
        return mem

    # Layer 2: per-series disk cache — refresh only expired series
    cache  = _load_series_cache()
    changed = _refresh_series(cache)
    if changed:
        _save_series_cache(cache)

    # Layer 3: assemble response and populate memory cache
    result = _assemble_macro(cache)
    _macro_mem["data"] = result
    _macro_mem["ts"]   = time.time()
    return result


@router.get("/api/macro/calendar")
def get_macro_calendar(
    back_days: int = Query(730, ge=0, le=3650),
    ahead_days: int = Query(120, ge=0, le=400),
):
    """Past and upcoming FOMC / CPI / NFP / PCE / GDP dates, oldest first.

    Same source as TAIL's event strip (event_calendar): FOMC from the Fed's
    published calendar, releases from FRED. Used by the price chart's event
    rail. Fail-soft — `releases_ok` false means FRED was down and only FOMC
    dates are in the list.
    """
    today = datetime.now().date()
    p = calendar_payload(today, ahead_days=ahead_days, back_days=back_days)
    return {
        "as_of": p["as_of"],
        "events": p["past"] + p["upcoming"],
        "releases_ok": p["releases_ok"],
        "fomc_calendar_through": p["fomc_calendar_through"],
        "fomc_calendar_stale": p["fomc_calendar_stale"],
    }


@router.delete("/api/macro/cache")
def clear_macro_cache():
    """Force full refresh: wipe memory cache and reset all series TTLs."""
    _macro_mem.clear()
    # Reset timestamps so every series appears expired on next request
    try:
        cache = _load_series_cache()
        for entry in cache.values():
            if isinstance(entry, dict):
                entry["ts"] = 0
        _save_series_cache(cache)
    except Exception:
        pass
    # Remove legacy monolithic cache file if it exists
    for legacy in ["macro_cache.json"]:
        try:
            p = Path(__file__).parent.parent / legacy
            if p.exists():
                p.unlink()
        except Exception:
            pass
    return {"cleared": True}
