"""Deterministic multi-model equity valuation engine.

The router owns data retrieval.  This module only receives normalized numbers,
so every formula is offline-testable and a saved input document can reproduce a
run later.  Rates are decimals (0.10 = 10%); statement values stay in the
issuer's reporting currency.
"""
from __future__ import annotations

from copy import deepcopy
from math import isfinite
from typing import Any


MODEL_LABELS = {
    "fcff": "3-STAGE FCFF",
    "growth": "REVENUE → FCFF",
    "fcfe": "FCFE",
    "excess_return": "EXCESS RETURN",
    "affo": "AFFO DCF",
    "normalized_cycle": "NORMALIZED CYCLE",
}
VALID_MODELS = frozenset({"auto", *MODEL_LABELS})
VALID_SCENARIOS = frozenset({"bear", "base", "bull"})


def _number(value: Any) -> float | None:
    try:
        out = float(value)
        return out if isfinite(out) else None
    except (TypeError, ValueError):
        return None


def _clamp(value: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, value))


def choose_model(inputs: dict[str, Any]) -> dict[str, Any]:
    """Recommend a model without preventing an analyst override."""
    sector = str(inputs.get("sector") or "").lower()
    industry = str(inputs.get("industry") or "").lower()
    margin = _number(inputs.get("ebit_margin"))
    growth = _number(inputs.get("revenue_growth"))
    fcff = _number(inputs.get("fcff"))
    revenue_volatility = _number(inputs.get("revenue_growth_volatility")) or 0.0

    if sector == "financial services" or any(
        word in industry for word in ("bank", "insurance", "capital markets", "credit services")
    ):
        model = "excess_return"
        reason = "Financial firms are capital-constrained; operating debt and reinvestment are not corporate FCFF inputs."
    elif sector == "real estate" or "reit" in industry:
        model = "affo"
        reason = "Property depreciation and maintenance capital make AFFO more informative than reported corporate FCF."
    elif sector in {"energy", "basic materials"} and revenue_volatility >= 0.18:
        model = "normalized_cycle"
        reason = "Cyclical revenue is volatile; the model normalizes revenue and margin instead of extending the latest year."
    elif (fcff is not None and fcff <= 0) or (margin is not None and margin <= 0) or (growth or 0) >= 0.20:
        model = "growth"
        reason = "High growth or non-positive cash flow needs a longer revenue-to-margin transition before steady state."
    else:
        model = "fcff"
        reason = "Positive operating cash flow and ordinary corporate reinvestment support a three-stage FCFF model."

    return {
        "model": model,
        "label": MODEL_LABELS[model],
        "reason": reason,
        "overrideable": True,
        "alternatives": [m for m in MODEL_LABELS if m != model],
    }


def _capital_costs(inputs: dict[str, Any]) -> dict[str, float]:
    rf = _number(inputs.get("risk_free"))
    if rf is None:
        rf = 0.04
    erp = _number(inputs.get("equity_risk_premium"))
    if erp is None:
        erp = 0.045
    beta = _clamp(_number(inputs.get("beta")) or 1.0, 0.25, 2.5)
    ke = _clamp(rf + beta * erp, 0.04, 0.30)

    market_cap = max(_number(inputs.get("market_cap")) or 0.0, 0.0)
    debt = max(_number(inputs.get("debt")) or 0.0, 0.0)
    tax = _clamp(_number(inputs.get("tax_rate")) or 0.21, 0.0, 0.40)
    kd = _number(inputs.get("pre_tax_cost_debt"))
    if kd is None:
        kd = rf + 0.025
    kd = _clamp(kd, 0.005, 0.30)
    capital = market_cap + debt
    if market_cap > 0 and debt > 0:
        wacc = (market_cap / capital) * ke + (debt / capital) * kd * (1 - tax)
    else:
        # Market capitalization is required for a meaningful debt/equity mix.
        # If it is missing (for example because quote and statement currencies
        # differ), cost of equity is the least misleading deterministic fallback.
        wacc = ke
    return {"risk_free": rf, "erp": erp, "beta": beta, "cost_of_equity": ke,
            "pre_tax_cost_debt": kd, "wacc": _clamp(wacc, 0.035, 0.30)}


def default_assumptions(inputs: dict[str, Any], model: str) -> dict[str, Any]:
    costs = _capital_costs(inputs)
    current_growth = _number(inputs.get("revenue_growth"))
    if current_growth is None:
        current_growth = 0.06
    if model == "growth" and current_growth < 0.12:
        current_growth = 0.15
    current_growth = _clamp(current_growth, -0.10, 0.40)

    current_margin = _number(inputs.get("ebit_margin"))
    if current_margin is None:
        current_margin = 0.10
    target_margin = current_margin
    if model == "growth" and current_margin < 0.12:
        target_margin = 0.15
    if model == "normalized_cycle":
        target_margin = _number(inputs.get("normalized_margin")) or current_margin

    discount = costs["cost_of_equity"] if model in {"fcfe", "excess_return", "affo"} else costs["wacc"]
    terminal_growth = min(0.025, max(0.0, costs["risk_free"] - 0.005), discount - 0.015)
    terminal_growth = _clamp(terminal_growth, 0.0, 0.04)
    years = 10 if model in {"growth", "excess_return"} else 7

    sales_to_capital = _number(inputs.get("sales_to_capital"))
    if sales_to_capital is None or sales_to_capital <= 0:
        sales_to_capital = 2.0
    roe = _number(inputs.get("roe"))
    if roe is None:
        book = _number(inputs.get("book_equity"))
        earnings = _number(inputs.get("net_income"))
        roe = (earnings / book) if book and earnings is not None else costs["cost_of_equity"]

    payout = _number(inputs.get("payout_ratio"))
    if payout is None:
        dividends = _number(inputs.get("dividends"))
        earnings = _number(inputs.get("net_income"))
        payout = (dividends / earnings) if dividends is not None and earnings and earnings > 0 else 0.35

    return {
        "forecast_years": years,
        "high_growth_years": min(5, years),
        "revenue_growth": current_growth,
        "target_margin": _clamp(target_margin, -0.25, 0.60),
        "tax_rate": _clamp(_number(inputs.get("tax_rate")) or 0.21, 0.0, 0.40),
        "sales_to_capital": _clamp(sales_to_capital, 0.20, 12.0),
        "wacc": costs["wacc"],
        "cost_of_equity": costs["cost_of_equity"],
        "terminal_growth": terminal_growth,
        "terminal_roic": max(costs["wacc"] + 0.01, 0.08),
        "roe": _clamp(roe, -0.25, 0.60),
        "stable_roe": costs["cost_of_equity"],
        "payout_ratio": _clamp(payout, 0.0, 1.0),
        "affo_growth": _clamp(current_growth, -0.05, 0.25),
        "normalized_revenue": _number(inputs.get("normalized_revenue")) or _number(inputs.get("revenue")),
        "normalized_margin": _clamp(_number(inputs.get("normalized_margin")) or target_margin, -0.25, 0.60),
    }


def _with_overrides(
    base: dict[str, Any], scenario: str, overrides: dict[str, Any] | None
) -> tuple[dict[str, Any], list[str]]:
    assumptions = deepcopy(base)
    warnings: list[str] = []
    for key, value in (overrides or {}).items():
        if key not in assumptions or value is None:
            continue
        if key in {"forecast_years", "high_growth_years"}:
            assumptions[key] = int(value)
        else:
            number = _number(value)
            if number is not None:
                assumptions[key] = number

    if scenario == "bear":
        assumptions["revenue_growth"] = assumptions["revenue_growth"] * 0.70
        assumptions["target_margin"] -= 0.03
        assumptions["wacc"] += 0.01
        assumptions["cost_of_equity"] += 0.01
        assumptions["affo_growth"] *= 0.70
        assumptions["roe"] -= 0.025
    elif scenario == "bull":
        assumptions["revenue_growth"] = assumptions["revenue_growth"] * 1.20
        assumptions["target_margin"] += 0.02
        assumptions["wacc"] = max(0.035, assumptions["wacc"] - 0.005)
        assumptions["cost_of_equity"] = max(0.04, assumptions["cost_of_equity"] - 0.005)
        assumptions["affo_growth"] *= 1.20
        assumptions["roe"] += 0.02

    assumptions["forecast_years"] = int(_clamp(assumptions["forecast_years"], 3, 15))
    assumptions["high_growth_years"] = int(
        _clamp(assumptions["high_growth_years"], 0, assumptions["forecast_years"])
    )
    assumptions["revenue_growth"] = _clamp(assumptions["revenue_growth"], -0.15, 0.50)
    assumptions["target_margin"] = _clamp(assumptions["target_margin"], -0.30, 0.65)
    assumptions["tax_rate"] = _clamp(assumptions["tax_rate"], 0.0, 0.45)
    assumptions["sales_to_capital"] = _clamp(assumptions["sales_to_capital"], 0.20, 15.0)
    assumptions["payout_ratio"] = _clamp(assumptions["payout_ratio"], 0.0, 1.0)
    assumptions["roe"] = _clamp(assumptions["roe"], -0.30, 0.70)
    assumptions["terminal_growth"] = _clamp(assumptions["terminal_growth"], -0.02, 0.06)
    assumptions["terminal_roic"] = max(0.01, assumptions["terminal_roic"])

    discount = assumptions["cost_of_equity"] if assumptions.get("equity_model") else assumptions["wacc"]
    if assumptions["terminal_growth"] >= discount:
        assumptions["terminal_growth"] = discount - 0.005
        warnings.append("Terminal growth was capped 50bp below the discount rate.")
    return assumptions, warnings


def _growth_for_year(start: float, terminal: float, year: int, years: int, high_years: int) -> tuple[float, str]:
    if year <= high_years:
        return start, "HIGH GROWTH"
    transition = max(1, years - high_years)
    weight = (year - high_years) / transition
    return start + (terminal - start) * weight, "TRANSITION"


def _corporate_value(inputs: dict[str, Any], a: dict[str, Any], model: str) -> dict[str, Any]:
    revenue = _number(inputs.get("revenue"))
    if model == "normalized_cycle":
        revenue = _number(a.get("normalized_revenue")) or revenue
    if revenue is None or revenue <= 0:
        raise ValueError("Revenue is required for an FCFF valuation.")

    current_margin = _number(inputs.get("ebit_margin"))
    if current_margin is None:
        ebit = _number(inputs.get("ebit"))
        current_margin = (ebit / revenue) if ebit is not None else 0.10
    if model == "normalized_cycle":
        current_margin = a["normalized_margin"]

    years = a["forecast_years"]
    forecast: list[dict[str, Any]] = []
    pv_explicit = 0.0
    for year in range(1, years + 1):
        growth, stage = _growth_for_year(
            a["revenue_growth"], a["terminal_growth"], year, years, a["high_growth_years"]
        )
        prior_revenue = revenue
        revenue *= 1 + growth
        margin = current_margin + (a["target_margin"] - current_margin) * year / years
        ebit = revenue * margin
        nopat = ebit * (1 - a["tax_rate"])
        reinvestment = max(0.0, revenue - prior_revenue) / a["sales_to_capital"]
        cash_flow = nopat - reinvestment
        pv = cash_flow / ((1 + a["wacc"]) ** year)
        pv_explicit += pv
        forecast.append({
            "year": year,
            "stage": stage if year < years else "STABLE ENTRY",
            "revenue": revenue,
            "growth": growth,
            "ebit_margin": margin,
            "nopat": nopat,
            "reinvestment": reinvestment,
            "cash_flow": cash_flow,
            "discount_rate": a["wacc"],
            "present_value": pv,
        })

    next_revenue = revenue * (1 + a["terminal_growth"])
    next_nopat = next_revenue * a["target_margin"] * (1 - a["tax_rate"])
    stable_reinvestment = next_nopat * a["terminal_growth"] / a["terminal_roic"]
    terminal_cash_flow = next_nopat - stable_reinvestment
    terminal_value = terminal_cash_flow / (a["wacc"] - a["terminal_growth"])
    pv_terminal = terminal_value / ((1 + a["wacc"]) ** years)
    return {
        "forecast": forecast,
        "pv_explicit": pv_explicit,
        "terminal_cash_flow": terminal_cash_flow,
        "terminal_value": terminal_value,
        "pv_terminal": pv_terminal,
        "enterprise_value": pv_explicit + pv_terminal,
        "equity_direct": False,
    }


def _fcfe_value(inputs: dict[str, Any], a: dict[str, Any]) -> dict[str, Any]:
    base = _number(inputs.get("fcfe"))
    if base is None:
        base = _number(inputs.get("net_income"))
    if base is None:
        raise ValueError("FCFE or net income is required for an FCFE valuation.")
    years = a["forecast_years"]
    forecast: list[dict[str, Any]] = []
    pv_explicit = 0.0
    cash_flow = base
    for year in range(1, years + 1):
        growth, stage = _growth_for_year(
            a["revenue_growth"], a["terminal_growth"], year, years, a["high_growth_years"]
        )
        cash_flow *= 1 + growth
        pv = cash_flow / ((1 + a["cost_of_equity"]) ** year)
        pv_explicit += pv
        forecast.append({"year": year, "stage": stage, "growth": growth, "cash_flow": cash_flow,
                         "discount_rate": a["cost_of_equity"], "present_value": pv})
    terminal_cash_flow = cash_flow * (1 + a["terminal_growth"])
    terminal_value = terminal_cash_flow / (a["cost_of_equity"] - a["terminal_growth"])
    pv_terminal = terminal_value / ((1 + a["cost_of_equity"]) ** years)
    return {"forecast": forecast, "pv_explicit": pv_explicit, "terminal_cash_flow": terminal_cash_flow,
            "terminal_value": terminal_value, "pv_terminal": pv_terminal,
            "enterprise_value": None, "equity_value": pv_explicit + pv_terminal, "equity_direct": True}


def _affo_value(inputs: dict[str, Any], a: dict[str, Any]) -> dict[str, Any]:
    affo = _number(inputs.get("affo"))
    if affo is None:
        affo = _number(inputs.get("fcfe")) or _number(inputs.get("fcff"))
    if affo is None:
        raise ValueError("AFFO is unavailable; enter an AFFO override before using the REIT model.")
    local = dict(a)
    local["revenue_growth"] = a["affo_growth"]
    return _fcfe_value({**inputs, "fcfe": affo}, local)


def _excess_return_value(inputs: dict[str, Any], a: dict[str, Any]) -> dict[str, Any]:
    book = _number(inputs.get("book_equity"))
    if book is None or book <= 0:
        raise ValueError("Positive book equity is required for an excess-return valuation.")
    initial_book = book
    years = a["forecast_years"]
    forecast: list[dict[str, Any]] = []
    pv_explicit = 0.0
    last_excess = 0.0
    for year in range(1, years + 1):
        weight = year / years
        roe = a["roe"] + (a["stable_roe"] - a["roe"]) * weight
        earnings = book * roe
        excess = book * (roe - a["cost_of_equity"])
        pv = excess / ((1 + a["cost_of_equity"]) ** year)
        pv_explicit += pv
        forecast.append({"year": year, "stage": "FADE TO STABLE", "roe": roe,
                         "book_equity": book, "earnings": earnings, "cash_flow": excess,
                         "discount_rate": a["cost_of_equity"], "present_value": pv})
        book += earnings * (1 - a["payout_ratio"])
        last_excess = excess
    stable_excess = book * (a["stable_roe"] - a["cost_of_equity"])
    terminal_value = (
        stable_excess / (a["cost_of_equity"] - a["terminal_growth"])
        if stable_excess > 0 else 0.0
    )
    pv_terminal = terminal_value / ((1 + a["cost_of_equity"]) ** years)
    return {"forecast": forecast, "pv_explicit": pv_explicit,
            "terminal_cash_flow": stable_excess or last_excess, "terminal_value": terminal_value,
            "pv_terminal": pv_terminal, "enterprise_value": None,
            "equity_value": initial_book + pv_explicit + pv_terminal, "equity_direct": True}


def _run_core(inputs: dict[str, Any], model: str, assumptions: dict[str, Any]) -> dict[str, Any]:
    assumptions = dict(assumptions)
    assumptions["equity_model"] = model in {"fcfe", "excess_return", "affo"}
    discount = assumptions["cost_of_equity"] if assumptions["equity_model"] else assumptions["wacc"]
    if assumptions["terminal_growth"] >= discount:
        raise ValueError("Terminal growth must be below the discount rate.")

    if model in {"fcff", "growth", "normalized_cycle"}:
        result = _corporate_value(inputs, assumptions, model)
    elif model == "fcfe":
        result = _fcfe_value(inputs, assumptions)
    elif model == "affo":
        result = _affo_value(inputs, assumptions)
    elif model == "excess_return":
        result = _excess_return_value(inputs, assumptions)
    else:
        raise ValueError(f"Unknown DCF model: {model}")

    if not result["equity_direct"]:
        cash = max(_number(inputs.get("cash")) or 0.0, 0.0)
        debt = max(_number(inputs.get("debt")) or 0.0, 0.0)
        minority = max(_number(inputs.get("minority_interest")) or 0.0, 0.0)
        preferred = max(_number(inputs.get("preferred_stock")) or 0.0, 0.0)
        result["equity_value"] = result["enterprise_value"] + cash - debt - minority - preferred
    return result


def _sensitivity(inputs: dict[str, Any], model: str, assumptions: dict[str, Any]) -> dict[str, Any]:
    equity_model = model in {"fcfe", "excess_return", "affo"}
    rate_key = "cost_of_equity" if equity_model else "wacc"
    center_rate = assumptions[rate_key]
    center_g = assumptions["terminal_growth"]
    rates = [max(0.025, center_rate + d) for d in (-0.02, -0.01, 0.0, 0.01, 0.02)]
    growths = [max(-0.02, center_g + d) for d in (-0.01, -0.005, 0.0, 0.005, 0.01)]
    shares = _number(inputs.get("shares")) or 0.0
    matrix: list[list[float | None]] = []
    for rate in rates:
        row: list[float | None] = []
        for growth in growths:
            if growth >= rate:
                row.append(None)
                continue
            varied = dict(assumptions)
            varied[rate_key] = rate
            varied["terminal_growth"] = growth
            try:
                value = _run_core(inputs, model, varied)["equity_value"]
                row.append((value / shares) if shares > 0 else None)
            except (ValueError, ZeroDivisionError, OverflowError):
                row.append(None)
        matrix.append(row)
    return {"discount_rate_key": rate_key, "discount_rates": rates,
            "terminal_growth_rates": growths, "values_per_share": matrix}


def run_valuation(
    inputs: dict[str, Any], model: str = "auto", scenario: str = "base",
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run one valuation and return both the result and every assumption used."""
    if model not in VALID_MODELS:
        raise ValueError(f"model must be one of {sorted(VALID_MODELS)}")
    if scenario not in VALID_SCENARIOS:
        raise ValueError(f"scenario must be one of {sorted(VALID_SCENARIOS)}")

    recommendation = choose_model(inputs)
    selected = recommendation["model"] if model == "auto" else model
    base = default_assumptions(inputs, selected)
    base["equity_model"] = selected in {"fcfe", "excess_return", "affo"}
    assumptions, assumption_warnings = _with_overrides(base, scenario, overrides)
    core = _run_core(inputs, selected, assumptions)

    shares = _number(inputs.get("shares")) or 0.0
    price = _number(inputs.get("price"))
    equity_value = core["equity_value"]
    intrinsic = (equity_value / shares) if shares > 0 else None
    upside = (intrinsic / price - 1) if intrinsic is not None and price and price > 0 else None
    total_pv = core["pv_explicit"] + core["pv_terminal"]
    terminal_share = core["pv_terminal"] / total_pv if total_pv > 0 else None

    inherited_warnings = list(inputs.get("warnings") or [])
    warnings = inherited_warnings + assumption_warnings
    if terminal_share is not None and terminal_share > 0.75:
        warnings.append("Terminal value exceeds 75% of discounted operating value; treat the point estimate as fragile.")
    if selected == "affo" and inputs.get("affo_is_proxy"):
        warnings.append("AFFO is a proxy derived from available statements; replace it with company-reported AFFO for investment use.")
    if selected == "fcfe" and inputs.get("net_borrowing") is None:
        warnings.append("FCFE uses a fallback because net borrowing is unavailable.")

    return {
        "status": "ok",
        "symbol": inputs.get("symbol"),
        "currency": inputs.get("currency"),
        "as_of": inputs.get("as_of"),
        "scenario": scenario,
        "model": selected,
        "model_label": MODEL_LABELS[selected],
        "model_router": recommendation,
        "summary": {
            "market_price": price,
            "enterprise_value": core.get("enterprise_value"),
            "equity_value": equity_value,
            "intrinsic_value_per_share": intrinsic,
            "upside_downside": upside,
            "pv_explicit": core["pv_explicit"],
            "pv_terminal": core["pv_terminal"],
            "terminal_value_share": terminal_share,
        },
        "bridge": {
            "cash": max(_number(inputs.get("cash")) or 0.0, 0.0),
            "debt": max(_number(inputs.get("debt")) or 0.0, 0.0),
            "minority_interest": max(_number(inputs.get("minority_interest")) or 0.0, 0.0),
            "preferred_stock": max(_number(inputs.get("preferred_stock")) or 0.0, 0.0),
            "shares": shares,
        },
        "assumptions": assumptions,
        "forecast": core["forecast"],
        "terminal": {
            "cash_flow": core["terminal_cash_flow"],
            "undiscounted_value": core["terminal_value"],
            "method": "Gordon growth",
        },
        "sensitivity": _sensitivity(inputs, selected, assumptions),
        "data_quality": {
            "completeness": inputs.get("completeness"),
            "warnings": list(dict.fromkeys(warnings)),
            "lineage": inputs.get("lineage") or [],
        },
    }
