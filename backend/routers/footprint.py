"""
Order Footprint endpoint — Binance klines + aggTrades → buy/sell volume per candle
and, for the most recent candles, per price level.

Two sources, two costs:
  * klines carry each candle's exact taker-buy volume, so the per-candle totals
    (buy, sell, delta) of hundreds of candles are one request;
  * the price levels need the trades themselves (aggTrades, 1000 a page), so
    they are read for the last `_DETAIL_CANDLES` only, a few candles per
    request, and a closed candle is kept — it never changes.

Only available for cryptocurrency pairs that exist on Binance.
"""
import concurrent.futures
import math
import statistics
import threading
import time
from collections import OrderedDict, defaultdict

import requests
from fastapi import APIRouter, HTTPException, Query

from cache import TTLCache
from config import BINANCE_API_KEY

router = APIRouter()

BINANCE_BASE = "https://api.binance.com"
_fp_cache = TTLCache(ttl=30, maxsize=50)
_RESPONSE_TTL = 10

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

# How many of the most recent candles get price levels. Long intervals are
# page-capped well below a candle's trades, so more of them buys nothing.
_DETAIL_CANDLES: dict[str, int] = {
    "1m": 150, "5m": 150, "15m": 60, "30m": 40,
    "1h": 20, "2h": 20, "4h": 20,
    "1d": 10, "1wk": 4,
}

# Candles whose trades are read in one request; the rest are reported as
# `pending` and filled by the next ones. Keeps a cold start inside the proxy's
# timeout and Binance's request weight.
_FETCH_PER_REQUEST = 30

# Closed candles, binned on a fine tick: (symbol, interval, openTime) → bins.
_closed: "OrderedDict[tuple[str, str, int], dict]" = OrderedDict()
_closed_lock = threading.Lock()
_CLOSED_MAX = 4000


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
    headers = _binance_headers()
    # First page by time, the rest by id: paging on "last timestamp + 1" drops
    # every trade that shares the last one's millisecond — a sweep is exactly
    # many trades in one millisecond.
    params: dict = {"symbol": bn_symbol, "startTime": start_ms, "endTime": end_ms, "limit": 1000}

    for _ in range(max_pages):
        resp = requests.get(
            f"{BINANCE_BASE}/api/v3/aggTrades",
            params=params,
            headers=headers,
            timeout=10,
        )
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        inside = [t for t in batch if int(t["T"]) <= end_ms]
        trades.extend(inside)
        if len(batch) < 1000 or len(inside) < len(batch):
            break
        params = {"symbol": bn_symbol, "fromId": int(batch[-1]["a"]) + 1, "limit": 1000}

    return trades


def _nice_step(raw: float) -> float:
    """Largest 1-2-5 step not above `raw`."""
    if raw <= 0:
        return 0.0
    exp = math.floor(math.log10(raw))
    base = 10.0 ** exp
    for m in (5, 2, 1):
        if m * base <= raw * (1 + 1e-9):
            return m * base
    return base


def _base_tick(price: float) -> float:
    """Tick the trades are binned on before any display step is known.

    A power of ten about 1/100,000 of the price (0.1 for BTC at 80k), so every
    1-2-5 display step above it is a whole number of ticks.
    """
    if price <= 0:
        return 0.0
    return 10.0 ** math.floor(math.log10(price * 1e-5))


def _bin_trades(trades: list[dict], tick: float) -> dict:
    """Trades of one candle → buy/sell volume per tick, plus the running delta's range."""
    buy: dict[int, float] = defaultdict(float)
    sell: dict[int, float] = defaultdict(float)
    seen = 0.0
    delta = 0.0
    min_delta = 0.0
    max_delta = 0.0

    for t in trades:
        qty = float(t["q"])
        k = math.floor(float(t["p"]) / tick + 1e-9)
        seen += qty
        if t["m"]:  # isBuyerMaker = True means taker sold
            sell[k] += qty
            delta -= qty
        else:
            buy[k] += qty
            delta += qty
        if delta < min_delta:
            min_delta = delta
        elif delta > max_delta:
            max_delta = delta

    return {
        "tick": tick,
        "buy": dict(buy),
        "sell": dict(sell),
        "seen": seen,
        "minDelta": min_delta,
        "maxDelta": max_delta,
    }


def _levels(bins: dict, step: float) -> list[dict]:
    """Re-bin a candle's ticks onto the response grid: a level is [k*step, (k+1)*step).

    The same k is the same price in every candle, so rows line up across the
    chart and the client can merge them further.
    """
    ratio = bins["tick"] / step
    buy: dict[int, float] = defaultdict(float)
    sell: dict[int, float] = defaultdict(float)
    for k, v in bins["buy"].items():
        buy[math.floor(k * ratio + 1e-9)] += v
    for k, v in bins["sell"].items():
        sell[math.floor(k * ratio + 1e-9)] += v
    return [
        {
            "priceLow": round(k * step, 8),
            "priceHigh": round((k + 1) * step, 8),
            "buyVol": round(buy.get(k, 0.0), 6),
            "sellVol": round(sell.get(k, 0.0), 6),
        }
        for k in sorted(set(buy) | set(sell))
    ]


def _candle_out(ci: dict, bins: dict | None, step: float) -> dict:
    """One candle of the response.

    `totalBuyVol` / `totalSellVol` come from the kline (exact, whatever the
    interval). `levels` come from aggTrades, which are page-capped: `coverage`
    is the share of the candle's volume they hold, and null when the candle has
    no levels (outside the detail window, or not read yet).
    """
    volume = ci["volume"]
    out = {
        "openTime": ci["openTime"],
        "open": ci["open"],
        "high": ci["high"],
        "low": ci["low"],
        "close": ci["close"],
        "volume": volume,
        "trades": ci["trades"],
        "levels": [],
        "totalBuyVol": round(ci["takerBuy"], 6),
        "totalSellVol": round(max(0.0, volume - ci["takerBuy"]), 6),
        "coverage": None,
        "minDelta": None,
        "maxDelta": None,
    }
    if bins is None or step <= 0:
        return out

    out["levels"] = _levels(bins, step)
    coverage = bins["seen"] / volume if volume > 0 else 0.0
    out["coverage"] = round(min(coverage, 1.0), 4)
    # The running delta is only the candle's when every trade was read.
    if coverage >= 0.98:
        out["minDelta"] = round(bins["minDelta"], 6)
        out["maxDelta"] = round(bins["maxDelta"], 6)
    return out


@router.get("/api/crypto/footprint/{symbol}")
def crypto_footprint(
    symbol: str,
    interval: str = Query("5m", description="Candle interval: 1m,5m,15m,30m,1h,2h,4h,1d,1wk"),
    limit: int = Query(20, ge=5, le=500, description="Number of candles (totals for all, levels for the most recent)"),
    buckets: int = Query(12, ge=6, le=30, description="Row density: the grid step gives ~2x this many rows across a typical candle"),
):
    """Order footprint: buy/sell volume per candle, and at each price level for recent candles."""
    interval = interval.lower().strip()
    if interval not in INTERVAL_MS:
        raise HTTPException(400, f"Invalid interval. Use: {list(INTERVAL_MS.keys())}")

    bn_symbol = _to_binance_symbol(symbol)

    cache_key = f"fp:{bn_symbol}:{interval}:{limit}:{buckets}"
    cached = _fp_cache.get(cache_key, ttl=_RESPONSE_TTL)
    if cached is not None:
        return cached

    binance_interval = "1w" if interval == "1wk" else interval
    pages_per_candle = _PAGES_PER_CANDLE.get(interval, 10)

    try:
        # 1) Klines: OHLC and the exact buy/sell split of every candle
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
            return {"symbol": bn_symbol, "interval": interval, "step": 0.0, "pending": 0, "candles": []}

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
                "trades": int(kl[8]),
                "takerBuy": float(kl[9]),
            })

        detail = candles_info[-_DETAIL_CANDLES.get(interval, 20):]

        # One price grid for the whole response: ~2x`buckets` rows across a
        # typical candle. The client merges rows up to what fits on screen.
        ranges = [c["high"] - c["low"] for c in detail if c["high"] > c["low"]]
        step = _nice_step(statistics.median(ranges) / (buckets * 2)) if ranges else 0.0
        tick = min(_base_tick(candles_info[-1]["close"]), step) if step > 0 else 0.0

        # 2) Trades for the detail candles not held yet, newest first
        now_ms = int(time.time() * 1000)
        bins_by_time: dict[int, dict] = {}
        missing: list[dict] = []
        with _closed_lock:
            for ci in reversed(detail):
                held = _closed.get((bn_symbol, interval, ci["openTime"]))
                if held is not None:
                    bins_by_time[ci["openTime"]] = held
                else:
                    missing.append(ci)
        batch = missing[:_FETCH_PER_REQUEST] if tick > 0 else []

        def fetch_candle_bins(ci: dict) -> tuple[dict, dict]:
            trades = _fetch_trades_for_candle(
                bn_symbol, ci["openTime"], ci["closeTime"], pages_per_candle,
            )
            return ci, _bin_trades(trades, tick)

        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            for ci, bins in pool.map(fetch_candle_bins, batch):
                bins_by_time[ci["openTime"]] = bins
                if ci["closeTime"] < now_ms:
                    with _closed_lock:
                        _closed[(bn_symbol, interval, ci["openTime"])] = bins
                        while len(_closed) > _CLOSED_MAX:
                            _closed.popitem(last=False)

        # 3) Response
        data = {
            "symbol": bn_symbol,
            "interval": interval,
            "step": step,
            "pending": len(missing) - len(batch),
            "candles": [
                _candle_out(ci, bins_by_time.get(ci["openTime"]), step) for ci in candles_info
            ],
        }
        # A partial answer is not kept: the next request should read more.
        if data["pending"] == 0:
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
