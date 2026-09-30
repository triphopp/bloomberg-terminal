"""Ledger v2 API (plans/port-ledger-v2.md) — `/api/v2/ledger/*`.

Everything here writes through `ledger.py`; the DB refuses edits and deletes of
posted events, and bookings inside a closed period. Errors come back as
`{code, detail, evidence}` (409 for a closed period / a close that does not
match the broker, 422 for bad input).
"""
from __future__ import annotations

from typing import Optional
from urllib.parse import unquote

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

import ledger
from db import get_db

router = APIRouter(prefix="/api/v2/ledger")


class LedgerCorrectionMiddleware:
    """`X-Ledger-Correction: <url-encoded reason>` → ledger.correction(reason)
    for the request, so a legacy PORT edit that reaches into a closed period
    can be booked today instead of refused."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http":
            for k, v in scope.get("headers") or []:
                if k == b"x-ledger-correction":
                    reason = unquote(v.decode("latin-1")).strip()[:500]
                    with ledger.correction(reason):
                        await self.app(scope, receive, send)
                    return
        await self.app(scope, receive, send)


# ── models ───────────────────────────────────────────────────────────────────
Num = Optional[str | float | int]


class ModeIn(BaseModel):
    mode: str
    reason: str = ""
    cutover: Optional[str] = None
    cutover_at: Optional[str] = None   # the statement's moment, e.g. 2026-09-30T00:54+07:00


class WalletIn(BaseModel):
    account_id: str
    wallet: str
    currency: str
    is_default: bool = False
    note: str = ""
    broker_label: Optional[str] = None


class RuleIn(BaseModel):
    account_id: str
    symbol_pattern: str
    wallet: str
    note: str = ""


class TradeIn(BaseModel):
    account_id: str
    side: str
    symbol: str
    qty: Num
    price: Num
    trade_date: str
    currency: str
    wallet: Optional[str] = None
    fee: Num = 0
    vat: Num = 0
    tax: Num = 0
    fee_basis: Optional[str] = "POSTED"
    multiplier: Num = None
    position_effect: Optional[str] = None
    trade_time: Optional[str] = None
    settle_date: Optional[str] = None
    broker_ref: Optional[str] = None
    evidence_ref: Optional[str] = None
    fx_rate: Num = None
    note: str = ""


class PositionEventIn(BaseModel):
    account_id: str
    type: str
    symbol: str
    qty: Num
    trade_date: str
    currency: str
    wallet: Optional[str] = None
    price: Num = None
    cash: Num = 0
    evidence_ref: Optional[str] = None
    note: str = ""


class CashIn(BaseModel):
    account_id: str
    type: str
    amount: Num
    trade_date: str
    currency: str
    wallet: Optional[str] = None
    symbol: Optional[str] = None
    broker_ref: Optional[str] = None
    evidence_ref: Optional[str] = None
    note: str = ""


class DividendIn(BaseModel):
    account_id: str
    symbol: str
    gross: Num
    wht: Num = 0
    trade_date: str
    currency: str
    wallet: Optional[str] = None
    evidence_ref: Optional[str] = None
    note: str = ""


class TransferIn(BaseModel):
    from_account: str
    to_account: str
    amount: Num
    trade_date: str
    currency: str
    from_wallet: Optional[str] = None
    to_wallet: Optional[str] = None
    evidence_ref: Optional[str] = None
    note: str = ""


class FxIn(BaseModel):
    account_id: str
    trade_date: str
    from_currency: str
    from_amount: Num
    to_currency: str
    to_amount: Num
    from_wallet: Optional[str] = None
    to_wallet: Optional[str] = None
    fee: Num = 0
    broker_ref: Optional[str] = None
    evidence_ref: Optional[str] = None
    note: str = ""


class MoveIn(BaseModel):
    account_id: str
    from_wallet: str
    to_wallet: str
    amount: Num
    trade_date: str
    to_amount: Num = None
    fee: Num = 0
    broker_ref: Optional[str] = None
    evidence_ref: Optional[str] = None
    note: str = ""


class OpeningIn(BaseModel):
    account_id: str
    trade_date: str
    currency: str
    evidence_ref: str
    amount: Num = None
    symbol: Optional[str] = None
    qty: Num = None
    price: Num = None
    wallet: Optional[str] = None
    note: str = ""


class AdjustIn(BaseModel):
    account_id: str
    trade_date: str
    currency: str
    amount: Num
    category: str
    note: str
    wallet: Optional[str] = None
    evidence_ref: Optional[str] = None


class ReverseIn(BaseModel):
    reason: str
    evidence_ref: Optional[str] = None


class FeeTrueupIn(BaseModel):
    posted_fee: Num
    evidence_ref: Optional[str] = None
    trade_date: Optional[str] = None
    note: str = ""


class CloseIn(BaseModel):
    account_id: str
    wallet: str
    as_of: str
    statement_balance: Num = None
    statement_id: Optional[str] = None
    source_ref: Optional[str] = None
    note: str = ""


class ReopenIn(BaseModel):
    account_id: str
    wallet: str
    reason: str = Field(min_length=1)
    reopen_to: Optional[str] = None


class ProjectIn(BaseModel):
    correction_reason: Optional[str] = None
    dry_run: bool = False


def _write(fn):
    with get_db() as conn:
        return fn(conn)


# ── accounts / wallets ───────────────────────────────────────────────────────
@router.get("/accounts")
def list_accounts():
    with get_db() as conn:
        out = []
        for a in conn.execute("SELECT id, name, currency, ledger_mode, ledger_cutover, ledger_cutover_at FROM portfolio_accounts "
                              "ORDER BY name"):
            item = {**dict(a), "wallets": ledger.wallets(conn, a["id"]),
                    "balances": ledger.balances(conn, a["id"]), "rules": ledger.wallet_rules(conn, a["id"])}
            if a["ledger_mode"] != "LEGACY":
                p = ledger.pilot(conn, a["id"])
                item["matched"] = p["matched"]
                item["agreed"] = {w["wallet"]: {"as_of": w.get("statement_as_of"),
                                                "difference": w.get("difference")} for w in p["wallets"]}
            out.append(item)
        return {"accounts": out}


@router.put("/accounts/{account_id}/mode")
def set_mode(account_id: str, body: ModeIn):
    return _write(lambda c: ledger.set_mode(c, account_id, body.mode, body.reason, body.cutover, body.cutover_at))


@router.put("/wallets")
def set_wallet(body: WalletIn):
    return _write(lambda c: ledger.set_wallet(c, body.account_id, body.wallet, body.currency,
                                              body.is_default, body.note, body.broker_label))


@router.get("/wallet-rules")
def list_rules(account_id: Optional[str] = None):
    with get_db() as conn:
        return {"rules": ledger.wallet_rules(conn, account_id)}


@router.put("/wallet-rules")
def put_rule(body: RuleIn):
    return _write(lambda c: ledger.set_wallet_rule(c, body.account_id, body.symbol_pattern, body.wallet, body.note))


@router.delete("/wallet-rules/{rule_id}")
def delete_rule(rule_id: str):
    return _write(lambda c: ledger.delete_wallet_rule(c, rule_id))


@router.get("/route")
def route(account_id: str, currency: str, symbol: Optional[str] = None, label: Optional[str] = None,
          wallet: Optional[str] = None):
    """Which wallet ENTRY should preselect — and the choices in that currency."""
    with get_db() as conn:
        m = ledger.mode(conn, account_id)
        ccy = currency.upper()
        choices = [w for w in ledger.wallets(conn, account_id) if w["currency"] == ccy]
        if m == "LEGACY":
            return {"mode": m, "wallet": None, "reason": "ledger off", "choices": choices}
        return {"mode": m, **ledger.route_wallet(conn, account_id, ccy, symbol=symbol, wallet=wallet,
                                                 broker_label=label), "choices": choices}


# ── reading ──────────────────────────────────────────────────────────────────
@router.get("/events")
def list_events(account_id: Optional[str] = None, wallet: Optional[str] = None,
                date_from: Optional[str] = None, date_to: Optional[str] = None,
                limit: int = Query(200, ge=1, le=5000)):
    with get_db() as conn:
        return {"events": ledger.events(conn, account_id, wallet=wallet, date_from=date_from,
                                        date_to=date_to, limit=limit)}


@router.get("/balances")
def get_balances(account_id: Optional[str] = None, as_of: Optional[str] = None):
    with get_db() as conn:
        return {"as_of": as_of, "balances": ledger.balances(conn, account_id, as_of)}


@router.get("/positions/{account_id}")
def get_positions(account_id: str, as_of: Optional[str] = None):
    with get_db() as conn:
        return {"account_id": account_id, "positions": ledger.positions(conn, account_id, as_of)}


@router.get("/check")
def run_check(account_id: Optional[str] = None, stale_fee_days: int = 7):
    with get_db() as conn:
        return ledger.check(conn, account_id, stale_fee_days=stale_fee_days)


@router.get("/pilot/{account_id}")
def run_pilot(account_id: str, as_of: Optional[str] = None):
    with get_db() as conn:
        return ledger.pilot(conn, account_id, as_of)


@router.get("/closes")
def list_closes(account_id: Optional[str] = None):
    with get_db() as conn:
        return {"closes": ledger.closes(conn, account_id)}


# ── posting ──────────────────────────────────────────────────────────────────
@router.post("/events/trade", status_code=201)
def post_trade(body: TradeIn):
    return _write(lambda c: ledger.post_trade(c, **body.model_dump()))


@router.post("/events/position", status_code=201)
def post_position(body: PositionEventIn):
    return _write(lambda c: ledger.post_position_event(c, **body.model_dump()))


@router.post("/events/cash", status_code=201)
def post_cash(body: CashIn):
    return _write(lambda c: ledger.post_cash(c, **body.model_dump()))


@router.post("/events/dividend", status_code=201)
def post_dividend(body: DividendIn):
    return {"events": _write(lambda c: ledger.post_dividend(c, **body.model_dump()))}


@router.post("/events/transfer", status_code=201)
def post_transfer(body: TransferIn):
    return {"events": _write(lambda c: ledger.post_transfer(c, **body.model_dump()))}


@router.post("/events/fx-convert", status_code=201)
def post_fx(body: FxIn):
    return {"events": _write(lambda c: ledger.post_fx_convert(c, **body.model_dump()))}


@router.post("/events/move", status_code=201)
def move(body: MoveIn):
    """Between two wallets of one account: transfer, or FX conversion if the currencies differ."""
    return {"events": _write(lambda c: ledger.move_between_wallets(c, **body.model_dump()))}


@router.post("/events/opening", status_code=201)
def post_opening(body: OpeningIn):
    return _write(lambda c: ledger.post_opening(c, **body.model_dump()))


@router.post("/events/adjust", status_code=201)
def post_adjust(body: AdjustIn):
    return _write(lambda c: ledger.post_adjust(c, **body.model_dump()))


@router.post("/events/{event_id}/reverse", status_code=201)
def reverse(event_id: str, body: ReverseIn):
    return {"events": _write(lambda c: ledger.reverse(c, event_id, body.reason,
                                                      evidence_ref=body.evidence_ref))}


@router.post("/events/{event_id}/fee-trueup", status_code=201)
def fee_trueup(event_id: str, body: FeeTrueupIn):
    return _write(lambda c: ledger.fee_trueup(c, event_id, body.posted_fee, evidence_ref=body.evidence_ref,
                                              trade_date=body.trade_date, note=body.note))


# ── periods / projection ─────────────────────────────────────────────────────
@router.post("/close", status_code=201)
def close(body: CloseIn):
    return _write(lambda c: ledger.close_period(c, **body.model_dump()))


@router.post("/reopen", status_code=201)
def reopen(body: ReopenIn):
    return _write(lambda c: ledger.reopen_period(c, **body.model_dump()))


@router.post("/project/{account_id}")
def project(account_id: str, body: ProjectIn):
    def run(c):
        if ledger.mode(c, account_id) != "SHADOW":
            raise ledger.LedgerError("LEDGER_NOT_SHADOW", f"{account_id} is not in SHADOW mode")
        return ledger.project(c, account_id, correction_reason=body.correction_reason, dry_run=body.dry_run)
    return _write(run)
