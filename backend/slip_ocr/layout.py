"""Token geometry and Thai-tolerant label lookup.

OCR on Thai drops or swaps the stacked marks (ไม้เอก, สระอิ/อี, ไม้หันอากาศ):
"คำสั่ง" comes back as "คำสัง", "ที่" as "ที". Labels are therefore compared
with those marks removed, then fuzzily, so one lost mark never loses a field.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from difflib import SequenceMatcher
import re


@dataclass(frozen=True)
class Token:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    conf: float = 1.0

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2

    @property
    def h(self) -> float:
        return max(1.0, self.y1 - self.y0)


# Above/below vowels, tone marks, thanthakhat, mai han-akat, maitaikhu.
_THAI_MARKS = re.compile("[ัิ-ฺ็-๎]")
_SPACE = re.compile(r"[\s.:\-–—()]+")


def norm(text: str) -> str:
    return _SPACE.sub("", _THAI_MARKS.sub("", text.lower()))


def label_score(token_text: str, label: str) -> float:
    """1.0 when the label is inside the token; else the best fuzzy prefix ratio."""
    t, l = norm(token_text), norm(label)
    if not t or not l:
        return 0.0
    if l in t:
        return 1.0
    head = t[: len(l) + 2]
    return SequenceMatcher(None, head, l).ratio()


def find_label(tokens: list[Token], *labels: str, min_score: float = 0.8,
               exclude: tuple[str, ...] = ()) -> Token | None:
    best, best_score = None, min_score
    for tok in tokens:
        if any(norm(e) in norm(tok.text) for e in exclude):
            continue
        for lab in labels:
            s = label_score(tok.text, lab)
            if s > best_score or (s == best_score and best is not None and tok.y0 < best.y0):
                best, best_score = tok, s
    return best


def same_row(tokens: list[Token], anchor: Token) -> list[Token]:
    """Tokens right of `anchor` whose vertical centre sits inside its line."""
    tol = anchor.h * 0.7
    row = [t for t in tokens if t is not anchor and abs(t.cy - anchor.cy) <= tol and t.x0 > anchor.x1 - 5]
    return sorted(row, key=lambda t: t.x0)


def below(tokens: list[Token], anchor: Token, lines: float = 3.0) -> list[Token]:
    """Tokens under `anchor` in its column, nearest first (stacked label/value)."""
    out = []
    for t in tokens:
        if t is anchor or t.y0 <= anchor.cy:
            continue
        if t.y0 - anchor.y1 > anchor.h * lines:
            continue
        overlap = min(t.x1, anchor.x1) - max(t.x0, anchor.x0)
        if overlap > 0 or abs(t.x0 - anchor.x0) < anchor.h * 2:
            out.append(t)
    return sorted(out, key=lambda t: t.y0)


def next_row(tokens: list[Token], anchor: Token, row: list[Token]) -> list[Token]:
    """The line under a value that wrapped (e.g. a long order number)."""
    if not row:
        return []
    last = row[-1]
    out = [t for t in tokens
           if t.y0 > last.cy and t.y0 - last.y1 < last.h * 1.2
           and t.x0 > anchor.x1 and t not in row]
    return sorted(out, key=lambda t: t.x0)


# ── numbers ────────────────────────────────────────────────────────────────

_NUM = re.compile(r"[-+]?\d[\d,]*(?:\.\d+)?")
_CCY = re.compile(r"\b(usd|thb|hkd|jpy|eur|sgd)\b", re.I)
# OCR letter/digit swaps that only ever happen inside a number.
_FIX = str.maketrans({"o": "0", "O": "0", "l": "1", "I": "1", "|": "1", "S": "5"})


def parse_number(text: str) -> Decimal | None:
    cleaned = re.sub(r"(?<=\d)[oOlI|S](?=[\d,.])|(?<=[\d,.])[oOlI|S](?=\d)",
                     lambda m: m.group(0).translate(_FIX), text)
    m = _NUM.search(cleaned)
    if not m:
        return None
    try:
        return Decimal(m.group(0).replace(",", ""))
    except InvalidOperation:
        return None


def parse_money(text: str) -> tuple[Decimal | None, str | None]:
    ccy = _CCY.search(text)
    return parse_number(text), (ccy.group(1).upper() if ccy else None)


def is_money(text: str) -> bool:
    return bool(_NUM.search(text)) and bool(_CCY.search(text))
