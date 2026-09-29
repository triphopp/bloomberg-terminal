"""Replay every position by date once, and keep today's cash where it is.

2026-09-28 — reports/port-avco-buy-sell-mismatch-risk-report.md. Sale P&L and
open-lot averages had drifted from the dated stock card (ledger check I3/I2).
avco_replay now re-derives a position on every trade write; this script does
it for the whole book once.

Where a closed position's stored P&L did not add up, the fix moves derived cash.
Earlier UNKNOWN reconcile offsets had absorbed that error against the broker
balance, so a DATA_FIX offset per (account, currency) cancels the move: cash
stays on the broker figure, the P&L becomes correct.

    python scripts/apply_avco_replay.py            # dry run: prints what changes
    python scripts/apply_avco_replay.py --apply    # backup, replay, offsets
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
import uuid
from collections import defaultdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import avco_replay  # noqa: E402
import db  # noqa: E402
from routers.portfolio_v2 import _write_audit_log  # noqa: E402

_NS = uuid.UUID("0b7f3c2e-5d1a-4e8b-9c6f-2a4d8e1b7c30")
REASON = "AVCO replay by date — whole book, 2026-09-28 (port-avco-dated-replay)"


def _trades(conn) -> dict:
    return {r["id"]: dict(r) for r in conn.execute("SELECT * FROM trades")}


def _cash_delta(old: dict, new: dict) -> dict:
    """Derived-cash move per (account, currency): Δrealized − Δopen cost."""
    out: dict[tuple, float] = defaultdict(float)
    for tid, o in old.items():
        n = new[tid]
        key = (o["account_id"], (o.get("currency") or "USD").upper())
        if o["win_loss"] != "P":
            out[key] += float(n["pnl_amount"] or 0) - float(o["pnl_amount"] or 0)
        else:
            out[key] -= (float(n["price_entry"]) - float(o["price_entry"])) * float(o["volume"])
    return {k: round(v, 2) for k, v in out.items() if abs(v) >= 0.005}


def _backup() -> Path:
    dst = Path(__file__).resolve().parent.parent / "backups" / (
        f"portfolio.db.bak-{datetime.now():%Y%m%d-%H%M%S}-pre-avco-replay")
    dst.parent.mkdir(exist_ok=True)
    s = db.connect(readonly=True)
    d = sqlite3.connect(dst)  # db-ok: fresh backup file, not the book
    s.backup(d)
    d.close(); s.close()
    return dst


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db.init_db(); db.init_portfolio_v2()
    if args.apply:
        print("backup:", _backup())

    with db.get_db() as conn:
        before = _trades(conn)
        results = {}
        with db.audit_reason(conn, REASON):
            for acct, sym in conn.execute(
                    "SELECT DISTINCT account_id, symbol FROM trades ORDER BY 1, 2").fetchall():
                results[(acct, sym)] = avco_replay.replay(
                    conn, acct, sym, audit=_write_audit_log, reason="whole-book repair")
        after = _trades(conn)
        delta = _cash_delta(before, after)

        for (acct, sym), r in results.items():
            if r["rows_changed"] or r.get("skipped") or r.get("warnings"):
                print(f"{acct:10} {sym:8} rows {r['rows_changed']:3} sales {r['sales_repriced']:3}"
                      + (f"  SKIPPED: {r['skipped']}" if r.get("skipped") else "")
                      + (f"  WARN: {r['warnings']}" if r.get("warnings") else ""))
        print("rows changed:", sum(r["rows_changed"] for r in results.values()))
        print("derived cash move (to cancel):", delta)

        today = datetime.now().strftime("%Y-%m-%d")
        with db.audit_reason(conn, REASON):
            for (acct, ccy), move in delta.items():
                syms = sorted({s for (a, s), r in results.items() if a == acct and r["sales_repriced"]})
                conn.execute(
                    "INSERT INTO cash_adjustments (id, account_id, date, amount, currency, "
                    "target_balance, derived_before, note, category) VALUES (?,?,?,?,?,?,?,?,?)",
                    (str(uuid.uuid5(_NS, f"{acct}|{ccy}|{today}")), acct, today, -move, ccy,
                     None, None,
                     f"AVCO replay by date corrected realized P&L ({', '.join(syms)}): derived cash "
                     f"moved {move:+.2f} {ccy}. Earlier reconcile offsets had absorbed that error "
                     f"against the broker balance; this cancels it so cash stays on the broker figure. "
                     f"No deposit/withdrawal.",
                     "DATA_FIX"),
                )
        if not args.apply:
            conn.rollback()
            print("dry run — rolled back (use --apply)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
