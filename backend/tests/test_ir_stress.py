"""
Unit tests for analytics/ir_stress.

These are the golden cases from memory/plans/corporate-ir-stress-testing.md §15 —
the edge shapes the model has to survive before any of it reaches a screen: a
firm with no debt, a firm holding more cash than debt, a growth rate that walks
into the discount rate, a scenario applied at zero.

Every test builds its own exposure dict rather than hitting yfinance or EDGAR, so
the suite stays offline and deterministic.

Run:
    cd backend
    python -m pytest tests/test_ir_stress.py -v
"""

import sys

import pytest

sys.path.insert(0, ".")

from analytics.ir_stress import curve, ear, valuation
from analytics.ir_stress.exposure import CASH_PASSTHROUGH


def make_exposure(
    *,
    debt=1_000_000_000.0,
    cash=0.0,
    interest=40_000_000.0,
    ebit=200_000_000.0,
    wall=None,
    ladder_usable=False,
    tax_rate=0.21,
):
    """Minimal exposure dict in the shape get_exposure() returns."""
    return {
        "symbol": "TEST",
        "debt": {"total": debt, "cash": cash},
        "income": {
            "interest_expense": interest,
            "ebit": ebit,
            "icr": (ebit / interest) if interest else None,
            "tax_rate": tax_rate,
        },
        "wall_12m": wall,
        "ladder_usable": ladder_usable,
    }


# ── Scenario plumbing ────────────────────────────────────────────────────────

def test_parallel_scenario_shifts_every_tenor_equally():
    shifts = curve.scenario_shifts("par_+200")
    assert set(shifts) == {label for label, _sid, _y in curve.TENORS}
    assert all(abs(v - 0.02) < 1e-12 for v in shifts.values())


def test_1994_replay_flattens_the_curve():
    """The short end rose more than the long end — that is what made it 1994."""
    shifts = curve.scenario_shifts("hist_1994")
    assert shifts["2Y"] > shifts["30Y"]


def test_2022_replay_inverts_the_curve():
    shifts = curve.scenario_shifts("hist_2022")
    assert shifts["1Y"] > shifts["10Y"] > shifts["30Y"]


def test_interpolation_fills_unspecified_tenors_monotonically():
    shifts = curve.scenario_shifts("bear_steep")
    assert shifts["2Y"] < shifts["5Y"] < shifts["10Y"] < shifts["30Y"]


def test_price_channel_is_flagged_unextrapolable_past_200bp():
    assert curve.describe("par_+200")["price_channel_extrapolable"] is True
    assert curve.describe("par_+300")["price_channel_extrapolable"] is False
    # A replay counts by its actual 10Y move, not by its name.
    assert curve.describe("hist_2022")["price_channel_extrapolable"] is False


def test_shock_beyond_the_historical_record_is_flagged():
    assert curve.describe("stylized_par_400")["beyond_historical_record"] is True
    assert curve.describe("par_+300")["beyond_historical_record"] is False


# ── Earnings at risk ─────────────────────────────────────────────────────────

def test_all_floating_upper_bound_is_exactly_debt_times_shock():
    """phi=1 with no cash and no ladder has a closed form to check against."""
    exp = make_exposure(debt=1_000_000_000.0, cash=0.0)
    res = ear.earnings_at_risk(exp, "par_+100")
    assert res["delta_interest"]["hi"] == pytest.approx(1_000_000_000.0 * 0.01)


def test_lower_bound_is_zero_when_there_is_no_cash():
    exp = make_exposure(cash=0.0)
    assert ear.earnings_at_risk(exp, "par_+100")["delta_interest"]["lo"] == pytest.approx(0.0)


def test_net_cash_firm_gains_at_the_lower_bound():
    """Cash earns more when rates rise, so phi=0 is a saving, not a cost."""
    exp = make_exposure(debt=100_000_000.0, cash=5_000_000_000.0)
    res = ear.earnings_at_risk(exp, "par_+100")
    assert res["delta_interest"]["lo"] < 0
    assert res["after_tax"]["lo"] < 0


def test_zero_debt_zero_cash_firm_has_no_interest_channel():
    exp = make_exposure(debt=0.0, cash=0.0, interest=1.0)
    res = ear.earnings_at_risk(exp, "par_+300")
    assert res["delta_interest"]["lo"] == pytest.approx(0.0)
    assert res["delta_interest"]["hi"] == pytest.approx(0.0)


def test_zero_shock_leaves_interest_unchanged():
    """The invariant every scenario path has to satisfy."""
    exp = make_exposure(cash=500_000_000.0, wall=200_000_000.0, ladder_usable=True)
    shifts = {label: 0.0 for label, _sid, _y in curve.TENORS}
    lo = ear._delta_interest(exp, shifts, 0.0)
    hi = ear._delta_interest(exp, shifts, 1.0)
    assert lo["total"] == pytest.approx(0.0)
    assert hi["total"] == pytest.approx(0.0)


def test_maturing_floating_debt_is_not_counted_twice():
    """At phi=1 the floating leg already reprices the wall, so refi must be nil."""
    exp = make_exposure(wall=400_000_000.0, ladder_usable=True)
    shifts = curve.scenario_shifts("par_+100")
    assert ear._delta_interest(exp, shifts, 1.0)["refi"] == pytest.approx(0.0)
    assert ear._delta_interest(exp, shifts, 0.0)["refi"] > 0


def test_refi_leg_ignored_when_the_ladder_fails_its_coverage_gate():
    exp = make_exposure(wall=400_000_000.0, ladder_usable=False)
    shifts = curve.scenario_shifts("par_+100")
    assert ear._delta_interest(exp, shifts, 0.0)["refi"] == pytest.approx(0.0)


def test_bound_widens_with_the_size_of_the_shock():
    exp = make_exposure()
    hi100 = ear.earnings_at_risk(exp, "par_+100")["delta_interest"]["hi"]
    hi300 = ear.earnings_at_risk(exp, "par_+300")["delta_interest"]["hi"]
    assert hi300 == pytest.approx(3 * hi100)


def test_cut_scenario_reduces_interest_expense():
    res = ear.earnings_at_risk(make_exposure(), "par_-100")
    assert res["delta_interest"]["hi"] < 0


# ── Coverage and breaking point ──────────────────────────────────────────────

def test_breaking_point_is_reported_in_basis_points():
    """A root of 0.0125 in rate units is 125bp, not 0.0125bp."""
    exp = make_exposure(debt=1_000_000_000.0, cash=0.0, interest=40_000_000.0,
                        ebit=105_000_000.0)
    # EBIT/2 - I = 52.5m - 40m = 12.5m over 1bn of sensitivity → 125bp
    assert ear.breaking_point(exp)["bp"] == pytest.approx(125.0, abs=0.1)


def test_breaking_point_is_zero_when_coverage_is_already_below_target():
    exp = make_exposure(interest=100_000_000.0, ebit=150_000_000.0)  # ICR 1.5
    res = ear.breaking_point(exp)
    assert res["bp"] == 0.0
    assert res["status"] == "already_breached"


def test_negative_ebit_is_flagged_not_returned_as_nan():
    res = ear.breaking_point(make_exposure(ebit=-500_000_000.0))
    assert res["status"] == "negative_ebit"
    assert res["bp"] == 0.0


def test_net_cash_firm_has_no_breaking_point_from_this_channel():
    """Interest income outweighs the debt stack, so rising rates cannot break it."""
    exp = make_exposure(debt=10_000_000.0, cash=1_000_000_000.0)
    res = ear.breaking_point(exp)
    assert res["status"] == "not_applicable"
    assert res["bp"] is None


def test_breaking_point_needs_debt_interest_and_ebit():
    exp = make_exposure(debt=None, interest=None)
    assert ear.breaking_point(exp)["status"] == "insufficient_data"


def test_cash_passthrough_is_less_than_one():
    """Operating balances do not all earn the policy rate."""
    assert 0 < CASH_PASSTHROUGH < 1


# ── Valuation ────────────────────────────────────────────────────────────────

def _profile(spread, theta):
    return {"spread": spread, "theta": theta}


def test_exact_revaluation_is_smaller_than_the_linear_one():
    """Convexity: linearising a perpetuity overstates the loss."""
    p = _profile(0.043, 0.33)
    res = valuation.price_impact(p, 0.05)
    assert res["exact"] > res["linear"]  # both negative; exact is the milder
    assert res["convexity"] > 0


def test_convexity_gap_grows_with_the_shock():
    p = _profile(0.043, 0.33)
    small = valuation.price_impact(p, 0.01)["convexity"]
    large = valuation.price_impact(p, 0.05)["convexity"]
    assert large > small * 5


def test_low_pass_through_names_are_nearly_linear():
    """A staple with theta 0.04 barely curves; a REIT with 0.33 does."""
    staple = valuation.price_impact(_profile(0.025, 0.04), 0.05)["convexity"]
    reit = valuation.price_impact(_profile(0.043, 0.33), 0.05)["convexity"]
    assert staple < reit / 5


def test_growth_reaching_the_discount_rate_is_rejected_not_clamped():
    """g >= k_e must surface as a status, never as a silently clamped number."""
    res = valuation.price_impact(_profile(0.02, 1.0), -0.03)
    assert res["status"] == "invalid_terminal_assumption"
    assert res["exact"] is None


def test_zero_shock_leaves_price_unchanged():
    res = valuation.price_impact(_profile(0.043, 0.33), 0.0)
    assert res["exact"] == pytest.approx(0.0)


def test_missing_spread_returns_none_not_a_crash():
    res = valuation.price_impact({"spread": None, "theta": 0.2}, 0.01)
    assert res["exact"] is None


def test_rate_cut_raises_the_price():
    assert valuation.price_impact(_profile(0.043, 0.33), -0.01)["exact"] > 0


# ── Pass-through rejection ───────────────────────────────────────────────────

def test_negative_implied_theta_is_rejected_as_a_mechanism_conflict():
    """A price that rises with rates cannot come from discounting."""
    from analytics.ir_stress import empirical

    beta = {"status": "ok", "significant": True, "kappa_10y_pct_per_100bp": +2.27}
    res = empirical.implied_theta(beta, 0.0128)
    assert res["status"] == "mechanism_conflict"
    assert res["theta"] is None
    assert res["rejected_theta"] < 0


def test_positive_implied_theta_is_accepted():
    from analytics.ir_stress import empirical

    beta = {"status": "ok", "significant": True, "kappa_10y_pct_per_100bp": -6.94}
    res = empirical.implied_theta(beta, 0.0429)
    assert res["status"] == "ok"
    assert res["theta"] == pytest.approx(0.298, abs=0.01)


def test_insignificant_beta_supplies_no_theta():
    from analytics.ir_stress import empirical

    beta = {"status": "ok", "significant": False, "kappa_10y_pct_per_100bp": -0.2}
    assert empirical.implied_theta(beta, 0.05)["status"] == "unavailable"


def test_empirical_impact_refuses_to_extrapolate_past_the_limit():
    from analytics.ir_stress import empirical

    beta = {"status": "ok", "significant": True, "kappa_10y_pct_per_100bp": -6.0,
            "kappa_10y_ci95": [-8.0, -4.0], "kappa_10y_t": -6.0}
    assert empirical.empirical_impact(beta, 300)["status"] == "not_extrapolable"
    assert empirical.empirical_impact(beta, 100)["status"] == "ok"


def test_empirical_impact_scales_linearly_inside_the_limit():
    from analytics.ir_stress import empirical

    beta = {"status": "ok", "significant": True, "kappa_10y_pct_per_100bp": -6.0,
            "kappa_10y_ci95": [-8.0, -4.0], "kappa_10y_t": -6.0}
    assert empirical.empirical_impact(beta, 200)["value"] == pytest.approx(-0.12)


def test_bounded_beta_returns_pending_instead_of_blocking():
    """A slow price download must degrade the price channel, not fail the run."""
    import time

    from analytics.ir_stress import empirical

    original = empirical.rate_beta
    empirical.rate_beta = lambda sym: (time.sleep(5), {"status": "ok"})[1]
    try:
        res = empirical.rate_beta_bounded("SLOWSYM", timeout=0.2)
        assert res["status"] == "pending"
        assert "note" in res
    finally:
        empirical.rate_beta = original


def test_pending_beta_supplies_no_theta_and_no_price_estimate():
    from analytics.ir_stress import empirical

    pending = {"status": "pending"}
    assert empirical.implied_theta(pending, 0.04)["status"] == "unavailable"
    assert empirical.empirical_impact(pending, 100)["status"] == "pending"


# ── Guards against foreign statements ────────────────────────────────────────

def _confidence(**kw):
    from analytics.ir_stress.exposure import _confidence as fn

    args = {
        "completeness": 0.9,
        "stale": False,
        "interest": 1e9,
        "ebit": 5e9,
        "usd_reported": True,
        "cik": "0000789019",
        "debt": 2e10,
        "usable": True,
    }
    args.update(kw)
    return fn(**args)


def test_statements_in_another_currency_block_the_bounded_estimate():
    """SK hynix read as dollars reports 51 trillion of operating profit."""
    res = _confidence(usd_reported=False)
    assert res["bounded_assessment_available"] is False
    assert "statements_not_in_usd" in res["missing"]


def test_missing_sec_registrant_blocks_the_bounded_estimate():
    res = _confidence(cik=None)
    assert res["bounded_assessment_available"] is False
    assert "no_edgar_cik" in res["missing"]


def test_missing_total_debt_blocks_the_bounded_estimate():
    res = _confidence(debt=None)
    assert res["bounded_assessment_available"] is False
    assert "total_debt" in res["missing"]


def test_complete_us_filer_is_high_confidence():
    res = _confidence()
    assert res["bounded_assessment_available"] is True
    assert res["missing"] == []
    assert res["level"] == "high"


def test_screen_symbol_filter_keeps_us_class_shares_and_drops_foreign_listings():
    from routers.ir_stress import _US_TICKER

    for good in ("AMT", "MSFT", "BRK.B", "BF.B"):
        assert _US_TICKER.match(good), good
    for bad in ("BH.BK", "^OVX", "0700.HK", "ABCDEF"):
        assert not _US_TICKER.match(bad), bad
