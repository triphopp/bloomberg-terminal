"""
Dynamic symbol-list management — CRUD for symbol_lists table.
"""
from fastapi import APIRouter, HTTPException

from db import (
    get_symbol_list,
    get_heatmap_groups,
    add_symbol_to_list,
    remove_symbol_from_list,
    update_symbol_in_list,
)

router = APIRouter()


@router.get("/api/config/symbols")
def list_all_symbol_lists():
    """Return all available list_ids with their symbol counts."""
    from db import get_db
    with get_db() as conn:
        rows = conn.execute(
            "SELECT list_id, COUNT(*) as count FROM symbol_lists "
            "WHERE enabled = 1 GROUP BY list_id ORDER BY list_id"
        ).fetchall()
    return {"lists": [{"list_id": r["list_id"], "count": r["count"]} for r in rows]}


@router.get("/api/config/symbols/{list_id}")
def get_symbols_in_list(list_id: str):
    """Return all enabled symbols in a symbol list."""
    symbols = get_symbol_list(list_id)
    if not symbols:
        # Check if the list_id exists at all (maybe all disabled)
        from db import get_db
        with get_db() as conn:
            exists = conn.execute(
                "SELECT COUNT(*) FROM symbol_lists WHERE list_id = ?", (list_id,)
            ).fetchone()[0]
        if not exists:
            raise HTTPException(status_code=404, detail=f"List '{list_id}' not found")
    return {"list_id": list_id, "symbols": symbols, "count": len(symbols)}


@router.post("/api/config/symbols/{list_id}")
def add_symbol(list_id: str, symbol: str, label: str = "",
               region: str = "", meta: dict | None = None):
    """Add a symbol to a list."""
    try:
        row_id = add_symbol_to_list(list_id, symbol, label, region, meta)
        return {"ok": True, "id": row_id}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/api/config/symbols/{list_id}/{symbol_id}")
def delete_symbol(list_id: str, symbol_id: int):
    """Disable a symbol in a list (soft delete)."""
    ok = remove_symbol_from_list(symbol_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Symbol id={symbol_id} not found")
    return {"ok": True}


@router.patch("/api/config/symbols/{list_id}/{symbol_id}")
def patch_symbol(list_id: str, symbol_id: int, fields: dict):
    """Update fields on a symbol (label, region, meta, sort_order, enabled)."""
    ok = update_symbol_in_list(symbol_id, **fields)
    if not ok:
        raise HTTPException(
            status_code=404,
            detail=f"Symbol id={symbol_id} not found or no valid fields provided",
        )
    return {"ok": True}
