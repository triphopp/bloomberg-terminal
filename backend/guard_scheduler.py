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

The same tick checks take-profit rebalance (routers.risk._rebalance_plan,
rules in `rebalance_rules`) and writes "guard:REBALANCE" once per holding per
ISO week while it stays a TRIM.

The same tick writes the day's VaR forecast once (`var_forecasts`), which
GET /api/v2/portfolio/risk/var-backtest scores against the next trading day.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL = 15 * 60
STARTUP_DELAY = 120
_started = False

# Heartbeat for the UI (`status()` → GET /risk/guard "scan"). In memory: it
# describes THIS process, and a reload that restarts the loop resets it.
_status: dict = {"started_at": None, "interval": None, "last_run_at": None,
                 "last_ok_at": None, "last_error": None, "last_events": 0}


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
    rebal = 0
    try:
        rebal = _rebalance_alerts()
    except Exception as e:  # noqa: BLE001 — never fails the guard tick
        logger.warning("rebalance check failed: %s", e)
    return {"light": snapshot.get("light"), "events": len(written), "var_forecast": bool(forecast),
            "rebalance_events": rebal}


def rebalance_events(plan: dict, now: datetime) -> list[dict]:
    """TRIM rows → alert rows. bar_time = ISO week, so UNIQUE(rule_id, symbol,
    bar_time) lets a holding that stays over its band toast once a week, not
    every 15 minutes or every day."""
    y, w, _ = now.date().isocalendar()
    week = f"{y}-W{w:02d}"
    return [
        {"rule_id": "guard:REBALANCE", "symbol": r["symbol"], "bar_time": week,
         "snapshot": {"weight_pct": r["weight_pct"], "target_pct": r["target_pct"],
                      "growth_pct": r["growth_pct"], "sell_shares": r["sell_shares"],
                      "sell_value": r["sell_value"], "est_realized": r["est_realized"]}}
        for r in plan.get("rows", []) if r["status"] == "TRIM"
    ]


def _rebalance_alerts(now: datetime | None = None) -> int:
    from db import get_db
    from routers.risk import _rebalance_plan

    now = now or _now()
    events = rebalance_events(_rebalance_plan(None), now)
    n = 0
    with get_db() as conn:
        for e in events:
            cur = conn.execute(
                "INSERT OR IGNORE INTO alert_events (rule_id, symbol, fired_at, bar_time, snapshot_json) "
                "VALUES (?, ?, ?, ?, ?)",
                (e["rule_id"], e["symbol"], now.isoformat(), e["bar_time"], json.dumps(e["snapshot"])),
            )
            n += cur.rowcount
        conn.commit()
    if n:
        logger.info("rebalance: %d take-profit alert(s)", n)
    return n


def _now() -> datetime:
    return datetime.now(timezone.utc)


def status(now: datetime | None = None) -> dict:
    """Is the notifier alive? `state`: OFF (disabled) · STARTING (first tick not
    due yet) · OK · ERROR (last tick failed) · STALE (no good tick for 2 intervals
    — the alerts the user relies on are not being produced)."""
    now = now or _now()
    out = {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in _status.items()}
    interval = _status["interval"]
    if not _started or not interval:
        out["state"] = "OFF"
        return out
    ok, started = _status["last_ok_at"], _status["started_at"]
    budget = 2 * interval + STARTUP_DELAY
    if ok is None:
        late = started is not None and (now - started).total_seconds() > budget
        out["state"] = "STALE" if late else ("ERROR" if _status["last_error"] else "STARTING")
    elif (now - ok).total_seconds() > budget:
        out["state"] = "STALE"
    elif _status["last_error"]:
        out["state"] = "ERROR"
    else:
        out["state"] = "OK"
    return out


def _loop(interval: int) -> None:
    time.sleep(STARTUP_DELAY)
    while True:
        _status["last_run_at"] = _now()
        try:
            res = run_once()
            _status["last_ok_at"] = _now()
            _status["last_error"] = None
            _status["last_events"] = int(res.get("events") or 0)
        except Exception as e:  # noqa: BLE001 — a bad tick must not kill the loop
            # Shown in the UI: never a URL (they can carry API keys).
            _status["last_error"] = re.sub(r"https?://\S+", "<url>", f"{type(e).__name__}: {e}")[:300]
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
    _status["started_at"] = _now()
    _status["interval"] = interval
    threading.Thread(target=_loop, args=(interval,), daemon=True, name="trade-guard").start()
    logger.info("trade guard: notifier started (every %ds)", interval)
