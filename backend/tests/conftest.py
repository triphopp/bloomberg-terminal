"""
Shared pytest configuration and fixtures for backend tests.
Run all tests: cd backend && python -m pytest tests/ -v
Run specific:  cd backend && python -m pytest tests/test_greeks.py -v
"""
import sys
import os

# Ensure backend/ is on path for all tests
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# No test may reach the real cloud folder. SYNC_AUTODETECT finds the machine's
# Google Drive, and the sync worker a TestClient starts outlives its test: it
# kept pulling the real cloud into whichever temp DB was current and pushing
# the result as this machine's device — two test trades reached the Mac on
# 2026-09-27. Set before config is imported (load_dotenv never overrides);
# sync tests opt back in with their own temp SYNC_DIR via monkeypatch.
os.environ["SYNC_ENABLED"] = "false"
os.environ["SYNC_AUTODETECT"] = "false"
os.environ["SYNC_DIR"] = ""  # empty, not unset: backend/.env sets it and would fill a gap
# Op-log mode turns the snapshot sync off (sync.config.enabled), so a machine
# whose backend/.env sets OPLOG_ENABLED=true failed every sync test with
# status "disabled". Tests that want op-log mode set it themselves.
os.environ["OPLOG_ENABLED"] = "false"


import pytest


@pytest.fixture(autouse=True)
def _no_v7_quote_network(monkeypatch):
    """The batched v7 quote runs ahead of every fast_info load. Tests that stub
    `get_ticker` must not have it answered by real Yahoo first, so it answers
    nothing (→ the per-symbol path) unless a test stubs `_v7_fetch` itself."""
    import market_snapshots
    monkeypatch.setattr(market_snapshots, "_v7_fetch", lambda chunk: [])
    market_snapshots._v7_cache.clear()
    market_snapshots._v7_inflight.clear()
    yield
    market_snapshots._v7_cache.clear()
    market_snapshots._v7_inflight.clear()
