"""
Sector Classification Router
Provides dynamic sector/industry data from SQLite, populated via Wikipedia + yfinance.

Endpoints:
  POST /api/sectors/fetch                    — fetch universe from Wikipedia + classify via yfinance
  GET  /api/sectors/status                   — coverage summary per country
  GET  /api/sectors/{country}                — all sectors for a country
  GET  /api/sectors/{country}/{sector}       — stocks in a sector
  GET  /api/sectors/search                   — search by symbol or company name
  PUT  /api/sectors/{symbol}/override        — manual sector override
  DELETE /api/sectors/{country}              — clear all classifications for a country
"""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import StreamingResponse

from db import get_db, get_sectors_by_country, get_stocks_in_sector, upsert_sector_classification
from sources import market_data

router = APIRouter()

# ── Wikipedia index source URLs ───────────────────────────────────────────────

WIKI_INDEX_URLS: dict[str, str] = {
    "SET50":    "https://en.wikipedia.org/wiki/List_of_SET_50_Index_components",
    "SET100":   "https://en.wikipedia.org/wiki/List_of_SET_100_Index_components",
    "KOSPI200": "https://en.wikipedia.org/wiki/KOSPI_200",
    "HSI":      "https://en.wikipedia.org/wiki/Hang_Seng_Index",
    "CSI300":   "https://en.wikipedia.org/wiki/CSI_300_Index",
    "STOXX600": "https://en.wikipedia.org/wiki/EURO_STOXX_600",
    "DAX40":    "https://en.wikipedia.org/wiki/DAX",
    "CAC40":    "https://en.wikipedia.org/wiki/CAC_40",
    "FTSE100":  "https://en.wikipedia.org/wiki/FTSE_100_Index",
    "SP500":    "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
}

# Exchange suffix appended when Wikipedia gives bare tickers
COUNTRY_EXCHANGE_SUFFIX: dict[str, str] = {
    "TH":    ".BK",
    "KR":    ".KS",
    "HK":    ".HK",
    "CN_SS": ".SS",
    "CN_SZ": ".SZ",
}

# ── Exchange suffix → exchange name ───────────────────────────────────────────

_SUFFIX_TO_EXCHANGE: dict[str, str] = {
    ".BK": "SET",   ".KS": "KRX",   ".KQ": "KOSDAQ",
    ".HK": "HKEX",  ".SS": "SSE",   ".SZ": "SZSE",
    ".DE": "XETRA", ".PA": "EPA",   ".L":  "LSE",
    ".AS": "AMS",   ".SW": "SIX",   ".MI": "BIT",
    ".OL": "OSE",   ".CO": "CSE",
}


def _symbol_to_exchange(symbol: str) -> str | None:
    for suffix, exchange in _SUFFIX_TO_EXCHANGE.items():
        if symbol.endswith(suffix):
            return exchange
    return "NYSE/NASDAQ"


# ── Wikipedia fetcher ─────────────────────────────────────────────────────────

def _fetch_index_universe(country: str, index: str) -> list[dict]:
    """
    Scrape constituent list from a Wikipedia index page.
    Returns [{"symbol": "PTT.BK", "name": "PTT PCL", "sector_wiki": "Energy",
              "index_tag": "SET50"}, ...]
    Falls back to [] if table not found — caller should handle gracefully.
    """
    try:
        import pandas as pd
    except ImportError:
        return []

    url = WIKI_INDEX_URLS.get(index)
    if not url:
        return []

    try:
        tables = pd.read_html(url, flavor="lxml")
    except Exception:
        try:
            tables = pd.read_html(url)
        except Exception as e:
            print(f"[sectors] Wikipedia fetch failed for {index}: {e}")
            return []

    suffix = COUNTRY_EXCHANGE_SUFFIX.get(country, "")

    for df in tables:
        cols_lower = {str(c).lower().strip(): str(c) for c in df.columns}

        # Find symbol column
        sym_col = None
        for candidate in ["ticker", "symbol", "code", "stock code", "ticker symbol",
                           "sgx code", "ric", "bloomberg code"]:
            if candidate in cols_lower:
                sym_col = cols_lower[candidate]
                break
        if sym_col is None:
            continue

        # Find name column (optional)
        name_col = None
        for candidate in ["company", "name", "security", "company name",
                           "constituent", "company / name"]:
            if candidate in cols_lower:
                name_col = cols_lower[candidate]
                break

        # Find sector column (optional)
        sector_col = None
        for candidate in ["sector", "gics sector", "industry", "industry group",
                           "gics sub-industry"]:
            if candidate in cols_lower:
                sector_col = cols_lower[candidate]
                break

        results = []
        for _, row in df.iterrows():
            raw_sym = str(row[sym_col]).strip()
            if not raw_sym or raw_sym.lower() in ("nan", "-", "n/a", ""):
                continue
            # Add exchange suffix if bare ticker
            sym = raw_sym if "." in raw_sym else f"{raw_sym}{suffix}"
            results.append({
                "symbol":      sym,
                "name":        str(row[name_col]).strip() if name_col else "",
                "sector_wiki": str(row[sector_col]).strip() if sector_col else None,
                "index_tag":   index,
            })

        if results:
            return results

    print(f"[sectors] No usable table found for {index} on Wikipedia")
    return []


# ── yfinance classifier ───────────────────────────────────────────────────────

def _classify_one(stock: dict, country: str, force: bool) -> str:
    """
    Fetch yfinance sector info for one stock and upsert to DB.
    Returns "ok" | "error" | "skipped"
    """
    symbol = stock["symbol"]

    if not force:
        with get_db() as conn:
            row = conn.execute(
                "SELECT last_fetched FROM sector_classifications WHERE symbol = ? AND country = ?",
                (symbol, country),
            ).fetchone()
            if row and row["last_fetched"]:
                try:
                    days_old = (date.today() - date.fromisoformat(row["last_fetched"])).days
                    if days_old < 7:
                        return "skipped"
                except ValueError:
                    pass

    try:
        info = market_data.get_info(symbol)
        sector   = info.get("sector")
        industry = info.get("industry")
        mcap     = info.get("marketCap")
        name     = info.get("shortName") or info.get("longName") or stock.get("name", "")

        if not sector and not name:
            upsert_sector_classification(symbol, country, {
                "source":       "yfinance",
                "last_fetched": date.today().isoformat(),
                "fetch_error":  "no_sector_data",
            })
            return "error"

        upsert_sector_classification(symbol, country, {
            "exchange":      _symbol_to_exchange(symbol),
            "sector_gics":   sector,
            "industry_gics": industry,
            "sector_display": sector,
            "company_name":  name,
            "market_cap":    mcap,
            "index_tags":    stock.get("index_tag"),
            "source":        "yfinance",
            "last_fetched":  date.today().isoformat(),
            "fetch_error":   None,
        })
        return "ok"

    except Exception as e:
        upsert_sector_classification(symbol, country, {
            "source":       "yfinance",
            "last_fetched": date.today().isoformat(),
            "fetch_error":  str(e)[:200],
        })
        return "error"


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/api/sectors/fetch")
def fetch_sector_classifications(  # sync: heavy blocking Wikipedia+yfinance (1-3 min) — must run in threadpool, never on event loop
    country: str  = Body(...),
    index: str    = Body(...),
    force: bool   = Body(False),
):
    """
    Fetch constituent list from Wikipedia, then classify each symbol via yfinance.
    Workers: 20 concurrent yfinance calls (~1-3 min for 50-300 stocks).
    """
    symbols = _fetch_index_universe(country, index)
    if not symbols:
        # Return 200 with empty — caller decides whether to fallback
        return {
            "country": country, "index": index,
            "total": 0, "ok": 0, "error": 0, "skipped": 0,
            "warning": f"No symbols found for {index} — Wikipedia table may not be available",
        }

    results = {"ok": 0, "error": 0, "skipped": 0}
    workers = min(len(symbols), 20)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_classify_one, s, country, force): s for s in symbols}
        for future in as_completed(futures):
            outcome = future.result()
            results[outcome] = results.get(outcome, 0) + 1

    return {
        "country": country,
        "index":   index,
        "total":   len(symbols),
        **results,
    }


@router.get("/api/sectors/status")
def classification_status():
    """Coverage summary per country."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT
                country,
                COUNT(*)                                                   AS total_stocks,
                COUNT(CASE WHEN sector_gics   IS NOT NULL THEN 1 END)     AS classified,
                COUNT(CASE WHEN fetch_error   IS NOT NULL THEN 1 END)     AS errors,
                COUNT(DISTINCT sector_display)                             AS sector_count,
                MAX(last_fetched)                                          AS last_updated
            FROM sector_classifications
            GROUP BY country
            ORDER BY country
        """).fetchall()
    return {"countries": [dict(r) for r in rows]}


@router.get("/api/sectors/search")
def search_sectors(
    q:       str = Query(..., min_length=1),
    country: str = Query(None),
    limit:   int = Query(20),
):
    """Search stocks by symbol or company name."""
    pattern = f"%{q.upper()}%"
    where   = "(UPPER(symbol) LIKE ? OR UPPER(company_name) LIKE ?)"
    params  = [pattern, pattern]

    if country:
        where  += " AND country = ?"
        params.append(country.upper())

    with get_db() as conn:
        rows = conn.execute(f"""
            SELECT symbol, company_name, sector_display, industry_gics,
                   country, exchange, market_cap, index_tags
            FROM sector_classifications
            WHERE {where}
            ORDER BY market_cap DESC
            LIMIT ?
        """, params + [limit]).fetchall()

    return {"results": [dict(r) for r in rows], "count": len(rows)}


@router.get("/api/sectors/{country}")
def get_country_sectors(country: str):
    """All sectors for a country with stock counts."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT
                sector_display,
                COUNT(*)          AS stock_count,
                SUM(market_cap)   AS total_mcap,
                MAX(last_fetched) AS last_updated
            FROM sector_classifications
            WHERE country = ? AND sector_display IS NOT NULL
              AND fetch_error IS NULL
            GROUP BY sector_display
            ORDER BY total_mcap DESC
        """, (country.upper(),)).fetchall()

    if not rows:
        raise HTTPException(404, f"No sector data for country '{country}'. Run POST /api/sectors/fetch first.")

    return {
        "country": country.upper(),
        "sectors": [dict(r) for r in rows],
    }


@router.get("/api/sectors/{country}/{sector}")
def get_sector_stocks_endpoint(
    country: str,
    sector:  str,
    limit:   int = Query(30),
    index:   str = Query(None),
):
    """Stocks in a sector, ranked by market cap descending."""
    where  = "country = ? AND sector_display = ? AND fetch_error IS NULL"
    params: list = [country.upper(), sector]

    if index:
        where  += " AND index_tags LIKE ?"
        params.append(f"%{index}%")

    with get_db() as conn:
        rows = conn.execute(f"""
            SELECT symbol, company_name, industry_gics,
                   market_cap, exchange, index_tags, last_fetched
            FROM sector_classifications
            WHERE {where}
            ORDER BY market_cap DESC
            LIMIT ?
        """, params + [limit]).fetchall()

    return {
        "country": country.upper(),
        "sector":  sector,
        "stocks":  [dict(r) for r in rows],
        "count":   len(rows),
    }


@router.put("/api/sectors/{symbol}/override")
def override_sector(
    symbol:         str,
    country:        str = Body(...),
    sector_display: str = Body(...),
    sector_local:   str = Body(None),
):
    """Manual override for a stock's sector classification."""
    with get_db() as conn:
        updated = conn.execute("""
            UPDATE sector_classifications
            SET sector_display = ?,
                sector_local   = ?,
                source         = 'manual',
                updated_at     = datetime('now')
            WHERE symbol = ? AND country = ?
        """, (sector_display, sector_local, symbol, country)).rowcount

    if not updated:
        raise HTTPException(404, f"{symbol} not found for country {country}")

    return {"symbol": symbol, "country": country, "sector_display": sector_display}


@router.delete("/api/sectors/{country}")
def clear_country_classifications(country: str):
    """Remove all sector classifications for a country (use before re-seeding)."""
    with get_db() as conn:
        deleted = conn.execute(
            "DELETE FROM sector_classifications WHERE country = ?",
            (country.upper(),),
        ).rowcount
    return {"country": country.upper(), "deleted": deleted}
