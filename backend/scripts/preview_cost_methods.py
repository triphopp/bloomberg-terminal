"""Compare recorded realized P&L with AVCO and FIFO without restating data.

    python scripts/preview_cost_methods.py --account dime --json preview.json
"""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from accounting_io import read_book
from config import DB_PATH
from ledger_backfill import build_events
from ledger_engine import LedgerError, replay


def compare(conn, account_id=None):
    events, issues = build_events(conn)
    positions = defaultdict(list)
    for e in events:
        if e.type in ("BUY", "SELL") and not e.note.startswith("option") and (not account_id or e.account_id == account_id):
            positions[(e.account_id, e.symbol)].append(e)
    results = []
    for (aid, symbol), events in sorted(positions.items()):
        row = {"account_id": aid, "symbol": symbol, "currency": events[0].currency,
               "recorded_realized": sum(e.stored_pnl or 0 for e in events if e.type == "SELL"), "methods": {}}
        for method in ("AVCO", "FIFO"):
            try:
                card = replay(events, method)
            except LedgerError as exc:
                row["methods"][method] = {"error": str(exc)}
                continue
            realized = sum(r["realized"] or 0 for r in card)
            row["methods"][method] = {
                "realized": realized, "delta_vs_recorded": realized - row["recorded_realized"],
                "remaining_qty": card[-1]["bal_qty"], "remaining_cost": card[-1]["bal_cost"],
                "sales": [{"event_id": r["event"].id, "date": r["event"].trade_date,
                           "qty": r["qty_out"], "recorded": r["event"].stored_pnl,
                           "replayed": r["realized"], "cost_out": r["cost_out"],
                           "delta": None if r["event"].stored_pnl is None else r["realized"] - r["event"].stored_pnl}
                          for r in card if r["event"].type == "SELL"],
            }
        results.append(row)
    return {"mode": "dry-run", "account_id": account_id, "source": "reconstructed",
            "note": "No account setting, trade, ledger, cash offset or return was changed. Same-day execution order must be verified against broker records.",
            "positions": results, "findings": [i.as_dict() for i in issues if not account_id or i.account_id == account_id]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=str(DB_PATH))
    parser.add_argument("--account")
    parser.add_argument("--json", help="Write full preview to a JSON file")
    args = parser.parse_args()
    with read_book(args.db) as conn:
        result = compare(conn, args.account)
    if args.json:
        Path(args.json).write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
        print(args.json)
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
