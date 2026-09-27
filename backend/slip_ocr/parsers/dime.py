"""Dime! "รายละเอียดคำสั่ง" (order detail) screen, US stocks.

Layout, top to bottom:
    ซื้อ COST                    [NASDAQ]     side + symbol, exchange chip
    1,900.00 USD                              order amount (what was sent)
    ใช้ราคาตลาด (Market)
    ราคาที่ได้จริง   จำนวนหุ้น                  stacked: labels, values below
    914.11 USD      2.0751791
    มูลค่าหุ้น                1,896.96 USD      label left, value right
    ค่าคอมมิชชัน                 2.84 USD
    ภาษีมูลค่าเพิ่ม 7% (VAT)       0.20 USD
    ประเภทคำสั่ง · ช่วงเวลาส่งคำสั่ง · ช่วงเวลาที่คำสั่งมีผล
    วันที่ส่งคำสั่ง / วันที่คำสั่งสำเร็จ   25 ก.ย. 69 - 20:45 น.   Thai local time
    บัญชีชำระเงิน   Dime! USD 80000472719
    เลขที่คำสั่ง     STKBMF2026092501454 1145317   (wraps onto two lines)

The price shown is rounded; value = qty × true price. See validate.py.
"""
from __future__ import annotations

from decimal import Decimal
import re

from ..layout import (Token, below, find_label, is_money, next_row, norm, parse_money,
                      parse_number, same_row)
from ..thai_date import parse_thai_datetime

BROKER = "DIME"
DISPLAY_TZ = "Asia/Bangkok"

_EXCHANGES = ("NASDAQ", "NYSE", "ARCA", "AMEX", "BATS", "OTC")
_SYMBOL = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")
_ORDER_REF = re.compile(r"[A-Z]{3,}\d{8,}")


def claims(tokens: list[Token]) -> bool:
    text = " ".join(norm(t.text) for t in tokens)
    hits = sum(k in text for k in (norm("ราคาที่ได้จริง"), norm("มูลค่าหุ้น"), norm("เลขที่คำสั่ง"),
                                   "dime", norm("ค่าคอมมิชชัน")))
    return hits >= 2


def _field(value, tok: Token | list[Token] | None, confidence: float | None = None) -> dict:
    toks = tok if isinstance(tok, list) else ([tok] if tok else [])
    conf = confidence if confidence is not None else (min(t.conf for t in toks) if toks else 0.0)
    return {
        "value": value,
        "confidence": round(float(conf), 2),
        "raw": " ".join(t.text for t in toks) if toks else None,
    }


def _money_right(tokens, *labels, exclude=()) -> tuple[dict, str | None]:
    lab = find_label(tokens, *labels, exclude=exclude)
    if lab is None:
        return _field(None, None), None
    for t in same_row(tokens, lab):
        amt, ccy = parse_money(t.text)
        if amt is not None:
            return _field(str(amt), t, min(t.conf, max(lab.conf, 0.5))), ccy
    return _field(None, None), None


def _header(tokens: list[Token]) -> tuple[dict, dict, dict]:
    """(side, symbol, exchange) from the "ซื้อ COST [NASDAQ]" line."""
    side = symbol = exch = _field(None, None)
    for t in sorted(tokens, key=lambda t: t.y0):
        n = norm(t.text)
        mark = "BUY" if n.startswith(norm("ซื้อ")) else "SELL" if n.startswith(norm("ขาย")) else None
        if mark is None:
            continue
        side = _field(mark, t)
        rest = re.sub(r"^[฀-๿\s]+", "", t.text).strip().upper()
        cand = rest.split()[0] if rest else ""
        if not _SYMBOL.match(cand):
            nxt = same_row(tokens, t)
            cand = nxt[0].text.strip().upper() if nxt else ""
        if _SYMBOL.match(cand) and cand not in _EXCHANGES:
            symbol = _field(cand, t)
        for r in same_row(tokens, t):
            u = re.sub(r"[^A-Z]", "", r.text.upper())
            for ex in _EXCHANGES:
                # OCR reads the chip's Q as O ("NASDAO"): allow one letter off.
                if len(u) == len(ex) and sum(a != b for a, b in zip(u, ex)) <= 1:
                    exch = _field(ex, r)
        break
    return side, symbol, exch


def _order_amount(tokens: list[Token], side_tok_y: float | None, stop: Token | None) -> tuple[dict, str | None]:
    """The big number under the header: the amount the order was sent for."""
    top = side_tok_y or 0
    bottom = stop.y0 if stop else float("inf")
    for t in sorted(tokens, key=lambda t: t.y0):
        if top < t.cy < bottom and is_money(t.text):
            amt, ccy = parse_money(t.text)
            return _field(str(amt), t), ccy
    return _field(None, None), None


def _stamp(tokens, *labels) -> dict:
    lab = find_label(tokens, *labels)
    if lab is None:
        return _field(None, None)
    row = same_row(tokens, lab)
    text = " ".join(t.text for t in row)
    dt = parse_thai_datetime(text)
    return _field(dt.isoformat(timespec="minutes") if dt else None, row or None)


def parse(tokens: list[Token]) -> dict:
    side, symbol, exch = _header(tokens)

    px_lab = find_label(tokens, "ราคาที่ได้จริง")
    qty_lab = find_label(tokens, "จำนวนหุ้น")
    price = quantity = _field(None, None)
    ccy = None
    if px_lab:
        for t in below(tokens, px_lab):
            amt, c = parse_money(t.text)
            if amt is not None:
                price, ccy = _field(str(amt), t), c or ccy
                break
    if qty_lab:
        for t in below(tokens, qty_lab):
            q = parse_number(t.text)
            if q is not None and not is_money(t.text):
                quantity = _field(str(q), t)
                break

    side_y = next((t.cy for t in tokens if side["raw"] and t.text == side["raw"]), None)
    order_amount, oc = _order_amount(tokens, side_y, px_lab)
    gross, gc = _money_right(tokens, "มูลค่าหุ้น")
    commission, _ = _money_right(tokens, "ค่าคอมมิชชัน", "ค่าคอม")
    vat, _ = _money_right(tokens, "ภาษีมูลค่าเพิ่ม", "vat")
    sec_fee, _ = _money_right(tokens, "sec fee", "ค่าธรรมเนียม sec", "ค่าธรรมเนียมก.ล.ต.สหรัฐ")
    taf_fee, _ = _money_right(tokens, "taf", "ค่าธรรมเนียม finra", "finra taf")

    order_type = _field(None, None)
    ot_lab = find_label(tokens, "ประเภทคำสั่ง")
    if ot_lab:
        row = same_row(tokens, ot_lab)
        txt = " ".join(t.text for t in row).lower()
        kind = "MARKET" if "market" in txt or norm("ราคาตลาด") in norm(txt) else \
               "LIMIT" if "limit" in txt or norm("ราคาที่กำหนด") in norm(txt) else None
        order_type = _field(kind, row or None)

    submitted = _stamp(tokens, "วันที่ส่งคำสั่ง")
    filled = _stamp(tokens, "วันที่คำสั่งสำเร็จ")

    order_ref = _field(None, None)
    ref_lab = find_label(tokens, "เลขที่คำสั่ง", exclude=("บัญชี",))
    if ref_lab:
        row = same_row(tokens, ref_lab)
        parts = row + next_row(tokens, ref_lab, row)
        joined = "".join(re.sub(r"\s", "", t.text) for t in parts).upper()
        if _ORDER_REF.search(joined):
            order_ref = _field(joined, parts)

    settlement = _field(None, None)
    st_lab = find_label(tokens, "บัญชีชำระเงิน")
    if st_lab:
        row = same_row(tokens, st_lab)
        parts = row + next_row(tokens, st_lab, row)
        name = " ".join(t.text for t in row).strip()
        num = next((re.sub(r"\D", "", t.text) for t in parts if re.fullmatch(r"\d{6,}", t.text.strip())), "")
        # Only the tail of the account number: enough to tell wallets apart.
        settlement = _field({"wallet": name.upper() or None, "account_tail": num[-4:] or None}, parts or None)

    currency = next((c for c in (ccy, gc, oc) if c), None)
    return {
        "broker": BROKER,
        "layout": "dime.order_detail",
        "display_timezone": DISPLAY_TZ,
        "currency": currency,
        "fields": {
            "side": side, "symbol": symbol, "exchange": exch,
            "order_amount": order_amount, "price": price, "quantity": quantity,
            "gross_value": gross, "commission": commission, "vat": vat,
            "sec_fee": sec_fee, "taf_fee": taf_fee,
            "order_type": order_type,
            "submitted_at": submitted, "executed_at": filled if filled["value"] else submitted,
            "order_ref": order_ref, "settlement": settlement,
        },
    }


def as_decimal(field: dict) -> Decimal | None:
    v = field.get("value")
    return Decimal(v) if isinstance(v, str) and v else None
