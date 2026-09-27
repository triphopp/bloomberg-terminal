"""Thai slip timestamps: "25 ก.ย. 69 - 20:45 น." → datetime(2026, 9, 25, 20, 45).

Years are Buddhist Era — 2-digit (69 = 2569) or 4-digit (2569); a 4-digit year
below 2400 is taken as AD. Month keys keep their vowels: without them มี.ค.
(March) and ม.ค. (January) would read the same.
"""
from __future__ import annotations

from datetime import datetime
import re

_MONTHS = {
    "มกราคม": 1, "กุมภาพันธ์": 2, "มีนาคม": 3, "เมษายน": 4, "พฤษภาคม": 5, "มิถุนายน": 6,
    "กรกฎาคม": 7, "สิงหาคม": 8, "กันยายน": 9, "ตุลาคม": 10, "พฤศจิกายน": 11, "ธันวาคม": 12,
    "มค": 1, "กพ": 2, "มีค": 3, "เมย": 4, "พค": 5, "มิย": 6,
    "กค": 7, "สค": 8, "กย": 9, "ตค": 10, "พย": 11, "ธค": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}
_KEYS = sorted(_MONTHS, key=len, reverse=True)

_DATE = re.compile(r"(\d{1,2})\s*([^\d\s][^\d]*?)\s*(\d{2,4})(?!\d)")
_TIME = re.compile(r"(\d{1,2})\s*[:.]\s*(\d{2})(?:\s*[:.]\s*(\d{2}))?")


def _month(text: str) -> int | None:
    key = re.sub(r"[\s.]", "", text.lower())
    for k in _KEYS:
        if key.startswith(k):
            return _MONTHS[k]
    return None


def _year(raw: str) -> int:
    y = int(raw)
    if y < 100:
        return 2500 + y - 543
    return y - 543 if y >= 2400 else y


def parse_thai_datetime(text: str) -> datetime | None:
    """First date in `text`, with the first time after it (00:00 if none)."""
    m = _DATE.search(text)
    if not m:
        return None
    month = _month(m.group(2))
    if month is None:
        return None
    try:
        day, year = int(m.group(1)), _year(m.group(3))
        t = _TIME.search(text, m.end())
        hh, mm, ss = (int(t.group(1)), int(t.group(2)), int(t.group(3) or 0)) if t else (0, 0, 0)
        return datetime(year, month, day, hh, mm, ss)
    except ValueError:
        return None
