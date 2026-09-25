"""Does a dividend entry make sense in its own units?

Two ways a dividend goes wrong without anyone noticing:

* **Currency scale.** Dime shows US dividends in baht. Typing that baht figure
  into a row labelled USD multiplies it by USD/THB a second time on every
  report — JEPQ $17.77/unit when the fund paid $0.44 (2026-09-25: seven rows,
  DIVIDENDS ฿155.6K instead of ฿48.7K, Dime XIRR +276%).
* **Total vs holding.** total_received should be about units held on the
  ex-date × per-unit (less withholding tax). A total 30× that, or for a stock
  not held, is a typo or the wrong row.

`check()` compares the entry with the market's own dividend for that ex-date
and with the position held then, and returns issues with a suggested fix. It
never writes. Market lookups are cached and may fail — then the scale check is
simply skipped (`market` = None), never guessed.
"""
from __future__ import annotations

import time
from typing import Callable, Optional

from portfolio_currency import fx_rate, normalize_currency, trade_currency

# Per-unit within ±35% of the market figure is "the same dividend": brokers
# report net of withholding (US 15%, TH 10%) and round.
_SAME = 0.35
# A per-unit off by roughly the exchange rate (±40%) is a currency slip.
_FX_BAND = (0.6, 1.4)
# total ÷ (held × per-unit): 0.5–1.1 covers withholding up to 30% and rounding.
_TOTAL_BAND = (0.5, 1.1)
_WINDOW_DAYS = 20

_cache: dict[str, tuple[float, list]] = {}
_TTL = 6 * 3600


def _market_dividends(yf_symbol: str) -> list:
    hit = _cache.get(yf_symbol)
    if hit and time.time() - hit[0] < _TTL:
        return hit[1]
    from sources import market_data

    try:
        recs = market_data.get_dividends(yf_symbol) or []
    except Exception:
        recs = []
    _cache[yf_symbol] = (time.time(), recs)
    return recs


def _days(a: str, b: str) -> int:
    from datetime import date

    return abs((date.fromisoformat(a[:10]) - date.fromisoformat(b[:10])).days)


def check(
    conn,
    *,
    account_id: str,
    asset: str,
    ex_date: Optional[str],
    pay_date: Optional[str],
    amount_per_unit: float,
    total_received: float,
    currency: Optional[str],
    market: Optional[Callable[[str], list]] = None,
    dividend_id: Optional[str] = None,
) -> dict:
    market = market or _market_dividends
    asset_u = (asset or "").strip().upper()
    acc = conn.execute(
        "SELECT currency FROM portfolio_accounts WHERE id = ?", (account_id,)
    ).fetchone()
    acc_ccy = (acc["currency"] if acc else None) or "THB"
    lots = [dict(r) for r in conn.execute(
        "SELECT * FROM trades WHERE account_id = ? AND upper(symbol) = ?",
        (account_id, asset_u),
    ).fetchall()]
    for lot in lots:
        lot["acc_currency"] = acc_ccy
    instrument_ccy = trade_currency(lots[0]) if lots else None
    entered_ccy = normalize_currency(currency) or instrument_ccy or acc_ccy
    when = (ex_date or pay_date or "")[:10]

    out: dict = {
        "asset": asset_u,
        "instrument_currency": instrument_ccy,
        "entered_currency": entered_ccy,
        "expected_per_unit": None,
        "expected_ex_date": None,
        "ratio": None,
        "held_units": None,
        "gross_expected": None,
        "issues": [],
    }
    issues = out["issues"]

    # ── 1. per-unit vs the market's dividend ────────────────────────────────
    if lots and when and amount_per_unit > 0:
        from routers.portfolio_v2 import _trade_yf_symbol

        yf_sym = _trade_yf_symbol(lots[0])
        recs = market(yf_sym) if yf_sym else []
        near = sorted(
            (r for r in recs if r.ex_date and _days(r.ex_date, when) <= _WINDOW_DAYS),
            key=lambda r: _days(r.ex_date, when),
        )
        if near:
            exp = float(near[0].amount)
            out["expected_per_unit"] = exp
            out["expected_ex_date"] = near[0].ex_date
            # Put the entry in the instrument's currency before comparing.
            conv = amount_per_unit
            if entered_ccy != instrument_ccy:
                conv = amount_per_unit * fx_rate(entered_ccy, instrument_ccy, when)
            ratio = conv / exp if exp > 0 else None
            out["ratio"] = round(ratio, 3) if ratio else None
            usd_thb = fx_rate("USD", "THB", when)
            if ratio is None or abs(ratio - 1) <= _SAME:
                pass
            elif instrument_ccy == "USD" and entered_ccy == "USD" and \
                    _FX_BAND[0] * usd_thb <= ratio <= _FX_BAND[1] * usd_thb:
                issues.append({
                    "level": "error",
                    "code": "looks_thb_as_usd",
                    "message": (
                        f"{amount_per_unit:g} USD/unit is {ratio:.0f}× {asset_u}'s ${exp:g} "
                        f"(ex {near[0].ex_date}) — about USD/THB ({usd_thb:.2f}). "
                        "This looks like the baht figure labelled USD."
                    ),
                    "fix": {
                        "currency": "USD",
                        "amount_per_unit": round(amount_per_unit / usd_thb, 6),
                        "total_received": round(total_received / usd_thb, 4),
                        "label": f"Convert to USD at {usd_thb:.4f}",
                    },
                    "alt_fix": {"currency": "THB", "label": "Keep the numbers, label THB"},
                })
            elif instrument_ccy == "THB" and entered_ccy == "THB" and \
                    _FX_BAND[0] / usd_thb <= ratio <= _FX_BAND[1] / usd_thb:
                issues.append({
                    "level": "error",
                    "code": "looks_usd_as_thb",
                    "message": (
                        f"{amount_per_unit:g} THB/unit is 1/{1 / ratio:.0f} of {asset_u}'s "
                        f"฿{exp:g} — looks like a USD figure labelled THB."
                    ),
                    "fix": {
                        "currency": "THB",
                        "amount_per_unit": round(amount_per_unit * usd_thb, 6),
                        "total_received": round(total_received * usd_thb, 2),
                        "label": f"Convert to THB at {usd_thb:.4f}",
                    },
                })
            else:
                issues.append({
                    "level": "warn",
                    "code": "per_unit_mismatch",
                    "message": (
                        f"{asset_u} paid {exp:g} {instrument_ccy}/unit (ex {near[0].ex_date}); "
                        f"this entry is {ratio:.2f}× that. Special dividend or split? Check the statement."
                    ),
                })
        elif recs:
            issues.append({
                "level": "warn",
                "code": "no_market_dividend",
                "message": f"No {asset_u} dividend within {_WINDOW_DAYS} days of {when} in market data.",
            })

    # ── 2. total vs units held on the ex-date ────────────────────────────────
    if lots and when:
        held = 0.0
        for lot in lots:
            de = str(lot.get("date_entry") or "")[:10]
            dx = str(lot.get("date_exit") or "")[:10]
            # Entitled if bought before the ex-date and not sold before it.
            if de and de < when and (not dx or dx >= when):
                held += float(lot.get("volume") or 0)
        out["held_units"] = round(held, 6)
        if held <= 0:
            issues.append({
                "level": "warn",
                "code": "not_held",
                "message": f"No {asset_u} lot was held on {when} — wrong date, or the buy is missing.",
            })
        elif amount_per_unit > 0 and total_received > 0:
            gross = held * amount_per_unit
            out["gross_expected"] = round(gross, 4)
            r = total_received / gross
            # One dividend row may represent one subaccount. Before saying the
            # other lots are unpaid, include other recorded rows for the same
            # entitlement. Exclude this row when auditing/editing a saved one.
            sibling_total = 0.0
            sibling_count = 0
            for sibling in conn.execute(
                """SELECT id, amount_per_unit, total_received, currency FROM dividends
                   WHERE account_id = ? AND upper(asset) = ?
                     AND substr(coalesce(ex_date, pay_date), 1, 10) = ?""",
                (account_id, asset_u, when),
            ):
                if sibling["id"] == dividend_id:
                    continue
                if normalize_currency(sibling["currency"]) != entered_ccy:
                    continue
                sibling_per_unit = float(sibling["amount_per_unit"] or 0)
                if abs(sibling_per_unit - amount_per_unit) > max(abs(amount_per_unit) * 0.02, 1e-6):
                    continue
                sibling_total += float(sibling["total_received"] or 0)
                sibling_count += 1
            entitlement_covered = (
                sibling_count > 0
                and _TOTAL_BAND[0] <= (total_received + sibling_total) / gross <= _TOTAL_BAND[1]
            )
            # Units this total actually pays for, gross or after 10%/15% tax.
            implied = [total_received / amount_per_unit / k for k in (1.0, 0.9, 0.85)]
            held_lots = [
                lot for lot in lots
                if str(lot.get("date_entry") or "")[:10] < when
                and (not lot.get("date_exit") or str(lot["date_exit"])[:10] >= when)
            ]
            one_lot = next(
                (lot for lot in held_lots if len(held_lots) > 1 and any(
                    abs(u - float(lot.get("volume") or 0)) <= 0.02 * float(lot.get("volume") or 1)
                    for u in implied)),
                None,
            )
            if entitlement_covered:
                pass
            elif one_lot is not None and not (_TOTAL_BAND[0] <= r <= _TOTAL_BAND[1]):
                sub = (one_lot.get("note") or "").splitlines()[0].strip() or one_lot["id"][:8]
                rest = held - float(one_lot.get("volume") or 0)
                issues.append({
                    "level": "warn",
                    "code": "matches_one_lot",
                    "message": (
                        f"Total pays for exactly one lot — {float(one_lot['volume']):g} units ({sub}). "
                        f"The other {rest:g} units held on {when} have no dividend recorded; "
                        f"≈{rest * amount_per_unit:,.2f} gross may be missing."
                    ),
                })
            elif not (_TOTAL_BAND[0] <= r <= _TOTAL_BAND[1]):
                issues.append({
                    "level": "warn",
                    "code": "total_vs_holding",
                    "message": (
                        f"Held {held:g} units × {amount_per_unit:g} = {gross:,.2f} gross; "
                        f"total entered {total_received:,.2f} is {r:.2f}× that."
                    ),
                })
    elif not lots:
        issues.append({
            "level": "info",
            "code": "no_trades",
            "message": f"No {asset_u} trades in this account — cannot check units or currency.",
        })
    return out


def blocking(result: dict) -> list[dict]:
    """Issues that stop a save unless the caller passes force."""
    return [i for i in result.get("issues", []) if i.get("level") == "error"]
