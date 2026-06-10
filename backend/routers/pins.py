"""Pin / Watchlist CRUD endpoints."""

import sqlite3
import uuid
import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db import get_db

router = APIRouter()


# ─── Pydantic Models ────────────────────────────────────────────────────────

class PinGroupIn(BaseModel):
    id: str
    name: str
    color: str = "#f59e0b"
    sort_order: int = 0


class PinGroupPatch(BaseModel):
    name: str | None = None
    color: str | None = None
    sort_order: int | None = None


class PinnedAssetIn(BaseModel):
    id: str
    symbol: str
    group_id: str
    comment: str = ""
    buy_target: float | None = None
    sell_target: float | None = None
    price_at_pin: float | None = None
    priority: int = 1
    added_at: str = ""
    tags: list[str] = []


class PinnedAssetPatch(BaseModel):
    group_id: str | None = None
    comment: str | None = None
    buy_target: float | None = None
    sell_target: float | None = None
    priority: int | None = None


class PinTagIn(BaseModel):
    id: str
    name: str
    color: str = "#94a3b8"


class PinImportRequest(BaseModel):
    groups: list[dict] = []
    assets: list[dict] = []


class ReorderItem(BaseModel):
    id: str
    sort_order: int


class ReorderRequest(BaseModel):
    order: list[ReorderItem]


# ─── Helpers ────────────────────────────────────────────────────────────────

def _asset_with_tags(conn, row) -> dict:
    """Convert a pinned_assets row to dict and attach tag IDs."""
    asset = dict(row)
    tag_rows = conn.execute(
        "SELECT tag_id FROM pinned_asset_tags WHERE asset_id = ?",
        (asset["id"],),
    ).fetchall()
    asset["tags"] = [r["tag_id"] for r in tag_rows]
    return asset


# ─── Groups ─────────────────────────────────────────────────────────────────

@router.get("/api/pins/groups")
def list_groups():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM pin_groups ORDER BY sort_order ASC"
        ).fetchall()
        return [dict(r) for r in rows]


@router.post("/api/pins/groups", status_code=201)
def create_group(body: PinGroupIn):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO pin_groups (id, name, color, sort_order) VALUES (?, ?, ?, ?)",
            (body.id, body.name, body.color, body.sort_order),
        )
        conn.commit()
    return {"ok": True, "id": body.id}


@router.patch("/api/pins/groups/{group_id}")
def patch_group(group_id: str, body: PinGroupPatch):
    with get_db() as conn:
        existing = conn.execute(
            "SELECT * FROM pin_groups WHERE id = ?", (group_id,)
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Group not found")

        updates = body.model_dump(exclude_none=True)
        if not updates:
            return dict(existing)

        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [group_id]
        conn.execute(
            f"UPDATE pin_groups SET {set_clause} WHERE id = ?", values
        )
        conn.commit()

        row = conn.execute(
            "SELECT * FROM pin_groups WHERE id = ?", (group_id,)
        ).fetchone()
        return dict(row)


@router.delete("/api/pins/groups/{group_id}")
def delete_group(group_id: str):
    with get_db() as conn:
        existing = conn.execute(
            "SELECT * FROM pin_groups WHERE id = ?", (group_id,)
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Group not found")

        # Find the oldest remaining group to reassign assets
        oldest = conn.execute(
            "SELECT id FROM pin_groups WHERE id != ? ORDER BY sort_order ASC, rowid ASC LIMIT 1",
            (group_id,),
        ).fetchone()

        if oldest:
            conn.execute(
                "UPDATE pinned_assets SET group_id = ? WHERE group_id = ?",
                (oldest["id"], group_id),
            )
        else:
            # No other groups exist — delete all assets in this group
            asset_ids = conn.execute(
                "SELECT id FROM pinned_assets WHERE group_id = ?", (group_id,)
            ).fetchall()
            for a in asset_ids:
                conn.execute(
                    "DELETE FROM pinned_asset_tags WHERE asset_id = ?", (a["id"],)
                )
            conn.execute(
                "DELETE FROM pinned_assets WHERE group_id = ?", (group_id,)
            )

        conn.execute("DELETE FROM pin_groups WHERE id = ?", (group_id,))
        conn.commit()
    return {"ok": True}


# ─── Assets ─────────────────────────────────────────────────────────────────

@router.get("/api/pins/assets")
def list_assets():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM pinned_assets ORDER BY sort_order ASC, added_at ASC"
        ).fetchall()
        return [_asset_with_tags(conn, r) for r in rows]


@router.post("/api/pins/assets", status_code=201)
def create_asset(body: PinnedAssetIn):
    added_at = body.added_at or datetime.datetime.utcnow().isoformat()
    with get_db() as conn:
        conn.execute(
            """INSERT INTO pinned_assets
               (id, symbol, group_id, comment, buy_target, sell_target, price_at_pin, priority, added_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                body.id,
                body.symbol,
                body.group_id,
                body.comment,
                body.buy_target,
                body.sell_target,
                body.price_at_pin,
                body.priority,
                added_at,
            ),
        )
        # Attach tags
        for tag_id in body.tags:
            conn.execute(
                "INSERT OR IGNORE INTO pinned_asset_tags (asset_id, tag_id) VALUES (?, ?)",
                (body.id, tag_id),
            )
        conn.commit()
    return {"ok": True, "id": body.id}


@router.patch("/api/pins/assets/reorder")
def reorder_assets(body: ReorderRequest):
    """Bulk-update sort_order for a list of assets. Called after drag-to-reorder."""
    with get_db() as conn:
        for item in body.order:
            conn.execute(
                "UPDATE pinned_assets SET sort_order = ? WHERE id = ?",
                (item.sort_order, item.id),
            )
        conn.commit()
    return {"ok": True, "updated": len(body.order)}


@router.patch("/api/pins/assets/{asset_id}")
def patch_asset(asset_id: str, body: PinnedAssetPatch):
    with get_db() as conn:
        existing = conn.execute(
            "SELECT * FROM pinned_assets WHERE id = ?", (asset_id,)
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Asset not found")

        updates = body.model_dump(exclude_none=True)
        if not updates:
            return _asset_with_tags(conn, existing)

        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [asset_id]
        conn.execute(
            f"UPDATE pinned_assets SET {set_clause} WHERE id = ?", values
        )
        conn.commit()

        row = conn.execute(
            "SELECT * FROM pinned_assets WHERE id = ?", (asset_id,)
        ).fetchone()
        return _asset_with_tags(conn, row)


@router.delete("/api/pins/assets/{asset_id}")
def delete_asset(asset_id: str):
    with get_db() as conn:
        conn.execute(
            "DELETE FROM pinned_asset_tags WHERE asset_id = ?", (asset_id,)
        )
        conn.execute("DELETE FROM pinned_assets WHERE id = ?", (asset_id,))
        conn.commit()
    return {"ok": True}


# ─── Tags ───────────────────────────────────────────────────────────────────

@router.get("/api/pins/tags")
def list_tags():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM pin_tags").fetchall()
        return [dict(r) for r in rows]


@router.post("/api/pins/tags", status_code=201)
def create_tag(body: PinTagIn):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO pin_tags (id, name, color) VALUES (?, ?, ?)",
            (body.id, body.name, body.color),
        )
        conn.commit()
    return {"ok": True, "id": body.id}


@router.delete("/api/pins/tags/{tag_id}")
def delete_tag(tag_id: str):
    with get_db() as conn:
        conn.execute("DELETE FROM pinned_asset_tags WHERE tag_id = ?", (tag_id,))
        conn.execute("DELETE FROM pin_tags WHERE id = ?", (tag_id,))
        conn.commit()
    return {"ok": True}


# ─── Asset ↔ Tag association ────────────────────────────────────────────────

@router.post("/api/pins/assets/{asset_id}/tags/{tag_id}", status_code=201)
def assign_tag(asset_id: str, tag_id: str):
    with get_db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO pinned_asset_tags (asset_id, tag_id) VALUES (?, ?)",
            (asset_id, tag_id),
        )
        conn.commit()
    return {"ok": True}


@router.delete("/api/pins/assets/{asset_id}/tags/{tag_id}")
def remove_tag(asset_id: str, tag_id: str):
    with get_db() as conn:
        conn.execute(
            "DELETE FROM pinned_asset_tags WHERE asset_id = ? AND tag_id = ?",
            (asset_id, tag_id),
        )
        conn.commit()
    return {"ok": True}


# ─── Bulk Import ────────────────────────────────────────────────────────────

@router.post("/api/pins/import")
def bulk_import(body: PinImportRequest):
    with get_db() as conn:
        for g in body.groups:
            conn.execute(
                """INSERT OR REPLACE INTO pin_groups (id, name, color, sort_order)
                   VALUES (?, ?, ?, ?)""",
                (
                    g.get("id", str(uuid.uuid4())),
                    g.get("name", "Unnamed"),
                    g.get("color", "#f59e0b"),
                    g.get("sort_order", 0),
                ),
            )
        for a in body.assets:
            conn.execute(
                """INSERT OR REPLACE INTO pinned_assets
                   (id, symbol, group_id, comment, buy_target, sell_target, price_at_pin, priority, added_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    a.get("id", str(uuid.uuid4())),
                    a.get("symbol", ""),
                    a.get("group_id", ""),
                    a.get("comment", ""),
                    a.get("buy_target"),
                    a.get("sell_target"),
                    a.get("price_at_pin"),
                    a.get("priority", 1),
                    a.get("added_at", datetime.datetime.utcnow().isoformat()),
                ),
            )
        conn.commit()
    return {"ok": True, "groups": len(body.groups), "assets": len(body.assets)}
