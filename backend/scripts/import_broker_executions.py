"""Validate or import image-cited broker fills; never change trades or cash.

From backend/:
  python scripts/import_broker_executions.py --manifest backups/accounting-evidence-20260925/dime-executions-manifest.json
  python scripts/import_broker_executions.py --manifest backups/accounting-evidence-20260925/dime-executions-manifest.json --apply
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--db", type=Path, default=Path(__file__).resolve().parents[1] / "portfolio.db")
    parser.add_argument("--apply", action="store_true", help="Import after creating a verified SQLite backup")
    args = parser.parse_args()
    db_path = args.db.resolve()
    os.environ["PORTFOLIO_DB"] = str(db_path)

    from accounting_io import backup_book, read_book
    from broker_executions import import_prepared, prepare_manifest

    rows = prepare_manifest(args.manifest, args.manifest.parent)
    print(f"Image hashes verified; {len(rows)} complete executions prepared")
    if not args.apply:
        with read_book(db_path) as conn:
            exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='broker_executions'").fetchone()
            present = (sum(bool(conn.execute("SELECT 1 FROM broker_executions WHERE id=?", (r["id"],)).fetchone())
                           for r in rows) if exists else 0)
        print(f"PREVIEW: {len(rows) - present} new, {present} already present; no database changes")
        return 0

    backup = backup_book(db_path, label="pre-broker-executions")
    print(f"Verified backup: {backup}")
    import db
    db.init_portfolio_v2()
    db.init_sync_layer()
    db.init_audit_layer()
    with db.get_db() as conn:
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Source database integrity check failed")
        with db.audit_reason(conn, f"image-cited Dime Activity import: {args.manifest.name}"):
            result = import_prepared(conn, rows)
    with read_book(db_path) as conn:
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Database integrity check failed after import")
        count = conn.execute("SELECT count(*) FROM broker_executions WHERE account_id=?", (rows[0]["account_id"],)).fetchone()[0]
        trades = conn.execute("SELECT count(*) FROM trades WHERE account_id=?", (rows[0]["account_id"],)).fetchone()[0]
        ledger = conn.execute("SELECT count(*) FROM ledger_events").fetchone()[0]
    print(f"IMPORTED: {result}; account evidence rows={count}, trade rows={trades}, ledger rows={ledger}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
