"""
WEBULL notifier — a token or an entitlement about to end → alert-feed event.

The DEPTH panel says when the access token (15 days) or the market-data
entitlement (the date in WEBULL_SUBSCRIPTION_ENDS) is about to end — but only
to someone looking at DEPTH. This writes the same fact to `alert_events`, so
the strip at the bottom of every view, the alert list and the toast carry it:

  rule_id            when                                    one row per
  webull:TOKEN_SOON  a working token has under 3 days left   day
  webull:TOKEN_ENDED the token is past its date / refused    token
  webull:FEED_SOON   the entitlement has ≤14 days left       step: 14, 7, 3, 2, 1
  webull:FEED_ENDED  its date has passed                     date

UNIQUE(rule_id, symbol, bar_time) keeps a scan from writing a row twice. A row
that no longer holds — the token was renewed, the date was moved — is
acknowledged here: nobody should have to dismiss a warning that was heeded.

It reads the token file and, at most every 6 hours, asks Webull whether the
token still stands (`refresh_token_status`). It never requests a token.
`WEBULL_SCAN_INTERVAL=0` disables (default 1800 s). Nothing is written while
the keys are not set.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from datetime import date, datetime, timezone

import webull_client as wb

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL = 30 * 60
STARTUP_DELAY = 90
SYMBOL = "WEBULL"
TOKEN_LEAD_S = 3 * 86_400
FEED_STEPS = (14, 7, 3, 2, 1)      # days left at which the entitlement is mentioned again
_started = False


def interval_seconds() -> int:
    raw = os.getenv("WEBULL_SCAN_INTERVAL", "").strip()
    if not raw:
        return DEFAULT_INTERVAL
    try:
        return max(0, int(raw))
    except ValueError:
        logger.warning("WEBULL_SCAN_INTERVAL=%r is not an integer — using default", raw)
        return DEFAULT_INTERVAL


def _iso(ms) -> str | None:
    try:
        return datetime.fromtimestamp(float(ms) / 1000, timezone.utc).isoformat(timespec="seconds")
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def wanted(token: dict | None, subscription: dict | None, now: datetime) -> list[dict]:
    """The rows that should stand right now. Pure: the token record as stored,
    the entitlement as /api/webull/status reports it, and the clock."""
    out: list[dict] = []
    status = (token or {}).get("status")
    left = None
    if token and token.get("expires_at"):
        try:
            left = float(token["expires_at"]) / 1000 - now.timestamp()
        except (TypeError, ValueError):
            left = None
    ends_at = _iso((token or {}).get("expires_at"))
    if status in ("EXPIRED", "INVALID") or (status == "NORMAL" and left is not None and left <= 0):
        out.append({
            "rule_id": "webull:TOKEN_ENDED",
            # One row per token: its expiry date names it without holding it.
            "bar_time": f"ended#{token.get('expires_at') or 0}",
            "snapshot": {"kind": "TOKEN_ENDED", "title": "Access token ended", "ends_at": ends_at,
                         "detail": "DEPTH is off until a new token is confirmed: MKT → STRUCTURE → DEPTH → "
                                   "REQUEST TOKEN, then the SMS code in the Webull app."},
        })
    elif status == "NORMAL" and left is not None and left < TOKEN_LEAD_S:
        out.append({
            "rule_id": "webull:TOKEN_SOON",
            "bar_time": now.astimezone().date().isoformat(),      # said once a day
            "snapshot": {"kind": "TOKEN_SOON", "title": "Access token ends", "ends_at": ends_at,
                         "detail": "A Webull token lasts 15 days and cannot be renewed early. When it ends, "
                                   "DEPTH asks for a new one (SMS code in the Webull app)."},
        })

    days = (subscription or {}).get("days_left")
    ends = (subscription or {}).get("ends")
    if days is not None and ends:
        feed_ends = f"{ends}T00:00:00+00:00"
        if days <= 0:
            out.append({
                "rule_id": "webull:FEED_ENDED",
                "bar_time": f"ended#{ends}",
                "snapshot": {"kind": "FEED_ENDED", "title": "Market-data entitlement end date passed",
                             "ends_at": feed_ends, "ends": ends,
                             "detail": "Renew on the Webull website → avatar → Advanced Quotes → OpenAPI, "
                                       "then set WEBULL_SUBSCRIPTION_ENDS in backend/.env."},
            })
        elif days <= FEED_STEPS[0]:
            step = min(s for s in FEED_STEPS if s >= days)
            out.append({
                "rule_id": "webull:FEED_SOON",
                "bar_time": f"{ends}#{step}",
                "snapshot": {"kind": "FEED_SOON", "title": "Market-data entitlement ends",
                             "ends_at": feed_ends, "ends": ends,
                             "detail": "Renew on the Webull website → avatar → Advanced Quotes → OpenAPI, "
                                       "then set WEBULL_SUBSCRIPTION_ENDS in backend/.env."},
            })
    return out


def apply(conn, rows: list[dict], now: datetime | None = None) -> list[dict]:
    """Write `rows`, acknowledge every standing webull row that is not one of
    them. Returns the rows that were new."""
    now = now or datetime.now(timezone.utc)
    written = []
    for row in rows:
        cur = conn.execute(
            "INSERT OR IGNORE INTO alert_events (rule_id, symbol, fired_at, bar_time, snapshot_json) "
            "VALUES (?, ?, ?, ?, ?)",
            (row["rule_id"], SYMBOL, now.isoformat(), row["bar_time"],
             json.dumps(row["snapshot"], ensure_ascii=False)),
        )
        if cur.rowcount:
            written.append(row)
    keep = {(r["rule_id"], r["bar_time"]) for r in rows}
    for event in conn.execute(
            "SELECT id, rule_id, bar_time FROM alert_events "
            "WHERE acked = 0 AND rule_id LIKE 'webull:%'").fetchall():
        if (event["rule_id"], event["bar_time"]) not in keep:
            conn.execute("UPDATE alert_events SET acked = 1 WHERE id = ?", (event["id"],))
    conn.commit()
    return written


def subscription(today: date | None = None) -> dict | None:
    """WEBULL_SUBSCRIPTION_ENDS as days left; None when unset or not a date."""
    raw = wb.config.WEBULL_SUBSCRIPTION_ENDS
    try:
        ends = date.fromisoformat(raw) if raw else None
    except ValueError:
        return None
    if ends is None:
        return None
    return {"ends": ends.isoformat(), "days_left": (ends - (today or date.today())).days}


def run_once() -> dict:
    from db import get_db

    if not wb.configured():
        rows: list[dict] = []
    else:
        try:
            token = wb.refresh_token_status()           # ≤1 call / 6 h; never requests a token
        except wb.WebullError:
            token = wb.load_token()
        rows = wanted(token, subscription(), datetime.now(timezone.utc))
    with get_db() as conn:
        written = apply(conn, rows)
    if written:
        logger.warning("webull: %s", ", ".join(r["rule_id"] for r in written))
    return {"standing": [r["rule_id"] for r in rows], "new": [r["rule_id"] for r in written]}


def _loop(interval: int) -> None:
    time.sleep(STARTUP_DELAY)
    while True:
        try:
            run_once()
        except Exception as e:  # noqa: BLE001 — a bad tick must not kill the loop
            logger.exception("webull tick failed (will retry next interval): %s", e)
        time.sleep(interval)


def start_background_scan() -> None:
    global _started
    if _started:
        return
    interval = interval_seconds()
    if interval == 0:
        logger.info("webull: notifier disabled (WEBULL_SCAN_INTERVAL=0)")
        return
    _started = True
    threading.Thread(target=_loop, args=(interval,), daemon=True, name="webull-scan").start()
    logger.info("webull: notifier started (every %ds)", interval)
