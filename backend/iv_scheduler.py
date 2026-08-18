"""
Daily ATM implied-vol snapshot recorder.

Without this the SD heatmap cannot work as designed. Yahoo publishes only the
CURRENT implied vol of an option chain — there is no IV history to back-fill — so
the series exists only because something wrote it down each day, and a day nobody
recorded is a permanent hole. Before this module the only writers were "user
opened the OPTIONS tab" (which records whatever expiry they happened to be
looking at — 0DTE during an expiry week) and "user turned the indicator on", which
made a feature that needs 30+ consecutive days depend on the user happening to
open the right screen every single day.

Design, following alerts/scheduler.py because it is the same shape of problem:

  * **Catch-up first, then tick.** The first pass runs shortly after boot rather
    than one interval later: the realistic usage is the app being open for part of
    a day, so a scheduler that only fires on a long timer would miss most days.
  * **Self-gating.** Each pass records only symbols with no usable row for today,
    so once the day is covered the loop costs one indexed query and no network.
  * **Refresh after the close.** A snapshot taken mid-session is a mid-session
    IV. If the day's row was written before 16:00 ET and the pass is running
    after it, the row is re-recorded so the stored value is the closest thing to
    a closing mark that this machine's uptime allows. Upsert on the natural key
    makes that a replace, not a duplicate.
  * **Remembers what has no options at all.** `^VIX`, most ETFs and many foreign
    listings have no chain; without a negative cache they would be retried every
    pass forever.
  * Daemon thread, started once from main.py. `IV_SNAPSHOT_INTERVAL=0` disables.

Symbol universe: the watchlist (`pinned_assets`) plus every symbol that already
has an `iv_snapshots` row. The second half matters — a series someone started by
opening the indicator on SPY should not silently stop the moment SPY leaves the
watchlist, because the gap cannot be repaired afterwards.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

#: How often a pass runs. Shorter than a day on purpose: a pass is nearly free
#: once the day is covered, and several chances per day is what makes the series
#: survive a machine that is only on for part of it.
DEFAULT_INTERVAL = 3 * 60 * 60

#: Let the app finish booting (startup already does regime training, BC
#: calibration and the sync pull) before touching the network.
STARTUP_DELAY = 90

#: US cash close, the mark a snapshot ideally represents.
_ET = ZoneInfo("America/New_York")
_CLOSE_HOUR = 16

#: Symbols with no option chain, learned at runtime. Not persisted: a listing can
#: gain options, and one wasted probe per restart is cheaper than a stale "never"
#: baked into the DB.
_no_options: set[str] = set()

#: symbol → ET date on which it returned "chain exists but no usable ATM quote".
#: Distinct from `_no_options`, and deliberately only good for that day: a thin
#: chain (a recent IPO, an index with no quotes at the money) may well have a
#: usable pair tomorrow, but retrying it every pass today is pure waste —
#: measured on this box that was 3 symbols × 8 passes of futile requests a day.
_no_quote_today: dict[str, str] = {}

_started = False


def interval_seconds() -> int:
    raw = os.getenv("IV_SNAPSHOT_INTERVAL", "").strip()
    if not raw:
        return DEFAULT_INTERVAL
    try:
        return max(0, int(raw))
    except ValueError:
        logger.warning("IV_SNAPSHOT_INTERVAL=%r is not an integer — using default", raw)
        return DEFAULT_INTERVAL


def _configured_symbols() -> list[str] | None:
    """`IV_SNAPSHOT_SYMBOLS` override, or None to use the DB-derived universe."""
    raw = os.getenv("IV_SNAPSHOT_SYMBOLS", "").strip()
    if not raw:
        return None
    return [s.strip().upper() for s in raw.split(",") if s.strip()]


def target_symbols() -> list[str]:
    """Watchlist ∪ symbols that already have IV history, minus known non-options."""
    override = _configured_symbols()
    if override is not None:
        return [s for s in override if s not in _no_options]

    from db import get_db

    with get_db() as conn:
        pinned = {
            str(r[0]).upper()
            for r in conn.execute("SELECT DISTINCT symbol FROM pinned_assets").fetchall()
            if r[0]
        }
        recorded = {
            str(r[0]).upper()
            for r in conn.execute("SELECT DISTINCT symbol FROM iv_snapshots").fetchall()
            if r[0]
        }

    return sorted((pinned | recorded) - _no_options)


def _after_us_close(now: datetime | None = None) -> bool:
    """True once the US cash session for the ET day is over.

    Holidays are not consulted on purpose: on a closed day the quote does not
    change, so the only cost of a needless refresh is one request, while wiring a
    holiday calendar in here would be a second source of truth against
    market_session.py.
    """
    et = (now or datetime.now(timezone.utc)).astimezone(_ET)
    return et.hour >= _CLOSE_HOUR


def symbols_needing_snapshot(symbols: list[str], today: str, after_close: bool) -> list[str]:
    """Which symbols have no usable row for `today` — the self-gating query.

    `dte >= IV_SNAPSHOT_MIN_DTE` mirrors what the σ-band endpoint will accept, so
    a day covered only by a front-week row (what opening the OPTIONS tab during an
    expiry week leaves behind) still counts as missing.

    After the close, a row written earlier in the session is also treated as
    missing so the stored value gets replaced by a closing-side mark.
    """
    if not symbols:
        return []

    from db import get_db
    from routers.options import IV_SANITY_MAX, IV_SANITY_MIN, IV_SNAPSHOT_MIN_DTE

    placeholders = ",".join("?" for _ in symbols)
    with get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT symbol, MAX(created_at) AS last_write
            FROM iv_snapshots
            WHERE snapshot_date = ? AND dte >= ? AND iv_mid BETWEEN ? AND ?
              AND symbol IN ({placeholders})
            GROUP BY symbol
            """,
            [today, IV_SNAPSHOT_MIN_DTE, IV_SANITY_MIN, IV_SANITY_MAX, *symbols],
        ).fetchall()

    covered: dict[str, str] = {str(r["symbol"]).upper(): str(r["last_write"] or "") for r in rows}

    needing: list[str] = []
    for sym in symbols:
        # Already tried today and the chain had no usable ATM pair — give it a
        # rest until tomorrow rather than re-asking every pass.
        if _no_quote_today.get(sym.upper()) == today:
            continue
        last_write = covered.get(sym.upper())
        if last_write is None:
            needing.append(sym)
            continue
        if after_close and not _written_after_close(last_write):
            needing.append(sym)
    return needing


def _written_after_close(created_at: str) -> bool:
    """Was this row written after the US close? `created_at` is UTC (SQLite
    `datetime('now')`), so it is converted before comparing."""
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M:%f", "%Y-%m-%d %H:%M:%S.%f"):
        try:
            stamp = datetime.strptime(created_at, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        return _after_us_close(stamp)
    # Unparseable stamp: treat as already done rather than re-record every pass.
    return True


def run_once() -> dict:
    """One pass. Returns a summary; never raises for a single bad symbol."""
    symbols = target_symbols()
    today = date.today().isoformat()
    after_close = _after_us_close()
    needing = symbols_needing_snapshot(symbols, today, after_close)

    if not needing:
        return {"skipped": "all covered", "symbols": len(symbols), "afterClose": after_close}

    from fastapi import HTTPException
    from routers.options import record_snapshot_now

    recorded, failed, no_chain = 0, 0, 0
    for sym in needing:
        try:
            # The plain function, NOT the endpoint coroutine: FastAPI defaults are
            # `Query` marker objects until the framework resolves them, so calling
            # the endpoint directly passed a Query where an int was expected and
            # every snapshot failed with a TypeError.
            record_snapshot_now(sym)
            recorded += 1
        except HTTPException as e:
            # 404 = no chain on this listing at all → skip it for the life of the
            # process. 422 = a chain exists but had no usable ATM quote today →
            # skip only for today, since a thin chain can fill in tomorrow.
            if e.status_code == 404:
                _no_options.add(sym.upper())
                no_chain += 1
            else:
                _no_quote_today[sym.upper()] = today
                failed += 1
        except Exception as e:  # noqa: BLE001 — one bad symbol must not stop the pass
            failed += 1
            logger.debug("iv snapshot: %s failed: %s", sym, e)

    logger.info(
        "iv snapshot: recorded=%d failed=%d no_chain=%d (of %d needing, %d tracked, afterClose=%s)",
        recorded, failed, no_chain, len(needing), len(symbols), after_close,
    )
    return {
        "recorded": recorded,
        "failed": failed,
        "noChain": no_chain,
        "needing": len(needing),
        "symbols": len(symbols),
        "afterClose": after_close,
    }


def _loop(interval: int) -> None:
    time.sleep(STARTUP_DELAY)
    while True:
        try:
            run_once()
        except Exception as e:  # noqa: BLE001 — a bad pass must not kill the loop
            logger.warning("iv snapshot pass failed (will retry next interval): %s", e)
        time.sleep(interval)


def start_background_recorder() -> None:
    global _started
    if _started:
        return
    interval = interval_seconds()
    if interval == 0:
        logger.info("iv snapshot: disabled (IV_SNAPSHOT_INTERVAL=0)")
        return
    _started = True
    threading.Thread(target=_loop, args=(interval,), daemon=True, name="iv-snapshot").start()
    logger.info("iv snapshot: background recorder started (every %ds)", interval)
