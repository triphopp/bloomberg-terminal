"""
AUTO DIVIDEND — an ex-dividend date has passed and we held the stock → the
dividend is booked in PORT → CASH → DIVIDENDS by itself.

What a pass does, per account and per symbol traded in it:

1. The market's dividends (Yahoo history, the same records CAL draws as
   "Ex-dividend") with an ex-date in the last `DIVIDEND_AUTO_LOOKBACK_DAYS`
   (default 60) and not in the future.
2. Units held ON that ex-date — `dividend_check.held_on`: bought before the
   ex-date, not sold before it. **None held → nothing happens.** A stock that is
   only on a watchlist or in a thesis is never booked.
3. Already booked by hand? Any row for the same account and asset with an
   ex-date within ±`MATCH_DAYS` (or no ex-date and a pay date in the window)
   means the user has it — skip. Split rows per subaccount count as booked.
4. Otherwise insert one row: per-unit = the market figure, total = held ×
   per-unit (GROSS — how this book records dividends, recent rows show
   received ÷ (held × per-unit) = 1.0), currency = the instrument's,
   pay date = Yahoo's declared pay date when its calendar names this ex-date,
   else the ex-date (the same placeholder DIV SUGGESTIONS used).

The id is deterministic (`auto-div-<hash of account|asset|ex-date>`) and the
insert is OR IGNORE, so two machines syncing the same book can both run it and
one row results, and a pass never touches a row again — an edit the user makes
from the broker statement stays. A row the user DELETES is not re-created: the
DELETE is in `audit_events` (synced) and that is the tombstone. Older gaps than
the lookback stay as DIV SUGGESTIONS chips for a person to decide.

`DIVIDEND_AUTO_INTERVAL` seconds between passes (default 21600 = 6 h, 0 = off).
A write refused by the ledger (a closed period on a SHADOW account) is skipped
and reported, never forced.
"""
from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from datetime import date, datetime, timedelta, timezone
from typing import Callable, Optional

logger = logging.getLogger(__name__)

AUTO_PREFIX = "auto-div-"
DEFAULT_INTERVAL = 6 * 3600
DEFAULT_LOOKBACK = 60
STARTUP_DELAY = 240
# An existing row this close to the market ex-date is the same dividend: brokers
# and the user sometimes type the record date or the announcement date instead.
MATCH_DAYS = 10
# A row with only a pay date is the same dividend if paid in this window after XD.
PAY_WINDOW = (-5, 100)

_started = False
_lock = threading.Lock()
_last: dict = {"at": None, "booked": [], "skipped": [], "errors": []}


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return max(0, int(raw))
    except ValueError:
        logger.warning("%s=%r is not an integer — using %d", name, raw, default)
        return default


def interval_seconds() -> int:
    return _env_int("DIVIDEND_AUTO_INTERVAL", DEFAULT_INTERVAL)


def lookback_days() -> int:
    return _env_int("DIVIDEND_AUTO_LOOKBACK_DAYS", DEFAULT_LOOKBACK)


def auto_id(account_id: str, asset: str, ex_date: str) -> str:
    key = f"{account_id}|{asset.strip().upper()}|{ex_date[:10]}"
    return AUTO_PREFIX + hashlib.sha1(key.encode()).hexdigest()[:16]


def is_auto(div_id: Optional[str]) -> bool:
    return bool(div_id) and str(div_id).startswith(AUTO_PREFIX)


def _d(s: str) -> date:
    return date.fromisoformat(str(s)[:10])


# ── market lookups (injectable for tests) ────────────────────────────────────

def _market_dividends(yf_symbol: str) -> list:
    import dividend_check

    return dividend_check._market_dividends(yf_symbol)


def _declared_pay_date(yf_symbol: str, ex_date: str) -> Optional[str]:
    """Yahoo's pay date, only when its calendar is about THIS ex-date."""
    try:
        from sources import market_data

        cal = market_data.get_ticker(yf_symbol).calendar or {}
    except Exception:
        return None
    if not isinstance(cal, dict):
        return None

    def iso(v) -> Optional[str]:
        if v is None:
            return None
        v = v.date() if hasattr(v, "date") and not isinstance(v, date) else v
        return v.strftime("%Y-%m-%d") if hasattr(v, "strftime") else str(v)[:10]

    if iso(cal.get("Ex-Dividend Date")) != ex_date[:10]:
        return None
    pay = iso(cal.get("Dividend Date"))
    return pay if pay and pay >= ex_date[:10] else None


# ── the plan ─────────────────────────────────────────────────────────────────

def _already_booked(rows: list[dict], ex_date: str) -> Optional[dict]:
    xd = _d(ex_date)
    for r in rows:
        if r.get("ex_date"):
            try:
                if abs((_d(r["ex_date"]) - xd).days) <= MATCH_DAYS:
                    return r
            except ValueError:
                continue
        elif r.get("pay_date"):
            try:
                gap = (_d(r["pay_date"]) - xd).days
            except ValueError:
                continue
            if PAY_WINDOW[0] <= gap <= PAY_WINDOW[1]:
                return r
    return None


def plan(
    conn,
    today: Optional[date] = None,
    *,
    lookback: Optional[int] = None,
    market: Optional[Callable[[str], list]] = None,
    account_id: Optional[str] = None,
) -> dict:
    """What a pass would book, and why each other market dividend is skipped.
    Reads only."""
    from dividend_check import held_on
    from portfolio_currency import trade_currency
    from routers.portfolio_v2 import _trade_yf_symbol

    today = today or date.today()
    lookback = lookback_days() if lookback is None else lookback
    market = market or _market_dividends
    floor = (today - timedelta(days=lookback)).isoformat()
    top = today.isoformat()

    where = "(t.date_exit IS NULL OR t.date_exit = '' OR substr(t.date_exit, 1, 10) >= ?)"
    params: list = [floor]
    if account_id:
        where += " AND t.account_id = ?"
        params.append(account_id)
    lots = [dict(r) for r in conn.execute(
        "SELECT t.*, a.currency acc_currency FROM trades t "
        "JOIN portfolio_accounts a ON a.id = t.account_id "
        f"WHERE {where} ORDER BY t.account_id, t.symbol",
        params,
    ).fetchall()]
    groups: dict[tuple[str, str], list[dict]] = {}
    for lot in lots:
        sym = str(lot.get("symbol") or "").strip().upper()
        if sym:
            groups.setdefault((lot["account_id"], sym), []).append(lot)

    tombstones = {r[0] for r in conn.execute(
        "SELECT row_id FROM audit_events WHERE table_name = 'dividends' AND action = 'DELETE' "
        "AND row_id LIKE ?", (AUTO_PREFIX + "%",),
    ).fetchall()}

    to_book: list[dict] = []
    skipped: list[dict] = []
    for (acct, sym), sym_lots in groups.items():
        yf = _trade_yf_symbol(sym_lots[0])
        if not yf:
            continue
        try:
            recs = market(yf) or []
        except Exception as exc:  # noqa: BLE001 — one symbol must not stop the pass
            skipped.append({"account_id": acct, "asset": sym, "reason": f"market: {type(exc).__name__}"})
            continue
        recs = [r for r in recs if r.ex_date and floor <= r.ex_date[:10] <= top]
        if not recs:
            continue
        names = {sym, yf.upper(), yf.upper().removesuffix(".BK")}
        booked = [dict(r) for r in conn.execute(
            f"SELECT id, asset, ex_date, pay_date FROM dividends WHERE account_id = ? "
            f"AND upper(asset) IN ({','.join('?' * len(names))})",
            (acct, *names),
        ).fetchall()]
        ccy = trade_currency(sym_lots[0])
        for rec in sorted(recs, key=lambda r: r.ex_date):
            xd = rec.ex_date[:10]
            base = {"account_id": acct, "asset": sym, "ex_date": xd}
            amount = float(rec.amount or 0)
            if amount <= 0:
                continue
            held = held_on(sym_lots, xd)
            if held <= 0:
                skipped.append({**base, "reason": "not_held"})
                continue
            div_id = auto_id(acct, sym, xd)
            if div_id in tombstones:
                skipped.append({**base, "reason": "deleted_by_user"})
                continue
            hit = _already_booked(booked, xd)
            if hit:
                skipped.append({**base, "reason": "already_booked", "row_id": hit["id"]})
                continue
            to_book.append({
                **base,
                "id": div_id,
                "yf_symbol": yf,
                "amount_per_unit": round(amount, 6),
                "held_units": round(held, 6),
                "total_received": round(held * amount, 4 if ccy != "THB" else 2),
                "currency": ccy,
            })
    return {"today": top, "since": floor, "to_book": to_book, "skipped": skipped}


# ── the pass ─────────────────────────────────────────────────────────────────

def run_once(
    today: Optional[date] = None,
    *,
    dry_run: bool = False,
    market: Optional[Callable[[str], list]] = None,
    pay_date: Optional[Callable[[str, str], Optional[str]]] = None,
    account_id: Optional[str] = None,
) -> dict:
    import ledger
    from db import get_db

    pay_date = pay_date or _declared_pay_date
    with get_db() as conn:
        p = plan(conn, today, market=market, account_id=account_id)
    if dry_run:
        return {**p, "dry_run": True}

    booked, errors = [], []
    for row in p["to_book"]:
        pay = pay_date(row["yf_symbol"], row["ex_date"])
        row = {**row, "pay_date": pay or row["ex_date"], "pay_date_estimated": pay is None}
        try:
            with get_db() as conn:
                wallet = ledger.entry_wallet(conn, row["account_id"], row["currency"], row["asset"], None)
                cur = conn.execute(
                    """INSERT OR IGNORE INTO dividends (id, account_id, asset, ex_date, pay_date,
                           amount_per_unit, total_received, reinvested_amount, reinvest_asset,
                           reinvest_price, reinvest_units, currency, wallet)
                       VALUES (?,?,?,?,?,?,?,0,'',0,0,?,?)""",
                    (row["id"], row["account_id"], row["asset"], row["ex_date"], row["pay_date"],
                     row["amount_per_unit"], row["total_received"], row["currency"], wallet),
                )
            if cur.rowcount:
                booked.append(row)
        except Exception as exc:  # noqa: BLE001 — e.g. LEDGER_PERIOD_CLOSED: report, never force
            logger.warning("auto dividend %s %s %s not booked: %s",
                           row["account_id"], row["asset"], row["ex_date"], exc)
            errors.append({**row, "error": str(exc)[:200]})

    if booked:
        logger.info("auto dividend: booked %s", ", ".join(
            f"{r['account_id']}:{r['asset']} XD {r['ex_date']} {r['total_received']} {r['currency']}"
            for r in booked))
        _push_sync()
    result = {**p, "booked": booked, "errors": errors, "dry_run": False}
    with _lock:
        _last.update({
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "booked": booked, "skipped": p["skipped"], "errors": errors,
        })
    return result


def _push_sync() -> None:
    """A write made off the request path: tell sync, as the HTTP middleware
    would after a POST to /api/v2/portfolio."""
    try:
        import sync
        from sync import oplog

        sync.request_push()
        oplog.request_sync()
    except Exception:  # noqa: BLE001 — sync is optional on a machine without it
        logger.debug("auto dividend: sync push not requested", exc_info=True)


def _wait_for_sync_pull(timeout: float = 600) -> None:
    """Never plan before the startup cloud pull has merged: a dividend the user
    booked on the other machine would look missing and be booked twice."""
    try:
        from sync import startup_done
    except Exception:  # noqa: BLE001
        return
    if not startup_done.wait(timeout):
        logger.warning("auto dividend: sync pull not done after %ds — running anyway", int(timeout))


def status() -> dict:
    with _lock:
        last = dict(_last)
    return {
        "enabled": interval_seconds() > 0,
        "interval_s": interval_seconds(),
        "lookback_days": lookback_days(),
        "last_run": last,
    }


def _loop(interval: int) -> None:
    import request_latency

    time.sleep(STARTUP_DELAY)
    _wait_for_sync_pull()
    while True:
        request_latency.wait_for_quiet()
        try:
            run_once()
        except Exception as e:  # noqa: BLE001 — a bad tick must not kill the loop
            logger.exception("auto dividend pass failed (will retry): %s", e)
        time.sleep(interval)


def start_background_scan() -> None:
    global _started
    if _started:
        return
    interval = interval_seconds()
    if interval == 0:
        logger.info("auto dividend: disabled (DIVIDEND_AUTO_INTERVAL=0)")
        return
    _started = True
    threading.Thread(target=_loop, args=(interval,), daemon=True, name="dividend-auto").start()
    logger.info("auto dividend: started (every %ds, lookback %dd)", interval, lookback_days())
