"""
Zettelkasten knowledge base — atomic notes that outlive a single thesis.

Schema + rationale: db.init_zettel_schema(); plan in
memory/plans/zettelkasten-knowledge-base.md.

Three rules the endpoints exist to enforce:

  1. A zettel is one idea, reusable. It is attached to theses/trades/symbols
     through `zettel_refs`, never owned by one of them.
  2. Disagreement is data. Two zettels that clash are joined by a CONTRADICTS
     edge that stays OPEN until someone writes down how it was settled; the
     edge is never deleted, and neither note is.
  3. Nothing is thrown away. Superseding marks the old note `superseded` and
     leaves it readable — the point of the archive is being able to retrace how
     the thinking moved.

Every write that touches a thesis also writes a `thesis_events` row, so the
THESES timeline stays the single place where a thesis's whole story is visible.
"""
import re
import sqlite3
import uuid
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from actor import capture_actor, current_actor
from config import OBSIDIAN_WIKI_DIR
from db import get_db, zettel_fts_available
from routers.theses import _log_event
from sync.config import device_id

router = APIRouter(prefix="/api/v2/zettel", dependencies=[Depends(capture_actor)])

VALID_KIND = {"CLAIM", "EVIDENCE", "QUESTION", "MECHANISM", "DEFINITION", "SOURCE_NOTE"}
VALID_STATUS = {"open", "settled", "superseded", "retracted"}
VALID_STANCE = {"bull", "bear", "neutral"}
VALID_REL = {"SUPPORTS", "CONTRADICTS", "REFINES", "SUPERSEDES", "FOLLOWS_FROM", "CONTEXT"}
VALID_RELIABILITY = {"primary", "secondary", "rumor"}
VALID_TARGET = {"thesis", "trade", "symbol"}

EDITABLE = ("kind", "title", "body", "stance", "confidence", "status", "tags", "occurred_at")


def _uid() -> str:
    return str(uuid.uuid4())


def _now() -> str:
    return datetime.utcnow().isoformat()


def _now_sync() -> str:
    """`updated_at` in the format the sync triggers write (space + millis).

    The merge compares these as plain strings, so an ISO 'T' stamp inserted here
    would out-rank every later trigger-written update. Same reasoning as
    routers/theses._now_sync.
    """
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%f")[:-3]


def _clamp_1_5(v: Optional[int]) -> Optional[int]:
    return None if v is None else max(1, min(5, int(v)))


def _norm_title(t: str) -> str:
    """Duplicate check key: case- and whitespace-insensitive."""
    return re.sub(r"\s+", " ", (t or "").strip()).lower()


def _next_ref(conn) -> str:
    """Z-0001, Z-0002, … — a label humans quote, minted per device.

    Two offline devices can mint the same number; `ref` is therefore indexed but
    NOT unique, and `resolve_ref_collisions` renames the later arrival after a
    merge. A UNIQUE constraint here would make the whole import fail instead.
    """
    row = conn.execute(
        "SELECT MAX(CAST(SUBSTR(ref, 3) AS INTEGER)) FROM zettel "
        "WHERE ref LIKE 'Z-%' AND SUBSTR(ref, 3) GLOB '[0-9]*'"
    ).fetchone()
    return f"Z-{((row[0] or 0) + 1):04d}"


def _validate(kind=None, status=None, stance=None, reliability=None, rel=None) -> None:
    if kind is not None and kind.upper() not in VALID_KIND:
        raise HTTPException(400, f"kind must be one of {sorted(VALID_KIND)}")
    if status is not None and status not in VALID_STATUS:
        raise HTTPException(400, f"status must be one of {sorted(VALID_STATUS)}")
    if stance not in (None, "") and stance not in VALID_STANCE:
        raise HTTPException(400, f"stance must be one of {sorted(VALID_STANCE)}")
    if reliability is not None and reliability not in VALID_RELIABILITY:
        raise HTTPException(400, f"reliability must be one of {sorted(VALID_RELIABILITY)}")
    if rel is not None and rel.upper() not in VALID_REL:
        raise HTTPException(400, f"rel must be one of {sorted(VALID_REL)}")


def _get(conn, zettel_id: str) -> dict:
    row = conn.execute(
        "SELECT * FROM zettel WHERE id = ? OR ref = ?", (zettel_id, zettel_id)
    ).fetchone()
    if row is None:
        raise HTTPException(404, f"zettel {zettel_id} not found")
    return dict(row)


def _sources_for(conn, zettel_id: str) -> list[dict]:
    return [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM zettel_sources WHERE zettel_id = ? "
            "ORDER BY COALESCE(published_at, created_at) DESC",
            (zettel_id,),
        ).fetchall()
    ]


def _refs_for(conn, zettel_id: str) -> list[dict]:
    """Attachments, with the thesis title joined in so a caller can render them."""
    rows = [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM zettel_refs WHERE zettel_id = ?", (zettel_id,)
        ).fetchall()
    ]
    for r in rows:
        if r["target_type"] == "thesis":
            t = conn.execute(
                "SELECT symbol, title FROM theses WHERE id = ?", (r["target_id"],)
            ).fetchone()
            if t:
                r["symbol"] = t["symbol"]
                r["thesis_title"] = t["title"]
    return rows


def _edges_for(conn, zettel_id: str) -> dict:
    """Both directions. `out` = this note points at others, `in` = backlinks."""
    sql = """SELECT e.*, z.ref AS other_ref, z.title AS other_title, z.kind AS other_kind,
                    z.status AS other_status
             FROM zettel_edges e JOIN zettel z ON z.id = e.{join}
             WHERE e.{where} = ? ORDER BY e.created_at DESC"""
    out = [dict(r) for r in conn.execute(sql.format(join="dst_id", where="src_id"), (zettel_id,))]
    inc = [dict(r) for r in conn.execute(sql.format(join="src_id", where="dst_id"), (zettel_id,))]
    return {"out": out, "in": inc}


def _thesis_ids_for(conn, zettel_id: str) -> list[str]:
    return [
        r["target_id"]
        for r in conn.execute(
            "SELECT target_id FROM zettel_refs WHERE zettel_id = ? AND target_type = 'thesis'",
            (zettel_id,),
        ).fetchall()
    ]


def _log_to_theses(conn, zettel_ids, event_type: str, payload: dict, note: str) -> None:
    """Mirror a knowledge-base action into the timeline of every thesis it touches.

    Without this the HISTORY tab tells half the story: the thesis looks untouched
    while the evidence under it moved.

    Takes one id or several: both sides of a conflict usually hang off the SAME
    thesis, and logging per side would double every CONFLICT entry in its timeline.
    """
    if isinstance(zettel_ids, str):
        zettel_ids = [zettel_ids]
    seen: list[str] = []
    for zid in zettel_ids:
        for tid in _thesis_ids_for(conn, zid):
            if tid not in seen:
                seen.append(tid)
    for tid in seen:
        _log_event(conn, tid, event_type, payload, note)


# ── Models ───────────────────────────────────────────────────────────────────

class SourceIn(BaseModel):
    url: str = ""
    publisher: str = ""
    title: str = ""
    published_at: Optional[str] = None
    quote: str = ""
    reliability: str = "secondary"


class ZettelIn(BaseModel):
    kind: str = "CLAIM"
    title: str
    body: str = ""
    stance: Optional[str] = None
    confidence: Optional[int] = None
    status: str = "open"
    tags: str = ""
    occurred_at: Optional[str] = None
    sources: list[SourceIn] = []
    thesis_id: Optional[str] = None
    symbol: Optional[str] = None


class ZettelPatch(BaseModel):
    kind: Optional[str] = None
    title: Optional[str] = None
    body: Optional[str] = None
    stance: Optional[str] = None
    confidence: Optional[int] = None
    status: Optional[str] = None
    tags: Optional[str] = None
    occurred_at: Optional[str] = None
    reason: str = ""


class EdgeIn(BaseModel):
    src_id: str
    dst_id: str
    rel: str
    note: str = ""


class EdgePatch(BaseModel):
    resolution: str
    superseded_id: Optional[str] = None


class RefIn(BaseModel):
    target_type: str = "thesis"
    target_id: str
    role: str = ""


# ── Zettel CRUD ──────────────────────────────────────────────────────────────

@router.get("")
def list_zettel(
    kind: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    stance: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    thesis_id: Optional[str] = Query(None),
    symbol: Optional[str] = Query(None),
    actor: Optional[str] = Query(None),
    include_deleted: bool = Query(False),
    limit: int = Query(200),
):
    where: list[str] = []
    params: list[Any] = []
    if not include_deleted:
        where.append("z.deleted_at IS NULL")
    for col, val in (("kind", kind), ("status", status), ("stance", stance)):
        if val:
            where.append(f"z.{col} = ?")
            params.append(val)
    if actor:
        where.append("z.actor = ?" if actor != "agent" else "z.actor LIKE 'agent:%'")
        if actor != "agent":
            params.append(actor)
    if tag:
        where.append("(',' || REPLACE(z.tags, ' ', '') || ',') LIKE ?")
        params.append(f"%,{tag.strip()},%")
    if thesis_id or symbol:
        where.append(
            "EXISTS (SELECT 1 FROM zettel_refs r WHERE r.zettel_id = z.id AND "
            + ("r.target_type = 'thesis' AND r.target_id = ?" if thesis_id
               else "r.target_type = 'symbol' AND UPPER(r.target_id) = ?")
            + ")"
        )
        params.append(thesis_id or (symbol or "").upper())

    sql = "SELECT z.* FROM zettel z"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY COALESCE(z.occurred_at, z.created_at) DESC LIMIT ?"
    params.append(limit)

    with get_db() as conn:
        rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
        # Counters the list view needs: how well-sourced a note is, and whether
        # it is currently in dispute.
        for r in rows:
            r["source_count"] = conn.execute(
                "SELECT COUNT(*) FROM zettel_sources WHERE zettel_id = ?", (r["id"],)
            ).fetchone()[0]
            r["open_conflicts"] = conn.execute(
                "SELECT COUNT(*) FROM zettel_edges WHERE rel = 'CONTRADICTS' "
                "AND resolved_at IS NULL AND (src_id = ? OR dst_id = ?)",
                (r["id"], r["id"]),
            ).fetchone()[0]
    return {"zettel": rows}


@router.get("/search")
def search_zettel(q: str = Query(..., min_length=1), limit: int = Query(30)):
    """Full-text search. Trigram FTS5 when available (matches inside Thai text),
    LIKE otherwise."""
    term = q.strip()
    with get_db() as conn:
        if zettel_fts_available():
            try:
                rows = [
                    dict(r)
                    for r in conn.execute(
                        """SELECT z.*, snippet(zettel_fts, 1, '«', '»', '…', 12) AS snippet
                           FROM zettel_fts f JOIN zettel z ON z.rowid = f.rowid
                           WHERE zettel_fts MATCH ? AND z.deleted_at IS NULL
                           ORDER BY rank LIMIT ?""",
                        (term, limit),
                    ).fetchall()
                ]
                return {"zettel": rows, "engine": "fts5"}
            except sqlite3.OperationalError:
                # Malformed MATCH expression (a bare quote, an operator) — fall
                # through to LIKE rather than 500 on a user's search box.
                pass
        like = f"%{term}%"
        rows = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM zettel WHERE deleted_at IS NULL AND "
                "(title LIKE ? OR body LIKE ? OR tags LIKE ?) "
                "ORDER BY COALESCE(occurred_at, created_at) DESC LIMIT ?",
                (like, like, like, limit),
            ).fetchall()
        ]
    return {"zettel": rows, "engine": "like"}


@router.get("/conflicts")
def list_conflicts(
    thesis_id: Optional[str] = Query(None),
    include_resolved: bool = Query(False),
    limit: int = Query(100),
):
    """Contradictions the book is carrying — the queue to triage.

    Both sides come back in full so a caller can judge without a second fetch.
    """
    sql = """SELECT e.*,
                    a.ref AS src_ref, a.title AS src_title, a.kind AS src_kind,
                    a.stance AS src_stance, a.status AS src_status,
                    a.occurred_at AS src_occurred_at, a.actor AS src_actor,
                    b.ref AS dst_ref, b.title AS dst_title, b.kind AS dst_kind,
                    b.stance AS dst_stance, b.status AS dst_status,
                    b.occurred_at AS dst_occurred_at, b.actor AS dst_actor
             FROM zettel_edges e
             JOIN zettel a ON a.id = e.src_id
             JOIN zettel b ON b.id = e.dst_id
             WHERE e.rel = 'CONTRADICTS'"""
    params: list[Any] = []
    if not include_resolved:
        sql += " AND e.resolved_at IS NULL"
    if thesis_id:
        sql += (" AND EXISTS (SELECT 1 FROM zettel_refs r WHERE r.target_type = 'thesis' "
                "AND r.target_id = ? AND r.zettel_id IN (e.src_id, e.dst_id))")
        params.append(thesis_id)
    sql += " ORDER BY e.resolved_at IS NOT NULL, e.created_at DESC LIMIT ?"
    params.append(limit)
    with get_db() as conn:
        rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    return {"conflicts": rows, "open_count": sum(1 for r in rows if not r["resolved_at"])}


@router.get("/graph")
def graph(
    thesis_id: Optional[str] = Query(None),
    root_id: Optional[str] = Query(None),
    depth: int = Query(2, ge=1, le=4),
):
    """Nodes + edges for the graph view, walked breadth-first from a seed set."""
    with get_db() as conn:
        if root_id:
            seeds = [_get(conn, root_id)["id"]]
        elif thesis_id:
            seeds = [
                r["zettel_id"]
                for r in conn.execute(
                    "SELECT zettel_id FROM zettel_refs "
                    "WHERE target_type = 'thesis' AND target_id = ?",
                    (thesis_id,),
                ).fetchall()
            ]
        else:
            seeds = [
                r["id"]
                for r in conn.execute(
                    "SELECT id FROM zettel WHERE deleted_at IS NULL "
                    "ORDER BY COALESCE(occurred_at, created_at) DESC LIMIT 60"
                ).fetchall()
            ]

        seen: set[str] = set(seeds)
        frontier = list(seeds)
        edges: dict[str, dict] = {}
        for _ in range(depth):
            if not frontier:
                break
            marks = ",".join("?" * len(frontier))
            rows = conn.execute(
                f"SELECT * FROM zettel_edges WHERE src_id IN ({marks}) OR dst_id IN ({marks})",
                [*frontier, *frontier],
            ).fetchall()
            nxt: list[str] = []
            for r in rows:
                e = dict(r)
                edges[e["id"]] = e
                for side in (e["src_id"], e["dst_id"]):
                    if side not in seen:
                        seen.add(side)
                        nxt.append(side)
            frontier = nxt

        nodes = []
        if seen:
            marks = ",".join("?" * len(seen))
            nodes = [
                dict(r)
                for r in conn.execute(
                    f"SELECT id, ref, kind, title, stance, status, actor FROM zettel "
                    f"WHERE id IN ({marks})",
                    list(seen),
                ).fetchall()
            ]
    return {"nodes": nodes, "edges": list(edges.values())}


@router.get("/{zettel_id}")
def get_zettel(zettel_id: str):
    with get_db() as conn:
        z = _get(conn, zettel_id)
        return {
            "zettel": z,
            "sources": _sources_for(conn, z["id"]),
            "edges": _edges_for(conn, z["id"]),
            "refs": _refs_for(conn, z["id"]),
        }


@router.post("")
def create_zettel(body: ZettelIn):
    _validate(kind=body.kind, status=body.status, stance=body.stance)
    if not body.title.strip():
        raise HTTPException(400, "a zettel needs a title — one sentence stating the idea")
    if body.kind.upper() == "EVIDENCE" and not body.sources:
        raise HTTPException(400, "an EVIDENCE zettel needs at least one source")
    for s in body.sources:
        _validate(reliability=s.reliability)

    zid = _uid()
    now = _now_sync()
    who = current_actor()
    with get_db() as conn:
        # Re-jotting the same idea is the failure mode of a shared notebook:
        # hand the caller the existing note instead so they extend it.
        dup = next(
            (
                dict(r)
                for r in conn.execute(
                    "SELECT id, ref, title FROM zettel WHERE deleted_at IS NULL"
                ).fetchall()
                if _norm_title(r["title"]) == _norm_title(body.title)
            ),
            None,
        )
        if dup:
            raise HTTPException(
                409,
                f"a zettel with this title already exists: {dup['ref']} ({dup['id']}) — "
                "add a source to it, or link a new note with REFINES/CONTRADICTS",
            )

        conn.execute(
            """INSERT INTO zettel (id, ref, kind, title, body, stance, confidence, status,
                                   tags, actor, occurred_at, device_id, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                zid, _next_ref(conn), body.kind.upper(), body.title.strip(), body.body,
                body.stance or None, _clamp_1_5(body.confidence), body.status,
                body.tags.strip(), who, body.occurred_at or _now(), device_id(), now, now,
            ),
        )
        for s in body.sources:
            _insert_source(conn, zid, s, who)
        if body.thesis_id:
            _attach(conn, zid, "thesis", body.thesis_id)
        if body.symbol:
            _attach(conn, zid, "symbol", body.symbol.upper())

        z = _get(conn, zid)
        _log_to_theses(
            conn, zid, "ZETTEL_ADDED",
            {"zettel_id": zid, "ref": z["ref"], "kind": z["kind"], "stance": z["stance"]},
            z["title"],
        )
        return {"zettel": z, "sources": _sources_for(conn, zid), "refs": _refs_for(conn, zid)}


@router.patch("/{zettel_id}")
def patch_zettel(zettel_id: str, body: ZettelPatch):
    _validate(kind=body.kind, status=body.status, stance=body.stance)
    updates = {k: v for k, v in body.model_dump(exclude_unset=True).items() if k in EDITABLE}
    if not updates:
        raise HTTPException(400, "nothing to update")
    if "kind" in updates and updates["kind"]:
        updates["kind"] = str(updates["kind"]).upper()
    if "confidence" in updates:
        updates["confidence"] = _clamp_1_5(updates["confidence"])
    if "stance" in updates and updates["stance"] == "":
        updates["stance"] = None

    with get_db() as conn:
        before = _get(conn, zettel_id)
        zid = before["id"]
        diff = {k: {"from": before.get(k), "to": v} for k, v in updates.items()
                if before.get(k) != v}
        if not diff:
            return {"zettel": before, "changed": []}
        sets = ", ".join(f"{k} = ?" for k in diff)
        conn.execute(
            f"UPDATE zettel SET {sets}, updated_at = ? WHERE id = ?",
            [*[updates[k] for k in diff], _now_sync(), zid],
        )
        # Only a change of meaning reaches the thesis timeline; fixing a typo in
        # the body does not.
        if {"status", "stance", "title", "confidence"} & set(diff):
            _log_to_theses(
                conn, zid, "ZETTEL_CHANGED",
                {"zettel_id": zid, "ref": before["ref"], **diff},
                body.reason or before["title"],
            )
        return {"zettel": _get(conn, zid), "changed": sorted(diff)}


@router.delete("/{zettel_id}")
def delete_zettel(zettel_id: str):
    """Soft only. Edges are deliberately left in place: 'what did this once
    contradict' is exactly the question the archive exists to answer."""
    with get_db() as conn:
        z = _get(conn, zettel_id)
        conn.execute(
            "UPDATE zettel SET deleted_at = ?, updated_at = ? WHERE id = ?",
            (_now(), _now_sync(), z["id"]),
        )
        _log_to_theses(conn, z["id"], "ZETTEL_REMOVED",
                       {"zettel_id": z["id"], "ref": z["ref"]}, z["title"])
    return {"ok": True}


@router.post("/{zettel_id}/restore")
def restore_zettel(zettel_id: str):
    with get_db() as conn:
        z = _get(conn, zettel_id)
        conn.execute(
            "UPDATE zettel SET deleted_at = NULL, updated_at = ? WHERE id = ?",
            (_now_sync(), z["id"]),
        )
        return {"zettel": _get(conn, z["id"])}


# ── Sources ──────────────────────────────────────────────────────────────────

def _insert_source(conn, zettel_id: str, s: SourceIn, who: str) -> str:
    sid = _uid()
    now = _now_sync()
    conn.execute(
        """INSERT INTO zettel_sources (id, zettel_id, url, publisher, title, published_at,
                                       quote, reliability, retrieved_at, actor, device_id,
                                       created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (sid, zettel_id, s.url.strip(), s.publisher.strip(), s.title.strip(),
         s.published_at or None, s.quote, s.reliability, _now(), who, device_id(), now, now),
    )
    return sid


@router.post("/{zettel_id}/sources")
def add_source(zettel_id: str, body: SourceIn):
    _validate(reliability=body.reliability)
    if not (body.url.strip() or body.quote.strip() or body.title.strip()):
        raise HTTPException(400, "a source needs at least a url, a title or a quote")
    with get_db() as conn:
        z = _get(conn, zettel_id)
        sid = _insert_source(conn, z["id"], body, current_actor())
        return {"source": dict(
            conn.execute("SELECT * FROM zettel_sources WHERE id = ?", (sid,)).fetchone()
        )}


@router.delete("/sources/{source_id}")
def delete_source(source_id: str):
    with get_db() as conn:
        conn.execute("DELETE FROM zettel_sources WHERE id = ?", (source_id,))
    return {"ok": True}


@router.get("/sources/by-url")
def zettel_by_source(url: str = Query(..., min_length=3)):
    """Every claim resting on one story — what you need when a source is
    corrected or retracted."""
    with get_db() as conn:
        rows = [
            dict(r)
            for r in conn.execute(
                """SELECT z.*, s.url, s.publisher, s.published_at, s.reliability
                   FROM zettel_sources s JOIN zettel z ON z.id = s.zettel_id
                   WHERE s.url LIKE ? AND z.deleted_at IS NULL
                   ORDER BY COALESCE(z.occurred_at, z.created_at) DESC""",
                (f"%{url.strip()}%",),
            ).fetchall()
        ]
    return {"zettel": rows}


# ── Edges ────────────────────────────────────────────────────────────────────

def _create_edge(conn, src_id: str, dst_id: str, rel: str, note: str = "") -> dict:
    """Takes an open connection: resolve_edge draws a SUPERSEDES link while it
    still holds one, and a second get_db() there deadlocks against its own write."""
    _validate(rel=rel)
    rel = rel.upper()
    src = _get(conn, src_id)
    dst = _get(conn, dst_id)
    if src["id"] == dst["id"]:
        raise HTTPException(400, "a zettel cannot link to itself")
    existing = conn.execute(
        "SELECT * FROM zettel_edges WHERE src_id = ? AND dst_id = ? AND rel = ?",
        (src["id"], dst["id"], rel),
    ).fetchone()
    if existing:
        return {"edge": dict(existing), "created": False}

    eid = _uid()
    now = _now_sync()
    conn.execute(
        """INSERT INTO zettel_edges (id, src_id, dst_id, rel, note, actor, device_id,
                                     created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (eid, src["id"], dst["id"], rel, note, current_actor(), device_id(), now, now),
    )
    # SUPERSEDES is the one relation that changes the other note's standing: the
    # old reading stays readable but stops counting as current.
    if rel == "SUPERSEDES" and dst["status"] != "superseded":
        conn.execute(
            "UPDATE zettel SET status = 'superseded', updated_at = ? WHERE id = ?",
            (_now_sync(), dst["id"]),
        )
    if rel == "CONTRADICTS":
        _log_to_theses(
            conn, (src["id"], dst["id"]), "CONFLICT_OPENED",
            {"edge_id": eid, "src": src["ref"], "dst": dst["ref"]},
            f"{src['title']}  ⟂  {dst['title']}",
        )
    edge = dict(conn.execute("SELECT * FROM zettel_edges WHERE id = ?", (eid,)).fetchone())
    return {"edge": edge, "created": True}


@router.post("/edges")
def create_edge(body: EdgeIn):
    with get_db() as conn:
        return _create_edge(conn, body.src_id, body.dst_id, body.rel, body.note)


@router.patch("/edges/{edge_id}")
def resolve_edge(edge_id: str, body: EdgePatch):
    """Close a contradiction by writing down how it was settled.

    The edge itself is never rewritten beyond this — append-only is what lets two
    devices resolve independently without racing.
    """
    if not body.resolution.strip():
        raise HTTPException(400, "a resolution is required — what settled it, and why")
    with get_db() as conn:
        row = conn.execute("SELECT * FROM zettel_edges WHERE id = ?", (edge_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "edge not found")
        edge = dict(row)
        if edge["rel"] != "CONTRADICTS":
            raise HTTPException(400, "only a CONTRADICTS edge can be resolved")
        conn.execute(
            "UPDATE zettel_edges SET resolved_at = ?, resolution = ?, updated_at = ? WHERE id = ?",
            (_now(), body.resolution.strip(), _now_sync(), edge_id),
        )
        if body.superseded_id:
            loser = _get(conn, body.superseded_id)
            if loser["id"] not in (edge["src_id"], edge["dst_id"]):
                raise HTTPException(400, "superseded_id must be one side of this conflict")
            winner = edge["dst_id"] if loser["id"] == edge["src_id"] else edge["src_id"]
            _create_edge(conn, winner, loser["id"], "SUPERSEDES", body.resolution.strip())
        _log_to_theses(conn, (edge["src_id"], edge["dst_id"]), "CONFLICT_RESOLVED",
                       {"edge_id": edge_id}, body.resolution.strip())
        out = dict(conn.execute("SELECT * FROM zettel_edges WHERE id = ?", (edge_id,)).fetchone())
    return {"edge": out}


@router.delete("/edges/{edge_id}")
def delete_edge(edge_id: str):
    """Only for a mis-drawn link. A settled disagreement is resolved, not erased."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM zettel_edges WHERE id = ?", (edge_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "edge not found")
        if row["resolved_at"]:
            raise HTTPException(400, "a resolved conflict is part of the record — keep it")
        conn.execute("DELETE FROM zettel_edges WHERE id = ?", (edge_id,))
    return {"ok": True}


@router.get("/{zettel_id}/backlinks")
def backlinks(zettel_id: str):
    with get_db() as conn:
        z = _get(conn, zettel_id)
        return {"zettel_id": z["id"], "ref": z["ref"], **_edges_for(conn, z["id"])}


# ── Attachments (thesis / trade / symbol) ────────────────────────────────────

def _attach(conn, zettel_id: str, target_type: str, target_id: str, role: str = "") -> None:
    if target_type not in VALID_TARGET:
        raise HTTPException(400, f"target_type must be one of {sorted(VALID_TARGET)}")
    if target_type == "thesis":
        if conn.execute("SELECT 1 FROM theses WHERE id = ?", (target_id,)).fetchone() is None:
            raise HTTPException(404, f"thesis {target_id} not found")
    now = _now_sync()
    conn.execute(
        "INSERT OR REPLACE INTO zettel_refs (zettel_id, target_type, target_id, role, "
        "device_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        (zettel_id, target_type, target_id, role, device_id(), now, now),
    )


@router.post("/{zettel_id}/refs")
def add_ref(zettel_id: str, body: RefIn):
    with get_db() as conn:
        z = _get(conn, zettel_id)
        target = body.target_id.upper() if body.target_type == "symbol" else body.target_id
        _attach(conn, z["id"], body.target_type, target, body.role)
        if body.target_type == "thesis":
            _log_event(conn, target, "ZETTEL_LINKED",
                       {"zettel_id": z["id"], "ref": z["ref"], "kind": z["kind"]}, z["title"])
        return {"refs": _refs_for(conn, z["id"])}


@router.delete("/{zettel_id}/refs/{target_type}/{target_id}")
def remove_ref(zettel_id: str, target_type: str, target_id: str):
    with get_db() as conn:
        z = _get(conn, zettel_id)
        conn.execute(
            "DELETE FROM zettel_refs WHERE zettel_id = ? AND target_type = ? AND target_id = ?",
            (z["id"], target_type, target_id),
        )
    return {"ok": True}


# ── Post-merge housekeeping ─────────────────────────────────────────────────

@router.post("/resolve-ref-collisions")
def resolve_ref_collisions():
    """Re-mint `ref` labels that two devices minted independently.

    `ref` is not unique in the schema on purpose (a UNIQUE index would abort the
    whole sync import). After a merge, the oldest row keeps the number and later
    ones move to the end of the sequence.
    """
    renamed: list[dict] = []
    with get_db() as conn:
        dups = [
            r["ref"]
            for r in conn.execute(
                "SELECT ref FROM zettel WHERE ref IS NOT NULL GROUP BY ref HAVING COUNT(*) > 1"
            ).fetchall()
        ]
        for ref in dups:
            rows = conn.execute(
                "SELECT id, ref, created_at FROM zettel WHERE ref = ? ORDER BY created_at ASC",
                (ref,),
            ).fetchall()
            for row in rows[1:]:
                new_ref = _next_ref(conn)
                conn.execute(
                    "UPDATE zettel SET ref = ?, updated_at = ? WHERE id = ?",
                    (new_ref, _now_sync(), row["id"]),
                )
                renamed.append({"id": row["id"], "from": ref, "to": new_ref})
    return {"renamed": renamed, "count": len(renamed)}


# ── Obsidian export (one-way: the DB stays authoritative) ────────────────────

_UNSAFE = re.compile(r"[^0-9A-Za-z฀-๿._-]+")

REL_ARROW = {
    "SUPPORTS": "SUPPORTS", "CONTRADICTS": "CONTRADICTS", "REFINES": "REFINES",
    "SUPERSEDES": "SUPERSEDES", "FOLLOWS_FROM": "FOLLOWS FROM", "CONTEXT": "CONTEXT",
}


def _slug(title: str, limit: int = 60) -> str:
    """Filename-safe, Thai kept. Obsidian links break on a renamed file, so this
    has to stay stable for a given title."""
    return _UNSAFE.sub("-", (title or "").strip()).strip("-")[:limit] or "note"


def _note_filename(z: dict) -> str:
    return f"{z['ref']}-{_slug(z['title'])}.md"


def _yaml_list(values: list[str]) -> str:
    return "[" + ", ".join(v.replace("]", "") for v in values) + "]"


def _render_note(conn, z: dict) -> str:
    """One zettel as an Obsidian page. `## Links` is what makes the vault's graph
    view draw the argument — Obsidian reads [[wikilinks]], so the edges we keep in
    SQL become a picture there without us drawing one."""
    sources = _sources_for(conn, z["id"])
    edges = _edges_for(conn, z["id"])
    refs = _refs_for(conn, z["id"])
    symbols = sorted({r.get("symbol") or r["target_id"] for r in refs
                      if r["target_type"] in ("thesis", "symbol")})

    fm = [
        "---",
        f"ref: {z['ref']}",
        f"kind: {z['kind']}",
        f"status: {z['status']}",
        f"actor: {z['actor']}",
    ]
    if z.get("stance"):
        fm.append(f"stance: {z['stance']}")
    if z.get("confidence") is not None:
        fm.append(f"confidence: {z['confidence']}")
    if z.get("occurred_at"):
        fm.append(f"occurred_at: {str(z['occurred_at'])[:10]}")
    if z.get("tags"):
        fm.append("tags: " + _yaml_list(
            [t.strip() for t in str(z["tags"]).split(",") if t.strip()]
        ))
    if symbols:
        fm.append("theses: " + _yaml_list(symbols))
    fm.append(f"updated_at: {z['updated_at']}")
    fm.append("---")

    parts = ["\n".join(fm), "", f"# {z['title']}", "", (z.get("body") or "").strip(), ""]

    if sources:
        parts.append("## Sources")
        for s in sources:
            label = s["publisher"] or s["title"] or s["url"] or "source"
            line = f"- [{label}]({s['url']})" if s["url"] else f"- {label}"
            meta = " · ".join(x for x in (str(s["published_at"] or "")[:10], s["reliability"]) if x)
            parts.append(f"{line}{f' — {meta}' if meta else ''}")
            if s["quote"]:
                parts.append(f"  > {s['quote']}")
        parts.append("")

    out, inc = edges["out"], edges["in"]
    if out or inc:
        parts.append("## Links")
        for e in out:
            state = "" if not e["resolved_at"] else "  ✔ resolved"
            why = f" — {e['note']}" if e["note"] else ""
            parts.append(
                f"- {REL_ARROW.get(e['rel'], e['rel'])} "
                f"[[{e['other_ref']}-{_slug(e['other_title'])}]]{why}{state}"
            )
            if e["resolution"]:
                parts.append(f"  > {e['resolution']}")
        for e in inc:
            parts.append(
                f"- ← {REL_ARROW.get(e['rel'], e['rel'])} from "
                f"[[{e['other_ref']}-{_slug(e['other_title'])}]]"
            )
        parts.append("")

    return "\n".join(parts).rstrip() + "\n"


def _render_index(conn, notes: list[dict], conflicts: list[dict]) -> str:
    lines = [
        "---", "title: Zettelkasten index", f"updated_at: {_now()}", "---", "",
        "# Zettelkasten", "",
        "Exported from the Bloomberg Terminal knowledge base. **The database is the",
        "source of truth** — edits made here are overwritten on the next export.", "",
    ]
    if conflicts:
        lines += ["## ⚠️ Open conflicts", ""]
        for c in conflicts:
            why = f" — {c['note']}" if c["note"] else ""
            lines.append(
                f"- [[{c['src_ref']}-{_slug(c['src_title'])}]] "
                f"⟂ [[{c['dst_ref']}-{_slug(c['dst_title'])}]]{why}"
            )
        lines.append("")
    lines += ["## Notes", ""]
    for z in notes:
        flags = " ".join(x for x in (z["kind"], z.get("stance") or "", z["status"]) if x)
        lines.append(f"- [[{z['ref']}-{_slug(z['title'])}]] — {z['title']}  `{flags}`")
    return "\n".join(lines) + "\n"


@router.post("/export-md")
def export_markdown(include_deleted: bool = Query(False)):
    """Write the whole base to `OBSIDIAN_WIKI_DIR/zettel/` as linked markdown.

    One-way by design: Obsidian gets a readable, graph-able mirror, while every
    write keeps going through the API so the event log and the device sync stay
    the only path that changes anything.
    """
    out_dir = OBSIDIAN_WIKI_DIR / "zettel"
    out_dir.mkdir(parents=True, exist_ok=True)
    root = out_dir.resolve()

    written: list[str] = []
    with get_db() as conn:
        sql = "SELECT * FROM zettel"
        if not include_deleted:
            sql += " WHERE deleted_at IS NULL"
        sql += " ORDER BY ref"
        notes = [dict(r) for r in conn.execute(sql).fetchall()]
        for z in notes:
            path = (out_dir / _note_filename(z)).resolve()
            # `ref` and the slug are derived from user text; keep the write inside
            # the vault folder no matter what ends up in a title.
            if root not in path.parents:
                continue
            path.write_text(_render_note(conn, z), encoding="utf-8")
            written.append(path.name)

        conflicts = [
            dict(r)
            for r in conn.execute(
                """SELECT e.note, a.ref AS src_ref, a.title AS src_title,
                          b.ref AS dst_ref, b.title AS dst_title
                   FROM zettel_edges e
                   JOIN zettel a ON a.id = e.src_id
                   JOIN zettel b ON b.id = e.dst_id
                   WHERE e.rel = 'CONTRADICTS' AND e.resolved_at IS NULL
                   ORDER BY e.created_at DESC"""
            ).fetchall()
        ]
        (out_dir / "INDEX.md").write_text(_render_index(conn, notes, conflicts), encoding="utf-8")

    # Files the DB no longer knows about (a note renamed, or purged elsewhere)
    # would otherwise linger in the vault and keep showing up in its graph.
    stale = [
        p.name for p in out_dir.glob("*.md")
        if p.name != "INDEX.md" and p.name not in written
    ]
    return {
        "written": len(written), "dir": str(out_dir),
        "index": "INDEX.md", "open_conflicts": len(conflicts), "stale": stale,
    }
