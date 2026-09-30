"""request_latency: per-request queue / run / DB timing, and the local thread lane.

The bug this guards (2026-09-30): a 2 ms pins read waited 4.8 s for a worker
thread while 80 upstream-bound requests held all 40 of anyio's default tokens.
"""
import asyncio
import json
import threading
import time

import anyio
import anyio.to_thread
import httpx
import pytest
from fastapi import FastAPI

import request_latency as rl


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, tmp_path):
    rl.reset()
    monkeypatch.setattr(rl, "LOG_PATH", tmp_path / "latency.jsonl")
    monkeypatch.setattr(rl, "_local_limiter", None)
    rl.install()
    yield
    rl.reset()


def _app():
    app = FastAPI()
    gate = threading.Event()

    @app.get("/api/slow/{sym}")
    def slow(sym: str):          # sync: runs on the default thread pool
        gate.wait(5)
        return {"sym": sym}

    @app.get("/api/pins/assets")
    def pins():                  # sync, local lane
        return []

    @app.get("/api/fast")
    def fast():                  # sync, default lane
        return {}

    @app.get("/api/async")
    async def not_threaded():
        return {}

    app.add_middleware(rl.LatencyMiddleware)
    return app, gate


def _run(coro):
    return asyncio.run(coro)


def test_lane_for_matches_prefix_boundaries(monkeypatch):
    monkeypatch.setattr(rl, "LOCAL_LANE_ENABLED", True)
    assert rl.lane_for("/api/pins/assets") == "local"
    assert rl.lane_for("/api/pins") == "local"
    assert rl.lane_for("/api/pinsX") == "default"
    assert rl.lane_for("/api/v2/portfolio/summary") == "default"   # prices holdings: upstream-bound
    assert rl.lane_for("/api/stock/quote/AAPL") == "default"
    monkeypatch.setattr(rl, "LOCAL_LANE_ENABLED", False)
    assert rl.lane_for("/api/pins/assets") == "default"


def test_records_route_template_and_writes_slow_log_without_query(monkeypatch):
    monkeypatch.setattr(rl, "SLOW_MS", 0.0)
    app, gate = _app()
    gate.set()

    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/slow/AAPL?api_key=SECRET")
            assert r.status_code == 200
            snap = rl.snapshot()
        return snap

    snap = _run(go())
    routes = {r["route"] for r in snap["routes"]}
    assert "GET /api/slow/{sym}" in routes
    lines = rl.LOG_PATH.read_text().splitlines()
    rec = json.loads(lines[-1])
    assert rec["route"] == "GET /api/slow/{sym}" and rec["threads"] == 1
    assert "SECRET" not in rl.LOG_PATH.read_text() and "AAPL" not in rl.LOG_PATH.read_text()


def test_queue_wait_is_measured_and_local_lane_skips_the_queue(monkeypatch):
    """Default pool squeezed to 1 token and held by a blocked route: a default-lane
    route queues behind it; a local-lane route does not."""
    monkeypatch.setattr(rl, "LOCAL_LANE_ENABLED", True)
    monkeypatch.setattr(rl, "SLOW_MS", 0.0)
    app, gate = _app()

    async def go():
        anyio.to_thread.current_default_thread_limiter().total_tokens = 1
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            blocker = asyncio.create_task(c.get("/api/slow/X"))
            await asyncio.sleep(0.1)                       # blocker holds the only token
            t = time.perf_counter()
            r = await c.get("/api/pins/assets")
            local_s = time.perf_counter() - t
            assert r.status_code == 200
            fast = asyncio.create_task(c.get("/api/fast"))
            await asyncio.sleep(0.3)
            gate.set()
            await blocker
            await fast
        return local_s

    local_s = _run(go())
    assert local_s < 0.3
    recs = [json.loads(l) for l in rl.LOG_PATH.read_text().splitlines()]
    by = {r["route"]: r for r in recs}
    assert by["GET /api/pins/assets"]["lane"] == "local"
    assert by["GET /api/pins/assets"]["queue_ms"] < 100
    assert by["GET /api/fast"]["lane"] == "default"
    assert by["GET /api/fast"]["queue_ms"] >= 250          # waited for the blocker's token
    assert by["GET /api/fast"]["waiting_at_arrival"] == 0 and by["GET /api/fast"]["busy_at_arrival"] == 1


def test_async_route_uses_no_thread(monkeypatch):
    monkeypatch.setattr(rl, "SLOW_MS", 0.0)
    app, _ = _app()

    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            await c.get("/api/async")

    _run(go())
    rec = json.loads(rl.LOG_PATH.read_text().splitlines()[-1])
    assert rec["threads"] == 0 and rec["queue_ms"] == 0


def test_note_db_outside_a_request_keeps_long_background_holds():
    rl.note_db(0.001, 0.01, 0.0)          # short: ignored
    rl.note_db(0.001, 0.5, 0.2)           # a background writer holding the DB 500 ms
    rl.note_db(0.0, 0.0, 0.0, locked=True)
    snap = rl.snapshot()
    assert len(snap["background_db_holds"]) == 1
    assert snap["background_db_holds"][0]["held_ms"] == 500.0
    assert snap["counters"]["bg_db_locked"] == 1


def test_run_sync_outside_request_passes_through():
    async def go():
        return await anyio.to_thread.run_sync(lambda: 41 + 1)
    assert _run(go()) == 42
