"""Deterministic AVCO/FIFO replay. No database, quotes, or mutations.

Amounts stay Decimal throughout a replay. Round only when presenting values;
closing the last share consumes every remaining cent of cost. Invalid history
is rejected rather than converted into a plausible profit.
"""
from __future__ import annotations

from decimal import Decimal, localcontext


class LedgerError(ValueError):
    pass


def dec(value) -> Decimal:
    number = Decimal(str(value if value is not None else 0))
    if not number.is_finite():
        raise LedgerError("Ledger numbers must be finite")
    return number


def replay(events, method="AVCO") -> list[dict]:
    if method not in ("AVCO", "FIFO"):
        raise LedgerError("Cost method must be AVCO or FIFO")
    events = [e for e in events if e.type in ("BUY", "SELL")]
    if len({(e.account_id, e.symbol, e.currency) for e in events}) > 1:
        raise LedgerError("Replay requires one account, symbol and currency")
    ids = [e.id for e in events]
    if len(ids) != len(set(ids)):
        raise LedgerError("Duplicate event id")
    ordered = sorted(events, key=lambda e: (e.trade_date, e.trade_time or "",
                                           0 if e.type == "BUY" else 1, e.id))
    lots, rows = [], []
    balance = cost = Decimal(0)
    with localcontext() as ctx:
        ctx.prec = 36
        for e in ordered:
            qty, gross = dec(e.qty), dec(e.gross)
            fee, vat, tax = (dec(getattr(e, k, 0)) for k in ("fee", "vat", "tax"))
            if qty <= 0 or min(gross, fee, vat, tax) < 0:
                raise LedgerError(f"{e.id}: quantity must be positive; amounts nonnegative")
            allocations = []
            if e.type == "BUY":
                incoming = gross + fee + vat
                balance += qty
                cost += incoming
                lots.append({"id": e.id, "qty": qty, "cost": incoming})
                outgoing, realized = Decimal(0), None
            else:
                if balance <= 0 or qty > balance + Decimal("0.00000001"):
                    raise LedgerError(f"{e.id}: sale {qty} exceeds held quantity {balance}")
                # Absorb only sub-share numerical noise from legacy float rows.
                qty = min(qty, balance)
                all_out = balance - qty <= Decimal("0.00000001")
                if all_out:
                    qty = balance
                outgoing = Decimal(0)
                remaining = qty
                old_balance = balance
                old_cost = cost
                for lot in lots:
                    if lot["qty"] == 0 or remaining == 0:
                        continue
                    take = (lot["qty"] if all_out else lot["qty"] * qty / old_balance) if method == "AVCO" else min(remaining, lot["qty"])
                    if method == "AVCO":
                        allocated = old_cost * take / old_balance
                    else:
                        allocated = lot["cost"] if take == lot["qty"] else lot["cost"] * take / lot["qty"]
                    allocations.append({"sell_event_id": e.id, "buy_event_id": lot["id"],
                                        "qty": float(take), "unit_cost": float(allocated / take),
                                        "cost": float(allocated)})
                    lot["qty"] -= take
                    lot["cost"] -= allocated
                    outgoing += allocated
                    remaining -= take
                if method == "AVCO":
                    outgoing = old_cost if all_out else old_cost * qty / old_balance
                balance -= qty
                cost -= outgoing
                if all_out:
                    balance = cost = Decimal(0)
                    lots = []
                # AVCO lots carry a pooled cost; keep their residual costs in
                # proportion after a sale (FIFO retains its original costs).
                elif method == "AVCO":
                    for lot in lots:
                        lot["cost"] = cost * lot["qty"] / balance
                incoming = Decimal(0)
                realized = gross - fee - vat - tax - outgoing
            rows.append({"event": e, "qty_in": float(qty) if e.type == "BUY" else 0,
                         "qty_out": float(qty) if e.type == "SELL" else 0,
                         "cost_in": float(incoming), "cost_out": float(outgoing),
                         "realized": float(realized) if realized is not None else None,
                         "bal_qty": float(balance), "bal_cost": float(cost),
                         "avg": float(cost / balance) if balance else None,
                         "allocations": allocations})
    return rows
