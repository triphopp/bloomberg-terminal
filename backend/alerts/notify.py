"""
Alert notification dispatch (plan §3 `notify`, §11.8).

The four channels split by *who does the delivering*, and that split is the
whole design:

  ticker / toast / sound  →  CLIENT-side. The browser already polls
      /api/alerts/events. These are render hints carried on the event row,
      not separate transports — so there is nothing to implement here for
      them beyond making sure `notify` reaches the client (list_events joins
      alert_rules for exactly that reason).
  webhook                 →  SERVER-side. The only channel that needs an
      outbound request, so it's the only one this module actually delivers.

Building four transports would have meant four failure modes, four retry
policies and four things to keep in sync with the ticker. One is enough.

Failure policy: a webhook that 500s or hangs must never break a scan or lose
an event — the event row is already persisted by the time dispatch runs. We
record the outcome on the row (`notified_at` / `notify_error`) and move on.
No retry loop: the next scan is ~15 minutes away, and hammering a flaky
endpoint is worse than one missed ping that is still visible in-app.
"""
from __future__ import annotations

import json
import logging
import sqlite3
from typing import Any, Iterable
from urllib.parse import urlparse

import requests

logger = logging.getLogger(__name__)

# Deliberately short: dispatch runs inline at the end of a scan, and a hung
# endpoint must not hold the scan's DB transaction open.
WEBHOOK_TIMEOUT = 5.0


# ── Message shaping ──────────────────────────────────────────────────────────


def humanize_operand_key(key: str) -> str:
    """Turn an eval.py operand key back into something a human reads.

    Keys look like `ind:rsi:period=14:rsi:0`, `price:close:0`, `const:100.0`.
    They're built for memoization, not for people (plan §5's snapshot_json is
    "ค่า operand ทุกตัวตอนยิง → ไว้ debug ย้อนหลังได้"), so a webhook body that
    dumps them raw is a debug artifact, not a notification.
    """
    parts = key.split(":")
    kind = parts[0]
    if kind == "const":
        return parts[1] if len(parts) > 1 else key
    if kind == "price":
        return parts[1] if len(parts) > 1 else key
    if kind == "ind" and len(parts) >= 4:
        ind_id, params, output = parts[1], parts[2], parts[3]
        args = ",".join(p.split("=")[-1] for p in params.split(",") if p) if params else ""
        base = f"{ind_id.upper()}({args})" if args else ind_id.upper()
        # `RSI(14).rsi` reads worse than `RSI(14)` when the output is the
        # indicator's only/primary line.
        return base if output == ind_id else f"{base}.{output}"
    return key


def format_snapshot(snapshot: dict[str, float | None]) -> str:
    bits = []
    for key, value in snapshot.items():
        if key.startswith("const:"):
            continue  # thresholds are already implied by the rule name
        label = humanize_operand_key(key)
        bits.append(f"{label}={value:.4g}" if isinstance(value, (int, float)) else f"{label}=n/a")
    return "  ".join(bits)


def build_message(event: Any, rule: Any) -> tuple[str, str]:
    """(title, body) — plain text, shared by every webhook flavor."""
    title = f"{event.symbol} · {rule.name}"
    detail = format_snapshot(event.snapshot)
    body = f"bar {event.bar_time}"
    if detail:
        body += f"\n{detail}"
    return title, body


# ── Transport ────────────────────────────────────────────────────────────────


def webhook_flavor(url: str) -> str:
    """Discord and ntfy are the two endpoints a single-user local app actually
    points at (plan §11.8), and both reject the other's body shape — so detect
    rather than make the user configure a format they'd have to look up."""
    host = (urlparse(url).hostname or "").lower()
    if host.endswith("discord.com") or host.endswith("discordapp.com"):
        return "discord"
    if host == "ntfy.sh" or host.endswith(".ntfy.sh"):
        return "ntfy"
    return "generic"


def _request_args(url: str, event: Any, rule: Any) -> dict[str, Any]:
    title, body = build_message(event, rule)
    flavor = webhook_flavor(url)

    if flavor == "discord":
        return {"json": {"content": f"**{title}**\n{body}"}}
    if flavor == "ntfy":
        return {
            "data": body.encode("utf-8"),
            "headers": {"Title": title, "Tags": "chart_with_upwards_trend"},
        }
    return {
        "json": {
            "title": title,
            "message": body,
            "ruleId": event.rule_id,
            "ruleName": rule.name,
            "symbol": event.symbol,
            "barTime": event.bar_time,
            "firedAt": event.fired_at,
            "snapshot": event.snapshot,
        }
    }


def deliver_webhook(url: str, event: Any, rule: Any) -> tuple[bool, str | None]:
    """Never raises. Returns (ok, error_message)."""
    try:
        resp = requests.post(url, timeout=WEBHOOK_TIMEOUT, **_request_args(url, event, rule))
        if resp.status_code >= 400:
            return False, f"HTTP {resp.status_code}: {resp.text[:200]}"
        return True, None
    except Exception as e:  # noqa: BLE001 — a bad webhook must not fail a scan
        return False, f"{type(e).__name__}: {e}"[:300]


# ── Dispatch ─────────────────────────────────────────────────────────────────


def wants_webhook(rule: Any) -> bool:
    return "webhook" in (rule.notify or ()) and bool(rule.webhook_url)


def dispatch(
    conn: sqlite3.Connection,
    events: Iterable[Any],
    rules_by_id: dict[str, Any],
    now_iso: str,
) -> dict[str, int]:
    """Deliver the server-side channel for freshly-persisted events.

    Client-side channels (ticker/toast/sound) are intentionally a no-op here —
    see the module docstring. Returns a small counter for the scan response so
    a manual scan can tell "fired but nobody was told" from "fired and sent".
    """
    sent = failed = skipped = 0

    for event in events:
        rule = rules_by_id.get(event.rule_id)
        if rule is None or not wants_webhook(rule):
            skipped += 1
            continue

        ok, error = deliver_webhook(rule.webhook_url, event, rule)
        if ok:
            sent += 1
        else:
            failed += 1
            logger.warning("alert webhook failed for %s/%s: %s", rule.name, event.symbol, error)

        conn.execute(
            "UPDATE alert_events SET notified_at = ?, notify_error = ? "
            "WHERE rule_id = ? AND symbol = ? AND bar_time = ?",
            (now_iso if ok else None, error, event.rule_id, event.symbol, event.bar_time),
        )

    return {"sent": sent, "failed": failed, "skipped": skipped}


def test_webhook(url: str) -> tuple[bool, str | None]:
    """Used by POST /api/alerts/notify/test so the user can find out their URL
    is wrong now, instead of the next time a rule happens to fire."""

    class _FakeEvent:
        rule_id = "test"
        symbol = "TEST"
        fired_at = "now"
        bar_time = "—"
        snapshot: dict[str, float | None] = {}

    class _FakeRule:
        name = "Webhook test — bloomberg-terminal"

    return deliver_webhook(url, _FakeEvent(), _FakeRule())


__all__ = [
    "build_message",
    "deliver_webhook",
    "dispatch",
    "format_snapshot",
    "humanize_operand_key",
    "test_webhook",
    "webhook_flavor",
    "wants_webhook",
]
