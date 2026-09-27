"""
Chart drawings (routers/chart_drawings.py): CRUD + sync participation.

Does not use pytest's `tmp_path`: this box denies access to the system temp root.

Run:
    cd backend
    python -m pytest tests/test_chart_drawings.py -v
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
    "data": {
        "a": {"time": "2026-08-01", "price": 50000.5},
        "b": {"time": "2026-09-01", "price": 52000.25},
        "color": "#4fc3f7",
    },
}


@pytest.fixture()
def env(monkeypatch):
    root = Path(__file__).parent / "_tmp"
    root.mkdir(exist_ok=True)
    scratch = Path(tempfile.mkdtemp(dir=root))
    try:
        import config

        monkeypatch.setattr(config, "DB_PATH", scratch / "test.db", raising=False)
        import db

        monkeypatch.setattr(db, "DB_PATH", scratch / "test.db", raising=False)
        monkeypatch.setenv("OPLOG_DEVICE_ID", "test-device")
        db.init_db()
        from routers import chart_drawings

        chart_drawings.init_chart_drawings_schema()
        db.init_sync_layer()
        db.init_oplog_layer()
        app = FastAPI()
        app.include_router(chart_drawings.router)
        yield db, TestClient(app)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def test_put_creates_then_edits_in_place(env):
    db, client = env
    r = client.put("/api/v2/chart-drawings/d1", json=TREND)
    assert r.status_code == 200
    assert r.json()["data"]["a"]["price"] == 50000.5

    edited = {**TREND, "data": {**TREND["data"], "color": "#fff"}}
    assert client.put("/api/v2/chart-drawings/d1", json=edited).status_code == 200

    rows = client.get("/api/v2/chart-drawings").json()["drawings"]
    assert len(rows) == 1
    assert rows[0]["data"]["color"] == "#fff"
    assert rows[0]["barInterval"] == "1d"
    # An edit is an UPDATE, not delete+insert — no tombstone for a live row.
    with db.get_db() as conn:
        n = conn.execute(
            "SELECT COUNT(*) FROM sync_tombstones WHERE table_name='chart_drawings'"
        ).fetchone()[0]
    assert n == 0


def test_symbol_filter_and_delete(env):
    _, client = env
    client.put("/api/v2/chart-drawings/d1", json=TREND)
    client.put("/api/v2/chart-drawings/d2", json={**TREND, "symbol": "AAPL"})
    assert [d["id"] for d in client.get("/api/v2/chart-drawings?symbol=AAPL").json()["drawings"]] == ["d2"]

    assert client.delete("/api/v2/chart-drawings/d1").json() == {"deleted": 1}
    assert [d["id"] for d in client.get("/api/v2/chart-drawings").json()["drawings"]] == ["d2"]


def test_bad_kind_rejected(env):
    _, client = env
    assert client.put("/api/v2/chart-drawings/x", json={**TREND, "kind": "circle"}).status_code == 422


def test_import_is_insert_if_absent(env):
    _, client = env
    client.put("/api/v2/chart-drawings/d1", json=TREND)
    moved = {**TREND, "data": {**TREND["data"], "color": "#000"}}
    body = {"drawings": [{"id": "d1", **moved}, {"id": "d2", **TREND}]}
    assert client.post("/api/v2/chart-drawings/import", json=body).json() == {
        "imported": 1,
        "received": 2,
    }
    # Retry is a no-op, and the existing row was not overwritten.
    assert client.post("/api/v2/chart-drawings/import", json=body).json()["imported"] == 0
    rows = {d["id"]: d for d in client.get("/api/v2/chart-drawings").json()["drawings"]}
    assert rows["d1"]["data"]["color"] == "#4fc3f7"


def test_registered_for_sync():
    from sync.config import TABLE_PK
    from sync.gate import is_synced_write, should_gate

    assert TABLE_PK["chart_drawings"] == ["id"]
    assert is_synced_write("/api/v2/chart-drawings/abc")
    # Reads fine before the startup pull — not worth blocking the chart on.
    assert should_gate("/api/v2/chart-drawings", done=False) is False


def test_sync_machinery_landed(env):
    """updated_at stamped, delete leaves a tombstone, op-log captures the change."""
    db, client = env
    client.put("/api/v2/chart-drawings/d1", json=TREND)
    with db.get_db() as conn:
        assert conn.execute("SELECT updated_at FROM chart_drawings WHERE id='d1'").fetchone()[0]
        pending = conn.execute(
            "SELECT COUNT(*) FROM sync_pending WHERE table_name='chart_drawings'"
        ).fetchone()[0]
    assert pending == 1

    client.delete("/api/v2/chart-drawings/d1")
    with db.get_db() as conn:
        tomb = conn.execute(
            "SELECT row_id FROM sync_tombstones WHERE table_name='chart_drawings'"
        ).fetchall()
    assert [t[0] for t in tomb] == ["d1"]


def test_snapshot_export_includes_the_table(env):
    db, client = env
    client.put("/api/v2/chart-drawings/d1", json=TREND)
    from sync.snapshot import export_snapshot

    with db.get_db() as conn:
        payload = export_snapshot(conn, device="test-device")
    assert [r["id"] for r in payload["tables"]["chart_drawings"]] == ["d1"]
