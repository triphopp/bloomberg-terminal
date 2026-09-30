"""Posting service for the append-only journal (plans/port-ledger-v2.md).

The legacy book derives cash as `invested + realized + dividends − open cost +
Σ EDIT`, so an edit to any old row silently moves today's cash, and the EDIT
offsets that pin it back to the broker hide why. Here cash is the sum of posted
events — nothing else — and nothing posted is ever changed:

* every amount is a Decimal, stored as a canonical string, rounded to the
  currency's minor unit where it is money (`net_cash`);
* cash lives in a wallet (Dime: USD, FCD, THB saving) — a conversion is two
  linked FX_CONVERT legs, never one row with two currencies;
* a mistake is a REVERSAL plus a new event. Inside a closed period (a wallet's
  balance agreed with a broker statement) the pair is booked today with a
  stated reason, so the agreed balance never moves;
* SHADOW accounts: `project()` turns the legacy tables into events after every
  write (db.get_db → flush_dirty), reversing what changed.

Errors are `LedgerError` with a `code`; the router maps them to HTTP.
"""
from __future__ import annotations

import contextvars
import fnmatch
import hashlib
import json
import re
import sqlite3
import uuid
from collections import defaultdict
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Iterable, Optional

_NS = uuid.UUID("0b7d6a3e-5c1f-4e8a-9d2b-7a4c3e1f9b60")

# Minor unit per currency. Anything unlisted is 2 dp.
MINOR = {"JPY": 0, "KRW": 0, "BTC": 8, "ETH": 8, "USDT": 6, "USDC": 6}

CASH_SIGN = {  # cash-only event types: the sign a positive amount takes
    "DEPOSIT": 1, "INTEREST": 1, "WITHDRAW": -1, "FEE": -1, "WHT": -1,
}
TRADE_TYPES = ("BUY", "SELL")
POSITION_TYPES = ("OPTION_EXPIRE", "ASSIGN", "EXERCISE", "SPLIT")
PROJECTED_SOURCES = ("SHADOW", "BACKFILL", "BACKFILL_ESTIMATE")
ADJUST_CATEGORIES = ("DATA_FIX", "FEE", "FX_REVALUATION", "INTEREST", "BROKER_CORRECTION",
                     "OPENING_DIFF", "OTHER")


class LedgerError(ValueError):
    status = 422

    def __init__(self, code: str, message: str, evidence: Optional[dict] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.evidence = evidence or {}

    def as_dict(self) -> dict:
        return {"code": self.code, "detail": self.message, "evidence": self.evidence}


class PeriodClosed(LedgerError):
    status = 409


class CloseMismatch(LedgerError):
    status = 409


# ── correction context ───────────────────────────────────────────────────────
# A legacy edit that reaches into a closed period is allowed only with a
# stated reason. The router sets it from the X-Ledger-Correction header.
_correction: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "ledger_correction", default=None)


@contextmanager
def correction(reason: Optional[str]):
    token = _correction.set((reason or "").strip() or None)
    try:
        yield
    finally:
        _correction.reset(token)


def current_correction() -> Optional[str]:
    return _correction.get()


# ── numbers ──────────────────────────────────────────────────────────────────
def D(v) -> Optional[Decimal]:
    if v is None or v == "":
        return None
    if isinstance(v, Decimal):
        return v
    try:
        # str() first: Decimal(0.1) is 0.1000000000000000055…, str(0.1) is 0.1
        return Decimal(str(v))
    except (InvalidOperation, ValueError) as exc:
        raise LedgerError("LEDGER_BAD_NUMBER", f"not a number: {v!r}") from exc


def Z(v) -> Decimal:
    return D(v) or Decimal(0)


def txt(v) -> Optional[str]:
    """Canonical decimal string: no exponent, no trailing zeros, no -0."""
    d = D(v)
    if d is None:
        return None
    if d == 0:
        return "0"
    s = format(d.normalize(), "f")
    return s


def minor(ccy: str) -> int:
    return MINOR.get((ccy or "").upper(), 2)


def money(v, ccy: str) -> Decimal:
    q = Decimal(1).scaleb(-minor(ccy))
    return Z(v).quantize(q, rounding=ROUND_HALF_UP)


def _today() -> str:
    return date.today().isoformat()


def _now_ms() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")[:23]


def _day(v) -> str:
    s = str(v or "")[:10]
    try:
        date.fromisoformat(s)
    except ValueError as exc:
        raise LedgerError("LEDGER_BAD_DATE", f"not a date: {v!r}") from exc
    return s


def _eid(key: str) -> str:
    return str(uuid.uuid5(_NS, key))


# ── accounts, wallets, periods ───────────────────────────────────────────────
def account(conn, account_id: str) -> dict:
    row = conn.execute("SELECT * FROM portfolio_accounts WHERE id = ?", (account_id,)).fetchone()
    if not row:
        raise LedgerError("LEDGER_UNKNOWN_ACCOUNT", f"unknown account {account_id!r}")
    return dict(row)


def mode(conn, account_id: str) -> str:
    return str(account(conn, account_id).get("ledger_mode") or "LEGACY")


def wallets(conn, account_id: str) -> list[dict]:
    """Declared wallets plus any wallet an event already uses."""
    out = {r["wallet"]: dict(r) for r in conn.execute(
        "SELECT * FROM ledger_wallets WHERE account_id = ? ORDER BY wallet", (account_id,))}
    for r in conn.execute("SELECT DISTINCT wallet, currency FROM ledger_events WHERE account_id = ?",
                          (account_id,)):
        out.setdefault(r["wallet"], {"account_id": account_id, "wallet": r["wallet"],
                                     "currency": r["currency"], "is_default": 0, "note": "",
                                     "implicit": True})
    return sorted(out.values(), key=lambda w: w["wallet"])


def set_wallet(conn, account_id: str, wallet: str, currency: str, is_default: bool = False,
               note: str = "", broker_label: Optional[str] = None) -> dict:
    account(conn, account_id)
    wallet, currency = (wallet or "").strip().upper(), (currency or "").strip().upper()
    if not wallet or not currency:
        raise LedgerError("LEDGER_BAD_WALLET", "wallet and currency are required")
    used = conn.execute("SELECT DISTINCT currency FROM ledger_events WHERE account_id = ? AND wallet = ?",
                        (account_id, wallet)).fetchall()
    if any(r["currency"] != currency for r in used):
        raise LedgerError("LEDGER_BAD_WALLET",
                          f"wallet {wallet} already holds {used[0]['currency']} events")
    if is_default:
        conn.execute("UPDATE ledger_wallets SET is_default = 0 WHERE account_id = ? AND currency = ? "
                     "AND wallet <> ?", (account_id, currency, wallet))
    label = (broker_label or "").strip() or None
    # UPDATE-then-INSERT, not an UPSERT: an UPSERT's conflict clause overrides
    # the OR IGNORE inside the op-log capture trigger, so re-saving a row that
    # is still waiting to sync fails on sync_pending's key.
    vals = (currency, 1 if is_default else 0, note or "", label, _now_ms())
    if not conn.execute("UPDATE ledger_wallets SET currency = ?, is_default = ?, note = ?, broker_label = ?, "
                        "updated_at = ? WHERE account_id = ? AND wallet = ?", (*vals, account_id, wallet)).rowcount:
        conn.execute("INSERT INTO ledger_wallets (currency, is_default, note, broker_label, updated_at, "
                     "account_id, wallet) VALUES (?,?,?,?,?,?,?)", (*vals, account_id, wallet))
    return {"account_id": account_id, "wallet": wallet, "currency": currency,
            "is_default": bool(is_default), "note": note or "", "broker_label": label}


# ── routing: which wallet an entry settles in ────────────────────────────────
def _label_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def wallet_rules(conn, account_id: Optional[str] = None) -> list[dict]:
    sql, args = "SELECT * FROM ledger_wallet_rules", ()
    if account_id:
        sql += " WHERE account_id = ?"
        args = (account_id,)
    return [dict(r) for r in conn.execute(sql + " ORDER BY account_id, symbol_pattern", args)]


def set_wallet_rule(conn, account_id: str, symbol_pattern: str, wallet: str, note: str = "") -> dict:
    account(conn, account_id)
    pat = (symbol_pattern or "").strip().upper()
    if not pat:
        raise LedgerError("LEDGER_BAD_RULE", "symbol pattern is required (e.g. GC=F or MTS-*)")
    w = (wallet or "").strip().upper()
    wallet_currency(conn, account_id, w)  # must exist
    rid = _eid(f"rule|{account_id}|{pat}")
    if not conn.execute("UPDATE ledger_wallet_rules SET wallet = ?, note = ?, updated_at = ? WHERE id = ?",
                        (w, note or "", _now_ms(), rid)).rowcount:  # not an UPSERT: see set_wallet
        conn.execute("INSERT INTO ledger_wallet_rules (id, account_id, symbol_pattern, wallet, note, updated_at) "
                     "VALUES (?,?,?,?,?,?)", (rid, account_id, pat, w, note or "", _now_ms()))
    return {"id": rid, "account_id": account_id, "symbol_pattern": pat, "wallet": w, "note": note or ""}


def delete_wallet_rule(conn, rule_id: str) -> dict:
    n = conn.execute("DELETE FROM ledger_wallet_rules WHERE id = ?", (rule_id,)).rowcount
    if not n:
        raise LedgerError("LEDGER_UNKNOWN_RULE", f"no rule {rule_id}")
    return {"deleted": rule_id}


def route_wallet(conn, account_id: str, currency: str, *, symbol: Optional[str] = None,
                 wallet: Optional[str] = None, broker_label: Optional[str] = None) -> dict:
    """The wallet an entry settles in, and why.

    1. typed by the user  2. the slip's payment/receiving account  3. a rule
    for the symbol  4. the currency's default wallet. A candidate in another
    currency is skipped (a USD trade cannot settle in the THB wallet)."""
    currency = (currency or "").upper()
    if wallet:
        return {"wallet": wallet_for(conn, account_id, currency, wallet), "reason": "chosen"}
    ws = wallets(conn, account_id)
    if broker_label:
        key = _label_key(broker_label)
        for w in ws:
            lab = _label_key(w.get("broker_label") or "")
            if lab and (lab in key or key in lab) and w["currency"] == currency:
                return {"wallet": w["wallet"], "reason": f"slip: {broker_label}"}
    if symbol:
        sym = symbol.strip().upper()
        cur = {w["wallet"]: w["currency"] for w in ws}
        for r in wallet_rules(conn, account_id):
            if fnmatch.fnmatchcase(sym, r["symbol_pattern"]) and cur.get(r["wallet"]) == currency:
                return {"wallet": r["wallet"], "reason": f"rule: {r['symbol_pattern']} → {r['wallet']}"}
    return {"wallet": wallet_for(conn, account_id, currency), "reason": "default"}


def entry_wallet(conn, account_id: str, currency: str, symbol: Optional[str] = None,
                 given: Optional[str] = None, broker_label: Optional[str] = None) -> Optional[str]:
    """What a legacy write stores in its wallet column: nothing for a LEGACY
    account (unless typed), otherwise the routed wallet — fixed at entry so a
    later rule change never moves a booked trade."""
    if not given and not broker_label and mode(conn, account_id) == "LEGACY":
        return None
    return route_wallet(conn, account_id, currency, symbol=symbol, wallet=given,
                        broker_label=broker_label)["wallet"]


def wallet_for(conn, account_id: str, currency: str, wallet: Optional[str] = None) -> str:
    """The wallet an event in `currency` lands in."""
    currency = (currency or "").upper()
    if wallet:
        wallet = wallet.strip().upper()
        row = conn.execute("SELECT currency FROM ledger_wallets WHERE account_id = ? AND wallet = ?",
                           (account_id, wallet)).fetchone()
        have = row["currency"] if row else None
        if have is None:
            used = conn.execute("SELECT currency FROM ledger_events WHERE account_id = ? AND wallet = ? "
                                "LIMIT 1", (account_id, wallet)).fetchone()
            have = used["currency"] if used else (wallet if wallet == currency else None)
        if have is None:
            raise LedgerError("LEDGER_BAD_WALLET",
                              f"wallet {wallet} is not declared for {account_id} — add it first")
        if have != currency:
            raise LedgerError("LEDGER_BAD_WALLET", f"wallet {wallet} holds {have}, not {currency}")
        return wallet
    row = conn.execute("SELECT wallet FROM ledger_wallets WHERE account_id = ? AND currency = ? "
                       "AND is_default = 1", (account_id, currency)).fetchone()
    return row["wallet"] if row else currency


def wallet_currency(conn, account_id: str, wallet: str) -> str:
    row = conn.execute("SELECT currency FROM ledger_wallets WHERE account_id = ? AND wallet = ?",
                       (account_id, wallet)).fetchone()
    if row:
        return row["currency"]
    row = conn.execute("SELECT currency FROM ledger_events WHERE account_id = ? AND wallet = ? LIMIT 1",
                       (account_id, wallet)).fetchone()
    if row:
        return row["currency"]
    raise LedgerError("LEDGER_BAD_WALLET", f"wallet {wallet} is unknown for {account_id}")


def closed_through(conn, account_id: str, wallet: str) -> Optional[str]:
    row = conn.execute(
        "SELECT closed_through FROM ledger_period_close WHERE account_id = ? AND wallet = ? "
        "ORDER BY created_at DESC, rowid DESC LIMIT 1", (account_id, wallet)).fetchone()
    return row["closed_through"] if row and row["closed_through"] else None


def _book_date(conn, account_id: str, wallet: str, trade_date: str,
               reason: Optional[str]) -> tuple[str, Optional[str]]:
    """(book_date, correction note). Raises PeriodClosed without a reason."""
    ct = closed_through(conn, account_id, wallet)
    if not ct or trade_date > ct:
        return trade_date, None
    if not reason:
        raise PeriodClosed(
            "LEDGER_PERIOD_CLOSED",
            f"{account_id}/{wallet} is closed through {ct} (agreed with the broker); "
            f"a change dated {trade_date} needs a correction reason and is booked today",
            {"account_id": account_id, "wallet": wallet, "closed_through": ct, "trade_date": trade_date})
    today = _today()
    if today <= ct:
        raise PeriodClosed("LEDGER_PERIOD_CLOSED",
                           f"{account_id}/{wallet} is closed through {ct}, after today — reopen it first",
                           {"closed_through": ct})
    return today, reason


# ── insert ───────────────────────────────────────────────────────────────────
_COLS = ("id", "account_id", "wallet", "trade_date", "book_date", "settle_date", "trade_time", "type",
         "symbol", "qty", "price", "multiplier", "position_effect", "gross", "fee", "vat", "tax",
         "fee_basis", "net_cash", "currency", "fx_rate", "broker_ref", "link_id", "reverses_id",
         "category", "evidence_ref", "source", "source_key", "source_ref", "note", "updated_at")
_NUM = ("qty", "price", "multiplier", "gross", "fee", "vat", "tax", "net_cash", "fx_rate")


def _insert(conn, row: dict) -> dict:
    r = {c: row.get(c) for c in _COLS}
    for c in _NUM:
        r[c] = txt(r[c])
    for c in ("fee", "vat", "tax", "net_cash"):
        r[c] = r[c] or "0"
    r["id"] = r["id"] or str(uuid.uuid4())
    r["updated_at"] = _now_ms()
    r["note"] = r["note"] or ""
    r["source"] = r["source"] or "MANUAL"
    if isinstance(r["source_ref"], (list, tuple)):
        r["source_ref"] = json.dumps(list(r["source_ref"]))
    try:
        conn.execute(f"INSERT INTO ledger_events ({','.join(_COLS)}) VALUES ({','.join('?' * len(_COLS))})",
                     [r[c] for c in _COLS])
    except sqlite3.IntegrityError as exc:
        msg = str(exc)
        if "LEDGER_PERIOD_CLOSED" in msg:
            raise PeriodClosed("LEDGER_PERIOD_CLOSED",
                               f"{r['account_id']}/{r['wallet']} is closed on {r['book_date']}") from exc
        if "LEDGER_BAD_REVERSAL" in msg:
            raise LedgerError("LEDGER_BAD_REVERSAL", "a reversal must point at a live event") from exc
        if "idx_le_reverses" in msg or "reverses_id" in msg:
            raise LedgerError("LEDGER_ALREADY_REVERSED", f"event {r['reverses_id']} is already reversed") from exc
        raise LedgerError("LEDGER_INTEGRITY", msg) from exc
    return r


def _base(conn, account_id: str, currency: str, wallet: Optional[str], trade_date: str,
          reason: Optional[str] = None) -> dict:
    account(conn, account_id)
    currency = (currency or "").strip().upper()
    if not currency:
        raise LedgerError("LEDGER_BAD_CURRENCY", "currency is required")
    w = wallet_for(conn, account_id, currency, wallet)
    td = _day(trade_date)
    book, corr = _book_date(conn, account_id, w, td, reason if reason is not None else current_correction())
    return {"account_id": account_id, "currency": currency, "wallet": w, "trade_date": td,
            "book_date": book, "_correction": corr}


def _note(base: dict, note: str) -> str:
    corr = base.pop("_correction", None)
    return f"{note} [correction: {corr}]".strip() if corr else (note or "")


def _positive(v, what: str) -> Decimal:
    d = Z(v)
    if d <= 0:
        raise LedgerError("LEDGER_BAD_AMOUNT", f"{what} must be greater than 0")
    return d


def _nonneg(v, what: str) -> Decimal:
    d = Z(v)
    if d < 0:
        raise LedgerError("LEDGER_BAD_AMOUNT", f"{what} cannot be negative")
    return d


# ── posting ──────────────────────────────────────────────────────────────────
def trade_cash(side: str, qty, price, currency: str, *, multiplier=None, fee=0, vat=0, tax=0) -> dict:
    gross = Z(qty) * Z(price) * (D(multiplier) or Decimal(1))
    costs = Z(fee) + Z(vat) + Z(tax)
    net = -(gross + costs) if side == "BUY" else gross - costs
    return {"gross": gross, "net_cash": money(net, currency)}


def post_trade(conn, *, account_id: str, side: str, symbol: str, qty, price, trade_date: str,
               currency: str, wallet: Optional[str] = None, fee=0, vat=0, tax=0,
               fee_basis: Optional[str] = "POSTED", multiplier=None, position_effect: Optional[str] = None,
               trade_time: Optional[str] = None, settle_date: Optional[str] = None,
               broker_ref: Optional[str] = None, evidence_ref: Optional[str] = None, fx_rate=None,
               note: str = "", event_id: Optional[str] = None) -> dict:
    side = (side or "").upper()
    if side not in TRADE_TYPES:
        raise LedgerError("LEDGER_BAD_SIDE", "side must be BUY or SELL")
    if not (symbol or "").strip():
        raise LedgerError("LEDGER_BAD_SYMBOL", "symbol is required")
    q = _positive(qty, "qty")
    p = _nonneg(price, "price")
    for v, what in ((fee, "fee"), (vat, "vat"), (tax, "tax")):
        _nonneg(v, what)
    if position_effect and position_effect.upper() not in ("OPEN", "CLOSE"):
        raise LedgerError("LEDGER_BAD_EFFECT", "position_effect must be OPEN or CLOSE")
    if fee_basis and fee_basis not in ("ESTIMATED", "POSTED"):
        raise LedgerError("LEDGER_BAD_FEE_BASIS", "fee_basis must be ESTIMATED or POSTED")
    if mode(conn, account_id) == "SHADOW":
        raise LedgerError("LEDGER_SHADOW_TRADE",
                          f"{account_id} is in SHADOW mode — enter trades in ENTRY; the ledger follows it")
    b = _base(conn, account_id, currency, wallet, trade_date)
    cash = trade_cash(side, q, p, b["currency"], multiplier=multiplier, fee=fee, vat=vat, tax=tax)
    return _insert(conn, {
        **b, "id": event_id, "type": side, "symbol": symbol.strip().upper(), "qty": q, "price": p,
        "multiplier": multiplier, "position_effect": (position_effect or "").upper() or None,
        "gross": cash["gross"], "fee": fee, "vat": vat, "tax": tax,
        "fee_basis": fee_basis if Z(fee) + Z(vat) > 0 else None, "net_cash": cash["net_cash"],
        "fx_rate": fx_rate, "trade_time": trade_time, "settle_date": settle_date,
        "broker_ref": (broker_ref or "").strip().upper() or None, "evidence_ref": evidence_ref,
        "note": _note(b, note),
    })


def post_position_event(conn, *, account_id: str, type: str, symbol: str, qty, trade_date: str,
                        currency: str, wallet: Optional[str] = None, price=None, cash=0,
                        evidence_ref: Optional[str] = None, note: str = "") -> dict:
    """OPTION_EXPIRE / ASSIGN / EXERCISE / SPLIT: `qty` is the signed change in
    the position (expiring a long of 2 contracts × 100 = −200)."""
    type = (type or "").upper()
    if type not in POSITION_TYPES:
        raise LedgerError("LEDGER_BAD_TYPE", f"type must be one of {', '.join(POSITION_TYPES)}")
    if Z(qty) == 0:
        raise LedgerError("LEDGER_BAD_AMOUNT", "qty change cannot be 0")
    b = _base(conn, account_id, currency, wallet, trade_date)
    return _insert(conn, {
        **b, "type": type, "symbol": symbol.strip().upper(), "qty": D(qty), "price": price,
        "position_effect": "CLOSE" if type in ("OPTION_EXPIRE", "ASSIGN", "EXERCISE") else None,
        "net_cash": money(cash, b["currency"]), "evidence_ref": evidence_ref, "note": _note(b, note),
    })


def post_cash(conn, *, account_id: str, type: str, amount, trade_date: str, currency: str,
              wallet: Optional[str] = None, symbol: Optional[str] = None,
              broker_ref: Optional[str] = None, evidence_ref: Optional[str] = None,
              link_id: Optional[str] = None, note: str = "") -> dict:
    """DEPOSIT / WITHDRAW / INTEREST / FEE / WHT — `amount` is a positive size."""
    type = (type or "").upper()
    if type not in CASH_SIGN:
        raise LedgerError("LEDGER_BAD_TYPE", f"type must be one of {', '.join(CASH_SIGN)}")
    a = _positive(amount, "amount")
    b = _base(conn, account_id, currency, wallet, trade_date)
    return _insert(conn, {
        **b, "type": type, "symbol": (symbol or "").upper() or None,
        "net_cash": money(a * CASH_SIGN[type], b["currency"]),
        "fee": a if type == "FEE" else 0, "tax": a if type == "WHT" else 0,
        "fee_basis": "POSTED" if type == "FEE" else None,
        "broker_ref": broker_ref, "evidence_ref": evidence_ref, "link_id": link_id,
        "note": _note(b, note),
    })


def post_dividend(conn, *, account_id: str, symbol: str, gross, trade_date: str, currency: str,
                  wht=0, wallet: Optional[str] = None, evidence_ref: Optional[str] = None,
                  note: str = "") -> list[dict]:
    g = _positive(gross, "gross dividend")
    w = _nonneg(wht, "withholding tax")
    if w >= g:
        raise LedgerError("LEDGER_BAD_AMOUNT", "withholding tax must be less than the gross dividend")
    link = str(uuid.uuid4())
    b = _base(conn, account_id, currency, wallet, trade_date)
    rows = [_insert(conn, {**b, "type": "DIVIDEND", "symbol": symbol.upper(), "gross": g,
                           "net_cash": money(g, b["currency"]), "link_id": link,
                           "evidence_ref": evidence_ref, "note": _note(dict(b), note)})]
    if w > 0:
        rows.append(post_cash(conn, account_id=account_id, type="WHT", amount=w, trade_date=trade_date,
                              currency=currency, wallet=b["wallet"], symbol=symbol, link_id=link,
                              evidence_ref=evidence_ref, note=f"withholding on {symbol.upper()} dividend"))
    return rows


def post_transfer(conn, *, from_account: str, to_account: str, amount, trade_date: str, currency: str,
                  from_wallet: Optional[str] = None, to_wallet: Optional[str] = None,
                  evidence_ref: Optional[str] = None, note: str = "") -> list[dict]:
    a = _positive(amount, "amount")
    if from_account == to_account and (from_wallet or currency) == (to_wallet or currency):
        raise LedgerError("LEDGER_BAD_TRANSFER", "transfer needs two different wallets")
    link = str(uuid.uuid4())
    out = _base(conn, from_account, currency, from_wallet, trade_date)
    inn = _base(conn, to_account, currency, to_wallet, trade_date)
    return [
        _insert(conn, {**out, "type": "TRANSFER_OUT", "net_cash": -money(a, currency), "link_id": link,
                       "evidence_ref": evidence_ref, "note": _note(out, note)}),
        _insert(conn, {**inn, "type": "TRANSFER_IN", "net_cash": money(a, currency), "link_id": link,
                       "evidence_ref": evidence_ref, "note": _note(inn, note)}),
    ]


def cutover(conn, account_id: str) -> Optional[str]:
    """Day the account's journal starts from (OPENING balances). Legacy rows
    dated on or before it are not projected — their result is the opening."""
    return account(conn, account_id).get("ledger_cutover") or None


def _utc(v) -> str:
    """A stored time as 'YYYY-MM-DD HH:MM:SS' UTC ('' if absent). Rows keep
    created_at in UTC already; slip fill times carry an offset (+07:00)."""
    if not v:
        return ""
    s = str(v).strip()
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return s[:19]
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def cutover_at(conn, account_id: str) -> Optional[str]:
    """The moment (UTC) of the statement the OPENING balances came from."""
    return account(conn, account_id).get("ledger_cutover_at") or None


def _in_opening(w: dict, cut: Optional[str], cut_at: Optional[str]) -> bool:
    """Already inside the OPENING balances: dated on/before the cutover day AND
    known before the snapshot moment. A trade dated the cutover day but filled
    after the snapshot (a US session spanning midnight Bangkok) is not."""
    if not cut or w["trade_date"] > cut:
        return False
    known = w.get("_known_at") or ""
    return not cut_at or not known or known <= cut_at


def _pre_cutover_prints(conn, account_id: str) -> dict[str, str]:
    cut, cut_at = cutover(conn, account_id), cutover_at(conn, account_id)
    want, _ = desired_events(conn, account_id)
    # Wallet left out: routing rules added later re-route old rows on paper,
    # which is not a change to what happened.
    return {w["source_key"]: _fingerprint(w, with_wallet=False) for w in want if _in_opening(w, cut, cut_at)}


def _cutover_baseline(conn, account_id: str) -> Optional[dict]:
    raw = account(conn, account_id).get("ledger_cutover_baseline")
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        return None


def move_between_wallets(conn, *, account_id: str, from_wallet: str, to_wallet: str, amount,
                         trade_date: str, to_amount=None, fee=0, broker_ref: Optional[str] = None,
                         evidence_ref: Optional[str] = None, note: str = "") -> list[dict]:
    """Move cash between two wallets of one account.

    Same currency → a TRANSFER_OUT/IN pair (Dime! USD → Dime! FCD).
    Different currencies → an FX conversion, and `to_amount` (what actually
    arrived, from the slip) is required: the rate is whatever the broker gave,
    never a market quote."""
    fw, tw = (from_wallet or "").strip().upper(), (to_wallet or "").strip().upper()
    if not fw or not tw or fw == tw:
        raise LedgerError("LEDGER_BAD_TRANSFER", "choose two different wallets")
    fc, tc = wallet_currency(conn, account_id, fw), wallet_currency(conn, account_id, tw)
    if fc == tc:
        if D(to_amount) is not None and money(to_amount, tc) != money(amount, fc):
            raise LedgerError("LEDGER_BAD_TRANSFER",
                              f"{fw} and {tw} are both {fc}: the amount out must equal the amount in")
        rows = post_transfer(conn, from_account=account_id, to_account=account_id, amount=amount,
                             trade_date=trade_date, currency=fc, from_wallet=fw, to_wallet=tw,
                             evidence_ref=evidence_ref, note=note or f"{fw} → {tw}")
        if Z(fee) > 0:
            rows.append(post_cash(conn, account_id=account_id, type="FEE", amount=fee, trade_date=trade_date,
                                  currency=fc, wallet=fw, link_id=rows[0]["link_id"],
                                  evidence_ref=evidence_ref, note=f"transfer fee {fw} → {tw}"))
        return rows
    if D(to_amount) is None:
        raise LedgerError("LEDGER_NEEDS_AMOUNT",
                          f"{fw} ({fc}) → {tw} ({tc}) is a conversion: enter the {tc} amount that arrived")
    return post_fx_convert(conn, account_id=account_id, trade_date=trade_date, from_currency=fc,
                           from_amount=amount, to_currency=tc, to_amount=to_amount, from_wallet=fw,
                           to_wallet=tw, fee=fee, broker_ref=broker_ref, evidence_ref=evidence_ref,
                           note=note or f"{fw} → {tw}")


def post_fx_convert(conn, *, account_id: str, trade_date: str, from_currency: str, from_amount,
                    to_currency: str, to_amount, from_wallet: Optional[str] = None,
                    to_wallet: Optional[str] = None, fee=0, broker_ref: Optional[str] = None,
                    evidence_ref: Optional[str] = None, note: str = "") -> list[dict]:
    """Two legs, one link: `from_amount` leaves one wallet, `to_amount` lands in
    another. A fee (in the from-currency) is its own FEE event on the same link."""
    fa, ta = _positive(from_amount, "from_amount"), _positive(to_amount, "to_amount")
    fc, tc = (from_currency or "").upper(), (to_currency or "").upper()
    if fc == tc:
        raise LedgerError("LEDGER_BAD_FX", "an FX conversion needs two currencies")
    link = str(uuid.uuid4())
    rate = ta / fa  # to-currency units per from-currency unit, as the slip shows it
    out = _base(conn, account_id, fc, from_wallet, trade_date)
    inn = _base(conn, account_id, tc, to_wallet, trade_date)
    rows = [
        _insert(conn, {**out, "type": "FX_CONVERT", "net_cash": -money(fa, fc), "gross": fa,
                       "fx_rate": rate, "link_id": link, "broker_ref": broker_ref,
                       "evidence_ref": evidence_ref, "note": _note(out, note or f"{fc}→{tc}")}),
        _insert(conn, {**inn, "type": "FX_CONVERT", "net_cash": money(ta, tc), "gross": ta,
                       "fx_rate": rate, "link_id": link, "broker_ref": broker_ref,
                       "evidence_ref": evidence_ref, "note": _note(inn, note or f"{fc}→{tc}")}),
    ]
    if Z(fee) > 0:
        rows.append(post_cash(conn, account_id=account_id, type="FEE", amount=fee, trade_date=trade_date,
                              currency=fc, wallet=out["wallet"], link_id=link, evidence_ref=evidence_ref,
                              note=f"FX fee {fc}→{tc}"))
    return rows


def post_opening(conn, *, account_id: str, trade_date: str, currency: str, evidence_ref: str,
                 amount=None, symbol: Optional[str] = None, qty=None, price=None,
                 wallet: Optional[str] = None, note: str = "") -> dict:
    """Balance brought forward, from a statement. Cash (`amount`, signed) or a
    position (`symbol`, `qty`, `price` = cost/unit, no cash)."""
    if not (evidence_ref or "").strip():
        raise LedgerError("LEDGER_NEEDS_EVIDENCE", "an opening balance needs the statement it came from")
    b = _base(conn, account_id, currency, wallet, trade_date)
    if symbol:
        q = _positive(qty, "qty")
        p = _nonneg(price, "price")
        return _insert(conn, {**b, "type": "OPENING", "symbol": symbol.upper(), "qty": q, "price": p,
                              "gross": q * p, "net_cash": 0, "evidence_ref": evidence_ref,
                              "note": _note(b, note)})
    if D(amount) is None:
        raise LedgerError("LEDGER_BAD_AMOUNT", "opening cash amount is required")
    return _insert(conn, {**b, "type": "OPENING", "net_cash": money(amount, b["currency"]),
                          "evidence_ref": evidence_ref, "note": _note(b, note)})


def post_adjust(conn, *, account_id: str, trade_date: str, currency: str, amount, category: str,
                note: str, wallet: Optional[str] = None, evidence_ref: Optional[str] = None) -> dict:
    """Last resort. Needs a category (never UNKNOWN) and a written reason."""
    category = (category or "").upper()
    if category not in ADJUST_CATEGORIES:
        raise LedgerError("LEDGER_BAD_CATEGORY", f"category must be one of {', '.join(ADJUST_CATEGORIES)}")
    if not (note or "").strip():
        raise LedgerError("LEDGER_NEEDS_REASON", "an adjustment needs a written reason")
    if Z(amount) == 0:
        raise LedgerError("LEDGER_BAD_AMOUNT", "adjustment amount cannot be 0")
    b = _base(conn, account_id, currency, wallet, trade_date)
    return _insert(conn, {**b, "type": "ADJUST", "net_cash": money(amount, b["currency"]),
                          "category": category, "evidence_ref": evidence_ref, "note": _note(b, note)})


def get_event(conn, event_id: str) -> dict:
    row = conn.execute("SELECT * FROM ledger_events WHERE id = ?", (event_id,)).fetchone()
    if not row:
        raise LedgerError("LEDGER_UNKNOWN_EVENT", f"no event {event_id}")
    return dict(row)


def _reversed_ids(conn, account_id: Optional[str] = None) -> set[str]:
    sql = "SELECT reverses_id FROM ledger_events WHERE type = 'REVERSAL'"
    args: tuple = ()
    if account_id:
        sql += " AND account_id = ?"
        args = (account_id,)
    return {r[0] for r in conn.execute(sql, args)}


def qty_delta(e: dict) -> Decimal:
    """Signed change an event makes to its symbol's position."""
    t = e["type"]
    q = Z(e.get("qty"))
    if t == "BUY" or (t == "OPENING" and e.get("symbol")):
        return q
    if t == "SELL":
        return -q
    if t in POSITION_TYPES or t == "REVERSAL":
        return q
    return Decimal(0)


def _reverse_one(conn, orig: dict, reason: str, *, event_id: Optional[str] = None,
                 correction_reason: Optional[str] = None, evidence_ref: Optional[str] = None) -> dict:
    if orig["type"] == "REVERSAL":
        raise LedgerError("LEDGER_BAD_REVERSAL", "a reversal cannot be reversed — post the event again")
    book, corr = _book_date(conn, orig["account_id"], orig["wallet"], orig["trade_date"],
                            correction_reason if correction_reason is not None else current_correction())
    note = f"reverses {orig['type']} {orig['id'][:8]}: {reason}"
    if corr and corr != reason:
        note += f" [correction: {corr}]"
    return _insert(conn, {
        "id": event_id, "account_id": orig["account_id"], "wallet": orig["wallet"],
        "trade_date": orig["trade_date"], "book_date": book, "type": "REVERSAL",
        "symbol": orig.get("symbol"), "qty": -qty_delta(orig) if qty_delta(orig) else None,
        "price": orig.get("price"), "net_cash": -Z(orig["net_cash"]), "currency": orig["currency"],
        "reverses_id": orig["id"], "link_id": orig.get("link_id"), "evidence_ref": evidence_ref,
        "source": orig["source"] if orig["source"] in PROJECTED_SOURCES else "MANUAL",
        "source_key": orig.get("source_key"), "note": note,
    })


def reverse(conn, event_id: str, reason: str, *, evidence_ref: Optional[str] = None) -> list[dict]:
    """Reverse an event and every live leg linked to it (FX pair, transfer
    pair, dividend + WHT) — half a conversion is worse than none."""
    if not (reason or "").strip():
        raise LedgerError("LEDGER_NEEDS_REASON", "a reversal needs a reason")
    orig = get_event(conn, event_id)
    if orig["source"] in PROJECTED_SOURCES and mode(conn, orig["account_id"]) == "SHADOW":
        raise LedgerError("LEDGER_SHADOW_EVENT",
                          "this event mirrors a legacy row — edit or delete that row in PORT instead")
    done = _reversed_ids(conn)
    if orig["id"] in done:
        raise LedgerError("LEDGER_ALREADY_REVERSED", f"event {event_id} is already reversed")
    group = [orig]
    if orig.get("link_id") and orig["type"] in ("FX_CONVERT", "TRANSFER_IN", "TRANSFER_OUT", "DIVIDEND",
                                                "WHT", "FEE"):
        group = [dict(r) for r in conn.execute(
            "SELECT * FROM ledger_events WHERE link_id = ? AND type <> 'REVERSAL' ORDER BY created_at",
            (orig["link_id"],)) if r["id"] not in done]
    return [_reverse_one(conn, e, reason, correction_reason=reason, evidence_ref=evidence_ref)
            for e in group]


def fee_trueup(conn, event_id: str, posted_fee, *, evidence_ref: Optional[str] = None,
               trade_date: Optional[str] = None, note: str = "") -> Optional[dict]:
    """The broker's real fee replaces an estimate: posts the difference as a FEE
    linked to the trade (negative FEE = refund). Once per event."""
    e = get_event(conn, event_id)
    if e["type"] not in TRADE_TYPES:
        raise LedgerError("LEDGER_BAD_TYPE", "only a BUY or SELL carries a fee")
    if e["source"] in PROJECTED_SOURCES:
        raise LedgerError("LEDGER_SHADOW_EVENT",
                          "this event mirrors a legacy trade — type the real fee on the trade in PORT")
    if e.get("fee_basis") != "ESTIMATED":
        raise LedgerError("LEDGER_FEE_POSTED", "this event's fee is already the posted amount")
    if conn.execute("SELECT 1 FROM ledger_events WHERE type = 'FEE' AND link_id = ? AND fee_basis = 'POSTED'",
                    (event_id,)).fetchone():
        raise LedgerError("LEDGER_FEE_POSTED", "a true-up is already posted for this event")
    delta = money(_nonneg(posted_fee, "posted fee") - Z(e["fee"]) - Z(e["vat"]), e["currency"])
    b = _base(conn, e["account_id"], e["currency"], e["wallet"], trade_date or _today())
    return _insert(conn, {**b, "type": "FEE", "symbol": e.get("symbol"), "fee": delta,
                          "fee_basis": "POSTED", "net_cash": -delta, "link_id": event_id,
                          "evidence_ref": evidence_ref,
                          "note": _note(b, note or f"fee true-up: posted {txt(posted_fee)}, "
                                                    f"estimated {txt(Z(e['fee']) + Z(e['vat']))}")})


# ── reading ──────────────────────────────────────────────────────────────────
def events(conn, account_id: Optional[str] = None, *, wallet: Optional[str] = None,
           date_from: Optional[str] = None, date_to: Optional[str] = None,
           limit: int = 500) -> list[dict]:
    sql, args = "SELECT * FROM ledger_events WHERE 1=1", []
    for col, val in (("account_id", account_id), ("wallet", wallet)):
        if val:
            sql += f" AND {col} = ?"
            args.append(val)
    if date_from:
        sql += " AND book_date >= ?"
        args.append(date_from)
    if date_to:
        sql += " AND book_date <= ?"
        args.append(date_to)
    sql += " ORDER BY book_date DESC, trade_date DESC, created_at DESC LIMIT ?"
    args.append(int(limit))
    rows = [dict(r) for r in conn.execute(sql, args)]
    done = _reversed_ids(conn, account_id)
    for r in rows:
        r["reversed"] = r["id"] in done
    return rows


def balances(conn, account_id: Optional[str] = None, as_of: Optional[str] = None) -> list[dict]:
    """Cash per (account, wallet, currency) = Σ net_cash with book_date ≤ as_of."""
    sums: dict[tuple, Decimal] = defaultdict(Decimal)
    counts: dict[tuple, int] = defaultdict(int)
    sql, args = "SELECT account_id, wallet, currency, net_cash FROM ledger_events WHERE 1=1", []
    if account_id:
        sql += " AND account_id = ?"
        args.append(account_id)
    if as_of:
        sql += " AND book_date <= ?"
        args.append(_day(as_of))
    for r in conn.execute(sql, args):
        k = (r["account_id"], r["wallet"], r["currency"])
        sums[k] += Z(r["net_cash"])
        counts[k] += 1
    return [{"account_id": a, "wallet": w, "currency": c, "balance": txt(money(v, c)),
             "events": counts[(a, w, c)], "closed_through": closed_through(conn, a, w)}
            for (a, w, c), v in sorted(sums.items())]


def balance(conn, account_id: str, wallet: str, as_of: Optional[str] = None) -> Decimal:
    ccy = wallet_currency(conn, account_id, wallet)
    for b in balances(conn, account_id, as_of):
        if b["wallet"] == wallet:
            return D(b["balance"])
    return money(0, ccy)


def positions(conn, account_id: str, as_of: Optional[str] = None) -> list[dict]:
    q: dict[str, Decimal] = defaultdict(Decimal)
    sql, args = "SELECT * FROM ledger_events WHERE account_id = ? AND symbol IS NOT NULL", [account_id]
    if as_of:
        sql += " AND trade_date <= ?"
        args.append(_day(as_of))
    for r in conn.execute(sql, args):
        q[r["symbol"]] += qty_delta(dict(r))
    return [{"symbol": s, "qty": txt(v)} for s, v in sorted(q.items()) if v != 0]


# ── period close ─────────────────────────────────────────────────────────────
def close_period(conn, *, account_id: str, wallet: str, as_of: str, statement_balance=None,
                 statement_id: Optional[str] = None, source_ref: Optional[str] = None,
                 note: str = "") -> dict:
    """Agree a wallet with a broker statement up to `as_of` and lock it.

    Equal means equal at the currency's minor unit. A difference is returned,
    not absorbed — find the missing event and post it, then close."""
    account(conn, account_id)
    wallet = wallet.strip().upper()
    ccy = wallet_currency(conn, account_id, wallet)
    as_of = _day(as_of)
    if as_of > _today():
        raise LedgerError("LEDGER_BAD_DATE", "a period cannot be closed in the future")
    prev = closed_through(conn, account_id, wallet)
    if prev and as_of <= prev:
        raise LedgerError("LEDGER_BAD_DATE", f"already closed through {prev}")
    if statement_id:
        st = conn.execute("SELECT * FROM broker_statements WHERE id = ? AND account_id = ?",
                          (statement_id, account_id)).fetchone()
        if not st:
            raise LedgerError("LEDGER_UNKNOWN_STATEMENT", f"no statement {statement_id} for {account_id}")
        if str(st["currency"]).upper() != ccy:
            raise LedgerError("LEDGER_BAD_STATEMENT", f"statement is in {st['currency']}, wallet in {ccy}")
        if st["as_of"][:10] != as_of:
            raise LedgerError("LEDGER_BAD_STATEMENT", f"statement is dated {st['as_of'][:10]}, not {as_of}")
        statement_balance = st["cash"]
        source_ref = source_ref or st["source_ref"]
    if D(statement_balance) is None:
        raise LedgerError("LEDGER_NEEDS_EVIDENCE", "the broker's balance for that day is required")
    if not (source_ref or "").strip():
        raise LedgerError("LEDGER_NEEDS_EVIDENCE", "say where the broker balance came from (statement/app)")
    stmt = money(statement_balance, ccy)
    led = balance(conn, account_id, wallet, as_of)
    diff = stmt - led
    if diff != 0:
        since = [e for e in events(conn, account_id, wallet=wallet, date_from=prev, date_to=as_of, limit=30)]
        raise CloseMismatch(
            "LEDGER_CLOSE_MISMATCH",
            f"{account_id}/{wallet} on {as_of}: ledger {txt(led)} vs broker {txt(stmt)} "
            f"(missing {txt(diff)} {ccy}) — post the missing event, then close",
            {"ledger": txt(led), "broker": txt(stmt), "difference": txt(diff), "currency": ccy,
             "since_last_close": [{k: e[k] for k in ("id", "book_date", "type", "symbol", "net_cash", "note")}
                                  for e in since]})
    row = {"id": str(uuid.uuid4()), "account_id": account_id, "wallet": wallet, "currency": ccy,
           "action": "CLOSE", "closed_through": as_of, "balance": txt(stmt), "statement_id": statement_id,
           "source_ref": source_ref, "reason": note or "", "updated_at": _now_ms()}
    conn.execute(f"INSERT INTO ledger_period_close ({','.join(row)}) VALUES ({','.join('?' * len(row))})",
                 list(row.values()))
    return row


def reopen_period(conn, *, account_id: str, wallet: str, reason: str,
                  reopen_to: Optional[str] = None) -> dict:
    if not (reason or "").strip():
        raise LedgerError("LEDGER_NEEDS_REASON", "reopening a closed period needs a reason")
    wallet = wallet.strip().upper()
    ccy = wallet_currency(conn, account_id, wallet)
    prev = closed_through(conn, account_id, wallet)
    if not prev:
        raise LedgerError("LEDGER_NOT_CLOSED", f"{account_id}/{wallet} is not closed")
    if reopen_to and _day(reopen_to) >= prev:
        raise LedgerError("LEDGER_BAD_DATE", f"reopen_to must be before {prev}")
    row = {"id": str(uuid.uuid4()), "account_id": account_id, "wallet": wallet, "currency": ccy,
           "action": "REOPEN", "closed_through": _day(reopen_to) if reopen_to else None,
           "balance": None, "statement_id": None, "source_ref": None, "reason": reason.strip(),
           "updated_at": _now_ms()}
    conn.execute(f"INSERT INTO ledger_period_close ({','.join(row)}) VALUES ({','.join('?' * len(row))})",
                 list(row.values()))
    return row


def closes(conn, account_id: Optional[str] = None) -> list[dict]:
    sql, args = "SELECT * FROM ledger_period_close", ()
    if account_id:
        sql += " WHERE account_id = ?"
        args = (account_id,)
    return [dict(r) for r in conn.execute(sql + " ORDER BY created_at DESC", args)]


# ── SHADOW projection ────────────────────────────────────────────────────────
_FP_FIELDS = ("trade_date", "type", "wallet", "currency", "symbol", "qty", "price", "multiplier",
              "position_effect", "gross", "fee", "vat", "tax", "fee_basis", "net_cash", "category")


def _fingerprint(row: dict, with_wallet: bool = True) -> str:
    parts = []
    for f in _FP_FIELDS:
        if f == "wallet" and not with_wallet:
            continue
        v = row.get(f)
        parts.append(txt(v) if f in _NUM and v is not None else ("" if v is None else str(v)))
    return hashlib.sha1("\x1f".join(parts).encode()).hexdigest()[:16]


def _fee_basis(trades: dict, ids: Iterable[str], leg: str, fee) -> Optional[str]:
    if Z(fee) <= 0:
        return None
    for tid in ids:
        t = trades.get(tid) or {}
        try:
            detail = json.loads(t.get("fee_detail") or "{}").get(leg) or {}
        except (TypeError, ValueError):
            detail = {}
        if detail.get("source") in ("manual", "slip"):
            return "POSTED"
    return "ESTIMATED"


def desired_events(conn, account_id: str) -> tuple[list[dict], list[dict]]:
    """What the legacy tables say this account's journal is, as ledger rows
    keyed on the backfill's deterministic event id (`source_key`)."""
    import ledger_backfill as lb
    evs, issues = lb.build_events(conn)
    evs = [e for e in evs if e.account_id == account_id]
    trades = {r["id"]: dict(r) for r in conn.execute(
        "SELECT id, fee_detail, wallet_entry, wallet_exit, executed_at, created_at FROM trades "
        "WHERE account_id = ?", (account_id,))}
    row_wallet: dict[str, Optional[str]] = {}
    row_created: dict[str, str] = {}
    for table in ("cash_ledger", "dividends", "cash_adjustments"):
        wcol = "wallet" if table != "cash_adjustments" else "NULL AS wallet"
        for r in conn.execute(f"SELECT id, {wcol}, created_at FROM {table} WHERE account_id = ?", (account_id,)):
            row_wallet[r["id"]] = r["wallet"]
            row_created[r["id"]] = _utc(r["created_at"])
    adj_cat = {r["id"]: r["category"] for r in conn.execute(
        "SELECT id, category FROM cash_adjustments WHERE account_id = ?", (account_id,))}
    out = []
    for e in evs:
        ccy = (e.currency or "THB").upper()
        if e.type in ("BUY", "FEE"):
            stored = next((trades[i]["wallet_entry"] for i in e.source_ref
                           if i in trades and trades[i]["wallet_entry"]), None)
        elif e.type == "SELL":
            stored = next((trades[i]["wallet_exit"] for i in e.source_ref
                           if i in trades and trades[i]["wallet_exit"]), None)
        else:
            stored = next((row_wallet[i] for i in e.source_ref if row_wallet.get(i)), None)
        try:
            wallet = wallet_for(conn, account_id, ccy, stored) if stored else \
                route_wallet(conn, account_id, ccy, symbol=e.symbol)["wallet"]
        except LedgerError:
            wallet = wallet_for(conn, account_id, ccy)  # a stale wallet name: the check reports it
        # When the book learned of it: the broker's fill time if the slip gave
        # one, else when the row was typed. Decides which side of a cutover
        # moment an event dated on the cutover day falls (_in_opening).
        if e.type in ("BUY", "FEE") and any(i in trades for i in e.source_ref):
            known = min(_utc(trades[i]["executed_at"]) or _utc(trades[i]["created_at"])
                        for i in e.source_ref if i in trades)
        elif e.type == "SELL":
            known = _utc(e.trade_time)
        else:
            known = min((row_created[i] for i in e.source_ref if i in row_created), default=_utc(e.trade_time))
        row = {
            "account_id": account_id, "wallet": wallet, "_known_at": known,
            "trade_date": e.trade_date, "type": e.type, "symbol": e.symbol,
            "qty": D(e.qty) if e.qty is not None else None,
            "price": D(e.price) if e.price is not None else None,
            "gross": D(e.gross) if e.gross is not None else None,
            "fee": Z(e.fee), "vat": Z(e.vat), "tax": Z(e.tax),
            "net_cash": money(e.net_cash, ccy), "currency": ccy,
            "fx_rate": D(e.fx_rate) if e.fx_rate is not None else None,
            "trade_time": e.trade_time, "settle_date": e.settle_date, "broker_ref": e.broker_ref,
            "link_id": e.link_id, "source": "SHADOW", "source_key": e.id,
            "source_ref": list(e.source_ref), "note": e.note or "",
            "position_effect": None, "fee_basis": None, "category": None,
        }
        if e.type in TRADE_TYPES and e.note.startswith("option"):
            action = e.note.split(" ", 1)[-1].upper()
            row["position_effect"] = action if action in ("OPEN", "CLOSE") else None
        if e.type == "SELL" and not e.note.startswith("option"):
            row["fee_basis"] = _fee_basis(trades, e.source_ref, "exit", e.fee)
        if e.type == "FEE":
            row["fee_basis"] = _fee_basis(trades, e.source_ref, "entry", e.fee)
        if e.type == "ADJUST":
            row["category"] = next((adj_cat.get(i) for i in e.source_ref if adj_cat.get(i)), None) or "UNKNOWN"
        out.append(row)
    return out, [i.as_dict() for i in issues if i.account_id in (account_id, "-")]


def project(conn, account_id: str, *, correction_reason: Optional[str] = None,
            dry_run: bool = False) -> dict:
    """Bring a SHADOW account's journal in line with its legacy rows.

    Unchanged events are left alone; a changed one is reversed and posted
    again; a vanished one is reversed. Everything is planned first, so a
    closed period refuses the whole projection, never half of it."""
    reason = correction_reason if correction_reason is not None else current_correction()
    want, issues = desired_events(conn, account_id)
    cut, cut_at = cutover(conn, account_id), cutover_at(conn, account_id)
    if cut:
        want = [w for w in want if not _in_opening(w, cut, cut_at)]
    # Dated on the cutover day but after the snapshot: the day's close is the
    # snapshot, so these are booked the next day (trade_date kept).
    after_cut = (date.fromisoformat(cut) + timedelta(days=1)).isoformat() if cut else None
    want_by_key = {w["source_key"]: w for w in want}
    done = _reversed_ids(conn, account_id)
    posted = [dict(r) for r in conn.execute(
        "SELECT * FROM ledger_events WHERE account_id = ? AND source_key IS NOT NULL AND type <> 'REVERSAL'",
        (account_id,))]
    live: dict[str, list[dict]] = defaultdict(list)
    history: dict[str, int] = defaultdict(int)
    for p in posted:
        history[p["source_key"]] += 1
        if p["id"] not in done:
            live[p["source_key"]].append(p)

    to_reverse: list[dict] = []
    to_post: list[dict] = []
    unchanged = 0
    for key, rows in live.items():
        w = want_by_key.get(key)
        keep = None
        if w is not None:
            fp = _fingerprint(w)
            keep = next((r for r in rows if _fingerprint(r) == fp), None)
        for r in rows:
            if r is not keep:
                to_reverse.append(r)
        if keep is not None:
            unchanged += 1
    for key, w in want_by_key.items():
        if not any(_fingerprint(r) == _fingerprint(w) for r in live.get(key, [])):
            to_post.append(w)

    # Plan every booking date before writing anything.
    blocked = []
    plan_rev, plan_post = [], []
    for r in to_reverse:
        try:
            book, corr = _book_date(conn, account_id, r["wallet"], r["trade_date"], reason)
            plan_rev.append((r, book, corr))
        except PeriodClosed as exc:
            blocked.append({"action": "reverse", "event_id": r["id"], "type": r["type"],
                            "symbol": r.get("symbol"), "trade_date": r["trade_date"], **exc.evidence})
    for w in to_post:
        try:
            day = after_cut if cut and w["trade_date"] <= cut else w["trade_date"]
            book, corr = _book_date(conn, account_id, w["wallet"], day, reason)
            plan_post.append((w, book, corr))
        except PeriodClosed as exc:
            blocked.append({"action": "post", "source_key": w["source_key"], "type": w["type"],
                            "symbol": w.get("symbol"), "trade_date": w["trade_date"], **exc.evidence})
    summary = {"account_id": account_id, "unchanged": unchanged, "reverse": len(to_reverse),
               "post": len(to_post), "blocked": blocked, "issues": issues, "dry_run": dry_run}
    if dry_run:
        summary["pending"] = (
            [{"action": "reverse", "event_id": r["id"], "type": r["type"], "symbol": r.get("symbol"),
              "trade_date": r["trade_date"], "net_cash": r["net_cash"]} for r in to_reverse]
            + [{"action": "post", "type": w["type"], "symbol": w.get("symbol"), "trade_date": w["trade_date"],
                "net_cash": txt(w["net_cash"])} for w in to_post])[:50]
        return summary
    if blocked:
        raise PeriodClosed(
            "LEDGER_PERIOD_CLOSED",
            f"this change reaches into a closed period of {account_id} "
            f"({len(blocked)} event(s), first dated {blocked[0]['trade_date']}) — "
            "give a correction reason to book it today",
            {"blocked": blocked[:10]})
    for r, book, corr in plan_rev:
        _reverse_one(conn, r, "legacy row changed" if r["source_key"] in want_by_key else "legacy row removed",
                     event_id=_eid(f"rev|{r['id']}"), correction_reason=reason)
    for w, book, corr in plan_post:
        n = history[w["source_key"]]
        history[w["source_key"]] += 1
        row = dict(w, book_date=book, id=_eid(f"shadow|{account_id}|{w['source_key']}|{_fingerprint(w)}|{n}"))
        if corr:
            row["note"] = f"{row['note']} [correction: {corr}]".strip()
        _insert(conn, row)
    return summary


def flush_dirty(conn, mark: int) -> list[dict]:
    """Project the accounts this transaction's legacy writes touched."""
    try:
        rows = conn.execute("SELECT id, account_id FROM ledger_dirty WHERE id > ?", (mark,)).fetchall()
    except sqlite3.OperationalError:
        return []
    if not rows:
        return []
    conn.execute("DELETE FROM ledger_dirty WHERE id > ?", (mark,))
    out = []
    for acc in sorted({r["account_id"] for r in rows}):
        if mode(conn, acc) == "SHADOW":
            out.append(project(conn, acc))
    return out


def set_mode(conn, account_id: str, new_mode: str, reason: str = "",
             cutover_date: Optional[str] = None, cutover_moment: Optional[str] = None) -> dict:
    new_mode = (new_mode or "").upper()
    if new_mode not in ("LEGACY", "SHADOW", "PRIMARY"):
        raise LedgerError("LEDGER_BAD_MODE", "mode must be LEGACY, SHADOW or PRIMARY")
    if new_mode == "PRIMARY":
        raise LedgerError("LEDGER_PRIMARY_LOCKED",
                          "PRIMARY (screens read the ledger) opens after a SHADOW pilot closes a period "
                          "against the broker with no ADJUST — see plans/port-ledger-v2.md S9")
    old = mode(conn, account_id)
    if cutover_date:
        # Start the journal from a statement: history up to this day becomes
        # OPENING balances instead of being replayed. Fixed once events exist.
        cutover_date = _day(cutover_date)
        have = cutover(conn, account_id)
        if have and have != cutover_date and conn.execute(
                "SELECT 1 FROM ledger_events WHERE account_id = ? LIMIT 1", (account_id,)).fetchone():
            raise LedgerError("LEDGER_CUTOVER_FIXED", f"{account_id} already starts on {have}")
        conn.execute("UPDATE portfolio_accounts SET ledger_cutover = ?, ledger_cutover_at = ? WHERE id = ?",
                     (cutover_date, _utc(cutover_moment) or _now_ms()[:19], account_id))
        # What the legacy history said on the day the journal took over (L10).
        conn.execute("UPDATE portfolio_accounts SET ledger_cutover_baseline = ? WHERE id = ?",
                     (json.dumps(_pre_cutover_prints(conn, account_id), sort_keys=True), account_id))
    conn.execute("UPDATE portfolio_accounts SET ledger_mode = ? WHERE id = ?", (new_mode, account_id))
    out = {"account_id": account_id, "from": old, "to": new_mode, "reason": reason,
           "cutover": cutover(conn, account_id), "cutover_at": cutover_at(conn, account_id)}
    if new_mode == "SHADOW":
        out["projection"] = project(conn, account_id)
    return out


# ── checks ───────────────────────────────────────────────────────────────────
_OCC = re.compile(r"^[A-Z. ]{1,6}\d{6}[CP]\d{8}$")


def check(conn, account_id: Optional[str] = None, *, stale_fee_days: int = 7,
          as_of: Optional[str] = None) -> dict:
    today = _day(as_of) if as_of else _today()
    accs = [account_id] if account_id else [r["id"] for r in conn.execute("SELECT id FROM portfolio_accounts")]
    findings: list[dict] = []

    def add(code, severity, acc, message, evidence=None, wallet=None):
        findings.append({"code": code, "severity": severity, "account_id": acc, "wallet": wallet,
                         "message": message, "evidence": evidence or {}})

    for acc in accs:
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM ledger_events WHERE account_id = ? ORDER BY book_date, created_at", (acc,))]
        done = {r["reverses_id"] for r in rows if r["type"] == "REVERSAL"}
        by_id = {r["id"]: r for r in rows}
        live = [r for r in rows if r["type"] != "REVERSAL" and r["id"] not in done]

        # L1 — FX conversions come in two legs of two currencies
        fx: dict[Optional[str], list[dict]] = defaultdict(list)
        for r in live:
            if r["type"] == "FX_CONVERT":
                fx[r.get("link_id")].append(r)
        for link, legs in fx.items():
            ccys = {l["currency"] for l in legs}
            signs = sorted(Z(l["net_cash"]) > 0 for l in legs)
            if link is None or len(legs) != 2 or len(ccys) != 2 or signs != [False, True]:
                add("L1_FX_UNPAIRED", "error", acc,
                    f"FX conversion {str(link or legs[0]['id'])[:8]} has {len(legs)} leg(s) in "
                    f"{', '.join(sorted(ccys))} — needs one out and one in, two currencies",
                    {"events": [l["id"] for l in legs]})

        # L2 — a wallet never goes below zero (by booking day)
        run: dict[str, Decimal] = defaultdict(Decimal)
        low: dict[str, tuple[Decimal, str]] = {}
        first_neg: dict[str, str] = {}
        day_totals: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
        for r in rows:
            day_totals[(r["wallet"], r["book_date"])] += Z(r["net_cash"])
        for (w, d) in sorted(day_totals, key=lambda k: (k[0], k[1])):
            run[w] += day_totals[(w, d)]
            if run[w] < 0:
                first_neg.setdefault(w, d)
                if w not in low or run[w] < low[w][0]:
                    low[w] = (run[w], d)
        for w, (v, d) in low.items():
            ccy = wallet_currency(conn, acc, w)
            add("L2_NEGATIVE_WALLET", "error", acc,
                f"{w} falls to {txt(money(v, ccy))} {ccy} on {d} (first below zero {first_neg[w]}) — "
                "a deposit, FX conversion or opening balance is missing, or the buy was paid from another wallet",
                {"lowest": txt(money(v, ccy)), "date": d, "first_negative": first_neg[w]}, wallet=w)

        # L3 — events that landed inside a period after it was closed
        cl = [dict(r) for r in conn.execute(
            "SELECT * FROM ledger_period_close WHERE account_id = ? ORDER BY created_at, rowid", (acc,))]
        latest: dict[str, dict] = {}
        for c in cl:
            latest[c["wallet"]] = c
        for w, c in latest.items():
            if c["action"] != "CLOSE" or not c["closed_through"]:
                continue
            late = [r for r in rows if r["wallet"] == w and r["book_date"] <= c["closed_through"]
                    and r["created_at"] > c["created_at"]]
            if late:
                add("L3_LATE_IN_CLOSED", "error", acc,
                    f"{len(late)} event(s) arrived in {w} after it was closed through {c['closed_through']} "
                    "(synced from another device?) — reverse and re-book them today, or reopen",
                    {"events": [r["id"] for r in late[:20]]}, wallet=w)

        # L4 — estimated fees still waiting for the broker's figure
        trued = {r["link_id"] for r in rows if r["type"] == "FEE" and r.get("fee_basis") == "POSTED"
                 and r.get("link_id")}
        cutoff = (date.fromisoformat(today) - timedelta(days=stale_fee_days)).isoformat()
        stale = [r for r in live if r.get("fee_basis") == "ESTIMATED" and r["id"] not in trued
                 and r["trade_date"] <= cutoff]
        if stale:
            add("L4_FEE_ESTIMATED", "warn", acc,
                f"{len(stale)} fee(s) are still estimates older than {stale_fee_days} days — "
                "type the broker's figure from the confirmation",
                {"events": [{"id": r["id"], "trade_date": r["trade_date"], "symbol": r.get("symbol"),
                             "fee": r["fee"]} for r in stale[:20]]})

        # L5 — adjustments and openings must say why / from what
        for r in live:
            if r["type"] == "ADJUST" and (not r.get("category") or r["category"] == "UNKNOWN"
                                          or not (r.get("note") or "").strip()):
                add("L5_ADJUST_UNEXPLAINED", "warn", acc,
                    f"ADJUST {txt(r['net_cash'])} {r['currency']} on {r['trade_date']} has no category/reason — "
                    "find the missing event instead", {"id": r["id"], "category": r.get("category")},
                    wallet=r["wallet"])
            if r["type"] == "OPENING" and not (r.get("evidence_ref") or "").strip():
                add("L5_OPENING_NO_EVIDENCE", "warn", acc,
                    f"opening balance on {r['trade_date']} cites no statement", {"id": r["id"]}, wallet=r["wallet"])

        # L6 — legacy rows the SHADOW journal has not caught up with
        if mode(conn, acc) == "SHADOW":
            pend = project(conn, acc, dry_run=True)
            if pend["reverse"] or pend["post"]:
                add("L6_PROJECTION_PENDING", "warn", acc,
                    f"legacy rows differ from the journal: {pend['post']} to post, {pend['reverse']} to reverse "
                    f"({len(pend['blocked'])} in a closed period) — run PROJECT",
                    {"pending": pend.get("pending", []), "blocked": pend["blocked"][:10]})

        # L7 — option fills without open/close
        for r in live:
            if r["type"] in TRADE_TYPES and r.get("symbol") and _OCC.match(r["symbol"]) \
                    and not r.get("position_effect"):
                add("L7_OPTION_EFFECT", "info", acc,
                    f"option {r['type']} {r['symbol']} on {r['trade_date']} has no OPEN/CLOSE",
                    {"id": r["id"]})

        # L8 — one broker order booked twice
        refs: dict[tuple, list[str]] = defaultdict(list)
        for r in live:
            if r.get("broker_ref") and r["type"] in TRADE_TYPES:
                refs[(r["broker_ref"], r["type"])].append(r["id"])
        for (ref, typ), ids in refs.items():
            if len(ids) > 1:
                add("L8_DUPLICATE_ORDER", "error", acc, f"broker order {ref} is booked {len(ids)}× as {typ}",
                    {"events": ids})

        # L10 — the legacy history before the cutover changed after the
        # journal started from it: the OPENING balances no longer describe it
        base = _cutover_baseline(conn, acc)
        if base is not None:
            now = _pre_cutover_prints(conn, acc)
            added = sorted(set(now) - set(base))
            gone = sorted(set(base) - set(now))
            changed = sorted(k for k in set(now) & set(base) if now[k] != base[k])
            if added or gone or changed:
                add("L10_PRE_CUTOVER_CHANGE", "warn", acc,
                    f"legacy history before the ledger start {cutover(conn, acc)} changed: {len(added)} new, "
                    f"{len(changed)} edited, {len(gone)} removed. Entered late but already in the opening "
                    "statement → nothing to post; missing from it → post the event dated today",
                    {"added": added[:10], "changed": changed[:10], "removed": gone[:10]})

        # L9 — a reversal undoes exactly its target
        for r in rows:
            if r["type"] == "REVERSAL":
                o = by_id.get(r["reverses_id"])
                if o and Z(r["net_cash"]) != -Z(o["net_cash"]):
                    add("L9_BAD_REVERSAL", "error", acc,
                        f"reversal {r['id'][:8]} moves {txt(r['net_cash'])}, target moved {txt(o['net_cash'])}",
                        {"id": r["id"], "target": o["id"]})

    counts: dict[str, int] = defaultdict(int)
    for f in findings:
        counts[f["severity"]] += 1
    return {"as_of": today, "account_id": account_id, "counts": dict(counts), "findings": findings}


def pilot(conn, account_id: str, as_of: Optional[str] = None) -> dict:
    """Ledger vs the latest broker statement per wallet currency — the pilot's
    daily comparison. `matched` only when every wallet agrees exactly."""
    as_of = _day(as_of) if as_of else _today()
    out = []
    for b in balances(conn, account_id, as_of):
        st = conn.execute(
            "SELECT * FROM broker_statements WHERE account_id = ? AND currency = ? AND substr(as_of,1,10) <= ? "
            "AND id NOT IN (SELECT supersedes_id FROM broker_statements WHERE supersedes_id IS NOT NULL) "
            "ORDER BY as_of DESC, created_at DESC LIMIT 1",
            (account_id, b["currency"], as_of)).fetchone()
        # The broker's figure: a dated statement, or the balance a period was
        # closed on (itself agreed with the broker) — whichever is later.
        cl = conn.execute(
            "SELECT closed_through, balance, source_ref FROM ledger_period_close WHERE account_id = ? "
            "AND wallet = ? AND action = 'CLOSE' AND closed_through <= ? ORDER BY closed_through DESC, "
            "created_at DESC LIMIT 1", (account_id, b["wallet"], as_of)).fetchone()
        ref = None
        if st:
            ref = (st["as_of"][:10], st["cash"], "statement", st["id"])
        if cl and (ref is None or cl["closed_through"] >= ref[0]):
            ref = (cl["closed_through"], cl["balance"], "period_close", cl["source_ref"])
        item = dict(b)
        if ref:
            led_then = balance(conn, account_id, b["wallet"], ref[0])
            item.update(statement_as_of=ref[0], statement_cash=txt(money(ref[1], b["currency"])),
                        statement_kind=ref[2], statement_ref=ref[3], ledger_on_statement_day=txt(led_then),
                        difference=txt(money(ref[1], b["currency"]) - led_then))
        out.append(item)
    adj = conn.execute("SELECT COUNT(*) FROM ledger_events WHERE account_id = ? AND type = 'ADJUST' "
                       "AND book_date <= ?", (account_id, as_of)).fetchone()[0]
    matched = bool(out) and all(i.get("difference") == "0" for i in out)
    return {"account_id": account_id, "as_of": as_of, "mode": mode(conn, account_id),
            "wallets": out, "adjust_events": adj, "matched": matched}
