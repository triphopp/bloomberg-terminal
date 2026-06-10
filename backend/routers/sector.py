"""
US Sector Selection Signal router.

Endpoints:
  GET  /api/sector/signal   — full sector ranking + scores (cached 5min)
  GET  /api/sector/history  — historical signals from SQLite
  GET  /api/sector/factors  — raw macro factor z-scores
  DELETE /api/sector/cache  — clear all layer caches
"""
from __future__ import annotations

import json
import threading
import time
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Query

from analytics.sector_confluence import (
    compute_sector_signal,
    clear_confluence_cache,
)
from analytics.sector_factor import compute_factor
from db import get_db

router = APIRouter(prefix="/api/sector", tags=["sector"])

# ── Response cache ─────────────────────────────────────────────────────────────

_cache: dict[str, tuple[float, Any]] = {}
_cache_lock = threading.Lock()
_CACHE_TTL = 300  # 5 minutes


def _cached(key: str, ttl: int, factory):
    now = time.time()
    with _cache_lock:
        if key in _cache:
            ts, val = _cache[key]
            if now - ts < ttl:
                return val
    val = factory()
    with _cache_lock:
        _cache[key] = (now, val)
    return val


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/signal")
def get_signal():
    """Full sector ranking + scores with layer decomposition."""
    def compute():
        result = compute_sector_signal()
        try:
            _store_signal(result)
        except Exception:
            pass
        return result

    return _cached("signal", _CACHE_TTL, compute)


@router.get("/history")
def get_history(days: int = Query(60, ge=1, le=365)):
    """Historical sector signals from SQLite."""
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sector_signals (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                version         TEXT NOT NULL DEFAULT '1.0',
                timestamp       TEXT NOT NULL,
                cycle_phase     TEXT NOT NULL,
                cycle_score     REAL NOT NULL,
                vix             REAL,
                brake_active    INTEGER NOT NULL DEFAULT 0,
                sector_data     TEXT NOT NULL,
                conflicts       TEXT DEFAULT '{}',
                created_at      TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_ss_created_at
            ON sector_signals(created_at)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_ss_cycle
            ON sector_signals(cycle_phase)
        """)
        rows = conn.execute(
            "SELECT * FROM sector_signals "
            "WHERE created_at >= datetime('now', ?) "
            "ORDER BY created_at DESC LIMIT 500",
            (f"-{days} days",),
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/factors")
def get_factors():
    """Raw macro factor z-scores — for debugging and factor dashboard."""
    return compute_factor()["factors"]


@router.delete("/cache")
def clear_cache():
    """Clear all sector signal caches (response + all 4 layers)."""
    with _cache_lock:
        _cache.clear()
    clear_confluence_cache()
    return {"status": "ok", "message": "All sector caches cleared"}


# ── Persistence ────────────────────────────────────────────────────────────────

def _store_signal(result: dict) -> None:
    """Fire-and-forget persist to SQLite."""
    ts = result.get("timestamp", datetime.utcnow().isoformat() + "Z")
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sector_signals (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                version         TEXT NOT NULL DEFAULT '1.0',
                timestamp       TEXT NOT NULL,
                cycle_phase     TEXT NOT NULL,
                cycle_score     REAL NOT NULL,
                vix             REAL,
                brake_active    INTEGER NOT NULL DEFAULT 0,
                sector_data     TEXT NOT NULL,
                conflicts       TEXT DEFAULT '{}',
                created_at      TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_ss_created_at
            ON sector_signals(created_at)
        """)
        conn.execute(
            "INSERT INTO sector_signals "
            "(version, timestamp, cycle_phase, cycle_score, vix, brake_active, sector_data, conflicts) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (
                result.get("version", "1.0"),
                ts,
                result.get("cycle_phase", "UNKNOWN"),
                result.get("cycle_score", 0.0),
                result.get("vix"),
                1 if result.get("volatility_brake_active") else 0,
                json.dumps(result.get("sectors", [])),
                json.dumps(result.get("conflicts", {})),
            ),
        )
