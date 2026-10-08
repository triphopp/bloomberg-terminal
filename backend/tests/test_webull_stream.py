"""Webull live book (webull_wire.py + webull_stream.py).

No test reaches Webull: the socket and the HTTP calls are replaced. What is
held: the bytes sent and read are MQTT 3.1.1 and the SDK's proto3; what Webull
sends follows who is watching, and is asked for again after a reconnect; the
session hangs up when nobody watches; and the stream never requests a token.
"""
import importlib
import struct
import time

import pytest

import webull_wire as wire


# ── wire ─────────────────────────────────────────────────────────────────────

def _pb(number: int, raw: bytes) -> bytes:
    return bytes([(number << 3) | 2]) + wire._varlen(len(raw)) + raw


def _quote(symbol="INTC", bid=("109.33", "191"), ask=("109.34", "185"), ts="1791473782156", orders=()):
    def level(price, size):
        out = _pb(1, price.encode()) + _pb(2, size.encode())
        for mpid, n in orders:
            out += _pb(3, _pb(1, mpid.encode()) + _pb(2, n.encode()))
        return out
    basic = _pb(1, symbol.encode()) + _pb(2, b"913257268") + _pb(3, ts.encode()) + _pb(4, b"RTH")
    return _pb(1, basic) + _pb(2, level(*ask)) + _pb(3, level(*bid))


def _publish(topic: str, payload: bytes, qos: int = 0, packet_id: int = 7) -> bytes:
    body = struct.pack("!H", len(topic)) + topic.encode()
    if qos:
        body += struct.pack("!H", packet_id)
    return wire.packet(wire.PUBLISH, body + payload, flags=qos << 1)


def test_connect_packet_is_mqtt_311_with_user_and_password():
    p = wire.connect_packet("sess", "appkey", "pw", 60)
    assert p[0] == 0x10 and p[1] == len(p) - 2
    assert p[2:8] == b"\x00\x04MQTT" and p[8] == 4          # protocol name, level 4
    assert p[9] == 0xC2                                       # user + password + clean session
    assert p[10:12] == b"\x00\x3c"                            # keepalive 60
    assert p[12:] == b"\x00\x04sess\x00\x06appkey\x00\x02pw"


def test_remaining_length_is_variable_width():
    assert wire._varlen(0) == b"\x00" and wire._varlen(127) == b"\x7f"
    assert wire._varlen(128) == b"\x80\x01" and wire._varlen(16_383) == b"\xff\x7f"
    assert wire._varlen(16_384) == b"\x80\x80\x01"


def test_publish_is_read_with_and_without_a_packet_id():
    assert wire.parse_publish(0, _publish("quote", b"abc")[2:]) == ("quote", b"abc", None)
    assert wire.parse_publish(2, _publish("quote", b"abc", qos=1)[2:]) == ("quote", b"abc", 7)


def test_quote_payload_decodes_to_the_depth_shape():
    q = wire.decode_quote(_quote(orders=(("NSDQ", "100"), ("ARCA", "91"))))
    assert q["symbol"] == "INTC" and q["quote_time"] == "1791473782156" and q["trading_session"] == "RTH"
    assert q["bids"] == [{"price": "109.33", "size": "191",
                          "order": [{"mpid": "NSDQ", "size": "100"}, {"mpid": "ARCA", "size": "91"}]}]
    assert q["asks"][0]["price"] == "109.34"


def test_unknown_fields_are_skipped_and_a_cut_payload_is_an_error():
    extra = _quote() + bytes([(9 << 3) | 0, 0x96, 0x01]) + _pb(12, b"later addition")
    assert wire.decode_quote(extra)["symbol"] == "INTC"
    with pytest.raises((ValueError, IndexError)):
        wire.decode_quote(_quote()[:-3])


class _Pipe:
    """A socket that hands out what it is given, a few bytes at a time."""

    def __init__(self, data: bytes, chunk: int = 5):
        self.data, self.chunk, self.sent = bytearray(data), chunk, b""

    def settimeout(self, _):
        pass

    def recv(self, _):
        if not self.data:
            raise TimeoutError
        out = bytes(self.data[:self.chunk])
        del self.data[:self.chunk]
        return out

    def sendall(self, data):
        self.sent += data

    def close(self):
        pass


def test_packets_are_reassembled_from_a_fragmented_stream():
    big = _publish("quote", b"x" * 300)                      # two-byte remaining length
    s = wire.MqttSocket.__new__(wire.MqttSocket)
    s.sock, s._buf = _Pipe(wire.packet(wire.CONNACK, b"\x00\x00") + big + wire.packet(wire.PINGRESP)), bytearray()
    assert s.read(1) == (wire.CONNACK, 0, b"\x00\x00")
    kind, flags, body = s.read(1)
    assert kind == wire.PUBLISH and wire.parse_publish(flags, body) == ("quote", b"x" * 300, None)
    assert s.read(1) == (wire.PINGRESP, 0, b"")
    assert s.read(1) is None                                  # nothing more: a quiet second, not an error


# ── hub ──────────────────────────────────────────────────────────────────────

class _Reply:
    def __init__(self, status=200, body=""):
        self.status_code, self.text, self.ok = status, body, status < 400

    def json(self):
        import json
        return json.loads(self.text)


class _Sock:
    """Stands in for MqttSocket: a queue of packets, then silence (or a break)."""

    made: list = []

    def __init__(self, host, port, **_):
        self.host, self.sent, self.closed = host, [], False
        self.inbox = [(wire.CONNACK, 0, b"\x00\x00")]
        self.broken = False
        _Sock.made.append(self)

    def send(self, data):
        self.sent.append(data)

    def read(self, timeout):
        if self.inbox:
            return self.inbox.pop(0)
        if self.broken:
            raise ConnectionError("dropped")
        time.sleep(0.01)
        return None

    def close(self):
        self.closed = True


@pytest.fixture()
def hub(monkeypatch):
    monkeypatch.setenv("WEBULL_APP_KEY", "k" * 32)
    monkeypatch.setenv("WEBULL_APP_SECRET", "s" * 32)
    monkeypatch.delenv("WEBULL_API_HOST", raising=False)
    import config
    importlib.reload(config)
    import webull_client
    importlib.reload(webull_client)
    import webull_stream as ws
    importlib.reload(ws)

    calls, replies = [], {}

    def call(method, path, query=None, body=None, token=None, timeout=10):
        calls.append((path.rsplit("/", 1)[1], dict(body)))
        queued = replies.get(path.rsplit("/", 1)[1])
        return queued.pop(0) if queued else _Reply()

    _Sock.made = []
    monkeypatch.setattr(ws.wire, "MqttSocket", _Sock)
    monkeypatch.setattr(ws.wb, "call", call)
    monkeypatch.setattr(ws.wb, "active_token", lambda: "tok")
    monkeypatch.setattr(ws.upstream_health, "record", lambda *a, **k: None)
    monkeypatch.setattr(ws, "IDLE_S", 0.15)
    monkeypatch.setattr(ws, "BACKOFF_S", (0.01,))
    h = ws.DepthHub()
    yield type("Ctx", (), {"hub": h, "ws": ws, "calls": calls, "replies": replies})
    # The session thread must be gone before the next test patches the same
    # module: left running, its unsubscribe would land in that test's calls.
    with h._lock:
        h._want.clear()
        h._idle_since = 1.0
    thread = h._thread
    if thread is not None:
        thread.join(3)
        assert not thread.is_alive()
    monkeypatch.undo()
    importlib.reload(config)


def _until(cond, seconds=3.0):
    end = time.time() + seconds
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.01)
    return False


def _push(sock, payload: bytes):
    sock.inbox.append((wire.PUBLISH, 0, _publish("quote", payload)[2:]))


def test_watching_subscribes_and_a_pushed_book_is_served_once(hub):
    hub.hub.acquire("INTC", 1, False)
    assert _until(lambda: hub.calls)
    assert hub.calls[0] == ("subscribe", {"session_id": hub.calls[0][1]["session_id"], "symbols": ["INTC"],
                                          "category": "US_STOCK", "sub_types": ["QUOTE", "TICK"], "depth": 1})
    sock = _Sock.made[0]
    assert sock.host == "data-api.webull.co.th"
    assert sock.sent[0][0] == 0x10 and b"k" * 32 in sock.sent[0] and b"s" * 32 not in sock.sent[0]
    _push(sock, _quote())
    assert _until(lambda: hub.hub.latest("INTC", 0)[1] is not None)
    seq, quote = hub.hub.latest("INTC", 0)
    assert quote["bids"][0]["price"] == "109.33" and hub.hub.is_live("INTC")
    assert hub.hub.latest("INTC", seq) == (seq, None)         # nothing new since
    _push(sock, _quote(symbol="MSFT"))                        # not watched: counted, not kept
    assert _until(lambda: hub.hub.status()["messages"] == 2)
    assert hub.hub.latest("MSFT", 0)[1] is None
    hub.hub.release("INTC")


def test_last_watcher_gone_unsubscribes_then_hangs_up(hub):
    hub.hub.acquire("INTC", 1, False)
    hub.hub.acquire("INTC", 1, False)                         # a second panel on the same book
    assert _until(lambda: hub.hub.status()["subscribed"] == ["INTC"])
    hub.hub.release("INTC")
    time.sleep(0.3)
    assert hub.hub.status()["state"] == "live" and len(hub.calls) == 1   # one watcher left
    hub.hub.release("INTC")
    assert _until(lambda: hub.hub.status()["state"] == "idle")
    assert [c[0] for c in hub.calls] == ["subscribe", "unsubscribe"]
    assert _Sock.made[0].closed and len(_Sock.made) == 1


def test_a_dropped_connection_is_reopened_and_subscribed_again(hub):
    hub.hub.acquire("INTC", 1, False)
    assert _until(lambda: hub.hub.status()["subscribed"] == ["INTC"])
    _Sock.made[0].broken = True
    assert _until(lambda: len(_Sock.made) == 2 and hub.hub.status()["subscribed"] == ["INTC"])
    subs = [c for c in hub.calls if c[0] == "subscribe"]
    assert len(subs) == 2 and subs[0][1]["session_id"] != subs[1][1]["session_id"]
    hub.hub.release("INTC")


def test_depth_beyond_the_entitlement_is_learned(hub):
    hub.replies["subscribe"] = [_Reply(417, '{"error_code":"ILLEGAL_PARAMETER","message":"depth not more than 1"}')]
    hub.hub.acquire("INTC", 10, False)
    assert _until(lambda: hub.hub.status()["subscribed"] == ["INTC"])
    assert [c[1]["depth"] for c in hub.calls] == [10, 1]
    assert hub.hub.refusal("INTC") is None
    hub.hub.release("INTC")


def test_a_refused_symbol_is_reported_and_not_asked_again(hub):
    no = '{"error_code":"MARKET_DATA_NOT_SUBSCRIBED","message":"no permission"}'
    hub.replies["subscribe"] = [_Reply(403, no), _Reply(403, no)]   # with trades, then the book alone
    hub.hub.acquire("INTC", 1, True)
    assert _until(lambda: hub.hub.refusal("INTC") is not None)
    assert hub.hub.refusal("INTC")["code"] == "subscription" and hub.calls[0][1]["overnight_required"] is True
    time.sleep(0.2)
    assert [c[1]["sub_types"] for c in hub.calls] == [["QUOTE", "TICK"], ["QUOTE"]]
    assert hub.hub._ticks_ok                                  # not the trades' fault: still asked for next time
    hub.hub.release("INTC")


def test_without_a_working_token_the_stream_stops_and_requests_nothing(hub, monkeypatch):
    def no_token():
        raise hub.ws.wb.WebullError(409, "No active Webull access token — request one", "token_missing")
    monkeypatch.setattr(hub.ws.wb, "active_token", no_token)
    hub.hub.acquire("INTC", 1, False)
    assert _until(lambda: hub.hub.status()["state"] == "error")
    assert hub.hub.status()["error"]["code"] == "token_missing"
    assert hub.calls == [] and _Sock.made == []               # no connection, no SMS
    hub.hub.release("INTC")


def test_trades_are_kept_in_order_and_handed_out_once(hub):
    hub.hub.acquire("INTC", 1, False)
    assert _until(lambda: hub.hub.status()["subscribed"] == ["INTC"])
    sock = _Sock.made[0]
    for price, size, side, ms in (("109.25", "200", "B", "1791474258792"), ("109.24", "395", "S", "1791474258935")):
        basic = _pb(1, b"INTC") + _pb(2, b"913257268") + _pb(3, b"1791474259000") + _pb(4, b"RTH")
        tick = (_pb(1, basic) + _pb(2, b"11:44:18") + _pb(3, price.encode()) + _pb(4, size.encode())
                + _pb(5, side.encode()) + _pb(6, ms.encode()))
        sock.inbox.append((wire.PUBLISH, 0, _publish("tick", tick)[2:]))
    assert _until(lambda: len(hub.hub.trades("INTC", 0)[1]) == 2)
    seq, trades = hub.hub.trades("INTC", 0)
    assert [(t["price"], t["volume"], t["side"], t["time"]) for t in trades] == [
        ("109.25", "200", "B", "1791474258792"), ("109.24", "395", "S", "1791474258935")]
    assert hub.hub.trades("INTC", seq) == (seq, [])
    hub.hub.release("INTC")


def test_an_account_without_trades_still_gets_its_book(hub):
    hub.replies["subscribe"] = [_Reply(403, '{"error_code":"MARKET_DATA_NOT_SUBSCRIBED","message":"TICK"}')]
    hub.hub.acquire("INTC", 1, False)
    assert _until(lambda: hub.hub.status()["subscribed"] == ["INTC"])
    assert [c[1]["sub_types"] for c in hub.calls] == [["QUOTE", "TICK"], ["QUOTE"]]
    assert hub.hub.refusal("INTC") is None and hub.hub._ticks_ok is False
    hub.hub.release("INTC")
