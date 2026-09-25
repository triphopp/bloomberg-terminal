"""Cited broker statements and read-only reconciliation against legacy history.

Statements are entered as evidence and corrected by a new revision. They do
not write trades, cash offsets, returns, or ledger events.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
import json
import uuid

from accounting_preflight import opening_balance, trade_dates
from ledger_engine import dec
import ledger_backfill as lb


def _positions(value):
    if len(value) > 500:
        raise ValueError("Too many statement positions")
    positions = []
    for p in value:
        symbol = str(p["symbol"]).strip().upper()
        if not symbol or len(symbol) > 64:
            raise ValueError("Invalid statement symbol")
        qty, basis, price = dec(p["qty"]), dec(p["cost_basis"]), dec(p["market_price"])
        if min(qty, basis, price) < 0:
            raise ValueError("Statement quantities, cost and market price must be nonnegative")
        positions.append({"symbol": symbol, "qty": str(qty), "cost_basis": str(basis), "market_price": str(price)})
    return positions


def create(conn, payload):
    """Append a source-cited statement or a revision of the latest one."""
    account_id = str(payload["account_id"]).strip()
    account = conn.execute("SELECT currency,account_type FROM portfolio_accounts WHERE id=?", (account_id,)).fetchone()
    if account is None:
        raise ValueError("Unknown account")
    as_of = str(payload["as_of"])
    day = date.fromisoformat(as_of)
    if day > date.today():
        raise ValueError("Statement date cannot be in the future")
    currency = str(account["currency"]).upper()
    if str(payload.get("currency") or currency).upper() != currency:
        raise ValueError("Statement amounts must use the account currency")
    cash, market_value = dec(payload["cash"]), dec(payload["market_value"])
    if market_value < 0 or (cash < 0 and account["account_type"] != "margin"):
        raise ValueError("Negative statement balance requires a margin account")
    source_ref = str(payload.get("source_ref") or "").strip()
    if not source_ref or len(source_ref) > 256:
        raise ValueError("A broker statement reference is required (max 256 characters)")
    source_note = str(payload.get("source_note") or "").strip()
    if len(source_note) > 1024:
        raise ValueError("Statement note is too long")
    positions = _positions(payload.get("positions") or [])
    arithmetic = opening_balance(as_of=as_of, cash=cash, market_value=market_value, positions=positions)
    if not arithmetic["O1"]:
        raise ValueError("Statement cash plus holdings market values must equal the stated total")

    current = conn.execute("""
        SELECT id FROM broker_statements s
        WHERE s.account_id=? AND s.as_of=?
          AND NOT EXISTS(SELECT 1 FROM broker_statements newer WHERE newer.supersedes_id=s.id)
    """, (account_id, as_of)).fetchall()
    if len(current) > 1:
        raise ValueError("Multiple current statement versions; review before posting")
    supersedes = str(payload.get("supersedes_id") or "") or None
    if (current[0]["id"] if current else None) != supersedes:
        raise ValueError("Statement for this date changed; supply the current id as supersedes_id")
    statement_id = str(uuid.uuid4())
    conn.execute("""
        INSERT INTO broker_statements
          (id,account_id,as_of,currency,cash,market_value,holdings_json,source_ref,source_note,supersedes_id)
        VALUES (?,?,?,?,?,?,?,?,?,?)
    """, (statement_id, account_id, as_of, currency, str(cash), str(market_value),
          json.dumps(positions, ensure_ascii=False, separators=(",", ":")), source_ref,
          source_note, supersedes))
    return statement_id


def _held_units(conn, account_id, as_of):
    holdings: dict[str, Decimal] = {}
    for row in conn.execute("SELECT symbol,volume,date_entry,date_exit,win_loss FROM trades WHERE account_id=?", (account_id,)):
        entry, exit_ = trade_dates(dict(row))
        qty = dec(row["volume"])
        if qty < 0:
            raise ValueError("Negative recorded holding quantity")
        if entry <= as_of and (not exit_ or exit_ > as_of):
            symbol = str(row["symbol"]).strip().upper()
            holdings[symbol] = holdings.get(symbol, Decimal(0)) + qty
    return holdings


def _cash_before_offsets(conn, events, account_id, as_of, currency):
    total = Decimal(0)
    missing_fx = []
    for e in events:
        if e.account_id != account_id or e.trade_date > as_of or e.type == "ADJUST":
            continue
        if e.currency == currency:
            total += dec(e.net_cash)
            continue
        home_rate = lb._thb_rate(conn, currency, e.trade_date, None)
        if not home_rate or not e.fx_rate:
            missing_fx.append(e.id)
            continue
        total += dec(e.net_cash) * dec(e.fx_rate) / dec(home_rate)
    return (None if missing_fx else total), missing_fx


def reconcile(conn, statement, *, events=None):
    """Compare cash before EDIT offsets and day-end quantities; never infer prices."""
    row = dict(statement)
    positions = json.loads(row["holdings_json"])
    held = _held_units(conn, row["account_id"], row["as_of"])
    arithmetic = opening_balance(as_of=row["as_of"], cash=row["cash"],
        market_value=row["market_value"], positions=positions, held_units=held)
    if events is None:
        events, _ = lb.build_events(conn)
    predicted, missing_fx = _cash_before_offsets(conn, events, row["account_id"], row["as_of"], row["currency"])
    difference = None if predicted is None else dec(row["cash"]) - predicted
    return {"statement_id": row["id"], "account_id": row["account_id"], "as_of": row["as_of"],
            "currency": row["currency"], "source_ref": row["source_ref"],
            "statement_cash": float(dec(row["cash"])),
            "reconstructed_cash_before_offsets": None if predicted is None else float(predicted),
            "cash_difference": None if difference is None else float(difference),
            "missing_fx_event_ids": missing_fx,
            "O1": arithmetic["O1"], "O2": arithmetic["O2"],
            "quantity_differences": arithmetic["quantity_differences"],
            "market_value_checked_against_history": False,
            "broker_source_verified": False,
            "matched": difference is not None and abs(difference) <= Decimal("0.01") and arithmetic["O1"] and arithmetic["O2"],
            "basis": "reconstructed legacy history before cash EDIT offsets"}


def list_current(conn, account_id=None):
    sql = """SELECT s.* FROM broker_statements s
        WHERE NOT EXISTS(SELECT 1 FROM broker_statements newer WHERE newer.supersedes_id=s.id)"""
    args = []
    if account_id and account_id != "all":
        sql += " AND s.account_id=?"
        args.append(account_id)
    sql += " ORDER BY s.as_of DESC, s.account_id, s.created_at DESC"
    return [dict(row, positions=json.loads(row["holdings_json"])) for row in conn.execute(sql, args)]
