"""Accounting checks shared by the read-only API and command-line audit.

Reconstructed legacy events are explicitly labelled. They are not the posted
journal, and a missing price, FX rate, endpoint sample or statement is never a
passing check. No database writes or market downloads happen here.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal
from statistics import median
from typing import Callable

import dividend_check
import ledger_backfill as lb
import accounting_statements
from accounting_preflight import CASH_ADJUSTMENT_CATEGORIES
from ledger_engine import LedgerError, dec, replay


@dataclass
class Finding:
    code: str
    severity: str
    account_id: str | None
    symbol: str | None
    message: str
    evidence: dict = field(default_factory=dict)
    fix: dict | None = None


@dataclass
class Context:
    conn: object
    today: str
    book: dict
    endpoint_samples: dict | None = None
    nav_validation: list | None = None
    market: Callable | None = None
    checks: dict = field(default_factory=dict)

    def count(self, code, n=1, status="checked", reason=None):
        row = self.checks.setdefault(code, {"code": code, "status": status, "evaluated": 0})
        row["evaluated"] += n
        if reason:
            row["reason"] = reason


REGISTRY = {}


def check(code, severity, scope):
    def register(fn):
        REGISTRY[code] = (fn, severity, scope)
        return fn
    return register


def _rows(conn, table):
    return [dict(r) for r in conn.execute(f"SELECT * FROM {table}")]


def _number(value):
    return float(value or 0)


def _day(value):
    return str(value or "")[:10]


def _ledger_checks(ctx):
    for issue in ctx.book["issues"]:
        yield Finding(issue.code, issue.severity.lower(), issue.account_id, issue.symbol,
                      issue.message, {"source": "reconstructed"})


for _code in ("I1", "I2", "I3", "I5", "I6", "I7", "I8", "B"):
    def _adapter(ctx, code=_code):
        ctx.count(code, len(ctx.book["cards"]))
        return [f for f in _ledger_checks(ctx)
                if f.code == code or f.code.startswith(code + "_")]
    check(_code, "error", "position")(_adapter)


@check("I4", "warn", "account")
def cash_reconciliation(ctx):
    # Multiple edits on a day supersede one another; an old typed target is
    # not a second broker statement. Compare only the latest one per day.
    latest = {(r["account_id"], r["date"]): r for r in ctx.book["cash_checks"]}
    ctx.count("I4", len(latest))
    for r in latest.values():
        if r["missing_fx"] or r["unexplained"] is None:
            yield Finding("I4_MISSING_FX", "error", r["account_id"], None,
                          "Cash reconciliation is incomplete: missing dated FX.", r)
        elif abs(r["unexplained"]) > 0.01:
            yield Finding("I4", "warn", r["account_id"], None,
                          "Reconstructed cash before offsets differs from the recorded broker target.", r)


@check("I9", "error", "position")
def cost_conservation(ctx):
    for (aid, symbol), old_card in ctx.book["cards"].items():
        events = [r["event"] for r in old_card]
        if any(e.note.startswith("option") for e in events):
            continue  # option position direction is handled by option matching
        for method in ("AVCO", "FIFO"):
            ctx.count("I9")
            try:
                card = replay(events, method)
            except LedgerError as exc:
                yield Finding("I9_UNVERIFIABLE", "error", aid, symbol, str(exc), {"method": method})
                continue
            incoming = sum(r["cost_in"] for r in card)
            outgoing = sum(r["cost_out"] for r in card)
            remaining = card[-1]["bal_cost"] if card else 0
            if abs(incoming - outgoing - remaining) > 0.01:
                yield Finding("I9", "error", aid, symbol, "Cost is not conserved.",
                              {"method": method, "cost_in": incoming, "cost_out": outgoing,
                               "remaining_cost": remaining})


@check("H1", "warn", "row")
def hygiene(ctx):
    specs = {
        "trades": ("account_id", "symbol", "date_entry", "date_exit", "price_entry", "price_exit", "volume", "win_loss"),
        "dividends": ("account_id", "asset", "ex_date", "pay_date", "amount_per_unit", "total_received", "currency"),
        "cash_ledger": ("account_id", "date", "income", "investment", "entry_type"),
    }
    dates = {"trades": ("date_entry", "date_exit"), "dividends": ("ex_date", "pay_date"), "cash_ledger": ("date",)}
    for table, keys in specs.items():
        grouped = defaultdict(list)
        for row in _rows(ctx.conn, table):
            ctx.count("H1")
            grouped[tuple(row.get(k) for k in keys)].append(row)
            aid, sym = row["account_id"], row.get("symbol") or row.get("asset")
            for key in dates[table]:
                day = _day(row.get(key))
                if not day:
                    continue
                try:
                    date.fromisoformat(day)
                except ValueError:
                    yield Finding("H1_DATE", "error", aid, sym, "Invalid accounting date.",
                                  {"table": table, "id": row["id"], "field": key, "value": day})
                    continue
                if day > ctx.today:
                    yield Finding("H1_FUTURE", "warn", aid, sym, "Recorded transaction is in the future.",
                                  {"table": table, "id": row["id"], "field": key, "value": day})
            if table == "trades":
                entry, exit_ = _day(row.get("date_entry")), _day(row.get("date_exit"))
                if exit_ and entry and exit_ < entry:
                    yield Finding("H1_EXIT_BEFORE_ENTRY", "error", aid, sym, "Sale predates purchase.", {"id": row["id"]})
                if row.get("win_loss") != "P" and (not exit_ or row.get("price_exit") is None):
                    yield Finding("H1_CLOSED_NO_EXIT", "error", aid, sym, "Closed trade has no exit date or price.", {"id": row["id"]})
                pnl = _number(row.get("pnl_amount"))
                if (row.get("win_loss") == "W" and pnl < 0) or (row.get("win_loss") == "L" and pnl > 0):
                    yield Finding("H1_PNL_SIGN", "warn", aid, sym, "Win/loss label disagrees with P&L.", {"id": row["id"], "pnl": pnl})
        for duplicates in grouped.values():
            if len(duplicates) > 1:
                r = duplicates[0]
                yield Finding("H1_DUPLICATE", "warn", r["account_id"], r.get("symbol") or r.get("asset"),
                              "Matching rows may be duplicates; verify their broker references.",
                              {"table": table, "ids": [d["id"] for d in duplicates]})
    # The 2026-09-25 incident: the same withdrawal was posted to two accounts,
    # then hidden by a positive reconciliation offset. Report both row ids;
    # matching numbers alone are never permission to delete anything.
    withdrawals = defaultdict(list)
    for r in _rows(ctx.conn, "cash_ledger"):
        if _number(r.get("investment")) < 0 and (r.get("entry_type") or "CASH") != "TRANSFER":
            withdrawals[(_day(r["date"]), round(_number(r["investment"]), 2))].append(r)
    for (day, amount), rows in withdrawals.items():
        if len({r["account_id"] for r in rows}) > 1:
            for r in rows:
                yield Finding("H1_DUPLICATE_WITHDRAW", "warn", r["account_id"], None,
                              "Equal withdrawals appear in different accounts on the same date.",
                              {"date": day, "amount": amount, "rows": [{"id": x["id"], "account_id": x["account_id"]} for x in rows]})


@check("H2", "error", "account")
def daily_cash(ctx):
    accounts = {r["id"]: r for r in _rows(ctx.conn, "portfolio_accounts")}
    daily = defaultdict(float)
    missing = set()
    for e in ctx.book["events"]:
        if e.type == "ADJUST" or e.trade_date > ctx.today:
            continue
        home = accounts.get(e.account_id, {}).get("currency") or "THB"
        if e.currency == home:
            amount = e.net_cash
        else:
            rate = lb._thb_rate(ctx.conn, home, e.trade_date, None)
            if not rate or not e.fx_rate:
                missing.add(e.account_id)
                continue
            amount = e.net_cash * e.fx_rate / rate
        daily[(e.account_id, e.trade_date)] += amount
    for aid in accounts:
        ctx.count("H2")
        if aid in missing:
            yield Finding("H2_MISSING_FX", "error", aid, None, "Daily cash cannot be checked without dated FX.")
            continue
        if accounts[aid].get("account_type") == "margin":
            continue
        balance, lowest, low_day, days_negative = 0.0, 0.0, None, 0
        first_negative_day, first_negative_balance = None, None
        for (a, day), amount in sorted(daily.items()):
            if a != aid:
                continue
            balance += amount
            if balance < -0.01:
                days_negative += 1
                if first_negative_day is None:
                    first_negative_day, first_negative_balance = day, balance
            if balance < lowest:
                lowest, low_day = balance, day
        if lowest < -0.01:
            yield Finding("H2", "error", aid, None,
                          "Reconstructed pre-offset cash falls below zero; verify opening positions, funding wallet and broker cash activity.",
                          {"currency": accounts[aid].get("currency"), "lowest": lowest, "date": low_day,
                           "first_negative_date": first_negative_day,
                           "first_negative_balance": first_negative_balance,
                           "negative_event_days": days_negative,
                           "basis": "modelled from legacy trade dates and FX; opening-in-kind and THB/USD payment wallets are not yet represented; not a broker overdraft claim"})


@check("H3", "warn", "account")
def unlinked_transfers(ctx):
    rows = [r for r in _rows(ctx.conn, "cash_ledger") if (r.get("entry_type") or "CASH") != "TRANSFER"]
    ctx.count("H3", len(rows))
    for out in rows:
        amount = _number(out.get("investment"))
        if amount >= 0:
            continue
        for incoming in rows:
            if incoming["account_id"] != out["account_id"] and _day(incoming["date"]) == _day(out["date"]) and abs(_number(incoming.get("investment")) + amount) < 0.01:
                evidence = {"out_id": out["id"], "in_id": incoming["id"], "from_account": out["account_id"],
                            "to_account": incoming["account_id"], "date": _day(out["date"]), "amount": -amount}
                for aid in (out["account_id"], incoming["account_id"]):
                    yield Finding("H3", "warn", aid, None, "Opposite cash rows may be an unlinked transfer.", evidence)


@check("D1", "warn", "dividend")
def dividends(ctx):
    ctx.count("D1", 0, status="checked" if ctx.market else "partial",
              reason=None if ctx.market else "Holdings checked locally; market dividend amounts not requested.")
    for r in _rows(ctx.conn, "dividends"):
        ctx.count("D1")
        try:
            result = dividend_check.check(ctx.conn, account_id=r["account_id"], asset=r["asset"],
                ex_date=r["ex_date"], pay_date=r["pay_date"], amount_per_unit=_number(r["amount_per_unit"]),
                total_received=_number(r["total_received"]), currency=r.get("currency"),
                market=ctx.market or (lambda _: []), dividend_id=r["id"])
        except (ValueError, TypeError) as exc:
            yield Finding("D1_INVALID", "error", r["account_id"], r["asset"], str(exc), {"id": r["id"]})
            continue
        for issue in result["issues"]:
            yield Finding("D1_" + issue["code"].upper(), issue["level"], r["account_id"], r["asset"],
                          issue["message"], {"id": r["id"], "held_units": result["held_units"]}, issue.get("fix"))


@check("C1", "error", "account")
def cross_endpoint(ctx):
    samples = ctx.endpoint_samples
    if not samples:
        ctx.count("C1", 0, "skipped", "Cross-report comparison requires a full audit of the current reports.")
        return
    summary, returns = samples["summary"], samples["returns"]
    if summary.get("base_currency") != "THB" or returns.get("base_currency") != "THB":
        raise ValueError("C1 samples must use THB base currency")
    accounts = {r["account"]["id"]: r for r in summary["accounts"]}
    scopes = {**accounts, "all": {
        "total_invested_base": sum(r["total_invested_base"] for r in accounts.values()),
        "total_dividends_base": sum(r["total_dividends_base"] for r in accounts.values()),
        "pnl_base": summary["total_pnl_base"], "open_cost_base": summary["total_open_cost_base"],
        "cash_base": summary["total_cash_base"], "cash_adjustment_base": summary["total_cash_adjustment_base"],
    }}
    cash = _rows(ctx.conn, "cash_ledger")
    for aid, s in scopes.items():
        r = returns["total"] if aid == "all" else returns["accounts"].get(aid)
        history = samples["histories"].get(aid, [])
        if not r or not history:
            yield Finding("C1_MISSING", "error", aid, None, "Missing return or NAV sample; reconciliation is incomplete.")
            continue
        h = history[-1]
        invested = sum(_number(x["investment"]) for x in cash if x["account_id"] == aid or (aid == "all" and x["account_id"] in accounts))
        pairs = [
            ("invested: summary vs SQL", s["total_invested_base"], invested),
            ("invested: summary vs NAV", s["total_invested_base"], h["invested_capital"]),
            ("capital including offsets: returns vs summary", r["net_deposited"], s["total_invested_base"] + s["cash_adjustment_base"]),
            ("dividends: summary vs NAV", s["total_dividends_base"], h["dividends"]),
            ("dividends: summary vs returns", s["total_dividends_base"], r["dividends"]),
            ("realized: summary vs NAV", s["pnl_base"], h["realized_pnl"]),
            ("realized: summary vs returns", s["pnl_base"], r["realized"]),
            ("open cost: summary vs NAV", s["open_cost_base"], h["open_cost_basis"]),
            ("cash identity", s["cash_base"], s["total_invested_base"] + s["pnl_base"] + s["total_dividends_base"] - s["open_cost_base"] + s["cash_adjustment_base"]),
            ("cash: summary vs NAV", s["cash_base"], h["cash_balance"]),
            ("NAV: returns vs NAV history", r["nav_now"], h["nav_with_cash"]),
        ]
        for label, left, right in pairs:
            ctx.count("C1")
            if left is None or right is None or abs(left - right) > 0.05:
                yield Finding("C1", "error", aid, None, label,
                              {"left": left, "right": right, "difference": None if left is None or right is None else left - right,
                               "snapshot_date": h["snapshot_date"], "captured_at": samples.get("captured_at")})


@check("N1", "warn", "account")
def nav_validation(ctx):
    if ctx.nav_validation is None:
        ctx.count("N1", 0, "skipped", "Historical NAV comparison requires observed and reconstructed values for the same dates.")
        return
    if not ctx.nav_validation:
        ctx.count("N1", 0, "partial", "No overlapping live observations supplied.")
        yield Finding("N1_MISSING", "warn", None, None, "No overlapping live NAV observations.")
        return
    by_account = defaultdict(list)
    for row in ctx.nav_validation:
        by_account[row["account_id"]].append(row)
    for aid, rows in by_account.items():
        valid = [abs((r["rebuilt"] / r["live"] - 1) * 100) for r in rows if r.get("source") == "live" and r.get("live") and r.get("rebuilt") is not None]
        ctx.count("N1", len(valid))
        if not valid:
            yield Finding("N1_MISSING", "warn", aid, None, "No overlapping NAV observations.")
        elif median(valid) > 1:
            yield Finding("N1", "warn", aid, None, "Median NAV reconstruction error exceeds 1%.", {"median_abs_pct": median(valid), "observations": len(valid)})


@check("R3", "warn", "account")
def broker_statement_reconciliation(ctx):
    statements = accounting_statements.list_current(ctx.conn)
    if not statements:
        ctx.count("R3", 0, "skipped", "No dated broker statement with a source reference is recorded.")
        return
    by_day = defaultdict(list)
    for statement in statements:
        by_day[(statement["account_id"], statement["as_of"])].append(statement["id"])
    for (aid, as_of), ids in by_day.items():
        if len(ids) > 1:
            yield Finding("R3_CONFLICT", "error", aid, None,
                          "Multiple current broker statements exist for the same account and date.",
                          {"as_of": as_of, "statement_ids": ids})
    for statement in statements:
        ctx.count("R3")
        try:
            comparison = accounting_statements.reconcile(ctx.conn, statement, events=ctx.book["events"])
        except ValueError as exc:
            yield Finding("R3_UNVERIFIABLE", "error", statement["account_id"], None,
                          str(exc), {"statement_id": statement["id"], "as_of": statement["as_of"]})
            continue
        if comparison["missing_fx_event_ids"]:
            yield Finding("R3_MISSING_FX", "error", statement["account_id"], None,
                          "Broker cash cannot be compared without dated FX.", comparison)
        elif not comparison["matched"]:
            yield Finding("R3", "warn", statement["account_id"], None,
                          "Broker cash or holdings differ from reconstructed history.", comparison)


@check("R1", "error", "account")
def adjustment_categories(ctx):
    for row in _rows(ctx.conn, "cash_adjustments"):
        ctx.count("R1")
        if row.get("category") not in CASH_ADJUSTMENT_CATEGORIES:
            yield Finding("R1", "error", row["account_id"], None,
                          "Cash EDIT has no valid reason category.", {"adjustment_id": row["id"]})


@check("R2", "warn", "account")
def unexplained_adjustments(ctx):
    unknown = defaultdict(Decimal)
    for row in _rows(ctx.conn, "cash_adjustments"):
        if row.get("category") == "UNKNOWN":
            unknown[(row["account_id"], row["currency"])] += abs(dec(row["amount"]))
    statements = accounting_statements.list_current(ctx.conn)
    for (aid, currency), amount in unknown.items():
        ctx.count("R2")
        latest = next((r for r in statements if r["account_id"] == aid and r["currency"] == currency
                       and 0 <= (date.fromisoformat(ctx.today) - date.fromisoformat(r["as_of"])).days <= 30), None)
        evidence = {"absolute_unknown": float(amount), "currency": currency}
        if latest and dec(latest["market_value"]) > 0:
            fraction = amount / dec(latest["market_value"])
            evidence.update({"statement_id": latest["id"], "fraction_of_nav": float(fraction)})
            if fraction > Decimal("0.005"):
                yield Finding("R2", "warn", aid, None,
                              "Unexplained cash EDITs exceed 0.5% of cited broker NAV.", evidence)
        else:
            yield Finding("R2_UNVERIFIED", "warn", aid, None,
                          "Unexplained cash EDITs lack a recent broker NAV in the same currency.", evidence)
    if not unknown:
        ctx.count("R2", 0)


def _read_switch_gates(conn, account_id, reconstructed_count, posted_count):
    """Report durable activation prerequisites, independent of a check filter.

    A saved source reference is evidence supplied by the user, not proof that
    the broker issued the statement or that the balances reconcile.
    """
    accounts = [r[0] for r in conn.execute(
        "SELECT id FROM portfolio_accounts WHERE is_active=1" +
        (" AND id=?" if account_id else ""), (account_id,) if account_id else ()
    )]
    cited = {s["account_id"] for s in accounting_statements.list_current(conn, account_id)}
    missing = [aid for aid in accounts if aid not in cited]
    return [
        {"id": "posted_journal", "status": "blocked" if posted_count == 0 else "pending",
         "reason": "No posted events; the current book is reconstructed from legacy rows." if posted_count == 0
                   else "Posted events exist, but coverage and source references are not yet certified.",
         "reconstructed_events": reconstructed_count, "posted_events": posted_count},
        {"id": "broker_statements", "status": "blocked" if missing else "pending",
         "reason": "A dated, source-cited broker statement is missing for active accounts." if missing
                   else "Statements are recorded; source authenticity and balance agreement still need review.",
         "missing_account_ids": missing},
        {"id": "broker_cost_method", "status": "pending",
         "reason": "Broker cost method must be confirmed and stored per account before restating realized P&L."},
        {"id": "shadow_comparison", "status": "pending",
         "reason": "Legacy writes and posted journal have not run together with zero-difference comparisons."},
        {"id": "read_path", "status": "pending",
         "reason": "Portfolio cash, positions and returns still read legacy projections."},
    ]


def run(conn, *, account_id=None, codes=None, today=None, endpoint_samples=None, nav_validation=None, market=None):
    selected = list(codes or REGISTRY)
    unknown = set(selected) - REGISTRY.keys()
    if unknown:
        raise ValueError("Unknown accounting checks: " + ", ".join(sorted(unknown)))
    if account_id and not conn.execute("SELECT 1 FROM portfolio_accounts WHERE id=?", (account_id,)).fetchone():
        raise ValueError("Unknown account")
    ctx = Context(conn, today or date.today().isoformat(), lb.report(conn), endpoint_samples, nav_validation, market)
    findings = []
    for code in selected:
        found = REGISTRY[code][0](ctx)
        findings.extend(found or [])
        ctx.count(code, 0)
    findings = [f for f in findings if not account_id or f.account_id in (account_id, None, "-")]
    counts = {s: sum(f.severity == s for f in findings) for s in ("error", "warn", "info")}
    reconstructed_count = sum(not account_id or e.account_id == account_id for e in ctx.book["events"])
    posted_count = conn.execute("SELECT COUNT(*) FROM ledger_events" +
        (" WHERE account_id=?" if account_id else ""), (account_id,) if account_id else ()).fetchone()[0]
    gates = _read_switch_gates(conn, account_id, reconstructed_count, posted_count)
    return {"as_of": datetime.now(timezone.utc).isoformat(), "source": "reconstructed",
            "account_id": account_id, "counts": counts, "checks": list(ctx.checks.values()),
            "findings": [asdict(f) for f in findings],
            "events": reconstructed_count,
            "posted_events": posted_count,
            "read_switch_gates": gates,
            "ready_for_read_switch": False,
            "read_switch_reason": "Posted journal, broker reconciliation, cost policy, and shadow comparison are required."}


def stock_card(conn, account_id, symbol, method="AVCO"):
    events, issues = lb.build_events(conn)
    chosen = [e for e in events if e.account_id == account_id and e.symbol == symbol and e.type in ("BUY", "SELL")]
    if not chosen:
        raise ValueError("No matching position history")
    rows = replay(chosen, method)
    return {"account_id": account_id, "symbol": symbol, "currency": chosen[0].currency,
            "method": method, "source": "reconstructed", "rows": [dict(r, event=asdict(r["event"])) for r in rows],
            "findings": [i.as_dict() for i in issues if i.account_id == account_id and i.symbol == symbol],
            "cost_in": sum(r["cost_in"] for r in rows), "cost_out": sum(r["cost_out"] for r in rows),
            "remaining_cost": rows[-1]["bal_cost"], "remaining_qty": rows[-1]["bal_qty"],
            "realized": sum(r["realized"] or 0 for r in rows)}
