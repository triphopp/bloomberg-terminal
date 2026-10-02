"""
Thesis questions — the things a thesis does not know yet, tracked until they close.

Schema + rationale: db.init_questions_schema(); plan in
memory/plans/thesis-questions.md; research protocol in
memory/reference/question-research.md.

Four rules the endpoints exist to enforce:

  1. Capturing a question is cheap; placing it is tracked. Only the question
     itself is required — a half-formed doubt written down beats a well-formed
     one forgotten. What is still missing to place it in the tree (a parent, how
     each answer would move that parent, the thought behind it) comes back as
     `gaps` on every row, so an unplaced question is visible as unplaced instead
     of being refused. The one thing still refused is `if_a` == `if_b`: that is
     a statement that the answer changes nothing.
  2. No answer without evidence. An answer is CONFIRMED, INFERRED, UNCLEAR or
     UNANSWERABLE, and each level has a shape the server checks (see
     `_check_answer`). Inference is allowed, but only with an assumption someone
     can go and test: a metric, where to read it, by when, and what result
     would prove it wrong. A refused answer comes back 422 with every missing
     piece listed, so the caller can fix it in one pass.
  3. The user closes questions, not the agent. An agent's answer is a proposal
     until the user accepts it; an agent can neither accept nor drop.
  4. Status is derived, never stored. It is computed on read from the answers,
     reviews and assumption checks — all rows that are only ever added — so two
     devices cannot hold different statuses for the same history.

Every write that touches a thesis also writes a `thesis_events` row.
"""
import json
import re
import threading
import uuid
from datetime import date, datetime, timedelta
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from actor import capture_actor, current_actor, is_agent
from db import get_db
from routers.theses import _log_event
from sync.config import device_id

router = APIRouter(prefix="/api/v2/questions", dependencies=[Depends(capture_actor)])

LEVELS = ("CONFIRMED", "INFERRED", "UNCLEAR", "UNANSWERABLE")
BASES = ("NUMBER", "CIRCUMSTANTIAL", "EVENT")
SIGNAL_RESULTS = ("FOUND", "NOT_FOUND", "NOT_SEARCHED", "CONTRARY")
# Independent, diagnostic signals a CIRCUMSTANTIAL confirmation needs. Two
# vendors saying the same thing are one origin, not two.
MIN_INDEPENDENT_SIGNALS = 2
# An agent that claimed a question and went quiet releases it after this long.
CLAIM_TTL = timedelta(hours=2)
EDITABLE = ("title", "thought", "priority", "next_check")


def _uid() -> str:
    return str(uuid.uuid4())


def _now_sync() -> str:
    """Same stamp format the sync triggers write — see routers/zettel._now_sync."""
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%f")[:-3]


def _norm(t: str) -> str:
    return re.sub(r"\s+", " ", (t or "").strip()).lower()


def _is_date(s: Optional[str]) -> bool:
    try:
        date.fromisoformat((s or "")[:10])
        return len(s or "") >= 10
    except ValueError:
        return False


def _next_ref(conn) -> str:
    row = conn.execute(
        "SELECT MAX(CAST(SUBSTR(ref, 3) AS INTEGER)) FROM questions "
        "WHERE ref LIKE 'Q-%' AND SUBSTR(ref, 3) GLOB '[0-9]*'"
    ).fetchone()
    return f"Q-{((row[0] or 0) + 1):04d}"


def _get(conn, question_id: str) -> dict:
    row = conn.execute(
        "SELECT * FROM questions WHERE (id = ? OR ref = ?) AND deleted_at IS NULL",
        (question_id, question_id),
    ).fetchone()
    if row is None:
        raise HTTPException(404, f"question {question_id} not found")
    return dict(row)


def _user_only(what: str) -> None:
    if is_agent():
        raise HTTPException(403, f"only the user can {what} — propose it in chat instead")


def _in(conn, sql: str, ids: list[str]) -> list[dict]:
    """`sql` with one `{marks}` placeholder, run in chunks under SQLite's
    bound-parameter limit."""
    out: list[dict] = []
    for i in range(0, len(ids), 500):
        part = ids[i:i + 500]
        out += [dict(r) for r in conn.execute(sql.format(marks=",".join("?" * len(part))), part)]
    return out


# ── Evidence ─────────────────────────────────────────────────────────────────

def _zettel_brief(conn, ref_or_id: Optional[str]) -> Optional[dict]:
    if not ref_or_id:
        return None
    z = conn.execute(
        "SELECT id, ref, kind, title, status FROM zettel "
        "WHERE (id = ? OR ref = ?) AND deleted_at IS NULL",
        (ref_or_id, ref_or_id),
    ).fetchone()
    if z is None:
        return None
    out = dict(z)
    out["sources"] = [
        dict(r)
        for r in conn.execute(
            "SELECT url, publisher, published_at, quote, reliability FROM zettel_sources "
            "WHERE zettel_id = ?",
            (out["id"],),
        ).fetchall()
    ]
    return out


def _zettel_briefs(conn, ids: list[str]) -> dict[str, dict]:
    """`_zettel_brief` for many ids in two queries instead of two per id — a
    question's detail page cites a zettel per signal, per evidence and per check."""
    ids = sorted({i for i in ids if i})
    out = {r["id"]: {**r, "sources": []} for r in _in(
        conn, "SELECT id, ref, kind, title, status FROM zettel "
              "WHERE deleted_at IS NULL AND id IN ({marks})", ids)}
    for r in _in(conn, "SELECT zettel_id, url, publisher, published_at, quote, reliability "
                       "FROM zettel_sources WHERE zettel_id IN ({marks})", list(out)):
        out[r.pop("zettel_id")]["sources"].append(r)
    return out


def _evidence_problem(z: Optional[dict], label: str, need_primary: bool = False) -> Optional[str]:
    """Why this zettel cannot stand as evidence, or None when it can.

    Evidence here means a reader can check it without us: a URL to open and the
    sentence being relied on. A zettel with neither is an opinion with a number.
    """
    if z is None:
        return f"{label}: zettel not found — zettel_create it first (kind=EVIDENCE, with a source)"
    usable = [s for s in z["sources"] if (s["url"] or "").strip() and (s["quote"] or "").strip()]
    if not usable:
        return f"{label}: {z['ref']} has no source carrying both a url and the quoted sentence"
    if need_primary and not any(s["reliability"] == "primary" for s in usable):
        return (f"{label}: {z['ref']} has no PRIMARY source (filing, company release, "
                "official statistic) with url + quote")
    return None


def _open_conflicts(conn, zettel_ids: list[str]) -> list[str]:
    if not zettel_ids:
        return []
    marks = ",".join("?" * len(zettel_ids))
    rows = conn.execute(
        f"""SELECT a.ref AS a, b.ref AS b FROM zettel_edges e
            JOIN zettel a ON a.id = e.src_id JOIN zettel b ON b.id = e.dst_id
            WHERE e.rel = 'CONTRADICTS' AND e.resolved_at IS NULL
              AND (e.src_id IN ({marks}) OR e.dst_id IN ({marks}))""",
        [*zettel_ids, *zettel_ids],
    ).fetchall()
    return [f"{r['a']} ⟂ {r['b']}" for r in rows]


# ── Models ───────────────────────────────────────────────────────────────────

class ParentIn(BaseModel):
    parent: str            # id or Q-ref
    if_a: str = ""
    if_b: str = ""


class QuestionIn(BaseModel):
    title: str
    thought: str = ""
    thesis_id: Optional[str] = None
    symbol: Optional[str] = None
    is_root: bool = False
    parents: list[ParentIn] = []
    priority: Optional[int] = None
    next_check: Optional[str] = None


class QuestionPatch(BaseModel):
    title: Optional[str] = None
    thought: Optional[str] = None
    priority: Optional[int] = None
    next_check: Optional[str] = None


class SignalIn(BaseModel):
    expectation: str
    result: str = "NOT_SEARCHED"
    finding: str = ""
    supports: str = ""
    diagnostic: bool = False
    origin: str = ""
    zettel: Optional[str] = None
    searched_where: str = ""


class AssumptionIn(BaseModel):
    statement: str = ""
    metric: str = ""
    source_hint: str = ""
    check_by: Optional[str] = None
    falsifier: str = ""


class AnswerIn(BaseModel):
    level: str
    basis: Optional[str] = None
    answer: str = ""
    value: Optional[str] = None
    unit: Optional[str] = None
    as_of: Optional[str] = None
    alternatives: list[str] = []
    searched: str = ""
    next_check: Optional[str] = None
    evidence: list[str] = []
    signals: list[SignalIn] = []
    assumptions: list[AssumptionIn] = []


class ImportItem(QuestionIn):
    key: str = ""                       # local handle other items' parents may name
    answer: Optional[AnswerIn] = None


class ImportIn(BaseModel):
    thesis_id: Optional[str] = None     # default for items that do not set their own
    questions: list[ImportItem] = []


class EdgePatch(BaseModel):
    if_a: Optional[str] = None
    if_b: Optional[str] = None


class DateIn(BaseModel):
    title: str
    date: str
    status: str = "ESTIMATED"
    source: str = ""
    source_url: str = ""
    symbol: Optional[str] = None
    kind: str = "OTHER"
    note: str = ""
    questions: list["DateLinkIn"] = []


class DateLinkIn(BaseModel):
    question: str            # id or Q-ref
    reads: str = ""          # what will be read from this event for that question


class DatePatch(BaseModel):
    title: Optional[str] = None
    date: Optional[str] = None
    status: Optional[str] = None
    source: Optional[str] = None
    source_url: Optional[str] = None
    note: Optional[str] = None
    reason: str = ""


DateIn.model_rebuild()


class ReviewIn(BaseModel):
    decision: str
    note: str = ""


class AssumptionCheckIn(BaseModel):
    result: str
    note: str = ""
    zettel: Optional[str] = None


class DropIn(BaseModel):
    reason: str = ""


# ── Derived state ────────────────────────────────────────────────────────────

def _latest(rows: list[dict]) -> dict[str, dict]:
    """target_id → its newest check."""
    out: dict[str, dict] = {}
    for r in sorted(rows, key=lambda r: (r["created_at"], r["id"])):
        out[r["target_id"]] = r
    return out


def _derive(q: dict, answers: list[dict], assumptions: list[dict], checks: list[dict],
            today: Optional[str] = None, event_dates: Optional[list[str]] = None) -> dict:
    """The status of one question, from rows that are only ever added.

    OPEN   — still owed work: nothing accepted, an agent's answer waiting for the
             user, an accepted "unclear", or an inference whose assumption broke.
    WATCH  — answered for now, but resting on something not yet tested (or
             judged unanswerable from public data, with a date to look again).
    CLEAR  — confirmed, or an inference whose every assumption was tested and held.
    """
    today = today or date.today().isoformat()
    latest = _latest(checks)
    ordered = sorted(answers, key=lambda a: (a["created_at"], a["id"]), reverse=True)

    def accepted(a: dict) -> bool:
        review = latest.get(a["id"])
        if review is not None:
            return review["result"] == "ACCEPTED"
        return a["actor"] == "user"       # the user's own answer needs no second signature

    current = next((a for a in ordered if accepted(a)), None)
    proposed = next(
        (a for a in ordered
         if a["id"] not in latest and a["actor"] != "user"
         and (current is None or a["created_at"] > current["created_at"])),
        None,
    )

    held = broken = untested = 0
    due = False
    if current is not None and current["level"] == "INFERRED":
        for s in (x for x in assumptions if x["answer_id"] == current["id"]):
            chk = latest.get(s["id"])
            if chk is None:
                untested += 1
                due = due or bool(s["check_by"] and s["check_by"][:10] <= today)
            elif chk["result"] == "BROKEN":
                broken += 1
            else:
                held += 1

    if q.get("dropped_at"):
        status, reason = "DROPPED", "dropped"
    elif proposed is not None:
        status, reason = "OPEN", "awaiting_review"
    elif current is None:
        status, reason = "OPEN", "unanswered"
    elif current["level"] == "UNCLEAR":
        status, reason = "OPEN", "unclear"
    elif current["level"] == "CONFIRMED":
        status, reason = "CLEAR", "confirmed"
    elif current["level"] == "UNANSWERABLE":
        status, reason = "WATCH", "unanswerable"
    elif broken:
        status, reason = "OPEN", "assumption_broken"
    elif held and not untested:
        status, reason = "CLEAR", "assumptions_held"
    else:
        status, reason = "WATCH", "assumptions_untested"

    check_date = (current or {}).get("next_check") or q.get("next_check")
    if status in ("WATCH", "OPEN") and check_date and check_date[:10] <= today:
        due = True
    # A calendar date this question waits on has arrived and nothing was
    # recorded since: an answer or a check dated on/after it means someone looked.
    touched = max([r["created_at"][:10] for r in (*answers, *checks)], default="")
    if status in ("WATCH", "OPEN") and any(d <= today and touched < d for d in event_dates or []):
        due = True

    shown = proposed or current
    return {
        "status": status,
        "reason": reason,
        "level": shown["level"] if shown else None,
        "basis": shown["basis"] if shown else None,
        "answer": shown["answer"] if shown else "",
        "current_answer_id": current["id"] if current else None,
        "proposed_answer_id": proposed["id"] if proposed else None,
        "assumptions": {"held": held, "broken": broken, "untested": untested},
        "due": due,
    }


def _load(conn, where: str = "", params: tuple = ()) -> tuple[list[dict], dict[str, dict], list[dict]]:
    """Questions matching `where`, each one's derived state, and the edges among them."""
    qs = [
        dict(r)
        for r in conn.execute(
            f"SELECT * FROM questions WHERE deleted_at IS NULL {where} ORDER BY created_at", params
        ).fetchall()
    ]
    ids = [q["id"] for q in qs]
    by: dict[str, dict[str, list[dict]]] = {i: {"a": [], "s": [], "c": []} for i in ids}
    for key, table in (("a", "question_answers"), ("s", "question_assumptions"),
                       ("c", "question_checks")):
        for r in _in(conn, f"SELECT * FROM {table} WHERE question_id IN ({{marks}})", ids):
            by[r["question_id"]][key].append(r)
    today = date.today().isoformat()
    waits: dict[str, list[str]] = {}
    for r in _in(conn, "SELECT l.question_id, d.date FROM question_date_links l "
                       "JOIN question_dates d ON d.id = l.date_id "
                       "WHERE d.deleted_at IS NULL AND l.question_id IN ({marks})", ids):
        waits.setdefault(r["question_id"], []).append(r["date"][:10])
    states = {q["id"]: _derive(q, by[q["id"]]["a"], by[q["id"]]["s"], by[q["id"]]["c"], today,
                               waits.get(q["id"]))
              for q in qs}
    edges = _in(conn, "SELECT * FROM question_edges WHERE child_id IN ({marks})", ids)
    return qs, states, edges


def _blocked_counts(qs: list[dict], states: dict[str, dict], edges: list[dict]) -> dict[str, int]:
    """How many questions above this one are still waiting on it — the convergence
    points (one answer that moves several branches) rise to the top by themselves."""
    parents: dict[str, list[str]] = {}
    for e in edges:
        parents.setdefault(e["child_id"], []).append(e["parent_id"])
    # Each question's ancestor set is built once and reused by everything below
    # it, instead of walking to the root again from every question.
    memo: dict[str, frozenset[str]] = {}

    def ancestors(qid: str, trail: tuple = ()) -> frozenset[str]:
        if qid in memo:
            return memo[qid]
        acc: set[str] = set()
        for p in parents.get(qid, []):
            if p in trail:          # a loop cannot be created through the API; be safe anyway
                continue
            acc.add(p)
            acc |= ancestors(p, (*trail, qid))
        memo[qid] = frozenset(acc)
        return memo[qid]

    waiting = {i for i, st in states.items() if st["status"] in ("OPEN", "WATCH")}
    return {q["id"]: len(ancestors(q["id"]) & waiting) for q in qs}


def _by_child(edges: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for e in edges:
        out.setdefault(e["child_id"], []).append(e)
    return out


def _gaps(q: dict, mine: list[dict]) -> list[str]:
    """What this question still lacks to sit properly in the tree. Never a reason
    to refuse it — a reason to come back to it. `mine` = the edges where this
    question is the child."""
    gaps: list[str] = []
    if not q["is_root"] and not mine:
        gaps.append("parent")
    if any(not (e["if_a"] or "").strip() or not (e["if_b"] or "").strip() for e in mine):
        gaps.append("effect")
    if not (q["thought"] or "").strip():
        gaps.append("thought")
    return gaps


def _row(q: dict, state: dict, blocked: int = 0,
         by_child: Optional[dict[str, list[dict]]] = None) -> dict:
    return {**q, "is_root": bool(q["is_root"]), "state": state, "blocks": blocked,
            "gaps": _gaps(q, (by_child or {}).get(q["id"], []))}


# ── The whole book, loaded once per change ───────────────────────────────────
#
# The badge is polled every minute by every open PORT view, and the queue, the
# calendar and the import all need every question's status. Deriving that means
# reading five tables; doing it per request is the same work over and over while
# nothing moved. So the loaded book is kept, keyed on a signature that one cheap
# query computes: row count + the sum of updated_at (to the millisecond) of every
# table a status depends on, plus today's date because "due" turns on at midnight.
# The signature is checked on EVERY call, so a write from this process, another
# worker or a sync pull is seen at once; only the reload is skipped. Callers get
# shared objects — read them, never mutate them.

_BOOK_TABLES = ("questions", "question_edges", "question_answers", "question_assumptions",
                "question_checks", "question_dates", "question_date_links")
_BOOK_SQL = " UNION ALL ".join(
    f"SELECT COUNT(*), SUM(CAST((julianday(updated_at) - 2440587.5) * 86400000 AS INTEGER)) FROM {t}"
    for t in _BOOK_TABLES
)
_book_cache: dict[str, Any] = {"sig": None, "book": None}
_book_lock = threading.Lock()


def _book(conn) -> dict:
    sig = (str(conn.execute("PRAGMA database_list").fetchone()[2]), date.today().isoformat(),
           tuple(tuple(r) for r in conn.execute(_BOOK_SQL).fetchall()))
    with _book_lock:
        if _book_cache["sig"] == sig:
            return _book_cache["book"]
    qs, states, edges = _load(conn)
    book = {"qs": qs, "states": states, "edges": edges, "by_child": _by_child(edges),
            "by_id": {q["id"]: q for q in qs},
            "blocked": _blocked_counts(qs, states, edges),
            "counts": _count(list(states.values()))}
    with _book_lock:
        _book_cache.update(sig=sig, book=book)
    return book


def _count(states: list[dict]) -> dict:
    return {
        "pending": sum(1 for s in states if s["status"] == "OPEN"),
        "watch": sum(1 for s in states if s["status"] == "WATCH"),
        "clear": sum(1 for s in states if s["status"] == "CLEAR"),
        "dropped": sum(1 for s in states if s["status"] == "DROPPED"),
        "due": sum(1 for s in states if s["due"]),
    }


# ── Read ─────────────────────────────────────────────────────────────────────

@router.get("")
def list_questions(
    thesis_id: Optional[str] = Query(None),
    symbol: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
):
    where, params = "", []
    if thesis_id:
        where += " AND thesis_id = ?"
        params.append(thesis_id)
    if symbol:
        where += " AND UPPER(symbol) = ?"
        params.append(symbol.upper())
    with get_db() as conn:
        qs, states, edges = _load(conn, where, tuple(params))
    blocked = _blocked_counts(qs, states, edges)
    by_child = _by_child(edges)
    rows = [_row(q, states[q["id"]], blocked[q["id"]], by_child) for q in qs]
    if status:
        rows = [r for r in rows if r["state"]["status"] == status.upper()]
    return {"questions": rows, "counts": _count([r["state"] for r in rows])}


@router.get("/counts")
def counts():
    """The two badge numbers, whole book and per thesis. Cheap enough to poll."""
    with get_db() as conn:
        book = _book(conn)
    by_thesis: dict[str, list[dict]] = {}
    for q in book["qs"]:
        by_thesis.setdefault(q["thesis_id"] or "", []).append(book["states"][q["id"]])
    return {**book["counts"], "by_thesis": {k: _count(v) for k, v in by_thesis.items()}}


@router.get("/queue")
def queue(limit: int = Query(20), thesis_id: Optional[str] = Query(None)):
    """What an agent should look at next: unanswered or broken questions, and
    watched ones whose check date has come. Answers waiting for the user are not
    here — there is nothing more for an agent to do on those."""
    me = current_actor()
    cutoff = (datetime.utcnow() - CLAIM_TTL).strftime("%Y-%m-%d %H:%M:%S")
    with get_db() as conn:
        book = _book(conn)
        states, blocked = book["states"], book["blocked"]
        picked = []
        for q in book["qs"]:
            if thesis_id and q["thesis_id"] != thesis_id:
                continue
            s = states[q["id"]]
            wanted = (s["status"] == "OPEN" and s["reason"] != "awaiting_review") or \
                     (s["status"] == "WATCH" and s["due"])
            taken = q["claimed_by"] and q["claimed_by"] != me and (q["claimed_at"] or "") > cutoff
            if wanted and not taken:
                picked.append(q)
        picked.sort(key=lambda q: (-blocked[q["id"]], -(q["priority"] or 0),
                                   q["next_check"] or "9999", q["created_at"]))
        rows = [_row(q, states[q["id"]], blocked[q["id"]], book["by_child"])
                for q in picked[:limit]]
        parents = _parents_many(conn, [r["id"] for r in rows])
        for r in rows:
            r["parents"] = parents.get(r["id"], [])
    # The badge numbers are for the whole book even when the queue is scoped.
    return {"queue": rows, "counts": book["counts"]}


@router.get("/tree")
def tree(thesis_id: str = Query(...)):
    """One thesis's questions as nodes + child→parent edges, with the roll-up the
    index shows at the root: how many leaf questions are answered clearly."""
    with get_db() as conn:
        qs, states, edges = _load(conn, " AND thesis_id = ?", (thesis_id,))
        # A question from another thesis may be a child here (a convergence
        # point across theses) — pull those in so the tree is not missing a leaf.
        ids = {q["id"] for q in qs}
        extra = [e for e in _in(
            conn, "SELECT * FROM question_edges WHERE parent_id IN ({marks})", list(ids)
        ) if e["child_id"] not in ids]
        if extra:
            more_ids = sorted({e["child_id"] for e in extra})
            marks = ",".join("?" * len(more_ids))
            q2, s2, e2 = _load(conn, f" AND id IN ({marks})", tuple(more_ids))
            qs += q2
            states.update(s2)
            edges += [e for e in e2 if e not in edges]
    blocked = _blocked_counts(qs, states, edges)
    by_child = _by_child(edges)
    live = [q for q in qs if states[q["id"]]["status"] != "DROPPED"]
    has_child = {e["parent_id"] for e in edges}
    leaves = [q for q in live if q["id"] not in has_child]
    return {
        "nodes": [_row(q, states[q["id"]], blocked[q["id"]], by_child) for q in qs],
        "edges": edges,
        "counts": _count([states[q["id"]] for q in qs]),
        "leaves": {"total": len(leaves),
                   "clear": sum(1 for q in leaves if states[q["id"]]["status"] == "CLEAR")},
    }


def _parents(conn, question_id: str) -> list[dict]:
    return [
        dict(r)
        for r in conn.execute(
            """SELECT e.id AS edge_id, e.if_a, e.if_b, p.id, p.ref, p.title
               FROM question_edges e JOIN questions p ON p.id = e.parent_id
               WHERE e.child_id = ? ORDER BY e.created_at""",
            (question_id,),
        ).fetchall()
    ]


def _parents_many(conn, question_ids: list[str]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for r in _in(conn, """SELECT e.child_id, e.id AS edge_id, e.if_a, e.if_b, p.id, p.ref, p.title
                          FROM question_edges e JOIN questions p ON p.id = e.parent_id
                          WHERE e.child_id IN ({marks}) ORDER BY e.created_at""", question_ids):
        out.setdefault(r.pop("child_id"), []).append(r)
    return out


def _full(conn, q: dict) -> dict:
    qid = q["id"]
    answers = [dict(r) for r in conn.execute(
        "SELECT * FROM question_answers WHERE question_id = ? ORDER BY created_at DESC", (qid,))]
    assumptions = [dict(r) for r in conn.execute(
        "SELECT * FROM question_assumptions WHERE question_id = ? ORDER BY created_at", (qid,))]
    signals = [dict(r) for r in conn.execute(
        "SELECT * FROM question_signals WHERE question_id = ? ORDER BY created_at", (qid,))]
    checks = [dict(r) for r in conn.execute(
        "SELECT * FROM question_checks WHERE question_id = ? ORDER BY created_at", (qid,))]
    latest = _latest(checks)
    dates = [dict(r) for r in conn.execute(
        """SELECT d.id, d.ref, d.title, d.date, d.status, d.source, d.source_url, d.kind,
                  l.id AS link_id, l.reads
           FROM question_date_links l JOIN question_dates d ON d.id = l.date_id
           WHERE l.question_id = ? AND d.deleted_at IS NULL ORDER BY d.date""", (qid,))]
    state = _derive(q, answers, assumptions, checks, None, [d["date"][:10] for d in dates])

    for a in answers:
        a["alternatives"] = json.loads(a["alternatives"] or "[]")
        a["evidence"] = json.loads(a["evidence"] or "[]")
    cited = _zettel_briefs(conn, [
        *(i for a in answers for i in a["evidence"]),
        *(s["zettel_id"] for s in signals),
        *(c["zettel_id"] for c in checks),
    ])
    for a in answers:
        a["evidence"] = [cited[i] for i in a["evidence"] if i in cited]
        a["signals"] = [
            {**s, "diagnostic": bool(s["diagnostic"]), "zettel": cited.get(s["zettel_id"])}
            for s in signals if s["answer_id"] == a["id"]
        ]
        a["assumptions"] = [
            {**s, "check": latest.get(s["id"]),
             "check_zettel": cited.get((latest.get(s["id"]) or {}).get("zettel_id"))}
            for s in assumptions if s["answer_id"] == a["id"]
        ]
        a["review"] = latest.get(a["id"])

    children = [
        dict(r)
        for r in conn.execute(
            """SELECT c.id, c.ref, c.title, e.if_a, e.if_b
               FROM question_edges e JOIN questions c ON c.id = e.child_id
               WHERE e.parent_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at""",
            (qid,),
        ).fetchall()
    ]
    parents = _parents(conn, qid)
    return {
        "question": {**q, "is_root": bool(q["is_root"]), "gaps": _gaps(q, parents)},
        "state": state,
        "parents": parents,
        "children": children,
        "answers": answers,
        "dates": dates,
    }


# ── Calendar: the dates a question is waiting on ─────────────────────────────

DATE_STATUS = ("CONFIRMED", "ESTIMATED")
DATE_KINDS = ("EARNINGS", "FILING", "DATA_RELEASE", "EVENT", "OTHER")


def _next_date_ref(conn) -> str:
    row = conn.execute(
        "SELECT MAX(CAST(SUBSTR(ref, 3) AS INTEGER)) FROM question_dates "
        "WHERE ref LIKE 'D-%' AND SUBSTR(ref, 3) GLOB '[0-9]*'"
    ).fetchone()
    return f"D-{((row[0] or 0) + 1):04d}"


def _get_date(conn, date_id: str) -> dict:
    row = conn.execute(
        "SELECT * FROM question_dates WHERE (id = ? OR ref = ?) AND deleted_at IS NULL",
        (date_id, date_id)).fetchone()
    if row is None:
        raise HTTPException(404, f"calendar date {date_id} not found")
    return dict(row)


def _check_date_fields(date_: Optional[str], status: Optional[str], source: Optional[str],
                       source_url: Optional[str]) -> list[str]:
    """A date is a claim too. It always says where it came from, and CONFIRMED
    means the publisher itself announced it — so it needs the link."""
    bad = []
    if date_ is not None and not _is_date(date_):
        bad.append("date: YYYY-MM-DD")
    if status is not None and status.upper() not in DATE_STATUS:
        bad.append(f"status: one of {list(DATE_STATUS)}")
    if source is not None and not source.strip():
        bad.append("source: where this date came from (a calendar, an announcement, or "
                   "'estimated from <the pattern you used>')")
    if (status or "").upper() == "CONFIRMED" and not (source_url or "").strip():
        bad.append("source_url: a CONFIRMED date links to the announcement — otherwise it is ESTIMATED")
    return bad


def _link_date(conn, d: dict, link: DateLinkIn) -> None:
    q = _get(conn, link.question)
    if conn.execute("SELECT 1 FROM question_date_links WHERE date_id = ? AND question_id = ?",
                    (d["id"], q["id"])).fetchone():
        raise HTTPException(409, f"{q['ref']} already waits on {d['ref']}")
    now = _now_sync()
    conn.execute(
        """INSERT INTO question_date_links (id, date_id, question_id, reads, actor, device_id,
                                            created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)""",
        (_uid(), d["id"], q["id"], link.reads.strip(), current_actor(), device_id(), now, now))


def _calendar(conn, where: str = "", params: tuple = ()) -> list[dict]:
    rows = [dict(r) for r in conn.execute(
        f"SELECT * FROM question_dates WHERE deleted_at IS NULL {where} ORDER BY date, ref", params)]
    if not rows:
        return []
    links = _in(conn, "SELECT * FROM question_date_links WHERE date_id IN ({marks})",
                [r["id"] for r in rows])
    if where:
        # One date (the reply to an add / edit): only its own questions are
        # needed, so do not force a reload of the whole book right after a write.
        wanted = sorted({l["question_id"] for l in links})
        qs, states, _ = _load(conn, f" AND id IN ({','.join('?' * len(wanted))})",
                              tuple(wanted)) if wanted else ([], {}, [])
        by_id = {q["id"]: q for q in qs}
    else:
        book = _book(conn)
        by_id, states = book["by_id"], book["states"]
    changes = _in(conn, "SELECT * FROM question_date_changes WHERE date_id IN ({marks})",
                  [r["id"] for r in rows])
    today = date.today()
    for r in rows:
        r["days_until"] = (date.fromisoformat(r["date"][:10]) - today).days
        r["questions"] = [
            {"link_id": l["id"], "reads": l["reads"], "id": q["id"], "ref": q["ref"],
             "title": q["title"], "thesis_id": q["thesis_id"], "symbol": q["symbol"],
             "status": states[q["id"]]["status"], "due": states[q["id"]]["due"]}
            for l in links if l["date_id"] == r["id"] and (q := by_id.get(l["question_id"]))
        ]
        r["changes"] = sorted((c for c in changes if c["date_id"] == r["id"]),
                              key=lambda c: c["created_at"])
        # Arrived, and a question tied to it is still waiting to be looked at.
        r["due"] = r["days_until"] <= 0 and any(x["due"] for x in r["questions"])
    return rows


@router.get("/calendar")
def calendar(
    thesis_id: Optional[str] = Query(None),
    symbol: Optional[str] = Query(None),
    include_past: bool = Query(True),
):
    """Every dated thing a question is waiting on, soonest first, each with the
    questions it could answer. `status` says whether the date is confirmed or
    estimated and `source` where it came from."""
    with get_db() as conn:
        rows = _calendar(conn)
    if thesis_id:
        rows = [r for r in rows if any(q["thesis_id"] == thesis_id for q in r["questions"])]
    if symbol:
        rows = [r for r in rows if (r["symbol"] or "").upper() == symbol.upper()
                or any((q["symbol"] or "").upper() == symbol.upper() for q in r["questions"])]
    if not include_past:
        rows = [r for r in rows if r["days_until"] >= 0 or r["due"]]
    return {"dates": rows, "due": sum(1 for r in rows if r["due"]),
            "estimated": sum(1 for r in rows if r["status"] == "ESTIMATED")}


def _insert_date(conn, body: DateIn) -> dict:
    """Validate and insert one calendar date on an open connection; returns its row.
    Shared with routers/tracking.py, where a forecast and the date it waits on are
    written in one transaction."""
    if not body.title.strip():
        raise HTTPException(422, "title: what happens on that date (e.g. 'Intel Q3/26 10-Q')")
    bad = _check_date_fields(body.date, body.status, body.source, body.source_url)
    if body.kind.upper() not in DATE_KINDS:
        bad.append(f"kind: one of {list(DATE_KINDS)}")
    if bad:
        raise HTTPException(422, {"code": "DATE_REFUSED", "missing": bad})
    did = _uid()
    now = _now_sync()
    dup = next((r for r in conn.execute(
        "SELECT id, ref, title, date FROM question_dates WHERE deleted_at IS NULL")
        if _norm(r["title"]) == _norm(body.title)), None)
    if dup:
        raise HTTPException(
            409, f"already on the calendar: {dup['ref']} ({dup['date']}) — link the question "
                 "to it, or change its date, instead of adding it twice")
    conn.execute(
        """INSERT INTO question_dates (id, ref, title, date, status, source, source_url, symbol,
                                       kind, note, actor, device_id, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (did, _next_date_ref(conn), body.title.strip(), body.date[:10], body.status.upper(),
         body.source.strip(), body.source_url.strip(), (body.symbol or "").upper() or None,
         body.kind.upper(), body.note.strip(), current_actor(), device_id(), now, now))
    d = _get_date(conn, did)
    for link in body.questions:
        _link_date(conn, d, link)
    return d


@router.post("/calendar")
def add_date(body: DateIn):
    with get_db() as conn:
        d = _insert_date(conn, body)
        return {"date": _calendar(conn, " AND id = ?", (d["id"],))[0]}


@router.patch("/calendar/{date_id}")
def patch_date(date_id: str, body: DatePatch):
    """Move a date, or confirm one that was estimated. Either needs a reason, and
    the old value is kept in the revision trail."""
    updates = {k: v for k, v in body.model_dump(exclude_unset=True).items()
               if k in ("title", "date", "status", "source", "source_url", "note") and v is not None}
    if not updates:
        raise HTTPException(400, "nothing to update")
    with get_db() as conn:
        d = _get_date(conn, date_id)
        if "status" in updates:
            updates["status"] = updates["status"].upper()
        if "date" in updates:
            updates["date"] = updates["date"][:10]
        merged = {**d, **updates}
        bad = _check_date_fields(merged["date"], merged["status"], merged["source"],
                                 merged["source_url"])
        moved = merged["date"] != d["date"] or merged["status"] != d["status"]
        if moved and not body.reason.strip():
            bad.append("reason: why the date or its status changed")
        if bad:
            raise HTTPException(422, {"code": "DATE_REFUSED", "missing": bad})
        diff = {k: v for k, v in updates.items() if d.get(k) != v}
        if diff:
            sets = ", ".join(f"{k} = ?" for k in diff)
            conn.execute(f"UPDATE question_dates SET {sets}, updated_at = ? WHERE id = ?",
                         [*diff.values(), _now_sync(), d["id"]])
        if moved:
            now = _now_sync()
            conn.execute(
                """INSERT INTO question_date_changes (id, date_id, old_date, new_date, old_status,
                                                      new_status, reason, actor, device_id,
                                                      created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (_uid(), d["id"], d["date"], merged["date"], d["status"], merged["status"],
                 body.reason.strip(), current_actor(), device_id(), now, now))
        return {"date": _calendar(conn, " AND id = ?", (d["id"],))[0]}


@router.post("/calendar/{date_id}/questions")
def link_question_to_date(date_id: str, body: DateLinkIn):
    with get_db() as conn:
        d = _get_date(conn, date_id)
        _link_date(conn, d, body)
        return {"date": _calendar(conn, " AND id = ?", (d["id"],))[0]}


@router.delete("/calendar/links/{link_id}")
def unlink_question_from_date(link_id: str):
    with get_db() as conn:
        conn.execute("DELETE FROM question_date_links WHERE id = ?", (link_id,))
    return {"ok": True}


@router.delete("/calendar/{date_id}")
def delete_date(date_id: str):
    _user_only("remove a calendar date")
    with get_db() as conn:
        d = _get_date(conn, date_id)
        conn.execute("UPDATE question_dates SET deleted_at = ?, updated_at = ? WHERE id = ?",
                     (_now_sync(), _now_sync(), d["id"]))
    return {"ok": True}


@router.get("/{question_id}")
def get_question(question_id: str):
    with get_db() as conn:
        return _full(conn, _get(conn, question_id))


# ── Create / edit ────────────────────────────────────────────────────────────

def _check_edge(conn, child_id: Optional[str], p: ParentIn) -> dict:
    parent = _get(conn, p.parent)
    if p.if_a.strip() and _norm(p.if_a) == _norm(p.if_b):
        raise HTTPException(
            422,
            f"parent {parent['ref']}: if_a and if_b are the same, so answering this question "
            "would change nothing above it — it reduces no uncertainty",
        )
    if child_id:
        if parent["id"] == child_id:
            raise HTTPException(400, "a question cannot be its own parent")
        # Would this make a loop? Walk up from the parent looking for the child.
        seen, stack = set(), [parent["id"]]
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            if cur == child_id:
                raise HTTPException(400, f"{parent['ref']} already depends on this question — that would be a loop")
            stack += [r["parent_id"] for r in conn.execute(
                "SELECT parent_id FROM question_edges WHERE child_id = ?", (cur,))]
    return parent


def _insert_edge(conn, child_id: str, parent_id: str, p: ParentIn) -> None:
    now = _now_sync()
    conn.execute(
        """INSERT INTO question_edges (id, child_id, parent_id, if_a, if_b, actor, device_id,
                                       created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)""",
        (_uid(), child_id, parent_id, p.if_a.strip(), p.if_b.strip(), current_actor(),
         device_id(), now, now),
    )


def _create(conn, body: QuestionIn) -> dict:
    """Validate and insert one question on an open connection; returns its row.
    Shared by the single create and the tree import, which runs many of these
    in one transaction so a refused question leaves nothing half-written."""
    title = body.title.strip()
    if not title:
        raise HTTPException(422, "a question needs a title — the question itself, as one sentence")
    if body.next_check and not _is_date(body.next_check):
        raise HTTPException(422, "next_check must be YYYY-MM-DD")
    if body.is_root and body.parents:
        raise HTTPException(422, "a root question has no parents")
    if not body.parents and not body.thesis_id:
        # Not strictness — a question tied to nothing appears on no screen.
        raise HTTPException(
            422, "say where this question belongs: a thesis_id, or a parent question")

    qid = _uid()
    now = _now_sync()
    parents = [(_check_edge(conn, None, p), p) for p in body.parents]
    thesis_id = body.thesis_id or next((p["thesis_id"] for p, _ in parents if p["thesis_id"]), None)
    symbol = (body.symbol or next((p["symbol"] for p, _ in parents if p["symbol"]), None) or "").upper() or None
    if thesis_id:
        t = conn.execute("SELECT symbol FROM theses WHERE id = ?", (thesis_id,)).fetchone()
        if t is None:
            raise HTTPException(404, f"thesis {thesis_id} not found")
        symbol = symbol or t["symbol"]
    if body.is_root:
        if not thesis_id:
            raise HTTPException(422, "a root question belongs to a thesis — pass thesis_id")
        existing = conn.execute(
            "SELECT ref FROM questions WHERE thesis_id = ? AND is_root = 1 "
            "AND deleted_at IS NULL AND dropped_at IS NULL", (thesis_id,)).fetchone()
        if existing:
            raise HTTPException(
                409, f"this thesis already has a root question ({existing['ref']}) — "
                     "hang the new one under it")
    dup = next(
        (r for r in conn.execute(
            "SELECT id, ref, title FROM questions WHERE deleted_at IS NULL "
            "AND COALESCE(thesis_id, '') = ?", (thesis_id or "",))
         if _norm(r["title"]) == _norm(title)),
        None,
    )
    if dup:
        raise HTTPException(
            409, f"this question is already tracked: {dup['ref']} ({dup['id']}) — "
                 "add a parent to it instead of asking it twice")

    conn.execute(
        """INSERT INTO questions (id, ref, thesis_id, symbol, title, thought, is_root, priority,
                                  next_check, actor, device_id, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (qid, _next_ref(conn), thesis_id, symbol, title, body.thought.strip(),
         1 if body.is_root else 0, body.priority, body.next_check, current_actor(),
         device_id(), now, now),
    )
    for parent, p in parents:
        _insert_edge(conn, qid, parent["id"], p)
    q = _get(conn, qid)
    if thesis_id:
        _log_event(conn, thesis_id, "QUESTION_ADDED",
                   {"question_id": qid, "ref": q["ref"]}, title)
    return q


@router.post("")
def create_question(body: QuestionIn):
    with get_db() as conn:
        return _full(conn, _create(conn, body))


@router.patch("/{question_id}")
def patch_question(question_id: str, body: QuestionPatch):
    updates = {k: v for k, v in body.model_dump(exclude_unset=True).items() if k in EDITABLE}
    if not updates:
        raise HTTPException(400, "nothing to update")
    if updates.get("next_check") and not _is_date(updates["next_check"]):
        raise HTTPException(422, "next_check must be YYYY-MM-DD")
    if "title" in updates and not (updates["title"] or "").strip():
        raise HTTPException(422, "title cannot be empty")
    with get_db() as conn:
        q = _get(conn, question_id)
        diff = {k: v for k, v in updates.items() if q.get(k) != v}
        if diff:
            sets = ", ".join(f"{k} = ?" for k in diff)
            conn.execute(f"UPDATE questions SET {sets}, updated_at = ? WHERE id = ?",
                         [*diff.values(), _now_sync(), q["id"]])
        return _full(conn, _get(conn, q["id"]))


@router.post("/{question_id}/parents")
def add_parent(question_id: str, body: ParentIn):
    """Hang an existing question under a second parent — how two branches come to
    meet at one question instead of asking it twice."""
    with get_db() as conn:
        q = _get(conn, question_id)
        if q["is_root"]:
            raise HTTPException(400, "a root question has no parents")
        parent = _check_edge(conn, q["id"], body)
        if conn.execute("SELECT 1 FROM question_edges WHERE child_id = ? AND parent_id = ?",
                        (q["id"], parent["id"])).fetchone():
            raise HTTPException(409, f"{q['ref']} already hangs under {parent['ref']}")
        _insert_edge(conn, q["id"], parent["id"], body)
        return _full(conn, q)


@router.patch("/edges/{edge_id}")
def patch_parent(edge_id: str, body: EdgePatch):
    """Fill in (or correct) how each answer would move the parent — the piece a
    quickly captured question is usually missing."""
    with get_db() as conn:
        e = conn.execute("SELECT * FROM question_edges WHERE id = ?", (edge_id,)).fetchone()
        if e is None:
            raise HTTPException(404, "edge not found")
        if_a = (body.if_a if body.if_a is not None else e["if_a"]).strip()
        if_b = (body.if_b if body.if_b is not None else e["if_b"]).strip()
        if if_a and _norm(if_a) == _norm(if_b):
            raise HTTPException(
                422, "if_a and if_b are the same, so answering this question would change "
                     "nothing above it — it reduces no uncertainty")
        conn.execute("UPDATE question_edges SET if_a = ?, if_b = ?, updated_at = ? WHERE id = ?",
                     (if_a, if_b, _now_sync(), edge_id))
        return _full(conn, _get(conn, e["child_id"]))


@router.delete("/edges/{edge_id}")
def remove_parent(edge_id: str):
    """For a mis-drawn link. Removing the last one leaves the question unplaced
    (it shows `parent` in its gaps), not deleted."""
    _user_only("remove a link")
    with get_db() as conn:
        e = conn.execute("SELECT * FROM question_edges WHERE id = ?", (edge_id,)).fetchone()
        if e is None:
            raise HTTPException(404, "edge not found")
        conn.execute("DELETE FROM question_edges WHERE id = ?", (edge_id,))
    return {"ok": True}


# ── Claim ────────────────────────────────────────────────────────────────────

@router.post("/{question_id}/claim")
def claim(question_id: str):
    """Mark a question as being worked on, so two agents do not research the same
    one. Expires by itself (CLAIM_TTL) and is cleared by submitting an answer."""
    me = current_actor()
    cutoff = (datetime.utcnow() - CLAIM_TTL).strftime("%Y-%m-%d %H:%M:%S")
    with get_db() as conn:
        q = _get(conn, question_id)
        if q["claimed_by"] and q["claimed_by"] != me and (q["claimed_at"] or "") > cutoff:
            raise HTTPException(409, f"{q['ref']} is being worked on by {q['claimed_by']} "
                                     f"since {q['claimed_at']} UTC — take another from the queue")
        conn.execute("UPDATE questions SET claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = ?",
                     (me, datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"), _now_sync(), q["id"]))
        return _full(conn, _get(conn, q["id"]))


@router.post("/{question_id}/release")
def release(question_id: str):
    with get_db() as conn:
        q = _get(conn, question_id)
        if q["claimed_by"]:
            conn.execute("UPDATE questions SET claimed_by = NULL, claimed_at = NULL, updated_at = ? "
                         "WHERE id = ?", (_now_sync(), q["id"]))
    return {"ok": True}


# ── Answers ──────────────────────────────────────────────────────────────────

def _check_answer(conn, body: AnswerIn) -> tuple[list[str], list[Optional[dict]], list[dict]]:
    """Everything wrong with this answer, plus the resolved evidence.

    Returns (problems, zettel per signal, zettel per evidence ref). The whole
    list is collected rather than stopping at the first, so a refused answer can
    be repaired in one round trip.
    """
    level = (body.level or "").upper()
    basis = (body.basis or "").upper() or None
    bad: list[str] = []
    if level not in LEVELS:
        return [f"level must be one of {list(LEVELS)}"], [], []
    if not body.answer.strip():
        bad.append("answer: the answer in words is required at every level")

    sig_z: list[Optional[dict]] = []
    for i, s in enumerate(body.signals, 1):
        tag = f"signal {i}"
        result = (s.result or "").upper()
        z = _zettel_brief(conn, s.zettel) if s.zettel else None
        sig_z.append(z)
        if not s.expectation.strip():
            bad.append(f"{tag}: expectation is required — what you would expect to see if this were true")
        if result not in SIGNAL_RESULTS:
            bad.append(f"{tag}: result must be one of {list(SIGNAL_RESULTS)}")
        elif result in ("FOUND", "CONTRARY"):
            if not s.finding.strip():
                bad.append(f"{tag}: finding is required — what was actually observed")
            problem = _evidence_problem(z, tag) if s.zettel else f"{tag}: a {result} signal needs its evidence zettel"
            if problem:
                bad.append(problem)
            if result == "FOUND" and not s.origin.strip():
                bad.append(f"{tag}: origin is required — who ultimately produced this information "
                           "(two signals from one origin count once)")
        elif result == "NOT_FOUND" and not s.searched_where.strip():
            bad.append(f"{tag}: searched_where is required — an absence only counts if someone looked")

    ev_z: list[dict] = []
    for ref in body.evidence:
        z = _zettel_brief(conn, ref)
        problem = _evidence_problem(z, f"evidence {ref}")
        if problem:
            bad.append(problem)
        elif z:
            ev_z.append(z)

    found = [(s, z) for s, z in zip(body.signals, sig_z)
             if (s.result or "").upper() == "FOUND" and z is not None]

    if level == "CONFIRMED":
        if basis not in BASES:
            bad.append(f"basis: a CONFIRMED answer says what confirms it — one of {list(BASES)}")
        elif basis == "NUMBER":
            if not (body.value or "").strip():
                bad.append("value: a NUMBER confirmation needs the number")
            if not _is_date(body.as_of):
                bad.append("as_of: the date the number refers to (YYYY-MM-DD)")
            if not ev_z:
                bad.append("evidence: at least one evidence zettel")
            elif not any(_evidence_problem(z, "", need_primary=True) is None for z in ev_z):
                bad.append("evidence: a NUMBER confirmation needs a PRIMARY source (filing, company "
                           "release, official statistic) with url + quote")
        elif basis == "EVENT":
            if not _is_date(body.as_of):
                bad.append("as_of: the date the event happened (YYYY-MM-DD)")
            if not ev_z:
                bad.append("evidence: at least one evidence zettel documenting the event")
        elif basis == "CIRCUMSTANTIAL":
            alts = {_norm(a) for a in body.alternatives if a.strip()}
            if len(alts) < 2:
                bad.append("alternatives: name at least two competing explanations — a signal only "
                           "counts if it tells them apart")
            origins = {_norm(s.origin) for s, _ in found if s.diagnostic and s.origin.strip()}
            if len(origins) < MIN_INDEPENDENT_SIGNALS:
                bad.append(
                    f"signals: {MIN_INDEPENDENT_SIGNALS} FOUND signals that are diagnostic (would NOT "
                    "be seen under the competing explanation) and come from different origins — "
                    f"have {len(origins)}")
            if any((s.result or "").upper() == "CONTRARY" for s in body.signals):
                bad.append("signals: a CONTRARY signal is recorded — that is not a confirmation; "
                           "answer INFERRED and state what would settle it")
            clashes = _open_conflicts(conn, [z["id"] for _, z in found] + [z["id"] for z in ev_z])
            if clashes:
                bad.append("evidence is in an open conflict: " + ", ".join(clashes))
    elif level == "INFERRED":
        if not found and not ev_z:
            bad.append("evidence: an inference still stands on something observed — at least one "
                       "FOUND signal or evidence zettel")
        if not body.assumptions:
            bad.append("assumptions: at least one testable assumption — what must be true for this "
                       "inference to hold")
        for i, s in enumerate(body.assumptions, 1):
            for field, why in (("statement", "what is assumed"),
                               ("metric", "the number or fact that will test it"),
                               ("source_hint", "where that will be read"),
                               ("falsifier", "what result would prove it wrong")):
                if not (getattr(s, field) or "").strip():
                    bad.append(f"assumption {i}: {field} is required — {why}")
            if not _is_date(s.check_by):
                bad.append(f"assumption {i}: check_by is required — the date it can be tested (YYYY-MM-DD)")
    else:  # UNCLEAR / UNANSWERABLE
        if not body.searched.strip():
            bad.append("searched: say where you looked and what was not there")
        if not _is_date(body.next_check):
            bad.append("next_check: the date to look again (YYYY-MM-DD)")
    return bad, sig_z, ev_z


def _answer(conn, q: dict, body: AnswerIn) -> str:
    """Check and insert one answer on an open connection; returns its id."""
    level = (body.level or "").upper()
    if q["dropped_at"]:
        raise HTTPException(400, f"{q['ref']} was dropped — reopen it first")
    bad, sig_z, ev_z = _check_answer(conn, body)
    if bad:
        raise HTTPException(422, {
            "code": "ANSWER_REFUSED",
            "level": level,
            "missing": bad,
            "hint": "fix every item, or answer at a lower level: INFERRED needs evidence + a "
                    "testable assumption; UNCLEAR needs what was searched + a date to look again",
        })

    aid = _uid()
    now = _now_sync()
    who = current_actor()
    conn.execute(
        """INSERT INTO question_answers (id, question_id, level, basis, answer, value, unit, as_of,
                                         alternatives, searched, next_check, evidence, actor,
                                         device_id, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (aid, q["id"], level, (body.basis or "").upper() or None, body.answer.strip(),
         body.value, body.unit, body.as_of,
         json.dumps([a.strip() for a in body.alternatives if a.strip()], ensure_ascii=False),
         body.searched.strip(), body.next_check,
         json.dumps([z["id"] for z in ev_z]), who, device_id(), now, now),
    )
    for s, z in zip(body.signals, sig_z):
        conn.execute(
            """INSERT INTO question_signals (id, question_id, answer_id, expectation, result, finding,
                                             supports, diagnostic, origin, zettel_id, searched_where,
                                             device_id, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (_uid(), q["id"], aid, s.expectation.strip(), s.result.upper(), s.finding.strip(),
             s.supports.strip(), 1 if s.diagnostic else 0, s.origin.strip(),
             z["id"] if z else None, s.searched_where.strip(), device_id(), now, now),
        )
    if level == "INFERRED":
        for s in body.assumptions:
            conn.execute(
                """INSERT INTO question_assumptions (id, question_id, answer_id, statement, metric,
                                                     source_hint, check_by, falsifier, device_id,
                                                     created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (_uid(), q["id"], aid, s.statement.strip(), s.metric.strip(),
                 s.source_hint.strip(), s.check_by, s.falsifier.strip(), device_id(), now, now),
            )
    if q["claimed_by"]:
        conn.execute("UPDATE questions SET claimed_by = NULL, claimed_at = NULL, updated_at = ? "
                     "WHERE id = ?", (_now_sync(), q["id"]))
    if q["thesis_id"]:
        _log_event(conn, q["thesis_id"], "QUESTION_ANSWERED",
                   {"question_id": q["id"], "ref": q["ref"], "level": level,
                    "answer_id": aid}, f"{q['title']} → {body.answer.strip()}")
    return aid


@router.post("/{question_id}/answers")
def add_answer(question_id: str, body: AnswerIn):
    with get_db() as conn:
        q = _get(conn, question_id)
        _answer(conn, q, body)
        return _full(conn, _get(conn, q["id"]))


# ── Import a whole tree ──────────────────────────────────────────────────────

@router.post("/import")
def import_tree(body: ImportIn):
    """Add many questions (and optionally an answer each) in one transaction.

    Breaking a thesis down produces a tree, not one question, and its members
    point at each other before any of them has an id — so each item carries a
    local `key`, and a parent may name the key of an item EARLIER in the list
    (or the Q-ref / id of a question that already exists). Every rule of the
    single-question path applies unchanged; the first item that breaks one is
    reported by key and nothing at all is written.
    """
    if not body.questions:
        raise HTTPException(422, "questions: nothing to import")
    keys: dict[str, str] = {}
    created: list[dict] = []
    with get_db() as conn:
        for i, item in enumerate(body.questions):
            label = item.key or f"#{i + 1}"
            if item.key and item.key in keys:
                raise HTTPException(422, f"key '{item.key}' is used twice")
            q_in = QuestionIn(
                **{**item.model_dump(exclude={"key", "answer", "parents"}),
                   "thesis_id": item.thesis_id or body.thesis_id},
                parents=[ParentIn(parent=keys.get(p.parent, p.parent), if_a=p.if_a, if_b=p.if_b)
                         for p in item.parents],
            )
            try:
                q = _create(conn, q_in)
                if item.answer is not None:
                    _answer(conn, q, item.answer)
            except HTTPException as exc:
                # Propagating through get_db rolls the whole import back.
                raise HTTPException(exc.status_code, {
                    "code": "IMPORT_REFUSED", "key": label, "index": i,
                    "reason": exc.detail, "written": 0,
                }) from exc
            if item.key:
                keys[item.key] = q["id"]
            created.append({"key": label, "id": q["id"], "ref": q["ref"], "title": q["title"]})
        book = _book(conn)
    for c in created:
        c["status"] = book["states"][c["id"]]["status"]
    return {"created": created, "counts": book["counts"]}


@router.post("/answers/{answer_id}/review")
def review_answer(answer_id: str, body: ReviewIn):
    _user_only("accept or reject an answer")
    decision = (body.decision or "").upper()
    if decision not in ("ACCEPTED", "REJECTED"):
        raise HTTPException(422, "decision must be ACCEPTED or REJECTED")
    if decision == "REJECTED" and not body.note.strip():
        raise HTTPException(422, "say why it is rejected — the next attempt needs to know")
    with get_db() as conn:
        a = conn.execute("SELECT * FROM question_answers WHERE id = ?", (answer_id,)).fetchone()
        if a is None:
            raise HTTPException(404, "answer not found")
        q = _get(conn, a["question_id"])
        now = _now_sync()
        conn.execute(
            """INSERT INTO question_checks (id, question_id, kind, target_id, result, note, actor,
                                            device_id, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (_uid(), q["id"], "REVIEW", answer_id, decision, body.note.strip(), current_actor(),
             device_id(), now, now),
        )
        if q["thesis_id"]:
            _log_event(conn, q["thesis_id"], "QUESTION_REVIEWED",
                       {"question_id": q["id"], "ref": q["ref"], "decision": decision},
                       body.note.strip() or q["title"])
        return _full(conn, q)


@router.post("/assumptions/{assumption_id}/check")
def check_assumption(assumption_id: str, body: AssumptionCheckIn):
    """Record that an assumption was tested. HELD or BROKEN, and the evidence it
    was read from — a check without a source is the thing this system exists to
    refuse. BROKEN sends the question back to OPEN."""
    result = (body.result or "").upper()
    if result not in ("HELD", "BROKEN"):
        raise HTTPException(422, "result must be HELD or BROKEN")
    with get_db() as conn:
        s = conn.execute("SELECT * FROM question_assumptions WHERE id = ?", (assumption_id,)).fetchone()
        if s is None:
            raise HTTPException(404, "assumption not found")
        z = _zettel_brief(conn, body.zettel) if body.zettel else None
        bad = []
        if not body.note.strip():
            bad.append("note: what the metric actually came out as")
        problem = _evidence_problem(z, "zettel") if body.zettel else "zettel: the evidence the check was read from"
        if problem:
            bad.append(problem)
        if bad:
            raise HTTPException(422, {"code": "CHECK_REFUSED", "missing": bad})
        q = _get(conn, s["question_id"])
        now = _now_sync()
        conn.execute(
            """INSERT INTO question_checks (id, question_id, kind, target_id, result, note, zettel_id,
                                            actor, device_id, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (_uid(), q["id"], "ASSUMPTION", assumption_id, result, body.note.strip(), z["id"],
             current_actor(), device_id(), now, now),
        )
        if q["thesis_id"]:
            _log_event(conn, q["thesis_id"], "ASSUMPTION_CHECKED",
                       {"question_id": q["id"], "ref": q["ref"], "result": result},
                       f"{s['statement']} → {body.note.strip()}")
        return _full(conn, q)


# ── Drop / reopen / delete ───────────────────────────────────────────────────

@router.post("/{question_id}/drop")
def drop(question_id: str, body: DropIn):
    _user_only("drop a question")
    if not body.reason.strip():
        raise HTTPException(422, "a reason is required — why this no longer needs an answer")
    with get_db() as conn:
        q = _get(conn, question_id)
        conn.execute("UPDATE questions SET dropped_at = ?, drop_reason = ?, updated_at = ? WHERE id = ?",
                     (_now_sync(), body.reason.strip(), _now_sync(), q["id"]))
        if q["thesis_id"]:
            _log_event(conn, q["thesis_id"], "QUESTION_DROPPED",
                       {"question_id": q["id"], "ref": q["ref"]}, body.reason.strip())
        return _full(conn, _get(conn, q["id"]))


@router.post("/{question_id}/reopen")
def reopen(question_id: str):
    _user_only("reopen a question")
    with get_db() as conn:
        q = _get(conn, question_id)
        conn.execute("UPDATE questions SET dropped_at = NULL, drop_reason = '', updated_at = ? "
                     "WHERE id = ?", (_now_sync(), q["id"]))
        return _full(conn, _get(conn, q["id"]))


@router.delete("/{question_id}")
def delete_question(question_id: str):
    """Soft, and only for a question entered by mistake. One that was asked and
    stopped mattering is dropped with a reason instead, so the trail stays."""
    _user_only("delete a question")
    with get_db() as conn:
        q = _get(conn, question_id)
        if conn.execute("SELECT 1 FROM question_edges e JOIN questions c ON c.id = e.child_id "
                        "WHERE e.parent_id = ? AND c.deleted_at IS NULL", (q["id"],)).fetchone():
            raise HTTPException(400, "other questions hang under this one — drop it instead")
        conn.execute("UPDATE questions SET deleted_at = ?, updated_at = ? WHERE id = ?",
                     (_now_sync(), _now_sync(), q["id"]))
    return {"ok": True}


@router.post("/resolve-ref-collisions")
def resolve_ref_collisions():
    """Re-mint Q-refs two devices minted independently — see zettel's twin."""
    renamed: list[dict[str, Any]] = []
    with get_db() as conn:
        for (ref,) in conn.execute(
            "SELECT ref FROM questions WHERE ref IS NOT NULL GROUP BY ref HAVING COUNT(*) > 1"
        ).fetchall():
            rows = conn.execute("SELECT id FROM questions WHERE ref = ? ORDER BY created_at", (ref,)).fetchall()
            for row in rows[1:]:
                new_ref = _next_ref(conn)
                conn.execute("UPDATE questions SET ref = ?, updated_at = ? WHERE id = ?",
                             (new_ref, _now_sync(), row["id"]))
                renamed.append({"id": row["id"], "from": ref, "to": new_ref})
    return {"renamed": renamed, "count": len(renamed)}
