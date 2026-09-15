"""
run_scan must survive a stored rule that cannot be parsed.

Regression cover for the outage in
memory/sessions/reports/alert-scan-dead-since-2026-08-25-risk-report.md: a
leftover test row whose expr_json was `{"kind": "const", "value": 1}` (no "op")
made `_row_to_engine_rule` raise straight out of run_scan, up through the
scheduler's one try/except-per-tick. Every other rule went unevaluated from
2026-08-25 to 2026-09-15 and the only symptom was a repeating WARNING line.

Run: cd backend && python -m pytest tests/test_alerts_scan_isolation.py -v
"""
import contextlib
import json
import sqlite3
import sys

import numpy as np
import pytest

sys.path.insert(0, ".")

from alerts.eval import Bars  # noqa: E402
from alerts.schema import create_alert_tables  # noqa: E402
from routers import alert_rules  # noqa: E402

GOOD_EXPR = {
    "op": "cmp",
    "left": {"src": "price", "field": "close"},
    "cmp": "gt",
    "right": {"src": "const", "value": 1},
}
# The exact shape of the row that caused the outage: valid JSON, no "op" key.
BROKEN_EXPR = {"kind": "const", "value": 1}


def _insert_rule(conn, rule_id, expr, name="rule", trigger="level"):
    conn.execute(
        "INSERT INTO alert_rules "
        "(id, name, enabled, scope_json, timeframe, expr_json, trigger, cooldown_bars, "
        " max_fires_per_day, notify_json, created_at, updated_at) "
        "VALUES (?, ?, 1, ?, '1d', ?, ?, 1, NULL, '[\"ticker\"]', 'now', 'now')",
        (
            rule_id, name,
            json.dumps({"type": "symbols", "symbols": ["AAPL"]}),
            json.dumps(expr), trigger,
        ),
    )


@pytest.fixture
def scan_env(monkeypatch):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    create_alert_tables(conn)

    @contextlib.contextmanager
    def fake_get_db():
        yield conn

    close = np.array([2.0, 2.0])
    bars = Bars(open=close, high=close, low=close, close=close, volume=np.ones(2))

    monkeypatch.setattr(alert_rules, "get_db", fake_get_db)
    monkeypatch.setattr(alert_rules, "_live_watchlist_symbols", lambda _c: [])
    monkeypatch.setattr(
        alert_rules, "_fetch_bars",
        lambda symbols, **kw: {s: (bars, ["2026-01-01", "2026-01-02"]) for s in symbols},
    )
    monkeypatch.setattr(alert_rules.notify, "dispatch", lambda *a, **kw: {})

    yield conn
    conn.close()


def test_an_unparseable_rule_does_not_stop_the_scan(scan_env):
    conn = scan_env
    _insert_rule(conn, "r-broken", BROKEN_EXPR, name="TEST rule")
    _insert_rule(conn, "r-good", GOOD_EXPR, name="close>1")

    result = alert_rules.run_scan()

    # The good rule is "level" on close=2 > 1, so it fires — proof the scan
    # got past the broken row instead of dying on it.
    assert [e["ruleId"] for e in result["events"]] == ["r-good"]
    assert [s["ruleId"] for s in result["skipped"]] == ["r-broken"]


def test_an_unparseable_rule_is_disabled_with_its_reason(scan_env):
    conn = scan_env
    _insert_rule(conn, "r-broken", BROKEN_EXPR, name="TEST rule")

    alert_rules.run_scan()

    row = conn.execute("SELECT * FROM alert_rules WHERE id = 'r-broken'").fetchone()
    assert row["enabled"] == 0, "a rule that can never parse must stop being retried"
    assert "unknown node op" in row["last_error"]
    assert row["last_error_at"]


def test_every_rule_broken_still_returns_a_result(scan_env):
    """The all-bad case took a different path out of run_scan than the mixed
    one — it must not fall through to the engine with an empty rule list."""
    conn = scan_env
    _insert_rule(conn, "r-broken", BROKEN_EXPR)

    result = alert_rules.run_scan()

    assert result["count"] == 0
    assert len(result["skipped"]) == 1
    # The disable has to be committed, or the next tick repeats the same work.
    assert conn.execute(
        "SELECT enabled FROM alert_rules WHERE id = 'r-broken'"
    ).fetchone()["enabled"] == 0


def test_a_clean_scan_clears_a_previous_error(scan_env):
    conn = scan_env
    _insert_rule(conn, "r-good", GOOD_EXPR)
    conn.execute(
        "UPDATE alert_rules SET last_error = 'stale', last_error_at = 'then' WHERE id = 'r-good'"
    )

    alert_rules.run_scan()

    row = conn.execute("SELECT * FROM alert_rules WHERE id = 'r-good'").fetchone()
    assert row["last_error"] is None
    assert row["last_error_at"] is None


def test_a_runtime_failure_records_the_error_but_keeps_the_rule_enabled(scan_env, monkeypatch):
    """Unparseable is permanent; blowing up mid-evaluation may not be. A rule
    that fails on bad bars must still be there when the data recovers."""
    conn = scan_env
    _insert_rule(conn, "r-good", GOOD_EXPR)

    def explode(*_a, **_kw):
        raise RuntimeError("indicator exploded")

    monkeypatch.setattr(alert_rules.engine, "evaluate", explode)

    result = alert_rules.run_scan()

    row = conn.execute("SELECT * FROM alert_rules WHERE id = 'r-good'").fetchone()
    assert row["enabled"] == 1
    assert "indicator exploded" in row["last_error"]
    assert [s["ruleId"] for s in result["skipped"]] == ["r-good"]
