"""
Alert engine — regime changes (15-min event).

GET /api/alerts?account_id=all
POST /api/alerts/regime/check   — called internally to detect regime changes
DELETE /api/alerts/regime/clear — clear expired events
"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Query

from cache import TTLCache
from db import get_db

router = APIRouter(prefix="/api/alerts", tags=["alerts"])

_cache = TTLCache(ttl=60)
_regime_lock = threading.Lock()

REGIME_ALERT_MINUTES = 15   # event-based alerts expire after this


# ---------------------------------------------------------------------------
# Regime change detection
# ---------------------------------------------------------------------------

def _get_current_regime_label() -> Optional[str]:
    """Fetch current CORR regime label from regime router."""
    try:
        from routers.regime import get_calibrated
        result = get_calibrated(period="3m")   # explicit — Query default won't resolve
        return result.get("corr", {}).get("label")
    except Exception as e:
        print(f"[alerts] regime fetch error: {e}")
        return None


def check_regime_change() -> Optional[dict]:
    """
    Compare current regime label with last stored label.
    If changed, insert a regime_alert row (expires 15 min from now).
    Returns the new alert dict, or None if no change.
    """
    with _regime_lock:
        current = _get_current_regime_label()
        if not current:
            return None

        now_utc    = datetime.now(timezone.utc)
        expires_at = (now_utc + timedelta(minutes=REGIME_ALERT_MINUTES)).isoformat()

        with get_db() as conn:
            # Get last recorded label
            last_row = conn.execute("""
                SELECT to_label FROM regime_alerts
                ORDER BY detected_at DESC LIMIT 1
            """).fetchone()

            last_label = last_row["to_label"] if last_row else None

            if last_label is None:
                # First run — seed current label as baseline, no alert
                conn.execute("""
                    INSERT INTO regime_alerts (from_label, to_label, regime_type, detected_at, expires_at)
                    VALUES (?, ?, 'CORR', ?, ?)
                """, (current, current, now_utc.isoformat(),
                      # expires immediately — won't show as active alert
                      now_utc.isoformat()))
                return None

            if last_label == current:
                return None  # no change

            # Genuine transition — insert with 15-min expiry
            conn.execute("""
                INSERT INTO regime_alerts (from_label, to_label, regime_type, detected_at, expires_at)
                VALUES (?, ?, 'CORR', ?, ?)
            """, (last_label, current, now_utc.isoformat(), expires_at))

        severity = "critical" if current in ("CRISIS", "RISK-OFF") else "warning"
        emoji    = "🔴" if severity == "critical" else "🟡"
        return {
            "type":       "regime",
            "severity":   severity,
            "symbol":     None,
            "message":    f"{emoji} REGIME: {last_label} → {current}",
            "persistent": False,
            "expires_at": expires_at,
        }


def _get_active_regime_alerts() -> list[dict]:
    """Return non-expired regime change alerts from DB."""
    now_utc = datetime.now(timezone.utc).isoformat()
    try:
        with get_db() as conn:
            rows = conn.execute("""
                SELECT from_label, to_label, detected_at, expires_at
                FROM regime_alerts
                WHERE expires_at > ?
                ORDER BY detected_at DESC
            """, (now_utc,)).fetchall()

        alerts = []
        for r in rows:
            severity = "critical" if r["to_label"] in ("CRISIS", "RISK-OFF") else "warning"
            emoji    = "🔴" if severity == "critical" else "🟡"
            alerts.append({
                "type":       "regime",
                "severity":   severity,
                "symbol":     None,
                "message":    f"{emoji} REGIME: {r['from_label']} → {r['to_label']}",
                "persistent": False,
                "expires_at": r["expires_at"],
            })
        return alerts
    except Exception as e:
        print(f"[alerts] regime DB error: {e}")
        return []


# ---------------------------------------------------------------------------
# Main endpoint
# ---------------------------------------------------------------------------

@router.get("")
def get_alerts(account_id: str = Query("all")):
    """
    Returns all active alerts:
      - Regime changes (event-based, expire after 15 min)
    """
    cache_key = f"alerts:{account_id}"
    cached = _cache.get(cache_key)
    if cached:
        return cached

    # Check for new regime change (also stores to DB if changed)
    check_regime_change()

    all_alerts = _get_active_regime_alerts()

    result = {
        "alerts":  all_alerts,
        "count":   len(all_alerts),
        "has_critical": any(a["severity"] == "critical" for a in all_alerts),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    _cache.set(cache_key, result)
    return result


@router.delete("/regime/clear")
def clear_expired_regime_alerts():
    """Remove expired regime alert rows from DB."""
    now_utc = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        conn.execute("DELETE FROM regime_alerts WHERE expires_at <= ?", (now_utc,))
    _cache.delete("alerts:all")
    return {"status": "cleared"}
