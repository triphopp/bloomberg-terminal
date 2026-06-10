"""
Equity Allocation Confluence Signal router.

Endpoints:
  GET /api/allocation/signal  — full confluence output (cached per-layer)
  GET /api/allocation/layers  — raw scores per layer (for debugging)
  GET /api/allocation/history — historical signals from SQLite
"""
import json
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from analytics.layer_a import compute_layer_a
from analytics.layer_b import compute_layer_b
from analytics.layer_c import compute_layer_c
from analytics.confluence import compute_confluence
from config import FRED_CSV_URL, FRED_JSON_URL, FRED_API_KEY
from db import get_db
from sources import market_data

router = APIRouter(prefix="/api/allocation", tags=["allocation"])

# ── ETF tickers for Layer B (same order as layer_b.EQUITY_ETFS + BOND_ETFS) ─────
ETF_TICKERS = ["SPY", "QQQ", "VT", "EFA", "EEM", "AGG", "BND", "TLT", "IEF"]

# ── Per-layer cache ─────────────────────────────────────────────────────────────
_cache: dict[str, tuple[float, Any]] = {}
_cache_lock = threading.Lock()

# Cache TTLs per layer (seconds)
_CACHE_TTL_A = 300   # 5 min — daily prices change slowly
_CACHE_TTL_B = 3600  # 1 hour — ETF shares outstanding
_CACHE_TTL_C = 86400 # 1 day — quarterly FRED data


def _cached(key: str, ttl: int, factory):
    """Generic cache helper."""
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


def _fetch_prices(symbol: str, period: str = "2y") -> list[float]:
    """Fetch daily close prices for a symbol, oldest first."""
    try:
        frame = market_data.get_history(symbol, period=period, interval="1d")
        # get_history() now returns OHLCVFrame — extract .df
        df = frame.df if frame is not None else None
        if df is None or df.empty:
            return []
        closes = df["Close"].dropna().tolist()
        return [float(x) for x in closes]
    except Exception:
        return []


def _fetch_shares_outstanding(symbol: str) -> float | None:
    """Fetch latest shares outstanding from yfinance info."""
    try:
        info = market_data.get_info(symbol)
        return info.get("sharesOutstanding")
    except Exception:
        return None


# ── Endpoints ───────────────────────────────────────────────────────────────────

@router.get("/signal")
def get_signal():
    """
    Full confluence signal — combines all three layers.
    Cached per-layer: A=5min, B=1hr, C=1day.
    """
    # Layer A — Sentiment
    layer_a = _cached("layer_a", _CACHE_TTL_A, lambda: _compute_layer_a())
    # Layer B — Flow
    layer_b = _cached("layer_b", _CACHE_TTL_B, lambda: _compute_layer_b())
    # Layer C — Structural
    layer_c = _cached("layer_c", _CACHE_TTL_C, lambda: _compute_layer_c())

    result = compute_confluence(layer_a, layer_b, layer_c)

    # Store signal in SQLite (async fire-and-forget, don't block response)
    try:
        _store_signal(result)
    except Exception:
        pass

    result["timestamp"] = datetime.utcnow().isoformat() + "Z"
    return result


@router.delete("/cache")
def clear_cache():
    """Force-clear all layer caches so next /signal recomputes from scratch."""
    with _cache_lock:
        _cache.clear()
    return {"cleared": True}


@router.get("/layers")
def get_layers():
    """Raw scores and inputs per layer — for debugging and charting."""
    layer_a = _cached("layer_a", _CACHE_TTL_A, lambda: _compute_layer_a())
    layer_b = _cached("layer_b", _CACHE_TTL_B, lambda: _compute_layer_b())
    layer_c = _cached("layer_c", _CACHE_TTL_C, lambda: _compute_layer_c())

    return {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "A": layer_a,
        "B": layer_b,
        "C": layer_c,
    }


@router.get("/history")
def get_history(days: int = 90):
    """Historical signal readings from SQLite."""
    with get_db() as conn:
        # Ensure table exists
        conn.execute("""
            CREATE TABLE IF NOT EXISTS allocation_signals (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp       TEXT NOT NULL,
                regime          TEXT NOT NULL,
                equal_score     INTEGER NOT NULL,
                weighted_score  REAL NOT NULL,
                conflict        INTEGER NOT NULL DEFAULT 0,
                a_score         INTEGER,
                a_z             REAL,
                b_score         INTEGER,
                b_z             REAL,
                c_score         INTEGER,
                c_z             REAL,
                c_eq_share      REAL,
                recommendation  TEXT DEFAULT '',
                created_at      TEXT DEFAULT (datetime('now'))
            )
        """)
        rows = conn.execute(
            "SELECT * FROM allocation_signals "
            "WHERE created_at >= datetime('now', ?) "
            "ORDER BY created_at DESC LIMIT 500",
            (f"-{days} days",),
        ).fetchall()
    return [dict(r) for r in rows]


# ── Internal computation helpers ─────────────────────────────────────────────────

def _compute_layer_a() -> dict:
    spy_prices = _fetch_prices("SPY", period="2y")
    agg_prices = _fetch_prices("AGG", period="2y")
    return compute_layer_a(spy_prices, agg_prices)


def _compute_layer_b() -> dict:
    etf_data: dict[str, dict] = {}
    for ticker in ETF_TICKERS:
        prices = _fetch_prices(ticker, period="1mo")
        shares = _fetch_shares_outstanding(ticker)
        etf_data[ticker] = {"prices": prices, "shares_outstanding": shares}
    return compute_layer_b(etf_data)


def _compute_layer_c() -> dict:
    return compute_layer_c()


def _store_signal(result: dict) -> None:
    """Persist a signal reading to SQLite."""
    layers = result.get("layers", {})
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS allocation_signals (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp       TEXT NOT NULL,
                regime          TEXT NOT NULL,
                equal_score     INTEGER NOT NULL,
                weighted_score  REAL NOT NULL,
                conflict        INTEGER NOT NULL DEFAULT 0,
                a_score         INTEGER,
                a_z             REAL,
                b_score         INTEGER,
                b_z             REAL,
                c_score         INTEGER,
                c_z             REAL,
                c_eq_share      REAL,
                recommendation  TEXT DEFAULT '',
                created_at      TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            INSERT INTO allocation_signals
                (timestamp, regime, equal_score, weighted_score, conflict,
                 a_score, a_z, b_score, b_z, c_score, c_z, c_eq_share, recommendation)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            result.get("timestamp", datetime.utcnow().isoformat() + "Z"),
            result.get("regime", "NEUTRAL"),
            result.get("equal_score", 0),
            result.get("weighted_score", 0.0),
            1 if result.get("conflict") else 0,
            layers.get("A", {}).get("score"),
            layers.get("A", {}).get("z_score"),
            layers.get("B", {}).get("score"),
            layers.get("B", {}).get("z_score"),
            layers.get("C", {}).get("score"),
            layers.get("C", {}).get("z_score"),
            layers.get("C", {}).get("equity_share"),
            result.get("recommendation", ""),
        ))
