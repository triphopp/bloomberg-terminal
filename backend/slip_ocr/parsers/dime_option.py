"""Dime! "รายละเอียดคำสั่ง" (order detail) screen, US options.

Layout, top to bottom (a long slip is often sent as two screenshots; the host
stacks their tokens, so any subset of these rows may be present):
    ซื้อ | ขาย                        [ออปชันสหรัฐฯ]
    INTC Put 40.00 USD                              underlying, type, strike
    วันหมดอายุ: 1 พฤษภาคม 2569                        expiry, Buddhist Era
    10 สัญญา / = 1,000 หุ้น                          contracts, shares → multiplier
    ราคาที่คุณตั้ง   ราคาที่ได้จริง/หุ้น                 limit, fill premium (stacked)
    ยอดที่ต้องชำระ | ยอดที่จะได้รับคืนโดยประมาณ          BUY payable | SELL receivable
    มูลค่าสัญญาที่ซื้อ | มูลค่าสัญญาทั้งหมด   290.00 USD  contracts × multiplier × premium
    ค่าคอมมิชชัน                          5.50 USD    (sale shows it negative)
    คูปองส่วนลด / เทรดออปชัน ฟรีจุก ๆ      -5.50 USD   a promo cancelling the commission
    ภาษีมูลค่าเพิ่ม 7% (VAT)               0.00 USD
    ค่าธรรมเนียม…ออปชัน (OCC) / (ORF) / การขาย (TAF Fee)   estimated, debited later
    วันที่ส่งคำสั่ง · วันรับเงินค่าขายคืน · วันที่คำสั่งสำเร็จ   Thai local time
    เลขที่คำสั่ง  OPTBLO…  (OCR reads the O after OPTBL/OPTSL as 0)

Signs on screen follow the cash direction of the order, so every fee is read
as a magnitude and the discount is always stored negative.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
import re
from zoneinfo import ZoneInfo

from ..layout import Token, below, find_label, is_money, next_row, norm, parse_money, parse_number, same_row
from ..thai_date import parse_thai_datetime
from .dime import BROKER, DISPLAY_TZ, _field, _stamp as _stamp_row

KIND = "option"
REQUIRED = ("side", "underlying", "option_type", "strike", "expiry", "contracts", "price", "executed_at")

_CONTRACT = re.compile(r"\b([A-Z][A-Z0-9.]{0,9})\s+(CALL|PUT)\s+([\d,]+(?:\.\d+)?)", re.I)
_ORDER_REF = re.compile(r"OPT[A-Z]{2,4}\d{8,}")
_NY = ZoneInfo("America/New_York")
CENT = Decimal("0.01")


def claims(tokens: list[Token]) -> bool:
    text = " ".join(norm(t.text) for t in tokens)
    hits = sum(k in text for k in (norm("สัญญา"), norm("วันหมดอายุ"), norm("ออปชัน"), "(occ)", "(orf)",
                                   norm("มูลค่าสัญญา")))
    return hits >= 2 or bool(re.search(r"OPT[BS]L", " ".join(t.text for t in tokens)))


def _money_right(tokens, *labels, exclude=()) -> dict:
    lab = find_label(tokens, *labels, exclude=exclude)
    if lab is None:
        return _field(None, None)
    for t in same_row(tokens, lab):
        amt, _ = parse_money(t.text)
        if amt is not None:
            return _field(str(abs(amt)), t, min(t.conf, max(lab.conf, 0.5)))
    return _field(None, None)


def _money_below(tokens, *labels) -> dict:
    lab = find_label(tokens, *labels)
    if lab is None:
        return _field(None, None)
    for t in below(tokens, lab):
        if is_money(t.text):
            amt, _ = parse_money(t.text)
            return _field(str(abs(amt)), t)
    return _field(None, None)


def _discount(tokens) -> dict:
    """The money on the promo line under คูปองส่วนลด (its own label is fuzzy: ช/ซ swaps)."""
    lab = find_label(tokens, "คูปองส่วนลด")
    rows = [t for t in tokens if is_money(t.text)
            and (lab is None or 0 < t.y0 - lab.y1 < lab.h * 3)]
    promo = find_label(tokens, "เทรดออปชัน", "ฟรีจุก")
    if promo is not None:
        rows = [t for t in same_row(tokens, promo) if is_money(t.text)] or rows
    elif lab is None:
        return _field(None, None)
    for t in rows:
        amt, _ = parse_money(t.text)
        if amt is not None:
            return _field(str(-abs(amt)), t)
    return _field(None, None)


def _stamp(tokens, *labels) -> dict:
    """Date on the label's row, or on the row under it (a "Dime! Fast" chip pushes it down)."""
    f = _stamp_row(tokens, *labels)
    if f["value"]:
        return f
    lab = find_label(tokens, *labels)
    if lab is None:
        return f
    row = same_row(tokens, lab)
    under = next_row(tokens, lab, row) if row else [
        t for t in tokens if 0 < t.y0 - lab.y1 < lab.h * 1.5 and t.x0 > lab.x1]
    dt = parse_thai_datetime(" ".join(t.text for t in under))
    return _field(dt.isoformat(timespec="minutes") if dt else None, under or None)


def _header(tokens) -> tuple[dict, dict, dict, dict]:
    side = under = otype = strike = _field(None, None)
    for t in sorted(tokens, key=lambda t: t.y0):
        n = norm(t.text)
        if side["value"] is None and len(n) <= 6 and (n.startswith(norm("ซื้อ")) or n.startswith(norm("ขาย"))):
            side = _field("BUY" if n.startswith(norm("ซื้อ")) else "SELL", t)
        m = _CONTRACT.search(t.text)
        if m and under["value"] is None:
            under = _field(m.group(1).upper(), t)
            otype = _field(m.group(2).lower(), t)
            strike = _field(str(Decimal(m.group(3).replace(",", ""))), t)
    return side, under, otype, strike


def parse(tokens: list[Token]) -> dict:
    side, underlying, option_type, strike = _header(tokens)

    expiry = _field(None, None)
    exp_lab = find_label(tokens, "วันหมดอายุ", exclude=("ณ",))
    if exp_lab is not None:
        dt = parse_thai_datetime(exp_lab.text) or parse_thai_datetime(
            " ".join(t.text for t in same_row(tokens, exp_lab)))
        expiry = _field(dt.date().isoformat() if dt else None, exp_lab)

    contracts = shares = _field(None, None)
    for t in tokens:
        n = norm(t.text)
        if contracts["value"] is None and norm("สัญญา") in n and norm("มูลค่า") not in n:
            q = parse_number(t.text)
            if q is not None and q > 0:
                contracts = _field(str(q), t)
        if shares["value"] is None and t.text.strip().startswith("=") and norm("หุ้น")[:2] in n:
            q = parse_number(t.text)
            if q is not None and q > 0:
                shares = _field(str(q), t)

    price = _money_below(tokens, "ราคาที่ได้จริง")
    limit_price = _money_below(tokens, "ราคาที่คุณตั้ง")
    payable = _money_below(tokens, "ยอดที่ต้องชำระ")
    receivable = _money_below(tokens, "ยอดที่จะได้รับคืน")
    gross = _money_right(tokens, "มูลค่าสัญญาที่ซื้อ", "มูลค่าสัญญาทั้งหมด", "มูลค่าสัญญา")
    commission = _money_right(tokens, "ค่าคอมมิชชัน", exclude=("หลัง", "และ", "ไม่มี"))
    discount = _discount(tokens)
    vat = _money_right(tokens, "ภาษีมูลค่าเพิ่ม", "vat", exclude=("หลัง",))
    occ = _money_right(tokens, "(occ)", "occ")
    orf = _money_right(tokens, "(orf)", "orf")
    taf = _money_right(tokens, "taf fee", "taf", "ค่าธรรมเนียมการขาย")

    submitted = _stamp(tokens, "วันที่ส่งคำสั่ง")
    filled = _stamp(tokens, "วันที่คำสั่งสำเร็จ")
    settle = _field(None, None)
    st_lab = find_label(tokens, "วันรับเงินค่าขายคืน", "วันรับเงิน")
    if st_lab is not None:
        row = same_row(tokens, st_lab)
        dt = parse_thai_datetime(" ".join(t.text for t in row))
        settle = _field(dt.date().isoformat() if dt else None, row or None)

    order_ref = _field(None, None)
    ref_lab = find_label(tokens, "เลขที่คำสั่ง", exclude=("บัญชี",))
    if ref_lab is not None:
        row = same_row(tokens, ref_lab)
        joined = "".join(re.sub(r"\s", "", t.text) for t in row).upper()
        joined = re.sub(r"^OPT([BS])L0", r"OPT\1LO", joined)
        if _ORDER_REF.search(joined):
            order_ref = _field(joined, row)

    order_type = _field(None, None)
    ot_lab = find_label(tokens, "ประเภทคำสั่ง")
    if ot_lab is not None:
        row = same_row(tokens, ot_lab)
        txt = norm(" ".join(t.text for t in row))
        kind = "LIMIT" if norm("ตั้งราคาเอง") in txt or "limit" in txt else \
               "MARKET" if norm("ราคาตลาด") in txt or "market" in txt else None
        order_type = _field(kind, row or None)

    return {
        "broker": BROKER,
        "kind": KIND,
        "layout": "dime.option_order_detail",
        "display_timezone": DISPLAY_TZ,
        "currency": "USD",
        "required": list(REQUIRED),
        "fields": {
            "side": side, "underlying": underlying, "option_type": option_type, "strike": strike,
            "expiry": expiry, "contracts": contracts, "shares": shares,
            "price": price, "limit_price": limit_price,
            "payable": payable, "receivable": receivable, "gross_value": gross,
            "commission": commission, "commission_discount": discount, "vat": vat,
            "occ_fee": occ, "orf_fee": orf, "taf_fee": taf,
            "order_type": order_type,
            "submitted_at": submitted, "executed_at": filled if filled["value"] else _field(None, None),
            "settle_date": settle, "order_ref": order_ref,
        },
    }


# ── validation and form, option-shaped ──────────────────────────────────────

def _d(slip, key):
    v = slip["fields"].get(key, {}).get("value")
    try:
        return Decimal(v) if isinstance(v, str) and v else None
    except Exception:
        return None


def validate(slip: dict, fee_schedule=None) -> list[dict]:
    checks: list[dict] = []
    add = lambda cid, level, msg: checks.append({"id": cid, "level": level, "message": msg})
    f = slip["fields"]
    side = f["side"]["value"]
    n, shares, px = _d(slip, "contracts"), _d(slip, "shares"), _d(slip, "price")
    gross = _d(slip, "gross_value")
    derived: dict = {}

    mult = Decimal(100)
    if n and shares:
        mult = shares / n
        if mult != 100:
            add("multiplier", "warn", f"{shares} shares / {n} contracts = multiplier {mult}")
    m_s = format(mult.normalize(), "f")
    derived["multiplier"] = m_s

    if n and px is not None and gross is not None:
        if abs(n * mult * px - gross) <= CENT:
            add("value", "ok", f"{n} × {m_s} × {px} = {gross}")
        else:
            add("value", "error", f"{n} × {m_s} × {px} = {(n * mult * px).quantize(CENT)} "
                                  f"but value reads {gross} — a digit is misread")
    elif n and px is not None:
        add("value", "warn", "Contract value not on the slip — not cross-checked")
    else:
        add("value", "error", "Contracts or premium not read")

    comm, disc = _d(slip, "commission"), _d(slip, "commission_discount")
    if disc is not None and comm is None:
        # The promo line cancels a commission of the same size; a bottom-only
        # screenshot shows the promo but cuts the commission above it.
        f["commission"] = {"value": str(-disc), "confidence": 0.5, "raw": None, "derived": True}
        add("commission_derived", "warn", f"Commission not read — taken as the promo amount {-disc}")
    items = []
    for comp, key in (("COMMISSION", "commission"), ("COMMISSION_DISCOUNT", "commission_discount"),
                      ("VAT", "vat"), ("OCC", "occ_fee"), ("ORF", "orf_fee"), ("TAF", "taf_fee")):
        v = _d(slip, key)
        if v is not None and (v != 0 or comp in ("COMMISSION", "VAT")):
            items.append({"component": comp, "amount": str(v)})
    fee_total = sum((Decimal(i["amount"]) for i in items), Decimal(0))
    derived["fee_items"] = items
    derived["fee_total"] = str(fee_total)

    amount = _d(slip, "payable" if side == "BUY" else "receivable")
    if gross is not None and amount is not None and items:
        expect = gross + fee_total if side == "BUY" else gross - fee_total
        if abs(expect - amount) <= CENT:
            add("total", "ok", f"{gross} {'+' if side == 'BUY' else '−'} fees {fee_total} = {amount}")
        else:
            add("total", "error", f"{gross} {'+' if side == 'BUY' else '−'} fees {fee_total} = {expect}, "
                                  f"slip total reads {amount}")
    else:
        add("total", "warn", "Order total / fees incomplete — total not checked")

    executed = f["executed_at"]["value"]
    if executed:
        local = datetime.fromisoformat(executed).replace(tzinfo=ZoneInfo(slip["display_timezone"]))
        derived["executed_at_utc"] = local.astimezone(ZoneInfo("UTC")).isoformat(timespec="minutes")
        derived["executed_at"] = local.isoformat(timespec="seconds")
        day = local.astimezone(_NY).date().isoformat()
        derived["trade_date"] = day
        m = re.search(r"(20\d{2})(\d{2})(\d{2})", f["order_ref"]["value"] or "")
        if m:
            ref_day = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
            add("ref_date", "ok" if ref_day == executed[:10] else "warn",
                "Order number date matches the fill date" if ref_day == executed[:10]
                else f"Order number says {ref_day}, fill date reads {executed[:10]}")
        submitted = f["submitted_at"]["value"]
        if submitted and submitted > executed:
            add("sequence", "warn", "Filled before it was submitted — a date is misread")
        exp = f["expiry"]["value"]
        if exp and exp < day:
            add("expiry", "error", f"Filled {day}, after the contract expired {exp}")
    else:
        add("executed_at", "error", "Fill time not read — add the screenshot with วันที่คำสั่งสำเร็จ")
    slip["derived"] = derived
    return checks


def to_form(slip: dict, checks: list[dict]) -> tuple[dict | None, list[str]]:
    f, d = slip["fields"], slip.get("derived", {})
    side = f["side"]["value"]
    warnings = [c["message"] for c in checks if c["level"] == "error"]
    if side is None:
        warnings.insert(0, "Buy/sell not read — add the top screenshot of the order")
    submitted = f["submitted_at"]["value"]
    form = {
        "instrument": "option",
        "side": side.lower() if side else "",
        "underlying": f["underlying"]["value"] or "",
        "option_type": f["option_type"]["value"] or "",
        "strike": f["strike"]["value"] or "",
        "expiry": f["expiry"]["value"] or "",
        "contracts": f["contracts"]["value"] or "",
        "multiplier": d.get("multiplier") or "100",
        "price": f["price"]["value"] or "",
        "limit_price": f["limit_price"]["value"],
        "trade_date": d.get("trade_date") or "",
        "executed_at": d.get("executed_at"),
        "submitted_at": (datetime.fromisoformat(submitted).replace(tzinfo=ZoneInfo(slip["display_timezone"]))
                         .isoformat(timespec="seconds") if submitted else None),
        "settle_date": f["settle_date"]["value"],
        "broker_order_ref": f["order_ref"]["value"],
        "order_type": f["order_type"]["value"],
        "fee_items": d.get("fee_items") or [],
        "fee_total": d.get("fee_total") or "0",
        "note": f"Dime order {f['order_ref']['value']}" if f["order_ref"]["value"] else "",
        "account_hint": None,
    }
    if d.get("executed_at") and d.get("trade_date") and d["executed_at"][:10] != d["trade_date"]:
        warnings.append(f"Filled {d['executed_at']} Bangkok = US session {d['trade_date']}")
    return form, warnings
