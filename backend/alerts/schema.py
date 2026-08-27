"""
Alert Rule Engine — SQLite schema (memory/plans/alert-rule-engine.md §5).

Table creation is factored out from db.py so tests can apply the exact same
DDL to an isolated in-memory connection instead of touching the shared
portfolio.db (see backend/tests/test_alerts_engine.py).
"""
import sqlite3


def create_alert_tables(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS alert_rules (
            id             TEXT PRIMARY KEY,
            name           TEXT NOT NULL,
            enabled        INTEGER NOT NULL DEFAULT 1,
            scope_json     TEXT NOT NULL,
            timeframe      TEXT NOT NULL DEFAULT '1d',
            expr_json      TEXT NOT NULL,
            trigger        TEXT NOT NULL DEFAULT 'edge' CHECK(trigger IN ('edge','level')),
            cooldown_bars  INTEGER NOT NULL DEFAULT 1,
            max_fires_per_day INTEGER,
            notify_json    TEXT NOT NULL DEFAULT '["ticker"]',
            webhook_url    TEXT,
            expires_at     TEXT,
            schema_version INTEGER NOT NULL DEFAULT 1,
            created_at     TEXT NOT NULL,
            updated_at     TEXT NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled)")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS alert_rule_state (
            rule_id       TEXT NOT NULL,
            symbol        TEXT NOT NULL,
            -- three-valued, not boolean — see plan §11
            last_state    TEXT NOT NULL DEFAULT 'unknown' CHECK(last_state IN ('unknown','false','true')),
            last_bar      TEXT,
            last_fired_bar TEXT,
            last_fired_at TEXT,
            fires_today   INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (rule_id, symbol),
            FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS alert_events (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id       TEXT NOT NULL,
            symbol        TEXT NOT NULL,
            fired_at      TEXT NOT NULL,
            bar_time      TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            acked         INTEGER NOT NULL DEFAULT 0,
            UNIQUE (rule_id, symbol, bar_time)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_alert_events_fired ON alert_events(fired_at DESC)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_alert_events_rule_symbol_day "
        "ON alert_events(rule_id, symbol, bar_time)"
    )

    # Webhook delivery outcome (alerts/notify.py). Added after the table
    # shipped, so it has to be an ALTER — CREATE TABLE IF NOT EXISTS above is
    # a no-op on databases that already have alert_events.
    _add_column(conn, "alert_events", "notified_at", "TEXT")
    _add_column(conn, "alert_events", "notify_error", "TEXT")

    # Rules deleted before delete_rule learned to ack their events left unacked
    # orphans behind, and an orphan alerts forever: the events endpoint gives a
    # row with no rule the default notify=["ticker"], so the ticker and the
    # watchlist badge kept warning about conditions the user had already
    # removed. Ack them once, here, where every start-up passes.
    conn.execute("""
        UPDATE alert_events
           SET acked = 1
         WHERE acked = 0
           AND rule_id NOT IN (SELECT id FROM alert_rules)
    """)


def _add_column(conn: sqlite3.Connection, table: str, column: str, decl: str) -> None:
    """Idempotent ALTER — SQLite has no ADD COLUMN IF NOT EXISTS."""
    existing = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
