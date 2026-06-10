"""
Order Footprint endpoint — Binance aggTrades → buy/sell volume per price level per candle.

Only available for cryptocurrency pairs that exist on Binance.
"""
import concurrent.futures
from collections import defaultdict

import requests
from fastapi import APIRouter, HTTPException, Query

from cache import TTLCache
from config import BINANCE_API_KEY

router = APIRouter()

BINANCE_BASE = "https://api.binance.com"
_fp_cache = TTLCache(ttl=30, maxsize=50)

INTERVAL_MS: dict[str, int] = {
    "1m":  60_000,
    "5m":  300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h":  3_600_000,
    "2h":  7_200_000,
    "4h":  14_400_000,
    "1d":  86_400_000,
    "1wk": 604_800_000,
}

# Max aggTrade pages per candle — higher for longer intervals
_PAGES_PER_CANDLE: dict[str, int] = {
    "1m": 2, "5m": 3, "15m": 5, "30m": 8,
    "1h": 10, "2h": 15, "4h": 20,
    "1d": 30, "1wk": 50,
}

# Auto-reduce candle count for large intervals
_MAX_CANDLES: dict[str, int] = {
    "1m": 60, "5m": 40, "15m": 30, "30m": 25,
    "1h": 20, "2h": 20, "4h": 20,
    "1d": 10, "1wk": 4,
}


def _to_binance_symbol(sym: str) -> str:
    s = sym.upper().replace("-USD", "").replace("-", "")
    for suffix in ("20947", "21794", "11841", "24478"):
        s = s.replace(suffix, "")
    return s + "USDT"


def _binance_headers() -> dict:
    h: dict[str, str] = {}
    if BINANCE_API_KEY:
        h["X-MBX-APIKEY"] = BINANCE_API_KEY
    return h


def _fetch_trades_for_candle(
    bn_symbol: str, start_ms: int, end_ms: int, max_pages: int
) -> list[dict]:
    """Fetch aggTrades for a single candle's time range."""
    trades: list[dict] = []
    fetch_start = start_ms
    headers = _binance_headers()

    for _ in range(max_pages):
        resp = requests.get(
            f"{BINANCE_BASE}/api/v3/aggTrades",
            params={
                "symbol": bn_symbol,
                "startTime": fetch_start,
                "endTime": end_ms,
                "limit": 1000,
            },
            headers=headers,
            timeout=10,
        )
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        trades.extend(batch)
        if len(batch) < 1000:
            break
        fetch_start = int(batch[-1]["T"]) + 1

    return trades


def _build_candle_footprint(
    kl_data: dict, trades: list[dict], buckets: int
) -> dict:
    """Build footprint levels from trades for a single candle."""
    price_high = kl_data["high"]
    price_low = kl_data["low"]
    price_range = price_high - price_low

    if price_range <= 0 or not trades:
        return {**kl_data, "levels": [], "totalBuyVol": 0, "totalSellVol": 0}

    bucket_size = price_range / buckets
    buy_buckets = [0.0] * buckets
    sell_buckets = [0.0] * buckets
    total_buy = 0.0
    total_sell = 0.0

    for t in trades:
        price = float(t["p"])
        qty = float(t["q"])
        is_sell = t["m"]  # isBuyerMaker = True means taker sold

        idx = int((price - price_low) / bucket_size)
        idx = max(0, min(idx, buckets - 1))

        if is_sell:
            sell_buckets[idx] += qty
            total_sell += qty
        else:
            buy_buckets[idx] += qty
            total_buy += qty

    levels = []
    for i in range(buckets):
        if buy_buckets[i] > 0 or sell_buckets[i] > 0:
            levels.append({
                "priceLow": round(price_low + i * bucket_size, 8),
                "priceHigh": round(price_low + (i + 1) * bucket_size, 8),
                "buyVol": round(buy_buckets[i], 6),
                "sellVol": round(sell_buckets[i], 6),
            })

    return {
        **kl_data,
        "levels": levels,
        "totalBuyVol": round(total_buy, 6),
        "totalSellVol": round(total_sell, 6),
    }


@router.get("/api/crypto/footprint/{symbol}")
def crypto_footprint(
    symbol: str,
    interval: str = Query("5m", description="Candle interval: 1m,5m,15m,30m,1h,2h,4h,1d,1wk"),
    limit: int = Query(20, ge=5, le=60, description="Number of candles"),
    buckets: int = Query(12, ge=6, le=30, description="Price levels per candle"),
):
    """Order footprint: buy/sell volume at each price level per candle."""
    interval = interval.lower().strip()
    if interval not in INTERVAL_MS:
        raise HTTPException(400, f"Invalid interval. Use: {list(INTERVAL_MS.keys())}")

    bn_symbol = _to_binance_symbol(symbol)

    # Clamp candle count for large intervals
    max_candles = _MAX_CANDLES.get(interval, 20)
    limit = min(limit, max_candles)

    cache_key = f"fp:{bn_symbol}:{interval}:{limit}:{buckets}"
    cached = _fp_cache.get(cache_key)
    if cached is not None:
        return cached

    binance_interval = "1w" if interval == "1wk" else interval
    pages_per_candle = _PAGES_PER_CANDLE.get(interval, 10)

    try:
        # 1) Fetch klines
        kl_resp = requests.get(
            f"{BINANCE_BASE}/api/v3/klines",
            params={"symbol": bn_symbol, "interval": binance_interval, "limit": limit},
            headers=_binance_headers(),
            timeout=10,
        )
        if kl_resp.status_code == 400:
            raise HTTPException(404, f"Symbol {bn_symbol} not found on Binance")
        kl_resp.raise_for_status()
        klines = kl_resp.json()

        if not klines:
            return {"symbol": bn_symbol, "interval": interval, "candles": []}

        # Build candle list with time ranges
        candles_info = []
        for kl in klines:
            candles_info.append({
                "openTime": int(kl[0]),
                "closeTime": int(kl[6]),
                "open": float(kl[1]),
                "high": float(kl[2]),
                "low": float(kl[3]),
                "close": float(kl[4]),
                "volume": float(kl[5]),
            })

        # 2) Fetch aggTrades per candle in parallel
        def fetch_candle_trades(ci: dict) -> tuple[int, list[dict]]:
            trades = _fetch_trades_for_candle(
                bn_symbol, ci["openTime"], ci["closeTime"], pages_per_candle,
            )
            return ci["openTime"], trades

        candle_trades: dict[int, list[dict]] = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            futures = {pool.submit(fetch_candle_trades, ci): ci for ci in candles_info}
            for future in concurrent.futures.as_completed(futures):
                open_time, trades = future.result()
                candle_trades[open_time] = trades

        # 3) Build footprint per candle
        result_candles = []
        for ci in candles_info:
            kl_data = {
                "openTime": ci["openTime"],
                "open": ci["open"],
                "high": ci["high"],
                "low": ci["low"],
                "close": ci["close"],
                "volume": ci["volume"],
            }
            trades = candle_trades.get(ci["openTime"], [])
            result_candles.append(_build_candle_footprint(kl_data, trades, buckets))

        data = {
            "symbol": bn_symbol,
            "interval": interval,
            "candles": result_candles,
        }
        _fp_cache.set(cache_key, data)
        return data

    except HTTPException:
        raise
    except requests.exceptions.RequestException as exc:
        print(f"[footprint] Binance API error for {bn_symbol}: {exc}")
        raise HTTPException(502, f"Binance API error: {exc}")
    except Exception as exc:
        print(f"[footprint] {bn_symbol}: {exc}")
        raise HTTPException(500, str(exc))
