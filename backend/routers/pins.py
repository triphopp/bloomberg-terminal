"""Pin / Watchlist CRUD endpoints."""

import sqlite3
import uuid
import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

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
    price_at_pin: float | None = None
    group_id: str | None = None
    comment: str | None = None
    buy_target: float | None = None
    sell_target: float | None = None
    priority: int | None = None


class NewGroupIn(BaseModel):
    name: str
    color: str | None = None


class PinUpsertIn(BaseModel):
    """PUT /api/pins/by-symbol/{symbol}. Fields left out are preserved on an
    existing pin; targets sent as null are cleared."""
    group_id: str | None = None
    new_group: NewGroupIn | None = None
    comment: str | None = None
    buy_target: float | None = None
    sell_target: float | None = None
    price_at_pin: float | None = None
    priority: int | None = Field(default=None, ge=1, le=3)
    tags: list[str] | None = None

    @model_validator(mode="after")
    def _one_destination(self):
        if self.group_id and self.new_group:
            raise ValueError("send group_id or new_group, not both")
        if self.new_group and not self.new_group.name.strip():
            raise ValueError("new_group.name is empty")
        return self


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


DEFAULT_GROUP_ID = "watchlist"
DEFAULT_GROUP_NAME = "Watchlist"
DEFAULT_GROUP_COLOR = "#f59e0b"


def pin_id_for(symbol: str) -> str:
    """Deterministic id for a NEW pin: two devices pinning the same symbol
    produce the same op-log row key instead of two colliding rows."""
    return f"pin:{symbol}"


def norm_symbol(symbol: str) -> str:
    return (symbol or "").strip().upper()


def _now() -> str:
    return datetime.datetime.utcnow().isoformat()


def _create_group(conn, name: str, color: str | None, group_id: str | None = None) -> dict:
    """Insert a group (reusing one with the same name, case-insensitively)."""
    name = name.strip()
    same = conn.execute(
        "SELECT * FROM pin_groups WHERE LOWER(name) = LOWER(?) ORDER BY sort_order LIMIT 1", (name,)
    ).fetchone()
    if same:
        return dict(same)
    gid = group_id or f"grp-{uuid.uuid4().hex[:12]}"
    order = conn.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM pin_groups").fetchone()[0]
    conn.execute(
        "INSERT INTO pin_groups (id, name, color, sort_order) VALUES (?, ?, ?, ?)",
        (gid, name, color or DEFAULT_GROUP_COLOR, order),
    )
    return dict(conn.execute("SELECT * FROM pin_groups WHERE id = ?", (gid,)).fetchone())


def _resolve_group(conn, body: "PinUpsertIn", existing) -> dict:
    """The group the pin should end up in (creating it when asked)."""
    if body.new_group:
        return _create_group(conn, body.new_group.name, body.new_group.color)
    if body.group_id:
        row = conn.execute("SELECT * FROM pin_groups WHERE id = ?", (body.group_id,)).fetchone()
        if row:
            return dict(row)
        if conn.execute("SELECT 1 FROM pin_groups LIMIT 1").fetchone():
            raise HTTPException(status_code=404, detail="Group not found")
    elif existing is not None:  # no destination given: stay where the pin is
        return dict(conn.execute("SELECT * FROM pin_groups WHERE id = ?", (existing["group_id"],)).fetchone())
    # nothing usable: first group, or a default one when none exist at all
    first = conn.execute("SELECT * FROM pin_groups ORDER BY sort_order ASC, rowid ASC LIMIT 1").fetchone()
    if first:
        return dict(first)
    return _create_group(conn, DEFAULT_GROUP_NAME, DEFAULT_GROUP_COLOR, group_id=DEFAULT_GROUP_ID)


def upsert_pin(conn, symbol: str, body: "PinUpsertIn", *, new_id: str | None = None,
               added_at: str | None = None) -> dict:
    """Create the pin for `symbol`, or move/update the existing one. Caller owns
    the transaction (get_db commits on success, rolls back on any exception)."""
    symbol = norm_symbol(symbol)
    if not symbol:
        raise HTTPException(status_code=422, detail="symbol is empty")
    existing = conn.execute("SELECT * FROM pinned_assets WHERE symbol = ?", (symbol,)).fetchone()
    group = _resolve_group(conn, body, existing)
    sent = body.model_fields_set

    if existing is None:
        pid = new_id or pin_id_for(symbol)
        order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM pinned_assets WHERE group_id = ?", (group["id"],)
        ).fetchone()[0]
        conn.execute(
            """INSERT INTO pinned_assets
               (id, symbol, group_id, comment, buy_target, sell_target, price_at_pin, priority, sort_order, added_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (pid, symbol, group["id"], body.comment or "", body.buy_target, body.sell_target,
             body.price_at_pin, body.priority or 1, order, added_at or _now(), _now()),
        )
        action = "created"
    else:
        pid = existing["id"]
        updates: dict = {}
        if existing["group_id"] != group["id"]:
            updates["group_id"] = group["id"]
            updates["sort_order"] = conn.execute(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM pinned_assets WHERE group_id = ?", (group["id"],)
            ).fetchone()[0]
        for col in ("comment", "buy_target", "sell_target", "price_at_pin", "priority"):
            if col in sent:
                v = getattr(body, col)
                if v is None and col in ("comment", "priority"):
                    continue  # NOT NULL columns: null means "no change"
                if v != existing[col]:
                    updates[col] = v
        action = "moved" if "group_id" in updates else "unchanged"
        if updates:
            updates["updated_at"] = _now()
            set_clause = ", ".join(f"{k} = ?" for k in updates)
            conn.execute(f"UPDATE pinned_assets SET {set_clause} WHERE id = ?", [*updates.values(), pid])
            if action == "unchanged":
                action = "updated"

    if body.tags is not None:
        conn.execute("DELETE FROM pinned_asset_tags WHERE asset_id = ?", (pid,))
        for tag_id in dict.fromkeys(body.tags):
            conn.execute("INSERT OR IGNORE INTO pinned_asset_tags (asset_id, tag_id) VALUES (?, ?)", (pid, tag_id))

    row = conn.execute("SELECT * FROM pinned_assets WHERE id = ?", (pid,)).fetchone()
    return {"action": action, "pin": _asset_with_tags(conn, row), "group": group}


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
        tags: dict[str, list[str]] = {}
        for tag in conn.execute("SELECT asset_id, tag_id FROM pinned_asset_tags"):
            tags.setdefault(tag["asset_id"], []).append(tag["tag_id"])
        return [{**dict(row), "tags": tags.get(row["id"], [])} for row in rows]


@router.put("/api/pins/by-symbol/{symbol}")
def put_pin_by_symbol(symbol: str, body: PinUpsertIn):
    """Upsert the one pin of `symbol`: create it, or MOVE it to another group.

    One symbol = one pin in exactly one group (multi-category is what tags are
    for). Group creation and pin write share one transaction, so a failure
    leaves neither behind. Returns {action: created|moved|updated|unchanged, pin, group}.
    """
    try:
        with get_db() as conn:
            return upsert_pin(conn, symbol, body)
    except sqlite3.Error as e:
        raise HTTPException(status_code=500, detail=f"pin write failed: {e}")


@router.post("/api/pins/assets", status_code=201)
def create_asset(body: PinnedAssetIn):
    """Legacy create. A symbol can only be pinned once, so a second POST for the
    same symbol is refused (409) instead of adding a duplicate - use
    PUT /api/pins/by-symbol/{symbol} to move it."""
    symbol = norm_symbol(body.symbol)
    if not symbol:
        raise HTTPException(status_code=422, detail="symbol is empty")
    with get_db() as conn:
        taken = conn.execute("SELECT id, group_id FROM pinned_assets WHERE symbol = ?", (symbol,)).fetchone()
        if taken:
            raise HTTPException(
                status_code=409,
                detail={"error": "symbol already pinned", "id": taken["id"], "group_id": taken["group_id"]},
            )
        try:
            conn.execute(
                """INSERT INTO pinned_assets
                   (id, symbol, group_id, comment, buy_target, sell_target, price_at_pin, priority, added_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (body.id, symbol, body.group_id, body.comment, body.buy_target, body.sell_target,
                 body.price_at_pin, body.priority, body.added_at or _now()),
            )
        except sqlite3.IntegrityError as e:
            raise HTTPException(status_code=409, detail=f"pin rejected: {e}")
        for tag_id in body.tags:
            conn.execute(
                "INSERT OR IGNORE INTO pinned_asset_tags (asset_id, tag_id) VALUES (?, ?)",
                (body.id, tag_id),
            )
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

        # exclude_unset, not exclude_none: a price target is cleared by sending
        # null, and exclude_none dropped exactly that field - the UI would empty
        # the box, the row would keep its old target, and the "price target hit"
        # badge went on warning about a target the user had deleted.
        #
        # Only the two target columns are nullable, so a null for anything else
        # is still ignored rather than writing NULL into a column that has never
        # held one.
        NULLABLE = {"buy_target", "sell_target"}
        updates = {
            k: v
            for k, v in body.model_dump(exclude_unset=True).items()
            if v is not None or k in NULLABLE
        }
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
        skipped = 0
        for a in body.assets:
            symbol = norm_symbol(a.get("symbol", ""))
            if not symbol:
                skipped += 1
                continue
            clash = conn.execute("SELECT id FROM pinned_assets WHERE symbol = ?", (symbol,)).fetchone()
            if clash and clash["id"] != a.get("id"):
                skipped += 1  # already pinned under another id: never a second row
                continue
            conn.execute(
                """INSERT OR REPLACE INTO pinned_assets
                   (id, symbol, group_id, comment, buy_target, sell_target, price_at_pin, priority, added_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    a.get("id", str(uuid.uuid4())),
                    symbol,
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
    return {"ok": True, "groups": len(body.groups), "assets": len(body.assets) - skipped, "skipped": skipped}
