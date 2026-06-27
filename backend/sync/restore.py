"""
Apply a merged snapshot into the local SQLite DB.

LWW upsert: a remote row overwrites the local row only when its updated_at is
newer (`WHERE excluded.updated_at > <table>.updated_at`). Local-only / newer rows
are preserved untouched.

The `_sync_guard` flag is raised for the whole restore so the per-row
updated_at / tombstone triggers stay silent — otherwise the act of restoring
would re-stamp updated_at (breaking LWW) and manufacture false tombstones.
"""
import sqlite3
from contextlib import contextmanager

from .config import SYNC_TABLES, TABLE_PK, TOMB_SEP


@contextmanager
def _guarded(conn: sqlite3.Connection):
    conn.execute("UPDATE _sync_guard SET active = 1")
    try:
        yield
    finally:
        conn.execute("UPDATE _sync_guard SET active = 0")


def _upsert(conn: sqlite3.Connection, table: str, pk: list[str], rows: list[dict]) -> int:
    if not rows:
        return 0
    applied = 0
    for row in rows:
        cols = list(row.keys())
        collist = ", ".join(cols)
        placeholders = ", ".join("?" for _ in cols)
        conflict = ", ".join(pk)
        # never rewrite the conflict key or a surrogate id during upsert
        skip = set(pk) | {"id"}
        setters = [c for c in cols if c not in skip]
        if not setters:
            sql = (f"INSERT INTO {table} ({collist}) VALUES ({placeholders}) "
                   f"ON CONFLICT({conflict}) DO NOTHING")
        else:
            set_clause = ", ".join(f"{c} = excluded.{c}" for c in setters)
            sql = (f"INSERT INTO {table} ({collist}) VALUES ({placeholders}) "
                   f"ON CONFLICT({conflict}) DO UPDATE SET {set_clause} "
                   f"WHERE excluded.updated_at > COALESCE({table}.updated_at, '')")
        try:
            cur = conn.execute(sql, [row[c] for c in cols])
            applied += cur.rowcount or 0
        except sqlite3.OperationalError:
            # column/shape drift between schema versions — skip this row
            continue
    return applied


def _apply_tombstone(conn: sqlite3.Connection, table: str, pk: list[str],
                     row_id: str, deleted_at: str) -> None:
    parts = row_id.split(TOMB_SEP)
    if len(parts) != len(pk):
        return
    where = " AND ".join(f"{c} = ?" for c in pk)
    try:
        conn.execute(
            f"DELETE FROM {table} WHERE {where} "
            f"AND (updated_at IS NULL OR updated_at < ?)",
            [*parts, deleted_at],
        )
    except sqlite3.OperationalError:
        return
    conn.execute(
        "INSERT INTO sync_tombstones (table_name, row_id, deleted_at) VALUES (?, ?, ?) "
        "ON CONFLICT(table_name, row_id) DO UPDATE SET deleted_at = excluded.deleted_at "
        "WHERE excluded.deleted_at > sync_tombstones.deleted_at",
        [table, row_id, deleted_at],
    )


def restore(conn: sqlite3.Connection, tables: dict, tombstones: list) -> int:
    """Upsert merged rows + apply tombstones. Returns rows-applied count."""
    applied = 0
    with _guarded(conn):
        for table, pk in SYNC_TABLES:
            applied += _upsert(conn, table, pk, tables.get(table, []))
        for t in tombstones:
            tbl = t["table_name"]
            pk = TABLE_PK.get(tbl)
            if not pk:
                continue
            _apply_tombstone(conn, tbl, pk, t["row_id"], t.get("deleted_at") or "")
    return applied
