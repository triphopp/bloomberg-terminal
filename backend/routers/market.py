"""
Market data & heatmap endpoints — extracted from main.py.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query

from cache import TTLCache
from sources import market_data
from config import (
    INDEX_ETF_MAP,
    INTL_SECTOR_STOCKS,
    CACHE_TTL,
    YTD_CACHE_TTL,
    ETF_SIZE_CACHE_TTL,
)
from db import get_symbol_list, get_heatmap_groups
from market_session import is_today_at, local_date_of

router = APIRouter()

# ── Module-level caches ───────────────────────────────────────────────────────
_cache = TTLCache(ttl=CACHE_TTL, maxsize=1)
_heatmap_cache = TTLCache(ttl=CACHE_TTL, maxsize=20)
_vol_cache = TTLCache(ttl=CACHE_TTL, maxsize=1)
_ytd_cache = TTLCache(ttl=YTD_CACHE_TTL, maxsize=200)
_etf_size_cache = TTLCache(ttl=ETF_SIZE_CACHE_TTL, maxsize=100)


# ── Helper functions ──────────────────────────────────────────────────────────

def compute_size(fi) -> float:
    """Return a relative size metric for treemap cell sizing.

    ETFs / stocks   → market cap in billions USD (AUM proxy)
    Indices/futures → 3-month avg dollar volume in billions USD
    Falls back to 1.0 so every cell gets at least some space.
    """
    mc = getattr(fi, "market_cap", None)
    if mc and mc > 0:
        return round(mc / 1e9, 4)
    avg_vol = getattr(fi, "three_month_average_volume", None) or 0
    price = getattr(fi, "last_price", None) or 0
    if avg_vol > 0 and price > 0:
        return round(avg_vol * price / 1e9, 4)
    return 1.0


def fetch_etf_size(etf_symbol: str) -> float:
    """Return the AUM (market cap) of a representative ETF in billions USD."""
    cached = _etf_size_cache.get(etf_symbol)
    if cached is not None:
        return cached
    try:
        fi = market_data.get_fast_info(etf_symbol)
        mc = getattr(fi, "market_cap", None)
        size = round(mc / 1e9, 4) if (mc and mc > 0) else 1.0
    except Exception:
        size = 1.0
    _etf_size_cache.set(etf_symbol, size)
    return size


def get_ytd_start_price(symbol: str) -> float | None:
    """Return the closing price on the first trading day of the current calendar year."""
    cached = _ytd_cache.get(symbol)
    if cached is not None:
        return cached
    try:
        year = datetime.now().year
        hist = market_data.get_ticker(symbol).history(start=f"{year}-01-01", interval="1d")
        if hist.empty:
            return None
        price = float(hist["Close"].iloc[0])
        _ytd_cache.set(symbol, price)
        return price
    except Exception:
        return None


def compute_ytd(symbol: str, current_price: float) -> float:
    """Compute true calendar-year YTD % change."""
    start = get_ytd_start_price(symbol)
    if start is None or start == 0:
        return 0.0
    return round((current_price - start) / start * 100, 2)


def fetch_one(cfg: dict) -> dict | None:
    """Fetch latest quote for a single symbol.

    Uses ticker.info for accurate change data (fast_info.previous_close
    is often stale, causing CHG% to diverge from Yahoo Finance).
    Falls back to fast_info when info is unavailable.
    """
    try:
        ticker = market_data.get_ticker(cfg["symbol"])
        fi = ticker.fast_info

        price = fi.last_price
        if price is None or price == 0:
            return None

        # Try ticker.info for accurate previous_close & change
        info: dict = {}
        try:
            info = ticker.info or {}
        except Exception:
            pass

        if info.get("regularMarketChange") is not None:
            change = round(info["regularMarketChange"], 2)
            pct_change = round(info.get("regularMarketChangePercent", 0), 4)
            price = info.get("regularMarketPrice") or price
        else:
            prev = fi.previous_close or price
            change = round(price - prev, 2)
            pct_change = round((change / prev) * 100, 4) if prev else 0.0

        # Volume: prefer regular_market_volume, fall back to 3-month average
        volume = (
            info.get("regularMarketVolume")
            or getattr(fi, "regular_market_volume", None)
            or getattr(fi, "three_month_average_volume", 0)
            or 0
        )
        vol_m = round(volume / 1_000_000, 2)

        # True YTD: (current price - first trading day of year close) / first close * 100
        ytd = compute_ytd(cfg["symbol"], price)

        # Size: use representative ETF's AUM for indices (they have no own market cap)
        etf_sym = INDEX_ETF_MAP.get(cfg["symbol"])
        size = fetch_etf_size(etf_sym) if etf_sym else compute_size(fi)

        # Session freshness: `change`/`pctChange` above are whatever Yahoo last
        # published, which after a close is the PREVIOUS session's move. Ship the
        # verdict so the UI can mark it rather than passing it off as today's.
        tz_name = info.get("exchangeTimezoneName")
        market_time = info.get("regularMarketTime")

        return {
            "id": cfg["id"],
            "symbol": cfg["symbol"],
            "num": cfg["num"],
            "rmi": "□",
            "value": round(price, 2),
            "change": change,
            "pctChange": pct_change,
            "avat": vol_m,
            "quoteDate": local_date_of(market_time, tz_name),
            "isCurrentSession": is_today_at(market_time, tz_name),
            "marketState": info.get("marketState"),
            "time": datetime.now().strftime("%H:%M"),
            "ytd": ytd,
            "ytdCur": ytd,
            "size": size,
        }
    except Exception as exc:
        print(f"[yfinance] {cfg['symbol']}: {exc}")
        return None


def build_market_data() -> dict:
    """Fetch all indices concurrently and group by region."""
    indices = get_symbol_list("indices")
    if not indices:
        return {
            "americas": [], "emea": [], "asiaPacific": [],
            "lastUpdated": datetime.utcnow().isoformat() + "Z",
            "dataSource": "yfinance",
        }
    regions: dict[str, list] = {"americas": [], "emea": [], "asiaPacific": []}

    with ThreadPoolExecutor(max_workers=10) as pool:
        future_to_cfg = {pool.submit(fetch_one, cfg): cfg for cfg in indices}
        for future in as_completed(future_to_cfg):
            cfg = future_to_cfg[future]
            result = future.result()
            if result:
                regions[cfg["region"]].append(result)

    # Preserve original order
    order = {cfg["id"]: i for i, cfg in enumerate(indices)}
    for region in regions.values():
        region.sort(key=lambda x: order.get(x["id"], 999))

    return {
        **regions,
        "lastUpdated": datetime.utcnow().isoformat() + "Z",
        "dataSource": "yfinance",
    }


def build_volatility_data() -> dict:
    """The VOLATILITY section of the TICK DATA board.

    Same row shape as the regional index sections so the UI can reuse TickRow,
    with the config's `group` carried through for the sub-headers (S&P term
    structure, vol-of-vol, equity, global, commodities/rates).

    These are calculated indices: no volume, no market cap, and YTD on a vol
    index is a real number but a meaningless one to rank by — the fields exist
    because the row component expects them, not because they mean anything here.
    """
    defs = get_symbol_list("volatility")
    if not defs:
        return {"items": [], "lastUpdated": datetime.utcnow().isoformat() + "Z"}

    items: list[dict] = []
    with ThreadPoolExecutor(max_workers=10) as pool:
        future_to_cfg = {pool.submit(fetch_one, cfg): cfg for cfg in defs}
        for future in as_completed(future_to_cfg):
            cfg = future_to_cfg[future]
            result = future.result()
            if result:
                result["group"] = cfg.get("group") or "VOLATILITY"
                items.append(result)

    order = {cfg["id"]: i for i, cfg in enumerate(defs)}
    items.sort(key=lambda x: order.get(x["id"], 999))

    return {
        "items": items,
        "lastUpdated": datetime.utcnow().isoformat() + "Z",
        "dataSource": "yfinance",
    }


def fetch_heatmap_item(cfg: dict) -> dict | None:
    """Fetch a single quote for a heatmap tile (sectors, commodities, bonds, indicators)."""
    try:
        ticker = market_data.get_ticker(cfg["symbol"])
        fi = ticker.fast_info

        price = fi.last_price
        prev_close = fi.previous_close

        if price is None or price == 0:
            return None

        prev = prev_close if prev_close else price
        change = round(price - prev, 4)
        pct_change = round((change / prev) * 100, 4) if prev else 0.0

        volume = (
            getattr(fi, "regular_market_volume", None)
            or getattr(fi, "three_month_average_volume", 0)
            or 0
        )
        vol_m = round(volume / 1_000_000, 2)

        # True YTD: (current price - first trading day of year close) / first close * 100
        ytd = compute_ytd(cfg["symbol"], price)

        return {
            "id": cfg["id"],
            "symbol": cfg["symbol"],
            "value": round(price, 4),
            "change": change,
            "pctChange": pct_change,
            "ytd": ytd,
            "avat": vol_m,
            "time": datetime.now().strftime("%H:%M"),
            "size": compute_size(fi),
        }
    except Exception as exc:
        print(f"[heatmap] {cfg['symbol']}: {exc}")
        return None


# ── Sector detail helpers ────────────────────────────────────────────────────

def _fetch_holding_info(symbol: str) -> dict | None:
    """Fetch key metrics for a single stock holding."""
    try:
        info = market_data.get_info(symbol)
        fi = market_data.get_fast_info(symbol)
        price = info.get("regularMarketPrice") or fi.last_price or 0
        if not price or price == 0:
            return None
        return {
            "symbol":     symbol,
            "name":       info.get("shortName") or info.get("longName", symbol),
            "price":      round(price, 2),
            "pctChange":  round(info.get("regularMarketChangePercent", 0), 2),
            "pe":         info.get("trailingPE"),
            "forwardPE":  info.get("forwardPE"),
            "peg":        info.get("pegRatio"),
            "debtEq":     info.get("debtToEquity"),
            "marketCap":  info.get("marketCap"),
        }
    except Exception as exc:
        print(f"[sector-detail] holding {symbol}: {exc}")
        return None


def _compute_aggregates(holdings: list[dict]) -> dict:
    """Compute robust aggregates: median, market-cap-weighted avg, range.

    Simple arithmetic means are sensitive to outliers — a single stock with
    P/E=500 or D/E=1000% can distort the picture.  Median and market-cap-
    weighted averages are what professional terminals (Bloomberg, FactSet) use.
    """
    def _vals(key: str) -> list[float]:
        return [h[key] for h in holdings if h.get(key) is not None]

    def _pct(key: str) -> list[float]:
        # For ratio metrics, filter out clearly erroneous values
        raw = _vals(key)
        return [v for v in raw if v > 0 and v < 10000]

    def _median(vals: list[float]) -> float | None:
        if not vals:
            return None
        s = sorted(vals)
        n = len(s)
        mid = n // 2
        return round((s[mid] + s[mid - 1]) / 2, 2) if n % 2 == 0 else round(s[mid], 2)

    def _avg(vals: list[float]) -> float | None:
        return round(sum(vals) / len(vals), 2) if vals else None

    def _wtd_pe(pe_key: str) -> float | None:
        """Market-cap-weighted average P/E — industry standard.

        Weighted P/E = Σ(marketCap_i) / Σ(marketCap_i / PE_i)
        This is the harmonic-mean equivalent that prevents large-cap stocks
        from dominating the numerator.
        """
        pairs = [(h.get(pe_key), h.get("marketCap")) for h in holdings]
        valid = [(pe, mc) for pe, mc in pairs if pe and mc and pe > 0 and mc > 0]
        if not valid:
            return None
        total_mc = sum(mc for _, mc in valid)
        total_earnings = sum(mc / pe for pe, mc in valid)
        return round(total_mc / total_earnings, 2) if total_earnings > 0 else None

    def _stats(key: str) -> dict:
        v = _pct(key) if key in ("pe", "forwardPE", "peg", "debtEq") else _vals(key)
        return {
            "median": _median(v),
            "avg":    _avg(v),
            "min":    round(min(v), 2) if v else None,
            "max":    round(max(v), 2) if v else None,
            "n":      len(v),
        }

    pe_vals     = _pct("pe")
    fpe_vals    = _pct("forwardPE")
    total_mc    = sum(v for v in _vals("marketCap") if v)
    count        = len(holdings)

    return {
        "count":     count,
        "pe":        {**_stats("pe"),        "wtd": _wtd_pe("pe")},
        "forwardPE": {**_stats("forwardPE"), "wtd": _wtd_pe("forwardPE")},
        "peg":       _stats("peg"),
        "debtEq":    _stats("debtEq"),
        "marketCap": {
            **_stats("marketCap"),
            "total": round(total_mc, 2) if total_mc else None,
        },
    }


def _single_pass_aggregates(stks: list[dict]) -> dict:
    """AF-4: compute all sector aggregates in one pass instead of 15+ separate list comprehensions."""
    n = len(stks)
    if n == 0:
        return {
            "count": 0, "avg_pct": 0.0, "avg_ytd": 0.0,
            "avg_price": 0.0, "total_size": 0.0,
            "pe": {"median": None, "avg": None, "min": None, "max": None, "n": 0, "wtd": None},
            "forwardPE": {"median": None, "avg": None, "min": None, "max": None, "n": 0, "wtd": None},
            "peg": {"median": None, "avg": None, "min": None, "max": None, "n": 0},
            "debtEq": {"median": None, "avg": None, "min": None, "max": None, "n": 0},
            "marketCap": {"median": None, "avg": None, "min": None, "max": None, "n": 0, "total": None},
        }

    sum_pct = sum_ytd = sum_price = total_size = total_mc = 0.0
    pe_list: list[float] = []
    fpe_list: list[float] = []
    peg_list: list[float] = []
    de_list: list[float] = []
    mc_list: list[float] = []
    wtd_pe_num = wtd_pe_den = wtd_fpe_num = wtd_fpe_den = 0.0

    for s in stks:
        sum_pct   += s.get("pctChange", 0) or 0
        sum_ytd   += s.get("ytd", 0) or 0
        sum_price += s.get("price", 0) or 0
        total_size += s.get("size", 1) or 1
        pe  = s.get("pe");  fpe = s.get("forwardPE")
        peg = s.get("peg"); de  = s.get("debtEq")
        mc  = s.get("marketCap")
        if pe  and 0 < pe  < 10000: pe_list.append(pe)
        if fpe and 0 < fpe < 10000: fpe_list.append(fpe)
        if peg and 0 < peg < 10000: peg_list.append(peg)
        if de  and 0 < de  < 10000: de_list.append(de)
        if mc  and mc > 0:
            mc_list.append(mc); total_mc += mc
            if pe  and 0 < pe  < 10000: wtd_pe_num  += mc; wtd_pe_den  += mc / pe
            if fpe and 0 < fpe < 10000: wtd_fpe_num += mc; wtd_fpe_den += mc / fpe

    def _med(vals: list[float]) -> float | None:
        if not vals: return None
        s = sorted(vals); mid = len(s) // 2
        return round((s[mid] + s[mid - 1]) / 2, 2) if len(s) % 2 == 0 else round(s[mid], 2)

    def _stats(vals: list[float]) -> dict:
        if not vals:
            return {"median": None, "avg": None, "min": None, "max": None, "n": 0}
        return {"median": _med(vals), "avg": round(sum(vals) / len(vals), 2),
                "min": round(min(vals), 2), "max": round(max(vals), 2), "n": len(vals)}

    return {
        "count":     n,
        "avg_pct":   round(sum_pct / n, 4),
        "avg_ytd":   round(sum_ytd / n, 4),
        "avg_price": round(sum_price / n, 2),
        "total_size": round(total_size, 2),
        "pe":        {**_stats(pe_list),  "wtd": round(wtd_pe_num / wtd_pe_den, 2) if wtd_pe_den > 0 else None},
        "forwardPE": {**_stats(fpe_list), "wtd": round(wtd_fpe_num / wtd_fpe_den, 2) if wtd_fpe_den > 0 else None},
        "peg":       _stats(peg_list),
        "debtEq":    _stats(de_list),
        "marketCap": {**_stats(mc_list), "total": round(total_mc, 2) if total_mc else None},
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/api/market-data")
def get_market_data():
    # get_or_set coalesces concurrent misses → only ONE thread hits yfinance,
    # the rest wait and share the result (prevents thundering-herd refetch).
    return _cache.get_or_set("market_data", build_market_data)


@router.get("/api/volatility")
def get_volatility():
    """VIX-family "fear" indices for the TICK DATA board."""
    return _vol_cache.get_or_set("volatility", build_volatility_data)


@router.get("/api/heatmap")
def get_heatmap(group: str = Query("sectors")):
    """Return heatmap tiles for a named group: sectors | commodities | bonds | indicators."""
    valid_groups = get_heatmap_groups()
    if group not in valid_groups:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown group '{group}'. Valid: {valid_groups}",
        )

    cache_key = f"heatmap:{group}"

    def _build() -> dict:
        configs = get_symbol_list(f"heatmap_{group}")
        tiles: list[dict] = []

        with ThreadPoolExecutor(max_workers=8) as pool:
            future_to_cfg = {pool.submit(fetch_heatmap_item, cfg): cfg for cfg in configs}
            for future in as_completed(future_to_cfg):
                result = future.result()
                if result:
                    tiles.append(result)

        # Preserve the original config order
        order = {cfg["symbol"]: i for i, cfg in enumerate(configs)}
        tiles.sort(key=lambda x: order.get(x["symbol"], 999))
        return {"tiles": tiles, "group": group}

    # Coalesce concurrent misses for the same group (see get_market_data note).
    return _heatmap_cache.get_or_set(cache_key, _build)


@router.get("/api/heatmap/sector-detail")
def get_sector_detail(etf: str = Query("XLK"), limit: int = Query(10)):
    """Return top holdings + aggregate cluster metrics for a sector ETF."""
    cache_key = f"sector_detail:{etf.upper()}:{limit}"
    cached = _heatmap_cache.get(cache_key)
    if cached is not None:
        return cached

    # 1. Fetch ETF holdings
    holdings_raw: list[dict] = []
    sector_name = etf.upper()
    try:
        ticker = market_data.get_ticker(etf)
        fd = ticker.funds_data
        if fd is not None:
            th = fd.top_holdings
            if th is not None and not th.empty:
                for sym_h, row in th.iterrows():
                    holdings_raw.append({
                        "symbol": str(sym_h),
                        "name":   row.get("Name", str(sym_h)),
                        "weight": round(float(row.get("Holding Percent", 0)) * 100, 2),
                    })
        info = market_data.get_info(etf)
        sector_name = info.get("shortName") or info.get("longName", etf.upper())
    except Exception as exc:
        print(f"[sector-detail] holdings for {etf}: {exc}")

    if not holdings_raw:
        raise HTTPException(
            status_code=404,
            detail=f"No holdings data for ETF '{etf.upper()}'. The ETF may not publish holdings via yfinance.",
        )

    # Sort by weight desc, take top N
    holdings_raw.sort(key=lambda h: h["weight"], reverse=True)
    top = holdings_raw[:limit]

    # 2. Fetch per-stock metrics concurrently
    detailed: list[dict] = []
    with ThreadPoolExecutor(max_workers=min(limit, 15)) as pool:
        futures = {pool.submit(_fetch_holding_info, h["symbol"]): h for h in top}
        for future in as_completed(futures):
            h = futures[future]
            result = future.result()
            if result:
                result["weight"] = h["weight"]
                detailed.append(result)

    # Restore weight-sorted order
    detailed.sort(key=lambda d: d.get("weight", 0), reverse=True)

    # 3. Compute aggregate metrics
    aggregate = _compute_aggregates(detailed)

    data = {
        "etf":       etf.upper(),
        "sector":    sector_name,
        "holdings":  detailed,
        "aggregate": aggregate,
    }
    _heatmap_cache.set(cache_key, data)
    return data


def _fetch_lightweight_stock(holding: dict) -> dict | None:
    """Fetch only price + change for a stock (no P/E metrics)."""
    try:
        sym = holding["symbol"]
        info = market_data.get_info(sym)
        fi = market_data.get_fast_info(sym)
        price = info.get("regularMarketPrice") or fi.last_price or 0
        if not price or price == 0:
            return None
        ytd = compute_ytd(sym, price)
        return {
            "symbol":    sym,
            "id":        sym,
            "name":      info.get("shortName") or info.get("longName", sym),
            "price":     round(price, 2),
            "pctChange": round(info.get("regularMarketChangePercent", 0), 2),
            "ytd":       ytd,
            "size":      holding["weight"],
        }
    except Exception as exc:
        print(f"[sector-stocks] {holding['symbol']}: {exc}")
        return None


@router.get("/api/heatmap/sector-stocks")
def get_sector_stocks(etf: str = Query("XLK"), limit: int = Query(10)):
    """Return lightweight stock list for nested treemap tiles (no P/E metrics)."""
    cache_key = f"sector_stocks:{etf.upper()}:{limit}"
    cached = _heatmap_cache.get(cache_key)
    if cached is not None:
        return cached

    # 1. Fetch ETF holdings
    holdings_raw: list[dict] = []
    try:
        ticker = market_data.get_ticker(etf)
        fd = ticker.funds_data
        if fd is not None:
            th = fd.top_holdings
            if th is not None and not th.empty:
                for sym_h, row in th.iterrows():
                    holdings_raw.append({
                        "symbol": str(sym_h),
                        "weight": round(float(row.get("Holding Percent", 0)) * 100, 2),
                    })
    except Exception as exc:
        print(f"[sector-stocks] holdings for {etf}: {exc}")

    if not holdings_raw:
        return {"etf": etf.upper(), "stocks": []}

    holdings_raw.sort(key=lambda h: h["weight"], reverse=True)
    top = holdings_raw[:limit]

    # 2. Fetch price + change data concurrently
    stocks: list[dict] = []
    with ThreadPoolExecutor(max_workers=min(limit, 15)) as pool:
        futures = {pool.submit(_fetch_lightweight_stock, h): h for h in top}
        for future in as_completed(futures):
            result = future.result()
            if result:
                stocks.append(result)

    stocks.sort(key=lambda s: s.get("size", 0), reverse=True)

    data = {"etf": etf.upper(), "stocks": stocks}
    _heatmap_cache.set(cache_key, data)
    return data


# ── International Sectors ────────────────────────────────────────────────────

def _fetch_intl_stock(cfg: dict) -> dict | None:
    """Fetch price, change, and fundamental metrics for an international stock."""
    try:
        sym = cfg["symbol"]
        ticker = market_data.get_ticker(sym)
        fi = ticker.fast_info

        price = fi.last_price
        if price is None or price == 0:
            return None

        # Try ticker.info for richer data (PE, fwdPE, PEG, D/E, MCap)
        info: dict = {}
        try:
            info = ticker.info or {}
        except Exception:
            pass

        if info.get("regularMarketPrice"):
            price = info["regularMarketPrice"]

        prev = fi.previous_close or price
        change = round(price - prev, 4)
        pct_change = round((change / prev) * 100, 4) if prev else 0.0

        if info.get("regularMarketChangePercent") is not None:
            pct_change = round(info["regularMarketChangePercent"], 4)

        ytd = compute_ytd(sym, price)
        size = compute_size(fi)

        return {
            "symbol":    sym,
            "id":        cfg["id"],
            "name":      info.get("shortName") or info.get("longName", cfg["id"]),
            "sector":    cfg["sector"],
            "price":     round(price, 2),
            "pctChange": pct_change,
            "ytd":       ytd,
            "size":      size,
            # Fundamental metrics (for aggregate computation)
            "pe":        info.get("trailingPE"),
            "forwardPE": info.get("forwardPE"),
            "peg":       info.get("pegRatio"),
            "debtEq":    info.get("debtToEquity"),
            "marketCap": info.get("marketCap"),
        }
    except Exception as exc:
        print(f"[intl-sectors] {cfg['symbol']}: {exc}")
        return None


@router.get("/api/heatmap/intl-sectors")
def get_intl_sectors(country: str = Query("th")):
    """Return stocks grouped by sector for international markets (TH/CN/KR/EU).

    Response shape matches the US sectors nested treemap:
    - tiles: sector-level aggregates (for parent nodes)
    - stocks: per-sector stock lists (for child nodes)
    """
    country = country.lower()
    configs = INTL_SECTOR_STOCKS.get(country)
    if not configs:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown country '{country}'. Valid: {list(INTL_SECTOR_STOCKS.keys())}",
        )

    cache_key = f"intl_sectors:{country}"
    cached = _heatmap_cache.get(cache_key)
    if cached is not None:
        return cached

    # Fetch all stocks concurrently
    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=min(len(configs), 15)) as pool:
        futures = {pool.submit(_fetch_intl_stock, cfg): cfg for cfg in configs}
        for future in as_completed(futures):
            result = future.result()
            if result:
                results.append(result)

    # Group by sector
    from collections import defaultdict
    sector_stocks: dict[str, list[dict]] = defaultdict(list)
    for r in results:
        sector_stocks[r["sector"]].append(r)

    # Sort stocks within each sector by size desc
    for stocks in sector_stocks.values():
        stocks.sort(key=lambda s: s.get("size", 0), reverse=True)

    # Build sector-level aggregate tiles
    # Preserve sector order from config (first appearance)
    seen_order: list[str] = []
    for cfg in configs:
        if cfg["sector"] not in seen_order:
            seen_order.append(cfg["sector"])

    tiles: list[dict] = []
    stocks_map: dict[str, list[dict]] = {}
    aggregates_map: dict[str, dict] = {}
    for sector in seen_order:
        stks = sector_stocks.get(sector, [])
        if not stks:
            continue

        # AF-4: single-pass accumulator replaces 15+ separate list-comprehension passes
        agg = _single_pass_aggregates(stks)

        tiles.append({
            "id":        sector,
            "symbol":    sector,
            "value":     agg["avg_price"],
            "pctChange": agg["avg_pct"],
            "ytd":       agg["avg_ytd"],
            "size":      agg["total_size"],
            "count":     len(stks),
        })
        aggregates_map[sector] = agg

        # Map sector → stocks (include per-stock fundamentals + weight)
        total_size = agg["total_size"] or 1
        stocks_map[sector] = [
            {
                "symbol":    s["symbol"],
                "id":        s["id"],
                "name":      s.get("name", s["id"]),
                "price":     s["price"],
                "pctChange": s["pctChange"],
                "ytd":       s["ytd"],
                "size":      s.get("size", 1),
                "pe":        s.get("pe"),
                "forwardPE": s.get("forwardPE"),
                "peg":       s.get("peg"),
                "debtEq":    s.get("debtEq"),
                "marketCap": s.get("marketCap"),
                "weight":    round(s.get("size", 1) / total_size * 100, 2),
            }
            for s in stks
        ]

    data = {
        "tiles": tiles,
        "stocks": stocks_map,
        "aggregates": aggregates_map,
        "country": country,
    }
    _heatmap_cache.set(cache_key, data)
    return data
