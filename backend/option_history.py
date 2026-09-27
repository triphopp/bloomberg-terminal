"""Book historical option round trips from transcribed broker slips.

A manifest (backups/accounting-evidence-*/…-manifest.json) lists each fill as
read off the broker's order-detail screen: contract, side, contracts, premium,
fill time, the fee lines and the images that show them. Nothing here reads an
image; the manifest pins each image by SHA-256 so the citation cannot drift.

What one fill becomes:
  option_trades        one row (fees = Σ its fee items)
  trade_fee_items      one row per fee line (basis ESTIMATED — a slip's fees
                       are the broker's estimate; the posted debit may differ)
  broker_executions    one OPTION evidence row, when the fill time is known
and each close is matched to its open explicitly (not FIFO by date: two fills
on one day are ordered by fill time, which the dated FIFO cannot see).

The broker's cash already contains these trades, so the import releases the
same amount from the cash offset (a DATA_FIX cash_adjustment): realized P&L
moves from "unexplained offset" to the trades that explain it, and today's
cash does not change. prepare() validates everything before apply() writes.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
import uuid

from db import occ_symbol
from portfolio_options import match_realized

NS = uuid.UUID("0b8f3a52-6c1e-4d7a-9f25-8e1d4c3b2a60")
FEE_COMPONENTS = {"COMMISSION", "COMMISSION_DISCOUNT", "VAT", "SEC", "TAF", "ORF", "OCC", "EXCHANGE", "OTHER"}
FEE_SOURCES = {"SLIP", "SCHEDULE", "MANUAL"}
CENT = Decimal("0.01")


def _dec(value, field: str) -> Decimal:
    try:
        d = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"invalid {field}: {value!r}") from exc
    if not d.is_finite():
        raise ValueError(f"invalid {field}: {value!r}")
    return d


def _iso_day(value, field: str) -> str:
    try:
        return date.fromisoformat(str(value)).isoformat()
    except ValueError as exc:
        raise ValueError(f"invalid {field}: {value!r}") from exc


def _aware(value, field: str):
    if value is None:
        return None
    try:
        dt = datetime.fromisoformat(str(value))
    except ValueError as exc:
        raise ValueError(f"invalid {field}: {value!r}") from exc
    if dt.tzinfo is None:
        raise ValueError(f"{field} needs a UTC offset: {value!r}")
    return dt


def _id(*parts) -> str:
    return str(uuid.uuid5(NS, "|".join(str(p) for p in parts)))


def prepare(manifest_path: Path) -> dict:
    """Validate the manifest and every cited image; return the rows to write."""
    manifest_path = Path(manifest_path)
    raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    account = str(raw.get("account_id") or "").strip()
    ccy = str(raw.get("currency") or "").strip().upper()
    tz_name = str(raw.get("display_timezone") or "").strip()
    images = raw.get("images") or {}
    if not account or not ccy or not tz_name or not raw.get("fills"):
        raise ValueError("manifest needs account_id, currency, display_timezone and fills")
    for name, sha in images.items():
        if Path(name).name != name:
            raise ValueError(f"unsafe image name: {name}")
        path = manifest_path.parent / name
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != sha:
            raise ValueError(f"image missing or changed: {name}")

    fills, fee_rows, evidence = {}, [], []
    for f in raw["fills"]:
        key = str(f["key"])
        if key in fills:
            raise ValueError(f"duplicate fill key {key}")
        c = f["contract"]
        opt_type = str(c["option_type"]).lower()
        if opt_type not in ("call", "put"):
            raise ValueError(f"{key}: option_type {opt_type!r}")
        expiry = _iso_day(c["expiry"], f"{key} expiry")
        strike = _dec(c["strike"], f"{key} strike")
        action, side = str(f["action"]).upper(), str(f["side"]).upper()
        if action not in ("OPEN", "CLOSE") or side not in ("BUY", "SELL"):
            raise ValueError(f"{key}: action/side {action}/{side}")
        contracts = _dec(f["contracts"], f"{key} contracts")
        price = _dec(f["price"], f"{key} price")
        reason = f.get("close_reason")
        if contracts <= 0 or strike <= 0 or price < 0:
            raise ValueError(f"{key}: contracts, strike and price must be positive")
        if action == "CLOSE" and reason not in ("TRADE", "EXPIRED", "EXERCISED", "ASSIGNED"):
            raise ValueError(f"{key}: a close needs a known close_reason, got {reason!r}")
        if action == "OPEN" and reason is not None:
            raise ValueError(f"{key}: an open has no close_reason")
        if price == 0 and reason != "EXPIRED":
            raise ValueError(f"{key}: price 0 is only an expiry")
        trade_date = _iso_day(f["trade_date"], f"{key} trade_date")
        executed = _aware(f.get("executed_at"), f"{key} executed_at")
        submitted = _aware(f.get("submitted_at"), f"{key} submitted_at")
        settle = _iso_day(f["settle_date"], f"{key} settle_date") if f.get("settle_date") else None
        if expiry < trade_date:
            raise ValueError(f"{key}: traded {trade_date} after expiry {expiry}")
        for img in f.get("images") or []:
            if img not in images:
                raise ValueError(f"{key}: uncited image {img}")

        trade_id = _id("option-history", account, key)
        fee_source = str((f.get("fees") or {}).get("source") or "SLIP").upper()
        if fee_source not in FEE_SOURCES:
            raise ValueError(f"{key}: fee source {fee_source}")
        fee_total, seen = Decimal(0), set()
        per_component = {}
        for component, amount in (f.get("fees") or {}).get("items") or []:
            component = str(component).upper()
            if component not in FEE_COMPONENTS or component in seen:
                raise ValueError(f"{key}: fee component {component}")
            seen.add(component)
            amt = _dec(amount, f"{key} {component}")
            if (amt < 0) != (component == "COMMISSION_DISCOUNT"):
                raise ValueError(f"{key}: {component} has the wrong sign")
            fee_total += amt
            per_component[component] = amt
            fee_rows.append({
                "id": _id("fee", "option_trades", trade_id, "FILL", component, "ESTIMATED"),
                "account_id": account, "trade_table": "option_trades", "trade_id": trade_id,
                "leg": "FILL", "component": component, "amount": str(amt), "currency": ccy,
                "basis": "ESTIMATED", "source": fee_source,
                "evidence_id": None, "note": f"{f.get('excel_ref') or ''} {key}".strip(),
            })
        if fee_total < 0:
            raise ValueError(f"{key}: fees net below zero")
        unverified = [str(u) for u in f.get("unverified") or []]
        note_bits = [f.get("excel_ref") or "", f.get("note") or ""]
        if unverified:
            note_bits.append("UNVERIFIED: " + ", ".join(unverified))
        fills[key] = {
            "key": key,
            "trade_id": trade_id, "account_id": account,
            "underlying": str(c["underlying"]).strip().upper(), "expiry": expiry,
            "strike": float(strike), "option_type": opt_type, "multiplier": 100.0, "currency": ccy,
            "occ_symbol": occ_symbol(c["underlying"], expiry, float(strike), opt_type),
            "trade_date": trade_date, "action": action, "side": side,
            "quantity": float(contracts), "price": float(price), "fees": float(fee_total),
            "close_reason": reason, "note": " — ".join(b for b in note_bits if b),
            "executed_at": executed.isoformat() if executed else None,
            "settle_date": settle, "broker_order_ref": f.get("order_ref"),
            "entry_source": "slip" if f.get("images") and "price" not in unverified else "excel",
            "unverified": unverified,
        }
        imgs = f.get("images") or []
        if executed and imgs and "price" not in unverified:
            gross = (contracts * 100 * price).quantize(CENT)
            ev_id = _id("broker-execution", "option", trade_id)
            for row in fee_rows:
                if row["trade_id"] == trade_id and fee_source == "SLIP":
                    row["evidence_id"] = ev_id
            evidence.append({
                "id": ev_id, "account_id": account, "broker": str(raw.get("broker") or ""),
                "instrument_type": "OPTION", "symbol": fills[key]["occ_symbol"], "side": side,
                "executed_at_local": executed.strftime("%Y-%m-%dT%H:%M:%S"),
                "submitted_at_local": submitted.strftime("%Y-%m-%dT%H:%M:%S") if submitted else None,
                "display_timezone": tz_name, "quantity": str(contracts), "unit_price": str(price),
                "instrument_ccy": ccy, "gross_value": str(gross),
                "order_amount": str(gross + fee_total) if side == "BUY" else None,
                "order_ccy": ccy if side == "BUY" else None,
                "commission": str(per_component.get("COMMISSION", Decimal(0))),
                "commission_discount": str(per_component.get("COMMISSION_DISCOUNT", Decimal(0))),
                "vat": str(per_component.get("VAT", Decimal(0))),
                "occ_fee": str(per_component.get("OCC", Decimal(0))),
                "orf_fee": str(per_component.get("ORF", Decimal(0))),
                "taf_fee": str(per_component.get("TAF", Decimal(0))),
                "settle_date": settle, "order_ref": f.get("order_ref"),
                "option_trade_id": trade_id,
                "source_image": imgs[0], "source_sha256": images[imgs[0]],
                "source_note": f"{f.get('excel_ref') or ''}; images: {', '.join(imgs)}",
                "extractor": "manual-transcription",
            })

    matches = []
    closed = {k: 0.0 for k in fills}
    for close_key, open_key, qty in raw.get("matches") or []:
        o, c = fills.get(open_key), fills.get(close_key)
        if not o or not c or o["action"] != "OPEN" or c["action"] != "CLOSE":
            raise ValueError(f"bad match {close_key} -> {open_key}")
        if o["occ_symbol"] != c["occ_symbol"] or o["side"] == c["side"]:
            raise ValueError(f"match {close_key} -> {open_key}: different contract or same side")
        if c["trade_date"] < o["trade_date"] or (
                o["executed_at"] and c["executed_at"]
                and datetime.fromisoformat(c["executed_at"]) < datetime.fromisoformat(o["executed_at"])):
            raise ValueError(f"match {close_key} -> {open_key}: closed before it was opened")
        qty = float(qty)
        closed[open_key] += qty
        closed[close_key] += qty
        direction = 1 if o["side"] == "BUY" else -1
        realized, fee_alloc = match_realized(direction, o["price"], c["price"], qty, o["multiplier"],
                                             o["fees"], o["quantity"], c["fees"], c["quantity"])
        matches.append({"close_trade_id": c["trade_id"], "open_trade_id": o["trade_id"],
                        "quantity": qty, "fees_alloc": round(fee_alloc, 6),
                        "realized_pnl": round(realized, 6), "close_key": close_key, "open_key": open_key})
    for key, f in fills.items():
        if abs(closed[key] - f["quantity"]) > 1e-9:
            raise ValueError(f"{key}: {f['quantity']:g} contracts, {closed[key]:g} matched — "
                             "this importer books complete round trips only")

    realized_total = round(sum(m["realized_pnl"] for m in matches), 2)
    manifest_sha = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    offset = {
        # Stable across manifest revisions: a corrected manifest amends this
        # row rather than releasing the offset a second time.
        "id": _id("cash-offset", account, manifest_path.name),
        "manifest_name": manifest_path.name,
        "account_id": account, "date": date.today().isoformat(), "amount": -realized_total,
        "currency": ccy, "category": "DATA_FIX",
        "note": (f"Releases broker-matched cash offset that had absorbed {len(matches)} option round trips "
                 f"(realized {realized_total:+.2f} {ccy} incl. fees) now booked from Dime slips; "
                 f"manifest {manifest_path.name} SHA256 {manifest_sha}; no deposit/withdrawal."),
    }
    return {"account_id": account, "fills": list(fills.values()), "fee_items": fee_rows,
            "evidence": evidence, "matches": matches, "realized_total": realized_total,
            "cash_offset": offset, "manifest_sha256": manifest_sha}


_TRADE_COLS = ("trade_id", "contract_id", "account_id", "trade_date", "action", "side", "quantity",
               "price", "fees", "exchange_rate", "close_reason", "note", "executed_at", "settle_date",
               "broker_order_ref", "entry_source")
_FEE_COLS = ("id", "account_id", "trade_table", "trade_id", "leg", "component", "amount", "currency",
             "basis", "source", "evidence_id", "note")
_EV_COLS = ("id", "account_id", "broker", "instrument_type", "symbol", "side", "executed_at_local",
            "submitted_at_local", "display_timezone", "quantity", "unit_price", "instrument_ccy",
            "gross_value", "order_amount", "order_ccy", "commission", "commission_discount", "vat",
            "occ_fee", "orf_fee", "taf_fee", "settle_date", "order_ref", "option_trade_id",
            "source_image", "source_sha256", "source_note", "extractor")


def _usd_thb(conn, day: str):
    row = conn.execute("SELECT rate FROM fx_rates WHERE base='USD' AND quote='THB' AND date<=? "
                       "ORDER BY date DESC LIMIT 1", (day,)).fetchone()
    return float(row[0]) if row and 25 < float(row[0]) < 45 else None


def _insert(conn, table, cols, row) -> None:
    conn.execute(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                 tuple(row[c] for c in cols))


def status(conn, plan: dict) -> dict:
    """How much of the plan is already in the book. All or nothing is valid."""
    present = sum(bool(conn.execute("SELECT 1 FROM option_trades WHERE trade_id=?",
                                    (f["trade_id"],)).fetchone()) for f in plan["fills"])
    duplicates = []
    for f in plan["fills"]:
        row = conn.execute(
            """SELECT t.trade_id FROM option_trades t JOIN option_contracts c USING(contract_id)
               WHERE t.account_id=? AND c.occ_symbol=? AND t.side=? AND t.trade_date=?
                 AND ABS(t.quantity-?)<1e-9 AND ABS(COALESCE(t.price,-1)-?)<1e-9 AND t.trade_id<>?""",
            (f["account_id"], f["occ_symbol"], f["side"], f["trade_date"], f["quantity"], f["price"],
             f["trade_id"])).fetchone()
        if row:
            duplicates.append((f["key"], row[0]))
    return {"fills": len(plan["fills"]), "present": present, "duplicates": duplicates}


def apply(conn, plan: dict) -> dict:
    """Write the plan in the caller's transaction. Idempotent; refuses a partial book."""
    st = status(conn, plan)
    if st["duplicates"]:
        raise ValueError(f"fills already booked under other ids: {st['duplicates']}")
    if st["present"] == st["fills"]:
        return amend(conn, plan)
    if st["present"]:
        raise ValueError(f"{st['present']} of {st['fills']} fills already present — refusing a partial import")
    if not conn.execute("SELECT 1 FROM portfolio_accounts WHERE id=?", (plan["account_id"],)).fetchone():
        raise ValueError(f"unknown account {plan['account_id']}")

    for f in plan["fills"]:
        row = conn.execute("SELECT contract_id, multiplier, currency FROM option_contracts WHERE occ_symbol=?",
                           (f["occ_symbol"],)).fetchone()
        if row:
            if float(row[1]) != f["multiplier"] or str(row[2]).upper() != f["currency"]:
                raise ValueError(f"{f['occ_symbol']}: stored multiplier/currency differ")
            contract_id = row[0]
        else:
            contract_id = _id("option-contract", f["occ_symbol"])
            conn.execute("""INSERT INTO option_contracts (contract_id, occ_symbol, underlying, expiry, strike,
                            option_type, multiplier, currency) VALUES (?,?,?,?,?,?,?,?)""",
                         (contract_id, f["occ_symbol"], f["underlying"], f["expiry"], f["strike"],
                          f["option_type"], f["multiplier"], f["currency"]))
        _insert(conn, "option_trades", _TRADE_COLS,
                {**f, "contract_id": contract_id,
                 "exchange_rate": _usd_thb(conn, f["trade_date"]) if f["currency"] == "USD" else None})
    for ev in plan["evidence"]:
        _insert(conn, "broker_executions", _EV_COLS, ev)
    for item in plan["fee_items"]:
        _insert(conn, "trade_fee_items", _FEE_COLS, item)
    for m in plan["matches"]:
        conn.execute("""INSERT INTO option_trade_matches
                        (close_trade_id, open_trade_id, quantity, fees_alloc, realized_pnl)
                        VALUES (?,?,?,?,?)""",
                     (m["close_trade_id"], m["open_trade_id"], m["quantity"], m["fees_alloc"], m["realized_pnl"]))
    off = plan["cash_offset"]
    if off["amount"]:
        conn.execute("""INSERT INTO cash_adjustments (id, account_id, date, amount, currency, category, note)
                        VALUES (?,?,?,?,?,?,?)""",
                     (off["id"], off["account_id"], off["date"], off["amount"], off["currency"],
                      off["category"], off["note"]))
    return {"inserted": len(plan["fills"]), "fee_items": len(plan["fee_items"]),
            "evidence": len(plan["evidence"]), "matches": len(plan["matches"]),
            "cash_offset": off["amount"]}


def amend(conn, plan: dict) -> dict:
    """Bring an already-booked manifest up to a corrected revision.

    The manifest is the source: a later slip that fills in a fill time, an
    order number or the real fees replaces what an earlier revision had to
    estimate. Contract, side, action and quantity are the fill's identity and
    are never amended — a change there is a different fill. Every UPDATE goes
    through the audit triggers, so the old values stay on record.
    """
    changed = {"fills": 0, "fee_items": 0, "evidence": 0, "matches": 0, "cash_offset": 0}
    editable = ("trade_date", "price", "fees", "close_reason", "note", "executed_at",
                "settle_date", "broker_order_ref", "entry_source")
    for f in plan["fills"]:
        row = dict(conn.execute(
            """SELECT t.*, c.occ_symbol FROM option_trades t JOIN option_contracts c USING(contract_id)
               WHERE t.trade_id=?""", (f["trade_id"],)).fetchone())
        if (row["occ_symbol"], row["action"], row["side"], float(row["quantity"])) !=                 (f["occ_symbol"], f["action"], f["side"], f["quantity"]):
            raise ValueError(f"{f['key']}: contract/side/quantity differ from the booked fill")
        diff = [c for c in editable if row[c] != f[c]
                and not (isinstance(f[c], float) and row[c] is not None and abs(float(row[c]) - f[c]) < 1e-9)]
        if diff:
            conn.execute(f"UPDATE option_trades SET {', '.join(c + '=?' for c in diff)} WHERE trade_id=?",
                         (*[f[c] for c in diff], f["trade_id"]))
            changed["fills"] += 1

    wanted = {i["id"]: i for i in plan["fee_items"]}
    trade_ids = tuple(f["trade_id"] for f in plan["fills"])
    marks = ",".join("?" for _ in trade_ids)
    for old in conn.execute(f"SELECT * FROM trade_fee_items WHERE trade_table='option_trades' "
                            f"AND basis='ESTIMATED' AND trade_id IN ({marks})", trade_ids).fetchall():
        new = wanted.pop(old["id"], None)
        if new is None:
            conn.execute("DELETE FROM trade_fee_items WHERE id=?", (old["id"],))
            changed["fee_items"] += 1
        elif any(old[c] != new[c] for c in ("amount", "source", "evidence_id", "note")):
            conn.execute("UPDATE trade_fee_items SET amount=?, source=?, evidence_id=?, note=? WHERE id=?",
                         (new["amount"], new["source"], new["evidence_id"], new["note"], new["id"]))
            changed["fee_items"] += 1
    for item in wanted.values():
        _insert(conn, "trade_fee_items", _FEE_COLS, item)
        changed["fee_items"] += 1

    for ev in plan["evidence"]:
        old = conn.execute("SELECT * FROM broker_executions WHERE id=?", (ev["id"],)).fetchone()
        if old is None:
            _insert(conn, "broker_executions", _EV_COLS, ev)
            changed["evidence"] += 1
        elif any(old[c] != ev[c] for c in _EV_COLS):
            cols = [c for c in _EV_COLS if c != "id"]
            conn.execute(f"UPDATE broker_executions SET {', '.join(c + '=?' for c in cols)} WHERE id=?",
                         (*[ev[c] for c in cols], ev["id"]))
            changed["evidence"] += 1

    for m in plan["matches"]:
        old = conn.execute("SELECT quantity, fees_alloc, realized_pnl FROM option_trade_matches "
                           "WHERE close_trade_id=? AND open_trade_id=?",
                           (m["close_trade_id"], m["open_trade_id"])).fetchone()
        if old is None:
            raise ValueError(f"match {m['close_key']} -> {m['open_key']} missing from the book")
        if tuple(old) != (m["quantity"], m["fees_alloc"], m["realized_pnl"]):
            conn.execute("UPDATE option_trade_matches SET quantity=?, fees_alloc=?, realized_pnl=? "
                         "WHERE close_trade_id=? AND open_trade_id=?",
                         (m["quantity"], m["fees_alloc"], m["realized_pnl"],
                          m["close_trade_id"], m["open_trade_id"]))
            changed["matches"] += 1

    off = plan["cash_offset"]
    row = conn.execute("SELECT id, amount FROM cash_adjustments WHERE id=?", (off["id"],)).fetchone() or         conn.execute("SELECT id, amount FROM cash_adjustments WHERE account_id=? AND category='DATA_FIX' "
                     "AND note LIKE ?", (off["account_id"], f"%manifest {off['manifest_name']} %")).fetchone()
    if row is None:
        raise ValueError("booked manifest has no cash offset row to amend")
    if abs(float(row["amount"]) - off["amount"]) > 1e-9:
        conn.execute("UPDATE cash_adjustments SET amount=?, note=? WHERE id=?",
                     (off["amount"], off["note"], row["id"]))
        changed["cash_offset"] = 1
    return {"inserted": 0, "amended": changed, "cash_offset": off["amount"]}

