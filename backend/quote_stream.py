"""Live quote hub — Yahoo streaming connections shared by the whole process.

Yahoo's pricing WebSocket (the one finance.yahoo.com itself uses) pushes a
message per symbol as it trades: every few seconds for crypto, per trade for US
equities. No key, no REST calls — the 200 calls/min the REST pollers already
make are left alone.

Limits measured 2026-09-26 (memory/sessions/reports/yf-websocket-limits-report.md):
  * A connection serves the first 100 unique symbols it subscribes, first-come,
    across messages. #101+ get nothing — no error, no close. Unsubscribing frees
    a slot, but an overflowed symbol is never promoted. Invalid symbols take a
    slot too.
  * No per-IP cap seen up to 400 connections / 833 msg/s.
  * Subscriptions do not expire; a socket without pings was dropped at ~56 min.

Shape:
  * Symbols are sharded, at most SHARD_CAP per connection. Each shard owns one
    socket and its own reconnect loop, and resubscribes its whole set on every
    connect.
  * All sockets live on one asyncio loop in a daemon thread of its own — never
    uvicorn's loop, where a blocking endpoint would stall the stream and a
    long-lived socket hangs `--reload`. `yfinance.AsyncWebSocket` is not used:
    its reconnect does not resubscribe, and it decodes through MessageToDict.
  * Subscriptions are ref-counted across SSE clients. acquire/release only
    change `_refs` and wake the loop; `_reconcile` (loop thread only) diffs the
    wanted set against the shard map. The wake coalesces, so a burst of
    acquire/release costs one pass and nothing can be applied out of order.
  * One budget for the process (config.QUOTE_STREAM_MAX_SYMBOLS). Every
    symbol a client asks for carries a tier — FOCUS (a chart, a held position),
    VISIBLE (default) or MOUNTED — and a symbol's tier is the best any client
    gave it. Under budget everything streams. Over it, `_allocate` keeps the
    best tier first, and within a tier what already streams keeps its slot:
    a newcomer only takes a slot from a strictly lower tier. The loser is
    unsubscribed and the winner subscribed on the same socket — no new one.
    A denied symbol is not silent: `coverage()` says so, and the SSE route
    tells the client, whose REST poll keeps that row current.
  * Ticks land in `_latest` with a version counter. SSE clients read it on
    their own clock (routers/stream.py), so the sockets never block on a slow
    browser and a burst of trades collapses into one message per second.
    There is deliberately no tick queue: a price is latest-wins.

Only regular-session ticks (`market_hours == 1`) are kept. Pre/post prices are
a different number — PORT shows them in its own PRE/POST column from
/premarket — and folding them into the regular price would move P&L on a
print the regular session has not made.

Unofficial endpoint: if Yahoo changes it the stream goes quiet and every panel
keeps working off its REST poll, exactly as before the stream existed.
Connection state goes to upstream_health as source "Yahoo stream".
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import threading
import time
from typing import Any

from google.protobuf.internal.type_checkers import ToShortestFloat
from google.protobuf.message import DecodeError
from yfinance.pricing_pb2 import PricingData

import upstream_health
from config import QUOTE_STREAM_MAX_SYMBOLS

log = logging.getLogger(__name__)

SOURCE = "Yahoo stream"
URL = "wss://streamer.finance.yahoo.com/?version=2"
SHARD_CAP = 90  # Yahoo serves 100 per connection; the rest is headroom
MAX_SYMBOLS = QUOTE_STREAM_MAX_SYMBOLS
_BACKOFF_MAX_S = 60
_PING_S = 20

# Tiers, best first. What a client does not say is VISIBLE.
FOCUS, VISIBLE, MOUNTED = 0, 1, 2
TIERS = (FOCUS, VISIBLE, MOUNTED)

_lock = threading.Lock()
_refs: dict[str, list[int]] = {}  # symbol -> client count per tier
_seq: dict[str, int] = {}  # symbol -> order it was first wanted (older wins a tie)
_seq_next = 0
_live: frozenset[str] = frozenset()  # symbols given a slot by the last _reconcile
_considered: frozenset[str] = frozenset()  # symbols the last _reconcile allocated over
_latest: dict[str, dict[str, Any]] = {}
_version = 0
_last_msg_at: float | None = None

_thread: threading.Thread | None = None
_loop: asyncio.AbstractEventLoop | None = None
_wake: asyncio.Event | None = None
_shards: list["_Shard"] = []  # loop thread writes; status() reads a copy


def _wanted() -> list[str]:
    return sorted(_refs)


def _tier(counts: list[int]) -> int:
    return next(t for t in TIERS if counts[t] > 0)


def _allocate(demand: dict[str, tuple[int, int]], held: set[str], budget: int) -> set[str]:
    """Symbols that get a slot. demand = {symbol: (tier, seq)}.

    Best tier first; within a tier a symbol already streaming beats a new one
    (no churn when a client reopens with the same set), then the older ask.
    """
    if len(demand) <= budget:
        return set(demand)
    order = sorted(demand, key=lambda s: (demand[s][0], s not in held, demand[s][1]))
    return set(order[:budget])


# ── Decode ───────────────────────────────────────────────────────────────────
# Read fields straight off the protobuf. MessageToDict was 37 of the 38 µs a
# tick cost; this is ~6 µs. Two things MessageToDict did that must be kept:
#   * price/change are float32 — the raw field reads 0.2696099877…, the tick
#     must say 0.26961 (ToShortestFloat; '%.7g' is wrong for ~half of float32s).
#   * proto3 has no field presence, so 0 also means "not sent". Change 0 goes
#     out as None and live-quotes.ts derives it from the previous close.

_pb = PricingData()  # reused; only the loop thread decodes


def _decode(raw: str | bytes) -> tuple[str, float, float | None, float | None, int] | None:
    """(symbol, price, change, change_pct, ts_ms) for a regular-session tick, else None."""
    try:
        _pb.ParseFromString(base64.b64decode(json.loads(raw)["message"]))
    except (ValueError, KeyError, TypeError, binascii.Error, DecodeError):
        return None
    if _pb.market_hours != 1 or not _pb.id or not _pb.price:
        return None
    ch, pct = _pb.change, _pb.change_percent
    return (
        _pb.id,
        ToShortestFloat(_pb.price),
        ToShortestFloat(ch) if ch else None,
        ToShortestFloat(pct) if pct else None,
        _pb.time,
    )


def _on_frame(raw: str | bytes) -> None:
    global _version, _last_msg_at
    _last_msg_at = time.time()
    t = _decode(raw)
    if t is None:
        return
    sym, price, change, pct, ts = t
    with _lock:
        _version += 1
        _latest[sym] = {"price": price, "change": change, "change_pct": pct, "ts": ts, "v": _version}


# ── Shards ───────────────────────────────────────────────────────────────────


class _Shard:
    __slots__ = ("id", "symbols", "ws", "task", "closed")

    def __init__(self, sid: int) -> None:
        self.id = sid
        self.symbols: set[str] = set()
        self.ws: Any = None
        self.task: asyncio.Task | None = None
        self.closed = False


_next_id = 0


async def _send(sh: _Shard, verb: str, symbols: list[str]) -> None:
    ws = sh.ws
    if ws is None or not symbols:
        return  # not connected: the connect path subscribes the whole set
    try:
        await ws.send(json.dumps({verb: symbols}))
    except Exception:  # noqa: BLE001 — the read loop sees the drop and reconnects
        pass


async def _run_shard(sh: _Shard) -> None:
    """Connect → subscribe the shard's set → read, until the shard is closed."""
    from websockets.asyncio.client import connect

    backoff = 2
    while not sh.closed:
        try:
            async with connect(URL, ping_interval=_PING_S, ping_timeout=_PING_S,
                               open_timeout=15, max_size=2**20) as ws:
                sh.ws = ws
                if sh.symbols:
                    await ws.send(json.dumps({"subscribe": sorted(sh.symbols)}))
                upstream_health.record(SOURCE, None, target="connect")
                backoff = 2
                async for raw in ws:
                    _on_frame(raw)
            if not sh.closed:
                upstream_health.record(SOURCE, "connection", target="listen")
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — any failure means reconnect
            upstream_health.record(SOURCE, upstream_health.classify_exception(exc), target="connect")
            log.warning("quote stream shard %d dropped: %s", sh.id, upstream_health.redact(str(exc)))
        finally:
            sh.ws = None
        if sh.closed:
            break
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, _BACKOFF_MAX_S)


def _plan(shards: list[set[str]], wanted: set[str], cap: int) -> tuple[list[set[str]], list[set[str]], list[str]]:
    """Pure placement. Returns (remove per shard, add per shard, overflow for new shards).

    Symbols stay on the shard they are on; new ones fill free slots in order,
    then spill into new shards. Nothing is moved — moving a symbol means a gap
    in its ticks, and a half-empty shard costs one idle socket.
    """
    remove = [s - wanted for s in shards]
    placed = set().union(*shards) & wanted if shards else set()
    new = sorted(wanted - placed)
    add: list[set[str]] = []
    for s, r in zip(shards, remove):
        free = cap - (len(s) - len(r))
        take, new = new[:max(free, 0)], new[max(free, 0):]
        add.append(set(take))
    return remove, add, new


async def _reconcile() -> None:
    global _next_id, _live, _considered
    held = set().union(*[sh.symbols for sh in _shards]) if _shards else set()
    with _lock:
        demand = {s: (_tier(c), _seq[s]) for s, c in _refs.items()}
    wanted = _allocate(demand, held, MAX_SYMBOLS)
    with _lock:
        _live, _considered = frozenset(wanted), frozenset(demand)
    remove, add, overflow = _plan([sh.symbols for sh in _shards], wanted, SHARD_CAP)
    for sh, r, a in zip(list(_shards), remove, add):
        if r:
            sh.symbols -= r
            await _send(sh, "unsubscribe", sorted(r))
        if a:
            sh.symbols |= a
            await _send(sh, "subscribe", sorted(a))
    for i in range(0, len(overflow), SHARD_CAP):
        sh = _Shard(_next_id)
        _next_id += 1
        sh.symbols = set(overflow[i:i + SHARD_CAP])
        sh.task = asyncio.create_task(_run_shard(sh), name=f"quote-shard-{sh.id}")
        _shards.append(sh)
    for sh in [s for s in _shards if not s.symbols]:
        sh.closed = True
        _shards.remove(sh)
        if sh.task:
            sh.task.cancel()


async def _main() -> None:
    global _loop, _wake
    _loop = asyncio.get_running_loop()
    _wake = asyncio.Event()
    _wake.set()  # first pass picks up whatever was acquired before the loop existed
    while True:
        await _wake.wait()
        _wake.clear()
        try:
            await _reconcile()
        except Exception:  # noqa: BLE001 — keep the loop; next wake retries
            log.exception("quote stream reconcile failed")


def _ensure_thread() -> None:
    global _thread
    with _lock:
        if _thread is not None and _thread.is_alive():
            return
        _thread = threading.Thread(target=lambda: asyncio.run(_main()), name="quote-stream", daemon=True)
        _thread.start()


def _poke() -> None:
    loop, wake = _loop, _wake
    if loop is not None and wake is not None:
        try:
            loop.call_soon_threadsafe(wake.set)
        except RuntimeError:  # loop closed (interpreter shutdown)
            pass


# ── Public API (routers/stream.py) ───────────────────────────────────────────


def acquire(symbols: list[str], tier: int = VISIBLE) -> None:
    """A client started watching these symbols at this tier."""
    global _seq_next
    changed = False
    with _lock:
        for s in symbols:
            c = _refs.get(s)
            if c is None:
                c = _refs[s] = [0, 0, 0]
                _seq[s] = _seq_next
                _seq_next += 1
                changed = True
            elif tier < _tier(c):
                changed = True  # promoted: may now win a slot
            c[tier] += 1
    _ensure_thread()
    if changed:
        _poke()


def release(symbols: list[str], tier: int = VISIBLE) -> None:
    """A client stopped watching these symbols (same tier it acquired them at)."""
    changed = False
    with _lock:
        for s in symbols:
            c = _refs.get(s)
            if c is None or c[tier] <= 0:
                continue
            before = _tier(c)
            c[tier] -= 1
            if not any(c):
                del _refs[s]
                _seq.pop(s, None)
                changed = True
            elif _tier(c) != before:
                changed = True  # demoted: may lose its slot
    if changed:
        _poke()


def coverage(symbols: list[str]) -> tuple[list[str], list[str]]:
    """(live, denied): which of these hold a stream slot and which were refused one.

    A symbol not yet placed (the loop has not run since it was acquired) is in
    neither list.
    """
    with _lock:
        live, seen = _live, _considered
    return [s for s in symbols if s in live], [s for s in symbols if s in seen and s not in live]


def snapshot(symbols: list[str], since: int = 0) -> tuple[int, dict[str, dict[str, Any]]]:
    """Ticks for `symbols` newer than version `since`, and the current version."""
    with _lock:
        out = {
            s: {k: v for k, v in q.items() if k != "v"}
            for s in symbols
            if (q := _latest.get(s)) is not None and q["v"] > since
        }
        return _version, out


def status() -> dict[str, Any]:
    shards = [{"id": sh.id, "symbols": len(sh.symbols), "connected": sh.ws is not None} for sh in list(_shards)]
    with _lock:
        return {
            "connected": bool(shards) and all(s["connected"] for s in shards),
            "symbols": _wanted(),
            "live": len(_live),
            "denied": sorted((_considered - _live) & set(_refs)),
            "max_symbols": MAX_SYMBOLS,
            "shards": shards,
            "shard_cap": SHARD_CAP,
            "last_message_age_s": None if _last_msg_at is None else round(time.time() - _last_msg_at, 1),
            "cached": len(_latest),
        }
