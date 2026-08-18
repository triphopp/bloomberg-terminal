"""
SQLite database connection and schema initialization.
"""
import json
import sqlite3
from contextlib import contextmanager

from config import DB_PATH


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, ddl: str) -> None:
    """Idempotent ADD COLUMN without using exception handling as control flow."""
    if column not in _table_columns(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


@contextmanager
def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    # foreign_keys is genuinely per-connection (SQLite resets it on every
    # new connection) so this has to run here. journal_mode is NOT — it's a
    # persistent property stored in the DB file header, so re-issuing
    # `PRAGMA journal_mode = WAL` on every request pays for a lock + recheck
    # that always no-ops once the file is already WAL (~0.65ms measured,
    # dwarfing every other query this function runs). Set it once, in
    # _ensure_wal_mode() at startup, instead of on all 150+ get_db() call
    # sites' every invocation.
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _ensure_wal_mode() -> None:
    """Runs once at startup — see the comment in get_db() for why this isn't
    inline there. Safe to call even if the file is already WAL (no-op) or
    doesn't exist yet (creates it)."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode = WAL")
    conn.close()


def init_db() -> None:
    _ensure_wal_mode()
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS transactions (
                id         TEXT PRIMARY KEY,
                symbol     TEXT NOT NULL,
                type       TEXT NOT NULL CHECK(type IN ('buy','sell')),
                shares     REAL NOT NULL,
                price      REAL NOT NULL,
                date       TEXT NOT NULL,
                commission REAL NOT NULL DEFAULT 0,
                notes      TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tx_sym  ON transactions(symbol)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS pin_groups (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                color      TEXT NOT NULL DEFAULT '#f59e0b',
                sort_order INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pinned_assets (
                id           TEXT PRIMARY KEY,
                symbol       TEXT NOT NULL,
                group_id     TEXT NOT NULL REFERENCES pin_groups(id),
                comment      TEXT NOT NULL DEFAULT '',
                buy_target   REAL,
                sell_target  REAL,
                price_at_pin REAL,
                priority     INTEGER NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 3),
                sort_order   INTEGER NOT NULL DEFAULT 0,
                added_at     TEXT NOT NULL DEFAULT (date('now')),
                updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        # Migration: add sort_order to existing DBs that don't have it yet
        try:
            conn.execute("ALTER TABLE pinned_assets ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass  # column already exists
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pin_tags (
                id    TEXT PRIMARY KEY,
                name  TEXT NOT NULL UNIQUE,
                color TEXT NOT NULL DEFAULT '#94a3b8'
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pinned_asset_tags (
                asset_id TEXT NOT NULL REFERENCES pinned_assets(id) ON DELETE CASCADE,
                tag_id   TEXT NOT NULL REFERENCES pin_tags(id)      ON DELETE CASCADE,
                PRIMARY KEY (asset_id, tag_id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_pa_group ON pinned_assets(group_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_pa_sym   ON pinned_assets(symbol)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS symbol_lists (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                list_id    TEXT NOT NULL,
                symbol     TEXT NOT NULL,
                label      TEXT,
                region     TEXT,
                meta       TEXT,
                sort_order INTEGER DEFAULT 0,
                enabled    INTEGER DEFAULT 1,
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sym_list_list ON symbol_lists(list_id)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS sector_classifications (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol        TEXT NOT NULL,
                country       TEXT NOT NULL,
                exchange      TEXT,
                sector_gics   TEXT,
                industry_gics TEXT,
                sector_local  TEXT,
                sector_display TEXT,
                company_name  TEXT,
                market_cap    REAL,
                index_tags    TEXT,
                source        TEXT DEFAULT 'yfinance',
                last_fetched  TEXT,
                fetch_error   TEXT,
                created_at    TEXT DEFAULT (datetime('now')),
                updated_at    TEXT DEFAULT (datetime('now')),
                UNIQUE(symbol, country)
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_sc_country_sector
            ON sector_classifications(country, sector_display)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_sc_symbol
            ON sector_classifications(symbol)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_sc_country_mcap
            ON sector_classifications(country, market_cap)
        """)

        # ── ATM implied-vol snapshots ─────────────────────────────────────
        # Yahoo only ever reports the CURRENT implied vol of a chain, so an IV
        # time series cannot be back-filled from anywhere — it can only be
        # accumulated. One row per (symbol, day, expiry); the SD-band heatmap
        # reads this as its sigma history and shows how many days it has.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS iv_snapshots (
                symbol        TEXT NOT NULL,
                snapshot_date TEXT NOT NULL,
                expiry        TEXT NOT NULL,
                dte           INTEGER NOT NULL,
                spot          REAL NOT NULL,
                atm_strike    REAL,
                iv_call       REAL,
                iv_put        REAL,
                iv_mid        REAL NOT NULL,
                source        TEXT NOT NULL DEFAULT 'yfinance',
                created_at    TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (symbol, snapshot_date, expiry)
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ivsnap_sym_date "
            "ON iv_snapshots(symbol, snapshot_date)"
        )


def init_portfolio_v2() -> None:
    """Create portfolio v2 tables (multi-account, trade log, cash, dividends)."""
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS portfolio_accounts (
                id           TEXT PRIMARY KEY,
                name         TEXT NOT NULL,
                broker       TEXT DEFAULT '',
                country      TEXT NOT NULL DEFAULT 'TH',
                currency     TEXT NOT NULL DEFAULT 'THB',
                account_type TEXT DEFAULT 'equity',
                is_active    INTEGER DEFAULT 1,
                created_at   TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS trades (
                id                TEXT PRIMARY KEY,
                account_id        TEXT NOT NULL,
                symbol            TEXT NOT NULL,
                sector            TEXT DEFAULT '',
                date_entry        TEXT NOT NULL,
                date_exit         TEXT,
                price_entry       REAL NOT NULL DEFAULT 0,
                price_exit        REAL,
                price_stoploss    REAL,
                price_target      REAL,
                volume            REAL NOT NULL DEFAULT 0,
                amount            REAL,
                pnl_amount        REAL,
                win_loss          TEXT DEFAULT 'P',
                pnl_percent       REAL,
                currency          TEXT NOT NULL DEFAULT 'THB',
                exchange_rate     REAL DEFAULT 1,
                exit_exchange_rate REAL,
                strategy_name     TEXT DEFAULT '',
                entry_trigger     TEXT DEFAULT '',
                exit_trigger      TEXT DEFAULT '',
                market_trend      TEXT DEFAULT '',
                news_sentiment    TEXT DEFAULT '',
                expectation_based TEXT DEFAULT '',
                factor_based      TEXT DEFAULT '',
                fear_greed_index  TEXT DEFAULT '',
                vix_index         TEXT DEFAULT '',
                note              TEXT DEFAULT '',
                created_at        TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_trades_account ON trades(account_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_trades_symbol  ON trades(symbol)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_trades_date    ON trades(date_entry)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_trades_wl      ON trades(win_loss)")
        # Migration: symbol resolver (plans/port-redesign.md Step 1)
        # resolved_symbol = provider-canonical ticker (e.g. TU.BK), market = US/TH/CRYPTO
        _ensure_column(conn, "trades", "resolved_symbol", "resolved_symbol TEXT")
        _ensure_column(conn, "trades", "market", "market TEXT")
        _ensure_column(conn, "trades", "exit_exchange_rate", "exit_exchange_rate REAL")
        _ensure_column(conn, "trades", "is_reinvest", "is_reinvest INTEGER NOT NULL DEFAULT 0")
        _ensure_column(conn, "portfolio_accounts", "markets", "markets TEXT")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS cash_ledger (
                id            TEXT PRIMARY KEY,
                account_id    TEXT NOT NULL,
                date          TEXT NOT NULL,
                income        REAL DEFAULT 0,
                investment    REAL DEFAULT 0,
                exchange_rate REAL DEFAULT 1,
                note          TEXT DEFAULT '',
                created_at    TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cash_account ON cash_ledger(account_id)")
        # Migration: linked-pair TRANSFER entries (plans/cash-transfer-feature.md)
        _ensure_column(conn, "cash_ledger", "entry_type", "entry_type TEXT DEFAULT 'CASH'")
        _ensure_column(conn, "cash_ledger", "linked_id", "linked_id TEXT")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS dividends (
                id                TEXT PRIMARY KEY,
                account_id        TEXT NOT NULL,
                asset             TEXT NOT NULL,
                ex_date           TEXT,
                pay_date          TEXT,
                amount_per_unit   REAL DEFAULT 0,
                total_received    REAL DEFAULT 0,
                reinvested_amount REAL DEFAULT 0,
                reinvest_asset    TEXT DEFAULT '',
                reinvest_price    REAL DEFAULT 0,
                reinvest_units    REAL DEFAULT 0,
                currency          TEXT,
                created_at        TEXT DEFAULT (datetime('now'))
            )
        """)
        _ensure_column(conn, "dividends", "currency", "currency TEXT")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_div_account ON dividends(account_id)")

        # Daily FX history is deterministic market data, so it stays local and is
        # intentionally excluded from cloud-sync snapshots.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS fx_rates (
                date       TEXT NOT NULL,
                base       TEXT NOT NULL,
                quote      TEXT NOT NULL,
                rate       REAL NOT NULL CHECK(rate > 0),
                source     TEXT DEFAULT '',
                updated_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY(date, base, quote)
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_fx_pair_date "
            "ON fx_rates(base, quote, date DESC)"
        )

        # One-time/idempotent correction for pre-first-class currency rows.
        # Import locally to keep db.py's module dependency graph acyclic.
        from portfolio_currency import backfill_currency_columns
        backfill_currency_columns(conn)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS option_positions (
                id            TEXT PRIMARY KEY,
                account_id    TEXT NOT NULL DEFAULT 'dime',
                underlying    TEXT NOT NULL,
                expiry        TEXT NOT NULL,
                strike        REAL NOT NULL,
                option_type   TEXT NOT NULL CHECK(option_type IN ('call','put')),
                quantity      INTEGER NOT NULL,
                entry_price   REAL NOT NULL,
                entry_date    TEXT NOT NULL,
                status        TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','expired')),
                notes         TEXT DEFAULT '',
                created_at    TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_opt_account ON option_positions(account_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_opt_status  ON option_positions(status)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS regime_alerts (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                from_label  TEXT NOT NULL,
                to_label    TEXT NOT NULL,
                regime_type TEXT NOT NULL DEFAULT 'CORR',
                detected_at TEXT NOT NULL DEFAULT (datetime('now')),
                expires_at  TEXT NOT NULL
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS risk_snapshots (
                id                   INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id           TEXT NOT NULL,
                snapshot_date        TEXT NOT NULL,
                portfolio_value      REAL DEFAULT 0,
                today_return_pct     REAL DEFAULT 0,
                breach_count         INTEGER DEFAULT 0,
                ensemble_signal      TEXT DEFAULT 'STABLE',
                vol_regime           TEXT DEFAULT 'UNKNOWN',
                cf_hist_ratio        REAL DEFAULT 1.0,
                mc_hist_ratio        REAL DEFAULT 1.0,
                ci_width_ratio       REAL DEFAULT 1.0,
                avg_correlation      REAL DEFAULT 0,
                current_drawdown_pct REAL DEFAULT 0,
                var_backtest_rate    REAL DEFAULT 0,
                risk_score           REAL DEFAULT 0,
                ews                  INTEGER DEFAULT 0,
                is_fat_tail_event    INTEGER DEFAULT 0,
                created_at           TEXT DEFAULT (datetime('now')),
                UNIQUE(account_id, snapshot_date)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_rs_account_date ON risk_snapshots(account_id, snapshot_date)")
        # Migrations for columns added after initial schema
        try:
            conn.execute("ALTER TABLE risk_snapshots ADD COLUMN regime_label TEXT DEFAULT 'UNKNOWN'")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE risk_snapshots ADD COLUMN avg_wedge REAL DEFAULT 0.5")
        except Exception:
            pass

        # ── Portfolio NAV snapshots (daily mark-to-market, THB base) ──────
        conn.execute("""
            CREATE TABLE IF NOT EXISTS portfolio_nav_snapshots (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id       TEXT NOT NULL,
                snapshot_date    TEXT NOT NULL,
                total_value      REAL DEFAULT 0,
                open_cost_basis  REAL DEFAULT 0,
                unrealized_pnl   REAL DEFAULT 0,
                realized_pnl     REAL DEFAULT 0,
                invested_capital REAL DEFAULT 0,
                dividends        REAL DEFAULT 0,
                created_at       TEXT DEFAULT (datetime('now')),
                UNIQUE(account_id, snapshot_date)
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_nav_account_date "
            "ON portfolio_nav_snapshots(account_id, snapshot_date)"
        )

        # ── Paper Trading tables ─────────────────────────────────────────
        conn.execute("""
            CREATE TABLE IF NOT EXISTS paper_accounts (
                id              TEXT PRIMARY KEY,
                name            TEXT NOT NULL,
                currency        TEXT NOT NULL DEFAULT 'USD',
                initial_balance REAL NOT NULL DEFAULT 100000,
                created_at      TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS paper_orders (
                id           TEXT PRIMARY KEY,
                account_id   TEXT NOT NULL REFERENCES paper_accounts(id) ON DELETE CASCADE,
                symbol       TEXT NOT NULL,
                side         TEXT NOT NULL CHECK(side IN ('buy','sell')),
                order_type   TEXT NOT NULL CHECK(order_type IN ('market','limit','stop','stop_limit')),
                quantity     REAL NOT NULL,
                limit_price  REAL,
                stop_price   REAL,
                status       TEXT NOT NULL DEFAULT 'pending'
                             CHECK(status IN ('pending','filled','partially_filled','cancelled','expired')),
                filled_qty   REAL NOT NULL DEFAULT 0,
                filled_price REAL,
                filled_at    TEXT,
                expires_at   TEXT,
                created_at   TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_po_account ON paper_orders(account_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_po_status  ON paper_orders(status)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS paper_fills (
                id         TEXT PRIMARY KEY,
                order_id   TEXT NOT NULL REFERENCES paper_orders(id) ON DELETE CASCADE,
                quantity   REAL NOT NULL,
                price      REAL NOT NULL,
                commission REAL NOT NULL DEFAULT 0,
                filled_at  TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_pf_order ON paper_fills(order_id)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS paper_positions (
                id           TEXT PRIMARY KEY,
                account_id   TEXT NOT NULL REFERENCES paper_accounts(id) ON DELETE CASCADE,
                symbol       TEXT NOT NULL,
                quantity     REAL NOT NULL DEFAULT 0,
                avg_cost     REAL NOT NULL DEFAULT 0,
                realized_pnl REAL NOT NULL DEFAULT 0,
                UNIQUE(account_id, symbol)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_pp_account ON paper_positions(account_id)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS paper_snapshots (
                id              TEXT PRIMARY KEY,
                account_id      TEXT NOT NULL REFERENCES paper_accounts(id) ON DELETE CASCADE,
                date            TEXT NOT NULL,
                equity          REAL NOT NULL,
                cash            REAL NOT NULL,
                positions_value REAL NOT NULL DEFAULT 0,
                UNIQUE(account_id, date)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ps_account ON paper_snapshots(account_id, date)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS paper_option_positions (
                id            TEXT PRIMARY KEY,
                account_id    TEXT NOT NULL REFERENCES paper_accounts(id) ON DELETE CASCADE,
                underlying    TEXT NOT NULL,
                expiry        TEXT NOT NULL,
                strike        REAL NOT NULL,
                option_type   TEXT NOT NULL CHECK(option_type IN ('call','put')),
                quantity      INTEGER NOT NULL,
                entry_price   REAL NOT NULL,
                entry_date    TEXT NOT NULL,
                exit_price    REAL,
                exit_date     TEXT,
                status        TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','expired','exercised')),
                commission    REAL NOT NULL DEFAULT 0,
                realized_pnl  REAL,
                notes         TEXT DEFAULT '',
                created_at    TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_pop_account ON paper_option_positions(account_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_pop_status  ON paper_option_positions(status)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS trade_audit_log (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                trade_id       TEXT NOT NULL,
                action         TEXT NOT NULL,
                fields_changed TEXT DEFAULT '{}',
                reason         TEXT DEFAULT '',
                snapshot       TEXT DEFAULT '{}',
                created_at     TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tal_trade ON trade_audit_log(trade_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tal_time  ON trade_audit_log(created_at)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS position_cost_overrides (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id TEXT NOT NULL,
                symbol     TEXT NOT NULL,
                avg_cost   REAL NOT NULL,
                reason     TEXT DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(account_id, symbol)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_pco_account ON position_cost_overrides(account_id)")

        # No default accounts — users create their own via the portfolio UI
        # (POST /api/v2/portfolio/accounts).


def init_thesis_schema() -> None:
    """Investment thesis tables + allocation targets.

    `theses` is the materialised head (one row per thesis, edited in place so the
    existing field-level LWW merge applies), `thesis_events` is an append-only
    audit log of how the thinking changed. Events are never UPDATEd, so two
    devices writing history concurrently can never conflict — they just union.

    All PKs are TEXT uuid4: AUTOINCREMENT ids collide across devices and would
    have to be excluded from cloud sync (see sync/config.py).
    """
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS theses (
                id              TEXT PRIMARY KEY,
                symbol          TEXT NOT NULL,
                resolved_symbol TEXT,
                market          TEXT,
                account_id      TEXT,
                sub_portfolio   TEXT,
                title           TEXT NOT NULL DEFAULT '',
                category        TEXT DEFAULT '',
                strategy        TEXT DEFAULT '',
                status          TEXT NOT NULL DEFAULT 'draft',
                conviction      INTEGER,
                time_horizon    TEXT DEFAULT '',
                target_price    REAL,
                stop_price      REAL,
                currency        TEXT,
                body            TEXT DEFAULT '',
                source_file     TEXT,
                deleted_at      TEXT,
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_theses_symbol  ON theses(symbol)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_theses_status  ON theses(status)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_theses_account ON theses(account_id)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS thesis_events (
                id          TEXT PRIMARY KEY,
                thesis_id   TEXT NOT NULL,
                event_type  TEXT NOT NULL,
                payload     TEXT,
                note        TEXT DEFAULT '',
                occurred_at TEXT NOT NULL,
                device_id   TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_thevt_thesis ON thesis_events(thesis_id, occurred_at)"
        )

        conn.execute("""
            CREATE TABLE IF NOT EXISTS thesis_links (
                thesis_id  TEXT NOT NULL,
                trade_id   TEXT NOT NULL,
                role       TEXT DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (thesis_id, trade_id)
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS allocation_targets (
                id         TEXT PRIMARY KEY,
                account_id TEXT NOT NULL DEFAULT 'all',
                scope      TEXT NOT NULL DEFAULT 'sector',
                key        TEXT NOT NULL,
                target_pct REAL NOT NULL DEFAULT 0,
                band_pct   REAL NOT NULL DEFAULT 5,
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(account_id, scope, key)
            )
        """)


def init_alerts_schema() -> None:
    """Alert Rule Engine tables (memory/plans/alert-rule-engine.md §5)."""
    from alerts.schema import create_alert_tables
    with get_db() as conn:
        create_alert_tables(conn)


def init_sync_layer() -> None:
    """Cloud-sync support: per-row `updated_at` (LWW) + delete tombstones.

    Adds an `updated_at` column + an AFTER UPDATE trigger to every synced table,
    plus an AFTER DELETE trigger that records the deleted natural key into
    `sync_tombstones` (so deletes survive a merge instead of resurrecting).

    All triggers are gated by `_sync_guard.active`; the restore path raises that
    flag so importing remote rows neither re-stamps `updated_at` nor fabricates
    tombstones. Safe to call on every startup (idempotent)."""
    from sync.config import SYNC_TABLES, TOMB_SEP
    sep = TOMB_SEP  # char(31) unit separator, embedded literally below

    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sync_tombstones (
                table_name TEXT NOT NULL,
                row_id     TEXT NOT NULL,
                deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (table_name, row_id)
            )
        """)
        conn.execute("CREATE TABLE IF NOT EXISTS _sync_guard (active INTEGER NOT NULL)")
        if conn.execute("SELECT COUNT(*) FROM _sync_guard").fetchone()[0] == 0:
            conn.execute("INSERT INTO _sync_guard (active) VALUES (0)")

        # Millisecond stamp. `datetime('now')` is second-resolution, so two
        # devices editing the same row inside one second produced equal
        # timestamps — last-write-wins then had nothing to compare and the
        # winner fell out of file iteration order, which the two machines can
        # resolve DIFFERENTLY and stay diverged forever.
        #
        # The format keeps the space separator of `datetime('now')` on purpose:
        # '2026-08-11 02:08:04.123' sorts after the existing
        # '2026-08-11 02:08:04' under the plain string comparison the merge
        # uses, so old and new rows stay orderable with no data migration. An
        # ISO 'T'/'Z' form would have sorted every legacy row below every new
        # one regardless of actual time.
        now_ms = "strftime('%Y-%m-%d %H:%M:%f', 'now')"

        # Tables that USED to be synced. Their triggers survive in any DB
        # created before they were dropped from SYNC_TABLES, and would keep
        # stamping updated_at and manufacturing tombstones for rows no peer
        # will ever look at — paper_positions in particular is wiped and
        # rebuilt on every merge, which would mean a tombstone per position
        # per pull, forever.
        for table in ("paper_positions",):
            for suffix in ("ins", "upd", "del"):
                conn.execute(f"DROP TRIGGER IF EXISTS trg_{table}_sync_{suffix}")
            conn.execute("DELETE FROM sync_tombstones WHERE table_name = ?", (table,))

        for table, pk in SYNC_TABLES:
            # 1) updated_at column (skip if table absent or column exists)
            try:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN updated_at TEXT")
            except Exception:
                pass
            try:
                conn.execute(
                    f"UPDATE {table} SET updated_at = {now_ms} WHERE updated_at IS NULL"
                )
            except Exception:
                continue  # table not present in this DB

            # Triggers are recreated, not IF NOT EXISTS'd: an install from
            # before the millisecond change already has second-resolution
            # bodies, and CREATE TRIGGER IF NOT EXISTS would leave them.
            for suffix in ("ins", "upd", "del"):
                conn.execute(f"DROP TRIGGER IF EXISTS trg_{table}_sync_{suffix}")

            # 2a) stamp updated_at on INSERT when caller didn't set it (else NULL
            #     breaks last-write-wins comparisons during merge)
            conn.execute(f"""
                CREATE TRIGGER trg_{table}_sync_ins
                AFTER INSERT ON {table} FOR EACH ROW
                WHEN (SELECT active FROM _sync_guard) = 0 AND NEW.updated_at IS NULL
                BEGIN
                    UPDATE {table} SET updated_at = {now_ms} WHERE rowid = NEW.rowid;
                END;
            """)

            # 2b) auto-stamp updated_at on UPDATE (match by rowid — always unique)
            conn.execute(f"""
                CREATE TRIGGER trg_{table}_sync_upd
                AFTER UPDATE ON {table} FOR EACH ROW
                WHEN (SELECT active FROM _sync_guard) = 0
                BEGIN
                    UPDATE {table} SET updated_at = {now_ms} WHERE rowid = NEW.rowid;
                END;
            """)

            # 3) record tombstone on DELETE (natural key joined by char(31))
            row_expr = " || char(31) || ".join(f"CAST(OLD.{c} AS TEXT)" for c in pk)
            conn.execute(f"""
                CREATE TRIGGER trg_{table}_sync_del
                AFTER DELETE ON {table} FOR EACH ROW
                WHEN (SELECT active FROM _sync_guard) = 0
                BEGIN
                    INSERT OR REPLACE INTO sync_tombstones (table_name, row_id, deleted_at)
                    VALUES ('{table}', {row_expr}, {now_ms});
                END;
            """)


def get_sectors_by_country(country: str) -> list[str]:
    """Return distinct sector_display names for a country, ordered alphabetically."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT DISTINCT sector_display
            FROM sector_classifications
            WHERE country = ? AND sector_display IS NOT NULL
            ORDER BY sector_display
        """, (country,)).fetchall()
    return [r["sector_display"] for r in rows]


def get_stocks_in_sector(country: str, sector: str, limit: int = 30) -> list[dict]:
    """Return stocks in a sector ordered by market_cap DESC."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT symbol, company_name, sector_display, industry_gics,
                   market_cap, exchange, index_tags, last_fetched
            FROM sector_classifications
            WHERE country = ? AND sector_display = ?
            ORDER BY market_cap DESC
            LIMIT ?
        """, (country, sector, limit)).fetchall()
    return [dict(r) for r in rows]


def upsert_sector_classification(symbol: str, country: str, data: dict) -> None:
    """Insert or update a stock's sector classification."""
    with get_db() as conn:
        conn.execute("""
            INSERT INTO sector_classifications
                (symbol, country, exchange, sector_gics, industry_gics,
                 sector_local, sector_display, company_name, market_cap,
                 index_tags, source, last_fetched, fetch_error, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
            ON CONFLICT(symbol, country) DO UPDATE SET
                exchange       = excluded.exchange,
                sector_gics    = COALESCE(excluded.sector_gics,   sector_classifications.sector_gics),
                industry_gics  = COALESCE(excluded.industry_gics, sector_classifications.industry_gics),
                sector_display = COALESCE(excluded.sector_display, sector_classifications.sector_display),
                company_name   = COALESCE(excluded.company_name,  sector_classifications.company_name),
                market_cap     = COALESCE(excluded.market_cap,    sector_classifications.market_cap),
                index_tags     = excluded.index_tags,
                source         = excluded.source,
                last_fetched   = excluded.last_fetched,
                fetch_error    = excluded.fetch_error,
                updated_at     = datetime('now')
        """, (
            symbol, country,
            data.get("exchange"),
            data.get("sector_gics"),
            data.get("industry_gics"),
            data.get("sector_local"),
            data.get("sector_display") or data.get("sector_gics"),
            data.get("company_name"),
            data.get("market_cap"),
            data.get("index_tags"),
            data.get("source", "yfinance"),
            data.get("last_fetched"),
            data.get("fetch_error"),
        ))


def seed_symbol_lists() -> None:
    """Populate symbol_lists from config.py defaults on first run."""
    with get_db() as conn:
        count = conn.execute("SELECT COUNT(*) FROM symbol_lists").fetchone()[0]
        if count > 0:
            return

        from config import INDICES, HEATMAP_GROUPS, FX_PAIRS, CRYPTO_LIST

        sort = 0
        for cfg in INDICES:
            conn.execute(
                "INSERT INTO symbol_lists (list_id, symbol, label, region, meta, sort_order) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("indices", cfg["symbol"], cfg["id"], cfg["region"],
                 json.dumps({"num": cfg["num"]}), sort),
            )
            sort += 1

        for group_name, items in HEATMAP_GROUPS.items():
            list_id = f"heatmap_{group_name}"
            sort = 0
            for cfg in items:
                conn.execute(
                    "INSERT INTO symbol_lists (list_id, symbol, label, sort_order) "
                    "VALUES (?, ?, ?, ?)",
                    (list_id, cfg["symbol"], cfg["id"], sort),
                )
                sort += 1

        sort = 0
        for cfg in FX_PAIRS:
            conn.execute(
                "INSERT INTO symbol_lists (list_id, symbol, label, sort_order) "
                "VALUES (?, ?, ?, ?)",
                ("fx", cfg["symbol"], cfg["id"], sort),
            )
            sort += 1

        sort = 0
        for cfg in CRYPTO_LIST:
            conn.execute(
                "INSERT INTO symbol_lists (list_id, symbol, label, meta, sort_order) "
                "VALUES (?, ?, ?, ?, ?)",
                ("crypto", cfg["symbol"], cfg["id"],
                 json.dumps({"name": cfg["name"]}), sort),
            )
            sort += 1


def get_symbol_list(list_id: str) -> list[dict]:
    """Return enabled symbols for a list, formatted like the old config lists."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM symbol_lists WHERE list_id = ? AND enabled = 1 "
            "ORDER BY sort_order, id",
            (list_id,),
        ).fetchall()

    result: list[dict] = []
    for r in rows:
        item: dict = {
            "symbol": r["symbol"],
            "id": r["label"],
        }
        if r["region"]:
            item["region"] = r["region"]
        if r["meta"]:
            try:
                meta = json.loads(r["meta"])
            except (json.JSONDecodeError, TypeError):
                meta = {}
            if isinstance(meta, dict):
                item.update(meta)
        result.append(item)
    return result


def get_heatmap_groups() -> list[str]:
    """Return available heatmap group names (without 'heatmap_' prefix)."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT DISTINCT list_id FROM symbol_lists "
            "WHERE list_id LIKE 'heatmap_%' AND enabled = 1"
        ).fetchall()
    return [r["list_id"].replace("heatmap_", "", 1) for r in rows]


def add_symbol_to_list(list_id: str, symbol: str, label: str = "",
                       region: str = "", meta: dict | None = None) -> int:
    """Add a symbol to a list. Returns the new row id."""
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO symbol_lists (list_id, symbol, label, region, meta) "
            "VALUES (?, ?, ?, ?, ?)",
            (list_id, symbol, label, region,
             json.dumps(meta) if meta else None),
        )
        return cur.lastrowid


def remove_symbol_from_list(symbol_id: int) -> bool:
    """Soft-delete a symbol by setting enabled=0. Returns True if a row was updated."""
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE symbol_lists SET enabled = 0 WHERE id = ?",
            (symbol_id,),
        )
        return cur.rowcount > 0


def update_symbol_in_list(symbol_id: int, **fields) -> bool:
    """Update fields on a symbol_lists row. Only allowed: label, region, meta, sort_order, enabled."""
    allowed = {"label", "region", "meta", "sort_order", "enabled"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return False
    if "meta" in updates and isinstance(updates["meta"], dict):
        updates["meta"] = json.dumps(updates["meta"])

    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [symbol_id]
    with get_db() as conn:
        cur = conn.execute(
            f"UPDATE symbol_lists SET {set_clause} WHERE id = ?",
            values,
        )
        return cur.rowcount > 0


def compute_holdings() -> list[dict]:
    """Compute current holdings from transaction history using average-cost method."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM transactions ORDER BY date ASC, created_at ASC"
        ).fetchall()
    state: dict[str, dict] = {}
    for r in rows:
        sym = r["symbol"].upper()
        if sym not in state:
            state[sym] = {"symbol": sym, "shares": 0.0, "total_cost": 0.0,
                          "first_date": r["date"], "last_date": r["date"]}
        s = state[sym]
        if r["type"] == "buy":
            s["shares"]     += r["shares"]
            s["total_cost"] += r["shares"] * r["price"] + r["commission"]
            s["last_date"]   = r["date"]
        else:
            sold = min(r["shares"], s["shares"])
            if s["shares"] > 0:
                avg = s["total_cost"] / s["shares"]
                s["total_cost"] -= sold * avg
            s["shares"]   -= sold
            s["last_date"] = r["date"]
    result = []
    for s in state.values():
        if s["shares"] > 1e-6:
            s["avg_cost"]      = round(s["total_cost"] / s["shares"], 4)
            s["purchase_date"] = s["first_date"]
            result.append(s)
    return result
