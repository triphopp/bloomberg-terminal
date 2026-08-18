"""
`iv_snapshots` participation in the cloud-sync layer.

Adding a table to SYNC_TABLES is not just a list edit: init_sync_layer() has to
add an `updated_at` column and install three triggers, and the merge needs the
natural key to be stable across devices. This checks that machinery actually
landed on the new table, since a silent miss means one machine's IV history never
reaches the other — and an unrecorded day cannot be back-filled.

Does not use pytest's `tmp_path`: this box denies access to the system temp root.

Run:
    cd backend
    python -m pytest tests/test_iv_snapshots_sync.py -v
"""

import shutil
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, ".")


@pytest.fixture()
def synced_db(monkeypatch):
    root = Path(__file__).parent / "_tmp"
    root.mkdir(exist_ok=True)
    scratch = Path(tempfile.mkdtemp(dir=root))
    try:
        import config

        monkeypatch.setattr(config, "DB_PATH", scratch / "test.db", raising=False)
        import db

        monkeypatch.setattr(db, "DB_PATH", scratch / "test.db", raising=False)
        db.init_db()
        db.init_portfolio_v2()
        db.init_sync_layer()
        yield db
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def _insert(db, symbol="SPY", day: date | None = None, dte=30, iv=0.2):
    day = day or date.today()
    with db.get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO iv_snapshots (symbol, snapshot_date, expiry, dte, spot,"
            " atm_strike, iv_call, iv_put, iv_mid, source)"
            " VALUES (?,?,?,?,100,100,?,?,?,'test')",
            (symbol, day.isoformat(), (day + timedelta(days=dte)).isoformat(), dte, iv, iv, iv),
        )


def test_table_is_registered_with_its_natural_key():
    from sync.config import TABLE_PK

    assert TABLE_PK["iv_snapshots"] == ["symbol", "snapshot_date", "expiry"]


def test_sync_layer_adds_updated_at(synced_db):
    with synced_db.get_db() as conn:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(iv_snapshots)").fetchall()}
    assert "updated_at" in cols


def test_all_three_triggers_are_installed(synced_db):
    with synced_db.get_db() as conn:
        names = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='iv_snapshots'"
            ).fetchall()
        }
    assert names == {
        "trg_iv_snapshots_sync_ins",
        "trg_iv_snapshots_sync_upd",
        "trg_iv_snapshots_sync_del",
    }


def test_insert_gets_stamped(synced_db):
    _insert(synced_db)
    with synced_db.get_db() as conn:
        stamp = conn.execute("SELECT updated_at FROM iv_snapshots").fetchone()[0]
    assert stamp  # not NULL — a NULL breaks last-write-wins comparisons at merge


def test_update_restamps_later_than_the_insert(synced_db):
    _insert(synced_db, iv=0.2)
    with synced_db.get_db() as conn:
        first = conn.execute("SELECT updated_at FROM iv_snapshots").fetchone()[0]
        conn.execute("UPDATE iv_snapshots SET iv_mid = 0.9")
        second = conn.execute("SELECT updated_at FROM iv_snapshots").fetchone()[0]
    assert second >= first


def test_delete_records_a_tombstone_on_the_composite_key(synced_db):
    from sync.config import TOMB_SEP

    day = date.today()
    _insert(synced_db, "SPY", day)
    with synced_db.get_db() as conn:
        conn.execute("DELETE FROM iv_snapshots WHERE symbol = 'SPY'")
        rows = conn.execute(
            "SELECT row_id FROM sync_tombstones WHERE table_name = 'iv_snapshots'"
        ).fetchall()

    assert len(rows) == 1
    expiry = (day + timedelta(days=30)).isoformat()
    assert rows[0][0] == TOMB_SEP.join(["SPY", day.isoformat(), expiry])


def test_rows_for_different_days_never_contend(synced_db):
    """The point of syncing this table: two machines recording different days
    union rather than overwrite each other."""
    today = date.today()
    _insert(synced_db, "SPY", today)
    _insert(synced_db, "SPY", today - timedelta(days=1))
    with synced_db.get_db() as conn:
        n = conn.execute("SELECT COUNT(*) FROM iv_snapshots WHERE symbol='SPY'").fetchone()[0]
    assert n == 2


def test_snapshot_export_includes_the_table(synced_db):
    """A table in SYNC_TABLES that the exporter skips would sync nothing."""
    from sync.snapshot import export_snapshot

    _insert(synced_db)
    with synced_db.get_db() as conn:
        payload = export_snapshot(conn, device="test-device")

    assert "iv_snapshots" in payload["tables"]
    assert len(payload["tables"]["iv_snapshots"]) == 1
    row = payload["tables"]["iv_snapshots"][0]
    # The natural key has to survive the round trip, or the merge cannot match it.
    assert row["symbol"] == "SPY"
    assert row["snapshot_date"] == date.today().isoformat()
    assert row["updated_at"]
