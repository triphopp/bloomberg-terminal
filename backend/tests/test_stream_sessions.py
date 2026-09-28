"""Stream sessions: interest changes by diff, resumable reconnects, reaping."""
from collections import Counter

import pytest

from stream_sessions import SessionRegistry, valid_id


class Hub:
    """Records acquire/release like quote_stream's ref counts."""

    def __init__(self):
        self.refs: Counter = Counter()
        self.log: list[tuple[str, tuple[str, ...], int]] = []

    def acquire(self, syms, tier):
        self.log.append(("acq", tuple(syms), tier))
        for s in syms:
            self.refs[(s, tier)] += 1

    def release(self, syms, tier):
        self.log.append(("rel", tuple(syms), tier))
        for s in syms:
            self.refs[(s, tier)] -= 1
            assert self.refs[(s, tier)] >= 0, f"double release {s}@{tier}"

    def held(self):
        return {k for k, v in self.refs.items() if v > 0}


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


@pytest.fixture
def reg():
    hub, clock = Hub(), Clock()
    r = SessionRegistry(hub.acquire, hub.release, grace_s=30, clock=clock)
    r.hub, r.clk = hub, clock
    return r


SID = "page-0001"


def test_valid_id():
    assert valid_id("abcdef12")
    assert valid_id("0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b")
    for bad in (None, "", "short", "has space here", "x" * 65, "semi;colon!"):
        assert not valid_id(bad)


def test_update_only_touches_the_difference(reg):
    reg.attach(SID, [[], ["A", "B", "C"], []])
    reg.hub.log.clear()
    reg.update(SID, [[], ["B", "C", "D"], []])
    assert reg.hub.log == [("acq", ("D",), 1), ("rel", ("A",), 1)]
    assert reg.hub.held() == {("B", 1), ("C", 1), ("D", 1)}


def test_tier_move_acquires_before_releasing(reg):
    reg.attach(SID, [[], ["A"], []])
    reg.hub.log.clear()
    reg.update(SID, [["A"], [], []])  # promoted to focus
    assert reg.hub.log == [("acq", ("A",), 0), ("rel", ("A",), 1)]
    assert reg.hub.held() == {("A", 0)}


def test_duplicate_symbol_keeps_best_tier(reg):
    reg.attach(SID, [["A"], ["A", "B"], ["B"]])
    assert reg.hub.held() == {("A", 0), ("B", 1)}


def test_reconnect_resumes_session_and_ignores_stale_url(reg):
    reg.attach(SID, [[], ["A"], []])
    reg.update(SID, [[], ["A", "B"], []])
    reg.detach(SID)
    reg.clk.t = 10
    reg.hub.log.clear()
    s = reg.attach(SID, [[], ["A"], []])  # EventSource reconnects with its original URL
    assert reg.hub.log == []  # nothing re-subscribed
    assert s.symbols() == ["A", "B"]
    assert reg.take_snapshot_symbols(SID) == ["A", "B"]  # everything re-sent after a reconnect
    assert reg.take_snapshot_symbols(SID) == []


def test_new_symbols_get_a_snapshot_removed_ones_do_not(reg):
    reg.attach(SID, [[], ["A"], []])
    reg.take_snapshot_symbols(SID)
    reg.update(SID, [[], ["A", "B", "C"], []])
    reg.update(SID, [[], ["A", "B"], []])
    assert reg.take_snapshot_symbols(SID) == ["B"]


def test_detached_session_is_reaped_after_grace_and_releases_everything(reg):
    reg.attach(SID, [["F"], ["A"], ["M"]])
    reg.detach(SID)
    reg.clk.t = 29
    assert reg.reap() == 0
    reg.clk.t = 30
    assert reg.reap() == 1
    assert reg.hub.held() == set()
    assert reg.update(SID, [[], ["A"], []]) is None  # → client reopens


def test_overlapping_connections_keep_the_session_attached(reg):
    reg.attach(SID, [[], ["A"], []])
    reg.attach(SID, [[], ["A"], []])  # reconnect raced the old stream's close
    reg.detach(SID)
    reg.clk.t = 100
    assert reg.reap() == 0
    assert reg.hub.held() == {("A", 1)}  # refs taken once, not per connection


def test_drop_releases_now(reg):
    reg.attach(SID, [[], ["A", "B"], []])
    reg.drop(SID)
    assert reg.hub.held() == set()
    reg.drop(SID)  # idempotent


def test_registry_cap(reg):
    reg.max_sessions = 2
    assert reg.attach("sess-0001", [[], ["A"], []])
    assert reg.attach("sess-0002", [[], ["A"], []])
    assert reg.attach("sess-0003", [[], ["A"], []]) is None
    assert reg.hub.refs[("A", 1)] == 2


def test_interest_endpoint_404_for_unknown_session_and_diff_for_known(monkeypatch):
    from fastapi.testclient import TestClient
    from fastapi import FastAPI

    import routers.stream as st

    hub = Hub()
    monkeypatch.setattr(st, "sessions", SessionRegistry(hub.acquire, hub.release))
    app = FastAPI()
    app.include_router(st.router)
    c = TestClient(app)
    r = c.post("/api/stream/interest", json={"session": "nope-0001", "symbols": ["A"]})
    assert r.status_code == 404
    st.sessions.attach("page-0002", [[], ["A"], []])
    r = c.post("/api/stream/interest", json={"session": "page-0002", "symbols": ["a", "B"], "focus": ["B"]})
    assert r.status_code == 200 and r.json()["symbols"] == 2
    assert hub.held() == {("A", 1), ("B", 0)}
    bad = c.post("/api/stream/interest", json={"session": "bad id!!", "symbols": []})
    assert bad.status_code == 422


def test_resumed_flag_tells_the_client_to_resend(reg):
    s = reg.attach(SID, [[], ["A", "B"], []])
    assert s.resumed is False
    reg.detach(SID)
    s = reg.attach(SID, [[], ["A", "C"], []])  # tab came back with a different set
    assert s.resumed is True
    assert s.symbols() == ["A", "B"]  # kept its own until the client resends
