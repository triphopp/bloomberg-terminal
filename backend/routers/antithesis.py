"""
Anti-thesis — stepping back from a thesis by arguing against it.

Every belief the thesis rests on is written beside its negation, attacked from
each angle a belief can be wrong, and stands only while every attack on it has
been answered with evidence. A claim that loses is replaced by a new wording,
and the new wording is attacked again: thesis, antithesis, synthesis.

Schema + rationale: db.init_antithesis_schema(); how an agent uses it in
memory/reference/anti-thesis.md.

What the endpoints exist to enforce:

  1. A belief nobody attacked is UNTESTED, not safe. A claim stands only when it
     has objections and every one of them was rebutted; it is SETTLED only when
     every angle was tried as well — an objection raised and answered, or a
     search for one recorded with where it looked.
  2. Raising an objection is cheap, dismissing one is not. An objection needs
     its argument and nothing else. A rebuttal needs evidence a reader can
     check — a zettel carrying a url and the quoted sentence — that is not
     itself part of an open conflict.
  3. A claim under attack is not reworded. Changing what it says is a revision:
     a new claim that replaces it and starts untested, with the old wording and
     everything argued against it kept.
  4. The user closes. An agent's verdict is a proposal until the user accepts
     it; only the user withdraws an objection, retires or deletes a claim,
     rewrites one directly, or changes what a claim is worth to the thesis.
  5. Nothing here changes the thesis. A key claim that fell is shown and logged;
     the body, the status and the conviction stay the user's to change.
  6. Status is derived, never stored — see `_derive`.
"""
import json
from datetime import date
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

import routers.questions as questions
from actor import capture_actor, current_actor
from db import get_db
from routers.questions import (
    QuestionIn, _evidence_problem, _in, _is_date, _latest, _norm, _open_conflicts, _uid,
    _user_only, _zettel_brief, _zettel_briefs,
)
# The stamp comes from theses, not questions: "the newest verdict stands" is
# decided by created_at, and questions._now_sync drops the seconds (see
# memory/reports/now-sync-missing-seconds-risk-report.md).
from routers.theses import _log_event, _now_sync
from sync.config import device_id

router = APIRouter(prefix="/api/v2/antithesis", dependencies=[Depends(capture_actor)])

STAKES = ("KEY", "SUPPORT")
# The ways a belief can be wrong. The text is what an objection from that angle
# argues; it is served with the board so the UI and an agent read the same words.
ANGLES = {
    "FACT":  "the facts are wrong — the data is false, stale, or measures something else",
    "CAUSE": "another cause explains what we see, and it does not carry the thesis with it",
    "LOGIC": "the facts hold but the conclusion does not follow — a step is missing or overreached",
    "TIME":  "true today but not for long enough, not widely enough, or later than the horizon",
    "PRICE": "true, and already paid for — the market knows it, or the other side knows more",
    "OTHER": "anything else",
}
# A claim is settled only when each of these was tried.
REQUIRED_ANGLES = ("FACT", "CAUSE", "LOGIC", "TIME", "PRICE")
VERDICTS = ("REBUTTED", "CONCEDED", "UNDECIDED")
CONSEQUENCES = ("REVISE", "FALLS")
# Most urgent first — the order the board is sorted in.
STATUSES = ("FALLEN", "BROKEN", "CONTESTED", "UNTESTED", "STANDS", "REVISED", "RETIRED")
# A claim nothing more can be argued against: it was replaced or let go.
CLOSED = ("REVISED", "RETIRED")
UNRESOLVED = ("OPEN", "PENDING", "UNDECIDED")


# ── Models ───────────────────────────────────────────────────────────────────

class ObjectionIn(BaseModel):
    argument: str = ""
    angle: str = "OTHER"
    would_see: str = ""
    look_where: str = ""
    parent: Optional[str] = None      # A-ref / id of the objection this one continues


class SweepIn(BaseModel):
    angle: str = ""
    searched: str = ""


class ClaimIn(BaseModel):
    statement: str = ""
    thesis_id: Optional[str] = None
    negation: str = ""
    basis: str = ""
    stake: str = "SUPPORT"


class ClaimPatch(BaseModel):
    statement: Optional[str] = None
    negation: Optional[str] = None
    basis: Optional[str] = None
    stake: Optional[str] = None


class ReviseIn(BaseModel):
    statement: str = ""
    negation: str = ""
    reason: str = ""


class ObjectionPatch(BaseModel):
    angle: Optional[str] = None
    would_see: Optional[str] = None
    look_where: Optional[str] = None


class VerdictIn(BaseModel):
    result: str = ""
    reasoning: str = ""
    evidence: list[str] = []
    searched: str = ""
    next_check: Optional[str] = None
    consequence: Optional[str] = None
    revised_statement: str = ""
    revised_negation: str = ""


class ReviewIn(BaseModel):
    decision: str = ""
    note: str = ""


class ReasonIn(BaseModel):
    reason: str = ""


class ImportClaim(ClaimIn):
    objections: list[ObjectionIn] = []
    none_found: list[SweepIn] = []


class ImportIn(BaseModel):
    thesis_id: str = ""
    claims: list[ImportClaim] = []


# ── Small helpers ────────────────────────────────────────────────────────────

def _next_ref(conn, table: str, prefix: str) -> str:
    row = conn.execute(
        f"SELECT MAX(CAST(SUBSTR(ref, 3) AS INTEGER)) FROM {table} "
        f"WHERE ref LIKE '{prefix}-%' AND SUBSTR(ref, 3) GLOB '[0-9]*'"
    ).fetchone()
    return f"{prefix}-{((row[0] or 0) + 1):04d}"


def _get_claim(conn, claim_id: str) -> dict:
    row = conn.execute(
        "SELECT * FROM anti_claims WHERE (id = ? OR ref = ?) AND deleted_at IS NULL",
        (claim_id, claim_id),
    ).fetchone()
    if row is None:
        raise HTTPException(404, f"claim {claim_id} not found")
    return dict(row)


def _get_objection(conn, objection_id: str) -> dict:
    row = conn.execute("SELECT * FROM anti_objections WHERE id = ? OR ref = ?",
                       (objection_id, objection_id)).fetchone()
    if row is None:
        raise HTTPException(404, f"objection {objection_id} not found")
    return dict(row)


def _by_time(r: dict) -> tuple:
    return (r["created_at"], r["id"])


def _angle(raw: str, bad: list[str], allowed: tuple[str, ...] = tuple(ANGLES)) -> str:
    angle = (raw or "").strip().upper()
    if angle not in allowed:
        bad.append(f"angle: one of {list(allowed)}")
    return angle


# ── Derived state ────────────────────────────────────────────────────────────

def _objection_state(o: dict, rows: list[dict], today: str) -> dict:
    """Where one objection stands. The verdict that counts is the newest one the
    user stands behind — their own, or an agent's they accepted. A newer agent
    verdict nobody has reviewed is a proposal, and keeps the objection open."""
    mine = [r for r in rows if r["objection_id"] == o["id"]]
    reviews = _latest([{**r, "target_id": r["target_id"] or ""} for r in mine if r["kind"] == "REVIEW"])
    verdicts = sorted((r for r in mine if r["kind"] == "VERDICT"), key=_by_time, reverse=True)

    def accepted(v: dict) -> bool:
        review = reviews.get(v["id"])
        if review is not None:
            return review["result"] == "ACCEPTED"
        return v["actor"] == "user"        # the user's own verdict needs no second signature

    current = next((v for v in verdicts if accepted(v)), None)
    proposed = next(
        (v for v in verdicts
         if v["id"] not in reviews and v["actor"] != "user"
         and (current is None or _by_time(v) > _by_time(current))),
        None,
    )
    if o["withdrawn_at"]:
        status = "WITHDRAWN"
    elif proposed is not None:
        status = "PENDING"
    elif current is None:
        status = "OPEN"
    else:
        status = current["result"]
    due = bool(status == "UNDECIDED" and current["next_check"] and current["next_check"][:10] <= today)
    return {"status": status, "due": due, "_current": current, "_proposed": proposed,
            "_verdicts": verdicts, "_reviews": reviews}


def _derive(c: dict, objections: list[dict], successor: Optional[dict], depth: int) -> dict:
    """Where one claim stands, from rows that are only ever added.

    FALLEN    — an objection was conceded and the claim was given up.
    BROKEN    — an objection was conceded, the claim has to be reworded, and the
                new wording has not been written.
    CONTESTED — at least one objection is unanswered, undecided, or answered by
                an agent and waiting for the user.
    UNTESTED  — nobody has objected to it. The default, and not a good one.
    STANDS    — it was objected to and every objection was rebutted.
    REVISED   — a newer claim replaced it. RETIRED — the user let it go.
    """
    sweeps = [o for o in objections if o["kind"] == "NONE_FOUND" and not o["withdrawn_at"]]
    live = [o for o in objections if o["kind"] == "OBJECTION" and not o["withdrawn_at"]]
    tally = {s.lower(): 0 for s in (*UNRESOLVED, "REBUTTED", "CONCEDED")}
    for o in live:
        tally[o["state"]["status"].lower()] += 1
    conceded = [o for o in live if o["state"]["status"] == "CONCEDED"]

    angles: dict[str, str] = {}
    for a in REQUIRED_ANGLES:
        on = [o["state"]["status"] for o in live if o["angle"] == a]
        if any(s in UNRESOLVED for s in on):
            angles[a] = "open"
        elif "CONCEDED" in on:
            angles[a] = "conceded"
        elif on:
            angles[a] = "rebutted"
        elif any(o["angle"] == a for o in sweeps):
            angles[a] = "none_found"
        else:
            angles[a] = "untried"
    untried = [a for a, s in angles.items() if s == "untried"]

    if c["retired_at"]:
        status = "RETIRED"
    elif successor is not None:
        status = "REVISED"
    elif any(o["state"]["_current"]["consequence"] == "FALLS" for o in conceded):
        status = "FALLEN"
    elif conceded:
        status = "BROKEN"
    elif not live:
        status = "UNTESTED"
    elif any(o["state"]["status"] in UNRESOLVED for o in live):
        status = "CONTESTED"
    else:
        status = "STANDS"

    gaps: list[str] = []
    if status not in CLOSED and status != "FALLEN":
        if not c["negation"].strip():
            gaps.append("negation")
        if untried:
            gaps.append("angles")
        if any(not o["would_see"].strip() for o in live if o["state"]["status"] in UNRESOLVED):
            gaps.append("would_see")
    return {
        "status": status,
        "round": depth,
        "gaps": gaps,
        "angles": angles,
        "untried": untried,
        # Nothing left to argue: it stands, and every angle was tried.
        "settled": status == "STANDS" and not untried,
        "objections": {**tally, "due": sum(1 for o in live if o["state"]["due"])},
        "challenged_at": max((o["created_at"] for o in (*live, *sweeps)), default=None),
    }


def _load(conn, where: str = "", params: tuple = ()) -> list[dict]:
    """Claims matching `where`, each with its objections (under `_objections`,
    their own state attached) and derived state."""
    claims = [dict(r) for r in conn.execute(
        f"SELECT * FROM anti_claims WHERE deleted_at IS NULL {where} ORDER BY created_at, ref",
        params).fetchall()]
    ids = [c["id"] for c in claims]
    objections = _in(conn, "SELECT * FROM anti_objections WHERE claim_id IN ({marks})", ids)
    rows = _in(conn, "SELECT * FROM anti_verdicts WHERE claim_id IN ({marks})", ids)
    # Asked for separately: the claim that replaced one may sit outside `where`.
    successors: dict[str, dict] = {}
    for s in sorted(_in(conn, "SELECT id, ref, statement, revises_id, created_at FROM anti_claims "
                              "WHERE deleted_at IS NULL AND revises_id IN ({marks})", ids),
                    key=_by_time):
        successors[s["revises_id"]] = s
    lineage = {r["id"]: r["revises_id"] for r in conn.execute(
        "SELECT id, revises_id FROM anti_claims WHERE revises_id IS NOT NULL").fetchall()}
    today = date.today().isoformat()
    for o in objections:
        o["state"] = _objection_state(o, rows, today)
    for c in claims:
        depth, at, seen = 1, c["id"], set()
        while lineage.get(at) and at not in seen:
            seen.add(at)
            at = lineage[at]
            depth += 1
        c["_objections"] = sorted((o for o in objections if o["claim_id"] == c["id"]), key=_by_time)
        c["_successor"] = successors.get(c["id"])
        c["state"] = _derive(c, c["_objections"], c["_successor"], depth)
    return claims


def _urgency(c: dict) -> tuple:
    return (STATUSES.index(c["state"]["status"]), 0 if c["stake"] == "KEY" else 1, c["created_at"])


def _count(claims: list[dict]) -> dict:
    out: dict[str, int] = {s.lower(): 0 for s in STATUSES}
    out.update(pending=0, due=0, settled=0, key_fallen=0, key_open=0)
    for c in claims:
        s = c["state"]
        out[s["status"].lower()] += 1
        if s["status"] in CLOSED:
            continue
        out["pending"] += s["objections"]["pending"]
        out["due"] += s["objections"]["due"]
        out["settled"] += 1 if s["settled"] else 0
        if c["stake"] == "KEY":
            out["key_fallen"] += 1 if s["status"] == "FALLEN" else 0
            out["key_open"] += 1 if s["status"] in ("UNTESTED", "CONTESTED", "BROKEN") else 0
    # `open` = beliefs still owed an argument; `alert` = what needs the user now.
    out["open"] = out["untested"] + out["contested"] + out["broken"]
    out["alert"] = out["key_fallen"] + out["broken"] + out["pending"] + out["due"]
    return out


def _summary(claims: list[dict]) -> dict:
    """One line for the whole thesis. SETTLED is the only reading that says the
    step back is finished — and it lasts until someone raises the next objection."""
    live = [c for c in claims if c["state"]["status"] not in CLOSED]
    standing = [c for c in live if c["state"]["status"] == "STANDS"]
    counts = _count(claims)
    if counts["key_fallen"]:
        verdict = "KEY_FALLEN"
    elif counts["open"]:
        verdict = "OPEN"
    elif not standing:
        verdict = "EMPTY"       # nothing on the board, or nothing left standing on it
    elif all(c["state"]["settled"] for c in standing):
        verdict = "SETTLED"
    else:
        verdict = "STANDING"
    return {"verdict": verdict, "live": len(live),
            "challenged_at": max((c["state"]["challenged_at"] or "" for c in live), default="") or None}


def _verdict_out(v: Optional[dict], reviews: dict[str, dict], cited: dict[str, dict]) -> Optional[dict]:
    if v is None:
        return None
    review = reviews.get(v["id"])
    return {
        "id": v["id"], "result": v["result"], "reasoning": v["reasoning"],
        "evidence": [cited[i] for i in json.loads(v["evidence"] or "[]") if i in cited],
        "searched": v["searched"], "next_check": v["next_check"], "consequence": v["consequence"],
        "revised_statement": v["revised_statement"], "revised_negation": v["revised_negation"],
        "actor": v["actor"], "created_at": v["created_at"],
        "review": review and {"result": review["result"], "note": review["reasoning"],
                              "actor": review["actor"], "created_at": review["created_at"]},
    }


def _out(conn, claims: list[dict]) -> list[dict]:
    """Claims as the API returns them: private keys stripped, evidence and the
    question an objection was sent to resolved to something readable."""
    cited = _zettel_briefs(conn, [
        i for c in claims for o in c["_objections"] for v in o["state"]["_verdicts"]
        for i in json.loads(v["evidence"] or "[]")])
    book = questions._book(conn) if any(
        o["question_id"] for c in claims for o in c["_objections"]) else None
    by_id = {c["id"]: c for c in claims}

    def brief(c: Optional[dict]) -> Optional[dict]:
        return c and {"id": c["id"], "ref": c["ref"], "statement": c["statement"]}

    def question(qid: Optional[str]) -> Optional[dict]:
        q = book["by_id"].get(qid) if book and qid else None
        return q and {"id": q["id"], "ref": q["ref"], "title": q["title"],
                      "status": book["states"][q["id"]]["status"]}

    out = []
    for c in claims:
        objections, sweeps = [], []
        for o in c["_objections"]:
            s = o["state"]
            row = {k: v for k, v in o.items() if k != "state"}
            if o["kind"] == "NONE_FOUND":
                sweeps.append(row)
                continue
            current, proposed = s["_current"], s["_proposed"]
            shown = {v["id"] for v in (current, proposed) if v}
            objections.append({
                **row,
                "state": {"status": s["status"], "due": s["due"]},
                "question": question(o["question_id"]),
                "verdict": _verdict_out(current, s["_reviews"], cited),
                "proposal": _verdict_out(proposed, s["_reviews"], cited),
                "history": [_verdict_out(v, s["_reviews"], cited)
                            for v in s["_verdicts"] if v["id"] not in shown],
            })
        prior = by_id.get(c["revises_id"]) if c["revises_id"] else None
        if c["revises_id"] and prior is None:
            row = conn.execute("SELECT id, ref, statement FROM anti_claims WHERE id = ?",
                               (c["revises_id"],)).fetchone()
            prior = dict(row) if row else None
        out.append({
            **{k: v for k, v in c.items() if not k.startswith("_")},
            "revises": brief(prior), "revised_by": brief(c["_successor"]),
            "objections": objections, "sweeps": sweeps,
        })
    return out


def _full(conn, claim_id: str) -> dict:
    return {"claim": _out(conn, _load(conn, " AND id = ?", (claim_id,)))[0]}


# ── Read ─────────────────────────────────────────────────────────────────────

@router.get("")
def board(thesis_id: str = Query(...), include_closed: bool = Query(True)):
    """Every claim of one thesis with its objections and where each stands, most
    urgent first. `angles` = what each angle of attack argues."""
    with get_db() as conn:
        claims = _load(conn, " AND thesis_id = ?", (thesis_id,))
        claims.sort(key=_urgency)
        shown = claims if include_closed else [c for c in claims
                                               if c["state"]["status"] not in CLOSED]
        return {"claims": _out(conn, shown), "counts": _count(claims),
                "summary": _summary(claims), "angles": ANGLES,
                "required_angles": list(REQUIRED_ANGLES)}


@router.get("/counts")
def counts():
    """The badge numbers, whole book and per thesis. `open` = beliefs still owed
    an argument; `alert` = fallen key claims, claims to rewrite, verdicts
    waiting for the user."""
    with get_db() as conn:
        claims = _load(conn)
    by_thesis: dict[str, list[dict]] = {}
    for c in claims:
        by_thesis.setdefault(c["thesis_id"] or "", []).append(c)
    return {**_count(claims), "by_thesis": {
        k: {**_count(v), "verdict": _summary(v)["verdict"]} for k, v in by_thesis.items()}}


@router.get("/queue")
def queue(thesis_id: Optional[str] = Query(None), limit: int = Query(20, ge=1, le=200)):
    """What a step back still owes, for whoever does the arguing: objections
    nobody has answered (or whose look-again date came), then claims that were
    never attacked from some angle — key claims first."""
    with get_db() as conn:
        claims = _load(conn, " AND thesis_id = ?" if thesis_id else "",
                       (thesis_id,) if thesis_id else ())
        claims = [c for c in claims if c["state"]["status"] not in (*CLOSED, "FALLEN")]
        claims.sort(key=_urgency)
        rows = _out(conn, claims)
    owed, untried = [], []
    for c in rows:
        head = {"claim_id": c["id"], "claim_ref": c["ref"], "thesis_id": c["thesis_id"],
                "symbol": c["symbol"], "stake": c["stake"], "statement": c["statement"],
                "negation": c["negation"]}
        for o in c["objections"]:
            if o["state"]["status"] == "OPEN" or o["state"]["due"]:
                owed.append({**head, "objection_id": o["id"], "objection_ref": o["ref"],
                             "angle": o["angle"], "argument": o["argument"],
                             "would_see": o["would_see"], "look_where": o["look_where"],
                             "status": o["state"]["status"],
                             "next_check": (o["verdict"] or {}).get("next_check")})
        if c["state"]["gaps"]:
            untried.append({**head, "status": c["state"]["status"], "gaps": c["state"]["gaps"],
                            "untried": c["state"]["untried"]})
    return {"objections": owed[:limit], "claims": untried[:limit], "angles": ANGLES,
            "counts": _count(claims)}


@router.get("/{claim_id}")
def get_claim(claim_id: str):
    with get_db() as conn:
        return _full(conn, _get_claim(conn, claim_id)["id"])


# ── Claims ───────────────────────────────────────────────────────────────────

def _insert_claim(conn, thesis_id: str, symbol: Optional[str], statement: str, negation: str,
                  basis: str, stake: str, revises_id: Optional[str] = None) -> dict:
    cid = _uid()
    now = _now_sync()
    conn.execute(
        """INSERT INTO anti_claims (id, ref, thesis_id, symbol, statement, negation, basis, stake,
                                    revises_id, actor, device_id, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (cid, _next_ref(conn, "anti_claims", "C"), thesis_id, symbol, statement, negation, basis,
         stake, revises_id, current_actor(), device_id(), now, now),
    )
    return _get_claim(conn, cid)


def _create_claim(conn, body: ClaimIn) -> dict:
    """Validate and insert one claim on an open connection; returns its row.
    Shared by the single create and the import."""
    statement = body.statement.strip()
    bad: list[str] = []
    if not statement:
        bad.append("statement: the belief itself, as one sentence that could turn out false")
    if not body.thesis_id:
        bad.append("thesis_id: the thesis that rests on this belief")
    stake = (body.stake or "SUPPORT").upper()
    if stake not in STAKES:
        bad.append(f"stake: one of {list(STAKES)} — KEY = the thesis falls if this does")
    if bad:
        raise HTTPException(422, {"code": "CLAIM_REFUSED", "missing": bad})
    t = conn.execute("SELECT symbol FROM theses WHERE id = ?", (body.thesis_id,)).fetchone()
    if t is None:
        raise HTTPException(404, f"thesis {body.thesis_id} not found")
    if body.negation.strip() and _norm(body.negation) == _norm(statement):
        raise HTTPException(422, "negation: the same sentence as the claim — write what the "
                                 "world looks like if the claim is false")
    dup = next((r for r in conn.execute(
        "SELECT ref, statement FROM anti_claims WHERE deleted_at IS NULL AND thesis_id = ?",
        (body.thesis_id,)) if _norm(r["statement"]) == _norm(statement)), None)
    if dup:
        raise HTTPException(409, f"this belief is already on the board: {dup['ref']} — object "
                                 "to it instead of writing it twice")
    c = _insert_claim(conn, body.thesis_id, t["symbol"], statement, body.negation.strip(),
                      body.basis.strip(), stake)
    _log_event(conn, body.thesis_id, "ANTI_CLAIM_ADDED",
               {"claim_id": c["id"], "ref": c["ref"], "stake": stake}, statement)
    return c


@router.post("")
def create_claim(body: ClaimIn):
    """Put one belief on the board. Only the statement and the thesis are needed;
    a missing negation shows as a gap, and the claim sits UNTESTED until someone
    objects to it."""
    with get_db() as conn:
        return _full(conn, _create_claim(conn, body)["id"])


@router.patch("/{claim_id}")
def patch_claim(claim_id: str, body: ClaimPatch):
    """Fill in a claim. Its wording can be corrected only while nothing has been
    argued against it — after that, rewording is a revision (POST …/revise), so
    the goalposts stay where the objections found them."""
    updates = {k: v.strip() for k, v in body.model_dump(exclude_unset=True).items()
               if isinstance(v, str)}
    with get_db() as conn:
        c = _get_claim(conn, claim_id)
        if "stake" in updates:
            updates["stake"] = updates["stake"].upper()
        diff = {k: v for k, v in updates.items() if c[k] != v}
        if not diff:
            raise HTTPException(400, "nothing to update")
        bad: list[str] = []
        if "stake" in diff:
            _user_only("change what a claim is worth to the thesis")
            if diff["stake"] not in STAKES:
                bad.append(f"stake: one of {list(STAKES)}")
        if "statement" in diff:
            if not diff["statement"]:
                bad.append("statement cannot be empty")
            if c["actor"] == "user":
                _user_only("reword a claim the user wrote")
            argued = conn.execute("SELECT 1 FROM anti_objections WHERE claim_id = ? LIMIT 1",
                                  (c["id"],)).fetchone()
            if argued:
                raise HTTPException(
                    409, f"{c['ref']} has been argued over — it is not reworded in place. "
                         "Revise it (POST …/revise, or concede an objection with "
                         "consequence=REVISE): the new wording replaces it and starts untested")
        if _norm(diff.get("negation", c["negation"])) == _norm(diff.get("statement", c["statement"])):
            bad.append("negation: the same sentence as the claim")
        if bad:
            raise HTTPException(422, {"code": "CLAIM_REFUSED", "missing": bad})
        sets = ", ".join(f"{k} = ?" for k in diff)
        conn.execute(f"UPDATE anti_claims SET {sets}, updated_at = ? WHERE id = ?",
                     [*diff.values(), _now_sync(), c["id"]])
        if "stake" in diff and c["thesis_id"]:
            _log_event(conn, c["thesis_id"], "ANTI_STAKE_CHANGED",
                       {"claim_id": c["id"], "ref": c["ref"], "from": c["stake"],
                        "to": diff["stake"]}, c["statement"])
        return _full(conn, c["id"])


def _state_of(conn, claim_id: str) -> dict:
    return _load(conn, " AND id = ?", (claim_id,))[0]


def _replace(conn, old: dict, statement: str, negation: str, why: str) -> dict:
    """The synthesis: a new claim in place of `old`. It inherits what the old one
    was worth to the thesis and nothing else — no objection carries over, because
    none of them was raised against these words."""
    new = _insert_claim(conn, old["thesis_id"], old["symbol"], statement, negation, "",
                        old["stake"], revises_id=old["id"])
    if old["thesis_id"]:
        _log_event(conn, old["thesis_id"], "ANTI_REVISED",
                   {"claim_id": new["id"], "ref": new["ref"], "from_ref": old["ref"],
                    "from": old["statement"], "to": statement}, why)
    return new


@router.post("/{claim_id}/revise")
def revise(claim_id: str, body: ReviseIn):
    """Replace a claim with a new wording. The old one is kept with everything
    argued against it; the new one starts untested."""
    _user_only("rewrite a claim directly — concede the objection that forces the change, with "
               "consequence=REVISE and the new wording")
    statement = body.statement.strip()
    with get_db() as conn:
        c = _state_of(conn, _get_claim(conn, claim_id)["id"])
        bad: list[str] = []
        if not statement:
            bad.append("statement: the new wording")
        elif _norm(statement) == _norm(c["statement"]):
            bad.append("statement: the same sentence as before — a revision changes what is claimed")
        if not body.reason.strip():
            bad.append("reason: what made the old wording untenable — it goes on the thesis timeline")
        if bad:
            raise HTTPException(422, {"code": "CLAIM_REFUSED", "missing": bad})
        if c["state"]["status"] in CLOSED:
            raise HTTPException(409, f"{c['ref']} is {c['state']['status'].lower()} — revise the "
                                     "claim that stands in its place")
        new = _replace(conn, c, statement, body.negation.strip(), body.reason.strip())
        return _full(conn, new["id"])


@router.post("/{claim_id}/retire")
def retire(claim_id: str, body: ReasonIn):
    _user_only("take a claim off the board")
    if not body.reason.strip():
        raise HTTPException(422, "a reason is required — why the thesis no longer rests on this")
    with get_db() as conn:
        c = _get_claim(conn, claim_id)
        conn.execute("UPDATE anti_claims SET retired_at = ?, retire_reason = ?, updated_at = ? "
                     "WHERE id = ?", (_now_sync(), body.reason.strip(), _now_sync(), c["id"]))
        if c["thesis_id"]:
            _log_event(conn, c["thesis_id"], "ANTI_RETIRED",
                       {"claim_id": c["id"], "ref": c["ref"], "stake": c["stake"]},
                       f"{c['statement']}: {body.reason.strip()}")
        return _full(conn, c["id"])


@router.post("/{claim_id}/reopen")
def reopen(claim_id: str):
    _user_only("put a retired claim back on the board")
    with get_db() as conn:
        c = _get_claim(conn, claim_id)
        conn.execute("UPDATE anti_claims SET retired_at = NULL, retire_reason = '', "
                     "updated_at = ? WHERE id = ?", (_now_sync(), c["id"]))
        return _full(conn, c["id"])


@router.delete("/{claim_id}")
def delete_claim(claim_id: str):
    """Soft, and only for a claim entered by mistake. One the thesis stopped
    resting on is retired with a reason, so what was argued stays."""
    _user_only("delete a claim")
    with get_db() as conn:
        c = _get_claim(conn, claim_id)
        conn.execute("UPDATE anti_claims SET deleted_at = ?, updated_at = ? WHERE id = ?",
                     (_now_sync(), _now_sync(), c["id"]))
    return {"ok": True}


# ── Objections ───────────────────────────────────────────────────────────────

def _arguable(c: dict) -> None:
    status = c["state"]["status"]
    if status == "REVISED":
        raise HTTPException(409, f"{c['ref']} was replaced by {c['_successor']['ref']} — argue "
                                 "against that one")
    if status == "RETIRED":
        raise HTTPException(409, f"{c['ref']} was retired — the thesis no longer rests on it")


def _insert_objection(conn, c: dict, kind: str, angle: str, argument: str, would_see: str,
                      look_where: str, parent_id: Optional[str] = None) -> dict:
    oid = _uid()
    now = _now_sync()
    conn.execute(
        """INSERT INTO anti_objections (id, ref, claim_id, parent_id, kind, angle, argument,
                                        would_see, look_where, actor, device_id, created_at,
                                        updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (oid, _next_ref(conn, "anti_objections", "A"), c["id"], parent_id, kind, angle, argument,
         would_see, look_where, current_actor(), device_id(), now, now),
    )
    return _get_objection(conn, oid)


def _object(conn, c: dict, body: ObjectionIn) -> dict:
    """Check and insert one objection on an open connection; returns its row."""
    _arguable(c)
    argument = body.argument.strip()
    bad: list[str] = []
    if not argument:
        bad.append("argument: the reason the claim could be false, as one sentence")
    angle = _angle(body.angle or "OTHER", bad)
    if bad:
        raise HTTPException(422, {"code": "OBJECTION_REFUSED", "missing": bad})
    same = next((o for o in c["_objections"] if o["kind"] == "OBJECTION"
                 and _norm(o["argument"]) == _norm(argument)), None)
    if same:
        raise HTTPException(409, f"already raised against {c['ref']}: {same['ref']} — answer it, "
                                 "or continue it with parent=" + same["ref"])
    parent_id = None
    if body.parent:
        parent = _get_objection(conn, body.parent)
        if parent["claim_id"] != c["id"] or parent["kind"] != "OBJECTION":
            raise HTTPException(422, f"parent: {body.parent} is not an objection to {c['ref']}")
        parent_id = parent["id"]
    o = _insert_objection(conn, c, "OBJECTION", angle, argument, body.would_see.strip(),
                          body.look_where.strip(), parent_id)
    if c["thesis_id"]:
        _log_event(conn, c["thesis_id"], "ANTI_OBJECTION",
                   {"claim_id": c["id"], "ref": c["ref"], "objection_id": o["id"],
                    "objection_ref": o["ref"], "angle": angle}, argument)
    return o


def _sweep(conn, c: dict, body: SweepIn) -> dict:
    """Record that an angle was searched for an objection and none was found."""
    _arguable(c)
    bad: list[str] = []
    angle = _angle(body.angle, bad, REQUIRED_ANGLES)
    if not body.searched.strip():
        bad.append("searched: where you looked and what for — an angle nobody searched is "
                   "untried, not clean")
    if bad:
        raise HTTPException(422, {"code": "SWEEP_REFUSED", "missing": bad})
    raised = next((o for o in c["_objections"] if o["kind"] == "OBJECTION" and o["angle"] == angle
                   and not o["withdrawn_at"]), None)
    if raised:
        raise HTTPException(409, f"{c['ref']} already has an objection on {angle}: "
                                 f"{raised['ref']} — answer it instead")
    return _insert_objection(conn, c, "NONE_FOUND", angle, "", "", body.searched.strip())


@router.post("/{claim_id}/objections")
def add_objection(claim_id: str, body: ObjectionIn):
    """Argue against a claim. Only the argument is needed; `would_see` (what we
    would observe if the objection were right) and `look_where` make it
    something that can be checked, and show as a gap until they are there."""
    with get_db() as conn:
        c = _state_of(conn, _get_claim(conn, claim_id)["id"])
        o = _object(conn, c, body)
        return {**_full(conn, c["id"]), "objection_id": o["id"], "objection_ref": o["ref"]}


@router.post("/{claim_id}/sweeps")
def add_sweep(claim_id: str, body: SweepIn):
    """Say that one angle was searched and gave no objection — with where it was
    searched. Without this, an angle nobody thought about and an angle that came
    up clean look the same."""
    with get_db() as conn:
        c = _state_of(conn, _get_claim(conn, claim_id)["id"])
        _sweep(conn, c, body)
        return _full(conn, c["id"])


@router.patch("/objections/{objection_id}")
def patch_objection(objection_id: str, body: ObjectionPatch):
    """Fill in what an objection would look like if it were right, where to
    look, or its angle. The argument itself is never edited — withdraw it and
    raise the better one."""
    updates = {k: v.strip() for k, v in body.model_dump(exclude_unset=True).items()
               if isinstance(v, str)}
    with get_db() as conn:
        o = _get_objection(conn, objection_id)
        if o["kind"] != "OBJECTION":
            raise HTTPException(400, "a none-found record is not edited — record the search again")
        bad: list[str] = []
        if "angle" in updates:
            updates["angle"] = _angle(updates["angle"], bad)
        if bad:
            raise HTTPException(422, {"code": "OBJECTION_REFUSED", "missing": bad})
        diff = {k: v for k, v in updates.items() if o[k] != v}
        if not diff:
            raise HTTPException(400, "nothing to update")
        sets = ", ".join(f"{k} = ?" for k in diff)
        conn.execute(f"UPDATE anti_objections SET {sets}, updated_at = ? WHERE id = ?",
                     [*diff.values(), _now_sync(), o["id"]])
        return _full(conn, o["claim_id"])


@router.post("/objections/{objection_id}/withdraw")
def withdraw(objection_id: str, body: ReasonIn):
    """Take an objection back — a duplicate, a misreading, the wrong claim. Not
    how a real objection is closed: that takes a rebuttal with evidence."""
    _user_only("withdraw an objection")
    if not body.reason.strip():
        raise HTTPException(422, "a reason is required — why this objection should not have "
                                 "been raised")
    with get_db() as conn:
        o = _get_objection(conn, objection_id)
        conn.execute("UPDATE anti_objections SET withdrawn_at = ?, withdraw_reason = ?, "
                     "updated_at = ? WHERE id = ?",
                     (_now_sync(), body.reason.strip(), _now_sync(), o["id"]))
        return _full(conn, o["claim_id"])


@router.post("/objections/{objection_id}/question")
def to_question(objection_id: str):
    """Send an objection that cannot be settled yet to PORT → TOOLS → QUESTIONS.
    It becomes an ordinary question, answered by the rules of routers/questions.py;
    the objection stays open here until a verdict is given on it."""
    with get_db() as conn:
        o = _get_objection(conn, objection_id)
        c = _state_of(conn, o["claim_id"])
        if o["kind"] != "OBJECTION" or o["withdrawn_at"]:
            raise HTTPException(400, "only a standing objection is sent to the questions")
        alive = questions._book(conn)["by_id"]
        if o["question_id"] not in alive:
            title = f"จริงหรือไม่: {o['argument']}"
            same = next((r for r in conn.execute(
                "SELECT id, title FROM questions WHERE deleted_at IS NULL "
                "AND COALESCE(thesis_id, '') = ?", (c["thesis_id"] or "",))
                if _norm(r["title"]) == _norm(title)), None)
            thought = [f"{c['ref']} เราเชื่อ: {c['statement']}",
                       f"ข้อโต้แย้ง {o['ref']} ({o['angle']})"]
            if o["would_see"]:
                thought.append(f"ถ้าข้อโต้แย้งจริงจะเห็น: {o['would_see']}")
            if o["look_where"]:
                thought.append(f"ดูที่: {o['look_where']}")
            qid = same["id"] if same else questions._create(conn, QuestionIn(
                title=title, thought=" · ".join(thought), thesis_id=c["thesis_id"]))["id"]
            conn.execute("UPDATE anti_objections SET question_id = ?, updated_at = ? WHERE id = ?",
                         (qid, _now_sync(), o["id"]))
        return _full(conn, c["id"])


# ── Verdicts ─────────────────────────────────────────────────────────────────

def _apply(conn, c: dict, o: dict, v: dict) -> Optional[dict]:
    """What a verdict the user stands behind does beyond being recorded. Returns
    the claim that replaced `c`, when the verdict made one."""
    payload = {"claim_id": c["id"], "ref": c["ref"], "objection_id": o["id"],
               "objection_ref": o["ref"], "stake": c["stake"]}
    if v["result"] == "CONCEDED" and v["consequence"] == "REVISE":
        # Two conceded objections can each carry a rewording; the first one
        # accepted made the new claim, and the second argues against that.
        if _state_of(conn, c["id"])["_successor"] is None:
            return _replace(conn, c, v["revised_statement"], v["revised_negation"],
                            f"{o['ref']}: {o['argument']}")
    elif v["result"] == "CONCEDED" and c["thesis_id"]:
        _log_event(conn, c["thesis_id"], "ANTI_FALLEN", payload,
                   f"{c['statement']} — {o['argument']}")
    elif v["result"] == "REBUTTED" and c["thesis_id"]:
        _log_event(conn, c["thesis_id"], "ANTI_REBUTTED", payload,
                   f"{o['argument']} — {v['reasoning']}")
    return None


@router.post("/objections/{objection_id}/verdicts")
def add_verdict(objection_id: str, body: VerdictIn):
    """Say what became of an objection.

    REBUTTED  — it does not hold. Needs evidence: zettel (Z-refs) carrying a url
                and the quoted sentence, none of them in an open conflict.
    CONCEDED  — it holds. `consequence` REVISE (with `revised_statement`: the
                claim as it has to read now) or FALLS (the claim is given up).
    UNDECIDED — searched and cannot tell yet. Needs `searched` and `next_check`.

    A verdict from an agent is a proposal until the user reviews it. Giving a
    new verdict later replaces the standing one and keeps the old."""
    result = (body.result or "").upper()
    with get_db() as conn:
        o = _get_objection(conn, objection_id)
        c = _state_of(conn, o["claim_id"])
        if o["kind"] != "OBJECTION":
            raise HTTPException(400, "a none-found record takes no verdict")
        if o["withdrawn_at"]:
            raise HTTPException(409, f"{o['ref']} was withdrawn")
        _arguable(c)

        bad: list[str] = []
        if result not in VERDICTS:
            bad.append(f"result: one of {list(VERDICTS)}")
        if not body.reasoning.strip():
            bad.append("reasoning: why — in words someone who was not here can follow")
        evidence: list[str] = []
        for ref in body.evidence:
            z = _zettel_brief(conn, ref)
            problem = _evidence_problem(z, f"evidence {ref}")
            # Only a rebuttal has to be checkable by a stranger; elsewhere a
            # zettel is a pointer and merely has to exist.
            if z is None or (result == "REBUTTED" and problem):
                bad.append(problem or f"evidence {ref}: zettel not found")
            else:
                evidence.append(z["id"])
        consequence = (body.consequence or "").upper() or None
        if result == "REBUTTED":
            if not body.evidence:
                bad.append("evidence: at least one zettel (Z-ref) with url + quote — an "
                           "objection is not dismissed on say-so")
            bad += [f"evidence in an open conflict: {x} — resolve it or use other evidence"
                    for x in _open_conflicts(conn, evidence)]
        if result == "CONCEDED":
            if consequence not in CONSEQUENCES:
                bad.append(f"consequence: one of {list(CONSEQUENCES)} — REVISE = the claim "
                           "survives in a narrower wording, FALLS = it is given up")
            elif consequence == "REVISE":
                revised = body.revised_statement.strip()
                if not revised:
                    bad.append("revised_statement: the claim as it has to read now")
                elif _norm(revised) == _norm(c["statement"]):
                    bad.append("revised_statement: the same sentence as before — if nothing "
                               "changes, the objection was not conceded")
        elif consequence or body.revised_statement.strip():
            bad.append("consequence / revised_statement belong to a CONCEDED verdict only")
        if result == "UNDECIDED":
            if not body.searched.strip():
                bad.append("searched: where you looked")
            if not _is_date(body.next_check):
                bad.append("next_check: the day to look again (YYYY-MM-DD)")
        if bad:
            raise HTTPException(422, {"code": "VERDICT_REFUSED", "missing": bad})

        vid = _uid()
        now = _now_sync()
        conn.execute(
            """INSERT INTO anti_verdicts (id, claim_id, objection_id, kind, result, reasoning,
                                          evidence, searched, next_check, consequence,
                                          revised_statement, revised_negation, actor, device_id,
                                          created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (vid, c["id"], o["id"], "VERDICT", result, body.reasoning.strip(),
             json.dumps(evidence), body.searched.strip(),
             body.next_check[:10] if result == "UNDECIDED" else None, consequence,
             body.revised_statement.strip() if consequence == "REVISE" else "",
             body.revised_negation.strip() if consequence == "REVISE" else "",
             current_actor(), device_id(), now, now),
        )
        new = None
        if current_actor() == "user":
            v = dict(conn.execute("SELECT * FROM anti_verdicts WHERE id = ?", (vid,)).fetchone())
            new = _apply(conn, c, o, v)
        out: dict[str, Any] = {**_full(conn, c["id"]), "verdict_id": vid,
                               "proposal": current_actor() != "user"}
        if new is not None:
            out["revised_to"] = _full(conn, new["id"])["claim"]
        return out


@router.post("/verdicts/{verdict_id}/review")
def review_verdict(verdict_id: str, body: ReviewIn):
    _user_only("accept or reject a verdict")
    decision = (body.decision or "").upper()
    if decision not in ("ACCEPTED", "REJECTED"):
        raise HTTPException(422, "decision must be ACCEPTED or REJECTED")
    if decision == "REJECTED" and not body.note.strip():
        raise HTTPException(422, "say why it is rejected — the next attempt needs to know")
    with get_db() as conn:
        row = conn.execute("SELECT * FROM anti_verdicts WHERE id = ? AND kind = 'VERDICT'",
                           (verdict_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "verdict not found")
        v = dict(row)
        o = _get_objection(conn, v["objection_id"])
        c = _state_of(conn, v["claim_id"])
        last = conn.execute(
            "SELECT result FROM anti_verdicts WHERE kind = 'REVIEW' AND target_id = ? "
            "ORDER BY created_at DESC, id DESC LIMIT 1", (verdict_id,)).fetchone()
        if last is not None and last["result"] == decision:
            raise HTTPException(409, f"this verdict was already {decision.lower()}")
        now = _now_sync()
        conn.execute(
            """INSERT INTO anti_verdicts (id, claim_id, objection_id, kind, result, target_id,
                                          reasoning, actor, device_id, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (_uid(), c["id"], o["id"], "REVIEW", decision, verdict_id, body.note.strip(),
             current_actor(), device_id(), now, now),
        )
        new = _apply(conn, c, o, v) if decision == "ACCEPTED" else None
        out: dict[str, Any] = _full(conn, c["id"])
        if new is not None:
            out["revised_to"] = _full(conn, new["id"])["claim"]
        return out


# ── Import ───────────────────────────────────────────────────────────────────

@router.post("/import")
def import_board(body: ImportIn):
    """A whole step back in one transaction: the claims a thesis rests on, each
    with its negation, its opening objections and the angles searched without
    finding one. One refused item and nothing is written."""
    if not body.thesis_id:
        raise HTTPException(422, "thesis_id: the thesis being stepped back from")
    if not body.claims:
        raise HTTPException(422, "claims: at least one belief")
    created = []
    with get_db() as conn:
        for i, item in enumerate(body.claims, 1):
            try:
                c = _create_claim(conn, ClaimIn(**{**item.model_dump(
                    exclude={"objections", "none_found"}), "thesis_id": body.thesis_id}))
                for ob in item.objections:
                    _object(conn, _state_of(conn, c["id"]), ob)
                for sw in item.none_found:
                    _sweep(conn, _state_of(conn, c["id"]), sw)
            except HTTPException as exc:
                raise HTTPException(exc.status_code, {
                    "code": "IMPORT_REFUSED", "item": i, "statement": item.statement,
                    "missing": (exc.detail.get("missing") if isinstance(exc.detail, dict)
                                else [str(exc.detail)])}) from exc
            created.append(c["id"])
        claims = _load(conn, " AND thesis_id = ?", (body.thesis_id,))
        return {"created": [c["ref"] for c in claims if c["id"] in created],
                "counts": _count(claims), "summary": _summary(claims)}


@router.post("/resolve-ref-collisions")
def resolve_ref_collisions():
    """Re-mint C- / A-refs two devices minted independently — see zettel's twin."""
    renamed: list[dict[str, Any]] = []
    with get_db() as conn:
        for table, prefix in (("anti_claims", "C"), ("anti_objections", "A")):
            for (ref,) in conn.execute(
                f"SELECT ref FROM {table} WHERE ref IS NOT NULL GROUP BY ref HAVING COUNT(*) > 1"
            ).fetchall():
                rows = conn.execute(f"SELECT id FROM {table} WHERE ref = ? ORDER BY created_at",
                                    (ref,)).fetchall()
                for row in rows[1:]:
                    new_ref = _next_ref(conn, table, prefix)
                    conn.execute(f"UPDATE {table} SET ref = ?, updated_at = ? WHERE id = ?",
                                 (new_ref, _now_sync(), row["id"]))
                    renamed.append({"id": row["id"], "from": ref, "to": new_ref})
    return {"renamed": renamed, "count": len(renamed)}
