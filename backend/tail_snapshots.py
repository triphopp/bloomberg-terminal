"""
TAIL board — a daily record, so its history can be analysed later.

`/api/tail-risk/signals` answers "how does the board read NOW". Half of what it
reads has no history anywhere: credit (HY OAS, STL FSI, NFCI), the DCC
correlation levels, the sector regime, Fear & Greed, the named market events
and the composite risk level are computed from today's state only. This module
writes the board down once per market date (`tail_signal_snapshots`, local to
this machine), which is the only way those days survive.

The vol / flow signals CAN be rebuilt from daily series — that export is
`GET /api/tail-risk/history`, not this table.

  * One row per `data_date` (the market date the board describes). A later
    reading of the same date replaces the earlier one — the close is what a
    day is remembered by — and `reads` / `first_taken_at` say how often and
    since when it was seen. A payload older than the stored one never
    overwrites it (the signals cache can hand back a stale copy).
  * Written from two places: every successful compute (`routers/tail_risk`),
    and a background pass (`start_background_recorder`) so a day the TAIL
    page was never opened is still recorded. `TAIL_SNAPSHOT_INTERVAL=0` turns
    the pass off; recording on compute stays.
"""
from __future__ import annotations

import csv
import io
import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL = 60 * 60
STARTUP_DELAY = 180
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
#: Static text (definitions, Thai summaries) is left out — the rule and the
#: readings that fired it are what an analysis needs.
_EVENT_KEYS = ("id", "name", "channel", "direction", "severity", "score", "rule", "evidence", "catalyst")
_SIGNAL_KEYS = ("id", "dimension", "state", "value", "detail", "reason", "counted")
_DIMENSION_KEYS = ("id", "status", "on_count", "total", "unknown_count", "active_signals")
_CONTEXT_KEYS = (
    "fear_greed", "spy_rsi", "sector_regime", "sector_corr", "crisis_level",
    "dcc_v1_signal", "dcc_v3_signal", "vix_term", "events_ok", "event_partial", "event_asof",
)
_started = False


def _dump(v) -> str:
    return json.dumps(v, ensure_ascii=False, default=str)


def row_from_payload(payload: dict) -> dict | None:
    """The stored form of one `/signals` payload, or None when it is not a
    board worth keeping (a failed compute, no market date)."""
    if not payload or not payload.get("ok"):
        return None
    day = str(payload.get("data_date") or "")
    ts = str(payload.get("ts") or "")
    if not _DATE.match(day) or not ts:
        return None
    basis = payload.get("risk_basis") or {}
    return {
        "snapshot_date": day,
        "payload_ts": ts,
        "risk_level": payload.get("risk_level"),
        "risk_level_dimensions": payload.get("risk_level_dimensions"),
        "risk_driver": basis.get("driver"),
        "events_floor": basis.get("events"),
        "alert_dimensions": _dump(payload.get("alert_dimensions") or []),
        "watch_dimensions": _dump(payload.get("watch_dimensions") or []),
        "signals_json": _dump([{k: s.get(k) for k in _SIGNAL_KEYS} for s in payload.get("signals") or []]),
        "dimensions_json": _dump(
            [{k: d.get(k) for k in _DIMENSION_KEYS} for d in payload.get("dimensions") or []]
        ),
        "events_json": _dump([{k: e.get(k) for k in _EVENT_KEYS} for e in payload.get("events") or []]),
        "context_json": _dump({k: payload.get(k) for k in _CONTEXT_KEYS}),
        "unknown_signals": _dump((payload.get("data_health") or {}).get("unknown_signals") or []),
    }


def record(payload: dict, now: datetime | None = None) -> bool:
    """Store `payload` as its market date's row. True when the row was written."""
    row = row_from_payload(payload)
    if row is None:
        return False
    from db import get_db

    taken = (now or datetime.now(timezone.utc)).isoformat()
    with get_db() as conn:
        old = conn.execute(
            "SELECT payload_ts FROM tail_signal_snapshots WHERE snapshot_date = ?",
            (row["snapshot_date"],),
        ).fetchone()
        if old is not None:
            if str(old["payload_ts"]) > row["payload_ts"]:
                return False  # an older cached board must not replace a newer one
            if str(old["payload_ts"]) == row["payload_ts"]:
                return False  # the same compute, seen again
            cols = [k for k in row if k != "snapshot_date"]
            conn.execute(
                f"UPDATE tail_signal_snapshots SET {', '.join(f'{k} = ?' for k in cols)}, "
                "taken_at = ?, reads = reads + 1 WHERE snapshot_date = ?",
                [row[k] for k in cols] + [taken, row["snapshot_date"]],
            )
        else:
            cols = list(row)
            conn.execute(
                f"INSERT INTO tail_signal_snapshots ({', '.join(cols)}, first_taken_at, taken_at) "
                f"VALUES ({', '.join('?' for _ in cols)}, ?, ?)",
                [row[k] for k in cols] + [taken, taken],
            )
        conn.commit()
    return True


def list_rows(start: str | None = None, end: str | None = None) -> list[dict]:
    """Stored rows, oldest first, JSON columns decoded."""
    from db import get_db

    sql = "SELECT * FROM tail_signal_snapshots"
    where, args = [], []
    if start:
        where.append("snapshot_date >= ?")
        args.append(start)
    if end:
        where.append("snapshot_date <= ?")
        args.append(end)
    if where:
        sql += " WHERE " + " AND ".join(where)
    with get_db() as conn:
        rows = [dict(r) for r in conn.execute(sql + " ORDER BY snapshot_date", args)]
    for r in rows:
        for k in ("alert_dimensions", "watch_dimensions", "signals_json", "dimensions_json",
                  "events_json", "context_json", "unknown_signals"):
            r[k] = json.loads(r[k] or "null")
    return rows


def summary() -> dict:
    from db import get_db

    with get_db() as conn:
        r = conn.execute(
            "SELECT COUNT(*) AS n, MIN(snapshot_date) AS first, MAX(snapshot_date) AS last "
            "FROM tail_signal_snapshots"
        ).fetchone()
    return {"count": int(r["n"] or 0), "first": r["first"], "last": r["last"]}


def to_csv(rows: list[dict], signal_order: list[str]) -> str:
    """One line per market date: the composite, the context, then each signal's
    state (on / off / unknown) and the reading behind it."""
    seen = list(signal_order)
    for r in rows:
        for s in r["signals_json"] or []:
            if s.get("id") and s["id"] not in seen:
                seen.append(s["id"])
    context_cols = [
        "fear_greed", "spy_rsi", "sector_regime", "sector_corr", "crisis_level",
        "dcc_v1_signal", "dcc_v3_signal", "event_partial",
    ]
    header = [
        "date", "risk_level", "risk_level_dimensions", "risk_driver", "events_floor",
        "alert_dimensions", "watch_dimensions", "events", "event_severities",
        *context_cols, "unknown_signals",
    ]
    for sig in seen:
        header += [sig, f"{sig}_value"]
    header += ["first_taken_at", "taken_at", "reads"]

    out = io.StringIO()
    w = csv.writer(out, lineterminator="\n")
    w.writerow(header)
    for r in rows:
        ctx = r["context_json"] or {}
        events = r["events_json"] or []
        by_id = {s.get("id"): s for s in r["signals_json"] or []}
        line = [
            r["snapshot_date"], r["risk_level"], r["risk_level_dimensions"], r["risk_driver"],
            r["events_floor"], ";".join(r["alert_dimensions"] or []), ";".join(r["watch_dimensions"] or []),
            ";".join(str(e.get("id")) for e in events), ";".join(str(e.get("severity")) for e in events),
            *[ctx.get(k) for k in context_cols], ";".join(r["unknown_signals"] or []),
        ]
        for sig in seen:
            s = by_id.get(sig)
            line += [s.get("state") if s else "", s.get("value") if s else ""]
        line += [r["first_taken_at"], r["taken_at"], r["reads"]]
        w.writerow(["" if v is None else v for v in line])
    return out.getvalue()


# ─── Background pass ──────────────────────────────────────────────────────────


def interval_seconds() -> int:
    raw = os.getenv("TAIL_SNAPSHOT_INTERVAL", "").strip()
    if not raw:
        return DEFAULT_INTERVAL
    try:
        return max(0, int(raw))
    except ValueError:
        logger.warning("TAIL_SNAPSHOT_INTERVAL=%r is not an integer — using default", raw)
        return DEFAULT_INTERVAL


def run_once() -> bool:
    """Read the board (cached when fresh) and store it."""
    from routers import tail_risk

    return record(tail_risk.get_signals())


def _loop(interval: int) -> None:
    import request_latency

    time.sleep(STARTUP_DELAY)
    while True:
        request_latency.wait_for_quiet()
        try:
            run_once()
        except Exception:  # a dead recorder thread is a silent hole in the record
            logger.exception("tail snapshot: pass failed")
        time.sleep(interval)


def start_background_recorder() -> None:
    global _started
    if _started:
        return
    interval = interval_seconds()
    if interval == 0:
        logger.info("tail snapshot recorder: disabled (TAIL_SNAPSHOT_INTERVAL=0)")
        return
    _started = True
    threading.Thread(target=_loop, args=(interval,), daemon=True, name="tail-snapshot").start()
