"""
Investment Thesis system — DB-backed, cloud-synced, with an append-only history.

Design (memory/plans/thesis-db-and-allocation-basis.md):
  theses        — materialised head, edited in place (field-level LWW merge)
  thesis_events — append-only log of how the thinking changed (never UPDATEd,
                  so two devices writing history concurrently union rather than race)
  thesis_links  — explicit thesis ↔ trade links (symbol match is the implicit one)

Deletes are soft by default: a soft delete is an UPDATE, so it does NOT emit a
tombstone and stays reversible on both devices. `?purge=true` is the real DELETE
and does emit one.

Markdown in THESES_DIR (Obsidian on Google Drive) is import/export only — the DB
is the source of truth once a thesis has been imported.
"""
import json
import re
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional

import yaml
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from config import THESES_DIR
from db import get_db
from sync.config import device_id

router = APIRouter(prefix="/api/v2/theses")

# Fields a PATCH may touch. Anything else in the body is ignored rather than
# silently written — the head row is what the merge layer reconciles.
EDITABLE = (
    "symbol", "resolved_symbol", "market", "account_id", "sub_portfolio",
    "title", "category", "strategy", "status", "conviction", "time_horizon",
    "target_price", "stop_price", "currency", "body",
)

VALID_STATUS = {"draft", "active", "watch", "invalidated", "closed"}


def _now() -> str:
    return datetime.utcnow().isoformat()


def _now_sync() -> str:
    """`updated_at` in the exact format the sync triggers write.

    db.py stamps `strftime('%Y-%m-%d %H:%M:%f')` — space separator, millisecond
    precision — and the merge compares those stamps as plain strings. An ISO
    `T` separator sorts ABOVE every space-separated stamp ('T' > ' '), so a row
    inserted with `_now()` would out-rank every later trigger-written update and
    last-write-wins would keep the stale copy forever.
    """
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def _uid() -> str:
    return str(uuid.uuid4())


def _row(r) -> dict:
    return dict(r) if r is not None else {}


def _log_event(
    conn,
    thesis_id: str,
    event_type: str,
    payload: Optional[dict] = None,
    note: str = "",
    occurred_at: Optional[str] = None,
) -> str:
    event_id = _uid()
    conn.execute(
        """INSERT INTO thesis_events
           (id, thesis_id, event_type, payload, note, occurred_at, device_id, created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (
            event_id,
            thesis_id,
            event_type,
            json.dumps(payload, ensure_ascii=False) if payload else None,
            note or "",
            occurred_at or _now(),
            device_id(),
            _now(),
        ),
    )
    return event_id


def _get_thesis(conn, thesis_id: str) -> dict:
    row = conn.execute("SELECT * FROM theses WHERE id = ?", (thesis_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"Thesis {thesis_id} not found")
    return dict(row)


# ── Models ───────────────────────────────────────────────────────────────────

class ThesisIn(BaseModel):
    symbol: str
    title: str = ""
    resolved_symbol: Optional[str] = None
    market: Optional[str] = None
    account_id: Optional[str] = None
    sub_portfolio: Optional[str] = None
    category: Optional[str] = None
    strategy: Optional[str] = None
    status: str = "draft"
    conviction: Optional[int] = None
    time_horizon: Optional[str] = None
    target_price: Optional[float] = None
    stop_price: Optional[float] = None
    currency: Optional[str] = None
    body: str = ""


class ThesisPatch(BaseModel):
    symbol: Optional[str] = None
    title: Optional[str] = None
    resolved_symbol: Optional[str] = None
    market: Optional[str] = None
    account_id: Optional[str] = None
    sub_portfolio: Optional[str] = None
    category: Optional[str] = None
    strategy: Optional[str] = None
    status: Optional[str] = None
    conviction: Optional[int] = None
    time_horizon: Optional[str] = None
    target_price: Optional[float] = None
    stop_price: Optional[float] = None
    currency: Optional[str] = None
    body: Optional[str] = None
    note: Optional[str] = None          # free-text reason, stored on the event
    occurred_at: Optional[str] = None   # allow back-dating the history entry


class EventIn(BaseModel):
    event_type: str = "NOTE"
    note: str = ""
    payload: Optional[dict] = None
    occurred_at: Optional[str] = None


class LinkIn(BaseModel):
    trade_id: str
    role: str = ""


# ── CRUD ─────────────────────────────────────────────────────────────────────

@router.get("")
def list_theses(
    symbol: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    account_id: Optional[str] = Query(None),
    include_deleted: bool = Query(False),
):
    where: list[str] = []
    params: list[Any] = []
    if not include_deleted:
        where.append("deleted_at IS NULL")
    if symbol:
        where.append("UPPER(symbol) = ?")
        params.append(symbol.upper())
    if category:
        where.append("category = ?")
        params.append(category)
    if status:
        where.append("status = ?")
        params.append(status)
    if account_id and account_id != "all":
        where.append("account_id = ?")
        params.append(account_id)

    sql = "SELECT * FROM theses"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY COALESCE(updated_at, created_at) DESC"

    with get_db() as conn:
        rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
        counts = {
            r["thesis_id"]: r["n"]
            for r in conn.execute(
                "SELECT thesis_id, COUNT(*) n FROM thesis_events GROUP BY thesis_id"
            ).fetchall()
        }
        # Only the unresolved ones: a rail badge counting dismissed scenarios
        # would never go down, so it would stop meaning anything.
        note_counts = {
            r["thesis_id"]: r["n"]
            for r in conn.execute(
                "SELECT thesis_id, COUNT(*) n FROM thesis_notes "
                "WHERE deleted_at IS NULL AND status IN ('open','watching') "
                "GROUP BY thesis_id"
            ).fetchall()
        }
    for r in rows:
        r["event_count"] = counts.get(r["id"], 0)
        r["open_note_count"] = note_counts.get(r["id"], 0)
    return {"theses": rows}


@router.get("/by-symbol/{symbol}")
def theses_for_symbol(symbol: str):
    """Every non-deleted thesis for a ticker — used by the positions table badge."""
    with get_db() as conn:
        rows = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM theses WHERE UPPER(symbol) = ? AND deleted_at IS NULL "
                "ORDER BY COALESCE(updated_at, created_at) DESC",
                (symbol.upper(),),
            ).fetchall()
        ]
    return {"theses": rows}


@router.get("/summary/by-symbol")
def theses_summary():
    """symbol → {count, status, conviction} for the whole book, one query.

    The positions table renders hundreds of rows; per-row lookups would be a
    request storm.
    """
    with get_db() as conn:
        rows = conn.execute(
            "SELECT symbol, status, conviction, id FROM theses WHERE deleted_at IS NULL "
            "ORDER BY COALESCE(updated_at, created_at) DESC"
        ).fetchall()
    out: dict[str, dict] = {}
    for r in rows:
        sym = str(r["symbol"] or "").upper()
        if not sym:
            continue
        entry = out.setdefault(
            sym,
            {"count": 0, "status": r["status"], "conviction": r["conviction"], "id": r["id"]},
        )
        entry["count"] += 1
    return {"by_symbol": out}


@router.get("/{thesis_id}")
def get_thesis(thesis_id: str, event_limit: int = Query(50)):
    with get_db() as conn:
        thesis = _get_thesis(conn, thesis_id)
        events = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM thesis_events WHERE thesis_id = ? "
                "ORDER BY occurred_at DESC, created_at DESC LIMIT ?",
                (thesis_id, event_limit),
            ).fetchall()
        ]
        links = [
            dict(r)
            for r in conn.execute(
                """SELECT l.trade_id, l.role, l.created_at,
                          t.symbol, t.date_entry, t.date_exit, t.price_entry, t.price_exit,
                          t.volume, t.win_loss, t.account_id
                   FROM thesis_links l LEFT JOIN trades t ON t.id = l.trade_id
                   WHERE l.thesis_id = ?
                   ORDER BY t.date_entry DESC""",
                (thesis_id,),
            ).fetchall()
        ]
        notes = _notes_for(conn, thesis_id)
    for ev in events:
        if ev.get("payload"):
            try:
                ev["payload"] = json.loads(ev["payload"])
            except (TypeError, ValueError):
                pass
    return {"thesis": thesis, "events": events, "links": links, "notes": notes}


@router.post("")
def create_thesis(body: ThesisIn):
    if not body.symbol.strip():
        raise HTTPException(status_code=400, detail="symbol is required")
    if body.status not in VALID_STATUS:
        raise HTTPException(status_code=400, detail=f"status must be one of {sorted(VALID_STATUS)}")

    thesis_id = _uid()
    now = _now()
    data = body.dict()
    data["symbol"] = data["symbol"].strip().upper()
    data["title"] = data["title"] or data["symbol"]

    cols = ["id", *EDITABLE, "created_at", "updated_at"]
    values = [thesis_id, *[data.get(c) for c in EDITABLE], now, now]
    with get_db() as conn:
        conn.execute(
            f"INSERT INTO theses ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
            values,
        )
        _log_event(conn, thesis_id, "CREATED", {"symbol": data["symbol"], "title": data["title"]})
        thesis = _get_thesis(conn, thesis_id)
    return {"thesis": thesis}


@router.patch("/{thesis_id}")
def patch_thesis(thesis_id: str, body: ThesisPatch):
    payload = body.dict(exclude_unset=True)
    note = payload.pop("note", "") or ""
    occurred_at = payload.pop("occurred_at", None)
    updates = {k: v for k, v in payload.items() if k in EDITABLE}
    if not updates and not note:
        raise HTTPException(status_code=400, detail="nothing to update")
    if "status" in updates and updates["status"] not in VALID_STATUS:
        raise HTTPException(status_code=400, detail=f"status must be one of {sorted(VALID_STATUS)}")
    if "symbol" in updates and updates["symbol"]:
        updates["symbol"] = str(updates["symbol"]).strip().upper()

    with get_db() as conn:
        before = _get_thesis(conn, thesis_id)
        # Diff first — an event that records "changed" for untouched fields is
        # noise, and this log is the whole point of the feature.
        diff = {
            k: {"from": before.get(k), "to": v}
            for k, v in updates.items()
            if before.get(k) != v
        }
        if diff:
            sets = ", ".join(f"{k} = ?" for k in diff)
            conn.execute(
                f"UPDATE theses SET {sets}, updated_at = ? WHERE id = ?",
                [*[updates[k] for k in diff], _now(), thesis_id],
            )
        if diff or note:
            # A status flip is the event people scan history for — label it.
            if "status" in diff:
                kind = "INVALIDATED" if diff["status"]["to"] == "invalidated" else "STATUS_CHANGED"
            elif diff and set(diff) <= {"target_price", "stop_price"}:
                kind = "TARGET_CHANGED"
            elif diff:
                kind = "EDITED"
            else:
                kind = "NOTE"
            _log_event(conn, thesis_id, kind, diff or None, note, occurred_at)
        thesis = _get_thesis(conn, thesis_id)
    return {"thesis": thesis, "changed": sorted(diff)}


@router.delete("/{thesis_id}")
def delete_thesis(thesis_id: str, purge: bool = Query(False), note: str = Query("")):
    """Soft delete by default (reversible, no tombstone). `purge=true` is final."""
    with get_db() as conn:
        _get_thesis(conn, thesis_id)
        if purge:
            conn.execute("DELETE FROM thesis_events WHERE thesis_id = ?", (thesis_id,))
            conn.execute("DELETE FROM thesis_links  WHERE thesis_id = ?", (thesis_id,))
            conn.execute("DELETE FROM theses        WHERE id = ?", (thesis_id,))
            return {"ok": True, "purged": True}
        now = _now()
        conn.execute(
            "UPDATE theses SET deleted_at = ?, updated_at = ? WHERE id = ?", (now, now, thesis_id)
        )
        _log_event(conn, thesis_id, "DELETED", None, note)
    return {"ok": True, "purged": False}


@router.post("/{thesis_id}/restore")
def restore_thesis(thesis_id: str):
    with get_db() as conn:
        _get_thesis(conn, thesis_id)
        conn.execute(
            "UPDATE theses SET deleted_at = NULL, updated_at = ? WHERE id = ?", (_now(), thesis_id)
        )
        _log_event(conn, thesis_id, "RESTORED")
        thesis = _get_thesis(conn, thesis_id)
    return {"thesis": thesis}


# ── Events ───────────────────────────────────────────────────────────────────

@router.get("/{thesis_id}/events")
def list_events(thesis_id: str, limit: int = Query(200)):
    with get_db() as conn:
        rows = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM thesis_events WHERE thesis_id = ? "
                "ORDER BY occurred_at DESC, created_at DESC LIMIT ?",
                (thesis_id, limit),
            ).fetchall()
        ]
    for ev in rows:
        if ev.get("payload"):
            try:
                ev["payload"] = json.loads(ev["payload"])
            except (TypeError, ValueError):
                pass
    return {"events": rows}


@router.post("/{thesis_id}/events")
def add_event(thesis_id: str, body: EventIn):
    with get_db() as conn:
        _get_thesis(conn, thesis_id)
        event_id = _log_event(
            conn, thesis_id, body.event_type.upper(), body.payload, body.note, body.occurred_at
        )
        row = dict(
            conn.execute("SELECT * FROM thesis_events WHERE id = ?", (event_id,)).fetchone()
        )
    return {"event": row}


@router.delete("/{thesis_id}/events/{event_id}")
def delete_event(thesis_id: str, event_id: str):
    """Only ever for a mistyped manual note — edits/status flips are the record."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM thesis_events WHERE id = ? AND thesis_id = ?", (event_id, thesis_id)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="event not found")
        if row["event_type"] != "NOTE":
            raise HTTPException(status_code=400, detail="only NOTE events can be deleted")
        conn.execute("DELETE FROM thesis_events WHERE id = ?", (event_id,))
    return {"ok": True}


# ── Notes ────────────────────────────────────────────────────────────────────
#
# A note is the standing counterpart to an event: the scenarios, risks and
# catalysts the user is holding in their head about a thesis, kept editable
# until they resolve. Events stay append-only; a note that resolves writes ONE
# event so the timeline still shows when the thinking moved.

VALID_NOTE_KIND = {"NOTE", "SCENARIO", "RISK", "CATALYST", "QUESTION", "EVIDENCE"}
VALID_NOTE_STATUS = {"open", "watching", "confirmed", "dismissed"}
VALID_IMPACT = {"bull", "bear", "mixed"}

NOTE_EDITABLE = (
    "kind", "title", "body", "impact", "likelihood", "severity",
    "status", "watch_date", "pinned", "sort_order",
)


class NoteIn(BaseModel):
    kind: str = "NOTE"
    title: str = ""
    body: str = ""
    impact: Optional[str] = None
    likelihood: Optional[int] = None
    severity: Optional[int] = None
    status: str = "open"
    watch_date: Optional[str] = None
    pinned: bool = False


class NotePatch(BaseModel):
    kind: Optional[str] = None
    title: Optional[str] = None
    body: Optional[str] = None
    impact: Optional[str] = None
    likelihood: Optional[int] = None
    severity: Optional[int] = None
    status: Optional[str] = None
    watch_date: Optional[str] = None
    pinned: Optional[bool] = None
    sort_order: Optional[int] = None


def _validate_note(kind: Optional[str], status: Optional[str], impact: Optional[str]) -> None:
    if kind is not None and kind.upper() not in VALID_NOTE_KIND:
        raise HTTPException(status_code=400, detail=f"kind must be one of {sorted(VALID_NOTE_KIND)}")
    if status is not None and status not in VALID_NOTE_STATUS:
        raise HTTPException(
            status_code=400, detail=f"status must be one of {sorted(VALID_NOTE_STATUS)}"
        )
    # "" is how the UI clears the select, and is stored as NULL rather than rejected.
    if impact not in (None, "") and impact not in VALID_IMPACT:
        raise HTTPException(status_code=400, detail=f"impact must be one of {sorted(VALID_IMPACT)}")


def _clamp_1_5(v: Optional[int]) -> Optional[int]:
    if v is None:
        return None
    return max(1, min(5, int(v)))


def _notes_for(conn, thesis_id: str, include_deleted: bool = False) -> list[dict]:
    sql = "SELECT * FROM thesis_notes WHERE thesis_id = ?"
    if not include_deleted:
        sql += " AND deleted_at IS NULL"
    # Pinned first, then the ones with a date to watch, soonest first — an
    # undated note has no deadline and should not outrank one that does.
    sql += (
        " ORDER BY pinned DESC, "
        " CASE WHEN watch_date IS NULL OR watch_date = '' THEN 1 ELSE 0 END ASC,"
        " watch_date ASC, sort_order ASC, created_at DESC"
    )
    return [dict(r) for r in conn.execute(sql, (thesis_id,)).fetchall()]


@router.get("/notes/due")
def notes_due(days: int = Query(14), include_undated: bool = Query(False)):
    """Open notes whose watch_date falls inside the window — the "what am I
    waiting on across the whole book" view, joined to the thesis they belong to."""
    horizon = (datetime.utcnow().date() + timedelta(days=max(0, days))).isoformat()
    sql = """SELECT n.*, t.symbol, t.title AS thesis_title, t.status AS thesis_status
             FROM thesis_notes n JOIN theses t ON t.id = n.thesis_id
             WHERE n.deleted_at IS NULL AND t.deleted_at IS NULL
               AND n.status IN ('open','watching')"""
    if include_undated:
        sql += " AND (n.watch_date IS NULL OR n.watch_date = '' OR n.watch_date <= ?)"
    else:
        sql += " AND n.watch_date IS NOT NULL AND n.watch_date != '' AND n.watch_date <= ?"
    sql += " ORDER BY n.watch_date ASC, n.created_at DESC"
    with get_db() as conn:
        rows = [dict(r) for r in conn.execute(sql, (horizon,)).fetchall()]
    return {"notes": rows, "horizon": horizon}


@router.get("/{thesis_id}/notes")
def list_notes(thesis_id: str, include_deleted: bool = Query(False)):
    with get_db() as conn:
        _get_thesis(conn, thesis_id)
        return {"notes": _notes_for(conn, thesis_id, include_deleted)}


@router.post("/{thesis_id}/notes")
def add_note(thesis_id: str, body: NoteIn):
    _validate_note(body.kind, body.status, body.impact)
    if not body.title.strip() and not body.body.strip():
        raise HTTPException(status_code=400, detail="a note needs a title or a body")
    note_id = _uid()
    now = _now_sync()
    with get_db() as conn:
        _get_thesis(conn, thesis_id)
        conn.execute(
            """INSERT INTO thesis_notes
               (id, thesis_id, kind, title, body, impact, likelihood, severity,
                status, watch_date, pinned, sort_order, device_id, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                note_id,
                thesis_id,
                body.kind.upper(),
                body.title.strip(),
                body.body,
                body.impact or None,
                _clamp_1_5(body.likelihood),
                _clamp_1_5(body.severity),
                body.status,
                body.watch_date or None,
                1 if body.pinned else 0,
                0,
                device_id(),
                now,
                now,
            ),
        )
        _log_event(
            conn,
            thesis_id,
            "NOTE_ADDED",
            {"kind": body.kind.upper(), "note_id": note_id},
            body.title.strip() or body.body[:120],
        )
        row = dict(conn.execute("SELECT * FROM thesis_notes WHERE id = ?", (note_id,)).fetchone())
    return {"note": row}


@router.patch("/{thesis_id}/notes/{note_id}")
def patch_note(thesis_id: str, note_id: str, body: NotePatch):
    _validate_note(body.kind, body.status, body.impact)
    # exclude_unset, not exclude_none: sending null is how the UI clears
    # watch_date / impact / likelihood, and exclude_none would drop exactly that.
    updates = body.model_dump(exclude_unset=True)
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM thesis_notes WHERE id = ? AND thesis_id = ?", (note_id, thesis_id)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="note not found")
        before = dict(row)

        fields: dict[str, Any] = {}
        for key in NOTE_EDITABLE:
            if key not in updates:
                continue
            val = updates[key]
            if key == "kind" and val is not None:
                val = str(val).upper()
            elif key in ("likelihood", "severity"):
                val = _clamp_1_5(val)
            elif key == "pinned":
                val = 1 if val else 0
            elif key in ("impact", "watch_date") and val == "":
                val = None
            fields[key] = val
        if not fields:
            return {"note": before}

        fields["updated_at"] = _now_sync()
        sets = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(
            f"UPDATE thesis_notes SET {sets} WHERE id = ?", [*fields.values(), note_id]
        )

        # A note going confirmed/dismissed is the thinking actually moving, so
        # it belongs in the timeline. Fixing a typo in the body does not.
        new_status = fields.get("status")
        if new_status and new_status != before["status"] and new_status in ("confirmed", "dismissed"):
            _log_event(
                conn,
                thesis_id,
                "NOTE_RESOLVED",
                {"status": {"from": before["status"], "to": new_status}, "note_id": note_id},
                before["title"] or (before["body"] or "")[:120],
            )
        after = dict(conn.execute("SELECT * FROM thesis_notes WHERE id = ?", (note_id,)).fetchone())
    return {"note": after}


@router.delete("/{thesis_id}/notes/{note_id}")
def delete_note(thesis_id: str, note_id: str, purge: bool = Query(False)):
    """Soft by default, same reasoning as the thesis delete: an UPDATE emits no
    tombstone and stays reversible on both devices."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM thesis_notes WHERE id = ? AND thesis_id = ?", (note_id, thesis_id)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="note not found")
        if purge:
            conn.execute("DELETE FROM thesis_notes WHERE id = ?", (note_id,))
        else:
            conn.execute(
                "UPDATE thesis_notes SET deleted_at = ?, updated_at = ? WHERE id = ?",
                (_now(), _now_sync(), note_id),
            )
    return {"ok": True, "purged": purge}


# ── Trade links ──────────────────────────────────────────────────────────────

@router.post("/{thesis_id}/links")
def link_trade(thesis_id: str, body: LinkIn):
    with get_db() as conn:
        _get_thesis(conn, thesis_id)
        trade = conn.execute("SELECT id, symbol FROM trades WHERE id = ?", (body.trade_id,)).fetchone()
        if trade is None:
            raise HTTPException(status_code=404, detail=f"trade {body.trade_id} not found")
        conn.execute(
            "INSERT OR REPLACE INTO thesis_links (thesis_id, trade_id, role, created_at) "
            "VALUES (?,?,?,?)",
            (thesis_id, body.trade_id, body.role, _now()),
        )
        _log_event(
            conn, thesis_id, "TRADE_LINKED",
            {"trade_id": body.trade_id, "symbol": trade["symbol"], "role": body.role},
        )
    return {"ok": True}


@router.delete("/{thesis_id}/links/{trade_id}")
def unlink_trade(thesis_id: str, trade_id: str):
    with get_db() as conn:
        conn.execute(
            "DELETE FROM thesis_links WHERE thesis_id = ? AND trade_id = ?", (thesis_id, trade_id)
        )
        _log_event(conn, thesis_id, "TRADE_UNLINKED", {"trade_id": trade_id})
    return {"ok": True}


# ── Markdown import / export (Obsidian on Google Drive) ──────────────────────

def _parse_frontmatter(text: str) -> tuple[dict, str]:
    """Split YAML frontmatter from body. Returns ({}, text) if absent."""
    if not text.startswith("---"):
        return {}, text
    lines = text.split("\n")
    try:
        end = next(i for i, ln in enumerate(lines[1:], 1) if ln.strip() == "---")
    except StopIteration:
        return {}, text
    try:
        fm = yaml.safe_load("\n".join(lines[1:end])) or {}
    except Exception:
        fm = {}
    return (fm if isinstance(fm, dict) else {}), "\n".join(lines[end + 1:]).lstrip("\n")


_CONVICTION_WORDS = {"low": 2, "medium": 3, "med": 3, "high": 4, "very high": 5}


def _coerce_conviction(v) -> Optional[int]:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return max(1, min(5, int(v)))
    return _CONVICTION_WORDS.get(str(v).strip().lower())


@router.post("/import-md")
def import_markdown(dry_run: bool = Query(False)):
    """Import every .md in THESES_DIR that has not been imported before.

    Re-import is keyed on `source_file`, so running this twice does not duplicate
    a thesis, and the original files are left untouched.
    """
    if not THESES_DIR.exists():
        raise HTTPException(status_code=404, detail=f"THESES_DIR not found: {THESES_DIR}")

    with get_db() as conn:
        seen = {
            r["source_file"]
            for r in conn.execute(
                "SELECT source_file FROM theses WHERE source_file IS NOT NULL"
            ).fetchall()
        }

        imported: list[dict] = []
        skipped: list[str] = []
        for path in sorted(Path(THESES_DIR).glob("*.md")):
            if path.name in seen:
                skipped.append(path.name)
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError as exc:
                skipped.append(f"{path.name} ({exc})")
                continue
            fm, body = _parse_frontmatter(text)
            symbol = str(fm.get("symbol") or path.stem.split("-")[0]).upper()
            status = str(fm.get("status") or "active").lower()
            if status not in VALID_STATUS:
                status = "active"
            record = {
                "id": _uid(),
                "symbol": symbol,
                "title": str(fm.get("title") or path.stem),
                "category": str(fm.get("category") or ""),
                "strategy": str(fm.get("strategy") or ""),
                "status": status,
                "conviction": _coerce_conviction(fm.get("confidence") or fm.get("conviction")),
                "time_horizon": str(fm.get("time_horizon") or fm.get("horizon") or ""),
                "target_price": _num(fm.get("target_price") or fm.get("target")),
                "stop_price": _num(fm.get("stop_price") or fm.get("stop")),
                "body": body,
                "source_file": path.name,
            }
            imported.append(record)
            if dry_run:
                continue
            now = _now()
            conn.execute(
                """INSERT INTO theses
                   (id, symbol, title, category, strategy, status, conviction, time_horizon,
                    target_price, stop_price, body, source_file, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    record["id"], record["symbol"], record["title"], record["category"],
                    record["strategy"], record["status"], record["conviction"],
                    record["time_horizon"], record["target_price"], record["stop_price"],
                    record["body"], record["source_file"], now, now,
                ),
            )
            _log_event(
                conn, record["id"], "CREATED",
                {"imported": True, "source_file": path.name, "symbol": record["symbol"]},
                note=f"Imported from {path.name}",
                occurred_at=str(fm.get("last_updated") or "") or None,
            )

    return {
        "imported": [{"symbol": r["symbol"], "file": r["source_file"]} for r in imported],
        "imported_count": len(imported),
        "skipped": skipped,
        "dir": str(THESES_DIR),
        "dry_run": dry_run,
    }


def _num(v) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


@router.post("/{thesis_id}/export-md")
def export_markdown(thesis_id: str):
    """Write the thesis back to THESES_DIR so Obsidian can read it.

    One-way: the DB stays authoritative. A re-export overwrites the file it
    previously wrote (or `<SYMBOL>-<id8>.md` for a DB-native thesis).
    """
    with get_db() as conn:
        thesis = _get_thesis(conn, thesis_id)

    THESES_DIR.mkdir(parents=True, exist_ok=True)
    name = thesis.get("source_file") or f"{thesis['symbol']}-{thesis_id[:8]}.md"
    name = _SAFE_NAME.sub("_", name)
    if not name.endswith(".md"):
        name += ".md"
    path = Path(THESES_DIR) / name

    fm = {
        "symbol": thesis["symbol"],
        "title": thesis.get("title") or thesis["symbol"],
        "status": thesis.get("status"),
        "category": thesis.get("category") or "",
        "strategy": thesis.get("strategy") or "",
        "conviction": thesis.get("conviction"),
        "time_horizon": thesis.get("time_horizon") or "",
        "target_price": thesis.get("target_price"),
        "stop_price": thesis.get("stop_price"),
        "last_updated": thesis.get("updated_at"),
        "thesis_id": thesis_id,
    }
    text = (
        "---\n"
        + yaml.safe_dump({k: v for k, v in fm.items() if v not in (None, "")}, allow_unicode=True)
        + "---\n\n"
        + (thesis.get("body") or "")
        + "\n"
    )
    try:
        path.write_text(text, encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"write failed: {exc}") from exc

    with get_db() as conn:
        if not thesis.get("source_file"):
            conn.execute(
                "UPDATE theses SET source_file = ?, updated_at = ? WHERE id = ?",
                (name, _now(), thesis_id),
            )
        _log_event(conn, thesis_id, "EXPORTED", {"file": name})
    return {"ok": True, "file": name, "path": str(path)}
