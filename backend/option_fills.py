"""Book one option fill — the single write path the ENTRY form uses.

One call records what the broker did, in the shape the book keeps it:
    option_trades       the fill, with its fill time, settle date and order number
    trade_fee_items     each fee line (OCC, ORF, TAF, commission and its promo …)
    broker_executions   an OPTION evidence row when the fill came off a slip
    option_trade_matches  for a close: which open lots it consumed, and the
                        realized P&L with both legs' fees (match_realized)

A close consumes the lots the caller names (`allocations`) or, if none, the
open lots of that contract oldest first by fill time — by trade date, then the
time it was entered, where a fill time is unknown. `dry_run` runs every check
and returns the matches without writing, which is what the form previews.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import uuid

from db import occ_symbol
from option_history import FEE_COMPONENTS, NS, _EV_COLS, _FEE_COLS, _insert, _usd_thb
from portfolio_options import match_realized

CLOSE_REASONS = ("TRADE", "EXPIRED", "EXERCISED", "ASSIGNED", "UNKNOWN")


class FillError(ValueError):
    """A fill the book must refuse; the message is for the person entering it."""


def _dec(value, what: str) -> Decimal:
    try:
        d = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise FillError(f"{what}: not a number ({value!r})") from exc
    if not d.is_finite():
        raise FillError(f"{what}: not a number ({value!r})")
    return d


def _aware(value, what: str):
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value))
    except ValueError as exc:
        raise FillError(f"{what}: not a timestamp ({value!r})") from exc
    if dt.tzinfo is None:
        raise FillError(f"{what}: needs a UTC offset, e.g. +07:00")
    return dt


def normalize(body: dict) -> dict:
    """Validate the request; return the fill as the book stores it."""
    f = dict(body)
    f["account_id"] = str(f.get("account_id") or "").strip()
    f["underlying"] = str(f.get("underlying") or "").strip().upper()
    f["option_type"] = str(f.get("option_type") or "").lower()
    f["action"] = str(f.get("action") or "").upper()
    f["side"] = str(f.get("side") or "").upper()
    f["currency"] = str(f.get("currency") or "USD").upper()
    if not f["account_id"] or not f["underlying"]:
        raise FillError("account and underlying are required")
    if f["option_type"] not in ("call", "put"):
        raise FillError("option type must be call or put")
    if f["action"] not in ("OPEN", "CLOSE") or f["side"] not in ("BUY", "SELL"):
        raise FillError("action must be OPEN/CLOSE and side BUY/SELL")
    try:
        f["expiry"] = date.fromisoformat(str(f.get("expiry"))[:10]).isoformat()
        f["trade_date"] = date.fromisoformat(str(f.get("trade_date"))[:10]).isoformat()
    except ValueError as exc:
        raise FillError("expiry and trade date must be YYYY-MM-DD") from exc
    f["strike"] = float(_dec(f.get("strike"), "strike"))
    f["multiplier"] = float(_dec(f.get("multiplier") or 100, "multiplier"))
    f["quantity"] = float(_dec(f.get("quantity"), "contracts"))
    if f["strike"] <= 0 or f["multiplier"] <= 0 or f["quantity"] <= 0:
        raise FillError("strike, multiplier and contracts must be positive")

    reason = f.get("close_reason")
    reason = str(reason).upper() if reason else None
    if f["action"] == "OPEN":
        if reason:
            raise FillError("an opening fill has no close reason")
    else:
        reason = reason or "TRADE"
        if reason not in CLOSE_REASONS:
            raise FillError(f"close reason must be one of {', '.join(CLOSE_REASONS)}")
    f["close_reason"] = reason
    price = f.get("price")
    if price in (None, ""):
        if reason == "EXPIRED":
            price = 0
        elif reason != "UNKNOWN":
            raise FillError("premium is required (leave it empty only for an UNKNOWN close)")
    f["price"] = None if price in (None, "") else float(_dec(price, "premium"))
    if f["price"] is not None and f["price"] < 0:
        raise FillError("premium cannot be negative")
    if f["price"] == 0 and reason not in ("EXPIRED", "EXERCISED", "ASSIGNED"):
        raise FillError("a premium of 0 is an expiry — choose EXPIRED")
    if f["trade_date"] > f["expiry"] and reason not in ("EXPIRED", "EXERCISED", "ASSIGNED"):
        raise FillError(f"traded {f['trade_date']}, after the contract expired {f['expiry']}")

    executed = _aware(f.get("executed_at"), "fill time")
    submitted = _aware(f.get("submitted_at"), "order time")
    if executed and submitted and submitted > executed:
        raise FillError("filled before it was submitted — check the times")
    f["executed_at"] = executed.isoformat() if executed else None
    f["submitted_at"] = submitted.isoformat() if submitted else None
    f["settle_date"] = str(f["settle_date"])[:10] if f.get("settle_date") else None
    f["broker_order_ref"] = (str(f.get("broker_order_ref") or "").strip().upper()) or None

    items, seen = [], set()
    for it in f.get("fee_items") or []:
        comp = str(it.get("component") or "").upper()
        if comp not in FEE_COMPONENTS or comp in seen:
            raise FillError(f"fee line {comp or '?'} is unknown or repeated")
        seen.add(comp)
        amt = _dec(it.get("amount"), comp)
        if amt == 0 and comp not in ("COMMISSION", "VAT"):
            continue
        if (amt < 0) != (comp == "COMMISSION_DISCOUNT") and amt != 0:
            raise FillError(f"{comp}: a cost is positive, only COMMISSION_DISCOUNT is negative")
        items.append({"component": comp, "amount": str(amt)})
    fee_total = sum((Decimal(i["amount"]) for i in items), Decimal(0))
    if fee_total < 0:
        raise FillError("fees net below zero — a discount larger than the commission")
    f["fee_items"], f["fees"] = items, float(fee_total)
    f["entry_source"] = "slip" if f.get("slip_sha256s") else (f.get("entry_source") or "manual")
    f["note"] = str(f.get("note") or "")
    f["occ_symbol"] = occ_symbol(f["underlying"], f["expiry"], f["strike"], f["option_type"])
    return f


def _open_lots(conn, f: dict) -> list[dict]:
    rows = conn.execute(
        """SELECT v.lot_id, v.entry_date, v.entry_price, v.entry_fees, v.quantity_opened,
                  v.quantity, v.direction, v.multiplier, t.executed_at, t.created_at
           FROM v_option_open_lots v JOIN option_trades t ON t.trade_id = v.lot_id
           WHERE v.account_id = ? AND v.occ_symbol = ?""",
        (f["account_id"], f["occ_symbol"])).fetchall()
    lots = [dict(r) for r in rows]

    def order(l):
        stamp = l["executed_at"] and datetime.fromisoformat(l["executed_at"]).timestamp()
        return (l["entry_date"], stamp or 0.0, l["created_at"] or "")
    return sorted(lots, key=order)


def plan(conn, body: dict) -> dict:
    """Everything `book` would write, computed without writing."""
    f = normalize(body)
    if not conn.execute("SELECT 1 FROM portfolio_accounts WHERE id=?", (f["account_id"],)).fetchone():
        raise FillError(f"unknown account {f['account_id']}")
    ref = f["broker_order_ref"]
    if ref:
        clash = conn.execute("SELECT trade_id FROM option_trades WHERE account_id=? AND broker_order_ref=?",
                             (f["account_id"], ref)).fetchone() or \
            conn.execute("SELECT id FROM trades WHERE account_id=? AND broker_order_ref=?",
                         (f["account_id"], ref)).fetchone()
        if clash:
            raise FillError(f"order {ref} is already booked")

    contract = conn.execute("SELECT contract_id, multiplier, currency FROM option_contracts WHERE occ_symbol=?",
                            (f["occ_symbol"],)).fetchone()
    if contract and (abs(float(contract["multiplier"]) - f["multiplier"]) > 1e-9
                     or str(contract["currency"]).upper() != f["currency"]):
        raise FillError(f"{f['occ_symbol']} is on record with multiplier {contract['multiplier']:g} "
                        f"{contract['currency']}")

    matches = []
    if f["action"] == "CLOSE":
        want_dir = 1 if f["side"] == "SELL" else -1          # a SELL closes long lots
        lots = [l for l in _open_lots(conn, f) if int(l["direction"]) == want_dir]
        if not lots:
            raise FillError(f"no open {'long' if want_dir > 0 else 'short'} lot of {f['occ_symbol']} to close")
        by_id = {l["lot_id"]: l for l in lots}
        allocs = body.get("allocations") or []
        if allocs:
            picked = []
            for a in allocs:
                lot = by_id.get(a.get("open_trade_id"))
                qty = float(_dec(a.get("quantity"), "allocated contracts"))
                if lot is None:
                    raise FillError("an allocated lot is not open on this contract")
                if qty <= 0 or qty > abs(float(lot["quantity"])) + 1e-9:
                    raise FillError(f"lot {lot['entry_date']} has {abs(float(lot['quantity'])):g} left")
                picked.append((lot, qty))
            if abs(sum(q for _, q in picked) - f["quantity"]) > 1e-9:
                raise FillError("allocated contracts must add up to the fill")
        else:
            picked, left = [], f["quantity"]
            for lot in lots:
                if left <= 1e-9:
                    break
                take = min(left, abs(float(lot["quantity"])))
                picked.append((lot, take))
                left -= take
            if left > 1e-9:
                raise FillError(f"only {f['quantity'] - left:g} contracts are open to close")
        for lot, qty in picked:
            if f["trade_date"] < lot["entry_date"]:
                raise FillError(f"closes {f['trade_date']}, before the lot opened {lot['entry_date']}")
            if f["executed_at"] and lot["executed_at"] and \
                    datetime.fromisoformat(f["executed_at"]) < datetime.fromisoformat(lot["executed_at"]):
                raise FillError("fill time is before the lot's own fill time")
            realized, fees = match_realized(
                int(lot["direction"]), lot["entry_price"], f["price"], qty, f["multiplier"],
                float(lot["entry_fees"] or 0), float(lot["quantity_opened"] or 0), f["fees"], f["quantity"])
            matches.append({"open_trade_id": lot["lot_id"], "entry_date": lot["entry_date"],
                            "entry_price": lot["entry_price"], "quantity": qty,
                            "fees_alloc": round(fees, 6),
                            "realized_pnl": None if realized is None else round(realized, 6)})

    gross = (f["price"] or 0) * f["quantity"] * f["multiplier"]
    cash = (-gross - f["fees"]) if f["side"] == "BUY" else (gross - f["fees"])
    known = [m["realized_pnl"] for m in matches if m["realized_pnl"] is not None]
    return {"fill": f, "contract_id": contract["contract_id"] if contract else None,
            "matches": matches, "gross": round(gross, 2), "fees": round(f["fees"], 2),
            "cash_effect": round(cash, 2),
            "realized_total": round(sum(known), 2) if matches and len(known) == len(matches) else None}


def book(conn, body: dict) -> dict:
    p = plan(conn, body)
    f = p["fill"]
    contract_id = p["contract_id"]
    if contract_id is None:
        contract_id = str(uuid.uuid4())
        conn.execute("""INSERT INTO option_contracts (contract_id, occ_symbol, underlying, expiry, strike,
                        option_type, multiplier, currency) VALUES (?,?,?,?,?,?,?,?)""",
                     (contract_id, f["occ_symbol"], f["underlying"], f["expiry"], f["strike"],
                      f["option_type"], f["multiplier"], f["currency"]))
    trade_id = str(uuid.uuid4())
    conn.execute(
        """INSERT INTO option_trades (trade_id, contract_id, account_id, trade_date, action, side, quantity,
               price, fees, exchange_rate, close_reason, note, executed_at, settle_date, broker_order_ref,
               entry_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (trade_id, contract_id, f["account_id"], f["trade_date"], f["action"], f["side"], f["quantity"],
         f["price"], f["fees"], _usd_thb(conn, f["trade_date"]) if f["currency"] == "USD" else None,
         f["close_reason"], f["note"], f["executed_at"], f["settle_date"], f["broker_order_ref"],
         f["entry_source"]))

    evidence_id = _evidence(conn, f, trade_id)
    source = "SLIP" if f["entry_source"] == "slip" else "MANUAL"
    for it in f["fee_items"]:
        _insert(conn, "trade_fee_items", _FEE_COLS, {
            "id": str(uuid.uuid5(NS, f"fee|option_trades|{trade_id}|FILL|{it['component']}|ESTIMATED")),
            "account_id": f["account_id"], "trade_table": "option_trades", "trade_id": trade_id,
            "leg": "FILL", "component": it["component"], "amount": it["amount"], "currency": f["currency"],
            "basis": "ESTIMATED", "source": source, "evidence_id": evidence_id, "note": ""})
    for m in p["matches"]:
        conn.execute("""INSERT INTO option_trade_matches (close_trade_id, open_trade_id, quantity, fees_alloc,
                        realized_pnl) VALUES (?,?,?,?,?)""",
                     (trade_id, m["open_trade_id"], m["quantity"], m["fees_alloc"], m["realized_pnl"]))
    return {**{k: v for k, v in p.items() if k != "fill"}, "ok": True, "trade_id": trade_id,
            "contract_id": contract_id, "occ_symbol": f["occ_symbol"], "evidence_id": evidence_id}


def _evidence(conn, f: dict, trade_id: str) -> str | None:
    """The slip as a broker_executions OPTION row — only with a fill time and a stored image."""
    shas = [s for s in f.get("slip_sha256s") or [] if s]
    if not shas or not f["executed_at"] or f["price"] is None:
        return None
    import slip_evidence
    sidecars = [(s, slip_evidence.load(s)) for s in shas]
    sha, side = next(((s, c) for s, c in sidecars if c), (None, None))
    if side is None:
        return None
    fee = {i["component"]: i["amount"] for i in f["fee_items"]}
    local = datetime.fromisoformat(f["executed_at"])
    sub = datetime.fromisoformat(f["submitted_at"]) if f["submitted_at"] else None
    gross = Decimal(str(f["price"])) * Decimal(str(f["quantity"])) * Decimal(str(f["multiplier"]))
    ev_id = str(uuid.uuid5(NS, f"broker-execution|option|{trade_id}"))
    _insert(conn, "broker_executions", _EV_COLS, {
        "id": ev_id, "account_id": f["account_id"], "broker": (side.get("broker") or "").upper(),
        "instrument_type": "OPTION", "symbol": f["occ_symbol"], "side": f["side"],
        "executed_at_local": local.strftime("%Y-%m-%dT%H:%M:%S"),
        "submitted_at_local": sub.strftime("%Y-%m-%dT%H:%M:%S") if sub else None,
        "display_timezone": (side.get("slip") or {}).get("display_timezone") or "UNKNOWN",
        "quantity": format(Decimal(str(f["quantity"])).normalize(), "f"), "unit_price": str(f["price"]),
        "instrument_ccy": f["currency"], "gross_value": str(gross.quantize(Decimal("0.01"))),
        "order_amount": str((gross + Decimal(str(f["fees"]))).quantize(Decimal("0.01"))) if f["side"] == "BUY" else None,
        "order_ccy": f["currency"] if f["side"] == "BUY" else None,
        "commission": fee.get("COMMISSION", "0"), "commission_discount": fee.get("COMMISSION_DISCOUNT", "0"),
        "vat": fee.get("VAT", "0"), "occ_fee": fee.get("OCC", "0"), "orf_fee": fee.get("ORF", "0"),
        "taf_fee": fee.get("TAF", "0"), "settle_date": f["settle_date"], "order_ref": f["broker_order_ref"],
        "option_trade_id": trade_id, "source_image": side.get("image_file") or f"{sha}.img",
        "source_sha256": sha,
        "source_note": f"order detail slip, {len(shas)} screenshot(s): {', '.join(s[:12] for s in shas)}",
        "extractor": f"{side.get('engine') or ''} {((side.get('ocr') or {}).get('backend')) or ''}".strip(),
    })
    return ev_id
