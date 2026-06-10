"""
SEC Thailand (sec.or.th) Open API router.
Auth header: Ocp-Apim-Subscription-Key (Azure APIM standard).
Each product subscription has its own key.

Confirmed working on api.sec.or.th:
  - FundFactsheet  /FundFactsheet/fund/...
  - Fund Daily     /FundDailyInfo/...
  - Common         /common/ref/...

Under maintenance (Digital Asset) or require new portal subscription
(Bond, One Report) — endpoints kept as stubs, return 503 with guidance.
New portal: https://secopendata.sec.or.th/sec-open-apis
"""
import time
from typing import Any, Optional

import requests
from fastapi import APIRouter, HTTPException, Query

from config import SEC_KEYS, SEC_BASE_URL, DEFAULT_HTTP_TIMEOUT, MEM_CACHE_TTL

router = APIRouter(prefix="/api/sec", tags=["sec"])

_cache: dict[str, dict[str, Any]] = {}


def _get(product: str, path: str, params: dict | None = None,
         ttl: int = MEM_CACHE_TTL, method: str = "GET", body: dict | None = None) -> Any:
    """Call SEC API for a given product. Raises 503 if key not set."""
    cache_key = product + path + str(sorted((params or {}).items()))
    if method == "GET":
        entry = _cache.get(cache_key)
        if entry and time.time() - entry["ts"] < ttl:
            return entry["data"]

    api_key = SEC_KEYS.get(product, "")
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail=f"SEC {product} key not configured. "
                   f"Set SEC_{product.upper()}_PRIMARY in backend/.env",
        )

    headers = {
        "Accept": "application/json",
        "Ocp-Apim-Subscription-Key": api_key,
    }

    try:
        if method == "POST":
            resp = requests.post(
                f"{SEC_BASE_URL}{path}",
                json=body,
                headers={**headers, "Content-Type": "application/json"},
                timeout=DEFAULT_HTTP_TIMEOUT,
            )
        else:
            resp = requests.get(
                f"{SEC_BASE_URL}{path}",
                params=params,
                headers=headers,
                timeout=DEFAULT_HTTP_TIMEOUT,
            )

        if resp.status_code == 204:
            return []  # no content = empty dataset for that date/period

        resp.raise_for_status()
        data = resp.json()
    except requests.HTTPError:
        raise HTTPException(status_code=resp.status_code, detail=resp.text[:300])
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SEC API unreachable: {e}")

    if method == "GET":
        _cache[cache_key] = {"data": data, "ts": time.time()}
    return data


def _stub_new_portal(product: str):
    """Raise informative 503 for products that require the new SEC Open Data portal."""
    raise HTTPException(
        status_code=503,
        detail=(
            f"The '{product}' API requires a subscription from the new SEC Open Data portal "
            f"(https://secopendata.sec.or.th/sec-open-apis). "
            f"Keys from api-portal.sec.or.th do not have access to this product's endpoints."
        ),
    )


# ─────────────────────────────────────────────────────────────────────────────
# COMMON — reference / master data
# Confirmed paths on api.sec.or.th
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/common/asset-types")
def get_asset_types():
    """Portfolio asset type reference list."""
    return _get("common", "/common/ref/fund/portfolio/asset_type")


@router.get("/common/alert-action-types")
def get_alert_action_types():
    """Investor alert action type reference list."""
    return _get("common", "/common/ref/investoralert/action_type")


# ─────────────────────────────────────────────────────────────────────────────
# FUND FACTSHEET — prospectus, policy, fee, return data
# Confirmed paths on api.sec.or.th
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/fund/amc")
def list_amc():
    """List all Asset Management Companies (บลจ)."""
    return _get("fund_factsheet", "/FundFactsheet/fund/amc")


@router.get("/fund/amc/{unique_id}")
def get_amc_funds(unique_id: str):
    """List all funds under an AMC. unique_id from /fund/amc."""
    return _get("fund_factsheet", f"/FundFactsheet/fund/amc/{unique_id}")


@router.post("/fund/search")
def search_funds(name: str = Query(..., description="Fund name (Thai or English)")):
    """Search funds by name (POST)."""
    return _get("fund_factsheet", "/FundFactsheet/fund", method="POST", body={"name": name})


@router.get("/fund/{proj_id}/policy")
def get_fund_policy(proj_id: str):
    """Fund investment policy."""
    return _get("fund_factsheet", f"/FundFactsheet/fund/{proj_id}/policy")


@router.get("/fund/{proj_id}/investment")
def get_fund_investment(proj_id: str):
    """Fund investment details."""
    return _get("fund_factsheet", f"/FundFactsheet/fund/{proj_id}/investment")


@router.get("/fund/{proj_id}/ipo")
def get_fund_ipo(proj_id: str):
    """Fund IPO offering data."""
    return _get("fund_factsheet", f"/FundFactsheet/fund/{proj_id}/IPO")


@router.get("/fund/{proj_id}/suitability")
def get_fund_suitability(proj_id: str):
    """Fund investor suitability and risk spectrum."""
    return _get("fund_factsheet", f"/FundFactsheet/fund/{proj_id}/suitability")


@router.get("/fund/{proj_id}/performance")
def get_fund_performance(proj_id: str):
    """Fund historical performance / return data."""
    return _get("fund_factsheet", f"/FundFactsheet/fund/{proj_id}/performance")


@router.get("/fund/{proj_id}/dividend")
def get_fund_dividend(proj_id: str):
    """Fund dividend history."""
    return _get("fund_factsheet", f"/FundFactsheet/fund/{proj_id}/dividend")


@router.get("/fund/{proj_id}/fee")
def get_fund_fee(proj_id: str):
    """Fund fee structure."""
    return _get("fund_factsheet", f"/FundFactsheet/fund/{proj_id}/fee")


@router.get("/fund/{proj_id}/port/{period}")
def get_fund_portfolio(proj_id: str, period: str):
    """Fund portfolio by quarter (period e.g. '2025Q1')."""
    return _get("fund_factsheet", f"/FundFactsheet/fund/{proj_id}/FundPort/{period}")


@router.get("/fund/{proj_id}/manager-history")
def get_fund_manager_history(proj_id: str):
    """Fund manager history."""
    return _get("fund_factsheet", f"/FundFactsheet/fund/{proj_id}/fund_manager")


@router.get("/fund/{proj_id}/history")
def get_fund_history(proj_id: str):
    """Fund historical changes (name, policy etc)."""
    return _get("fund_factsheet", f"/FundFactsheet/fund/{proj_id}/fund_hist")


# ─────────────────────────────────────────────────────────────────────────────
# FUND DAILY INFO — NAV, AMC list
# Confirmed paths on api.sec.or.th
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/fund-daily/amc")
def list_daily_amc():
    """List AMCs available in Fund Daily Info product."""
    return _get("fund_daily", "/FundDailyInfo/amc")


@router.get("/fund-daily/{proj_id}/nav/{nav_date}")
def get_fund_nav(
    proj_id: str,
    nav_date: str,
):
    """
    Daily NAV for a fund on a specific date.
    nav_date format: YYYY-MM-DD.
    Returns [] when no data (non-trading day).
    proj_id from /fund/amc/{unique_id} response.
    """
    return _get("fund_daily", f"/FundDailyInfo/{proj_id}/dailynav/{nav_date}")


# ─────────────────────────────────────────────────────────────────────────────
# BOND — stub, requires new portal
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/bond/search")
def search_bonds(keyword: Optional[str] = Query(None)):
    """[Requires new portal] Bond search."""
    _stub_new_portal("Bond")


@router.get("/bond/{symbol}")
def get_bond_detail(symbol: str):
    """[Requires new portal] Bond detail."""
    _stub_new_portal("Bond")


# ─────────────────────────────────────────────────────────────────────────────
# DIGITAL ASSET — under maintenance by SEC
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/digital-asset/daily/{transaction_date}/trade-summary")
def get_da_daily_trade(transaction_date: str):
    """Daily digital asset trading summary. Under maintenance by SEC."""
    raise HTTPException(
        status_code=503,
        detail="Digital Asset API is temporarily under system maintenance by SEC Thailand. "
               "Use weekly report at https://www.sec.or.th instead.",
    )


@router.get("/digital-asset/daily/{transaction_date}/investor-type")
def get_da_investor_type(transaction_date: str):
    """Daily investor type summary. Under maintenance by SEC."""
    raise HTTPException(
        status_code=503,
        detail="Digital Asset API is temporarily under system maintenance by SEC Thailand.",
    )


@router.get("/digital-asset/monthly/{trade_month}/customer")
def get_da_monthly_customer(trade_month: str):
    """Monthly customer data. Under maintenance by SEC."""
    raise HTTPException(
        status_code=503,
        detail="Digital Asset API is temporarily under system maintenance by SEC Thailand.",
    )


# ─────────────────────────────────────────────────────────────────────────────
# ONE REPORT — stub, requires new portal
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/one-report/{symbol}")
def get_one_report(symbol: str, section: Optional[int] = Query(None)):
    """[Requires new portal] One Report (56-1) data."""
    _stub_new_portal("One Report")


@router.get("/one-report/{symbol}/financial-highlight")
def get_financial_highlight(symbol: str):
    """[Requires new portal] Financial highlights."""
    _stub_new_portal("One Report")


# ─────────────────────────────────────────────────────────────────────────────
# HEALTH CHECK
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/health")
def sec_health():
    """Show product key status and migration warnings."""
    return {
        "base_url": SEC_BASE_URL,
        "products": {
            product: "configured" if key else "missing"
            for product, key in SEC_KEYS.items()
        },
        "status": {
            "common":         "working",
            "fund_factsheet": "working_legacy_expires_2026-06-30",
            "fund_daily":     "working_legacy_expires_2026-06-30",
            "digital_asset":  "under_maintenance",
            "bond":           "v1_shutdown_use_api/sec/v2/bond",
            "one_report":     "use_api/sec/v2/one-report (Gregorian year, lang=T/E)",
        },
        "migration": {
            "warning":     "Fund legacy paths expire 2026-06-30. Migrate to /api/sec/v2/fund/* before then.",
            "bond_v2":     "working at /api/sec/v2/bond/* (6 endpoints)",
            "one_report":  "working at /api/sec/v2/one-report/* (23 endpoints, 2021-2023 data)",
            "digital_asset": "under maintenance — check https://www.sec.or.th for updates",
            "new_portal":  "https://secopendata.sec.or.th/sec-open-apis",
        },
    }
