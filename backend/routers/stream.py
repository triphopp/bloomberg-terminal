"""Live quotes over Server-Sent Events.

GET /api/stream/quotes?symbols=AAPL,BTC-USD,PTT.BK[&focus=…][&mounted=…]
  → text/event-stream, one `data:` line per second at most:
    {"AAPL": {"price": 231.4, "change": 1.2, "change_pct": 0.52, "ts": 1790...}, ...}
  Only symbols that ticked since the previous message are included; the first
  message carries whatever is already cached. A `: ping` comment every 15s
  keeps proxies from closing an idle stream (weekend, closed market).

  Priority (quote_stream tiers): `focus` = must stay live (open chart, held
  position), `symbols` = on screen, `mounted` = out of view, first to lose a
  slot when the process budget is full. A symbol in two lists keeps the best.

  `event: coverage` — {"live": N, "denied": [symbols]} — sent when it changes.
  Denied symbols got no stream slot (budget full); their REST poll is all
  there is. A client listening only to `message` never sees this event.

GET /api/stream/status → hub state (shards, budget, denied, last message age).

Symbols are Yahoo symbols (what yfinance takes). The browser reconnects on its
own if the stream drops — EventSource does that natively.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

import quote_stream

router = APIRouter()

_TICK_S = 1.0
_PING_S = 15.0


def _parse(*lists: str) -> list[list[str]]:
    """One list per tier, best first. A symbol keeps the best tier it is given;
    the total is capped at the process budget, in the order the client sent."""
    seen: set[str] = set()
    out: list[list[str]] = []
    room = quote_stream.MAX_SYMBOLS
    for raw in lists:
        tier: list[str] = []
        for s in raw.split(","):
            s = s.strip().upper()
            if s and len(s) <= 24 and s not in seen and room > 0:
                seen.add(s)
                tier.append(s)
                room -= 1
        out.append(tier)
    return out


def _sse(event: str | None, payload: object) -> str:
    head = f"event: {event}\n" if event else ""
    return f"{head}data: {json.dumps(payload, separators=(',', ':'))}\n\n"


@router.get("/api/stream/quotes")
async def stream_quotes(
    request: Request,
    symbols: str = Query(""),
    focus: str = Query(""),
    mounted: str = Query(""),
):
    by_tier = _parse(focus, symbols, mounted)
    syms = [s for group in by_tier for s in group]

    async def gen():
        if not syms:
            yield ": no symbols\n\n"
            return
        for tier, group in zip(quote_stream.TIERS, by_tier):
            quote_stream.acquire(group, tier)
        try:
            since = 0
            idle = 0.0
            sent_cov = None
            yield "retry: 3000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                live, denied = quote_stream.coverage(syms)
                cov = (len(live), tuple(denied))
                # Only once the allocator has seen every symbol of this client —
                # before that, "not live" means "not placed yet", not "denied".
                if cov != sent_cov and len(live) + len(denied) == len(syms):
                    sent_cov = cov
                    yield _sse("coverage", {"live": len(live), "denied": denied})
                since_new, ticks = quote_stream.snapshot(syms, since)
                since = since_new
                if ticks:
                    idle = 0.0
                    yield _sse(None, ticks)
                else:
                    idle += _TICK_S
                    if idle >= _PING_S:
                        idle = 0.0
                        yield ": ping\n\n"
                await asyncio.sleep(_TICK_S)
        finally:
            for tier, group in zip(quote_stream.TIERS, by_tier):
                quote_stream.release(group, tier)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/api/stream/status")
def stream_status():
    return quote_stream.status()
