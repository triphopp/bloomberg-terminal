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
"""
from __future__ import annotations

import threading
import time
from collections import deque
from datetime import date
from typing import NamedTuple, Optional

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

# More dates than a weekly release has in a year: the release turned daily.
MAX_PER_YEAR = 60

FRESH_S = 12 * 3600        # a good pull is reused this long
RETRY_S = 30 * 60          # a failed pull is not asked again sooner
RETRY_SLOW_S = 6 * 3600    # … and this long once it has failed three times running
KEEP_S = 60 * 86400        # the last good dates stay as fallback this long

_store = PersistentStore("calendar_fred", max_age=KEEP_S, maxsize=500)
_queue: deque[str] = deque()
_inflight: set[str] = set()
_active = 0
_lock = threading.Lock()


def release_url(rid: int) -> str:
    return f"https://fred.stlouisfed.org/releases/calendar?rid={rid}"


def _key(rid: int, year: int) -> str:
    return f"{rid}:{year}"


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


def _due(entry: Optional[dict], now: float) -> bool:
    if entry is None:
        return True
    age = now - entry.get("tried", 0)
    if not entry.get("error"):
        return age > FRESH_S
    return age > (RETRY_SLOW_S if entry.get("fails", 0) >= 3 else RETRY_S)


def _pull(key: str) -> None:
    try:
        rid, year = (int(x) for x in key.split(":"))
        now = time.time()
        prev = _store.get(key)
        try:
            entry = {"dates": _fetch(rid, year), "ts": now, "tried": now, "fails": 0, "error": None}
        except Exception as exc:  # noqa: BLE001 — recorded, retried on the negative-cache clock
            print(f"[fred_release_dates] release {rid} {year} failed: {type(exc).__name__}: {exc}")
            # Keep the last good dates, and their age: a fallback that is never
            # refreshed must still expire.
            entry = {"dates": prev.get("dates") if prev else None,
                     "ts": prev.get("ts", now) if prev else now, "tried": now,
                     "fails": (prev.get("fails", 0) if prev else 0) + 1,
                     "error": type(exc).__name__}
        _store.put(key, entry)
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


def _schedule(keys: list[str], force: bool = False) -> None:
    """Queue every key that is due. One worker: FRED allows 120 calls a minute
    and a cold start is ~30 releases × the years on screen."""
    global _active
    now = time.time()
    with _lock:
        for k in keys:
            if k in _inflight or not (force or _due(_store.get(k), now)):
                continue
            _inflight.add(k)
            _queue.append(k)
        if _queue and _active == 0:
            _active = 1
            threading.Thread(target=_work, daemon=True, name="cal-fred").start()


def idle() -> bool:
    with _lock:
        return not _inflight


def events(start: date, end: date, *, fetch: bool = True, force: bool = False) -> tuple[list[dict], dict]:
    """FRED release dates in [start, end] from what is held, and how the pull
    stands. With `fetch`, what is missing or due is queued behind the request."""
    keys = [_key(rid, y) for rid in RELEASES for y in range(start.year, end.year + 1)]
    if fetch:
        _schedule(keys, force=force)
    out: list[dict] = []
    pending: list[str] = []
    failed: dict[str, str] = {}
    with _lock:
        inflight = set(_inflight)
    blank = False   # a release that failed with no last-good dates to show
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
        out += [{"date": d, "kind": rel.kind, "label": rel.label, "impact": rel.impact,
                 "source": "FRED", "release_id": rid, "series": list(rel.series)}
                for d in entry["dates"] if start <= date.fromisoformat(d[:10]) <= end]
    # A failure with last-good dates still on screen is only listed under `failed`.
    return out, {"ok": not blank, "releases": len(RELEASES), "pending": pending, "failed": failed}
