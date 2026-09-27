"""Order slips as cited evidence: the bridge between slip_ocr (no DB) and the book.

    /slip/read  → save(image, result)      image + the engine's reading, by sha256
    /trades     → booked(...)               refuse an order number already entered
                → record(conn, trade, sha)  one broker_executions row, linked to the trade

What gets recorded is what the engine read off the image, never the form: if
the person corrects a field before saving, the evidence still shows the slip
and evidence_match / the audit tab surface the difference.

Files live beside the database (evidence/slips/<sha>.<ext> + <sha>.json) and
are gitignored — a slip carries account numbers. They do not travel with sync.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import uuid

from config import DB_PATH

_SHA = re.compile(r"^[0-9a-f]{64}$")
_EXT = {b"RIFF": ".webp", b"\x89PNG": ".png", b"\xff\xd8\xff": ".jpg", b"GIF8": ".gif"}


def fee_schedule(broker: str, currency: str, side: str, qty: float, price: float) -> dict | None:
    """slip_ocr.FeeSchedule backed by broker_fees.py — the engine holds no rates."""
    import broker_fees
    if broker == "DIME" and currency == "USD":
        return {**broker_fees.estimate("DIME_US", side, qty, price), "label": "Dime schedule"}
    return None


def slip_dir() -> Path:
    return Path(DB_PATH).resolve().parent / "evidence" / "slips"


def _ext(data: bytes) -> str:
    return next((e for magic, e in _EXT.items() if data.startswith(magic)), ".img")


def save(data: bytes, result: dict) -> None:
    """Content-addressed, so saving the same slip twice is a no-op."""
    sha = result["image_sha256"]
    d = slip_dir()
    d.mkdir(parents=True, exist_ok=True)
    img = d / f"{sha}{_ext(data)}"
    if not img.exists():
        img.write_bytes(data)
    sidecar = {k: result.get(k) for k in ("engine", "broker", "status", "slip", "checks", "ocr")}
    sidecar["image_file"] = img.name
    (d / f"{sha}.json").write_text(json.dumps(sidecar, ensure_ascii=False), encoding="utf-8")


def load(sha: str) -> dict | None:
    if not _SHA.fullmatch(sha or ""):
        return None
    p = slip_dir() / f"{sha}.json"
    if not p.is_file():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def _value(slip: dict, key: str):
    return (slip["fields"].get(key) or {}).get("value")


def provenance(sidecar: dict) -> dict:
    """trades columns taken from the slip: order ref and fill time with offset."""
    slip = sidecar["slip"]
    executed = _value(slip, "executed_at")
    offset = "+07:00" if slip.get("display_timezone") == "Asia/Bangkok" else ""
    return {
        "broker_order_ref": _value(slip, "order_ref"),
        "executed_at": f"{executed}{offset}" if executed else None,
    }


def booked(conn, account_id: str, order_ref: str | None) -> list[dict]:
    """Book rows already carrying this broker order number (split lots share it)."""
    if not order_ref:
        return []
    rows = conn.execute(
        "SELECT id, symbol, date_entry, volume, price_entry FROM trades "
        "WHERE account_id = ? AND broker_order_ref = ?", (account_id, order_ref)
    ).fetchall()
    return [dict(r) for r in rows]


def record(conn, account_id: str, trade_id: str, sha: str, sidecar: dict) -> str:
    """Insert (or enrich and link) the broker_executions row for this slip. Returns its id."""
    slip = sidecar["slip"]
    v = lambda k: _value(slip, k)  # noqa: E731
    executed = v("executed_at")
    stamp = f"{executed}:00" if executed and len(executed) == 16 else executed
    symbol, side = (v("symbol") or "").upper(), v("side")
    qty, price = v("quantity"), v("price")
    if not (symbol and side and stamp and qty and price):
        raise ValueError("Slip lacks symbol, side, time, quantity or price — not recorded as evidence")
    order_ref = v("order_ref")
    identity = (account_id, symbol, side, stamp, qty, price)
    evidence = {
        "order_ref": order_ref, "gross_value": v("gross_value"), "commission": v("commission"),
        "vat": v("vat"), "sec_fee": v("sec_fee"), "taf_fee": v("taf_fee"),
        "exchange": v("exchange"), "order_type": v("order_type"),
        "trade_id": trade_id, "extractor": f"{sidecar.get('engine')} {((sidecar.get('ocr') or {}).get('backend')) or ''}".strip(),
    }
    # Same fill already cited (an Activity import, or this order re-entered
    # after its trade was deleted): add what the slip knows and link it.
    old = conn.execute(
        "SELECT id FROM broker_executions WHERE account_id=? AND (order_ref=? OR (symbol=? AND side=? "
        "AND executed_at_local=? AND quantity=? AND unit_price=?))",
        (account_id, order_ref, *identity[1:]),
    ).fetchone()
    if old:
        sets = ", ".join(f"{k} = COALESCE(?, {k})" for k in evidence if k != "trade_id")
        conn.execute(f"UPDATE broker_executions SET {sets}, trade_id = ?, "
                     "updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?",
                     (*[evidence[k] for k in evidence if k != "trade_id"], trade_id, old["id"]))
        return old["id"]
    row_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "broker-execution|" + "|".join(identity)))
    order_amount = v("order_amount") if side == "BUY" else None
    cols = {
        "id": row_id, "account_id": account_id, "broker": slip["broker"], "symbol": symbol,
        "side": side, "executed_at_local": stamp, "display_timezone": slip["display_timezone"],
        "quantity": qty, "unit_price": price, "instrument_ccy": slip.get("currency") or "USD",
        "order_amount": order_amount, "order_ccy": (slip.get("currency") or "USD") if order_amount else None,
        "source_image": sidecar["image_file"], "source_sha256": sha,
        "source_note": f"{slip['broker'].title()} order detail slip (OCR {sidecar.get('status')})",
        **evidence,
    }
    conn.execute(f"INSERT INTO broker_executions ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                 tuple(cols.values()))
    return row_id


def unlink_trade(conn, trade_id: str) -> None:
    """A deleted trade does not delete the fill it cited — the slip still happened."""
    conn.execute("UPDATE broker_executions SET trade_id = NULL WHERE trade_id = ?", (trade_id,))
