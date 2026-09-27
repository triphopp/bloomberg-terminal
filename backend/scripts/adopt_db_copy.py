"""Make one machine's portfolio DB an exact copy of another's (central-db plan, Step 0).

Two machines that both write and merge through Google Drive can drift apart
for good (2026-09-27: 23 trades differed, Mac cash ≈ −฿629K). Until the cloud
primary lands, one machine is the source of truth and the others adopt its
file whole — no merge.

    # on the source machine (Windows) — backend may keep running
    cd backend && python scripts/adopt_db_copy.py export --out <file.db>

    # on the machine to fix (Mac) — stop the backend first
    cd backend && python scripts/adopt_db_copy.py adopt <file.db>          # dry run
    cd backend && python scripts/adopt_db_copy.py adopt <file.db> --yes    # do it

    # either machine: compare the money tables
    cd backend && python scripts/adopt_db_copy.py fingerprint [<file.db>]

`adopt` backs up the current DB first, copies with SQLite's backup API, checks
integrity, proves the result matches the source fingerprint, sets aside the
Drive-sync ancestor files and writes SYNC_ENABLED=false to backend/.env (key
name only is printed). Nothing is deleted.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from config import DB_PATH  # noqa: E402
from db import connect  # noqa: E402

MONEY_TABLES = (
    "portfolio_accounts", "trades", "cash_ledger", "cash_adjustments", "dividends",
    "option_contracts", "option_trades", "trade_fee_items", "broker_executions",
)
BACKEND_PORT = int(os.getenv("BACKEND_PORT", "9317"))


def fingerprint(path: Path) -> dict[str, dict]:
    """Row count + content hash per money table; equal hashes = identical rows."""
    out: dict[str, dict] = {}
    conn = connect(path, readonly=True)
    try:
        for table in MONEY_TABLES:
            try:
                cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]
            except sqlite3.DatabaseError:
                cols = []
            if not cols:
                out[table] = {"rows": None, "sha256": None}
                continue
            order = ", ".join(f'"{c}"' for c in sorted(cols))
            rows = conn.execute(f"SELECT {order} FROM {table} ORDER BY {order}").fetchall()
            blob = json.dumps([list(r) for r in rows], default=str, ensure_ascii=False)
            out[table] = {"rows": len(rows), "sha256": hashlib.sha256(blob.encode()).hexdigest()}
    finally:
        conn.close()
    return out


def integrity(path: Path) -> str:
    conn = connect(path, readonly=True)
    try:
        return conn.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        conn.close()


def copy_into(src: Path, dst: Path) -> None:
    """SQLite online backup: consistent even while src is being written."""
    s = connect(src, readonly=True)
    d = sqlite3.connect(str(dst))  # db-ok: backup destination, filled from src
    try:
        s.backup(d)
        # a WAL-mode destination holds the copy in its -wal until checkpointed;
        # fold it into the main file so the result is one self-contained file
        d.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        d.close()
        s.close()


def backend_running() -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{BACKEND_PORT}/api/dev/status", timeout=2):
            return True
    except Exception:
        return False


def set_env_key(env: Path, key: str, value: str) -> str:
    text = env.read_text(encoding="utf-8") if env.exists() else ""
    line = f"{key}={value}"
    pat = re.compile(rf"^{re.escape(key)}=.*$", re.M)
    if pat.search(text):
        new, verb = pat.sub(line, text, count=1), "updated"
    else:
        new, verb = (text if text.endswith("\n") or not text else text + "\n") + line + "\n", "added"
    env.write_text(new, encoding="utf-8")
    return verb


def print_fp(label: str, fp: dict) -> None:
    print(f"\n{label}")
    for t, v in fp.items():
        print(f"  {t:20} rows={v['rows']!s:>6}  {str(v['sha256'])[:16]}")


def cmd_export(a) -> int:
    out = Path(a.out).resolve()
    if out.exists():
        print(f"refusing to overwrite {out}")
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)
    src = Path(DB_PATH).resolve()
    copy_into(src, out)
    ok = integrity(out)
    print(f"exported {src} -> {out}  integrity={ok}")
    print_fp("fingerprint (compare after adopt):", fingerprint(out))
    return 0 if ok == "ok" else 1


def cmd_fingerprint(a) -> int:
    path = Path(a.path).resolve() if a.path else Path(DB_PATH).resolve()
    print_fp(str(path), fingerprint(path))
    return 0


def cmd_adopt(a) -> int:
    src = Path(a.source).resolve()
    dst = Path(DB_PATH).resolve()
    from sync.config import device_id  # noqa: E402

    print(f"source      : {src}")
    print(f"this DB     : {dst}")
    print(f"sync device : {device_id()}")
    if not src.exists():
        print("source file not found")
        return 1
    if src == dst:
        print("source and target are the same file")
        return 1
    if backend_running():
        print(f"backend is running on :{BACKEND_PORT} — stop it first (it holds the DB and would push to Drive)")
        return 1
    ok = integrity(src)
    if ok != "ok":
        print(f"source integrity_check failed: {ok}")
        return 1
    src_fp = fingerprint(src)
    print_fp("source fingerprint:", src_fp)
    if dst.exists():
        print_fp("current fingerprint (will be replaced):", fingerprint(dst))

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backups = dst.parent / "backups"
    sidecars = sorted(dst.parent.glob(f".sync_*_{dst.stem}.json"))
    env = Path(a.env).resolve() if a.env else BACKEND / ".env"
    print("\nplan:")
    if dst.exists():
        print(f"  1. back up current DB -> {backups / f'{dst.stem}-pre-adopt-{stamp}.db'}")
    print(f"  2. copy source into {dst} (SQLite backup API) + integrity + fingerprint match")
    print(f"  3. set aside {len(sidecars)} sync ancestor file(s) -> {backups / f'sync-sidecars-pre-adopt-{stamp}'}")
    print(f"  4. SYNC_ENABLED=false in {env}")
    if not a.yes:
        print("\ndry run — re-run with --yes to apply")
        return 0

    backups.mkdir(exist_ok=True)
    if dst.exists():
        saved = backups / f"{dst.stem}-pre-adopt-{stamp}.db"
        copy_into(dst, saved)
        if integrity(saved) != "ok":
            print(f"backup failed integrity_check: {saved} — nothing changed")
            return 1
        print(f"backed up -> {saved}")

    copy_into(src, dst)
    if integrity(dst) != "ok":
        print("adopted DB failed integrity_check — restore the backup above")
        return 1
    got = fingerprint(dst)
    if got != src_fp:
        print_fp("MISMATCH after copy:", got)
        return 1
    print("copied, integrity ok, fingerprint matches source")

    if sidecars:
        aside = backups / f"sync-sidecars-pre-adopt-{stamp}"
        aside.mkdir()
        for f in sidecars:
            shutil.move(str(f), aside / f.name)
        print(f"set aside {len(sidecars)} sync ancestor file(s) -> {aside}")
    print(f"SYNC_ENABLED {set_env_key(env, 'SYNC_ENABLED', 'false')} in {env}")
    print("\ndone — start the backend and compare /api/v2/portfolio/summary with the source machine")
    return 0


def main() -> int:
    if hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export", help="copy this machine's DB to a file")
    e.add_argument("--out", required=True)
    e.set_defaults(fn=cmd_export)
    ad = sub.add_parser("adopt", help="replace this machine's DB with a copy (dry run without --yes)")
    ad.add_argument("source")
    ad.add_argument("--yes", action="store_true")
    ad.add_argument("--env", help="dotenv file to write SYNC_ENABLED into (default backend/.env)")
    ad.set_defaults(fn=cmd_adopt)
    f = sub.add_parser("fingerprint", help="row counts + content hashes of the money tables")
    f.add_argument("path", nargs="?")
    f.set_defaults(fn=cmd_fingerprint)
    a = ap.parse_args()
    return a.fn(a)


if __name__ == "__main__":
    raise SystemExit(main())
