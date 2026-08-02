"""
Government bond curves for the MKT [1] TICK DATA board.

Deliberately separate from `global_yields.py`:
  - `global_yields` serves MACRO [6] → YIELD tab and owns the `table/curves/series`
    shape. Adding tenors there changes the column count that tab renders.
  - This router serves a flat, tick-row shape (one row per tenor) and covers the
    FULL curve for the two countries the board cares about.

Sources (verified 2026-08-01):
  US — FRED daily constant-maturity, 11 tenors 1M…30Y. yfinance only exposes
       4 points (^IRX/^FVX/^TNX/^TYX), so those are used for `chartSymbol` only.
  JP — MOF CSV, 15 tenors 1Y…40Y. Neither FRED (OECD monthly 10Y only) nor
       yfinance (no JGB yield series at all — only ETFs and JGB VIX) can cover
       the curve, so MOF is the single free daily source.

TTL: 1h for live values, 24h for the 1.2 MB MOF history file.
"""
import csv
import io
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

import requests
from fastapi import APIRouter

from cache import TTLCache
from config import FRED_API_KEY
from routers.global_yields import _fred_fetch

router = APIRouter()
_cache = TTLCache(ttl=3600, maxsize=8)

_UA = "Mozilla/5.0 (compatible; BloombergTerminal/1.0)"

# ── US: FRED daily constant-maturity Treasury rates ───────────────────────────

_UST: list[tuple[str, str]] = [
    ("1M", "DGS1MO"),
    ("3M", "DGS3MO"),
    ("6M", "DGS6MO"),
    ("1Y", "DGS1"),
    ("2Y", "DGS2"),
    ("3Y", "DGS3"),
    ("5Y", "DGS5"),
    ("7Y", "DGS7"),
    ("10Y", "DGS10"),
    ("20Y", "DGS20"),
    ("30Y", "DGS30"),
]

# Tenors that have a yfinance series the chart panel can actually draw.
# ^IRX is the 13-week discount rate — close enough to 3M for charting only.
_UST_CHART: dict[str, str] = {
    "3M": "^IRX",
    "5Y": "^FVX",
    "10Y": "^TNX",
    "30Y": "^TYX",
}

# ── JP: MOF CSV ───────────────────────────────────────────────────────────────
# NOTE the /english/ path — the Japanese path 404s with a 20 KB HTML page that
# would silently parse as CSV garbage. `_parse_mof_csv` guards on the header.
_JGB_CURRENT = (
    "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv"
)
_JGB_HISTORY = (
    "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/"
    "historical/jgbcme_all.csv"
)
# OECD monthly 10Y — fallback only, when MOF is unreachable
_JP_FRED_10Y = "IRLTLT01JPM156N"


# ── Row builder ───────────────────────────────────────────────────────────────

def _row(country: str, tenor: str, series: list[tuple[str, float]]) -> dict | None:
    """Build one tick row from an ascending [(date, value)] series.

    `value` is a percentage; `changeBp`/`ytdBp` are basis points, because a
    percent-change on a yield is meaningless (a move from 0.05% to 0.10% is not
    a "+100%" market event).
    """
    if not series:
        return None

    last_date, last_val = series[-1]
    prev_val = series[-2][1] if len(series) >= 2 else None

    year_start = f"{datetime.utcnow().year}-01-01"
    ytd_base = None
    for d, v in series:
        if d >= year_start:
            ytd_base = v
            break
    if ytd_base is None:
        # Series has no observation this year yet — fall back to the oldest we have
        ytd_base = series[0][1]

    return {
        "id": f"{country} {tenor}",
        "country": country,
        "tenor": tenor,
        "value": round(last_val, 4),
        "changeBp": round((last_val - prev_val) * 100, 1) if prev_val is not None else None,
        "ytdBp": round((last_val - ytd_base) * 100, 1),
        "sparkline1": [v for _, v in series[-30:]],
        "chartSymbol": _UST_CHART.get(tenor) if country == "US" else None,
        "asOf": last_date,
    }


def _window_start() -> str:
    """Oldest observation we need: 45 days before Jan 1 of the current year.

    The 45-day pad guarantees a YTD baseline and a usable sparkline in early
    January, when the current year has barely any observations.
    """
    year_start = datetime(datetime.utcnow().year, 1, 1)
    return (year_start - timedelta(days=45)).strftime("%Y-%m-%d")


# ── US fetch ──────────────────────────────────────────────────────────────────

def _fetch_us() -> tuple[list[dict], str | None]:
    if not FRED_API_KEY:
        return [], "FRED_API_KEY not configured. Set FRED_API_KEY env var."

    start = _window_start()
    rows: dict[str, dict] = {}

    def _one(tenor: str, sid: str):
        obs = _fred_fetch(sid, limit=400, obs_start=start)
        return tenor, [(o["date"], o["value"]) for o in obs]

    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(_one, t, s) for t, s in _UST]
        for fut in as_completed(futures):
            try:
                tenor, series = fut.result()
            except Exception as exc:  # one dead series must not kill the curve
                print(f"[rates] US tenor failed: {exc}")
                continue
            row = _row("US", tenor, series)
            if row:
                rows[tenor] = row

    ordered = [rows[t] for t, _ in _UST if t in rows]
    return ordered, None


# ── JP fetch ──────────────────────────────────────────────────────────────────

def _parse_mof_csv(text: str) -> tuple[list[str], list[tuple[str, dict[str, float]]]]:
    """Parse a MOF jgbcme CSV → (tenors, [(iso_date, {tenor: value})]) ascending.

    Layout (verified): line 1 is a title, line 2 is the header
    `Date,1Y,2Y,...,40Y`, then one row per business day with dates like
    `2026/7/1` (not zero-padded) and empty strings for missing tenors.
    """
    if not text.lstrip().startswith("Interest Rate"):
        raise ValueError("not a MOF interest-rate CSV (got HTML or unknown format?)")

    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if len(rows) < 3:
        raise ValueError("MOF CSV too short")

    header = rows[1]
    if not header or header[0].strip() != "Date":
        raise ValueError(f"unexpected MOF header: {header[:3]}")
    tenors = [h.strip() for h in header[1:] if h.strip()]

    out: list[tuple[str, dict[str, float]]] = []
    for raw in rows[2:]:
        if not raw or not raw[0].strip():
            continue
        try:
            d = datetime.strptime(raw[0].strip(), "%Y/%m/%d").strftime("%Y-%m-%d")
        except ValueError:
            continue
        vals: dict[str, float] = {}
        for i, tenor in enumerate(tenors, start=1):
            if i >= len(raw):
                break
            v = raw[i].strip()
            if not v:  # missing tenor is an empty cell, not a "-"
                continue
            try:
                vals[tenor] = float(v)
            except ValueError:
                continue
        if vals:
            out.append((d, vals))

    out.sort(key=lambda x: x[0])
    return tenors, out


def _get_mof(url: str, cache_key: str, ttl: int) -> str:
    cached = _cache.get(cache_key, ttl=ttl)
    if cached is not None:
        return cached
    r = requests.get(url, headers={"User-Agent": _UA}, timeout=30)
    r.raise_for_status()
    text = r.content.decode("utf-8", errors="replace")
    _cache.set(cache_key, text)
    return text


def _fetch_jp_fred_fallback() -> list[dict]:
    """OECD monthly 10Y — one row, clearly flagged as stale by the caller."""
    if not FRED_API_KEY:
        return []
    obs = _fred_fetch(_JP_FRED_10Y, limit=40, obs_start=_window_start())
    row = _row("JP", "10Y", [(o["date"], o["value"]) for o in obs])
    return [row] if row else []


def _fetch_jp() -> tuple[list[dict], str, bool]:
    """→ (rows, source, stale). Never raises — falls back to FRED, then empty."""
    try:
        # The month file is the only one carrying the newest business day: the
        # history file lagged it by a full month when this was verified.
        cur_tenors, cur_hist = _parse_mof_csv(
            _get_mof(_JGB_CURRENT, "jgb:current", 3600)
        )
        try:
            _, all_hist = _parse_mof_csv(
                _get_mof(_JGB_HISTORY, "jgb:history", 24 * 3600)
            )
        except Exception as exc:
            print(f"[rates] MOF history unavailable, month file only: {exc}")
            all_hist = []

        start = _window_start()
        merged: dict[str, dict[str, float]] = {
            d: v for d, v in all_hist if d >= start
        }
        merged.update({d: v for d, v in cur_hist})  # month file wins on overlap

        by_tenor: dict[str, list[tuple[str, float]]] = {t: [] for t in cur_tenors}
        for d in sorted(merged):
            for tenor, val in merged[d].items():
                if tenor in by_tenor:
                    by_tenor[tenor].append((d, val))

        rows = []
        for tenor in cur_tenors:
            row = _row("JP", tenor, by_tenor.get(tenor, []))
            if row:
                rows.append(row)
        if rows:
            return rows, "mof", False
        raise ValueError("MOF parsed but produced no rows")
    except Exception as exc:
        print(f"[rates] MOF failed ({exc}) — falling back to FRED monthly 10Y")
        return _fetch_jp_fred_fallback(), "fred", True


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.get("/api/rates/curve")
def rates_curve():
    """Full US Treasury + JGB curves as flat tick rows for the TICK DATA board."""
    cached = _cache.get("rates:curve")
    if cached is not None:
        return cached

    us, us_error = _fetch_us()
    jp, jp_source, jp_stale = _fetch_jp()

    data = {
        "us": us,
        "jp": jp,
        "usError": us_error,
        "jpSource": jp_source,
        "jpStale": jp_stale,
        "asOf": datetime.utcnow().isoformat() + "Z",
    }
    _cache.set("rates:curve", data)
    return data


@router.delete("/api/rates/curve")
def clear_rates_cache():
    _cache.clear()
    return {"cleared": True}
