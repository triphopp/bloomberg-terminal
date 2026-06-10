"""
Bank of Thailand (BOT) API router.
Auth: static token in Authorization header (no Bearer prefix) — IBM API Connect format.
"""
import json
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import requests
from fastapi import APIRouter, HTTPException, Query

from config import BOT_API_TOKEN, BOT_IR_TOKEN, BOT_FX_TOKEN, BOT_STATS_TOKEN, BOT_BASE_URL, MEM_CACHE_TTL, DEFAULT_HTTP_TIMEOUT

router = APIRouter()

# ── Cache ─────────────────────────────────────────────────────────────────────
_BOT_CACHE_FILE = Path(__file__).parent.parent / "bot_cache.json"
_mem: dict[str, Any] = {}
_MEM_TTL  = MEM_CACHE_TTL        # 5 min in-memory
_DISK_TTL = 60 * 60       # 1 hr disk (auction data changes only on auction days)
_BOT_MAX_DAYS = 30        # BOT API limit is 31 days; default to 30 for safety

_SESSION = requests.Session()
_SESSION.headers.update({
    "Accept": "application/json",
    "Authorization": BOT_API_TOKEN,   # raw token, no "Bearer" prefix
})
_TIMEOUT = DEFAULT_HTTP_TIMEOUT


def _load_cache() -> dict:
    try:
        if _BOT_CACHE_FILE.exists():
            return json.loads(_BOT_CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def _save_cache(cache: dict) -> None:
    try:
        _BOT_CACHE_FILE.write_text(
            json.dumps(cache, separators=(",", ":")), encoding="utf-8"
        )
    except Exception:
        pass


def _is_fresh(entry: dict | None, ttl: int = _DISK_TTL) -> bool:
    return bool(entry and time.time() - entry.get("ts", 0) < ttl)


# ── Fetcher ───────────────────────────────────────────────────────────────────

def _fetch_bond_auctions(start_period: str, end_period: str) -> dict:
    """Fetch bond auction results from BOT API.
    BOT limit: max 31 days per request. Date format: yyyy-mm-dd.
    """
    if not BOT_API_TOKEN:
        raise HTTPException(status_code=503, detail="BOT_API_TOKEN not configured")

    url = f"{BOT_BASE_URL}/BondAuction/bond_auction_v2/"
    try:
        r = _SESSION.get(url, params={"start_period": start_period, "end_period": end_period}, timeout=_TIMEOUT)
        if not r.ok:
            raise HTTPException(status_code=r.status_code, detail=f"BOT API error: {r.text[:200]}")
        body = r.json()
        result = body.get("result", body)
        if str(result.get("success", "true")).lower() == "false":
            errors = result.get("error", [])
            msg = "; ".join(e.get("message", "") for e in errors) if errors else "BOT API error"
            raise HTTPException(status_code=400, detail=msg)
        return body
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"BOT API unreachable: {str(e)}")


def _parse_auctions(raw: dict) -> list[dict]:
    """Normalise BOT bond auction response into a clean list.
    BOT structure: raw['result']['data']['data_detail'] = list of records.
    """
    try:
        records = raw["result"]["data"]["data_detail"]
    except (KeyError, TypeError):
        records = []

    cleaned = []
    for r in records:
        if not isinstance(r, dict):
            continue
        cleaned.append({
            "auction_date":      r.get("auction_date"),
            "payment_date":      r.get("payment_date"),
            "instrument_type":   r.get("debt_securities_type"),
            "series":            r.get("thaibma_symbol"),
            "isin_code":         r.get("isin_code"),
            "name_th":           r.get("auction_nm_th"),
            "coupon_rate":       _to_float(r.get("coupon_rate")),
            "time_to_maturity":  r.get("time_to_maturity"),
            "maturity_date":     r.get("maturity_date"),
            "offered_amount":    _to_float(r.get("issue_amount_ncb_cb")),
            "accepted_amount":   _to_float(r.get("accepted_amount_ncb_cb") or r.get("grand_total_amount")),
            "low_yield":         _to_float(r.get("accepted_lowest_yield")),
            "high_yield":        _to_float(r.get("accepted_highest_yield")),
            "avg_yield":         _to_float(r.get("weighted_average_accepted_yield")),
            "bid_cover_ratio":   _to_float(r.get("bid_coverage_ratio")),
            "status":            r.get("auction_st"),
        })
    return cleaned


def _to_float(val: Any) -> float | None:
    try:
        return round(float(val), 6) if val is not None and val != "" else None
    except (TypeError, ValueError):
        return None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/api/bot/auctions")
def get_bond_auctions(
    start_period: str = Query(default="", description="Start date yyyy-mm-dd (default: 30 days ago)"),
    end_period:   str = Query(default="", description="End date yyyy-mm-dd (default: today). Max range: 31 days"),
    raw:          bool = Query(default=False, description="Return raw BOT response for debugging"),
):
    """
    Bond auction results from Bank of Thailand.
    Includes government bonds, T-bills, BOT bonds with yield, bid-cover ratio.
    BOT API limit: max 31 days per request.
    """
    from datetime import timedelta
    today = datetime.utcnow().date()
    if not end_period:
        end_period = today.strftime("%Y-%m-%d")
    if not start_period:
        start_period = (today - timedelta(days=_BOT_MAX_DAYS)).strftime("%Y-%m-%d")

    cache_key = f"auctions:{start_period}:{end_period}"

    # Memory cache
    mem = _mem.get(cache_key)
    if mem and time.time() - _mem.get(f"{cache_key}:ts", 0) < _MEM_TTL:
        return mem

    # Disk cache
    cache = _load_cache()
    entry = cache.get(cache_key)
    if _is_fresh(entry):
        result = entry["data"]
        _mem[cache_key] = result
        _mem[f"{cache_key}:ts"] = time.time()
        return result

    # Fetch from BOT
    raw_data = _fetch_bond_auctions(start_period, end_period)

    if raw:
        return {"raw": raw_data}

    auctions = _parse_auctions(raw_data)

    # Sort newest first
    auctions.sort(key=lambda x: x.get("auction_date") or "", reverse=True)

    result = {
        "auctions": auctions,
        "count": len(auctions),
        "start_period": start_period,
        "end_period": end_period,
        "as_of": datetime.utcnow().isoformat() + "Z",
        "_raw_structure": list(raw_data.keys()) if isinstance(raw_data, dict) else type(raw_data).__name__,
    }

    # Save caches
    cache[cache_key] = {"ts": time.time(), "data": result}
    _save_cache(cache)
    _mem[cache_key] = result
    _mem[f"{cache_key}:ts"] = time.time()

    return result


@router.get("/api/bot/auctions/raw")
def get_bond_auctions_raw(
    start_period: str = Query(default="2024"),
    end_period:   str = Query(default="2025"),
):
    """Return raw BOT API response — useful for inspecting field names."""
    return _fetch_bond_auctions(start_period, end_period)


# ═════════════════════════════════════════════════════════════════════════════
# INTEREST RATES
# ═════════════════════════════════════════════════════════════════════════════

_IR_SESSION = requests.Session()
_IR_SESSION.headers.update({"Accept": "application/json", "Authorization": BOT_IR_TOKEN})

_FX_SESSION = requests.Session()
_FX_SESSION.headers.update({"Accept": "application/json", "Authorization": BOT_FX_TOKEN})

_IR_TTL = 4 * 3600   # 4 hr — daily data
_FX_TTL = 4 * 3600


def _bot_get(session: requests.Session, path: str, params: dict | None = None) -> dict:
    """Generic BOT GET. Raises HTTPException on API-level error."""
    try:
        r = session.get(f"{BOT_BASE_URL}{path}", params=params or {}, timeout=_TIMEOUT)
        if not r.ok:
            raise HTTPException(status_code=r.status_code, detail=f"BOT API {r.status_code}: {r.text[:200]}")
        body = r.json()
        result = body.get("result", body)
        if str(result.get("success", "true")).lower() == "false":
            errors = result.get("error", [])
            msg = "; ".join(e.get("message", "") for e in errors) if errors else "BOT API error"
            raise HTTPException(status_code=400, detail=msg)
        return body
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))


def _cached(cache_key: str, ttl: int, fetcher):
    """Cache-aside helper: memory → disk → fetcher."""
    mem = _mem.get(cache_key)
    if mem and time.time() - _mem.get(f"{cache_key}:ts", 0) < _MEM_TTL:
        return mem
    cache = _load_cache()
    entry = cache.get(cache_key)
    if _is_fresh(entry, ttl):
        result = entry["data"]
        _mem[cache_key] = result
        _mem[f"{cache_key}:ts"] = time.time()
        return result
    result = fetcher()
    cache[cache_key] = {"ts": time.time(), "data": result}
    _save_cache(cache)
    _mem[cache_key] = result
    _mem[f"{cache_key}:ts"] = time.time()
    return result


# ── Policy Rate ───────────────────────────────────────────────────────────────

def _fetch_policy_rate() -> dict:
    body = _bot_get(_IR_SESSION, "/PolicyRate/v3/policy_rate/")
    r = body.get("result", {})
    return {
        "rate":              _to_float(r.get("data")),
        "announcement_date": r.get("announcement_date"),
        "effective_datetime":r.get("effective_datetime"),
        "news_en":           r.get("news_text_en"),
        "news_th":           r.get("news_text_th"),
        "as_of":             datetime.utcnow().isoformat() + "Z",
    }


@router.get("/api/bot/rates/policy")
def get_policy_rate():
    """BOT Policy Rate — current rate + latest MPC decision text."""
    return _cached("ir:policy", _IR_TTL, _fetch_policy_rate)


# ── Interbank Transaction Rate ────────────────────────────────────────────────

def _fetch_interbank(start: str, end: str) -> dict:
    body = _bot_get(_IR_SESSION, "/Stat-InterbankTransactionRate/v2/INTRBNK_TXN_RATE",
                    {"start_period": start, "end_period": end})
    records = body.get("result", {}).get("data", {}).get("data_detail", [])
    cleaned = []
    for r in records:
        wavg = _to_float(r.get("weighted_average_interest_rate"))
        if wavg is None:
            continue
        cleaned.append({
            "period":    r.get("period"),
            "term":      r.get("term_type_name_eng"),
            "min_rate":  _to_float(r.get("min_interest_rate")),
            "max_rate":  _to_float(r.get("max_interest_rate")),
            "mode_rate": _to_float(r.get("mode_interest_rate")),
            "wavg_rate": wavg,
        })
    cleaned.sort(key=lambda x: (x["period"] or "", x["term"] or ""), reverse=True)
    return {
        "records": cleaned,
        "count":   len(cleaned),
        "start_period": start,
        "end_period":   end,
        "as_of": datetime.utcnow().isoformat() + "Z",
    }


@router.get("/api/bot/rates/interbank")
def get_interbank_rate(
    start_period: str = Query(default="", description="Start date yyyy-mm-dd (default: 30 days ago)"),
    end_period:   str = Query(default="", description="End date yyyy-mm-dd (default: today). Max 31 days"),
):
    """Interbank Transaction Rates — O/N, T/N, Call etc. (weighted average, min, max)."""
    from datetime import timedelta
    today = datetime.utcnow().date()
    if not end_period:
        end_period = today.strftime("%Y-%m-%d")
    if not start_period:
        start_period = (today - timedelta(days=_BOT_MAX_DAYS)).strftime("%Y-%m-%d")
    return _cached(f"ir:interbank:{start_period}:{end_period}", _IR_TTL,
                   lambda: _fetch_interbank(start_period, end_period))


# ── THB Implied Interest Rate ─────────────────────────────────────────────────

def _fetch_thb_implied(start: str, end: str) -> dict:
    body = _bot_get(_IR_SESSION, "/Stat-ThaiBahtImpliedInterestRate/v2/THB_IMPL_INT_RATE",
                    {"start_period": start, "end_period": end})
    records = body.get("result", {}).get("data", {}).get("data_detail", [])
    cleaned = []
    for r in records:
        cleaned.append({
            "period":    r.get("period") or None,
            "rate_type": r.get("rate_type_name_eng"),
            "rate":      _to_float(r.get("interest_rate")),
        })
    cleaned.sort(key=lambda x: (x["period"] or "", x["rate_type"] or ""), reverse=True)
    return {
        "records": cleaned,
        "count":   len(cleaned),
        "start_period": start,
        "end_period":   end,
        "as_of": datetime.utcnow().isoformat() + "Z",
    }


@router.get("/api/bot/rates/thb-implied")
def get_thb_implied_rate(
    start_period: str = Query(default="", description="Start date yyyy-mm-dd (default: 30 days ago)"),
    end_period:   str = Query(default="", description="End date yyyy-mm-dd (default: today). Max 31 days"),
):
    """Thai Baht Implied Interest Rates — ONSHORE/OFFSHORE T/N, 1W, 1M etc."""
    from datetime import timedelta
    today = datetime.utcnow().date()
    if not end_period:
        end_period = today.strftime("%Y-%m-%d")
    if not start_period:
        start_period = (today - timedelta(days=_BOT_MAX_DAYS)).strftime("%Y-%m-%d")
    return _cached(f"ir:thb_implied:{start_period}:{end_period}", _IR_TTL,
                   lambda: _fetch_thb_implied(start_period, end_period))


# ── Swap Point ────────────────────────────────────────────────────────────────

def _fetch_swap_point(start: str, end: str) -> dict:
    body = _bot_get(_IR_SESSION, "/Stat-SwapPoint/v2/SWAPPOINT",
                    {"start_period": start, "end_period": end})
    records = body.get("result", {}).get("data", {}).get("data_detail", [])
    cleaned = []
    for r in records:
        cleaned.append({
            "period": r.get("period") or None,
            "term":   r.get("term_type_name_eng"),
            "bid":    _to_float(r.get("bid_rate")),
            "offer":  _to_float(r.get("offer_rate")),
        })
    cleaned.sort(key=lambda x: (x["period"] or "", x["term"] or ""), reverse=True)
    return {
        "records": cleaned,
        "count":   len(cleaned),
        "start_period": start,
        "end_period":   end,
        "as_of": datetime.utcnow().isoformat() + "Z",
    }


@router.get("/api/bot/rates/swap-point")
def get_swap_point(
    start_period: str = Query(default="", description="Start date yyyy-mm-dd (default: 30 days ago)"),
    end_period:   str = Query(default="", description="End date yyyy-mm-dd (default: today). Max 31 days"),
):
    """FX Swap Points — Onshore bid/offer for 1M, 3M, 6M, 1Y terms (in satangs)."""
    from datetime import timedelta
    today = datetime.utcnow().date()
    if not end_period:
        end_period = today.strftime("%Y-%m-%d")
    if not start_period:
        start_period = (today - timedelta(days=_BOT_MAX_DAYS)).strftime("%Y-%m-%d")
    return _cached(f"ir:swap:{start_period}:{end_period}", _IR_TTL,
                   lambda: _fetch_swap_point(start_period, end_period))


# ── Interest Rates Summary (all in one call) ──────────────────────────────────

@router.get("/api/bot/rates")
def get_all_rates(
    start_period: str = Query(default="", description="Start date yyyy-mm-dd (default: 30 days ago)"),
    end_period:   str = Query(default="", description="End date yyyy-mm-dd (default: today). Max 31 days"),
):
    """All BOT interest rate data: policy rate + interbank + THB implied + swap points."""
    from datetime import timedelta
    today = datetime.utcnow().date()
    if not end_period:
        end_period = today.strftime("%Y-%m-%d")
    if not start_period:
        start_period = (today - timedelta(days=_BOT_MAX_DAYS)).strftime("%Y-%m-%d")

    policy    = _cached("ir:policy", _IR_TTL, _fetch_policy_rate)
    interbank = _cached(f"ir:interbank:{start_period}:{end_period}", _IR_TTL,
                        lambda: _fetch_interbank(start_period, end_period))
    thb_impl  = _cached(f"ir:thb_implied:{start_period}:{end_period}", _IR_TTL,
                        lambda: _fetch_thb_implied(start_period, end_period))
    swap      = _cached(f"ir:swap:{start_period}:{end_period}", _IR_TTL,
                        lambda: _fetch_swap_point(start_period, end_period))

    return {
        "policy_rate":          policy,
        "interbank":            interbank,
        "thb_implied":          thb_impl,
        "swap_points":          swap,
        "start_period":         start_period,
        "end_period":           end_period,
        "as_of":                datetime.utcnow().isoformat() + "Z",
        "fx_note": "Exchange Rate endpoints require additional BOT API subscription (Stat-ExchangeRate/v2)",
    }


# ═════════════════════════════════════════════════════════════════════════════
# EXCHANGE RATES  (requires Stat-ExchangeRate subscription — returns 403 until activated)
# ═════════════════════════════════════════════════════════════════════════════

def _parse_exg_records(body: dict) -> list[dict]:
    records = body.get("result", {}).get("data", {}).get("data_detail", [])
    cleaned = []
    for r in records:
        if not isinstance(r, dict):
            continue
        cleaned.append({
            "period":       r.get("period"),
            "currency_id":  r.get("currency_id"),
            "currency_name_eng": r.get("currency_name_eng"),
            "currency_name_th":  r.get("currency_name_th"),
            "buying_sight":   _to_float(r.get("buying_sight")),
            "buying_transfer":_to_float(r.get("buying_transfer")),
            "selling":        _to_float(r.get("selling")),
            "mid_rate":       _to_float(r.get("mid_rate") or r.get("average_rate")),
        })
    cleaned.sort(key=lambda x: (x["period"] or "", x["currency_id"] or ""), reverse=True)
    return cleaned


@router.get("/api/bot/fx/daily")
def get_fx_daily(
    start_period: str = Query(default="", description="Start date yyyy-mm-dd (default: 30 days ago)"),
    end_period:   str = Query(default="", description="End date yyyy-mm-dd (default: today). Max 31 days"),
):
    """Daily average exchange rates (THB). Requires Stat-ExchangeRate subscription."""
    from datetime import timedelta
    today = datetime.utcnow().date()
    if not end_period:
        end_period = today.strftime("%Y-%m-%d")
    if not start_period:
        start_period = (today - timedelta(days=_BOT_MAX_DAYS)).strftime("%Y-%m-%d")

    def fetch():
        body = _bot_get(_FX_SESSION, "/Stat-ExchangeRate/v2/DAILY_AVG_EXG_RATE/",
                        {"start_period": start_period, "end_period": end_period})
        records = _parse_exg_records(body)
        return {"records": records, "count": len(records),
                "start_period": start_period, "end_period": end_period,
                "as_of": datetime.utcnow().isoformat() + "Z"}

    return _cached(f"fx:daily:{start_period}:{end_period}", _FX_TTL, fetch)


@router.get("/api/bot/fx/monthly")
def get_fx_monthly(
    start_period: str = Query(default="2025-01", description="Start month yyyy-mm"),
    end_period:   str = Query(default="",         description="End month yyyy-mm (default: current month)"),
):
    """Monthly average exchange rates (THB). Requires Stat-ExchangeRate subscription."""
    if not end_period:
        end_period = datetime.utcnow().strftime("%Y-%m")

    def fetch():
        body = _bot_get(_FX_SESSION, "/Stat-ExchangeRate/v2/MONTHLY_AVG_EXG_RATE/",
                        {"start_period": start_period, "end_period": end_period})
        records = _parse_exg_records(body)
        return {"records": records, "count": len(records),
                "start_period": start_period, "end_period": end_period,
                "as_of": datetime.utcnow().isoformat() + "Z"}

    return _cached(f"fx:monthly:{start_period}:{end_period}", _FX_TTL, fetch)


# ═════════════════════════════════════════════════════════════════════════════
# STATISTICS  (CategoryList / Observations — requires Statistics subscription)
# ═════════════════════════════════════════════════════════════════════════════

_STATS_SESSION = requests.Session()
_STATS_SESSION.headers.update({"Accept": "application/json", "Authorization": BOT_STATS_TOKEN})

_STATS_CATEGORY_TTL = 24 * 3600   # 24 hr — categories rarely change
_STATS_SERIES_TTL   = 24 * 3600   # 24 hr
_STATS_SEARCH_TTL   = 60 * 60     # 1 hr
_STATS_OBS_TTL      = 60 * 60     # 1 hr


@router.get("/api/bot/statistics/categories")
def get_stat_categories():
    """List all available statistical categories from BOT."""
    if not BOT_STATS_TOKEN:
        raise HTTPException(status_code=503, detail="BOT_STATS_TOKEN not configured")

    def fetch() -> dict:
        body = _bot_get(_STATS_SESSION, "/categorylist/category_list/")
        categories = body.get("result", {}).get("category", [])
        return {
            "categories": categories,
            "count": len(categories),
            "as_of": datetime.utcnow().isoformat() + "Z",
        }

    return _cached("stats:categories", _STATS_CATEGORY_TTL, fetch)


@router.get("/api/bot/statistics/series")
def get_stat_series(
    category: str = Query(default="", description="Category code e.g. FM_RT_013"),
):
    """List all series within a statistical category."""
    if not BOT_STATS_TOKEN:
        raise HTTPException(status_code=503, detail="BOT_STATS_TOKEN not configured")
    if not category:
        raise HTTPException(status_code=400, detail="category parameter is required")

    def fetch() -> dict:
        body = _bot_get(_STATS_SESSION, "/categorylist/series_list/",
                        {"category": category})
        series = body.get("result", {}).get("series", [])
        return {
            "category": category,
            "series": series,
            "count": len(series),
            "as_of": datetime.utcnow().isoformat() + "Z",
        }

    return _cached(f"stats:series:{category}", _STATS_SERIES_TTL, fetch)


@router.get("/api/bot/statistics/search")
def search_stat_series(
    keyword: str = Query(default="", description="Search keyword for series"),
):
    """Search statistical series by keyword."""
    if not BOT_STATS_TOKEN:
        raise HTTPException(status_code=503, detail="BOT_STATS_TOKEN not configured")
    if not keyword:
        raise HTTPException(status_code=400, detail="keyword parameter is required")

    def fetch() -> dict:
        body = _bot_get(_STATS_SESSION, "/search-series/", {"keyword": keyword})
        series = body.get("result", {}).get("series_details", [])
        return {
            "keyword": keyword,
            "series": series,
            "count": len(series),
            "as_of": datetime.utcnow().isoformat() + "Z",
        }

    return _cached(f"stats:search:{keyword}", _STATS_SEARCH_TTL, fetch)


@router.get("/api/bot/statistics/observations")
def get_stat_observations(
    series_code:  str = Query(default="", description="Series code e.g. FMRTTHORD00003"),
    start_period: str = Query(default="", description="Start date yyyy-mm-dd (default: 365 days ago)"),
    end_period:   str = Query(default="", description="End date yyyy-mm-dd (default: today)"),
):
    """Get observation data for a statistical series."""
    if not BOT_STATS_TOKEN:
        raise HTTPException(status_code=503, detail="BOT_STATS_TOKEN not configured")
    if not series_code:
        raise HTTPException(status_code=400, detail="series_code parameter is required")

    from datetime import timedelta
    today = datetime.utcnow().date()
    if not end_period:
        end_period = today.strftime("%Y-%m-%d")
    if not start_period:
        start_period = (today - timedelta(days=365)).strftime("%Y-%m-%d")

    def fetch() -> dict:
        body = _bot_get(_STATS_SESSION, "/observations/", {
            "series_code": series_code,
            "start_period": start_period,
            "end_period": end_period,
        })
        result = body.get("result", {})
        obs_series = result.get("series", [])
        # Flatten observations for convenience
        for s in obs_series:
            obs = s.get("observations", [])
            s["observations"] = [
                {"period": o.get("period_start"), "value": _to_float(o.get("value"))}
                for o in obs if isinstance(o, dict)
            ]
        return {
            "series_code": series_code,
            "start_period": start_period,
            "end_period": end_period,
            "series": obs_series,
            "as_of": datetime.utcnow().isoformat() + "Z",
        }

    return _cached(f"stats:obs:{series_code}:{start_period}:{end_period}", _STATS_OBS_TTL, fetch)


# ═════════════════════════════════════════════════════════════════════════════
# CACHE MANAGEMENT
# ═════════════════════════════════════════════════════════════════════════════

@router.delete("/api/bot/cache")
def clear_bot_cache():
    """Force refresh: clear memory and disk cache."""
    _mem.clear()
    try:
        cache = _load_cache()
        for entry in cache.values():
            if isinstance(entry, dict):
                entry["ts"] = 0
        _save_cache(cache)
    except Exception:
        pass
    return {"cleared": True}
