"""Read-only accounting snapshots and verified SQLite backups, including WAL."""
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
import sqlite3


@contextmanager
def read_book(path):
    conn = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    conn.execute("BEGIN")  # all checks see a consistent book
    try:
        yield conn
    finally:
        conn.rollback()
        conn.close()


def backup_book(path, label="accounting") -> Path:
    source = Path(path).resolve()
    folder = source.parent / "backups"
    folder.mkdir(exist_ok=True)
    target = folder / f"{source.stem}-{datetime.now():%Y%m%d-%H%M%S-%f}-{label}.db"
    # Reserve a fresh path; never overwrite a prior backup.
    with target.open("xb"):
        pass
    with read_book(source) as src, sqlite3.connect(target) as dst:
        src.backup(dst)
        if dst.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError(f"Backup integrity check failed: {target}")
    return target
