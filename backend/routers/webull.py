"""Webull OpenAPI — order-book depth for US stocks and ETFs (MKT → STRUCTURE → DEPTH).

  GET  /api/webull/status          keys set? which host? token status — never a secret
                                   `shared`: is the token shared through Drive, and any error
  POST /api/webull/token           ask for an access token (production: texts a code to the owner)
  POST /api/webull/token/check     re-read the token's status from Webull
  GET  /api/webull/depth?symbol=AAPL&depth=10&overnight=false
  GET  /api/webull/depth/stream?symbol=AAPL&depth=10&overnight=false   text/event-stream
       the same book, pushed as it changes (webull_stream.py — MQTT, ≤3 a second).
       `data:` = a depth answer · `event: state` = {live, state, error} when it changes.
       `event: trades` = [{t, price, size, side, session}, ...] — time and sales, oldest first.
       The panel still asks /depth first: that call is where a refusal is explained,
       and the stream only ever carries books and trades.
  GET  /api/webull/ticks?symbol=AAPL&count=100
       the last trades (≤1000 — about a minute and a half of a busy stock; Webull
       takes no start time, so there is no going further back), newest first.
       What the tape shows before the stream has printed anything.

Depth is what the account is entitled to: with "Nasdaq Basic - Non Display"
(free) that is one level, and asking for more is refused ("depth not more than
1") — so the limit is remembered and asked for instead. More levels need the
OpenAPI ("Non Display") TotalView subscription, separate from the one in the
Webull app. The answer says how many levels came back (`levels`) and how many
were wanted (`depth_requested`) rather than pretending.

A request for a token is never made on its own: in production it sends an SMS
and starts a 5-minute clock, so only POST /api/webull/token does it.

Successes are cached 1 s (the panel polls; Webull allows 300 calls / 60 s),
refusals 20 s — "no subscription" does not change between two polls.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timezone

import asyncio
import json

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

import webull_client as wb
import webull_stream
from cache import TTLCache

router = APIRouter()

_DEPTH_PATH = "/market-data/stocks/depths/list"
_TICKS_PATH = "/market-data/stocks/ticks/list"
_CATEGORIES = ("US_STOCK", "US_ETF")
# US tickers only: AAPL · BRK.B · BF-B. An index (^DJI), a future (ES=F), FX
# (JPY=X), crypto (BTC-USD) or a foreign listing (PTT.BK, VOD.L) is not in this
# feed. Mirrors `isDepthSymbol` in components/bloomberg/lib/depth-book.ts.
_SYMBOL = re.compile(r"^[A-Z]{1,5}(?:[.\-][ABC])?$")

_cache = TTLCache(ttl=1, maxsize=64)
_fail = TTLCache(ttl=20, maxsize=256)          # negative cache
_category = TTLCache(ttl=24 * 3600, maxsize=2048)   # symbol → the category that answered
# session → the most levels Webull will give this account. Short-lived: a new
# subscription should show within minutes, at the cost of one refused call.
_entitled = TTLCache(ttl=10 * 60, maxsize=4)
_DEPTH_LIMIT = re.compile(r"depth not more than (\d+)", re.I)


def _raise(err: wb.WebullError):
    raise HTTPException(err.status, {"message": str(err), "code": err.code})


def _num(value) -> float | None:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n == n else None


def _side(levels) -> list[dict]:
    out = []
    for level in levels if isinstance(levels, list) else []:
        if not isinstance(level, dict):
            continue
        price, size = _num(level.get("price")), _num(level.get("size"))
        if price is None or size is None:
            continue
        orders = level.get("order")
        out.append({
            "price": price,
            "size": size,
            # Webull lists a level's orders per market participant; absent on L1.
            "count": len(orders) if isinstance(orders, list) and orders else None,
        })
    return out


def _shape(symbol: str, data, asked: int, category: str, overnight: bool,
           endpoint: str = _DEPTH_PATH) -> dict:
    if isinstance(data, list):
        data = next((d for d in data if isinstance(d, dict) and d.get("symbol") == symbol),
                    data[0] if data and isinstance(data[0], dict) else {})
    if not isinstance(data, dict):
        data = {}
    bids, asks = _side(data.get("bids")), _side(data.get("asks"))
    bids.sort(key=lambda l: -l["price"])
    asks.sort(key=lambda l: l["price"])
    quote_ms = _num(data.get("quote_time"))
    return {
        "symbol": symbol,
        "category": category,
        "overnight": overnight,
        "bids": bids,
        "asks": asks,
        "levels": max(len(bids), len(asks)),
        "depth_requested": asked,
        "has_counts": any(l["count"] is not None for l in bids + asks),
        "quote_time": (datetime.fromtimestamp(quote_ms / 1000, timezone.utc).isoformat(timespec="seconds")
                       if quote_ms else None),
        "source": {
            "name": "Webull OpenAPI",
            "endpoint": endpoint,
            "environment": wb.environment(),
            "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
    }


def _refusal(r, token: str | None = None) -> tuple[int, str, str]:
    """Webull said no → (status to answer with, what to tell the user, code).
    One place, so every endpoint names an ended token or a lapsed subscription
    the same way and none of them reports it as a vague upstream error."""
    reason = wb.explain(r)
    if r.status_code == 401:                      # INVALID_TOKEN — the same on every endpoint
        wb.mark_token("INVALID", reason, token)
        return (409, "The Webull access token is no longer accepted (a token lasts 15 days) — request "
                     "a new one and confirm the SMS code in the Webull app", "token_missing")
    if r.status_code == 403:
        known = _subscription()
        ended = (f" The entitlement was due to end on {known['ends']}."
                 if known and known["days_left"] is not None and known["days_left"] <= 0 else "")
        return (403, f"Not entitled ({reason}).{ended} Market data over OpenAPI needs its own subscription: "
                     "Webull → avatar → Advanced Quotes → OpenAPI Advanced Quotes", "subscription")
    if r.status_code == 429:
        return 429, "Webull rate limit (300 calls / 60 s) — slowing down", "rate_limit"
    return r.status_code if r.status_code < 500 else 424, f"Webull {r.status_code}: {reason}", "upstream"


def _subscription() -> dict | None:
    """When the market-data entitlement ends, as the owner wrote it down
    (WEBULL_SUBSCRIPTION_ENDS) — Webull's API does not say. None = not written down."""
    raw = wb.config.WEBULL_SUBSCRIPTION_ENDS
    if not raw:
        return None
    try:
        ends = date.fromisoformat(raw)
    except ValueError:
        return {"ends": raw, "days_left": None,
                "error": "WEBULL_SUBSCRIPTION_ENDS is not a YYYY-MM-DD date"}
    return {"ends": ends.isoformat(), "days_left": (ends - date.today()).days, "error": None}


def _trade(raw: dict) -> dict | None:
    """One print, typed. side: B = buyer lifted the offer, S = seller hit the bid,
    N = neither (inside the spread, or reported off the book)."""
    t, price, size = _num(raw.get("time")), _num(raw.get("price")), _num(raw.get("volume"))
    if t is None or price is None or size is None:
        return None
    side = str(raw.get("side") or "N").upper()[:1]
    return {"t": int(t), "price": price, "size": size, "side": side if side in "BS" else "N",
            "session": raw.get("trading_session")}


_ticks_cache = TTLCache(ttl=2, maxsize=64)


@router.get("/api/webull/ticks")
def webull_ticks(symbol: str = Query(..., max_length=12), count: int = Query(100, ge=1, le=1000)):
    sym = symbol.strip().upper()
    if not _SYMBOL.match(sym):
        raise HTTPException(422, {"message": f"{sym or symbol!r}: US stocks and ETFs only",
                                  "code": "unsupported"})
    key = f"ticks|{sym}|{count}"
    if (hit := _ticks_cache.get(key)) is not None:
        return hit
    if (bad := _fail.get(key)) is not None:
        raise HTTPException(bad["status"], bad["detail"])
    try:
        token = wb.active_token()
        r = wb.call("GET", _TICKS_PATH, token=token, query={
            "symbol": sym, "category": _category.get(sym) or "US_STOCK", "count": str(count)})
    except wb.WebullError as err:
        _raise(err)
    if not r.ok:
        status, message, code = _refusal(r, token)
        detail = {"message": message, "code": code}
        if code != "token_missing":
            _fail.set(key, {"status": status, "detail": detail})
        raise HTTPException(status, detail)
    try:
        rows = r.json().get("result") or []
    except (ValueError, AttributeError):
        rows = []
    trades = sorted((t for t in map(_trade, rows) if t), key=lambda t: -t["t"])
    out = {"symbol": sym, "trades": trades,
           "source": {"name": "Webull OpenAPI", "endpoint": _TICKS_PATH,
                      "environment": wb.environment(),
                      "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}}
    _ticks_cache.set(key, out)
    return out


@router.get("/api/webull/status")
def webull_status():
    try:
        # A status older than 6 h is read again from Webull (one call), so an
        # ended token shows here before a panel trips over it.
        token = wb.public_token(wb.refresh_token_status()) if wb.configured() else None
    except wb.WebullError:
        token = None
    return {"configured": wb.configured(), "host": wb.host(), "environment": wb.environment(),
            "token": token, "shared": wb.shared_status(), "subscription": _subscription(),
            "stream": webull_stream.hub.status()}


@router.post("/api/webull/token")
def webull_token_create():
    try:
        record = wb.create_token()
    except wb.WebullError as err:
        _raise(err)
    _fail.clear()
    return {"token": wb.public_token(record), "environment": wb.environment()}


@router.post("/api/webull/token/check")
def webull_token_check():
    try:
        record = wb.check_token()
    except wb.WebullError as err:
        _raise(err)
    if record and record.get("status") == "NORMAL":
        _fail.clear()
    return {"token": wb.public_token(record), "environment": wb.environment()}


@router.get("/api/webull/depth")
def webull_depth(symbol: str = Query(..., max_length=12),
                 depth: int = Query(10, ge=1, le=50),
                 overnight: bool = False):
    sym = symbol.strip().upper()
    if not _SYMBOL.match(sym):
        raise HTTPException(422, {"message": f"{sym or symbol!r}: depth covers US stocks and ETFs only",
                                  "code": "unsupported"})
    key = f"{sym}|{depth}|{int(overnight)}"
    if (hit := _cache.get(key)) is not None:
        return hit
    if (bad := _fail.get(key)) is not None:
        raise HTTPException(bad["status"], bad["detail"])

    try:
        token = wb.active_token()
    except wb.WebullError as err:
        _raise(err)

    session = "overnight" if overnight else "regular"

    def ask(category: str):
        return wb.call("GET", _DEPTH_PATH, token=token, query={
            "symbol": sym, "category": category,
            "depth": str(max(1, min(depth, _entitled.get(session) or depth))),
            "overnight_required": "true" if overnight else "false"})

    known = _category.get(sym)
    last = None
    for category in ([known] if known else _CATEGORIES):
        try:
            r = ask(category)
            # Asking for more levels than the account has is a refusal, not a short
            # answer: "ILLEGAL_PARAMETER: depth not more than 1" on the free Level 1
            # feed. Remember the limit and ask for that instead.
            if r.status_code == 417 and (limit := _DEPTH_LIMIT.search(r.text or "")):
                _entitled.set(session, int(limit.group(1)))
                r = ask(category)
        except wb.WebullError as err:
            _fail.set(key, {"status": err.status, "detail": {"message": str(err), "code": err.code}})
            _raise(err)
        if r.ok:
            try:
                payload = r.json()
            except ValueError:
                last = (424, "Webull returned a body that is not JSON", "upstream")
                break
            out = _shape(sym, payload, depth, category, overnight)
            if out["levels"]:
                _category.set(sym, category)
                _cache.set(key, out)
                return out
            last = (404, f"{sym}: no bid/ask in the {category} book", "empty")
            continue                      # an ETF asked as a stock answers empty: try the other
        last = _refusal(r, token)
        if last[2] != "upstream":
            break
        # 417 = business refusal: wrong category for this symbol is one of them.

    status, message, code = last or (424, "Webull gave no answer", "upstream")
    detail = {"message": message, "code": code}
    if code != "token_missing":           # a new token must work at once, not after the cache
        _fail.set(key, {"status": status, "detail": detail})
    raise HTTPException(status, detail)


# ── Live book ────────────────────────────────────────────────────────────────

_STREAM_TICK_S = 0.2
_STREAM_PING_S = 15.0


def _sse(event: str | None, payload: object) -> str:
    head = f"event: {event}\n" if event else ""
    return f"{head}data: {json.dumps(payload, separators=(',', ':'))}\n\n"


@router.get("/api/webull/depth/stream")
async def webull_depth_stream(request: Request,
                              symbol: str = Query(..., max_length=12),
                              depth: int = Query(10, ge=1, le=50),
                              overnight: bool = False):
    sym = symbol.strip().upper()
    if not _SYMBOL.match(sym):
        raise HTTPException(422, {"message": f"{sym or symbol!r}: depth covers US stocks and ETFs only",
                                  "code": "unsupported"})
    hub = webull_stream.hub
    session = "overnight" if overnight else "regular"
    asked = max(1, min(depth, _entitled.get(session) or depth))

    async def gen():
        # Acquire inside the generator: a response that is never iterated never
        # runs `finally`, and would hold the subscription for good.
        try:
            hub.acquire(sym, asked, overnight)
        except wb.WebullError as err:
            yield _sse("state", {"live": False, "state": "error",
                                 "error": {"message": str(err), "code": err.code}})
            return
        try:
            since, since_trade, idle, sent = 0, 0, 0.0, None
            yield "retry: 5000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                since_new, quote = hub.latest(sym, since)
                status = hub.status()
                state = {"live": hub.is_live(sym), "state": status["state"],
                         "error": hub.refusal(sym) or status["error"]}
                if state != sent:
                    sent = state
                    yield _sse("state", state)
                since_trade, printed = hub.trades(sym, since_trade)
                if printed:
                    idle = 0.0
                    yield _sse("trades", [t for t in map(_trade, printed) if t])
                if quote is not None:
                    since, idle = since_new, 0.0
                    yield _sse(None, _shape(sym, quote, depth, _category.get(sym) or "US_STOCK",
                                            overnight, endpoint="stream: quote"))
                else:
                    idle += _STREAM_TICK_S
                    if idle >= _STREAM_PING_S:
                        idle = 0.0
                        yield ": ping\n\n"
                await asyncio.sleep(_STREAM_TICK_S)
        finally:
            hub.release(sym)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
