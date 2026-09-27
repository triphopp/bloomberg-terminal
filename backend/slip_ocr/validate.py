"""Cross-checks that tie a slip's numbers together.

A misread digit almost never survives all of these, so they are what makes the
auto-fill trustworthy rather than the OCR confidence alone:

    value      qty × shown price = value, within the price's display rounding
               → the exact fill price is value / qty (Dime rounds the shown price)
    total      BUY: value + commission + VAT (+ SEC + TAF) = order amount
    schedule   commission/VAT vs a broker fee schedule, when the caller passes one
    ref_date   Dime's order number embeds YYYYMMDD of the order day
    sequence   filled at or after submitted

Each check: {"id", "level": ok|warn|error, "message"}. `derived` is written
back onto the slip: exact price, fee total, NY trade date, UTC timestamp.
"""
from __future__ import annotations

from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
import re
from typing import Callable, Optional
from zoneinfo import ZoneInfo

CENT = Decimal("0.01")
_NY = ZoneInfo("America/New_York")

# The engine knows no fee rates. A caller that does passes
#   fee_schedule(broker, currency, side, qty, price) -> {"commission", "vat", "total", "label"?} | None
# (numbers in the instrument currency); None = no schedule for that slip.
FeeSchedule = Callable[[str, str, str, float, float], Optional[dict]]


def _d(slip: dict, key: str) -> Decimal | None:
    v = slip["fields"].get(key, {}).get("value")
    try:
        return Decimal(v) if isinstance(v, str) and v else None
    except Exception:
        return None


def _check(out: list, cid: str, level: str, message: str) -> None:
    out.append({"id": cid, "level": level, "message": message})


def validate(slip: dict, fee_schedule: FeeSchedule | None = None) -> list[dict]:
    checks: list[dict] = []
    f = slip["fields"]
    side = f["side"]["value"]
    qty, px = _d(slip, "quantity"), _d(slip, "price")
    gross, order = _d(slip, "gross_value"), _d(slip, "order_amount")
    comm, vat = _d(slip, "commission"), _d(slip, "vat")
    sec, taf = _d(slip, "sec_fee") or Decimal(0), _d(slip, "taf_fee") or Decimal(0)
    derived: dict = {}

    # Recover one missing leg of the BUY total from the others.
    if side == "BUY" and gross is None and None not in (order, comm, vat):
        gross = order - comm - vat - sec - taf
        f["gross_value"] = {"value": str(gross), "confidence": 0.5, "raw": None, "derived": True}
        _check(checks, "value_derived", "warn", f"Value not read — derived from order amount: {gross}")

    # 1. value identity → exact price
    if qty and px and gross:
        diff = abs(qty * px - gross)
        tol = qty * CENT + CENT
        if diff <= tol:
            exact = gross / qty
            derived["exact_price"] = str(exact.quantize(Decimal("0.0001"), ROUND_HALF_UP))
            note = "" if diff <= CENT else f" (shown price is rounded; exact {derived['exact_price']})"
            _check(checks, "value", "ok", f"{qty} × {px} ≈ {gross}{note}")
        else:
            _check(checks, "value", "error",
                   f"{qty} × {px} = {(qty * px).quantize(CENT)} but value reads {gross} — a digit is misread")
    elif qty and px:
        derived["exact_price"] = str(px)
        _check(checks, "value", "warn", "Value not on slip — using the shown price")
    else:
        _check(checks, "value", "error", "Quantity or price not read")

    # 2. order total
    fees = [x for x in (comm, vat) if x is not None]
    fee_total = sum(fees, Decimal(0)) + sec + taf if fees or sec or taf else None
    if fee_total is not None:
        derived["fee_total"] = str(fee_total)
        derived["fee_breakdown"] = {
            k: str(v) for k, v in (("commission", comm), ("vat", vat), ("sec_fee", sec), ("taf_fee", taf))
            if v is not None and (k in ("commission", "vat") or v)
        }
    if side == "BUY" and order is not None and gross is not None and fee_total is not None:
        total = gross + fee_total
        if abs(total - order) <= CENT:
            _check(checks, "total", "ok", f"{gross} + fees {fee_total} = {order}")
        else:
            _check(checks, "total", "error", f"{gross} + fees {fee_total} = {total}, order amount reads {order}")
    elif side == "BUY":
        _check(checks, "total", "warn", "Order amount / fees incomplete — total not checked")

    # 3. fee schedule
    if fee_schedule and qty and derived.get("exact_price"):
        try:
            est = fee_schedule(slip.get("broker") or "", slip.get("currency") or "", side,
                               float(qty), float(derived["exact_price"]))
            label = (est or {}).get("label") or f"{(slip.get('broker') or '').title()} schedule"
            gaps = []
            for key, got in (("commission", comm), ("vat", vat)):
                if est is not None and got is not None:
                    gaps.append(abs(Decimal(str(est[key])) - got))
            if gaps and max(gaps) <= CENT:
                _check(checks, "schedule", "ok", f"Fees match the {label} (est. {est['total']:.2f}, ±1¢)")
            elif gaps:
                _check(checks, "schedule", "warn",
                       f"Fees differ from the {label} (est. {est['total']:.2f}) — slip value kept")
        except Exception:  # schedule is advisory; never block a slip on it
            pass

    # 4/5. dates
    executed = f["executed_at"]["value"]
    if executed:
        local = datetime.fromisoformat(executed).replace(tzinfo=ZoneInfo(slip["display_timezone"]))
        derived["executed_at_utc"] = local.astimezone(ZoneInfo("UTC")).isoformat(timespec="minutes")
        derived["trade_date"] = local.astimezone(_NY).date().isoformat()
        ref = f["order_ref"]["value"] or ""
        m = re.search(r"(20\d{2})(\d{2})(\d{2})", ref)
        if m:
            if f"{m.group(1)}-{m.group(2)}-{m.group(3)}" == executed[:10]:
                _check(checks, "ref_date", "ok", "Order number date matches the fill date")
            else:
                _check(checks, "ref_date", "warn",
                       f"Order number says {m.group(1)}-{m.group(2)}-{m.group(3)}, fill date reads {executed[:10]}")
        submitted = f["submitted_at"]["value"]
        if submitted and submitted > executed:
            _check(checks, "sequence", "warn", "Filled before it was submitted — a date is misread")
    else:
        _check(checks, "executed_at", "error", "Fill date not read")

    slip["derived"] = derived
    return checks
