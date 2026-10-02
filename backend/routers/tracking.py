"""
Thesis tracking — the numbers a thesis stands or falls on, compared against what
was expected on the day they are published.

Schema + rationale: db.init_tracking_schema(); plan in
memory/plans/thesis-tracking.md; how an agent uses it in
memory/reference/thesis-tracking.md.

What the endpoints exist to enforce:

  1. A metric says where its number is read. Capturing one is cheap (a title and
     a thesis), but a metric with no source, no forecast for the next period, or
     — for a killer — no kill rule shows what is missing as `gaps` and sits in
     SETUP until it is filled in.
  2. A forecast is written before the result and never after. It names the
     period, what is expected, WHY, and the date the number comes out. Setting
     or revising one for a period that already has its number is refused.
  3. A reading carries its evidence, and the numbers decide the verdict. When
     the forecast is a band the server compares; a verdict sent that disagrees
     with the arithmetic is refused.
  4. A miss is not closed by recording it. A reading that is not in line, or
     that crosses the kill line, opens a question under the thesis in the same
     transaction; the metric stays OFF until that question is answered (by the
     rules of routers/questions.py) or dropped by the user.
  5. Kill lines do not drift. Moving one, or demoting a killer, needs a reason,
     lands on the thesis timeline, and is the user's to do.
  6. Status is derived, never stored — see `_derive`.

Crossing a kill line changes nothing on the thesis itself: it is shown, logged
as KILLER_HIT, and left for the user to act on.
"""
import json
import operator
import sqlite3
from datetime import date
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

import routers.questions as questions
from actor import capture_actor, current_actor
from db import get_db
from routers.questions import (
    DateIn, ParentIn, QuestionIn, _evidence_problem, _in, _is_date, _norm, _now_sync, _uid,
    _user_only, _zettel_brief, _zettel_briefs,
)
from routers.theses import _log_event
from sync.config import device_id

router = APIRouter(prefix="/api/v2/tracking", dependencies=[Depends(capture_actor)])

ROLES = ("KILLER", "WATCH")
CADENCES = ("QUARTERLY", "MONTHLY", "WEEKLY", "DAILY", "EVENT")
KILL_OPS = {"<": operator.lt, "<=": operator.le, ">": operator.gt, ">=": operator.ge}
NOT_IN_LINE = ("ABOVE", "BELOW", "OFF")
# Most urgent first — the order the board is sorted in.
STATUSES = ("KILL", "DUE", "OFF", "SETUP", "WAITING", "RETIRED")
EDITABLE = ("title", "role", "unit", "definition", "why", "kill_rule", "kill_op", "kill_value",
            "cadence", "source_name", "source_url", "source_locator", "source_tool", "series_id",
            "question_id")
RULE_FIELDS = ("role", "kill_rule", "kill_op", "kill_value")


# ── Models ───────────────────────────────────────────────────────────────────

class ExpectationIn(BaseModel):
    period: str = ""
    expected: str = ""
    low: Optional[float] = None
    high: Optional[float] = None
    basis: str = ""
    evidence: list[str] = []
    date: Optional[str] = None          # a D-ref / id already on the question calendar
    new_date: Optional[DateIn] = None   # or put the event on the calendar now
    due_date: Optional[str] = None      # or a day to look, when no event stands behind it
    release_time: str = ""


class MetricIn(BaseModel):
    title: str
    thesis_id: Optional[str] = None
    role: str = "WATCH"
    unit: str = ""
    definition: str = ""
    why: str = ""
    kill_rule: str = ""
    kill_op: Optional[str] = None
    kill_value: Optional[float] = None
    cadence: str = "QUARTERLY"
    source_name: str = ""
    source_url: str = ""
    source_locator: str = ""
    source_tool: str = ""
    series_id: Optional[str] = None
    question: Optional[str] = None      # Q-ref / id of the question this number informs
    expectation: Optional[ExpectationIn] = None


class MetricPatch(BaseModel):
    title: Optional[str] = None
    role: Optional[str] = None
    unit: Optional[str] = None
    definition: Optional[str] = None
    why: Optional[str] = None
    kill_rule: Optional[str] = None
    kill_op: Optional[str] = None
    kill_value: Optional[float] = None
    cadence: Optional[str] = None
    source_name: Optional[str] = None
    source_url: Optional[str] = None
    source_locator: Optional[str] = None
    source_tool: Optional[str] = None
    series_id: Optional[str] = None
    question: Optional[str] = None
    reason: str = ""


class ReadingIn(BaseModel):
    value: Optional[float] = None
    value_text: str = ""
    as_of: Optional[str] = None
    period: str = ""                    # only when there is no forecast to take it from
    expectation_id: Optional[str] = None
    verdict: Optional[str] = None
    kill: Optional[bool] = None
    note: str = ""
    zettel: Optional[str] = None
    source_url: str = ""
    quote: str = ""


class RetireIn(BaseModel):
    reason: str = ""


# ── Small helpers ────────────────────────────────────────────────────────────

def _next_ref(conn) -> str:
    row = conn.execute(
        "SELECT MAX(CAST(SUBSTR(ref, 3) AS INTEGER)) FROM track_metrics "
        "WHERE ref LIKE 'K-%' AND SUBSTR(ref, 3) GLOB '[0-9]*'"
    ).fetchone()
    return f"K-{((row[0] or 0) + 1):04d}"


def _get_metric(conn, metric_id: str) -> dict:
    row = conn.execute(
        "SELECT * FROM track_metrics WHERE (id = ? OR ref = ?) AND deleted_at IS NULL",
        (metric_id, metric_id),
    ).fetchone()
    if row is None:
        raise HTTPException(404, f"tracked metric {metric_id} not found")
    return dict(row)


def _num(v: float) -> str:
    return format(v, ",.10g")


def _band(low: Optional[float], high: Optional[float]) -> str:
    if low is not None and high is not None:
        return _num(low) if low == high else f"{_num(low)} – {_num(high)}"
    if low is not None:
        return f"≥ {_num(low)}"
    if high is not None:
        return f"≤ {_num(high)}"
    return ""


def _kill_line(m: dict) -> str:
    return f"{m['kill_op']} {_num(m['kill_value'])}" if m["kill_op"] and m["kill_value"] is not None else ""


def _by_time(r: dict) -> tuple:
    return (r["created_at"], r["id"])


def _check_metric_fields(conn, m: dict) -> list[str]:
    """Everything wrong with a metric's own fields (create and edit share it)."""
    bad: list[str] = []
    if m["role"] not in ROLES:
        bad.append(f"role: one of {list(ROLES)}")
    if m["cadence"] not in CADENCES:
        bad.append(f"cadence: one of {list(CADENCES)}")
    if m["kill_op"] is not None and m["kill_op"] not in KILL_OPS:
        bad.append(f"kill_op: one of {list(KILL_OPS)}")
    if (m["kill_op"] is None) != (m["kill_value"] is None):
        bad.append("kill_op and kill_value go together — the line a number is compared against")
    if m["kill_op"] is not None and not (m["kill_rule"] or "").strip():
        bad.append("kill_rule: say the kill condition in words too — the number alone does not "
                   "carry its conditions")
    url = (m["source_url"] or "").strip()
    if url and not url.lower().startswith(("http://", "https://")):
        bad.append("source_url: a link that opens (http…) — put a tool or a place in the document "
                   "in source_tool / source_locator")
    if m["series_id"]:
        try:
            known = conn.execute("SELECT 1 FROM series_meta WHERE id = ?", (m["series_id"],)).fetchone()
        except sqlite3.OperationalError:
            known = None
        if not known:
            bad.append(f"series_id: no indicator series '{m['series_id']}' — see GET /api/v2/series")
    return bad


# ── Derived state ────────────────────────────────────────────────────────────

def _effective(e: dict, dates: dict[str, dict]) -> tuple[str, Optional[dict]]:
    """The day a forecast's number comes out, and the calendar row behind it.
    The calendar wins while its row is alive, so a moved earnings date moves here."""
    d = dates.get(e["date_id"]) if e["date_id"] else None
    return ((d["date"] if d else e["due_date"]) or "")[:10], d


def _periods(exps: list[dict], reads: list[dict]) -> dict[str, dict]:
    """One entry per period: the forecast that stands (the newest row for it) with
    its earlier revisions, and the number that stands with its earlier corrections."""
    out: dict[str, dict] = {}

    def slot(period: str) -> dict:
        return out.setdefault(_norm(period), {"period": period, "expectation": None,
                                              "revisions": [], "reading": None, "corrections": []})

    for e in sorted(exps, key=_by_time):
        s = slot(e["period"])
        if s["expectation"] is not None:
            s["revisions"].append(s["expectation"])
        s["expectation"] = e
    for r in sorted(reads, key=_by_time):
        s = slot(r["period"])
        if s["reading"] is not None:
            s["corrections"].append(s["reading"])
        s["reading"] = r
    return out


def _question_brief(book: dict, question_id: Optional[str]) -> Optional[dict]:
    q = book["by_id"].get(question_id) if question_id else None
    if q is None:
        return None
    return {"id": q["id"], "ref": q["ref"], "title": q["title"],
            "status": book["states"][q["id"]]["status"]}


def _derive(m: dict, periods: dict[str, dict], dates: dict[str, dict], book: dict,
            today: str) -> dict:
    """Where one metric stands, from rows that are only ever added.

    KILL    — the number that stands for the latest period crossed the kill line.
    DUE     — a forecast's date has come and its number has not been recorded.
    OFF     — a number came out not in line (or past the kill line) and the
              question that asks why is still open.
    SETUP   — something is missing before this can be tracked: where to read it,
              a forecast for the next period, or (for a killer) the kill rule.
    WAITING — a forecast is set and its date has not come.
    """
    open_: list[tuple[str, dict, Optional[dict]]] = []
    # Every forecast that hangs on a calendar row, read or not — what the question
    # calendar shows under that date.
    waits: list[dict] = []
    for p in periods.values():
        e, r = p["expectation"], p["reading"]
        if e is None:
            continue
        when, d = _effective(e, dates)
        if r is None:
            open_.append((when, e, d))
        if d is not None:
            waits.append({"date_id": d["id"], "period": e["period"], "expected": e["expected"],
                          "low": e["low"], "high": e["high"],
                          "reading": r and {"value_text": r["value_text"], "verdict": r["verdict"],
                                            "kill": bool(r["kill"])}})
    open_.sort(key=lambda x: (x[0] or "9999", x[1]["created_at"]))

    nxt = None
    if open_:
        when, e, d = open_[0]
        days = (date.fromisoformat(when) - date.fromisoformat(today)).days if when else None
        nxt = {"expectation_id": e["id"], "period": e["period"], "expected": e["expected"],
               "low": e["low"], "high": e["high"], "date": when or None,
               "date_id": d["id"] if d else None, "date_ref": d["ref"] if d else None,
               "date_title": d["title"] if d else None, "date_status": d["status"] if d else None,
               "release_time": e["release_time"], "days_until": days,
               "due": days is not None and days <= 0}
    due = any(when and when <= today for when, _, _ in open_)

    standing = [p["reading"] for p in periods.values() if p["reading"] is not None]
    last = None
    unexplained = 0
    if standing:
        for r in standing:
            if r["verdict"] in NOT_IN_LINE or r["kill"]:
                q = _question_brief(book, r["question_id"])
                # A why-question the user deleted or dropped counts as let go.
                if q is not None and q["status"] not in ("CLEAR", "DROPPED"):
                    unexplained += 1
        r = max(standing, key=lambda r: (r["as_of"] or "", r["created_at"], r["id"]))
        q = _question_brief(book, r["question_id"])
        last = {"reading_id": r["id"], "period": r["period"], "as_of": r["as_of"],
                "value": r["value"], "value_text": r["value_text"], "verdict": r["verdict"],
                "kill": bool(r["kill"]), "question": q,
                "explained": q is None or q["status"] in ("CLEAR", "DROPPED")}

    gaps: list[str] = []
    if not m["retired_at"]:
        if not (m["source_name"].strip() and (m["source_url"].strip() or m["source_locator"].strip()
                                             or m["source_tool"].strip())):
            gaps.append("source")
        if m["role"] == "KILLER" and not m["kill_rule"].strip():
            gaps.append("kill_rule")
        if nxt is None:
            gaps.append("expectation")

    if m["retired_at"]:
        status = "RETIRED"
    elif last and last["kill"]:
        status = "KILL"
    elif due:
        status = "DUE"
    elif unexplained:
        status = "OFF"
    elif gaps:
        status = "SETUP"
    else:
        status = "WAITING"
    return {"status": status, "gaps": gaps, "next": nxt, "due": due and not m["retired_at"],
            "last": last, "unexplained": unexplained, "waits": waits}


def _load(conn, where: str = "", params: tuple = ()) -> list[dict]:
    """Metrics matching `where`, each with its periods and derived state attached
    under `_periods` / `state` (the caller strips `_periods` before replying)."""
    ms = [dict(r) for r in conn.execute(
        f"SELECT * FROM track_metrics WHERE deleted_at IS NULL {where} ORDER BY created_at, ref",
        params).fetchall()]
    ids = [m["id"] for m in ms]
    exps = _in(conn, "SELECT * FROM track_expectations WHERE metric_id IN ({marks})", ids)
    reads = _in(conn, "SELECT * FROM track_readings WHERE metric_id IN ({marks})", ids)
    dates = {d["id"]: d for d in _in(
        conn, "SELECT id, ref, title, date, status, source, source_url, kind FROM question_dates "
              "WHERE deleted_at IS NULL AND id IN ({marks})",
        sorted({e["date_id"] for e in exps if e["date_id"]}))}
    book = questions._book(conn)
    today = date.today().isoformat()
    for m in ms:
        m["_periods"] = _periods([e for e in exps if e["metric_id"] == m["id"]],
                                 [r for r in reads if r["metric_id"] == m["id"]])
        m["_dates"] = dates
        m["state"] = _derive(m, m["_periods"], dates, book, today)
    return ms


def _row(m: dict) -> dict:
    return {k: v for k, v in m.items() if not k.startswith("_")}


def _urgency(m: dict) -> tuple:
    s = m["state"]
    return (STATUSES.index(s["status"]), (s["next"] or {}).get("date") or "9999", m["created_at"])


def _count(ms: list[dict]) -> dict:
    out = {s.lower(): 0 for s in STATUSES}
    for m in ms:
        out[m["state"]["status"].lower()] += 1
    out["alert"] = out["kill"] + out["due"] + out["off"]
    return out


def _series(conn, series_id: Optional[str]) -> Optional[dict]:
    """The latest published points of the indicator series a metric is bound to —
    shown beside it, never recorded as a reading by itself."""
    if not series_id:
        return None
    try:
        meta = conn.execute("SELECT id, label, unit, source, source_url FROM series_meta WHERE id = ?",
                            (series_id,)).fetchone()
        if meta is None:
            return None
        points = [dict(r) for r in conn.execute(
            "SELECT date, value FROM series_points WHERE series_id = ? AND value IS NOT NULL "
            "ORDER BY date DESC LIMIT 2", (series_id,))]
    except sqlite3.OperationalError:
        return None
    return {**dict(meta), "points": points}


def _full(conn, metric_id: str) -> dict:
    m = _load(conn, " AND id = ?", (metric_id,))[0]
    book = questions._book(conn)
    dates = m["_dates"]
    cited = _zettel_briefs(conn, [
        *(r["zettel_id"] for p in m["_periods"].values()
          for r in (p["reading"], *p["corrections"]) if r),
        *(i for p in m["_periods"].values() for e in (p["expectation"], *p["revisions"]) if e
          for i in json.loads(e["evidence"] or "[]")),
    ])

    def exp_out(e: Optional[dict]) -> Optional[dict]:
        if e is None:
            return None
        when, d = _effective(e, dates)
        return {**e, "evidence": [cited[i] for i in json.loads(e["evidence"] or "[]") if i in cited],
                "date": when or None, "calendar": d,
                # Written after the day the number came out — a forecast in hindsight.
                "late": bool(when) and e["created_at"][:10] > when}

    def read_out(r: Optional[dict]) -> Optional[dict]:
        if r is None:
            return None
        return {**r, "kill": bool(r["kill"]), "zettel": cited.get(r["zettel_id"]),
                "question": _question_brief(book, r["question_id"])}

    rows = []
    for p in m["_periods"].values():
        e, r = exp_out(p["expectation"]), read_out(p["reading"])
        rows.append({"period": p["period"], "expectation": e, "reading": r,
                     "revisions": [exp_out(x) for x in reversed(p["revisions"])],
                     "corrections": [read_out(x) for x in reversed(p["corrections"])],
                     "_at": (e or {}).get("date") or (r or {}).get("as_of") or ""})
    rows.sort(key=lambda x: x["_at"], reverse=True)
    for x in rows:
        del x["_at"]
    return {"metric": _row(m), "state": m["state"], "periods": rows,
            "question": _question_brief(book, m["question_id"]),
            "series": _series(conn, m["series_id"])}


# ── Read ─────────────────────────────────────────────────────────────────────

@router.get("")
def list_metrics(
    thesis_id: Optional[str] = Query(None),
    symbol: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
):
    """Tracked metrics with their derived state, most urgent first."""
    where, params = "", []
    if thesis_id:
        where += " AND thesis_id = ?"
        params.append(thesis_id)
    if symbol:
        where += " AND UPPER(symbol) = ?"
        params.append(symbol.upper())
    with get_db() as conn:
        ms = _load(conn, where, tuple(params))
    if status:
        ms = [m for m in ms if m["state"]["status"] == status.upper()]
    ms.sort(key=_urgency)
    return {"metrics": [_row(m) for m in ms], "counts": _count(ms)}


@router.get("/counts")
def counts():
    """The badge numbers, whole book and per thesis. `alert` = kill + due + off:
    the metrics that need someone now."""
    with get_db() as conn:
        ms = _load(conn)
    by_thesis: dict[str, list[dict]] = {}
    for m in ms:
        by_thesis.setdefault(m["thesis_id"] or "", []).append(m)
    return {**_count(ms), "by_thesis": {k: _count(v) for k, v in by_thesis.items()}}


@router.get("/due")
def due(days: int = Query(14, ge=0, le=365), thesis_id: Optional[str] = Query(None)):
    """What to read now and soon: metrics whose date has come, misses still
    waiting for an explanation, crossed kill lines, and forecasts due within
    `days`. Every row carries where its number is read."""
    with get_db() as conn:
        ms = _load(conn, " AND thesis_id = ?" if thesis_id else "",
                   (thesis_id,) if thesis_id else ())
    picked = []
    for m in ms:
        s = m["state"]
        soon = s["next"] and s["next"]["days_until"] is not None and s["next"]["days_until"] <= days
        if s["status"] in ("KILL", "DUE", "OFF") or (s["status"] != "RETIRED" and soon):
            picked.append(m)
    picked.sort(key=_urgency)
    return {"metrics": [_row(m) for m in picked], "counts": _count(ms)}


@router.get("/{metric_id}")
def get_metric(metric_id: str):
    with get_db() as conn:
        return _full(conn, _get_metric(conn, metric_id)["id"])


# ── Metrics: create / edit ───────────────────────────────────────────────────

@router.post("")
def create_metric(body: MetricIn):
    title = body.title.strip()
    if not title:
        raise HTTPException(422, "a tracked metric needs a title — the number being watched")
    if not body.thesis_id:
        raise HTTPException(422, "thesis_id: the thesis this number can confirm or kill")
    data = {
        "role": (body.role or "WATCH").upper(), "cadence": (body.cadence or "QUARTERLY").upper(),
        "kill_rule": body.kill_rule.strip(), "kill_op": (body.kill_op or "").strip() or None,
        "kill_value": body.kill_value, "source_url": body.source_url.strip(),
        "series_id": (body.series_id or "").strip() or None,
    }
    mid = _uid()
    now = _now_sync()
    with get_db() as conn:
        t = conn.execute("SELECT symbol FROM theses WHERE id = ?", (body.thesis_id,)).fetchone()
        if t is None:
            raise HTTPException(404, f"thesis {body.thesis_id} not found")
        bad = _check_metric_fields(conn, data)
        if bad:
            raise HTTPException(422, {"code": "METRIC_REFUSED", "missing": bad})
        dup = next((r for r in conn.execute(
            "SELECT ref, title FROM track_metrics WHERE deleted_at IS NULL AND thesis_id = ?",
            (body.thesis_id,)) if _norm(r["title"]) == _norm(title)), None)
        if dup:
            raise HTTPException(409, f"already tracked on this thesis: {dup['ref']} — add the next "
                                     "forecast to it instead of tracking it twice")
        question_id = questions._get(conn, body.question)["id"] if body.question else None
        ref = _next_ref(conn)
        conn.execute(
            """INSERT INTO track_metrics (id, ref, thesis_id, symbol, title, role, unit, definition,
                                          why, kill_rule, kill_op, kill_value, cadence, source_name,
                                          source_url, source_locator, source_tool, series_id,
                                          question_id, actor, device_id, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (mid, ref, body.thesis_id, t["symbol"], title, data["role"], body.unit.strip(),
             body.definition.strip(), body.why.strip(), data["kill_rule"], data["kill_op"],
             data["kill_value"], data["cadence"], body.source_name.strip(), data["source_url"],
             body.source_locator.strip(), body.source_tool.strip(), data["series_id"], question_id,
             current_actor(), device_id(), now, now),
        )
        _log_event(conn, body.thesis_id, "METRIC_ADDED",
                   {"metric_id": mid, "ref": ref, "role": data["role"]}, title)
        if body.expectation is not None:
            _expect(conn, _get_metric(conn, mid), body.expectation)
        return _full(conn, mid)


@router.patch("/{metric_id}")
def patch_metric(metric_id: str, body: MetricPatch):
    """Fill in or correct a metric. Moving a kill line that was already set, or
    changing the role, is the user's call and needs a reason — a line that can be
    moved quietly is not a line."""
    updates = body.model_dump(exclude_unset=True)
    reason = (updates.pop("reason", "") or "").strip()
    with get_db() as conn:
        m = _get_metric(conn, metric_id)
        if "question" in updates:
            q = updates.pop("question")
            updates["question_id"] = questions._get(conn, q)["id"] if q else None
        for k in ("role", "cadence"):
            if updates.get(k):
                updates[k] = updates[k].upper()
        for k, v in list(updates.items()):
            if isinstance(v, str):
                updates[k] = v.strip()
            if k in ("kill_op", "series_id") and not updates[k]:
                updates[k] = None
        updates = {k: v for k, v in updates.items() if k in EDITABLE}
        if "title" in updates and not updates["title"]:
            raise HTTPException(422, "title cannot be empty")
        diff = {k: v for k, v in updates.items() if m.get(k) != v}
        if not diff:
            raise HTTPException(400, "nothing to update")
        bad = _check_metric_fields(conn, {**m, **diff})
        moved = {k for k in diff if k in RULE_FIELDS and (k == "role" or m[k] not in (None, ""))}
        if moved:
            _user_only("move a kill line or change a metric's role")
            if not reason:
                bad.append("reason: why the kill line or the role changed — it goes on the "
                           "thesis timeline")
        if bad:
            raise HTTPException(422, {"code": "METRIC_REFUSED", "missing": bad})
        sets = ", ".join(f"{k} = ?" for k in diff)
        conn.execute(f"UPDATE track_metrics SET {sets}, updated_at = ? WHERE id = ?",
                     [*diff.values(), _now_sync(), m["id"]])
        if moved and m["thesis_id"]:
            _log_event(conn, m["thesis_id"], "METRIC_RULE_CHANGED",
                       {"metric_id": m["id"], "ref": m["ref"],
                        "changes": {k: {"from": m[k], "to": diff[k]} for k in sorted(moved)}},
                       f"{m['title']}: {reason}")
        return _full(conn, m["id"])


# ── Forecasts ────────────────────────────────────────────────────────────────

def _expect(conn, m: dict, body: ExpectationIn) -> str:
    """Check and insert one forecast on an open connection; returns its id."""
    if m["retired_at"]:
        raise HTTPException(400, f"{m['ref']} was retired — reopen it first")
    period = body.period.strip()
    bad: list[str] = []
    if not period:
        bad.append("period: which period the forecast is for (e.g. 'FQ1 FY27', '2026-10')")
    if not body.expected.strip():
        bad.append("expected: what you expect the number to be, in words")
    if not body.basis.strip():
        bad.append("basis: why you expect it — guidance, a model, a trend. A forecast with no "
                   "reason teaches nothing when it misses")
    if body.low is not None and body.high is not None and body.low > body.high:
        bad.append("low / high: low is above high")
    ways = [bool(body.date), body.new_date is not None, bool(body.due_date)]
    if sum(ways) == 0:
        bad.append("date: when the number comes out — `date` (a D-ref already on the calendar), "
                   "`new_date` (put the event on the calendar, with where the date came from), or "
                   "`due_date` (a day to look, when no event stands behind it)")
    elif sum(ways) > 1:
        bad.append("date: give one of date / new_date / due_date")
    if body.due_date and not _is_date(body.due_date):
        bad.append("due_date: YYYY-MM-DD")
    evidence: list[str] = []
    for ref in body.evidence:
        z = _zettel_brief(conn, ref)
        if z is None:
            bad.append(f"evidence {ref}: zettel not found")
        else:
            evidence.append(z["id"])
    if bad:
        raise HTTPException(422, {"code": "EXPECTATION_REFUSED", "missing": bad})

    read = next((r for r in conn.execute(
        "SELECT period, value_text FROM track_readings WHERE metric_id = ?", (m["id"],))
        if _norm(r["period"]) == _norm(period)), None)
    if read:
        raise HTTPException(
            409, f"{m['ref']} {period} already has its number ({read['value_text']}) — a forecast "
                 "is not set after the result. Set the next period instead")

    d = None
    if body.date:
        d = questions._get_date(conn, body.date)
    elif body.new_date is not None:
        if not body.new_date.symbol:
            body.new_date.symbol = m["symbol"]
        d = questions._insert_date(conn, body.new_date)
    eid = _uid()
    now = _now_sync()
    conn.execute(
        """INSERT INTO track_expectations (id, metric_id, period, expected, low, high, basis,
                                           evidence, date_id, due_date, release_time, actor,
                                           device_id, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (eid, m["id"], period, body.expected.strip(), body.low, body.high, body.basis.strip(),
         json.dumps(evidence), d["id"] if d else None,
         (d["date"] if d else body.due_date)[:10], body.release_time.strip(), current_actor(),
         device_id(), now, now),
    )
    if m["thesis_id"]:
        _log_event(conn, m["thesis_id"], "METRIC_EXPECTED",
                   {"metric_id": m["id"], "ref": m["ref"], "period": period},
                   f"{m['title']} {period}: {body.expected.strip()}")
    return eid


@router.post("/{metric_id}/expectations")
def add_expectation(metric_id: str, body: ExpectationIn):
    """Set the forecast for a period — or revise it, which adds a row and keeps
    the old one. Refused once the period has its number."""
    with get_db() as conn:
        m = _get_metric(conn, metric_id)
        _expect(conn, m, body)
        return _full(conn, m["id"])


# ── Readings ─────────────────────────────────────────────────────────────────

def _why_title(m: dict, period: str, value_text: str, e: Optional[dict], verdict: str) -> str:
    if verdict in NOT_IN_LINE and e is not None:
        return f"ทำไม {m['title']} งวด {period} ออกมา {value_text} ไม่ตรงกับที่คาด ({e['expected']})"
    return f"ทำไม {m['title']} งวด {period} ออกมา {value_text} จนแตะเส้น killer ({m['kill_rule']})"


def _open_why(conn, m: dict, e: Optional[dict], period: str, body: ReadingIn, value_text: str,
              verdict: str, kill: bool) -> str:
    """The question a miss leaves behind. It is an ordinary question: it enters
    the agent queue unanswered and closes by the rules of routers/questions.py."""
    title = _why_title(m, period, value_text, e, verdict)
    same = next((r for r in conn.execute(
        "SELECT id, title FROM questions WHERE deleted_at IS NULL AND COALESCE(thesis_id, '') = ?",
        (m["thesis_id"] or "",)) if _norm(r["title"]) == _norm(title)), None)
    if same:
        return same["id"]
    thought = [f"{m['ref']} {m['title']}"]
    if e is not None:
        thought.append(f"คาดไว้: {e['expected']} — เพราะ {e['basis']}")
    thought.append(f"ค่าจริง: {value_text} ณ {body.as_of}")
    if kill:
        thought.append(f"แตะเส้น killer: {m['kill_rule']}")
    if body.note.strip():
        thought.append(body.note.strip())
    parent = questions._book(conn)["by_id"].get(m["question_id"]) if m["question_id"] else None
    q = questions._create(conn, QuestionIn(
        title=title, thought=" · ".join(thought), thesis_id=m["thesis_id"],
        parents=[ParentIn(parent=parent["id"])] if parent and not parent["dropped_at"] else [],
    ))
    return q["id"]


@router.post("/{metric_id}/readings")
def add_reading(metric_id: str, body: ReadingIn):
    """Record what the number came out as. The reply's `opened_question` is the
    question a miss opened (or the one already open for this period)."""
    with get_db() as conn:
        m = _get_metric(conn, metric_id)
        loaded = _load(conn, " AND id = ?", (m["id"],))[0]
        periods = loaded["_periods"]

        # Which forecast this answers: the one named, the period named, or the
        # open one that comes due first.
        e: Optional[dict] = None
        if body.expectation_id:
            e = next((p["expectation"] for p in periods.values()
                      if p["expectation"] and p["expectation"]["id"] == body.expectation_id), None)
            if e is None:
                raise HTTPException(404, "that forecast is not the standing one for any period "
                                         f"of {m['ref']}")
        elif body.period.strip():
            e = (periods.get(_norm(body.period)) or {}).get("expectation")
        elif loaded["state"]["next"]:
            eid = loaded["state"]["next"]["expectation_id"]
            e = next(p["expectation"] for p in periods.values()
                     if p["expectation"] and p["expectation"]["id"] == eid)
        period = e["period"] if e else body.period.strip()

        bad: list[str] = []
        if not period:
            bad.append("period: which period the number is for — there is no open forecast to "
                       "take it from (to correct a number already recorded, name its period)")
        unit = f" {m['unit']}" if m["unit"] else ""
        value_text = body.value_text.strip() or (
            f"{_num(body.value)}{unit}" if body.value is not None else "")
        if not value_text:
            bad.append("value: the number as published — or value_text when it is not a number")
        if not _is_date(body.as_of):
            bad.append("as_of: the date the number refers to or was published (YYYY-MM-DD)")

        z = None
        if body.zettel:
            z = _zettel_brief(conn, body.zettel)
            problem = _evidence_problem(z, "zettel")
            if problem:
                bad.append(problem)
        elif not (body.source_url.strip() and body.quote.strip()):
            bad.append("evidence: a zettel (Z-ref carrying url + quote), or source_url + quote — "
                       "the sentence or table line the number was read from")

        given = (body.verdict or "").upper() or None
        if e is None:
            verdict = "UNSCORED"
        elif body.value is not None and (e["low"] is not None or e["high"] is not None):
            verdict = ("BELOW" if e["low"] is not None and body.value < e["low"]
                       else "ABOVE" if e["high"] is not None and body.value > e["high"]
                       else "IN_LINE")
            if given and given != verdict and not (given == "OFF" and verdict != "IN_LINE"):
                bad.append(f"verdict: the forecast was {_band(e['low'], e['high'])} and the number "
                           f"is {_num(body.value)} — that is {verdict}, not {given}")
        elif given in ("IN_LINE", *NOT_IN_LINE):
            verdict = given
        else:
            verdict = ""
            bad.append("verdict: IN_LINE or OFF — this forecast has no numeric band (or the "
                       f"reading is not a number), so say whether \"{e['expected']}\" held")

        if m["kill_op"] and m["kill_value"] is not None and body.value is not None:
            kill = bool(KILL_OPS[m["kill_op"]](body.value, m["kill_value"]))
            if body.kill is not None and body.kill != kill:
                bad.append(f"kill: the line is {_kill_line(m)} and the number is "
                           f"{_num(body.value)} — that is {'past' if kill else 'not past'} it")
        else:
            kill = bool(body.kill)
            if kill and not m["kill_rule"].strip():
                bad.append("kill: this metric has no kill rule to cross — set one first")
        if bad:
            raise HTTPException(422, {"code": "READING_REFUSED", "missing": bad})

        question_id = None
        if (verdict in NOT_IN_LINE or kill) and m["thesis_id"]:
            before = (periods.get(_norm(period)) or {}).get("reading")
            alive = questions._book(conn)["by_id"]
            question_id = (before["question_id"]
                           if before and before["question_id"] in alive
                           else _open_why(conn, m, e, period, body, value_text, verdict, kill))

        now = _now_sync()
        conn.execute(
            """INSERT INTO track_readings (id, metric_id, expectation_id, period, as_of, value,
                                           value_text, verdict, kill, note, zettel_id, source_url,
                                           quote, question_id, actor, device_id, created_at,
                                           updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (_uid(), m["id"], e["id"] if e else None, period, body.as_of[:10], body.value,
             value_text, verdict, 1 if kill else 0, body.note.strip(), z["id"] if z else None,
             body.source_url.strip(), body.quote.strip(), question_id, current_actor(),
             device_id(), now, now),
        )
        if m["thesis_id"]:
            _log_event(conn, m["thesis_id"], "KILLER_HIT" if kill else "METRIC_READ",
                       {"metric_id": m["id"], "ref": m["ref"], "period": period,
                        "verdict": verdict, "kill": kill, "question_id": question_id},
                       f"{m['title']} {period}: "
                       f"{'คาด ' + e['expected'] + ' → ' if e else ''}จริง {value_text}")
        out = _full(conn, m["id"])
        out["opened_question"] = _question_brief(questions._book(conn), question_id)
        return out


# ── Retire / reopen / delete ─────────────────────────────────────────────────

@router.post("/{metric_id}/retire")
def retire(metric_id: str, body: RetireIn):
    _user_only("stop tracking a metric")
    if not body.reason.strip():
        raise HTTPException(422, "a reason is required — why this number no longer matters "
                                 "to the thesis")
    with get_db() as conn:
        m = _get_metric(conn, metric_id)
        conn.execute("UPDATE track_metrics SET retired_at = ?, retire_reason = ?, updated_at = ? "
                     "WHERE id = ?", (_now_sync(), body.reason.strip(), _now_sync(), m["id"]))
        if m["thesis_id"]:
            _log_event(conn, m["thesis_id"], "METRIC_RETIRED",
                       {"metric_id": m["id"], "ref": m["ref"], "role": m["role"]},
                       f"{m['title']}: {body.reason.strip()}")
        return _full(conn, m["id"])


@router.post("/{metric_id}/reopen")
def reopen(metric_id: str):
    _user_only("track a retired metric again")
    with get_db() as conn:
        m = _get_metric(conn, metric_id)
        conn.execute("UPDATE track_metrics SET retired_at = NULL, retire_reason = '', "
                     "updated_at = ? WHERE id = ?", (_now_sync(), m["id"]))
        return _full(conn, m["id"])


@router.delete("/{metric_id}")
def delete_metric(metric_id: str):
    """Soft, and only for a metric entered by mistake. One that was tracked and
    stopped mattering is retired with a reason, so its record stays."""
    _user_only("delete a tracked metric")
    with get_db() as conn:
        m = _get_metric(conn, metric_id)
        conn.execute("UPDATE track_metrics SET deleted_at = ?, updated_at = ? WHERE id = ?",
                     (_now_sync(), _now_sync(), m["id"]))
    return {"ok": True}


@router.post("/resolve-ref-collisions")
def resolve_ref_collisions():
    """Re-mint K-refs two devices minted independently — see zettel's twin."""
    renamed: list[dict[str, Any]] = []
    with get_db() as conn:
        for (ref,) in conn.execute(
            "SELECT ref FROM track_metrics WHERE ref IS NOT NULL GROUP BY ref HAVING COUNT(*) > 1"
        ).fetchall():
            rows = conn.execute("SELECT id FROM track_metrics WHERE ref = ? ORDER BY created_at",
                                (ref,)).fetchall()
            for row in rows[1:]:
                new_ref = _next_ref(conn)
                conn.execute("UPDATE track_metrics SET ref = ?, updated_at = ? WHERE id = ?",
                             (new_ref, _now_sync(), row["id"]))
                renamed.append({"id": row["id"], "from": ref, "to": new_ref})
    return {"renamed": renamed, "count": len(renamed)}
