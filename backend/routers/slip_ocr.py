"""Broker slip screenshot → ENTRY form fields. Reads only; never writes a trade.

The engine (backend/slip_ocr/) does not touch the database. This router adds
the one lookup that needs it: has this broker order number been booked already.
"""
from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile

from db import get_db

router = APIRouter(prefix="/api/v2/portfolio/slip")

MAX_BYTES = 12 * 1024 * 1024
# slip broker → portfolio_accounts.id the ENTRY form preselects
ACCOUNT_HINT = {"DIME": "dime"}


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
    return out


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
