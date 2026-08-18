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
# UNIQUE(...) natural key. Auto-increment-id tables (symbol_lists,
# trade_audit_log) are intentionally excluded: their ids collide across devices.
#
#   (table_name, [natural key columns])
SYNC_TABLES: list[tuple[str, list[str]]] = [
    ("transactions",            ["id"]),
    ("portfolio_accounts",      ["id"]),
    ("trades",                  ["id"]),
    ("cash_ledger",             ["id"]),
    ("dividends",               ["id"]),
    ("option_positions",        ["id"]),
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
    ("thesis_links",             ["thesis_id", "trade_id"]),   # composite PK
    ("allocation_targets",       ["account_id", "scope", "key"]),  # UNIQUE(...)
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
]

TABLE_PK: dict[str, list[str]] = {t: pk for t, pk in SYNC_TABLES}

# Tables holding real money. A delete only beats a concurrent edit here when it
# is STRICTLY newer — on a same-timestamp tie the row survives and is reported as
# a conflict, because an unwanted row is visible and deletable while a wrongly
# deleted trade is silent and gone. Everything else keeps delete-wins-on-tie.
MONEY_TABLES: frozenset[str] = frozenset({
    "transactions", "trades", "cash_ledger", "dividends",
    "option_positions", "portfolio_accounts", "position_cost_overrides",
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
    return _autodetect_dir()


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
