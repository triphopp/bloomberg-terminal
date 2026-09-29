"""Fiscal.ai — secondary fundamentals source (free trial: 100 fixed companies,
250 calls/day). Cross-check numbers against SEC filings; cite `source` in every use.

  GET /api/fiscal/status                       key set? calls used today / budget
  GET /api/fiscal/{kind}/{symbol}?period=annual
      kind: profile · income · balance · cashflow · ratios · adjusted ·
            segments-kpis · earnings-summary · ir-events · fund-letters · news-summary
  GET /api/fiscal/transcript/{symbol}/{event_key}   event_key = q{quarter}-{year}, e.g. q3-2026
                                                    (Fiscal.ai's own quarter label — see ir-events)

The key is sent as the `X-Api-Key` header (the API also accepts `?apiKey=`, which
would put it in URLs and logs — do not switch). Every upstream call counts
against a daily budget persisted in logs/fiscal_ai_usage.json, so a backend
reload does not reset it. Successes are cached 12 h, failures 10 min.
"""

from __future__ import annotations

import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

import requests
from fastapi import APIRouter, HTTPException, Query

import config
from cache import TTLCache

router = APIRouter()

_PATHS: dict[str, str] = {
    "profile": "/v3/company/profile",
    "income": "/v1/company/financials/income-statement/standardized",
    "balance": "/v1/company/financials/balance-sheet/standardized",
    "cashflow": "/v1/company/financials/cash-flow-statement/standardized",
    "ratios": "/v1/company/ratios",
    "adjusted": "/v1/company/adjusted-metrics",
    "segments-kpis": "/v2/company/segments-and-kpis",
    "earnings-summary": "/v1/company/earnings-summary",
    "ir-events": "/v1/company/ir-events",
    "fund-letters": "/v1/company/fund-letters",
    "news-summary": "/v1/company/news-summary",
}
_PERIODIC = {"income", "balance", "cashflow", "ratios", "adjusted", "segments-kpis"}
_PERIODS = {"annual", "quarterly", "semi-annual", "ltm", "ytd", "latest"}
_SYMBOL = re.compile(r"^(?:[A-Z]{2,5}_)?[A-Z0-9.\-]{1,12}$")   # V · BRK.A · NYSE_V
_EVENT = re.compile(r"^q[1-4]-\d{4}$")

_BASE = config.FISCAL_AI_BASE_URL.removesuffix("/v3")   # paths above carry their own version
_USAGE_FILE = Path(config._REPO_ROOT) / "logs" / "fiscal_ai_usage.json"

_cache = TTLCache(ttl=12 * 3600, maxsize=512)
_fail = TTLCache(ttl=10 * 60, maxsize=512)          # negative cache
_session = requests.Session()
_lock = threading.Lock()


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _load_usage() -> dict:
    try:
        u = json.loads(_USAGE_FILE.read_text(encoding="utf-8"))
        return u if u.get("date") == _today() else {"date": _today(), "calls": 0}
    except (OSError, ValueError):
        return {"date": _today(), "calls": 0}


def _spend_one() -> int:
    """Reserve one call from today's budget; 429 if it is gone. Returns calls used."""
    with _lock:
        u = _load_usage()
        if u["calls"] >= config.FISCAL_AI_DAILY_LIMIT:
            raise HTTPException(429, f"Fiscal.ai daily budget used ({u['calls']}/"
                                     f"{config.FISCAL_AI_DAILY_LIMIT}, resets 00:00 UTC)")
        u["calls"] += 1
        try:
            _USAGE_FILE.parent.mkdir(parents=True, exist_ok=True)
            _USAGE_FILE.write_text(json.dumps(u), encoding="utf-8")
        except OSError:
            pass
        return u["calls"]


def _fetch(path: str, params: dict) -> dict:
    if not config.FISCAL_AI_API_KEY:
        # 424, not 503: main.py replaces every 5xx detail with "Internal server error".
        raise HTTPException(424, "FISCAL_AI_API_KEY is not set in backend/.env "
                                 "(fiscal.ai → Data API → Create API key), then restart the backend")
    key = f"{path}?{json.dumps(params, sort_keys=True)}"
    if (hit := _cache.get(key)) is not None:
        return hit
    if (err := _fail.get(key)) is not None:
        raise HTTPException(502, err)
    used = _spend_one()
    try:
        r = _session.get(f"{_BASE}{path}", params=params, timeout=30,
                         headers={"X-Api-Key": config.FISCAL_AI_API_KEY, "Accept": "application/json"})
    except requests.RequestException as exc:
        msg = f"Fiscal.ai unreachable: {exc.__class__.__name__}"
        _fail.set(key, msg)
        raise HTTPException(502, msg) from exc
    if not r.ok:
        # Body may explain (e.g. company not in the free-trial list); never echo headers.
        detail = r.text[:300].replace(config.FISCAL_AI_API_KEY, "***")
        msg = f"Fiscal.ai {path} → {r.status_code}: {detail}"
        _fail.set(key, msg)
        raise HTTPException(502 if r.status_code >= 500 else r.status_code, msg)
    data = {
        "data": r.json(),
        "source": {
            "name": "Fiscal.ai API",
            "endpoint": path,
            "params": params,
            "docs": "https://docs.fiscal.ai/docs/api-reference",
            "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "tier": "free trial (secondary — cross-check vs SEC filings)",
            "calls_used_today": used,
        },
    }
    _cache.set(key, data)
    return data


def _company(symbol: str, exchange: str | None) -> dict:
    s = symbol.strip().upper()
    if not _SYMBOL.match(s):
        raise HTTPException(400, f"bad symbol {symbol!r}")
    if "_" in s:                       # already a companyKey like NYSE_V
        return {"companyKey": s}
    return {"ticker": s, **({"exchange": exchange.upper()} if exchange else {})}


@router.get("/api/fiscal/status")
def fiscal_status():
    u = _load_usage()
    return {"key_set": bool(config.FISCAL_AI_API_KEY), "date_utc": u["date"],
            "calls_used": u["calls"], "daily_limit": config.FISCAL_AI_DAILY_LIMIT}


@router.get("/api/fiscal/transcript/{symbol}/{event_key}")
def fiscal_transcript(symbol: str, event_key: str, exchange: str | None = None):
    if not _EVENT.match(event_key.lower()):
        raise HTTPException(400, "event_key must look like q3-2026 (see ir-events)")
    return _fetch(f"/v1/company/ir-events/transcript/{event_key.lower()}", _company(symbol, exchange))


@router.get("/api/fiscal/{kind}/{symbol}")
def fiscal_data(kind: str, symbol: str,
                period: str = Query("annual", description="annual|quarterly|semi-annual|ltm|ytd|latest, comma-separated"),
                exchange: str | None = None):
    if kind not in _PATHS:
        raise HTTPException(400, f"kind must be one of {sorted(_PATHS)}")
    params = _company(symbol, exchange)
    if kind in _PERIODIC:
        periods = [p.strip() for p in period.split(",") if p.strip()]
        if not periods or any(p not in _PERIODS for p in periods):
            raise HTTPException(400, f"period must be from {sorted(_PERIODS)}")
        params["periodType"] = ",".join(periods)
    return _fetch(_PATHS[kind], params)
