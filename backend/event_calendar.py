"""
Scheduled US macro events — FOMC decisions and the data releases the market
trades around (CPI, NFP, PCE, GDP).

Two sources, on purpose:

- **FOMC meetings are hardcoded** from federalreserve.gov/monetarypolicy/
  fomccalendars.htm. FRED cannot supply them: release 101 "FOMC Press Release"
  carries a date on EVERY day (daily series such as DFEDTAR hang off it), and
  release 326 (Summary of Economic Projections) only covers the four SEP
  meetings. The list ends at FOMC_CALENDAR_THROUGH; past that the payload says
  so instead of silently reporting "no meeting".
- **Data releases come from FRED** `release/dates`, which does publish future
  dates. Cached for 12h and fail-soft: a FRED outage degrades to FOMC-only with
  `releases_ok = false`, never to an exception.

The decision date is the SECOND day of a two-day meeting — statement and SEP
are released then. The previous hardcoded list in macro.py used the day after,
which is how it came to call a decision day "tomorrow".
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from typing import Iterable, Optional

import requests

from cache import TTLCache

# (decision date, has Summary of Economic Projections)
FOMC_DECISIONS: tuple[tuple[str, bool], ...] = (
    ("2026-01-28", False),
    ("2026-03-18", True),
    ("2026-04-29", False),
    ("2026-06-17", True),
    ("2026-07-29", False),
    ("2026-09-16", True),
    ("2026-10-28", False),
    ("2026-12-09", True),
    ("2027-01-27", False),
    ("2027-03-17", True),
    ("2027-04-28", False),
    ("2027-06-09", True),
    ("2027-07-28", False),
    ("2027-09-15", True),
    ("2027-10-27", False),
    ("2027-12-08", True),
)
FOMC_CALENDAR_THROUGH = FOMC_DECISIONS[-1][0]

# FRED release id → (kind, label)
FRED_RELEASES: dict[int, tuple[str, str]] = {
    10: ("CPI", "CPI"),
    50: ("NFP", "Employment Situation"),
    54: ("PCE", "PCE / Personal Income"),
    53: ("GDP", "GDP"),
}

# How much each kind tends to move vol, for ordering and emphasis only.
IMPACT: dict[str, str] = {"FOMC": "high", "CPI": "high", "NFP": "high", "PCE": "medium", "GDP": "medium"}

FRED_RELEASE_DATES_URL = "https://api.stlouisfed.org/fred/release/dates"

_cache = TTLCache(ttl=12 * 3600)


def _d(s: str) -> date:
    return datetime.strptime(str(s)[:10], "%Y-%m-%d").date()


def business_days_between(a: date, b: date) -> int:
    """Signed count of weekdays stepped from a to b (b later → positive)."""
    if a == b:
        return 0
    step = 1 if b > a else -1
    n, cur = 0, a
    while cur != b:
        cur += timedelta(days=step)
        if cur.weekday() < 5:
            n += step
    return n


def fomc_events(start: date, end: date) -> list[dict]:
    return [
        {
            "date": d,
            "kind": "FOMC",
            "label": "FOMC decision + SEP" if sep else "FOMC decision",
            "sep": sep,
            "impact": IMPACT["FOMC"],
            "source": "federalreserve.gov",
        }
        for d, sep in FOMC_DECISIONS
        if start <= _d(d) <= end
    ]


def _fetch_release_dates(release_id: int, start: date, end: date) -> list[str]:
    from config import FRED_API_KEY  # read at call time so tests can patch it

    if not FRED_API_KEY:
        raise RuntimeError("FRED_API_KEY not set")
    params = {
        "release_id": release_id,
        "api_key": FRED_API_KEY,
        "file_type": "json",
        "realtime_start": start.isoformat(),
        "realtime_end": end.isoformat(),
        "include_release_dates_with_no_data": "true",
        "sort_order": "asc",
        "limit": 1000,
    }
    # One retry: api.stlouisfed.org read-timeouts are sporadic, and a single
    # miss would otherwise drop that release from the strip.
    for attempt in (1, 2):
        try:
            r = requests.get(FRED_RELEASE_DATES_URL, params=params, timeout=10)
            r.raise_for_status()
            break
        except requests.RequestException:
            if attempt == 2:
                raise
    return [x["date"] for x in r.json().get("release_dates", []) if start <= _d(x["date"]) <= end]


def release_events(start: date, end: date) -> tuple[list[dict], bool]:
    """FRED data releases in [start, end]. Returns (events, all_sources_ok)."""
    def one(rid: int):
        key = f"rel:{rid}:{start}:{end}"
        try:
            return rid, _cache.get_or_set(key, lambda: _fetch_release_dates(rid, start, end))
        except Exception as exc:  # fail-soft: FOMC still reported
            print(f"[event_calendar] FRED release {rid} failed: {exc}")
            return rid, None

    events: list[dict] = []
    ok = True
    with ThreadPoolExecutor(max_workers=len(FRED_RELEASES)) as pool:
        results = list(pool.map(one, FRED_RELEASES))
    for rid, dates in results:
        kind, label = FRED_RELEASES[rid]
        if dates is None:
            ok = False
            continue
        events += [
            {"date": d, "kind": kind, "label": label, "sep": False,
             "impact": IMPACT[kind], "source": "FRED"}
            for d in dates
        ]
    return events, ok


def _sorted(events: Iterable[dict]) -> list[dict]:
    order = {"FOMC": 0, "CPI": 1, "NFP": 2, "PCE": 3, "GDP": 4}
    return sorted(events, key=lambda e: (e["date"], order.get(e["kind"], 9)))


def next_fomc(today: date) -> Optional[dict]:
    """Next decision on or after today — a decision day reports days_until 0."""
    for d, sep in FOMC_DECISIONS:
        if _d(d) >= today:
            return {"date": d, "days_until": (_d(d) - today).days, "sep": sep}
    return None


def calendar_payload(today: date, ahead_days: int = 45, back_days: int = 135,
                     window_bdays: int = 1) -> dict:
    """Upcoming events, the active event window, and past events for chart markers.

    `event_window.active` is true when an event is within ±`window_bdays`
    business days of today: vol that is up into a known release is expected,
    not evidence of stress, and the UI says so next to the vol signals.
    """
    start, end = today - timedelta(days=back_days), today + timedelta(days=ahead_days)
    releases, releases_ok = release_events(start, end)
    all_events = _sorted(fomc_events(start, end) + releases)

    upcoming, past, window = [], [], []
    for e in all_events:
        ed = _d(e["date"])
        bd = business_days_between(today, ed)
        item = {**e, "days_until": (ed - today).days, "bdays_until": bd}
        if ed >= today:
            upcoming.append(item)
        else:
            past.append(item)
        if abs(bd) <= window_bdays:
            window.append(item)

    last = _d(FOMC_CALENDAR_THROUGH)
    stale = today > last
    return {
        "as_of": today.isoformat(),
        "upcoming": upcoming,
        "past": past,
        "event_window": {"active": bool(window), "bdays": window_bdays, "events": window},
        "next_fomc": next_fomc(today),
        "fomc_calendar_through": FOMC_CALENDAR_THROUGH,
        "fomc_calendar_stale": stale,
        "fomc_calendar_expiring": not stale and (last - today).days < 60,
        "releases_ok": releases_ok,
    }
