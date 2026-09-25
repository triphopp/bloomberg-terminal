"""Match cited broker fills (`broker_executions`) with the reconstructed book.

Read-only. A screenshot proves a fill's quantity, price and time; the legacy
`trades` table often does not hold fills at all — it may merge several buys
into one lot, or keep only what was left after selling part of a position.
Each fill and each reconstructed BUY/SELL ends up in exactly one bucket:

* MATCHED       one fill = one book event (same day, quantity, price)
* CONSOLIDATED  several fills of one side = one book lot (Σqty equal, VWAP ≈ price)
* NETTED        buys − sells = one book BUY at the buys' VWAP: the round trip
                on the sold part never reached the book, nor did its P&L
* MISSING_IN_DB a fill with no book counterpart
* NO_EVIDENCE   a book event inside the fills' date range with no fill
* OUT_OF_COVERAGE a book event outside that range (not a finding — the
                imported screenshots are a sample, not a statement)

Fees: a Dime buy shows the order amount; amount − qty × price is the
commission + VAT the book does not record (FEE_GAP). Sale fees are not shown.

Times on Dime Activity are Thai local; the trade date is the New York date.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from itertools import combinations
from zoneinfo import ZoneInfo

import ledger_backfill as lb

DISPLAY_TZ = "Asia/Bangkok"
_BKK = ZoneInfo(DISPLAY_TZ)
_NY = ZoneInfo("America/New_York")

QTY_TOL = 1e-6          # relative, floor 1e-6 shares
PRICE_EXACT = 0.0005    # 0.05 %: one fill vs one book row
PRICE_VWAP = 0.005      # 0.5 %: a merged lot rounds its average
WINDOW_DAYS = 45        # how far apart merged fills may be
MAX_SUBSET = 14         # brute-force cap per side and symbol


def us_trade_date(local_stamp: str) -> str:
    t = datetime.fromisoformat(local_stamp).replace(tzinfo=_BKK)
    return t.astimezone(_NY).date().isoformat()


def _same_qty(a: float, b: float) -> bool:
    return abs(a - b) <= QTY_TOL * max(1.0, abs(a), abs(b))


def _near(a: float, b: float, tol: float) -> bool:
    return b > 0 and abs(a - b) <= tol * b


def _days(a: str, b: str) -> int:
    return abs((date.fromisoformat(a) - date.fromisoformat(b)).days)


def _vwap(fills) -> float:
    q = sum(f["qty"] for f in fills)
    return sum(f["qty"] * f["price"] for f in fills) / q if q else 0.0


def _load_fills(conn, account_id=None) -> list[dict]:
    has = conn.execute("SELECT 1 FROM sqlite_master WHERE name='broker_executions'").fetchone()
    if not has:
        return []
    sql = "SELECT * FROM broker_executions"
    args: tuple = ()
    if account_id:
        sql += " WHERE account_id=?"
        args = (account_id,)
    out = []
    for r in conn.execute(sql + " ORDER BY executed_at_local", args):
        r = dict(r)
        qty, price = float(r["quantity"]), float(r["unit_price"])
        amount = float(r["order_amount"]) if r.get("order_amount") else None
        fee = None
        if r["side"] == "BUY" and amount is not None and (r.get("order_ccy") or "") == r["instrument_ccy"]:
            fee = round(amount - qty * price, 6)
        cash = -(amount if amount is not None else qty * price) if r["side"] == "BUY" else qty * price
        out.append({"id": r["id"], "account_id": r["account_id"], "symbol": r["symbol"].upper(),
                    "side": r["side"], "local_time": r["executed_at_local"],
                    "us_date": us_trade_date(r["executed_at_local"]),
                    "qty": qty, "price": price, "order_amount": amount, "fee": fee,
                    "cash": cash, "currency": r["instrument_ccy"],
                    "source_image": r["source_image"], "display_timezone": r.get("display_timezone")})
    return out


def _match_symbol(fills: list[dict], events: list) -> list[dict]:
    rows: list[dict] = []
    used_f: set[str] = set()
    used_e: set[str] = set()
    lo = min(f["us_date"] for f in fills)
    hi = max(f["us_date"] for f in fills)

    def row(status, fs, es, **extra):
        fq = sum(f["qty"] for f in fs)
        return {"status": status,
                "side": (fs[0]["side"] if fs else es[0].type),
                "fill_ids": [f["id"] for f in fs], "event_ids": [e.id for e in es],
                "source_refs": sorted({r for e in es for r in e.source_ref}),
                "images": sorted({f["source_image"] for f in fs}),
                "us_date": fs[-1]["us_date"] if fs else None,
                "local_time": fs[-1]["local_time"] if fs else None,
                "fill_qty": fq if fs else None,
                "fill_price": _vwap(fs) if fs else None,
                "book_date": es[0].trade_date if es else None,
                "book_qty": sum(e.qty or 0 for e in es) if es else None,
                "book_price": es[0].price if es else None,
                "broker_cash": sum(f["cash"] for f in fs) if fs else None,
                "book_cash": sum(e.net_cash for e in es) if es else None,
                "fee_gap": sum(f["fee"] or 0 for f in fs if f["fee"] and f["fee"] > 0.005) or None,
                **extra}

    # 1 — one fill, one event
    for f in fills:
        for e in events:
            if e.id in used_e or e.type != f["side"]:
                continue
            if e.trade_date not in (f["us_date"], f["local_time"][:10]):
                continue
            if _same_qty(f["qty"], e.qty or 0) and _near(f["price"], e.price or 0, PRICE_EXACT):
                used_f.add(f["id"]); used_e.add(e.id)
                rows.append(row("MATCHED", [f], [e]))
                break

    # 2 — several fills of one side, one lot
    for e in sorted(events, key=lambda e: e.trade_date):
        if e.id in used_e:
            continue
        pool = [f for f in fills if f["id"] not in used_f and f["side"] == e.type
                and f["us_date"] <= e.trade_date and _days(f["us_date"], e.trade_date) <= WINDOW_DAYS]
        pool = pool[-MAX_SUBSET:]
        hit = None
        for n in range(len(pool), 1, -1):
            for combo in combinations(pool, n):
                if _same_qty(sum(f["qty"] for f in combo), e.qty or 0) and \
                        _near(_vwap(combo), e.price or 0, PRICE_VWAP):
                    hit = list(combo)
                    break
            if hit:
                break
        if hit:
            used_e.add(e.id); used_f.update(f["id"] for f in hit)
            rows.append(row("CONSOLIDATED", hit, [e]))

    # 3 — buys minus sells, one BUY lot at the buys' average
    for e in sorted(events, key=lambda e: e.trade_date):
        if e.id in used_e or e.type != "BUY":
            continue
        near = [f for f in fills if f["id"] not in used_f and _days(f["us_date"], e.trade_date) <= WINDOW_DAYS]
        buys = [f for f in near if f["side"] == "BUY"][-MAX_SUBSET // 2:]
        sells = [f for f in near if f["side"] == "SELL"][-MAX_SUBSET // 2:]
        hit = None
        for nb in range(len(buys), 0, -1):
            for bset in combinations(buys, nb):
                if not _near(_vwap(bset), e.price or 0, PRICE_VWAP):
                    continue
                bq = sum(f["qty"] for f in bset)
                first = min(f["us_date"] for f in bset)
                for ns in range(len(sells), 0, -1):
                    for sset in combinations(sells, ns):
                        if min(f["us_date"] for f in sset) < first:
                            continue
                        if _same_qty(bq - sum(f["qty"] for f in sset), e.qty or 0):
                            hit = (list(bset), list(sset))
                            break
                    if hit:
                        break
                if hit:
                    break
            if hit:
                break
        if hit:
            bset, sset = hit
            avg = _vwap(bset)
            sold = sum(f["qty"] for f in sset)
            realized = sum(f["qty"] * f["price"] for f in sset) - sold * avg
            used_e.add(e.id); used_f.update(f["id"] for f in bset + sset)
            r = row("NETTED", bset + sset, [e], sold_qty=sold,
                    missing_realized=round(realized, 6))
            # What the book kept: the unsold remainder at the buys' average.
            r.update(fill_qty=sum(f["qty"] for f in bset) - sold, fill_price=avg)
            rows.append(r)

    # 4 — what is left
    for f in fills:
        if f["id"] not in used_f:
            rows.append(row("MISSING_IN_DB", [f], []))
    for e in events:
        if e.id not in used_e:
            status = "NO_EVIDENCE" if lo <= e.trade_date <= hi else "OUT_OF_COVERAGE"
            rows.append(row(status, [], [e]))
    rows.sort(key=lambda r: (r["us_date"] or r["book_date"] or "", r["local_time"] or ""))
    return rows


def run(conn, account_id: str | None = None) -> dict:
    fills = _load_fills(conn, account_id)
    events, _issues = lb.build_events(conn)
    book = defaultdict(list)
    for e in events:
        if e.type in ("BUY", "SELL") and not e.note.startswith("option"):
            book[(e.account_id, (e.symbol or "").upper())].append(e)

    by_key = defaultdict(list)
    for f in fills:
        by_key[(f["account_id"], f["symbol"])].append(f)

    symbols, rows = [], []
    for (aid, sym), fs in sorted(by_key.items()):
        matched = _match_symbol(fs, book.get((aid, sym), []))
        for r in matched:
            r.update(account_id=aid, symbol=sym)
        rows.extend(matched)
        lo, hi = min(f["us_date"] for f in fs), max(f["us_date"] for f in fs)
        inside = [r for r in matched if r["status"] != "OUT_OF_COVERAGE"]
        counts = defaultdict(int)
        for r in matched:
            counts[r["status"]] += 1
        broker_cash = sum(f["cash"] for f in fs)
        in_cov = {i for r in inside for i in r["event_ids"]}
        book_in = [e for e in book[(aid, sym)] if e.id in in_cov]
        book_cash = sum(e.net_cash for e in book_in)
        signed = {"BUY": 1, "SELL": -1}
        broker_qty = sum(signed[f["side"]] * f["qty"] for f in fs)
        book_qty = sum(signed[e.type] * (e.qty or 0) for e in book_in)
        fee_gap = sum(f["fee"] for f in fs if f["fee"] and f["fee"] > 0.005)
        symbols.append({
            "account_id": aid, "symbol": sym, "currency": fs[0]["currency"],
            "coverage_from": lo, "coverage_to": hi, "fills": len(fs),
            "counts": dict(counts),
            "broker_cash": round(broker_cash, 6), "book_cash": round(book_cash, 6),
            "cash_gap": round(book_cash - broker_cash, 6),
            "fee_gap": round(fee_gap, 6),
            # The book omits commissions, so a gap equal to them is explained.
            "cash_gap_ex_fees": round(book_cash - broker_cash - fee_gap, 6),
            "broker_net_qty": round(broker_qty, 7), "book_net_qty": round(book_qty, 7),
            "qty_match": _same_qty(broker_qty, book_qty),
            "missing_realized": round(sum(r.get("missing_realized") or 0 for r in matched), 6),
            "verified": counts["MISSING_IN_DB"] == 0 and counts["NETTED"] == 0
                        and counts["NO_EVIDENCE"] == 0
                        and abs(book_cash - broker_cash - fee_gap) <= 0.05,
        })

    totals = defaultdict(int)
    for r in rows:
        totals[r["status"]] += 1
    by_ccy = defaultdict(lambda: {"cash_gap": 0.0, "fee_gap": 0.0, "cash_gap_ex_fees": 0.0,
                                  "missing_realized": 0.0})
    for s in symbols:
        t = by_ccy[s["currency"]]
        for k in t:
            t[k] = round(t[k] + s[k], 6)
    return {"as_of": datetime.now().astimezone().isoformat(timespec="seconds"),
            "source": "broker_executions vs reconstructed legacy history",
            "account_id": account_id, "display_timezone_assumed": DISPLAY_TZ,
            "fills": len(fills), "counts": dict(totals), "totals": dict(by_ccy),
            "symbols": symbols, "rows": rows,
            "note": "Screenshots are a sample; OUT_OF_COVERAGE rows are unchecked, not wrong. "
                    "cash_gap = book − broker (before sale fees); positive means the book holds more cash."}
