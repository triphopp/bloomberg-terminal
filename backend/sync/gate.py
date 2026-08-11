"""
Which request paths must wait for the startup cloud pull.

Kept out of main.py so it can be tested without importing the app (importing
main runs the whole startup: DB init, model calibration, scheduler threads).
"""
from .manager import startup_done

# Endpoints whose tables are listed in config.py:SYNC_TABLES. Serving these
# mid-pull hands a second device its pre-merge rows, and anything the user edits
# in that window collides with the merge landing moments later. Everything else
# (quotes, macro, news — none of it device-shared) stays available immediately.
SYNC_GATED_PREFIXES: tuple[str, ...] = (
    "/api/portfolio",
    "/api/v2/portfolio",
    "/api/paper",
    "/api/pins",
    "/api/options/positions",
    "/api/options/greeks/portfolio",
)


# Paths whose writes land in a synced table and should therefore trigger a
# debounced push. Superset of the gated list: alert_rules is synced but reads
# fine pre-merge, so it is push-worthy without being gate-worthy.
#
# /api/sync/* is excluded on purpose — POST /api/sync/pull writing a snapshot
# that schedules another push is a loop with no exit.
SYNCED_WRITE_PREFIXES: tuple[str, ...] = SYNC_GATED_PREFIXES + (
    "/api/alerts/rules",
)


def should_gate(path: str, done: bool | None = None) -> bool:
    """True when `path` needs synced data that has not been merged in yet."""
    if done is None:
        done = startup_done.is_set()
    return not done and path.startswith(SYNC_GATED_PREFIXES)


def is_synced_write(path: str) -> bool:
    """True when a write to `path` changes data that belongs in a snapshot."""
    return path.startswith(SYNCED_WRITE_PREFIXES)
