"""Bank transfer slips as the evidence of a fund deposit.

plans/fund-book.md: "where did the money come from" must have a trail. A
member's deposit can carry the transfer slip it was made with:

    read   an image → what the slip says (when, reference, from, to, amount,
           memo). OCR runs on this machine (slip_ocr/ocr.py); nothing leaves it.
           A reading is a SUGGESTION — the user checks it against the picture
           before it is saved.
    keep   the image, content-addressed, beside the database in
           `evidence/fund-slips/` (gitignored: it shows names and account
           numbers), and one `fund_slips` row per deposit with the fields as
           the user confirmed them plus the raw reading.
    guard  one slip is one deposit: the same image, or the same bank reference,
           cannot back a second deposit while the first one stands.

Who the money went to is recorded as the slip says and is not judged: a member
may pay the fund's manager, or pay into a broker account directly.

The parser (slip_ocr/parsers/bank_transfer.py) is written against the layout
of a Thai bank app's "transfer complete" slip (label on the left, value on the
right; SCB is the one it was built from). A slip it cannot read still comes
back with what it found and a list of what it did not — the form is then typed
by hand. A broker ORDER slip (Dime) is told apart first and refused here with
`kind: "trade"`: it belongs in ENTRY, not in a deposit.
"""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Optional

from config import DB_PATH
from slip_ocr import classify
from slip_ocr.parsers import bank_transfer

PARSER_VERSION = bank_transfer.PARSER_VERSION
MAX_BYTES = 12 * 1024 * 1024
FIELDS = bank_transfer.FIELDS
parse_transfer = bank_transfer.parse

_SHA = re.compile(r"^[0-9a-f]{64}$")
_EXT = {b"RIFF": ".webp", b"\x89PNG": ".png", b"\xff\xd8\xff": ".jpg", b"GIF8": ".gif"}
_MEDIA = {".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif"}


def slip_dir() -> Path:
    return Path(DB_PATH).resolve().parent / "evidence" / "fund-slips"


# ── reading ──────────────────────────────────────────────────────────────────

def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def save_image(data: bytes, reading: dict) -> str:
    """Keep the image and its reading under the image's hash; the same picture
    saved twice is one file. Returns the hash."""
    sha = sha256(data)
    d = slip_dir()
    d.mkdir(parents=True, exist_ok=True)
    ext = next((e for magic, e in _EXT.items() if data.startswith(magic)), ".img")
    img = d / f"{sha}{ext}"
    if not img.exists():
        img.write_bytes(data)
    (d / f"{sha}.json").write_text(
        json.dumps({"image_file": img.name, "reading": reading}, ensure_ascii=False), encoding="utf-8")
    return sha


def load(sha: str) -> Optional[dict]:
    if not _SHA.fullmatch(sha or ""):
        return None
    p = slip_dir() / f"{sha}.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None


def image_path(sha: str) -> Optional[tuple[Path, str]]:
    """(file, media type) of a saved slip image."""
    side = load(sha)
    if not side:
        return None
    p = slip_dir() / str(side.get("image_file") or "")
    if not p.is_file() or p.parent != slip_dir():
        return None
    return p, _MEDIA.get(p.suffix, "application/octet-stream")


def read(data: bytes) -> dict:
    """OCR + parse one image, keep it, and return `{sha256, reading}`.
    `reading.kind` = what the slip is (slip_ocr.classify): "transfer" is read
    into the deposit's fields; "trade" (a broker order slip) is not — the
    image is still kept, the fields stay empty and `unread` lists them all."""
    from slip_ocr import ocr
    tokens = ocr.read(data)
    kind = classify(tokens)
    if kind == "trade":
        reading = {**dict.fromkeys(FIELDS), "bank": None, "currency": "THB", "says_complete": False,
                   "unread": [f for f in FIELDS if f != "memo"], "parser": PARSER_VERSION}
    else:
        reading = parse_transfer(tokens)
    reading["kind"] = kind or "unknown"
    reading["ocr"] = {"backend": ocr.BACKEND, "tokens": [
        {"text": t.text, "box": [round(t.x0), round(t.y0), round(t.x1), round(t.y1)], "conf": round(t.conf, 3)}
        for t in tokens]}
    return {"sha256": save_image(data, reading), "reading": reading}


# ── one slip, one deposit ────────────────────────────────────────────────────

def standing_use(conn, fund_id: str, *, sha: Optional[str] = None, ref_code: Optional[str] = None) -> list[dict]:
    """Deposits that stand (not reversed) and already cite this image or this
    bank reference."""
    clauses, args = [], []
    if sha:
        clauses.append("s.sha256 = ?")
        args.append(sha)
    if ref_code:
        clauses.append("(s.ref_code IS NOT NULL AND s.ref_code != '' AND s.ref_code = ?)")
        args.append(ref_code)
    if not clauses:
        return []
    rows = conn.execute(
        "SELECT s.id slip_id, s.sha256, s.ref_code, c.id contribution_id, c.date, c.amount, c.currency, c.member_id "
        "FROM fund_slips s JOIN fund_contributions c ON c.id = s.contribution_id "
        f"WHERE s.fund_id = ? AND ({' OR '.join(clauses)}) AND c.reverses_id IS NULL "
        "AND NOT EXISTS (SELECT 1 FROM fund_contributions r WHERE r.reverses_id = c.id)",
        [fund_id, *args]).fetchall()
    return [dict(r) for r in rows]


def attach(conn, fund_id: str, contribution: dict, slip: dict, *, actor: str = "user") -> dict:
    """Record the slip a deposit was made with, in the deposit's transaction.

    `slip` = `{sha256, ...fields as the user confirmed them}`. Raises
    ValueError(code, detail) — the caller turns it into a refusal — when the
    image was never uploaded, the slip already backs a standing deposit, or
    the slip's amount is not the deposit's."""
    sha = str(slip.get("sha256") or "")
    side = load(sha)
    if side is None:
        raise ValueError("unknown_slip", "This slip image has not been uploaded on this machine")
    ref = (str(slip.get("ref_code") or "").strip()) or None
    used = standing_use(conn, fund_id, sha=sha, ref_code=ref)
    if used:
        u = used[0]
        raise ValueError(
            "slip_already_used",
            f"This slip already backs the deposit of {u['amount']} {u['currency']} dated {u['date']} — "
            "one transfer is one deposit. Reverse that deposit first if it was entered wrongly.")
    amount = None
    if slip.get("amount") not in (None, ""):
        try:
            amount = Decimal(str(slip["amount"]).replace(",", ""))
        except Exception:
            raise ValueError("bad_slip_amount", f"The slip amount is not a number: {slip['amount']!r}")
        if amount != Decimal(contribution["amount"]):
            raise ValueError(
                "slip_amount_differs",
                f"The slip says {amount} but the deposit is {contribution['amount']} {contribution['currency']}. "
                "They must be the same transfer.")
    slip_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO fund_slips (id, fund_id, contribution_id, sha256, image_file, bank, transferred_at, ref_code, "
        "from_name, from_account, to_name, to_account, amount, currency, memo, reading_json, entered_by) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (slip_id, fund_id, contribution["id"], sha, side.get("image_file"), slip.get("bank") or None,
         slip.get("transferred_at") or None, ref,
         (slip.get("from_name") or "").strip() or None, (slip.get("from_account") or "").strip() or None,
         (slip.get("to_name") or "").strip() or None, (slip.get("to_account") or "").strip() or None,
         str(amount) if amount is not None else None, slip.get("currency") or "THB",
         (slip.get("memo") or "").strip() or None,
         json.dumps(side.get("reading") or {}, ensure_ascii=False), actor or "user"))
    return dict(conn.execute("SELECT * FROM fund_slips WHERE id = ?", (slip_id,)).fetchone())


def for_contributions(conn, fund_id: str) -> dict[str, dict]:
    """{contribution id: its slip} — without the raw reading."""
    cols = ("id, contribution_id, sha256, bank, transferred_at, ref_code, from_name, from_account, "
            "to_name, to_account, amount, currency, memo, created_at")
    return {r["contribution_id"]: dict(r) for r in conn.execute(
        f"SELECT {cols} FROM fund_slips WHERE fund_id = ?", (fund_id,))}
