"""Import broker Activity fills as source-cited facts, without posting cash or lots.

A screenshot shows execution quantity and price. It does not establish the
funding wallet, net sale proceeds, fee schedule, or which cost lot was sold.
Those unknowns stay out of the live portfolio calculation.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
import re
import uuid


_SYMBOL = re.compile(r"^[A-Z0-9.\-]{1,24}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _positive_decimal(value: object, field: str) -> str:
    try:
        number = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"Invalid {field}") from exc
    if not number.is_finite() or number <= 0:
        raise ValueError(f"{field} must be positive and finite")
    return str(number)


def prepare_manifest(manifest_path: Path, evidence_dir: Path) -> list[dict]:
    """Validate every cited image and row before any database write."""
    raw = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    account_id = str(raw.get("account_id") or "").strip()
    broker = str(raw.get("broker") or "").strip()
    images = raw.get("images") or {}
    executions = raw.get("executions") or []
    if not account_id or not broker or not isinstance(images, dict) or not isinstance(executions, list):
        raise ValueError("Invalid broker manifest")
    if not executions:
        raise ValueError("No broker executions in manifest")

    for name, expected in images.items():
        if Path(name).name != name or not _SHA256.fullmatch(str(expected)):
            raise ValueError(f"Unsafe or invalid image reference: {name}")
        path = Path(evidence_dir) / name
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f"Broker image missing or hash mismatch: {name}")

    prepared = []
    seen = set()
    for row in executions:
        symbol = str(row.get("symbol") or "").strip().upper()
        side = str(row.get("side") or "").strip().upper()
        stamp = str(row.get("executed_at_display") or "").strip()
        image = str(row.get("source_image") or "").strip()
        if not _SYMBOL.fullmatch(symbol) or side not in {"BUY", "SELL"}:
            raise ValueError(f"Invalid symbol or side: {symbol}/{side}")
        try:
            if datetime.fromisoformat(stamp).strftime("%Y-%m-%dT%H:%M:%S") != stamp:
                raise ValueError
        except ValueError as exc:
            raise ValueError(f"Invalid display timestamp: {stamp}") from exc
        if image not in images:
            raise ValueError(f"Uncited broker execution: {image}")
        qty = _positive_decimal(row.get("quantity"), "quantity")
        price = _positive_decimal(row.get("unit_price"), "unit_price")
        amount = row.get("order_amount")
        order_amount = _positive_decimal(amount, "order_amount") if amount is not None else None
        order_ccy = str(row.get("order_ccy") or "").strip().upper() or None
        if (order_amount is None) != (order_ccy is None):
            raise ValueError("Order amount and currency must be supplied together")
        if order_ccy is not None and order_ccy not in {"USD", "THB"}:
            raise ValueError(f"Unsupported order currency: {order_ccy}")
        if side == "SELL" and order_amount is not None:
            raise ValueError("Sale proceeds are not proven by an Activity quantity/price row")
        identity = (account_id, symbol, side, stamp, qty, price)
        if identity in seen:
            raise ValueError(f"Duplicate execution in manifest: {identity}")
        seen.add(identity)
        prepared.append({
            "id": str(uuid.uuid5(uuid.NAMESPACE_URL, "broker-execution|" + "|".join(identity))),
            "account_id": account_id, "broker": broker, "symbol": symbol, "side": side,
            "executed_at_local": stamp, "display_timezone": "UNKNOWN",
            "quantity": qty, "unit_price": price, "instrument_ccy": "USD",
            "order_amount": order_amount, "order_ccy": order_ccy,
            "source_image": image, "source_sha256": images[image],
            "source_note": "Dime Activity screenshot; wallet, settlement and sale fees not shown",
        })
    return prepared


def import_prepared(conn, rows: list[dict]) -> dict[str, int]:
    """Idempotent insert; fail instead of overwriting a disputed fill."""
    if not rows:
        return {"inserted": 0, "already_present": 0}
    account_id = rows[0]["account_id"]
    if not conn.execute("SELECT 1 FROM portfolio_accounts WHERE id=?", (account_id,)).fetchone():
        raise ValueError(f"Unknown account: {account_id}")
    inserted = already_present = 0
    fields = ("id", "account_id", "broker", "symbol", "side", "executed_at_local",
              "display_timezone", "quantity", "unit_price", "instrument_ccy",
              "order_amount", "order_ccy", "source_image", "source_sha256", "source_note")
    sql = ("INSERT INTO broker_executions (" + ",".join(fields) + ") VALUES (" +
           ",".join("?" for _ in fields) + ")")
    for row in rows:
        old = conn.execute("SELECT * FROM broker_executions WHERE id=?", (row["id"],)).fetchone()
        if old:
            if any(old[field] != row[field] for field in fields):
                raise ValueError(f"Conflicting broker execution: {row['id']}")
            already_present += 1
            continue
        conn.execute(sql, tuple(row[field] for field in fields))
        inserted += 1
    return {"inserted": inserted, "already_present": already_present}
