"""Change feed (change_feed.py): DB triggers bump a per-table version on every
write, whoever writes — the frontend refetches on a moved version instead of
polling.

Does not use pytest's `tmp_path`: this box denies access to the system temp root.
"""

import shutil
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, ".")

TREND = {
    "kind": "trend",
    "symbol": "^DJI",
    "barInterval": "1d",
    "data": {"a": {"time": "2026-08-01", "price": 1.0}, "b": {"time": "2026-09-01", "price": 2.0}},
}


@pytest.fixture()
def env(monkeypatch):
    root = Path(__file__).parent / "_tmp"
    root.mkdir(exist_ok=True)
    scratch = Path(tempfile.mkdtemp(dir=root))
    try:
        import config
        import db

        monkeypatch.setattr(config, "DB_PATH", scratch / "test.db", raising=False)
        monkeypatch.setattr(db, "DB_PATH", scratch / "test.db", raising=False)
        monkeypatch.setenv("OPLOG_DEVICE_ID", "test-device")
        db.init_db()
        from routers import chart_drawings, changes

        chart_drawings.init_chart_drawings_schema()
        db.init_sync_layer()
        db.init_oplog_layer()
        import change_feed

        change_feed.init_change_feed()
        change_feed.init_change_feed()  # idempotent
        app = FastAPI()
        app.include_router(chart_drawings.router)
        app.include_router(changes.router)
        yield db, change_feed, TestClient(app)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def _v(client):
    return client.get("/api/changes").json()["tables"]["chart_drawings"]


def test_every_write_through_the_api_moves_the_version(env):
    _, _, client = env
    v0 = _v(client)
    client.put("/api/v2/chart-drawings/d1", json=TREND)
    v1 = _v(client)
    assert v1 > v0
    client.put("/api/v2/chart-drawings/d1", json={**TREND, "data": {**TREND["data"], "color": "#fff"}})
    v2 = _v(client)
    assert v2 > v1
    client.delete("/api/v2/chart-drawings/d1")
    assert _v(client) > v2


def test_reads_do_not_move_it(env):
    _, _, client = env
    client.put("/api/v2/chart-drawings/d1", json=TREND)
    v = _v(client)
    client.get("/api/v2/chart-drawings")
    assert _v(client) == v


def test_a_writer_that_bypasses_the_router_is_seen_too(env):
    """Sync apply, the MCP server and scripts write SQL directly."""
    db, change_feed, client = env
    v = _v(client)
    with db.get_db() as conn:
        conn.execute(
            "INSERT INTO chart_drawings (id, kind, symbol, bar_interval, data) VALUES (?,?,?,?,?)",
            ("raw1", "trend", "AAPL", "1d", "{}"),
        )
    assert change_feed.versions()["chart_drawings"] > v


def test_versions_lists_only_watched_tables(env):
    _, change_feed, _ = env
    assert set(change_feed.versions()) == set(change_feed.WATCHED)
