"""Webull OpenAPI — order-book depth for US stocks and ETFs (MKT → STRUCTURE → DEPTH).

  GET  /api/webull/status          keys set? which host? token status — never a secret
  POST /api/webull/token           ask for an access token (production: texts a code to the owner)
  POST /api/webull/token/check     re-read the token's status from Webull
  GET  /api/webull/depth?symbol=AAPL&depth=10&overnight=false

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
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query

import webull_client as wb
from cache import TTLCache

router = APIRouter()

_DEPTH_PATH = "/market-data/stocks/depths/list"
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


def _shape(symbol: str, data, asked: int, category: str, overnight: bool) -> dict:
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
            "endpoint": _DEPTH_PATH,
            "environment": wb.environment(),
            "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
    }


@router.get("/api/webull/status")
def webull_status():
    try:
        token = wb.public_token(wb.load_token()) if wb.configured() else None
    except wb.WebullError:
        token = None
    return {"configured": wb.configured(), "host": wb.host(), "environment": wb.environment(),
            "token": token}


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
        reason = wb.explain(r)
        if r.status_code == 401:
            wb.mark_token("INVALID")
            last = (409, f"Webull refused the access token ({reason}) — request a new one", "token_missing")
            break
        if r.status_code == 403:
            last = (403, f"Not entitled ({reason}) — market data over OpenAPI needs its own subscription: "
                         "Webull → avatar → Advanced Quotes → OpenAPI Advanced Quotes", "subscription")
            break
        if r.status_code == 429:
            last = (429, "Webull rate limit (300 calls / 60 s) — slowing down", "rate_limit")
            break
        # 417 = business refusal: wrong category for this symbol is one of them.
        last = (r.status_code if r.status_code < 500 else 424,
                f"Webull {r.status_code}: {reason}", "upstream")

    status, message, code = last or (424, "Webull gave no answer", "upstream")
    detail = {"message": message, "code": code}
    if code != "token_missing":           # a new token must work at once, not after the cache
        _fail.set(key, {"status": status, "detail": detail})
    raise HTTPException(status, detail)
