"""
Three-way, field-level merge of the local DB against N device snapshots.

The third leg is `base`, persisted by manager.py after every successful pull. It
carries TWO kinds of ancestor, and the distinction is load-bearing:

    base["tables"]        the merged result — ancestor for the LOCAL side
    base["peers"][dev]    that peer's snapshot as we last saw it — ancestor
                          for THAT peer's side

so the two questions come out separately —

    changed_local  = local[field]  != base["tables"][field]
    changed_remote = remote[field] != base["peers"][dev][field]

A single shared ancestor does NOT work, and fails in the worst possible
direction. After a merge the base holds the merged (newer) value while an
offline peer's snapshot still holds the old one; comparing that peer against
the merged base reports "remote changed" for every row it never touched, and
since local now equals the base ("unchanged"), the peer's stale value wins and
the merge silently reverts real data — on every pull, forever. That is a data
loss bug, not a conflict-noise bug. Per-peer ancestors make an untouched peer
compare equal to itself and contribute nothing.

    remote only   → take remote          (no conflict)
    local only    → keep local           (no conflict)
    both, equal   → take it              (no conflict)
    both, differ  → REAL conflict → last-write-wins on that field, loser kept

Without a base, "the values differ" was the only signal available, so a peer
that had merely been offline for a week — every one of its rows stale, none of
them concurrent edits — reported as dozens of conflicts on every single merge,
and a row-level winner threw away whichever fields the loser had legitimately
edited. Both of those are gone.

With no ancestor for a peer — a device seen for the first time, or a row that
peer did not have last time — the pair falls back to row-level last-write-wins,
the behaviour that predates this file. Field-level merging starts from the
second time the two devices meet, which under the 20s auto-pull is immediate.
Guessing an ancestor instead is what produced the revert above.
"""
from .config import MONEY_TABLES, SYNC_TABLES, TOMB_SEP

# Bookkeeping columns that must never take part in field comparison.
_META = {"updated_at"}

# Stands for "this field was not in the ancestor" — never equal to a JSON value.
_ABSENT = object()


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


def _lww_row(table: str, pk: list[str], a: dict, b: dict, conflicts: list) -> dict:
    """Row-level last-write-wins — used when the pair has no common ancestor."""
    if _payload(a) == _payload(b):
        return a if _ua(a) >= _ua(b) else b
    if _ua(b) > _ua(a):
        winner, loser = b, a
    elif _ua(a) > _ua(b):
        winner, loser = a, b
    else:  # equal stamps, differing data — same answer on every device
        winner, loser = (a, b) if str(_payload(a)) > str(_payload(b)) else (b, a)
    conflicts.append({
        "table":  table,
        "key":    list(_key(a, pk)),
        "fields": ["__row__"],
        "winner": winner,
        "loser":  loser,
    })
    return winner


def _merge_row(table: str, pk: list[str], a: dict, a_base: dict | None,
               b: dict, b_base: dict | None, conflicts: list) -> dict:
    """Field-level three-way merge, each side against ITS OWN ancestor."""
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

        # A field absent from an ancestor counts as changed on that side. The
        # sentinel object() can never equal a JSON value, which is the point.
        a_ch = av != (a_base or {}).get(field, _ABSENT)
        b_ch = bv != (b_base or {}).get(field, _ABSENT)

        if b_ch and not a_ch:
            out[field] = bv
        elif a_ch and not b_ch:
            out[field] = av
        elif not a_ch and not b_ch:
            # Neither side edited this field, yet they disagree — the two
            # ancestors are simply from different eras (an offline peer's
            # ancestor predates the merged base). That divergence was already
            # resolved by an earlier merge, so the merged side stands. Calling
            # it a conflict is what kept a week-old peer generating noise.
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
    """Merge `snaps` (LOCAL SNAPSHOT FIRST) → (merged_tables, tombstones, conflicts).

    `base` is {"tables": …, "peers": {device: {"tables": …}}} as written by
    manager.py. Missing entries degrade to last-write-wins, never to a guess.
    """
    base_tables = (base or {}).get("tables") or {}
    peer_bases = (base or {}).get("peers") or {}

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
        # index the ancestors once per table
        base_rows = {_key(r, pk): r for r in base_tables.get(table, [])}
        peer_rows = {
            dev: {_key(r, pk): r for r in (pb.get("tables") or {}).get(table, [])}
            for dev, pb in peer_bases.items()
        }

        best: dict[tuple, dict] = {}
        for i, s in enumerate(snaps):
            # snaps[0] is this device; the rest are peers, each with its own
            # ancestor. An unknown device (or unknown row) has no ancestor at
            # all, and inventing one is exactly what reverts data.
            anc = None if i == 0 else peer_rows.get(s.get("device") or "")
            for row in s.get("tables", {}).get(table, []):
                key = _key(row, pk)
                cur = best.get(key)
                if cur is None:
                    best[key] = row
                    continue
                peer_anc = anc.get(key) if anc is not None else None
                if peer_anc is None:
                    best[key] = _lww_row(table, pk, cur, row, conflicts)
                else:
                    best[key] = _merge_row(table, pk, cur, base_rows.get(key),
                                           row, peer_anc, conflicts)

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
