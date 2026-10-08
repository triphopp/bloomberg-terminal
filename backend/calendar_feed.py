"""
One calendar over every dated thing the terminal already knows about.

Nothing new is stored here. Four kinds of date lived in four places, each with
its own screen, and none of them knew about the others:

  MACRO    event_calendar.py — FOMC, FRED release dates, rule dates (TAIL strip)
  COMPANY  earnings and dividends per symbol, from Yahoo (stock view, chart rail)
  THESIS   thesis_notes.watch_date and question_dates, with the tracked numbers
           that wait on them (PORT → TOOLS)
  PORT     option expiries of open lots, HOLD review dates

`build()` reads them into one list in one shape and says which theses each event
belongs to — a note through its thesis, a question date through its questions
and tracked numbers, a company date through the symbol. A macro event belongs
to no thesis by itself; the user ties one to a thesis by writing a dated note
on that day, and the two then sit together under the same date.

What the user adds from the calendar goes where such things already go: a dated
note on a thesis (`thesis_notes`), or a row of the question calendar
(`question_dates`) when it belongs to no thesis. Those tables sync; this module
has none of its own.

Company dates are the only slow source — one Yahoo round per symbol — so they
are pulled in the background and kept in `backend/cache/calendar_company.json`.
A request never waits on them: it answers with what is held and lists what is
still `pending`. A symbol that failed is not asked again for RETRY_S (6 h after
three failures in a row), and its last good answer stays on screen meanwhile.
"""
from __future__ import annotations

import hashlib
import sqlite3
import threading
import time
from collections import deque
from datetime import date, datetime, timedelta
from typing import Optional

import event_calendar as ec
from db import get_db
from persist_cache import PersistentStore

CATEGORIES = ("MACRO", "COMPANY", "THESIS", "PORT")
_CAT_ORDER = {c: i for i, c in enumerate(CATEGORIES)}
_IMPACT_ORDER = {"high": 0, "medium": 1, "low": 2, None: 3}

MAX_SPAN_DAYS = 400

FOMC_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"

# ── Company dates: background pull, kept across restarts ─────────────────────

FRESH_S = 6 * 3600        # a good pull is reused this long
RETRY_S = 30 * 60         # a failed pull is not asked again sooner
RETRY_SLOW_S = 6 * 3600   # … and this long once it has failed three times running
KEEP_S = 30 * 86400       # the last good answer stays as fallback this long
HISTORY_DAYS = 3 * 366    # dividend history kept per symbol
_WORKERS = 3              # gentle on Yahoo: the app-wide gate allows 6

_store = PersistentStore("calendar_company", max_age=KEEP_S, maxsize=2000)
# Pulls run on daemon threads that live only while there is work. Not a
# ThreadPoolExecutor: the interpreter joins one at exit, queue and all, and a
# reload right after the calendar was opened would wait out 25 Yahoo rounds.
_queue: deque[str] = deque()
_inflight: set[str] = set()
_active = 0
_lock = threading.Lock()


def _d(s) -> date:
    return date.fromisoformat(str(s)[:10])


def _px(v: float) -> str:
    """House price format: two decimals, up to four below 1."""
    if abs(v) >= 1:
        return f"{v:,.2f}"
    whole, _, frac = f"{v:.4f}".rstrip("0").partition(".")
    return f"{whole}.{frac.ljust(2, '0')}"


def _short(text: str, n: int = 220) -> str:
    t = " ".join(str(text or "").split())
    return t if len(t) <= n else t[: n - 1].rstrip() + "…"


def _event(eid: str, day: str, category: str, kind: str, title: str, *, symbol: Optional[str] = None,
           impact: Optional[str] = None, estimated: bool = False, source: str = "",
           source_url: str = "", detail: str = "", done: bool = False, due: bool = False,
           theses: Optional[list[dict]] = None, ref: Optional[dict] = None,
           tag: Optional[str] = None) -> dict:
    return {
        "id": eid, "date": day, "category": category, "kind": kind, "title": title,
        "symbol": symbol, "impact": impact, "estimated": estimated,
        "source": source, "source_url": source_url, "detail": detail,
        "done": done, "due": due, "theses": theses or [], "ref": ref, "tag": tag,
    }


# ── MACRO ────────────────────────────────────────────────────────────────────

def macro_events(start: date, end: date) -> tuple[list[dict], dict]:
    """FOMC + FRED releases + rule dates in [start, end].

    FRED is asked a calendar year at a time, not for the window on screen:
    event_calendar caches by the exact range, and a month grid that moves by a
    month would otherwise be eight new calls on every click.
    """
    releases: list[dict] = []
    releases_ok = True
    for year in range(start.year, end.year + 1):
        rows, ok = ec.release_events(date(year, 1, 1), date(year, 12, 31))
        releases_ok = releases_ok and ok
        releases += [r for r in rows if start <= _d(r["date"]) <= end]

    out: dict[str, dict] = {}
    for e in ec.fomc_events(start, end) + releases + ec.rule_events(start, end):
        day = str(e["date"])[:10]
        eid = f"macro:{e['kind']}:{day}"
        if eid in out:  # ISM prints two reports on some days; keep them apart
            eid = f"{eid}:{hashlib.sha1(e['label'].encode()).hexdigest()[:6]}"
        out[eid] = _event(
            eid, day, "MACRO", e["kind"], e["label"], impact=e.get("impact"),
            # A rule date is the scheduled day, not the publisher's confirmation.
            estimated=e.get("source") == "rule",
            source=e.get("source") or "",
            source_url=FOMC_URL if e["kind"] == "FOMC" else "",
        )
    last = _d(ec.FOMC_CALENDAR_THROUGH)
    return list(out.values()), {
        "ok": releases_ok, "releases_ok": releases_ok,
        "fomc_through": ec.FOMC_CALENDAR_THROUGH,
        # Asked for days past the hardcoded list: "no FOMC" there means "not entered".
        "fomc_missing": end > last,
    }


# ── Theses, and who a symbol belongs to ──────────────────────────────────────

def _thesis_brief(row: dict, via: str) -> dict:
    return {"id": row["id"], "symbol": row["symbol"], "title": row["title"],
            "status": row["status"], "via": via}


def load_theses(conn) -> tuple[dict[str, dict], dict[str, list[dict]]]:
    """Every live thesis by id, and by the symbols it answers to."""
    from routers.theses import _INSTRUMENT_KINDS, _kind_of

    by_id: dict[str, dict] = {}
    by_symbol: dict[str, list[dict]] = {}
    try:
        rows = conn.execute(
            "SELECT id, symbol, resolved_symbol, title, status, kind, category "
            "FROM theses WHERE deleted_at IS NULL ORDER BY created_at").fetchall()
    except sqlite3.OperationalError:
        return by_id, by_symbol
    for r in rows:
        t = dict(r)
        t["instrument"] = _kind_of(t) in _INSTRUMENT_KINDS
        by_id[t["id"]] = t
        for s in {str(t.get("symbol") or "").upper(), str(t.get("resolved_symbol") or "").upper()}:
            if s:
                by_symbol.setdefault(s, []).append(t)
    return by_id, by_symbol


def _theses_for_symbol(by_symbol: dict[str, list[dict]], *symbols: Optional[str]) -> list[dict]:
    seen: dict[str, dict] = {}
    for s in symbols:
        for t in by_symbol.get(str(s or "").upper(), []):
            seen.setdefault(t["id"], _thesis_brief(t, "symbol"))
    return list(seen.values())


def company_universe(conn, by_symbol: dict[str, list[dict]]) -> dict[str, dict]:
    """Symbols whose company dates belong on the calendar: every open thesis
    about a tradable instrument, every open position, every open option's
    underlying. Keyed by the provider symbol; `display` is what the book calls it."""
    out: dict[str, dict] = {}

    def add(provider: Optional[str], display: Optional[str], held: bool) -> None:
        p = str(provider or display or "").upper().strip()
        if not p or p.endswith("-USD") or p.endswith("=X") or p.startswith("^"):
            return  # crypto, FX, indices: no earnings, no dividends
        u = out.setdefault(p, {"symbol": p, "display": str(display or p).upper(), "held": False})
        u["held"] = u["held"] or held

    # A thesis written as "AOT" means the AOT.BK the book trades, not whatever
    # "AOT" is elsewhere: take the provider symbol the trade log resolved for it.
    traded: dict[str, str] = {}
    try:
        for r in conn.execute("SELECT DISTINCT symbol, resolved_symbol FROM trades "
                              "WHERE COALESCE(resolved_symbol, '') != ''").fetchall():
            traded.setdefault(str(r["symbol"]).upper(), r["resolved_symbol"])
    except sqlite3.OperationalError:
        pass
    for rows in by_symbol.values():
        for t in rows:
            if t["instrument"] and t["status"] not in ("closed", "invalidated"):
                sym = str(t.get("symbol") or "").upper()
                add(t.get("resolved_symbol") or traded.get(sym) or sym, sym, False)
    for sql in (
        "SELECT DISTINCT symbol, resolved_symbol FROM trades "
        "WHERE win_loss = 'P' AND COALESCE(market, '') != 'CRYPTO'",
        "SELECT DISTINCT underlying AS symbol, underlying AS resolved_symbol "
        "FROM v_option_open_lots WHERE quantity != 0",
    ):
        try:
            for r in conn.execute(sql).fetchall():
                add(r["resolved_symbol"], r["symbol"], True)
        except sqlite3.OperationalError:
            continue
    return out


# ── COMPANY ──────────────────────────────────────────────────────────────────

def _fetch_company(symbol: str) -> dict:
    """One symbol's earnings and dividend dates from the stock endpoints (so the
    SET deadline rule and their 1 h cache are shared with the stock view).
    Each half fails on its own; `errors` names what did."""
    from fastapi import HTTPException

    from routers import stock

    out: dict = {"earnings": [], "dividends": [], "upcoming_dividends": [], "splits": [], "errors": {}}
    floor = (date.today() - timedelta(days=HISTORY_DAYS)).isoformat()

    def err(exc: Exception) -> str:
        return f"HTTP {exc.status_code}" if isinstance(exc, HTTPException) else type(exc).__name__

    try:
        out["earnings"] = [e for e in stock.stock_earnings_calendar(symbol).get("earningsDates", [])
                           if str(e.get("date") or "")[:10] >= floor]
    except Exception as exc:  # noqa: BLE001 — recorded, and retried on the negative-cache clock
        out["errors"]["earnings"] = err(exc)
    try:
        d = stock.stock_dividends(symbol)
        out["dividends"] = [x for x in d.get("dividends", []) if str(x.get("date") or "") >= floor]
        out["splits"] = [x for x in d.get("splits", []) if str(x.get("date") or "") >= floor]
        out["upcoming_dividends"] = d.get("upcomingDividends", [])
    except Exception as exc:  # noqa: BLE001
        out["errors"]["dividends"] = err(exc)
    return out


def _due_for_pull(entry: Optional[dict], now: float) -> bool:
    if entry is None:
        return True
    age = now - entry.get("tried", 0)
    if not entry.get("errors"):
        return age > FRESH_S
    return age > (RETRY_SLOW_S if entry.get("fails", 0) >= 3 else RETRY_S)


def _pull(symbol: str) -> None:
    try:
        now = time.time()
        prev = _store.get(symbol)
        try:
            got = _fetch_company(symbol)
        except Exception as exc:  # noqa: BLE001 — still recorded, or it is asked again at once
            got = {"earnings": [], "dividends": [], "upcoming_dividends": [], "splits": [],
                   "errors": dict.fromkeys(("earnings", "dividends"), type(exc).__name__)}
        failed = bool(got["errors"])
        entry = {**got, "ts": now, "tried": now,
                 "fails": (prev.get("fails", 0) + 1 if prev else 1) if failed else 0}
        if failed and prev:
            # Keep the half that worked last time rather than blank it, and keep
            # its age: a fallback that is never refreshed must still expire.
            for part, keys in (("earnings", ("earnings",)),
                               ("dividends", ("dividends", "upcoming_dividends", "splits"))):
                if part in got["errors"]:
                    for k in keys:
                        entry[k] = prev.get(k, [])
            if len(got["errors"]) == 2:
                entry["ts"] = prev.get("ts", now)
        _store.put(symbol, entry)
    finally:
        with _lock:
            _inflight.discard(symbol)


def _work() -> None:
    global _active
    while True:
        with _lock:
            if not _queue:
                _active -= 1
                return
            symbol = _queue.popleft()
        _pull(symbol)


def _schedule(symbols: list[str], force: bool = False) -> list[str]:
    """Queue a pull for every symbol that is due; returns what is now in flight."""
    global _active
    now = time.time()
    with _lock:
        for s in symbols:
            if s in _inflight or not (force or _due_for_pull(_store.get(s), now)):
                continue
            _inflight.add(s)
            _queue.append(s)
        while _active < min(_WORKERS, len(_queue)):
            _active += 1
            threading.Thread(target=_work, daemon=True, name="cal-company").start()
        return sorted(s for s in symbols if s in _inflight)


def idle() -> bool:
    """No company pull queued or running."""
    with _lock:
        return not _inflight


def _company_rows(u: dict, entry: dict, start: str, end: str, theses: list[dict]) -> list[dict]:
    sym, shown = u["symbol"], u["display"]
    out: dict[str, dict] = {}

    def put(kind: str, day: str, title: str, **kw) -> None:
        if start <= day <= end:
            eid = f"co:{kind}:{sym}:{day}"
            out.setdefault(eid, _event(eid, day, "COMPANY", kind, title, symbol=shown,
                                       theses=theses, **kw))

    for e in entry.get("earnings") or []:
        day = str(e.get("date") or "")[:10]
        if len(day) != 10:
            continue
        if e.get("deadline"):
            put("EARNINGS", day, f"Filing deadline {e.get('period') or ''}".strip(), estimated=True,
                source="SET filing deadline (rule)",
                detail="Last day the exchange allows — companies usually file earlier.")
            continue
        reported, est, sur = e.get("reportedEPS"), e.get("epsEstimate"), e.get("surprise")
        if reported is not None:
            bits = [f"EPS {_px(reported)}"]
            if est is not None:
                bits.append(f"vs est {_px(est)}")
            if sur is not None:
                bits.append(f"({sur:+.1f}%)")
            detail = " ".join(bits)
        else:
            detail = f"EPS est {_px(est)}" if est is not None else ""
            if e.get("windowEnd"):
                detail = (detail + " · " if detail else "") + f"window to {e['windowEnd']} — not confirmed"
        put("EARNINGS", day, str(e.get("eventType") or "Earnings").strip() or "Earnings",
            estimated=bool(e.get("estimated")), detail=detail, done=reported is not None,
            source="Yahoo calendar" if e.get("source") == "yahoo_calendar" else "Yahoo earnings dates")

    for x in entry.get("upcoming_dividends") or []:
        day = str(x.get("date") or "")[:10]
        if len(day) != 10:
            continue
        bits = []
        if x.get("dividend") is not None:
            bits.append(f"{_px(x['dividend'])} per share"
                        + (" (last paid — amount not announced)" if x.get("estimated") else ""))
        if x.get("payDate"):
            bits.append(f"pays {x['payDate']}")
        put("DIVIDEND", day, "Ex-dividend", detail=" · ".join(bits), source="Yahoo calendar")
    for x in entry.get("dividends") or []:
        day = str(x.get("date") or "")[:10]
        if len(day) == 10 and x.get("dividend") is not None:
            put("DIVIDEND", day, "Ex-dividend", detail=f"{_px(x['dividend'])} per share",
                done=True, source="Yahoo dividend history")
    for x in entry.get("splits") or []:
        day = str(x.get("date") or "")[:10]
        if len(day) == 10 and x.get("ratio"):
            put("SPLIT", day, f"Split {x['ratio']:g}:1", done=True, source="Yahoo split history")
    return list(out.values())


def company_events(universe: dict[str, dict], by_symbol: dict[str, list[dict]], start: date,
                   end: date, *, fetch: bool = True, force: bool = False) -> tuple[list[dict], dict]:
    symbols = sorted(universe)
    pending = _schedule(symbols, force) if fetch else []
    events: list[dict] = []
    failed: dict[str, dict] = {}
    oldest: Optional[float] = None
    held = 0
    for s in symbols:
        entry = _store.get(s)
        if entry is None:
            continue
        held += 1
        if entry.get("errors"):
            failed[universe[s]["display"]] = entry["errors"]
        oldest = entry["ts"] if oldest is None else min(oldest, entry["ts"])
        theses = _theses_for_symbol(by_symbol, s, universe[s]["display"])
        events += _company_rows(universe[s], entry, start.isoformat(), end.isoformat(), theses)
    return events, {
        "ok": not failed, "symbols": len(symbols), "loaded": held,
        "pending": [universe[s]["display"] for s in pending], "failed": failed,
        "oldest_pull": datetime.fromtimestamp(oldest).isoformat(timespec="seconds") if oldest else None,
    }


# ── THESIS ───────────────────────────────────────────────────────────────────

def note_events(conn, by_id: dict[str, dict], start: date, end: date) -> list[dict]:
    rows = conn.execute(
        """SELECT id, thesis_id, kind, title, body, impact, status, watch_date
           FROM thesis_notes
           WHERE deleted_at IS NULL AND COALESCE(watch_date, '') != ''
             AND SUBSTR(watch_date, 1, 10) BETWEEN ? AND ?""",
        (start.isoformat(), end.isoformat())).fetchall()
    out = []
    for r in rows:
        t = by_id.get(r["thesis_id"])
        if t is None:  # its thesis was deleted
            continue
        title = (r["title"] or "").strip()
        out.append(_event(
            f"note:{r['id']}", r["watch_date"][:10], "THESIS", "NOTE",
            title or _short(r["body"], 90), symbol=t["symbol"], tag=r["kind"],
            detail=_short(r["body"]) if title else "", source="thesis note",
            done=r["status"] in ("confirmed", "dismissed"),
            theses=[_thesis_brief(t, "note")],
            ref={"type": "note", "id": r["id"], "thesis_id": r["thesis_id"],
                 "status": r["status"], "impact": r["impact"]},
        ))
    return out


def question_date_events(conn, by_id: dict[str, dict], by_symbol: dict[str, list[dict]],
                         start: date, end: date) -> list[dict]:
    """Rows of the question calendar, with the questions and tracked numbers
    that wait on each, plus a forecast whose release day is not a calendar row."""
    from routers import questions, tracking

    rows = questions._calendar(conn, " AND date >= ? AND date <= ?",
                               (start.isoformat(), end.isoformat()))
    try:
        metrics = tracking._load(conn)
    except sqlite3.OperationalError:  # tracking tables not created yet
        metrics = []
    waits: dict[str, list[tuple[dict, dict]]] = {}
    for m in metrics:
        for w in m["state"]["waits"]:
            waits.setdefault(w["date_id"], []).append((m, w))

    def link(theses: dict[str, dict], thesis_id: Optional[str], via: str) -> None:
        t = by_id.get(thesis_id or "")
        if t is not None:
            theses.setdefault(t["id"], _thesis_brief(t, via))

    out = []
    for r in rows:
        theses: dict[str, dict] = {}
        # The questions travel in `ref` (each is a link); `detail` is what else
        # hangs on the date — the tracked numbers, or the row's own note.
        bits = []
        for q in r["questions"]:
            link(theses, q["thesis_id"], "question")
        unread = False
        for m, w in waits.get(r["id"], []):
            link(theses, m["thesis_id"], "metric")
            unread = unread or (w["reading"] is None and not m["retired_at"])
            bits.append(f"{m['ref']} {m['title']} — expected: {w['expected']}"
                        + (f" → {w['reading']['value_text']}" if w["reading"] else ""))
        for t in _theses_for_symbol(by_symbol, r["symbol"]):
            theses.setdefault(t["id"], t)
        arrived = r["days_until"] <= 0
        out.append(_event(
            f"qdate:{r['id']}", r["date"][:10], "THESIS", "QDATE", r["title"], symbol=r["symbol"],
            tag=r["kind"], estimated=r["status"] != "CONFIRMED", source=r["source"],
            source_url=r["source_url"], detail=_short(" | ".join(bits) or r["note"], 400),
            due=bool(r["due"]) or (arrived and unread),
            done=arrived and not r["due"] and not unread and bool(bits or r["questions"]),
            theses=list(theses.values()),
            ref={"type": "question_date", "id": r["id"], "ref": r["ref"],
                 "questions": [{"id": q["id"], "ref": q["ref"], "title": q["title"],
                                "thesis_id": q["thesis_id"], "status": q["status"],
                                "reads": q["reads"]}
                               for q in r["questions"]]},
        ))

    lo, hi = start.isoformat(), end.isoformat()
    for m in metrics:
        nxt = m["state"]["next"]
        if m["retired_at"] or not nxt or nxt["date_id"] or not nxt["date"] or not (lo <= nxt["date"] <= hi):
            continue
        theses = {}
        link(theses, m["thesis_id"], "metric")
        out.append(_event(
            f"track:{m['id']}:{nxt['period']}", nxt["date"], "THESIS", "TRACK",
            f"{m['title']} ({nxt['period']})", symbol=m["symbol"], tag=m["role"],
            source=m["source_name"], source_url=m["source_url"],
            detail=f"{m['ref']} — expected: {nxt['expected']}", due=bool(nxt["due"]),
            theses=list(theses.values()),
            ref={"type": "metric", "id": m["id"], "ref": m["ref"], "thesis_id": m["thesis_id"]},
        ))
    return out


# ── PORT ─────────────────────────────────────────────────────────────────────

def port_events(conn, by_symbol: dict[str, list[dict]], start: date, end: date) -> list[dict]:
    lo, hi = start.isoformat(), end.isoformat()
    out = []
    try:
        lots = conn.execute(
            "SELECT underlying, SUBSTR(expiry, 1, 10) AS expiry, option_type, strike, quantity "
            "FROM v_option_open_lots WHERE quantity != 0 AND SUBSTR(expiry, 1, 10) BETWEEN ? AND ? "
            "ORDER BY expiry, underlying, strike", (lo, hi)).fetchall()
    except sqlite3.OperationalError:
        lots = []
    groups: dict[tuple[str, str], list[str]] = {}
    for r in lots:
        groups.setdefault((r["underlying"], r["expiry"]), []).append(
            f"{str(r['option_type'])[:1].upper()}{r['strike']:g} ×{r['quantity']:g}")
    for (underlying, expiry), legs in groups.items():
        out.append(_event(
            f"opt:{underlying}:{expiry}", expiry, "PORT", "EXPIRY",
            f"Options expire — {len(legs)} open lot{'s' if len(legs) != 1 else ''}",
            symbol=underlying, detail=" · ".join(legs), source="option book",
            theses=_theses_for_symbol(by_symbol, underlying)))
    try:
        holds = conn.execute(
            "SELECT id, kind, symbol, yf_symbol, reason, review_on FROM risk_decisions "
            "WHERE decision = 'HOLD' AND cleared_at IS NULL AND COALESCE(review_on, '') != '' "
            "AND SUBSTR(review_on, 1, 10) BETWEEN ? AND ?", (lo, hi)).fetchall()
    except sqlite3.OperationalError:
        holds = []
    for r in holds:
        out.append(_event(
            f"hold:{r['id']}", r["review_on"][:10], "PORT", "REVIEW",
            f"HOLD review ({str(r['kind']).lower()})", symbol=r["symbol"],
            detail=_short(r["reason"]), source="risk decision journal",
            theses=_theses_for_symbol(by_symbol, r["symbol"], r["yf_symbol"])))
    return out


# ── The calendar ─────────────────────────────────────────────────────────────

def build(start: date, end: date, today: Optional[date] = None, *, fetch: bool = True,
          force: bool = False) -> dict:
    """Every event in [start, end], soonest first, and how each source fared.
    A source that fails is reported under `sources` and leaves the rest standing."""
    today = today or date.today()
    events: list[dict] = []
    sources: dict[str, dict] = {}

    try:
        rows, sources["macro"] = macro_events(start, end)
        events += rows
    except Exception as exc:  # noqa: BLE001
        sources["macro"] = {"ok": False, "error": type(exc).__name__}

    with get_db() as conn:
        by_id, by_symbol = load_theses(conn)
        universe = company_universe(conn, by_symbol)
        for name, fn in (
            ("notes", lambda: note_events(conn, by_id, start, end)),
            ("dates", lambda: question_date_events(conn, by_id, by_symbol, start, end)),
            ("port", lambda: port_events(conn, by_symbol, start, end)),
        ):
            try:
                rows = fn()
                events += rows
                sources[name] = {"ok": True, "count": len(rows)}
            except Exception as exc:  # noqa: BLE001
                sources[name] = {"ok": False, "error": type(exc).__name__}

    rows, sources["company"] = company_events(universe, by_symbol, start, end,
                                              fetch=fetch, force=force)
    events += rows

    for e in events:
        e["days_until"] = (_d(e["date"]) - today).days
    events.sort(key=lambda e: (e["date"], _CAT_ORDER[e["category"]],
                               _IMPACT_ORDER.get(e["impact"], 3), e["symbol"] or "", e["title"]))
    return {
        "as_of": today.isoformat(), "start": start.isoformat(), "end": end.isoformat(),
        "events": events, "sources": sources,
        "theses": [{"id": t["id"], "symbol": t["symbol"], "title": t["title"], "status": t["status"]}
                   for t in by_id.values()],
    }


# ── Reminders ────────────────────────────────────────────────────────────────

ALERT_LEAD_BDAYS = 1
ALERT_MACRO_IMPACT = frozenset({"high"})


def alertable(events: list[dict], today: date) -> list[dict]:
    """The events worth a line in the alert feed today: anything still open that
    falls today or on the next business day (so Monday's is said on Friday).
    Macro is held to the releases that move markets — a weekly report every week
    would teach people to ignore the strip. One row per event; the client words
    it "today" / "tomorrow" from the date."""
    out = []
    for e in events:
        if e["done"]:
            continue
        day = _d(e["date"])
        if day < today or ec.business_days_between(today, day) > ALERT_LEAD_BDAYS:
            continue
        if e["category"] == "MACRO" and e["impact"] not in ALERT_MACRO_IMPACT:
            continue
        thesis = e["theses"][0] if e["theses"] else None
        ref = e["ref"] or {}
        questions = ref.get("questions") or []
        snapshot = {
            "event_id": e["id"], "date": e["date"], "category": e["category"], "kind": e["kind"],
            "title": e["title"], "symbol": e["symbol"],
            # A fact worth a line under the headline (EPS estimate, the dividend,
            # the legs expiring). A note's body or a question is one click away.
            "detail": _short(e["detail"], 120) if e["kind"] not in ("NOTE", "QDATE") else "",
            "estimated": e["estimated"], "source": e["source"],
            "thesis_id": thesis["id"] if thesis else None,
            "thesis_symbol": thesis["symbol"] if thesis else None,
            "thesis_count": len(e["theses"]),
            "note_id": ref.get("id") if ref.get("type") == "note" else None,
            "question_id": questions[0]["id"] if questions else None,
        }
        out.append({
            "rule_id": f"cal:{e['kind']}",
            "symbol": e["symbol"] or (thesis["symbol"] if thesis else e["category"]),
            # UNIQUE(rule_id, symbol, bar_time): the date leads so past rows can be
            # cleared by it, the hash keeps two notes of one thesis on one day apart.
            "bar_time": f"{e['date']}#{hashlib.sha1(e['id'].encode()).hexdigest()[:8]}",
            "snapshot": {k: v for k, v in snapshot.items() if v not in (None, "")},
        })
    return out
