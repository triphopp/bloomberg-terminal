"""
Scheduled US macro events — FOMC decisions, the data releases the market
trades around, and the dates that follow from a published rule (option expiry,
VIX settlement, FOMC minutes, ISM, the EIA weekly oil report).

Three sources, on purpose:

- **FOMC meetings are hardcoded** from federalreserve.gov/monetarypolicy/
  fomccalendars.htm. FRED cannot supply them: release 101 "FOMC Press Release"
  carries a date on EVERY day (daily series such as DFEDTAR hang off it), and
  release 326 (Summary of Economic Projections) only covers the four SEP
  meetings. The list ends at FOMC_CALENDAR_THROUGH; past that the payload says
  so instead of silently reporting "no meeting".
- **Data releases come from FRED** `release/dates`, which does publish future
  dates. Cached for 12h and fail-soft: a FRED outage degrades to FOMC-only with
  `releases_ok = false`, never to an exception.
- **Rule dates are computed** (`rule_events`): no network, so they survive a
  FRED outage. Each carries `source: "rule"` and the rule in its label — the
  publisher can still move a date (EIA around Christmas, minutes around
  Thanksgiving), so these are the scheduled day, not a confirmation.

Only the kinds in WINDOW_KINDS open the EVENT WINDOW. A weekly report inside
it would leave the window open every week and the tag would stop meaning
anything.

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
    # 2023–2025: past decisions, so the price chart's event rail has FOMC
    # history to line reactions up against (TAIL only ever looked ahead).
    ("2023-02-01", False),
    ("2023-03-22", True),
    ("2023-05-03", False),
    ("2023-06-14", True),
    ("2023-07-26", False),
    ("2023-09-20", True),
    ("2023-11-01", False),
    ("2023-12-13", True),
    ("2024-01-31", False),
    ("2024-03-20", True),
    ("2024-05-01", False),
    ("2024-06-12", True),
    ("2024-07-31", False),
    ("2024-09-18", True),
    ("2024-11-07", False),
    ("2024-12-18", True),
    ("2025-01-29", False),
    ("2025-03-19", True),
    ("2025-05-07", False),
    ("2025-06-18", True),
    ("2025-07-30", False),
    ("2025-09-17", True),
    ("2025-10-29", False),
    ("2025-12-10", True),
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
    46: ("PPI", "Producer Price Index"),
    9: ("RETAIL", "Advance Retail Sales"),
    192: ("JOLTS", "Job Openings (JOLTS)"),
    180: ("CLAIMS", "Weekly Jobless Claims"),
}

# How much each kind tends to move vol, for ordering and emphasis only.
IMPACT: dict[str, str] = {
    "FOMC": "high", "CPI": "high", "NFP": "high", "PCE": "medium", "GDP": "medium",
    "PPI": "medium", "RETAIL": "medium", "JOLTS": "medium", "ISM": "medium",
    "MINUTES": "medium", "OPEX": "medium", "VIXEXP": "medium",
    "CLAIMS": "low", "EIA": "low",
}

# Kinds that open the EVENT WINDOW (and so tag the vol signals).
WINDOW_KINDS = frozenset({"FOMC", "CPI", "NFP", "PCE", "GDP"})

_ORDER = {k: i for i, k in enumerate((
    "FOMC", "CPI", "NFP", "PCE", "GDP", "PPI", "RETAIL", "JOLTS", "ISM",
    "MINUTES", "OPEX", "VIXEXP", "CLAIMS", "EIA",
))}

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
    # No local retry: upstream_health's requests hook already retries FRED GETs
    # (timeout / 5xx, with backoff) — a loop here multiplied it to 6 attempts.
    r = requests.get(FRED_RELEASE_DATES_URL, params=params, timeout=10)
    r.raise_for_status()
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


# ── Rule dates ────────────────────────────────────────────────────────────────

def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """n-th `weekday` (Mon=0) of the month; n = -1 is the last one."""
    if n > 0:
        first = date(year, month, 1)
        return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))
    nxt = date(year + (month == 12), month % 12 + 1, 1)
    last = nxt - timedelta(days=1)
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def good_friday(year: int) -> date:
    # Anonymous Gregorian computus → Easter Sunday, minus two days.
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    g = (8 * b + 13) // 25
    h = (19 * a + b - d - g + 15) % 30
    j, k = c // 4, c % 4
    m = (a + 11 * h) // 319
    r = (2 * e + 2 * j - k - h + m + 32) % 7
    month = (h - m + r + 90) // 25
    day = (h - m + r + month + 19) % 32
    return date(year, month, day) - timedelta(days=2)


def federal_holidays(year: int) -> set[date]:
    """US federal holidays as observed (Saturday → Friday, Sunday → Monday)."""
    fixed = [date(year, 1, 1), date(year, 6, 19), date(year, 7, 4),
             date(year, 11, 11), date(year, 12, 25), date(year + 1, 1, 1)]
    out = set()
    for d in fixed:
        wd = d.weekday()
        out.add(d - timedelta(days=1) if wd == 5 else d + timedelta(days=1) if wd == 6 else d)
    out |= {
        _nth_weekday(year, 1, 0, 3), _nth_weekday(year, 2, 0, 3), _nth_weekday(year, 5, 0, -1),
        _nth_weekday(year, 9, 0, 1), _nth_weekday(year, 10, 0, 2), _nth_weekday(year, 11, 3, 4),
    }
    return {d for d in out if d.year == year}


def _nth_business_day(year: int, month: int, n: int) -> date:
    hol = federal_holidays(year)
    d, seen = date(year, month, 1), 0
    while True:
        if d.weekday() < 5 and d not in hol:
            seen += 1
            if seen == n:
                return d
        d += timedelta(days=1)


def monthly_opex(year: int, month: int) -> date:
    """Standard monthly option expiry: third Friday, Thursday when that is Good Friday."""
    d = _nth_weekday(year, month, 4, 3)
    return d - timedelta(days=1) if d == good_friday(year) else d


def vix_settlement(year: int, month: int) -> date:
    """VIX futures/options final settlement for the `month` contract: 30 days
    before the third Friday of the FOLLOWING month (Cboe rule) — a Wednesday,
    or a Tuesday when that Friday is an exchange holiday."""
    ny, nm = year + (month == 12), month % 12 + 1
    return monthly_opex(ny, nm) - timedelta(days=30)


def eia_weekly(wednesday: date) -> date:
    """EIA Weekly Petroleum Status Report for the week of `wednesday`: Wednesday
    10:30 ET, Thursday when a federal holiday falls Monday–Wednesday of that
    week (eia.gov release schedule; Christmas weeks are set by hand there)."""
    hol = federal_holidays(wednesday.year) | federal_holidays(wednesday.year - 1)
    week = {wednesday - timedelta(days=i) for i in range(3)}
    return wednesday + timedelta(days=1) if week & hol else wednesday


def rule_events(start: date, end: date) -> list[dict]:
    """Events whose date follows from a rule — no network call."""
    out: list[tuple[date, str, str]] = []

    y, m = start.year, start.month
    while date(y, m, 1) <= end:
        opex = monthly_opex(y, m)
        out.append((opex, "OPEX",
                    "Triple witching (index futures + options expiry)" if m % 3 == 0
                    else "Monthly options expiry"))
        out.append((vix_settlement(y, m), "VIXEXP", "VIX futures / options settlement"))
        out.append((_nth_business_day(y, m, 1), "ISM", "ISM Manufacturing PMI (1st business day)"))
        out.append((_nth_business_day(y, m, 3), "ISM", "ISM Services PMI (3rd business day)"))
        y, m = y + (m == 12), m % 12 + 1

    for d, _sep in FOMC_DECISIONS:
        out.append((_d(d) + timedelta(days=21), "MINUTES", f"FOMC minutes (meeting {d}, +3 weeks)"))

    wed = start + timedelta(days=(2 - start.weekday()) % 7)
    while wed <= end + timedelta(days=1):
        out.append((eia_weekly(wed), "EIA", "EIA Weekly Petroleum Status (crude / product stocks)"))
        wed += timedelta(days=7)

    return [
        {"date": d.isoformat(), "kind": kind, "label": label, "sep": False,
         "impact": IMPACT[kind], "source": "rule"}
        for d, kind, label in out
        if start <= d <= end
    ]


def _sorted(events: Iterable[dict]) -> list[dict]:
    return sorted(events, key=lambda e: (e["date"], _ORDER.get(e["kind"], 99)))


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
    all_events = _sorted(fomc_events(start, end) + releases + rule_events(start, end))

    upcoming, past, window = [], [], []
    for e in all_events:
        ed = _d(e["date"])
        bd = business_days_between(today, ed)
        item = {**e, "days_until": (ed - today).days, "bdays_until": bd}
        if ed >= today:
            upcoming.append(item)
        else:
            past.append(item)
        if abs(bd) <= window_bdays and e["kind"] in WINDOW_KINDS:
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
