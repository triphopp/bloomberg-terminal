"""
Startup sync gate: which paths wait for the cloud pull, and which never do.

main.py runs sync_startup() on a worker thread so uvicorn binds its port right
away; these assertions are what keeps that safe.
"""
import pytest

from sync.gate import SYNC_GATED_PREFIXES, is_synced_write, should_gate


@pytest.mark.parametrize(
    "path",
    [
        "/api/v2/portfolio/accounts",
        "/api/v2/portfolio/summary?ignored",  # startswith, query never reaches it
        "/api/portfolio/db/holdings",
        "/api/paper/accounts/1/summary",
        "/api/pins/assets",
        "/api/options/positions/list",
        "/api/options/greeks/portfolio",
    ],
)
def test_synced_paths_are_gated_until_pull_finishes(path):
    assert should_gate(path, done=False) is True
    assert should_gate(path, done=True) is False


@pytest.mark.parametrize(
    "path,expected",
    [
        ("/api/v2/portfolio/trades", True),
        ("/api/paper/orders", True),
        ("/api/pins/assets", True),
        ("/api/alerts/rules", True),      # synced table, but reads fine pre-merge
        ("/api/alerts/scan", False),      # writes alert_events — never synced
        ("/api/sync/pull", False),        # a push here would schedule another
        ("/api/market-data", False),
    ],
)
def test_only_synced_writes_schedule_a_push(path, expected):
    assert is_synced_write(path) is expected


@pytest.mark.parametrize(
    "path",
    [
        "/api/stock",
        "/api/market-data",
        "/api/macro/series",
        "/api/watchlist/signals",
        "/api/sync/status",          # must stay readable *while* syncing
        "/api/options/AAPL",         # chain quotes are not device-shared
        "/api/alerts/events",        # alert_events is excluded from SYNC_TABLES
        "/docs",
    ],
)
def test_unsynced_paths_never_gated(path):
    assert should_gate(path, done=False) is False


def test_every_gated_prefix_is_an_api_path():
    # A bare "/" or "" here would gate the entire app on a cloud round-trip.
    for prefix in SYNC_GATED_PREFIXES:
        assert prefix.startswith("/api/")


def test_gate_falls_back_to_live_event(monkeypatch):
    import sync.gate as gate

    gate.startup_done.clear()
    try:
        assert should_gate("/api/v2/portfolio/accounts") is True
        gate.startup_done.set()
        assert should_gate("/api/v2/portfolio/accounts") is False
    finally:
        gate.startup_done.set()
