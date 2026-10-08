"""
/api/calendar — the one calendar (the CAL view, key 6).

Read-only. Macro events, company dates, what the theses are waiting on and the
book's own dates, in one list (`backend/calendar_feed.py`). What the user adds
from the calendar is written through the routes that already own those rows:
`POST /api/v2/theses/{id}/notes` (a dated note on a thesis) or
`POST /api/v2/questions/calendar` (a date that belongs to no thesis).
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

import calendar_feed as feed

router = APIRouter()

DEFAULT_BACK_DAYS = 7
DEFAULT_AHEAD_DAYS = 45


def _day(name: str, value: Optional[str], fallback: date) -> date:
    if not value:
        return fallback
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        raise HTTPException(422, f"{name}: YYYY-MM-DD") from None


@router.get("/api/calendar")
def get_calendar(
    start: Optional[str] = Query(None, description="first day, YYYY-MM-DD (default: a week back)"),
    end: Optional[str] = Query(None, description="last day, YYYY-MM-DD (default: 45 days ahead)"),
    refresh: bool = Query(False, description="ask Yahoo again for every company date now"),
):
    """Every event in the window, soonest first. Company dates load in the
    background: `sources.company.pending` lists the symbols still being read —
    ask again in a few seconds."""
    today = date.today()
    lo = _day("start", start, today - timedelta(days=DEFAULT_BACK_DAYS))
    hi = _day("end", end, today + timedelta(days=DEFAULT_AHEAD_DAYS))
    if hi < lo:
        raise HTTPException(422, "end is before start")
    if (hi - lo).days > feed.MAX_SPAN_DAYS:
        raise HTTPException(422, f"window too long: at most {feed.MAX_SPAN_DAYS} days")
    return feed.build(lo, hi, today, force=refresh)
