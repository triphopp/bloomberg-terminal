"""Router contract tests without provider/network access."""
import sys

import pytest
import pandas as pd
from fastapi import HTTPException

sys.path.insert(0, ".")

from routers import dcf as router


def normalized_inputs():
    return {
        "symbol": "TEST", "currency": "USD", "as_of": "2025-12-31",
        "sector": "Technology", "industry": "Software - Infrastructure",
        "price": 50.0, "shares": 100.0, "market_cap": 5_000.0,
        "revenue": 1_200.0, "ebit": 180.0, "ebit_margin": 0.15,
        "tax_rate": 0.21, "net_income": 130.0, "fcff": 95.0, "fcfe": 85.0,
        "cash": 300.0, "debt": 100.0, "book_equity": 900.0, "affo": 90.0,
        "revenue_growth": 0.12, "revenue_growth_volatility": 0.07,
        "risk_free": 0.04, "equity_risk_premium": 0.045, "beta": 1.0,
        "pre_tax_cost_debt": 0.055, "sales_to_capital": 2.0, "roe": 0.15,
        "payout_ratio": 0.25, "completeness": 0.92, "warnings": [], "lineage": [],
    }


def test_post_contract_applies_model_scenario_and_override(monkeypatch):
    monkeypatch.setattr(router, "_inputs", lambda _symbol: normalized_inputs())
    request = router.DcfRunRequest(
        model="growth", scenario="bull", assumptions={"target_margin": 0.25}
    )
    out = router.run_dcf("test", request)
    assert out["symbol"] == "TEST"
    assert out["model"] == "growth"
    assert out["scenario"] == "bull"
    assert out["assumptions"]["target_margin"] == pytest.approx(0.27)


def test_invalid_symbol_is_rejected_before_provider_call():
    with pytest.raises(HTTPException) as error:
        router.run_dcf("../../etc/passwd", router.DcfRunRequest())
    assert error.value.status_code == 400


def test_cross_currency_quote_is_not_compared_to_statement_value(monkeypatch):
    dates = pd.to_datetime(["2025-12-31", "2024-12-31", "2023-12-31"])

    class FakeTicker:
        info = {
            "financialCurrency": "EUR", "currency": "USD", "currentPrice": 50.0,
            "marketCap": 5_000.0, "sharesOutstanding": 100.0,
            "sector": "Industrials", "industry": "Machinery", "beta": 1.0,
        }
        income_stmt = pd.DataFrame(
            [[1200, 1100, 1000], [180, 160, 140], [160, 145, 125], [32, 29, 25], [128, 116, 100], [10, 9, 8]],
            index=["Total Revenue", "Operating Income", "Pretax Income", "Tax Provision", "Net Income", "Interest Expense"],
            columns=dates,
        )
        cashflow = pd.DataFrame(
            [[60, 55, 50], [-80, -75, -70], [-12, -10, -8], [90, 82, 75]],
            index=["Depreciation And Amortization", "Capital Expenditure", "Change In Working Capital", "Free Cash Flow"],
            columns=dates,
        )
        balance_sheet = pd.DataFrame(
            [[200, 180, 160], [100, 95, 90], [900, 820, 750], [1000, 920, 840]],
            index=["Cash And Cash Equivalents", "Total Debt", "Stockholders Equity", "Invested Capital"],
            columns=dates,
        )

    monkeypatch.setattr(router.market_data, "get_ticker", lambda _symbol: FakeTicker())
    monkeypatch.setattr(router, "_latest_risk_free", lambda: (0.04, "test", None))
    inputs = router._normalize_inputs("ADR")

    assert inputs["currency"] == "EUR"
    assert inputs["price"] is None
    assert inputs["market_cap"] is None
    assert any("while the market quote uses USD" in warning for warning in inputs["warnings"])
    assert any(row["status"] == "STATEMENT" for row in inputs["lineage"])
