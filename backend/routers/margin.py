"""
MARGIN — IBKR Reg T maintenance status per account, PORT and PAPER.

    GET  /api/v2/portfolio/margin/status?scope=port|paper&account_id=X
    GET  /api/v2/portfolio/margin/overview        every enabled account, worst first
    GET  /api/v2/portfolio/margin/settings?scope=&account_id=
    PUT  /api/v2/portfolio/margin/settings        body: MarginSettingsIn

The model lives in backend/margin.py (pure); this module only builds the
`Book` — cash + stock lines + option lines, all in the ACCOUNT currency — from
the same valuation the rest of PORT / PAPER uses:
  PORT   open lots  → routers.portfolio_v2._open_positions_enriched
         cash       → routers.portfolio_v2.get_summary (derived + reconciled;
                      an ESTIMATE until the account is reconciled — flagged)
  PAPER  positions  → paper_positions @ live price, cash → paper _get_cash
         options    → paper_option_positions valued by portfolio_options
PAPER orders also go through `paper_check()` when margin is enabled there.
"""
from __future__ import annotations

import json
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

import margin as mg
from db import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v2/portfolio/margin")

SCOPES = ("port", "paper")


# ── settings ────────────────────────────────────────────────────────────────

def load_settings(conn, scope: str, account_id: str) -> tuple[bool, mg.Settings, dict]:
    row = conn.execute(
        "SELECT * FROM margin_settings WHERE scope = ? AND account_id = ?", (scope, account_id)
    ).fetchone()
    if not row:
        st = mg.Settings()
        return False, st, _settings_out(scope, account_id, False, st)
    try:
        overrides = {str(k).upper(): float(v) for k, v in json.loads(row["overrides_json"] or "{}").items()}
    except (ValueError, TypeError):
        overrides = {}
    try:
        th = {**mg.DEFAULT_THRESHOLDS, **{k: float(v) for k, v in json.loads(row["thresholds_json"] or "{}").items()
                                          if k in mg.DEFAULT_THRESHOLDS}}
    except (ValueError, TypeError):
        th = dict(mg.DEFAULT_THRESHOLDS)
    st = mg.Settings(maint_long=row["maint_long"], maint_short=row["maint_short"],
                     initial=row["initial"], overrides=overrides, thresholds=th)
    return bool(row["enabled"]), st, _settings_out(scope, account_id, bool(row["enabled"]), st)


def _settings_out(scope: str, account_id: str, enabled: bool, st: mg.Settings) -> dict:
    return {"scope": scope, "account_id": account_id, "enabled": enabled,
            "maint_long": st.maint_long, "maint_short": st.maint_short, "initial": st.initial,
            "overrides": st.overrides, "thresholds": st.thresholds}


class MarginSettingsIn(BaseModel):
    scope: str
    account_id: str
    enabled: bool = True
    maint_long: float = 0.25
    maint_short: float = 0.30
    initial: float = 0.50
    overrides: dict[str, float] = {}
    thresholds: dict[str, float] = {}


def _account_exists(conn, scope: str, account_id: str) -> Optional[dict]:
    table = "portfolio_accounts" if scope == "port" else "paper_accounts"
    row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (account_id,)).fetchone()
    return dict(row) if row else None


@router.get("/settings")
def get_settings(scope: str = Query(...), account_id: str = Query(...)):
    _check_scope(scope)
    with get_db() as conn:
        return load_settings(conn, scope, account_id)[2]


@router.put("/settings")
def put_settings(body: MarginSettingsIn):
    _check_scope(body.scope)
    for name in ("maint_long", "maint_short", "initial"):
        v = getattr(body, name)
        if not 0 < v <= 1:
            raise HTTPException(400, f"{name} must be in (0, 1]")
    overrides = {}
    for sym, rate in body.overrides.items():
        if not 0 < float(rate) <= 1:
            raise HTTPException(400, f"override for {sym} must be in (0, 1]")
        overrides[sym.strip().upper()] = float(rate)
    th = {k: float(v) for k, v in body.thresholds.items() if k in mg.DEFAULT_THRESHOLDS}
    merged = {**mg.DEFAULT_THRESHOLDS, **th}
    if not merged["WATCH"] > merged["WARNING"] > merged["DANGER"] >= 0:
        raise HTTPException(400, "thresholds must satisfy WATCH > WARNING > DANGER ≥ 0")
    with get_db() as conn:
        acc = _account_exists(conn, body.scope, body.account_id)
        if not acc:
            raise HTTPException(404, "Account not found")
        # UPDATE-then-INSERT, not an UPSERT: an UPSERT's conflict policy
        # overrides the `INSERT OR IGNORE INTO sync_pending` inside the op-log
        # capture triggers (sync/oplog.py), so the second save of a row still
        # pending flush failed with UNIQUE(sync_pending) — reports/sqlite-upsert-oplog-risk-report.md.
        vals = (int(body.enabled), body.maint_long, body.maint_short, body.initial,
                json.dumps(overrides), json.dumps(merged))
        cur = conn.execute(
            "UPDATE margin_settings SET enabled = ?, maint_long = ?, maint_short = ?, initial = ?, "
            "overrides_json = ?, thresholds_json = ? WHERE scope = ? AND account_id = ?",
            (*vals, body.scope, body.account_id),
        )
        if cur.rowcount == 0:
            conn.execute(
                "INSERT INTO margin_settings (enabled, maint_long, maint_short, initial, overrides_json, "
                "thresholds_json, scope, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (*vals, body.scope, body.account_id),
            )
        # A real account on margin may run negative cash — the accounting
        # checks (accounting_checks H2, statements) key off account_type.
        if body.scope == "port" and body.enabled and acc.get("account_type") in (None, "", "equity"):
            conn.execute("UPDATE portfolio_accounts SET account_type = 'margin' WHERE id = ?",
                         (body.account_id,))
        return load_settings(conn, body.scope, body.account_id)[2]


def _check_scope(scope: str) -> None:
    if scope not in SCOPES:
        raise HTTPException(400, "scope must be 'port' or 'paper'")


# ── book builders ───────────────────────────────────────────────────────────

def _option_lines(valued: list[dict], ccy: str, ref_key: str = "id") -> tuple[list[mg.OptionLine], list[str]]:
    from portfolio_currency import convert_amount
    lines, missing = [], []
    for o in valued:
        if o.get("expired"):
            continue
        fx = convert_amount(1.0, o.get("currency") or "USD", ccy)
        spot = o.get("spot")
        if not spot:
            missing.append(f"{o.get('symbol')}: no spot")
        lines.append(mg.OptionLine(
            underlying=str(o.get("underlying") or "").upper(),
            symbol=str(o.get("symbol") or ""),
            option_type=str(o.get("option_type") or "call"),
            strike=float(o.get("strike") or 0) * fx,
            expiry=str(o.get("expiry") or "")[:10],
            qty=float(o.get("quantity") or 0),
            mult=float(o.get("multiplier") or 100),
            mark=float(o.get("mark") or 0) * fx,
            spot=float(spot) * fx if spot else None,
            ref=str(o.get(ref_key) or ""),
        ))
    return lines, missing


def port_book(account_id: str) -> tuple[mg.Book, dict]:
    from portfolio_currency import convert_amount, report_currency
    from routers.portfolio_v2 import _open_positions_enriched, get_summary

    with get_db() as conn:
        acc = _account_exists(conn, "port", account_id)
    if not acc:
        raise HTTPException(404, "Account not found")
    ccy = report_currency(acc.get("currency") or "USD")

    data = _open_positions_enriched(account_id, ccy)
    agg: dict[str, dict] = {}
    missing: list[str] = []
    for p in data.get("positions", []):
        key = str(p.get("yf_symbol") or p.get("resolved_symbol") or p.get("symbol") or "").upper()
        price = p.get("current_price")
        if not key:
            continue
        if not price:
            missing.append(f"{p.get('symbol')}: no price")
            continue
        pos_ccy = p.get("pos_currency") or ccy
        a = agg.setdefault(key, {"qty": 0.0, "price": float(price) * convert_amount(1.0, pos_ccy, ccy),
                                 "symbol": p.get("symbol") or key, "usd": pos_ccy == "USD"})
        a["qty"] += float(p.get("volume") or 0)
    stocks = [mg.StockLine(k, a["symbol"], a["qty"], a["price"], a["usd"], k) for k, a in agg.items() if a["qty"]]
    options, opt_missing = _option_lines(data.get("options") or [], ccy)

    summary = get_summary(base_currency=ccy)
    row = next((a for a in summary.get("accounts", []) if a["account"]["id"] == account_id), None)
    cash = float(row["cash_base"]) if row else 0.0
    meta = {
        "scope": "port", "account_id": account_id, "name": acc.get("name"),
        "broker": acc.get("broker"), "currency": ccy,
        "cash_is_estimate": not (row and row.get("cash_reconciled_at")),
        "cash_reconciled_at": row.get("cash_reconciled_at") if row else None,
        "missing": missing + opt_missing,
    }
    return mg.Book(cash, stocks, options), meta


def paper_book(account_id: str) -> tuple[mg.Book, dict]:
    from portfolio_options import value_option_rows
    from routers.paper_trading import _batch_prices, _get_cash, _get_positions_from_db, _open_option_rows

    with get_db() as conn:
        acc = _account_exists(conn, "paper", account_id)
        if not acc:
            raise HTTPException(404, "Account not found")
        positions = _get_positions_from_db(conn, account_id)
        cash = _get_cash(conn, account_id)
        opt_rows = _open_option_rows(conn, account_id)
    ccy = acc.get("currency") or "USD"
    prices = _batch_prices([p["symbol"] for p in positions]) if positions else {}
    stocks, missing = [], []
    for p in positions:
        px = prices.get(p["symbol"])
        if not px:
            missing.append(f"{p['symbol']}: no price")
            px = p["avg_cost"]
        sym = p["symbol"].upper()
        stocks.append(mg.StockLine(sym, sym, float(p["quantity"]), float(px), ccy == "USD", sym))
    valued = value_option_rows(opt_rows, "USD", with_greeks=False) if opt_rows else []
    options, opt_missing = _option_lines(valued, "USD")
    meta = {"scope": "paper", "account_id": account_id, "name": acc.get("name"), "broker": "PAPER",
            "currency": ccy, "cash_is_estimate": False, "cash_reconciled_at": None,
            "missing": missing + opt_missing}
    return mg.Book(cash, stocks, options), meta


def build_book(scope: str, account_id: str) -> tuple[mg.Book, dict]:
    return port_book(account_id) if scope == "port" else paper_book(account_id)


# ── status ──────────────────────────────────────────────────────────────────

def _round(v):
    if isinstance(v, float):
        return round(v, 6)
    if isinstance(v, dict):
        return {k: _round(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_round(x) for x in v]
    return v


def status(scope: str, account_id: str) -> dict:
    with get_db() as conn:
        enabled, st, settings = load_settings(conn, scope, account_id)
        acc = _account_exists(conn, scope, account_id)
    if not acc:
        raise HTTPException(404, "Account not found")
    if not enabled:
        return {"enabled": False, "scope": scope, "account_id": account_id,
                "name": acc.get("name"), "settings": settings}
    book, meta = build_book(scope, account_id)
    res = mg.analyse(book, st)
    return _round({"enabled": True, **meta, **res, "settings": settings})


@router.get("/status")
def get_status(scope: str = Query("port"), account_id: str = Query(...)):
    _check_scope(scope)
    return status(scope, account_id)


def enabled_accounts() -> list[tuple[str, str]]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT m.scope, m.account_id FROM margin_settings m "
            "LEFT JOIN portfolio_accounts p ON m.scope = 'port' AND p.id = m.account_id "
            "LEFT JOIN paper_accounts q ON m.scope = 'paper' AND q.id = m.account_id "
            "WHERE m.enabled = 1 AND (p.id IS NOT NULL AND COALESCE(p.is_active, 1) = 1 OR q.id IS NOT NULL)"
        ).fetchall()
    return [(r["scope"], r["account_id"]) for r in rows]


def overview() -> dict:
    out = []
    for scope, aid in enabled_accounts():
        try:
            s = status(scope, aid)
        except Exception as e:  # noqa: BLE001 — one bad account must not blank the ribbon
            logger.warning("margin status failed for %s:%s: %s", scope, aid, e)
            out.append({"scope": scope, "account_id": aid, "level": None, "error": str(e)})
            continue
        out.append({k: s.get(k) for k in (
            "scope", "account_id", "name", "currency", "level", "cushion", "excess_liquidity",
            "available_funds", "nlv", "maint_margin", "loan", "drop_to_call",
            "rise_to_call", "restricted", "uses_margin", "cash_is_estimate")})
    ranked = [a for a in out if a.get("level")]
    worst = max(ranked, key=lambda a: mg.LEVEL_RANK[a["level"]], default=None)
    out.sort(key=lambda a: -mg.LEVEL_RANK.get(a.get("level") or "SAFE", 0))
    return {"accounts": out, "worst": worst["level"] if worst else None}


@router.get("/overview")
def get_overview():
    return overview()


# ── PAPER pre-trade check ───────────────────────────────────────────────────

def paper_enabled(account_id: str) -> bool:
    with get_db() as conn:
        return load_settings(conn, "paper", account_id)[0]


def paper_check(account_id: str, *, stock: Optional[mg.StockLine] = None,
                option: Optional[mg.OptionLine] = None, cash_delta: float = 0.0) -> Optional[str]:
    """None when the fill keeps Available Funds ≥ 0 (IBKR accepts the order),
    else the rejection text. Closing trades never reach here."""
    with get_db() as conn:
        _, st, _ = load_settings(conn, "paper", account_id)
    book, _ = paper_book(account_id)
    before = mg.evaluate(book, st, detail=False)
    after = mg.evaluate(mg.with_trade(book, stock=stock, option=option, cash_delta=cash_delta), st, detail=False)
    if after["available_funds"] < 0 and after["available_funds"] < before["available_funds"]:
        return (f"Insufficient margin (Reg T): available funds after this order "
                f"{after['available_funds']:,.2f} (now {before['available_funds']:,.2f}), "
                f"initial margin {after['initial_margin']:,.2f} vs ELV {after['elv']:,.2f}")
    return None
