"""
GET /api/prebuy-check/{symbol} — MKT → STRUCTURE → CHECK and the chart chip.

Gathers the facts prebuy_check.evaluate() rules on, all from what other screens
already fetch and cache — nothing is pulled here that a page does not pull:

    rotation   routers/rotation.py table (US: the stock's Select Sector SPDR,
               TH: its SET sector)                              15 min cache
    trend      daily history, 2y (market_snapshots, shared)     15 min
    calendar   calendar_feed.build (macro + the symbol's thesis dates) and
               calendar_feed.symbol_events (its earnings / dividends — any
               symbol, pulled behind the request)
    book       TRADE GUARD snapshot of the personal book (routers/risk.py)
    thesis     theses / track_metrics / thesis_notes rows for the symbol

A source that is slow is reported PENDING (the client polls while `pending` is
non-empty); a source that fails is reported OPEN with the reason — never PASS.
Personal book only (account_scope default). plans/pre-buy-check.md.
"""
from __future__ import annotations

import logging
import sqlite3
import time
from datetime import date, timedelta
from typing import Any, Optional

from fastapi import APIRouter, Query

import prebuy_check
from cache import TTLCache
from db import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/prebuy-check", tags=["prebuy-check"])

# A complete answer is reused this long; one with PENDING parts is never cached.
_cache = TTLCache(ttl=60, maxsize=256)
_FACT_TIMEOUT = 6.0      # seconds a fact may take before it is reported PENDING
EVENT_DAYS_AHEAD = 45    # the month strip + the list below it


def applicable(symbol: str) -> bool:
    """Indices, FX, crypto and futures have no sector, earnings or thesis to check."""
    s = symbol.upper()
    return not (s.startswith("^") or "=" in s or s.endswith("-USD"))


# ── Facts ────────────────────────────────────────────────────────────────────

def _quote(symbol: str) -> Optional[dict]:
    from market_requests import collect
    from market_snapshots import quote_future
    got, _ = collect({symbol: quote_future(symbol)}, timeout=_FACT_TIMEOUT)
    return got.get(symbol)


def _rotation_fact(symbol: str, quote: Optional[dict]) -> tuple[Optional[dict], Optional[str]]:
    """(fact, gics sector name or SET sector code) — fact None = still loading."""
    from routers import rotation
    from sector_map import to_gics
    from sector_membership import GICS_SECTORS, load_set_snapshot

    if symbol.endswith(".BK"):
        code = next((m["sector"] for m in load_set_snapshot()["members"]
                     if m["symbol"].upper() == symbol[:-3]), None)
        if not code:
            return {"unknown": f"{symbol} is not in the SET sector file"}, None
        table = rotation.rotation_table(bench="SPY", market="TH")
        row = next((r for r in table.get("rows", []) if r.get("kind") == "sector" and r.get("id") == code), None)
        if row is None:
            return ({"unknown": "ROT has no data for the TH sectors right now"} if table.get("rows") else None), code
        return {"sector": row.get("name") or code, "group_id": code, "quadrant": row.get("quadrant"),
                "mom_dir": row.get("mom_dir"), "m1_vs_bench": row.get("m1_vs_bench"),
                "bench": table.get("bench"), "market": "TH"}, code

    table = rotation.rotation_table(bench="SPY", market="US")
    rows = table.get("rows", [])
    own = next((r for r in rows if r.get("id") == symbol), None)  # a sector / theme ETF itself
    # GICS from the Select Sector SPDR that holds it (State Street's daily file,
    # every S&P 500 member). Yahoo's `sector` is Morningstar's scheme, not GICS
    # (reference/rotation-groups.md) — used only when no SPDR holds the stock,
    # and the check says so.
    gics, etf, approx = None, None, False
    if own is None:
        etf = _spdr_of(symbol)
        if etf:
            gics = next(name for _, name, e in GICS_SECTORS if e == etf)
        elif quote and quote.get("sector"):
            gics, approx = to_gics(quote["sector"]), True
            etf = next((e for _, name, e in GICS_SECTORS if name == gics), None)
    row = own or (next((r for r in rows if r.get("id") == etf), None) if etf else None)
    if row is None:
        if not rows or quote is None:
            return None, gics
        why = ("not in any Select Sector SPDR and no sector on the quote (an ETF or fund)" if not gics
               else f"{gics} has no ROT row")
        return {"unknown": why}, gics
    fact = {"sector": row.get("name"), "group_id": row.get("id"), "quadrant": row.get("quadrant"),
            "mom_dir": row.get("mom_dir"), "m1_vs_bench": row.get("m1_vs_bench"),
            "bench": table.get("bench"), "market": "US"}
    if approx:
        fact["approx"] = "not in the S&P 500 — sector ≈ Yahoo's (Morningstar), not GICS"
    return fact, gics


def _spdr_of(symbol: str) -> Optional[str]:
    """The Select Sector SPDR whose holdings file lists `symbol`, or None. The 11
    files are fetched in parallel once a day (routers/rotation.py caches them,
    failures for 30 min); a file still loading counts as not holding it."""
    from concurrent.futures import ThreadPoolExecutor, wait

    from routers import rotation
    from sector_membership import GICS_SECTORS, us_yahoo

    etfs = [e for _, _, e in GICS_SECTORS]
    pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="prebuy-spdr")
    futures = {e: pool.submit(rotation._ssga_holdings, e) for e in etfs}
    wait(futures.values(), timeout=_FACT_TIMEOUT)
    pool.shutdown(wait=False)  # a slow file finishes in the background and is cached
    for e, f in futures.items():
        held = f.result() if f.done() and not f.exception() else None
        if held and any(us_yahoo(r["ticker"]) == symbol for r in held.get("rows", [])):
            return e
    return None


def _trend_fact(symbol: str) -> Optional[dict]:
    from market_requests import collect
    from market_snapshots import history_future

    frames, _ = collect({symbol: history_future(symbol, "2y", "1d", ttl=900)}, timeout=_FACT_TIMEOUT)
    df = frames.get(symbol)
    if df is None:
        return None
    close = df["Close"].dropna().astype(float)
    r = prebuy_check.RULES
    if close.empty:
        return {"close": None, "sma50": None, "sma200": None, "sma50_prev": None}
    s50 = close.rolling(r["sma_short"]).mean()
    s200 = close.rolling(r["sma_long"]).mean()

    def last(s, back: int = 0) -> Optional[float]:
        v = s.iloc[-1 - back] if len(s) > back else float("nan")
        return None if v != v else round(float(v), 6)  # NaN → None

    return {"close": float(close.iloc[-1]), "sma50": last(s50), "sma200": last(s200),
            "sma50_prev": last(s50, r["sma_slope_bars"]), "as_of": str(close.index[-1].date())}


def _calendar_facts(symbol: str, thesis_ids: set[str]) -> tuple[dict, list[dict], list[dict], list[str]]:
    """(earnings fact, upcoming high-impact macro, events for the panel, pending names)."""
    import calendar_feed

    today = date.today()
    start, end = today.replace(day=1), today + timedelta(days=EVENT_DAYS_AHEAD)
    pending: list[str] = []
    built = calendar_feed.build(start, end, today)
    own, status = calendar_feed.symbol_events(symbol, start, end)
    bare = symbol[:-3] if symbol.endswith(".BK") else symbol

    events: dict[str, dict] = {}
    for e in built["events"]:
        mine = (e.get("symbol") or "").upper() in (symbol, bare)
        tied = any(t.get("id") in thesis_ids for t in e.get("theses") or [])
        macro = e["category"] == "MACRO" and e.get("impact") in ("high", "medium")
        if mine or tied or macro:
            events[e["id"]] = e
    for e in own:
        events.setdefault(e["id"], e)
    listed = sorted(events.values(), key=lambda e: (e["date"], e["category"] != "COMPANY"))

    upcoming_earn = [e for e in listed if e["kind"] == "EARNINGS" and e.get("days_until", -1) >= 0
                     and (e.get("symbol") or "").upper() in (symbol, bare) and not e.get("done")]
    nxt = upcoming_earn[0] if upcoming_earn else None
    if status.get("pending") and not status.get("loaded"):
        pending.append("earnings")
    earn = {
        "applicable": status.get("applicable", True),
        "next": {"date": nxt["date"], "days_until": nxt["days_until"], "estimated": nxt.get("estimated"),
                 "title": nxt["title"]} if nxt else None,
        "pending": bool(status.get("pending")) and not status.get("loaded"),
        "failed": bool(status.get("failed") and "earnings" in (status.get("failed") or {})),
        "window_days": EVENT_DAYS_AHEAD,
    }
    macro = [{"date": e["date"], "days_until": e["days_until"], "title": e["title"]}
             for e in listed if e["category"] == "MACRO" and e.get("impact") == "high"
             and e.get("days_until", -1) >= 0]
    keep = ("id", "date", "days_until", "category", "kind", "title", "impact", "estimated", "done",
            "detail", "source", "symbol")
    return earn, macro, [{k: e.get(k) for k in keep} for e in listed], pending


def _book_fact(symbol: str, sector_key: Optional[str]) -> tuple[Optional[dict], Optional[dict]]:
    """(book fact, guard summary) from TRADE GUARD on the personal book."""
    import trade_guard
    from routers.risk import _guard_snapshot
    from sector_map import to_gics

    try:
        snap = _guard_snapshot(None, "THB")
    except Exception as exc:  # noqa: BLE001 — reported, never PASS
        logger.warning("prebuy-check guard snapshot failed: %s", exc)
        return {"unknown": f"TRADE GUARD unavailable ({type(exc).__name__})"}, None
    guard = {"light": snap.get("light"), "size_multiplier": snap.get("size_multiplier"),
             "why": snap.get("size_multiplier_why") or []}
    invested = float(snap.get("invested_value") or 0.0)
    nav = snap.get("nav_value") or invested
    bare = symbol[:-3] if symbol.endswith(".BK") else symbol
    rows = [p for p in snap.get("positions", [])
            if str(p.get("yf_symbol") or "").upper() == symbol or str(p.get("symbol") or "").upper() == bare]
    mv = sum(float(p.get("market_value") or 0.0) for p in rows)
    notional = float(nav) * trade_guard.SIZE_BUCKETS[prebuy_check.RULES["buy_bucket"]] \
        * float(snap.get("size_multiplier") or 0.0) if nav else 0.0
    denom = invested + notional
    weight = mv / invested * 100 if invested else 0.0
    out = {"held": bool(rows), "weight_pct": round(weight, 2), "bucket_notional": round(notional, 2),
           "guard_multiplier": snap.get("size_multiplier"),
           "weight_after_pct": round((mv + notional) / denom * 100, 2) if denom and notional else None}
    gics = to_gics(rows[0].get("sector")) if rows and rows[0].get("sector") else (to_gics(sector_key) if sector_key else None)
    if gics:
        now = next((s["weight_pct"] for s in snap.get("sectors", []) if to_gics(s["sector"]) == gics), 0.0)
        sec_mv = now / 100 * invested
        out.update({"sector": gics, "sector_pct": round(now, 2),
                    "sector_after_pct": round((sec_mv + notional) / denom * 100, 2) if denom and notional else None})
    return out, guard


def _thesis_fact(symbol: str) -> tuple[dict, set[str]]:
    import calendar_feed

    bare = symbol[:-3] if symbol.endswith(".BK") else symbol
    with get_db() as conn:
        _, by_symbol = calendar_feed.load_theses(conn)
        seen: dict[str, dict] = {}
        for key in (symbol, bare):
            for t in by_symbol.get(key, []):
                if t["status"] not in ("closed", "invalidated"):
                    seen[t["id"]] = t
        ids = list(seen)
        kill = rules = 0
        if ids:
            marks = ",".join("?" * len(ids))
            try:
                kill = conn.execute(
                    f"SELECT COUNT(*) FROM track_metrics WHERE thesis_id IN ({marks}) AND role = 'KILLER' "
                    "AND kill_op IS NOT NULL AND kill_value IS NOT NULL AND retired_at IS NULL "
                    "AND deleted_at IS NULL", ids).fetchone()[0]
            except sqlite3.OperationalError:
                kill = 0
            try:
                rules = conn.execute(
                    f"SELECT COUNT(*) FROM thesis_notes WHERE thesis_id IN ({marks}) AND deleted_at IS NULL "
                    "AND title LIKE 'กติกาการถือ%'", ids).fetchone()[0]
            except sqlite3.OperationalError:
                rules = 0
    theses = [{"id": t["id"], "title": t["title"], "status": t["status"]} for t in seen.values()]
    return {"theses": theses, "kill_lines": int(kill), "holding_rules": bool(rules)}, set(ids)


# ── Route ────────────────────────────────────────────────────────────────────

def build(symbol: str) -> dict[str, Any]:
    sym = symbol.strip().upper()
    started = time.monotonic()
    out: dict[str, Any] = {"symbol": sym, "as_of": date.today().isoformat(), "applicable": applicable(sym)}
    if not out["applicable"]:
        out.update({"reason": "index, FX, crypto or futures — no sector, earnings or thesis to check",
                    "tier": None, "checks": [], "events": [], "pending": [], "rules": prebuy_check.RULES})
        return out

    pending: list[str] = []
    errors: dict[str, str] = {}

    def safe(name: str, fn, default):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 — one fact failing must not sink the rest
            logger.warning("prebuy-check %s %s failed: %s", sym, name, exc)
            errors[name] = type(exc).__name__
            return default

    quote = safe("quote", lambda: _quote(sym), None)
    rot, sector_key = safe("rotation", lambda: _rotation_fact(sym, quote), ({"unknown": "ROT failed"}, None))
    if rot is None:
        pending.append("rotation")
    trend = safe("trend", lambda: _trend_fact(sym), {"close": None, "sma50": None, "sma200": None})
    if trend is None:
        pending.append("trend")
    thesis, thesis_ids = safe("thesis", lambda: _thesis_fact(sym), ({"theses": []}, set()))
    earn, macro, events, cal_pending = safe(
        "calendar", lambda: _calendar_facts(sym, thesis_ids),
        ({"applicable": True, "next": None, "pending": False, "failed": True}, None, [], []))
    pending += cal_pending
    book, guard = safe("book", lambda: _book_fact(sym, sector_key), ({"unknown": "TRADE GUARD failed"}, None))

    result = prebuy_check.evaluate({
        "rotation": rot, "trend": trend, "earnings": earn, "macro": macro,
        "book": book, "thesis": thesis, "guard": guard,
    })
    out.update(result)
    out.update({
        "name": (quote or {}).get("shortName") or (quote or {}).get("longName"),
        "sector": (rot or {}).get("sector") if rot and not rot.get("unknown") else sector_key,
        "events": events,
        "pending": pending,
        "errors": errors,
        "took_ms": round((time.monotonic() - started) * 1000),
    })
    return out


@router.get("/{symbol}")
def get_prebuy_check(symbol: str, fresh: bool = Query(False, description="skip the 60 s cache")):
    """What we can measure that disagrees with buying `symbol` now — checks, tier
    A/B/C, the size it allows, and the symbol's events for the month. Never a
    buy / sell call; see prebuy_check.py."""
    key = symbol.strip().upper()
    if not fresh:
        hit = _cache.get(key)
        if hit is not None:
            return hit
    out = build(key)
    if not out.get("pending") and not out.get("errors"):
        _cache.set(key, out)
    return out
