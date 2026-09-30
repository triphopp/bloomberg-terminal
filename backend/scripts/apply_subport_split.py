"""Split average cost per sub-port for accounts with sub-accounts, once.

2026-09-30 — plans/port-subport-split.md. /sell and the AVCO replay used to pool
every open lot of (account, symbol), so OR held in Finansia 6065151 and 6065157
carried one mixed average. They now pool per sub-port (sub_port.py); this
script brings the stored book in line:

1. Rows split off by a partial sale were written with an empty note and lost
   their sub-port. Each gets its parent lot's tag back (via the audit trail).
2. `--tag-untagged SUB` tags the account's remaining untagged rows (history
   from before the sub-accounts existed) with SUB, so they are not left in a
   pool of their own.
3. Every (account, symbol) is replayed by date, per sub-port.

Total open cost is conserved when only open lots move between pools; a
repriced sale moves derived cash, which a DATA_FIX offset cancels (same rule as
apply_avco_replay.py) so cash stays on the broker figure.

    python scripts/apply_subport_split.py                                # dry run
    python scripts/apply_subport_split.py --tag-untagged 0153717         # dry run, with 2.
    python scripts/apply_subport_split.py --tag-untagged 0153717 --apply # backup + write
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
import uuid
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import avco_replay  # noqa: E402
import db  # noqa: E402
from routers.portfolio_v2 import _lot_family, _write_audit_log  # noqa: E402
from scripts.apply_avco_replay import _cash_delta, _trades  # noqa: E402
from sub_port import split_accounts, sub_port_of, sub_port_segment  # noqa: E402

_NS = uuid.UUID("5c1e9a3d-7b2f-4d6a-8e0c-3f9b1a2d4e57")
REASON = "sub-port split: AVCO pooled per sub-port — 2026-09-30 (port-subport-split)"


def _backup() -> Path:
    dst = Path(__file__).resolve().parent.parent / "backups" / (
        f"portfolio.db.bak-{datetime.now():%Y%m%d-%H%M%S}-pre-subport-split")
    dst.parent.mkdir(exist_ok=True)
    s = db.connect(readonly=True)
    d = sqlite3.connect(dst)  # db-ok: fresh backup file, not the book
    s.backup(d)
    d.close(); s.close()
    return dst


def _retag(conn, row: dict, segment: str, why: str) -> None:
    note = row.get("note") or ""
    new = f"{segment} | {note}" if note.strip() else segment
    conn.execute("UPDATE trades SET note = ? WHERE id = ?", (new, row["id"]))
    _write_audit_log(conn, row["id"], "PATCH", {"note": note}, {"note": new}, why)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--account", default="finansia")
    ap.add_argument("--tag-untagged", metavar="SUB",
                    help="tag the account's rows that still have no sub-port with this one")
    args = ap.parse_args()

    db.init_db(); db.init_portfolio_v2()
    if args.apply:
        print("backup:", _backup())

    with db.get_db() as conn:
        acct = args.account
        before = _trades(conn)
        rows = {tid: r for tid, r in before.items() if r["account_id"] == acct}

        with db.audit_reason(conn, REASON):
            # 1. split rows get their parent's sub-port back
            for tid, r in rows.items():
                if sub_port_of(r["note"]):
                    continue
                seg = next((sub_port_segment(rows[m]["note"]) for m in _lot_family(conn, tid)
                            if m in rows and sub_port_segment(rows[m]["note"])), "")
                if seg:
                    print(f"retag split row {tid[:8]} {r['symbol']:7} {r['win_loss']} → {seg}")
                    _retag(conn, r, seg, "split row: sub-port of its parent lot")
                    rows[tid] = dict(conn.execute("SELECT * FROM trades WHERE id = ?", (tid,)).fetchone())

            # 2. history from before the sub-accounts
            if args.tag_untagged:
                name = next((sub_port_segment(r["note"]).rsplit(" (", 1)[0]
                             for r in rows.values() if sub_port_segment(r["note"])), acct)
                seg = f"{name} ({args.tag_untagged})"
                for tid, r in rows.items():
                    if not sub_port_of(r["note"]):
                        print(f"tag untagged    {tid[:8]} {r['symbol']:7} {r['win_loss']} "
                              f"{r['date_entry']} → {seg}")
                        _retag(conn, r, seg, f"untagged history assigned to {args.tag_untagged}")

            left = [r for r in conn.execute(
                "SELECT id, symbol, note FROM trades WHERE account_id = ?", (acct,))
                if not sub_port_of(r["note"])]
            if left and acct in split_accounts(conn):
                print(f"\n{len(left)} row(s) still untagged — they form a pool of their own:",
                      sorted({r['symbol'] for r in left}))

            # 3. replay per sub-port
            print()
            results = {}
            for (sym,) in conn.execute(
                    "SELECT DISTINCT symbol FROM trades WHERE account_id = ? ORDER BY 1", (acct,)):
                results[sym] = avco_replay.replay(conn, acct, sym, audit=_write_audit_log,
                                                  reason="sub-port split")

        after = _trades(conn)
        for sym, r in results.items():
            if r["rows_changed"] or r.get("skipped") or r.get("warnings"):
                print(f"{sym:8} rows {r['rows_changed']:3} sales {r['sales_repriced']:3}"
                      + (f"  SKIPPED: {r['skipped']}" if r.get("skipped") else "")
                      + (f"  WARN: {r['warnings']}" if r.get("warnings") else ""))
        for tid, o in before.items():
            n = after[tid]
            if o["account_id"] != acct:
                continue
            moved = {k: (o[k], n[k]) for k in ("price_entry", "pnl_amount")
                     if (o[k] or 0) != (n[k] or 0) and abs((o[k] or 0) - (n[k] or 0)) > 1e-9}
            if moved:
                print(f"  {o['symbol']:7} {tid[:8]} [{sub_port_of(n['note']) or '-'}] {o['win_loss']}"
                      f" vol {o['volume']:g}: "
                      + ", ".join(f"{k} {a:.4f} → {b:.4f}" for k, (a, b) in moved.items()))

        delta = _cash_delta(before, after)
        print("\nderived cash move (to cancel):", delta or "none")
        today = datetime.now().strftime("%Y-%m-%d")
        with db.audit_reason(conn, REASON):
            for (a, ccy), move in delta.items():
                conn.execute(
                    "INSERT INTO cash_adjustments (id, account_id, date, amount, currency, "
                    "target_balance, derived_before, note, category) VALUES (?,?,?,?,?,?,?,?,?)",
                    (str(uuid.uuid5(_NS, f"{a}|{ccy}|{today}")), a, today, -move, ccy, None, None,
                     f"Sub-port split repriced sales: derived cash moved {move:+.2f} {ccy}. "
                     f"Cancels it so cash stays on the broker figure. No deposit/withdrawal.",
                     "DATA_FIX"),
                )
        if not args.apply:
            conn.rollback()
            print("dry run — rolled back (use --apply)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
