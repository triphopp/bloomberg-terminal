"""
ETF analytics endpoint — extracted from main.py.
"""
from typing import Any

import pandas as pd
from fastapi import APIRouter, HTTPException

from cache import TTLCache
from sources import market_data

router = APIRouter()

# ── Module-level cache ───────────────────────────────────────────────────────
_etf_cache = TTLCache(ttl=3600, maxsize=100)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _safe_float(val: Any) -> float | None:
    try:
        return float(val) if val is not None and not pd.isna(val) else None
    except Exception:
        return None


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/api/etf/{symbol}")
def etf_info(symbol: str):
    """ETF overview: info, top holdings, sector weights, country weights."""
    cache_key = f"etf:{symbol.upper()}"
    cached = _etf_cache.get(cache_key)
    if cached is not None:
        return cached
    try:
        ticker = market_data.get_ticker(symbol)
        info = market_data.get_info(symbol)

        overview = {
            "symbol":       symbol.upper(),
            "name":         info.get("longName") or info.get("shortName", ""),
            "fundFamily":   info.get("fundFamily", ""),
            "category":     info.get("category", ""),
            "totalAssets":  info.get("totalAssets"),
            "navPrice":     info.get("navPrice"),
            "ytdReturn":    _safe_float(info.get("ytdReturn")),
            "threeYearReturn": _safe_float(info.get("threeYearAverageReturn")),
            "fiveYearReturn":  _safe_float(info.get("fiveYearAverageReturn")),
            "expenseRatio": _safe_float(info.get("annualReportExpenseRatio")),
            "beta3Year":    _safe_float(info.get("beta3Year")),
            "dividendYield": _safe_float(info.get("yield")),
            "exchange":     info.get("exchange", ""),
        }

        # Holdings
        holdings = []
        sector_weights = {}
        try:
            fd = ticker.funds_data
            if fd:
                try:
                    th = fd.top_holdings
                    if th is not None and not th.empty:
                        for sym_h, row in th.iterrows():
                            holdings.append({
                                "symbol":  str(sym_h),
                                "name":    row.get("Name", ""),
                                "weight":  round(float(row.get("Holding Percent", 0)) * 100, 2),
                            })
                except Exception:
                    pass
                try:
                    sw = fd.sector_weightings
                    if sw:
                        sector_weights = {k: round(float(v) * 100, 2) for k, v in sw.items() if v}
                except Exception:
                    pass
        except Exception:
            pass

        data = {
            "overview":       overview,
            "topHoldings":    holdings,
            "sectorWeights":  sector_weights,
        }
        _etf_cache.set(cache_key, data)
        return data
    except Exception as exc:
        print(f"[etf] {symbol}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))
