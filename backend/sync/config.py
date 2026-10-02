"""
Sync configuration — cloud dir, device id, table allow-list.

Intentionally imports nothing from `db` so it can be imported by `db.py` itself
(the schema migration needs SYNC_TABLES).
"""
import glob
import os
import re
import socket
import string
import sys
from pathlib import Path

# Snapshot schema version. Bump when the snapshot JSON shape changes in a way
# that older clients cannot merge. Merge across mismatched versions is refused.
# NOT bumped for the paper_positions removal: dropping a table is wire-compatible
# in both directions — an old peer's paper_positions rows are simply ignored
# (merge only walks SYNC_TABLES), and our snapshot's missing table upserts as an
# empty list on their side, which is a no-op rather than a delete. Bumping would
# have frozen every peer out until it upgraded, for no protocol gain.
SCHEMA_VER = 2  # trades.exit_exchange_rate + dividends.currency

# Tables included in cloud snapshots, with their NATURAL merge key.
# Only tables with stable, cross-device keys are listed — TEXT uuid PKs, or a
# UNIQUE(...) natural key. Auto-increment-id tables (symbol_lists) are
# intentionally excluded: their ids collide across devices. trade_audit_log used
# to be excluded for that reason and now carries a uuid `event_id` instead.
#
#   (table_name, [natural key columns])
SYNC_TABLES: list[tuple[str, list[str]]] = [
    ("transactions",            ["id"]),
    ("portfolio_accounts",      ["id"]),
    ("trades",                  ["id"]),
    ("cash_ledger",             ["id"]),
    ("dividends",               ["id"]),
    # Cash reconciliation offsets. uuid PK; rows are created and deleted, never
    # edited, so last-write-wins is a union.
    ("cash_adjustments",        ["id"]),
    ("broker_statements",        ["id"]),  # cited, versioned broker evidence
    ("broker_executions",         ["id"]),  # cited broker fills; no implied cash/wallet
    # Ledger v2 (plans/port-ledger-v2.md). Journal + period closes are
    # APPEND-ONLY (below): a merge is a union, never an update or a delete.
    # Wallets are settings — ordinary field-level LWW.
    ("ledger_events",             ["id"]),
    ("ledger_period_close",       ["id"]),
    ("ledger_wallets",            ["account_id", "wallet"]),  # composite PK
    ("ledger_wallet_rules",       ["id"]),                    # routing settings, LWW
    # Normalized option schema (2026-09-10). Contracts sync on their natural key
    # so the same contract entered on two devices merges into one row; trades
    # and matches carry uuid PKs.
    #
    # ORDER MATTERS: restore._upsert walks this list in sequence with
    # foreign_keys ON, so a table must appear after whatever it references —
    # contracts before trades, trades before the greeks and matches that point
    # at them.
    ("option_contracts",        ["occ_symbol"]),          # UNIQUE(occ_symbol)
    ("option_trades",           ["trade_id"]),
    # Fee breakdown of a fill (trades or option_trades). uuid5 PK derived from
    # (trade, leg, component, basis), so the same item entered on two devices
    # is one row.
    ("trade_fee_items",         ["id"]),
    # The market state at each execution. Same argument as iv_snapshots below:
    # a chain only ever reports NOW, so spot/IV/greeks at a past trade cannot be
    # re-derived on the other machine — without this the peer receives the trade
    # and permanently loses what the contract looked like when it was made.
    # (An earlier version excluded this as "derived state, rebuilt on demand",
    # which was simply wrong — nothing can rebuild it.)
    ("option_trade_greeks",     ["trade_id"]),
    ("option_trade_matches",    ["close_trade_id", "open_trade_id"]),  # composite PK
    # Daily greeks history behind PnL attribution. Accumulate-only for the same
    # reason, so a day only one machine recorded is a permanent hole in the
    # attribution chart unless it travels. Rows are that day's snapshot of one
    # position, so two devices recording the same day agree on substance and
    # last-write-wins is a union in practice.
    ("option_greeks_snapshots", ["position_id", "snapshot_date"]),  # composite PK
    ("position_cost_overrides", ["account_id", "symbol"]),   # UNIQUE(account_id, symbol)
    ("pin_groups",              ["id"]),
    ("pinned_assets",           ["id"]),
    ("pin_tags",                ["id"]),
    ("pinned_asset_tags",       ["asset_id", "tag_id"]),      # composite PK
    ("paper_accounts",          ["id"]),
    ("paper_orders",            ["id"]),
    ("paper_fills",             ["id"]),
    # paper_positions is NOT here: it is a running aggregate that
    # paper_trading.py:_execute_fill() mutates incrementally (qty += fill), and
    # last-write-wins on a running total silently drops one device's fills
    # (base 100, A buys 50 → 150, B buys 30 → 130; LWW keeps one, the other 30
    # shares vanish even though both paper_fills rows merged fine). It is
    # rebuilt from paper_fills after every merge — see derived.py.
    #
    # paper_snapshots DOES stay: each row is that day's equity marked at that
    # day's prices, so it cannot be recomputed after the fact.
    ("paper_snapshots",         ["account_id", "date"]),      # UNIQUE(account_id, date)
    ("paper_option_positions",  ["id"]),
    # alert_rules is the rule DEFINITIONS the user authored — same shape as
    # pinned_assets, syncs the same way. alert_rule_state (per-symbol scan
    # cursor) and alert_events (fired history, auto-increment id — would
    # collide across devices like symbol_lists/trade_audit_log above) are
    # deliberately NOT synced: state regenerates itself from a fresh scan on
    # whichever device runs the scanner, and merging two devices' independent
    # scan cursors could double-fire or silently drop an edge transition.
    ("alert_rules",              ["id"]),
    # Thesis system. uuid4 PKs, so ids never collide across devices.
    # thesis_events is append-only by construction (no endpoint UPDATEs a row),
    # which makes LWW a union rather than a race.
    ("theses",                   ["id"]),
    ("thesis_events",            ["id"]),
    # thesis_notes IS edited in place, unlike thesis_events — but it is the same
    # shape as `theses` itself (uuid PK, field-level LWW on a head row), so the
    # existing merge handles it. Adding a table needs no SCHEMA_VER bump: an old
    # peer ignores a table it does not walk, and its snapshot simply carries none.
    ("thesis_notes",             ["id"]),
    ("thesis_links",             ["thesis_id", "trade_id"]),   # composite PK
    # TRADE GUARD "hold anyway" decisions — uuid PK, edited only to set
    # cleared_at. guard_state (the notifier's per-holding flag cursor) is NOT
    # synced, for the same reason alert_rule_state is not.
    ("guard_overrides",          ["id"]),
    # Zettelkasten. `zettel` is a head row like `theses` (field-level LWW);
    # edges and sources are append-only by construction — closing a conflict
    # fills resolved_at on the existing row, it never rewrites the link — so a
    # merge unions them. zettel_fts is derived and deliberately absent: each
    # device rebuilds its own index from its own rows.
    ("zettel",                   ["id"]),
    ("zettel_edges",             ["id"]),
    ("zettel_sources",           ["id"]),
    ("zettel_refs",              ["zettel_id", "target_type", "target_id"]),  # composite PK
    # Thesis questions (routers/questions.py). `questions` is the only head row
    # (field-level LWW) and is kept small on purpose: every op carries the whole
    # row. Edges, answers, signals, assumptions and checks are append-only by
    # construction — accepting an answer or testing an assumption ADDS a
    # question_checks row — so a merge unions them, and status is derived from
    # them on read rather than synced.
    ("questions",                ["id"]),
    ("question_edges",           ["id"]),
    ("question_answers",         ["id"]),
    ("question_signals",         ["id"]),
    ("question_assumptions",     ["id"]),
    ("question_checks",          ["id"]),
    # The question calendar: question_dates is a small head row (a date gets
    # revised → LWW); links and the revision trail are insert-only.
    ("question_dates",           ["id"]),
    ("question_date_links",      ["id"]),
    ("question_date_changes",    ["id"]),
    # Thesis tracking (routers/tracking.py). Same split as the questions:
    # track_metrics is the small head row (LWW); an expectation and a reading
    # are never updated — a revised forecast or a corrected number is a new row —
    # so a merge unions them and due / off / kill are derived on read.
    ("track_metrics",            ["id"]),
    ("track_expectations",       ["id"]),
    ("track_readings",           ["id"]),
    # Rendered analysis pages. The ROW travels here; the HTML file beside it
    # travels through sync/files.py, because a page index without its pages is
    # four links that 404 on the other machine. Keyed on `slug` (UNIQUE, and the
    # name of the folder the file lives in) rather than the uuid `id`, so the
    # same page written on two devices merges into one row instead of two.
    ("graphs",                   ["slug"]),                       # UNIQUE(slug)
    # Read marks (routers/reads.py): one head row per thing the user has looked
    # at; marking again moves seen_at, so LWW keeps the later look.
    ("read_marks",               ["target_type", "target_id"]),   # composite PK
    # Indicator series (backend/series_sources). `series_meta` is a head row
    # like `theses` — a label or sort order is edited in place, so field-level
    # LWW. `series_points` is one published number on one day, keyed naturally,
    # which makes a merge a union: two devices recording the same day agree, and
    # a day only one machine was awake for is filled in for both. Same argument
    # as iv_snapshots — the publisher sells the history, so an unrecorded day
    # cannot be re-derived by anyone.
    ("series_meta",              ["id"]),
    ("series_points",            ["series_id", "date"]),   # composite PK
    ("allocation_targets",       ["account_id", "scope", "key"]),  # UNIQUE(...)
    # Why an edit was made, for both equity and option trades. Append-only by
    # construction — no endpoint UPDATEs a row — so last-write-wins is a union,
    # the same shape as thesis_events. Keyed on the uuid `event_id`, never the
    # device-local autoincrement `id`. Listed after `trades` and the option
    # tables it refers to, though it declares no FK: the rows it points at
    # should already be present when a reader goes looking.
    ("trade_audit_log",          ["event_id"]),
    # Row-level change log written by triggers on every money table
    # (db.init_audit_layer). Append-only, uuid key → merge is a union. The
    # triggers are sync-guarded, so imported rows never log twice.
    ("audit_events",             ["event_id"]),
    # ATM implied-vol history. Market data, which normally stays local (see
    # fx_rates, deliberately absent) — but this series is the one kind that
    # CANNOT be re-derived later: the provider publishes only the CURRENT IV of a
    # chain, so a day nobody recorded is a permanent hole. Syncing means whichever
    # machine was running that day fills it for both.
    #
    # The composite PK is a natural key (no auto-increment id to collide), and
    # rows are immutable facts about one (symbol, day, expiry), so LWW is a union
    # in practice: two devices recording the same day agree, and different days
    # never contend.
    ("iv_snapshots",             ["symbol", "snapshot_date", "expiry"]),
    # Sector-ETF AUM, recorded daily by this app because nobody sells the
    # history: Yahoo returns None for an ETF's shares outstanding and publishes
    # only today's totalAssets. Same class of row as iv_snapshots — an immutable
    # fact about one (symbol, day) that cannot be re-derived afterwards — so the
    # merge is a union and a day only one machine was awake for is filled in for
    # both. Without this, two machines each hold half a flow series and neither
    # can compute a flow across the gap.
    ("etf_aum_snapshots",        ["as_of", "symbol"]),     # composite PK
    # Trend lines + regression channels drawn on charts (routers/chart_drawings.py).
    # Client-minted uuid PK, so the same line drawn on two devices never
    # collides; a REG rail-mode change is an edit in place → field-level LWW.
    ("chart_drawings",           ["id"]),
    # MARGIN parameters per account (routers/margin.py): a choice the user made,
    # edited in place → field-level LWW on the natural key. margin_state (the
    # scheduler's last-seen level) is NOT synced, same reason as guard_state.
    ("margin_settings",          ["scope", "account_id"]),  # composite PK
]

TABLE_PK: dict[str, list[str]] = {t: pk for t, pk in SYNC_TABLES}

# Tables no device may change or delete once a row exists (DB triggers refuse
# it). Sync must match: rows only ever get ADDED — no updated_at stamping
# trigger (it is an UPDATE, which the append-only trigger aborts), no
# tombstones, and a peer row that differs from ours under the same key is a
# conflict to review, never an overwrite.
APPEND_ONLY_TABLES: frozenset[str] = frozenset({"ledger_events", "ledger_period_close"})

# Tables holding real money. A delete only beats a concurrent edit here when it
# is STRICTLY newer — on a same-timestamp tie the row survives and is reported as
# a conflict, because an unwanted row is visible and deletable while a wrongly
# deleted trade is silent and gone. Everything else keeps delete-wins-on-tie.
MONEY_TABLES: frozenset[str] = frozenset({
    "transactions", "trades", "cash_ledger", "cash_adjustments", "broker_statements",
    "broker_executions", "dividends",
    "option_trades", "option_trade_matches", "trade_fee_items",
    "portfolio_accounts", "position_cost_overrides",
    "ledger_events", "ledger_period_close", "ledger_wallets",
})

# char(31) — unit separator — joins composite key parts inside tombstone row_id.
TOMB_SEP = "\x1f"


def _sanitize(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", name)[:40] or "device"


def device_id() -> str:
    """Stable per-machine id. Env override wins, else hostname."""
    explicit = os.getenv("SYNC_DEVICE_ID", "").strip()
    if explicit:
        return _sanitize(explicit)
    return _sanitize(socket.gethostname())


def sync_dir() -> Path | None:
    """The shared cloud folder, or None if sync is disabled / unconfigured.

    Quotes are stripped: a shell-exported SYNC_DIR (PowerShell `$env:SYNC_DIR =
    "'G:\\My Drive\\...'"`) keeps them literally, and load_dotenv() does not
    override an existing env var — the quoted path then never exists and sync
    silently reports OFFLINE forever."""
    raw = os.getenv("SYNC_DIR", "").strip().strip("'\"").strip()
    if raw:
        return Path(raw)
    # SYNC_AUTODETECT=false means only an explicit SYNC_DIR counts — a found
    # Google Drive must not become the folder anyway (tests rely on this).
    return _autodetect_dir() if autodetect_on() else None


# Subfolder inside "My Drive" that holds the portfolio snapshots.
FOLDER_NAME = os.getenv("SYNC_FOLDER_NAME", "Investment Portfolio")


def _gdrive_roots() -> list[Path]:
    """Locate the Google Drive 'My Drive' root(s) across OSes."""
    roots: list[Path] = []
    home = Path.home()

    if sys.platform == "win32":
        # Google Drive (File Stream) mounts as a virtual drive letter — usually
        # G:, but scan all letters for a "<letter>:\My Drive" folder.
        for letter in string.ascii_uppercase:
            p = Path(f"{letter}:/My Drive")
            if p.exists():
                roots.append(p)
        # Legacy "backup & sync" location
        roots.append(home / "Google Drive" / "My Drive")
        roots.append(home / "Google Drive")
    elif sys.platform == "darwin":
        # New Drive (CloudStorage): ~/Library/CloudStorage/GoogleDrive-<email>/My Drive
        for base in glob.glob(str(home / "Library/CloudStorage/GoogleDrive-*")):
            roots.append(Path(base) / "My Drive")
        roots.append(home / "Google Drive" / "My Drive")
        roots.append(Path("/Volumes/GoogleDrive/My Drive"))
        roots.append(home / "Google Drive")
    else:  # linux (rclone / insync mounts vary)
        for base in glob.glob(str(home / "*[Gg]oogle*[Dd]rive*")):
            roots.append(Path(base) / "My Drive")
            roots.append(Path(base))

    # de-dupe, keep order
    seen, out = set(), []
    for r in roots:
        if r not in seen:
            seen.add(r)
            out.append(r)
    return out


def _autodetect_dir() -> Path | None:
    """Find (or create) '<Google Drive>/My Drive/<FOLDER_NAME>'. Returns None if
    no Google Drive root is present on this machine."""
    for root in _gdrive_roots():
        if not root.exists():
            continue
        target = root / FOLDER_NAME
        try:
            target.mkdir(parents=True, exist_ok=True)
        except OSError:
            continue
        return target
    return None


def autodetect_on() -> bool:
    return os.getenv("SYNC_AUTODETECT", "true").lower() == "true"


def enabled() -> bool:
    """Sync is on when SYNC_ENABLED=true, OR auto-detect is allowed and a Google
    Drive folder was found (and not explicitly disabled)."""
    flag = os.getenv("SYNC_ENABLED", "").lower()
    # Op-log mode replaces the snapshot merge; running both would merge the
    # same rows twice by two different rules.
    if os.getenv("OPLOG_ENABLED", "").strip().lower() == "true":
        return False
    if flag == "false":
        return False
    if flag == "true":
        return sync_dir() is not None
    # unset → enable automatically when a drive is detected
    return autodetect_on() and sync_dir() is not None


# How often the background worker checks for local changes (seconds).
PUSH_INTERVAL = int(os.getenv("SYNC_PUSH_INTERVAL", "60"))

# How often it checks the cloud manifest for OTHER devices' pushes (seconds).
# Cheap: one manifest.json read; a full merge only runs when a peer hash moved.
PULL_INTERVAL = int(os.getenv("SYNC_PULL_INTERVAL", "20"))
