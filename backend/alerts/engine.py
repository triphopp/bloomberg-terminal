"""
Alert Rule Engine — scan orchestration: evaluate + trigger + persist events.

Owns the tri-state trigger state machine (plan §3, §11) and the DB writes for
alert_rule_state / alert_events. Doesn't fetch prices or compute indicators
itself — those are injected (`Bars` + `IndicatorResolver`, same contract as
eval.py) so this stays testable with synthetic data. The real yfinance +
indicator-library glue is operands.py (phase 3).

Trigger semantics, restated from the plan:
  - "edge"  fires only on a strict false(valid) -> true(valid) transition.
    unknown -> true does NOT fire (§11) — that's the whole reason last_state
    is three-valued instead of boolean.
  - "level" fires every scan the rule is true & valid, subject to cooldown.
  - cooldown_bars: once fired, stay silent for N more bars for that symbol.
  - bar-time dedup: UNIQUE(rule_id, symbol, bar_time) on alert_events makes a
    duplicate scan of the same bar a no-op at the DB layer, not app logic.
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from typing import Any, Callable

from .ast import AndNode, NotNode, OrNode, Predicate, RuleNode, SustainedNode, WithinNode, operand_key
from .eval import Bars, BoolResult, IndicatorResolver, evaluate, resolve_operand


@dataclass(frozen=True)
class AlertRule:
    id: str
    name: str
    enabled: bool
    scope: dict[str, Any]  # {"type": "watchlist"} | {"type": "symbols", "symbols": [...]}
    timeframe: str
    expr: RuleNode
    trigger: str = "edge"  # "edge" | "level"
    cooldown_bars: int = 1
    max_fires_per_day: int | None = None
    # Delivery, not evaluation — this module never reads them. They ride along
    # so the scan's dispatch step (alerts/notify.py) doesn't have to re-query
    # alert_rules for every event it just produced.
    notify: tuple[str, ...] = ("ticker",)
    webhook_url: str | None = None


@dataclass(frozen=True)
class Event:
    rule_id: str
    symbol: str
    fired_at: str
    bar_time: str
    snapshot: dict[str, float | None]


def resolve_scope_symbols(rule: AlertRule, watchlist_symbols: list[str]) -> list[str]:
    """A rule's scope is either the whole watchlist (resolved by the caller
    from the live pins table, plan §11.5 — not stored per-rule) or a fixed
    symbol list."""
    if rule.scope.get("type") == "symbols":
        return list(rule.scope.get("symbols", []))
    return list(watchlist_symbols)


def collect_snapshot(
    node: RuleNode, bars: Bars, resolve_indicator: IndicatorResolver, idx: int
) -> dict[str, float | None]:
    """Every distinct operand's value at bar `idx`, keyed by its canonical
    key — cheap because it only runs when a rule actually fires (plan §5:
    'ดูค่าที่ทำให้มันยิงได้ทันทีโดยไม่ต้อง reproduce')."""
    snapshot: dict[str, float | None] = {}

    def resolve_and_store(op) -> None:
        key = operand_key(op)
        if key in snapshot:
            return
        r = resolve_operand(op, bars, resolve_indicator)
        snapshot[key] = float(r.values[idx]) if r.valid[idx] else None

    def walk(n: RuleNode) -> None:
        if isinstance(n, Predicate):
            resolve_and_store(n.left)
            resolve_and_store(n.right)
            if n.right2 is not None:
                resolve_and_store(n.right2)
        elif isinstance(n, (AndNode, OrNode)):
            for c in n.children:
                walk(c)
        elif isinstance(n, NotNode):
            walk(n.child)
        elif isinstance(n, (WithinNode, SustainedNode)):
            walk(n.child)

    walk(node)
    return snapshot


@dataclass(frozen=True)
class _PriorState:
    last_state: str  # 'unknown' | 'false' | 'true'
    last_bar: str | None
    last_fired_bar: str | None


def _load_state(conn: sqlite3.Connection, rule_id: str, symbol: str) -> _PriorState:
    row = conn.execute(
        "SELECT last_state, last_bar, last_fired_bar FROM alert_rule_state "
        "WHERE rule_id = ? AND symbol = ?",
        (rule_id, symbol),
    ).fetchone()
    if row is None:
        return _PriorState(last_state="unknown", last_bar=None, last_fired_bar=None)
    return _PriorState(last_state=row["last_state"], last_bar=row["last_bar"], last_fired_bar=row["last_fired_bar"])


def _bars_since(bar_times: list[str], from_bar: str | None, current_idx: int) -> int | None:
    """How many bars ago `from_bar` was, relative to `current_idx`. None if
    `from_bar` isn't in this window (fell out of lookback, or never fired)."""
    if from_bar is None:
        return None
    try:
        idx = bar_times.index(from_bar)
    except ValueError:
        return None
    return current_idx - idx


def _fires_today_count(conn: sqlite3.Connection, rule_id: str, symbol: str, bar_time: str) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM alert_events "
        "WHERE rule_id = ? AND symbol = ? AND date(bar_time) = date(?)",
        (rule_id, symbol, bar_time),
    ).fetchone()
    return int(row["c"])


def decide_and_record(
    conn: sqlite3.Connection,
    rule: AlertRule,
    symbol: str,
    result: BoolResult,
    bar_times: list[str],
    bars: Bars,
    resolve_indicator: IndicatorResolver,
    now_iso: str,
) -> Event | None:
    """Look at only the LAST bar (scan is a real-time tick, not a backfill —
    within/sustained/crossesAbove already saw the full history inside
    `evaluate()`). Updates alert_rule_state unconditionally; inserts into
    alert_events only on a genuine, un-cooled-down, under-quota fire."""
    idx = len(bar_times) - 1
    current_bar = bar_times[idx]
    value = bool(result.value[idx])
    valid = bool(result.valid[idx])

    prior = _load_state(conn, rule.id, symbol)
    new_state = "true" if (valid and value) else ("false" if valid else "unknown")

    should_attempt = False
    if valid:
        if rule.trigger == "level":
            should_attempt = value
        else:  # edge — unknown -> true must NOT fire (§11)
            should_attempt = value and prior.last_state == "false"

    event: Event | None = None
    if should_attempt:
        bars_since_fire = _bars_since(bar_times, prior.last_fired_bar, idx)
        # cooldown_bars=1 means "stay quiet for 1 more bar" — the very next
        # bar (bars_since=1) is still inside the cooldown, so the gap must be
        # STRICTLY greater than cooldown_bars before firing again.
        cooled_down = bars_since_fire is None or bars_since_fire > rule.cooldown_bars
        under_quota = (
            rule.max_fires_per_day is None
            or _fires_today_count(conn, rule.id, symbol, current_bar) < rule.max_fires_per_day
        )
        if cooled_down and under_quota:
            snapshot = collect_snapshot(rule.expr, bars, resolve_indicator, idx)
            cur = conn.execute(
                "INSERT OR IGNORE INTO alert_events "
                "(rule_id, symbol, fired_at, bar_time, snapshot_json) VALUES (?,?,?,?,?)",
                (rule.id, symbol, now_iso, current_bar, json.dumps(snapshot)),
            )
            if cur.rowcount == 1:  # actually inserted — not a duplicate of an already-recorded bar
                event = Event(rule.id, symbol, now_iso, current_bar, snapshot)

    conn.execute(
        """
        INSERT INTO alert_rule_state (rule_id, symbol, last_state, last_bar, last_fired_bar, last_fired_at, fires_today)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(rule_id, symbol) DO UPDATE SET
            last_state     = excluded.last_state,
            last_bar       = excluded.last_bar,
            last_fired_bar = CASE WHEN ? THEN excluded.last_fired_bar ELSE alert_rule_state.last_fired_bar END,
            last_fired_at  = CASE WHEN ? THEN excluded.last_fired_at  ELSE alert_rule_state.last_fired_at  END,
            fires_today    = ?
        """,
        (
            rule.id, symbol, new_state, current_bar,
            current_bar if event else prior.last_fired_bar,
            now_iso if event else None,
            1 if event else 0,
            event is not None, event is not None,
            # re-query rather than increment: the INSERT above (if any) already
            # landed on this connection, so this reflects it exactly once.
            _fires_today_count(conn, rule.id, symbol, current_bar),
        ),
    )
    return event


def scan(
    conn: sqlite3.Connection,
    rules: list[AlertRule],
    bars_by_symbol: dict[str, Bars],
    bar_times_by_symbol: dict[str, list[str]],
    resolver_for_symbol: Callable[[str], IndicatorResolver],
    watchlist_symbols: list[str],
    now_iso: str,
) -> list[Event]:
    """Evaluate every enabled rule against its scope's symbols.

    `resolver_for_symbol(symbol)` returns an IndicatorResolver bound to that
    symbol's own bars (see alerts/operands.make_resolver) — indicators are
    per-symbol data, so a single shared resolver would be wrong. Cross-rule
    memoization of repeated (indicator, params) computations for the SAME
    symbol is the resolver's own job (plan §6's O(distinct operands ×
    symbols) budget), not this loop's."""
    events: list[Event] = []
    for rule in rules:
        if not rule.enabled:
            continue
        for symbol in resolve_scope_symbols(rule, watchlist_symbols):
            bars = bars_by_symbol.get(symbol)
            bar_times = bar_times_by_symbol.get(symbol)
            if bars is None or not bar_times:
                continue
            resolve_indicator = resolver_for_symbol(symbol)
            result = evaluate(rule.expr, bars, resolve_indicator)
            event = decide_and_record(
                conn, rule, symbol, result, bar_times, bars, resolve_indicator, now_iso
            )
            if event:
                events.append(event)
    return events
