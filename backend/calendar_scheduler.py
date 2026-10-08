"""
CALENDAR notifier — a date that has come up → alert-feed event.

Every interval it reads the next few days of the one calendar
(`calendar_feed.build`) and writes each event worth saying
(`calendar_feed.alertable`: today or the next business day, still open, macro
only when high impact) to `alert_events` with rule_id = "cal:<KIND>", so the
ticker, the alert list and the toast show it with the rest
(`alert_rules.list_events` names these rows). The snapshot carries the thesis
the event belongs to, which is what the alert links to.

UNIQUE(rule_id, symbol, bar_time) with bar_time = "<date>#<event hash>" makes
it one row per event however often the scan runs; a date that moves is a new
event. A reminder whose day has passed is acknowledged here — nobody should
have to dismiss yesterday. `CALENDAR_SCAN_INTERVAL=0` disables (default 1800 s).
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from datetime import date, datetime, timedelta, timezone

import calendar_feed as feed

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL = 30 * 60
STARTUP_DELAY = 150
# Far enough to hold "the next business day" across a long weekend.
LOOKAHEAD_DAYS = 5
_started = False


def interval_seconds() -> int:
    raw = os.getenv("CALENDAR_SCAN_INTERVAL", "").strip()
    if not raw:
        return DEFAULT_INTERVAL
    try:
        return max(0, int(raw))
    except ValueError:
        logger.warning("CALENDAR_SCAN_INTERVAL=%r is not an integer — using default", raw)
        return DEFAULT_INTERVAL


def apply(conn, events: list[dict], today: date, now: datetime | None = None) -> list[dict]:
    """Write the reminders for `events`, clear the ones whose day is over.
    Returns the rows that were new."""
    now = now or datetime.now(timezone.utc)
    written = []
    for a in feed.alertable(events, today):
        cur = conn.execute(
            "INSERT OR IGNORE INTO alert_events (rule_id, symbol, fired_at, bar_time, snapshot_json) "
            "VALUES (?, ?, ?, ?, ?)",
            (a["rule_id"], a["symbol"], now.isoformat(), a["bar_time"],
             json.dumps(a["snapshot"], ensure_ascii=False)),
        )
        if cur.rowcount:
            written.append(a)
    conn.execute(
        "UPDATE alert_events SET acked = 1 "
        "WHERE acked = 0 AND rule_id LIKE 'cal:%' AND SUBSTR(bar_time, 1, 10) < ?",
        (today.isoformat(),),
    )
    conn.commit()
    return written


def run_once() -> dict:
    from db import get_db

    today = date.today()
    payload = feed.build(today, today + timedelta(days=LOOKAHEAD_DAYS), today)
    with get_db() as conn:
        written = apply(conn, payload["events"], today)
    if written:
        logger.info("calendar: %d reminder(s): %s", len(written),
                    ", ".join(f"{a['symbol']} {a['rule_id']}" for a in written))
    return {"events": len(written), "pending": payload["sources"].get("company", {}).get("pending", [])}


def _loop(interval: int) -> None:
    time.sleep(STARTUP_DELAY)
    while True:
        try:
            run_once()
        except Exception as e:  # noqa: BLE001 — a bad tick must not kill the loop
            logger.exception("calendar tick failed (will retry next interval): %s", e)
        time.sleep(interval)


def start_background_scan() -> None:
    global _started
    if _started:
        return
    interval = interval_seconds()
    if interval == 0:
        logger.info("calendar: notifier disabled (CALENDAR_SCAN_INTERVAL=0)")
        return
    _started = True
    threading.Thread(target=_loop, args=(interval,), daemon=True, name="calendar-scan").start()
    logger.info("calendar: notifier started (every %ds)", interval)
