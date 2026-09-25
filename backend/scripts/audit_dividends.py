"""Run dividend_check over every recorded dividend. Read-only.

Usage (from backend/):
    python scripts/audit_dividends.py              # issues only
    python scripts/audit_dividends.py --all        # every row
    python scripts/audit_dividends.py --account dime
"""
from __future__ import annotations

import argparse
import io
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config import DB_PATH  # noqa: E402
import dividend_check  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--account")
    args = ap.parse_args()
    if hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    uri = "file:" + os.path.abspath(DB_PATH).replace("\\", "/") + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    sql = "SELECT * FROM dividends"
    params: list = []
    if args.account:
        sql += " WHERE account_id = ?"
        params.append(args.account)
    rows = [dict(r) for r in conn.execute(sql + " ORDER BY account_id, pay_date", params)]
    counts = {"error": 0, "warn": 0, "info": 0}
    for r in rows:
        res = dividend_check.check(
            conn, account_id=r["account_id"], asset=r["asset"], ex_date=r["ex_date"],
            pay_date=r["pay_date"], amount_per_unit=float(r["amount_per_unit"] or 0),
            total_received=float(r["total_received"] or 0), currency=r["currency"],
            dividend_id=r["id"],
        )
        issues = res["issues"]
        for i in issues:
            counts[i["level"]] = counts.get(i["level"], 0) + 1
        if issues or args.all:
            exp = res["expected_per_unit"]
            print(f"{r['account_id']:9} {r['asset']:8} ex {str(r['ex_date'])[:10]:10} "
                  f"{float(r['amount_per_unit'] or 0):>9.4f} {r['currency'] or '?':3}/unit  "
                  f"total {float(r['total_received'] or 0):>10.2f}  market {exp if exp is not None else '—'}  "
                  f"held {res['held_units']}")
            for i in issues:
                print(f"    {i['level'].upper():5} {i['code']:18} {i['message']}")
    print(f"\n{len(rows)} dividends · errors {counts['error']} · warnings {counts['warn']} · info {counts['info']}")
    return 1 if counts["error"] else 0


if __name__ == "__main__":
    sys.exit(main())
