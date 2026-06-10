"""
S&P 500 screener — constituent list + GICS sector classification from Wikipedia.

Data source: https://en.wikipedia.org/wiki/List_of_S%26P_500_companies
GICS = Global Industry Classification Standard (MSCI/S&P, same as Bloomberg).
The Wikipedia table is maintained by the community and updated quarterly.
"""
import pandas as pd
from fastapi import APIRouter, HTTPException

from cache import TTLCache

router = APIRouter()

# Single daily-refresh cache for the whole S&P 500 dataset
_sp500_cache = TTLCache(ttl=86400, maxsize=1)

# Known symbol mappings: Wikipedia dot notation → yfinance dash notation
_SYMBOL_FIXES = {"BRK.B": "BRK-B", "BF.B": "BF-B"}

_WIKI_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"


def _fetch_sp500() -> dict:
    """Fetch and parse the S&P 500 constituent table from Wikipedia."""
    cached = _sp500_cache.get("sp500")
    if cached is not None:
        return cached

    try:
        dfs = pd.read_html(_WIKI_URL, attrs={"id": "constituents"})
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch S&P 500 data from Wikipedia: {exc}",
        )

    if not dfs:
        raise HTTPException(status_code=502, detail="S&P 500 table not found on Wikipedia")

    df = dfs[0]

    # Normalize column names
    expected_cols = ["Symbol", "Security", "GICS Sector", "GICS Sub-Industry"]
    missing = [c for c in expected_cols if c not in df.columns]
    if missing:
        raise HTTPException(
            status_code=502,
            detail=f"Wikipedia table structure changed — missing columns: {missing}",
        )

    # Fix symbols that use dots (BRK.B → BRK-B for yfinance compatibility)
    df["Symbol"] = df["Symbol"].apply(lambda s: _SYMBOL_FIXES.get(str(s), str(s)))

    # Build sector → constituents mapping
    by_sector = {}
    for sector, group in df.groupby("GICS Sector"):
        by_sector[sector] = group[["Symbol", "Security", "GICS Sub-Industry"]].to_dict("records")

    sectors_list = sorted(by_sector.keys())

    result = {
        "sectors": by_sector,
        "sectors_list": sectors_list,
        "constituents": df[expected_cols].rename(
            columns={"GICS Sector": "sector", "GICS Sub-Industry": "subIndustry", "Security": "name"}
        ).assign(symbol=df["Symbol"])[["symbol", "name", "sector", "subIndustry"]].to_dict("records"),
        "count": len(df),
    }
    _sp500_cache.set("sp500", result)
    return result


@router.get("/api/screener/sp500")
def sp500_full():
    """Full S&P 500: all constituents grouped by GICS sector."""
    return _fetch_sp500()


@router.get("/api/screener/sp500/sectors")
def sp500_sectors():
    """List of unique GICS sector names in the S&P 500."""
    data = _fetch_sp500()
    return {"sectors": data["sectors_list"], "count": len(data["sectors_list"])}


@router.get("/api/screener/sp500/{sector}")
def sp500_by_sector(sector: str):
    """Constituents of a specific GICS sector (case-insensitive prefix match)."""
    data = _fetch_sp500()
    by_sector = data["sectors"]

    # Exact match
    if sector in by_sector:
        return {"sector": sector, "constituents": by_sector[sector], "count": len(by_sector[sector])}

    # Case-insensitive match
    sector_lower = sector.lower()
    for name, constituents in by_sector.items():
        if name.lower() == sector_lower:
            return {"sector": name, "constituents": constituents, "count": len(constituents)}

    # Suggest closest sectors
    available = sorted(by_sector.keys())
    raise HTTPException(
        status_code=404,
        detail=f"Sector '{sector}' not found. Available: {available}",
    )
