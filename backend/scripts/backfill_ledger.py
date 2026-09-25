"""Rebuild `ledger_events` from trades / cash / dividends and check it.

Dry run (default) opens the DB READ-ONLY and prints what it would post, how
confident each buy price is, and every invariant the replay breaks
(plans/port-accounting-ledger.md I1–I7).

Usage (from backend/):
    python scripts/backfill_ledger.py                        # dry run, all accounts
    python scripts/backfill_ledger.py --account dime --symbol SNDK --card
    python scripts/backfill_ledger.py --json out.json        # full machine-readable report
    python scripts/backfill_ledger.py --apply                # insert (backs up the DB first)
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sqlite3
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config import DB_PATH  # noqa: E402
import ledger_backfill as lb  # noqa: E402
from accounting_io import backup_book, read_book  # noqa: E402


def _connect(read_only: bool) -> sqlite3.Connection:
    if read_only:
        uri = "file:" + os.path.abspath(DB_PATH).replace("\\", "/") + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True)
    else:
        conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _fmt(v, nd=2):
    return "—" if v is None else f"{v:,.{nd}f}"


def apply_reviewed_book(path, *, accept_warnings=False):
    """Backup a stable snapshot, reject failed checks, then append atomically.

    Recompare events under the write lock: if another writer changed the book
    after backup, stop instead of posting a stale reconstruction.
    """
    import accounting_checks
    backup = backup_book(path, "pre-ledger-backfill")
    with read_book(backup) as snapshot:
        before = lb.report(snapshot)
        audit = accounting_checks.run(snapshot)
    if audit["counts"]["error"] or (audit["counts"]["warn"] and not accept_warnings):
        raise ValueError(f"Apply blocked: {audit['counts']}. Review accounting_audit first. Backup: {backup}")
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("BEGIN IMMEDIATE")
        now = lb.report(conn)
        normalize = lambda events: sorted((e.row() for e in events), key=lambda r: r["id"])
        if normalize(now["events"]) != normalize(before["events"]):
            raise ValueError("Book changed after backup; rerun dry-run before applying")
        result = lb.apply(conn, now["events"])
        conn.commit()
        return {**result, "backup": str(backup)}
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _print_card(card):
    print(f"    {'date':10} {'type':4} {'qty in':>12} {'qty out':>12} {'price':>11} "
          f"{'cost out':>13} {'realized':>12} {'bal qty':>12} {'bal cost':>14} {'avg':>11}  src")
    for r in card:
        e = r["event"]
        print(f"    {e.trade_date:10} {e.type:4} {_fmt(r['qty_in'] or None, 4):>12} "
              f"{_fmt(r['qty_out'] or None, 4):>12} {_fmt(e.price, 4):>11} "
              f"{_fmt(r['cost_out'] or None):>13} {_fmt(r['realized']):>12} "
              f"{_fmt(r['bal_qty'], 4):>12} {_fmt(r['bal_cost']):>14} {_fmt(r['avg'], 4):>11}  "
              f"{e.confidence if e.type == 'BUY' else ''}")


def main() -> int:
    ap = argparse.ArgumentParser()
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="insert events after checks (default: dry run)")
    mode.add_argument("--dry-run", action="store_true", help="read-only preview (default)")
    ap.add_argument("--accept-warnings", action="store_true", help="acknowledge reviewed warnings; errors always block apply")
    ap.add_argument("--account")
    ap.add_argument("--symbol")
    ap.add_argument("--card", action="store_true", help="print the stock card of each position")
    ap.add_argument("--json", help="write full report to this file")
    args = ap.parse_args()

    if hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

    conn = _connect(read_only=True)
    rep = lb.report(conn)

    def keep(acct, sym):
        return ((not args.account or acct == args.account)
                and (not args.symbol or (sym or "").upper() == args.symbol.upper()))

    events = [e for e in rep["events"] if keep(e.account_id, e.symbol)]
    issues = [i for i in rep["issues"] if keep(i.account_id, i.symbol) or i.account_id == "-"]

    print(f"== ledger backfill {'APPLY' if args.apply else 'DRY RUN'} — {DB_PATH}")
    print(f"events: {len(rep['events'])}  " + "  ".join(f"{k}={v}" for k, v in sorted(rep['by_type'].items())))
    print("buy price source: " + "  ".join(f"{k}={v}" for k, v in sorted(rep['buy_confidence'].items()))
          + "   (AUDIT = recovered from trade_audit_log, RECORDED = row as entered, never rewritten)")

    sev_order = {"ERROR": 0, "WARN": 1, "INFO": 2}
    print(f"\n== positions checked: {len(rep['cards'])}")
    by_pos: dict = {}
    for i in issues:
        by_pos.setdefault((i.account_id, i.symbol), []).append(i)
    clean = [k for k in rep["cards"] if k not in by_pos and keep(*k)]
    print(f"   clean (all invariants hold): {len(clean)}  "
          + ", ".join(f"{a}:{s}" for a, s in clean))

    print(f"\n== issues: {len(issues)}  "
          + "  ".join(f"{s}={sum(1 for i in issues if i.severity == s)}" for s in ("ERROR", "WARN")))
    for (acct, sym), its in sorted(by_pos.items(), key=lambda kv: (min(sev_order[i.severity] for i in kv[1]), kv[0][0], str(kv[0][1]))):
        print(f"\n  [{acct}] {sym or ''}")
        for i in sorted(its, key=lambda i: sev_order[i.severity]):
            print(f"    {i.severity:5} {i.code:16} {i.message}")
        if args.card and (acct, sym) in rep["cards"]:
            _print_card(rep["cards"][(acct, sym)])
    if args.card:
        for k in clean:
            print(f"\n  [{k[0]}] {k[1]}  (clean)")
            _print_card(rep["cards"][k])

    print("\n== I4 cash: ledger vs broker balance you typed in (EDIT / reconcile)")
    print(f"    {'account':10} {'date':10} {'ccy':3} {'broker':>14} {'ledger':>14} {'unexplained':>14}")
    for c in rep["cash_checks"]:
        if args.account and c["account_id"] != args.account:
            continue
        print(f"    {c['account_id']:10} {c['date']:10} {c['currency']:3} {_fmt(c['broker_balance']):>14} "
              f"{_fmt(c['ledger_balance']):>14} {_fmt(c['unexplained']):>14}"
              + (f"  ({c['missing_fx']} events without FX skipped)" if c["missing_fx"] else ""))

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump({
                "events": [dict(e.row(), confidence=e.confidence, stored_pnl=e.stored_pnl) for e in events],
                "issues": [i.as_dict() for i in issues],
                "cash_checks": rep["cash_checks"],
                "by_type": rep["by_type"], "buy_confidence": rep["buy_confidence"],
            }, fh, ensure_ascii=False, indent=1, default=str)
        print(f"\nreport written: {args.json}")

    if args.apply:
        if args.account or args.symbol:
            print("\n--apply posts the whole book; drop --account/--symbol")
            return 2
        conn.close()
        try:
            res = apply_reviewed_book(DB_PATH, accept_warnings=args.accept_warnings)
        except ValueError as exc:
            print(str(exc))
            return 1
        print(f"\nbackup: {res['backup']}\ninserted {res['inserted']}, already present {res['already_present']}")
    else:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
