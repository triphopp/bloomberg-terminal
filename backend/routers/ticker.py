"""
Bloomberg-style market crawl endpoint.

GET /api/ticker?account_id=all
Returns curated market data (indices, FX, commodities) + active alerts
for the bottom scrolling ticker strip.

All data reused from existing caches — zero extra yfinance calls.
"""
from __future__ import annotations

import atexit
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Query

from cache import TTLCache

router = APIRouter(prefix="/api/ticker", tags=["ticker"])

# ── Cache policy ──────────────────────────────────────────────────────────────
# Two ages, not one. FRESH_TTL is how long a payload is served with no work at
# all; STALE_TTL is how long a payload that was once good keeps being served
# WHILE a background thread refreshes it. Between the two, the crawl shows real
# numbers a minute or two old instead of "MARKET DATA LOADING..." — it is
# ambient context, and a slightly late S&P print beats an empty bar.
#
# FRESH_TTL sits deliberately UNDER the frontend's 60s poll. At 60 it matched
# the poll exactly, and matched CACHE_TTL on the market and heatmap caches too,
# so an entry expired at the instant the next request arrived and nearly every
# poll paid the full cold path (measured: 23.5s cold vs 0.21s warm).
FRESH_TTL = 45
STALE_TTL = 900  # 15 min — past this, a payload is too old to show at all

# A refresh that returned nothing is retried on this cadence rather than on
# every request, so an upstream 429 does not turn into a stampede.
REFRESH_MIN_INTERVAL = 15

# Entries are (fetched_at_monotonic, payload). The timestamp lives in the value
# because TTLCache.get() DELETES anything past the ttl it is handed — asking it
# for a 45s view first would evict the 60s-old payload we still want to serve.
_cache = TTLCache(ttl=STALE_TTL, maxsize=32)

_refresh_lock = threading.Lock()
_inflight: set[str] = set()
_last_attempt: dict[str, float] = {}
_build_locks: dict[str, threading.Lock] = {}

# Set once the process is on its way out. Every background thread here is a
# daemon, so the interpreter will not wait for it — and a daemon caught part-way
# through building a ThreadPoolExecutor during shutdown does not fail politely:
# Python raises "cannot schedule new futures after interpreter shutdown" and the
# process aborts with a core dump (seen in CI, after the whole suite had passed).
# So: refuse to start new work once this is set, and give whatever is already
# running a moment to unwind.
_stopping = threading.Event()
_threads: set[threading.Thread] = set()


def _shutdown() -> None:
    _stopping.set()
    with _refresh_lock:
        live = [t for t in _threads if t.is_alive()]
    for t in live:
        t.join(timeout=2)


atexit.register(_shutdown)


def _start(target, name: str) -> None:
    """Start a tracked daemon thread, unless the process is already stopping."""
    if _stopping.is_set():
        return
    thread = threading.Thread(target=target, name=name, daemon=True)
    with _refresh_lock:
        _threads.add(thread)
    thread.start()


def _build_lock_for(key: str) -> threading.Lock:
    """One build lock per key, so N readers arriving on a cold process wait on
    the single build instead of each starting their own fan-out."""
    with _refresh_lock:
        lock = _build_locks.get(key)
        if lock is None:
            lock = _build_locks[key] = threading.Lock()
        return lock

# ── Curated symbol → Bloomberg-style label maps ────────────────────────────

_IDX_MAP: dict[str, str] = {
    "S&P 500":      "SPX",
    "NASDAQ":       "NDX",
    "Dow Jones":    "INDU",
    "Russell 2000": "RUT",
    "Nikkei 225":   "NKY",
    "Hang Seng":    "HSI",
    "SET":          "SET",
    "KOSPI":        "KOSPI",
    "DAX":          "DAX",
    "FTSE 100":     "UKX",
    "CAC 40":       "CAC",
}

_COMM_MAP: dict[str, str] = {
    "Gold":        "XAU",
    "WTI Crude":   "WTI",
    "WTI Oil":     "WTI",
    "Brent Crude": "BRT",
    "Silver":      "XAG",
    "Copper":      "HG",
    "Natural Gas": "NG",
}

_IND_MAP: dict[str, str] = {
    "VIX": "VIX",
}

# VIX prominence levels (for frontend pill coloring)
def _vix_level(vix: float | None) -> str:
    if vix is None: return "normal"
    if vix >= 30:   return "extreme"
    if vix >= 25:   return "high"
    if vix >= 20:   return "elevated"
    if vix >= 15:   return "normal"
    return "low"

_FX_MAP: dict[str, str] = {
    "EURUSD=X": "EUR/USD",
    "USDJPY=X": "USD/JPY",
    "GBPUSD=X": "GBP/USD",
    "USDTHB=X": "USD/THB",
    "USDCNH=X": "USD/CNH",
    "AUDUSD=X": "AUD/USD",
}

# Display order for index items (keys = Bloomberg label, lower = earlier)
_IDX_ORDER = ["SPX", "NDX", "INDU", "RUT", "VIX", "NKY", "HSI", "SET", "KOSPI", "DAX", "UKX", "CAC"]
_COMM_ORDER = ["XAU", "BRT", "WTI", "XAG", "HG", "NG"]
_FX_ORDER = ["EUR/USD", "USD/JPY", "GBP/USD", "USD/THB", "USD/CNH", "AUD/USD"]


def _rank(label: str, order: list[str]) -> int:
    try:
        return order.index(label)
    except ValueError:
        return 999


# ── Data fetchers (all reuse existing module caches) ─────────────────────────

def _fetch_indices() -> list[dict]:
    try:
        from routers.market import get_market_data
        mkt = get_market_data()
        all_items = (
            mkt.get("americas", []) +
            mkt.get("emea", []) +
            mkt.get("asiaPacific", [])
        )
        out = []
        for i in all_items:
            lbl = _IDX_MAP.get(i.get("id", ""))
            if lbl:
                out.append({
                    "label": lbl,
                    "value": i.get("value"),
                    "change": i.get("change"),
                    "pct":   i.get("pctChange"),
                    "type":  "index",
                    "_rank": _rank(lbl, _IDX_ORDER),
                })
        return sorted(out, key=lambda x: x["_rank"])
    except Exception as e:
        print(f"[ticker] indices error: {e}")
        return []


def _fetch_commodities_and_vix() -> list[dict]:
    out = []
    try:
        from routers.market import get_heatmap
        for grp, mapping, order in [
            ("indicators",  _IND_MAP,  _IDX_ORDER),
            ("commodities", _COMM_MAP, _COMM_ORDER),
        ]:
            try:
                hm = get_heatmap(group=grp)
                for tile in hm.get("tiles", []):
                    lbl = mapping.get(tile.get("id", ""))
                    if lbl:
                        item: dict = {
                            "label": lbl,
                            "value": tile.get("value"),
                            "change": tile.get("change"),
                            "pct":   tile.get("pctChange"),
                            "type":  "indicator" if grp == "indicators" else "commodity",
                            "_rank": _rank(lbl, order),
                        }
                        # Tag VIX with prominence level for frontend pill rendering
                        if lbl == "VIX":
                            item["vix_level"] = _vix_level(tile.get("value"))
                        out.append(item)
            except Exception as e:
                print(f"[ticker] heatmap {grp} error: {e}")
    except Exception as e:
        print(f"[ticker] heatmap import error: {e}")

    # VIX first, then commodities ordered
    vix = [x for x in out if x["label"] == "VIX"]
    comm = sorted([x for x in out if x["label"] != "VIX"], key=lambda x: x["_rank"])
    return vix + comm


def _fetch_fx() -> list[dict]:
    try:
        from routers.fx import fx_overview
        fx = fx_overview()
        out = []
        for p in fx.get("pairs", []):
            lbl = _FX_MAP.get(p.get("symbol", ""))
            if lbl:
                out.append({
                    "label": lbl,
                    "value": p.get("price"),
                    "change": p.get("change"),
                    "pct":   p.get("pctChange"),
                    "type":  "fx",
                    "_rank": _rank(lbl, _FX_ORDER),
                })
        return sorted(out, key=lambda x: x["_rank"])
    except Exception as e:
        print(f"[ticker] fx error: {e}")
        return []


def _fetch_fear_greed() -> dict | None:
    """Current Fear & Greed value — shown as prominent pill like Regime."""
    try:
        from routers.fear_greed import get_current
        fg = get_current()
        if fg is None or fg.get("value") is None:
            return None
        return {
            "label": "FEAR-GREED",
            "value": fg["value"],
            "change": None,
            "pct":    None,
            "type":   "fear_greed",
            "fear_greed_value": fg["value"],
            "fear_greed_zone":  fg.get("zone", "neutral"),
            "fear_greed_label": fg.get("label", "NEUTRAL"),
        }
    except Exception as e:
        print(f"[ticker] fear-greed error: {e}")
        return None


def _fetch_regime() -> dict | None:
    """Current CORR regime label — always shown in ticker."""
    try:
        from routers.regime import get_calibrated
        result = get_calibrated(period="3m")
        corr = result.get("corr", {})
        label = corr.get("label")
        score = corr.get("score")
        if not label:
            return None
        return {
            "label": "REGIME",
            "value": None,
            "change": None,
            "pct":   None,
            "type":  "regime",
            "regime_label": label,
            "regime_score": round(score, 3) if score is not None else None,
        }
    except Exception as e:
        print(f"[ticker] regime error: {e}")
        return None


def _fetch_alerts(account_id: str) -> list[dict]:
    alerts: list[dict] = []
    try:
        from routers.alerts import check_regime_change, _get_stoploss_breaches, _get_active_regime_alerts
        check_regime_change()
        alerts = _get_stoploss_breaches(account_id) + _get_active_regime_alerts()
    except Exception as e:
        print(f"[ticker] alerts error: {e}")

    # DCC correlation spike alerts (from tail-risk cache — no circular dependency,
    # tail-risk never calls /api/ticker in its DCC path)
    try:
        from routers.tail_risk import get_cached_dcc_signals
        _DCC_RANK = {"NORMAL": 0, "CAUTION": 1, "SPIKE": 2, "EXTREME": 3}
        v1, v3 = get_cached_dcc_signals()
        max_rank = max(_DCC_RANK.get(v1, 0), _DCC_RANK.get(v3, 0))
        if max_rank >= 2:  # SPIKE or EXTREME
            alerts.append({
                "type":     "dcc",
                "severity": "critical" if max_rank >= 3 else "warning",
                "symbol":   None,
                "message":  f"V1:{v1} HMM:{v3}",
                "persistent": True,
            })
    except Exception as e:
        print(f"[ticker] DCC alert error: {e}")

    return alerts


# ── Build ─────────────────────────────────────────────────────────────────────

def _build_ticker(account_id: str) -> tuple[dict, bool]:
    """Assemble one ticker payload. Returns (payload, degraded).

    The six fetchers are independent and every one of them is network-bound on a
    cold cache, so they run concurrently — serially they summed to the 23.5s a
    user saw as "MARKET DATA LOADING...". Each already swallows its own errors
    and returns empty; the try here only covers something escaping that.

    `degraded` means not one market row came back (indices, commodities/VIX and
    FX all empty) — an upstream failure, not a quiet market. The caller uses it
    to avoid overwriting a good payload with an empty one.
    """
    jobs = {
        "indices":    _fetch_indices,
        "comms_vix":  _fetch_commodities_and_vix,
        "fx":         _fetch_fx,
        "regime":     _fetch_regime,
        "fear_greed": _fetch_fear_greed,
        "alerts":     lambda: _fetch_alerts(account_id),
    }
    out: dict[str, object] = {}
    if _stopping.is_set():
        return {
            "items": [], "alerts": [], "has_critical": False,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "stale": False, "degraded": True,
        }, True
    with ThreadPoolExecutor(max_workers=len(jobs), thread_name_prefix="ticker") as pool:
        futures = {name: pool.submit(fn) for name, fn in jobs.items()}
        for name, fut in futures.items():
            try:
                out[name] = fut.result()
            except Exception as e:  # a fetcher's own except should have caught this
                print(f"[ticker] {name} fetcher raised: {e}")
                out[name] = None

    indices    = out.get("indices") or []
    comms_vix  = out.get("comms_vix") or []
    fx         = out.get("fx") or []
    regime     = out.get("regime")
    fear_greed = out.get("fear_greed")
    alerts     = out.get("alerts") or []

    # Order: SPX NDX INDU VIX | XAU WTI | EUR/USD USD/JPY ... | REGIME | FEAR-GREED
    items = list(indices) + list(comms_vix) + list(fx)
    degraded = not items
    if regime:
        items.append(regime)
    if fear_greed:
        items.append(fear_greed)

    # Strip internal _rank key before returning
    for item in items:
        item.pop("_rank", None)

    payload = {
        "items":        items,
        "alerts":       alerts,
        "has_critical": any(a["severity"] == "critical" for a in alerts),
        "timestamp":    datetime.now(timezone.utc).isoformat(),
        "stale":        False,
        "degraded":     degraded,
    }
    return payload, degraded


def _build_and_store(key: str, account_id: str) -> dict:
    """Build, then keep the result only if it is worth keeping.

    A degraded payload never replaces a payload that still has market rows in
    it. Caching the empty one was what made a single upstream 429 blank the
    crawl for a full minute: the empty result was stored like any other and
    every reader for the next 60s got it back.
    """
    payload, degraded = _build_ticker(account_id)
    if degraded:
        prev = _cache.get(key)
        if prev is not None:
            return {**prev[1], "stale": True}
    _cache.set(key, (time.monotonic(), payload))
    return payload


def _spawn_refresh(key: str, account_id: str) -> None:
    """Refresh in the background, at most one thread per key."""
    now = time.monotonic()
    with _refresh_lock:
        if key in _inflight:
            return
        if now - _last_attempt.get(key, float("-inf")) < REFRESH_MIN_INTERVAL:
            return
        _inflight.add(key)
        _last_attempt[key] = now

    def run() -> None:
        try:
            _build_and_store(key, account_id)
        except Exception as e:
            print(f"[ticker] background refresh failed: {e}")
        finally:
            with _refresh_lock:
                _inflight.discard(key)
                _threads.discard(threading.current_thread())

    _start(run, f"ticker-refresh-{account_id}")


def prewarm(account_id: str = "all") -> None:
    """Fill the ticker cache — and, through it, the market, heatmap and FX
    caches every other view reads — on a worker thread at startup.

    Nothing warmed these before: startup warmed the regime model, the BC
    calibration, the alert scan and the IV recorder, so the FIRST request for
    any of them paid the whole cold fan-out while the user watched an empty bar.
    """
    key = f"ticker:{account_id}"

    def run() -> None:
        try:
            t0 = time.monotonic()
            # Through the same build lock as a cold request, so a user who opens
            # the terminal mid-prewarm waits on this build and gets its result
            # instead of racing it with a second full fan-out of their own.
            with _build_lock_for(key):
                if _cache.get(key) is None:
                    _build_and_store(key, account_id)
            print(f"[ticker] prewarm done in {time.monotonic() - t0:.1f}s")
        except Exception as e:
            print(f"[ticker] prewarm failed: {e}")
        finally:
            with _refresh_lock:
                _threads.discard(threading.current_thread())

    _start(run, "ticker-prewarm")


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.get("")
def get_ticker(account_id: str = Query("all")):
    """
    Bloomberg crawl data: indices + VIX + commodities + FX + active alerts.

    Stale-while-revalidate: a payload older than FRESH_TTL is still returned
    (flagged `stale`) while a background thread refreshes it, so the bar only
    ever goes empty on the very first request of a cold process.
    """
    key = f"ticker:{account_id}"

    entry = _cache.get(key)  # STALE_TTL view — see the _cache comment above
    if entry is not None:
        fetched_at, payload = entry
        if time.monotonic() - fetched_at < FRESH_TTL:
            return payload
        _spawn_refresh(key, account_id)
        return {**payload, "stale": True}

    # Cold process, or nothing good for STALE_TTL. Build inline — there is
    # nothing to serve in the meantime — but only one caller does the work.
    with _build_lock_for(key):
        entry = _cache.get(key)
        if entry is not None:
            return entry[1]  # another thread built it while we waited
        return _build_and_store(key, account_id)
