"""One-off backfill of portfolio_nav_snapshots from historical closes.

⚠️ DO NOT RUN against the current trades table — results verified WRONG 2026-07-03.
The reconstruction assumes date_entry/date_exit are real trade dates, but the DB
contains placeholders: 21 trades share date_exit 2026-06-06 (a Saturday — bulk
data-entry date, not a real sell date) and 22 trades share date_entry 2025-01-01.
Positions the user had long since sold get held open through rallies (e.g. INTC
40→129) producing fake NAV peaks (dime "5.7M THB"). Synthetic rows from the first
run were deleted the same day. Only usable if/when trade dates become trustworthy.

Reconstructs daily NAV per account (THB base) from trade history:
holdings on day d = trades with date_entry <= d < date_exit (or still open),
valued at that day's raw close (auto_adjust=False to match entry prices).
USD accounts converted with the historical THB=X close of the same day.

Existing rows (e.g. today's live capture) are preserved via ON CONFLICT DO NOTHING.

Run from backend/:  python -m scripts.backfill_nav
"""
import sys
from datetime import date, datetime
from pathlib import Path

import pandas as pd
import yfinance as yf

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db import get_db
from routers.portfolio_v2 import _get_yf_symbol


def _f(v) -> float:
    try:
        return float(v) if v is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def main() -> None:
    today = date.today().isoformat()

    with get_db() as conn:
        accounts = {
            a["id"]: dict(a)
            for a in conn.execute(
                "SELECT id, currency FROM portfolio_accounts WHERE is_active = 1"
            ).fetchall()
        }
        trades = [dict(r) for r in conn.execute(
            "SELECT account_id, symbol, date_entry, date_exit, win_loss, "
            "       volume, price_entry, amount, COALESCE(pnl_amount, 0) pnl "
            "FROM trades"
        ).fetchall()]
        ledger = [dict(r) for r in conn.execute(
            "SELECT account_id, date, COALESCE(investment, 0) investment FROM cash_ledger"
        ).fetchall()]
        divs = [dict(r) for r in conn.execute(
            "SELECT account_id, pay_date, COALESCE(total_received, 0) total FROM dividends"
        ).fetchall()]

    if not trades:
        print("no trades — nothing to backfill")
        return

    start = min(t["date_entry"] for t in trades if t["date_entry"])
    print(f"backfill range: {start} -> {today}")

    # Resolve yfinance symbols (skip options)
    for t in trades:
        t["yf"] = _get_yf_symbol(t["symbol"], t["account_id"])
    symbols = sorted({t["yf"] for t in trades if t["yf"]})
    print(f"symbols ({len(symbols)}): {symbols}")

    raw = yf.download(symbols, start=start, end=None, interval="1d",
                      auto_adjust=False, progress=False)
    closes = raw["Close"]
    if isinstance(closes, pd.Series):  # single-symbol shape
        closes = closes.to_frame(name=symbols[0])
    closes.index = pd.to_datetime(closes.index).date

    fx_raw = yf.download("THB=X", start=start, end=None, interval="1d",
                         auto_adjust=False, progress=False)["Close"]
    if isinstance(fx_raw, pd.DataFrame):
        fx_raw = fx_raw.iloc[:, 0]
    fx_raw.index = pd.to_datetime(fx_raw.index).date

    # Unified daily calendar; forward-fill across market-holiday mismatches
    idx = sorted(set(closes.index) | set(fx_raw.index))
    closes = closes.reindex(idx).ffill()
    fx = fx_raw.reindex(idx).ffill().fillna(33.5)

    rows: list[tuple] = []
    for d in idx:
        ds = d.isoformat()
        if ds >= today:
            continue  # today handled by live capture-on-view
        fx_d = float(fx.loc[d])
        g = {"total": 0.0, "cost": 0.0, "unreal": 0.0, "real": 0.0, "inv": 0.0, "div": 0.0}
        for aid, acc in accounts.items():
            afx = fx_d if acc["currency"] == "USD" else 1.0
            cost = unreal = 0.0
            for t in trades:
                if t["account_id"] != aid or not t["date_entry"] or t["date_entry"] > ds:
                    continue
                if t["date_exit"] and t["date_exit"] <= ds:
                    continue  # already sold by day d
                vol = _f(t["volume"])
                entry = _f(t["price_entry"])
                cost_native = _f(t["amount"]) or entry * vol
                cost += cost_native * afx
                px = closes.at[d, t["yf"]] if t["yf"] in closes.columns else None
                if px is not None and pd.notna(px) and entry > 0:
                    unreal += (float(px) - entry) * vol * afx
            realized = sum(
                t["pnl"] for t in trades
                if t["account_id"] == aid and t["date_exit"] and t["date_exit"] <= ds
            ) * afx
            invested = sum(
                l["investment"] for l in ledger
                if l["account_id"] == aid and l["date"] and l["date"] <= ds
            )
            dividend = sum(
                v["total"] for v in divs
                if v["account_id"] == aid and v["pay_date"] and v["pay_date"] <= ds
            )
            total = cost + unreal
            rows.append((aid, ds, total, cost, unreal, realized, invested, dividend))
            g["total"] += total; g["cost"] += cost; g["unreal"] += unreal
            g["real"] += realized; g["inv"] += invested; g["div"] += dividend
        rows.append(("all", ds, g["total"], g["cost"], g["unreal"],
                     g["real"], g["inv"], g["div"]))

    with get_db() as conn:
        conn.executemany("""
            INSERT INTO portfolio_nav_snapshots
                (account_id, snapshot_date, total_value, open_cost_basis,
                 unrealized_pnl, realized_pnl, invested_capital, dividends)
            VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(account_id, snapshot_date) DO NOTHING
        """, rows)
        n = conn.execute("SELECT COUNT(*) FROM portfolio_nav_snapshots").fetchone()[0]
    print(f"inserted (attempted {len(rows)}), table now has {n} rows")


if __name__ == "__main__":
    main()
