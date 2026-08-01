"""
Unit tests for backend/alerts/scheduler.py (plan §6 "Scheduler").

The scheduler is what turns stored rules into fired alerts — before it,
POST /api/alerts/scan had no caller anywhere in the codebase and rules were
inert. These tests cover the two behaviours that matter operationally:
configuration, and the self-gate that keeps an unused feature off the network.

Run: cd backend && python -m pytest tests/test_alerts_scheduler.py -v
"""
import pytest

from alerts import scheduler


# ── Interval configuration ───────────────────────────────────────────────────


def test_default_interval_matches_the_bars_cache_ttl(monkeypatch):
    """15 minutes on purpose: it lines up with watchlist_signals' TTLCache so
    a scan reuses bars instead of doubling yfinance traffic (plan §6)."""
    monkeypatch.delenv("ALERT_SCAN_INTERVAL", raising=False)
    assert scheduler.interval_seconds() == 15 * 60


def test_interval_can_be_overridden(monkeypatch):
    monkeypatch.setenv("ALERT_SCAN_INTERVAL", "300")
    assert scheduler.interval_seconds() == 300


def test_zero_interval_means_disabled(monkeypatch):
    monkeypatch.setenv("ALERT_SCAN_INTERVAL", "0")
    assert scheduler.interval_seconds() == 0


def test_garbage_interval_falls_back_to_the_default(monkeypatch):
    monkeypatch.setenv("ALERT_SCAN_INTERVAL", "every 5 minutes")
    assert scheduler.interval_seconds() == 15 * 60


def test_start_is_a_no_op_when_disabled(monkeypatch):
    monkeypatch.setenv("ALERT_SCAN_INTERVAL", "0")
    monkeypatch.setattr(scheduler, "_started", False)
    started = []
    monkeypatch.setattr(
        scheduler.threading, "Thread", lambda **kw: started.append(kw) or pytest.fail("spawned")
    )
    scheduler.start_background_scan()
    assert started == []


def test_start_is_idempotent(monkeypatch):
    """main.py runs at import time; a double import must not give us two
    scanners racing on the same rules."""
    monkeypatch.delenv("ALERT_SCAN_INTERVAL", raising=False)
    monkeypatch.setattr(scheduler, "_started", False)
    spawned = []

    class FakeThread:
        def __init__(self, **kw):
            spawned.append(kw)

        def start(self):
            pass

    monkeypatch.setattr(scheduler.threading, "Thread", FakeThread)
    scheduler.start_background_scan()
    scheduler.start_background_scan()
    assert len(spawned) == 1
    assert spawned[0]["daemon"] is True


# ── Self-gating ──────────────────────────────────────────────────────────────


def test_run_once_skips_entirely_when_no_rule_is_enabled(monkeypatch):
    """A user who never creates a rule should pay nothing for the scanner
    existing — no yfinance call, no router import."""
    monkeypatch.setattr(scheduler, "_has_enabled_rules", lambda: False)

    from routers import alert_rules

    monkeypatch.setattr(
        alert_rules, "run_scan", lambda *a, **k: pytest.fail("should not have scanned")
    )
    assert scheduler.run_once() == {"skipped": "no enabled rules"}


def test_run_once_delegates_to_the_router_when_rules_exist(monkeypatch):
    """Reuses the endpoint's own code path rather than a parallel one, so a
    scheduled scan and a manual scan can't drift apart (notify dispatch
    included)."""
    monkeypatch.setattr(scheduler, "_has_enabled_rules", lambda: True)
    calls = []

    from routers import alert_rules

    monkeypatch.setattr(
        alert_rules, "run_scan", lambda *a, **k: calls.append(1) or {"count": 0, "events": []}
    )
    result = scheduler.run_once()
    assert calls == [1]
    assert result["count"] == 0
