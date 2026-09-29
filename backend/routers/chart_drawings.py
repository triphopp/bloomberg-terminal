"""
Chart drawings — trend lines and regression channels the user draws on a chart.

Stored here (not in the browser's localStorage) so they survive a cleared
browser, a different browser, and — through sync/config.py:SYNC_TABLES — reach
the other machine. uuid PKs minted by the client, so the same drawing created on
two devices never collides and a merge is a plain union.

GET    /api/v2/chart-drawings              every drawing (optionally ?symbol=)
PUT    /api/v2/chart-drawings/{id}         create or replace one drawing
DELETE /api/v2/chart-drawings/{id}         remove one drawing
POST   /api/v2/chart-drawings/import       bulk insert-if-absent (localStorage migration)

`data` is the drawing's own shape, owned by the frontend
(chart/indicators/trend-line.ts, regression-channel.ts) and stored as JSON:
  trend       {"a": {"time", "price", "futureBars"?}, "b": {...}, "color"}
              futureBars = bars past `time` for a point projected into the future
  regression  {"fromTime", "toTime", "color", "options": {...}}
"""
from __future__ import annotations

import json
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from db import get_db

router = APIRouter(prefix="/api/v2/chart-drawings", tags=["Chart Drawings"])

Kind = Literal["trend", "regression"]
_MAX_DATA_BYTES = 8_000


def init_chart_drawings_schema() -> None:
    """Must run before init_sync_layer(): that adds updated_at + sync triggers."""
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS chart_drawings (
                id           TEXT PRIMARY KEY,
                kind         TEXT NOT NULL CHECK (kind IN ('trend', 'regression')),
                symbol       TEXT NOT NULL,
                bar_interval TEXT NOT NULL,
                data         TEXT NOT NULL,
                created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chart_drawings_chart"
            " ON chart_drawings(symbol, bar_interval)"
        )


class DrawingIn(BaseModel):
    kind: Kind
    symbol: str = Field(min_length=1, max_length=64)
    barInterval: str = Field(min_length=1, max_length=16)
    data: dict[str, Any]


class DrawingImportItem(DrawingIn):
    id: str = Field(min_length=1, max_length=64)


class DrawingImport(BaseModel):
    drawings: list[DrawingImportItem]


def _encode(data: dict[str, Any]) -> str:
    raw = json.dumps(data, separators=(",", ":"), sort_keys=True)
    if len(raw) > _MAX_DATA_BYTES:
        raise HTTPException(413, "drawing data too large")
    return raw


def _row(r) -> dict[str, Any]:
    try:
        data = json.loads(r["data"])
    except (TypeError, ValueError):
        data = {}
    return {
        "id": r["id"],
        "kind": r["kind"],
        "symbol": r["symbol"],
        "barInterval": r["bar_interval"],
        "data": data,
        "createdAt": r["created_at"],
    }


@router.get("")
def list_drawings(symbol: str | None = None):
    sql = "SELECT id, kind, symbol, bar_interval, data, created_at FROM chart_drawings"
    args: tuple = ()
    if symbol:
        sql += " WHERE symbol = ?"
        args = (symbol,)
    sql += " ORDER BY created_at, id"
    with get_db() as conn:
        rows = conn.execute(sql, args).fetchall()
    return {"drawings": [_row(r) for r in rows]}


@router.put("/{drawing_id}")
def put_drawing(drawing_id: str, body: DrawingIn):
    if not drawing_id or len(drawing_id) > 64:
        raise HTTPException(400, "bad id")
    data = _encode(body.data)
    with get_db() as conn:
        # UPDATE-or-INSERT rather than INSERT OR REPLACE: REPLACE is a delete +
        # insert, which would fire the delete trigger and leave a tombstone for a
        # row that still exists.
        cur = conn.execute(
            "UPDATE chart_drawings SET kind = ?, symbol = ?, bar_interval = ?, data = ?"
            " WHERE id = ?",
            (body.kind, body.symbol, body.barInterval, data, drawing_id),
        )
        if cur.rowcount == 0:
            conn.execute(
                "INSERT INTO chart_drawings (id, kind, symbol, bar_interval, data)"
                " VALUES (?, ?, ?, ?, ?)",
                (drawing_id, body.kind, body.symbol, body.barInterval, data),
            )
        r = conn.execute(
            "SELECT id, kind, symbol, bar_interval, data, created_at FROM chart_drawings"
            " WHERE id = ?",
            (drawing_id,),
        ).fetchone()
    return _row(r)


@router.delete("/{drawing_id}")
def delete_drawing(drawing_id: str):
    with get_db() as conn:
        cur = conn.execute("DELETE FROM chart_drawings WHERE id = ?", (drawing_id,))
    return {"deleted": cur.rowcount}


@router.post("/import")
def import_drawings(body: DrawingImport):
    """Insert the ones not present yet; never overwrites. Safe to retry."""
    added = 0
    with get_db() as conn:
        for d in body.drawings:
            data = _encode(d.data)
            cur = conn.execute(
                "INSERT OR IGNORE INTO chart_drawings (id, kind, symbol, bar_interval, data)"
                " VALUES (?, ?, ?, ?, ?)",
                (d.id, d.kind, d.symbol, d.barInterval, data),
            )
            added += cur.rowcount
    return {"imported": added, "received": len(body.drawings)}
