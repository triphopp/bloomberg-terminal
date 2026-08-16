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
from datetime import datetime
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
    for r in rows:
        r["event_count"] = counts.get(r["id"], 0)
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
    for ev in events:
        if ev.get("payload"):
            try:
                ev["payload"] = json.loads(ev["payload"])
            except (TypeError, ValueError):
                pass
    return {"thesis": thesis, "events": events, "links": links}


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
