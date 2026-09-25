"""
Market heatmap — one whole equity market, grouped by sector, sized by market cap.

Backs the `heatmap(MARKET)` terminal command (the HMAP view, which replaced
GMOV on 2026-09-25).

Why a screener instead of per-symbol quotes: GMOV's heatmap fetched every tile
one ticker at a time (fast_info + a YTD history pull + sometimes `.info`), so a
100-tile map was 100–300 Yahoo calls. Yahoo's equity screener returns up to 250
full quotes per call, already sorted by market cap. One call per sector — 11,
run in parallel — maps a market's ~250 largest names in about half a second,
and every colour metric on the page (1D, 52W, vs 50/200-day average, distance
from the 52-week high, relative volume) is already in that payload, so switching
metric costs no request at all.

Calls go through yfinance, so upstream_health observes them like every other
Yahoo call. Failures are negative-cached; a failed refresh serves the last good
map flagged `stale` rather than an empty page.
"""
from __future__ import annotations

import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor

import yfinance as yf
from fastapi import APIRouter, HTTPException, Query
from yfinance import EquityQuery

from cache import TTLCache

log = logging.getLogger(__name__)
router = APIRouter()

# Yahoo's screener sector taxonomy (EQUITY_SCREENER_EQ_MAP["sector"]).
SECTORS = [
    "Technology",
    "Financial Services",
    "Healthcare",
    "Consumer Cyclical",
    "Communication Services",
    "Industrials",
    "Consumer Defensive",
    "Energy",
    "Basic Materials",
    "Real Estate",
    "Utilities",
]

# Friendly names → Yahoo screener region codes. Any 2-letter region code the
# screener knows is accepted as-is too (see REGIONS).
ALIASES = {
    "US": "us", "USA": "us", "SPX": "us", "NYSE": "us", "NASDAQ": "us",
    "TH": "th", "SET": "th", "THAI": "th",
    "JP": "jp", "JPX": "jp", "NIKKEI": "jp", "TOPIX": "jp",
    "HK": "hk", "HSI": "hk",
    "CN": "cn", "CHINA": "cn",
    "KR": "kr", "KOSPI": "kr",
    "TW": "tw", "TWSE": "tw",
    "IN": "in", "NSE": "in", "INDIA": "in",
    "UK": "gb", "GB": "gb", "FTSE": "gb", "LSE": "gb",
    "DE": "de", "DAX": "de", "FR": "fr", "CAC": "fr",
    "SG": "sg", "AU": "au", "ASX": "au", "CA": "ca", "TSX": "ca",
    "BR": "br", "VN": "vn", "ID": "id", "MY": "my", "PH": "ph",
}

try:  # the screener's own list of valid regions
    from yfinance.const import EQUITY_SCREENER_EQ_MAP

    REGIONS: set[str] = set(EQUITY_SCREENER_EQ_MAP.get("region", []))
except Exception:  # noqa: BLE001 — older yfinance: fall back to the alias targets
    REGIONS = set(ALIASES.values())

# Thai board noise: NVDRs (-R), depositary receipts of foreign stocks
# (NVDA80.BK — their "market cap" is the foreign company's), foreign-board and
# preferred lines. Each would be a duplicate or an impostor tile.
_TH_NOISE = re.compile(r"(-R|-F|-P|\d{2})\.BK$", re.I)

_cache = TTLCache(ttl=90, maxsize=32)        # fresh map
_last_good = TTLCache(ttl=6 * 3600, maxsize=32)  # served (flagged stale) if a refresh fails
_fail = TTLCache(ttl=60, maxsize=32)          # negative cache


def resolve_market(market: str) -> str | None:
    m = market.strip().upper()
    if m in ALIASES:
        return ALIASES[m]
    return m.lower() if m.lower() in REGIONS else None


def _pct(v, scale: float = 1.0):
    return round(float(v) * scale, 2) if isinstance(v, (int, float)) else None


def _tile(q: dict, sector: str) -> dict | None:
    sym = q.get("symbol")
    cap = q.get("marketCap")
    price = q.get("regularMarketPrice")
    if not sym or not isinstance(cap, (int, float)) or cap <= 0 or price is None:
        return None
    if q.get("quoteType") not in (None, "EQUITY"):
        return None
    if sym.endswith(".BK") and _TH_NOISE.search(sym):
        return None
    vol = q.get("regularMarketVolume")
    avg = q.get("averageDailyVolume3Month")
    return {
        "s": sym,
        "n": q.get("shortName") or q.get("longName") or sym,
        "ln": q.get("longName"),
        "sec": sector,
        "cap": float(cap),
        "px": price,
        "d1": _pct(q.get("regularMarketChangePercent")),
        "w52": _pct(q.get("fiftyTwoWeekChangePercent")),          # already percent
        "d50": _pct(q.get("fiftyDayAverageChangePercent"), 100),  # fraction → %
        "d200": _pct(q.get("twoHundredDayAverageChangePercent"), 100),
        "hi": _pct(q.get("fiftyTwoWeekHighChangePercent"), 100),  # ≤ 0: below the high
        "rv": round(vol / avg, 2) if vol and avg else None,       # intraday: partial day
        "pe": _pct(q.get("trailingPE")),
        "cur": q.get("currency"),
        "ms": q.get("marketState"),
        "pre": _pct(q.get("preMarketChangePercent")),
        "post": _pct(q.get("postMarketChangePercent")),
    }


def _fetch_sector(region: str, sector: str, per: int) -> list[dict]:
    query = EquityQuery("and", [EquityQuery("eq", ["region", region]), EquityQuery("eq", ["sector", sector])])
    # Over-fetch: on SET the top of every sector is depositary receipts that
    # _tile() throws away, so `per` survivors need a deeper page.
    res = yf.screen(query, sortField="intradaymarketcap", sortAsc=False, size=min(250, per * 4))
    tiles: list[dict] = []
    seen_names: set[str] = set()
    for q in res.get("quotes", []):
        t = _tile(q, sector)
        if not t:
            continue
        # Share classes (GOOG/GOOGL, BRK-A/B) are one company — keep the larger.
        key = (t["ln"] or t["n"]).lower()
        if key in seen_names:
            continue
        seen_names.add(key)
        tiles.append(t)
        if len(tiles) >= per:
            break
    return tiles


def build_heatmap(region: str, per: int) -> dict:
    t0 = time.time()
    errors = 0
    tiles: list[dict] = []
    with ThreadPoolExecutor(max_workers=len(SECTORS)) as pool:
        futures = {pool.submit(_fetch_sector, region, s, per): s for s in SECTORS}
        for fut, sector in futures.items():
            try:
                tiles.extend(fut.result())
            except Exception as exc:  # noqa: BLE001
                errors += 1
                log.warning("heatmap %s/%s failed: %s", region, sector, exc)
    if not tiles:
        raise RuntimeError(f"no tiles for region {region} ({errors} sector errors)")
    for t in tiles:
        t.pop("ln", None)
    return {
        "market": region,
        "tiles": tiles,
        "currency": tiles[0].get("cur"),
        "asOf": int(time.time()),
        "partial": errors > 0,
        "ms": round((time.time() - t0) * 1000),
    }


@router.get("/api/market-heatmap")
def market_heatmap(market: str = Query("US"), per: int = Query(25, ge=5, le=60)):
    region = resolve_market(market)
    if not region:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown market '{market}'. Try US, TH, JP, HK, CN, KR, TW, IN, UK, DE or a 2-letter region code.",
        )
    key = f"{region}:{per}"
    hit = _cache.get(key)
    if hit is not None:
        return hit
    if _fail.get(key) is not None:
        stale = _last_good.get(key)
        if stale is not None:
            return {**stale, "stale": True}
        return {"market": region, "tiles": [], "error": "screener unavailable"}
    try:
        data = build_heatmap(region, per)
    except Exception as exc:  # noqa: BLE001
        log.warning("market heatmap %s failed: %s", region, exc)
        _fail.set(key, True)
        stale = _last_good.get(key)
        if stale is not None:
            return {**stale, "stale": True}
        return {"market": region, "tiles": [], "error": "screener unavailable"}
    _cache.set(key, data)
    _last_good.set(key, data)
    return data
