"""Broker order slip (screenshot) → trade-entry fields.

A separate engine: it never opens the portfolio database. The router hands it
image bytes and gets back what the slip says, how sure the engine is, the
arithmetic checks that tie the numbers together, and the ENTRY form fields to
fill. A person still presses SAVE — the engine only removes the typing.

    read_slip(image_bytes, fee_schedule=None)    OCR + parse + validate + map, one call
    parse_tokens(tokens, fee_schedule=None)      the same without OCR (tests, other OCR engines)
    classify(tokens)                             "trade" | "transfer" | None — what kind of slip it is

Every result says `slip_kind`. A bank transfer slip (money in / out) is not a
trade: it comes back with `transfer` (its fields) and no `form`, so the host
can send it to cash instead of refusing it.

Self-contained: imports nothing from the host app. Fee rates are the host's
business — pass `fee_schedule` (see validate.FeeSchedule) to get the
"schedule" check; without it that one check is skipped. See README.md.

Layers, each replaceable on its own:
    ocr.py        image → Token list (rapidocr/ONNX, easyocr fallback; local, in a worker process)
    layout.py     Token list → label/value lookups (Thai-tolerant fuzzy labels)
    parsers/      one module per broker layout; `detect` picks the first that claims it;
                  bank_transfer.py = a bank's transfer slip (asked after every trade layout)
    thai_date.py  "25 ก.ย. 69 - 20:45 น." → 2026-09-25T20:45
    validate.py   qty × price = value, value + fees = order amount, fee schedule, dates
    mapping.py    slip → ENTRY form fields (NY trade date, exact price, fee total)
"""
from __future__ import annotations

import hashlib

from .layout import Token
from .mapping import to_form
from .parsers import bank_transfer, detect
from .validate import FeeSchedule, validate

ENGINE_VERSION = "slip-ocr/1"


__all__ = ["ENGINE_VERSION", "FeeSchedule", "Token", "classify", "parse_tokens", "read_slip", "read_slips", "stack"]

SUPPORTED = "Dime order detail (US stocks, US options), bank transfer slip (SCB layout)"


def classify(tokens: list[Token]) -> str | None:
    """What a slip is, before anything is read out of it: "trade" (a broker
    order slip), "transfer" (a bank's money-in / money-out slip) or None. The
    trade layouts are asked first — an order slip can mention a bank."""
    if detect(tokens) is not None:
        return "trade"
    if bank_transfer.claims(tokens):
        return "transfer"
    return None


def parse_tokens(tokens: list[Token], fee_schedule: FeeSchedule | None = None) -> dict:
    parser = detect(tokens)
    if parser is None and bank_transfer.claims(tokens):
        transfer = bank_transfer.parse(tokens)
        return {
            "engine": ENGINE_VERSION, "slip_kind": "transfer", "broker": None,
            "status": "review" if transfer["unread"] else "ok",
            "slip": None, "checks": [], "form": None, "transfer": transfer,
            "warnings": ["Bank transfer slip — money in / out, not a trade: book it in CASH"],
        }
    if parser is None:
        return {
            "engine": ENGINE_VERSION, "slip_kind": None, "broker": None, "status": "fail",
            "slip": None, "checks": [], "form": None,
            "warnings": [f"Unrecognised slip layout — supported: {SUPPORTED}"],
        }
    slip = parser.parse(tokens)
    slip.setdefault("kind", "stock")
    checks = getattr(parser, "validate", validate)(slip, fee_schedule)
    form, warnings = getattr(parser, "to_form", to_form)(slip, checks)
    status = _status(slip, checks)
    return {
        "engine": ENGINE_VERSION, "slip_kind": "trade", "broker": slip["broker"], "status": status,
        "slip": slip, "checks": checks, "form": form, "warnings": warnings,
    }


def read_slip(image: bytes, fee_schedule: FeeSchedule | None = None) -> dict:
    return read_slips([image], fee_schedule)


def stack(pages: list[list[Token]], gap: float = 40.0) -> list[Token]:
    """Tokens of several screenshots of ONE order, as if it were one tall image.

    A long order-detail screen is usually sent as a top and a bottom shot that
    overlap. Stacking keeps each page's geometry; a row that appears on both
    pages is found twice with the same value, and label lookup takes the first.
    """
    out: list[Token] = []
    offset = 0.0
    for toks in pages:
        if not toks:
            continue
        out += [Token(t.text, t.x0, t.y0 + offset, t.x1, t.y1 + offset, t.conf) for t in toks]
        offset += max(t.y1 for t in toks) + gap
    return out


def read_slips(images: list[bytes], fee_schedule: FeeSchedule | None = None) -> dict:
    from . import ocr  # starts the OCR worker only when an image is actually read

    pages = [ocr.read(img) for img in images]
    tokens = stack(pages)
    out = parse_tokens(tokens, fee_schedule)
    shas = [hashlib.sha256(img).hexdigest() for img in images]
    out["image_sha256"] = shas[0] if shas else None
    out["image_sha256s"] = shas
    out["ocr"] = {"backend": ocr.BACKEND, "tokens": len(tokens), "pages": len(images)}
    return out


def _status(slip: dict, checks: list[dict]) -> str:
    """ok = every required field read and every check passed; fail = unusable."""
    required = slip.get("required") or ("side", "symbol", "quantity", "price", "executed_at")
    fields = slip["fields"]
    if any(fields.get(k, {}).get("value") in (None, "") for k in required):
        return "fail"
    if any(c["level"] == "error" for c in checks):
        return "review"
    if any(c["level"] == "warn" for c in checks):
        return "review"
    if any(f.get("confidence", 1) < 0.5 for f in fields.values() if f.get("value") is not None):
        return "review"
    return "ok"
