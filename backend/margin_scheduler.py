"""
MARGIN notifier — account margin level changes → alert-feed events.

Every interval it evaluates every account with margin enabled
(routers.margin.overview) and compares each level with the last scan
(`margin_state`). A move to a WORSE level writes `alert_events` with
rule_id = "margin:<LEVEL>", so the existing ticker/toast/badge show it with no
new client code (alert_rules.list_events names these rows). An improvement
only updates the state.

Unlike TRADE GUARD, the first run is NOT silent for WARNING and worse: a book
that boots already near liquidation is exactly what must be said out loud.
UNIQUE(rule_id, symbol, bar_time) with bar_time = today caps a level at one
event per account per day. `MARGIN_SCAN_INTERVAL=0` disables (default 300 s).
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from datetime import datetime, timezone

import margin as mg

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL = 5 * 60
STARTUP_DELAY = 90
_started = False

LABELS = {
    "WATCH": "cushion below watch line",
    "WARNING": "cushion low — reduce or add funds",
    "DANGER": "near liquidation",
    "LIQUIDATION": "excess liquidity < 0 — IBKR liquidates",
}


def interval_seconds() -> int:
    raw = os.getenv("MARGIN_SCAN_INTERVAL", "").strip()
    if not raw:
        return DEFAULT_INTERVAL
    try:
        return max(0, int(raw))
    except ValueError:
        logger.warning("MARGIN_SCAN_INTERVAL=%r is not an integer — using default", raw)
        return DEFAULT_INTERVAL


def transitions(prev: dict[str, str], accounts: list[dict]) -> tuple[dict[str, str], list[dict]]:
    """New state + the events to fire. Pure — tested directly."""
    state, events = dict(prev), []
    for a in accounts:
        level = a.get("level")
        if not level:
            continue
        key = f"{a['scope']}:{a['account_id']}"
        old = prev.get(key)
        state[key] = level
        worse = mg.LEVEL_RANK[level] > mg.LEVEL_RANK.get(old or "SAFE", 0)
        first_and_bad = old is None and mg.LEVEL_RANK[level] >= mg.LEVEL_RANK["WARNING"]
        if (old is not None and worse) or first_and_bad:
            events.append({"level": level, "key": key, "account": a})
    return state, events


def apply(conn, overview: dict, now: datetime | None = None) -> list[dict]:
    now = now or datetime.now(timezone.utc)
    prev = {r["key"]: r["level"] for r in conn.execute("SELECT key, level FROM margin_state").fetchall()}
    state, events = transitions(prev, overview.get("accounts", []))
    written = []
    day = now.date().isoformat()
    for e in events:
        a = e["account"]
        snap = {k: a.get(k) for k in ("scope", "account_id", "name", "currency", "level", "cushion",
                                      "excess_liquidity", "maint_margin", "nlv", "drop_to_call")}
        snap["text"] = LABELS.get(e["level"], e["level"])
        label = f"{'PAPER ' if a['scope'] == 'paper' else ''}{a.get('name') or a['account_id']}"
        cur = conn.execute(
            "INSERT OR IGNORE INTO alert_events (rule_id, symbol, fired_at, bar_time, snapshot_json) "
            "VALUES (?, ?, ?, ?, ?)",
            (f"margin:{e['level']}", label, now.isoformat(), day,
             json.dumps({k: v for k, v in snap.items() if v is not None})),
        )
        if cur.rowcount:
            written.append(e)
    conn.execute("DELETE FROM margin_state")
    conn.executemany(
        "INSERT INTO margin_state (key, level, updated_at) VALUES (?, ?, ?)",
        [(k, v, now.isoformat()) for k, v in state.items()],
    )
    conn.commit()
    return written


def run_once() -> dict:
    from db import get_db
    from routers.margin import enabled_accounts, overview

    if not enabled_accounts():
        return {"skipped": "no margin accounts"}
    ov = overview()
    with get_db() as conn:
        written = apply(conn, ov)
    if written:
        logger.info("margin: %d level change(s): %s", len(written),
                    ", ".join(f"{e['key']}→{e['level']}" for e in written))
    return {"worst": ov.get("worst"), "events": len(written)}


def _loop(interval: int) -> None:
    time.sleep(STARTUP_DELAY)
    while True:
        try:
            run_once()
        except Exception as e:  # noqa: BLE001 — a bad tick must not kill the loop
            logger.exception("margin tick failed (will retry next interval): %s", e)
        time.sleep(interval)


def start_background_scan() -> None:
    global _started
    if _started:
        return
    interval = interval_seconds()
    if interval == 0:
        logger.info("margin: notifier disabled (MARGIN_SCAN_INTERVAL=0)")
        return
    _started = True
    threading.Thread(target=_loop, args=(interval,), daemon=True, name="margin-scan").start()
    logger.info("margin: notifier started (every %ds)", interval)
