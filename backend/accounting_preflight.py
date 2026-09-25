"""Pure preparation checks for dividends, opening balances, wallets and transfers.

These routines calculate proposals. They do not choose broker policy, post a
dividend, change a return, or estimate a missing statement balance.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
import re

from ledger_engine import dec


CASH_ADJUSTMENT_CATEGORIES = frozenset({
    "FX_REVALUATION", "FEE", "TAX", "INTEREST", "MISSING_DEPOSIT",
    "MISSING_WITHDRAWAL", "MISSING_TRADE", "DATA_FIX", "UNKNOWN",
})


def _money(value):
    return float(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def dividend_amounts(*, gross=None, net=None, tax_rate=None, tax_withheld=None):
    """D4: preserve an explicitly entered net; never infer a tax jurisdiction."""
    if gross is None and net is None:
        raise ValueError("Enter gross or net dividend")
    if tax_rate is not None and not 0 <= dec(tax_rate) < 1:
        raise ValueError("Tax rate must be between 0 and 1")
    if tax_withheld is None and tax_rate is None and (gross is None or net is None):
        raise ValueError("Enter actual withholding or an explicitly selected tax rate")
    g = dec(gross) if gross is not None else None
    n = dec(net) if net is not None else None
    tax = dec(tax_withheld) if tax_withheld is not None else None
    if g is not None and n is not None:
        if tax is None:
            tax = g - n
        elif abs(g - tax - n) > Decimal("0.01"):
            raise ValueError("Gross minus withholding must equal net")
    elif g is None:
        g = n + tax if tax is not None else n / (1 - dec(tax_rate))
        tax = g - n
    else:
        tax = tax if tax is not None else g * dec(tax_rate)
        n = g - tax
    if min(g, n, tax) < 0:
        raise ValueError("Dividend and withholding cannot be negative")
    gross_rounded, net_rounded = _money(g), _money(n)
    return {"gross_amount": gross_rounded, "tax_withheld": round(gross_rounded-net_rounded, 2),
            "total_received": net_rounded, "effective_rate": float(tax/g) if g else 0,
            "rate_matches": tax_rate is None or not g or abs(tax/g-dec(tax_rate)) <= Decimal("0.005")}


def trade_dates(trade):
    """Reject incomplete history before it can produce a passing preview."""
    entry = str(trade.get("date_entry") or "")[:10]
    exit_ = str(trade.get("date_exit") or "")[:10]
    if not entry:
        raise ValueError("Missing purchase date; holdings cannot be verified")
    date.fromisoformat(entry)
    if not exit_ and trade.get("win_loss") in ("W", "L", "D"):
        raise ValueError("Closed trade has no sale date; holdings cannot be verified")
    if exit_:
        date.fromisoformat(exit_)
        if exit_ < entry:
            raise ValueError("Sale predates purchase; holdings cannot be verified")
    return entry, exit_


def entitlement_units(trades, ex_date, *, today=None):
    """S3 eligibility: bought strictly before XD; selling on XD is entitled."""
    xd = date.fromisoformat(ex_date)
    if xd > date.fromisoformat(today or date.today().isoformat()):
        raise ValueError("Entitlements can only be prepared on or after the ex-date")
    grouped = defaultdict(Decimal)
    for trade in trades:
        entry, exit_ = trade_dates(trade)
        if entry < ex_date and (not exit_ or exit_ >= ex_date):
            sub = trade.get("sub_account")
            if not sub:
                match = re.search(r"\((\d{6,})\)", trade.get("note") or "")
                sub = match.group(1) if match else ""
            qty = dec(trade.get("volume"))
            if qty < 0:
                raise ValueError("Negative holding quantity")
            grouped[(trade["account_id"], sub, trade["symbol"])] += qty
    return [{"account_id": aid, "sub_account": sub or None, "asset": symbol, "ex_date": ex_date,
             "units": float(qty)} for (aid, sub, symbol), qty in sorted(grouped.items()) if qty > 0]


def opening_balance(*, as_of, cash, market_value, positions, held_units=None):
    """O1/O2: cost is separate from opening market value; missing holdings stay unknown."""
    date.fromisoformat(as_of)
    total = dec(cash)
    seen, differences = set(), []
    for p in positions:
        symbol = str(p["symbol"]).strip().upper()
        if not symbol or symbol in seen:
            raise ValueError("Opening positions require distinct nonempty symbols")
        seen.add(symbol)
        qty, price, cost = dec(p["qty"]), dec(p["market_price"]), dec(p["cost_basis"])
        if min(qty, price, cost) < 0:
            raise ValueError("Opening quantities, prices and costs cannot be negative")
        total += qty * price
        if held_units is not None and abs(qty - dec(held_units.get(symbol))) > Decimal("0.000001"):
            differences.append({"symbol": symbol, "statement_qty": float(qty), "ledger_qty": held_units.get(symbol, 0)})
    if held_units is not None:
        for symbol, qty in held_units.items():
            if symbol not in seen and abs(dec(qty)) > Decimal("0.000001"):
                differences.append({"symbol": symbol, "statement_qty": 0, "ledger_qty": qty})
    delta = total - dec(market_value)
    return {"as_of": as_of, "cash": float(dec(cash)), "market_value": float(dec(market_value)),
            "calculated_market_value": _money(total), "difference": _money(delta),
            "O1": abs(delta) <= Decimal("0.01"),
            "O2": None if held_units is None else not differences, "quantity_differences": differences,
            "performance_basis": "market_value", "pnl_basis": "cost_basis"}


def wallet_value(wallets, rates):
    """W1/W2: rates are report-currency per wallet unit, supplied explicitly."""
    total, valued, unpriced = Decimal(0), [], []
    for wallet in wallets:
        currency = wallet["currency"].upper()
        rate = rates.get(currency)
        balance = dec(wallet["balance"])
        if rate is None or dec(rate) <= 0:
            unpriced.append(currency)
            continue
        value = balance * dec(rate)
        total += value
        valued.append({**wallet, "value": _money(value), "W1": balance >= 0 or bool(wallet.get("margin"))})
    return {"wallets": valued, "missing_rates": sorted(set(unpriced)),
            "cash_base": None if unpriced else _money(total), "W2": None if unpriced else True}


def transfer_balance(*, out_date, amount, in_legs, fee=0, as_of=None):
    """T1: in-transit capital stays in the portfolio until the arrival date."""
    start = date.fromisoformat(out_date)
    when = date.fromisoformat(as_of or date.today().isoformat())
    outgoing, fees = dec(amount), dec(fee)
    if outgoing <= 0 or fees < 0 or fees > outgoing:
        raise ValueError("Transfer amount must be positive; fee must be between zero and amount")
    planned = received = Decimal(0)
    for leg in in_legs:
        arrives = date.fromisoformat(leg["date"])
        value = dec(leg["amount"])
        if value <= 0 or arrives < start:
            raise ValueError("Incoming legs must be positive and cannot precede departure")
        planned += value
        if arrives <= when:
            received += value
    if planned + fees > outgoing:
        raise ValueError("Incoming legs plus fee exceed outgoing amount")
    if when < start:
        received = Decimal(0)
        transit = Decimal(0)
    else:
        transit = outgoing - fees - received
    # Weekdays only; broker holiday calendars must be supplied at activation.
    business_days = sum(date.fromordinal(d).weekday() < 5 for d in range(start.toordinal()+1, when.toordinal()+1))
    return {"amount": float(outgoing), "received": float(received), "fee": float(fees),
            "in_transit": float(transit), "unallocated": float(outgoing-fees-planned),
            "overdue": transit > 0 and business_days > 5, "business_days": business_days,
            "all_scope_external_flow": 0, "as_of": when.isoformat()}
