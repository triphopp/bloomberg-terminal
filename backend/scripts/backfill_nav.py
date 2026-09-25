"""Rebuild daily NAV snapshots for days nobody opened the terminal.

`portfolio_nav_snapshots` is captured once a day when PORT is viewed, so the
book's history starts on the first day that happened (2026-07-03). Everything
before is invisible to GROWTH / INDEX. This rebuilds those days from trade
history and daily closes, the same way the live capture values today:

    holdings on day d = lots with date_entry <= d < date_exit (or still open)
    total_value       = Σ qty × close(d), in THB at that day's USD/THB close
    realized_pnl      = Σ pnl_amount of lots exited on or before d, converted
                        per trade at its exit FX (realized_pnl_in_report)
    open_cost_basis   = Σ cost of the held lots (entry FX)

invested_capital and dividends are re-derived by /nav-history from the ledgers
by date, so what is stored for them here does not matter.

History of this script: the first run (2026-07-03) was WRONG — 21 lots carried
the data-entry date as their exit and 22 a 2025-01-01 placeholder entry, so
positions sold months earlier were held through rallies. Those dates were fixed
2026-09-25 (Dime exits by price-match; Dime entries by price-match confirmed by
the user; Finansia's 2025-01-01 lots really were held before 2026 and their
฿1.88M opening balance moved to 2025-12-31). Run --validate before --apply.

Usage (from backend/):
    python scripts/backfill_nav.py                      # dry run 2026-01-01 → day before first live snapshot
    python scripts/backfill_nav.py --validate           # rebuild the LIVE span too and compare with the real snapshots
    python scripts/backfill_nav.py --apply              # insert (never overwrites a live row; backs up the DB)
    python scripts/backfill_nav.py --start 2026-03-01 --end 2026-03-31
"""
from __future__ import annotations

import argparse
import io
import os
import shutil
import sqlite3
import sys
from statistics import median
from collections import defaultdict
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pandas as pd  # noqa: E402
import yfinance as yf  # noqa: E402

from config import DB_PATH  # noqa: E402
from portfolio_currency import trade_currency  # noqa: E402

# Re-derived by nav-history, and the router pulls in half the app — import lazily.


def _f(v) -> float:
    try:
        return float(v) if v is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def _d(v) -> str:
    return str(v or "")[:10]


def _connect(read_only: bool) -> sqlite3.Connection:
    if read_only:
        uri = "file:" + os.path.abspath(DB_PATH).replace("\\", "/") + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True)
    else:
        conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def load(conn):
    accounts = {r["id"]: dict(r) for r in conn.execute(
        "SELECT id, currency FROM portfolio_accounts WHERE is_active = 1")}
    trades = []
    for r in conn.execute("SELECT * FROM trades"):
        t = dict(r)
        if t["account_id"] not in accounts:
            continue
        t["acc_currency"] = accounts[t["account_id"]]["currency"]
        trades.append(t)
    return accounts, trades


def fetch_prices(symbols: list[str], start: str) -> tuple[pd.DataFrame, pd.Series]:
    raw = yf.download(symbols, start=start, end=None, interval="1d",
                      auto_adjust=False, progress=False, group_by="column")
    closes = raw["Close"]
    if isinstance(closes, pd.Series):
        closes = closes.to_frame(name=symbols[0])
    closes.index = pd.to_datetime(closes.index).date
    fx = yf.download("THB=X", start=start, end=None, interval="1d",
                     auto_adjust=False, progress=False)["Close"]
    if isinstance(fx, pd.DataFrame):
        fx = fx.iloc[:, 0]
    fx.index = pd.to_datetime(fx.index).date
    return closes, fx


def build(accounts, trades, closes, fx, days: list[str]) -> tuple[list[tuple], dict]:
    """Rows for portfolio_nav_snapshots + a record of what could not be priced."""
    from portfolio_currency import realized_pnl_in_report, trade_value_in_report

    idx = sorted(set(closes.index) | set(fx.index) | {date.fromisoformat(d) for d in days})
    closes = closes.reindex(idx).ffill()
    fx = fx.reindex(idx).ffill().bfill()
    unpriced: dict[str, set] = defaultdict(set)

    # Realized per lot in THB is date-independent once exited; compute once.
    realized_thb = {t["id"]: realized_pnl_in_report(t, "THB")
                    for t in trades if t.get("win_loss") != "P" and _d(t.get("date_exit"))}
    cost_thb = {}
    for t in trades:
        native = _f(t.get("amount")) or _f(t["price_entry"]) * _f(t["volume"])
        cost_thb[t["id"]] = trade_value_in_report(t, native, "THB", when="entry")

    from routers.portfolio_v2 import _trade_yf_symbol
    ysym = {t["id"]: _trade_yf_symbol(t) for t in trades}

    rows = []
    for ds in days:
        d = date.fromisoformat(ds)
        usd_thb = float(fx.loc[d])
        g = defaultdict(float)
        for aid in accounts:
            total = cost = realized = 0.0
            for t in trades:
                if t["account_id"] != aid:
                    continue
                de, dx = _d(t["date_entry"]), _d(t.get("date_exit"))
                if dx and dx <= ds and t.get("win_loss") != "P":
                    realized += realized_thb.get(t["id"], 0.0)
                if not de or de > ds or (dx and dx <= ds):
                    continue
                if str(t["symbol"]).upper().startswith(("PUT_", "CALL_")):
                    continue
                vol = _f(t["volume"])
                c = cost_thb[t["id"]]
                cost += c
                sym = ysym[t["id"]]
                px = closes.at[d, sym] if sym in closes.columns else None
                if px is None or pd.isna(px):
                    unpriced[f"{aid}:{t['symbol']}"].add(ds)
                    total += c  # no quote: carry at cost rather than drop it
                    continue
                ccy = trade_currency(t)
                rate = usd_thb if ccy == "USD" else 1.0
                total += float(px) * vol * rate
            rows.append((aid, ds, total, cost, total - cost, realized))
            g["total"] += total; g["cost"] += cost; g["real"] += realized
        rows.append(("all", ds, g["total"], g["cost"], g["total"] - g["cost"], g["real"]))
    return rows, unpriced


def trading_days(start: str, end: str, closes: pd.DataFrame) -> list[str]:
    """Weekdays in range that at least one market traded."""
    have = {d.isoformat() for d in closes.dropna(how="all").index}
    out, d = [], date.fromisoformat(start)
    while d.isoformat() <= end:
        if d.weekday() < 5 and d.isoformat() in have:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def nav_with_cash(rows_by_key, inv_by_acct_day, div_by_acct_day, aid, ds):
    """Same identity /nav-history uses (without reconciliation offsets):
    NAV = holdings MV + (invested + realized + dividends − open cost)."""
    total, cost, _u, realized = rows_by_key[(aid, ds)]
    return total + inv_by_acct_day(aid, ds) + realized + div_by_acct_day(aid, ds) - cost


def live_nav_rows(rows):
    """Validation must compare with observations, never with its own backfill."""
    return {r["snapshot_date"]: r for r in rows if r.get("source") == "live"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-01-01")
    ap.add_argument("--end", help="default: the day before the first live snapshot")
    ap.add_argument("--validate", action="store_true",
                    help="also rebuild the live span and compare with the real snapshots")
    ap.add_argument("--validation-json", help="write N1 samples (requires --validate)")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    if args.validation_json and not args.validate:
        ap.error("--validation-json requires --validate")
    if hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

    conn = _connect(read_only=True)
    accounts, trades = load(conn)
    live = {(r["account_id"], r["snapshot_date"]): dict(r) for r in conn.execute(
        "SELECT * FROM portfolio_nav_snapshots")}
    first_live = min((d for (a, d), r in live.items() if a == "all" and r.get("source") == "live"), default=date.today().isoformat())
    end = args.end or (date.fromisoformat(first_live) - timedelta(days=1)).isoformat()
    span_end = max(end, max((d for (a, d) in live if a == "all"), default=end)) if args.validate else end

    from routers.portfolio_v2 import _trade_yf_symbol
    symbols = sorted({s for t in trades if (s := _trade_yf_symbol(t))
                      and not str(t["symbol"]).upper().startswith(("PUT_", "CALL_"))})
    fetch_from = (date.fromisoformat(args.start) - timedelta(days=10)).isoformat()
    print(f"== NAV backfill {'APPLY' if args.apply else 'DRY RUN'} — {args.start} → {end}"
          f"  ({len(symbols)} symbols, first live snapshot {first_live})")
    closes, fx = fetch_prices(symbols, fetch_from)

    days = trading_days(args.start, span_end, closes)
    rows, unpriced = build(accounts, trades, closes, fx, days)
    by_key = {(r[0], r[1]): r[2:] for r in rows}

    # ledger-by-date helpers, identical to /nav-history's re-derivation
    import routers.portfolio_v2 as pv2
    hist_cache = {}

    def hist(aid):
        if aid not in hist_cache:
            hist_cache[aid] = pv2.get_nav_history(account_id=aid, days=100000)
        return hist_cache[aid]

    ledger = [dict(r) for r in conn.execute("SELECT account_id, date, investment FROM cash_ledger")]
    divs = [dict(r) for r in conn.execute(
        "SELECT d.*, a.currency acc_currency FROM dividends d JOIN portfolio_accounts a ON a.id=d.account_id")]
    from portfolio_currency import convert_amount

    def inv(aid, ds):
        return sum(_f(l["investment"]) for l in ledger
                   if (aid == "all" and l["account_id"] in accounts or l["account_id"] == aid)
                   and _d(l["date"]) <= ds)

    div_events = [(d["account_id"], _d(d.get("pay_date") or d.get("ex_date")),
                   convert_amount(_f(d["total_received"]), d.get("currency") or d.get("acc_currency"),
                                  "THB", date=d.get("pay_date") or d.get("ex_date"))) for d in divs]

    def div(aid, ds):
        return sum(v for a, dd, v in div_events
                   if (aid == "all" and a in accounts or a == aid) and dd and dd <= ds)

    if unpriced:
        print("\nno close (carried at cost):")
        for k, v in sorted(unpriced.items()):
            print(f"  {k:24} {len(v)} day(s)  {min(v)} … {max(v)}")

    # Monthly view of the rebuilt span (ALL)
    print("\n== rebuilt NAV (ALL, THB) — month end")
    months = {}
    for ds in days:
        if ds <= end:
            months[ds[:7]] = ds
    print(f"  {'month':7} {'holdings MV':>14} {'invested':>14} {'realized':>12} {'NAV':>14}")
    for m, ds in months.items():
        total, cost, _u, realized = by_key[("all", ds)]
        print(f"  {m:7} {total:>14,.0f} {inv('all', ds):>14,.0f} {realized:>12,.0f} "
              f"{nav_with_cash(by_key, inv, div, 'all', ds):>14,.0f}")

    if args.validate:
        validation_samples = []
        print("\n== validation: rebuilt vs LIVE snapshot, nav_with_cash without cash EDIT offsets")
        for aid in ["all", *accounts]:
            live_rows = live_nav_rows(hist(aid))
            diffs = []
            for ds in days:
                if ds < first_live or ds not in live_rows:
                    continue
                h = live_rows[ds]
                real_nav = h["nav_with_cash"] - h["cash_adjustment"]
                est = nav_with_cash(by_key, inv, div, aid, ds)
                if real_nav:
                    diffs.append((ds, (est / real_nav - 1) * 100, est, real_nav))
                    validation_samples.append({"account_id": aid, "date": ds, "rebuilt": est, "live": real_nav, "source": "live"})
            if not diffs:
                print(f"  {aid:10} no overlap")
                continue
            ab = sorted(abs(x[1]) for x in diffs)
            worst = max(diffs, key=lambda x: abs(x[1]))
            print(f"  {aid:10} {len(diffs):3} days  median |Δ| {median(ab):.2f}%  "
                  f"p90 {ab[int(len(ab) * 0.9)]:.2f}%  worst {worst[1]:+.2f}% on {worst[0]} "
                  f"(rebuilt {worst[2]:,.0f} vs live {worst[3]:,.0f})")
        if args.validation_json:
            import json
            from pathlib import Path
            Path(args.validation_json).write_text(json.dumps(validation_samples, indent=2, allow_nan=False), encoding="utf-8")

    if args.apply:
        new = [r for r in rows if r[1] <= end and (r[0], r[1]) not in live]
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = f"{DB_PATH}.bak-{stamp}-pre-nav-backfill"
        src = sqlite3.connect(DB_PATH)
        dst = sqlite3.connect(backup)
        src.backup(dst)
        dst.close()
        src.close()
        conn.close()
        w = _connect(read_only=False)
        with w:
            w.executemany("""
                INSERT INTO portfolio_nav_snapshots
                    (account_id, snapshot_date, total_value, open_cost_basis,
                     unrealized_pnl, realized_pnl, invested_capital, dividends, source)
                VALUES (?,?,?,?,?,?,0,0,'backfill')
                ON CONFLICT(account_id, snapshot_date) DO NOTHING
            """, new)
        print(f"\nbackup: {backup}\ninserted {len(new)} rows ({len(new) // (len(accounts) + 1)} days) as source='backfill'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
