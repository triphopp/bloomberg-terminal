"""
Earnings-at-risk: what a curve shock does to interest expense and coverage.

The repricing share phi is unknowable from public filings, so nothing here
returns a point estimate for it. What it returns instead is the interval the
answer must lie in, which is a real result rather than a hedge: at phi=0 nothing
reprices and only the cash pile moves, at phi=1 the whole stack reprices within
the year. Both ends are computable from Total Debt, cash, interest expense and
EBIT alone — the inputs 41 of 43 probed S&P names had, against 24 with a usable
maturity ladder.

For many firms the whole interval is decisive. Coca-Cola at +200bp lands between
-0.4% and +4.8% of EBIT: rate-immune, provably, without knowing phi. Realty
Income spans 0% to 26%: the bound cannot settle it and the ladder has to.
"""
from __future__ import annotations

from analytics.ir_stress import curve as _curve
from analytics.ir_stress.exposure import CASH_PASSTHROUGH

# Two thresholds worth naming. 2.0x is the level most incurrence covenants sit
# at; 1.0x is where EBIT stops covering the interest bill at all. Neither is read
# from the issuer's actual credit agreement, which is not machine-readable.
ICR_COVENANT = 2.0
ICR_BREACH = 1.0


def _delta_interest(exposure: dict, shifts: dict[str, float], phi: float) -> dict:
    """Change in annual interest expense at a given repricing share."""
    debt = exposure["debt"]["total"] or 0.0
    cash = exposure["debt"]["cash"] or 0.0

    # Floating debt reprices off the short end; the 2Y is the closest tenor to
    # where corporate revolvers and term loans actually reset.
    short = shifts.get("2Y", shifts.get("1Y", 0.0))
    floating_leg = debt * phi * short

    # Maturing debt is refinanced at the shocked 5Y plus the same spread it
    # already pays. Only the *shock* enters here: the gap between the old coupon
    # and today's market rate exists at zero shock too and is reported separately
    # as refi_gap, so folding it in would double-count.
    wall = exposure.get("wall_12m") or 0.0
    usable = exposure.get("ladder_usable")
    five = shifts.get("5Y", 0.0)
    # Debt that both floats and matures inside the year must not be counted
    # twice; the floating leg already reprices it.
    refi_base = max(0.0, wall * (1 - phi)) if usable else 0.0
    refi_leg = refi_base * five

    # Cash earns more when rates rise, which is why a net-cash issuer shows a
    # negative delta at the low end of the bound.
    cash_leg = -cash * CASH_PASSTHROUGH * short

    return {
        "floating": floating_leg,
        "refi": refi_leg,
        "cash": cash_leg,
        "total": floating_leg + refi_leg + cash_leg,
    }


def earnings_at_risk(exposure: dict, scenario_id: str) -> dict:
    """Bounded interest-expense and coverage impact for one scenario."""
    shifts = _curve.scenario_shifts(scenario_id)

    lo = _delta_interest(exposure, shifts, 0.0)
    hi = _delta_interest(exposure, shifts, 1.0)

    interest = exposure["income"]["interest_expense"]
    ebit = exposure["income"]["ebit"]
    tax_rate = exposure["income"]["tax_rate"]
    icr0 = exposure["income"]["icr"]

    def _icr(delta: float) -> float | None:
        if not (ebit is not None and interest is not None):
            return None
        new_interest = interest + delta
        if new_interest <= 0:
            return None
        return ebit / new_interest

    after_tax = (1 - tax_rate) if tax_rate is not None else 1.0

    return {
        "scenario": _curve.describe(scenario_id),
        "delta_interest": {
            "lo": lo["total"],
            "hi": hi["total"],
            "lo_breakdown": lo,
            "hi_breakdown": hi,
            "note": "phi=0 (nothing reprices) to phi=1 (whole stack reprices this year)",
        },
        "vs_ebit": {
            "lo": (lo["total"] / ebit) if ebit else None,
            "hi": (hi["total"] / ebit) if ebit else None,
        },
        "after_tax": {
            "lo": lo["total"] * after_tax,
            "hi": hi["total"] * after_tax,
        },
        "icr": {
            "base": icr0,
            "lo": _icr(lo["total"]),
            "hi": _icr(hi["total"]),
            "covenant_level": ICR_COVENANT,
            "already_below_covenant": bool(icr0 is not None and icr0 < ICR_COVENANT),
        },
    }


def breaking_point(exposure: dict, target_icr: float = ICR_COVENANT) -> dict:
    """Parallel shock that drags coverage down to `target_icr`, worst case.

    Solved at phi=1, which makes the answer a *lower* bound on the real
    threshold: the firm breaks at this shock only if every dollar of debt
    reprices within the year. NextEra at -2bp is not a firm about to default; it
    is a firm whose coverage already sits on 2.0 with no headroom left in the
    worst case.
    """
    debt = exposure["debt"]["total"]
    cash = exposure["debt"]["cash"] or 0.0
    interest = exposure["income"]["interest_expense"]
    ebit = exposure["income"]["ebit"]

    if not (debt and interest and ebit is not None):
        return {"status": "insufficient_data", "bp": None}

    if ebit < 0:
        return {
            "status": "negative_ebit",
            "bp": 0.0,
            "note": "EBIT is negative; coverage is already breached at zero shock",
        }

    sensitivity = debt - CASH_PASSTHROUGH * cash
    if sensitivity <= 0:
        return {
            "status": "not_applicable",
            "bp": None,
            "note": "Interest income on cash outweighs the debt stack; rising rates "
                    "do not erode coverage through this channel",
        }

    x = (ebit / target_icr - interest) / sensitivity
    return {
        "status": "ok" if x > 0 else "already_breached",
        "bp": round(max(0.0, x) * 10000, 1),
        "target_icr": target_icr,
        "worst_case": True,
        "note": "solved at phi=1, so this is the lower bound of the true threshold",
    }
