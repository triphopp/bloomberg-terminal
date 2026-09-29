"""
TRADE GUARD notifier — turns guard flags into alert-feed events.

Every interval it evaluates the whole book (routers.risk._guard_snapshot, all
accounts, THB) and compares each holding's flags with the last scan
(`guard_state`). A code that APPEARS (STOP_HIT, NEAR_STOP, TIME, or a book-level
DAY_LOSS / DD_* / STREAK) is written to `alert_events` with
rule_id = "guard:<CODE>", so the existing ticker/toast/badge pick it up with no
new client code. `routers/alert_rules.list_events` names these rows (there is
no alert_rules row behind them). UNIQUE(rule_id, symbol, bar_time) with
bar_time = today also caps a code at one event per symbol per day.

First run on an empty `guard_state` seeds silently: the card already shows
what is flagged today, and a dozen toasts on first boot teach people to ignore
toasts. `TRADE_GUARD_SCAN_INTERVAL=0` disables the thread (default 900 s).

The same tick writes the day's VaR forecast once (`var_forecasts`), which
GET /api/v2/portfolio/risk/var-backtest scores against the next trading day.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL = 15 * 60
STARTUP_DELAY = 120
_started = False


def interval_seconds() -> int:
    raw = os.getenv("TRADE_GUARD_SCAN_INTERVAL", "").strip()
    if not raw:
        return DEFAULT_INTERVAL
    try:
        return max(0, int(raw))
    except ValueError:
        logger.warning("TRADE_GUARD_SCAN_INTERVAL=%r is not an integer — using default", raw)
        return DEFAULT_INTERVAL


def _load_state(conn) -> dict[str, set[str]]:
    out = {}
    for r in conn.execute("SELECT key, flags FROM guard_state").fetchall():
        try:
            out[r["key"]] = set(json.loads(r["flags"] or "[]"))
        except ValueError:
            out[r["key"]] = set()
    return out


def apply(conn, snapshot: dict, now: datetime | None = None) -> list[dict]:
    """Diff `snapshot` against guard_state, write events + new state. Returns
    the events written (empty on the silent first run)."""
    import trade_guard

    now = now or datetime.now(timezone.utc)
    prev = _load_state(conn)
    seeding = not prev
    state, events = trade_guard.transitions(prev, snapshot)
    written = []
    if not seeding:
        day = now.date().isoformat()
        for e in events:
            cur = conn.execute(
                "INSERT OR IGNORE INTO alert_events (rule_id, symbol, fired_at, bar_time, snapshot_json) "
                "VALUES (?, ?, ?, ?, ?)",
                (f"guard:{e['code']}", e["symbol"] or "?", now.isoformat(), day,
                 json.dumps({k: v for k, v in e["snapshot"].items() if v is not None})),
            )
            if cur.rowcount:
                written.append(e)
    conn.execute("DELETE FROM guard_state")
    conn.executemany(
        "INSERT INTO guard_state (key, flags, updated_at) VALUES (?, ?, ?)",
        [(k, json.dumps(sorted(v)), now.isoformat()) for k, v in state.items()],
    )
    conn.commit()
    return written


def run_once() -> dict:
    from db import get_db
    from routers.risk import _guard_snapshot

    with get_db() as conn:
        has_open = conn.execute("SELECT 1 FROM trades WHERE win_loss = 'P' LIMIT 1").fetchone()
    if not has_open:
        return {"skipped": "no open positions"}
    snapshot = _guard_snapshot(None, "THB")
    with get_db() as conn:
        written = apply(conn, snapshot)
    if written:
        logger.info("trade guard: %d new flag(s): %s", len(written),
                    ", ".join(f"{e['symbol']}:{e['code']}" for e in written))
    # Once a day: log the VaR forecast the next trading day will be judged
    # against (routers.risk GET /var-backtest). Never fails the guard tick.
    forecast = None
    try:
        from routers.risk import _record_var_forecast
        forecast = _record_var_forecast("all")
        if forecast:
            logger.info("var forecast logged for %s: hist %.3f%%", forecast["forecast_date"],
                        forecast["var_hist_pct"] or 0)
    except Exception as e:  # noqa: BLE001
        logger.warning("var forecast not logged: %s", e)
    return {"light": snapshot.get("light"), "events": len(written), "var_forecast": bool(forecast)}


def _loop(interval: int) -> None:
    time.sleep(STARTUP_DELAY)
    while True:
        try:
            run_once()
        except Exception as e:  # noqa: BLE001 — a bad tick must not kill the loop
            logger.exception("trade guard tick failed (will retry next interval): %s", e)
        time.sleep(interval)


def start_background_scan() -> None:
    global _started
    if _started:
        return
    interval = interval_seconds()
    if interval == 0:
        logger.info("trade guard: disabled (TRADE_GUARD_SCAN_INTERVAL=0)")
        return
    _started = True
    threading.Thread(target=_loop, args=(interval,), daemon=True, name="trade-guard").start()
    logger.info("trade guard: notifier started (every %ds)", interval)
