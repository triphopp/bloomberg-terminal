"""
Forex endpoints — extracted from main.py.
"""
from fastapi import APIRouter, HTTPException, Query

import pandas as pd
from cache import TTLCache
from config import STOCK_CACHE_TTL, MAX_HISTORY_CACHE_TTL, PERIOD_TO_YF, VALID_INTERVALS
from db import get_symbol_list
from sources import market_data

router = APIRouter()

# ── Module-level cache ───────────────────────────────────────────────────────
_fx_cache = TTLCache(ttl=120, maxsize=200)


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/api/fx")
def fx_overview():
    """All major FX pairs with current rates and day change."""
    cache_key = "fx:overview"
    cached = _fx_cache.get(cache_key, ttl=60)
    if cached is not None:
        return cached
    try:
        pairs_defs = get_symbol_list("fx")
        if not pairs_defs:
            raise HTTPException(status_code=500, detail="FX list is empty — run seed")
        symbols = [p["symbol"] for p in pairs_defs]
        batch = market_data.download_quotes(symbols)
        pairs = []
        for pair_def in pairs_defs:
            sym = pair_def["symbol"]
            try:
                snap = batch.quotes.get(sym)
                if not snap or snap.last_price is None:
                    continue
                price = snap.last_price
                prev = snap.previous_close
                chg = price - prev if price and prev else 0
                pct = (chg / prev * 100) if prev else 0
                pairs.append({
                    "id":        pair_def["id"],
                    "symbol":    sym,
                    "price":     round(price, 5) if price else None,
                    "change":    round(chg, 5),
                    "pctChange": round(pct, 3),
                    "prevClose": round(prev, 5) if prev else None,
                })
            except Exception:
                pass
        data = {"pairs": pairs}
        _fx_cache.set(cache_key, data)
        return data
    except Exception as exc:
        print(f"[fx] {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/api/fx/history/{pair}")
def fx_history(pair: str, period: str = "1mo", interval: str = ""):
    """Historical FX rate data. pair = 'EURUSD' or 'EURUSD=X'."""
    sym      = pair if "=" in pair else f"{pair}=X"
    period   = period.lower().strip()
    interval = interval.lower().strip()

    yf_period = PERIOD_TO_YF.get(period, "1mo")
    if interval not in VALID_INTERVALS:
        interval = "1d"

    resample_rule = {"2h": "2h", "4h": "4h"}.get(interval)
    yf_interval   = "1h" if resample_rule else interval
    is_intraday   = yf_interval not in ("1d", "1wk")
    ttl = (
        60 if yf_interval in ("5m", "15m")
        else 300 if is_intraday
        else MAX_HISTORY_CACHE_TTL if period in ("max", "5y")
        else STOCK_CACHE_TTL
    )

    cache_key = f"fxh:{sym}:{period}:{interval}"
    cached = _fx_cache.get(cache_key, ttl=ttl)
    if cached is not None:
        return cached
    try:
        frame = market_data.get_history(sym, period=yf_period, interval=yf_interval)
        hist = frame.df if frame is not None else None
        if hist is None or hist.empty:
            raise HTTPException(status_code=404, detail="No data")
        if resample_rule:
            hist = (
                hist.resample(resample_rule, label="left", closed="left")
                .agg({"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"})
                .dropna(subset=["Close"])
            )
        date_fmt = "%Y-%m-%dT%H:%M:%S" if is_intraday else "%Y-%m-%d"
        points = []
        for dt, row in hist.iterrows():
            points.append({
                "date":  dt.strftime(date_fmt),
                "close": round(float(row["Close"]), 5),
                "open":  round(float(row["Open"]), 5),
                "high":  round(float(row["High"]), 5),
                "low":   round(float(row["Low"]), 5),
                "volume": int(row["Volume"]) if not pd.isna(row.get("Volume", float("nan"))) else 0,
            })
        data = {"symbol": sym, "period": period, "history": points}
        _fx_cache.set(cache_key, data)
        return data
    except HTTPException:
        raise
    except Exception as exc:
        print(f"[fx-history] {sym}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))
