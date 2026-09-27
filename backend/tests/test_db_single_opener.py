"""db.connect() is the only opener of the portfolio database.

Keeping one door is what lets DB_MODE swap the local SQLite file for a
cloud-primary replica later (memory/plans/central-db-cloud-primary.md) without
hunting down callers. A raw sqlite3.connect() elsewhere needs `# db-ok: <reason>`
on the same line — reserved for files that are not the book (a fresh backup
file, a one-off script's explicit --db target).
"""
import re
import sqlite3
from pathlib import Path

import pytest

import db

BACKEND = Path(__file__).resolve().parents[1]
SKIP_DIRS = {"tests", "backups", "__pycache__", "node_modules", "venv", ".venv", "site-packages"}
RAW_CONNECT = re.compile(r"\bsqlite3\.connect\(")
TAG = re.compile(r"#\s*db-ok:\s*\S")


def _sources():
    for p in BACKEND.rglob("*.py"):
        rel = p.relative_to(BACKEND)
        if any(part in SKIP_DIRS or part.startswith(".pytest-temp") for part in rel.parts[:-1]):
            continue
        if rel == Path("db.py"):
            continue
        yield rel, p


def test_no_raw_connect_outside_db_py():
    offenders = []
    for rel, path in _sources():
        for n, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            if RAW_CONNECT.search(line) and not TAG.search(line):
                offenders.append(f"{rel}:{n}: {line.strip()}")
    assert not offenders, (
        "open the portfolio DB with db.connect() (or tag a non-book file `# db-ok: <reason>`):\n"
        + "\n".join(offenders)
    )


def test_connect_defaults_to_db_path_with_row_factory(tmp_path, monkeypatch):
    target = tmp_path / "book.db"
    monkeypatch.setattr(db, "DB_PATH", target)
    conn = db.connect()
    try:
        conn.execute("CREATE TABLE t (a INTEGER)")
        conn.execute("INSERT INTO t VALUES (7)")
        conn.commit()
        row = conn.execute("SELECT a FROM t").fetchone()
        assert isinstance(row, sqlite3.Row) and row["a"] == 7
    finally:
        conn.close()
    assert target.exists()


def test_readonly_connection_refuses_writes(tmp_path):
    target = tmp_path / "book.db"
    rw = db.connect(target)
    rw.execute("CREATE TABLE t (a INTEGER)")
    rw.commit()
    rw.close()

    ro = db.connect(target, readonly=True)
    try:
        with pytest.raises(sqlite3.OperationalError):
            ro.execute("INSERT INTO t VALUES (1)")
    finally:
        ro.close()


def test_unknown_mode_refuses_instead_of_opening_the_local_file(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_MODE", "replica")
    with pytest.raises(RuntimeError, match="central-db-cloud-primary"):
        db.connect(tmp_path / "book.db")
    assert not (tmp_path / "book.db").exists()
