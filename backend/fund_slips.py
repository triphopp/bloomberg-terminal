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

The parser is written against the layout of a Thai bank app's "transfer
complete" slip (label on the left, value on the right; SCB is the one it was
built from). A slip it cannot read still comes back with what it found and a
list of what it did not — the form is then typed by hand.
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
from slip_ocr.layout import Token, find_label, label_score, parse_number, same_row
from slip_ocr.thai_date import parse_thai_datetime

PARSER_VERSION = "fund-slip/1"
MAX_BYTES = 12 * 1024 * 1024
FIELDS = ("transferred_at", "ref_code", "from_name", "from_account", "to_name", "to_account", "amount", "memo")

_SHA = re.compile(r"^[0-9a-f]{64}$")
_EXT = {b"RIFF": ".webp", b"\x89PNG": ".png", b"\xff\xd8\xff": ".jpg", b"GIF8": ".gif"}
_MEDIA = {".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif"}
# A masked account as banks print it: xxx-xxx435-2. OCR mixes the case of the x.
_ACCOUNT = re.compile(r"^(?=.*\d)(?=.*[xX])[xX\d][xX\d\- ]{5,}$")
_REF = re.compile(r"[A-Za-z0-9]{12,}")
_TIME = re.compile(r"\d{1,2}\s*[:.]\s*\d{2}")
_BANKS = ("SCB", "KBANK", "K PLUS", "KRUNGTHAI", "KTB", "BBL", "BANGKOK BANK", "KRUNGSRI", "TTB", "GSB", "UOB", "KKP")
_LABELS = {
    "ref": ("รหัสอ้างอิง", "เลขที่รายการ", "เลขที่อ้างอิง"),
    "from": ("จาก",),
    "to": ("ไปยัง", "ไปที่"),
    "amount": ("จำนวนเงิน", "จำนวน"),
    "memo": ("บันทึกช่วยจำ", "บันทึก"),
    "done": ("โอนเงินสำเร็จ", "รายการสำเร็จ", "ทำรายการสำเร็จ"),
}


def slip_dir() -> Path:
    return Path(DB_PATH).resolve().parent / "evidence" / "fund-slips"


# ── reading ──────────────────────────────────────────────────────────────────

def _text(tokens: list[Token]) -> str:
    return " ".join(t.text.strip() for t in sorted(tokens, key=lambda t: t.x0) if t.text.strip())


def _block(tokens: list[Token], top: Token, bottom: Optional[Token]) -> list[Token]:
    """Tokens from the row of `top` down to just above `bottom`."""
    lo = top.cy - top.h * 0.7
    hi = (bottom.cy - bottom.h * 0.7) if bottom else float("inf")
    return [t for t in tokens if t is not top and lo <= t.cy < hi]


def _party(tokens: list[Token], label: Token, nxt: Optional[Token]) -> tuple[Optional[str], Optional[str]]:
    """(name, masked account) of the party a label introduces: the name on the
    label's row, the account in the rows under it."""
    block = _block(tokens, label, nxt)
    accounts = [t for t in block if _ACCOUNT.match(t.text.strip())]
    row = [t for t in same_row(tokens, label) if t not in accounts]
    name = _text(row) or None
    account = accounts[0].text.strip().lower() if accounts else None
    return name, account


def parse_transfer(tokens: list[Token]) -> dict:
    """What a transfer slip says. Every field is None when it was not found;
    `unread` lists those, so the caller can say what still has to be typed."""
    labels = {k: find_label(tokens, *v, min_score=0.85) for k, v in _LABELS.items()}
    order = sorted((t for t in labels.values() if t is not None), key=lambda t: t.cy)

    def after(key: str) -> Optional[Token]:
        tok = labels.get(key)
        if tok is None:
            return None
        later = [t for t in order if t.cy > tok.cy + tok.h * 0.5]
        return later[0] if later else None

    out: dict = dict.fromkeys(FIELDS)

    for tok in sorted(tokens, key=lambda t: t.cy):
        if _TIME.search(tok.text):
            when = parse_thai_datetime(tok.text)
            if when:
                out["transferred_at"] = when.isoformat(timespec="minutes")
                break

    if labels["ref"] is not None:
        ref = labels["ref"]
        # The value's box often starts under the end of the label's, so the
        # row is taken by height alone rather than "right of the label".
        row = [t for t in tokens if t is not ref and abs(t.cy - ref.cy) <= ref.h * 0.7]
        m = _REF.search(_text(row).replace(" ", ""))
        if m:
            out["ref_code"] = m.group(0)
    if out["ref_code"] is None:      # the label and its value read as one token
        for tok in tokens:
            if any(label_score(tok.text, lab) >= 0.85 for lab in _LABELS["ref"]):
                m = _REF.search(tok.text)
                if m:
                    out["ref_code"] = m.group(0)

    if labels["from"] is not None:
        out["from_name"], out["from_account"] = _party(tokens, labels["from"], after("from"))
    if labels["to"] is not None:
        out["to_name"], out["to_account"] = _party(tokens, labels["to"], after("to"))

    if labels["amount"] is not None:
        amount = parse_number(_text(same_row(tokens, labels["amount"])))
        if amount is not None and amount > 0:
            out["amount"] = str(amount)

    if labels["memo"] is not None:
        memo = labels["memo"]
        under = [t for t in tokens if t is not memo and memo.cy + memo.h * 0.6 < t.cy <= memo.cy + memo.h * 2.4]
        inline = same_row(tokens, memo)
        out["memo"] = _text(inline or under) or None

    joined = " ".join(t.text for t in tokens).upper()
    bank = next((b for b in _BANKS if re.search(rf"(?<![A-Z]){re.escape(b)}(?![A-Z])", joined)), None)
    return {
        **out,
        "bank": bank,
        "currency": "THB",
        "says_complete": labels["done"] is not None,
        "unread": [f for f in FIELDS if f != "memo" and out[f] is None],
        "parser": PARSER_VERSION,
    }


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
    """OCR + parse one image, keep it, and return `{sha256, reading}`."""
    from slip_ocr import ocr
    tokens = ocr.read(data)
    reading = parse_transfer(tokens)
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
