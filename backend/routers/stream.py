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

  `event: coverage` — {"live": N, "denied": [symbols], "connected": bool} —
  sent when it changes. Denied symbols got no stream slot (budget full); their
  REST poll is all there is. `connected` false = Yahoo socket down: nothing is
  live whatever `live` says. The frontend slows its REST poll only while
  connected and not denied. A client listening only to `message` never sees it.

  `&session=<id>` (2026-09-28, stream_sessions.py): the page keeps this ONE
  stream and changes its symbols with POST /api/stream/interest (diff only — no
  reopen, no re-subscribe of what it already holds). A reconnect within 30 s
  resumes the session with the symbols it had, whatever the URL says; newly
  added symbols (and all of them after a reconnect) get the hub's last cached
  tick on the next frame.

POST /api/stream/interest {session, symbols, focus?, mounted?} → {ok, symbols};
  404 = unknown/expired session → the client reopens the stream.

GET /api/stream/status → hub state (shards, budget, denied, last message age)
  + `sessions` {sessions, attached, grace_s}.

Symbols are Yahoo symbols (what yfinance takes). The browser reconnects on its
own if the stream drops — EventSource does that natively.
"""

from __future__ import annotations

import asyncio
import json
import uuid

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import quote_stream
from stream_sessions import SessionRegistry, valid_id

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


sessions = SessionRegistry(quote_stream.acquire, quote_stream.release)


@router.get("/api/stream/quotes")
async def stream_quotes(
    request: Request,
    symbols: str = Query(""),
    focus: str = Query(""),
    mounted: str = Query(""),
    session: str = Query(""),
):
    """`session` (8–64 chars [A-Za-z0-9-]) makes the stream resumable and
    updatable by `POST /api/stream/interest`; without it the stream is bound to
    the URL's symbols and released when it closes (the old behaviour)."""
    by_tier = _parse(focus, symbols, mounted)
    named = valid_id(session)
    sid = session if named else uuid.uuid4().hex
    if not named and not any(by_tier):
        async def empty():
            yield ": no symbols\n\n"
        return StreamingResponse(empty(), media_type="text/event-stream")

    async def gen():
        # Attach inside the generator: a response that is never iterated (client
        # gone before the first byte) never runs `finally`, and would leak refs.
        attached = sessions.attach(sid, by_tier)
        if attached is None:
            yield _sse("error", {"detail": "Too many stream sessions"})
            return
        resumed = attached.resumed
        try:
            since = 0
            idle = 0.0
            sent_cov = None
            yield "retry: 3000\n\n"
            # The session exists from here on: interest updates sent before
            # this (headers arrive first) could 404, so clients wait for it.
            # `resumed`: the session kept the interest it had before this
            # connection, not this URL's — the client must resend its set.
            yield _sse("ready", {"session": sid if named else None, "resumed": resumed})
            while True:
                if await request.is_disconnected():
                    break
                syms = sessions.symbols(sid)
                live, denied = quote_stream.coverage(syms)
                up = quote_stream.connected()
                cov = (len(live), tuple(denied), up, len(syms))
                # Only once the allocator has seen every symbol of this client —
                # before that, "not live" means "not placed yet", not "denied".
                if cov != sent_cov and len(live) + len(denied) == len(syms):
                    sent_cov = cov
                    yield _sse("coverage", {"live": len(live), "denied": denied, "connected": up})
                since_new, ticks = quote_stream.snapshot(syms, since)
                # Snapshot for symbols this session just started watching (or
                # all of them after a reconnect): Yahoo sends nothing on
                # subscribe, so the hub's last tick is the only price to show.
                fresh = sessions.take_snapshot_symbols(sid)
                if fresh:
                    _, snap = quote_stream.snapshot(fresh, 0)
                    ticks = {**snap, **ticks}
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
            if named:
                sessions.detach(sid)
                # Resumable for grace_s; reaped after, whatever else happens.
                asyncio.get_running_loop().call_later(sessions.grace_s + 1, sessions.reap)
            else:
                sessions.drop(sid)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class InterestIn(BaseModel):
    session: str = Field(min_length=8, max_length=64)
    symbols: list[str] = Field(default_factory=list)
    focus: list[str] = Field(default_factory=list)
    mounted: list[str] = Field(default_factory=list)


@router.post("/api/stream/interest")
def stream_interest(body: InterestIn):
    """Replace what a session watches — only the difference is subscribed or
    released, the SSE pipe stays open. 404 = unknown/expired session: the
    client reopens its stream (which creates the session again)."""
    if not valid_id(body.session):
        raise HTTPException(422, "Invalid session id")
    by_tier = _parse(",".join(body.focus), ",".join(body.symbols), ",".join(body.mounted))
    s = sessions.update(body.session, by_tier)
    if s is None:
        raise HTTPException(404, "Unknown stream session")
    return {"ok": True, "symbols": len(s.tiers)}


@router.get("/api/stream/status")
def stream_status():
    return {**quote_stream.status(), "sessions": sessions.stats()}
