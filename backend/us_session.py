"""The US trading day a market reading belongs to. Pure — stdlib only.

A number read off a US option chain describes a US session, so the row it goes
into is dated by that session, not by the clock of the machine that read it.
`date.today()` here is the Thai date, which turns at 13:00 ET — mid-session —
and on 2026-10-06 that filed Friday's session (read at 13:00–16:30 ET on one
machine) and a stale Saturday-morning chain (read on the other) under the same
non-trading day, Saturday 2026-10-03, with different values: 61 iv_snapshots
sync conflicts (memory/reports/iv-snapshot-sync-conflicts-risk-report.md).

The rule:
  * during or after the session (09:30 ET onward, Mon–Fri) a reading belongs to
    that ET day;
  * before the open, or on a weekend, the chain still shows the last session's
    marks, so the reading belongs to the previous weekday.

Weekday exchange holidays are not modelled, on purpose: a reading on one is
dated that day on every machine alike (no conflict, one extra point of an
unchanged chain), while a holiday table here would be another calendar to keep
in step with the frontend's (components/bloomberg/lib/us-market-session.ts).
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
OPEN = time(9, 30)
CLOSE = time(16, 0)


def _previous_weekday(day: date) -> date:
    day -= timedelta(days=1)
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day


def session_date(now: datetime | None = None) -> date:
    """The US session whose marks a reading taken at `now` shows."""
    et = (now or datetime.now(timezone.utc)).astimezone(ET)
    day = et.date()
    if day.weekday() >= 5 or et.time() < OPEN:
        return _previous_weekday(day)
    return day


def close_utc(day: date) -> datetime:
    """16:00 ET of `day`, in UTC."""
    return datetime.combine(day, CLOSE, ET).astimezone(timezone.utc)


def is_after_close(now: datetime | None = None) -> bool:
    """Has the session that `now` belongs to closed? True from 16:00 ET, before
    the next open and all weekend — the chain then holds closing-side marks."""
    now = now or datetime.now(timezone.utc)
    return now >= close_utc(session_date(now))


def parse_utc(stamp: str | None) -> datetime | None:
    """A SQLite `datetime('now')` stamp (UTC, optional fraction) — None if unreadable."""
    if not stamp:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f"):
        try:
            return datetime.strptime(str(stamp)[:26], fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def written_after_close(created_at: str | None, day: date | str) -> bool | None:
    """Was a row for session `day` written once that session had closed?
    None when the stamp cannot be read."""
    stamp = parse_utc(created_at)
    if stamp is None:
        return None
    if isinstance(day, str):
        day = date.fromisoformat(day[:10])
    return stamp >= close_utc(day)
