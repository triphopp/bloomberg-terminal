"""
Interest-rate stress endpoints for the RATE STRESS tab in stock-view.

US listings only: the whole exposure side rests on EDGAR, so a Thai or other
non-US ticker gets a 404 that says where to go instead, matching what
`company_filings` already does.

Deliberately no `/history` here yet. Reproducing what the model would have said
at a past date needs point-in-time filings (first-filed revision, not today's
restatement) and that reconstruction is far too slow for a request — it belongs
to the harness, which writes its results to a table this router will later read.
"""
from __future__ import annotations

import re

from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, HTTPException, Query

from analytics import ir_stress
from analytics.ir_stress import curve, ear, empirical, exposure, valuation
from cache import TTLCache

router = APIRouter(prefix="/api/ir-stress")
_cache = TTLCache(ttl=900, maxsize=128)

# A dot means a class share on a US exchange (BRK.B) when a single letter follows
# it, and a foreign exchange code when two do (BH.BK, 0700.HK). Carets are index
# symbols (^OVX), which have no filings at all. Getting this wrong is not
# harmless: yfinance happily returns a balance sheet for a Thai listing and the
# screen then prints a coverage ratio built from EDGAR data that is not there.
_US_TICKER = re.compile(r"^[A-Z]{1,5}(\.[A-Z])?$")


def _require_us(symbol: str) -> str:
    sym = symbol.upper()
    if not _US_TICKER.match(sym):
        raise HTTPException(
            status_code=404,
            detail=f"{sym} is not a US listing — the rate-stress model reads debt "
                   f"schedules from SEC EDGAR, which has no filings for it",
        )
    return sym


@router.get("/curve")
def get_curve():
    """Current UST curve and the corporate refinancing rate derived from it."""
    return curve.get_curve()


@router.get("/scenarios")
def list_scenarios():
    """Every scenario the model accepts, with its limits declared up front."""
    return {
        "scenarios": [curve.describe(sid) for sid in curve.SCENARIOS],
        "max_observed_12m_bp": curve.MAX_OBSERVED_12M_BP,
        "note": (
            "Shocks are curve moves, not policy actions: measured 2021-2026 the "
            "10Y fell in 4 of the 11 months the funds rate rose."
        ),
    }


@router.get("/{symbol}/exposure")
def get_exposure(symbol: str):
    """Debt stack, maturity ladder, effective coupon and the refinancing gap."""
    return exposure.get_exposure(_require_us(symbol))


@router.get("/{symbol}/duration")
def get_duration(symbol: str):
    """Equity duration from the inverted Gordon model plus measured pass-through.

    Returns the assumed-growth variant alongside, because seeing it blow up is
    the argument for not using it.
    """
    sym = _require_us(symbol)
    beta = empirical.rate_beta_bounded(sym)

    sector = None
    try:
        from routers import market as _market

        sector = (_market.market_data.get_ticker(sym).info or {}).get("sector")
    except Exception:  # noqa: BLE001
        pass

    profile = valuation.valuation_profile(
        sym, beta.get("market_beta") if beta.get("status") == "ok" else None, sector
    )
    theta_fit = empirical.implied_theta(beta, profile.get("spread"))
    if theta_fit["status"] == "ok":
        profile["theta"] = theta_fit["theta"]
        profile["theta_source"] = "implied from this name's measured beta"
    profile["theta_fit"] = theta_fit

    return {
        "symbol": sym,
        "sector": sector,
        "profile": profile,
        "rate_beta": beta,
        "impact_100bp": valuation.price_impact(profile, 0.01),
    }


@router.get("/{symbol}/scenario")
def get_scenario(symbol: str, id: str = Query(..., description="scenario id")):
    """One scenario, with the earnings, solvency and price channels kept apart."""
    sym = _require_us(symbol)
    if id not in curve.SCENARIOS:
        raise HTTPException(status_code=400, detail=f"unknown scenario {id}")
    result = ir_stress.run_stress(sym, [id])
    return {
        "symbol": sym,
        "exposure": result["exposure"],
        "valuation": result["valuation"],
        "scenario": result["scenarios"][0],
        "breaking_point": result["breaking_point"],
        "channel_gap": result["channel_gap"],
    }


@router.get("/{symbol}")
def get_stress(
    symbol: str,
    scenarios: str = Query("", description="comma-separated ids; blank = default set"),
):
    """Full assessment across the default scenario set."""
    sym = _require_us(symbol)
    ids = [s.strip() for s in scenarios.split(",") if s.strip()] or None
    if ids:
        unknown = [s for s in ids if s not in curve.SCENARIOS]
        if unknown:
            raise HTTPException(status_code=400, detail=f"unknown scenarios: {unknown}")

    key = f"{sym}:{','.join(ids or ir_stress.DEFAULT_SCENARIOS)}"
    cached = _cache.get(key)
    if cached is not None:
        return cached

    data = ir_stress.run_stress(sym, ids)
    _cache.set(key, data)
    return data


@router.get("/screen/rank")
def screen(
    symbols: str = Query(..., description="comma-separated tickers"),
    scenario: str = Query("par_+100"),
):
    """Cross-sectional comparison, ranked by the worst-case earnings hit.

    Two rankings come back rather than one composite, because they disagree: the
    names that lose most in price are not the names whose coverage erodes most,
    and a single score would bury that.
    """
    if scenario not in curve.SCENARIOS:
        raise HTTPException(status_code=400, detail=f"unknown scenario {scenario}")

    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()][:40]

    def _row(sym: str) -> dict:
        # One symbol costs an EDGAR round trip per maturity bucket plus five years
        # of prices, so a whole watchlist done in sequence takes minutes on a cold
        # cache — long enough that the tab looks broken.
        if not _US_TICKER.match(sym):
            # yfinance will happily price a Thai listing or a volatility index and
            # the row would then show a coverage ratio built on filings that do not
            # exist. Cheaper to say so than to print a plausible wrong number.
            return {"symbol": sym, "error": "not a US listing — no SEC filings"}
        try:
            exp = exposure.get_exposure(sym)
            if not exp.get("cik"):
                return {"symbol": sym, "error": "no SEC registrant behind this ticker"}
            if not exp.get("usd_reported", True):
                ccy = exp.get("reporting_currency")
                return {"symbol": sym, "error": f"statements reported in {ccy}, not USD"}
            e = ear.earnings_at_risk(exp, scenario)
            beta = empirical.rate_beta_bounded(sym)
            bp = ear.breaking_point(exp, ear.ICR_COVENANT)
            return {
                "symbol": sym,
                "ear_hi_over_ebit": e["vs_ebit"]["hi"],
                "ear_lo_over_ebit": e["vs_ebit"]["lo"],
                "ear_hi_usd": e["delta_interest"]["hi"],
                "ear_lo_usd": e["delta_interest"]["lo"],
                "icr_base": e["icr"]["base"],
                "icr_worst": e["icr"]["hi"],
                "breaking_point_bp": bp.get("bp"),
                "refi_gap_bp": exp["cost"]["refi_gap_bp"],
                "kappa_pct_per_100bp": (
                    beta.get("kappa_10y_pct_per_100bp") if beta.get("significant") else None
                ),
                "kappa_significant": bool(beta.get("significant")),
                "confidence": exp["confidence"]["level"],
            }
        except Exception as exc:  # noqa: BLE001 - one bad ticker must not sink the screen
            return {"symbol": sym, "error": str(exc)}

    with ThreadPoolExecutor(max_workers=8) as pool:
        rows = list(pool.map(_row, syms))

    ok = [r for r in rows if "error" not in r]
    return {
        "scenario": curve.describe(scenario),
        "rows": rows,
        "by_earnings": [
            r["symbol"]
            for r in sorted(
                (r for r in ok if r["ear_hi_over_ebit"] is not None),
                key=lambda r: -r["ear_hi_over_ebit"],
            )
        ],
        "by_price": [
            r["symbol"]
            for r in sorted(
                (r for r in ok if r["kappa_pct_per_100bp"] is not None),
                key=lambda r: r["kappa_pct_per_100bp"],
            )
        ],
    }
