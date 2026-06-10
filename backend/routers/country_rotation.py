"""
Country Equity Rotation Signal router.

Endpoints:
  GET /api/country-rotation/scores   — ranked rotation scores (cached 5min)
  GET /api/country-rotation/history  — historical scores from SQLite
  GET /api/country-rotation/universe — static universe definition
"""
import threading
import time
from datetime import datetime
from typing import Any

from fastapi import APIRouter

from analytics.country_rotation import (
    COUNTRY_UNIVERSE,
    compute_momentum,
    compute_macro_quality,
    compute_carry,
    compute_rotation_scores,
)
from db import get_db

router = APIRouter(prefix="/api/country-rotation", tags=["country-rotation"])

# ── Cache ──────────────────────────────────────────────────────────────────────
_cache: dict[str, tuple[float, Any]] = {}
_cache_lock = threading.Lock()

_CACHE_TTL = 300  # 5 minutes


def _cached(key: str, factory):
    now = time.time()
    with _cache_lock:
        if key in _cache:
            ts, val = _cache[key]
            if now - ts < _CACHE_TTL:
                return val
    val = factory()
    with _cache_lock:
        _cache[key] = (now, val)
    return val


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.delete("/cache")
def clear_cache():
    """Force-clear rotation score cache so next /scores recomputes from scratch."""
    with _cache_lock:
        _cache.clear()
    return {"cleared": True}


@router.get("/scores")
def get_scores():
    """Full ranked country rotation scores with allocation context."""
    def compute():
        momentum = compute_momentum()
        macro    = compute_macro_quality()
        carry    = compute_carry()
        rankings = compute_rotation_scores(momentum, macro, carry)

        # Universe stats
        m_comp = [m.get("composite", 0) for m in momentum.values() if "composite" in m]
        from statistics import mean, stdev

        result = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "rankings": rankings,
            "universe_stats": {
                "n_countries": len(rankings),
                "mean_momentum_composite": round(mean(m_comp), 6) if m_comp else 0,
                "std_momentum_composite":  round(stdev(m_comp), 6) if len(m_comp) > 1 else 0,
                "data_freshness": {
                    "prices": datetime.utcnow().strftime("%Y-%m-%d"),
                    "macro": _macro_freshness(macro),
                    "carry": datetime.utcnow().strftime("%Y-%m-%d"),
                },
            },
        }

        # Store in DB
        try:
            _store_scores(rankings)
        except Exception:
            pass

        return result

    return _cached("scores", compute)


@router.get("/history")
def get_history(days: int = 90, ticker: str = "SPY"):
    """Historical rotation scores for a ticker."""
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS country_rotation_scores (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp       TEXT NOT NULL,
                ticker          TEXT NOT NULL,
                country         TEXT NOT NULL,
                rotation_score  REAL NOT NULL,
                classification  TEXT NOT NULL,
                m_score         REAL,
                m_momentum_12m  REAL,
                m_momentum_6m   REAL,
                m_momentum_3m   REAL,
                q_score         REAL,
                q_gdp_3y_ma     REAL,
                q_current_acct  REAL,
                c_score         REAL,
                c_div_yield     REAL,
                created_at      TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_crs_timestamp ON country_rotation_scores(timestamp)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_crs_ticker   ON country_rotation_scores(ticker)"
        )
        rows = conn.execute(
            "SELECT * FROM country_rotation_scores "
            "WHERE ticker = ? AND created_at >= datetime('now', ?) "
            "ORDER BY created_at DESC LIMIT 500",
            (ticker.upper(), f"-{days} days"),
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/universe")
def get_universe():
    """Static universe definition."""
    return COUNTRY_UNIVERSE


# ── Helpers ────────────────────────────────────────────────────────────────────

def _macro_freshness(macro: dict) -> str:
    """Extract the latest year from macro data."""
    years = []
    for detail in macro.values():
        y = detail.get("gdp_year") or detail.get("current_account_year")
        if y:
            try:
                years.append(int(y))
            except ValueError:
                pass
    return str(max(years)) if years else "unknown"


def _store_scores(rankings: list[dict]) -> None:
    """Persist scores to SQLite."""
    ts = datetime.utcnow().isoformat() + "Z"
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS country_rotation_scores (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp       TEXT NOT NULL,
                ticker          TEXT NOT NULL,
                country         TEXT NOT NULL,
                rotation_score  REAL NOT NULL,
                classification  TEXT NOT NULL,
                m_score         REAL,
                m_momentum_12m  REAL,
                m_momentum_6m   REAL,
                m_momentum_3m   REAL,
                q_score         REAL,
                q_gdp_3y_ma     REAL,
                q_current_acct  REAL,
                c_score         REAL,
                c_div_yield     REAL,
                created_at      TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_crs_timestamp ON country_rotation_scores(timestamp)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_crs_ticker   ON country_rotation_scores(ticker)"
        )
        for item in rankings:
            layers = item.get("layers", {})
            conn.execute(
                "INSERT INTO country_rotation_scores "
                "(timestamp, ticker, country, rotation_score, classification, "
                "m_score, m_momentum_12m, m_momentum_6m, m_momentum_3m, "
                "q_score, q_gdp_3y_ma, q_current_acct, c_score, c_div_yield) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    ts, item["ticker"], item["country"],
                    item["rotation_score"], item["classification"],
                    layers["M"]["score"], layers["M"]["momentum_12m_1m"],
                    layers["M"]["momentum_6m"], layers["M"]["momentum_3m"],
                    layers["Q"]["score"], layers["Q"]["gdp_growth_3y_ma"],
                    layers["Q"]["current_account"],
                    layers["C"]["score"], layers["C"]["dividend_yield"],
                ),
            )
