"""
Row-level last-write-wins merge of N device snapshots.

Conflict = same natural key present in ≥2 snapshots with differing payloads.
Resolution = max(updated_at) wins. The losing version is captured in `conflicts`
so the caller can persist it (zero data loss). Deletes propagate via tombstones.
"""
from .config import SYNC_TABLES, TOMB_SEP


def _ua(row: dict) -> str:
    return row.get("updated_at") or ""


def _payload(row: dict) -> dict:
    # compare everything except the volatile timestamp
    return {k: v for k, v in row.items() if k != "updated_at"}


def merge_snapshots(snaps: list[dict]) -> tuple[dict, list, list]:
    """Returns (merged_tables, merged_tombstones, conflicts)."""
    # ── tombstones: latest deletion per (table, row_id) ──────────────────────
    tomb: dict[tuple[str, str], str] = {}
    for s in snaps:
        for t in s.get("tombstones", []):
            key = (t["table_name"], t["row_id"])
            d = t.get("deleted_at") or ""
            if d > tomb.get(key, ""):
                tomb[key] = d

    merged_tables: dict[str, list[dict]] = {}
    conflicts: list[dict] = []

    for table, pk in SYNC_TABLES:
        best: dict[tuple, dict] = {}
        for s in snaps:
            for row in s.get("tables", {}).get(table, []):
                key = tuple(str(row.get(c, "")) for c in pk)
                if key not in best:
                    best[key] = row
                    continue
                cur = best[key]
                if _payload(row) == _payload(cur):
                    # same data — keep newer timestamp, no conflict
                    if _ua(row) > _ua(cur):
                        best[key] = row
                    continue
                # genuine divergence → LWW, loser recorded
                if _ua(row) > _ua(cur):
                    conflicts.append({"table": table, "winner": row, "loser": cur})
                    best[key] = row
                else:
                    conflicts.append({"table": table, "winner": cur, "loser": row})

        # apply tombstones: drop a row if a newer-or-equal deletion exists
        out = []
        for key, row in best.items():
            rid = TOMB_SEP.join(str(row.get(c, "")) for c in pk)
            d = tomb.get((table, rid))
            if d and d >= _ua(row):
                continue
            out.append(row)
        merged_tables[table] = out

    merged_tombs = [
        {"table_name": k[0], "row_id": k[1], "deleted_at": v}
        for k, v in tomb.items()
    ]
    return merged_tables, merged_tombs, conflicts
