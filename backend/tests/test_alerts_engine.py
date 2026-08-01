"""
Unit tests for backend/alerts/engine.py — trigger/cooldown/tri-state state
machine (memory/plans/alert-rule-engine.md §3, §11).

Uses an isolated in-memory SQLite connection (never touches portfolio.db).
Run: cd backend && python -m pytest tests/test_alerts_engine.py -v
"""
import sqlite3

import numpy as np
import pytest

from alerts.ast import ConstOperand, IndicatorOperand, Predicate, PriceOperand
from alerts.engine import AlertRule, collect_snapshot, decide_and_record, resolve_scope_symbols, scan
from alerts.eval import Bars
from alerts.schema import create_alert_tables


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    create_alert_tables(c)
    yield c
    c.close()


def make_bars(close) -> Bars:
    close = np.asarray(close, dtype=float)
    n = len(close)
    ones = np.ones(n)
    return Bars(open=close, high=close, low=close, close=close, volume=ones)


def no_indicator(_id, _params, _output):
    raise AssertionError("this rule doesn't use an indicator operand")


def seed_rule(conn, rule: AlertRule) -> None:
    """alert_rule_state.rule_id has a real FK into alert_rules — in production
    the CRUD router always creates that row first. Tests exercise engine.py in
    isolation, so stub the minimal parent row ourselves."""
    conn.execute(
        "INSERT OR IGNORE INTO alert_rules "
        "(id, name, enabled, scope_json, timeframe, expr_json, trigger, cooldown_bars, "
        " max_fires_per_day, notify_json, created_at, updated_at) "
        "VALUES (?, ?, ?, '{}', ?, '{}', ?, ?, ?, '[]', 'now', 'now')",
        (
            rule.id, rule.name, int(rule.enabled), rule.timeframe,
            rule.trigger, rule.cooldown_bars, rule.max_fires_per_day,
        ),
    )


def gt_one_rule(**overrides) -> AlertRule:
    expr = Predicate(left=PriceOperand(field_="close"), cmp="gt", right=ConstOperand(1))
    defaults = dict(
        id="r1", name="close>1", enabled=True, scope={"type": "watchlist"},
        timeframe="1d", expr=expr, trigger="edge", cooldown_bars=1, max_fires_per_day=None,
    )
    defaults.update(overrides)
    return AlertRule(**defaults)


DAYS = [f"2026-01-{d:02d}" for d in range(1, 10)]
CLOSE = [1, 1, 1, 2, 2, 1, 2, 2, 2]  # gt(1) -> F F F T T F T T T


def run_progressive(conn, rule, close=CLOSE, days=DAYS):
    """Simulate a scan running once per new bar, as it would in production."""
    from alerts.eval import evaluate

    seed_rule(conn, rule)
    events = []
    for t in range(1, len(close) + 1):
        bars = make_bars(close[:t])
        bar_times = days[:t]
        result = evaluate(rule.expr, bars, no_indicator)
        ev = decide_and_record(conn, rule, "TEST", result, bar_times, bars, no_indicator, f"fired-at-{t}")
        events.append(ev)
    return events


# ── edge trigger + §11 unknown->true must not fire ──────────────────────────


def test_edge_fires_only_on_false_to_true_transition(conn):
    rule = gt_one_rule(cooldown_bars=1)
    events = run_progressive(conn, rule)
    fired_days = [e.bar_time for e in events if e is not None]
    # value sequence F F F T T F T T T; the first T (day4) is unknown->true (day1 leaves
    # state at 'false' since value is False, not unknown) — wait day1 IS the first bar,
    # so prior state before day1 is genuinely 'unknown'. day1's value is False, so no fire
    # attempt anyway. The first *true* value is day4, and by then prior state is 'false'
    # (set by days 1-3), so it fires. day7 is the next false->true transition and fires too.
    assert fired_days == ["2026-01-04", "2026-01-07"]


def test_first_bar_true_from_unknown_does_not_fire(conn):
    """If the very first scan of a symbol already reads True, that's an
    unknown->true transition and must NOT fire (§11) — only a later false->true
    edge should."""
    rule = gt_one_rule()
    close = [2, 2, 1, 2]  # T (unknown->true, no fire), T (true->true, no fire), F, T (fires)
    events = run_progressive(conn, rule, close=close, days=DAYS[: len(close)])
    fired = [e.bar_time for e in events if e is not None]
    assert fired == ["2026-01-04"]


# ── cooldown ─────────────────────────────────────────────────────────────────


def test_cooldown_suppresses_a_too_close_second_edge(conn):
    rule = gt_one_rule(cooldown_bars=5)
    events = run_progressive(conn, rule)
    fired = [e.bar_time for e in events if e is not None]
    # day7's edge (3 bars after day4's fire) is inside the 5-bar cooldown -> suppressed
    assert fired == ["2026-01-04"]


def test_db_unique_constraint_backstops_a_duplicate_fire_even_if_state_is_stale(conn):
    """If alert_rule_state and alert_events ever disagree — e.g. a previous
    scan wrote the event but crashed before updating state, or two scan
    processes raced — app-level cooldown logic can't see the prior fire.
    UNIQUE(rule_id, symbol, bar_time) on alert_events must still stop the
    duplicate insert (plan §3: 'bar-time dedup')."""
    rule = gt_one_rule(trigger="level", cooldown_bars=0)
    from alerts.eval import evaluate

    seed_rule(conn, rule)
    conn.execute(
        "INSERT INTO alert_events (rule_id, symbol, fired_at, bar_time, snapshot_json) "
        "VALUES (?, ?, 'earlier-run', '2026-01-01', '{}')",
        (rule.id, "TEST"),
    )
    # state was never updated to reflect that fire — looks like a fresh symbol
    bars = make_bars([2])
    bar_times = ["2026-01-01"]
    result = evaluate(rule.expr, bars, no_indicator)
    event = decide_and_record(conn, rule, "TEST", result, bar_times, bars, no_indicator, "t2")
    assert event is None  # app logic thought this was a legitimate new fire; DB said no
    count = conn.execute("SELECT COUNT(*) AS c FROM alert_events").fetchone()["c"]
    assert count == 1


# ── level trigger ────────────────────────────────────────────────────────────


def test_level_trigger_fires_every_valid_true_bar_subject_to_cooldown(conn):
    rule = gt_one_rule(trigger="level", cooldown_bars=1)
    events = run_progressive(conn, rule)
    fired = [e.bar_time for e in events if e is not None]
    # day4 fires. day5 is only 1 bar later -> still inside cooldown_bars=1,
    # suppressed. day6 is False. day7 fires (3 bars after day4). day8 is 1
    # bar after day7 -> suppressed. day9 is 2 bars after day7 -> allowed.
    assert fired == ["2026-01-04", "2026-01-07", "2026-01-09"]


# ── max_fires_per_day ────────────────────────────────────────────────────────


def test_max_fires_per_day_caps_level_trigger_within_the_same_calendar_day(conn):
    rule = gt_one_rule(trigger="level", cooldown_bars=0, max_fires_per_day=1)
    from alerts.eval import evaluate

    seed_rule(conn, rule)
    # two bars on the SAME calendar day (e.g. an intraday timeframe)
    close = [2, 2]
    days = ["2026-01-01T09:30", "2026-01-01T10:00"]
    events = []
    for t in range(1, 3):
        bars = make_bars(close[:t])
        bar_times = days[:t]
        result = evaluate(rule.expr, bars, no_indicator)
        events.append(decide_and_record(conn, rule, "TEST", result, bar_times, bars, no_indicator, f"t{t}"))
    assert events[0] is not None
    assert events[1] is None  # quota of 1/day already used


# ── snapshot ─────────────────────────────────────────────────────────────────


def test_collect_snapshot_captures_every_distinct_operand_once():
    expr = Predicate(
        left=IndicatorOperand(id="rsi", output="rsi", params={"period": 14}),
        cmp="between",
        right=ConstOperand(20.0),
        right2=ConstOperand(80.0),
    )
    bars = make_bars([1, 2, 3])
    raw = np.array([np.nan, 55.0, 60.0])

    def resolve(_id, _params, _output):
        return raw

    snap = collect_snapshot(expr, bars, resolve, idx=2)
    keys = list(snap.keys())
    assert len(keys) == 3  # left (indicator), right (const), right2 (const)
    assert snap["const:20.0"] == 20.0
    assert snap["const:80.0"] == 80.0

    snap_invalid = collect_snapshot(expr, bars, resolve, idx=0)
    ind_key = [k for k in snap_invalid if k.startswith("ind:")][0]
    assert snap_invalid[ind_key] is None  # NaN at bar 0 -> reported as None, not 0 or NaN


def test_collect_snapshot_dedups_repeated_operand_references():
    close_op = PriceOperand(field_="close")
    expr = Predicate(left=close_op, cmp="crossesAbove", right=PriceOperand(field_="close", offset=1))
    bars = make_bars([1, 2, 3])
    snap = collect_snapshot(expr, bars, no_indicator, idx=2)
    # left is close@0, right is close@1 -- two DIFFERENT operand keys, not a dup
    assert len(snap) == 2


# ── scope resolution ─────────────────────────────────────────────────────────


def test_resolve_scope_symbols_watchlist_uses_the_live_list():
    rule = gt_one_rule(scope={"type": "watchlist"})
    assert resolve_scope_symbols(rule, ["AAPL", "MSFT"]) == ["AAPL", "MSFT"]


def test_resolve_scope_symbols_fixed_list_ignores_the_watchlist():
    rule = gt_one_rule(scope={"type": "symbols", "symbols": ["NVDA"]})
    assert resolve_scope_symbols(rule, ["AAPL", "MSFT"]) == ["NVDA"]


# ── scan() orchestrator ──────────────────────────────────────────────────────


def test_scan_skips_disabled_rules_and_symbols_with_no_bars(conn):
    enabled = gt_one_rule(id="r-on", enabled=True)
    disabled = gt_one_rule(id="r-off", enabled=False)
    seed_rule(conn, enabled)
    seed_rule(conn, disabled)
    bars = {"AAPL": make_bars([2, 2])}  # unknown->true on first scan, no fire yet
    bar_times = {"AAPL": ["2026-01-01", "2026-01-02"]}
    events = scan(conn, [enabled, disabled], bars, bar_times, lambda _s: no_indicator, ["AAPL", "MSFT"], "t1")
    assert events == []  # AAPL: true the whole time (unknown->true then true->true, no edge)
    # MSFT has no bars in the dict -> must be skipped, not crash
    state_rows = conn.execute("SELECT rule_id, symbol FROM alert_rule_state").fetchall()
    assert ("r-on", "MSFT") not in [(r["rule_id"], r["symbol"]) for r in state_rows]
    assert ("r-on", "AAPL") in [(r["rule_id"], r["symbol"]) for r in state_rows]
    assert "r-off" not in [r["rule_id"] for r in state_rows]


def test_scan_gives_each_symbol_its_own_resolver(conn):
    """A rule using an IndicatorOperand must see EACH symbol's own indicator
    series, not one shared resolver's output reused across symbols."""
    expr = Predicate(
        left=IndicatorOperand(id="x", output="x", params={}), cmp="gt", right=ConstOperand(0)
    )
    rule = gt_one_rule(id="r1", expr=expr, trigger="level", scope={"type": "symbols", "symbols": ["UP", "DOWN"]})
    seed_rule(conn, rule)

    bars = {"UP": make_bars([1, 1]), "DOWN": make_bars([1, 1])}
    bar_times = {"UP": ["2026-01-01", "2026-01-02"], "DOWN": ["2026-01-01", "2026-01-02"]}

    per_symbol_raw = {"UP": np.array([5.0, 5.0]), "DOWN": np.array([-5.0, -5.0])}

    def resolver_for_symbol(symbol):
        return lambda _id, _params, _output: per_symbol_raw[symbol]

    events = scan(conn, [rule], bars, bar_times, resolver_for_symbol, [], "t1")
    fired_symbols = {e.symbol for e in events}
    assert fired_symbols == {"UP"}  # only UP's indicator is positive
