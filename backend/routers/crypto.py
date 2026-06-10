"""
Crypto endpoints — extracted from main.py.
"""
import pandas as pd
from fastapi import APIRouter, HTTPException, Query

from cache import TTLCache
from config import STOCK_CACHE_TTL, MAX_HISTORY_CACHE_TTL, PERIOD_TO_YF, VALID_INTERVALS
from db import get_symbol_list
from sources import market_data

router = APIRouter()

# ── Module-level cache ───────────────────────────────────────────────────────
_crypto_cache = TTLCache(ttl=120, maxsize=200)


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/api/crypto")
def crypto_overview():
    """Top crypto assets with prices and 24h changes."""
    cache_key = "crypto:overview"
    cached = _crypto_cache.get(cache_key, ttl=60)
    if cached is not None:
        return cached
    try:
        coins_defs = get_symbol_list("crypto")
        if not coins_defs:
            raise HTTPException(status_code=500, detail="Crypto list is empty — run seed")
        symbols = [c["symbol"] for c in coins_defs]
        batch = market_data.download_quotes(symbols)
        coins = []
        for coin_def in coins_defs:
            sym = coin_def["symbol"]
            try:
                snap = batch.quotes.get(sym)
                if not snap or snap.last_price is None:
                    continue
                price = snap.last_price
                prev = snap.previous_close
                chg = price - prev if price and prev else 0
                pct = (chg / prev * 100) if prev else 0
                mcap = snap.market_cap
                coins.append({
                    "id":        coin_def["id"],
                    "name":      coin_def.get("name", coin_def["id"]),
                    "symbol":    sym,
                    "price":     round(price, 6) if price else None,
                    "change":    round(chg, 6),
                    "pctChange": round(pct, 2),
                    "marketCap": mcap,
                    "prevClose": round(prev, 6) if prev else None,
                })
            except Exception:
                pass
        data = {"coins": coins}
        _crypto_cache.set(cache_key, data)
        return data
    except Exception as exc:
        print(f"[crypto] {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/api/crypto/history/{coin}")
def crypto_history(coin: str, period: str = "3mo", interval: str = ""):
    """Historical crypto price. coin = 'BTC' or 'BTC-USD'."""
    sym      = coin if "-" in coin else f"{coin}-USD"
    period   = period.lower().strip()
    interval = interval.lower().strip()

    yf_period = PERIOD_TO_YF.get(period, "3mo")
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

    cache_key = f"cryh:{sym}:{period}:{interval}"
    cached = _crypto_cache.get(cache_key, ttl=ttl)
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
                "date":   dt.strftime(date_fmt),
                "close":  round(float(row["Close"]), 6),
                "open":   round(float(row["Open"]), 6),
                "high":   round(float(row["High"]), 6),
                "low":    round(float(row["Low"]), 6),
                "volume": int(row["Volume"]) if not pd.isna(row.get("Volume", float("nan"))) else 0,
            })
        data = {"symbol": sym, "period": period, "history": points}
        _crypto_cache.set(cache_key, data)
        return data
    except HTTPException:
        raise
    except Exception as exc:
        print(f"[crypto-history] {sym}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))
