"""
Alert scan scheduler (plan §6 "Scheduler").

Without this, the whole engine is inert: rules get created and stored, and
nothing ever evaluates them. `POST /api/alerts/scan` had no caller at all —
neither backend nor frontend — so an alert could only fire if someone curled
the endpoint by hand.

Design choices worth stating:

  * 15-minute period, matching watchlist_signals' `_cache` TTL, so a scan
    reuses bars that were about to be fetched anyway instead of doubling
    yfinance traffic (plan §6).
  * **Self-gating.** Each tick first asks "is there an enabled rule?" — a
    single indexed COUNT — and returns without touching the network if not.
    A user who never creates a rule pays nothing for this thread existing.
  * Daemon thread, started once from main.py, same pattern as
    sync.start_background_push() and bc_calibration — no new dependency for a
    single periodic job.
  * `ALERT_SCAN_INTERVAL=0` disables it entirely.

A scan is idempotent per bar: UNIQUE(rule_id, symbol, bar_time) on
alert_events means a tick that re-evaluates an already-fired bar is a DB-level
no-op, so a missed or doubled tick can't produce duplicate notifications.
"""
from __future__ import annotations

import logging
import os
import threading
import time

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL = 15 * 60
# Give the app a moment to finish booting before the first scan — startup
# already fires off regime training and BC calibration.
STARTUP_DELAY = 60

_started = False


def interval_seconds() -> int:
    raw = os.getenv("ALERT_SCAN_INTERVAL", "").strip()
    if not raw:
        return DEFAULT_INTERVAL
    try:
        return max(0, int(raw))
    except ValueError:
        logger.warning("ALERT_SCAN_INTERVAL=%r is not an integer — using default", raw)
        return DEFAULT_INTERVAL


def _has_enabled_rules() -> bool:
    from db import get_db

    with get_db() as conn:
        row = conn.execute("SELECT 1 FROM alert_rules WHERE enabled = 1 LIMIT 1").fetchone()
    return row is not None


def run_once() -> dict:
    """One scan tick. Returns the scan response, or a `skipped` marker.

    Imported lazily: routers.alert_rules imports this package, so a top-level
    import here would be circular.
    """
    if not _has_enabled_rules():
        return {"skipped": "no enabled rules"}

    from routers import alert_rules

    result = alert_rules.run_scan()
    if result.get("count"):
        logger.info(
            "alert scan: %d event(s) fired, delivery=%s", result["count"], result.get("delivery")
        )
    return result


def _loop(interval: int) -> None:
    time.sleep(STARTUP_DELAY)
    while True:
        try:
            run_once()
        except Exception as e:  # noqa: BLE001 — a bad tick must not kill the loop
            logger.warning("alert scan tick failed (will retry next interval): %s", e)
        time.sleep(interval)


def start_background_scan() -> None:
    global _started
    if _started:
        return
    interval = interval_seconds()
    if interval == 0:
        logger.info("alert scan: disabled (ALERT_SCAN_INTERVAL=0)")
        return
    _started = True
    threading.Thread(target=_loop, args=(interval,), daemon=True, name="alert-scan").start()
    logger.info("alert scan: background scanner started (every %ds)", interval)
