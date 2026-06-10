"""
Layer 1 — IPO Listing Quality Gate.
Screens pre-IPO companies using hard filters + weighted soft scoring.
Input is a JSON body (manual entry — company not yet listed on yfinance).
"""
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter()


# ── Thresholds ────────────────────────────────────────────────────────────────

MAX_GOING_CONCERN_YEARS       = 0
MIN_OCF_POSITIVE_YEARS        = 1
MAX_RELATED_PARTY_REVENUE_PCT = 0.50

MIN_PROFITABLE_YEARS_OF_3     = 2
MIN_FREE_FLOAT_PCT            = 0.15
MIN_MARKET_CAP_USD            = 10_000_000
MIN_INDEPENDENT_DIRECTORS     = 0.33

WEIGHT_PROFITABILITY = 0.30
WEIGHT_CASHFLOW      = 0.25
WEIGHT_GOVERNANCE    = 0.25
WEIGHT_FLOAT         = 0.10
WEIGHT_AUDITOR       = 0.10


# ── Input Schema ──────────────────────────────────────────────────────────────

class ListingScreenRequest(BaseModel):
    company_id:                  str
    company_name:                str
    years_profitable:            List[bool]  = Field(..., min_length=3, max_length=3)
    operating_cashflow:          List[float] = Field(..., min_length=3, max_length=3)
    free_float_pct:              float = Field(..., ge=0, le=1)
    market_cap_usd:              float = Field(..., ge=0)
    independent_directors_ratio: float = Field(..., ge=0, le=1)
    has_audit_committee:         bool
    has_internal_controls:       bool
    auditor_registered:          bool
    going_concern_count:         int   = Field(..., ge=0)
    related_party_revenue_pct:   float = Field(..., ge=0, le=1)
    revenue_history:             Optional[List[float]] = None


# ── Scoring ───────────────────────────────────────────────────────────────────

def _run_hard_filters(req: ListingScreenRequest) -> list[str]:
    """Return list of failed hard filter names (empty = all pass)."""
    fails = []
    if req.going_concern_count > MAX_GOING_CONCERN_YEARS:
        fails.append("going_concern")
    positive_ocf = sum(1 for v in req.operating_cashflow if v > 0)
    if positive_ocf < MIN_OCF_POSITIVE_YEARS:
        fails.append("min_ocf_positive")
    if req.related_party_revenue_pct > MAX_RELATED_PARTY_REVENUE_PCT:
        fails.append("related_party_revenue")
    if not req.auditor_registered:
        fails.append("auditor_registered")
    return fails


def _score_profitability(req: ListingScreenRequest) -> float:
    profitable_count = sum(1 for v in req.years_profitable if v)
    ratio = profitable_count / 3
    return min(ratio / (MIN_PROFITABLE_YEARS_OF_3 / 3), 1.0)


def _score_cashflow(req: ListingScreenRequest) -> float:
    ocf = req.operating_cashflow
    positive_years = sum(1 for v in ocf if v > 0)
    trend_bonus = 0.1 if (len(ocf) == 3 and ocf[2] > ocf[1] > ocf[0]) else 0
    return min((positive_years / 3) + trend_bonus, 1.0)


def _score_governance(req: ListingScreenRequest) -> float:
    dir_score  = min(req.independent_directors_ratio / MIN_INDEPENDENT_DIRECTORS, 1.0)
    audit_score = 1.0 if req.has_audit_committee else 0.0
    ctrl_score  = 1.0 if req.has_internal_controls else 0.0
    return (dir_score * 0.5) + (audit_score * 0.3) + (ctrl_score * 0.2)


def _score_float(req: ListingScreenRequest) -> float:
    return min(req.free_float_pct / MIN_FREE_FLOAT_PCT, 1.0)


def _score_auditor(req: ListingScreenRequest) -> float:
    base    = 1.0 if req.auditor_registered else 0.3
    penalty = req.going_concern_count * 0.5
    return max(base - penalty, 0.0)


def _generate_recommendations(req: ListingScreenRequest, breakdown: dict) -> list[str]:
    recs = []
    if breakdown["profitability"] < 0.67:
        recs.append("Improve profitability track record — target ≥ 2 profitable years out of 3")
    if breakdown["cashflow"] < 0.67:
        recs.append("Strengthen operating cash flow — at least 1 OCF-positive year required; improving trend is a plus")
    if req.independent_directors_ratio < MIN_INDEPENDENT_DIRECTORS:
        recs.append(f"Increase independent directors to ≥ {MIN_INDEPENDENT_DIRECTORS*100:.0f}% of the board")
    if not req.has_audit_committee:
        recs.append("Establish an audit committee before listing")
    if not req.has_internal_controls:
        recs.append("Implement and document internal control systems")
    if req.free_float_pct < MIN_FREE_FLOAT_PCT:
        recs.append(f"Increase public free float to ≥ {MIN_FREE_FLOAT_PCT*100:.0f}%")
    if req.market_cap_usd < MIN_MARKET_CAP_USD:
        recs.append(f"Market cap below minimum threshold of ${MIN_MARKET_CAP_USD:,.0f}")
    return recs


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.post("/api/listing-gate/screen")
def listing_gate_screen(req: ListingScreenRequest):
    """
    Layer 1 — IPO Listing Quality Gate.
    Returns decision (APPROVE / CONDITIONAL / REJECT), composite score 0-100,
    per-dimension breakdown, and hard filter results.
    """
    hard_fails = _run_hard_filters(req)

    scores = {
        "profitability": _score_profitability(req),
        "cashflow":      _score_cashflow(req),
        "governance":    _score_governance(req),
        "float":         _score_float(req),
        "auditor":       _score_auditor(req),
    }

    composite = (
        scores["profitability"] * WEIGHT_PROFITABILITY +
        scores["cashflow"]      * WEIGHT_CASHFLOW +
        scores["governance"]    * WEIGHT_GOVERNANCE +
        scores["float"]         * WEIGHT_FLOAT +
        scores["auditor"]       * WEIGHT_AUDITOR
    ) * 100

    composite = round(composite, 1)

    if hard_fails or composite < 50:
        decision = "REJECT"
    elif composite >= 70:
        decision = "APPROVE"
    else:
        decision = "CONDITIONAL"

    recs = _generate_recommendations(req, scores)

    hard_filter_results = {
        "going_concern":          req.going_concern_count <= MAX_GOING_CONCERN_YEARS,
        "min_ocf_positive":       sum(1 for v in req.operating_cashflow if v > 0) >= MIN_OCF_POSITIVE_YEARS,
        "related_party_revenue":  req.related_party_revenue_pct <= MAX_RELATED_PARTY_REVENUE_PCT,
        "auditor_registered":     req.auditor_registered,
    }

    return {
        "company_id":    req.company_id,
        "company_name":  req.company_name,
        "decision":      decision,
        "score":         composite,
        "score_breakdown": {k: round(v * 100, 1) for k, v in scores.items()},
        "hard_filter_results": hard_filter_results,
        "hard_filter_fails":   hard_fails,
        "recommendations":     recs,
        "as_of":         datetime.utcnow().isoformat() + "Z",
    }
