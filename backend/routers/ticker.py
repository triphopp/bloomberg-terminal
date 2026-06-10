"""
Bloomberg-style market crawl endpoint.

GET /api/ticker?account_id=all
Returns curated market data (indices, FX, commodities) + active alerts
for the bottom scrolling ticker strip.

All data reused from existing caches — zero extra yfinance calls.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Query

from cache import TTLCache

router = APIRouter(prefix="/api/ticker", tags=["ticker"])
_cache = TTLCache(ttl=60)

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


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.get("")
def get_ticker(account_id: str = Query("all")):
    """
    Bloomberg crawl data: indices + VIX + commodities + FX + active alerts.
    All data served from existing 60s caches — no extra yfinance requests.
    """
    cache_key = f"ticker:{account_id}"
    cached = _cache.get(cache_key)
    if cached:
        return cached

    indices     = _fetch_indices()
    comms_vix   = _fetch_commodities_and_vix()
    fx          = _fetch_fx()
    regime      = _fetch_regime()
    fear_greed  = _fetch_fear_greed()
    al          = _fetch_alerts(account_id)

    # Order: SPX NDX INDU VIX | XAU WTI | EUR/USD USD/JPY ... | REGIME | FEAR-GREED
    items = indices + comms_vix + fx
    if regime:
        items.append(regime)
    if fear_greed:
        items.append(fear_greed)

    # Strip internal _rank key before returning
    for item in items:
        item.pop("_rank", None)

    result = {
        "items":        items,
        "alerts":       al,
        "has_critical": any(a["severity"] == "critical" for a in al),
        "timestamp":    datetime.now(timezone.utc).isoformat(),
    }
    _cache.set(cache_key, result)
    return result
