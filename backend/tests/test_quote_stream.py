"""quote_stream: direct protobuf decode and shard placement.

Decode must give exactly what the MessageToDict path gave (the frontend keys
off those numbers); placement must never put more than SHARD_CAP symbols on one
Yahoo connection, which serves only its first 100 and silently drops the rest.
"""
import asyncio
import base64
import json
import random
import struct

import pytest
from google.protobuf.json_format import MessageToDict
from yfinance.pricing_pb2 import PricingData

import quote_stream as qs


def _frame(**fields) -> str:
    p = PricingData(**fields)
    return json.dumps({"type": "pricing", "message": base64.b64encode(p.SerializeToString()).decode()})


def _old_decode(raw: str):
    """The pre-2026-09-26 path: MessageToDict, then quote_stream._on_message."""
    p = PricingData()
    p.ParseFromString(base64.b64decode(json.loads(raw).get("message", "")))
    m = MessageToDict(p, preserving_proto_field_name=True)
    sym, price = m.get("id"), m.get("price")
    if not sym or price is None or m.get("market_hours") != 1:
        return None
    return (sym, float(price), m.get("change"), m.get("change_percent"), int(m.get("time") or 0))


def _f32(x: float) -> float:
    return struct.unpack("f", struct.pack("f", x))[0]


def test_decode_matches_messagetodict_on_random_ticks():
    rng = random.Random(7)
    for _ in range(3000):
        fields = dict(
            id=rng.choice(["AAPL", "BTC-USD", "PTT.BK", "^GSPC", "EURUSD=X"]),
            price=_f32(rng.choice([rng.uniform(1e-4, 1), rng.uniform(1, 1e5)])),
            change=rng.choice([0.0, _f32(rng.uniform(-50, 50))]),
            change_percent=rng.choice([0.0, _f32(rng.uniform(-9, 9))]),
            time=rng.randint(1_700_000_000_000, 1_800_000_000_000),
            market_hours=rng.choice([0, 1, 1, 1, 2]),
        )
        raw = _frame(**fields)
        assert qs._decode(raw) == _old_decode(raw), fields


def test_decode_float32_is_shortest_repr():
    t = qs._decode(_frame(id="ENA-USD", price=0.26961, change=0.049059987, change_percent=22.244383,
                          time=1, market_hours=1))
    assert t[1] == 0.26961  # raw float32 field reads 0.2696099877357483
    assert t[2] == 0.049059987


def test_decode_zero_change_is_none_so_frontend_derives_it():
    t = qs._decode(_frame(id="USDT-USD", price=0.99977, time=1, market_hours=1))
    assert t[2] is None and t[3] is None


@pytest.mark.parametrize("raw", [
    _frame(id="AAPL", price=1.0, market_hours=0),          # pre-market
    _frame(id="AAPL", price=1.0, market_hours=2),          # post-market
    _frame(price=1.0, market_hours=1),                     # no symbol
    _frame(id="AAPL", market_hours=1),                     # no price
    "not json", json.dumps({"type": "pricing"}), json.dumps({"message": "@@@"}),
    json.dumps({"message": base64.b64encode(b"\xff\xff\xff").decode()}),
])
def test_decode_rejects(raw):
    assert qs._decode(raw) is None


# ── placement ────────────────────────────────────────────────────────────────

def _syms(a, b):
    return {f"S{i:04d}" for i in range(a, b)}


def test_plan_spills_into_new_shards_at_cap():
    remove, add, overflow = qs._plan([], _syms(0, 250), 90)
    assert remove == [] and add == []
    assert len(overflow) == 250  # caller cuts it into 90/90/70


def test_plan_fills_free_slots_before_new_shards_and_never_moves():
    shards = [_syms(0, 90), _syms(90, 150)]
    wanted = (_syms(0, 150) - _syms(0, 10)) | _syms(500, 545)
    remove, add, overflow = qs._plan(shards, wanted, 90)
    assert remove == [_syms(0, 10), set()]
    assert len(add[0]) == 10 and len(add[1]) == 30  # shard 0 got its freed slots back
    assert len(overflow) == 5
    for s, r, a in zip(shards, remove, add):
        assert len((s - r) | a) <= 90
        assert not (a & set().union(*shards))  # nothing already placed is re-added


# ── reconcile, with sockets faked ────────────────────────────────────────────

class _FakeWS:
    def __init__(self):
        self.sent = []

    async def send(self, s):
        self.sent.append(json.loads(s))


@pytest.fixture
def hub(monkeypatch):
    async def fake_run(sh):
        sh.ws = _FakeWS()
        await asyncio.Event().wait()

    monkeypatch.setattr(qs, "_run_shard", fake_run)
    monkeypatch.setattr(qs, "_ensure_thread", lambda: None)
    monkeypatch.setattr(qs, "_poke", lambda: None)
    for name, val in [("_refs", {}), ("_seq", {}), ("_shards", []),
                      ("_live", frozenset()), ("_considered", frozenset())]:
        monkeypatch.setattr(qs, name, val)
    return qs


def _sorted(s):
    return sorted(s)


def test_reconcile_shards_acquire_and_release(hub):
    async def go():
        hub.acquire(_sorted(_syms(0, 200)))
        await hub._reconcile()
        await asyncio.sleep(0)
        assert [len(sh.symbols) for sh in hub._shards] == [90, 90, 20]
        assert set().union(*[sh.symbols for sh in hub._shards]) == _syms(0, 200)

        # drop the whole middle shard and 5 from the first; add 3 new ones
        hub.release(_sorted(_syms(90, 180) | _syms(0, 5)))
        hub.acquire(_sorted(_syms(900, 903)))
        first = hub._shards[0]
        await hub._reconcile()
        assert len(hub._shards) == 2  # emptied shard closed
        assert first.symbols == _syms(5, 90) | _syms(900, 903)
        assert {"unsubscribe": _sorted(_syms(0, 5))} in first.ws.sent
        assert {"subscribe": _sorted(_syms(900, 903))} in first.ws.sent
        assert all(len(sh.symbols) <= hub.SHARD_CAP for sh in hub._shards)

        hub.release(_sorted(_syms(0, 90) | _syms(180, 200) | _syms(900, 903)))
        await hub._reconcile()
        assert hub._shards == [] and hub._refs == {}

    asyncio.run(go())


# ── budget + tiers ───────────────────────────────────────────────────────────

def test_allocate_under_budget_takes_everything():
    d = {s: (2, i) for i, s in enumerate(_syms(0, 50))}
    assert qs._allocate(d, set(), 50) == set(d)


def test_allocate_tier_first_then_held_then_age():
    d = {"F": (0, 9), "V_OLD": (1, 1), "V_HELD": (1, 5), "V_NEW": (1, 7), "M_HELD": (2, 0)}
    assert qs._allocate(d, {"V_HELD", "M_HELD"}, 3) == {"F", "V_HELD", "V_OLD"}
    # a same-tier newcomer never evicts a streaming symbol
    assert qs._allocate(d, {"V_HELD", "V_NEW", "M_HELD"}, 3) == {"F", "V_HELD", "V_NEW"}


def test_budget_full_focus_evicts_mounted_on_the_same_socket(hub, monkeypatch):
    monkeypatch.setattr(hub, "MAX_SYMBOLS", 100)

    async def go():
        hub.acquire(_sorted(_syms(0, 60)), hub.VISIBLE)
        hub.acquire(_sorted(_syms(60, 100)), hub.MOUNTED)
        await hub._reconcile()
        await asyncio.sleep(0)
        assert len(hub._shards) == 2 and hub.coverage(["S0099"]) == (["S0099"], [])

        loser_shard = next(sh for sh in hub._shards if "S0099" in sh.symbols)
        hub.acquire(["S0500"], hub.VISIBLE)  # beats the newest MOUNTED
        await hub._reconcile()
        assert hub.coverage(["S0500", "S0099"]) == (["S0500"], ["S0099"])
        assert "S0500" in loser_shard.symbols and len(hub._shards) == 2  # slot reused, no new socket
        assert {"unsubscribe": ["S0099"]} in loser_shard.ws.sent

        hub.acquire(["S0600"], hub.MOUNTED)  # ties the lowest held tier → a streaming symbol keeps its slot
        await hub._reconcile()
        assert hub.coverage(["S0600"]) == ([], ["S0600"])

        hub.acquire(["S0700"], hub.FOCUS)  # evicts the next-newest MOUNTED
        await hub._reconcile()
        assert hub.coverage(["S0700", "S0098"]) == (["S0700"], ["S0098"])

        hub.release(["S0700"], hub.FOCUS)  # slot frees → oldest denied MOUNTED gets it back
        await hub._reconcile()
        assert hub.coverage(["S0098", "S0099", "S0600"]) == (["S0098"], ["S0099", "S0600"])
        assert hub.status()["live"] == 100

    asyncio.run(go())


def test_tier_is_best_of_all_clients(hub):
    hub.acquire(["X"], hub.MOUNTED)
    hub.acquire(["X"], hub.FOCUS)
    assert hub._tier(hub._refs["X"]) == hub.FOCUS
    hub.release(["X"], hub.FOCUS)
    assert hub._tier(hub._refs["X"]) == hub.MOUNTED
    hub.release(["X"], hub.MOUNTED)
    assert "X" not in hub._refs
    hub.release(["X"], hub.MOUNTED)  # extra release is a no-op


def test_coverage_is_silent_until_allocated(hub):
    hub.acquire(["NEW"])
    assert hub.coverage(["NEW"]) == ([], [])  # not placed yet ≠ denied


def test_router_parse_tiers_dedupe_and_budget(monkeypatch):
    from routers import stream
    monkeypatch.setattr(qs, "MAX_SYMBOLS", 4)
    assert stream._parse("aapl,msft", "MSFT,nvda,tsla", "x,y") == [["AAPL", "MSFT"], ["NVDA", "TSLA"], []]


def test_on_frame_updates_latest_and_snapshot():
    qs._on_frame(_frame(id="ZZTEST", price=12.5, change=0.5, change_percent=4.0, time=42, market_hours=1))
    v, out = qs.snapshot(["ZZTEST"], 0)
    assert out["ZZTEST"] == {"price": 12.5, "change": 0.5, "change_pct": 4.0, "ts": 42}
    assert qs.snapshot(["ZZTEST"], v)[1] == {}
