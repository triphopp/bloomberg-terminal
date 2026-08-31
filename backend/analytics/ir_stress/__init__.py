"""
Corporate interest-rate stress framework.

Three channels, deliberately kept apart because they answer different questions
and disagree by an order of magnitude. American Tower loses about 7.8% of its
price per 100bp while the worst case for its net interest bill is 0.42% of market
cap — an 18x gap. Collapsing them into one score would hide exactly the thing
that matters.

    earnings  ->  ear.py         bounded interest expense, coverage, breaking point
    value     ->  valuation.py   Gordon inverted, exact revaluation, pass-through
    price     ->  empirical.py   measured rate beta, and where it stops working

Plans: memory/plans/corporate-ir-stress-testing.md (model),
       memory/plans/cirst-validation-harness.md (how it gets validated).
"""
from __future__ import annotations

from analytics.ir_stress import curve, ear, empirical, exposure, valuation

DEFAULT_SCENARIOS = [
    "par_+10",
    "par_+15",
    "par_+20",
    "par_+25",
    "par_+50",
    "par_-25",
    "par_+100",
    "par_+200",
    "par_+300",
    "par_-100",
    "bear_steep",
    "bull_flat",
    "hist_2022",
    "hist_1994",
]


def run_stress(symbol: str, scenario_ids: list[str] | None = None) -> dict:
    """Full single-name assessment across every channel that has the data."""
    sym = symbol.upper()
    scenario_ids = scenario_ids or DEFAULT_SCENARIOS

    exp = exposure.get_exposure(sym)

    beta = empirical.rate_beta_bounded(sym)

    info: dict = {}
    try:
        from routers import market as _market

        info = _market.market_data.get_ticker(sym).info or {}
    except Exception:  # noqa: BLE001
        pass
    sector = info.get("sector")

    profile = valuation.valuation_profile(
        sym,
        beta.get("market_beta") if beta.get("status") == "ok" else None,
        sector,
        info=info,
    )
    theta_fit = empirical.implied_theta(beta, profile.get("spread"))
    if theta_fit["status"] == "ok":
        profile["theta"] = theta_fit["theta"]
        profile["theta_source"] = "implied from this name's measured beta"
    profile["theta_fit"] = theta_fit

    rows = []
    for sid in scenario_ids:
        desc = curve.describe(sid)
        e = ear.earnings_at_risk(exp, sid)
        d_rf = curve.scenario_shifts(sid).get("10Y", 0.0)
        rows.append({
            **e,
            "price": {
                "model": valuation.price_impact(profile, d_rf),
                "empirical": empirical.empirical_impact(beta, desc["headline_bp"]),
            },
        })

    mcap = profile.get("market_cap")
    worst = max((r["after_tax"]["hi"] for r in rows if r["after_tax"]["hi"]), default=None)

    return {
        "symbol": sym,
        "sector": sector,
        "exposure": exp,
        "valuation": profile,
        "rate_beta": beta,
        "scenarios": rows,
        "breaking_point": {
            "covenant_2x": ear.breaking_point(exp, ear.ICR_COVENANT),
            "breach_1x": ear.breaking_point(exp, ear.ICR_BREACH),
        },
        # The headline comparison: cash damage against price damage, in the same
        # unit, so nobody reads one as the other.
        "channel_gap": {
            "worst_after_tax_interest_over_mcap": (worst / mcap) if (worst and mcap) else None,
            "price_impact_100bp": (
                beta["kappa_10y_pct_per_100bp"] / 100
                if beta.get("status") == "ok" and beta.get("significant")
                else None
            ),
        },
    }
