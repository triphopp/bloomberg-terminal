"""
Read marks — what the user has looked at, and what has changed since.

Most of what lands in a thesis is written by an agent: notes, zettel, answers,
research pages, tracked readings. Without a mark there is no way to tell the
forty things already checked from the three that arrived overnight.

Only the moment of reading is stored (`read_marks.seen_at`). Unread is derived
on read:

  * never marked  → unread, unless the user wrote it themselves
  * marked        → unread again once the thing's own timestamp passes seen_at

so an item edited after it was read comes back by itself, and there is no
status column to drift between devices. Only the user marks: an agent calling
these endpoints is refused, and opening a page does not count as reading it.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from actor import capture_actor, is_agent
from db import get_db
from sync.config import device_id

router = APIRouter(prefix="/api/v2/reads", dependencies=[Depends(capture_actor)])

TYPES = ("thesis", "note", "zettel", "answer", "graph", "reading")

# type → rows of (id, thesis_id, parent_id, actor, stamp). `parent_id` is what the
# item hangs under in the UI (the question of an answer, the metric of a
# reading). actor NULL = the table does not record who wrote it.
_SOURCES: dict[str, str] = {
    "thesis": """
        SELECT id, id AS thesis_id, NULL AS parent_id, NULL AS actor,
               COALESCE(updated_at, created_at) AS stamp
          FROM theses WHERE deleted_at IS NULL""",
    "note": """
        SELECT id, thesis_id, NULL AS parent_id, NULL AS actor,
               COALESCE(updated_at, created_at) AS stamp
          FROM thesis_notes WHERE deleted_at IS NULL""",
    "zettel": """
        SELECT z.id, r.target_id AS thesis_id, NULL AS parent_id, z.actor,
               COALESCE(z.updated_at, z.created_at) AS stamp
          FROM zettel z
          LEFT JOIN zettel_refs r ON r.zettel_id = z.id AND r.target_type = 'thesis'
         WHERE z.deleted_at IS NULL""",
    "answer": """
        SELECT a.id, q.thesis_id, a.question_id AS parent_id, a.actor, a.created_at AS stamp
          FROM question_answers a
          JOIN questions q ON q.id = a.question_id
         WHERE q.deleted_at IS NULL""",
    "graph": """
        SELECT id, thesis_id, NULL AS parent_id, actor,
               COALESCE(updated_at, created_at) AS stamp
          FROM graphs WHERE deleted_at IS NULL""",
    "reading": """
        SELECT r.id, m.thesis_id, r.metric_id AS parent_id, r.actor, r.created_at AS stamp
          FROM track_readings r
          JOIN track_metrics m ON m.id = r.metric_id
         WHERE m.deleted_at IS NULL""",
}


def _now() -> str:
    """Same shape the sync triggers stamp `updated_at` with (see theses._now_sync)."""
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def _norm(ts: Optional[str]) -> str:
    """ISO 'T' and SQLite ' ' stamps side by side in one comparable form."""
    return (ts or "").replace("T", " ")[:23]


def _is_unread(seen: Optional[str], actor: Optional[str], stamp: Optional[str]) -> bool:
    if seen is None:
        return actor != "user"
    return _norm(stamp) > _norm(seen)


def _items(conn, types: tuple[str, ...] = TYPES) -> list[dict]:
    """Every unread item. A table a migration has not created yet contributes nothing."""
    marks = {
        (r["target_type"], r["target_id"]): r["seen_at"]
        for r in conn.execute("SELECT target_type, target_id, seen_at FROM read_marks").fetchall()
    }
    out: list[dict] = []
    for t in types:
        try:
            rows = conn.execute(_SOURCES[t]).fetchall()
        except sqlite3.OperationalError:
            continue
        seen_ids: set[str] = set()
        for r in rows:
            if _is_unread(marks.get((t, r["id"])), r["actor"], r["stamp"]):
                # A zettel attached to two theses is one item, counted under each.
                key = f"{r['id']}|{r['thesis_id'] or ''}"
                if key in seen_ids:
                    continue
                seen_ids.add(key)
                out.append({"type": t, "id": r["id"], "thesis_id": r["thesis_id"] or "",
                            "parent_id": r["parent_id"]})
    return out


def mark(conn, target_type: str, target_id: str, seen_at: Optional[str] = None) -> None:
    # UPDATE then INSERT, not an UPSERT: read_marks is synced, and an UPSERT's
    # conflict clause overrides the op-log capture trigger's own (gotchas.md).
    seen = _now() if seen_at is None else seen_at
    cur = conn.execute(
        "UPDATE read_marks SET seen_at = ?, device_id = ? WHERE target_type = ? AND target_id = ?",
        (seen, device_id(), target_type, target_id),
    )
    if cur.rowcount == 0:
        conn.execute(
            """INSERT INTO read_marks (target_type, target_id, seen_at, device_id, created_at, updated_at)
               VALUES (?,?,?,?,?,?)""",
            (target_type, target_id, seen, device_id(), _now(), _now()),
        )


def mark_if_user(conn, target_type: str, target_id: str) -> None:
    """What the user just wrote, the user has read. Called by the routers that
    own a table with no `actor` column (theses, thesis_notes)."""
    if not is_agent():
        mark(conn, target_type, target_id)


class Item(BaseModel):
    type: str
    id: str


class MarkIn(BaseModel):
    items: list[Item] = []
    # Everything unread under one thesis ("" = the items attached to no thesis),
    # optionally narrowed to some types.
    thesis_id: Optional[str] = None
    types: Optional[list[str]] = None


def _refuse_agent() -> None:
    if is_agent():
        raise HTTPException(403, "only the user marks something as read")


def _check(items: list[Item]) -> None:
    bad = sorted({i.type for i in items if i.type not in TYPES})
    if bad:
        raise HTTPException(422, f"unknown type {bad} — one of {list(TYPES)}")


@router.get("/unread")
def unread(thesis_id: Optional[str] = Query(None)):
    """Unread items and the per-thesis counts the navigator shows."""
    with get_db() as conn:
        items = _items(conn)
    by_thesis: dict[str, dict[str, int]] = {}
    for it in items:
        c = by_thesis.setdefault(it["thesis_id"], {"total": 0, **{t: 0 for t in TYPES}})
        c["total"] += 1
        c[it["type"]] += 1
    if thesis_id is not None:
        items = [i for i in items if i["thesis_id"] == thesis_id]
    return {"items": items, "by_thesis": by_thesis,
            "total": len({(i["type"], i["id"]) for i in items})}


@router.post("")
def mark_read(body: MarkIn):
    _refuse_agent()
    _check(body.items)
    with get_db() as conn:
        targets = [(i.type, i.id) for i in body.items]
        if body.thesis_id is not None:
            types = tuple(t for t in (body.types or TYPES) if t in TYPES)
            targets += [(i["type"], i["id"]) for i in _items(conn, types)
                        if i["thesis_id"] == body.thesis_id]
        for t, i in dict.fromkeys(targets):
            mark(conn, t, i)
    return {"marked": len(set(targets))}


@router.post("/unmark")
def mark_unread(body: MarkIn):
    """Back to unread. The row stays with an empty seen_at rather than being
    deleted, so the change travels to the other devices as an ordinary update."""
    _refuse_agent()
    _check(body.items)
    with get_db() as conn:
        for i in body.items:
            mark(conn, i.type, i.id, seen_at="")
    return {"unmarked": len(body.items)}
