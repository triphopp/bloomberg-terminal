"""
/api/calendar — the one calendar (the CAL view, key 6).

Read-only. Macro events, company dates, what the theses are waiting on and the
book's own dates, in one list (`backend/calendar_feed.py`). What the user adds
from the calendar is written through the routes that already own those rows:
`POST /api/v2/theses/{id}/notes` (a dated note on a thesis) or
`POST /api/v2/questions/calendar` (a date that belongs to no thesis).

One write lives here because only the calendar knows its events:
`POST /api/calendar/questions` ties an open question to a CAL event (a CPI
print, an earnings date). It writes nothing of its own — the event becomes a
row of the question calendar (`question_dates`, reused when it is already
there) and the question waits on it. From then on the question turns `due` when
the day comes and `question_queue` hands it to whoever answers it.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

import calendar_feed as feed
from actor import capture_actor
from db import get_db

router = APIRouter(dependencies=[Depends(capture_actor)])

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


# ── A question waits on a calendar event ─────────────────────────────────────

class EventLinkIn(BaseModel):
    event_id: str            # the `id` of a CAL event (get_calendar)
    question: str            # id or Q-ref
    reads: str = ""          # what will be read from the event for that question


# The kinds a question can wait on, and what they become on the question calendar.
# A note already belongs to its thesis, a tracked number already has its date,
# an expiry / HOLD review is the book's own business — none of those answers a question.
_DATE_KIND = {"EARNINGS": "EARNINGS", "DIVIDEND": "EVENT", "SPLIT": "EVENT", "FOMC": "EVENT"}
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


def _event_by_id(event_id: str) -> dict:
    m = _DAY.search(event_id)
    if not m:
        raise HTTPException(422, f"event_id: an id from the calendar (macro:… / co:… / qdate:…), got {event_id!r}")
    day = date.fromisoformat(m.group(0))
    # fetch=False: a company date is read from what the calendar already holds;
    # the event was on screen (or in get_calendar), so it is there.
    hit = next((e for e in feed.build(day, day, fetch=False)["events"] if e["id"] == event_id), None)
    if hit is None:
        raise HTTPException(404, f"no calendar event {event_id} on {day} — read get_calendar again")
    return hit


@router.post("/api/calendar/questions")
def link_question_to_event(body: EventLinkIn):
    """Tie a question to a CAL event. The event is copied onto the question
    calendar once — its title, day, source and whether the day is confirmed —
    and every later question that waits on it reuses that row."""
    from routers import questions as qs

    eid = body.event_id.strip()
    with get_db() as conn:
        if eid.startswith("qdate:"):
            d = qs._get_date(conn, eid.removeprefix("qdate:"))
        else:
            e = _event_by_id(eid)
            if e["category"] not in ("MACRO", "COMPANY"):
                raise HTTPException(422, f"{e['kind']} event: only a macro release, a company date or a "
                                         "question date can answer a question (a note, a tracked "
                                         "number or an expiry already has its place)")
            title = f"{e['symbol']} {e['title']}" if e["symbol"] else e["title"]
            title = f"{title} — {e['date']}"
            d = next((dict(r) for r in conn.execute(
                "SELECT * FROM question_dates WHERE deleted_at IS NULL")
                if qs._norm(r["title"]) == qs._norm(title)), None)
            if d is None:
                confirmed = not e["estimated"] and bool(e["source_url"])
                d = qs._insert_date(conn, qs.DateIn(
                    title=title, date=e["date"],
                    status="CONFIRMED" if confirmed else "ESTIMATED",
                    source=f"terminal calendar: {e['source'] or e['category'].lower()}",
                    source_url=e["source_url"] or "", symbol=e["symbol"],
                    kind=_DATE_KIND.get(e["kind"], "DATA_RELEASE" if e["category"] == "MACRO" else "OTHER"),
                    note=f"from calendar event {eid}" + (f" — {e['detail']}" if e["detail"] else ""),
                ))
        qs._link_date(conn, d, qs.DateLinkIn(question=body.question, reads=body.reads))
        return {"date": qs._calendar(conn, " AND id = ?", (d["id"],))[0]}
