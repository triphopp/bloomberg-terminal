"""Fund book — `/api/v2/fund/*` (plans/fund-book.md, Step 1).

A pooled fund kept apart from the personal book: its accounts carry
`portfolio_accounts.fund_id` and are read with `account_id=fund:<id>` through
the ordinary portfolio / risk routes (backend/account_scope.py). This router
adds what only a fund has — members, deposits and the units they bought.

    GET  /api/v2/fund                          the funds
    POST /api/v2/fund                          create one
    GET  /api/v2/fund/{id}                     fund + accounts + value + rule
    POST /api/v2/fund/{id}/accounts            a new broker account of the fund
    GET  /api/v2/fund/{id}/members             who holds what (capital and units)
    POST /api/v2/fund/{id}/members
    GET  /api/v2/fund/{id}/nav                 value now, per unit
    GET  /api/v2/fund/{id}/contributions       every deposit and reversal
    POST /api/v2/fund/{id}/contributions       a deposit → units at that day's value
    POST /api/v2/fund/{id}/contributions/preview     the same sums, nothing written
    POST /api/v2/fund/{id}/contributions/{cid}/reverse
    POST /api/v2/fund/{id}/split-rule

Agents may read; every write is the user's (403 for an agent actor). Errors
are `{code, detail}`. Nothing here pays anyone — distributions are Step 4.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import fund as fund_core
from actor import capture_actor, current_actor
from db import get_db
from portfolio_currency import convert_amount

router = APIRouter(prefix="/api/v2/fund", dependencies=[Depends(capture_actor)])


def _refuse(exc: fund_core.FundError):
    raise HTTPException(status_code=exc.status, detail={"code": exc.code, "detail": exc.detail})


def _user_only() -> str:
    actor = current_actor()
    if actor != "user":
        raise HTTPException(status_code=403, detail={
            "code": "user_only", "detail": "Fund money is recorded by the user, not by an agent"})
    return actor


# ── valuation ────────────────────────────────────────────────────────────────

def value_now(fund: dict) -> dict:
    """The fund's value in its base currency, from the same functions PORT
    uses, limited to the fund's accounts: holdings and options at market plus
    cash. `nav` is None when a holding has no price — a value that leaves a
    position out is not a value, and the positions that could not be priced
    are named."""
    from routers.portfolio_v2 import _open_positions_enriched, get_summary

    scope, base = fund_core.scope_of(fund["id"]), fund["base_currency"]
    data = _open_positions_enriched(scope, base)
    holdings, unpriced = Decimal(0), []
    for p in data.get("positions") or []:
        mv = p.get("market_value_base")
        if mv is None:
            unpriced.append(str(p.get("symbol") or ""))
        else:
            holdings += Decimal(str(mv))
    options = Decimal(0)
    for o in data.get("options") or []:
        mv = o.get("market_value_base")
        if mv is None:
            unpriced.append(str(o.get("occ_symbol") or o.get("underlying") or "option"))
        else:
            options += Decimal(str(mv))
    summary = get_summary(base_currency=base, account_id=scope)
    cash = Decimal(str(summary.get("total_cash_base") or 0))
    nav = None if unpriced else holdings + options + cash
    return {"base_currency": base, "holdings": str(holdings), "options": str(options), "cash": str(cash),
            "nav": str(nav) if nav is not None else None, "unpriced": sorted(set(unpriced)),
            "cash_is_estimate": bool(summary.get("cash_is_estimate"))}


def value_on(fund: dict, day: str) -> Optional[Decimal]:
    """The fund's stored value on a past day (holdings + cash, the daily
    snapshot), in its base currency — None when that day was not captured."""
    from routers.portfolio_v2 import get_nav_history

    for row in get_nav_history(fund_core.scope_of(fund["id"]), 100000):
        if str(row.get("snapshot_date") or row.get("date") or "")[:10] == day:
            nav = row.get("nav_with_cash")
            if nav is None:
                return None
            return Decimal(str(convert_amount(float(nav), "THB", fund["base_currency"], date=day)))
    return None


def _nav_for(fund: dict, day: str) -> tuple[Optional[Decimal], str, list[str]]:
    """(value before a deposit dated `day`, how it was obtained, what could not be priced)."""
    if day == date.today().isoformat():
        v = value_now(fund)
        return (Decimal(v["nav"]) if v["nav"] is not None else None), "live", v["unpriced"]
    return value_on(fund, day), "snapshot", []


# ── funds ────────────────────────────────────────────────────────────────────

class FundIn(BaseModel):
    name: str
    base_currency: str = "THB"
    unit_par: str = "10"
    broker_note: str = ""
    agreement_ref: str = ""


class AccountIn(BaseModel):
    id: str
    name: str
    currency: str
    broker: str = ""
    country: str = "TH"
    account_type: str = "equity"


class MemberIn(BaseModel):
    name: str
    contact: str = ""
    joined_on: Optional[str] = None
    note: str = ""


class ContributionIn(BaseModel):
    member_id: str
    account_id: str
    date: str
    amount: str
    currency: Optional[str] = None
    fx_rate: Optional[str] = None        # THB per 1 unit of `currency` on that day
    unit_price: Optional[str] = None     # typed by hand — needs price_reason
    price_reason: str = ""
    evidence_ref: str = ""
    note: str = ""


class ReverseIn(BaseModel):
    reason: str


class SplitRuleIn(BaseModel):
    basis: str
    effective_from: str
    reason: str


@router.get("")
def list_funds():
    with get_db() as conn:
        return {"funds": fund_core.list_funds(conn)}


@router.post("", status_code=201)
def create_fund(body: FundIn):
    _user_only()
    try:
        with get_db() as conn:
            return fund_core.create_fund(conn, **body.model_dump())
    except fund_core.FundError as exc:
        _refuse(exc)


@router.get("/{fund_id}")
def get_fund(fund_id: str):
    try:
        with get_db() as conn:
            fund = fund_core.get_fund(conn, fund_id)
            out = {**fund, "scope": fund_core.scope_of(fund_id),
                   "accounts": fund_core.accounts(conn, fund_id),
                   "split_rule": fund_core.split_rule(conn, fund_id),
                   "units": str(fund_core.units_outstanding(conn, fund_id)),
                   "capital": str(fund_core.capital_total(conn, fund_id))}
    except fund_core.FundError as exc:
        _refuse(exc)
    out["value"] = value_now(fund)
    return out


@router.post("/{fund_id}/accounts", status_code=201)
def add_account(fund_id: str, body: AccountIn):
    _user_only()
    try:
        with get_db() as conn:
            data = body.model_dump()
            return fund_core.add_account(conn, fund_id, account_id=data.pop("id"), **data)
    except fund_core.FundError as exc:
        _refuse(exc)


@router.get("/{fund_id}/accounts")
def list_fund_accounts(fund_id: str):
    try:
        with get_db() as conn:
            fund_core.get_fund(conn, fund_id)
            return {"accounts": fund_core.accounts(conn, fund_id)}
    except fund_core.FundError as exc:
        _refuse(exc)


@router.post("/{fund_id}/split-rule", status_code=201)
def set_split_rule(fund_id: str, body: SplitRuleIn):
    _user_only()
    try:
        with get_db() as conn:
            return fund_core.set_split_rule(conn, fund_id, **body.model_dump())
    except fund_core.FundError as exc:
        _refuse(exc)


# ── members ──────────────────────────────────────────────────────────────────

@router.post("/{fund_id}/members", status_code=201)
def add_member(fund_id: str, body: MemberIn):
    _user_only()
    try:
        with get_db() as conn:
            return fund_core.add_member(conn, fund_id, **body.model_dump())
    except fund_core.FundError as exc:
        _refuse(exc)


@router.get("/{fund_id}/members")
def list_members(fund_id: str):
    try:
        with get_db() as conn:
            fund = fund_core.get_fund(conn, fund_id)
    except fund_core.FundError as exc:
        _refuse(exc)
    value = value_now(fund)
    nav = Decimal(value["nav"]) if value["nav"] is not None else None
    with get_db() as conn:
        out = fund_core.members_view(conn, fund_id, nav)
    out["value"] = value
    return out


@router.get("/{fund_id}/nav")
def get_nav(fund_id: str):
    try:
        with get_db() as conn:
            fund = fund_core.get_fund(conn, fund_id)
            units = fund_core.units_outstanding(conn, fund_id)
            capital = fund_core.capital_total(conn, fund_id)
    except fund_core.FundError as exc:
        _refuse(exc)
    value = value_now(fund)
    nav = Decimal(value["nav"]) if value["nav"] is not None else None
    price = fund_core.unit_price(fund, nav, units)
    return {**value, "units": str(units), "capital": str(capital),
            "unit_price": str(price) if price is not None else None, "unit_par": fund["unit_par"]}


# ── deposits ─────────────────────────────────────────────────────────────────

@router.get("/{fund_id}/contributions")
def list_contributions(fund_id: str, member_id: Optional[str] = None):
    try:
        with get_db() as conn:
            fund_core.get_fund(conn, fund_id)
            rows = fund_core.contributions(conn, fund_id, member_id)
    except fund_core.FundError as exc:
        _refuse(exc)
    return {"total_matching": len(rows), "returned": len(rows), "complete": True, "contributions": rows}


def _contribute(fund_id: str, body: ContributionIn, *, write: bool) -> dict:
    try:
        with get_db() as conn:
            fund = fund_core.get_fund(conn, fund_id)
        day = fund_core._day(body.date)
        nav, source, unpriced = (None, "manual", []) if body.unit_price else _nav_for(fund, day)
        with get_db() as conn:
            if nav is None and not body.unit_price and fund_core.units_outstanding(conn, fund_id, as_of=day) > 0:
                why = (f"no price for {', '.join(unpriced)}" if unpriced
                       else f"no stored value of the fund for {day}")
                raise fund_core.FundError(
                    422, "nav_unknown",
                    f"The deposit cannot be turned into units: {why}. Give unit_price with a reason.")
            row = fund_core.contribute(
                conn, fund_id, member_id=body.member_id, account_id=body.account_id, date=day,
                amount=body.amount, currency=body.currency, fx_rate=body.fx_rate,
                nav_before=str(nav) if nav is not None else None, price_source=source,
                manual_unit_price=body.unit_price, price_reason=body.price_reason,
                evidence_ref=body.evidence_ref, note=body.note, actor=current_actor())
            if not write:
                raise _Preview(row)
            return row
    except _Preview as p:
        return {**p.row, "preview": True}
    except fund_core.FundError as exc:
        _refuse(exc)


class _Preview(Exception):
    """Raised inside the transaction so a preview rolls back everything it wrote."""

    def __init__(self, row: dict):
        self.row = row


@router.post("/{fund_id}/contributions/preview")
def preview_contribution(fund_id: str, body: ContributionIn):
    """What a deposit would record — unit price, where it came from, units — with nothing kept."""
    return _contribute(fund_id, body, write=False)


@router.post("/{fund_id}/contributions", status_code=201)
def add_contribution(fund_id: str, body: ContributionIn):
    _user_only()
    return _contribute(fund_id, body, write=True)


@router.post("/{fund_id}/contributions/{contribution_id}/reverse", status_code=201)
def reverse_contribution(fund_id: str, contribution_id: str, body: ReverseIn):
    _user_only()
    try:
        with get_db() as conn:
            return fund_core.reverse(conn, fund_id, contribution_id, reason=body.reason, actor=current_actor())
    except fund_core.FundError as exc:
        _refuse(exc)
