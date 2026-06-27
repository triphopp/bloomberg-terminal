"""
Snapshot export + atomic JSON write + content hashing.
"""
import hashlib
import json
import os
import sqlite3
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .config import SCHEMA_VER, SYNC_TABLES, TABLE_PK


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def compute_hash(tables: dict, tombstones: list) -> str:
    """Deterministic content hash. Rows are pre-sorted in export, so equal data
    on two machines yields the same hash (used to skip redundant pushes)."""
    blob = json.dumps({"t": tables, "d": tombstones}, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def export_snapshot(conn: sqlite3.Connection, device: str) -> dict:
    """Dump all sync tables + tombstones into a snapshot dict."""
    tables: dict[str, list[dict]] = {}
    for table, pk in SYNC_TABLES:
        try:
            rows = [dict(r) for r in conn.execute(f"SELECT * FROM {table}").fetchall()]
        except sqlite3.OperationalError:
            rows = []  # table not present yet
        # stable order → deterministic hash
        rows.sort(key=lambda r: tuple(str(r.get(c, "")) for c in pk))
        tables[table] = rows

    try:
        tombs = [dict(r) for r in conn.execute(
            "SELECT table_name, row_id, deleted_at FROM sync_tombstones"
        ).fetchall()]
    except sqlite3.OperationalError:
        tombs = []
    tombs.sort(key=lambda t: (t["table_name"], t["row_id"]))

    return {
        "schema_ver":   SCHEMA_VER,
        "device":       device,
        "generated_at": _utcnow(),
        "hash":         compute_hash(tables, tombs),
        "tables":       tables,
        "tombstones":   tombs,
    }


def write_json(path: Path, data: dict) -> None:
    """Atomic write: temp file in same dir + os.replace, so a half-synced Drive
    file is never observed by the other machine."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, default=str)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def read_snapshot(path: Path) -> dict | None:
    """Load + validate a snapshot file. Returns None on any corruption / partial
    write / hash mismatch / schema mismatch (file is skipped, never crashes pull)."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    if data.get("schema_ver") != SCHEMA_VER:
        return None
    tables = data.get("tables")
    tombs = data.get("tombstones", [])
    if not isinstance(tables, dict):
        return None
    if data.get("hash") and data["hash"] != compute_hash(tables, tombs):
        return None  # truncated / mid-sync file
    return data
