"""A bank app's "transfer complete" slip (money in or out), read into its fields.

Not a trade: it has no parser in `PARSERS` and no ENTRY form. `classify`
(slip_ocr/__init__.py) asks the trade layouts first and this one after, so a
Dime order slip is never taken for a transfer.

Written against the layout of SCB's slip (label on the left, value on the
right). A slip it cannot read fully still comes back with what it found and
`unread` listing the rest — the person types those.
"""
from __future__ import annotations

import re
from typing import Optional

from ..layout import Token, find_label, label_score, parse_number, same_row
from ..thai_date import parse_thai_datetime

PARSER_VERSION = "fund-slip/1"
FIELDS = ("transferred_at", "ref_code", "from_name", "from_account", "to_name", "to_account", "amount", "memo")

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


def parse(tokens: list[Token]) -> dict:
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


def claims(tokens: list[Token]) -> bool:
    """A transfer slip: says it completed, or names both sides, and has an amount."""
    labels = {k: find_label(tokens, *v, min_score=0.85) for k, v in _LABELS.items()}
    sides = labels["from"] is not None and labels["to"] is not None
    return labels["amount"] is not None and (labels["done"] is not None or sides)
