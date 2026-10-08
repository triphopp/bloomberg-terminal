"""WEBULL notices in the alert feed (webull_scheduler.py).

Held here: the rows that should stand follow from the token record, the
entitlement date and the clock alone; a scan never writes a row twice; a notice
that was heeded clears itself; a restart does not sweep one away; and nothing
is written — and Webull is not called — while the keys are not set.
"""
import importlib
import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

NOW = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)
MS = lambda dt: int(dt.timestamp() * 1000)      # noqa: E731


@pytest.fixture()
def ws(monkeypatch):
    monkeypatch.setenv("WEBULL_APP_KEY", "k" * 32)
    monkeypatch.setenv("WEBULL_APP_SECRET", "s" * 32)
    import config
    importlib.reload(config)
    import webull_client
    importlib.reload(webull_client)
    import webull_scheduler as mod
    importlib.reload(mod)
    yield mod
    monkeypatch.undo()
    importlib.reload(config)


@pytest.fixture()
def conn():
    from alerts.schema import create_alert_tables
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    create_alert_tables(c)
    yield c
    c.close()


def _token(status="NORMAL", ends=NOW + timedelta(days=10)):
    return {"token": "t" * 32, "status": status, "expires_at": MS(ends), "checked_at": 0}


def _ids(rows):
    return [r["rule_id"] for r in rows]


# ── what should stand ────────────────────────────────────────────────────────

def test_nothing_while_the_token_has_days_and_the_date_is_far(ws):
    assert ws.wanted(_token(), {"ends": "2027-10-08", "days_left": 353}, NOW) == []
    assert ws.wanted(None, None, NOW) == []                       # never set up: nothing to say
    assert ws.wanted(_token("PENDING"), None, NOW) == []          # being confirmed right now


def test_token_is_mentioned_three_days_out_once_a_day(ws):
    assert ws.wanted(_token(ends=NOW + timedelta(days=3, hours=1)), None, NOW) == []
    soon = ws.wanted(_token(ends=NOW + timedelta(days=2, hours=4)), None, NOW)
    assert _ids(soon) == ["webull:TOKEN_SOON"]
    assert soon[0]["snapshot"]["ends_at"] == "2026-10-22T16:00:00+00:00"
    tomorrow = ws.wanted(_token(ends=NOW + timedelta(days=2, hours=4)), None, NOW + timedelta(days=1))
    assert tomorrow[0]["bar_time"] != soon[0]["bar_time"]         # a new line the next day


@pytest.mark.parametrize("token", [
    {"status": "NORMAL", "ends": NOW - timedelta(minutes=1)},     # past its date
    {"status": "EXPIRED", "ends": NOW - timedelta(days=1)},
    {"status": "INVALID", "ends": NOW + timedelta(days=9)},       # ended on Webull's side
])
def test_an_ended_token_is_one_row_however_it_ended(ws, token):
    rows = ws.wanted(_token(token["status"], token["ends"]), None, NOW)
    assert _ids(rows) == ["webull:TOKEN_ENDED"]
    again = ws.wanted(_token(token["status"], token["ends"]), None, NOW + timedelta(days=3))
    assert again[0]["bar_time"] == rows[0]["bar_time"]            # not repeated daily
    assert "t" * 32 not in json.dumps(rows)                       # the token itself is never written


def test_entitlement_is_mentioned_in_steps_then_as_ended(ws):
    sub = lambda days: {"ends": "2027-10-08", "days_left": days}  # noqa: E731
    assert ws.wanted(_token(), sub(15), NOW) == []
    steps = {days: ws.wanted(_token(), sub(days), NOW)[0]["bar_time"] for days in (14, 10, 8, 7, 3, 2, 1)}
    assert steps[14] == steps[10] == steps[8]                     # one line from 14 down to 8
    assert len({steps[14], steps[7], steps[3], steps[2], steps[1]}) == 5
    assert _ids(ws.wanted(_token(), sub(0), NOW)) == ["webull:FEED_ENDED"]
    assert _ids(ws.wanted(_token(), sub(-40), NOW)) == ["webull:FEED_ENDED"]


def test_both_can_stand_at_once(ws):
    rows = ws.wanted(_token(ends=NOW + timedelta(hours=5)), {"ends": "2026-10-23", "days_left": 3}, NOW)
    assert _ids(rows) == ["webull:TOKEN_SOON", "webull:FEED_SOON"]


# ── writing them ─────────────────────────────────────────────────────────────

def _standing(conn):
    return [(r["rule_id"], r["symbol"]) for r in conn.execute(
        "SELECT rule_id, symbol FROM alert_events WHERE acked = 0 ORDER BY id")]


def test_a_scan_writes_a_row_once(ws, conn):
    rows = ws.wanted(_token(ends=NOW + timedelta(days=1)), None, NOW)
    assert _ids(ws.apply(conn, rows, NOW)) == ["webull:TOKEN_SOON"]
    assert ws.apply(conn, rows, NOW) == []
    assert _standing(conn) == [("webull:TOKEN_SOON", "WEBULL")]


def test_a_notice_that_was_heeded_clears_itself(ws, conn):
    ws.apply(conn, ws.wanted(_token(ends=NOW + timedelta(days=1)), None, NOW), NOW)
    ws.apply(conn, ws.wanted(_token(ends=NOW - timedelta(hours=1)), None, NOW), NOW)
    assert _standing(conn) == [("webull:TOKEN_ENDED", "WEBULL")]  # "ends" gave way to "ended"
    ws.apply(conn, ws.wanted(_token(ends=NOW + timedelta(days=15)), None, NOW), NOW)   # a new token
    assert _standing(conn) == []


def test_other_alerts_are_left_alone(ws, conn):
    conn.execute("INSERT INTO alert_events (rule_id, symbol, fired_at, bar_time, snapshot_json) "
                 "VALUES ('cal:EARNINGS', 'MU', '2026-10-20', '2026-10-21#x', '{}')")
    ws.apply(conn, [], NOW)
    assert _standing(conn) == [("cal:EARNINGS", "MU")]


def test_a_restart_does_not_sweep_a_standing_notice(ws, conn):
    from alerts.schema import create_alert_tables
    ws.apply(conn, ws.wanted(_token(ends=NOW + timedelta(days=1)), None, NOW), NOW)
    create_alert_tables(conn)                 # what every start-up runs: acks rows with no rule
    assert _standing(conn) == [("webull:TOKEN_SOON", "WEBULL")]


def test_the_feed_names_it_and_only_an_ending_asks_for_a_toast(ws):
    import routers.alert_rules as ar
    assert ar._guard_name("webull:TOKEN_SOON") == "WEBULL · TOKEN SOON"
    assert ar._ruleless_notify("webull:TOKEN_SOON", {}) == ["ticker"]
    assert ar._ruleless_notify("webull:TOKEN_ENDED", {}) == ["ticker", "toast"]
    assert ar._ruleless_notify("webull:FEED_ENDED", {}) == ["ticker", "toast"]


def test_without_keys_nothing_is_asked_and_old_notices_clear(ws, conn, monkeypatch):
    ws.apply(conn, ws.wanted(_token(ends=NOW + timedelta(days=1)), None, NOW), NOW)
    monkeypatch.setattr(ws.wb.config, "WEBULL_APP_SECRET", "")
    monkeypatch.setattr(ws.wb, "refresh_token_status",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("called Webull")))

    class _Db:
        def __enter__(self):
            return conn

        def __exit__(self, *a):
            return False

    import db
    monkeypatch.setattr(db, "get_db", lambda: _Db())
    assert ws.run_once() == {"standing": [], "new": []}
    assert _standing(conn) == []
