"""Capture today's NAV snapshot headlessly (no frontend, no running server).

Same logic the ANALYTICS tab triggers on view — `_maybe_capture_nav()` is a
no-op if today's row already exists, so running it repeatedly is safe.

Run from backend/:  python -m scripts.capture_nav
Or from anywhere:   python D:\\Agents\\Claude\\bloomberg-terminal-main\\backend\\scripts\\capture_nav.py
"""
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db import get_db
from routers.portfolio_v2 import _maybe_capture_nav


def main() -> None:
    today = datetime.now().strftime("%Y-%m-%d")
    _maybe_capture_nav()
    with get_db() as conn:
        n = conn.execute(
            "SELECT COUNT(*) FROM portfolio_nav_snapshots WHERE snapshot_date = ?",
            (today,),
        ).fetchone()[0]
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] nav rows for {today}: {n}")
    if n == 0:
        sys.exit(1)  # non-zero so Task Scheduler shows the failure


if __name__ == "__main__":
    main()
