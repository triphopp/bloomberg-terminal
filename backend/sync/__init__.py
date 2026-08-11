"""
Portfolio cloud-sync package.

Local SQLite stays the working copy. JSON snapshots are exchanged through a
shared cloud folder (Google Drive) so PC and MacOS converge on the same data.

The `.db` file itself is NEVER placed on the cloud drive — Google Drive syncs raw
bytes + WAL sidecars, which corrupts SQLite. Only validated JSON snapshots cross
the cloud boundary.
"""
from .manager import (
    pull,
    push,
    request_push,
    sync_startup,
    start_startup_async,
    startup_done,
    get_status,
    start_background_push,
)

__all__ = [
    "pull",
    "push",
    "request_push",
    "sync_startup",
    "start_startup_async",
    "startup_done",
    "get_status",
    "start_background_push",
]
