"""
Unit tests for backend/alerts/notify.py — the server-side `notify` channel
(memory/plans/alert-rule-engine.md §3, §11.8).

Network is never touched: `requests.post` is monkeypatched throughout, which
is also the point of several tests — the contract is that a webhook can fail
in any way at all without costing the scan or the event row.

Run: cd backend && python -m pytest tests/test_alerts_notify.py -v
"""
import sqlite3

import pytest
import requests

from alerts import notify
from alerts.engine import AlertRule, Event
from alerts.schema import create_alert_tables


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    create_alert_tables(c)
    yield c
    c.close()


def make_event(rule_id="r1", symbol="NVDA", bar="2026-07-30") -> Event:
    return Event(
        rule_id=rule_id,
        symbol=symbol,
        fired_at="2026-07-30T10:00:00",
        bar_time=bar,
        snapshot={"ind:rsi:period=14:rsi:0": 28.4321, "const:30.0": 30.0},
    )


def make_rule(rule_id="r1", *, notify_channels=("webhook",), url="https://example.test/hook"):
    return AlertRule(
        id=rule_id,
        name="Oversold Bounce",
        enabled=True,
        scope={"type": "symbols", "symbols": ["NVDA"]},
        timeframe="1d",
        expr=None,
        notify=tuple(notify_channels),
        webhook_url=url,
    )


def seed_event(conn, event: Event) -> None:
    conn.execute(
        "INSERT INTO alert_events (rule_id, symbol, fired_at, bar_time, snapshot_json) "
        "VALUES (?, ?, ?, ?, '{}')",
        (event.rule_id, event.symbol, event.fired_at, event.bar_time),
    )


class FakeResponse:
    def __init__(self, status_code=204, text=""):
        self.status_code = status_code
        self.text = text


# ── Message shaping ──────────────────────────────────────────────────────────


def test_humanize_operand_key_renders_indicator_params():
    assert notify.humanize_operand_key("ind:rsi:period=14:rsi:0") == "RSI(14)"


def test_humanize_operand_key_keeps_output_when_it_differs_from_the_indicator():
    assert notify.humanize_operand_key("ind:macd:fast=12,slow=26:hist:0") == "MACD(12,26).hist"


def test_humanize_operand_key_passes_through_price_and_const():
    assert notify.humanize_operand_key("price:close:0") == "close"
    assert notify.humanize_operand_key("const:30.0") == "30.0"


def test_format_snapshot_drops_constants():
    # Thresholds are already implied by the rule name — repeating them makes
    # the one number that matters harder to find.
    out = notify.format_snapshot({"ind:rsi:period=14:rsi:0": 28.4321, "const:30.0": 30.0})
    assert out == "RSI(14)=28.43"


def test_format_snapshot_handles_missing_values():
    assert "n/a" in notify.format_snapshot({"ind:rsi:period=14:rsi:0": None})


def test_build_message_leads_with_symbol_and_rule_name():
    title, body = notify.build_message(make_event(), make_rule())
    assert title == "NVDA · Oversold Bounce"
    assert "2026-07-30" in body
    assert "RSI(14)=28.43" in body


# ── Flavor detection ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://discord.com/api/webhooks/1/abc", "discord"),
        ("https://discordapp.com/api/webhooks/1/abc", "discord"),
        ("https://ntfy.sh/my-alerts", "ntfy"),
        ("https://my.ntfy.sh/topic", "ntfy"),
        ("https://example.com/hook", "generic"),
        ("not a url", "generic"),
    ],
)
def test_webhook_flavor(url, expected):
    assert notify.webhook_flavor(url) == expected


def test_discord_payload_uses_content_field(monkeypatch):
    captured = {}

    def fake_post(url, **kw):
        captured.update(kw)
        return FakeResponse()

    monkeypatch.setattr(requests, "post", fake_post)
    notify.deliver_webhook("https://discord.com/api/webhooks/1/x", make_event(), make_rule())
    assert "content" in captured["json"]
    assert "Oversold Bounce" in captured["json"]["content"]


def test_ntfy_payload_uses_body_and_title_header(monkeypatch):
    captured = {}

    def fake_post(url, **kw):
        captured.update(kw)
        return FakeResponse()

    monkeypatch.setattr(requests, "post", fake_post)
    notify.deliver_webhook("https://ntfy.sh/alerts", make_event(), make_rule())
    assert captured["headers"]["Title"] == "NVDA · Oversold Bounce"
    assert b"RSI(14)" in captured["data"]


def test_generic_payload_carries_the_full_event(monkeypatch):
    captured = {}

    def fake_post(url, **kw):
        captured.update(kw)
        return FakeResponse()

    monkeypatch.setattr(requests, "post", fake_post)
    notify.deliver_webhook("https://example.com/hook", make_event(), make_rule())
    payload = captured["json"]
    assert payload["symbol"] == "NVDA"
    assert payload["barTime"] == "2026-07-30"
    assert payload["snapshot"]["ind:rsi:period=14:rsi:0"] == pytest.approx(28.4321)


# ── Failure isolation ────────────────────────────────────────────────────────


def test_deliver_webhook_reports_http_errors_without_raising(monkeypatch):
    monkeypatch.setattr(requests, "post", lambda url, **kw: FakeResponse(500, "boom"))
    ok, error = notify.deliver_webhook("https://example.com/hook", make_event(), make_rule())
    assert ok is False
    assert "500" in error


def test_deliver_webhook_swallows_transport_exceptions(monkeypatch):
    def explode(url, **kw):
        raise requests.ConnectionError("no route to host")

    monkeypatch.setattr(requests, "post", explode)
    ok, error = notify.deliver_webhook("https://example.com/hook", make_event(), make_rule())
    assert ok is False
    assert "ConnectionError" in error


def test_dispatch_survives_a_failing_webhook_and_records_the_error(conn, monkeypatch):
    event = make_event()
    seed_event(conn, event)
    monkeypatch.setattr(requests, "post", lambda url, **kw: FakeResponse(503, "down"))

    counts = notify.dispatch(conn, [event], {"r1": make_rule()}, "2026-07-30T10:00:01")

    assert counts == {"sent": 0, "failed": 1, "skipped": 0}
    row = conn.execute("SELECT notified_at, notify_error FROM alert_events").fetchone()
    assert row["notified_at"] is None
    assert "503" in row["notify_error"]


def test_dispatch_marks_delivery_on_success(conn, monkeypatch):
    event = make_event()
    seed_event(conn, event)
    monkeypatch.setattr(requests, "post", lambda url, **kw: FakeResponse())

    counts = notify.dispatch(conn, [event], {"r1": make_rule()}, "2026-07-30T10:00:01")

    assert counts == {"sent": 1, "failed": 0, "skipped": 0}
    row = conn.execute("SELECT notified_at, notify_error FROM alert_events").fetchone()
    assert row["notified_at"] == "2026-07-30T10:00:01"
    assert row["notify_error"] is None


# ── Channel routing ──────────────────────────────────────────────────────────


def test_client_side_channels_send_nothing(conn, monkeypatch):
    """ticker/toast/sound are rendered by the browser off the events feed —
    dispatch must not invent a second delivery path for them."""
    def explode(url, **kw):
        raise AssertionError("no outbound request should happen")

    monkeypatch.setattr(requests, "post", explode)
    event = make_event()
    seed_event(conn, event)
    rule = make_rule(notify_channels=("ticker", "toast", "sound"))

    counts = notify.dispatch(conn, [event], {"r1": rule}, "now")
    assert counts["skipped"] == 1


def test_webhook_channel_without_a_url_is_skipped(conn, monkeypatch):
    def explode(url, **kw):
        raise AssertionError("no outbound request should happen")

    monkeypatch.setattr(requests, "post", explode)
    event = make_event()
    seed_event(conn, event)

    counts = notify.dispatch(conn, [event], {"r1": make_rule(url=None)}, "now")
    assert counts["skipped"] == 1


def test_dispatch_ignores_events_whose_rule_vanished(conn, monkeypatch):
    """A rule deleted mid-scan leaves the event behind (no FK, by design) —
    that must not raise."""
    monkeypatch.setattr(requests, "post", lambda url, **kw: FakeResponse())
    event = make_event(rule_id="gone")
    seed_event(conn, event)

    counts = notify.dispatch(conn, [event], {}, "now")
    assert counts == {"sent": 0, "failed": 0, "skipped": 1}


def test_dispatch_only_marks_the_matching_event_row(conn, monkeypatch):
    monkeypatch.setattr(requests, "post", lambda url, **kw: FakeResponse())
    first, second = make_event(bar="2026-07-29"), make_event(bar="2026-07-30")
    seed_event(conn, first)
    seed_event(conn, second)

    notify.dispatch(conn, [second], {"r1": make_rule()}, "stamped")

    rows = dict(conn.execute("SELECT bar_time, notified_at FROM alert_events").fetchall())
    assert rows["2026-07-29"] is None
    assert rows["2026-07-30"] == "stamped"


def test_test_webhook_reaches_the_endpoint(monkeypatch):
    captured = {}
    monkeypatch.setattr(
        requests, "post", lambda url, **kw: captured.update(url=url, **kw) or FakeResponse()
    )
    ok, error = notify.test_webhook("https://example.com/hook")
    assert ok is True and error is None
    assert captured["url"] == "https://example.com/hook"


# ── Schema migration ─────────────────────────────────────────────────────────


def test_create_alert_tables_adds_notify_columns_to_an_existing_table():
    """The columns shipped after alert_events did, so CREATE TABLE IF NOT
    EXISTS can't deliver them — the ALTER path has to run on old databases."""
    c = sqlite3.connect(":memory:")
    c.execute("""
        CREATE TABLE alert_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, rule_id TEXT NOT NULL,
            symbol TEXT NOT NULL, fired_at TEXT NOT NULL, bar_time TEXT NOT NULL,
            snapshot_json TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0,
            UNIQUE (rule_id, symbol, bar_time)
        )
    """)
    create_alert_tables(c)
    cols = {r[1] for r in c.execute("PRAGMA table_info(alert_events)")}
    assert {"notified_at", "notify_error"} <= cols
    create_alert_tables(c)  # idempotent — a second boot must not fail
    c.close()
