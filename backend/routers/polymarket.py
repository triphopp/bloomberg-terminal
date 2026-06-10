"""
Polymarket Signal Extraction Pipeline.

Two-layer architecture:
  Layer 1 — Market Discovery: Gamma API full-pool fetch → phrase keyword match (client-side)
  Layer 2 — Signal Extraction: 8 signal types → outcomePrices[0] = implied probability

NOTE: The Gamma API (/gamma-api.polymarket.com/markets) does NOT support server-side
filtering by tag, category, or full-text search — all query params except limit/offset/
active/closed are silently ignored. Discovery must be done client-side on the full pool.

Signal types:
  fed_rate     — Fed rate decisions / FOMC
  inflation    — CPI, PCE, inflation targets
  recession    — GDP, recession probability
  global_rates — ECB, BOE, BOJ, other central banks
  trade        — Tariffs, trade war, trade deals
  economy      — Payrolls, unemployment, consumer data
  crypto       — BTC/ETH price targets
  election     — Presidential/parliamentary elections
"""
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

import requests
from fastapi import APIRouter, HTTPException, Query

from cache import TTLCache
from db import get_db
from config import MEM_CACHE_TTL, DEFAULT_HTTP_TIMEOUT, POLYMARKET_GAMMA_BASE, GAMMA_POOL_MAX, GAMMA_PAGE_SIZE

router = APIRouter()

_SESSION = requests.Session()
_SESSION.headers.update({
    "User-Agent": "BloombergTerminal/1.0",
    "Accept": "application/json",
})
_TIMEOUT = DEFAULT_HTTP_TIMEOUT
_GAMMA_BASE = POLYMARKET_GAMMA_BASE

# ── In-memory cache ──────────────────────────────────────────────────────────
_pm_cache = TTLCache(ttl=MEM_CACHE_TTL, maxsize=200)
_CACHE_TTL = MEM_CACHE_TTL  # 5 minutes (kept for _market_pool)

# ── Market pool cache (all active markets, 10-min TTL) ───────────────────────
_market_pool: list[dict] = []
_pool_ts: float = 0
_POOL_TTL = 10 * 60

# ═════════════════════════════════════════════════════════════════════════════
# SIGNAL TYPE DEFINITIONS
# Aligned with Polymarket's actual economy category tag structure.
# tag_slugs: tried first via Gamma API ?tag_slug= parameter
# keywords:  fallback full-text match on question + description
# ═════════════════════════════════════════════════════════════════════════════

SIGNAL_TYPES: dict[str, dict] = {
    "fed_rate": {
        "label": "Fed Rate",
        "color": "#85b7eb",
        # Phrase-level keywords — avoids partial matches (e.g. "rate" alone hits unrelated markets)
        "keywords": [
            "fed rate cut", "fed rate hike", "fed rate cuts",
            "FOMC rate", "federal funds rate", "fed funds rate",
            "basis points cut", "basis points hike",
            "fed pause", "rate pause fed",
        ],
    },
    "inflation": {
        "label": "Inflation",
        "color": "#ef9f27",
        "keywords": [
            "inflation rate", "CPI report", "core CPI", "core PCE",
            "consumer price index", "annual inflation",
            "inflation above", "inflation below", "inflation exceed",
        ],
    },
    "recession": {
        "label": "Recession / GDP",
        "color": "#f0a07a",
        "keywords": [
            "US recession", "economic recession", "GDP growth", "GDP contraction",
            "GDP decline", "GDP negative", "soft landing", "hard landing",
            "recession by", "recession in 20",
        ],
    },
    "global_rates": {
        "label": "Global Rates",
        "color": "#97c459",
        "keywords": [
            "ECB rate", "ECB cut", "ECB hike",
            "Bank of England rate", "BOE rate", "BOE cut",
            "Bank of Japan rate", "BOJ rate",
            "RBA rate", "rate cut ECB",
        ],
    },
    "trade": {
        "label": "Trade / Tariffs",
        "color": "#ed93b1",
        "keywords": [
            "tariff", "trade war", "trade deal",
            "import duty", "China tariff", "US tariff",
            "trade policy", "export ban", "trade agreement",
        ],
    },
    "economy": {
        "label": "Economy",
        "color": "#5dcaa5",
        "keywords": [
            "unemployment rate", "nonfarm payrolls", "jobs report",
            "retail sales", "consumer confidence", "housing starts",
            "jobless claims", "ISM manufacturing", "PMI",
        ],
    },
    "crypto": {
        "label": "Crypto",
        "color": "#af91e8",
        "keywords": [
            "bitcoin hit", "bitcoin reach", "bitcoin dip",
            "BTC price", "ETH price", "ethereum hit",
            "bitcoin 100k", "bitcoin 200k", "bitcoin 150k",
            "solana price",
        ],
    },
    "election": {
        "label": "Election",
        "color": "#c084d6",
        "keywords": [
            "presidential election", "win the presidency",
            "win the 2026", "win the 2027", "win the 2028",
            "parliamentary election", "snap election",
            "midterm election", "win the senate", "win the house",
        ],
    },
}


# ═════════════════════════════════════════════════════════════════════════════
# DATABASE — Signal store + Slug registry
# ═════════════════════════════════════════════════════════════════════════════

def _init_polymarket_tables():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pm_slug_registry (
                slug         TEXT NOT NULL,
                signal_type  TEXT NOT NULL,
                question     TEXT NOT NULL,
                condition_id TEXT NOT NULL DEFAULT '',
                token_id     TEXT NOT NULL DEFAULT '',
                volume       REAL NOT NULL DEFAULT 0,
                active       INTEGER NOT NULL DEFAULT 1,
                discovered   TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (slug, signal_type)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pm_signals (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                signal_type  TEXT NOT NULL,
                slug         TEXT NOT NULL,
                question     TEXT NOT NULL,
                probability  REAL NOT NULL,
                volume       REAL NOT NULL DEFAULT 0,
                liquidity    REAL NOT NULL DEFAULT 0,
                outcome      TEXT NOT NULL DEFAULT 'Yes',
                raw_json     TEXT NOT NULL DEFAULT '{}',
                timestamp    TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_pms_type ON pm_signals(signal_type)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_pms_ts   ON pm_signals(timestamp)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_pms_slug ON pm_signals(slug)")

_init_polymarket_tables()


# ═════════════════════════════════════════════════════════════════════════════
# LAYER 1 — MARKET DISCOVERY
# ═════════════════════════════════════════════════════════════════════════════

def _refresh_market_pool() -> list[dict]:
    """
    Fetch active markets from Gamma API (paginated up to 3000). Cached 10 min.

    NOTE: The Gamma API does NOT support server-side filtering by tag/category/keyword.
    All params except limit/offset/active/closed are silently ignored.
    We fetch the full pool and filter client-side.
    """
    global _market_pool, _pool_ts
    if _market_pool and (time.time() - _pool_ts) < _POOL_TTL:
        return _market_pool

    url = f"{_GAMMA_BASE}/markets"
    pool: list[dict] = []
    for offset in range(0, GAMMA_POOL_MAX, GAMMA_PAGE_SIZE):
        try:
            r = _SESSION.get(url, params={
                "limit": GAMMA_PAGE_SIZE, "offset": offset,
                "active": "true", "closed": "false",
            }, timeout=_TIMEOUT)
            if not r.ok:
                break
            batch = r.json()
            if not isinstance(batch, list) or not batch:
                break
            pool.extend(batch)
            if len(batch) < GAMMA_PAGE_SIZE:
                break
        except Exception:
            break

    if pool:
        _market_pool = pool
        _pool_ts = time.time()
    return _market_pool


def _phrase_match(text: str, keywords: list[str]) -> bool:
    """
    Phrase-level containment match (case-insensitive substring).
    Use multi-word phrases to avoid false positives from single words like 'rate' or 'trade'.
    """
    text_lower = text.lower()
    return any(kw.lower() in text_lower for kw in keywords)


def _keyword_search_pool(keywords: list[str], limit: int = 20) -> list[dict]:
    """
    Search the market pool by keyword against question + first 400 chars of description.
    Returns top matches sorted by volume descending, up to `limit`.
    """
    pool = _refresh_market_pool()
    matched: list[dict] = []
    seen: set[str] = set()
    for m in pool:
        slug = m.get("slug", "")
        if not slug or slug in seen:
            continue
        text = m.get("question", "") + " " + m.get("description", "")[:400]
        if _phrase_match(text, keywords):
            seen.add(slug)
            matched.append(m)
    matched.sort(key=lambda m: float(m.get("volume", 0) or 0), reverse=True)
    return matched[:limit]


def _discover_markets_for_signal(signal_type: str) -> list[dict]:
    """
    Discover relevant markets for a signal type via keyword match on the market pool.
    Searches question + first 400 chars of description, sorts by volume descending.
    """
    cfg = SIGNAL_TYPES.get(signal_type)
    if not cfg:
        return []

    pool = _refresh_market_pool()
    keywords = cfg["keywords"]

    matched: list[dict] = []
    seen: set[str] = set()
    for m in pool:
        slug = m.get("slug", "")
        if not slug or slug in seen:
            continue
        text = m.get("question", "") + " " + m.get("description", "")[:400]
        if _phrase_match(text, keywords):
            seen.add(slug)
            matched.append(m)

    matched.sort(key=lambda m: float(m.get("volume", 0) or 0), reverse=True)
    return matched


def _register_slugs(signal_type: str, markets: list[dict]) -> int:
    """Save discovered markets to slug registry. Returns count of upserted rows."""
    count = 0
    with get_db() as conn:
        for m in markets:
            slug = m.get("slug") or m.get("condition_id", "")
            if not slug:
                continue
            try:
                conn.execute("""
                    INSERT INTO pm_slug_registry (slug, signal_type, question, condition_id, token_id, volume)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(slug, signal_type) DO UPDATE SET
                        volume   = excluded.volume,
                        question = excluded.question,
                        active   = 1
                """, (
                    slug, signal_type,
                    m.get("question", "")[:500],
                    m.get("conditionId", m.get("condition_id", "")),
                    _extract_token_id(m),
                    float(m.get("volume", 0) or 0),
                ))
                count += 1
            except Exception:
                pass
    return count


def _extract_token_id(market: dict) -> str:
    """Extract first Yes-outcome token ID from market data."""
    tokens = market.get("tokens", [])
    if tokens and isinstance(tokens, list):
        return str(tokens[0].get("token_id", ""))
    clob = market.get("clobTokenIds")
    if clob:
        if isinstance(clob, str):
            try:
                ids = json.loads(clob)
                return str(ids[0]) if ids else ""
            except Exception:
                return str(clob)
        if isinstance(clob, list) and clob:
            return str(clob[0])
    return ""


# ═════════════════════════════════════════════════════════════════════════════
# LAYER 2 — SIGNAL EXTRACTION
# ═════════════════════════════════════════════════════════════════════════════

def _extract_probability(market: dict) -> float | None:
    """Extract outcomePrices[0] = implied Yes-probability (0–1)."""
    prices = market.get("outcomePrices")
    if prices:
        if isinstance(prices, str):
            try:
                prices = json.loads(prices)
            except Exception:
                pass
        if isinstance(prices, list) and prices:
            try:
                return round(float(prices[0]), 4)
            except (ValueError, TypeError):
                pass

    tokens = market.get("tokens", [])
    if tokens and isinstance(tokens, list):
        price = tokens[0].get("price")
        if price is not None:
            try:
                return round(float(price), 4)
            except (ValueError, TypeError):
                pass

    bid = market.get("bestBid")
    ask = market.get("bestAsk")
    if bid is not None and ask is not None:
        try:
            return round((float(bid) + float(ask)) / 2, 4)
        except (ValueError, TypeError):
            pass

    return None


def _fetch_market_detail(slug: str) -> dict | None:
    """Fetch full market data by exact slug from Gamma API."""
    try:
        r = _SESSION.get(
            f"{_GAMMA_BASE}/markets",
            params={"slug": slug, "limit": 1},
            timeout=_TIMEOUT,
        )
        if r.ok:
            data = r.json()
            if isinstance(data, list) and data:
                return data[0]
    except Exception:
        pass
    return None


def _extract_signal_for_type(signal_type: str) -> dict | None:
    """
    Full pipeline for one signal type:
    1. Discover markets via tag API or keyword fallback
    2. Extract probability from each candidate
    3. Return best market (highest volume) + top-10 list
    4. Store signal + register slugs in DB
    """
    markets = _discover_markets_for_signal(signal_type)
    if not markets:
        return None

    _register_slugs(signal_type, markets)

    desc_by_slug: dict[str, str] = {
        m.get("slug", ""): (m.get("description") or "")[:300]
        for m in markets[:30]
    }
    event_slug_by_slug: dict[str, str] = {
        m.get("slug", ""): (m.get("events") or [{}])[0].get("slug", "")
        for m in markets[:30]
    }

    extracted: list[dict] = []
    for m in markets[:30]:
        prob = _extract_probability(m)
        if prob is not None:
            extracted.append({
                "slug": m.get("slug", ""),
                "question": m.get("question", ""),
                "probability": prob,
                "volume": float(m.get("volume", 0) or 0),
                "liquidity": float(m.get("liquidity", 0) or 0),
                "end_date": m.get("endDate", ""),
            })

    if not extracted:
        return None

    extracted.sort(key=lambda x: x["volume"], reverse=True)
    best = extracted[0]

    _store_signal({**best, "signal_type": signal_type})

    delta     = _get_24h_delta(signal_type, best["probability"])
    classify  = _classify_signal(best["probability"], delta)

    return {
        "signal_type":  signal_type,
        "slug":         best["slug"],
        "event_slug":   event_slug_by_slug.get(best["slug"], ""),
        "question":     best["question"],
        "probability":  best["probability"],
        "volume":       best["volume"],
        "liquidity":    best["liquidity"],
        "description":  desc_by_slug.get(best["slug"], ""),
        "delta_24h":    classify["delta_24h"],
        "direction":    classify["direction"],
        "status":       classify["status"],
        "implied_odds": classify["implied_odds"],
        "regime_flag":  classify["regime_flag"],
        "markets":      extracted[:10],
    }


def _get_24h_delta(signal_type: str, current_prob: float) -> float | None:
    """Compare current probability to the reading closest to 24h ago from DB."""
    try:
        with get_db() as conn:
            row = conn.execute("""
                SELECT probability FROM pm_signals
                WHERE signal_type = ?
                  AND timestamp <= datetime('now', '-23 hours')
                ORDER BY timestamp DESC
                LIMIT 1
            """, (signal_type,)).fetchone()
        if row:
            return round(current_prob - row[0], 4)
    except Exception:
        pass
    return None


def _classify_signal(prob: float, delta: float | None) -> dict:
    """Compute status, direction, implied_odds, regime_flag for a probability."""
    status       = "LIKELY" if prob >= 0.65 else ("UNLIKELY" if prob <= 0.35 else "UNCERTAIN")
    regime_flag  = "HIGH_CONVICTION" if abs(prob - 0.5) >= 0.30 else "UNCERTAIN"
    implied_odds = round(1 / prob, 2) if prob > 0 else None
    if delta is None:
        direction = "STABLE"
    elif delta > 0.02:
        direction = "UP"
    elif delta < -0.02:
        direction = "DOWN"
    else:
        direction = "STABLE"
    return {
        "status":       status,
        "direction":    direction,
        "implied_odds": implied_odds,
        "regime_flag":  regime_flag,
        "delta_24h":    delta,
    }


def _store_signal(signal: dict) -> None:
    with get_db() as conn:
        conn.execute("""
            INSERT INTO pm_signals (signal_type, slug, question, probability, volume, liquidity, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            signal["signal_type"],
            signal["slug"],
            signal.get("question", "")[:500],
            signal["probability"],
            signal.get("volume", 0),
            signal.get("liquidity", 0),
            datetime.now(timezone.utc).isoformat(),
        ))


def _extract_all_signals() -> list[dict]:
    """Extract signals for all signal types concurrently."""
    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = {
            st: pool.submit(_extract_signal_for_type, st)
            for st in SIGNAL_TYPES
        }
        for st, fut in futs.items():
            try:
                data = fut.result(timeout=30)
                if data:
                    cfg = SIGNAL_TYPES[st]
                    data["label"] = cfg["label"]
                    data["color"] = cfg["color"]
                    results.append(data)
            except Exception:
                pass
    # Stable order: follow SIGNAL_TYPES key order
    order = list(SIGNAL_TYPES.keys())
    results.sort(key=lambda d: order.index(d["signal_type"]) if d["signal_type"] in order else 99)
    return results


# ═════════════════════════════════════════════════════════════════════════════
# API ENDPOINTS
# ═════════════════════════════════════════════════════════════════════════════

@router.get("/api/polymarket/signals")
def get_all_signals():
    """
    Extract current signals for all 8 types.
    Primary discovery via Polymarket's own tag categories, keyword fallback.
    Cached 5 minutes.
    """
    cached = _pm_cache.get("signals")
    if cached is not None:
        return cached

    signals = _extract_all_signals()
    result = {
        "signals": signals,
        "count": len(signals),
        "signal_types": {
            k: {"label": v["label"], "color": v["color"]}
            for k, v in SIGNAL_TYPES.items()
        },
        "as_of": datetime.now(timezone.utc).isoformat(),
    }
    _pm_cache.set("signals", result)
    return result


@router.get("/api/polymarket/signals/{signal_type}")
def get_signal(signal_type: str):
    """Extract signal for one specific type."""
    if signal_type not in SIGNAL_TYPES:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown signal type '{signal_type}'. Valid: {list(SIGNAL_TYPES.keys())}",
        )

    cache_key = f"signal:{signal_type}"
    cached = _pm_cache.get(cache_key)
    if cached is not None:
        return cached

    data = _extract_signal_for_type(signal_type)
    if not data:
        raise HTTPException(status_code=503, detail=f"No market data for '{signal_type}'")

    cfg = SIGNAL_TYPES[signal_type]
    data["label"] = cfg["label"]
    data["color"] = cfg["color"]
    _pm_cache.set(cache_key, data)
    return data


@router.get("/api/polymarket/search")
def search_markets(q: str = Query(..., min_length=2)):
    """
    Search Polymarket markets by keyword against the market pool.
    Returns top 20 results sorted by volume.
    """
    cache_key = f"search:{q.lower()}"
    cached = _pm_cache.get(cache_key)
    if cached is not None:
        return cached

    # Search pool by question + description text
    markets = _keyword_search_pool([q], limit=20)
    results = []
    for m in markets:
        prob = _extract_probability(m)
        events = m.get("events") or []
        event_slug = events[0].get("slug", "") if events else ""
        results.append({
            "slug": m.get("slug", ""),
            "event_slug": event_slug,
            "question": m.get("question", ""),
            "probability": prob,
            "volume": float(m.get("volume", 0) or 0),
            "liquidity": float(m.get("liquidity", 0) or 0),
            "end_date": m.get("endDate", ""),
            "active": m.get("active", True),
            "image": m.get("image", ""),
        })

    data = {"query": q, "results": results, "count": len(results)}
    _pm_cache.set(cache_key, data)
    return data



@router.get("/api/polymarket/market/{slug}")
def get_market_detail(slug: str):
    """Get full market details by exact slug."""
    market = _fetch_market_detail(slug)
    if not market:
        raise HTTPException(status_code=404, detail=f"Market '{slug}' not found")
    prob = _extract_probability(market)
    return {
        "slug": slug,
        "question": market.get("question", ""),
        "description": market.get("description", "")[:1000],
        "probability": prob,
        "volume": float(market.get("volume", 0) or 0),
        "liquidity": float(market.get("liquidity", 0) or 0),
        "end_date": market.get("endDate", ""),
        "active": market.get("active", True),
        "outcomes": market.get("outcomes", []),
        "outcomePrices": market.get("outcomePrices", []),
        "tokens": market.get("tokens", []),
        "image": market.get("image", ""),
    }


@router.get("/api/polymarket/discover/{signal_type}")
def discover_signal_markets(signal_type: str):
    """
    Discover and register markets for a signal type.
    Shows what the tag-based + keyword search finds.
    """
    if signal_type not in SIGNAL_TYPES:
        raise HTTPException(status_code=404, detail=f"Unknown signal type: {signal_type}")

    markets = _discover_markets_for_signal(signal_type)
    count = _register_slugs(signal_type, markets)

    results = []
    for m in markets[:30]:
        prob = _extract_probability(m)
        results.append({
            "slug": m.get("slug", ""),
            "question": m.get("question", ""),
            "probability": prob,
            "volume": float(m.get("volume", 0) or 0),
        })

    cfg = SIGNAL_TYPES[signal_type]
    return {
        "signal_type": signal_type,
        "label": cfg["label"],
        "keywords": cfg["keywords"],
        "discovered": len(markets),
        "registered": count,
        "markets": results,
    }


@router.get("/api/polymarket/registry")
def get_slug_registry(signal_type: str = Query(default="")):
    """List all registered slugs, optionally filtered by signal type."""
    with get_db() as conn:
        if signal_type:
            rows = conn.execute("""
                SELECT * FROM pm_slug_registry
                WHERE signal_type = ? AND active = 1
                ORDER BY volume DESC
            """, (signal_type,)).fetchall()
        else:
            rows = conn.execute("""
                SELECT * FROM pm_slug_registry
                WHERE active = 1
                ORDER BY signal_type, volume DESC
            """).fetchall()
    return {"slugs": [dict(r) for r in rows], "count": len(rows)}


@router.get("/api/polymarket/history")
def get_signal_history(
    signal_type: str = Query(default=""),
    limit: int = Query(default=100, ge=1, le=1000),
):
    """Get historical signal readings for time series analysis."""
    with get_db() as conn:
        if signal_type:
            rows = conn.execute("""
                SELECT signal_type, slug, question, probability, volume, liquidity, timestamp
                FROM pm_signals
                WHERE signal_type = ?
                ORDER BY timestamp DESC LIMIT ?
            """, (signal_type, limit)).fetchall()
        else:
            rows = conn.execute("""
                SELECT signal_type, slug, question, probability, volume, liquidity, timestamp
                FROM pm_signals
                ORDER BY timestamp DESC LIMIT ?
            """, (limit,)).fetchall()
    return {"history": [dict(r) for r in rows], "count": len(rows)}


@router.get("/api/polymarket/latest")
def get_latest_signals():
    """Get the most recent stored signal for each type (fast DB read, no live fetch)."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT s.signal_type, s.slug, s.question, s.probability,
                   s.volume, s.liquidity, s.timestamp
            FROM pm_signals s
            INNER JOIN (
                SELECT signal_type, MAX(timestamp) as max_ts
                FROM pm_signals GROUP BY signal_type
            ) latest ON s.signal_type = latest.signal_type AND s.timestamp = latest.max_ts
            ORDER BY s.signal_type
        """).fetchall()

    signals = {}
    for r in rows:
        st = r["signal_type"]
        cfg = SIGNAL_TYPES.get(st, {})
        signals[st] = {
            **dict(r),
            "label": cfg.get("label", st),
            "color": cfg.get("color", "#888"),
        }
    return {"signals": signals, "count": len(signals), "as_of": datetime.now(timezone.utc).isoformat()}


@router.post("/api/polymarket/refresh")
def refresh_all_signals():
    """Force refresh all signals (bypass cache)."""
    _pm_cache.clear()
    signals = _extract_all_signals()
    result = {
        "signals": signals,
        "count": len(signals),
        "refreshed": True,
        "as_of": datetime.now(timezone.utc).isoformat(),
    }
    _pm_cache.set("signals", result)
    return result


@router.delete("/api/polymarket/cache")
def clear_polymarket_cache():
    """Clear in-memory cache (signals + pool)."""
    global _market_pool, _pool_ts
    _pm_cache.clear()
    _market_pool = []
    _pool_ts = 0
    return {"cleared": True}


@router.get("/api/polymarket/types")
def get_signal_types():
    """List all signal types with their keywords."""
    return {
        "types": {
            k: {
                "label": v["label"],
                "color": v["color"],
                "keywords": v["keywords"],
            }
            for k, v in SIGNAL_TYPES.items()
        },
    }


@router.get("/api/polymarket/mcp")
def get_mcp_signals():
    """
    Structured signal output optimised for LLM / MCP agent consumption.
    Each signal includes probability, status, direction, implied_odds,
    regime_flag, and 24h delta — ready for tool-call or RAG injection.
    Cached 5 minutes (shared with /signals).
    """
    cached = _pm_cache.get("signals")
    signals: list[dict] = cached["signals"] if cached else _extract_all_signals()

    mcp_signals = []
    for s in signals:
        cfg = SIGNAL_TYPES.get(s["signal_type"], {})
        prob  = s["probability"]
        delta = s.get("delta_24h")
        cl    = _classify_signal(prob, delta)
        mcp_signals.append({
            "signal_type":  s["signal_type"],
            "label":        cfg.get("label", s["signal_type"]),
            "question":     s["question"],
            "probability":  prob,
            "probability_pct": round(prob * 100, 1),
            "status":       s.get("status",       cl["status"]),
            "direction":    s.get("direction",     cl["direction"]),
            "implied_odds": s.get("implied_odds",  cl["implied_odds"]),
            "regime_flag":  s.get("regime_flag",   cl["regime_flag"]),
            "delta_24h":    delta,
            "delta_24h_pct": round(delta * 100, 2) if delta is not None else None,
            "volume_usd":   round(s["volume"], 2),
            "liquidity_usd": round(s["liquidity"], 2),
            "end_date":     s.get("end_date", ""),
            "url":          f"https://polymarket.com/event/{s.get('event_slug') or s['slug']}",
        })

    return {
        "as_of":   datetime.now(timezone.utc).isoformat(),
        "count":   len(mcp_signals),
        "signals": mcp_signals,
        "schema": {
            "probability":    "0.0–1.0 implied YES probability",
            "status":         "LIKELY (≥65%) | UNCERTAIN | UNLIKELY (≤35%)",
            "direction":      "UP | DOWN | STABLE vs 24h ago (threshold ±2pp)",
            "implied_odds":   "decimal odds = 1/probability",
            "regime_flag":    "HIGH_CONVICTION (|p-0.5|≥0.30) | UNCERTAIN",
            "delta_24h":      "change in probability vs ~24h ago (null if no history)",
            "delta_24h_pct":  "delta expressed in percentage points",
        },
    }
