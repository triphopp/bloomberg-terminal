"""
Rebuild derived tables from their synced base tables after a merge.

`paper_positions` is a running aggregate, so it is deliberately absent from
SYNC_TABLES (see config.py). `paper_fills` and `paper_orders` are append-only
with uuid PKs — they union across devices without ever colliding — so replaying
them reproduces the position book exactly, with every device's fills included.

The replay mirrors paper_trading.py:_execute_fill() step for step, including its
rounding, so a rebuild on a device that never synced is a no-op rather than a
silent re-pricing.
"""
import logging
import sqlite3
import uuid

from .restore import _guarded

logger = logging.getLogger("sync")


def rebuild_paper_positions(conn: sqlite3.Connection) -> int:
    """Replay every fill into paper_positions. Returns the row count written."""
    try:
        fills = conn.execute("""
            SELECT po.account_id, po.symbol, po.side,
                   pf.quantity, pf.price, pf.filled_at, pf.id
            FROM paper_fills pf
            JOIN paper_orders po ON pf.order_id = po.id
            ORDER BY pf.filled_at, pf.id
        """).fetchall()
    except sqlite3.OperationalError:
        return 0  # paper tables not created on this device

    # (account_id, symbol) → {quantity, avg_cost, realized_pnl}
    book: dict[tuple[str, str], dict] = {}

    for f in fills:
        key = (f["account_id"], f["symbol"])
        pos = book.get(key)
        qty, price = f["quantity"], f["price"]

        if f["side"] == "buy":
            if pos is None:
                book[key] = {"quantity": qty, "avg_cost": price, "realized_pnl": 0.0}
                continue
            new_qty = pos["quantity"] + qty
            new_avg = ((pos["quantity"] * pos["avg_cost"]) + (qty * price)) / new_qty if new_qty else 0
            pos["quantity"] = round(new_qty, 8)
            pos["avg_cost"] = round(new_avg, 6)
        else:  # sell
            if pos is None:
                # a sell with no matching buy — the fills of the opening trade
                # never made it here. Skip rather than invent a short position.
                logger.warning("rebuild: sell with no open position %s/%s", *key)
                continue
            realized = (price - pos["avg_cost"]) * qty
            pos["quantity"] = round(pos["quantity"] - qty, 8)
            pos["realized_pnl"] = round(pos["realized_pnl"] + realized, 2)
            if pos["quantity"] < 1e-8:
                # _execute_fill deletes the row at zero, dropping realized_pnl
                # with it — match that, or rebuilt books would disagree.
                del book[key]

    written = 0
    # Guarded like restore(): the wipe-and-replace below is bookkeeping, not a
    # user edit. Ungurded it would fire the DELETE trigger once per position and
    # bury sync_tombstones under rows that mean nothing to any peer.
    with _guarded(conn):
        conn.execute("DELETE FROM paper_positions")
        for (account_id, symbol), pos in book.items():
            try:
                conn.execute(
                    "INSERT INTO paper_positions "
                    "(id, account_id, symbol, quantity, avg_cost, realized_pnl) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (uuid.uuid4().hex[:12], account_id, symbol,
                     pos["quantity"], pos["avg_cost"], pos["realized_pnl"]),
                )
                written += 1
            except sqlite3.IntegrityError:
                # orders merged ahead of their account row — the next pull that
                # brings paper_accounts across rebuilds this position correctly
                logger.warning("rebuild: no account %s for %s", account_id, symbol)
    return written


def rebuild_all(conn: sqlite3.Connection) -> dict[str, int]:
    return {"paper_positions": rebuild_paper_positions(conn)}
