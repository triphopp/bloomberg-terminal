"""
Three-way, field-level merge of the local DB against N device snapshots.

The third leg is `base`: the merged state this device last agreed on, persisted
by manager.py after every successful pull. It is what makes the two questions
below answerable separately —

    changed_local  = local[field]  != base[field]
    changed_remote = remote[field] != base[field]

    remote only   → take remote          (no conflict)
    local only    → keep local           (no conflict)
    both, equal   → take it              (no conflict)
    both, differ  → REAL conflict → last-write-wins on that field, loser kept

Without a base, "the values differ" was the only signal available, so a peer
that had merely been offline for a week — every one of its rows stale, none of
them concurrent edits — reported as dozens of conflicts on every single merge,
and a row-level winner threw away whichever fields the loser had legitimately
edited. Both of those are gone.

With no base (first ever merge, or a key that is new on both devices) every
field counts as changed on both sides, which degrades exactly to the old
last-write-wins behaviour — never worse than before.
"""
from .config import MONEY_TABLES, SYNC_TABLES, TOMB_SEP

# Bookkeeping columns that must never take part in field comparison.
_META = {"updated_at"}


def _ua(row: dict | None) -> str:
    return (row or {}).get("updated_at") or ""


def _payload(row: dict) -> dict:
    return {k: v for k, v in row.items() if k not in _META}


def _key(row: dict, pk: list[str]) -> tuple:
    return tuple(str(row.get(c, "")) for c in pk)


def _pick(a, b) -> object:
    """Deterministic tie-break for two values whose timestamps are equal.

    Must not depend on which device is running: `str` ordering gives both
    machines the same answer, so they converge instead of each keeping its own
    value forever. (Preferring "local" here is what would diverge.)"""
    return a if str(a) > str(b) else b


def _merge_row(table: str, pk: list[str], base: dict | None,
               a: dict, b: dict, conflicts: list) -> dict:
    """Field-level three-way merge of two versions of the same row."""
    if _payload(a) == _payload(b):
        # identical data — keep the newer stamp so it does not flap on re-merge
        return a if _ua(a) >= _ua(b) else b

    a_new, b_new = _ua(a) > _ua(b), _ua(b) > _ua(a)
    out = dict(a)
    clashes: list[str] = []

    for field in set(a) | set(b):
        if field in _META:
            continue
        av, bv = a.get(field), b.get(field)
        if av == bv:
            out[field] = av
            continue

        # A field absent from `base` counts as changed on both sides.
        basev = (base or {}).get(field, object())
        a_ch, b_ch = av != basev, bv != basev

        if b_ch and not a_ch:
            out[field] = bv
        elif a_ch and not b_ch:
            out[field] = av
        else:
            # genuine concurrent edit of the same field
            clashes.append(field)
            out[field] = av if a_new else bv if b_new else _pick(av, bv)

    out["updated_at"] = max(_ua(a), _ua(b))

    if clashes:
        winner, loser = (a, b) if a_new else (b, a) if b_new else (out, b)
        conflicts.append({
            "table":  table,
            "key":    list(_key(a, pk)),
            "fields": sorted(clashes),
            "winner": winner,
            "loser":  loser,
        })
    return out


def merge_snapshots(snaps: list[dict], base: dict | None = None) -> tuple[dict, list, list]:
    """Merge `snaps` (local snapshot first) → (merged_tables, tombstones, conflicts).

    `base` is a previously merged snapshot dict ({"tables": …}); None disables
    three-way resolution and falls back to plain last-write-wins.
    """
    base_tables = (base or {}).get("tables") or {}

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
        # index the base once per table
        base_rows = {_key(r, pk): r for r in base_tables.get(table, [])}

        best: dict[tuple, dict] = {}
        for s in snaps:
            for row in s.get("tables", {}).get(table, []):
                key = _key(row, pk)
                cur = best.get(key)
                if cur is None:
                    best[key] = row
                else:
                    best[key] = _merge_row(table, pk, base_rows.get(key), cur, row, conflicts)

        # apply tombstones
        out = []
        for key, row in best.items():
            rid = TOMB_SEP.join(str(row.get(c, "")) for c in pk)
            d = tomb.get((table, rid))
            if d:
                ua = _ua(row)
                deleted = d > ua if table in MONEY_TABLES else d >= ua
                if deleted:
                    continue
                if d == ua:  # survived a same-timestamp delete — say so
                    conflicts.append({
                        "table": table, "key": list(key), "fields": ["__deleted__"],
                        "winner": row, "loser": {"deleted_at": d},
                    })
            out.append(row)
        merged_tables[table] = out

    merged_tombs = [
        {"table_name": k[0], "row_id": k[1], "deleted_at": v}
        for k, v in tomb.items()
    ]
    return merged_tables, merged_tombs, conflicts
