"""
Discovery feeds for the MKT left panel (tabs next to WATCHLIST).

- FREQ   — the symbols this user searches most. Every symbol opened from a
           search box posts a hit; the top N by count (ties → most recent) is
           read back. Local SQLite table `search_hits`, not synced: it describes
           habits on this machine, and merging counts across machines would
           need a CRDT for no real gain.
- ACTIVE — US stocks with the most shares traded today, from Yahoo's
           predefined `most_actives` screener (via yfinance, so it is observed
           by upstream_health like every other Yahoo call).
"""
import logging
import re
import time

import yfinance as yf
from fastapi import APIRouter, Query
from pydantic import BaseModel

from cache import TTLCache
from db import get_db

log = logging.getLogger(__name__)
router = APIRouter()

# Tickers, indices (^GSPC), FX (EURUSD=X), futures (CL=F), crypto (BTC-USD),
# foreign listings (PTT.BK). Anything else is a typo, not a symbol worth counting.
_SYMBOL_RE = re.compile(r"^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$")


class SearchHit(BaseModel):
    symbol: str


@router.post("/api/search-stats/hit")
def record_search_hit(hit: SearchHit):
    sym = hit.symbol.strip().upper()
    if not _SYMBOL_RE.match(sym):
        return {"ok": False, "error": "invalid symbol"}
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO search_hits (symbol, count, last_at) VALUES (?, 1, datetime('now'))
            ON CONFLICT(symbol) DO UPDATE SET count = count + 1, last_at = datetime('now')
            """,
            (sym,),
        )
    return {"ok": True, "symbol": sym}


@router.get("/api/search-stats/top")
def top_searches(limit: int = Query(30, ge=1, le=50)):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT symbol, count, last_at FROM search_hits "
            "ORDER BY count DESC, last_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return {"items": [dict(r) for r in rows]}


@router.delete("/api/search-stats/{symbol}")
def forget_search(symbol: str):
    """Drop one symbol from the frequency list (a mistyped or finished idea)."""
    with get_db() as conn:
        conn.execute("DELETE FROM search_hits WHERE symbol = ?", (symbol.strip().upper(),))
    return {"ok": True}


# Yahoo refreshes the screener every few minutes; 2 min keeps it current without
# a request per panel render. A failure is cached for 60s (negative cache) so an
# outage is not re-fired on every poll.
_active_cache = TTLCache(ttl=120, maxsize=8)
_active_fail = TTLCache(ttl=60, maxsize=8)


def _num(v):
    return float(v) if isinstance(v, (int, float)) else None


@router.get("/api/most-active")
def most_active(count: int = Query(30, ge=1, le=50)):
    key = f"most_active:{count}"
    cached = _active_cache.get(key) or _active_fail.get(key)
    if cached is not None:
        return cached
    try:
        res = yf.screen("most_actives", count=count)
        items = []
        for q in res.get("quotes", [])[:count]:
            vol = _num(q.get("regularMarketVolume"))
            avg = _num(q.get("averageDailyVolume3Month"))
            items.append(
                {
                    "symbol": q.get("symbol"),
                    "name": q.get("shortName") or q.get("longName"),
                    "price": _num(q.get("regularMarketPrice")),
                    "pctChange": _num(q.get("regularMarketChangePercent")),
                    "volume": vol,
                    "avgVolume": avg,
                    # relative volume — 2.0 = twice the 3-month average
                    "rvol": (vol / avg) if vol and avg else None,
                    "marketState": q.get("marketState"),
                    # Extended hours — the screener carries them; the panel
                    # shows a PRE/AH line under the row while they trade.
                    "preMarketPrice": _num(q.get("preMarketPrice")),
                    "preMarketChange": _num(q.get("preMarketChange")),
                    "preMarketChangePercent": _num(q.get("preMarketChangePercent")),
                    "postMarketPrice": _num(q.get("postMarketPrice")),
                    "postMarketChange": _num(q.get("postMarketChange")),
                    "postMarketChangePercent": _num(q.get("postMarketChangePercent")),
                    "time": q.get("regularMarketTime"),
                }
            )
        data = {"items": items, "asOf": int(time.time())}
        _active_cache.set(key, data)
        return data
    except Exception as exc:  # noqa: BLE001 — upstream shape/network errors alike
        log.warning("most_actives screener failed: %s", exc)
        data = {"items": [], "error": "screener unavailable", "asOf": int(time.time())}
        _active_fail.set(key, data)
        return data
