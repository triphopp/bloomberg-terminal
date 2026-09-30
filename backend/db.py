"""
SQLite database connection and schema initialization.
"""
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from time import perf_counter
from typing import Optional

import request_latency
from config import DB_MODE, DB_PATH

DB_MODES = ("local",)


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, ddl: str) -> None:
    """Idempotent ADD COLUMN without using exception handling as control flow."""
    if column not in _table_columns(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


def occ_symbol(underlying: str, expiry: str, strike: float, option_type: str) -> str:
    """OCC 21-character contract symbol: root(6, space-padded) + YYMMDD + C/P + strike*1000(8).

    Used as the natural key for option_contracts so the same contract entered
    twice cannot become two rows.
    """
    root = str(underlying or "").strip().upper()[:6].ljust(6)
    ymd = str(expiry or "")[:10].replace("-", "")[2:]
    cp = "C" if str(option_type).lower() == "call" else "P"
    return f"{root}{ymd}{cp}{int(round(float(strike) * 1000)):08d}"


def connect(path=None, *, readonly: bool = False, check_same_thread: bool = True) -> sqlite3.Connection:
    """The one place a portfolio database is opened.

    `path` defaults to DB_PATH; scripts pass another file (a backup, a copy under
    review). check_same_thread=False only for get_db()'s pool, which hands a
    connection to one caller at a time. Every opener going through here is what lets DB_MODE later swap the
    local file for a cloud-primary replica without touching 76 callers
    (memory/plans/central-db-cloud-primary.md). tests/test_db_single_opener.py
    keeps raw sqlite3.connect() out of everything else.
    """
    if DB_MODE not in DB_MODES:
        raise RuntimeError(
            f"DB_MODE={DB_MODE!r} is not available yet (supported: {', '.join(DB_MODES)}) "
            "— see memory/plans/central-db-cloud-primary.md"
        )
    target = Path(path) if path is not None else Path(DB_PATH)
    if readonly:
        conn = sqlite3.connect(target.resolve().as_uri() + "?mode=ro", uri=True)
        conn.execute("PRAGMA query_only = ON")
    else:
        conn = sqlite3.connect(str(target), check_same_thread=check_same_thread)
    conn.row_factory = sqlite3.Row
    return conn


# ── Connection pool for get_db() ──────────────────────────────────────────────
# Measured 2026-09-30 (memory/reports/db-latency-risk-report.md): the schema is
# ~230 KB of SQL (396 triggers — sync, op-log, audit, change feed), and SQLite
# re-parses all of it on the FIRST statement of every new connection: 2.3 ms
# alone, but 33 ms each with 3 threads opening at once and 97 ms with 8
# (the parse contends inside SQLite). /api/v2/portfolio/summary opens ~50
# connections per call, and the UI fires its panels in parallel, so a "2 ms"
# pins read took 37 ms whenever anything else was reading. A reused connection
# answers the same queries in ~0.02-0.2 ms under the same concurrency.
#
# Idle connections wait in a small LIFO list (any thread may take one; SQLite is
# built serialized, and a connection is only ever used by one get_db() at a
# time). Keyed by the DB file's identity, so a test that points DB_PATH at a new
# file — or deletes and recreates it — never gets a connection to the old one.
# DB_POOL_SIZE=0 restores open-per-call.
import os as _os
import threading as _threading

_POOL_MAX = max(0, int(_os.getenv("DB_POOL_SIZE", "16") or 0))
# importlib.reload(db) (many tests do) re-runs this module in the same globals:
# close the previous pool instead of orphaning its connections.
for _k, _c in globals().get("_pool", None) or ():
    try:
        _c.close()
    except Exception:
        pass
_pool: list[tuple[tuple, sqlite3.Connection]] = []
_pool_lock = _threading.Lock()


def _pool_key() -> tuple:
    target = Path(DB_PATH)
    try:
        st = _os.stat(target)
    except OSError:
        return (str(target), None)
    born = getattr(st, "st_birthtime_ns", None) or getattr(st, "st_birthtime", None) or st.st_ctime_ns
    return (str(target.resolve()), st.st_dev, st.st_ino, born)


def _acquire() -> tuple[sqlite3.Connection, Optional[tuple]]:
    """(connection, pool key) — key None = not poolable, close after use."""
    if _POOL_MAX <= 0 or DB_MODE != "local":
        return connect(), None
    key = _pool_key()
    if key[1] is None:           # file not created yet — init_db's first open
        return connect(), None
    stale = []
    conn = None
    with _pool_lock:
        while _pool:
            k, c = _pool.pop()
            if k == key:
                conn = c
                break
            stale.append(c)
    for c in stale:
        _close_quietly(c)
    if conn is None:
        conn = connect(check_same_thread=False)
    return conn, key


def _release(conn: sqlite3.Connection, key: Optional[tuple], healthy: bool) -> None:
    if key is not None and healthy:
        try:
            if conn.in_transaction:      # never hand on a half-open write
                conn.rollback()
            conn.row_factory = sqlite3.Row
            with _pool_lock:
                if len(_pool) < _POOL_MAX:
                    _pool.append((key, conn))
                    return
        except sqlite3.Error:
            pass
    _close_quietly(conn)


def _close_quietly(conn: sqlite3.Connection) -> None:
    try:
        conn.close()
    except Exception:
        pass


def close_pool() -> None:
    """Close every idle pooled connection (tests; before replacing the DB file)."""
    with _pool_lock:
        conns = [c for _, c in _pool]
        _pool.clear()
    for c in conns:
        _close_quietly(c)


import atexit as _atexit
_atexit.register(close_pool)


@contextmanager
def get_db():
    t0 = perf_counter()
    conn, key = _acquire()
    # foreign_keys is genuinely per-connection (SQLite resets it on every
    # new connection) so this has to run here. journal_mode is NOT — it's a
    # persistent property stored in the DB file header, so re-issuing
    # `PRAGMA journal_mode = WAL` on every request pays for a lock + recheck
    # that always no-ops once the file is already WAL (~0.65ms measured,
    # dwarfing every other query this function runs). Set it once, in
    # _ensure_wal_mode() at startup, instead of on all 150+ get_db() call
    # sites' every invocation. (Re-issued on a pooled connection too: ~µs,
    # and it keeps a body that turned it off from leaking that to the next.)
    healthy = False
    t_open = t_commit = None
    locked = False
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        changes_before = conn.total_changes   # cumulative on a reused connection
        mark = _ledger_mark(conn)
        t_open = perf_counter()
        yield conn
        # SHADOW accounts: project this transaction's legacy writes into the
        # ledger before committing, so a write the ledger refuses (a closed
        # period) never lands in the legacy tables either.
        t_commit = perf_counter()
        if mark is not None and conn.total_changes != changes_before:
            import ledger
            ledger.flush_dirty(conn, mark)
        conn.commit()
        healthy = True
    except Exception as exc:
        locked = isinstance(exc, sqlite3.OperationalError) and "locked" in str(exc)
        try:
            conn.rollback()
            healthy = True
        except sqlite3.Error:
            pass
        raise
    finally:
        _release(conn, key, healthy)
        # Phase timings for request_latency (logs/latency.jsonl, /api/health/latency).
        end = perf_counter()
        request_latency.note_db((t_open or end) - t0, end - t0,
                                (end - t_commit) if t_commit is not None else 0.0, locked)


def _ledger_mark(conn: sqlite3.Connection) -> Optional[int]:
    """Highest ledger_dirty id before this connection writes (None = no table)."""
    try:
        return conn.execute("SELECT COALESCE(MAX(id), 0) FROM ledger_dirty").fetchone()[0]
    except sqlite3.OperationalError:
        return None


def _ensure_wal_mode() -> None:
    """Runs once at startup — see the comment in get_db() for why this isn't
    inline there. Safe to call even if the file is already WAL (no-op) or
    doesn't exist yet (creates it)."""
    conn = connect()
    conn.execute("PRAGMA journal_mode = WAL")
    conn.close()


def dedupe_pinned_assets(conn: sqlite3.Connection) -> int:
    """Collapse pins that share a symbol into one row (idempotent). Returns rows removed.

    One symbol = one pin in exactly one group; multi-category membership is what
    pin tags are for. Keeps the row with the most information (comment, targets,
    price_at_pin, tags), then the most recently updated, then the smallest id
    (so two machines holding the same rows choose the same survivor). Fields the
    survivor lacks are filled from the discarded rows and their tags are merged.

    The DELETEs run with the sync guard raised: op-log / tombstone capture is
    skipped on purpose. Every device runs this same migration on its own copy;
    if each captured a delete, a machine that kept row X would receive "delete X"
    from the machine that kept row Y and lose the pin entirely.
    """
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT p.*, (SELECT COUNT(*) FROM pinned_asset_tags t WHERE t.asset_id = p.id) AS n_tags "
        "FROM pinned_assets p"
    ).fetchall()
    by_sym: dict[str, list[sqlite3.Row]] = {}
    for r in rows:
        by_sym.setdefault(str(r["symbol"] or "").strip().upper(), []).append(r)

    def info(r) -> int:
        return (bool(r["comment"]) + (r["buy_target"] is not None) + (r["sell_target"] is not None)
                + (r["price_at_pin"] is not None) + (r["n_tags"] or 0))

    doomed: list[str] = []
    for sym, group in by_sym.items():
        if len(group) < 2:
            continue
        group.sort(key=lambda r: str(r["id"]))
        group.sort(key=lambda r: str(r["updated_at"] or ""), reverse=True)
        group.sort(key=info, reverse=True)  # stable: info desc, then updated desc, then id asc
        keep, rest = group[0], group[1:]
        fill: dict = {}
        for col in ("comment", "buy_target", "sell_target", "price_at_pin"):
            if keep[col] in (None, ""):
                for r in rest:
                    if r[col] not in (None, ""):
                        fill[col] = r[col]
                        break
        if fill:
            sets = ", ".join(f"{c} = ?" for c in fill)
            conn.execute(f"UPDATE pinned_assets SET {sets} WHERE id = ?", [*fill.values(), keep["id"]])
        for r in rest:
            conn.execute(
                "INSERT OR IGNORE INTO pinned_asset_tags (asset_id, tag_id) "
                "SELECT ?, tag_id FROM pinned_asset_tags WHERE asset_id = ?",
                (keep["id"], r["id"]),
            )
            doomed.append(r["id"])

    if doomed:
        has_guard = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='_sync_guard'"
        ).fetchone()
        if has_guard:
            conn.execute("UPDATE _sync_guard SET active = 1")
        try:
            for pid in doomed:
                conn.execute("DELETE FROM pinned_asset_tags WHERE asset_id = ?", (pid,))
                conn.execute("DELETE FROM pinned_assets WHERE id = ?", (pid,))
        finally:
            if has_guard:
                conn.execute("UPDATE _sync_guard SET active = 0")
    # normalise stray case/whitespace so the unique index means what it says
    conn.execute("UPDATE pinned_assets SET symbol = UPPER(TRIM(symbol)) WHERE symbol != UPPER(TRIM(symbol))")
    return len(doomed)


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
        conn.execute("CREATE INDEX IF NOT EXISTS idx_pa_group_sort ON pinned_assets(group_id, sort_order)")
        dedupe_pinned_assets(conn)
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_pa_symbol ON pinned_assets(symbol)")

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


def _migrate_option_positions(conn: sqlite3.Connection) -> None:
    """One-way move of the flat `option_positions` rows into the normalized
    tables, then drop the old table.

    Runs only while `option_positions` still exists, so it is a no-op on every
    start after the first. Greeks for migrated trades are recorded as
    `source='unavailable'` with every value NULL: the market state at those
    entries was never captured and — like iv_snapshots — cannot be recovered.
    """
    if not conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='option_positions'"
    ).fetchone():
        return

    import uuid as _uuid

    rows = [dict(r) for r in conn.execute("SELECT * FROM option_positions").fetchall()]
    id_map: dict[str, str] = {}          # old position id → new OPEN trade id

    for row in rows:
        under = str(row.get("underlying") or "").upper()
        expiry = str(row.get("expiry") or "")[:10]
        strike = float(row.get("strike") or 0)
        otype = str(row.get("option_type") or "call")
        mult = float(row.get("multiplier") or 100) or 100.0
        ccy = str(row.get("currency") or "USD").upper()
        occ = occ_symbol(under, expiry, strike, otype)

        found = conn.execute(
            "SELECT contract_id FROM option_contracts WHERE occ_symbol = ?", (occ,)
        ).fetchone()
        if found:
            contract_id = found["contract_id"]
        else:
            contract_id = str(_uuid.uuid4())
            conn.execute(
                """INSERT INTO option_contracts
                   (contract_id, occ_symbol, underlying, expiry, strike,
                    option_type, multiplier, currency)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (contract_id, occ, under, expiry, strike, otype, mult, ccy),
            )

        qty = float(row.get("quantity") or 0)
        if qty == 0:
            continue
        # The old column was signed; direction now lives in action+side.
        side = "BUY" if qty > 0 else "SELL"
        open_id = str(_uuid.uuid4())
        id_map[str(row.get("id"))] = open_id
        conn.execute(
            """INSERT INTO option_trades
               (trade_id, contract_id, account_id, trade_date, action, side,
                quantity, price, note)
               VALUES (?,?,?,?, 'OPEN', ?, ?, ?, ?)""",
            (
                open_id, contract_id, row.get("account_id") or "dime",
                str(row.get("entry_date") or "")[:10], side,
                abs(qty), float(row.get("entry_price") or 0),
                str(row.get("notes") or ""),
            ),
        )
        conn.execute(
            "INSERT INTO option_trade_greeks (trade_id, source) VALUES (?, 'unavailable')",
            (open_id,),
        )

        status = str(row.get("status") or "open")
        if status == "open":
            continue

        # Closed rows become a CLOSE trade plus a full-size match. A row closed
        # before exit_price existed keeps price NULL and close_reason 'UNKNOWN'
        # — its realized P&L is unknown, and writing 0 there would report a
        # 100% loss that never happened.
        exit_price = row.get("exit_price")
        close_id = str(_uuid.uuid4())
        conn.execute(
            """INSERT INTO option_trades
               (trade_id, contract_id, account_id, trade_date, action, side,
                quantity, price, close_reason, note)
               VALUES (?,?,?,?, 'CLOSE', ?, ?, ?, ?, ?)""",
            (
                close_id, contract_id, row.get("account_id") or "dime",
                str(row.get("exit_date") or row.get("expiry") or "")[:10],
                "SELL" if qty > 0 else "BUY",
                abs(qty), exit_price,
                "TRADE" if exit_price is not None
                else ("EXPIRED" if status == "expired" else "UNKNOWN"),
                "migrated from option_positions",
            ),
        )
        conn.execute(
            "INSERT INTO option_trade_greeks (trade_id, source) VALUES (?, 'unavailable')",
            (close_id,),
        )
        realized = (
            (float(exit_price) - float(row.get("entry_price") or 0)) * qty * mult
            if exit_price is not None else None
        )
        conn.execute(
            """INSERT INTO option_trade_matches
               (close_trade_id, open_trade_id, quantity, realized_pnl)
               VALUES (?,?,?,?)""",
            (close_id, open_id, abs(qty), realized),
        )

    # Daily greeks history keyed the old position id; without this remap the
    # attribution chart goes quietly empty — the join simply finds nothing.
    for old_id, new_id in id_map.items():
        conn.execute(
            "UPDATE option_greeks_snapshots SET position_id = ? WHERE position_id = ?",
            (new_id, old_id),
        )

    conn.execute("DROP TABLE option_positions")
    logger_msg = f"[option-migration] moved {len(rows)} row(s) into the normalized schema"
    print(logger_msg)


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
        # Broker fees in the instrument currency. Kept out of price_entry: the
        # broker's own cost basis is qty x price (Dime shows it that way).
        # fee_exit is already inside pnl_amount; fee_entry is charged to
        # realized P&L on the buy date (see broker_fees.py).
        _ensure_column(conn, "trades", "fee_entry", "fee_entry REAL")
        _ensure_column(conn, "trades", "fee_exit", "fee_exit REAL")
        _ensure_column(conn, "trades", "fee_detail", "fee_detail TEXT")
        # In-kind transfer of a portfolio taken over for management (fund
        # practice): price_entry/amount = fair value on the transfer date, so
        # returns start there. Both per-unit memo prices stay fixed even when
        # AVCO later rebases price_entry, so the pre-takeover loss is stable:
        # inherited = (transfer_price_entry - original_price_entry) x volume.
        _ensure_column(conn, "trades", "acquisition_type", "acquisition_type TEXT")
        _ensure_column(conn, "trades", "original_price_entry", "original_price_entry REAL")
        _ensure_column(conn, "trades", "transfer_price_entry", "transfer_price_entry REAL")
        # What the lot actually cost per unit when bought. price_entry is the
        # pooled AVCO (rewritten by every sale); lot_price never is, so the
        # position can be replayed by date (avco_replay.py). NULL on rows older
        # than 2026-09-28 until the first replay backfills it from the audit log.
        _ensure_column(conn, "trades", "lot_price", "lot_price REAL")
        # Provenance of a trade row. broker_order_ref is NOT unique here: a
        # partial sell splits one buy into two rows that share the order.
        # Uniqueness lives on broker_executions (one order = one evidence row);
        # create_trade refuses an order number already in the book.
        # executed_at = fill time with its offset (date_entry stays the trade
        # date); entry_source = manual | slip | excel, NULL for older rows.
        _ensure_column(conn, "trades", "broker_order_ref", "broker_order_ref TEXT")
        _ensure_column(conn, "trades", "executed_at", "executed_at TEXT")
        _ensure_column(conn, "trades", "entry_source", "entry_source TEXT")
        _ensure_column(conn, "trades", "source_sha256", "source_sha256 TEXT")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_trades_order_ref ON trades(account_id, broker_order_ref) "
                     "WHERE broker_order_ref IS NOT NULL")
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
        # Cash reconciliation. Idle cash is DERIVED (invested + realized +
        # dividends − open cost); each row here is the offset that brought that
        # derived number to the balance the broker actually showed on `date`.
        # Deliberately NOT cash_ledger rows: an offset is not capital paid in, so
        # it must not move invested capital, XIRR or CAGR. Amount is in
        # `currency` (the currency the user reconciled in).
        conn.execute("""
            CREATE TABLE IF NOT EXISTS cash_adjustments (
                id             TEXT PRIMARY KEY,
                account_id     TEXT NOT NULL,
                date           TEXT NOT NULL,
                amount         REAL NOT NULL DEFAULT 0,
                currency       TEXT NOT NULL DEFAULT 'THB',
                target_balance REAL,
                derived_before REAL,
                category       TEXT NOT NULL DEFAULT 'UNKNOWN',
                note           TEXT DEFAULT '',
                created_at     TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cash_adj_account ON cash_adjustments(account_id)")
        _ensure_column(conn, "cash_adjustments", "category", "category TEXT NOT NULL DEFAULT 'UNKNOWN'")
        # Broker evidence is versioned by append, so a correction retains the
        # original statement and points to it via supersedes_id. Currency is
        # the account's native currency; positions are a complete day-end list.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS broker_statements (
                id              TEXT PRIMARY KEY,
                account_id      TEXT NOT NULL REFERENCES portfolio_accounts(id),
                as_of           TEXT NOT NULL,
                currency        TEXT NOT NULL,
                cash            TEXT NOT NULL,
                market_value    TEXT NOT NULL,
                holdings_json   TEXT NOT NULL,
                source_ref      TEXT NOT NULL,
                source_note     TEXT NOT NULL DEFAULT '',
                supersedes_id   TEXT REFERENCES broker_statements(id),
                created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
                updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_broker_statement_day ON broker_statements(account_id, as_of)")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_broker_statement_revision ON broker_statements(supersedes_id) WHERE supersedes_id IS NOT NULL")
        # A broker activity screenshot proves an execution, not its funding
        # wallet, settlement cash or cost-lot allocation. Keep each fill as
        # cited evidence until those facts can be reconciled with legacy lots.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS broker_executions (
                id                TEXT PRIMARY KEY,
                account_id        TEXT NOT NULL REFERENCES portfolio_accounts(id),
                broker            TEXT NOT NULL,
                symbol            TEXT NOT NULL,
                side              TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
                executed_at_local TEXT NOT NULL,
                display_timezone  TEXT NOT NULL,
                quantity          TEXT NOT NULL,
                unit_price        TEXT NOT NULL,
                instrument_ccy    TEXT NOT NULL,
                order_amount      TEXT,
                order_ccy         TEXT,
                source_image      TEXT NOT NULL,
                source_sha256     TEXT NOT NULL,
                source_note       TEXT NOT NULL DEFAULT '',
                created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
                updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
                UNIQUE(account_id, symbol, side, executed_at_local, quantity, unit_price)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_broker_executions_date ON broker_executions(account_id, executed_at_local)")
        # Order-slip evidence (slip_evidence.py): an order detail screen shows
        # more than an Activity row — the broker's order number, the value
        # before rounding and each fee. One broker order is one evidence row,
        # so the order number is unique per account; trade_id links the book
        # row it was entered as (NULL again if that trade is deleted).
        for col, ddl in (("order_ref", "order_ref TEXT"), ("gross_value", "gross_value TEXT"),
                         ("commission", "commission TEXT"), ("vat", "vat TEXT"),
                         ("sec_fee", "sec_fee TEXT"), ("taf_fee", "taf_fee TEXT"),
                         ("exchange", "exchange TEXT"), ("order_type", "order_type TEXT"),
                         ("trade_id", "trade_id TEXT"), ("extractor", "extractor TEXT")):
            _ensure_column(conn, "broker_executions", col, ddl)
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_broker_executions_order_ref "
                     "ON broker_executions(account_id, order_ref) WHERE order_ref IS NOT NULL")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_broker_executions_trade ON broker_executions(trade_id)")
        # Row-level change log for every money table, written by triggers (see
        # init_audit_layer) so no endpoint — present or future — can skip it.
        # Append-only; `event_id` is a uuid so the log syncs as a union.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS audit_events (
                event_id   TEXT PRIMARY KEY,
                table_name TEXT NOT NULL,
                row_id     TEXT NOT NULL,
                account_id TEXT,
                action     TEXT NOT NULL CHECK(action IN ('INSERT','UPDATE','DELETE')),
                old_data   TEXT,
                new_data   TEXT,
                reason     TEXT,
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_events(created_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_row ON audit_events(table_name, row_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_account ON audit_events(account_id, created_at)")
        # One-row side channel for the human reason behind a write. Set and
        # cleared inside the same transaction by `audit_reason()`; SQLite
        # serialises writers, so a reason cannot leak into another request.
        conn.execute("CREATE TABLE IF NOT EXISTS _audit_context (reason TEXT)")
        if conn.execute("SELECT COUNT(*) FROM _audit_context").fetchone()[0] == 0:
            conn.execute("INSERT INTO _audit_context (reason) VALUES (NULL)")
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

        # `option_positions` is deliberately NOT created here any more. It was
        # replaced by the normalized tables below; _migrate_option_positions()
        # moves any surviving rows and drops it. Re-creating it would have the
        # migration drop an empty table on every single start.

        # ── Normalized option schema (2026-09-10) ────────────────────────────
        # `option_positions` crammed three different levels into one flat row:
        # the INSTRUMENT (a contract, shared by every trade on it), the
        # EXECUTION (one buy or sell), and the LOT LIFECYCLE (open → closed).
        # That made partial closes impossible (one row holds one exit_price),
        # left no room for the market state at entry, and let editing a price
        # silently rewrite realized P&L that had already been reported.
        #
        # Split three ways, with the lot DERIVED rather than stored:
        #   option_contracts     — the instrument, deduplicated
        #   option_trades        — one immutable row per execution
        #   option_trade_greeks  — the market state at that execution (1:1)
        #   option_trade_matches — which close consumed which open (FIFO)
        #
        # A "lot" is an OPEN trade that is not yet fully matched, which is what
        # v_option_open_lots computes. `status` therefore does not exist as a
        # column: expiry and exercise are CLOSE trades like any other, so every
        # end of a lot is a row someone can point at.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS option_contracts (
                contract_id  TEXT PRIMARY KEY,
                occ_symbol   TEXT NOT NULL UNIQUE,
                underlying   TEXT NOT NULL,
                expiry       TEXT NOT NULL,
                strike       REAL NOT NULL,
                option_type  TEXT NOT NULL CHECK(option_type IN ('call','put')),
                multiplier   REAL NOT NULL DEFAULT 100,
                currency     TEXT NOT NULL DEFAULT 'USD',
                created_at   TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(underlying, expiry, strike, option_type)
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_oc_underlying ON option_contracts(underlying)"
        )

        # `quantity` is ALWAYS positive; direction comes from action+side:
        #   OPEN/BUY  = open long      OPEN/SELL  = open short (credit received)
        #   CLOSE/SELL = close a long  CLOSE/BUY  = close a short
        # `price` is nullable only for a close whose price is genuinely unknown
        # (close_reason='UNKNOWN') — lots closed by the pre-2026-09-09 endpoint,
        # which recorded no price. Unknown is not zero, and must not be reported
        # as a 100% loss.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS option_trades (
                trade_id      TEXT PRIMARY KEY,
                contract_id   TEXT NOT NULL REFERENCES option_contracts(contract_id),
                account_id    TEXT NOT NULL,
                trade_date    TEXT NOT NULL,
                action        TEXT NOT NULL CHECK(action IN ('OPEN','CLOSE')),
                side          TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
                quantity      REAL NOT NULL CHECK(quantity > 0),
                price         REAL,
                fees          REAL NOT NULL DEFAULT 0,
                exchange_rate REAL,
                close_reason  TEXT CHECK(close_reason IN
                                  ('TRADE','EXPIRED','EXERCISED','ASSIGNED','UNKNOWN')),
                note          TEXT NOT NULL DEFAULT '',
                created_at    TEXT NOT NULL DEFAULT (datetime('now')),
                CHECK (action = 'CLOSE' OR price IS NOT NULL),
                CHECK (action = 'OPEN'  OR close_reason IS NOT NULL),
                CHECK (price IS NOT NULL OR close_reason = 'UNKNOWN')
            )
        """)
        for col in ("contract_id", "account_id", "trade_date", "action"):
            conn.execute(
                f"CREATE INDEX IF NOT EXISTS idx_ot_{col} ON option_trades({col})"
            )

        conn.execute("""
            CREATE TABLE IF NOT EXISTS option_trade_greeks (
                trade_id    TEXT PRIMARY KEY
                            REFERENCES option_trades(trade_id) ON DELETE CASCADE,
                spot        REAL,
                iv          REAL,
                delta       REAL,
                gamma       REAL,
                theta       REAL,
                vega        REAL,
                rho         REAL,
                source      TEXT NOT NULL DEFAULT 'live'
                            CHECK(source IN ('live','manual','unavailable')),
                captured_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)

        # realized_pnl is materialized rather than derived from a join. Derived,
        # a later edit to a trade's price would silently rewrite P&L that has
        # already been reported; stored, correcting a price has to be an
        # intentional re-match. NULL means genuinely unknown (see UNKNOWN above),
        # which is not the same as zero.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS option_trade_matches (
                close_trade_id TEXT NOT NULL
                               REFERENCES option_trades(trade_id) ON DELETE CASCADE,
                open_trade_id  TEXT NOT NULL
                               REFERENCES option_trades(trade_id) ON DELETE CASCADE,
                quantity       REAL NOT NULL CHECK(quantity > 0),
                fees_alloc     REAL NOT NULL DEFAULT 0,
                realized_pnl   REAL,
                matched_at     TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (close_trade_id, open_trade_id)
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_otm_open ON option_trade_matches(open_trade_id)"
        )

        # A lot is an OPEN trade with quantity left to close. Deriving it means
        # there is no second copy of the remaining size to drift out of step
        # with the trades that produced it.
        conn.execute("DROP VIEW IF EXISTS v_option_open_lots")
        conn.execute("""
            CREATE VIEW v_option_open_lots AS
            SELECT
                t.trade_id                                     AS lot_id,
                t.trade_id                                     AS open_trade_id,
                t.contract_id, t.account_id,
                c.underlying, c.expiry, c.strike, c.option_type,
                c.multiplier, c.currency, c.occ_symbol,
                t.trade_date                                   AS entry_date,
                t.price                                        AS entry_price,
                t.fees                                         AS entry_fees,
                t.exchange_rate                                AS entry_exchange_rate,
                t.note,
                CASE WHEN t.side = 'BUY' THEN 1 ELSE -1 END    AS direction,
                (t.quantity - COALESCE(m.matched, 0))
                    * CASE WHEN t.side = 'BUY' THEN 1 ELSE -1 END AS quantity,
                t.quantity                                     AS quantity_opened,
                COALESCE(m.matched, 0)                         AS quantity_closed,
                g.spot   AS entry_spot,  g.iv    AS entry_iv,
                g.delta  AS entry_delta, g.gamma AS entry_gamma,
                g.theta  AS entry_theta, g.vega  AS entry_vega,
                g.rho    AS entry_rho,   g.source AS entry_greeks_source
            FROM option_trades t
            JOIN option_contracts c ON c.contract_id = t.contract_id
            LEFT JOIN option_trade_greeks g ON g.trade_id = t.trade_id
            LEFT JOIN (
                SELECT open_trade_id, SUM(quantity) AS matched
                FROM option_trade_matches GROUP BY open_trade_id
            ) m ON m.open_trade_id = t.trade_id
            WHERE t.action = 'OPEN'
              AND t.quantity - COALESCE(m.matched, 0) > 1e-9
        """)

        conn.execute("DROP VIEW IF EXISTS v_option_realized")
        conn.execute("""
            CREATE VIEW v_option_realized AS
            SELECT
                mt.close_trade_id, mt.open_trade_id,
                mt.quantity, mt.fees_alloc, mt.realized_pnl,
                ct.account_id, ct.trade_date AS exit_date, ct.price AS exit_price,
                ct.close_reason, ct.exchange_rate AS exit_exchange_rate,
                ot.trade_date AS entry_date, ot.price AS entry_price,
                CASE WHEN ot.side = 'BUY' THEN 1 ELSE -1 END AS direction,
                c.contract_id, c.underlying, c.expiry, c.strike, c.option_type,
                c.multiplier, c.currency, c.occ_symbol
            FROM option_trade_matches mt
            JOIN option_trades ct ON ct.trade_id = mt.close_trade_id
            JOIN option_trades ot ON ot.trade_id = mt.open_trade_id
            JOIN option_contracts c ON c.contract_id = ot.contract_id
        """)

        # Provenance of an option fill, the same four facts trades carries:
        # executed_at = fill time with its offset as the broker displayed it
        # (trade_date stays the exchange date); settle_date = the day the cash
        # moved; broker_order_ref = the broker's order number, unique per
        # account; entry_source = manual | slip | excel, NULL for older rows.
        for col, ddl in (("executed_at", "executed_at TEXT"),
                         ("settle_date", "settle_date TEXT"),
                         ("broker_order_ref", "broker_order_ref TEXT"),
                         ("entry_source", "entry_source TEXT")):
            _ensure_column(conn, "option_trades", col, ddl)
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_ot_order_ref "
                     "ON option_trades(account_id, broker_order_ref) "
                     "WHERE broker_order_ref IS NOT NULL")

        # Fee breakdown of one fill. `option_trades.fees` (and trades.fee_entry
        # / fee_exit) stays the single number every P&L path reads; these rows
        # say what it is made of and how sure we are of each part, and
        # accounting check F1 holds the two equal.
        #
        # A broker slip shows fees "pending, estimated" (basis ESTIMATED); the
        # broker later debits the real amount as its own cash line (POSTED),
        # which can differ by cents and may be a daily total across fills.
        # When both exist for a component the POSTED one wins. amount is a
        # decimal string in the fill's currency: a cost is positive, a promo
        # that cancels a commission is a negative COMMISSION_DISCOUNT row, so
        # the waived commission stays visible instead of reading as "free".
        # source: SLIP (read off the order confirmation), BROKER_POSTING (cash
        # activity line), SCHEDULE (computed from a fitted fee schedule, no
        # confirmation seen), MANUAL. leg: FILL for a one-fill row
        # (option_trades), ENTRY / EXIT for the two legs a trades row holds.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS trade_fee_items (
                id           TEXT PRIMARY KEY,
                account_id   TEXT NOT NULL,
                trade_table  TEXT NOT NULL CHECK(trade_table IN ('trades','option_trades')),
                trade_id     TEXT NOT NULL,
                leg          TEXT NOT NULL CHECK(leg IN ('FILL','ENTRY','EXIT')),
                component    TEXT NOT NULL CHECK(component IN
                                 ('COMMISSION','COMMISSION_DISCOUNT','VAT','SEC','TAF',
                                  'ORF','OCC','EXCHANGE','OTHER')),
                amount       TEXT NOT NULL,
                currency     TEXT NOT NULL,
                basis        TEXT NOT NULL CHECK(basis IN ('ESTIMATED','POSTED')),
                source       TEXT NOT NULL CHECK(source IN
                                 ('SLIP','BROKER_POSTING','SCHEDULE','MANUAL')),
                evidence_id  TEXT,
                note         TEXT NOT NULL DEFAULT '',
                created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
                UNIQUE(trade_table, trade_id, leg, component, basis)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tfi_trade "
                     "ON trade_fee_items(trade_table, trade_id)")

        # broker_executions began as stock fills. An option order slip is the
        # same kind of evidence with a contract instead of a ticker: symbol is
        # the OCC symbol, quantity is contracts, unit_price the per-share
        # premium. It also shows fees a stock slip has no field for (OCC
        # clearing, ORF) and a commission cancelled by a promo, plus when the
        # order was sent as well as filled and the settlement date.
        for col, ddl in (("instrument_type",
                          "instrument_type TEXT NOT NULL DEFAULT 'STOCK' "
                          "CHECK(instrument_type IN ('STOCK','OPTION'))"),
                         ("option_trade_id", "option_trade_id TEXT"),
                         ("commission_discount", "commission_discount TEXT"),
                         ("occ_fee", "occ_fee TEXT"),
                         ("orf_fee", "orf_fee TEXT"),
                         ("submitted_at_local", "submitted_at_local TEXT"),
                         ("settle_date", "settle_date TEXT")):
            _ensure_column(conn, "broker_executions", col, ddl)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_broker_executions_option_trade "
                     "ON broker_executions(option_trade_id)")

        _migrate_option_positions(conn)

        # Greeks history. P&L attribution needs the state at the START of each
        # period (spot, IV and the greeks computed from them) and none of that
        # can be reconstructed later — Yahoo serves only the CURRENT chain, so
        # like iv_snapshots this can only be ACCUMULATED, never back-filled.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS option_greeks_snapshots (
                position_id      TEXT NOT NULL,
                snapshot_date    TEXT NOT NULL,
                account_id       TEXT,
                underlying       TEXT,
                expiry           TEXT,
                strike           REAL,
                option_type      TEXT,
                quantity         REAL,
                multiplier       REAL,
                currency         TEXT,
                spot             REAL,
                iv               REAL,
                mark             REAL,
                delta            REAL,
                gamma            REAL,
                theta            REAL,
                vega             REAL,
                market_value_usd REAL,
                created_at       TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (position_id, snapshot_date)
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ogs_date ON option_greeks_snapshots(snapshot_date)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ogs_account ON option_greeks_snapshots(account_id)"
        )

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
        # 'live' = captured on the day; 'backfill' = rebuilt later from closing
        # prices (scripts/backfill_nav.py). The UI labels backfilled days as
        # estimates — nobody looked at the book on those days.
        _ensure_column(conn, "portfolio_nav_snapshots", "source",
                       "source TEXT NOT NULL DEFAULT 'live'")

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
        # Mirror the live table so paper and live value on the same basis.
        _ensure_column(conn, "paper_option_positions", "currency",   "currency TEXT NOT NULL DEFAULT 'USD'")
        _ensure_column(conn, "paper_option_positions", "multiplier", "multiplier REAL NOT NULL DEFAULT 100")

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
        # The autoincrement `id` is device-local: two machines both write id 42
        # for different events, so it cannot key a sync. `event_id` is a uuid
        # that identifies the event itself, which is what lets the log travel.
        # Rows are append-only (nothing UPDATEs one), so merging is a union.
        _ensure_column(conn, "trade_audit_log", "event_id", "event_id TEXT")
        stale = [
            r[0] for r in conn.execute(
                "SELECT id FROM trade_audit_log WHERE event_id IS NULL OR event_id = ''"
            ).fetchall()
        ]
        if stale:
            import uuid as _uuid
            conn.executemany(
                "UPDATE trade_audit_log SET event_id = ? WHERE id = ?",
                [(str(_uuid.uuid4()), i) for i in stale],
            )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_tal_event ON trade_audit_log(event_id)"
        )

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

        _init_ledger_events(conn)

        # No default accounts — users create their own via the portfolio UI
        # (POST /api/v2/portfolio/accounts).


LEDGER_EVENT_TYPES: tuple[str, ...] = (
    "DEPOSIT", "WITHDRAW", "TRANSFER_IN", "TRANSFER_OUT",
    "BUY", "SELL", "DIVIDEND", "WHT", "FEE", "INTEREST",
    "FX_CONVERT", "SPLIT", "ADJUST", "REVERSAL",
    # v2 (plans/port-ledger-v2.md)
    "OPENING", "OPTION_EXPIRE", "ASSIGN", "EXERCISE",
)
LEDGER_SOURCES: tuple[str, ...] = ("MANUAL", "IMPORT", "BACKFILL", "BACKFILL_ESTIMATE", "SHADOW")
LEDGER_MODES: tuple[str, ...] = ("LEGACY", "SHADOW", "PRIMARY")
# Legacy tables whose writes are projected into the ledger for SHADOW accounts.
LEDGER_PROJECTED_TABLES: tuple[str, ...] = (
    "trades", "cash_ledger", "dividends", "cash_adjustments", "option_trades",
)
_NOW_MS = "strftime('%Y-%m-%d %H:%M:%f','now')"


def _ledger_events_ddl(table: str = "ledger_events") -> str:
    types = ",".join(f"'{t}'" for t in LEDGER_EVENT_TYPES)
    sources = ",".join(f"'{s}'" for s in LEDGER_SOURCES)
    # Money and quantities are canonical decimal strings (ledger.py writes them
    # with Decimal), the same as broker_statements: a REAL column cannot hold
    # 0.1 exactly, and "equal to the statement" must mean equal, not close.
    return f"""
        CREATE TABLE IF NOT EXISTS {table} (
            id              TEXT PRIMARY KEY,
            account_id      TEXT NOT NULL,
            wallet          TEXT NOT NULL,
            trade_date      TEXT NOT NULL,
            book_date       TEXT NOT NULL,
            settle_date     TEXT,
            trade_time      TEXT,
            type            TEXT NOT NULL CHECK(type IN ({types})),
            symbol          TEXT,
            qty             TEXT,
            price           TEXT,
            multiplier      TEXT,
            position_effect TEXT CHECK(position_effect IS NULL OR position_effect IN ('OPEN','CLOSE')),
            gross           TEXT,
            fee             TEXT NOT NULL DEFAULT '0',
            vat             TEXT NOT NULL DEFAULT '0',
            tax             TEXT NOT NULL DEFAULT '0',
            fee_basis       TEXT CHECK(fee_basis IS NULL OR fee_basis IN ('ESTIMATED','POSTED')),
            net_cash        TEXT NOT NULL DEFAULT '0',
            currency        TEXT NOT NULL,
            fx_rate         TEXT,
            broker_ref      TEXT,
            link_id         TEXT,
            reverses_id     TEXT,
            category        TEXT,
            evidence_ref    TEXT,
            source          TEXT NOT NULL DEFAULT 'MANUAL' CHECK(source IN ({sources})),
            source_key      TEXT,
            source_ref      TEXT,
            note            TEXT NOT NULL DEFAULT '',
            created_at      TEXT NOT NULL DEFAULT ({_NOW_MS}),
            updated_at      TEXT NOT NULL DEFAULT ({_NOW_MS})
        )
    """


def _append_only(conn: sqlite3.Connection, table: str) -> None:
    for op in ("UPDATE", "DELETE"):
        conn.execute(f"DROP TRIGGER IF EXISTS trg_{table}_no_{op.lower()}")
        conn.execute(f"""
            CREATE TRIGGER trg_{table}_no_{op.lower()}
            BEFORE {op} ON {table}
            WHEN (SELECT active FROM _ledger_guard LIMIT 1) = 0
            BEGIN
                SELECT RAISE(ABORT, '{table} is append-only: post a REVERSAL instead');
            END
        """)


def _init_ledger_events(conn: sqlite3.Connection) -> None:
    """Append-only journal (plans/port-ledger-v2.md).

    One row per economic event, never edited: a mistake is corrected by a
    REVERSAL row pointing at it plus a fresh row. Positions, average cost and
    cash are all derived from this table, so it can be replayed at any time.

    * `net_cash` is signed (in +, out −) in `currency`, inside `wallet` — Dime
      keeps USD, FCD and a THB saving account apart, and a buy is paid from one.
    * `trade_date` is when it happened; `book_date` is the accounting day it
      lands on. They differ only for a correction to a closed period, which is
      booked today so the closed balance never moves.
    * `source_key` names the legacy row(s) a SHADOW/BACKFILL event projects;
      MANUAL events have none and projection never touches them.
    """
    conn.execute("CREATE TABLE IF NOT EXISTS _ledger_guard (active INTEGER NOT NULL)")
    if conn.execute("SELECT COUNT(*) FROM _ledger_guard").fetchone()[0] == 0:
        conn.execute("INSERT INTO _ledger_guard (active) VALUES (0)")
    # Same DDL as init_sync_layer: the lock and dirty triggers below read it,
    # and a DB initialised without the sync layer (tests, scripts) must work.
    conn.execute("CREATE TABLE IF NOT EXISTS _sync_guard (active INTEGER NOT NULL)")
    if conn.execute("SELECT COUNT(*) FROM _sync_guard").fetchone()[0] == 0:
        conn.execute("INSERT INTO _sync_guard (active) VALUES (0)")

    cols = _table_columns(conn, "ledger_events")
    if cols and "wallet" not in cols:
        # v1 table. It never held posted rows on any machine (2026-09-29), so
        # an empty one is simply rebuilt; a non-empty one is kept and migrated.
        n = conn.execute("SELECT COUNT(*) FROM ledger_events").fetchone()[0]
        for op in ("update", "delete"):
            conn.execute(f"DROP TRIGGER IF EXISTS trg_ledger_events_no_{op}")
        conn.execute("DROP INDEX IF EXISTS idx_le_broker_ref")
        if n == 0:
            conn.execute("DROP TABLE ledger_events")
        else:
            conn.execute("ALTER TABLE ledger_events RENAME TO ledger_events_v1")
            conn.execute(_ledger_events_ddl())
            keep = [c for c in _table_columns(conn, "ledger_events_v1")
                    if c in _table_columns(conn, "ledger_events")]
            sel = ", ".join(keep)
            conn.execute(
                f"INSERT INTO ledger_events ({sel}, wallet, book_date) "
                f"SELECT {sel}, currency, trade_date FROM ledger_events_v1"
            )
            conn.execute("DROP TABLE ledger_events_v1")
    conn.execute(_ledger_events_ddl())
    conn.execute("CREATE INDEX IF NOT EXISTS idx_le_pos ON ledger_events(account_id, symbol, trade_date)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_le_date ON ledger_events(account_id, trade_date)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_le_book ON ledger_events(account_id, wallet, book_date)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_le_source_key ON ledger_events(account_id, source_key)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_le_broker_ref2 ON ledger_events(account_id, broker_ref)")
    # An event is reversed at most once — a second reversal would double the fix.
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_le_reverses "
                 "ON ledger_events(reverses_id) WHERE reverses_id IS NOT NULL")
    # Immutability lives in the DB, not the API, so no future endpoint or
    # script can quietly rewrite history. `_ledger_guard.active = 1` is the one
    # maintenance escape hatch (backfill --replace), set and cleared inside a
    # single transaction.
    _append_only(conn, "ledger_events")

    # Period close: a wallet's balance agreed with a broker statement up to a
    # day. Append-only too — reopening is a new row with an earlier date and a
    # reason, so who moved the line, and why, stays on record.
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS ledger_period_close (
            id             TEXT PRIMARY KEY,
            account_id     TEXT NOT NULL,
            wallet         TEXT NOT NULL,
            currency       TEXT NOT NULL,
            action         TEXT NOT NULL CHECK(action IN ('CLOSE','REOPEN')),
            closed_through TEXT,
            balance        TEXT,
            statement_id   TEXT,
            source_ref     TEXT,
            reason         TEXT NOT NULL DEFAULT '',
            created_at     TEXT NOT NULL DEFAULT ({_NOW_MS}),
            updated_at     TEXT NOT NULL DEFAULT ({_NOW_MS})
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_lpc_wallet "
                 "ON ledger_period_close(account_id, wallet, created_at)")
    _append_only(conn, "ledger_period_close")

    # Wallets per account. A row is a setting (edited in place → synced LWW).
    # Without one, an event's wallet is its currency code.
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS ledger_wallets (
            account_id TEXT NOT NULL,
            wallet     TEXT NOT NULL,
            currency   TEXT NOT NULL,
            is_default INTEGER NOT NULL DEFAULT 0,
            note       TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ({_NOW_MS}),
            PRIMARY KEY (account_id, wallet)
        )
    """)

    # Rows whose book_date falls inside a closed period are refused. Local
    # writes only: a peer's event that was posted before it saw our close
    # still lands (refusing it would split the devices for good) and check L3
    # reports it for review.
    conn.execute("DROP TRIGGER IF EXISTS trg_ledger_events_period_lock")
    conn.execute("""
        CREATE TRIGGER trg_ledger_events_period_lock
        BEFORE INSERT ON ledger_events
        WHEN (SELECT active FROM _sync_guard LIMIT 1) = 0
         AND (SELECT active FROM _ledger_guard LIMIT 1) = 0
         AND NEW.book_date <= COALESCE((
                SELECT closed_through FROM ledger_period_close
                WHERE account_id = NEW.account_id AND wallet = NEW.wallet
                ORDER BY created_at DESC, rowid DESC LIMIT 1), '')
        BEGIN
            SELECT RAISE(ABORT, 'LEDGER_PERIOD_CLOSED');
        END
    """)
    # A reversal must point at a live, non-reversal event in the same wallet.
    conn.execute("DROP TRIGGER IF EXISTS trg_ledger_events_reversal_target")
    conn.execute("""
        CREATE TRIGGER trg_ledger_events_reversal_target
        BEFORE INSERT ON ledger_events
        WHEN NEW.type = 'REVERSAL'
         AND (SELECT active FROM _sync_guard LIMIT 1) = 0
         AND NOT EXISTS (SELECT 1 FROM ledger_events o
                         WHERE o.id = NEW.reverses_id AND o.type <> 'REVERSAL'
                           AND o.account_id = NEW.account_id AND o.wallet = NEW.wallet
                           AND o.currency = NEW.currency)
        BEGIN
            SELECT RAISE(ABORT, 'LEDGER_BAD_REVERSAL');
        END
    """)

    # Which accounts write to the ledger. LEGACY = not at all, SHADOW = every
    # legacy write is projected in the same transaction, PRIMARY = the ledger
    # is the book (read switch; not enabled until a pilot passes).
    _ensure_column(conn, "portfolio_accounts", "ledger_mode",
                   "ledger_mode TEXT NOT NULL DEFAULT 'LEGACY'")
    # First day of the journal: earlier history is summed into OPENING events
    # from a broker statement rather than replayed from legacy rows.
    _ensure_column(conn, "portfolio_accounts", "ledger_cutover", "ledger_cutover TEXT")
    _ensure_column(conn, "portfolio_accounts", "ledger_cutover_baseline", "ledger_cutover_baseline TEXT")
    # The statement's moment (UTC). A trade dated the cutover day but filled
    # after it is not in the OPENING balances (ledger._in_opening).
    _ensure_column(conn, "portfolio_accounts", "ledger_cutover_at", "ledger_cutover_at TEXT")

    # Which wallet a legacy row paid from / was paid into (plans/port-ledger-v2.md).
    # Set at entry for SHADOW accounts (typed, read off the slip, or routed by
    # rule); NULL = the currency's default wallet. Sync carries them like any column.
    _ensure_column(conn, "trades", "wallet_entry", "wallet_entry TEXT")
    _ensure_column(conn, "trades", "wallet_exit", "wallet_exit TEXT")
    _ensure_column(conn, "cash_ledger", "wallet", "wallet TEXT")
    _ensure_column(conn, "dividends", "wallet", "wallet TEXT")
    # The name the broker prints for a wallet on its slips ("Dime! FCD").
    _ensure_column(conn, "ledger_wallets", "broker_label", "broker_label TEXT")
    # Per-account routing: an instrument that always settles in one wallet
    # (Dime gold → FCD). `symbol_pattern` is an fnmatch pattern.
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS ledger_wallet_rules (
            id             TEXT PRIMARY KEY,
            account_id     TEXT NOT NULL,
            symbol_pattern TEXT NOT NULL,
            wallet         TEXT NOT NULL,
            note           TEXT NOT NULL DEFAULT '',
            updated_at     TEXT NOT NULL DEFAULT ({_NOW_MS}),
            UNIQUE (account_id, symbol_pattern)
        )
    """)

    # Projection queue: which SHADOW accounts a statement just touched.
    # Machine-local, never synced; get_db() drains the rows its own transaction
    # added before it commits (ledger.flush_dirty).
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ledger_dirty (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id TEXT NOT NULL,
            table_name TEXT NOT NULL
        )
    """)
    for table in LEDGER_PROJECTED_TABLES:
        if not _table_columns(conn, table):
            continue
        for op in ("ins", "upd", "del"):
            conn.execute(f"DROP TRIGGER IF EXISTS trg_{table}_ledger_dirty_{op}")
        shadow = ("(SELECT ledger_mode FROM portfolio_accounts WHERE id = {row}.account_id) "
                  "IN ('SHADOW','PRIMARY')")
        guard = "(SELECT active FROM _sync_guard LIMIT 1) = 0"
        for op, event, rows in (("ins", "INSERT", ("NEW",)), ("upd", "UPDATE", ("NEW", "OLD")),
                                ("del", "DELETE", ("OLD",))):
            cond = " OR ".join(shadow.format(row=r) for r in rows)
            body = "\n".join(
                f"INSERT INTO ledger_dirty (account_id, table_name) "
                f"SELECT {r}.account_id, '{table}' WHERE {shadow.format(row=r)};"
                for r in rows)
            conn.execute(f"""
                CREATE TRIGGER trg_{table}_ledger_dirty_{op}
                AFTER {event} ON {table} FOR EACH ROW
                WHEN {guard} AND ({cond})
                BEGIN
                    {body}
                END
            """)


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

        # Standing notes: the scenarios, risks and catalysts that could move a
        # thesis. Deliberately NOT thesis_events — an event is an immutable fact
        # about the past ("status changed on the 3rd"), while a note is a live
        # object the user keeps revising until the scenario resolves. Editing an
        # event row would break the append-only property the sync merge relies on.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS thesis_notes (
                id         TEXT PRIMARY KEY,
                thesis_id  TEXT NOT NULL,
                kind       TEXT NOT NULL DEFAULT 'NOTE',
                title      TEXT NOT NULL DEFAULT '',
                body       TEXT NOT NULL DEFAULT '',
                impact     TEXT,
                likelihood INTEGER,
                severity   INTEGER,
                status     TEXT NOT NULL DEFAULT 'open',
                watch_date TEXT,
                pinned     INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0,
                deleted_at TEXT,
                device_id  TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_thnote_thesis ON thesis_notes(thesis_id, status)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_thnote_watch ON thesis_notes(watch_date)"
        )

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


def init_zettel_schema() -> None:
    """Zettelkasten knowledge base — atomic notes that outlive one thesis.

    `thesis_notes` is a note ABOUT a thesis: it lives and dies with it. A zettel
    is a standing claim ("CXMT ships DDR5 at >90% yield") that several theses may
    lean on, so it is linked to them through `zettel_refs` rather than owned by
    one. That is also what makes conflicting evidence tractable: two zettels are
    joined by a typed edge, and an unresolved CONTRADICTS edge is a question the
    book is carrying, not a lost note.

    Shapes follow the thesis system so the existing merge covers them unchanged:
    `zettel` is a materialised head (field-level LWW), while `zettel_edges` and
    `zettel_sources` are append-only by construction — a device that closes a
    contradiction only ever fills `resolved_at`, never rewrites the edge.
    """
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS zettel (
                id          TEXT PRIMARY KEY,
                ref         TEXT,
                kind        TEXT NOT NULL DEFAULT 'CLAIM',
                title       TEXT NOT NULL DEFAULT '',
                body        TEXT NOT NULL DEFAULT '',
                stance      TEXT,
                confidence  INTEGER,
                status      TEXT NOT NULL DEFAULT 'open',
                tags        TEXT NOT NULL DEFAULT '',
                actor       TEXT NOT NULL DEFAULT 'user',
                occurred_at TEXT,
                deleted_at  TEXT,
                device_id   TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        # `ref` (Z-0042) is a label people quote, not a key: two offline devices
        # can mint the same number, and a UNIQUE index would make the merge fail
        # for the whole table. The router renames the later arrival instead.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_zettel_ref    ON zettel(ref)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_zettel_status ON zettel(status)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_zettel_kind   ON zettel(kind)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS zettel_edges (
                id          TEXT PRIMARY KEY,
                src_id      TEXT NOT NULL,
                dst_id      TEXT NOT NULL,
                rel         TEXT NOT NULL,
                note        TEXT NOT NULL DEFAULT '',
                resolved_at TEXT,
                resolution  TEXT NOT NULL DEFAULT '',
                actor       TEXT NOT NULL DEFAULT 'user',
                device_id   TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_zedge_src ON zettel_edges(src_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_zedge_dst ON zettel_edges(dst_id)")
        # The OPEN CONFLICTS panel: unresolved CONTRADICTS edges, newest first.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_zedge_open ON zettel_edges(rel, resolved_at)"
        )
        # One direction per pair per relation — a second identical link says
        # nothing the first did not.
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_zedge_uniq "
            "ON zettel_edges(src_id, dst_id, rel)"
        )

        conn.execute("""
            CREATE TABLE IF NOT EXISTS zettel_sources (
                id           TEXT PRIMARY KEY,
                zettel_id    TEXT NOT NULL,
                url          TEXT NOT NULL DEFAULT '',
                publisher    TEXT NOT NULL DEFAULT '',
                title        TEXT NOT NULL DEFAULT '',
                published_at TEXT,
                quote        TEXT NOT NULL DEFAULT '',
                reliability  TEXT NOT NULL DEFAULT 'secondary',
                retrieved_at TEXT,
                actor        TEXT NOT NULL DEFAULT 'user',
                device_id    TEXT,
                created_at   TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_zsrc_zettel ON zettel_sources(zettel_id)")
        # "What else rests on this story?" — the question that matters when a
        # source is corrected or retracted.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_zsrc_url ON zettel_sources(url)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS zettel_refs (
                zettel_id   TEXT NOT NULL,
                target_type TEXT NOT NULL,
                target_id   TEXT NOT NULL,
                role        TEXT NOT NULL DEFAULT '',
                device_id   TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (zettel_id, target_type, target_id)
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_zref_target ON zettel_refs(target_type, target_id)"
        )

        _init_zettel_fts(conn)


def _init_zettel_fts(conn) -> None:
    """FTS5 index over zettel text, kept in step by triggers.

    Tokenizer is `trigram`, not the default `unicode61`: Thai has no spaces, so
    unicode61 indexes a whole clause as one token and a search for a word in the
    middle of it finds nothing. Trigram matches substrings in any script, at the
    cost of a larger index — irrelevant at the scale of a personal notebook.

    Derived data: NOT in SYNC_TABLES. Each device rebuilds it from its own rows.
    """
    try:
        conn.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS zettel_fts USING fts5(
                title, body, tags,
                content='zettel', content_rowid='rowid',
                tokenize='trigram'
            )
        """)
    except sqlite3.OperationalError as exc:
        # An SQLite built without FTS5: search degrades to LIKE in the router
        # rather than taking the whole app down.
        print(f"[zettel] FTS5 unavailable, falling back to LIKE search: {exc}")
        return

    conn.execute("""
        CREATE TRIGGER IF NOT EXISTS zettel_fts_ai AFTER INSERT ON zettel BEGIN
            INSERT INTO zettel_fts(rowid, title, body, tags)
            VALUES (new.rowid, new.title, new.body, new.tags);
        END
    """)
    conn.execute("""
        CREATE TRIGGER IF NOT EXISTS zettel_fts_ad AFTER DELETE ON zettel BEGIN
            INSERT INTO zettel_fts(zettel_fts, rowid, title, body, tags)
            VALUES ('delete', old.rowid, old.title, old.body, old.tags);
        END
    """)
    # `OF title, body, tags` is load-bearing, not tidiness. init_sync_layer puts
    # its own AFTER UPDATE trigger on every synced table which re-UPDATEs
    # `updated_at`; an unrestricted trigger here would then fire a second time
    # with old == new and hand FTS a 'delete' for content it no longer holds,
    # and SQLite reports that as "database disk image is malformed".
    conn.execute("DROP TRIGGER IF EXISTS zettel_fts_au")
    conn.execute("""
        CREATE TRIGGER zettel_fts_au AFTER UPDATE OF title, body, tags ON zettel
        WHEN old.title IS NOT new.title OR old.body IS NOT new.body
          OR old.tags IS NOT new.tags
        BEGIN
            INSERT INTO zettel_fts(zettel_fts, rowid, title, body, tags)
            VALUES ('delete', old.rowid, old.title, old.body, old.tags);
            INSERT INTO zettel_fts(rowid, title, body, tags)
            VALUES (new.rowid, new.title, new.body, new.tags);
        END
    """)
    # A DB that held rows before FTS existed, or whose index an older build of
    # the trigger above left inconsistent.
    rows = conn.execute("SELECT COUNT(*) FROM zettel").fetchone()[0]
    indexed = conn.execute("SELECT COUNT(*) FROM zettel_fts").fetchone()[0]
    if rows != indexed:
        conn.execute("INSERT INTO zettel_fts(zettel_fts) VALUES ('rebuild')")


def zettel_fts_available() -> bool:
    """False on an SQLite built without FTS5 — the router then searches with LIKE."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='zettel_fts'"
        ).fetchone()
    return row is not None


# Tables whose every INSERT / UPDATE / DELETE lands in audit_events.
# option_trade_matches is left out on purpose: it is rebuilt from option_trades
# on every edit, so logging it would bury the real change under recomputation.
AUDITED_TABLES: tuple[str, ...] = (
    "portfolio_accounts",
    "trades",
    "cash_ledger",
    "cash_adjustments",
    "broker_statements",
    "broker_executions",
    "dividends",
    "position_cost_overrides",
    "allocation_targets",
    "option_contracts",
    "option_trades",
    "trade_fee_items",
    "transactions",
)


@contextmanager
def audit_reason(conn: sqlite3.Connection, reason: Optional[str]):
    """Attach a human reason to every audit event written inside the block.

    Must share the connection (and so the transaction) of the writes it labels.
    """
    conn.execute("UPDATE _audit_context SET reason = ?", ((reason or "").strip() or None,))
    try:
        yield
    finally:
        conn.execute("UPDATE _audit_context SET reason = NULL")


def init_audit_layer() -> None:
    """(Re)create the audit triggers. Run AFTER init_sync_layer.

    Triggers are rebuilt on every start because their column lists are baked
    in, and _ensure_column migrations add columns over time.

    - Gated by `_sync_guard.active`: rows imported from a peer are not new
      edits here, and the peer's own audit_events travel with the sync.
    - UPDATE fires only when a column OTHER than `updated_at` changed. The sync
      layer's own trigger re-stamps updated_at after every write; without this
      filter each edit would log twice, and every insert once more as an update.
    """
    from sync.config import TABLE_PK
    now_ms = "strftime('%Y-%m-%d %H:%M:%f', 'now')"
    guard = "(SELECT active FROM _sync_guard) = 0"
    reason = "(SELECT reason FROM _audit_context)"

    with get_db() as conn:
        for table in AUDITED_TABLES:
            cols = [
                str(r[1]) for r in conn.execute(f"PRAGMA table_info({table})").fetchall()
                if r[1] != "updated_at"
            ]
            for suffix in ("ins", "upd", "del"):
                conn.execute(f"DROP TRIGGER IF EXISTS trg_{table}_audit_{suffix}")
            if not cols:
                continue  # table absent in this DB

            pk = [c for c in TABLE_PK.get(table, ["id"]) if c in cols] or ["rowid"]

            def row_id(ref: str) -> str:
                return " || char(31) || ".join(f"CAST({ref}.{c} AS TEXT)" for c in pk)

            def snapshot(ref: str) -> str:
                return "json_object(" + ", ".join(f"'{c}', {ref}.{c}" for c in cols) + ")"

            def account(ref: str) -> str:
                return f"{ref}.account_id" if "account_id" in cols else "NULL"

            def insert(action: str, ref: str, old: str, new: str) -> str:
                return (
                    "INSERT INTO audit_events (event_id, table_name, row_id, account_id, "
                    "action, old_data, new_data, reason, created_at) VALUES ("
                    f"lower(hex(randomblob(16))), '{table}', {row_id(ref)}, {account(ref)}, "
                    f"'{action}', {old}, {new}, {reason}, {now_ms});"
                )

            conn.execute(f"""
                CREATE TRIGGER trg_{table}_audit_ins AFTER INSERT ON {table} FOR EACH ROW
                WHEN {guard}
                BEGIN {insert('INSERT', 'NEW', 'NULL', snapshot('NEW'))} END;
            """)
            changed = " OR ".join(f"OLD.{c} IS NOT NEW.{c}" for c in cols)
            conn.execute(f"""
                CREATE TRIGGER trg_{table}_audit_upd AFTER UPDATE ON {table} FOR EACH ROW
                WHEN {guard} AND ({changed})
                BEGIN {insert('UPDATE', 'NEW', snapshot('OLD'), snapshot('NEW'))} END;
            """)
            conn.execute(f"""
                CREATE TRIGGER trg_{table}_audit_del AFTER DELETE ON {table} FOR EACH ROW
                WHEN {guard}
                BEGIN {insert('DELETE', 'OLD', snapshot('OLD'), 'NULL')} END;
            """)


def init_graphs_schema() -> None:
    """Rendered analysis pages — the index for what lives in GRAPHS_DIR.

    The page itself is a file on disk (research/graphs/<slug>/index.html): an
    80KB document with inline SVG has no business sitting in a TEXT column, and
    keeping it as a file means it diffs in git and opens without the backend
    running. This table is only what you need to FIND one — title, who it is
    about, which thesis it argues, when the data was pulled.

    `slug` is the natural key and the URL segment, so it is UNIQUE here (unlike
    zettel `ref`, which is minted per device): a graph is created through one
    backend, never merged in from another, and a collision would otherwise
    silently overwrite someone's page on disk.

    Not wired into the sync layer: the folder travels with the repo.
    """
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS graphs (
                id          TEXT PRIMARY KEY,
                slug        TEXT NOT NULL UNIQUE,
                title       TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                kind        TEXT NOT NULL DEFAULT 'html',
                symbol      TEXT,
                thesis_id   TEXT,
                zettel_refs TEXT NOT NULL DEFAULT '',
                tags        TEXT NOT NULL DEFAULT '',
                as_of       TEXT,
                sources     TEXT NOT NULL DEFAULT '[]',
                version     INTEGER NOT NULL DEFAULT 1,
                bytes       INTEGER NOT NULL DEFAULT 0,
                actor       TEXT NOT NULL DEFAULT 'user',
                deleted_at  TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_graphs_thesis ON graphs(thesis_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_graphs_symbol ON graphs(symbol)")


def init_series_schema() -> None:
    """Generic indicator series — anything that is a number over time and is NOT
    a tradable instrument.

    Quotes already have a home (yfinance through the provider registry); what
    had none is the other half of a research desk: spot prices published by an
    industry board, a freight rate, a survey index. Those arrive per source, in
    a shape that source decides, and the mistake would be one table per source —
    a `dram_prices` table means the next one needs a `freight_rates` table, a
    second endpoint and a second panel.

    So the store is deliberately source-agnostic. A collector
    (backend/series_sources/*.py) declares its series and hands back
    observations; the router, the scheduler and the UI never learn what DRAM is.

    Two tables, for the same reason the thesis system has a head row and an
    append-only log:

      series_meta   — what a series IS. Edited in place (a label or a sort order
                      changes), so field-level last-write-wins on merge.
      series_points — what it WAS on a given day. Keyed on (series_id, date):
                      an immutable fact about one day, which makes a merge a
                      union rather than a race — the same argument as
                      iv_snapshots, and it matters for the same reason. The
                      publisher shows only TODAY's price, so a day nobody
                      recorded is a permanent hole in the chart.
    """
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS series_meta (
                id          TEXT PRIMARY KEY,
                group_key   TEXT NOT NULL,
                section     TEXT NOT NULL DEFAULT '',
                label       TEXT NOT NULL,
                unit        TEXT NOT NULL DEFAULT '',
                source      TEXT NOT NULL,
                source_url  TEXT NOT NULL DEFAULT '',
                freq        TEXT NOT NULL DEFAULT 'daily',
                symbol      TEXT,
                tags        TEXT NOT NULL DEFAULT '',
                sort_order  INTEGER NOT NULL DEFAULT 0,
                first_seen  TEXT,
                last_value  REAL,
                last_date   TEXT,
                updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS series_points (
                series_id   TEXT NOT NULL,
                date        TEXT NOT NULL,
                value       REAL,
                high        REAL,
                low         REAL,
                change_pct  REAL,
                captured_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (series_id, date)
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_series_meta_group ON series_meta(group_key, section)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_series_points_date ON series_points(date)"
        )


def init_etf_aum_schema() -> None:
    """Self-built AUM record for the sector ETF complex.

    One row is what a fund was worth on one day. Yahoo publishes only TODAY's
    `totalAssets` and `navPrice` and has no history behind either, so a day
    nobody recorded can never be recovered — the same argument as
    `series_points`, and the reason this is a stored fact rather than a derived
    one. Keyed on (as_of, symbol), which makes a cross-device merge a union.
    """
    with get_db() as conn:
        # Symbols opened from a search box — MKT left panel FREQ tab
        # (routers/discover.py). Local to this machine, not in SYNC_TABLES.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS search_hits (
                symbol  TEXT PRIMARY KEY,
                count   INTEGER NOT NULL DEFAULT 0,
                last_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS etf_aum_snapshots (
                as_of          TEXT NOT NULL,
                symbol         TEXT NOT NULL,
                total_assets   REAL,
                nav            REAL,
                close          REAL,
                implied_shares REAL,
                source         TEXT NOT NULL DEFAULT 'yfinance',
                captured_at    TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (as_of, symbol)
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_etf_aum_symbol ON etf_aum_snapshots(symbol, as_of)"
        )


def init_bond_issuance_schema() -> None:
    """Corporate-bond prospectuses from SEC full-text search (BOND view).

    A cache of a public, re-derivable source — not synced across devices: each
    machine backfills its own year from EDGAR. Filings are keyed on accession
    number because one deal is listed once per co-registrant; days carry a
    `complete` flag because EDGAR keeps publishing a day's filings into the
    evening, so the last two days are re-read until they settle.
    """
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS bond_issuance_filings (
                adsh        TEXT PRIMARY KEY,
                file_date   TEXT NOT NULL,
                form        TEXT NOT NULL DEFAULT '',
                issuer      TEXT NOT NULL DEFAULT '',
                cik         TEXT NOT NULL DEFAULT '',
                sic         TEXT NOT NULL DEFAULT '',
                category    TEXT NOT NULL,
                captured_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_bond_issuance_date ON bond_issuance_filings(file_date, category)"
        )
        conn.execute("""
            CREATE TABLE IF NOT EXISTS bond_issuance_days (
                date        TEXT PRIMARY KEY,
                filings     INTEGER NOT NULL DEFAULT 0,
                complete    INTEGER NOT NULL DEFAULT 0,
                fetched_at  TEXT NOT NULL
            )
        """)


def init_cot_schema() -> None:
    """CFTC Commitments of Traders, long-form (routers/cot.py).

    A cache of a public, re-derivable source — not synced across devices; each
    machine backfills its own history from CFTC. Keyed on the contract CODE
    because CFTC renamed most markets on 2022-02-01 and the code survived.
    """
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS cot_reports (
                dataset     TEXT NOT NULL,
                code        TEXT NOT NULL,
                report_date TEXT NOT NULL,
                oi          REAL NOT NULL,
                conc4_long  REAL,
                conc4_short REAL,
                conc8_long  REAL,
                conc8_short REAL,
                fetched_at  TEXT NOT NULL,
                PRIMARY KEY (dataset, code, report_date)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cot_reports_code ON cot_reports(code, report_date)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS cot_positions (
                dataset       TEXT NOT NULL,
                code          TEXT NOT NULL,
                report_date   TEXT NOT NULL,
                grp           TEXT NOT NULL,
                long          REAL NOT NULL,
                short         REAL NOT NULL,
                spread        REAL,
                traders_long  REAL,
                traders_short REAL,
                PRIMARY KEY (dataset, code, report_date, grp)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cot_positions_code ON cot_positions(code, report_date)")


def init_guard_schema() -> None:
    """TRADE GUARD tables (backend/trade_guard.py). Before init_sync_layer():
    guard_overrides is synced."""
    with get_db() as conn:
        # TRADE GUARD "hold anyway" decisions (backend/trade_guard.py). One row
        # per decision, keyed to a HOLDING PERIOD (account, yf_symbol,
        # first_entry) so buying the symbol again later starts clean. A newer
        # HOLD on the same holding sets `cleared_at` on the old one (kept for
        # the report); DELETE is an undo. Synced: it is a decision the user made.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS guard_overrides (
                id          TEXT PRIMARY KEY,
                account_id  TEXT NOT NULL,
                yf_symbol   TEXT NOT NULL,
                symbol      TEXT,
                first_entry TEXT NOT NULL,
                codes       TEXT NOT NULL DEFAULT '[]',
                reason      TEXT NOT NULL DEFAULT '',
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                cleared_at  TEXT
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_guard_ovr_pos "
            "ON guard_overrides(account_id, yf_symbol, first_entry)"
        )
        # A HOLD expires: on `review_on` (default created_at + HOLD_REVIEW_DAYS)
        # or when price breaks `floor_price` (default stop − 1R). NULL = default.
        _ensure_column(conn, "guard_overrides", "review_on", "review_on TEXT")
        _ensure_column(conn, "guard_overrides", "floor_price", "floor_price REAL")
        # Last flags the guard scheduler saw per holding, so a notification
        # fires on the TRANSITION into a flag, not every scan it stays there.
        # Machine-local like alert_rule_state: a scan cursor, not user data.
        # One VaR forecast per day per book, written BEFORE the day it is judged
        # on (guard_scheduler → routers.risk._record_var_forecast). The only
        # honest test of the VaR numbers: a forecast cannot be re-made after the
        # fact. Machine-local (Windows is the sole writer until the Postgres
        # cutover); `holdings` = {yf_symbol: {"w": weight, "ccy": currency}}.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS var_forecasts (
                forecast_date  TEXT NOT NULL,
                account_id     TEXT NOT NULL,
                confidence     REAL NOT NULL,
                var_hist_pct   REAL,
                cvar_pct       REAL,
                var_cf_pct     REAL,
                cvar_mc_pct    REAL,
                ensemble_pct   REAL,
                portfolio_value REAL,
                holdings       TEXT NOT NULL,
                created_at     TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (forecast_date, account_id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS guard_state (
                key        TEXT PRIMARY KEY,
                flags      TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL
            )
        """)


def init_margin_schema() -> None:
    """MARGIN tables (backend/margin.py, routers/margin.py). Before
    init_sync_layer(): margin_settings is synced."""
    with get_db() as conn:
        # Per-account Reg T parameters the user chose. scope = 'port' (a
        # portfolio_accounts id) or 'paper' (a paper_accounts id). `enabled`
        # turns the model on; overrides_json = {"SYMBOL": maint rate} for
        # IBKR house rates; thresholds_json = cushion floors per level.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS margin_settings (
                scope           TEXT NOT NULL CHECK(scope IN ('port','paper')),
                account_id      TEXT NOT NULL,
                enabled         INTEGER NOT NULL DEFAULT 0,
                maint_long      REAL NOT NULL DEFAULT 0.25,
                maint_short     REAL NOT NULL DEFAULT 0.30,
                initial         REAL NOT NULL DEFAULT 0.50,
                overrides_json  TEXT NOT NULL DEFAULT '{}',
                thresholds_json TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY (scope, account_id)
            )
        """)
        # Last level the margin scheduler saw per account, so an alert fires on
        # the transition, not on every scan. Machine-local like guard_state.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS margin_state (
                key        TEXT PRIMARY KEY,
                level      TEXT NOT NULL,
                updated_at TEXT NOT NULL
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
    from sync.config import APPEND_ONLY_TABLES, SYNC_TABLES, TOMB_SEP
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
            if table in APPEND_ONLY_TABLES:
                # updated_at comes from the column DEFAULT; stamping it would be
                # an UPDATE (refused), and a delete never happens to tombstone.
                for suffix in ("ins", "upd", "del"):
                    conn.execute(f"DROP TRIGGER IF EXISTS trg_{table}_sync_{suffix}")
                continue
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


def init_oplog_layer() -> None:
    """Op-log sync capture (sync/oplog.py): change-log tables + per-table
    triggers. Runs LAST at startup so every synced table already exists."""
    from sync.oplog import install
    with get_db() as conn:
        install(conn)


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


def sync_symbol_lists() -> None:
    """Add symbols that config.py has gained since the tables were first seeded.

    `seed_symbol_lists` only ever runs against an empty table, so anything added
    to config.py afterwards never reached an existing install — KOSPI sat in
    INDICES for months while every running terminal showed five Asian indices.
    This runs on every startup and inserts only what is missing, keyed on
    (list_id, symbol), so a user's own edits (disabled rows, re-ordering,
    symbols they added themselves) are left alone.
    """
    from config import INDICES, VOL_INDICES

    groups: list[tuple[str, list[dict]]] = [("indices", INDICES), ("volatility", VOL_INDICES)]

    with get_db() as conn:
        for list_id, defaults in groups:
            existing = {
                r["symbol"]
                for r in conn.execute(
                    "SELECT symbol FROM symbol_lists WHERE list_id = ?", (list_id,)
                ).fetchall()
            }
            # New rows go after everything already there, so an existing board
            # does not reshuffle under the user.
            next_sort = conn.execute(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM symbol_lists WHERE list_id = ?",
                (list_id,),
            ).fetchone()[0]

            for cfg in defaults:
                if cfg["symbol"] in existing:
                    continue
                meta = {k: v for k, v in cfg.items() if k not in ("symbol", "id", "region")}
                conn.execute(
                    "INSERT INTO symbol_lists (list_id, symbol, label, region, meta, sort_order) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        list_id,
                        cfg["symbol"],
                        cfg["id"],
                        cfg.get("region"),
                        json.dumps(meta) if meta else None,
                        next_sort,
                    ),
                )
                next_sort += 1


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
