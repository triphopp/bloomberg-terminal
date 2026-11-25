"""
Release dates of the FRED data the terminal reads — for the CAL view.

FRED publishes the schedule of every release ahead (`fred/release/dates` with
`include_release_dates_with_no_data`), so nothing here is a hand-kept date. Each
row of RELEASES is one FRED release, the kind CAL files it under, and the series
the backend actually reads from it (asked of FRED with `fred/series/release`,
2026-11-25). A series added to the backend whose release is not in the table
gets no date on CAL until a row is added here.

Daily releases are left out on purpose (SKIPPED): H.15 yields, ICE BofA OAS,
the spreads, VIX, Moody's yields and the FOMC target range print every business
day, so a "release" on every weekday would bury the grid and say nothing.
USREC hangs off a daily release too — NBER announces turning points on no
schedule. The SEP is FOMC's own row.

A request never waits on FRED. Dates are pulled one release-year at a time on a
daemon thread and kept in `backend/cache/calendar_fred.json`; the request answers
with what is held and lists what is still `pending`. A failed pull is not asked
again for RETRY_S (6 h after three failures in a row), and the last good dates
stay on screen meanwhile — a FRED outage no longer empties the macro calendar
(2026-10-21: FRED answered with a non-JSON page and every release dropped off).

A release day that has come also carries what it published (HEADLINES: GDP
q/q saar, CPI y/y, payrolls …) as first printed that day — read from the FRED
vintage in force on the date, one call per series per year, same worker, kept
in `backend/cache/calendar_fred_values.json`.
"""
from __future__ import annotations

import threading
import time
from collections import deque
from datetime import date
from typing import NamedTuple, Optional

import requests

import event_calendar as ec
from persist_cache import PersistentStore


class Release(NamedTuple):
    kind: str
    label: str
    impact: str
    series: tuple[str, ...]   # what the backend reads from it ("" = traded around, not read)


# Market-moving releases TAIL already tracks (event_calendar.FRED_RELEASES), with
# the series the backend reads from each.
_READS: dict[int, tuple[str, ...]] = {
    9: ("RSXFS",),
    10: ("CPIAUCSL", "CPILFESL"),
    50: ("PAYEMS", "UNRATE", "MANEMP"),
    53: ("GDPC1", "GDPDEF", "A191RL1Q225SBEA"),
    54: ("PCEPI", "PCEPILFE"),
}

# The rest of what the backend reads from FRED. Weekly prints are "low" — CAL
# hides those behind its รายสัปดาห์ switch, and reminders skip them.
_DATA: dict[int, Release] = {
    22: Release("H8", "H.8 Bank Assets & Liabilities", "low", ("BUSLOANS",)),
    52: Release("Z1", "Z.1 Financial Accounts", "medium", ("NCBDBIQ027S", "BOGZ1FL153064476Q")),
    80: Release("TBULL", "Treasury Bulletin (federal debt)", "medium", ("GFDEBTN",)),
    91: Release("UMICH", "UMich Consumer Sentiment", "medium", ("UMCSENT",)),
    99: Release("CBO", "CBO Budget & Economic Outlook", "medium", ("GDPPOT", "NROU")),
    187: Release("STLFSI", "St. Louis Fed Financial Stress Index", "low", ("STLFSI4",)),
    190: Release("MORTGAGE", "Mortgage rates (Freddie Mac PMMS)", "low", ("MORTGAGE30US",)),
    191: Release("SLOOS", "Senior Loan Officer Survey", "medium", ("DRTSCILM",)),
    205: Release("OECD", "OECD Main Economic Indicators (CLI, 10Y yields)", "medium",
                 ("USALOLITOAASTSAM", "IRLTLT01JPM156N", "IRLTLT01DEM156N")),
    219: Release("CFNAI", "Chicago Fed National Activity Index", "medium",
                 ("CFNAI", "CFNAIMA3", "CFNAIDIFF")),
    221: Release("NFCI", "Chicago Fed Financial Conditions (NFCI)", "low", ("NFCI", "ANFCI")),
    231: Release("DELINQ", "Bank Charge-off & Delinquency Rates", "medium",
                 ("DRCCLACBS", "DRSFRMACBS")),
    261: Release("RECPROB", "Recession Probabilities (Chauvet–Piger)", "medium", ("RECPROUSM156N",)),
    321: Release("EMPIRE", "Empire State Manufacturing Survey", "medium", ("GACDISA066MSFRBNY",)),
    351: Release("PHILLY", "Philly Fed Manufacturing Survey", "medium", ("GACDFSA066MSFRBPHI",)),
    354: Release("KW", "Kim–Wright term premium", "low", ("THREEFY10", "THREEFYTP10")),
    373: Release("GDPRI", "GDP-based Recession Index", "medium", ("JHGDPBRINDX",)),
    374: Release("DALLAS", "Dallas Fed Manufacturing Survey", "medium", ("BACTSAMFRBDAL",)),
    456: Release("SAHM", "Sahm Rule Recession Indicator", "medium", ("SAHMREALTIME",)),
}

RELEASES: dict[int, Release] = {
    **{rid: Release(kind, label, ec.IMPACT[kind], _READS.get(rid, ()))
       for rid, (kind, label) in ec.FRED_RELEASES.items()},
    **_DATA,
}

# Read by the backend, never put on CAL — see the module docstring.
SKIPPED: dict[int, str] = {
    18: "H.15 Selected Interest Rates — daily (DGS*, DFII*, GS10, TB3MS, FEDFUNDS)",
    101: "FOMC Press Release — daily (DFEDTARL/U); FOMC dates are hardcoded in event_calendar",
    200: "CBOE Market Statistics — daily (VIXCLS)",
    209: "ICE BofA Indices — daily (BAMLH0A0HYM2, BAMLC0A0CM, BAMLC0A4CBBBEY)",
    242: "Recession Indicators — daily (USREC); NBER announces on no schedule",
    304: "Interest Rate Spreads — daily (T10Y2Y, T10Y3M, T10YIE, T5YIE, TEDRATE)",
    326: "Summary of Economic Projections (FEDTARMDLR) — already the FOMC decision + SEP row",
    427: "Moody's Daily Corporate Bond Yields — daily (DAAA, DBAA)",
}


# ── What was printed: the headline figures of each release ────────────────────
#
# A release day on CAL carries the number it published — GDP 4.30% on the day
# BEA put it out — as first published that day, not today's revised value: the
# value comes from the FRED vintage (ALFRED) in force on the release date, so a
# GDP second estimate shows the second estimate and the advance shows the
# advance. Same transforms TAIL uses (routers/macro.py `_INDICATOR_CFG`).

class Headline(NamedTuple):
    series: str
    label: str
    xform: str        # direct | yoy_pct | mom_pct | mom_diff
    fmt: str          # str.format of the scaled value
    scale: float = 1.0


_PCT = "{:.2f}%"
_SPCT = "{:+.2f}%"
_IDX = "{:.2f}"

HEADLINES: dict[int, tuple[Headline, ...]] = {
    9: (Headline("RSXFS", "Retail sales m/m", "mom_pct", _SPCT),),
    10: (Headline("CPIAUCSL", "CPI y/y", "yoy_pct", _PCT),
         Headline("CPILFESL", "Core CPI y/y", "yoy_pct", _PCT)),
    46: (Headline("PPIFIS", "PPI final demand y/y", "yoy_pct", _PCT),),
    50: (Headline("PAYEMS", "Nonfarm payrolls", "mom_diff", "{:+,.0f}k"),
         Headline("UNRATE", "Unemployment rate", "direct", _PCT)),
    53: (Headline("A191RL1Q225SBEA", "Real GDP q/q saar", "direct", _PCT),),
    54: (Headline("PCEPI", "PCE y/y", "yoy_pct", _PCT),
         Headline("PCEPILFE", "Core PCE y/y", "yoy_pct", _PCT)),
    180: (Headline("ICSA", "Initial claims", "direct", "{:,.0f}k", 1e-3),),
    192: (Headline("JTSJOL", "Job openings", "direct", "{:.2f}M", 1e-3),),
    22: (Headline("BUSLOANS", "C&I loans", "direct", "${:,.1f}bn"),),
    52: (Headline("NCBDBIQ027S", "Nonfin. corporate debt securities", "direct", "${:,.1f}bn", 1e-3),),
    80: (Headline("GFDEBTN", "Federal debt", "direct", "${:,.2f}tn", 1e-6),),
    91: (Headline("UMCSENT", "Consumer sentiment", "direct", _IDX),),
    187: (Headline("STLFSI4", "Financial stress index", "direct", _IDX),),
    190: (Headline("MORTGAGE30US", "30Y fixed mortgage", "direct", _PCT),),
    191: (Headline("DRTSCILM", "Banks tightening C&I standards (net)", "direct", _PCT),),
    205: (Headline("USALOLITOAASTSAM", "US composite leading indicator", "direct", _IDX),),
    219: (Headline("CFNAI", "CFNAI", "direct", _IDX),
          Headline("CFNAIMA3", "CFNAI 3-month avg", "direct", _IDX)),
    221: (Headline("NFCI", "NFCI", "direct", _IDX),),
    231: (Headline("DRCCLACBS", "Credit card delinquency", "direct", _PCT),
          Headline("DRSFRMACBS", "Mortgage delinquency", "direct", _PCT)),
    261: (Headline("RECPROUSM156N", "Recession probability", "direct", _PCT),),
    321: (Headline("GACDISA066MSFRBNY", "Empire general conditions", "direct", _IDX),),
    351: (Headline("GACDFSA066MSFRBPHI", "Philly Fed general activity", "direct", _IDX),),
    354: (Headline("THREEFYTP10", "10Y term premium", "direct", _PCT),),
    373: (Headline("JHGDPBRINDX", "GDP-based recession index", "direct", _PCT),),
    374: (Headline("BACTSAMFRBDAL", "Dallas Fed general activity", "direct", _IDX),),
    456: (Headline("SAHMREALTIME", "Sahm rule", "direct", "{:.2f} pp"),),
}


def _shift_year(d: str, years: int) -> str:
    return f"{int(d[:4]) + years:04d}{d[4:]}"


def _xform(obs: list[tuple[str, float]], i: int, how: str) -> Optional[float]:
    """Transformed value of observation i of one vintage (sorted by date)."""
    d, v = obs[i]
    if how == "direct":
        return v
    if how in ("mom_pct", "mom_diff"):
        if i == 0:
            return None
        p = obs[i - 1][1]
        return v - p if how == "mom_diff" else (v / p - 1) * 100 if p else None
    if how == "yoy_pct":
        ago = dict(obs).get(_shift_year(d, -1))
        return (v / ago - 1) * 100 if ago else None
    raise ValueError(how)


def _period(obs: list[tuple[str, float]]) -> str:
    """Reference period of the last observation, named the way the agency does."""
    d = obs[-1][0]
    gap = (date.fromisoformat(d) - date.fromisoformat(obs[-2][0])).days if len(obs) > 1 else 31
    if gap > 80:
        return f"Q{(int(d[5:7]) - 1) // 3 + 1} {d[:4]}"
    if gap > 20:
        return date.fromisoformat(d).strftime("%b %Y")
    return f"week of {d}"


def vintage_values(rows: list[tuple[str, str, str, Optional[float]]], how: str,
                   year: int) -> dict[str, list]:
    """{release day: [value, previous value, reference period]} for every day of
    `year` on which this series got new data — each read from the vintage in
    force on that day. `rows` = (observation date, realtime_start, realtime_end,
    value) as FRED returns them with a realtime window."""
    lo = f"{year:04d}-01-01"
    out: dict[str, list] = {}
    for day in sorted({r[1] for r in rows if r[1] >= lo and r[1][:4] == str(year)}):
        obs = sorted((o, v) for o, s, e, v in rows if s <= day <= e and v is not None)
        if not obs:
            continue
        out[day] = [_xform(obs, len(obs) - 1, how),
                    _xform(obs, len(obs) - 2, how) if len(obs) > 1 else None,
                    _period(obs)]
    return out


def _fetch_obs(series: str, year: int) -> list[tuple[str, str, str, Optional[float]]]:
    """Every vintage of `series` that took effect in `year`. Raises on any failure."""
    from config import FRED_API_KEY

    if not FRED_API_KEY:
        raise RuntimeError("FRED_API_KEY not set")
    # realtime_end may not be after today unless it is FRED's max date.
    rt_end = f"{year}-12-31" if year < date.today().year else "9999-12-31"
    r = requests.get(OBS_URL, params={
        "series_id": series, "api_key": FRED_API_KEY, "file_type": "json",
        "realtime_start": f"{year}-01-01", "realtime_end": rt_end,
        # 14 months before January: a y/y on the first print of the year.
        "observation_start": f"{year - 2}-01-01",
    }, timeout=30)
    r.raise_for_status()
    try:
        body = r.json()
    except ValueError:
        import upstream_health
        upstream_health.record("FRED", "bad_body", target=f"/fred/series/observations?series_id={series}")
        raise
    rows = []
    for x in body.get("observations", []):
        try:
            v: Optional[float] = float(x["value"])
        except (TypeError, ValueError):
            v = None   # "." = no value
        rows.append((x["date"], x["realtime_start"], x["realtime_end"], v))
    return rows


def _how(series: str) -> str:
    return next(h.xform for hs in HEADLINES.values() for h in hs if h.series == series)


def _text(h: Headline, v: Optional[float]) -> Optional[str]:
    return None if v is None else h.fmt.format(v * h.scale)


def actual(rid: int, day: str) -> Optional[list[dict]]:
    """The headline figures release `rid` published on `day`, as held. None when
    the release has no headline; [] when none is held for that day (not out yet,
    or FRED has not picked it up)."""
    heads = HEADLINES.get(rid)
    if not heads:
        return None
    out = []
    for h in heads:
        entry = _vstore.get(_vkey(h.series, int(day[:4])))
        got = ((entry or {}).get("vals") or {}).get(day)
        if not got:
            continue
        v, p, period = got
        out.append({"series": h.series, "label": h.label,
                    "value": None if v is None else round(v * h.scale, 6),
                    # Printed, but the change cannot be worked out from FRED: the
                    # earlier observation is missing (CPI of Oct 2025 was never
                    # collected — the 2025 shutdown — so no y/y for Oct 2026).
                    "text": _text(h, v) or "n/a", "prev_text": _text(h, p), "period": period})
    return out


# ── Background pull (dates and values share one worker) ──────────────────────

# More dates than a weekly release has in a year: the release turned daily.
MAX_PER_YEAR = 60

FRESH_S = 12 * 3600        # a good pull is reused this long
RETRY_S = 30 * 60          # a failed pull is not asked again sooner
RETRY_SLOW_S = 6 * 3600    # … and this long once it has failed three times running
KEEP_S = 60 * 86400        # the last good dates stay as fallback this long
PAST_YEAR_FRESH_S = 30 * 86400   # vintages of a past year no longer change
AWAIT_DAYS = 3             # a release this recent with no figure held is asked again every RETRY_S

OBS_URL = "https://api.stlouisfed.org/fred/series/observations"

_store = PersistentStore("calendar_fred", max_age=KEEP_S, maxsize=500)
_vstore = PersistentStore("calendar_fred_values", max_age=KEEP_S, maxsize=500)
_queue: deque[str] = deque()
_inflight: set[str] = set()
_active = 0
_lock = threading.Lock()


def release_url(rid: int) -> str:
    return f"https://fred.stlouisfed.org/releases/calendar?rid={rid}"


def _key(rid: int, year: int) -> str:
    return f"{rid}:{year}"


def _vkey(series: str, year: int) -> str:
    return f"v:{series}:{year}"


def _fetch(rid: int, year: int) -> list[str]:
    """One release's dates in one calendar year. Raises on any failure."""
    try:
        dates = ec._fetch_release_dates(rid, date(year, 1, 1), date(year, 12, 31))
    except ValueError:
        # A 200 that is not JSON (FRED's maintenance page) passes the requests
        # hook as a success; say so in logs/upstream.jsonl.
        import upstream_health
        upstream_health.record("FRED", "bad_body", target=f"/fred/release/dates?release_id={rid}")
        raise
    if len(dates) > MAX_PER_YEAR:
        raise RuntimeError(f"{len(dates)} dates in {year} — release is daily now")
    return dates


def _due(entry: Optional[dict], now: float, fresh: float = FRESH_S) -> bool:
    if entry is None:
        return True
    age = now - entry.get("tried", 0)
    if not entry.get("error"):
        return age > fresh
    return age > (RETRY_SLOW_S if entry.get("fails", 0) >= 3 else RETRY_S)


def _pull(key: str) -> None:
    try:
        now = time.time()
        if key.startswith("v:"):
            _, series, y = key.split(":")
            store, field = _vstore, "vals"
            fetch = lambda: vintage_values(_fetch_obs(series, int(y)), _how(series), int(y))  # noqa: E731
        else:
            rid, year = (int(x) for x in key.split(":"))
            store, field = _store, "dates"
            fetch = lambda: _fetch(rid, year)  # noqa: E731
        prev = store.get(key)
        try:
            entry = {field: fetch(), "ts": now, "tried": now, "fails": 0, "error": None}
        except Exception as exc:  # noqa: BLE001 — recorded, retried on the negative-cache clock
            print(f"[fred_release_dates] {key} failed: {type(exc).__name__}: {exc}")
            # Keep the last good answer, and its age: a fallback that is never
            # refreshed must still expire.
            entry = {field: prev.get(field) if prev else None,
                     "ts": prev.get("ts", now) if prev else now, "tried": now,
                     "fails": (prev.get("fails", 0) if prev else 0) + 1,
                     "error": type(exc).__name__}
        store.put(key, entry)
    finally:
        with _lock:
            _inflight.discard(key)


def _work() -> None:
    global _active
    while True:
        with _lock:
            if not _queue:
                _active -= 1
                return
            key = _queue.popleft()
        _pull(key)


def _schedule(keys: list[str]) -> None:
    """Queue these keys (the caller decided they are due). One worker: FRED
    allows 120 calls a minute and a cold start is ~60 calls per year on screen."""
    global _active
    with _lock:
        for k in keys:
            if k in _inflight:
                continue
            _inflight.add(k)
            _queue.append(k)
        if _queue and _active == 0:
            _active = 1
            threading.Thread(target=_work, daemon=True, name="cal-fred").start()


def idle() -> bool:
    with _lock:
        return not _inflight


def _value_keys_due(dated: list[tuple[int, str]], years: range, today: date, now: float,
                    force: bool) -> list[str]:
    """Value pulls to queue: a missing or stale year, and — on top of the plain
    freshness — a release of the last AWAIT_DAYS whose figure is not held yet
    (FRED picks a print up some time after the agency posts it)."""
    awaiting = {h.series for rid, d in dated
                if 0 <= (today - date.fromisoformat(d)).days <= AWAIT_DAYS and actual(rid, d) == []
                for h in HEADLINES.get(rid, ())}
    out = []
    for series in {h.series for hs in HEADLINES.values() for h in hs}:
        # FRED refuses a realtime window that starts in the future.
        for y in (y for y in years if y <= today.year):
            k = _vkey(series, y)
            entry = _vstore.get(k)
            fresh = PAST_YEAR_FRESH_S if y < today.year else FRESH_S
            if force or _due(entry, now, fresh) or (
                    series in awaiting and y == today.year and now - entry.get("tried", 0) > RETRY_S):
                out.append(k)
    return out


def events(start: date, end: date, *, fetch: bool = True, force: bool = False,
           today: Optional[date] = None) -> tuple[list[dict], dict]:
    """FRED release dates in [start, end] from what is held — each past one with
    the figures it published — and how the pull stands. With `fetch`, what is
    missing or due is queued behind the request."""
    today = today or date.today()
    now = time.time()
    years = range(start.year, end.year + 1)
    keys = [_key(rid, y) for rid in RELEASES for y in years]
    dated: list[tuple[int, str]] = []
    out: list[dict] = []
    pending: list[str] = []
    failed: dict[str, str] = {}
    blank = False   # a release that failed with no last-good dates to show
    if fetch:
        _schedule([k for k in keys if force or _due(_store.get(k), now)])
    with _lock:
        inflight = set(_inflight)
    for k in keys:
        entry = _store.get(k)
        if entry and entry.get("error"):
            failed[k] = entry["error"]
        if not entry or entry.get("dates") is None:
            if not entry or k in inflight:
                pending.append(k)
            else:
                blank = True
            continue
        rid = int(k.split(":")[0])
        rel = RELEASES[rid]
        for d in entry["dates"]:
            if not start <= date.fromisoformat(d[:10]) <= end:
                continue
            dated.append((rid, d))
            out.append({"date": d, "kind": rel.kind, "label": rel.label, "impact": rel.impact,
                        "source": "FRED", "release_id": rid, "series": list(rel.series),
                        # Figures exist only once the day has come.
                        "actual": actual(rid, d) if d <= today.isoformat() else None})
    if fetch:
        _schedule(_value_keys_due(dated, years, today, now, force))
    # A failure with last-good dates still on screen is only listed under `failed`.
    return out, {"ok": not blank, "releases": len(RELEASES), "pending": pending, "failed": failed}
