"""Trade history for agents — read-only, exact, and explicit about what it covers.

The book lives in SQLite (`trades`: one row per lot; `option_trades` + matches for
options). `/api/v2/portfolio/trades` serves the PORT table and is the wrong thing
to hand a model: it matches symbols by substring, has no date filter, and a
model that receives 50 of 138 rows cannot tell — it answers from the 50.

Everything here is built so a wrong answer has nowhere to come from:

  * filters are exact and echoed back (`query`); an unknown account or a
    malformed date is a 422, never a silent "no rows";
  * every list says how many rows match, how many it returned and whether that
    is all of them (`total_matching` / `returned` / `complete` / `next_offset`);
  * `totals` and `/stats` are computed here over ALL matching rows, per
    currency — a model never has to add rows up, and THB is never added to USD;
  * values in `rows` are the stored values, unrounded; NULL stays null (an open
    lot has no P&L — that is not a P&L of zero); what is derived is named in
    `fields`;
  * a symbol that was never traded says so (`notes`) and offers the nearest
    symbols that were.

  GET /api/v2/trade-history/coverage       what is in the book + the field dictionary
  GET /api/v2/trade-history/trades         lots, filtered, paged
  GET /api/v2/trade-history/trades/{id}    one lot + its audit trail, broker slips, theses
  GET /api/v2/trade-history/stats          realized results, grouped
  GET /api/v2/trade-history/options        option round trips + open option lots

No UI consumer: the MCP server (`get_trade_coverage`, `get_trades`, `get_trade`,
`get_trade_stats`, `get_option_trades`) is the reader. Nothing here writes.
"""
from __future__ import annotations

import difflib
import json
import math
from collections import defaultdict
from datetime import date, datetime, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Query

from db import get_db
from portfolio_currency import convert_amount, realized_pnl_in_report, report_currency
from sub_port import sub_port_of

router = APIRouter(prefix="/api/v2/trade-history")

Status = Literal["all", "open", "closed"]
Result = Literal["W", "L"]
DateField = Literal["any", "entry", "exit"]
Order = Literal["newest", "oldest"]
Detail = Literal["brief", "full"]
GroupBy = Literal["none", "symbol", "month", "year", "strategy", "sector",
                  "account", "sub_port", "market", "instrument"]

MAX_LIMIT = 500
NONE_LABEL = "(none)"  # an empty strategy / sector / sub-port, as a filter value and a group key

# What each field means. Served by /coverage and returned to the agent — this is
# prompt text, so a column whose name misleads (price_entry) says so here.
FIELDS: dict[str, str] = {
    "id": "Row id of the lot. Name it when you state a fact about a trade.",
    "account_id": "Broker account (see accounts in coverage).",
    "sub_port": "DERIVED from the note's leading tag: 'Finansia (6065151)' → '6065151'. '' = no sub-account.",
    "symbol": "Ticker as the user wrote it (DELTA).",
    "resolved_symbol": "Data-provider ticker (DELTA.BK).",
    "market": "US / TH / CRYPTO.",
    "currency": "Currency of every price, amount, fee and P&L on this row. Rows in different currencies are never added together.",
    "status": "DERIVED: OPEN (still held, win_loss = 'P') or CLOSED (sold).",
    "result": "W or L as stored when the lot was sold; null while open. Statistics count wins by this flag, as the app does.",
    "date_entry": "Trade date of the buy, YYYY-MM-DD. On a TRANSFER_IN lot: the day it was taken over, not the day it was first bought.",
    "date_exit": "Trade date of the sale. null = not sold.",
    "holding_days": "DERIVED: date_exit − date_entry; for an open lot, today − date_entry.",
    "volume": "Units in this lot (shares, coins). A partial sale splits a lot in two rows, so one buy order can be several rows.",
    "price_entry": "AVERAGE COST per unit of the whole position (AVCO) — rewritten whenever another lot of the symbol is sold. NOT necessarily what this lot was bought at: that is lot_price.",
    "lot_price": "Price actually paid per unit for this lot. null = not recorded (older rows) — do not substitute price_entry without saying so.",
    "price_exit": "Sale price per unit. null = not sold.",
    "cost": "DERIVED: `amount` when recorded, else price_entry × volume (`cost_source` says which).",
    "pnl_amount": "Realized profit / loss of the lot in `currency`, measured against price_entry, sale fee already deducted, buy fee NOT deducted. null = open lot — no result yet, which is not zero.",
    "pnl_percent": "As stored at the sale: price_exit against price_entry in %, before fees.",
    "fee_entry": "Buy-side broker fee. null = not recorded, which is not the same as 0.",
    "fee_exit": "Sell-side broker fee — already inside pnl_amount.",
    "exchange_rate": "THB per 1 unit of `currency` on the entry date.",
    "exit_exchange_rate": "THB per 1 unit of `currency` on the exit date.",
    "strategy_name": "Strategy the user tagged the trade with. '' = none given.",
    "sector": "Sector the user or the classifier assigned.",
    "acquisition_type": "TRANSFER_IN = received in kind when the portfolio was taken over for management; null = bought.",
    "original_price_entry": "TRANSFER_IN only: the previous owner's cost per unit (memo, never rebased).",
    "transfer_price_entry": "TRANSFER_IN only: fair value per unit on the transfer date (memo, never rebased).",
    "price_stoploss": "Stop-loss the user set. null = none.",
    "price_target": "Target the user set. null = none.",
    "broker_order_ref": "Broker's order number. Not unique: lots split from one order share it.",
    "executed_at": "Fill time with its UTC offset, when the slip gave one.",
    "entry_source": "manual / slip / excel; null on older rows.",
    "is_reinvest": "1 = the user marked the buy as a reinvestment. A label only.",
    "note": "Free text. A sold lot carries '[SOLD date] @ price | P&L: …' appended by the app.",
    "entry_trigger": "Why the user entered, in their words.",
    "exit_trigger": "Why the user exited, in their words.",
    "market_trend": "User's tag at entry.",
    "news_sentiment": "User's tag at entry.",
    "expectation_based": "User's tag at entry.",
    "factor_based": "User's tag at entry.",
    "fear_greed_index": "Fear & Greed reading the user recorded at entry.",
    "vix_index": "VIX reading the user recorded at entry.",
}

# How to read this data without inventing any of it. Returned by /coverage and
# repeated in the MCP server's instructions.
RULES: list[str] = [
    "State only what a tool returned. A trade, date, price or amount that is not in a result does not exist for you.",
    "Check `complete` on every list. When it is false you hold a page — fetch the rest with `next_offset` or say the answer covers only part.",
    "Never add rows up yourself. Sums, counts, win rates and averages come from `totals` or from the stats endpoint.",
    "Amounts are per `currency`. Do not add THB to USD; ask for `base_currency` when one figure is needed, and say it is converted.",
    "null means not recorded or not applicable — an open lot has no P&L. Do not read null as 0 and do not fill it in.",
    "`total_matching` = 0 is an answer: say there are no such trades. Read `notes` — it says when a symbol was never traded.",
    "One row is one lot, not one order and not one position. Count lots as lots.",
    "price_entry is the position's average cost, not this lot's purchase price (lot_price).",
    "Results here are realized (sold) lots. Open lots have no P&L in this data — unrealized P&L needs live prices (get_positions).",
    "Give the row `id` and the dates when you quote a trade, and the `as_of` time of the result you read.",
]

_BRIEF = (
    "id", "account_id", "sub_port", "symbol", "resolved_symbol", "market", "currency",
    "status", "result", "date_entry", "date_exit", "holding_days",
    "volume", "price_entry", "lot_price", "price_exit", "cost", "cost_source",
    "pnl_amount", "pnl_percent", "fee_entry", "fee_exit",
    "strategy_name", "sector", "acquisition_type",
)


# ── small helpers ────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _day(value: Optional[str], name: str) -> Optional[str]:
    """A YYYY-MM-DD bound, or 422 — a date the server has to guess at would
    return rows for a range nobody asked for."""
    if value is None or str(value).strip() == "":
        return None
    try:
        return date.fromisoformat(str(value).strip()).isoformat()
    except ValueError:
        raise HTTPException(422, f"{name} must be a date written YYYY-MM-DD, got {value!r}")


def _num(value: Any) -> Optional[float]:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def _sum(values) -> float:
    return round(math.fsum(values), 2)


def _label(value: Any) -> str:
    return str(value or "").strip() or NONE_LABEL


def _matches_label(value: Any, wanted: str) -> bool:
    return _label(value).casefold() == _label(wanted).casefold()


def _cost(row: dict) -> tuple[Optional[float], Optional[str]]:
    amount = _num(row.get("amount"))
    if amount:
        return abs(amount), "amount"
    price, volume = _num(row.get("price_entry")), _num(row.get("volume"))
    if price and volume:
        return price * volume, "price_entry × volume"
    return None, None


def _holding_days(row: dict, today: date) -> Optional[int]:
    try:
        start = date.fromisoformat(str(row.get("date_entry") or "")[:10])
        end = date.fromisoformat(str(row["date_exit"])[:10]) if row.get("date_exit") else today
    except ValueError:
        return None
    return (end - start).days


def _shape(row: dict, today: date, detail: str = "full") -> dict:
    """A stored row plus the derived fields. Stored values pass through untouched."""
    out = dict(row)
    is_open = row.get("win_loss") == "P"
    cost, cost_source = _cost(row)
    out.update(
        sub_port=sub_port_of(row.get("note")),
        status="OPEN" if is_open else "CLOSED",
        result=None if is_open else row.get("win_loss"),
        holding_days=_holding_days(row, today),
        cost=cost,
        cost_source=cost_source,
    )
    out.pop("win_loss", None)
    if detail == "brief":
        return {k: out.get(k) for k in _BRIEF}
    return out


def _source(conn) -> dict:
    # updated_at is added by the sync layer; a database opened before it ran has only created_at.
    cols = {r[1] for r in conn.execute("PRAGMA table_info(trades)")}
    stamp = "COALESCE(updated_at, created_at)" if "updated_at" in cols else "created_at"
    n, last = conn.execute(f"SELECT COUNT(*), MAX({stamp}) FROM trades").fetchone()
    return {"database": "SQLite portfolio.db", "table": "trades",
            "rows_in_table": n, "last_write_utc": last}


def _accounts(conn) -> dict[str, dict]:
    known = {r["id"]: dict(r) for r in conn.execute(
        "SELECT id, name, currency FROM portfolio_accounts")}
    for (acc,) in conn.execute("SELECT DISTINCT account_id FROM trades"):
        known.setdefault(acc, {"id": acc, "name": acc, "currency": None})
    return known


def _check_account(conn, account_id: Optional[str]) -> Optional[str]:
    if not account_id or account_id == "all":
        return None
    known = _accounts(conn)
    if account_id not in known:
        raise HTTPException(
            422, f"Unknown account_id {account_id!r}. Accounts: {', '.join(sorted(known))}")
    return account_id


def _symbol_note(conn, symbol: str) -> Optional[str]:
    """Why a symbol filter found nothing — never traded, or traded but excluded
    by the other filters. The two must not read the same to a model."""
    sym = symbol.strip().upper()
    known: set[str] = set()
    for a, b in conn.execute("SELECT DISTINCT UPPER(symbol), UPPER(COALESCE(resolved_symbol, '')) FROM trades"):
        known.update(x for x in (a, b) if x)
    if sym in known:
        return (f"{sym} has trades in the book, but none match the other filters "
                "(account / status / dates / strategy).")
    near = sorted(set(difflib.get_close_matches(sym, sorted(known), n=5, cutoff=0.6))
                  | {k for k in known if k.startswith(sym) or sym.startswith(k.split('.')[0])})[:8]
    hint = f" Symbols that were traded and look similar: {', '.join(near)}." if near else ""
    return (f"No trade for {sym} has ever been recorded — symbols match exactly, "
            f"not by substring.{hint} get_trade_coverage lists every traded symbol.")


# ── the query both /trades and /stats run ────────────────────────────────────

def _select(conn, *, symbol=None, account_id=None, status="all", result=None,
            date_from=None, date_to=None, date_field="any", strategy=None,
            sector=None, sub_port=None, market=None) -> tuple[list[dict], dict]:
    """Every lot that matches, plus the filters as they were applied."""
    account_id = _check_account(conn, account_id)
    date_from, date_to = _day(date_from, "date_from"), _day(date_to, "date_to")
    if date_from and date_to and date_from > date_to:
        raise HTTPException(422, f"date_from {date_from} is after date_to {date_to}")
    sym = symbol.strip().upper() if symbol and symbol.strip() else None

    where, params = [], []
    if account_id:
        where.append("account_id = ?"); params.append(account_id)
    if sym:
        where.append("(UPPER(symbol) = ? OR UPPER(COALESCE(resolved_symbol, '')) = ?)")
        params += [sym, sym]
    if status == "open":
        where.append("win_loss = 'P'")
    elif status == "closed":
        where.append("win_loss != 'P'")
    if result:
        where.append("win_loss = ?"); params.append(result)
    if market:
        where.append("UPPER(COALESCE(market, '')) = ?"); params.append(market.strip().upper())

    entry, exit_ = "substr(date_entry, 1, 10)", "substr(date_exit, 1, 10)"
    if date_from or date_to:
        lo, hi = date_from or "0000-00-00", date_to or "9999-99-99"
        if date_field == "entry":
            where.append(f"{entry} BETWEEN ? AND ?"); params += [lo, hi]
        elif date_field == "exit":
            where.append(f"{exit_} BETWEEN ? AND ?"); params += [lo, hi]
        else:
            where.append(f"({entry} BETWEEN ? AND ? OR {exit_} BETWEEN ? AND ?)")
            params += [lo, hi, lo, hi]

    sql = "SELECT * FROM trades" + (" WHERE " + " AND ".join(where) if where else "")
    rows = [dict(r) for r in conn.execute(sql, params)]
    if strategy is not None and strategy.strip():
        rows = [r for r in rows if _matches_label(r.get("strategy_name"), strategy)]
    if sector is not None and sector.strip():
        rows = [r for r in rows if _matches_label(r.get("sector"), sector)]
    if sub_port is not None and sub_port.strip():
        rows = [r for r in rows if _matches_label(sub_port_of(r.get("note")), sub_port)]

    query = {
        "symbol": sym, "account_id": account_id, "status": status, "result": result,
        "date_from": date_from, "date_to": date_to,
        "date_field": date_field if (date_from or date_to) else None,
        "strategy": strategy or None, "sector": sector or None,
        "sub_port": sub_port or None, "market": market.strip().upper() if market else None,
    }
    return rows, query


def _date_notes(query: dict) -> list[str]:
    if not (query["date_from"] or query["date_to"]):
        return []
    return [{
        "any": "Dates: a lot matches when its entry date OR its exit date is inside the range.",
        "entry": "Dates: matched on the entry (buy) date only.",
        "exit": "Dates: matched on the exit (sale) date only — lots not sold are left out.",
    }[query["date_field"]]]


def _list_totals(rows: list[dict]) -> list[dict]:
    """Counts and realized P&L over every matching lot, one line per currency."""
    by_ccy: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_ccy[str(r.get("currency") or "").upper() or "?"].append(r)
    out = []
    for ccy, group in sorted(by_ccy.items()):
        closed = [r for r in group if r.get("win_loss") != "P"]
        opened = [r for r in group if r.get("win_loss") == "P"]
        out.append({
            "currency": ccy,
            "lots": len(group),
            "open_lots": len(opened),
            "closed_lots": len(closed),
            "wins": sum(1 for r in closed if r.get("win_loss") == "W"),
            "losses": sum(1 for r in closed if r.get("win_loss") == "L"),
            "realized_pnl": _sum(_num(r.get("pnl_amount")) or 0.0 for r in closed) if closed else None,
            "open_cost": _sum(_cost(r)[0] or 0.0 for r in opened) if opened else None,
        })
    return out


def _activity(row: dict) -> tuple:
    return (str(row.get("date_exit") or row.get("date_entry") or ""),
            str(row.get("created_at") or ""), str(row.get("id") or ""))


def list_lots(*, symbol: Optional[str] = None, account_id: Optional[str] = None,
              status: str = "all", result: Optional[str] = None,
              date_from: Optional[str] = None, date_to: Optional[str] = None,
              date_field: str = "any", strategy: Optional[str] = None,
              sector: Optional[str] = None, sub_port: Optional[str] = None,
              market: Optional[str] = None, limit: int = 50, offset: int = 0,
              order: str = "newest", detail: str = "brief") -> dict:
    limit = max(1, min(int(limit), MAX_LIMIT))
    offset = max(0, int(offset))
    today = date.today()
    with get_db() as conn:
        rows, query = _select(
            conn, symbol=symbol, account_id=account_id, status=status, result=result,
            date_from=date_from, date_to=date_to, date_field=date_field,
            strategy=strategy, sector=sector, sub_port=sub_port, market=market)
        notes = _date_notes(query)
        if not rows and query["symbol"]:
            notes.append(_symbol_note(conn, query["symbol"]))
        source = _source(conn)
    rows.sort(key=_activity, reverse=(order == "newest"))
    page = rows[offset:offset + limit]
    end = offset + len(page)
    complete = offset == 0 and end >= len(rows)
    if not rows:
        notes.append("No lots match. That is the answer — do not supply trades from memory.")
    elif not complete:
        notes.append(f"Lots {offset + 1}–{end} of {len(rows)}. `totals` covers all {len(rows)}; "
                     "`rows` is only this page.")
    return {
        "as_of": _now(),
        "source": source,
        "query": {**query, "order": order, "limit": limit, "offset": offset, "detail": detail},
        "total_matching": len(rows),
        "returned": len(page),
        "complete": complete,
        "next_offset": end if end < len(rows) else None,
        "totals": _list_totals(rows),
        "notes": notes,
        "rows": [_shape(r, today, detail) for r in page],
    }


# ── one lot ──────────────────────────────────────────────────────────────────

def _json(text: Any) -> Any:
    if not isinstance(text, str) or not text.strip():
        return text
    try:
        return json.loads(text)
    except ValueError:
        return text


def one_lot(trade_id: str) -> dict:
    tid = str(trade_id or "").strip()
    if not tid:
        raise HTTPException(422, "trade_id is empty")
    with get_db() as conn:
        row = conn.execute("SELECT * FROM trades WHERE id = ?", (tid,)).fetchone()
        if row is None and len(tid) >= 6:
            # An id copied short from a table. Unique prefix only — two matches
            # is a question for the caller, not a coin toss.
            hits = conn.execute(
                "SELECT * FROM trades WHERE id LIKE ? ESCAPE '\\' LIMIT 6",
                (tid.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%",),
            ).fetchall()
            if len(hits) > 1:
                raise HTTPException(
                    409, f"{tid!r} is the start of {len(hits)} trade ids: "
                         + ", ".join(h["id"] for h in hits))
            row = hits[0] if hits else None
        if row is None:
            deleted = conn.execute(
                "SELECT created_at FROM trade_audit_log WHERE trade_id = ? AND action = 'DELETE' "
                "ORDER BY created_at DESC LIMIT 1", (tid,)).fetchone()
            raise HTTPException(
                404, f"No trade with id {tid!r}."
                     + (f" It was deleted on {deleted['created_at']} UTC." if deleted else "")
                     + " Ids come from get_trades.")
        lot = dict(row)
        audit = [
            {"at_utc": a["created_at"], "action": a["action"],
             "fields_changed": _json(a["fields_changed"]), "reason": a["reason"] or None}
            for a in conn.execute(
                "SELECT action, fields_changed, reason, created_at FROM trade_audit_log "
                "WHERE trade_id = ? ORDER BY created_at, id", (lot["id"],))
        ]
        slips = [dict(e) for e in conn.execute(
            "SELECT order_ref, side, executed_at_local, display_timezone, quantity, unit_price, "
            "instrument_ccy, gross_value, commission, vat, sec_fee, taf_fee, settle_date, "
            "source_sha256 FROM broker_executions WHERE trade_id = ? ORDER BY executed_at_local",
            (lot["id"],))]
        theses = [dict(t) for t in conn.execute(
            "SELECT l.thesis_id, l.role, t.title, t.status FROM thesis_links l "
            "LEFT JOIN theses t ON t.id = l.thesis_id WHERE l.trade_id = ?", (lot["id"],))]
        siblings = []
        if lot.get("broker_order_ref"):
            siblings = [dict(s) for s in conn.execute(
                "SELECT id, volume, date_exit, win_loss FROM trades "
                "WHERE account_id = ? AND broker_order_ref = ? AND id != ?",
                (lot["account_id"], lot["broker_order_ref"], lot["id"]))]
        source = _source(conn)
    lot["fee_detail"] = _json(lot.get("fee_detail"))
    return {
        "as_of": _now(),
        "source": source,
        "trade": _shape(lot, date.today(), "full"),
        "audit_log": audit,
        "broker_slips": slips,
        "theses": theses,
        "same_order_lots": siblings,
        "notes": [
            "audit_log is every recorded change to this row, oldest first. AVCO_REPAIR / SELL_* "
            "entries are the app rebasing price_entry — not the user changing their mind.",
            "broker_slips is empty when no order confirmation was attached; that says nothing "
            "about whether the trade happened.",
        ],
    }


# ── statistics ───────────────────────────────────────────────────────────────

def _option_rows(conn, query: dict) -> tuple[list[dict], int]:
    """Closed option round trips shaped like a closed lot (as PORT → ANALYTICS
    folds them in). Second value: matches whose closing price was never
    recorded — left out, because unknown is not break-even."""
    where, params = [], []
    if query["account_id"]:
        where.append("v.account_id = ?"); params.append(query["account_id"])
    if query["symbol"]:
        where.append("UPPER(v.underlying) = ?"); params.append(query["symbol"])
    lo, hi = query["date_from"] or "0000-00-00", query["date_to"] or "9999-99-99"
    if query["date_from"] or query["date_to"]:
        entry, exit_ = "substr(v.entry_date, 1, 10)", "substr(v.exit_date, 1, 10)"
        if query["date_field"] == "entry":
            where.append(f"{entry} BETWEEN ? AND ?"); params += [lo, hi]
        elif query["date_field"] == "exit":
            where.append(f"{exit_} BETWEEN ? AND ?"); params += [lo, hi]
        else:
            where.append(f"({entry} BETWEEN ? AND ? OR {exit_} BETWEEN ? AND ?)")
            params += [lo, hi, lo, hi]
    sql = "SELECT v.* FROM v_option_realized v" + (" WHERE " + " AND ".join(where) if where else "")
    out, unknown = [], 0
    for o in conn.execute(sql, params):
        o = dict(o)
        if o.get("realized_pnl") is None:
            unknown += 1
            continue
        pnl = float(o["realized_pnl"])
        qty, mult = float(o.get("quantity") or 0), float(o.get("multiplier") or 100)
        out.append({
            "instrument": "option",
            "id": f"{o['close_trade_id']}:{o['open_trade_id']}",
            "account_id": o["account_id"],
            "symbol": str(o.get("underlying") or "").upper(),
            "contract": o.get("occ_symbol"),
            "market": None, "sector": "Options", "strategy_name": "OPTION", "note": None,
            "currency": str(o.get("currency") or "USD").upper(),
            "date_entry": str(o.get("entry_date") or "")[:10],
            "date_exit": str(o.get("exit_date") or "")[:10],
            "price_entry": o.get("entry_price"), "volume": qty * mult,
            "amount": abs(float(o.get("entry_price") or 0) * qty * mult),
            "pnl_amount": pnl,
            "win_loss": "W" if pnl > 0 else "L",
            "fee_entry": None,
        })
    return out, unknown


def _group_key(row: dict, group_by: str) -> str:
    if group_by == "none":
        return "all"
    if group_by == "symbol":
        return str(row.get("symbol") or "").upper()
    if group_by in ("month", "year"):
        return str(row.get("date_exit") or "")[: 7 if group_by == "month" else 4]
    if group_by == "strategy":
        return _label(row.get("strategy_name"))
    if group_by == "sector":
        return _label(row.get("sector"))
    if group_by == "account":
        return str(row.get("account_id") or "")
    if group_by == "sub_port":
        return _label(sub_port_of(row.get("note")))
    if group_by == "market":
        return _label(row.get("market"))
    return row.get("instrument") or "stock"


def _stats(rows: list[dict], today: date) -> dict:
    """Realized results of closed lots that share one currency."""
    with_pnl = [r for r in rows if _num(r.get("pnl_amount")) is not None]
    wins = [r for r in with_pnl if r.get("win_loss") == "W"]
    losses = [r for r in with_pnl if r.get("win_loss") == "L"]
    win_pnl = [float(r["pnl_amount"]) for r in wins]
    loss_pnl = [float(r["pnl_amount"]) for r in losses]
    closed = len(wins) + len(losses)
    avg_win = math.fsum(win_pnl) / len(wins) if wins else None
    avg_loss = math.fsum(loss_pnl) / len(losses) if losses else None
    realized = math.fsum(win_pnl) + math.fsum(loss_pnl)
    costs = [_cost(r)[0] for r in with_pnl]
    cost_closed = math.fsum(c for c in costs if c)
    days = [d for d in (_holding_days(r, today) for r in with_pnl) if d is not None]
    fees = [_num(r.get("fee_entry")) for r in with_pnl]
    expectancy = realized / closed if closed else None

    def _pick(fn):
        if not with_pnl:
            return None
        r = fn(with_pnl, key=lambda x: float(x["pnl_amount"]))
        return {"id": r.get("id"), "symbol": r.get("symbol"), "date_exit": r.get("date_exit"),
                "pnl_amount": float(r["pnl_amount"])}

    def _r(v, nd=2):
        return None if v is None else round(v, nd)

    return {
        "closed_lots": closed,
        "wins": len(wins),
        "losses": len(losses),
        "win_rate_pct": _r(len(wins) / closed * 100, 1) if closed else None,
        "realized_pnl": _r(realized) if closed else None,
        "gross_win": _r(math.fsum(win_pnl)) if wins else None,
        "gross_loss": _r(math.fsum(loss_pnl)) if losses else None,
        "avg_win": _r(avg_win),
        "avg_loss": _r(avg_loss),
        "payoff": _r(avg_win / abs(avg_loss)) if avg_win is not None and avg_loss and avg_loss < 0 else None,
        "expectancy_per_lot": _r(expectancy),
        "cost_closed": _r(cost_closed) if cost_closed else None,
        "return_on_cost_pct": _r(realized / cost_closed * 100) if cost_closed else None,
        "avg_holding_days": _r(sum(days) / len(days), 1) if days else None,
        "entry_fees_recorded": _r(math.fsum(f for f in fees if f)) if any(f is not None for f in fees) else None,
        "best": _pick(max),
        "worst": _pick(min),
        "pnl_not_recorded": len(rows) - len(with_pnl),
        "flag_disagrees_with_sign": sum(
            1 for r in with_pnl
            if (r.get("win_loss") == "W") != (float(r["pnl_amount"]) > 0)),
    }


def _in_base(row: dict, base: str, conn) -> float:
    if row.get("instrument") == "option":
        return convert_amount(float(row["pnl_amount"]), row["currency"], base,
                              date=row.get("date_exit") or None, conn=conn)
    return realized_pnl_in_report(row, base, conn=conn)


def lot_stats(*, group_by: str = "none", symbol: Optional[str] = None,
              account_id: Optional[str] = None, date_from: Optional[str] = None,
              date_to: Optional[str] = None, date_field: str = "exit",
              strategy: Optional[str] = None, sector: Optional[str] = None,
              sub_port: Optional[str] = None, market: Optional[str] = None,
              include_options: bool = True, base_currency: Optional[str] = None) -> dict:
    today = date.today()
    base = report_currency(base_currency) if base_currency else None
    if base_currency and base != str(base_currency).strip().upper():
        raise HTTPException(422, f"base_currency {base_currency!r} is not supported — use THB or USD")
    notes: list[str] = []
    with get_db() as conn:
        rows, query = _select(
            conn, symbol=symbol, account_id=account_id, status="closed",
            date_from=date_from, date_to=date_to, date_field=date_field,
            strategy=strategy, sector=sector, sub_port=sub_port, market=market)
        for r in rows:
            r["instrument"] = "stock"
        options_in, unknown = False, 0
        if include_options:
            if query["strategy"] or query["sector"] or query["sub_port"] or query["market"]:
                notes.append("Options are left out: strategy / sector / sub_port / market "
                             "filters apply to stock lots only.")
            else:
                opts, unknown = _option_rows(conn, query)
                rows += opts
                options_in = True
        if not rows and query["symbol"]:
            notes.append(_symbol_note(conn, query["symbol"]))
        source = _source(conn)

        buckets: dict[tuple[str, str], list[dict]] = defaultdict(list)
        for r in rows:
            buckets[(_group_key(r, group_by), str(r.get("currency") or "").upper() or "?")].append(r)
        groups = []
        for (key, ccy), members in buckets.items():
            entry = {"group": key, "currency": ccy, **_stats(members, today)}
            if base:
                entry["realized_pnl_base"] = _sum(_in_base(r, base, conn) for r in members
                                                  if _num(r.get("pnl_amount")) is not None)
            groups.append(entry)
        by_ccy: dict[str, list[dict]] = defaultdict(list)
        for r in rows:
            by_ccy[str(r.get("currency") or "").upper() or "?"].append(r)
        totals = [{"currency": ccy, **_stats(members, today)} for ccy, members in sorted(by_ccy.items())]
        combined = None
        if base:
            combined = {
                "currency": base,
                "realized_pnl": _sum(_in_base(r, base, conn) for r in rows
                                     if _num(r.get("pnl_amount")) is not None),
                "closed_lots": sum(t["closed_lots"] for t in totals),
                "wins": sum(t["wins"] for t in totals),
                "losses": sum(t["losses"] for t in totals),
            }
            n = combined["closed_lots"]
            combined["win_rate_pct"] = round(combined["wins"] / n * 100, 1) if n else None
            notes.append(f"*_base and `combined` are converted to {base} at each lot's exit-date "
                         "rate (the rate stored on the row when there is one). They are "
                         "conversions, not booked amounts — quote the per-currency figure first.")

    if group_by in ("month", "year"):
        groups.sort(key=lambda g: (g["group"], g["currency"]))
    else:
        groups.sort(key=lambda g: (g["currency"], -(g["realized_pnl"] or 0.0), g["group"]))
    notes += _date_notes(query)
    if group_by in ("month", "year"):
        notes.append("Lots are placed in the period of their exit date.")
    if unknown:
        notes.append(f"{unknown} option round trip(s) have no closing price recorded and are "
                     "left out — unknown, not break-even.")
    if not rows:
        notes.append("No closed lots match. There is no result to report — do not estimate one.")
    return {
        "as_of": _now(),
        "source": source,
        "query": {**{k: v for k, v in query.items() if k not in ("status", "result")},
                  "group_by": group_by, "include_options": include_options, "base_currency": base},
        "scope": ("Closed (sold) lots only" + (" + closed option round trips" if options_in else "")
                  + ". Open lots have no result and are not in any figure here."),
        "definitions": {
            "realized_pnl": "Sum of pnl_amount: sale fees deducted, buy fees not (see entry_fees_recorded).",
            "wins / losses": "Counted by the W / L flag stored at the sale, as the app counts them; "
                             "flag_disagrees_with_sign says how many flags differ from the sign of the P&L.",
            "win_rate_pct": "wins ÷ closed_lots × 100.",
            "payoff": "avg_win ÷ |avg_loss|; null without a losing lot.",
            "expectancy_per_lot": "realized_pnl ÷ closed_lots.",
            "return_on_cost_pct": "realized_pnl ÷ cost_closed × 100 — not annualised, not a portfolio return.",
            "closed_lots": "Lots, not orders: a position sold in three parts is three lots.",
        },
        "totals": totals,
        "combined": combined,
        "groups": groups if group_by != "none" else [],
        "notes": notes,
    }


# ── options ──────────────────────────────────────────────────────────────────

def option_history(*, underlying: Optional[str] = None, account_id: Optional[str] = None,
                   date_from: Optional[str] = None, date_to: Optional[str] = None,
                   limit: int = 100, offset: int = 0) -> dict:
    limit = max(1, min(int(limit), MAX_LIMIT))
    offset = max(0, int(offset))
    date_from, date_to = _day(date_from, "date_from"), _day(date_to, "date_to")
    sym = underlying.strip().upper() if underlying and underlying.strip() else None
    with get_db() as conn:
        account_id = _check_account(conn, account_id)
        where, params = [], []
        if account_id:
            where.append("account_id = ?"); params.append(account_id)
        if sym:
            where.append("UPPER(underlying) = ?"); params.append(sym)
        clause = " WHERE " + " AND ".join(where) if where else ""
        closed_where, closed_params = list(where), list(params)
        if date_from or date_to:
            closed_where.append("substr(exit_date, 1, 10) BETWEEN ? AND ?")
            closed_params += [date_from or "0000-00-00", date_to or "9999-99-99"]
        closed = [dict(r) for r in conn.execute(
            "SELECT close_trade_id, open_trade_id, account_id, occ_symbol, underlying, option_type, "
            "strike, expiry, multiplier, currency, direction, quantity, entry_date, entry_price, "
            "exit_date, exit_price, close_reason, fees_alloc, realized_pnl FROM v_option_realized"
            + (" WHERE " + " AND ".join(closed_where) if closed_where else "")
            + " ORDER BY exit_date DESC, close_trade_id, open_trade_id", closed_params)]
        open_lots = [dict(r) for r in conn.execute(
            "SELECT lot_id, account_id, occ_symbol, underlying, option_type, strike, expiry, "
            "multiplier, currency, direction, quantity, entry_date, entry_price, entry_fees "
            "FROM v_option_open_lots" + clause + " ORDER BY expiry, underlying", params)]
        fills = conn.execute("SELECT COUNT(*) FROM option_trades").fetchone()[0]
    by_ccy: dict[str, list[dict]] = defaultdict(list)
    for r in closed:
        by_ccy[str(r.get("currency") or "USD").upper()].append(r)
    totals = []
    for ccy, group in sorted(by_ccy.items()):
        known = [float(r["realized_pnl"]) for r in group if r.get("realized_pnl") is not None]
        totals.append({
            "currency": ccy, "round_trips": len(group),
            "wins": sum(1 for p in known if p > 0), "losses": sum(1 for p in known if p <= 0),
            "realized_pnl": _sum(known) if known else None,
            "pnl_not_recorded": len(group) - len(known),
        })
    page = closed[offset:offset + limit]
    end = offset + len(page)
    complete = offset == 0 and end >= len(closed)
    notes = [
        "A round trip is one close matched to one open; a position closed in parts is several rows.",
        "direction 1 = bought (long), −1 = written (short). realized_pnl = direction × "
        "(exit_price − entry_price) × quantity × multiplier − fees_alloc, in `currency`.",
        "realized_pnl null = the closing price was never recorded: unknown, not zero.",
        "open_lots carry no P&L here — valuing them needs a live option chain.",
    ]
    if date_from or date_to:
        notes.append("Dates filter round_trips by exit date; open_lots are not date-filtered.")
    if not closed and not open_lots:
        notes.append("No option trades match. That is the answer.")
    return {
        "as_of": _now(),
        "source": {"database": "SQLite portfolio.db",
                   "tables": "option_trades + option_trade_matches + option_contracts",
                   "fills_in_table": fills},
        "query": {"underlying": sym, "account_id": account_id, "date_from": date_from,
                  "date_to": date_to, "limit": limit, "offset": offset},
        "total_matching": len(closed),
        "returned": len(page),
        "complete": complete,
        "next_offset": end if end < len(closed) else None,
        "totals": totals,
        "notes": notes,
        "round_trips": page,
        "open_lots": open_lots,
    }


# ── coverage ─────────────────────────────────────────────────────────────────

def coverage() -> dict:
    with get_db() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT account_id, symbol, resolved_symbol, market, currency, win_loss, date_entry, "
            "date_exit, strategy_name, sector, note FROM trades")]
        names = _accounts(conn)
        source = _source(conn)
        opt_fills = conn.execute("SELECT COUNT(*) FROM option_trades").fetchone()[0]
        opt_closed = conn.execute("SELECT COUNT(*) FROM v_option_realized").fetchone()[0]
        opt_open = conn.execute("SELECT COUNT(*) FROM v_option_open_lots").fetchone()[0]
        opt_under = [r[0] for r in conn.execute(
            "SELECT DISTINCT UPPER(c.underlying) FROM option_trades t "
            "JOIN option_contracts c ON c.contract_id = t.contract_id ORDER BY 1")]
        dividends = conn.execute("SELECT COUNT(*) FROM dividends").fetchone()[0]

    def _span(group: list[dict]) -> dict:
        entries = sorted(str(r["date_entry"])[:10] for r in group if r.get("date_entry"))
        exits = sorted(str(r["date_exit"])[:10] for r in group if r.get("date_exit"))
        return {
            "lots": len(group),
            "open_lots": sum(1 for r in group if r["win_loss"] == "P"),
            "closed_lots": sum(1 for r in group if r["win_loss"] != "P"),
            "first_entry": entries[0] if entries else None,
            "last_entry": entries[-1] if entries else None,
            "first_exit": exits[0] if exits else None,
            "last_exit": exits[-1] if exits else None,
        }

    by_account: dict[str, list[dict]] = defaultdict(list)
    by_symbol: dict[tuple, list[dict]] = defaultdict(list)
    strategies: dict[str, int] = defaultdict(int)
    sectors: dict[str, int] = defaultdict(int)
    for r in rows:
        by_account[r["account_id"]].append(r)
        by_symbol[(str(r["symbol"] or "").upper(), r.get("resolved_symbol"), r.get("market"),
                   str(r.get("currency") or "").upper(), r["account_id"])].append(r)
        strategies[_label(r.get("strategy_name"))] += 1
        sectors[_label(r.get("sector"))] += 1

    return {
        "as_of": _now(),
        "source": source,
        "what_a_row_is": ("One LOT of a stock / ETF / crypto / future symbol: bought once, held, "
                          "and either still open or sold. A partial sale splits a lot in two, so "
                          "lots are not orders and several lots can make one position."),
        "book": _span(rows),
        "accounts": [
            {"account_id": acc, "name": names.get(acc, {}).get("name"),
             "account_currency": names.get(acc, {}).get("currency"),
             "sub_ports": sorted({sub_port_of(r.get("note")) for r in group} - {""}),
             "currencies_traded": sorted({str(r.get("currency") or "").upper() for r in group}),
             **_span(group)}
            for acc, group in sorted(by_account.items())
        ],
        "symbols": [
            {"symbol": k[0], "resolved_symbol": k[1], "market": k[2], "currency": k[3],
             "account_id": k[4], **_span(group)}
            for k, group in sorted(by_symbol.items(), key=lambda kv: (kv[0][0], kv[0][4]))
        ],
        "strategies": [{"strategy": k, "lots": v} for k, v in sorted(strategies.items(), key=lambda kv: -kv[1])],
        "sectors": [{"sector": k, "lots": v} for k, v in sorted(sectors.items(), key=lambda kv: -kv[1])],
        "options": {"fills": opt_fills, "closed_round_trips": opt_closed, "open_lots": opt_open,
                    "underlyings": opt_under,
                    "note": "Separate tables — read with the options endpoint; stats folds closed round trips in."},
        "not_in_this_data": [
            f"Dividends ({dividends} rows) and cash deposits / withdrawals — not trades.",
            "Live prices and unrealized P&L of open lots — get_positions.",
            "Trades deleted by the user (only a DELETE line in the audit log remains).",
            "Anything before the first_entry date above: it was never recorded here.",
        ],
        "fields": FIELDS,
        "rules": RULES,
    }


# ── endpoints ────────────────────────────────────────────────────────────────

@router.get("/coverage")
def get_coverage():
    return coverage()


@router.get("/trades")
def get_trades(
    symbol: Optional[str] = Query(None, description="Exact ticker (DELTA or DELTA.BK), case-insensitive"),
    account_id: Optional[str] = Query(None),
    status: Status = Query("all"),
    result: Optional[Result] = Query(None),
    date_from: Optional[str] = Query(None, description="YYYY-MM-DD, inclusive"),
    date_to: Optional[str] = Query(None, description="YYYY-MM-DD, inclusive"),
    date_field: DateField = Query("any"),
    strategy: Optional[str] = Query(None),
    sector: Optional[str] = Query(None),
    sub_port: Optional[str] = Query(None),
    market: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=MAX_LIMIT),
    offset: int = Query(0, ge=0),
    order: Order = Query("newest"),
    detail: Detail = Query("brief"),
):
    return list_lots(symbol=symbol, account_id=account_id, status=status, result=result,
                     date_from=date_from, date_to=date_to, date_field=date_field,
                     strategy=strategy, sector=sector, sub_port=sub_port, market=market,
                     limit=limit, offset=offset, order=order, detail=detail)


@router.get("/trades/{trade_id}")
def get_trade(trade_id: str):
    return one_lot(trade_id)


@router.get("/stats")
def get_stats(
    group_by: GroupBy = Query("none"),
    symbol: Optional[str] = Query(None),
    account_id: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    date_field: DateField = Query("exit"),
    strategy: Optional[str] = Query(None),
    sector: Optional[str] = Query(None),
    sub_port: Optional[str] = Query(None),
    market: Optional[str] = Query(None),
    include_options: bool = Query(True),
    base_currency: Optional[str] = Query(None),
):
    return lot_stats(group_by=group_by, symbol=symbol, account_id=account_id,
                     date_from=date_from, date_to=date_to, date_field=date_field,
                     strategy=strategy, sector=sector, sub_port=sub_port, market=market,
                     include_options=include_options, base_currency=base_currency)


@router.get("/options")
def get_options(
    underlying: Optional[str] = Query(None),
    account_id: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=MAX_LIMIT),
    offset: int = Query(0, ge=0),
):
    return option_history(underlying=underlying, account_id=account_id,
                          date_from=date_from, date_to=date_to, limit=limit, offset=offset)
