"""
Global government bond yields via FRED API (St. Louis Fed).

Data sources:
  - US: daily FRED series  (DGS2 / DGS5 / DGS10 / DGS30)
  - G10 / OECD: monthly OECD series hosted on FRED (IRLTLT01XXM156N)
  - China: not available from FRED; omitted until a free daily source is found

TTL: 4 hours (bond data is daily; 4-hour refresh is sufficient)
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

import requests
from fastapi import APIRouter

from cache import TTLCache
from config import FRED_API_KEY, FRED_JSON_URL

router = APIRouter()
_cache = TTLCache(ttl=4 * 3600, maxsize=20)

# ── Country registry ──────────────────────────────────────────────────────────

_COUNTRIES = [
    {"code": "US", "name": "United States"},
    {"code": "JP", "name": "Japan"},
    {"code": "DE", "name": "Germany"},
    {"code": "GB", "name": "United Kingdom"},
    {"code": "FR", "name": "France"},
    {"code": "IT", "name": "Italy"},
    {"code": "AU", "name": "Australia"},
    {"code": "CA", "name": "Canada"},
    {"code": "KR", "name": "South Korea"},
]

# FRED series IDs per country + tenor
# US = daily Treasury Constant Maturity rates
# Others = OECD monthly long-term government bond yield (10Y)
_FRED_SERIES: dict[str, dict[str, str]] = {
    "US": {
        "2y":  "DGS2",
        "5y":  "DGS5",
        "10y": "DGS10",
        "30y": "DGS30",
    },
    "JP": {"10y": "IRLTLT01JPM156N"},
    "DE": {"10y": "IRLTLT01DEM156N"},
    "GB": {"10y": "IRLTLT01GBM156N"},
    "FR": {"10y": "IRLTLT01FRM156N"},
    "IT": {"10y": "IRLTLT01ITM156N"},
    "AU": {"10y": "IRLTLT01AUM156N"},
    "CA": {"10y": "IRLTLT01CAM156N"},
    "KR": {"10y": "IRLTLT01KRM156N"},
}

# Countries included in the 90-day / 12-month comparison chart
_SERIES_COUNTRIES = {"US", "JP", "DE", "GB"}

_UA = "Mozilla/5.0 (compatible; BloombergTerminal/1.0)"


# ── FRED fetch helpers ────────────────────────────────────────────────────────

def _fred_fetch(series_id: str, limit: int = 10, obs_start: str | None = None) -> list[dict]:
    """Fetch observations from FRED API → list of {date, value} sorted oldest-first."""
    params: dict = {
        "series_id":  series_id,
        "api_key":    FRED_API_KEY,
        "file_type":  "json",
        "sort_order": "desc",
        "limit":      limit,
    }
    if obs_start:
        params["observation_start"] = obs_start

    r = requests.get(FRED_JSON_URL, params=params,
                     headers={"User-Agent": _UA}, timeout=15)
    r.raise_for_status()

    rows: list[dict] = []
    for o in r.json().get("observations", []):
        v = o.get("value", "")
        if v and v != ".":
            try:
                rows.append({"date": o["date"], "value": round(float(v), 4)})
            except ValueError:
                pass
    return sorted(rows, key=lambda x: x["date"])


# ── Build dataset ─────────────────────────────────────────────────────────────

def _build_data() -> dict:
    if not FRED_API_KEY:
        return {
            "table":  [],
            "curves": {},
            "series": {},
            "as_of":  datetime.utcnow().isoformat() + "Z",
            "error":  "FRED_API_KEY not configured. Set FRED_API_KEY env var.",
        }

    # Date window for recent (table) data
    # US daily: look back 15 calendar days to ensure we get 2 trading days
    daily_start   = (datetime.utcnow() - timedelta(days=15)).strftime("%Y-%m-%d")
    # International monthly: look back 90 days to capture 2 monthly observations
    monthly_start = (datetime.utcnow() - timedelta(days=90)).strftime("%Y-%m-%d")
    # Series (chart): 13 months for monthly, 100 days for daily
    series_start  = (datetime.utcnow() - timedelta(days=400)).strftime("%Y-%m-%d")

    # Build fetch tasks
    table_tasks: list[tuple[str, str, str, str]] = []  # (code, tenor, series_id, obs_start)
    series_tasks: list[tuple[str, str]] = []           # (code, series_id)

    for code, tenors in _FRED_SERIES.items():
        is_daily = (code == "US")
        start = daily_start if is_daily else monthly_start
        for tenor, sid in tenors.items():
            table_tasks.append((code, tenor, sid, start))
        if code in _SERIES_COUNTRIES and "10y" in tenors:
            series_tasks.append((code, tenors["10y"]))

    raw: dict[str, dict[str, list[dict]]] = {}

    # Parallel table fetch
    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = {
            pool.submit(_fred_fetch, sid, 5, start): (code, tenor)
            for code, tenor, sid, start in table_tasks
        }
        for fut in as_completed(futures):
            code, tenor = futures[fut]
            try:
                rows = fut.result()
                raw.setdefault(code, {})[tenor] = rows
            except Exception as exc:
                print(f"[global_yields] {code}/{tenor}: {exc}")

    # Parallel series fetch (comparison chart — more history)
    series_raw: dict[str, list[dict]] = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        sfuts = {
            pool.submit(_fred_fetch, sid, 100, series_start): code
            for code, sid in series_tasks
        }
        for fut in as_completed(sfuts):
            code = sfuts[fut]
            try:
                series_raw[code] = fut.result()
            except Exception as exc:
                print(f"[global_yields/series] {code}: {exc}")

    # ── Build table rows ──────────────────────────────────────────────────────
    country_map = {c["code"]: c["name"] for c in _COUNTRIES}
    table: list[dict] = []

    for c in _COUNTRIES:
        code   = c["code"]
        tenors = raw.get(code, {})

        def _latest(t: str, _t=tenors) -> float | None:
            rows = _t.get(t, [])
            return rows[-1]["value"] if rows else None

        def _prev(t: str, _t=tenors) -> float | None:
            rows = _t.get(t, [])
            return rows[-2]["value"] if len(rows) >= 2 else None

        y10 = _latest("10y")
        y2  = _latest("2y")
        y30 = _latest("30y")
        p10 = _prev("10y")

        if y10 is None:
            continue  # skip country if no 10Y data

        # 1-day change only meaningful for US (daily data)
        chg = round(y10 - p10, 4) if (p10 is not None and code == "US") else None

        row: dict = {
            "code":   code,
            "name":   country_map.get(code, code),
            "10y":    y10,
            "2y":     y2,
            "30y":    y30,
            "chg_1d": chg,
        }
        if y10 and y2:
            row["spread_10y_2y"] = round(y10 - y2, 4)

        table.append(row)

    # Sort: US first, then descending 10Y yield
    us_rows    = [r for r in table if r["code"] == "US"]
    other_rows = sorted(
        [r for r in table if r["code"] != "US"],
        key=lambda x: x["10y"], reverse=True
    )
    table = us_rows + other_rows

    # ── Build yield curves (per country) ─────────────────────────────────────
    curves: dict[str, dict] = {}
    for c in _COUNTRIES:
        code   = c["code"]
        tenors = raw.get(code, {})
        curve: dict[str, float | None] = {}
        for t in ["2y", "5y", "10y", "30y"]:
            rows = tenors.get(t, [])
            curve[t] = rows[-1]["value"] if rows else None
        curves[code] = curve

    return {
        "table":   table,
        "curves":  curves,
        "series":  series_raw,
        "as_of":   datetime.utcnow().isoformat() + "Z",
        "source":  "FRED/OECD",
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/api/macro/global-yields")
def global_yields():
    """Global government bond yields (10Y) via FRED API. 4-hour cache."""
    cached = _cache.get("data")
    if cached is not None:
        return cached

    data = _build_data()
    _cache.set("data", data)
    return data


@router.delete("/api/macro/global-yields")
def clear_global_yields_cache():
    """Force-clear the global yields cache."""
    _cache.delete("data")
    return {"cleared": True}
