"""Webull market-data stream — the two wire formats, and nothing else.

Webull pushes quotes over MQTT 3.1.1 inside TLS (port 1883) with protobuf
payloads. What this app needs from each is small, so both are read here rather
than through `paho-mqtt` and `protobuf` — two dependencies less to install on
every machine, for a client that only ever listens:

  MQTT      CONNECT, CONNACK, PUBLISH (in), PUBACK, PINGREQ, PINGRESP, DISCONNECT.
            No SUBSCRIBE: what a session receives is set over HTTP
            (/market-data/streaming/subscribe), keyed on the MQTT client id.
  protobuf  proto3 where every field is a string or a nested message
            (Quote / AskBid / Order / Tick / Basic — the SDK's message.proto).

Pure functions and one small socket class; the tests feed it bytes.
"""

from __future__ import annotations

import socket
import ssl
import struct

# ── MQTT ─────────────────────────────────────────────────────────────────────

CONNECT, CONNACK, PUBLISH, PUBACK, PINGREQ, PINGRESP, DISCONNECT = 1, 2, 3, 4, 12, 13, 14

# Webull's own CONNACK codes above the standard five (docs: data-streaming-api).
CONNACK_REASONS = {
    0: "accepted", 1: "unacceptable protocol version", 2: "invalid client id", 3: "app key is empty",
    4: "bad user name or password", 5: "not authorized", 7: "connection lost", 16: "heartbeat timeout",
    100: "unknown error", 101: "internal error", 102: "already authenticated", 103: "authentication failed",
    104: "invalid app key", 105: "more than 5 connections for this app key — wait a minute",
}


def _str(value: str) -> bytes:
    raw = value.encode("utf-8")
    return struct.pack("!H", len(raw)) + raw


def _varlen(n: int) -> bytes:
    out = bytearray()
    while True:
        n, digit = divmod(n, 128)
        out.append(digit | (0x80 if n else 0))
        if not n:
            return bytes(out)


def packet(kind: int, body: bytes = b"", flags: int = 0) -> bytes:
    return bytes([(kind << 4) | flags]) + _varlen(len(body)) + body


def connect_packet(client_id: str, username: str, password: str, keepalive: int) -> bytes:
    # protocol "MQTT" level 4; flags: user name + password + clean session.
    body = _str("MQTT") + bytes([4, 0xC2]) + struct.pack("!H", keepalive)
    return packet(CONNECT, body + _str(client_id) + _str(username) + _str(password))


def parse_publish(flags: int, body: bytes) -> tuple[str, bytes, int | None]:
    """→ (topic, payload, packet id when the sender wants an acknowledgement)."""
    n = struct.unpack("!H", body[:2])[0]
    topic = body[2:2 + n].decode("utf-8", "replace")
    at = 2 + n
    packet_id = None
    if (flags >> 1) & 0x03:                       # QoS 1 or 2 carries an id
        packet_id = struct.unpack("!H", body[at:at + 2])[0]
        at += 2
    return topic, body[at:], packet_id


class MqttSocket:
    """A connected, TLS-wrapped MQTT session that can only listen."""

    def __init__(self, host: str, port: int, timeout: float = 10.0, tls: bool = True):
        raw = socket.create_connection((host, port), timeout=timeout)
        self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host) if tls else raw
        self._buf = bytearray()

    def send(self, data: bytes) -> None:
        self.sock.sendall(data)

    def _need(self, n: int) -> bytes | None:
        """n bytes, or None when the read timed out with nothing consumed."""
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("closed by the server")
            self._buf += chunk
        out = bytes(self._buf[:n])
        del self._buf[:n]
        return out

    def read(self, timeout: float) -> tuple[int, int, bytes] | None:
        """One packet → (type, flags, body); None when nothing arrived in `timeout`."""
        self.sock.settimeout(timeout)
        try:
            if not self._buf:
                chunk = self.sock.recv(65536)
                if not chunk:
                    raise ConnectionError("closed by the server")
                self._buf += chunk
        except (socket.timeout, TimeoutError):
            return None
        except ssl.SSLWantReadError:
            return None
        # A packet has started: finish it even if the rest takes a moment.
        self.sock.settimeout(max(timeout, 10.0))
        head = self._need(1)[0]
        length, shift = 0, 0
        while True:
            digit = self._need(1)[0]
            length |= (digit & 0x7F) << shift
            if not digit & 0x80:
                break
            shift += 7
            if shift > 21:
                raise ConnectionError("malformed MQTT length")
        return head >> 4, head & 0x0F, self._need(length) if length else b""

    def close(self) -> None:
        try:
            self.sock.sendall(packet(DISCONNECT))
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


# ── protobuf (strings and nested messages only) ──────────────────────────────

def _fields(data: bytes):
    """Yield (field number, value bytes) for the length-delimited fields; skip the rest."""
    at, end = 0, len(data)
    while at < end:
        key, shift = 0, 0
        while True:
            byte = data[at]
            at += 1
            key |= (byte & 0x7F) << shift
            if not byte & 0x80:
                break
            shift += 7
        number, wire = key >> 3, key & 7
        if wire == 2:
            size, shift = 0, 0
            while True:
                byte = data[at]
                at += 1
                size |= (byte & 0x7F) << shift
                if not byte & 0x80:
                    break
                shift += 7
            if at + size > end:
                raise ValueError("truncated protobuf field")
            yield number, data[at:at + size]
            at += size
        elif wire == 0:
            while data[at] & 0x80:
                at += 1
            at += 1
        elif wire == 1:
            at += 8
        elif wire == 5:
            at += 4
        else:
            raise ValueError(f"unsupported protobuf wire type {wire}")


def _text(raw: bytes) -> str:
    return raw.decode("utf-8", "replace")


def _level(data: bytes) -> dict:
    level: dict = {"price": None, "size": None, "order": []}
    for number, raw in _fields(data):
        if number == 1:
            level["price"] = _text(raw)
        elif number == 2:
            level["size"] = _text(raw)
        elif number == 3:
            order = {n: _text(v) for n, v in _fields(raw)}
            level["order"].append({"mpid": order.get(1), "size": order.get(2)})
    return level


def decode_quote(payload: bytes) -> dict:
    """A `quote` payload in the shape of the HTTP depth answer:
    {symbol, instrument_id, quote_time, trading_session, asks: [...], bids: [...]}."""
    out: dict = {"symbol": None, "instrument_id": None, "quote_time": None,
                 "trading_session": None, "asks": [], "bids": []}
    for number, raw in _fields(payload):
        if number == 1:
            basic = {n: _text(v) for n, v in _fields(raw)}
            out["symbol"] = basic.get(1)
            out["instrument_id"] = basic.get(2)
            out["quote_time"] = basic.get(3)
            out["trading_session"] = basic.get(4)
        elif number == 2:
            out["asks"].append(_level(raw))
        elif number == 3:
            out["bids"].append(_level(raw))
    return out


def decode_tick(payload: bytes) -> dict:
    """A `tick` payload: one trade. Field 6 is not in the published proto — it is
    the trade's own time in ms (the Basic timestamp is when it was sent)."""
    out: dict = {"symbol": None, "time": None, "price": None, "volume": None, "side": None,
                 "trading_session": None}
    sent = None
    for number, raw in _fields(payload):
        if number == 1:
            basic = {n: _text(v) for n, v in _fields(raw)}
            out["symbol"], sent, out["trading_session"] = basic.get(1), basic.get(3), basic.get(4)
        elif number == 3:
            out["price"] = _text(raw)
        elif number == 4:
            out["volume"] = _text(raw)
        elif number == 5:
            out["side"] = _text(raw)
        elif number == 6:
            out["time"] = _text(raw)
    out["time"] = out["time"] or sent
    return out
