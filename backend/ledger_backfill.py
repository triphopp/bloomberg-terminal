"""Rebuild the append-only journal (`ledger_events`) from today's tables.

`trades` stores each lot as a mutable row: a partial sell shrinks the buy row
and spawns a closed row, and every sell rewrites the open lots' `price_entry`
to the pooled average. So the rows as they stand no longer say what was
actually bought, and at what price. This module recovers it:

* BUY  — one per ROOT lot (a row not spawned by a partial sell). Quantity is
  the root's current volume plus every row split off it; price is the oldest
  `price_entry` any audit record saw for it, before a sale rewrote it.
* SELL — closed rows grouped by (account, symbol, exit date, exit price): one
  logical sale, however many lot rows it closed.
* Cash — cash_ledger → DEPOSIT/WITHDRAW/TRANSFER_*, dividends → DIVIDEND,
  cash_adjustments → ADJUST.

Then it replays each position as a weighted-average stock card and checks the
result against what the app stores (plans/port-accounting-ledger.md I1–I7).
Nothing here writes unless `apply()` is called.

* Options — each option_trades fill is a BUY/SELL of its OCC contract, in
  underlying units (contracts × multiplier).
"""
from __future__ import annotations

import json
import re
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional

from portfolio_currency import trade_currency

EPS = 1e-6
_NS = uuid.UUID("6f1c2d0e-9a57-4f0b-8a8e-4c6b3d2a1f00")

# Audit actions written by the system (not a user's edit) that may carry the
# pre-change `price_entry` of a lot.
_SYSTEM_PRICE_ACTIONS = {
    "SELL_FULL", "SELL_PARTIAL", "SELL_PARTIAL_CREATED",
    "AVCO_REBASE", "AVCO_REPAIR", "SELL_ALL_LOTS",
}
_SPLIT_RE = re.compile(r"created from partial sell of (\S+)")


def _eid(key: str) -> str:
    """Deterministic id, so a re-run inserts nothing twice."""
    return str(uuid.uuid5(_NS, key))


def _d(v) -> str:
    return str(v or "")[:10]


def _f(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


@dataclass
class Issue:
    severity: str          # ERROR | WARN | INFO
    code: str              # I1..I7 or a backfill code
    account_id: str
    symbol: Optional[str]
    message: str

    def as_dict(self) -> dict:
        return self.__dict__.copy()


@dataclass
class Event:
    id: str
    account_id: str
    trade_date: str
    type: str
    net_cash: float
    currency: str
    symbol: Optional[str] = None
    qty: Optional[float] = None
    price: Optional[float] = None
    gross: Optional[float] = None
    fee: float = 0.0
    fx_rate: Optional[float] = None
    link_id: Optional[str] = None
    source: str = "BACKFILL"
    source_ref: list[str] = field(default_factory=list)
    note: str = ""
    # not stored: how the price was obtained, and the app's own P&L for a sale
    confidence: str = "RECORDED"
    stored_pnl: Optional[float] = None
    # When the app recorded it (UTC). Orders a buy and a sale made on the same
    # day — under average cost the order changes the average.
    trade_time: Optional[str] = None
    vat: float = 0.0
    tax: float = 0.0

    def row(self) -> dict:
        return {
            "id": self.id, "account_id": self.account_id, "trade_date": self.trade_date,
            "settle_date": None, "trade_time": self.trade_time, "type": self.type, "symbol": self.symbol,
            "qty": self.qty, "price": self.price, "gross": self.gross,
            "fee": round(self.fee, 6), "vat": self.vat, "tax": self.tax,
            "net_cash": round(self.net_cash, 6), "currency": self.currency,
            "fx_rate": self.fx_rate, "broker_ref": None, "link_id": self.link_id,
            "reverses_id": None, "source": self.source,
            "source_ref": json.dumps(self.source_ref), "note": self.note,
        }


# ── helpers over the audit trail ─────────────────────────────────────────────

def _audit(conn) -> list[dict]:
    rows = conn.execute(
        "SELECT id, trade_id, action, fields_changed, reason, created_at "
        "FROM trade_audit_log ORDER BY id"
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["fields"] = json.loads(d.get("fields_changed") or "{}") or {}
        except ValueError:
            d["fields"] = {}
        out.append(d)
    return out


def _thb_rate(conn, ccy: str, date: str, stored) -> Optional[float]:
    """THB per 1 unit of `ccy` on `date`: the rate stored on the row when it
    is a real one, else the dated fx_rates table."""
    if ccy == "THB":
        return 1.0
    s = _f(stored)
    if s > 1.5:  # a stored 1.0 on a USD row is a default, not a rate
        return s
    r = conn.execute(
        "SELECT rate FROM fx_rates WHERE base = ? AND quote = 'THB' AND date <= ? "
        "ORDER BY date DESC LIMIT 1", (ccy, date or "9999")
    ).fetchone()
    return float(r["rate"]) if r else None


# ── build ────────────────────────────────────────────────────────────────────

def build_events(conn) -> tuple[list[Event], list[Issue]]:
    issues: list[Issue] = []
    accounts = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM portfolio_accounts")}
    trades = {}
    for r in conn.execute("SELECT * FROM trades"):
        t = dict(r)
        t["acc_currency"] = (accounts.get(t["account_id"]) or {}).get("currency")
        trades[t["id"]] = t

    audit = _audit(conn)
    by_trade: dict[str, list[dict]] = defaultdict(list)
    parent: dict[str, str] = {}
    for a in audit:
        by_trade[a["trade_id"]].append(a)
        if a["action"] == "SELL_PARTIAL_CREATED":
            m = _SPLIT_RE.search(a.get("reason") or "")
            if m:
                parent[a["trade_id"]] = m.group(1)

    def root_of(tid: str) -> str:
        seen = set()
        while tid in parent and parent[tid] in trades and tid not in seen:
            seen.add(tid)
            tid = parent[tid]
        return tid

    family: dict[str, list[str]] = defaultdict(list)
    for tid in trades:
        family[root_of(tid)].append(tid)

    events: list[Event] = []

    # ── BUY: one per root lot ────────────────────────────────────────────────
    for root_id, members in family.items():
        root = trades[root_id]
        acct, sym = root["account_id"], root["symbol"]
        qty = sum(_f(trades[m]["volume"]) for m in members)
        ccy = trade_currency(root)

        # Oldest pre-change price any system action recorded, on the root
        # itself or on a split child (whose CREATED record snapshots the
        # parent's price at that sale).
        # A child's OTHER records (e.g. AVCO_REPAIR) hold the average it was
        # sold at, not what the lot was bought for — only its CREATED record
        # speaks for the parent.
        evidence = sorted(
            (a for m in members for a in by_trade.get(m, [])
             if (a["action"] in _SYSTEM_PRICE_ACTIONS if m == root_id
                 else a["action"] == "SELL_PARTIAL_CREATED")
             and isinstance(a["fields"].get("price_entry"), dict)
             and a["fields"]["price_entry"].get("old") is not None),
            key=lambda a: a["id"],
        )
        if evidence:
            price = _f(evidence[0]["fields"]["price_entry"]["old"])
            confidence = "AUDIT"
            first_sys = evidence[0]["id"]
            edited_after = [
                a for a in by_trade.get(root_id, [])
                if a["action"] == "PATCH" and a["id"] > first_sys and "price_entry" in a["fields"]
            ]
            if edited_after:
                confidence = "ESTIMATE"
                issues.append(Issue("WARN", "B_PRICE_EDITED", acct, sym,
                    f"lot {root_id[:8]} bought {_d(root['date_entry'])}: price_entry was edited by hand "
                    f"after a sale rewrote it — used pre-sale {price:g}, row now {_f(root['price_entry']):g}"))
        else:
            price = _f(root["price_entry"])
            confidence = "RECORDED"

        # The first partial sale logged the lot's volume before the split —
        # that is the buy quantity, if nobody edited volume in between.
        partials = [a for a in by_trade.get(root_id, []) if a["action"] == "SELL_PARTIAL"
                    and isinstance(a["fields"].get("volume"), dict)]
        if partials:
            logged = _f(partials[0]["fields"]["volume"].get("old"))
            if abs(logged - qty) > EPS * max(1.0, qty):
                issues.append(Issue("WARN", "B_QTY_MISMATCH", acct, sym,
                    f"lot {root_id[:8]}: rebuilt buy qty {qty:g} ≠ volume {logged:g} logged before its "
                    f"first partial sale — a split row is missing or volume was edited"))

        gross = qty * price
        events.append(Event(
            id=_eid(f"buy|{root_id}"), account_id=acct, trade_date=_d(root["date_entry"]),
            type="BUY", symbol=sym, qty=qty, price=price, gross=gross,
            net_cash=-gross, currency=ccy,
            fx_rate=_thb_rate(conn, ccy, _d(root["date_entry"]), root.get("exchange_rate")),
            source="BACKFILL" if confidence != "ESTIMATE" else "BACKFILL_ESTIMATE",
            source_ref=sorted(members), confidence=confidence,
            trade_time=str(root.get("created_at") or ""),
            note=f"lot {root_id[:8]}" + (f" + {len(members) - 1} split" if len(members) > 1 else ""),
        ))
        if _d(root.get("date_exit")) and _d(root["date_exit"]) < _d(root["date_entry"]):
            issues.append(Issue("ERROR", "I7", acct, sym,
                f"lot {root_id[:8]}: date_exit {_d(root['date_exit'])} before date_entry {_d(root['date_entry'])}"))

    # ── SELL: closed rows grouped into one logical sale ──────────────────────
    sales: dict[tuple, list[dict]] = defaultdict(list)
    for t in trades.values():
        if t.get("win_loss") == "P":
            continue
        if not _d(t.get("date_exit")) or t.get("price_exit") is None:
            issues.append(Issue("ERROR", "B_CLOSED_NO_EXIT", t["account_id"], t["symbol"],
                f"row {t['id'][:8]} is closed ({t.get('win_loss')}) but has no exit date/price"))
            continue
        key = (t["account_id"], t["symbol"], _d(t["date_exit"]), round(_f(t["price_exit"]), 8))
        sales[key].append(t)
        if _d(t["date_exit"]) < _d(t["date_entry"]):
            issues.append(Issue("ERROR", "I7", t["account_id"], t["symbol"],
                f"row {t['id'][:8]}: sold {_d(t['date_exit'])} before bought {_d(t['date_entry'])}"))

    for (acct, sym, date, price), legs in sales.items():
        qty = sum(_f(t["volume"]) for t in legs)
        gross = qty * price
        fee = 0.0
        stored_pnl = sum(_f(t.get("pnl_amount")) for t in legs)
        for t in legs:
            # pnl_amount = (exit − entry) × vol − commission. Recover the
            # commission; a negative or outsized one means the stored P&L does
            # not follow from the row's own prices (caught later by I3).
            implied = (price - _f(t["price_entry"])) * _f(t["volume"]) - _f(t.get("pnl_amount"))
            if 0.005 < implied <= 0.05 * price * _f(t["volume"]):
                fee += implied
        ccy = trade_currency(legs[0])
        # The moment the sale was logged; a row entered already-closed has no
        # sale record, so its own creation time stands in.
        stamps = [a["created_at"] for t in legs for a in by_trade.get(t["id"], [])
                  if a["action"] in ("SELL_FULL", "SELL_PARTIAL_CREATED", "SELL_ALL_LOTS")]
        stamps = stamps or [str(t.get("created_at") or "") for t in legs]
        events.append(Event(
            id=_eid(f"sell|{acct}|{sym}|{date}|{price}"), account_id=acct, trade_date=date,
            type="SELL", symbol=sym, qty=qty, price=price, gross=gross, fee=fee,
            net_cash=gross - fee, currency=ccy,
            fx_rate=_thb_rate(conn, ccy, date, legs[0].get("exit_exchange_rate")),
            source_ref=sorted(t["id"] for t in legs), stored_pnl=stored_pnl,
            trade_time=min(stamps),
            note=f"{len(legs)} lot row(s)",
        ))

    # ── options: each fill is a BUY/SELL of the contract ─────────────────────
    # Quantity in underlying units (contracts × multiplier) so price is the
    # per-share premium the chain quotes, and the stock card replays it like
    # any other position. A short open is a SELL before any BUY — I6 reports it.
    has_opt = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE name = 'option_trades'").fetchone()
    for r in (conn.execute(
            """SELECT t.*, c.occ_symbol, c.multiplier, c.currency c_ccy
               FROM option_trades t JOIN option_contracts c ON c.contract_id = t.contract_id""")
            if has_opt else []):
        o = dict(r)
        side = str(o.get("side") or "").upper()
        if side not in ("BUY", "SELL"):
            issues.append(Issue("ERROR", "B_OPTION_SIDE", o["account_id"], o["occ_symbol"],
                f"option fill {o['trade_id'][:8]} has side {side!r}"))
            continue
        units = _f(o["quantity"]) * (_f(o.get("multiplier")) or 100.0)
        price = _f(o["price"])
        fees = _f(o.get("fees"))
        gross = units * price
        ccy = (o.get("c_ccy") or "USD").upper()
        date = _d(o["trade_date"])
        events.append(Event(
            id=_eid(f"opt|{o['trade_id']}"), account_id=o["account_id"], trade_date=date,
            type=side, symbol=o["occ_symbol"], qty=units, price=price, gross=gross, fee=fees,
            net_cash=(-gross - fees) if side == "BUY" else (gross - fees), currency=ccy,
            fx_rate=_thb_rate(conn, ccy, date, o.get("exchange_rate")),
            source_ref=[o["trade_id"]], trade_time=str(o.get("created_at") or ""),
            note=f"option {o.get('action') or ''}".strip(),
        ))

    # ── cash ─────────────────────────────────────────────────────────────────
    for r in conn.execute("SELECT * FROM cash_ledger"):
        c = dict(r)
        inv = _f(c.get("investment"))
        if abs(inv) < EPS:
            continue
        etype = str(c.get("entry_type") or "CASH").upper()
        if etype == "TRANSFER":
            typ = "TRANSFER_OUT" if inv < 0 else "TRANSFER_IN"
        else:
            typ = "WITHDRAW" if inv < 0 else "DEPOSIT"
        events.append(Event(
            id=_eid(f"cash|{c['id']}"), account_id=c["account_id"], trade_date=_d(c["date"]),
            type=typ, net_cash=inv, currency="THB", fx_rate=1.0,
            link_id=c.get("linked_id"), source_ref=[c["id"]], note=c.get("note") or "",
        ))

    for r in conn.execute("SELECT * FROM dividends"):
        d = dict(r)
        amt = _f(d.get("total_received"))
        if abs(amt) < EPS:
            continue
        ccy = (d.get("currency") or (accounts.get(d["account_id"]) or {}).get("currency") or "THB").upper()
        date = _d(d.get("pay_date") or d.get("ex_date"))
        events.append(Event(
            id=_eid(f"div|{d['id']}"), account_id=d["account_id"], trade_date=date,
            type="DIVIDEND", symbol=d.get("asset"), net_cash=amt, currency=ccy,
            fx_rate=_thb_rate(conn, ccy, date, None), source_ref=[d["id"]],
        ))

    for r in conn.execute("SELECT * FROM cash_adjustments"):
        a = dict(r)
        ccy = (a.get("currency") or "THB").upper()
        events.append(Event(
            id=_eid(f"adj|{a['id']}"), account_id=a["account_id"], trade_date=_d(a["date"]),
            type="ADJUST", net_cash=_f(a["amount"]), currency=ccy,
            fx_rate=_thb_rate(conn, ccy, _d(a["date"]), None), source_ref=[a["id"]],
            note=a.get("note") or "reconcile offset",
        ))

    # transfer legs must pair to zero (I5)
    legs_by_link: dict[str, float] = defaultdict(float)
    for e in events:
        if e.type.startswith("TRANSFER") and e.link_id:
            legs_by_link[e.link_id] += e.net_cash
    for link, total in legs_by_link.items():
        if abs(total) > 0.01:
            issues.append(Issue("ERROR", "I5", "-", None, f"transfer {link[:8]} legs sum to {total:,.2f}, not 0"))

    return events, issues


# ── replay ───────────────────────────────────────────────────────────────────

_ORDER = {"BUY": 0, "SPLIT": 1, "SELL": 2}


def stock_card(events: list[Event], method: str = "AVCO") -> list[dict]:
    """Weighted-average stock card for ONE position, oldest first."""
    if method != "AVCO":
        from ledger_engine import replay
        return replay(events, method)
    rows = []
    bal_qty = bal_cost = 0.0
    # Same day: the order it was recorded in; no time known → buys first.
    for e in sorted(events, key=lambda e: (e.trade_date, e.trade_time or "", _ORDER.get(e.type, 9))):
        if e.type == "BUY":
            cost_in = (e.gross or 0) + e.fee + e.vat
            bal_qty += e.qty or 0
            bal_cost += cost_in
            rows.append({"event": e, "qty_in": e.qty, "qty_out": 0, "cost_in": cost_in,
                         "cost_out": 0, "realized": None,
                         "bal_qty": bal_qty, "bal_cost": bal_cost,
                         "avg": bal_cost / bal_qty if bal_qty > EPS else None})
        elif e.type == "SELL":
            qty = e.qty or 0
            avg = bal_cost / bal_qty if bal_qty > EPS else 0.0
            # Selling everything takes the whole remaining cost, so no satang
            # of rounding is left behind on an empty position.
            cost_out = bal_cost if abs(qty - bal_qty) <= EPS * max(1.0, qty) else qty * avg
            realized = (e.gross or 0) - e.fee - e.vat - e.tax - cost_out
            bal_qty -= qty
            bal_cost -= cost_out
            if abs(bal_qty) <= EPS * max(1.0, qty):
                bal_qty, bal_cost = 0.0, 0.0
            rows.append({"event": e, "qty_in": 0, "qty_out": qty, "cost_in": 0,
                         "cost_out": cost_out, "realized": realized,
                         "bal_qty": bal_qty, "bal_cost": bal_cost,
                         "avg": bal_cost / bal_qty if bal_qty > EPS else None})
    return rows


def check(conn, events: list[Event], issues: list[Issue]) -> dict:
    """Replay every position and every account's cash; append findings."""
    positions: dict[tuple, list[Event]] = defaultdict(list)
    for e in events:
        if e.type in ("BUY", "SELL"):
            positions[(e.account_id, e.symbol)].append(e)

    open_rows: dict[tuple, list[dict]] = defaultdict(list)
    for r in conn.execute("SELECT account_id, symbol, volume, price_entry FROM trades WHERE win_loss = 'P'"):
        open_rows[(r["account_id"], r["symbol"])].append(dict(r))
    overrides = {(r["account_id"], r["symbol"]): _f(r["avg_cost"])
                 for r in conn.execute("SELECT account_id, symbol, avg_cost FROM position_cost_overrides")}

    cards = {}
    for (acct, sym), evs in sorted(positions.items(), key=lambda kv: (kv[0][0], str(kv[0][1]))):
        card = stock_card(evs)
        cards[(acct, sym)] = card
        # I6 — never hold a negative number of shares
        neg = next((r for r in card if r["bal_qty"] < -EPS), None)
        if neg:
            issues.append(Issue("ERROR", "I6", acct, sym,
                f"sold more than bought on {neg['event'].trade_date}: balance {neg['bal_qty']:g} "
                f"— buy history is incomplete, P&L of this position cannot be verified"))
        # Same-day buy and sale: under average cost their order changes the
        # result, and the only evidence of it here is when each was typed in.
        days: dict[str, set] = defaultdict(set)
        for e in evs:
            days[e.trade_date].add(e.type)
        for day in sorted(d for d, ts in days.items() if {"BUY", "SELL"} <= ts):
            issues.append(Issue("WARN", "I8_SAME_DAY", acct, sym,
                f"bought and sold on {day}: order taken from record time — check the contract notes"))
        if any(e.note.startswith("option") for e in evs):
            continue  # open options live in option_trades, not in trades — no I1/I2 twin
        # I1 — end quantity vs the open lots the app shows
        end_qty = card[-1]["bal_qty"] if card else 0.0
        app_qty = sum(_f(r["volume"]) for r in open_rows.get((acct, sym), []))
        if abs(end_qty - app_qty) > 1e-4 * max(1.0, app_qty):
            issues.append(Issue("ERROR", "I1", acct, sym,
                f"stock card ends at {end_qty:g} shares, open lots hold {app_qty:g}"))
        # I2 — end average cost vs what the open lots carry
        if app_qty > EPS and card and card[-1]["avg"] is not None:
            app_avg = sum(_f(r["volume"]) * _f(r["price_entry"]) for r in open_rows[(acct, sym)]) / app_qty
            ledger_avg = card[-1]["avg"]
            if abs(app_avg - ledger_avg) > 1e-4 * max(1.0, ledger_avg):
                ov = overrides.get((acct, sym))
                issues.append(Issue("WARN", "I2", acct, sym,
                    f"avg cost: stock card {ledger_avg:.4f} vs open lots {app_avg:.4f} "
                    f"({(app_avg / ledger_avg - 1) * 100:+.2f}%)"
                    + (f"; manual override {ov:.4f} in place" if ov else "")))
        # I3 — realized P&L of every sale vs what the app booked
        for r in card:
            e = r["event"]
            if e.type != "SELL" or e.stored_pnl is None or r["realized"] is None:
                continue
            diff = e.stored_pnl - r["realized"]
            if abs(diff) > max(1.0, 0.001 * (e.gross or 0)):
                issues.append(Issue("WARN", "I3", acct, sym,
                    f"sale {e.trade_date} {e.qty:g} @ {e.price:g}: app booked {e.stored_pnl:,.2f}, "
                    f"stock card gives {r['realized']:,.2f} (diff {diff:+,.2f})"))

    # I4 — ledger cash vs the balance the user typed in from the broker.
    # Counted in the ACCOUNT's currency: a THB deposit into a USD account is
    # converted on the day it arrived (what the broker does), so later FX moves
    # do not show up as missing cash.
    acct_ccy = {r["id"]: (r["currency"] or "THB").upper()
                for r in conn.execute("SELECT id, currency FROM portfolio_accounts")}
    cash_checks = []
    for a in conn.execute("SELECT * FROM cash_adjustments ORDER BY date, created_at"):
        a = dict(a)
        acct, date = a["account_id"], _d(a["date"])
        home = acct_ccy.get(acct, "THB")
        # The target is the broker balance when it was typed; a same-day
        # trade recorded afterwards is not in it. Both stamps are UTC.
        typed_at = str(a.get("created_at") or "")
        bal, missing_fx, after_target = 0.0, 0, 0
        for e in events:
            if e.account_id != acct or e.trade_date > date or e.type == "ADJUST":
                continue
            if e.trade_date == date and typed_at and e.trade_time and e.trade_time > typed_at:
                after_target += 1
                continue
            if e.currency == home:
                bal += e.net_cash
                continue
            home_rate = _thb_rate(conn, home, e.trade_date, None)
            if e.fx_rate is None or not home_rate:
                missing_fx += 1
                continue
            bal += e.net_cash * e.fx_rate / home_rate
        ccy = (a.get("currency") or "THB").upper()
        target = _f(a.get("target_balance"))
        if ccy != home:
            r_from = _thb_rate(conn, ccy, date, None)
            r_home = _thb_rate(conn, home, date, None)
            target = target * r_from / r_home if r_from and r_home else None
        cash_checks.append({"account_id": acct, "date": date, "currency": home,
                            "broker_balance": target, "ledger_balance": bal,
                            "unexplained": None if target is None else target - bal,
                            "missing_fx": missing_fx, "after_target": after_target})

    return {"cards": cards, "cash_checks": cash_checks}


def report(conn) -> dict:
    events, issues = build_events(conn)
    result = check(conn, events, issues)
    by_type: dict[str, int] = defaultdict(int)
    by_conf: dict[str, int] = defaultdict(int)
    for e in events:
        by_type[e.type] += 1
        if e.type == "BUY":
            by_conf[e.confidence] += 1
    return {"events": events, "issues": issues, "by_type": dict(by_type),
            "buy_confidence": dict(by_conf), "cards": result["cards"],
            "cash_checks": result["cash_checks"]}


def apply(conn, events: list[Event]) -> dict:
    """Insert missing events. Existing ids are left alone (append-only)."""
    have = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM ledger_events")}
    # Idempotent means identical content, not merely an existing id. A legacy
    # edit after posting must be resolved with a reversal, never ignored.
    for event in events:
        if event.id in have:
            row = event.row()
            changed = [key for key, value in row.items() if have[event.id].get(key) != value]
            if changed:
                raise ValueError(f"Posted event {event.id} differs in {', '.join(changed)}; a reviewed reversal is required")
    new = [e.row() for e in events if e.id not in have]
    if new:
        cols = list(new[0].keys())
        conn.executemany(
            f"INSERT INTO ledger_events ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
            [tuple(r[c] for c in cols) for r in new],
        )
    return {"inserted": len(new), "already_present": len(events) - len(new)}
