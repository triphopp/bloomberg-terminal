"""
SEC Thailand v2 API router (new portal: secopendata.sec.or.th).
Gateway: api.sec.or.th | Auth: Ocp-Apim-Subscription-Key (single key).

CONFIRMED WORKING (tested 2026-05-29):
  Bond v2      /v2/bond/*            — 6 endpoints, cursor pagination
  Fund v2      /v2/fund/*            — 21 endpoints, cursor + proj_id filter
  One Report   /v1/one-report/*      — 23 endpoints, path params

UNDER MAINTENANCE / PENDING:
  Digital Asset — /v1/digital-asset/* — under maintenance by SEC

Pagination (Bond + Fund):
  page_size : items per page (max 100)
  cursor    : token from previous response next_cursor field

Fund filter:
  proj_id   : fund project ID e.g. M0003_2563 (from /fund/general-info/profiles)
  amcs/profiles endpoints: pagination only (no filter)

One Report:
  report_year : Gregorian year e.g. 2023  (NOT Buddhist Era — 2021/2022/2023 confirmed with data)
  unique_id   : SEC company_id e.g. C0000000013 (from sbo/info response)
  language    : T=Thai  E=English  (NOT 1/2 — T and E are the valid values)
  Returns 204 when company has no data for that section (not a path error).
"""
import time
from typing import Any, Optional

import requests
from fastapi import APIRouter, HTTPException, Query

from config import SEC2_KEYS, SEC_BASE_URL, DEFAULT_HTTP_TIMEOUT, MEM_CACHE_TTL

router = APIRouter(prefix="/api/sec/v2", tags=["sec-v2"])

_cache: dict[str, dict[str, Any]] = {}

# ── core HTTP helper ──────────────────────────────────────────────────────────

def _get(product: str, path: str,
         params: dict | None = None,
         ttl: int = MEM_CACHE_TTL) -> Any:
    clean = {k: v for k, v in (params or {}).items() if v is not None}

    ck = product + path + str(sorted(clean.items()))
    entry = _cache.get(ck)
    if entry and time.time() - entry["ts"] < ttl:
        return entry["data"]

    api_key = SEC2_KEYS.get(product, "")
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail=f"SEC v2 '{product}' key not set. "
                   f"Set SEC2_API_KEY (or SEC2_{product.upper()}_PRIMARY) in backend/.env",
        )

    try:
        resp = requests.get(
            f"{SEC_BASE_URL}{path}",
            params=clean or None,
            headers={"Accept": "application/json", "Ocp-Apim-Subscription-Key": api_key},
            timeout=DEFAULT_HTTP_TIMEOUT,
        )
        if resp.status_code == 204:
            return {"items": [], "message": "no_content"}
        resp.raise_for_status()
        data = resp.json()
    except requests.HTTPError:
        raise HTTPException(status_code=resp.status_code, detail=resp.text[:300])
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SEC API unreachable: {e}")

    _cache[ck] = {"data": data, "ts": time.time()}
    return data


def _pending(product: str, note: str = ""):
    raise HTTPException(
        status_code=503,
        detail=f"SEC v2 '{product}' paths not yet confirmed. {note}".strip(),
    )


# ═════════════════════════════════════════════════════════════════════════════
# BOND v2  — ตราสารหนี้
# Pagination: page_size (max 100) + cursor from previous next_cursor
# Filter:     bond_id (for detail endpoints), efft_date (for time-series)
# ═════════════════════════════════════════════════════════════════════════════

@router.get("/bond/issuers",
    summary="ชื่อผู้ออกตราสารหนี้",
    description="Fields: company_id, company_name_th, company_name_en")
def get_bond_issuers(
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None, description="Pagination cursor from previous next_cursor"),
):
    return _get("bond", "/v2/bond/issuers", {"page_size": page_size, "cursor": cursor})


@router.get("/bond/features",
    summary="ลักษณะทั่วไปของตราสารหนี้",
    description="Fields: bond_id, isin_code, bond_name_th/en, bond_type, coupon, maturity, offering, market, currency_info, …")
def get_bond_features(
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    return _get("bond", "/v2/bond/features", {"page_size": page_size, "cursor": cursor})


@router.get("/bond/credit-ratings",
    summary="การจัดอันดับความน่าเชื่อถือตามช่วงเวลา",
    description="Fields: bond_id, efft_date, exp_date, rating_code. Filter: bond_id, efft_date")
def get_bond_credit_ratings(
    bond_id: Optional[str] = Query(None),
    efft_date: Optional[str] = Query(None, description="Effective date YYYY-MM-DD"),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    return _get("bond", "/v2/bond/credit-ratings", {
        "bond_id": bond_id, "efft_date": efft_date,
        "page_size": page_size, "cursor": cursor,
    })


@router.get("/bond/outstanding-values",
    summary="มูลค่าคงค้างของตราสารหนี้ตามช่วงเวลา",
    description="Fields: bond_id, efft_date, exp_date, outstanding_value_mm_baht")
def get_bond_outstanding_values(
    bond_id: Optional[str] = Query(None),
    efft_date: Optional[str] = Query(None, description="Effective date YYYY-MM-DD"),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    return _get("bond", "/v2/bond/outstanding-values", {
        "bond_id": bond_id, "efft_date": efft_date,
        "page_size": page_size, "cursor": cursor,
    })


@router.get("/bond/involve-parties",
    summary="ผู้เกี่ยวข้องกับตราสารหนี้ตามช่วงเวลา",
    description="Fields: bond_id, company_id, efft_date, exp_date, function_type, function_type_name_th")
def get_bond_involve_parties(
    bond_id: Optional[str] = Query(None),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    return _get("bond", "/v2/bond/involve-parties", {
        "bond_id": bond_id, "page_size": page_size, "cursor": cursor,
    })


@router.get("/bond/investor-holdings",
    summary="มูลค่าตราสารหนี้ในผู้ลงทุนแต่ละประเภท",
    description="Fields: bond_id + thai/foreign × juristic/institution/hnw/person _value_baht")
def get_bond_investor_holdings(
    bond_id: Optional[str] = Query(None),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    return _get("bond", "/v2/bond/investor-holdings", {
        "bond_id": bond_id, "page_size": page_size, "cursor": cursor,
    })


# ═════════════════════════════════════════════════════════════════════════════
# ONE REPORT v1
# Path pattern: /v1/one-report/{section}/{report_year}/{endpoint}/{param}
# Sections: sbo, sustainability, scp, cgp, fs, cgs
# report_year: Buddhist Era e.g. 2566
# unique_id:   SEC company_id e.g. C0000000021
# language:    1=Thai  2=English
# Returns 204 when company has no filing for that year
# ═════════════════════════════════════════════════════════════════════════════

# ── SBO — ข้อมูลทั่วไปของกิจการ ─────────────────────────────────────────────

@router.get("/one-report/sbo/{report_year}/info/{language}",
    summary="ข้อมูลทั่วไปของกิจการ (รายการบริษัท)")
def get_sbo_info(
    report_year: int,
    language: str,
):
    """
    List all companies with SBO filing.
    report_year: Gregorian e.g. 2023 (data: 2021=178 cos, 2022=770, 2023=814).
    language: T=Thai, E=English.
    Returns array of unique_id, symbol, corp_name, address, business_type.
    Use unique_id from here for all other /one-report/* endpoints.
    """
    if language not in ("T", "E"):
        raise HTTPException(status_code=400, detail="language must be 'T' (Thai) or 'E' (English)")
    return _get("one_report", f"/v1/one-report/sbo/{report_year}/info/{language}")


@router.get("/one-report/sbo/{report_year}/rd/{unique_id}",
    summary="ข้อมูลวิจัยและพัฒนา (R&D)")
def get_sbo_rd(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/sbo/{report_year}/rd/{unique_id}")


@router.get("/one-report/sbo/{report_year}/product-income/{unique_id}",
    summary="รายได้จากผลิตภัณฑ์")
def get_sbo_product_income(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/sbo/{report_year}/product_income/{unique_id}")


@router.get("/one-report/sbo/{report_year}/export-income/{unique_id}",
    summary="รายได้จากการส่งออก")
def get_sbo_export_income(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/sbo/{report_year}/export_income/{unique_id}")


@router.get("/one-report/sbo/{report_year}/risk/{unique_id}",
    summary="ปัจจัยความเสี่ยง")
def get_sbo_risk(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/sbo/{report_year}/risk/{unique_id}")


# ── Sustainability — ความยั่งยืน ─────────────────────────────────────────────

@router.get("/one-report/sustainability/{report_year}/detail/{unique_id}",
    summary="ข้อมูล ESG overview")
def get_sustainability_detail(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/sustainability/{report_year}/detail/{unique_id}")


@router.get("/one-report/sustainability/{report_year}/environment-issue/{unique_id}",
    summary="ประเด็นด้านสิ่งแวดล้อม")
def get_sustainability_environment(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/sustainability/{report_year}/environment_issue/{unique_id}")


@router.get("/one-report/sustainability/{report_year}/humanrights-issue/{unique_id}",
    summary="ประเด็นด้านสิทธิมนุษยชน")
def get_sustainability_humanrights(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/sustainability/{report_year}/humanrights_issue/{unique_id}")


# ── SCP — ความรับผิดชอบต่อสังคม ─────────────────────────────────────────────

@router.get("/one-report/scp/{report_year}/employee-info/{unique_id}",
    summary="ข้อมูลพนักงาน")
def get_scp_employee_info(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/scp/{report_year}/employee_info/{unique_id}")


@router.get("/one-report/scp/{report_year}/employee-development/{unique_id}",
    summary="การพัฒนาพนักงาน")
def get_scp_employee_development(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/scp/{report_year}/employee_development/{unique_id}")


@router.get("/one-report/scp/{report_year}/labor-dispute/{unique_id}",
    summary="ข้อพิพาทแรงงาน")
def get_scp_labor_dispute(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/scp/{report_year}/labor_dispute/{unique_id}")


@router.get("/one-report/scp/{report_year}/csr-activity/{unique_id}",
    summary="กิจกรรม CSR")
def get_scp_csr_activity(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/scp/{report_year}/csr_activity/{unique_id}")


# ── CGP — การกำกับดูแลกิจการที่ดี ───────────────────────────────────────────

@router.get("/one-report/cgp/{report_year}/governance/{unique_id}",
    summary="นโยบายการกำกับดูแลกิจการ")
def get_cgp_governance(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/cgp/{report_year}/governance/{unique_id}")


@router.get("/one-report/cgp/{report_year}/director/{unique_id}",
    summary="ข้อมูลกรรมการ")
def get_cgp_director(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/cgp/{report_year}/director/{unique_id}")


@router.get("/one-report/cgp/{report_year}/code-of-conduct/{unique_id}",
    summary="จรรยาบรรณธุรกิจ")
def get_cgp_code_of_conduct(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/cgp/{report_year}/code_of_conduct/{unique_id}")


# ── FS — งบการเงิน ───────────────────────────────────────────────────────────

@router.get("/one-report/fs/{report_year}/financial-statement/{unique_id}",
    summary="งบการเงิน")
def get_fs_financial_statement(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/fs/{report_year}/financial_statement/{unique_id}")


# ── CGS — โครงสร้างการกำกับดูแล ─────────────────────────────────────────────

@router.get("/one-report/cgs/{report_year}/board/{unique_id}",
    summary="ข้อมูลคณะกรรมการ")
def get_cgs_board(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/cgs/{report_year}/board/{unique_id}")


@router.get("/one-report/cgs/{report_year}/employee/{unique_id}",
    summary="โครงสร้างพนักงาน")
def get_cgs_employee(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/cgs/{report_year}/employee/{unique_id}")


@router.get("/one-report/cgs/{report_year}/auditor-company/{unique_id}",
    summary="บริษัทผู้สอบบัญชี")
def get_cgs_auditor_company(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/cgs/{report_year}/auditor_company/{unique_id}")


@router.get("/one-report/cgs/{report_year}/director-performance/{unique_id}",
    summary="ผลการปฏิบัติหน้าที่กรรมการ")
def get_cgs_director_performance(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/cgs/{report_year}/director_performance/{unique_id}")


@router.get("/one-report/cgs/{report_year}/bods/{unique_id}",
    summary="รายชื่อคณะกรรมการบริษัท (BOD)")
def get_cgs_bods(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/cgs/{report_year}/bods/{unique_id}")


@router.get("/one-report/cgs/{report_year}/executives/{unique_id}",
    summary="รายชื่อผู้บริหาร")
def get_cgs_executives(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/cgs/{report_year}/executives/{unique_id}")


@router.get("/one-report/cgs/{report_year}/committees/{unique_id}/others",
    summary="คณะกรรมการชุดย่อยอื่นๆ")
def get_cgs_committees_others(report_year: int, unique_id: str):
    return _get("one_report", f"/v1/one-report/cgs/{report_year}/committees/{unique_id}/others")


# ═════════════════════════════════════════════════════════════════════════════
# DIGITAL ASSET v1  — ยังอยู่ระหว่างปรับปรุง
# ═════════════════════════════════════════════════════════════════════════════

@router.get("/digital-asset/intermediary",
    summary="ผู้ประกอบธุรกิจสินทรัพย์ดิจิทัล [under maintenance]")
def get_da_intermediary():
    raise HTTPException(
        status_code=503,
        detail="Digital Asset API (/v1/digital-asset/profile/intermediary) is under "
               "system maintenance by SEC Thailand. Check https://www.sec.or.th for updates.",
    )


# ═════════════════════════════════════════════════════════════════════════════
# FUND v2  — กองทุน
# Pagination: page_size (max 100) + cursor
# Filter:     proj_id (most endpoints); amcs/profiles = pagination only
# ═════════════════════════════════════════════════════════════════════════════

# ── General Info ─────────────────────────────────────────────────────────────

@router.get("/fund/general-info/amcs",
    summary="รายชื่อบริษัทจัดการกองทุน (AMC)")
def get_fund_amcs(
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: unique_id, comp_name_th, comp_name_en, last_upd_date"""
    return _get("fund", "/v2/fund/general-info/amcs", {"page_size": page_size, "cursor": cursor})


@router.get("/fund/general-info/profiles",
    summary="ข้อมูลทั่วไปของกองทุน")
def get_fund_profiles(
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: unique_id, comp_name_th/en, proj_id, regis_id, init_date, cancel_date, proj_name_th/en"""
    return _get("fund", "/v2/fund/general-info/profiles", {"page_size": page_size, "cursor": cursor})


@router.get("/fund/general-info/specifications",
    summary="ข้อมูลประเภทกองทุน (specification)")
def get_fund_specifications(
    proj_id: Optional[str] = Query(None, description="Fund project ID e.g. M0003_2563"),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: proj_id, fund_class_name, spec_code, spec_desc"""
    return _get("fund", "/v2/fund/general-info/specifications", {
        "proj_id": proj_id, "page_size": page_size, "cursor": cursor,
    })


@router.get("/fund/general-info/mutual-fund-fees",
    summary="ค่าธรรมเนียมกองทุนรวม")
def get_fund_mutual_fund_fees(
    proj_id: Optional[str] = Query(None),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: proj_id, fund_class_name, fee_type_desc, rate, rate_unit, fee_other_desc"""
    return _get("fund", "/v2/fund/general-info/mutual-fund-fees", {
        "proj_id": proj_id, "page_size": page_size, "cursor": cursor,
    })


@router.get("/fund/general-info/involve-parties",
    summary="ผู้เกี่ยวข้องกับกองทุน")
def get_fund_involve_parties(
    proj_id: Optional[str] = Query(None),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: proj_id, entity_type, entity_name_th/en, address"""
    return _get("fund", "/v2/fund/general-info/involve-parties", {
        "proj_id": proj_id, "page_size": page_size, "cursor": cursor,
    })


# ── Factsheet ─────────────────────────────────────────────────────────────────

@router.get("/fund/factsheet/urls",
    summary="URL หนังสือชี้ชวนกองทุน")
def get_fund_factsheet_urls(
    proj_id: Optional[str] = Query(None),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: proj_id, fund_class_name, prospectus_type, amc_url_factsheet, pdf_factsheet, as_of_date"""
    return _get("fund", "/v2/fund/factsheet/urls", {
        "proj_id": proj_id, "page_size": page_size, "cursor": cursor,
    })


@router.get("/fund/factsheet/ipos",
    summary="ข้อมูลการเสนอขายครั้งแรก (IPO)")
def get_fund_factsheet_ipos(
    proj_id: Optional[str] = Query(None),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: proj_id, start_date, end_date, prospectus_type, first_sell_start_date, first_sell_end_date"""
    return _get("fund", "/v2/fund/factsheet/ipos", {
        "proj_id": proj_id, "page_size": page_size, "cursor": cursor,
    })


@router.get("/fund/factsheet/benchmarks",
    summary="ดัชนีอ้างอิง (Benchmark)")
def get_fund_factsheet_benchmarks(
    proj_id: Optional[str] = Query(None),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: proj_id, start_date, end_date, prospectus_type, benchmark, benchmark_remark"""
    return _get("fund", "/v2/fund/factsheet/benchmarks", {
        "proj_id": proj_id, "page_size": page_size, "cursor": cursor,
    })


@router.get("/fund/factsheet/subscription-redemption-minimums",
    summary="จำนวนขั้นต่ำการซื้อ/ขายคืนหน่วยลงทุน")
def get_fund_sub_redeem_minimums(
    proj_id: Optional[str] = Query(None),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: proj_id, fund_class_name, prospectus_type, minimum_sub_ipo, minimum_sub_*, minimum_redeem_*"""
    return _get("fund", "/v2/fund/factsheet/subscription-redemption-minimums", {
        "proj_id": proj_id, "page_size": page_size, "cursor": cursor,
    })


@router.get("/fund/factsheet/subscription-redemption-periods",
    summary="รอบการซื้อ/ขายคืนหน่วยลงทุน")
def get_fund_sub_redeem_periods(
    proj_id: Optional[str] = Query(None),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: proj_id, fund_class_name, start_date, end_date, type, period, settlement"""
    return _get("fund", "/v2/fund/factsheet/subscription-redemption-periods", {
        "proj_id": proj_id, "page_size": page_size, "cursor": cursor,
    })


@router.get("/fund/factsheet/risk-spectrum",
    summary="ระดับความเสี่ยงกองทุน")
def get_fund_risk_spectrum(
    proj_id: Optional[str] = Query(None),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: proj_id, start_date, end_date, risk_spectrum (1-8+), risk_spectrum_desc"""
    return _get("fund", "/v2/fund/factsheet/risk-spectrum", {
        "proj_id": proj_id, "page_size": page_size, "cursor": cursor,
    })


@router.get("/fund/factsheet/statistics",
    summary="สถิติกองทุน (turnover ratio ฯลฯ)")
def get_fund_factsheet_statistics(
    proj_id: Optional[str] = Query(None),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: proj_id, fund_class_name, start_date, end_date, portfolio_turnover_ratio, recovering_period"""
    return _get("fund", "/v2/fund/factsheet/statistics", {
        "proj_id": proj_id, "page_size": page_size, "cursor": cursor,
    })


@router.get("/fund/factsheet/dividend-policy",
    summary="นโยบายการจ่ายเงินปันผล")
def get_fund_dividend_policy(
    proj_id: Optional[str] = Query(None),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: proj_id, fund_class_name, start_date, end_date, dividend_policy"""
    return _get("fund", "/v2/fund/factsheet/dividend-policy", {
        "proj_id": proj_id, "page_size": page_size, "cursor": cursor,
    })


@router.get("/fund/factsheet/fees",
    summary="ค่าธรรมเนียม (factsheet)")
def get_fund_factsheet_fees(
    proj_id: Optional[str] = Query(None),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: proj_id, fund_class_name, start_date, end_date, fee_type_desc, rate, actual_value"""
    return _get("fund", "/v2/fund/factsheet/fees", {
        "proj_id": proj_id, "page_size": page_size, "cursor": cursor,
    })


@router.get("/fund/factsheet/performance",
    summary="ผลการดำเนินงานกองทุน")
def get_fund_factsheet_performance(
    proj_id: Optional[str] = Query(None),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: proj_id, fund_class_name, start_date, end_date, performance_type_desc, reference_period"""
    return _get("fund", "/v2/fund/factsheet/performance", {
        "proj_id": proj_id, "page_size": page_size, "cursor": cursor,
    })


@router.get("/fund/factsheet/asset-allocation",
    summary="การจัดสรรสินทรัพย์")
def get_fund_asset_allocation(
    proj_id: Optional[str] = Query(None),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: proj_id, start_date, end_date, asset_seq, asset_name, asset_ratio"""
    return _get("fund", "/v2/fund/factsheet/asset-allocation", {
        "proj_id": proj_id, "page_size": page_size, "cursor": cursor,
    })


@router.get("/fund/factsheet/top5-holdings",
    summary="หลักทรัพย์ 5 อันดับแรก")
def get_fund_top5_holdings(
    proj_id: Optional[str] = Query(None),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: proj_id, start_date, end_date, asset_seq, asset_name, asset_ratio"""
    return _get("fund", "/v2/fund/factsheet/top5-holdings", {
        "proj_id": proj_id, "page_size": page_size, "cursor": cursor,
    })


# ── Outstanding Portfolio ─────────────────────────────────────────────────────

@router.get("/fund/outstanding/portfolio",
    summary="พอร์ตการลงทุนของกองทุน (รายสินทรัพย์)")
def get_fund_portfolio(
    proj_id: Optional[str] = Query(None),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: proj_id, period, as_of_date, assetliab_id, assetliab_desc, issue_code, isin_code, issuer, assetliab_value"""
    return _get("fund", "/v2/fund/outstanding/portfolio", {
        "proj_id": proj_id, "page_size": page_size, "cursor": cursor,
    })


@router.get("/fund/outstanding/portfolio-asset-type",
    summary="พอร์ตการลงทุนรวมตามประเภทสินทรัพย์")
def get_fund_portfolio_asset_type(
    proj_id: Optional[str] = Query(None),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: proj_id, period, assetliab_code, assetliab_desc, market_value, percent_nav"""
    return _get("fund", "/v2/fund/outstanding/portfolio-asset-type", {
        "proj_id": proj_id, "page_size": page_size, "cursor": cursor,
    })


# ── Daily Info ────────────────────────────────────────────────────────────────

@router.get("/fund/daily-info/nav",
    summary="มูลค่าหน่วยลงทุนรายวัน (NAV)")
def get_fund_daily_nav(
    proj_id: Optional[str] = Query(None),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: proj_id, unique_id, fund_class_name, nav_date, net_asset, last_val, sell_price, buy_price"""
    return _get("fund", "/v2/fund/daily-info/nav", {
        "proj_id": proj_id, "page_size": page_size, "cursor": cursor,
    })


@router.get("/fund/daily-info/dividend-history",
    summary="ประวัติการจ่ายเงินปันผล")
def get_fund_dividend_history(
    proj_id: Optional[str] = Query(None),
    page_size: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None),
):
    """Fields: proj_id, unique_id, class_abbr_name, book_close_date, dividend_date, dividend_value"""
    return _get("fund", "/v2/fund/daily-info/dividend-history", {
        "proj_id": proj_id, "page_size": page_size, "cursor": cursor,
    })


# ═════════════════════════════════════════════════════════════════════════════
# HEALTH
# ═════════════════════════════════════════════════════════════════════════════

@router.get("/health")
def sec_v2_health():
    return {
        "gateway": SEC_BASE_URL,
        "portal":  "https://secopendata.sec.or.th/sec-open-apis",
        "keys": {p: "configured" if k else "missing" for p, k in SEC2_KEYS.items()},
        "products": {
            "bond": {
                "status": "working",
                "version": "v2",
                "endpoints": 6,
                "pagination": "cursor-based (page_size max 100)",
            },
            "one_report": {
                "status": "working",
                "version": "v1",
                "endpoints": 23,
                "data_available": "2021 (178 cos), 2022 (770 cos), 2023 (814 cos)",
                "note": "Returns 204 when company has no data for that section",
                "params": {
                    "report_year": "Gregorian year e.g. 2023 (NOT Buddhist Era)",
                    "unique_id": "SEC company_id from sbo/info e.g. C0000000013",
                    "language": "T=Thai  E=English (NOT 1/2)",
                },
            },
            "digital_asset": {"status": "under_maintenance"},
            "fund": {
                "status": "working",
                "version": "v2",
                "endpoints": 21,
                "groups": ["general-info (5)", "factsheet (11)", "outstanding (2)", "daily-info (2)"],
                "pagination": "cursor-based (page_size max 100)",
                "filter": "proj_id (most endpoints); amcs/profiles = pagination only",
            },
        },
    }
