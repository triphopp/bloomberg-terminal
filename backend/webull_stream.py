"""Webull live order book — one MQTT session for the process, opened on demand.

    acquire(symbol, depth, overnight)   somebody is watching this book
    release(symbol)                     ...and stopped
    latest(symbol, since)               → (seq, quote) when it changed since `since`
    trades(symbol, since)               → (seq, [trade, ...]) printed since `since`
    status()                            what the hub is doing, for /api/webull/status

Webull pushes a book at most 3 times a second. The session exists only while a
panel is open: the first acquire starts the thread, and 20 s after the last
release it unsubscribes everything and hangs up (an account may hold the
Level 1 / Level 2 feed on one device, and at most 5 connections per app key).

What a session receives is set over HTTP, not by MQTT SUBSCRIBE, and is NOT
kept across a reconnect — so after every CONNACK the thread subscribes again
whatever is still wanted. It never asks for an access token (that sends an
SMS): without a working one it stops and says so.

Measured 2026-10-08 (production, Level 1): TLS + CONNACK in ~0.1 s, the first
quote ~0.5 s after the subscribe call, then ~2.6 messages a second for INTC.
"""

from __future__ import annotations

import logging
import re
import threading
import time
import uuid
from collections import deque

import config
import upstream_health
import webull_client as wb
import webull_wire as wire

logger = logging.getLogger(__name__)

PROD_HOST, TEST_HOST = "data-api.webull.co.th", "data-api.uat.webullbroker.com"
PORT = 1883                 # MQTT inside TLS, as the SDK connects
KEEPALIVE_S = 60
PING_S = 20
SILENT_S = 75               # nothing at all for this long, pings included → reconnect
IDLE_S = 20                 # no watcher for this long → hang up
STALE_S = 15                # a quote older than this is not "live"
BACKOFF_S = (2, 5, 15, 30)
MAX_SYMBOLS = 20            # books watched at once; a panel shows one
TAPE = 400                  # trades kept per symbol for a listener that joins late

_SUBSCRIBE = "/market-data/streaming/subscribe"
_UNSUBSCRIBE = "/market-data/streaming/unsubscribe"
_DEPTH_LIMIT = re.compile(r"depth not more than (\d+)", re.I)
_FATAL_CONNACK = {2, 3, 4, 5, 103, 104}     # retrying cannot help: bad id, bad key


def stream_host() -> str:
    custom = getattr(config, "WEBULL_STREAM_HOST", "")
    if custom:
        return custom
    return {"production": PROD_HOST, "test": TEST_HOST}.get(wb.environment(), "")


class DepthHub:
    def __init__(self):
        self._lock = threading.Lock()
        self._want: dict[str, dict] = {}        # symbol → {refs, depth, overnight}
        self._subscribed: dict[str, tuple] = {}  # symbol → (depth, overnight) as sent
        self._quotes: dict[str, dict] = {}       # symbol → {seq, at, quote}
        self._trades: dict[str, deque] = {}      # symbol → (seq, trade), oldest first
        # The free Level 1 feed carries time-and-sales, but an account without
        # it must still get its book: TICK is dropped after one refusal.
        self._ticks_ok = True
        self._seq = 0
        self._thread: threading.Thread | None = None
        self._idle_since: float | None = None
        self._cap: dict[bool, int] = {}          # overnight? → most levels the account gets
        self._refused: dict[str, dict] = {}      # symbol → {message, code, at}
        self.state = "idle"                      # idle · connecting · live · waiting · error
        self.error: dict | None = None
        self.connected_at: float | None = None
        self.messages = 0

    # ── interest ─────────────────────────────────────────────────────────────

    def acquire(self, symbol: str, depth: int, overnight: bool) -> None:
        with self._lock:
            entry = self._want.get(symbol)
            if entry is None:
                if len(self._want) >= MAX_SYMBOLS:
                    raise wb.WebullError(429, f"Already streaming {MAX_SYMBOLS} books", "rate_limit")
                entry = self._want[symbol] = {"refs": 0, "depth": depth, "overnight": overnight}
            entry["refs"] += 1
            entry["depth"], entry["overnight"] = depth, overnight
            self._refused.pop(symbol, None)
            self._idle_since = None
            if self._thread is None or not self._thread.is_alive():
                self.state, self.error = "connecting", None
                self._thread = threading.Thread(target=self._run, name="webull-depth-stream", daemon=True)
                self._thread.start()

    def release(self, symbol: str) -> None:
        with self._lock:
            entry = self._want.get(symbol)
            if entry is None:
                return
            entry["refs"] -= 1
            if entry["refs"] <= 0:
                del self._want[symbol]
            if not self._want:
                self._idle_since = time.time()

    def latest(self, symbol: str, since: int) -> tuple[int, dict | None]:
        with self._lock:
            held = self._quotes.get(symbol)
            # An old book is not handed to a new watcher as if it were now.
            if held and held["seq"] > since and time.time() - held["at"] < STALE_S:
                return held["seq"], held["quote"]
            return since, None

    def trades(self, symbol: str, since: int) -> tuple[int, list[dict]]:
        with self._lock:
            held = self._trades.get(symbol)
            if not held or held[-1][0] <= since:
                return since, []
            return held[-1][0], [t for seq, t in held if seq > since]

    def refusal(self, symbol: str) -> dict | None:
        with self._lock:
            return self._refused.get(symbol)

    def is_live(self, symbol: str) -> bool:
        with self._lock:
            held = self._quotes.get(symbol)
            return self.state == "live" and bool(held) and time.time() - held["at"] < STALE_S

    def status(self) -> dict:
        with self._lock:
            return {
                "state": self.state,
                "error": self.error,
                "symbols": sorted(self._want),
                "subscribed": sorted(self._subscribed),
                "messages": self.messages,
                "connected_for_s": round(time.time() - self.connected_at) if self.connected_at else None,
            }

    # ── the session ──────────────────────────────────────────────────────────

    def _run(self) -> None:
        attempt = 0
        while True:
            try:
                stop = self._session()
            except wb.WebullError as err:                 # no token, no keys: not ours to fix
                self._finish("error", {"message": str(err), "code": err.code})
                return
            except Exception as exc:                      # network, TLS, a bad packet
                upstream_health.record(stream_host(), "timeout" if isinstance(exc, TimeoutError)
                                       else "connection", target="mqtt")
                logger.warning("webull stream dropped: %s", exc.__class__.__name__)
                stop = None
            with self._lock:
                self._subscribed.clear()                  # not kept across a reconnect
                self.connected_at = None
                if not self._want:
                    self.state, self._thread = "idle", None
                    return
                # Hung up as idle while a new watcher arrived: straight back, no wait.
                self.state = "connecting" if stop else "waiting"
            if stop:
                attempt = 0
                continue
            time.sleep(BACKOFF_S[min(attempt, len(BACKOFF_S) - 1)])
            attempt += 1

    def _finish(self, state: str, error: dict | None) -> None:
        with self._lock:
            self.state, self.error = state, error
            self._subscribed.clear()
            self.connected_at = None
            self._thread = None

    def _session(self) -> bool:
        """One connection, until it is no longer needed (True) or it breaks (raises)."""
        host = stream_host()
        if not host:
            raise wb.WebullError(424, "No stream host for this WEBULL_API_HOST — set WEBULL_STREAM_HOST", "keys")
        token = wb.active_token()                         # raises: never requests one
        session_id = uuid.uuid4().hex
        started = time.time()
        sock = wire.MqttSocket(host, PORT)
        try:
            sock.send(wire.connect_packet(session_id, config.WEBULL_APP_KEY, uuid.uuid4().hex, KEEPALIVE_S))
            ack = sock.read(10)
            code = ack[2][1] if ack and ack[0] == wire.CONNACK and len(ack[2]) >= 2 else -1
            if code != 0:
                reason = wire.CONNACK_REASONS.get(code, f"code {code}")
                upstream_health.record(host, "auth" if code in _FATAL_CONNACK else "connection", target="mqtt")
                if code in _FATAL_CONNACK:
                    raise wb.WebullError(424, f"Webull stream refused the connection: {reason}", "upstream")
                if code == 105:
                    time.sleep(60)                        # the server holds a closed session ~1 min
                raise ConnectionError(reason)
            upstream_health.record(host, None, target="mqtt", elapsed=time.time() - started)
            with self._lock:
                self.state, self.error, self.connected_at = "live", None, time.time()

            last_in = last_ping = time.time()
            while True:
                if self._sync(session_id, token):
                    return True                           # idle: hung up on purpose
                got = sock.read(0.5)
                now = time.time()
                if got:
                    last_in = now
                    kind, flags, body = got
                    if kind == wire.PUBLISH:
                        topic, payload, packet_id = wire.parse_publish(flags, body)
                        if packet_id is not None:
                            sock.send(wire.packet(wire.PUBACK, packet_id.to_bytes(2, "big")))
                        if topic == "quote":
                            self._store(payload)
                        elif topic == "tick":
                            self._store_trade(payload)
                elif now - last_in > SILENT_S:
                    raise TimeoutError("stream went silent")
                if now - last_ping > PING_S:
                    sock.send(wire.packet(wire.PINGREQ))
                    last_ping = now
        finally:
            sock.close()

    def _store(self, payload: bytes) -> None:
        try:
            quote = wire.decode_quote(payload)
        except (ValueError, IndexError):
            return
        symbol = quote.get("symbol")
        with self._lock:
            self.messages += 1
            if symbol in self._want:
                self._seq += 1
                self._quotes[symbol] = {"seq": self._seq, "at": time.time(), "quote": quote}

    def _store_trade(self, payload: bytes) -> None:
        try:
            trade = wire.decode_tick(payload)
        except (ValueError, IndexError):
            return
        symbol = trade.get("symbol")
        with self._lock:
            self.messages += 1
            if symbol in self._want:
                self._seq += 1
                self._trades.setdefault(symbol, deque(maxlen=TAPE)).append((self._seq, trade))

    # ── subscriptions follow interest ────────────────────────────────────────

    def _sync(self, session_id: str, token: str) -> bool:
        """Make what Webull sends match what is watched. True = nobody is, hang up."""
        with self._lock:
            want = {s: (min(e["depth"], self._cap.get(e["overnight"], e["depth"])), e["overnight"])
                    for s, e in self._want.items() if s not in self._refused}
            have = dict(self._subscribed)
            idle_for = time.time() - self._idle_since if self._idle_since else 0
        for symbol in [s for s in have if have[s] != want.get(s)]:
            self._call(_UNSUBSCRIBE, {"session_id": session_id, "symbols": [symbol],
                                      "category": "US_STOCK", "sub_types": ["QUOTE", "TICK"]}, token)
            with self._lock:
                self._subscribed.pop(symbol, None)
                self._quotes.pop(symbol, None)
                self._trades.pop(symbol, None)
        for symbol, (depth, overnight) in want.items():
            if have.get(symbol) == (depth, overnight):
                continue
            body = {"session_id": session_id, "symbols": [symbol], "category": "US_STOCK",
                    "sub_types": ["QUOTE", "TICK"] if self._ticks_ok else ["QUOTE"], "depth": depth}
            if overnight:
                body["overnight_required"] = True
            r = self._call(_SUBSCRIBE, body, token)
            if (not r.ok and self._ticks_ok and r.status_code in (403, 417)
                    and not _DEPTH_LIMIT.search(r.text or "")):
                alone = self._call(_SUBSCRIBE, {**body, "sub_types": ["QUOTE"]}, token)
                if alone.ok:                            # it was the trades that were refused
                    self._ticks_ok = False              # the book alone, from now on
                    r = alone
            if r.ok:
                with self._lock:
                    self._subscribed[symbol] = (depth, overnight)
                continue
            reason = wb.explain(r)
            limit = _DEPTH_LIMIT.search(r.text or "")
            with self._lock:
                if r.status_code == 417 and limit:
                    self._cap[overnight] = int(limit.group(1))      # asked again next turn
                else:
                    code = ("token_missing" if r.status_code == 401 else
                            "subscription" if r.status_code == 403 else "upstream")
                    self._refused[symbol] = {"message": f"Webull stream {r.status_code}: {reason}",
                                             "code": code, "at": time.time()}
            if r.status_code == 401:
                wb.mark_token("INVALID", reason)
                raise wb.WebullError(409, "The Webull access token is no longer accepted (a token lasts "
                                          "15 days) — request a new one", "token_missing")
        return not want and not self._want and idle_for > IDLE_S

    @staticmethod
    def _call(path: str, body: dict, token: str):
        return wb.call("POST", path, body=body, token=token)


hub = DepthHub()
