"""Broker fee schedules: commission, VAT and US regulatory fees per trade.

Dime US stocks, fitted to Dime order confirmations (2026-09):

    SNDK sell 4.4628776 @ 1,754.96 = 7,832.17 → commission 11.74, VAT 0.82,
                                                 SEC 0.17, TAF 0.01
    MU   sell 1.1351884 @ 1,048.42 = 1,190.16 → commission 1.79, VAT 0.12,
                                                 SEC 0.03, TAF 0.01
    buys: order amount − qty × price = 0.1605 % (0.15 % + 7 % VAT)

Commission is 0.15 % of the trade value and VAT is 7 % of the commission, on
both sides. A sale adds the SEC fee (fitted rate, rounded up to the cent) and
FINRA TAF ($0.000166 a share, $0.01 minimum, $8.30 cap). Dime's cost basis is
qty × price — fees are not in it — so callers keep them in separate fields.

The estimate can be a cent off the confirmation (Dime's own rounding is not
consistent); the confirmation always wins when the user types it in.
"""
from __future__ import annotations

from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal
from typing import Optional

CENT = Decimal("0.01")

PROFILES: dict[str, dict] = {
    "DIME_US": {
        "label": "Dime US stocks: 0.15% + VAT 7%; sells add SEC + TAF",
        "currency": "USD",
        "commission_rate": Decimal("0.0015"),
        "vat_rate": Decimal("0.07"),
        "sec_rate": Decimal("0.0000211"),
        "taf_per_share": Decimal("0.000166"),
        "taf_min": Decimal("0.01"),
        "taf_max": Decimal("8.30"),
    },
}


def profile_for(conn, account_id: str, currency: Optional[str]) -> Optional[str]:
    """Fee profile of an account for an instrument currency, or None."""
    row = conn.execute(
        "SELECT id, name, currency FROM portfolio_accounts WHERE id = ?", (account_id,)
    ).fetchone()
    if row is None:
        return None
    ident = f"{row['id']} {row['name'] or ''}".lower()
    if "dime" in ident and (currency or "").upper() == "USD":
        return "DIME_US"
    return None


def _money(value: Decimal, rounding=ROUND_HALF_UP) -> Decimal:
    return value.quantize(CENT, rounding=rounding)


def estimate(profile: str, side: str, qty: float, price: float) -> dict:
    """Fees for one order, in the instrument currency."""
    p = PROFILES[profile]
    side = side.upper()
    if side not in ("BUY", "SELL"):
        raise ValueError("side must be BUY or SELL")
    q, px = Decimal(str(qty)), Decimal(str(price))
    if q <= 0 or px <= 0:
        raise ValueError("quantity and price must be positive")
    value = q * px
    raw_commission = value * p["commission_rate"]
    commission = _money(raw_commission)
    # VAT is on the unrounded commission: MU 1.78525 × 7 % = 0.12, not 0.13.
    vat = _money(raw_commission * p["vat_rate"])
    sec = taf = Decimal(0)
    if side == "SELL":
        sec = _money(value * p["sec_rate"], ROUND_CEILING)
        taf = min(max(_money(q * p["taf_per_share"], ROUND_CEILING), p["taf_min"]), p["taf_max"])
    total = commission + vat + sec + taf
    return {
        "profile": profile, "basis": p["label"], "currency": p["currency"], "side": side,
        "value": float(_money(value)), "commission": float(commission), "vat": float(vat),
        "sec_fee": float(sec), "taf_fee": float(taf), "total": float(total), "source": "auto",
    }
