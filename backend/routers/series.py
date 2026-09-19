"""
/api/v2/series — the generic indicator board.

Reads the store that `series_sources` fills. Nothing here knows what a DRAM chip
is: a caller asks for a group ("memory"), gets sections, series, latest values
and enough points to draw a sparkline, and the same endpoint serves whatever
source is added next.

Two things are deliberate:

1. **The series carries its own honesty.** `points` is what was actually
   recorded, and `first_seen` says since when. The publisher does not sell the
   history (its charts are member-only), so a chart here starts the day the
   recorder did — the UI is expected to say "12 days recorded", not to draw a
   confident line through three points.

2. **Staleness is reported, never hidden.** `last_date` is the date the SOURCE
   stamped, `captured_at` when this machine read it. A weekly table legitimately
   shows an eleven-day-old date; a daily one showing the same thing means the
   parser broke. Only the caller can tell those apart, so both travel.
"""
from datetime import date, datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query

from db import get_db

router = APIRouter(prefix="/api/v2/series")

MAX_DAYS = 3650


def _rows(conn, sql: str, params: tuple = ()) -> list[dict]:
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


@router.get("/groups")
def list_groups() -> dict:
    """The boards that exist, with how fresh each one is.

    The UI builds its selector from this rather than from a hard-coded list, so
    a new collector appears in the interface without a frontend change.
    """
    with get_db() as conn:
        groups = _rows(
            conn,
            """SELECT group_key,
                      COUNT(*)            AS series_count,
                      MAX(last_date)      AS last_date,
                      MAX(updated_at)     AS captured_at,
                      GROUP_CONCAT(DISTINCT source) AS sources
                 FROM series_meta
                GROUP BY group_key
                ORDER BY group_key""",
        )
    for g in groups:
        g["sources"] = [s for s in (g.get("sources") or "").split(",") if s]
    return {"groups": groups}


@router.get("")
def list_series(
    group: Optional[str] = Query(None, description="board key, e.g. 'memory'"),
    section: Optional[str] = None,
    source: Optional[str] = None,
    days: int = Query(60, ge=2, le=MAX_DAYS, description="how much history to inline"),
) -> dict:
    """Every series on a board, each with its recent points for a sparkline."""
    where, params = [], []
    for col, val in (("group_key", group), ("section", section), ("source", source)):
        if val:
            where.append(f"{col} = ?")
            params.append(val)
    sql = "SELECT * FROM series_meta"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY sort_order, label"

    with get_db() as conn:
        metas = _rows(conn, sql, tuple(params))
        if not metas:
            return {"series": [], "sections": [], "as_of": None}

        ids = [m["id"] for m in metas]
        marks = ",".join("?" * len(ids))
        points = _rows(
            conn,
            f"""SELECT series_id, date, value, high, low, change_pct, captured_at
                  FROM series_points
                 WHERE series_id IN ({marks})
                 ORDER BY date""",
            tuple(ids),
        )
        counts = {
            r["series_id"]: r["n"]
            for r in conn.execute(
                f"SELECT series_id, COUNT(*) n FROM series_points "
                f"WHERE series_id IN ({marks}) GROUP BY series_id",
                tuple(ids),
            ).fetchall()
        }

    by_id: dict[str, list[dict]] = {}
    for p in points:
        by_id.setdefault(p["series_id"], []).append(p)

    out = []
    for m in metas:
        series_points = by_id.get(m["id"], [])[-days:]
        first = series_points[0]["value"] if series_points else None
        last = series_points[-1] if series_points else None
        m["points"] = [
            {"date": p["date"], "value": p["value"], "high": p["high"], "low": p["low"]}
            for p in series_points
        ]
        m["point_count"] = counts.get(m["id"], 0)
        m["change_pct"] = last.get("change_pct") if last else None
        # Change over the window the caller asked for — distinct from the
        # publisher's own session change above, which covers one print.
        m["window_change_pct"] = (
            round((last["value"] - first) / first * 100, 2)
            if last and first not in (None, 0) and last["value"] is not None
            else None
        )
        m["captured_at"] = last.get("captured_at") if last else None
        m["stale_days"] = _stale_days(m.get("last_date"))
        out.append(m)

    sections: list[str] = []
    for m in out:
        if m["section"] and m["section"] not in sections:
            sections.append(m["section"])

    return {
        "series": out,
        "sections": sections,
        "as_of": max((m["last_date"] for m in out if m.get("last_date")), default=None),
    }


def _stale_days(last_date: Optional[str]) -> Optional[int]:
    if not last_date:
        return None
    try:
        d = date.fromisoformat(str(last_date)[:10])
    except ValueError:
        return None
    return (date.today() - d).days


@router.get("/{series_id}")
def get_series(series_id: str, days: int = Query(365, ge=2, le=MAX_DAYS)) -> dict:
    """One series with its full recorded history — what the big chart draws."""
    with get_db() as conn:
        meta = conn.execute("SELECT * FROM series_meta WHERE id = ?", (series_id,)).fetchone()
        if not meta:
            raise HTTPException(404, f"series '{series_id}' not found")
        points = _rows(
            conn,
            """SELECT date, value, high, low, change_pct, captured_at
                 FROM series_points WHERE series_id = ?
                ORDER BY date DESC LIMIT ?""",
            (series_id, days),
        )
    points.reverse()
    out = dict(meta)
    out["points"] = points
    out["point_count"] = len(points)
    out["stale_days"] = _stale_days(out.get("last_date"))
    return out


@router.post("/refresh")
def refresh(source: Optional[str] = Query(None, description="one collector, or all")) -> dict:
    """Pull from the sources now.

    Manual counterpart to the daily scheduler — the UI button, and how a new
    collector is smoke-tested. Failures come back per source rather than as a
    500: one broken parser must not hide the sources that did work.
    """
    import series_sources

    results = series_sources.run(source)
    return {
        "ran_at": datetime.now(timezone.utc).isoformat(),
        "results": [
            {
                "source": r.source,
                "ok": r.ok,
                "series": r.series,
                "points": r.points,
                "dates": r.dates,
                "error": r.error,
            }
            for r in results
        ],
    }


@router.delete("/{series_id}")
def delete_series(series_id: str, purge_points: bool = Query(False)) -> dict[str, Any]:
    """Drop a series the user no longer wants on the board.

    Hard delete, unlike theses or graphs: a series is re-creatable from its
    source on the next refresh, so there is nothing irreplaceable to protect —
    except the recorded history, which is why the points stay unless
    `purge_points` says otherwise.
    """
    with get_db() as conn:
        cur = conn.execute("DELETE FROM series_meta WHERE id = ?", (series_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, f"series '{series_id}' not found")
        if purge_points:
            conn.execute("DELETE FROM series_points WHERE series_id = ?", (series_id,))
    return {"ok": True, "id": series_id, "points_kept": not purge_points}
