"""Daily AUM snapshots for the sector ETF complex — the only path to real flow.

Net creation/redemption is what "money moved into a sector" actually means, and
it is not obtainable retroactively from any free source: Yahoo's
`get_shares_full` returns None for an ETF, and `totalAssets` / `navPrice` are
today's values with no history behind them. So the history has to be built by
recording it, one day at a time, the same argument as `series_points` and
`iv_snapshots` — a day nobody recorded is a permanent hole.

Two estimators come out of the stored pair, and they are deliberately kept
separate rather than averaged:

    shares method   implied_shares = total_assets / nav
                    flow = (shares_t - shares_{t-1}) * nav_t
                    Exact when both fields come from the same publication, which
                    is the assumption it rests on: Yahoo does not date them.

    return method   flow = aum_t - aum_{t-1} * (1 + total_return_t)
                    Needs no shares, but charges every dividend and every
                    rounding of AUM to "flow", so it is noisier.

They agree when the data is clean and diverge when it is not, which is the point
— a wide gap between them is a reason to distrust the day, not to pick one.

Nothing here runs on a timer. The capture is triggered by a read of the rotation
endpoint and guarded by the row for today already existing, so the process holds
no scheduler and a machine that is switched off simply has no row for that day
(and picks up the peer's when the two sync).
"""
from __future__ import annotations

import threading
from datetime import datetime, timezone
from typing import Optional

from db import get_db

#: The SPDR sector complex. Same 11 funds the rotation table uses; kept here as
#: symbols only, because this module knows nothing about what a sector means.
SECTOR_ETFS = ("XLK", "XLF", "XLV", "XLE", "XLI", "XLY", "XLP", "XLRE", "XLU", "XLB", "XLC")

#: A single capture at a time. Two requests landing together would otherwise
#: both see "no row for today" and both walk the 11 tickers.
_capture_lock = threading.Lock()
_capture_running = False


def _today() -> str:
    # US funds publish on the US trading day; the snapshot is stamped in UTC,
    # which is the same calendar day as the NY close for every hour the terminal
    # is realistically open. A row is a fact about a publication, not a clock.
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def have_today(symbols: tuple[str, ...] = SECTOR_ETFS) -> bool:
    with get_db() as conn:
        n = conn.execute(
            f"SELECT COUNT(*) FROM etf_aum_snapshots WHERE as_of = ? "
            f"AND symbol IN ({','.join('?' * len(symbols))})",
            (_today(), *symbols),
        ).fetchone()[0]
    return n >= len(symbols)


def capture(symbols: tuple[str, ...] = SECTOR_ETFS) -> dict:
    """Record today's AUM/NAV for each symbol. Idempotent per (day, symbol)."""
    import yfinance as yf

    day = _today()
    written, failed = 0, []
    for sym in symbols:
        try:
            info = yf.Ticker(sym).info
            aum = info.get("totalAssets") or info.get("netAssets")
            nav = info.get("navPrice")
            close = info.get("regularMarketPreviousClose") or info.get("previousClose")
            if not aum:
                failed.append(sym)
                continue
            shares = (float(aum) / float(nav)) if nav else None
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO etf_aum_snapshots
                        (as_of, symbol, total_assets, nav, close, implied_shares, source)
                    VALUES (?, ?, ?, ?, ?, ?, 'yfinance')
                    ON CONFLICT(as_of, symbol) DO UPDATE SET
                        total_assets   = excluded.total_assets,
                        nav            = excluded.nav,
                        close          = excluded.close,
                        implied_shares = excluded.implied_shares,
                        captured_at    = datetime('now')
                    """,
                    (day, sym, float(aum), float(nav) if nav else None,
                     float(close) if close else None, shares),
                )
            written += 1
        except Exception:  # one bad ticker must not cost the other ten
            failed.append(sym)
    return {"as_of": day, "written": written, "failed": failed}


def capture_async(symbols: tuple[str, ...] = SECTOR_ETFS) -> bool:
    """Fire today's capture in the background if it has not been done.

    Returns whether a capture was started. The 11 `info` calls take ~10-20s,
    which is why they never sit in front of a response.
    """
    global _capture_running
    with _capture_lock:
        if _capture_running:
            return False
        try:
            if have_today(symbols):
                return False
        except Exception:
            return False
        _capture_running = True

    def run() -> None:
        global _capture_running
        try:
            capture(symbols)
        finally:
            with _capture_lock:
                _capture_running = False

    threading.Thread(target=run, name="etf-aum-capture", daemon=True).start()
    return True


def history(symbols: tuple[str, ...] = SECTOR_ETFS, days: int = 400) -> list[dict]:
    """Stored snapshots, oldest first."""
    with get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT as_of, symbol, total_assets, nav, close, implied_shares
            FROM etf_aum_snapshots
            WHERE symbol IN ({','.join('?' * len(symbols))})
            ORDER BY as_of ASC
            """,
            symbols,
        ).fetchall()
    return [dict(r) for r in rows][-days * len(symbols):]


def flows(symbols: tuple[str, ...] = SECTOR_ETFS, window: int = 20) -> dict:
    """Estimated net creation/redemption per symbol over the stored window.

    Returns `available: False` while fewer than two distinct days exist, with
    the count so the UI can say how long the record still has to run rather
    than showing an empty panel.
    """
    rows = history(symbols)
    by_sym: dict[str, list[dict]] = {}
    for r in rows:
        by_sym.setdefault(r["symbol"], []).append(r)
    days = sorted({r["as_of"] for r in rows})
    if len(days) < 2:
        return {
            "available": False,
            "days_stored": len(days),
            "first_day": days[0] if days else None,
            "note": "ต้องมี snapshot อย่างน้อย 2 วันถึงจะประมาณ flow ได้",
        }

    span = days[-min(window, len(days)):]
    out = []
    for sym, series in by_sym.items():
        pts = [p for p in series if p["as_of"] in span and p["total_assets"]]
        if len(pts) < 2:
            continue
        shares_flow = 0.0
        return_flow = 0.0
        shares_ok = True
        for prev, cur in zip(pts, pts[1:]):
            nav_c, nav_p = cur.get("nav"), prev.get("nav")
            if cur.get("implied_shares") and prev.get("implied_shares") and nav_c:
                shares_flow += (cur["implied_shares"] - prev["implied_shares"]) * nav_c
            else:
                shares_ok = False
            if nav_c and nav_p:
                ret = nav_c / nav_p - 1
                return_flow += cur["total_assets"] - prev["total_assets"] * (1 + ret)
        out.append({
            "symbol": sym,
            "aum": pts[-1]["total_assets"],
            "flow_shares_method": round(shares_flow, 0) if shares_ok else None,
            "flow_return_method": round(return_flow, 0),
            "days": len(pts),
        })
    out.sort(key=lambda r: -(r["flow_shares_method"] or r["flow_return_method"] or 0))
    return {
        "available": True,
        "days_stored": len(days),
        "window_days": len(span),
        "first_day": days[0],
        "last_day": days[-1],
        "rows": out,
    }


def coverage() -> dict:
    """How far the self-built record has got. Shown while flow is still young."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT COUNT(DISTINCT as_of) AS days, MIN(as_of) AS first, MAX(as_of) AS last "
            "FROM etf_aum_snapshots"
        ).fetchone()
    d = dict(row) if row else {}
    return {"days": d.get("days") or 0, "first": d.get("first"), "last": d.get("last")}


def latest_aum(symbols: tuple[str, ...] = SECTOR_ETFS) -> dict[str, float]:
    """Most recent AUM per symbol, whatever day it was recorded."""
    with get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT symbol, total_assets FROM etf_aum_snapshots
            WHERE symbol IN ({','.join('?' * len(symbols))})
              AND as_of = (SELECT MAX(as_of) FROM etf_aum_snapshots s2
                           WHERE s2.symbol = etf_aum_snapshots.symbol)
            """,
            symbols,
        ).fetchall()
    return {r["symbol"]: r["total_assets"] for r in rows if r["total_assets"]}


def optional_float(v: object) -> Optional[float]:
    try:
        return float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
