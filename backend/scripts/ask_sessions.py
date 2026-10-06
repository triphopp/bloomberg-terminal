"""Where this machine keeps ASK conversations — show it, or set it.

    python scripts/ask_sessions.py                  # what is in effect, and why
    python scripts/ask_sessions.py drive            # the Google Drive folder the portfolio syncs through
    python scripts/ask_sessions.py local            # this machine only (app-data folder)
    python scripts/ask_sessions.py off              # keep nothing
    python scripts/ask_sessions.py auto             # drive when this machine has it, else local
    python scripts/ask_sessions.py --dir "D:\some\folder"   # an explicit folder (not inside the repo)

Writes ASK_SESSIONS_STORE / ASK_SESSIONS_DIR to backend/.env — the same thing
ASK → HISTORY → STORAGE does. A running backend picks the change up on the next
request. Run from the backend folder.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(HERE / ".env")      # SYNC_DIR and friends, as the backend sees them

import ask_sessions  # noqa: E402


def show(cfg: dict) -> None:
    where = {"drive": "Google Drive (shared with the other machine)", "local": "this machine only",
             "custom": "a folder you chose", "off": "nowhere — history is off"}[cfg["store"]]
    print(f"store      : {cfg['store']}  — {where}   (setting: {cfg['choice']})")
    print(f"folder     : {cfg['dir'] or '—'}")
    if cfg["reason"]:
        print(f"note       : {cfg['reason']}")
    print(f"drive      : {cfg['drive_dir'] or 'no Google Drive folder found on this machine'}")
    print(f"this machine: {cfg['local_dir']}")
    print(f"device     : {cfg['device']}")
    if cfg["dir"]:
        try:
            print(f"saved      : {len(ask_sessions.list_sessions(limit=10_000))} conversation(s)")
        except Exception as exc:  # noqa: BLE001 — a status line, not a failure
            print(f"saved      : cannot read the folder ({exc})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("store", nargs="?", choices=ask_sessions.STORES)
    parser.add_argument("--dir", help="an explicit folder, outside the repository")
    args = parser.parse_args()
    if args.store or args.dir:
        try:
            show(ask_sessions.configure(args.store, args.dir))
        except Exception as exc:  # noqa: BLE001 — HTTPException carries the reason
            sys.exit(f"not changed: {getattr(exc, 'detail', exc)}")
    else:
        show(ask_sessions.resolve())


if __name__ == "__main__":
    main()