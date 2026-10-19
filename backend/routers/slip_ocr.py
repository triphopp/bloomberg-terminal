"""Broker slip screenshot → ENTRY form fields. Reads only; never writes a trade.

A bank transfer slip dropped here is not refused: it comes back with
`slip_kind: "transfer"` and `transfer_hint` — which personal-book account the
money went into or came out of, and DEPOSIT / WITHDRAW — for ENTRY to hand to
CASH. The hint is a guess from the names on the slip; the person picks.

The engine (backend/slip_ocr/) does not touch the database. This router adds
the one lookup that needs it: has this broker order number been booked already.
"""
from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile

import account_scope
from db import get_db

router = APIRouter(prefix="/api/v2/portfolio/slip")

MAX_BYTES = 12 * 1024 * 1024
# slip broker → portfolio_accounts.id the ENTRY form preselects
ACCOUNT_HINT = {"DIME": "dime"}
# How a broker's name is printed on a Thai bank slip, by the Latin name the
# account carries. Any name containing one of BROKER_WORDS is a broker even
# when no account matches it.
NAME_ALIASES = {"FINANSIA": ("ฟินันเซีย",), "INNOVESTX": ("อินโนเวสท์", "INNOVEST X"), "DIME": ("ไดม์",)}
BROKER_WORDS = ("หลักทรัพย์", "บล.", "SECURITIES")


@router.get("/status")
def slip_status():
    from slip_ocr import ENGINE_VERSION
    try:
        from slip_ocr import ocr
        loaded = ocr.is_loaded()
    except Exception:
        loaded = False
    return {"engine": ENGINE_VERSION, "ocr_loaded": loaded, "backend": _backend()}


def _backend() -> str | None:
    try:
        from slip_ocr import ocr
        return ocr.BACKEND
    except Exception:
        return None


@router.post("/warm")
def slip_warm():
    """Load the OCR model in its worker now, so the first slip does not wait for it."""
    from slip_ocr import ocr
    ocr.warm()
    return {"ok": True, "backend": ocr.BACKEND}


@router.post("/read")
def read_slip(file: UploadFile | None = File(None), files: list[UploadFile] = File(default=[])):
    """One order slip. `files` takes several screenshots of the SAME order in
    top-to-bottom order (a long option slip rarely fits one screen); `file` is
    the single-image form older clients send."""
    uploads = ([file] if file is not None else []) + list(files or [])
    if not uploads:
        raise HTTPException(status_code=422, detail="No image")
    if len(uploads) > 4:
        raise HTTPException(status_code=422, detail="At most 4 screenshots per order")
    images = []
    for up in uploads:
        data = up.file.read(MAX_BYTES + 1)
        if not data:
            raise HTTPException(status_code=422, detail="Empty file")
        if len(data) > MAX_BYTES:
            raise HTTPException(status_code=413, detail="Image larger than 12 MB")
        images.append(data)
    from PIL import UnidentifiedImageError

    import slip_evidence
    import slip_ocr
    try:
        out = slip_ocr.read_slips(images, fee_schedule=slip_evidence.fee_schedule)
    except UnidentifiedImageError as exc:
        raise HTTPException(status_code=422, detail="Not a readable image (PNG / JPG / WEBP)") from exc
    except (ImportError, RuntimeError, TimeoutError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"OCR engine unavailable: {exc}") from exc
    if out.get("form"):
        out["form"]["account_hint"] = ACCOUNT_HINT.get(out.get("broker") or "")
    if out.get("slip"):
        # Each screenshot is stored under its own hash; every sidecar carries
        # the whole reading, so any one of them cites the order.
        for data, sha in zip(images, out["image_sha256s"]):
            slip_evidence.save(data, {**out, "image_sha256": sha})
    out["duplicates"] = _booked(out.get("form") or {})
    if out.get("slip_kind") == "transfer":
        with get_db() as conn:
            sql, params = account_scope.accounts_where(None)
            accounts = [dict(r) for r in conn.execute(
                f"SELECT id, name, broker, currency FROM portfolio_accounts WHERE {sql}", params)]
        out["transfer_hint"] = transfer_hint(out["transfer"], accounts)
    return out


def _squash(text: str | None) -> str:
    return "".join((text or "").upper().split())


def _account_in(name: str | None, accounts: list[dict]) -> dict | None:
    """The account a party's printed name points at, if any."""
    have = _squash(name)
    if not have:
        return None
    for a in accounts:
        keys = {_squash(a.get("id")), _squash(a.get("name")), _squash(a.get("broker"))} - {""}
        for latin, thai in NAME_ALIASES.items():
            if any(latin in k for k in keys):
                keys |= {_squash(t) for t in thai}
        if any(len(k) >= 3 and k in have for k in keys):
            return a
    return None


def _is_broker(name: str | None) -> bool:
    have = _squash(name)
    return bool(have) and any(_squash(w) in have for w in BROKER_WORDS)


def transfer_hint(transfer: dict, accounts: list[dict]) -> dict:
    """DEPOSIT when the money went to a broker account, WITHDRAW when it came
    from one; null when the slip does not say. Never decides — CASH shows it
    pre-picked and the person confirms."""
    to_acc = _account_in(transfer.get("to_name"), accounts)
    from_acc = _account_in(transfer.get("from_name"), accounts)
    if to_acc or (not from_acc and _is_broker(transfer.get("to_name"))):
        flow, acc = "DEPOSIT", to_acc
    elif from_acc or _is_broker(transfer.get("from_name")):
        flow, acc = "WITHDRAW", from_acc
    else:
        flow, acc = None, None
    return {"flow_type": flow, "account_id": acc["id"] if acc else None,
            "date": (transfer.get("transferred_at") or "")[:10] or None,
            "amount": transfer.get("amount"), "ref_code": transfer.get("ref_code")}


def _booked(form: dict) -> list[dict]:
    """Fills already carrying this order number — stock trades (the column, or
    on older rows the note) and option fills."""
    ref = form.get("broker_order_ref")
    if not ref:
        return []
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, account_id, symbol, date_entry, volume, price_entry FROM trades "
            "WHERE broker_order_ref = ? OR note LIKE ? LIMIT 5", (ref, f"%{ref}%")
        ).fetchall()
        opts = conn.execute(
            "SELECT t.trade_id id, t.account_id, c.occ_symbol symbol, t.trade_date date_entry, "
            "t.quantity volume, t.price price_entry FROM option_trades t "
            "JOIN option_contracts c USING(contract_id) WHERE t.broker_order_ref = ? LIMIT 5", (ref,)
        ).fetchall()
    return [dict(r) for r in rows] + [dict(r) for r in opts]
