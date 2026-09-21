"""Re-book past sells at one pooled average cost per sale.

Why this exists
---------------
`/api/v2/portfolio/sell` priced each sale off the AVCO of the lots still open at
that instant, but never wrote that average back to the rows. Two consequences:

1. The lot left behind kept its own `price_entry`, so selling a cheap lot
   re-priced the remainder upward — SNDK's ENTRY jumped 1616.2403 -> 1648.8074.
2. SellModal fills a multi-lot sale one lot at a time, so every call after the
   first saw a pool the previous call had already skewed, and each closed row
   booked P&L at a different average.

The router now rebases open lots on every sell, which fixes new sales. This
script repairs the rows written before that.

Method: group closed trades by (account, symbol, exit date) — one logical sale —
and re-book every row of that sale, plus the lots still open, at the average
cost of the whole position as it stood just before the sale. Cost basis is
conserved: sold_basis + open_basis equals the pool that went in.

Usage (from backend/):
    python scripts/repair_avco_history.py --dry-run            # report only
    python scripts/repair_avco_history.py --symbol SNDK        # one symbol
    python scripts/repair_avco_history.py --apply              # write
The DB is copied to portfolio.db.bak-<timestamp> before any write.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
import uuid
from collections import defaultdict
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config import DB_PATH  # noqa: E402

EPS = 1e-9


def _rows(conn, symbol: str | None):
    sql = "SELECT * FROM trades WHERE 1 = 1"
    params: list = []
    if symbol:
        sql += " AND UPPER(symbol) = ?"
        params.append(symbol.upper())
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def _purchase_prices(conn) -> dict[str, float]:
    """The price each lot was actually bought at, for rows this script has touched.

    The replay reads `price_entry` as the buy side of the pool, and a repair
    overwrites it with an average — so a second run would replay its own output
    and drift further. The first repair of a row logs the price it replaced, so
    that is what a re-run must read instead. Idempotent by construction: run it
    twice and the second run reports nothing.
    """
    out: dict[str, float] = {}
    rows = conn.execute(
        "SELECT trade_id, fields_changed FROM trade_audit_log "
        "WHERE action = 'AVCO_REPAIR' ORDER BY id"
    ).fetchall()
    for r in rows:
        if r["trade_id"] in out:
            continue  # the earliest entry holds the untouched price
        try:
            old = json.loads(r["fields_changed"] or "{}").get("price_entry", {}).get("old")
        except (ValueError, AttributeError):
            continue
        if old is not None:
            out[r["trade_id"]] = float(old)
    return out


def plan(conn, symbol: str | None, skipped: list | None = None) -> list[dict]:
    """Replay every position's buys and sells in date order.

    One running pool per (account, symbol): a buy adds volume at its own price,
    a sell takes volume out at the pool's average and books that average as the
    closed row's cost. Whatever is left when the replay ends is the average the
    open lots must carry.
    """
    skipped = skipped if skipped is not None else []
    original = _purchase_prices(conn)
    by_position: dict[tuple, list[dict]] = defaultdict(list)
    for row in _rows(conn, symbol):
        by_position[(row["account_id"], str(row["symbol"]).upper())].append(row)

    changes: list[dict] = []
    for (account_id, sym), rows in by_position.items():
        if not any(r["date_exit"] for r in rows):
            continue  # nothing was ever sold, so no average to restore

        events: list[tuple] = []
        for r in rows:
            vol = float(r["volume"] or 0)
            # 0 sorts buys ahead of same-day sells: you cannot sell what the
            # day's own purchase has not added to the pool yet.
            events.append((str(r["date_entry"] or ""), 0, r["id"], vol,
                           original.get(r["id"], float(r["price_entry"] or 0))))
            if r["date_exit"]:
                events.append((str(r["date_exit"]), 1, r["id"], vol, None))
        events.sort(key=lambda e: (e[0], e[1]))

        basis: dict[str, float] = {}
        pool_vol = 0.0
        pool_cost = 0.0
        broken = ""
        for _date, kind, rid, vol, price in events:
            if kind == 0:
                pool_vol += vol
                pool_cost += price * vol
                continue
            # A sell larger than the pool means the buy side is not all here —
            # an import that starts mid-position, or a split the rows never got.
            # Averaging what is left would invent a cost basis, so stop.
            if vol > pool_vol + 1e-6:
                broken = (f"sells {vol:.4f} against a pool of {pool_vol:.4f} "
                          "— the buy history is incomplete")
                break
            avco = pool_cost / pool_vol if pool_vol > EPS else price or 0.0
            basis[rid] = avco
            pool_vol -= vol
            pool_cost -= avco * vol
        if broken:
            skipped.append((account_id, sym, broken))
            continue
        final_avco = pool_cost / pool_vol if pool_vol > EPS else None
        for r in rows:
            if not r["date_exit"] and final_avco is not None:
                basis[r["id"]] = final_avco

        for r in rows:
            if r["id"] not in basis:
                continue
            old = float(r["price_entry"] or 0)
            new = basis[r["id"]]
            # price_entry is stored at 4dp, so anything below that is the
            # rounding the previous write already did, not a change to make.
            if round(old, 4) == round(new, 4):
                continue
            vol = float(r["volume"] or 0)
            change = {
                "id": r["id"], "account_id": account_id, "symbol": sym,
                "date_entry": r["date_entry"], "date_exit": r["date_exit"],
                "volume": vol, "old_entry": round(old, 4), "new_entry": round(new, 4),
                "old_pnl": r["pnl_amount"], "new_pnl": None, "new_pnl_pct": None,
            }
            if r["date_exit"] and r["price_exit"] is not None:
                exit_price = float(r["price_exit"])
                change["new_pnl"] = round((exit_price - new) * vol, 2)
                change["new_pnl_pct"] = round((exit_price / new - 1) * 100, 2) if new > 0 else 0
            changes.append(change)
    return changes


def apply(conn, changes: list[dict]) -> None:
    for c in changes:
        if c["new_pnl"] is None:
            conn.execute("UPDATE trades SET price_entry = ? WHERE id = ?",
                         (c["new_entry"], c["id"]))
        else:
            wl = "W" if c["new_pnl"] >= 0 else "L"
            conn.execute(
                "UPDATE trades SET price_entry = ?, pnl_amount = ?, pnl_percent = ?, "
                "win_loss = ? WHERE id = ?",
                (c["new_entry"], c["new_pnl"], c["new_pnl_pct"], wl, c["id"]),
            )
        conn.execute(
            """INSERT INTO trade_audit_log
                   (event_id, trade_id, action, fields_changed, reason, snapshot)
               VALUES (?, ?, 'AVCO_REPAIR', ?, ?, ?)""",
            (
                str(uuid.uuid4()), c["id"],
                json.dumps({
                    "price_entry": {"old": c["old_entry"], "new": c["new_entry"]},
                    **({"pnl_amount": {"old": c["old_pnl"], "new": c["new_pnl"]}}
                       if c["new_pnl"] is not None else {}),
                }),
                "re-booked at the pooled average cost of the sale "
                "(repair_avco_history.py)",
                json.dumps({k: c[k] for k in ("symbol", "volume", "date_entry", "date_exit")}),
            ),
        )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", help="repair only this symbol")
    ap.add_argument("--apply", action="store_true", help="write the changes")
    ap.add_argument("--dry-run", action="store_true", help="report only (default)")
    args = ap.parse_args()

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    skipped: list = []
    changes = plan(conn, args.symbol, skipped)

    for account_id, sym, why in skipped:
        print(f"SKIPPED {sym} ({account_id}): {why}")

    if not changes:
        print("nothing to repair")
        return 0

    width = max(len(c["symbol"]) for c in changes)
    realized_delta = 0.0
    for c in changes:
        state = c["date_exit"] or "OPEN"
        line = (f"{c['symbol']:<{width}}  {c['id'][:8]}  {state:<10} "
                f"vol {c['volume']:>12.7f}  entry {c['old_entry']:>10.4f} -> {c['new_entry']:>10.4f}")
        if c["new_pnl"] is not None:
            old = float(c["old_pnl"] or 0)
            realized_delta += c["new_pnl"] - old
            line += f"  pnl {old:>9.2f} -> {c['new_pnl']:>9.2f}"
        print(line)
    print(f"\n{len(changes)} rows, realized P&L change {realized_delta:+.2f}")

    if not args.apply:
        print("dry run — pass --apply to write")
        return 0

    backup = f"{DB_PATH}.bak-{datetime.now():%Y%m%d-%H%M%S}"
    shutil.copy2(DB_PATH, backup)
    print(f"backup: {backup}")
    apply(conn, changes)
    conn.commit()
    print("applied")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
