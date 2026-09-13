"""Adaptive DCF endpoints for the shared NEWS / stock valuation panel.

All provider work stays here in Python.  The frontend only receives normalized
inputs and deterministic valuation outputs from ``analytics.dcf``.
"""
from __future__ import annotations

import re
from statistics import median, pstdev
from typing import Any

import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from analytics import dcf
from cache import TTLCache
from sources import market_data

router = APIRouter(prefix="/api/dcf")
_inputs_cache = TTLCache(ttl=3600, maxsize=256)
_result_cache = TTLCache(ttl=900, maxsize=512)
_SYMBOL = re.compile(r"^[A-Z0-9.^=\-]{1,20}$")


class DcfRunRequest(BaseModel):
    model: str = "auto"
    scenario: str = "base"
    assumptions: dict[str, float] = Field(default_factory=dict)


def _safe(value: Any) -> float | None:
    try:
        number = float(value)
        return number if pd.notna(number) else None
    except (TypeError, ValueError):
        return None


def _clean_symbol(symbol: str) -> str:
    value = symbol.strip().upper()
    if not _SYMBOL.fullmatch(value):
        raise HTTPException(status_code=400, detail="Invalid symbol")
    return value


def _frame(ticker: Any, *attrs: str) -> Any:
    for attr in attrs:
        try:
            value = getattr(ticker, attr, None)
            if value is not None and not value.empty:
                return value.sort_index(axis=1, ascending=False)
        except Exception:
            continue
    return None


def _statement_value(frame: Any, names: tuple[str, ...], col: int = 0) -> tuple[float | None, str | None, str | None]:
    if frame is None or col >= len(frame.columns):
        return None, None, None
    for name in names:
        try:
            if name not in frame.index:
                continue
            value = _safe(frame.loc[name, frame.columns[col]])
            if value is not None:
                date = pd.Timestamp(frame.columns[col]).date().isoformat()
                return value, name, date
        except Exception:
            continue
    return None, None, None


def _history(frame: Any, names: tuple[str, ...], limit: int = 6) -> list[tuple[str, float]]:
    if frame is None:
        return []
    for name in names:
        if name not in frame.index:
            continue
        rows: list[tuple[str, float]] = []
        for col in frame.columns[:limit]:
            value = _safe(frame.loc[name, col])
            if value is not None:
                rows.append((pd.Timestamp(col).date().isoformat(), value))
        return sorted(rows)
    return []


def _cagr(rows: list[tuple[str, float]]) -> float | None:
    positive = [(date, value) for date, value in rows if value > 0]
    if len(positive) < 2:
        return None
    positive = sorted(positive)
    oldest_date, oldest = positive[0]
    newest_date, newest = positive[-1]
    years = max((pd.Timestamp(newest_date) - pd.Timestamp(oldest_date)).days / 365.25, 1.0)
    try:
        return (newest / oldest) ** (1 / years) - 1
    except (ValueError, ZeroDivisionError):
        return None


def _growth_volatility(rows: list[tuple[str, float]]) -> float | None:
    ordered = [value for _date, value in sorted(rows) if value > 0]
    growth = [ordered[i] / ordered[i - 1] - 1 for i in range(1, len(ordered))]
    return pstdev(growth) if len(growth) >= 2 else None


def _latest_risk_free() -> tuple[float, str, str | None]:
    """One market read, not the eleven-series FRED curve fan-out used by RATE STRESS."""
    try:
        history = market_data.get_ticker("^TNX").history(period="5d", interval="1d")
        close = history.get("Close") if history is not None else None
        if close is not None:
            clean = close.dropna()
            if not clean.empty:
                return float(clean.iloc[-1]) / 100, "market:^TNX", None
    except Exception:
        pass
    return 0.04, "fallback", "10Y Treasury was unavailable; risk-free rate uses an explicit 4.0% fallback."


def _normalize_inputs(symbol: str) -> dict[str, Any]:
    ticker = market_data.get_ticker(symbol)
    try:
        info = ticker.info or {}
    except HTTPException:
        # Already a deliberate response — a 429 from the source layer means the
        # vendor is throttling us, and relabelling it below would report a
        # transient upstream limit as our own failure.
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Company data unavailable for {symbol}") from exc

    income = _frame(ticker, "income_stmt", "financials")
    cashflow = _frame(ticker, "cashflow", "cash_flow")
    balance = _frame(ticker, "balance_sheet")
    if income is None and cashflow is None and balance is None:
        raise HTTPException(status_code=422, detail=f"No financial statements available for {symbol}")

    lineage: list[dict[str, Any]] = []
    warnings: list[str] = []

    def statement(key: str, frame: Any, names: tuple[str, ...], *, absolute: bool = False) -> float | None:
        value, tag, period = _statement_value(frame, names)
        if value is not None and absolute:
            value = abs(value)
        lineage.append({"key": key, "value": value, "source": "yfinance statement",
                        "tag": tag, "period": period, "status": "STATEMENT" if value is not None else "MISSING"})
        return value

    revenue = statement("revenue", income, ("Total Revenue", "Operating Revenue"))
    ebit = statement("ebit", income, ("Operating Income", "EBIT"))
    pretax = statement("pretax_income", income, ("Pretax Income", "Income Before Tax"))
    tax_provision = statement("tax_provision", income, ("Tax Provision", "Income Tax Expense"), absolute=True)
    net_income = statement("net_income", income, ("Net Income", "Net Income Common Stockholders"))
    interest = statement("interest_expense", income, ("Interest Expense", "Interest Expense Non Operating"), absolute=True)
    depreciation = statement(
        "depreciation", cashflow,
        ("Depreciation And Amortization", "Depreciation Amortization Depletion"), absolute=True,
    )
    capex = statement(
        "capex", cashflow,
        ("Capital Expenditure", "Capital Expenditures", "Purchase Of PPE", "Investments In Property Plant And Equipment"),
        absolute=True,
    )
    working_capital_cash = statement(
        "change_in_working_capital_cash", cashflow,
        ("Change In Working Capital", "Change In Other Working Capital"),
    )
    change_nwc = -working_capital_cash if working_capital_cash is not None else 0.0
    if working_capital_cash is None:
        warnings.append("Change in non-cash working capital is unavailable and defaults to zero.")

    free_cash_flow = statement("reported_free_cash_flow", cashflow, ("Free Cash Flow",))
    issuance = statement("debt_issuance", cashflow, ("Issuance Of Debt", "Long Term Debt Issuance"), absolute=True)
    repayment = statement("debt_repayment", cashflow, ("Repayment Of Debt", "Long Term Debt Payments"), absolute=True)
    net_borrowing = (issuance or 0.0) - (repayment or 0.0) if issuance is not None or repayment is not None else None
    dividends = statement("dividends", cashflow, ("Cash Dividends Paid", "Common Stock Dividend Paid"), absolute=True)
    gains_sale = statement("gain_on_property_sale", cashflow, ("Gain Loss On Sale Of PPE", "Gain On Sale Of PPE"))

    cash = statement(
        "cash", balance,
        ("Cash Cash Equivalents And Short Term Investments", "Cash And Cash Equivalents", "Cash Financial"),
        absolute=True,
    )
    debt = statement("debt", balance, ("Total Debt",), absolute=True)
    book_equity = statement(
        "book_equity", balance,
        ("Stockholders Equity", "Common Stock Equity", "Total Equity Gross Minority Interest"),
    )
    invested_capital = statement("invested_capital", balance, ("Invested Capital",), absolute=True)
    minority = statement("minority_interest", balance, ("Minority Interest", "Minority Interest In Balance Sheet"), absolute=True)
    preferred = statement("preferred_stock", balance, ("Preferred Stock Equity", "Preferred Stock"), absolute=True)

    revenue_history = _history(income, ("Total Revenue", "Operating Revenue"))
    ebit_history = _history(income, ("Operating Income", "EBIT"))
    invested_history = _history(balance, ("Invested Capital",))
    revenue_growth = _cagr(revenue_history)
    if revenue_growth is None:
        revenue_growth = _safe(info.get("revenueGrowth"))
    revenue_volatility = _growth_volatility(revenue_history)

    margins = []
    revenue_by_date = dict(revenue_history)
    for date, value in ebit_history:
        rev = revenue_by_date.get(date)
        if rev:
            margins.append(value / rev)
    normalized_margin = median(margins) if margins else None
    normalized_revenue = median([value for _date, value in revenue_history]) if revenue_history else revenue

    sales_to_capital = None
    if len(revenue_history) >= 2 and len(invested_history) >= 2:
        rev_map = dict(revenue_history)
        cap_map = dict(invested_history)
        dates = sorted(set(rev_map) & set(cap_map))
        ratios = []
        for older, newer in zip(dates, dates[1:]):
            delta_capital = cap_map[newer] - cap_map[older]
            delta_revenue = rev_map[newer] - rev_map[older]
            if delta_capital > 0 and delta_revenue > 0:
                ratios.append(delta_revenue / delta_capital)
        if ratios:
            sales_to_capital = median(ratios)

    if pretax and pretax > 0 and tax_provision is not None:
        tax_rate = min(0.40, max(0.0, tax_provision / pretax))
    else:
        tax_rate = 0.21
        warnings.append("Normalized tax rate uses 21% because the latest effective rate is unavailable or non-positive.")

    if ebit is not None and depreciation is not None and capex is not None:
        fcff = ebit * (1 - tax_rate) + depreciation - capex - change_nwc
        fcff_source = "derived:EBIT"
    elif free_cash_flow is not None:
        fcff = free_cash_flow + (interest or 0.0) * (1 - tax_rate)
        fcff_source = "proxy:reported FCF + after-tax interest"
        warnings.append("FCFF uses reported FCF plus after-tax interest because full operating inputs are incomplete.")
    else:
        fcff = None
        fcff_source = "missing"
    lineage.append({"key": "fcff", "value": fcff, "source": fcff_source,
                    "period": lineage[0].get("period") if lineage else None,
                    "status": "DERIVED" if fcff is not None else "MISSING"})

    if net_income is not None and depreciation is not None and capex is not None:
        fcfe = net_income + depreciation - capex - change_nwc + (net_borrowing or 0.0)
    elif free_cash_flow is not None:
        fcfe = free_cash_flow + (net_borrowing or 0.0)
        warnings.append("FCFE is a reported-FCF proxy because full equity cash-flow inputs are incomplete.")
    else:
        fcfe = None

    maintenance_capex = (capex * 0.50) if capex is not None else None
    ffo = (net_income + (depreciation or 0.0) - (gains_sale or 0.0)) if net_income is not None else None
    affo = (ffo - maintenance_capex) if ffo is not None and maintenance_capex is not None else free_cash_flow
    affo_is_proxy = affo is not None

    price = _safe(info.get("currentPrice") or info.get("regularMarketPrice"))
    shares = _safe(info.get("sharesOutstanding") or info.get("impliedSharesOutstanding"))
    market_cap = _safe(info.get("marketCap"))
    financial_currency = info.get("financialCurrency")
    quote_currency = info.get("currency")
    if financial_currency and quote_currency and financial_currency != quote_currency:
        warnings.append(
            f"Statements use {financial_currency} while the market quote uses {quote_currency}; "
            "price, market cap, and upside are omitted until an FX conversion is supplied."
        )
        price = None
        market_cap = None
    if shares is None and market_cap and price:
        shares = market_cap / price
        warnings.append("Shares outstanding is derived from market cap / price.")
    if market_cap is None and shares and price:
        market_cap = shares * price

    risk_free, rf_source, rf_warning = _latest_risk_free()
    if rf_warning:
        warnings.append(rf_warning)
    beta = _safe(info.get("beta")) or 1.0
    pre_tax_cost_debt = (interest / debt) if interest is not None and debt and debt > 0 else None
    roe = _safe(info.get("returnOnEquity"))
    if roe is None and net_income is not None and book_equity and book_equity > 0:
        roe = net_income / book_equity
    payout_ratio = _safe(info.get("payoutRatio"))

    as_of_candidates = [row["period"] for row in lineage if row.get("period")]
    as_of = max(as_of_candidates) if as_of_candidates else None
    market_lineage = [
        ("price", price, "market quote"), ("shares", shares, "market/company"),
        ("market_cap", market_cap, "market quote"), ("risk_free", risk_free, rf_source),
        ("beta", beta, "market quote"),
    ]
    for key, value, source in market_lineage:
        lineage.append({"key": key, "value": value, "source": source, "period": None,
                        "status": "MARKET" if value is not None else "MISSING"})

    critical = [revenue, ebit, net_income, depreciation, capex, cash, debt, book_equity,
                price, shares, market_cap, revenue_growth, risk_free, beta]
    completeness = sum(value is not None for value in critical) / len(critical)
    if completeness < 0.70:
        warnings.append("Input completeness is below 70%; use manual overrides before relying on the result.")

    return {
        "symbol": symbol,
        "currency": financial_currency or quote_currency,
        "as_of": as_of,
        "sector": info.get("sector"),
        "industry": info.get("industry"),
        "price": price,
        "shares": shares,
        "market_cap": market_cap,
        "revenue": revenue,
        "ebit": ebit,
        "ebit_margin": (ebit / revenue) if ebit is not None and revenue else None,
        "tax_rate": tax_rate,
        "net_income": net_income,
        "interest_expense": interest,
        "depreciation": depreciation,
        "capex": capex,
        "change_nwc": change_nwc,
        "net_borrowing": net_borrowing,
        "fcff": fcff,
        "fcfe": fcfe,
        "cash": cash,
        "debt": debt,
        "minority_interest": minority,
        "preferred_stock": preferred,
        "book_equity": book_equity,
        "invested_capital": invested_capital,
        "dividends": dividends,
        "ffo": ffo,
        "affo": affo,
        "affo_is_proxy": affo_is_proxy,
        "revenue_growth": revenue_growth,
        "revenue_growth_volatility": revenue_volatility,
        "normalized_revenue": normalized_revenue,
        "normalized_margin": normalized_margin,
        "sales_to_capital": sales_to_capital,
        "risk_free": risk_free,
        "equity_risk_premium": 0.045,
        "beta": beta,
        "pre_tax_cost_debt": pre_tax_cost_debt,
        "roe": roe,
        "payout_ratio": payout_ratio,
        "completeness": completeness,
        "warnings": warnings,
        "lineage": lineage,
    }


def _inputs(symbol: str) -> dict[str, Any]:
    result = _inputs_cache.get_or_set(symbol, lambda: _normalize_inputs(symbol))
    if result is None:
        raise HTTPException(status_code=503, detail="DCF input build timed out")
    return result


def _run(symbol: str, model: str, scenario: str, assumptions: dict[str, float] | None = None) -> dict[str, Any]:
    try:
        return dcf.run_valuation(_inputs(symbol), model=model, scenario=scenario, overrides=assumptions)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/{symbol}")
def get_dcf(
    symbol: str,
    model: str = Query("auto"),
    scenario: str = Query("base"),
):
    """Default or query-selected valuation. Cached because it has no user overrides."""
    sym = _clean_symbol(symbol)
    key = f"{sym}:{model}:{scenario}"
    result = _result_cache.get_or_set(key, lambda: _run(sym, model, scenario))
    if result is None:
        raise HTTPException(status_code=503, detail="DCF calculation timed out")
    return result


@router.post("/{symbol}")
def run_dcf(symbol: str, request: DcfRunRequest):
    """Revalue with explicit analyst inputs; POST runs are never shared in cache."""
    return _run(_clean_symbol(symbol), request.model, request.scenario, request.assumptions)


@router.delete("/cache/{symbol}")
def clear_dcf_cache(symbol: str):
    sym = _clean_symbol(symbol)
    _inputs_cache.delete(sym)
    removed = _result_cache.delete_prefix(f"{sym}:")
    return {"status": "ok", "symbol": sym, "results_removed": removed}
