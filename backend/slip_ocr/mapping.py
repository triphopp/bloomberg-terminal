"""Slip → PORT ENTRY form fields (strings, the shape of BLANK_FORM).

    date_*   the New York trade date — a Dime fill at 01:30 Bangkok is the
             previous US session, and every other US row is dated that way
    price_*  the price on screen when qty × it reproduces the broker's value
             to the cent; otherwise the fewest-decimals price that does, nearest
             value / qty (validate._fill_price)
    fee_*    commission + VAT (+ SEC + TAF); typed fees win over the estimate
"""
from __future__ import annotations


def to_form(slip: dict, checks: list[dict]) -> tuple[dict | None, list[str]]:
    f, d = slip["fields"], slip.get("derived", {})
    warnings: list[str] = []
    side = f["side"]["value"]
    if side is None:
        return None, ["Buy/sell not read"]

    ref = f["order_ref"]["value"]
    form: dict = {
        "side": side.lower(),
        "account_hint": None,   # the host maps `broker` to one of its own accounts
        "symbol": f["symbol"]["value"] or "",
        "volume": f["quantity"]["value"] or "",
        "note": f"{slip['broker'].title()} order {ref}" if ref else "",
        "broker_order_ref": ref,
        "executed_at": f["executed_at"]["value"],
        "fee_breakdown": d.get("fee_breakdown"),
        # The wallet the slip paid from / into ("DIME! FCD"); the host maps it
        # to one of its ledger wallets by the wallet's broker_label.
        "settlement_wallet": ((f.get("settlement") or {}).get("value") or {}).get("wallet"),
    }
    price, fee, day = d.get("exact_price") or "", d.get("fee_total") or "", d.get("trade_date") or ""
    if side == "BUY":
        form.update(date_entry=day, price_entry=price, fee_entry=fee)
    else:
        form.update(date_exit=day, price_exit=price, fee_exit=fee)
        warnings.append("SELL slip: exit filled — pick the lot being closed (entry date/price)")

    if f["executed_at"]["value"] and day and f["executed_at"]["value"][:10] != day:
        warnings.append(f"Filled {f['executed_at']['value']} Bangkok = US session {day}")
    for c in checks:
        if c["level"] == "error":
            warnings.append(c["message"])
    return form, warnings
