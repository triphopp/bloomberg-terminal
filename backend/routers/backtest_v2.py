"""
Backtest v2 — Trades-based, multi-currency, multi-account backtest engine.
Endpoints:
  GET /api/v2/portfolio/backtest/equity          — equity curve + metrics
  GET /api/v2/portfolio/backtest/holdings-timeline — monthly holdings stack
  GET /api/v2/portfolio/backtest/distribution     — P&L distribution histogram
"""
import bisect
import math
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from typing import Optional

import yfinance as yf  # yf.download with start/end dates — migrate when download() supports date range

from sources import market_data
from fastapi import APIRouter, Query

from db import get_db

router = APIRouter(prefix="/api/v2/portfolio/backtest")


# ── Helpers ──────────────────────────────────────────────────────────────────

def _fl(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _get_thb_per_usd() -> float:
    try:
        snap = market_data.get_fast_info("THBUSD=X")
        p = snap.get("last_price") or snap.get("regularMarketPrice")
        if p and float(p) > 0:
            return round(1 / float(p), 4)
    except Exception:
        pass
    return 33.5


def _to_thb(amount: float, currency: str, exchange_rate: float, thb_per_usd: float) -> float:
    """Convert amount to THB."""
    if currency == "THB":
        return amount
    # USD → THB
    rate = exchange_rate if exchange_rate and exchange_rate > 1 else thb_per_usd
    return amount * rate


def _to_base(amount: float, currency: str, exchange_rate: float, thb_per_usd: float, base: str) -> float:
    """Convert to base currency."""
    thb = _to_thb(amount, currency, exchange_rate, thb_per_usd)
    if base == "THB":
        return thb
    # THB → USD
    return thb / thb_per_usd


def _fetch_benchmark(symbol: str, start: str, end: str) -> dict[str, float]:
    """Fetch benchmark daily close prices → {date_str: close}."""
    try:
        df = yf.download(symbol, start=start, end=end, progress=False, auto_adjust=True)
        if df.empty:
            return {}
        closes = df["Close"]
        if hasattr(closes, "columns"):
            closes = closes.iloc[:, 0]
        return {d.strftime("%Y-%m-%d"): float(v) for d, v in closes.items()}
    except Exception:
        return {}


# ── Equity Curve ─────────────────────────────────────────────────────────────

@router.get("/equity")
def get_equity_curve(
    account_id: str = Query("all"),
    benchmark: str = Query("^SET.BK"),
    base_currency: str = Query("THB"),
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
):
    """Build equity curve from closed trades' realized P&L."""
    where = ["date_exit IS NOT NULL", "win_loss != 'P'"]
    params: list = []
    if account_id != "all":
        where.append("t.account_id = ?")
        params.append(account_id)
    if date_from:
        where.append("t.date_exit >= ?")
        params.append(date_from)
    if date_to:
        where.append("t.date_exit <= ?")
        params.append(date_to)

    with get_db() as conn:
        rows = conn.execute(
            f"""SELECT t.date_exit, t.pnl_amount, t.pnl_percent, t.price_entry, t.price_exit,
                       t.volume, t.currency, t.exchange_rate, t.win_loss,
                       a.currency AS acc_currency
                FROM trades t
                JOIN portfolio_accounts a ON t.account_id = a.id
                WHERE {' AND '.join(where)}
                ORDER BY t.date_exit""",
            params,
        ).fetchall()

    if not rows:
        return {"daily": [], "metrics": None, "message": "No closed trades found"}

    thb_per_usd = _get_thb_per_usd()
    base = base_currency.upper()

    # Build daily P&L series
    daily_pnl: dict[str, float] = defaultdict(float)
    daily_trades: dict[str, int] = defaultdict(int)
    wins, losses = [], []
    total_invested = 0.0

    for r in rows:
        date_str = str(r["date_exit"])[:10]
        pnl_raw = _fl(r["pnl_amount"])
        acc_cur = r["acc_currency"] or r["currency"] or "THB"
        ex_rate = _fl(r["exchange_rate"])

        # If pnl_amount is missing, compute from entry/exit
        if pnl_raw == 0 and r["price_exit"] and r["price_entry"]:
            pnl_raw = (_fl(r["price_exit"]) - _fl(r["price_entry"])) * _fl(r["volume"])

        pnl_base = _to_base(pnl_raw, acc_cur, ex_rate, thb_per_usd, base)
        daily_pnl[date_str] += pnl_base
        daily_trades[date_str] += 1

        # Track invested capital
        entry_val = _fl(r["price_entry"]) * _fl(r["volume"])
        total_invested += _to_base(entry_val, acc_cur, ex_rate, thb_per_usd, base)

        if r["win_loss"] == "W":
            wins.append(pnl_base)
        elif r["win_loss"] == "L":
            losses.append(pnl_base)

    # Also include open positions in total_invested for capital base
    with get_db() as conn:
        open_rows = conn.execute(
            "SELECT t.price_entry, t.volume, t.currency, t.exchange_rate, a.currency AS acc_currency "
            "FROM trades t JOIN portfolio_accounts a ON t.account_id = a.id "
            "WHERE t.win_loss = 'P'" +
            (" AND t.account_id = ?" if account_id != "all" else ""),
            [account_id] if account_id != "all" else [],
        ).fetchall()
    for r in open_rows:
        entry_val = _fl(r["price_entry"]) * _fl(r["volume"])
        acc_cur = r["acc_currency"] or r["currency"] or "THB"
        total_invested += _to_base(entry_val, acc_cur, _fl(r["exchange_rate"]), thb_per_usd, base)

    # Build cumulative curve
    sorted_dates = sorted(daily_pnl.keys())
    if not sorted_dates:
        return {"daily": [], "metrics": None}

    # Fetch benchmark
    start_date = sorted_dates[0]
    end_date = sorted_dates[-1]
    # Extend end by 1 day for yf download
    end_dt = datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=2)
    bench_prices = _fetch_benchmark(benchmark, start_date, end_dt.strftime("%Y-%m-%d"))
    bench_start = bench_prices.get(start_date)

    # Build daily series
    cum_pnl = 0.0
    daily_returns = []
    daily_series = []
    prev_cum = 0.0

    for d in sorted_dates:
        cum_pnl += daily_pnl[d]
        cum_pct = (cum_pnl / total_invested * 100) if total_invested > 0 else 0

        bench_ret = 0.0
        bp = bench_prices.get(d)
        if bp and bench_start and bench_start > 0:
            bench_ret = round((bp / bench_start - 1) * 100, 2)

        daily_series.append({
            "date": d,
            "cumulative_pnl": round(cum_pnl, 2),
            "cumulative_pnl_pct": round(cum_pct, 2),
            "portfolio_return": round(cum_pct, 2),
            "benchmark_return": bench_ret,
            "trades_closed": daily_trades[d],
        })

        if total_invested > 0:
            day_ret = daily_pnl[d] / total_invested
            daily_returns.append(day_ret)

        prev_cum = cum_pnl

    # Compute metrics
    total_pnl = cum_pnl
    total_trades = len(wins) + len(losses)
    win_rate = (len(wins) / total_trades * 100) if total_trades > 0 else 0
    avg_win = sum(wins) / len(wins) if wins else 0
    avg_loss = sum(losses) / len(losses) if losses else 0
    sum_wins = sum(wins)
    sum_losses = abs(sum(losses))
    profit_factor = (sum_wins / sum_losses) if sum_losses > 0 else float("inf") if sum_wins > 0 else 0

    # Sharpe, CAGR, MaxDD, Volatility
    n_days = max((datetime.strptime(end_date, "%Y-%m-%d") - datetime.strptime(start_date, "%Y-%m-%d")).days, 1)
    years = n_days / 365.25

    total_return_pct = (total_pnl / total_invested * 100) if total_invested > 0 else 0
    cagr = ((1 + total_pnl / total_invested) ** (1 / years) - 1) * 100 if total_invested > 0 and years > 0 else 0

    vol = 0.0
    sharpe = 0.0
    if daily_returns and len(daily_returns) > 1:
        mean_r = sum(daily_returns) / len(daily_returns)
        var_r = sum((r - mean_r) ** 2 for r in daily_returns) / (len(daily_returns) - 1)
        vol = math.sqrt(var_r) * math.sqrt(252) * 100
        sharpe = (mean_r * 252) / (math.sqrt(var_r) * math.sqrt(252)) if var_r > 0 else 0

    # Max drawdown
    peak = 0.0
    max_dd = 0.0
    cum = 0.0
    for d in sorted_dates:
        cum += daily_pnl[d]
        if cum > peak:
            peak = cum
        dd = (cum - peak) / peak * 100 if peak > 0 else 0
        if dd < max_dd:
            max_dd = dd

    # Beta / Alpha
    bench_returns_list = []
    port_returns_list = []
    prev_bench = bench_start
    for d in sorted_dates:
        bp = bench_prices.get(d)
        if bp and prev_bench and prev_bench > 0:
            br = (bp / prev_bench - 1)
            pr = daily_pnl[d] / total_invested if total_invested > 0 else 0
            bench_returns_list.append(br)
            port_returns_list.append(pr)
            prev_bench = bp

    beta = 0.0
    alpha = 0.0
    bench_total_return = 0.0
    if bench_returns_list and len(bench_returns_list) > 1:
        mb = sum(bench_returns_list) / len(bench_returns_list)
        mp = sum(port_returns_list) / len(port_returns_list)
        cov = sum((p - mp) * (b - mb) for p, b in zip(port_returns_list, bench_returns_list)) / (len(bench_returns_list) - 1)
        var_b = sum((b - mb) ** 2 for b in bench_returns_list) / (len(bench_returns_list) - 1)
        beta = cov / var_b if var_b > 0 else 0
        alpha = (mp - beta * mb) * 252 * 100  # annualized

    last_bench = list(bench_prices.values())[-1] if bench_prices else None
    if bench_start and last_bench:
        bench_total_return = (last_bench / bench_start - 1) * 100

    metrics = {
        "total_pnl": round(total_pnl, 2),
        "total_pnl_pct": round(total_return_pct, 2),
        "total_return": round(total_return_pct, 2),
        "benchmark_total_return": round(bench_total_return, 2),
        "cagr": round(cagr, 2),
        "sharpe_ratio": round(sharpe, 2),
        "max_drawdown": round(max_dd, 2),
        "volatility": round(vol, 2),
        "profit_factor": round(profit_factor, 2) if profit_factor != float("inf") else 999.0,
        "win_rate": round(win_rate, 1),
        "avg_win": round(avg_win, 2),
        "avg_loss": round(avg_loss, 2),
        "total_trades": total_trades,
        "benchmark": benchmark,
        "beta": round(beta, 2),
        "alpha": round(alpha, 2),
        "n_days": n_days,
        "base_currency": base,
        "total_invested": round(total_invested, 2),
    }

    return {"daily": daily_series, "metrics": metrics}


# ── Holdings Timeline (Stack Chart) ─────────────────────────────────────────

@router.get("/holdings-timeline")
def get_holdings_timeline(
    account_id: str = Query("all"),
    group_by: str = Query("sector"),
    base_currency: str = Query("THB"),
):
    """Monthly snapshot of open holdings grouped by sector/account/symbol."""
    where_acct = " AND t.account_id = ?" if account_id != "all" else ""
    params = [account_id] if account_id != "all" else []

    with get_db() as conn:
        rows = conn.execute(
            f"""SELECT t.symbol, t.sector, t.date_entry, t.date_exit, t.price_entry,
                       t.volume, t.currency, t.exchange_rate, t.win_loss,
                       t.account_id, t.note, a.currency AS acc_currency, a.name AS acc_name
                FROM trades t
                JOIN portfolio_accounts a ON t.account_id = a.id
                WHERE 1=1 {where_acct}
                ORDER BY t.date_entry""",
            params,
        ).fetchall()

    if not rows:
        return {"timeline": [], "all_keys": []}

    thb_per_usd = _get_thb_per_usd()
    base = base_currency.upper()

    # Find date range
    all_entry_dates = [str(r["date_entry"])[:7] for r in rows if r["date_entry"]]
    all_exit_dates = [str(r["date_exit"])[:7] for r in rows if r["date_exit"]]
    all_months_raw = set(all_entry_dates + all_exit_dates)
    if not all_months_raw:
        return {"timeline": [], "all_keys": []}

    min_month = min(all_months_raw)
    max_month = max(all_months_raw | {datetime.utcnow().strftime("%Y-%m")})

    # Generate all months
    months = []
    y, m = int(min_month[:4]), int(min_month[5:7])
    ey, em = int(max_month[:4]), int(max_month[5:7])
    while (y, m) <= (ey, em):
        months.append(f"{y}-{m:02d}")
        m += 1
        if m > 12:
            m = 1
            y += 1

    # AF-2: sweep-line replaces O(M×T) nested loop with O(T log T + M×active)
    trades_list = [
        {**dict(r),
         "_entry": str(r["date_entry"])[:10] if r["date_entry"] else None,
         "_exit":  str(r["date_exit"])[:10]  if r["date_exit"]  else None}
        for r in rows
    ]
    by_entry = sorted([t for t in trades_list if t["_entry"]], key=lambda t: t["_entry"])
    entry_ptr = 0
    active_trades: list[dict] = []

    all_keys_set: set[str] = set()
    timeline = []

    for month in months:
        month_start = f"{month}-01"
        month_end   = f"{month}-31"

        # Activate trades whose entry ≤ month_end
        while entry_ptr < len(by_entry) and by_entry[entry_ptr]["_entry"] <= month_end:
            active_trades.append(by_entry[entry_ptr])
            entry_ptr += 1

        # Deactivate trades that closed before this month starts
        active_trades = [t for t in active_trades if not t["_exit"] or t["_exit"] >= month_start]

        if not active_trades:
            continue

        holdings: dict[str, dict] = defaultdict(lambda: {"cost_value": 0.0, "symbols": set(), "count": 0})
        for r in active_trades:
            acc_cur = r["acc_currency"] or r["currency"] or "THB"
            ex_rate = _fl(r["exchange_rate"])
            cost = _fl(r["price_entry"]) * _fl(r["volume"])
            cost_base = _to_base(cost, acc_cur, ex_rate, thb_per_usd, base)

            if group_by == "account":
                key = r["note"] or r["acc_name"] or r["account_id"]
            elif group_by == "symbol":
                key = r["symbol"]
            else:
                key = r["sector"] or "Other"

            holdings[key]["cost_value"] += cost_base
            holdings[key]["symbols"].add(r["symbol"])
            holdings[key]["count"] += 1

        if not holdings:
            continue

        total_cost = sum(h["cost_value"] for h in holdings.values())
        h_list = []
        for key, h in sorted(holdings.items(), key=lambda x: -x[1]["cost_value"]):
            all_keys_set.add(key)
            h_list.append({
                "key": key,
                "cost_value": round(h["cost_value"], 2),
                "symbols": sorted(h["symbols"]),
                "count": h["count"],
            })

        # For symbol mode: merge beyond top 12 into "Others"
        if group_by == "symbol" and len(h_list) > 12:
            top = h_list[:12]
            rest = h_list[12:]
            others_val = sum(x["cost_value"] for x in rest)
            others_syms = set()
            others_count = 0
            for x in rest:
                others_syms.update(x["symbols"])
                others_count += x["count"]
            top.append({
                "key": "Others",
                "cost_value": round(others_val, 2),
                "symbols": sorted(others_syms),
                "count": others_count,
            })
            # Remove merged keys, add Others
            for x in rest:
                all_keys_set.discard(x["key"])
            all_keys_set.add("Others")
            h_list = top

        timeline.append({
            "month": month,
            "total_cost": round(total_cost, 2),
            "holdings": h_list,
        })

    # Pivot for frontend convenience: each month becomes {month, KEY1: val, KEY2: val, ...}
    all_keys = sorted(all_keys_set)
    pivoted = []
    for t in timeline:
        row = {"month": t["month"], "total_cost": t["total_cost"]}
        lookup = {h["key"]: h for h in t["holdings"]}
        for k in all_keys:
            row[k] = lookup[k]["cost_value"] if k in lookup else 0
        # Keep detail for tooltip
        row["_detail"] = t["holdings"]
        pivoted.append(row)

    return {"timeline": pivoted, "all_keys": all_keys}


# ── Distribution ─────────────────────────────────────────────────────────────

@router.get("/distribution")
def get_distribution(
    account_id: str = Query("all"),
    metric: str = Query("pnl_percent"),
    base_currency: str = Query("THB"),
):
    """Histogram of trade P&L distribution."""
    where = ["date_exit IS NOT NULL", "win_loss != 'P'"]
    params: list = []
    if account_id != "all":
        where.append("t.account_id = ?")
        params.append(account_id)

    with get_db() as conn:
        rows = conn.execute(
            f"""SELECT t.symbol, t.pnl_amount, t.pnl_percent, t.price_entry, t.price_exit,
                       t.volume, t.date_entry, t.date_exit, t.currency, t.exchange_rate,
                       t.win_loss, t.sector, a.currency AS acc_currency
                FROM trades t
                JOIN portfolio_accounts a ON t.account_id = a.id
                WHERE {' AND '.join(where)}
                ORDER BY t.date_exit""",
            params,
        ).fetchall()

    if not rows:
        return {"buckets": [], "trades": []}

    thb_per_usd = _get_thb_per_usd()
    base = base_currency.upper()

    # Collect values
    trades = []
    for r in rows:
        pnl_raw = _fl(r["pnl_amount"])
        acc_cur = r["acc_currency"] or r["currency"] or "THB"
        ex_rate = _fl(r["exchange_rate"])

        if pnl_raw == 0 and r["price_exit"] and r["price_entry"]:
            pnl_raw = (_fl(r["price_exit"]) - _fl(r["price_entry"])) * _fl(r["volume"])

        pnl_base = _to_base(pnl_raw, acc_cur, ex_rate, thb_per_usd, base)
        pnl_pct = _fl(r["pnl_percent"])
        if pnl_pct == 0 and r["price_entry"] and r["price_exit"] and _fl(r["price_entry"]) > 0:
            pnl_pct = (_fl(r["price_exit"]) - _fl(r["price_entry"])) / _fl(r["price_entry"]) * 100

        # Holding days
        days = 0
        if r["date_entry"] and r["date_exit"]:
            try:
                d1 = datetime.strptime(str(r["date_entry"])[:10], "%Y-%m-%d")
                d2 = datetime.strptime(str(r["date_exit"])[:10], "%Y-%m-%d")
                days = (d2 - d1).days
            except Exception:
                pass

        trades.append({
            "symbol": r["symbol"],
            "pnl_amount": round(pnl_base, 2),
            "pnl_percent": round(pnl_pct, 2),
            "holding_days": days,
            "win_loss": r["win_loss"],
            "sector": r["sector"] or "Other",
        })

    # Build histogram buckets based on metric
    if metric == "pnl_percent":
        values = [t["pnl_percent"] for t in trades]
        step = 10
        label_fmt = lambda lo, hi: f"{lo:+.0f}% to {hi:+.0f}%"
    elif metric == "holding_days":
        values = [float(t["holding_days"]) for t in trades]
        step = 30
        label_fmt = lambda lo, hi: f"{int(lo)}-{int(hi)}d"
    else:  # pnl_amount
        values = [t["pnl_amount"] for t in trades]
        # Auto-scale step
        vmax = max(abs(v) for v in values) if values else 1000
        step = max(round(vmax / 8, -2), 100)  # round to nearest 100
        sym = "฿" if base == "THB" else "$"
        label_fmt = lambda lo, hi: f"{sym}{lo:,.0f} to {sym}{hi:,.0f}"

    if not values:
        return {"buckets": [], "trades": trades}

    # AF-3: sort once + bisect per bucket instead of O(B×N) linear scans
    paired = sorted(zip(values, trades), key=lambda x: x[0])
    sorted_vals   = [p[0] for p in paired]
    sorted_trades = [p[1] for p in paired]

    lo = sorted_vals[0]
    hi = sorted_vals[-1]
    bucket_start = math.floor(lo / step) * step
    bucket_end   = math.ceil(hi / step) * step + step

    buckets = []
    b = bucket_start
    while b < bucket_end:
        b_lo, b_hi = b, b + step
        left  = bisect.bisect_left(sorted_vals, b_lo)
        right = bisect.bisect_left(sorted_vals, b_hi)
        if left < right:
            pnl_sum = sum(t["pnl_amount"] for t in sorted_trades[left:right])
            buckets.append({
                "range":   label_fmt(b_lo, b_hi),
                "lo":      b_lo,
                "hi":      b_hi,
                "count":   right - left,
                "pnl_sum": round(pnl_sum, 2),
            })
        b += step

    return {"buckets": buckets, "trades": trades}
