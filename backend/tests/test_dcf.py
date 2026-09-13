"""Offline tests for the adaptive DCF engine."""
import sys

import pytest

sys.path.insert(0, ".")

from analytics.dcf import choose_model, run_valuation


@pytest.fixture
def corporate_inputs():
    return {
        "symbol": "TEST",
        "currency": "USD",
        "as_of": "2025-12-31",
        "sector": "Industrials",
        "industry": "Specialty Industrial Machinery",
        "price": 100.0,
        "shares": 100.0,
        "market_cap": 10_000.0,
        "revenue": 2_000.0,
        "ebit": 400.0,
        "ebit_margin": 0.20,
        "tax_rate": 0.21,
        "net_income": 300.0,
        "fcff": 250.0,
        "fcfe": 220.0,
        "cash": 500.0,
        "debt": 300.0,
        "book_equity": 1_500.0,
        "affo": 240.0,
        "revenue_growth": 0.15,
        "revenue_growth_volatility": 0.08,
        "risk_free": 0.04,
        "equity_risk_premium": 0.045,
        "beta": 1.10,
        "pre_tax_cost_debt": 0.06,
        "sales_to_capital": 2.0,
        "roe": 0.20,
        "payout_ratio": 0.30,
        "completeness": 1.0,
        "warnings": [],
        "lineage": [],
    }


def test_auto_router_uses_specialized_models(corporate_inputs):
    bank = {**corporate_inputs, "sector": "Financial Services", "industry": "Banks - Regional"}
    reit = {**corporate_inputs, "sector": "Real Estate", "industry": "REIT - Industrial"}
    growth = {**corporate_inputs, "sector": "Technology", "revenue_growth": 0.30, "fcff": -20.0}
    cycle = {**corporate_inputs, "sector": "Energy", "revenue_growth_volatility": 0.25}
    assert choose_model(bank)["model"] == "excess_return"
    assert choose_model(reit)["model"] == "affo"
    assert choose_model(growth)["model"] == "growth"
    assert choose_model(cycle)["model"] == "normalized_cycle"


def test_fcff_bridge_adds_cash_and_subtracts_debt(corporate_inputs):
    out = run_valuation(corporate_inputs, model="fcff")
    summary = out["summary"]
    assert summary["equity_value"] == pytest.approx(summary["enterprise_value"] + 200.0)
    assert summary["intrinsic_value_per_share"] == pytest.approx(summary["equity_value"] / 100.0)


def test_missing_market_cap_uses_cost_of_equity_instead_of_debt_only_wacc(corporate_inputs):
    inputs = {**corporate_inputs, "market_cap": None}
    out = run_valuation(inputs, model="fcff")
    assert out["assumptions"]["wacc"] == pytest.approx(out["assumptions"]["cost_of_equity"])


def test_bear_base_bull_change_value_in_expected_order(corporate_inputs):
    values = [
        run_valuation(corporate_inputs, model="fcff", scenario=case)["summary"]["intrinsic_value_per_share"]
        for case in ("bear", "base", "bull")
    ]
    assert values[0] < values[1] < values[2]


def test_terminal_growth_is_capped_below_discount_rate(corporate_inputs):
    out = run_valuation(
        corporate_inputs,
        model="fcff",
        overrides={"wacc": 0.05, "terminal_growth": 0.06},
    )
    assert out["assumptions"]["terminal_growth"] == pytest.approx(0.045)
    assert any("capped" in warning for warning in out["data_quality"]["warnings"])


def test_growth_model_supports_negative_current_cash_flow(corporate_inputs):
    inputs = {**corporate_inputs, "fcff": -100.0, "ebit": -50.0, "ebit_margin": -0.025}
    out = run_valuation(inputs, model="growth", overrides={"target_margin": 0.18})
    assert out["model"] == "growth"
    assert len(out["forecast"]) == 10
    assert out["forecast"][-1]["ebit_margin"] == pytest.approx(0.18)


def test_fcfe_does_not_require_revenue(corporate_inputs):
    inputs = {**corporate_inputs, "revenue": None, "ebit": None, "ebit_margin": None}
    out = run_valuation(inputs, model="fcfe")
    assert out["summary"]["enterprise_value"] is None
    assert out["summary"]["equity_value"] > 0


def test_sensitivity_has_center_equal_to_point_estimate(corporate_inputs):
    out = run_valuation(corporate_inputs, model="fcff")
    matrix = out["sensitivity"]["values_per_share"]
    assert len(matrix) == 5 and all(len(row) == 5 for row in matrix)
    assert matrix[2][2] == pytest.approx(out["summary"]["intrinsic_value_per_share"])


def test_unknown_model_is_rejected(corporate_inputs):
    with pytest.raises(ValueError, match="model must be one of"):
        run_valuation(corporate_inputs, model="magic")
