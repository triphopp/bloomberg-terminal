"""Change feed: a version number per table, bumped by the database itself.

The frontend used to poll tables that change only when someone edits them
(`chart_drawings` every 60 s) just in case another tab, the other machine's
sync pull, or the MCP server had written. Instead, AFTER INSERT/UPDATE/DELETE
triggers bump `table_versions.seq`; the heartbeat carries the versions and the
frontend refetches only what moved (`hooks/useChangeFeed.ts`).

Triggers, not a Python hook: every writer goes through SQLite — routers, sync
apply, `bloomberg-terminal` MCP (its own process), scripts — so none can be
missed.

Postgres (plans/central-db-cloud-primary.md): the same table + plpgsql
triggers port 1:1, or `versions()` becomes `SELECT MAX(change_seq)` per table
once P1 adds change_seq. Multi-user (P6): key versions by owner_id as well.
`versions()` is the only reader, so the switch is local to this file.
"""

from __future__ import annotations

import re

from db import get_db

# Tables the frontend refreshes on change (keep in sync with CHANGE_KEYS in
# components/bloomberg/hooks/useChangeFeed.ts).
WATCHED: tuple[str, ...] = ("chart_drawings",)

_NAME = re.compile(r"^[a-z_][a-z0-9_]*$")


def _triggers_sql(table: str) -> list[str]:
    """SQLite trigger bodies. Postgres (P2) = one plpgsql function doing the same
    UPDATE + `CREATE TRIGGER … AFTER INSERT OR UPDATE OR DELETE … FOR EACH ROW`."""
    assert _NAME.match(table), table  # names are interpolated below
    bump = f"UPDATE table_versions SET seq = seq + 1 WHERE table_name = '{table}';"
    return [
        f"CREATE TRIGGER IF NOT EXISTS tv_{table}_{op[0].lower()} AFTER {op} ON {table} "
        f"BEGIN {bump} END"
        for op in ("INSERT", "UPDATE", "DELETE")
    ]


def _table_exists(c, table: str) -> bool:
    # Dialect seam: information_schema.tables on Postgres (P2).
    return c.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone() is not None


def init_change_feed(conn=None) -> None:
    """Idempotent. Run after every WATCHED table exists."""
    def run(c):
        c.execute(
            "CREATE TABLE IF NOT EXISTS table_versions ("
            " table_name TEXT PRIMARY KEY,"
            " seq INTEGER NOT NULL DEFAULT 0)"
        )
        for table in WATCHED:
            if not _table_exists(c, table):
                continue
            # ON CONFLICT … DO NOTHING: same statement on SQLite and Postgres.
            c.execute(
                "INSERT INTO table_versions (table_name, seq) VALUES (?, 0)"
                " ON CONFLICT (table_name) DO NOTHING",
                (table,),
            )
            for sql in _triggers_sql(table):
                c.execute(sql)

    if conn is not None:
        run(conn)
        return
    with get_db() as c:
        run(c)


def versions() -> dict[str, int]:
    with get_db() as conn:
        rows = conn.execute("SELECT table_name, seq FROM table_versions").fetchall()
    return {r[0]: int(r[1]) for r in rows if r[0] in WATCHED}
