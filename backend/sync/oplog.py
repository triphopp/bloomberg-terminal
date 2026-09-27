"""
Operation-log sync: every device may edit, and every device converges.

Replaces the snapshot merge (manager.py) when OPLOG_ENABLED=true. The snapshot
merge exchanged whole tables and guessed which side of a disagreement was newer;
2026-09-27 it kept two machines apart for good (23 trades, identical
updated_at, no conflict logged). This module exchanges CHANGES instead:

  capture   triggers note which row changed (sync_pending) — nothing else
  flush     each noted row becomes an op: the row's full new content (or a
            delete), a hybrid-logical-clock stamp, and `parent` = the op this
            device last saw for that row
  export    a device appends ITS OWN ops to files only it writes:
            <cloud>/oplog/<device>/<from>-<to>.jsonl — never rewritten, so
            Drive never has two writers for one file
  apply     a device reads every peer's new ops, sorts the batch by
            (hlc, device, seq) and applies them. An op whose parent is the
            row's current head is a plain fast-forward. Anything else was
            written without seeing the other edit — a CONFLICT: both devices
            keep the op with the higher (hlc, device, op_id), so they agree,
            and both record the pair in sync_conflicts for the user to review.
  state     each device publishes <device>/state.json: which ops it has
            applied + a content fingerprint. Two devices that applied the same
            ops must hold the same data; if not, status says DIVERGED.

HLC stamps order edits by cause, not by wall clock: a device that has seen an
op always stamps its next edit later than it, so "edited after seeing it"
always wins without a conflict, and only true concurrency needs review.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import socket
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .config import MONEY_TABLES, SYNC_TABLES, TABLE_PK, TOMB_SEP, sync_dir

logger = logging.getLogger(__name__)

CHUNK_MAX = 2000                 # ops per exported file
DEFER_PARENT_MS = 60 * 60 * 1000  # wait this long for a missing parent op
_META_COLS = {"updated_at"}
_lock = threading.RLock()


# ── config ───────────────────────────────────────────────────────────────────
def enabled() -> bool:
    return os.getenv("OPLOG_ENABLED", "").strip().lower() == "true"


def root_dir() -> Path | None:
    base = sync_dir()
    return (base / "oplog") if base else None


def device_id(db_path: Path | str | None = None) -> str:
    """This machine's op-log identity: env override, else a file beside the DB.

    Kept OUT of the database on purpose — a DB copied to another machine
    (adopt_db_copy.py) must not bring its old owner's identity with it."""
    explicit = os.getenv("OPLOG_DEVICE_ID", "").strip()
    if explicit:
        return explicit
    if db_path is None:
        from config import DB_PATH
        db_path = DB_PATH
    p = Path(db_path)
    f = p.with_name(f".oplog_device_{p.stem}")
    try:
        v = f.read_text(encoding="utf-8").strip()
        if v:
            return v
    except OSError:
        pass
    host = "".join(ch if ch.isalnum() else "-" for ch in socket.gethostname().lower()).strip("-") or "host"
    v = f"{host}-{uuid.uuid4().hex[:8]}"
    f.write_text(v, encoding="utf-8")
    return v


# ── schema ───────────────────────────────────────────────────────────────────
def key_expr(prefix: str, pk: list[str]) -> str:
    return " || char(31) || ".join(f"CAST({prefix}.{c} AS TEXT)" for c in pk)


def install(conn: sqlite3.Connection) -> None:
    """Op-log tables + capture triggers. Idempotent; call after init_sync_layer."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS sync_pending (
            table_name TEXT NOT NULL,
            row_key    TEXT NOT NULL,
            PRIMARY KEY (table_name, row_key)
        );
        CREATE TABLE IF NOT EXISTS sync_oplog (
            op_id      TEXT PRIMARY KEY,
            device     TEXT NOT NULL,
            seq        INTEGER NOT NULL,
            hlc        TEXT NOT NULL,
            table_name TEXT NOT NULL,
            row_key    TEXT NOT NULL,
            kind       TEXT NOT NULL CHECK(kind IN ('upsert','delete')),
            row_json   TEXT,
            parent     TEXT,
            resolves   TEXT,
            local      INTEGER NOT NULL DEFAULT 0,
            applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
            UNIQUE (device, seq)
        );
        CREATE INDEX IF NOT EXISTS idx_sync_oplog_row ON sync_oplog(table_name, row_key);
        CREATE TABLE IF NOT EXISTS sync_row_head (
            table_name TEXT NOT NULL,
            row_key    TEXT NOT NULL,
            op_id      TEXT NOT NULL,
            hlc        TEXT NOT NULL,
            device     TEXT NOT NULL,
            PRIMARY KEY (table_name, row_key)
        );
        CREATE TABLE IF NOT EXISTS sync_peer_seq (
            device   TEXT PRIMARY KEY,
            last_seq INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync_oplog_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync_conflicts (
            id          TEXT PRIMARY KEY,
            table_name  TEXT NOT NULL,
            row_key     TEXT NOT NULL,
            kept_op     TEXT NOT NULL,
            kept_device TEXT NOT NULL,
            kept_row    TEXT,
            other_op    TEXT NOT NULL,
            other_device TEXT NOT NULL,
            other_row   TEXT,
            reason      TEXT NOT NULL DEFAULT 'concurrent',
            detected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
            resolved_at TEXT,
            resolution  TEXT
        );
    """)
    guard = "(SELECT active FROM _sync_guard) = 0"
    for table, pk in SYNC_TABLES:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
            continue
        for s in ("ins", "upd", "updk", "del"):
            conn.execute(f"DROP TRIGGER IF EXISTS trg_{table}_oplog_{s}")
        new_k, old_k = key_expr("NEW", pk), key_expr("OLD", pk)
        conn.execute(f"""
            CREATE TRIGGER trg_{table}_oplog_ins AFTER INSERT ON {table} FOR EACH ROW
            WHEN {guard} BEGIN
                INSERT OR IGNORE INTO sync_pending (table_name, row_key) VALUES ('{table}', {new_k});
            END;""")
        conn.execute(f"""
            CREATE TRIGGER trg_{table}_oplog_upd AFTER UPDATE ON {table} FOR EACH ROW
            WHEN {guard} BEGIN
                INSERT OR IGNORE INTO sync_pending (table_name, row_key) VALUES ('{table}', {new_k});
            END;""")
        conn.execute(f"""
            CREATE TRIGGER trg_{table}_oplog_updk AFTER UPDATE ON {table} FOR EACH ROW
            WHEN {guard} AND ({old_k}) IS NOT ({new_k}) BEGIN
                INSERT OR IGNORE INTO sync_pending (table_name, row_key) VALUES ('{table}', {old_k});
            END;""")
        conn.execute(f"""
            CREATE TRIGGER trg_{table}_oplog_del AFTER DELETE ON {table} FOR EACH ROW
            WHEN {guard} BEGIN
                INSERT OR IGNORE INTO sync_pending (table_name, row_key) VALUES ('{table}', {old_k});
            END;""")


# ── small helpers ────────────────────────────────────────────────────────────
def _meta(conn, key: str, default: str | None = None) -> str | None:
    r = conn.execute("SELECT value FROM sync_oplog_meta WHERE key=?", (key,)).fetchone()
    return r[0] if r else default


def _set_meta(conn, key: str, value) -> None:
    conn.execute("INSERT INTO sync_oplog_meta (key, value) VALUES (?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))


def _hlc_parse(s: str | None) -> tuple[int, int]:
    if not s:
        return (0, 0)
    ms, _, c = s.partition(".")
    return (int(ms), int(c or 0))


def _hlc_fmt(ms: int, c: int) -> str:
    return f"{ms:015d}.{c:06d}"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _tick(conn) -> str:
    """Next local HLC stamp — strictly after everything this device has seen."""
    pm, pc = _hlc_parse(_meta(conn, "hlc"))
    now = _now_ms()
    ms, c = (now, 0) if now > pm else (pm, pc + 1)
    s = _hlc_fmt(ms, c)
    _set_meta(conn, "hlc", s)
    return s


def _observe(conn, remote: str) -> None:
    """Advance the local clock past a remote stamp (the causal half of HLC)."""
    if _hlc_parse(remote) > _hlc_parse(_meta(conn, "hlc")):
        _set_meta(conn, "hlc", remote)


def _next_seq(conn, device: str) -> int:
    n = int(_meta(conn, f"seq:{device}", "0")) + 1
    _set_meta(conn, f"seq:{device}", n)
    return n


def _columns(conn, table: str) -> dict[str, str]:
    return {r[1]: (r[2] or "").upper() for r in conn.execute(f"PRAGMA table_info({table})")}


def _key_where(conn, table: str) -> str:
    """Match the text row_key. A TEXT key column is compared as-is so its
    index is used; only non-text keys pay for the CAST (and a scan)."""
    types = _columns(conn, table)
    return " AND ".join(f"{c} = ?" if types.get(c, "").startswith("TEXT") else f"CAST({c} AS TEXT) = ?"
                        for c in TABLE_PK[table])


def _read_row(conn, table: str, row_key: str) -> dict | None:
    r = conn.execute(f"SELECT * FROM {table} WHERE {_key_where(conn, table)}", row_key.split(TOMB_SEP)).fetchone()
    return dict(r) if r else None


def _payload(row: dict | None) -> dict | None:
    """Row content that matters for equality — drops sync stamps and a
    device-local surrogate id."""
    if row is None:
        return None
    return {k: v for k, v in row.items() if k not in _META_COLS}


def _same(a: dict | None, b: dict | None, table: str) -> bool:
    pk = TABLE_PK[table]
    strip = (lambda r: None if r is None else
             {k: v for k, v in _payload(r).items() if not (k == "id" and "id" not in pk)})
    return strip(a) == strip(b)


def _dumps(row: dict | None) -> str | None:
    return None if row is None else json.dumps(row, sort_keys=True, default=str, ensure_ascii=False)


@contextmanager
def _txn(conn: sqlite3.Connection):
    """BEGIN IMMEDIATE: flush + apply run while no request can slip a write in
    between (it would be applied-over without ever becoming an op).
    Foreign keys on, as in the app's get_db(): peer ops replay in their
    author's order, which was valid under the same constraints there."""
    prev = conn.isolation_level
    conn.isolation_level = None
    conn.execute("PRAGMA foreign_keys = ON")  # no-op inside a transaction, so set first
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.isolation_level = prev


@contextmanager
def _guarded(conn):
    conn.execute("UPDATE _sync_guard SET active = 1")
    try:
        yield
    finally:
        conn.execute("UPDATE _sync_guard SET active = 0")


def _record_op(conn, op: dict, local: bool) -> None:
    conn.execute(
        "INSERT INTO sync_oplog (op_id, device, seq, hlc, table_name, row_key, kind, row_json, parent, resolves, local) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (op["op_id"], op["device"], op["seq"], op["hlc"], op["table"], op["row_key"], op["kind"],
         _dumps(op.get("row")), op.get("parent"), op.get("resolves"), 1 if local else 0))
    conn.execute(
        "INSERT INTO sync_row_head (table_name, row_key, op_id, hlc, device) VALUES (?,?,?,?,?) "
        "ON CONFLICT(table_name, row_key) DO UPDATE SET op_id=excluded.op_id, hlc=excluded.hlc, device=excluded.device",
        (op["table"], op["row_key"], op["op_id"], op["hlc"], op["device"]))


def _head(conn, table: str, row_key: str) -> dict | None:
    r = conn.execute("SELECT op_id, hlc, device FROM sync_row_head WHERE table_name=? AND row_key=?",
                     (table, row_key)).fetchone()
    return {"op_id": r[0], "hlc": r[1], "device": r[2]} if r else None


def _head_row(conn, head: dict | None) -> dict | None:
    if not head:
        return None
    r = conn.execute("SELECT row_json FROM sync_oplog WHERE op_id=?", (head["op_id"],)).fetchone()
    return json.loads(r[0]) if r and r[0] else None


def _new_op(conn, device: str, table: str, row_key: str, row: dict | None, resolves: str | None = None) -> dict:
    head = _head(conn, table, row_key)
    return {
        "op_id": uuid.uuid4().hex,
        "device": device,
        "seq": _next_seq(conn, device),
        "hlc": _tick(conn),
        "table": table,
        "row_key": row_key,
        "kind": "upsert" if row is not None else "delete",
        "row": row,
        "parent": head["op_id"] if head else None,
        "resolves": resolves,
    }


# ── flush: pending rows → local ops ──────────────────────────────────────────
def _flush(conn, device: str) -> int:
    pending = conn.execute("SELECT table_name, row_key FROM sync_pending ORDER BY rowid").fetchall()
    made = 0
    for table, row_key in pending:
        conn.execute("DELETE FROM sync_pending WHERE table_name=? AND row_key=?", (table, row_key))
        if table not in TABLE_PK:
            continue
        row = _read_row(conn, table, row_key)
        head = _head(conn, table, row_key)
        if head is not None:
            last = _head_row(conn, head)
            last_kind = conn.execute("SELECT kind FROM sync_oplog WHERE op_id=?", (head["op_id"],)).fetchone()
            if (row is None and last_kind and last_kind[0] == "delete") or (
                    row is not None and last is not None and row == last):
                continue  # nothing new since the op we already hold
        _record_op(conn, _new_op(conn, device, table, row_key, row), local=True)
        made += 1
    return made


def flush(conn: sqlite3.Connection, device: str) -> int:
    with _lock, _txn(conn):
        return _flush(conn, device)


def _close_superseded(conn, op: dict) -> None:
    """The losing side's own author edited that row again (op.parent is the
    losing op): its lost version was replaced by its author, not by us, so
    that conflict is moot. Only this narrow case closes on its own — a later
    edit from anyone else may never have seen the conflict."""
    if op.get("parent"):
        conn.execute(
            "UPDATE sync_conflicts SET resolved_at=strftime('%Y-%m-%d %H:%M:%f','now'), resolution=? "
            "WHERE other_op=? AND resolved_at IS NULL",
            (f"superseded: {op['device']} edited again", op["parent"]))


# ── export: own ops → own files ──────────────────────────────────────────────
def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:6]}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _op_from_row(r) -> dict:
    return {"op_id": r["op_id"], "device": r["device"], "seq": r["seq"], "hlc": r["hlc"],
            "table": r["table_name"], "row_key": r["row_key"], "kind": r["kind"],
            "row": json.loads(r["row_json"]) if r["row_json"] else None,
            "parent": r["parent"], "resolves": r["resolves"]}


def export(conn: sqlite3.Connection, device: str, root: Path) -> int:
    with _lock:
        done = int(_meta(conn, f"exported:{device}", "0"))
        rows = conn.execute("SELECT * FROM sync_oplog WHERE device=? AND seq>? ORDER BY seq",
                            (device, done)).fetchall()
        sent = 0
        for i in range(0, len(rows), CHUNK_MAX):
            part = rows[i:i + CHUNK_MAX]
            lo, hi = part[0]["seq"], part[-1]["seq"]
            body = "".join(json.dumps(_op_from_row(r), sort_keys=True, default=str, ensure_ascii=False) + "\n"
                           for r in part)
            _atomic_write(root / device / f"{lo:012d}-{hi:012d}.jsonl", body)
            with _txn(conn):
                _set_meta(conn, f"exported:{device}", hi)
            sent += len(part)
        return sent


# ── import + apply ───────────────────────────────────────────────────────────
def _read_peer(root: Path, peer: str, after: int) -> list[dict]:
    """Ops with seq > after, contiguous from after+1 (stops at a missing file)."""
    files = []
    for f in (root / peer).glob("*.jsonl"):
        try:
            lo, hi = (int(x) for x in f.stem.split("-"))
        except ValueError:
            continue
        if hi > after:
            files.append((lo, hi, f))
    ops: list[dict] = []
    want = after + 1
    for lo, hi, f in sorted(files):
        if lo > want:
            break  # a chunk has not arrived through Drive yet
        for line in f.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            op = json.loads(line)
            if op["seq"] == want:
                ops.append(op)
                want += 1
    return ops


def _upsert_row(conn, table: str, row: dict) -> None:
    pk = TABLE_PK[table]
    cols_here = _columns(conn, table)
    # an INTEGER surrogate id is device-local (autoincrement) and must not cross
    cols = [c for c in row if c in cols_here and not (c == "id" and "id" not in pk and cols_here[c].startswith("INT"))]
    setters = [c for c in cols if c not in pk and c != "id"]
    sql = (f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)}) "
           f"ON CONFLICT({', '.join(pk)}) DO ")
    sql += ("UPDATE SET " + ", ".join(f"{c}=excluded.{c}" for c in setters)) if setters else "NOTHING"
    conn.execute(sql, [row[c] for c in cols])


def _delete_row(conn, table: str, row_key: str) -> None:
    conn.execute(f"DELETE FROM {table} WHERE {_key_where(conn, table)}", row_key.split(TOMB_SEP))


def _conflict_id(table: str, row_key: str, loser_op: str) -> str:
    """Keyed on the LOSING op: the winner rule is deterministic, so every
    device that sees the clash names the same loser — and a resolution made on
    one device closes the same conflict on the others."""
    return hashlib.sha256(f"{table}\x1f{row_key}\x1f{loser_op}".encode()).hexdigest()[:32]


def _record_conflict(conn, table, row_key, kept: dict, kept_row, other: dict, other_row, reason="concurrent"):
    """`other` is the losing side."""
    cid = _conflict_id(table, row_key, other["op_id"])
    conn.execute(
        "INSERT OR IGNORE INTO sync_conflicts (id, table_name, row_key, kept_op, kept_device, kept_row, "
        "other_op, other_device, other_row, reason) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (cid, table, row_key, kept["op_id"], kept["device"], _dumps(kept_row),
         other["op_id"], other["device"], _dumps(other_row), reason))


def _write(conn, op: dict) -> None:
    if op["kind"] == "delete":
        _delete_row(conn, op["table"], op["row_key"])
    else:
        _upsert_row(conn, op["table"], op["row"])


def _apply_one(conn, op: dict) -> str:
    """Apply a peer op. Returns 'applied' | 'kept' | 'dup' | 'failed'."""
    if conn.execute("SELECT 1 FROM sync_oplog WHERE op_id=?", (op["op_id"],)).fetchone():
        return "dup"
    table, row_key = op["table"], op["row_key"]
    _observe(conn, op["hlc"])
    if table not in TABLE_PK:
        conn.execute("INSERT INTO sync_oplog (op_id, device, seq, hlc, table_name, row_key, kind, row_json, parent) "
                     "VALUES (?,?,?,?,?,?,?,?,?)", (op["op_id"], op["device"], op["seq"], op["hlc"], table,
                                                   row_key, op["kind"], _dumps(op.get("row")), op.get("parent")))
        return "kept"  # a table this device does not sync (older code) — remember, do not apply
    head = _head(conn, table, row_key)
    current = _read_row(conn, table, row_key)
    if op.get("resolves"):
        conn.execute("UPDATE sync_conflicts SET resolved_at=strftime('%Y-%m-%d %H:%M:%f','now'), "
                     "resolution=? WHERE id=? AND resolved_at IS NULL",
                     (f"resolved on {op['device']}", op["resolves"]))

    fast_forward = head is None or op.get("parent") == head["op_id"]
    wins = fast_forward or (op["hlc"], op["device"], op["op_id"]) > (head["hlc"], head["device"], head["op_id"])
    if wins:
        try:
            with conn_savepoint(conn):
                _write(conn, op)
        except sqlite3.DatabaseError as e:
            conn.execute("INSERT INTO sync_oplog (op_id, device, seq, hlc, table_name, row_key, kind, row_json, parent) "
                         "VALUES (?,?,?,?,?,?,?,?,?)", (op["op_id"], op["device"], op["seq"], op["hlc"], table,
                                                       row_key, op["kind"], _dumps(op.get("row")), op.get("parent")))
            _record_conflict(conn, table, row_key, head or {"op_id": "local", "device": "local"}, current,
                             op, op.get("row"), reason=f"apply failed: {e}")
            return "failed"
        _record_op(conn, op, local=False)
        _close_superseded(conn, op)
        if not fast_forward and not _same(current, op.get("row"), table):
            _record_conflict(conn, table, row_key, op, op.get("row"), head, current)
        return "applied"
    # a concurrent op that loses: keep our row, remember the op, flag it
    conn.execute("INSERT INTO sync_oplog (op_id, device, seq, hlc, table_name, row_key, kind, row_json, parent, resolves) "
                 "VALUES (?,?,?,?,?,?,?,?,?,?)", (op["op_id"], op["device"], op["seq"], op["hlc"], table, row_key,
                                                 op["kind"], _dumps(op.get("row")), op.get("parent"), op.get("resolves")))
    _close_superseded(conn, op)
    if not _same(current, op.get("row"), table):
        _record_conflict(conn, table, row_key, head, current, op, op.get("row"))
    return "kept"


@contextmanager
def conn_savepoint(conn):
    conn.execute("SAVEPOINT oplog_apply")
    try:
        yield
        conn.execute("RELEASE oplog_apply")
    except Exception:
        conn.execute("ROLLBACK TO oplog_apply")
        conn.execute("RELEASE oplog_apply")
        raise


def pull(conn: sqlite3.Connection, device: str, root: Path) -> dict:
    """Read every peer's new ops and apply them in (hlc, device, seq) order."""
    with _lock:
        peers = [p.name for p in root.iterdir() if p.is_dir() and p.name != device] if root.exists() else []
        seen = {r[0]: r[1] for r in conn.execute("SELECT device, last_seq FROM sync_peer_seq")}
        batch: list[dict] = []
        for peer in peers:
            try:
                batch += _read_peer(root, peer, seen.get(peer, 0))
            except (OSError, ValueError) as e:
                logger.warning("oplog: cannot read %s: %s", peer, e)
        batch.sort(key=lambda o: (o["hlc"], o["device"], o["seq"]))
        counts = {"applied": 0, "kept": 0, "dup": 0, "failed": 0, "deferred": 0}
        touched: set[str] = set()
        if not batch:
            return counts
        with _txn(conn):
            _flush(conn, device)  # our own edits get their op before any peer op lands on them
            blocked: set[str] = set()
            known = {r[0] for r in conn.execute("SELECT op_id FROM sync_oplog")}
            with _guarded(conn):
                for op in batch:
                    if op["device"] in blocked:
                        counts["deferred"] += 1
                        continue
                    parent = op.get("parent")
                    if parent and parent not in known and \
                            _now_ms() - _hlc_parse(op["hlc"])[0] < DEFER_PARENT_MS:
                        blocked.add(op["device"])  # its parent is still travelling
                        counts["deferred"] += 1
                        continue
                    counts[_apply_one(conn, op)] += 1
                    known.add(op["op_id"])
                    touched.add(op["table"])
                    conn.execute("INSERT INTO sync_peer_seq (device, last_seq) VALUES (?, ?) "
                                 "ON CONFLICT(device) DO UPDATE SET last_seq=excluded.last_seq",
                                 (op["device"], op["seq"]))
                if touched & {"paper_orders", "paper_fills"}:
                    from .derived import rebuild_all
                    rebuild_all(conn)
        counts["tables"] = sorted(touched)
        return counts


# ── state + divergence check ─────────────────────────────────────────────────
def fingerprint(conn) -> dict[str, str]:
    out = {}
    for table in sorted(MONEY_TABLES):
        cols = sorted(_columns(conn, table))
        if not cols:
            continue
        order = ", ".join(f'"{c}"' for c in cols)
        rows = conn.execute(f"SELECT {order} FROM {table} ORDER BY {order}").fetchall()
        blob = json.dumps([list(r) for r in rows], default=str, ensure_ascii=False)
        out[table] = hashlib.sha256(blob.encode()).hexdigest()[:16]
    return out


def vector(conn, device: str) -> dict[str, int]:
    v = {r[0]: r[1] for r in conn.execute("SELECT device, last_seq FROM sync_peer_seq")}
    v[device] = int(_meta(conn, f"seq:{device}", "0"))
    return {k: n for k, n in v.items() if n}


def publish_state(conn, device: str, root: Path) -> dict:
    state = {"device": device, "at": datetime.now(timezone.utc).isoformat(),
             "vector": vector(conn, device), "fingerprint": fingerprint(conn),
             "pending": conn.execute("SELECT COUNT(*) FROM sync_pending").fetchone()[0]}
    _atomic_write(root / device / "state.json", json.dumps(state, sort_keys=True))
    return state


def status(conn, device: str, root: Path | None) -> dict:
    me = {"device": device, "vector": vector(conn, device), "fingerprint": fingerprint(conn)}
    open_c = conn.execute("SELECT COUNT(*) FROM sync_conflicts WHERE resolved_at IS NULL").fetchone()[0]
    peers = []
    if root and root.exists():
        for f in root.glob("*/state.json"):
            if f.parent.name == device:
                continue
            try:
                st = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            same_ops = st.get("vector") == me["vector"]
            peers.append({
                "device": st.get("device"), "at": st.get("at"),
                "state": ("in_sync" if st.get("fingerprint") == me["fingerprint"] else "DIVERGED")
                         if same_ops else "catching_up",
            })
    return {"mode": "oplog", "device": device, "root": str(root) if root else None,
            "pending": conn.execute("SELECT COUNT(*) FROM sync_pending").fetchone()[0],
            "ops": conn.execute("SELECT COUNT(*) FROM sync_oplog").fetchone()[0],
            "open_conflicts": open_c, "peers": peers,
            "diverged": any(p["state"] == "DIVERGED" for p in peers)}


def sync_once(conn: sqlite3.Connection, device: str, root: Path) -> dict:
    """One full round: own edits out, peers' edits in, state published."""
    made = flush(conn, device)
    sent = export(conn, device, root)
    got = pull(conn, device, root)
    sent += export(conn, device, root)  # ops flushed inside pull
    publish_state(conn, device, root)
    return {"flushed": made, "exported": sent, **got}


def sync_pages(conn: sqlite3.Connection, base: Path, device: str) -> dict:
    """Carry the analysis-page HTML files (sync/files.py) that `graphs` rows name.

    The op-log moves the ROWS; the page file is not a row, and until 2026-09-27
    only the snapshot sync (manager.py) moved it — so with OPLOG_ENABLED a page
    made on one machine was listed on the other and rendered 404. `base` is the
    sync root the snapshot sync used (<SYNC_DIR>, not <SYNC_DIR>/oplog), so both
    modes share one `graphs/` folder and manifest. Pull first: push refuses a
    slug whose cloud copy changed since we last saw it, and pull is what takes it.
    """
    from .files import live_slugs, pull_files, push_files
    slugs = live_slugs(conn)
    got = pull_files(base, slugs, device)
    put = push_files(base, slugs, device)
    return {"taken": got["taken"], "sent": put["sent"], "skipped": got["skipped"] + put["skipped"]}


def run_round(conn: sqlite3.Connection, device: str, root: Path) -> dict:
    """What the worker runs: the op-log round, then the page files beside it.

    A page failure is reported in the result, never raised — it must not stop
    the row sync that the portfolio depends on."""
    result = sync_once(conn, device, root)
    try:
        result["pages"] = sync_pages(conn, root.parent, device)
    except Exception as e:
        logger.warning("oplog page sync failed: %s", e)
        result["pages"] = {"error": str(e)}
    return result


# ── conflict review ──────────────────────────────────────────────────────────
def conflicts(conn, open_only: bool = True) -> list[dict]:
    q = "SELECT * FROM sync_conflicts" + (" WHERE resolved_at IS NULL" if open_only else "") + " ORDER BY detected_at"
    out = []
    for r in conn.execute(q):
        d = dict(r) if isinstance(r, sqlite3.Row) else r
        for k in ("kept_row", "other_row"):
            d[k] = json.loads(d[k]) if d.get(k) else None
        out.append(d)
    return out


def resolve(conn: sqlite3.Connection, device: str, conflict_id: str, choice: str) -> dict:
    """choice 'kept' = leave the row as it is; 'other' = put the other side's
    version back. Either way an op carrying `resolves` travels, so the peer
    closes the same conflict and ends on the same row."""
    if choice not in ("kept", "other"):
        raise ValueError("choice must be 'kept' or 'other'")
    with _lock, _txn(conn):
        _flush(conn, device)
        c = conn.execute("SELECT * FROM sync_conflicts WHERE id=?", (conflict_id,)).fetchone()
        if not c:
            raise KeyError(conflict_id)
        c = dict(c)
        table, row_key = c["table_name"], c["row_key"]
        if choice == "other":
            row = json.loads(c["other_row"]) if c["other_row"] else None
            with _guarded(conn):
                if row is None:
                    _delete_row(conn, table, row_key)
                else:
                    _upsert_row(conn, table, row)
        row = _read_row(conn, table, row_key)
        op = _new_op(conn, device, table, row_key, row, resolves=conflict_id)
        _record_op(conn, op, local=True)
        conn.execute("UPDATE sync_conflicts SET resolved_at=strftime('%Y-%m-%d %H:%M:%f','now'), resolution=? "
                     "WHERE id=?", (f"kept {'other' if choice == 'other' else 'current'} on {device}", conflict_id))
        return {"ok": True, "op_id": op["op_id"], "row": row}


# ── background worker (app process) ──────────────────────────────────────────
_state = {"last_sync": None, "last_error": None, "last_result": None}
_wake = threading.Event()
_started = False


def request_sync() -> None:
    _wake.set()


def _worker(interval: float) -> None:
    from db import connect
    while True:
        _wake.wait(timeout=interval)
        _wake.clear()
        time.sleep(1.5)  # let a burst of writes finish
        root = root_dir()
        if root is None:
            continue
        try:
            conn = connect()
            try:
                _state["last_result"] = run_round(conn, device_id(), root)
                _state["last_sync"] = datetime.now(timezone.utc).isoformat()
                _state["last_error"] = None
            finally:
                conn.close()
        except Exception as e:  # never kill the worker
            _state["last_error"] = str(e)
            logger.warning("oplog sync failed: %s", e)


def start() -> bool:
    global _started
    if _started or not enabled() or root_dir() is None:
        return False
    _started = True
    interval = float(os.getenv("OPLOG_INTERVAL", "15"))
    threading.Thread(target=_worker, args=(interval,), name="oplog-sync", daemon=True).start()
    request_sync()
    return True


def app_status() -> dict:
    from db import connect
    conn = connect(readonly=True)
    try:
        return {**status(conn, device_id(), root_dir()), "enabled": enabled(), **_state}
    finally:
        conn.close()
