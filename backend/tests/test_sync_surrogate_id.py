"""
Regression tests for the bug that silently stopped every cloud pull for two days.

`trade_audit_log` keys its merge on the uuid `event_id` but still has an
AUTOINCREMENT `id` PRIMARY KEY. The restore sent the PEER's `id` in the INSERT,
which collided with a different local row's id — a collision `ON CONFLICT
(event_id)` cannot catch. The resulting IntegrityError was not in the except
clause, so it escaped the single transaction wrapping every table and rolled the
whole merge back. Symptom: `sync_startup failed: UNIQUE constraint failed:
trade_audit_log.id`, push still working, pull dead, and four option trades that
never arrived on the second machine.

Two independent guarantees, so a regression in either one fails on its own:
  1. a surrogate `id` is never carried across devices;
  2. a row that cannot be placed costs that row, never the whole snapshot.

Run: cd backend && python -m pytest tests/test_sync_surrogate_id.py -q
"""
import sqlite3

import pytest

from sync.restore import _upsert, restore


def _conn() -> sqlite3.Connection:
    """In-memory stand-in for the two tables that matter, same shapes as db.py."""
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute(
        """CREATE TABLE trade_audit_log (
               id         INTEGER PRIMARY KEY AUTOINCREMENT,
               trade_id   TEXT NOT NULL,
               action     TEXT NOT NULL,
               event_id   TEXT,
               updated_at TEXT)"""
    )
    conn.execute("CREATE UNIQUE INDEX idx_tal_event ON trade_audit_log(event_id)")
    # `id` here IS the natural key — the fix must leave this table alone.
    conn.execute(
        """CREATE TABLE trades (
               id         TEXT PRIMARY KEY,
               symbol     TEXT,
               updated_at TEXT)"""
    )
    conn.execute("CREATE TABLE _sync_guard (active INTEGER)")
    conn.execute("INSERT INTO _sync_guard VALUES (0)")
    return conn


def _local_audit_row(conn, event_id: str = "local-uuid"):
    conn.execute(
        "INSERT INTO trade_audit_log (trade_id, action, event_id, updated_at) "
        "VALUES ('T1', 'EDIT', ?, '2026-09-01')",
        (event_id,),
    )


def test_a_peers_surrogate_id_does_not_collide_with_a_different_local_row():
    conn = _conn()
    _local_audit_row(conn)  # takes id = 1 locally
    # The peer's row is a DIFFERENT event that happens to also be its id 1.
    peer = [{"id": 1, "trade_id": "T2", "action": "DELETE",
             "event_id": "peer-uuid", "updated_at": "2026-09-02"}]

    applied = _upsert(conn, "trade_audit_log", ["event_id"], peer)

    assert applied == 1
    rows = conn.execute(
        "SELECT event_id, trade_id FROM trade_audit_log ORDER BY id"
    ).fetchall()
    assert rows == [("local-uuid", "T1"), ("peer-uuid", "T2")], (
        "both events must survive — the peer's id is not a fact about this device"
    )


def test_the_same_event_still_merges_rather_than_duplicating():
    # Dropping `id` must not break the merge itself: the natural key still has
    # to collapse two devices' copies of one event into a single row.
    conn = _conn()
    _local_audit_row(conn, event_id="shared-uuid")
    peer = [{"id": 99, "trade_id": "T1", "action": "DELETE",
             "event_id": "shared-uuid", "updated_at": "2026-09-05"}]

    _upsert(conn, "trade_audit_log", ["event_id"], peer)

    rows = conn.execute("SELECT COUNT(*), MAX(action) FROM trade_audit_log").fetchone()
    assert rows[0] == 1, "one event, one row"
    assert rows[1] == "DELETE", "the newer edit should win"


def test_a_table_whose_natural_key_is_id_keeps_it():
    conn = _conn()
    peer = [{"id": "uuid-from-peer", "symbol": "AMD", "updated_at": "2026-09-02"}]

    _upsert(conn, "trades", ["id"], peer)

    assert conn.execute("SELECT id FROM trades").fetchone() == ("uuid-from-peer",), (
        "a trade's id IS its identity — dropping it would create a duplicate on "
        "every pull"
    )


def test_one_unplaceable_row_does_not_discard_the_rest_of_the_snapshot(monkeypatch):
    """The half of the bug that turned a one-row problem into a total outage."""
    conn = _conn()
    # A row that violates a constraint the merge key does not cover: NOT NULL.
    bad = {"trade_id": None, "action": "EDIT", "event_id": "bad", "updated_at": "x"}
    good = {"trade_id": "T3", "action": "EDIT", "event_id": "good", "updated_at": "x"}

    applied = _upsert(conn, "trade_audit_log", ["event_id"], [bad, good])

    assert applied == 1
    assert conn.execute(
        "SELECT event_id FROM trade_audit_log"
    ).fetchall() == [("good",)], "the good row must still land"


def test_restore_commits_every_other_table_when_one_row_is_unplaceable(monkeypatch):
    """End-to-end shape of the outage: an audit-log row must not be able to take
    the trades table down with it."""
    import sync.restore as R

    conn = _conn()
    monkeypatch.setattr(
        R, "SYNC_TABLES", [("trades", ["id"]), ("trade_audit_log", ["event_id"])]
    )
    monkeypatch.setattr(R, "TABLE_PK", {})
    tables = {
        "trades": [{"id": "t-1", "symbol": "MU", "updated_at": "2026-09-02"}],
        "trade_audit_log": [
            {"trade_id": None, "action": "EDIT", "event_id": "bad", "updated_at": "x"}
        ],
    }

    R.restore(conn, tables, [])

    assert conn.execute("SELECT COUNT(*) FROM trades").fetchone()[0] == 1, (
        "one bad audit row used to roll back every table in the snapshot"
    )
