"""Preview or book historical option round trips from a transcribed slip manifest.

From backend/:
  python scripts/import_option_history.py --manifest backups/accounting-evidence-20260926-options/dime-options-2026-manifest.json
  python scripts/import_option_history.py --manifest ... --apply
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--db", type=Path, default=Path(__file__).resolve().parents[1] / "portfolio.db")
    parser.add_argument("--apply", action="store_true", help="Book after a verified SQLite backup")
    args = parser.parse_args()
    db_path = args.db.resolve()
    os.environ["PORTFOLIO_DB"] = str(db_path)

    from accounting_io import backup_book, read_book
    import option_history

    plan = option_history.prepare(args.manifest)
    fills = {f["trade_id"]: f for f in plan["fills"]}
    print(f"Images verified; {len(plan['fills'])} fills, {len(plan['fee_items'])} fee items, "
          f"{len(plan['evidence'])} evidence rows")
    for m in plan["matches"]:
        o, c = fills[m["open_trade_id"]], fills[m["close_trade_id"]]
        flag = "  UNVERIFIED " + ",".join(o["unverified"] + c["unverified"]) if o["unverified"] or c["unverified"] else ""
        print(f"  {o['occ_symbol']}  {m['quantity']:>5g}  {o['trade_date']} @{o['price']:.2f} -> "
              f"{c['trade_date']} @{c['price']:.2f} {c['close_reason']:<8} fees {m['fees_alloc']:>6.2f}  "
              f"P&L {m['realized_pnl']:>+9.2f}{flag}")
    print(f"Realized total {plan['realized_total']:+.2f}; cash offset release {plan['cash_offset']['amount']:+.2f} "
          f"{plan['cash_offset']['currency']} (today's cash unchanged)")

    with read_book(db_path) as conn:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(option_trades)")}
        st = option_history.status(conn, plan) if "executed_at" in cols else {"present": 0, "duplicates": []}
    if st["duplicates"]:
        print(f"REFUSED: already booked under other ids: {st['duplicates']}")
        return 1
    if not args.apply:
        mode = "amend to this revision" if st["present"] == len(plan["fills"]) else "insert"
        print(f"PREVIEW: {len(plan['fills']) - st['present']} new, {st['present']} present ({mode}); "
              "no database changes")
        return 0

    backup = backup_book(db_path, label="pre-option-history")
    print(f"Verified backup: {backup}")
    import db
    db.init_portfolio_v2()
    db.init_sync_layer()
    db.init_audit_layer()
    with db.get_db() as conn:
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Source database integrity check failed")
        with db.audit_reason(conn, f"option history from Dime slips: {args.manifest.name}"):
            result = option_history.apply(conn, plan)
    with read_book(db_path) as conn:
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Database integrity check failed after import")
    print(f"IMPORTED: {result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
