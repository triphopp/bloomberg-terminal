"""Replay one position by date and write the result back to `trades`.

`/sell` prices a sale off the lots open at the moment it is typed. That is right
only if the book is entered in date order. A buy dated before a sale already
booked, a sale dated before a buy already booked, or an edit of a lot's price,
volume or date leaves the stored sale P&L and the open lots' average on the old
history — the ledger check reports it as I3 / I2
(reports/port-avco-buy-sell-mismatch-risk-report.md).

`replay()` rebuilds the position's stock card from `ledger_backfill` (the same
code the check uses, so the two cannot disagree) and rewrites, per row:

* closed row — price_entry = the average cost at its sale, pnl_amount =
  (exit − avg) × volume − fee_exit, pnl_percent, win_loss
* open row   — price_entry = the average after the last event

The buy price itself lives in `lot_price`, which no sale rewrites. Rows from
before that column get it from the audit trail on first replay.

A position is left alone (and the reason returned) when a manual cost override
is set, when the history sells more than it bought (I6), or when a row exits
before it entered (I7): a replay would only move the error somewhere else.
Every changed row gets an AVCO_REPAIR audit record.

An account with sub-ports (Finansia 6065151 / 6065157) pools each one apart:
`replay()` runs once per sub-port of the symbol (see sub_port.py).
"""
from __future__ import annotations

from typing import Callable, Optional

import ledger_backfill as lb

EPS = 1e-6
ACTION = "AVCO_REPAIR"


def _close(a, b, tol: float) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return abs(float(a) - float(b)) <= tol


def _fill_lot_prices(conn, account_id: str, symbol: str) -> list[str]:
    """Set lot_price where it is NULL, from the price the backfill recovers.

    Returns warnings for lots whose price had to be estimated (edited by hand
    after a sale rewrote it) — the caller should show them to a human.
    """
    missing = conn.execute(
        "SELECT COUNT(*) FROM trades WHERE account_id = ? AND symbol = ? AND lot_price IS NULL",
        (account_id, symbol),
    ).fetchone()[0]
    if not missing:
        return []
    events, issues = lb.build_events(conn, scope=(account_id, symbol))
    for e in events:
        if e.type == "BUY" and e.price is not None:
            ph = ",".join("?" * len(e.source_ref))
            conn.execute(
                f"UPDATE trades SET lot_price = ? WHERE lot_price IS NULL AND id IN ({ph})",
                [e.price, *e.source_ref],
            )
    return [i.message for i in issues if i.code == "B_PRICE_EDITED"]


def _leg_fee(row: dict) -> float:
    """fee_exit, or for a legacy row without one the commission its stored P&L
    implies — the same rule ledger_backfill uses, so replay keeps it."""
    if row.get("fee_exit") is not None:
        return float(row["fee_exit"])
    px, pe, vol = lb._f(row.get("price_exit")), lb._f(row.get("price_entry")), lb._f(row.get("volume"))
    implied = (px - pe) * vol - lb._f(row.get("pnl_amount"))
    return implied if 0.005 < implied <= 0.05 * px * vol else 0.0


def pools(conn, account_id: str, symbol: str) -> list[str]:
    """The sub-port pools this symbol has in the account ("" = the only one)."""
    events, _ = lb.build_events(conn, scope=(account_id, symbol))
    return sorted({e.sub_port for e in events if e.type in ("BUY", "SELL")}) or [""]


def plan(conn, account_id: str, symbol: str, sub_port: str = "") -> dict:
    """What replay() would write for one pool, without writing anything but lot_price."""
    if conn.execute(
        "SELECT 1 FROM position_cost_overrides WHERE account_id = ? AND symbol = ?",
        (account_id, symbol),
    ).fetchone():
        return {"skipped": "manual cost override in place", "changes": [], "warnings": []}

    warnings = _fill_lot_prices(conn, account_id, symbol)
    events, issues = lb.build_events(conn, scope=(account_id, symbol, sub_port))
    in_pool = {i for e in events for i in e.source_ref}
    bad = [i for i in issues if i.code == "I7"]
    if bad:
        return {"skipped": bad[0].message, "changes": [], "warnings": warnings}
    card = lb.stock_card([e for e in events if e.type in ("BUY", "SELL")])
    if any(r["bal_qty"] < -EPS for r in card):
        return {"skipped": "sells more than it bought — buy history is incomplete",
                "changes": [], "warnings": warnings}

    rows = {r["id"]: dict(r) for r in conn.execute(
        "SELECT * FROM trades WHERE account_id = ? AND symbol = ?", (account_id, symbol))
        if r["id"] in in_pool}
    target: dict[str, dict] = {}
    for c in card:
        e = c["event"]
        if e.type != "SELL" or not e.qty:
            continue
        avg = c["cost_out"] / e.qty
        for tid in e.source_ref:
            r = rows[tid]
            vol, px = lb._f(r["volume"]), lb._f(r["price_exit"])
            fee = _leg_fee(r)
            pnl = round((px - avg) * vol - fee, 2)
            # fee_exit stays as it is: a legacy NULL means "not recorded", and
            # the fee it implies survives because the P&L is rewritten net of it.
            target[tid] = {
                "price_entry": avg,
                "pnl_amount": pnl,
                "pnl_percent": round((px / avg - 1) * 100, 2) if avg > 0 else 0,
                "win_loss": "W" if pnl >= 0 else "L",
            }
    end_avg = card[-1]["avg"] if card else None
    if end_avg is not None:
        for tid, r in rows.items():
            if r.get("win_loss") == "P":
                target[tid] = {"price_entry": end_avg}

    changes = []
    for tid, new in target.items():
        old = rows[tid]
        diff = {}
        for k, v in new.items():
            tol = {"price_entry": 1e-6, "pnl_amount": 0.005, "pnl_percent": 0.005,
                   "fee_exit": 1e-6}.get(k)
            same = (old.get(k) == v) if tol is None else _close(old.get(k), v, tol)
            if not same:
                diff[k] = v
        if diff:
            changes.append({"id": tid, "old": old, "new": diff})
    return {"skipped": None, "changes": changes, "warnings": warnings, "avg": end_avg,
            "sub_port": sub_port}


def replay(conn, account_id: str, symbol: str,
           audit: Optional[Callable] = None, reason: str = "") -> dict:
    """Re-derive the position by date and write it. Same transaction as `conn`.

    `audit(conn, trade_id, action, old_row, new_values, reason)` — the router's
    _write_audit_log; injected so this module does not import the router.
    """
    why = f"AVCO replay by date{': ' + reason if reason else ''}"
    results = []
    for sub in pools(conn, account_id, symbol):
        result = plan(conn, account_id, symbol, sub)
        for ch in result["changes"]:
            cols = ", ".join(f"{k} = ?" for k in ch["new"])
            conn.execute(f"UPDATE trades SET {cols} WHERE id = ?", [*ch["new"].values(), ch["id"]])
            if audit:
                audit(conn, ch["id"], ACTION, ch["old"], ch["new"],
                      why + (f" [sub-port {sub}]" if sub else ""))
        results.append(result)
    # One pool (every account without sub-ports) reads exactly as before; with
    # several, the first skip is reported and each pool's outcome is listed.
    head = next((r for r in results if r.get("skipped")), results[0])
    out = {k: v for k, v in head.items() if k not in ("changes", "sub_port")}
    out["warnings"] = [w for r in results for w in r["warnings"]]
    out["rows_changed"] = sum(len(r["changes"]) for r in results)
    out["sales_repriced"] = sum(1 for r in results for c in r["changes"] if "pnl_amount" in c["new"])
    if len(results) > 1:
        out["pools"] = {r["sub_port"]: {"skipped": r["skipped"], "avg": r.get("avg"),
                                        "rows_changed": len(r["changes"])} for r in results}
    return out
