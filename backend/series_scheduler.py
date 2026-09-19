"""
Daily indicator-series recorder.

Same problem and same shape as `iv_scheduler`: the publishers behind these
series show only what is true NOW, and sell the history (DRAMeXchange's own
charts are member-only). The series therefore exists only because something
wrote it down each day, and a day nobody recorded is a permanent hole.

Design notes:

  * **Catch-up first, then tick.** The first pass runs shortly after boot, not
    one interval later: this machine is a desktop that is on for part of a day,
    so a scheduler that only fires on a long timer would miss most days.
  * **Self-gating on the SOURCE's date, not ours.** A pass is skipped when every
    collector's newest stamped date is already stored. That is what makes several
    passes a day nearly free, and it is also why a weekly table does not cause a
    refetch every three hours.
  * **One re-read after the publisher's update time.** DRAMeXchange stamps spot
    at ~18:10 GMT+8; a pass that ran at 09:00 recorded yesterday's print, so the
    first pass after that hour runs again even if the day looks covered. The
    upsert on (series_id, date) makes that a replace rather than a duplicate.
  * Daemon thread, started once from main.py. `SERIES_REFRESH_INTERVAL=0`
    disables it entirely (the UI's refresh button still works).
"""
from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

#: A pass is cheap once the day is covered, and several chances per day is what
#: makes the series survive a machine that is only on for part of it.
DEFAULT_INTERVAL = 4 * 60 * 60

#: Let the app finish booting (DB init, sync pull, calibration) first.
STARTUP_DELAY = 120

#: The publishers this module follows are Taiwanese; DRAMeXchange updates spot
#: at 18:10 local. One re-read after that hour gets the day's real print.
_TPE = ZoneInfo("Asia/Taipei")
_PUBLISH_HOUR = 19

_started = False
_last_pass_after_publish = ""


def interval_seconds() -> int:
    raw = os.getenv("SERIES_REFRESH_INTERVAL", "").strip()
    if not raw:
        return DEFAULT_INTERVAL
    try:
        return max(0, int(raw))
    except ValueError:
        logger.warning("SERIES_REFRESH_INTERVAL=%r is not an integer — using default", raw)
        return DEFAULT_INTERVAL


def _after_publish(now: datetime | None = None) -> bool:
    return (now or datetime.now(timezone.utc)).astimezone(_TPE).hour >= _PUBLISH_HOUR


def _tpe_today() -> str:
    return datetime.now(timezone.utc).astimezone(_TPE).date().isoformat()


def needs_pass() -> bool:
    """True when today's numbers are not in the store yet.

    'Today' is the publisher's day, not ours: the check is whether the newest
    point we hold was captured today in Taipei terms. A source whose own stamp
    is older (a weekly table) still satisfies it, because the pass that stored
    it did run today — the gate is about our reading, not about their cadence.
    """
    global _last_pass_after_publish
    from db import get_db

    today = _tpe_today()
    with get_db() as conn:
        row = conn.execute("SELECT MAX(captured_at) AS c FROM series_points").fetchone()
    captured = str((row["c"] if row else "") or "")
    if not captured:
        return True

    try:
        seen_day = (
            datetime.fromisoformat(captured)
            .replace(tzinfo=timezone.utc)
            .astimezone(_TPE)
            .date()
            .isoformat()
        )
    except ValueError:
        return True

    if seen_day != today:
        return True
    # Covered for today — but if that reading happened before the publisher's
    # update hour, take one more after it.
    if _after_publish() and _last_pass_after_publish != today:
        return True
    return False


def run_pass() -> list:
    import series_sources

    results = series_sources.run()
    if _after_publish():
        global _last_pass_after_publish
        _last_pass_after_publish = _tpe_today()
    for r in results:
        if r.ok:
            logger.info(
                "series: %s recorded %d point(s) across %d series %s",
                r.source, r.points, r.series, r.dates,
            )
        else:
            logger.warning("series: %s failed — %s", r.source, r.error)
    return results


def _loop(interval: int) -> None:
    time.sleep(STARTUP_DELAY)
    while True:
        try:
            if needs_pass():
                run_pass()
        except Exception:  # a scheduler thread that dies takes the series with it
            logger.exception("series: pass failed")
        time.sleep(interval)


def start_background_recorder() -> None:
    global _started
    if _started:
        return
    interval = interval_seconds()
    if interval == 0:
        logger.info("series recorder: disabled (SERIES_REFRESH_INTERVAL=0)")
        return
    _started = True
    threading.Thread(target=_loop, args=(interval,), daemon=True,
                     name="series-recorder").start()
    logger.info("series recorder: background recorder started (every %ds)", interval)
