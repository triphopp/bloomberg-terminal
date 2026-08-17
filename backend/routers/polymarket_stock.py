"""
Per-stock Polymarket prediction markets — price ladders as a market-implied distribution.

Polymarket runs recurring single-name equity events ("What will Micron (MU) hit in
August 2026?", "Will MU close above ___ end of August?", "MU Up or Down on Aug 14?").
Each is a ladder of Yes/No markets on strikes, so the quoted prices are a live
implied distribution for that stock over a fixed horizon.

Discovery uses Gamma's `/public-search`, which — unlike `/markets?q=` — really does
filter server-side, so no 3,000-market pool scan is needed.

Endpoints:
    GET /api/polymarket/stock/{symbol}          — full ladders + summary for one symbol
    GET /api/polymarket/stocks?symbols=A,B,C    — summary only, batched (watchlist row)
"""
from __future__ import annotations

import datetime
import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from fastapi import APIRouter, Query

from cache import TTLCache
from config import DEFAULT_HTTP_TIMEOUT, POLYMARKET_GAMMA_BASE
from routers.polymarket import _extract_probability
from sources import market_data

router = APIRouter()

_SESSION = requests.Session()
_SESSION.headers.update({"User-Agent": "BloombergTerminal/1.0", "Accept": "application/json"})
_TIMEOUT = DEFAULT_HTTP_TIMEOUT
_GAMMA = POLYMARKET_GAMMA_BASE

# Prices move with the order book, so these stay short — the point of the panel is
# that it tracks the live market, not a 10-minute-old snapshot.
_events_cache = TTLCache(ttl=90, maxsize=300)    # symbol → parsed events
_spot_cache = TTLCache(ttl=60, maxsize=300)      # symbol → last price
# Most tickers simply have no single-name markets. Remembering that for 15 min keeps
# a 30-symbol watchlist from re-searching Gamma for all of them every 90 seconds.
_miss_cache = TTLCache(ttl=900, maxsize=500)

# Strike labels look like "↑ $1,320" / "↓ $720" / "$1,020 or above"
_STRIKE_RE = re.compile(r"(-?[\d,]+(?:\.\d+)?)")
_UP_GLYPHS = ("↑", "above", "or more", "higher")
_DOWN_GLYPHS = ("↓", "below", "or less", "lower")


# ── Event classification ──────────────────────────────────────────────────────

def _event_type(title: str, slug: str) -> str:
    t = f"{title} {slug}".lower()
    if "up or down" in t or "up-or-down" in t:
        return "updown"
    if "what will" in t or "what-price" in t or "will-" in t and "hit" in t:
        return "ladder"
    if "above" in t or "close above" in t:
        return "above"
    if "earnings" in t or "revenue" in t or "margin" in t or "eps" in t:
        return "earnings"
    return "other"


def _parse_strike(label: str) -> tuple[float | None, str]:
    """"↑ $1,320" → (1320.0, "up")."""
    if not label:
        return None, ""
    low = label.lower()
    direction = ""
    if any(g in label or g in low for g in _UP_GLYPHS):
        direction = "up"
    elif any(g in label or g in low for g in _DOWN_GLYPHS):
        direction = "down"
    m = _STRIKE_RE.search(label.replace(",", ""))
    if not m:
        return None, direction
    try:
        return float(m.group(1)), direction
    except ValueError:
        return None, direction


def _is_live(event: dict, now: datetime.datetime) -> bool:
    """Closed events and anything already past its end date are dropped — the panel
    must never show last week's ladder as if it were current."""
    if event.get("closed") or event.get("archived"):
        return False
    end = event.get("endDate") or ""
    if not end:
        return True
    try:
        return datetime.datetime.fromisoformat(end.replace("Z", "+00:00")) > now
    except Exception:
        return True


def _days_left(end: str, now: datetime.datetime) -> float | None:
    try:
        dt = datetime.datetime.fromisoformat(end.replace("Z", "+00:00"))
        return round((dt - now).total_seconds() / 86_400, 1)
    except Exception:
        return None


# ── Fetch ─────────────────────────────────────────────────────────────────────

def _search_events(query: str, limit: int = 10) -> list[dict]:
    try:
        r = _SESSION.get(
            f"{_GAMMA}/public-search",
            params={"q": query, "limit_per_type": limit},
            timeout=_TIMEOUT,
        )
        if not r.ok:
            return []
        return r.json().get("events") or []
    except Exception as exc:
        print(f"[pm/stock] search '{query}': {exc}")
        return []


def _event_detail(slug: str) -> dict | None:
    try:
        r = _SESSION.get(f"{_GAMMA}/events", params={"slug": slug}, timeout=_TIMEOUT)
        if not r.ok:
            return None
        data = r.json()
        return data[0] if isinstance(data, list) and data else None
    except Exception as exc:
        print(f"[pm/stock] event '{slug}': {exc}")
        return None


def _spot(symbol: str) -> float | None:
    cached = _spot_cache.get(symbol)
    if cached is not None:
        return cached
    try:
        fi = market_data.get_fast_info(symbol)
        price = getattr(fi, "last_price", None)
    except Exception:
        price = None
    if price is not None:
        _spot_cache.set(symbol, float(price))
    return price


def _title_matches(title: str, symbol: str) -> bool:
    """Gamma's search is fuzzy — "MU" also returns markets about other names. Keep
    only events whose title carries the ticker itself."""
    return bool(re.search(rf"(?<![A-Za-z0-9]){re.escape(symbol)}(?![A-Za-z0-9])", title))


# ── Ladder → distribution ─────────────────────────────────────────────────────

def _build_event(detail: dict, spot: float | None, now: datetime.datetime) -> dict | None:
    markets = detail.get("markets") or []
    if not markets:
        return None

    etype = _event_type(detail.get("title", ""), detail.get("slug", ""))
    strikes: list[dict] = []
    prob_up: float | None = None

    for m in markets:
        prob = _extract_probability(m)
        label = (m.get("groupItemTitle") or "").strip()
        question = m.get("question", "") or ""

        if etype == "updown":
            # Two markets, "Up" and "Down" — only the Up leg is a signal.
            if label.lower().startswith("up") or "up on" in question.lower():
                prob_up = prob
            continue

        strike, direction = _parse_strike(label or question)
        if strike is None or prob is None:
            continue
        if etype == "above":
            # Every rung of a "close above ___" event is P(close ≥ K): one CDF,
            # not a two-sided touch ladder, so nothing here points down.
            direction = "up"
        strikes.append({
            "label": label or question[:40],
            "strike": strike,
            "direction": direction or ("up" if spot and strike >= spot else "down"),
            "prob": round(prob, 4),
            "volume": float(m.get("volume", 0) or 0),
            "slug": m.get("slug", ""),
        })

    strikes.sort(key=lambda s: s["strike"], reverse=True)

    end = detail.get("endDate", "") or ""
    return {
        "slug": detail.get("slug", ""),
        "title": detail.get("title", ""),
        "type": etype,
        "end_date": end,
        "days_left": _days_left(end, now),
        "volume": float(detail.get("volume", 0) or 0),
        "liquidity": float(detail.get("liquidity", 0) or 0),
        "strikes": strikes,
        "prob_up": round(prob_up, 4) if prob_up is not None else None,
        "url": f"https://polymarket.com/event/{detail.get('slug', '')}",
    }


def _prob_above_spot(strikes: list[dict], spot: float | None) -> float | None:
    """Interpolate P(close ≥ spot) off a "close above ___" CDF.

    The rungs bracket the spot price; probability falls as the strike rises, so a
    straight-line read between the two neighbouring rungs is the market's own
    answer to "does this close higher than it is right now?".
    """
    if not spot:
        return None
    pts = sorted(((s["strike"], s["prob"]) for s in strikes), key=lambda p: p[0])
    if len(pts) < 2:
        return None
    below = [p for p in pts if p[0] <= spot]
    above = [p for p in pts if p[0] > spot]
    if not below or not above:
        return None
    k0, p0 = below[-1]
    k1, p1 = above[0]
    if k1 == k0:
        return round(p0, 4)
    weight = (spot - k0) / (k1 - k0)
    return round(p0 + (p1 - p0) * weight, 4)


def _summarize(events: list[dict], spot: float | None) -> dict:
    """Collapse the ladders into the handful of numbers a watchlist row can show."""
    summary: dict = {
        "spot": spot,
        "prob_up": None,
        "prob_up_source": None,
        "prob_above_spot": None,
        "nearest_up": None,
        "nearest_down": None,
        "implied_high": None,
        "implied_low": None,
        "skew": None,
        "horizon_days": None,
        "event_slug": None,
        "event_title": None,
        "url": None,
    }

    # A daily up/down market is the cleanest directional read when one exists.
    updown = next((e for e in events if e["type"] == "updown" and e["prob_up"] is not None), None)
    if updown:
        summary["prob_up"] = updown["prob_up"]
        summary["prob_up_source"] = "updown"

    # Two different instruments, both useful: the "close above ___" CDF prices where
    # the stock finishes, the "what will it hit" ladder prices where it trades on the
    # way. Neither always brackets spot — a CDF whose top rung is under spot (the
    # stock ran past the whole ladder) still has to yield the upside to the touch
    # ladder — so each side of the summary is filled from whichever has the strikes.
    cdf = next((e for e in events if e["type"] == "above" and e["strikes"]), None)
    touch = next((e for e in events if e["type"] == "ladder" and e["strikes"]), None)
    primary = cdf or touch
    if not primary:
        return summary

    summary["horizon_days"] = primary["days_left"]
    summary["event_slug"] = primary["slug"]
    summary["event_title"] = primary["title"]
    summary["url"] = primary["url"]

    if cdf:
        interpolated = _prob_above_spot(cdf["strikes"], spot)
        if interpolated is not None:
            summary["prob_above_spot"] = interpolated
            if summary["prob_up"] is None:
                summary["prob_up"] = interpolated
                summary["prob_up_source"] = "cdf"

    def _tag(strike: dict, basis: str) -> dict:
        return {**strike, "basis": basis}

    up_candidates: list[dict] = []
    down_candidates: list[dict] = []
    if spot:
        if cdf:
            up_candidates += [_tag(s, "close") for s in cdf["strikes"] if s["strike"] > spot]
            down_candidates += [_tag(s, "close") for s in cdf["strikes"] if s["strike"] < spot]
        if touch:
            up_candidates += [
                _tag(s, "touch")
                for s in touch["strikes"]
                if s["direction"] == "up" and s["strike"] > spot
            ]
            down_candidates += [
                _tag(s, "touch")
                for s in touch["strikes"]
                if s["direction"] == "down" and s["strike"] < spot
            ]
        # "close" rungs first so the CDF wins whenever it covers this side.
        up_candidates.sort(key=lambda s: (s["basis"] != "close", s["strike"]))
        down_candidates.sort(key=lambda s: (s["basis"] != "close", -s["strike"]))
        summary["nearest_up"] = up_candidates[0] if up_candidates else None
        summary["nearest_down"] = down_candidates[0] if down_candidates else None

        if summary["prob_up"] is None and summary["nearest_up"]:
            summary["prob_up"] = summary["nearest_up"]["prob"]
            summary["prob_up_source"] = summary["nearest_up"]["basis"]

        if summary["nearest_up"] and summary["nearest_down"]:
            # A "close above K" rung below spot prices the stock STAYING up, so flip
            # it to get a downside tail comparable with the upside probability.
            down = summary["nearest_down"]
            down_tail = 1 - down["prob"] if down["basis"] == "close" else down["prob"]
            summary["skew"] = round(summary["nearest_up"]["prob"] - down_tail, 4)

    # Furthest strike each way the market still gives a coin-flip or better.
    # Stay on one basis per side: touch rungs far below spot are often already
    # resolved ("did it trade at 780 this month" — yes, three weeks ago), which
    # would drag the implied low down to a level that says nothing about now.
    def _one_basis(cands: list[dict]) -> list[dict]:
        close_only = [s for s in cands if s["basis"] == "close"]
        return close_only or cands

    coin_up = [s for s in _one_basis(up_candidates) if s["prob"] >= 0.5]
    coin_down = [
        s
        for s in _one_basis(down_candidates)
        if (s["prob"] <= 0.5 if s["basis"] == "close" else s["prob"] >= 0.5)
    ]
    if coin_up:
        summary["implied_high"] = max(s["strike"] for s in coin_up)
    if coin_down:
        summary["implied_low"] = min(s["strike"] for s in coin_down)

    return summary


def _stock_markets(symbol: str, company: str = "") -> dict:
    sym = symbol.upper()
    cached = _events_cache.get(f"{sym}:{company}")
    if cached is not None:
        return cached

    now = datetime.datetime.now(datetime.timezone.utc)
    miss = _miss_cache.get(sym)
    if miss is not None:
        return {
            "symbol": sym,
            "spot": _spot(sym),
            "as_of": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "events": [],
            "summary": _summarize([], None),
        }
    queries = [sym] + ([company] if company else [])

    candidates: dict[str, dict] = {}
    for q in queries:
        for ev in _search_events(q):
            slug = ev.get("slug", "")
            if not slug or slug in candidates:
                continue
            if not _is_live(ev, now):
                continue
            if not _title_matches(ev.get("title", ""), sym):
                continue
            candidates[slug] = ev

    spot = _spot(sym)
    events: list[dict] = []
    if candidates:
        with ThreadPoolExecutor(max_workers=6) as pool:
            futures = {pool.submit(_event_detail, slug): slug for slug in candidates}
            for fut in as_completed(futures):
                detail = fut.result()
                if not detail or not _is_live(detail, now):
                    continue
                built = _build_event(detail, spot, now)
                if built and (built["strikes"] or built["prob_up"] is not None):
                    events.append(built)

    # Soonest expiry first — that's the one a trader acts on.
    events.sort(key=lambda e: (e["days_left"] if e["days_left"] is not None else 9_999))

    data = {
        "symbol": sym,
        "spot": spot,
        "as_of": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "events": events,
        "summary": _summarize(events, spot),
    }
    _events_cache.set(f"{sym}:{company}", data)
    if not events:
        _miss_cache.set(sym, True)
    return data


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/api/polymarket/stock/{symbol}")
def stock_prediction_markets(
    symbol: str,
    company: str = Query(default="", description="Company name — widens the search"),
):
    """Live prediction markets for one ticker: price ladders + implied summary."""
    return _stock_markets(symbol, company)


@router.get("/api/polymarket/stocks")
def stock_prediction_summaries(
    symbols: str = Query(..., description="Comma-separated tickers (max 30)"),
):
    """Summary-only, batched — one row per watchlist symbol."""
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()][:30]
    out: dict[str, dict] = {}
    if not syms:
        return {"summaries": out}

    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(_stock_markets, s): s for s in syms}
        for fut in as_completed(futures):
            sym = futures[fut]
            try:
                data = fut.result()
            except Exception as exc:
                print(f"[pm/stock] {sym}: {exc}")
                continue
            if data["events"]:
                out[sym] = {
                    **data["summary"],
                    "event_count": len(data["events"]),
                }

    return {
        "summaries": out,
        "as_of": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
