"""
Alert Rule Engine — CRUD + preview + scan + events.

GET    /api/alerts/rules            list
POST   /api/alerts/rules            create (validate + normalize before save)
PATCH  /api/alerts/rules/{id}       update
DELETE /api/alerts/rules/{id}       delete (cascades alert_rule_state; events kept for
                                    audit but acked, so they stop alerting)
POST   /api/alerts/rules/preview    dry-run against real history — doesn't save anything
POST   /api/alerts/scan             evaluate enabled rules now, persist events
GET    /api/alerts/events           feed for alert-ticker.tsx
POST   /api/alerts/events/ack       mark events read

See memory/plans/alert-rule-engine.md for the design. Phase 3 (operands.py's
full indicator registry) isn't built yet — scan/preview currently support the
`rsi`/`ema`/`macd`/`rvol` subset in alerts/operands.py.
"""
from __future__ import annotations

import datetime
import json
import uuid
from typing import Any

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from cache import TTLCache
from db import get_db

from alerts import engine, notify, operands
from alerts.ast import AstValidationError, normalize_node, to_dict, validate
from alerts.eval import Bars, evaluate, fires
from routers.watchlist_signals import _download

router = APIRouter(prefix="/api/alerts", tags=["Alert Rules"])

_TRIGGERS = {"edge", "level"}
_NOTIFY_CHANNELS = {"ticker", "toast", "sound", "webhook"}
# v1 is daily-only — the scanner below (and watchlist_signals._download) only
# ever fetches "1d" bars (plan §7).
_SUPPORTED_TIMEFRAMES = {"1d"}

# Bars cache, separate from watchlist_signals' own — same TTL, same reasoning
# (daily signals only shift once per session), kept independent so a bug in
# one endpoint's cache invalidation can't affect the other.
_bars_cache = TTLCache(ttl=900, maxsize=200)


# ── Pydantic models ──────────────────────────────────────────────────────────


class AlertRuleIn(BaseModel):
    name: str
    enabled: bool = True
    scope: dict[str, Any]
    timeframe: str = "1d"
    expr: dict[str, Any]
    trigger: str = "edge"
    cooldown_bars: int = 1
    max_fires_per_day: int | None = None
    expires_at: str | None = None
    notify: list[str] = ["ticker"]
    webhook_url: str | None = None


class AlertRulePatch(BaseModel):
    name: str | None = None
    enabled: bool | None = None
    scope: dict[str, Any] | None = None
    timeframe: str | None = None
    expr: dict[str, Any] | None = None
    trigger: str | None = None
    cooldown_bars: int | None = None
    max_fires_per_day: int | None = None
    expires_at: str | None = None
    notify: list[str] | None = None
    webhook_url: str | None = None


class PreviewRequest(BaseModel):
    expr: dict[str, Any]
    scope: dict[str, Any]
    timeframe: str = "1d"
    # Mirrors what scan will actually do (plan §7.2) so a preview can't show
    # "currently true" off today's half-formed bar while the real scan stays
    # silent on the same rule. Exposed (not hardcoded) so a user debugging an
    # RVOL rule mid-session can deliberately peek at the live bar.
    evaluate_on_closed_bars_only: bool = True


class ScanRequest(BaseModel):
    rule_ids: list[str] | None = None  # None = every enabled rule
    evaluate_on_closed_bars_only: bool = True


class AckRequest(BaseModel):
    ids: list[int]


# ── Validation helpers ───────────────────────────────────────────────────────


def _validate_scope(scope: dict[str, Any]) -> None:
    t = scope.get("type")
    if t == "watchlist":
        return
    if t == "symbols":
        syms = scope.get("symbols")
        if not isinstance(syms, list) or not syms or not all(isinstance(s, str) for s in syms):
            raise HTTPException(422, "scope.symbols must be a non-empty list of strings")
        return
    raise HTTPException(422, f'scope.type must be "watchlist" or "symbols", got {t!r}')


def _validate_and_normalize_expr(expr: dict[str, Any]) -> tuple[dict[str, Any], list[dict]]:
    try:
        node = validate(expr)
    except AstValidationError as e:
        raise HTTPException(422, f"invalid rule expression: {e}")
    normalized, warnings = normalize_node(node)
    if any(w["kind"] == "contradiction" for w in warnings):
        raise HTTPException(422, {"error": "rule can never fire", "warnings": warnings})
    return to_dict(normalized), warnings


def _validate_trigger(trigger: str) -> None:
    if trigger not in _TRIGGERS:
        raise HTTPException(422, f"trigger must be one of {sorted(_TRIGGERS)}")


def _validate_timeframe(timeframe: str) -> None:
    if timeframe not in _SUPPORTED_TIMEFRAMES:
        raise HTTPException(
            422,
            f"timeframe {timeframe!r} isn't supported yet — v1 is daily-only (plan §7), "
            f"use one of {sorted(_SUPPORTED_TIMEFRAMES)}",
        )


def _validate_notify(notify: list[str]) -> None:
    unknown = set(notify) - _NOTIFY_CHANNELS
    if unknown:
        raise HTTPException(422, f"unknown notify channel(s): {sorted(unknown)}")


# ── Row <-> dict ─────────────────────────────────────────────────────────────


def _row_to_dict(row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "enabled": bool(row["enabled"]),
        "scope": json.loads(row["scope_json"]),
        "timeframe": row["timeframe"],
        "expr": json.loads(row["expr_json"]),
        "trigger": row["trigger"],
        "cooldownBars": row["cooldown_bars"],
        "maxFiresPerDay": row["max_fires_per_day"],
        "notify": json.loads(row["notify_json"]),
        "webhookUrl": row["webhook_url"],
        "expiresAt": row["expires_at"],
        "schemaVersion": row["schema_version"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _row_to_engine_rule(row) -> engine.AlertRule:
    return engine.AlertRule(
        id=row["id"],
        name=row["name"],
        enabled=bool(row["enabled"]),
        scope=json.loads(row["scope_json"]),
        timeframe=row["timeframe"],
        expr=validate(json.loads(row["expr_json"])),
        trigger=row["trigger"],
        cooldown_bars=row["cooldown_bars"],
        max_fires_per_day=row["max_fires_per_day"],
        notify=tuple(json.loads(row["notify_json"])),
        webhook_url=row["webhook_url"],
    )


# ── Market data ──────────────────────────────────────────────────────────────


def _bars_from_df(df: pd.DataFrame) -> tuple[Bars, list[str]]:
    if isinstance(df.columns, pd.MultiIndex):
        # A single-symbol yfinance frame can still carry a (symbol, field)
        # MultiIndex depending on the installed yfinance version, even though
        # _download()'s docstring assumes it's always flat for one symbol —
        # flatten defensively instead of relying on that assumption.
        df = df.copy()
        df.columns = df.columns.get_level_values(-1)
    df = df.dropna(subset=["Close"])
    bars = Bars(
        open=df["Open"].astype(float).to_numpy(),
        high=df["High"].astype(float).to_numpy(),
        low=df["Low"].astype(float).to_numpy(),
        close=df["Close"].astype(float).to_numpy(),
        volume=(df["Volume"].astype(float).to_numpy() if "Volume" in df else np.zeros(len(df))),
    )
    bar_times = [str(idx.date()) if hasattr(idx, "date") else str(idx) for idx in df.index]
    return bars, bar_times


def _drop_unclosed_last_bar(bars: Bars, bar_times: list[str]) -> tuple[Bars, list[str]]:
    """plan §7.2: yfinance's daily interval keeps updating today's row while
    the session is open, same behavior watchlist_signals.py already works
    around for `rvol` (its "session is still open" comment, line ~250). A
    rule using RVOL/Volume evaluated against that live-updating row reads a
    partial session as the full day and fires spuriously every morning — the
    plan's own words are "rule volume จะยิงมั่วทุกเช้า" if this isn't handled.

    Only the *last* row can be unclosed — every earlier row is a completed
    session by construction — so this only ever drops at most one bar."""
    if not bar_times:
        return bars, bar_times
    if bar_times[-1] != str(datetime.date.today()):
        return bars, bar_times
    if len(bar_times) == 1:
        # Nothing to evaluate against without fabricating history — the
        # caller's existing "bars is None/empty -> skip symbol" path handles
        # an empty Bars the same way it handles a missing one.
        empty = np.array([], dtype=float)
        return Bars(open=empty, high=empty, low=empty, close=empty, volume=empty), []
    trimmed = Bars(
        open=bars.open[:-1], high=bars.high[:-1], low=bars.low[:-1],
        close=bars.close[:-1], volume=bars.volume[:-1],
    )
    return trimmed, bar_times[:-1]


def _fetch_bars(
    symbols: list[str], *, evaluate_on_closed_bars_only: bool = True
) -> dict[str, tuple[Bars, list[str]]]:
    """One yfinance batch call for symbols not already cached — mirrors
    watchlist_signals._download's batching so a scan of the whole watchlist
    costs one request, not N (plan §6).

    `evaluate_on_closed_bars_only` trims today's still-forming bar before
    it ever reaches the evaluator (plan §7.2) — default on, since an
    unguarded scan is the wrong default for something a scheduler runs
    unattended every 15 minutes. Applied after the cache lookup/store so a
    cache hit can't accidentally skip the trim, and cached before trimming
    so preview (which wants the same fetch) isn't forced into the same
    choice as scan."""
    if not symbols:
        return {}
    key = ",".join(sorted(symbols))
    cached = _bars_cache.get(key)
    if cached is None:
        frames = _download(symbols)
        result: dict[str, tuple[Bars, list[str]]] = {}
        for sym in symbols:
            df = frames.get(sym)
            if df is None or df.empty:
                continue
            result[sym] = _bars_from_df(df)
        _bars_cache.set(key, result)
        cached = result

    if not evaluate_on_closed_bars_only:
        return cached
    return {sym: _drop_unclosed_last_bar(bars, times) for sym, (bars, times) in cached.items()}


def _live_watchlist_symbols(conn) -> list[str]:
    rows = conn.execute("SELECT DISTINCT symbol FROM pinned_assets").fetchall()
    return [r["symbol"] for r in rows]


# ── CRUD ─────────────────────────────────────────────────────────────────────


@router.get("/rules")
def list_rules():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM alert_rules ORDER BY created_at DESC").fetchall()
        return [_row_to_dict(r) for r in rows]


@router.post("/rules", status_code=201)
def create_rule(body: AlertRuleIn):
    _validate_scope(body.scope)
    _validate_trigger(body.trigger)
    _validate_timeframe(body.timeframe)
    _validate_notify(body.notify)
    expr_dict, warnings = _validate_and_normalize_expr(body.expr)

    now = datetime.datetime.utcnow().isoformat()
    rule_id = str(uuid.uuid4())
    with get_db() as conn:
        conn.execute(
            """INSERT INTO alert_rules
               (id, name, enabled, scope_json, timeframe, expr_json, trigger,
                cooldown_bars, max_fires_per_day, notify_json, webhook_url,
                expires_at, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                rule_id, body.name, int(body.enabled), json.dumps(body.scope),
                body.timeframe, json.dumps(expr_dict), body.trigger, body.cooldown_bars,
                body.max_fires_per_day, json.dumps(body.notify), body.webhook_url,
                body.expires_at, now, now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM alert_rules WHERE id = ?", (rule_id,)).fetchone()

    result = _row_to_dict(row)
    result["warnings"] = warnings
    return result


@router.patch("/rules/{rule_id}")
def patch_rule(rule_id: str, body: AlertRulePatch):
    with get_db() as conn:
        existing = conn.execute("SELECT * FROM alert_rules WHERE id = ?", (rule_id,)).fetchone()
        if not existing:
            raise HTTPException(404, "Rule not found")

        updates = body.model_dump(exclude_none=True)
        warnings: list[dict] = []

        if "scope" in updates:
            _validate_scope(updates["scope"])
            updates["scope_json"] = json.dumps(updates.pop("scope"))
        if "expr" in updates:
            expr_dict, warnings = _validate_and_normalize_expr(updates.pop("expr"))
            updates["expr_json"] = json.dumps(expr_dict)
        if "trigger" in updates:
            _validate_trigger(updates["trigger"])
        if "timeframe" in updates:
            _validate_timeframe(updates["timeframe"])
        if "notify" in updates:
            _validate_notify(updates["notify"])
            updates["notify_json"] = json.dumps(updates.pop("notify"))
        if "cooldownBars" in updates:  # not a real field name, guard against accidental camelCase body
            raise HTTPException(422, "use cooldown_bars, not cooldownBars")
        if "enabled" in updates:
            updates["enabled"] = int(updates["enabled"])

        if not updates:
            result = _row_to_dict(existing)
            result["warnings"] = []
            return result

        updates["updated_at"] = datetime.datetime.utcnow().isoformat()
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        conn.execute(f"UPDATE alert_rules SET {set_clause} WHERE id = ?", [*updates.values(), rule_id])
        conn.commit()
        row = conn.execute("SELECT * FROM alert_rules WHERE id = ?", (rule_id,)).fetchone()

    result = _row_to_dict(row)
    result["warnings"] = warnings
    return result


@router.delete("/rules/{rule_id}")
def delete_rule(rule_id: str):
    with get_db() as conn:
        existing = conn.execute("SELECT id FROM alert_rules WHERE id = ?", (rule_id,)).fetchone()
        if not existing:
            raise HTTPException(404, "Rule not found")
        # alert_rule_state cascades via FK. alert_events has no FK on purpose
        # — fired history survives rule deletion as an audit trail (plan §5).
        #
        # Surviving is not the same as still shouting: an unacked orphan keeps
        # its row in the ticker and in the watchlist badge forever, because the
        # events endpoint falls back to notify=["ticker"] for a row whose rule
        # is gone. Deleting the rule is the user saying they are done with it,
        # so ack what it fired. The rows stay, the warnings stop.
        conn.execute(
            "UPDATE alert_events SET acked = 1 WHERE rule_id = ? AND acked = 0",
            (rule_id,),
        )
        conn.execute("DELETE FROM alert_rules WHERE id = ?", (rule_id,))
        conn.commit()
    return {"ok": True}


# ── Preview (dry-run) ────────────────────────────────────────────────────────


@router.post("/rules/preview")
def preview_rule(body: PreviewRequest):
    _validate_scope(body.scope)
    _validate_timeframe(body.timeframe)
    expr_dict, warnings = _validate_and_normalize_expr(body.expr)
    node = validate(expr_dict)

    with get_db() as conn:
        watchlist_symbols = _live_watchlist_symbols(conn)
    symbols = (
        body.scope.get("symbols", [])
        if body.scope.get("type") == "symbols"
        else watchlist_symbols
    )

    bars_map = _fetch_bars(
        symbols, evaluate_on_closed_bars_only=body.evaluate_on_closed_bars_only
    )
    matching_now: list[str] = []
    per_symbol: dict[str, dict[str, Any]] = {}
    total_fires = 0

    for symbol, (bars, bar_times) in bars_map.items():
        resolve_indicator = operands.make_resolver(bars)
        try:
            result = evaluate(node, bars, resolve_indicator)
        except Exception as exc:  # unsupported indicator, malformed params, etc.
            per_symbol[symbol] = {"error": str(exc)}
            continue
        fire_mask = fires(result)
        fire_count = int(fire_mask.sum())
        total_fires += fire_count
        currently_true = bool(fire_mask[-1])
        if currently_true:
            matching_now.append(symbol)
        last_idx = np.nonzero(fire_mask)[0]
        per_symbol[symbol] = {
            "firesInWindow": fire_count,
            "lastFiredBar": bar_times[int(last_idx[-1])] if len(last_idx) else None,
            "currentlyTrue": currently_true,
        }

    n_symbols = len(bars_map) or 1
    result_warnings = list(warnings)
    avg = total_fires / n_symbols
    if avg > 15:  # rough guard, mirrors the "base rate too loose" instinct from §8.5.6
        result_warnings.append(
            {"kind": "loose", "detail": f"fires {avg:.1f} times/symbol in the fetched window — likely too loose"}
        )

    return {
        "matchingNow": matching_now,
        "perSymbol": per_symbol,
        "totalFires": total_fires,
        "warnings": result_warnings,
        "compiled": to_dict(node),
    }


# ── Scan ─────────────────────────────────────────────────────────────────────


@router.post("/scan")
def run_scan(body: ScanRequest = ScanRequest()):
    now = datetime.datetime.utcnow().isoformat()
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM alert_rules WHERE enabled = 1").fetchall()
        if body.rule_ids is not None:
            wanted = set(body.rule_ids)
            rows = [r for r in rows if r["id"] in wanted]
        if not rows:
            return {"events": [], "count": 0}

        rules = [_row_to_engine_rule(r) for r in rows]
        watchlist_symbols = _live_watchlist_symbols(conn)

        needed: set[str] = set()
        for rule in rules:
            needed.update(engine.resolve_scope_symbols(rule, watchlist_symbols))

        bars_map = _fetch_bars(
            sorted(needed), evaluate_on_closed_bars_only=body.evaluate_on_closed_bars_only
        )
        bars_by_symbol = {s: b for s, (b, _) in bars_map.items()}
        times_by_symbol = {s: t for s, (b, t) in bars_map.items()}
        resolvers: dict[str, Any] = {}

        def resolver_for_symbol(symbol: str):
            if symbol not in resolvers:
                resolvers[symbol] = operands.make_resolver(bars_by_symbol[symbol])
            return resolvers[symbol]

        events = engine.scan(
            conn, rules, bars_by_symbol, times_by_symbol,
            resolver_for_symbol, watchlist_symbols, now,
        )
        # Deliver *after* the rows exist: a webhook that hangs or 500s must
        # cost us the ping, never the event (alerts/notify.py).
        delivery = notify.dispatch(conn, events, {r.id: r for r in rules}, now)
        conn.commit()

    return {
        "events": [
            {"ruleId": e.rule_id, "symbol": e.symbol, "firedAt": e.fired_at, "barTime": e.bar_time, "snapshot": e.snapshot}
            for e in events
        ],
        "count": len(events),
        "delivery": delivery,
    }


# ── Events ───────────────────────────────────────────────────────────────────


@router.get("/events")
def list_events(limit: int = 100, acked: bool | None = None, rule_id: str | None = None):
    # LEFT JOIN, not INNER: alert_events deliberately has no FK to alert_rules
    # (deleting a rule shouldn't erase the record that it fired). Orphans must
    # still appear in the feed — with ruleName null rather than vanishing.
    #
    # The join is also what makes the client-side notify channels work at all:
    # ticker/toast/sound are render hints that live on the *rule*, and this is
    # the only payload the browser sees (alerts/notify.py module docstring).
    query = """
        SELECT e.*, r.name AS rule_name, r.notify_json AS rule_notify
        FROM alert_events e
        LEFT JOIN alert_rules r ON r.id = e.rule_id
    """
    clauses = []
    params: list[Any] = []
    if acked is not None:
        clauses.append("e.acked = ?")
        params.append(int(acked))
    if rule_id is not None:
        clauses.append("e.rule_id = ?")
        params.append(rule_id)
    if clauses:
        query += " WHERE " + " AND ".join(clauses)
    query += " ORDER BY e.fired_at DESC LIMIT ?"
    params.append(min(limit, 500))

    with get_db() as conn:
        rows = conn.execute(query, params).fetchall()
    return [
        {
            "id": r["id"], "ruleId": r["rule_id"], "symbol": r["symbol"],
            "firedAt": r["fired_at"], "barTime": r["bar_time"],
            "snapshot": json.loads(r["snapshot_json"]), "acked": bool(r["acked"]),
            "ruleName": r["rule_name"],
            # An orphaned event has no rule to ask, so fall back to the ticker
            # (the passive channel) rather than silently dropping it or
            # re-toasting history.
            "notify": json.loads(r["rule_notify"]) if r["rule_notify"] else ["ticker"],
            "notifiedAt": r["notified_at"],
            "notifyError": r["notify_error"],
        }
        for r in rows
    ]


class WebhookTestRequest(BaseModel):
    url: str


@router.post("/notify/test")
def notify_test(body: WebhookTestRequest):
    """Verify a webhook URL now, rather than the next time a rule happens to
    fire and nothing arrives."""
    ok, error = notify.test_webhook(body.url)
    return {"ok": ok, "error": error, "flavor": notify.webhook_flavor(body.url)}


@router.post("/events/ack")
def ack_events(body: AckRequest):
    if not body.ids:
        return {"ok": True, "updated": 0}
    with get_db() as conn:
        placeholders = ",".join("?" for _ in body.ids)
        cur = conn.execute(
            f"UPDATE alert_events SET acked = 1 WHERE id IN ({placeholders})", body.ids
        )
        conn.commit()
    return {"ok": True, "updated": cur.rowcount}
