"""
Stock-related endpoints — search, quote, history, financials, analyst, etc.
Extracted from main.py as part of the FastAPI router refactoring.
"""
import re
from datetime import datetime
from typing import Any

import pandas as pd
import requests
from fastapi import APIRouter, HTTPException, Query

from cache import TTLCache
from config import STOCK_CACHE_TTL, MAX_HISTORY_CACHE_TTL, PERIOD_TO_YF, HISTORY_PERIOD_MAP, VALID_INTERVALS
from market_session import is_today_at, local_date_of
from sources import market_data

_DETAIL_TTL = 3600  # 1 hour — financials, events, SEC filings

router = APIRouter()

# ── Module-level cache ────────────────────────────────────────────────────────
_stock_cache = TTLCache(ttl=STOCK_CACHE_TTL, maxsize=500)

_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search"


# ── Helper functions ──────────────────────────────────────────────────────────

def _safe_float(val: Any) -> float | None:
    """Safe float conversion handling None and NaN."""
    try:
        return float(val) if val is not None and not pd.isna(val) else None
    except Exception:
        return None


def _get_df(ticker: Any, *attrs: str) -> Any:
    """Return the first non-empty DataFrame found among the given attribute names."""
    for attr in attrs:
        try:
            df = getattr(ticker, attr, None)
            if df is not None and not df.empty:
                return df
        except Exception:
            pass
    return None


def _parse_income(df: Any) -> list[dict]:
    """Parse income statement columns."""
    if df is None or df.empty:
        return []
    rows = []
    for col in df.columns:
        s = df[col]
        rows.append({
            "endDate":      col.strftime("%Y-%m-%d"),
            "totalRevenue": _safe_float(s.get("Total Revenue")),
            "grossProfit":  _safe_float(s.get("Gross Profit")),
            "netIncome":    _safe_float(s.get("Net Income")),
            "basicEPS":     _safe_float(s.get("Basic EPS")),
        })
    return rows


def _parse_cashflow(df: Any) -> list[dict]:
    """Parse cashflow columns."""
    if df is None or df.empty:
        return []
    rows = []
    for col in df.columns:
        s = df[col]
        rows.append({
            "endDate":      col.strftime("%Y-%m-%d"),
            "freeCashflow": _safe_float(s.get("Free Cash Flow")),
        })
    return rows


def _parse_balance_sheet(df: Any) -> list[dict]:
    """Parse balance sheet with all fields."""
    if df is None or df.empty:
        return []
    rows = []
    for col in df.columns:
        s = df[col]
        rows.append({
            "endDate":               col.strftime("%Y-%m-%d"),
            "totalAssets":           _safe_float(s.get("Total Assets")),
            "totalLiabilities":      _safe_float(s.get("Total Liabilities Net Minority Interest")),
            "stockholdersEquity":    _safe_float(s.get("Stockholders Equity")),
            "totalDebt":             _safe_float(s.get("Total Debt")),
            "netDebt":               _safe_float(s.get("Net Debt")),
            "cash":                  _safe_float(s.get("Cash And Cash Equivalents")),
            "shortTermInvestments":  _safe_float(s.get("Other Short Term Investments")),
            "currentAssets":         _safe_float(s.get("Current Assets")),
            "currentLiabilities":    _safe_float(s.get("Current Liabilities")),
            "workingCapital":        _safe_float(s.get("Working Capital")),
            "retainedEarnings":      _safe_float(s.get("Retained Earnings")),
            "commonStock":           _safe_float(s.get("Common Stock")),
            "investedCapital":       _safe_float(s.get("Invested Capital")),
            "tangibleBookValue":     _safe_float(s.get("Tangible Book Value")),
            "sharesIssued":          _safe_float(s.get("Share Issued")),
            "ordinaryShares":        _safe_float(s.get("Ordinary Shares Number")),
            "inventory":             _safe_float(s.get("Inventory")),
            "accountsReceivable":    _safe_float(s.get("Receivables")),
            "accountsPayable":       _safe_float(s.get("Payables And Accrued Expenses")),
            "goodwill":              _safe_float(s.get("Goodwill")),
            "intangibleAssets":      _safe_float(s.get("Net Intangible Assets")),
            "capitalLeaseObligations": _safe_float(s.get("Capital Lease Obligations")),
        })
    return rows


# ══════════════════════════════════════════════════════════════════════════════
# ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════


# ── Stock Search (MUST be above /api/stock/{symbol}) ─────────────────────────

@router.get("/api/stock/search")
def stock_search(q: str = Query(..., min_length=1)):
    """
    Ticker search — MUST be declared before /api/stock/{symbol} so FastAPI
    matches the static path 'search' before the dynamic {symbol} catch-all.

    Root-cause note: yf.Search().quotes returns yfinance proxy objects, not plain dicts.
    FastAPI serializes the return value *after* our function returns, so any KeyError
    raised inside those objects (e.g. 'currentTradingPeriod') escapes the try/except.
    Fix: convert every item to a plain str-keyed dict *before* returning.
    """

    def _with_display(entry: dict) -> dict:
        """Central display normalisation: hide exchange suffixes and strip the
        duplicated ticker prefix Yahoo puts on Thai names
        ("BH.BK – BH_BUMRUNGRAD HOSPITAL" → "BH – BUMRUNGRAD HOSPITAL")."""
        sym = entry["symbol"]
        base = sym.split(".")[0]
        name = entry.get("shortname") or entry.get("longname") or ""
        if name.upper().startswith(f"{base.upper()}_"):
            name = name[len(base) + 1:]
        entry["display_symbol"] = base if sym.upper().endswith(".BK") else sym
        entry["display_name"] = name.strip()
        return entry

    def _normalise(items: list) -> list[dict]:
        out = []
        for item in items:
            try:
                # After data-source-contract: market_data.search() returns list[SearchResult]
                # (dataclass), not list[dict]. dict(dataclass) raises TypeError.
                # Use getattr for dataclass objects; fall back to dict access for plain dicts.
                if isinstance(item, dict):
                    d = item
                else:
                    d = {
                        "symbol":    str(getattr(item, "symbol",     "") or ""),
                        "shortname": str(getattr(item, "short_name", "") or ""),
                        "longname":  str(getattr(item, "long_name",  "") or ""),
                        "exchDisp":  str(getattr(item, "exchange",   "") or ""),
                        "typeDisp":  str(getattr(item, "quote_type", "") or ""),
                    }
                sym = str(d.get("symbol") or d.get("Symbol") or "").strip()
                if not sym:
                    continue
                out.append(_with_display({
                    "symbol":    sym,
                    "shortname": str(d.get("shortname") or d.get("shortName") or ""),
                    "longname":  str(d.get("longname")  or d.get("longName")  or ""),
                    "exchDisp":  str(d.get("exchDisp")  or d.get("exchange")  or ""),
                    "typeDisp":  str(d.get("typeDisp")  or d.get("quoteType") or ""),
                }))
            except Exception:
                pass
        return out

    def _add_suffix_probes(results: list[dict]) -> list[dict]:
        """Bare-ticker queries never surface Thai listings from Yahoo's search
        relevance — probe {q}.BK explicitly and append the exact match so the
        user can type BH instead of BH.BK."""
        if not re.fullmatch(r"[A-Za-z0-9]{1,8}", q):
            return results
        cand = f"{q.upper()}.BK"
        if any(r["symbol"].upper() == cand for r in results):
            return results
        try:
            probe = _normalise(market_data.search(cand, max_results=3))
            exact = next((r for r in probe if r["symbol"].upper() == cand), None)
            if exact:
                # Thai match goes right after the first exact bare-symbol hit
                # (if any) so it's visible without scrolling
                pos = next(
                    (i + 1 for i, r in enumerate(results) if r["symbol"].upper() == q.upper()),
                    0,
                )
                results.insert(pos, exact)
        except Exception:
            pass
        return results

    # ── Primary: yfinance.Search ──────────────────────────────────────────────
    try:
        raw_quotes = market_data.search(q, max_results=10)  # returns list[dict]
        result     = _add_suffix_probes(_normalise(raw_quotes))
        if result:
            return result
    except Exception as exc:
        print(f"[search/yf] {q}: {exc}")

    # ── Fallback: Yahoo Finance REST API ─────────────────────────────────────
    _headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept":     "application/json",
        "Referer":    "https://finance.yahoo.com",
    }
    for base in (
        "https://query2.finance.yahoo.com/v1/finance/search",
        "https://query1.finance.yahoo.com/v1/finance/search",
    ):
        try:
            res    = requests.get(
                base,
                params={"q": q, "quotesCount": 8, "newsCount": 0, "listsCount": 0},
                headers=_headers,
                timeout=6,
            )
            data   = res.json()
            result_block = ((data.get("finance", {}).get("result") or [{}])[0])
            quotes = result_block.get("quotes", [])
            result = _add_suffix_probes(_normalise(quotes))
            if result:
                return result
        except Exception as exc:
            print(f"[search/http:{base}] {q}: {exc}")

    return []


# ── Earnings Quality Monitor (Layer 2) — MUST be above /{symbol} catch-all ───

@router.get("/api/stock/quality/{symbol}")
def get_stock_quality(symbol: str):
    """
    Layer 2 — Earnings Quality Monitor.
    Returns Sloan Accrual Ratio, Beneish M-Score, Piotroski F-Score, and
    a composite quality score (0-100) with a traffic-light flag.
    """
    cache_key = f"quality:{symbol.upper()}"
    cached = _stock_cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        ticker = market_data.get_ticker(symbol.upper())

        # ── Raw DataFrames ────────────────────────────────────────────────────
        inc = _get_df(ticker, "financials", "income_stmt")
        cf  = _get_df(ticker, "cashflow")
        bs  = _get_df(ticker, "balance_sheet")

        if inc is None or cf is None or bs is None:
            raise HTTPException(status_code=422, detail="Insufficient financial data")

        # Helper: safe column value
        def _g(df: Any, row: str, col_idx: int) -> float | None:
            try:
                cols = df.columns
                if col_idx >= len(cols):
                    return None
                return _safe_float(df.loc[row, cols[col_idx]])
            except Exception:
                return None

        # ── 2A Sloan Accrual Ratio ────────────────────────────────────────────
        ni_0  = _g(inc, "Net Income", 0)
        cfo_0 = _g(cf,  "Operating Cash Flow", 0) or _g(cf, "Cash Flow From Continuing Operating Activities", 0)
        ta_0  = _g(bs,  "Total Assets", 0)
        ta_1  = _g(bs,  "Total Assets", 1)
        accrual_ratio: float | None = None
        if all(v is not None for v in [ni_0, cfo_0, ta_0, ta_1]) and (ta_0 + ta_1) != 0:  # type: ignore[operator]
            avg_ta = (ta_0 + ta_1) / 2  # type: ignore[operator]
            accrual_ratio = round((ni_0 - cfo_0) / avg_ta * 100, 2)  # type: ignore[operator]

        # Accrual score: lower accrual → higher quality
        def _accrual_score(ar: float | None) -> float:
            if ar is None: return 50.0
            if ar < 5:   return 100.0
            if ar < 10:  return 80.0 - (ar - 5) * 4
            if ar < 15:  return 60.0 - (ar - 10) * 4
            return max(40.0 - (ar - 15) * 2, 0.0)

        # ── 2B Beneish M-Score (8-variable) ──────────────────────────────────
        rev_0  = _g(inc, "Total Revenue", 0)
        rev_1  = _g(inc, "Total Revenue", 1)
        cogs_0 = _g(inc, "Cost Of Revenue", 0)
        cogs_1 = _g(inc, "Cost Of Revenue", 1)
        rec_0  = _g(bs,  "Receivables", 0)
        rec_1  = _g(bs,  "Receivables", 1)
        ca_0   = _g(bs,  "Current Assets", 0)
        ca_1   = _g(bs,  "Current Assets", 1)
        ppe_0  = _g(bs,  "Net PPE", 0)
        ppe_1  = _g(bs,  "Net PPE", 1)
        dep_0  = _g(cf,  "Depreciation And Amortization", 0) or _g(cf, "Depreciation Amortization Depletion", 0)
        dep_1  = _g(cf,  "Depreciation And Amortization", 1) or _g(cf, "Depreciation Amortization Depletion", 1)
        sga_0  = _g(inc, "Selling General Administrative", 0)
        sga_1  = _g(inc, "Selling General Administrative", 1)
        ltd_0  = _g(bs,  "Long Term Debt", 0)
        ltd_1  = _g(bs,  "Long Term Debt", 1)
        cl_0   = _g(bs,  "Current Liabilities", 0)
        cl_1   = _g(bs,  "Current Liabilities", 1)

        m_score: float | None = None
        m_vars: dict[str, float | None] = {}
        try:
            dsri = ((rec_0 / rev_0) / (rec_1 / rev_1)) if all(v and v != 0 for v in [rec_0, rev_0, rec_1, rev_1]) else None
            gm_0 = ((rev_0 - cogs_0) / rev_0) if rev_0 and cogs_0 is not None else None
            gm_1 = ((rev_1 - cogs_1) / rev_1) if rev_1 and cogs_1 is not None else None
            gmi  = (gm_1 / gm_0) if gm_0 and gm_1 and gm_0 != 0 else None
            nca_0 = (1 - (ca_0 + ppe_0) / ta_0) if all(v is not None for v in [ca_0, ppe_0, ta_0]) and ta_0 else None
            nca_1 = (1 - (ca_1 + ppe_1) / ta_1) if all(v is not None for v in [ca_1, ppe_1, ta_1]) and ta_1 else None
            aqi  = (nca_0 / nca_1) if nca_1 and nca_1 != 0 and nca_0 is not None else None
            sgi  = (rev_0 / rev_1) if rev_1 and rev_1 != 0 and rev_0 is not None else None
            dr_0 = (dep_0 / (ppe_0 + dep_0)) if all(v is not None and v != 0 for v in [dep_0]) and ppe_0 is not None and (ppe_0 + dep_0) != 0 else None
            dr_1 = (dep_1 / (ppe_1 + dep_1)) if all(v is not None and v != 0 for v in [dep_1]) and ppe_1 is not None and (ppe_1 + dep_1) != 0 else None
            depi = (dr_1 / dr_0) if dr_0 and dr_0 != 0 and dr_1 is not None else None
            sgai = ((sga_0 / rev_0) / (sga_1 / rev_1)) if all(v and v != 0 for v in [sga_0, rev_0, sga_1, rev_1]) else None
            tata = ((ni_0 - cfo_0) / ta_0) if ta_0 and ta_0 != 0 and ni_0 is not None and cfo_0 is not None else None
            lev_0 = ((ltd_0 + cl_0) / ta_0) if all(v is not None for v in [ltd_0, cl_0, ta_0]) and ta_0 else None
            lev_1 = ((ltd_1 + cl_1) / ta_1) if all(v is not None for v in [ltd_1, cl_1, ta_1]) and ta_1 else None
            lvgi  = (lev_0 / lev_1) if lev_1 and lev_1 != 0 and lev_0 is not None else None

            m_vars = {"dsri": dsri, "gmi": gmi, "aqi": aqi, "sgi": sgi,
                      "depi": depi, "sgai": sgai, "tata": tata, "lvgi": lvgi}

            # Compute M-Score using only available variables (adjust intercept proportionally)
            coeffs = {"dsri": 0.920, "gmi": 0.528, "aqi": 0.404, "sgi": 0.892,
                      "depi": 0.115, "sgai": -0.172, "tata": 4.679, "lvgi": -0.327}
            available = {k: v for k, v in m_vars.items() if v is not None}
            if len(available) >= 4:
                m_raw = -4.84 + sum(coeffs[k] * v for k, v in available.items())
                m_score = round(m_raw, 3)
        except Exception:
            pass

        # M-Score to quality score: lower (more negative) = higher quality
        def _beneish_score(m: float | None) -> float:
            if m is None: return 50.0
            if m < -2.22: return 90.0
            if m < -1.78: return 65.0
            if m < -1.00: return 40.0
            return 15.0

        # ── 2C Piotroski F-Score ──────────────────────────────────────────────
        ni_1   = _g(inc, "Net Income", 1)
        ta_2   = _g(bs,  "Total Assets", 2)
        cfo_1  = _g(cf,  "Operating Cash Flow", 1) or _g(cf, "Cash Flow From Continuing Operating Activities", 1)
        cl_2   = _g(bs,  "Current Liabilities", 2)
        ca_2   = _g(bs,  "Current Assets", 2)
        ltd_2  = _g(bs,  "Long Term Debt", 2)
        shares_0 = _g(bs, "Ordinary Shares Number", 0) or _g(bs, "Share Issued", 0)
        shares_1 = _g(bs, "Ordinary Shares Number", 1) or _g(bs, "Share Issued", 1)
        gp_0   = _g(inc, "Gross Profit", 0)
        gp_1   = _g(inc, "Gross Profit", 1)

        f_signals: dict[str, bool | None] = {}
        roa_0 = (ni_0 / ta_1) if ni_0 is not None and ta_1 else None
        roa_1 = (ni_1 / ta_2) if ni_1 is not None and ta_2 else None

        f_signals["F1_ROA"]       = (roa_0 > 0) if roa_0 is not None else None
        f_signals["F2_CFO"]       = (cfo_0 > 0) if cfo_0 is not None else None
        f_signals["F3_dROA"]      = (roa_0 > roa_1) if roa_0 is not None and roa_1 is not None else None
        f_signals["F4_Accrual"]   = ((cfo_0 / ta_1) > roa_0) if cfo_0 is not None and ta_1 and roa_0 is not None else None
        lev_now  = (ltd_0 / ((ta_0 + ta_1) / 2)) if ta_0 and ta_1 and ltd_0 is not None else None
        lev_prev = (ltd_1 / ((ta_1 + ta_2) / 2)) if ta_1 and ta_2 and ltd_1 is not None else None
        f_signals["F5_Leverage"]  = (lev_now < lev_prev) if lev_now is not None and lev_prev is not None else None
        cr_0 = (ca_0 / cl_0) if ca_0 and cl_0 else None
        cr_1 = (ca_1 / cl_1) if ca_1 and cl_1 else None
        f_signals["F6_Liquidity"] = (cr_0 > cr_1) if cr_0 is not None and cr_1 is not None else None
        f_signals["F7_Dilution"]  = (shares_0 <= shares_1) if shares_0 is not None and shares_1 is not None else None
        gm_now  = (gp_0 / rev_0) if gp_0 is not None and rev_0 else None
        gm_prev = (gp_1 / rev_1) if gp_1 is not None and rev_1 else None
        f_signals["F8_GrossMargin"] = (gm_now > gm_prev) if gm_now is not None and gm_prev is not None else None
        at_0 = (rev_0 / ta_1) if rev_0 is not None and ta_1 else None
        at_1 = (rev_1 / ta_2) if rev_1 is not None and ta_2 else None
        f_signals["F9_AssetTurn"]  = (at_0 > at_1) if at_0 is not None and at_1 is not None else None

        f_score = sum(1 for v in f_signals.values() if v is True)
        f_total = sum(1 for v in f_signals.values() if v is not None)

        piotroski_score = round((f_score / 9) * 100, 1)

        # ── Composite Quality Score ───────────────────────────────────────────
        accrual_q = _accrual_score(accrual_ratio)
        beneish_q = _beneish_score(m_score)
        quality_score = round(accrual_q * 0.30 + beneish_q * 0.40 + piotroski_score * 0.30, 1)

        if quality_score >= 70:
            flag = "GREEN"
        elif quality_score >= 50:
            flag = "YELLOW"
        elif quality_score >= 30:
            flag = "ORANGE"
        else:
            flag = "RED"

        result = {
            "symbol": symbol.upper(),
            "accrual": {
                "ratio":    accrual_ratio,
                "score":    round(accrual_q, 1),
                "level":    "NORMAL" if accrual_ratio is not None and accrual_ratio < 5
                            else "WATCH" if accrual_ratio is not None and accrual_ratio < 10
                            else "ALERT" if accrual_ratio is not None and accrual_ratio < 15
                            else "SEVERE" if accrual_ratio is not None else "N/A",
            },
            "beneish": {
                "m_score":  m_score,
                "score":    round(beneish_q, 1),
                "level":    "NOT_MANIPULATED" if m_score is not None and m_score < -2.22
                            else "GRAY_ZONE" if m_score is not None and m_score < -1.78
                            else "LIKELY_MANIPULATED" if m_score is not None else "N/A",
                "variables": {k: round(v, 4) if v is not None else None for k, v in m_vars.items()},
            },
            "piotroski": {
                "f_score":  f_score,
                "f_total":  f_total,
                "score":    piotroski_score,
                "level":    "STRONG" if f_score >= 7 else "NEUTRAL" if f_score >= 3 else "DISTRESS",
                "signals":  {k: v for k, v in f_signals.items()},
            },
            "overall_quality_score": quality_score,
            "flag": flag,
            "as_of": datetime.utcnow().isoformat() + "Z",
        }

        _stock_cache.set(cache_key, result)
        return result

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


# ── Stock Detail (dynamic {symbol} catch-all) ────────────────────────────────

@router.get("/api/stock/{symbol}")
def get_stock(symbol: str, period: str = "6mo"):
    """Fetch quote + price history for a single stock/index symbol."""
    VALID_PERIODS = {"1mo", "3mo", "6mo", "1y", "ytd"}
    if period not in VALID_PERIODS:
        period = "6mo"

    cache_key = f"{symbol.upper()}:{period}"
    cached = _stock_cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        ticker = market_data.get_ticker(symbol)
        fi = ticker.fast_info

        price = fi.last_price
        if price is None:
            raise HTTPException(status_code=404, detail=f"Symbol '{symbol}' not found or has no price data")

        prev_close = fi.previous_close or price
        change = round(price - prev_close, 2)
        pct_change = round((change / prev_close) * 100, 4) if prev_close else 0.0
        volume = getattr(fi, "regular_market_volume", None) or getattr(fi, "three_month_average_volume", 0) or 0

        # Company name and P/E — slower, so wrapped in try/except
        name = symbol.upper()
        pe_ratio = None
        try:
            info = ticker.info
            name = info.get("longName") or info.get("shortName") or symbol.upper()
            pe_ratio = info.get("trailingPE") or info.get("forwardPE")
        except Exception:
            pass

        # Historical OHLCV
        hist = ticker.history(period=period)
        chart_data = []
        for date, row in hist.iterrows():
            chart_data.append({
                "date": date.strftime("%Y-%m-%d"),
                "close": round(float(row["Close"]), 2),
                "open": round(float(row["Open"]), 2),
                "high": round(float(row["High"]), 2),
                "low": round(float(row["Low"]), 2),
                "volume": int(row["Volume"]),
            })

        data = {
            "symbol": symbol.upper(),
            "name": name,
            "price": round(price, 2),
            "change": change,
            "pctChange": pct_change,
            "volume": int(volume),
            "marketCap": getattr(fi, "market_cap", None),
            "week52High": getattr(fi, "year_high", None),
            "week52Low": getattr(fi, "year_low", None),
            "peRatio": round(pe_ratio, 2) if pe_ratio else None,
            "chart": chart_data,
        }

        _stock_cache.set(cache_key, data)
        return data

    except HTTPException:
        raise
    except Exception as exc:
        print(f"[stock] {symbol}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ── Sector Lookup (no cache, lightweight) ────────────────────────────────────

@router.get("/api/stock/sector/{symbol}")
def stock_sector(symbol: str):
    try:
        ticker = market_data.get_ticker(symbol)
        info = ticker.info or {}
        return {"symbol": symbol.upper(), "sector": info.get("sector"), "industry": info.get("industry")}
    except Exception:
        return {"symbol": symbol.upper(), "sector": None, "industry": None}


# ── Real-time Quote ──────────────────────────────────────────────────────────

@router.get("/api/stock/quote/{symbol}")
def stock_quote(symbol: str):
    """Real-time quote for a single symbol."""
    cache_key = f"quote:{symbol.upper()}"
    cached = _stock_cache.get(cache_key, ttl=60)
    if cached is not None:
        return cached

    try:
        ticker = market_data.get_ticker(symbol)

        # ── Prefer ticker.info for accurate price & change data ──────────
        # fast_info.previous_close is often stale/wrong, causing CHG% to
        # diverge from Yahoo Finance and other sources. ticker.info returns
        # Yahoo's own computed change values which match external sources.
        info: dict = {}
        try:
            info = ticker.info or {}
        except Exception:
            pass

        fi = ticker.fast_info

        # Price: prefer info (Yahoo's regularMarketPrice), fall back to fast_info
        price = info.get("regularMarketPrice") or info.get("currentPrice") or fi.last_price
        if price is None:
            raise HTTPException(status_code=404, detail=f"Symbol '{symbol}' not found")

        # Change: prefer Yahoo's pre-computed change value, always derive % from change/prev
        # (regularMarketChangePercent is unreliable across yfinance versions — decimal vs %-form)
        prev = info.get("previousClose") or info.get("regularMarketPreviousClose") or fi.previous_close or price
        if info.get("regularMarketChange") is not None:
            change = round(info["regularMarketChange"], 4)
        else:
            change = round(price - prev, 4)
        pct = round((change / prev) * 100, 4) if prev else 0.0

        # ── Session freshness ────────────────────────────────────────────
        # Yahoo keeps serving the last completed session after a market shuts,
        # so `change`/`pct` above can be a previous day's move. Publish the real
        # trade timestamp and a verdict so callers can label or suppress it.
        tz_name = info.get("exchangeTimezoneName")
        market_time = info.get("regularMarketTime")
        quote_date = local_date_of(market_time, tz_name)
        is_current = is_today_at(market_time, tz_name)

        # Extended-hours prices carry their own timestamps; drop whichever is
        # not from today. `marketState` alone is not enough — it reads CLOSED
        # all weekend while last Friday's postMarketPrice sits in the payload.
        pre_fresh = is_today_at(info.get("preMarketTime"), tz_name)
        post_fresh = is_today_at(info.get("postMarketTime"), tz_name)

        data = {
            "symbol":                     symbol.upper(),
            "longName":                   info.get("longName"),
            "shortName":                  info.get("shortName"),
            "fullExchangeName":           info.get("fullExchangeName"),
            "exchange":                   info.get("exchange") or getattr(fi, "exchange", None),
            "currency":                   info.get("currency"),
            "regularMarketPrice":         round(price, 4),
            "regularMarketChange":        change,
            "regularMarketChangePercent": pct,
            # Yahoo's own trade timestamp — NOT datetime.now(). Stamping "now"
            # here made every quote look live and hid exactly the staleness the
            # consumers below need to detect.
            "regularMarketTime":          market_time,
            "quoteDate":                  quote_date,
            "isCurrentSession":           is_current,
            "exchangeTimezone":           tz_name,
            "marketCap":                  info.get("marketCap") or getattr(fi, "market_cap", None),
            "trailingPE":                 info.get("trailingPE"),
            "forwardPE":                  info.get("forwardPE"),
            "beta":                       info.get("beta"),
            "regularMarketVolume":        info.get("regularMarketVolume") or getattr(fi, "regular_market_volume", None),
            "averageDailyVolume3Month":   info.get("averageVolume3Month") or getattr(fi, "three_month_average_volume", None),
            "fiftyTwoWeekHigh":           info.get("fiftyTwoWeekHigh") or getattr(fi, "year_high", None),
            "fiftyTwoWeekLow":            info.get("fiftyTwoWeekLow") or getattr(fi, "year_low", None),
            "dividendYield":              info.get("dividendYield"),
            "epsTrailingTwelveMonths":    info.get("trailingEps"),
            "regularMarketOpen":          info.get("regularMarketOpen") or getattr(fi, "open", None),
            "regularMarketPreviousClose": round(prev, 4),
            # ── Profitability ratios ───────────────────────────────────
            "returnOnEquity":             info.get("returnOnEquity"),
            "returnOnAssets":             info.get("returnOnAssets"),
            "grossMargins":               info.get("grossMargins"),
            "operatingMargins":           info.get("operatingMargins"),
            "profitMargins":              info.get("profitMargins"),
            # ── Valuation multiples ────────────────────────────────────
            "enterpriseValue":            info.get("enterpriseValue"),
            "enterpriseToEbitda":         info.get("enterpriseToEbitda"),
            "ebitda":                     info.get("ebitda"),
            "priceToBook":                info.get("priceToBook"),
            "priceToSalesTrailing12Months": info.get("priceToSalesTrailing12Months"),
            "bookValue":                  info.get("bookValue"),
            # ── Leverage & liquidity ───────────────────────────────────
            "debtToEquity":               info.get("debtToEquity"),
            "totalDebt":                  info.get("totalDebt"),
            "totalCash":                  info.get("totalCash"),
            "totalStockholdersEquity":    info.get("totalStockholdersEquity"),
            # ── Cash flow ──────────────────────────────────────────────
            "operatingCashflow":          info.get("operatingCashflow"),
            "capitalExpenditures":        info.get("capitalExpenditures"),
            "totalRevenue":               info.get("totalRevenue"),
            "sharesOutstanding":          info.get("sharesOutstanding") or getattr(fi, "shares", None),
            # ── Market session ─────────────────────────────────────────
            "marketState":               info.get("marketState"),
            "preMarketPrice":            info.get("preMarketPrice") if pre_fresh else None,
            "preMarketChange":           _safe_float(info.get("preMarketChange")) if pre_fresh else None,
            "preMarketChangePercent":    _safe_float(info.get("preMarketChangePercent")) if pre_fresh else None,
            "postMarketPrice":           info.get("postMarketPrice") if post_fresh else None,
            "postMarketChange":          _safe_float(info.get("postMarketChange")) if post_fresh else None,
            "postMarketChangePercent":   _safe_float(info.get("postMarketChangePercent")) if post_fresh else None,
            "sector":                    info.get("sector"),
            "industry":                  info.get("industry"),
        }

        _stock_cache.set(cache_key, data)
        return data

    except HTTPException:
        raise
    except Exception as exc:
        print(f"[quote] {symbol}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ── OHLCV History ────────────────────────────────────────────────────────────

@router.get("/api/stock/history/{symbol}")
def stock_history(symbol: str, period: str = "1y", interval: str = ""):
    """OHLCV history for a single symbol.

    period:   1d | 5d | 1m | 3m | ytd | 1y | 5y
    interval: 5m | 15m | 30m | 1h | 2h | 4h | 1d | 1wk
              (omit to use the legacy per-period default)
    """
    period   = period.lower().strip()
    interval = interval.lower().strip()

    # If no explicit interval -> fall back to legacy period map
    if interval not in VALID_INTERVALS:
        yf_period_def, interval = HISTORY_PERIOD_MAP.get(period, ("1y", "1d"))
        yf_period = yf_period_def
    else:
        yf_period = PERIOD_TO_YF.get(period, "1y")

    # 2h / 4h -> fetch 1h data then resample with pandas
    resample_rule: str | None = {"2h": "2h", "4h": "4h"}.get(interval)
    yf_interval   = "1h" if resample_rule else interval

    is_intraday = yf_interval not in ("1d", "1wk")
    ttl = (
        60 if yf_interval in ("5m", "15m")
        else 300 if is_intraday
        else MAX_HISTORY_CACHE_TTL if period in ("max", "5y")
        else STOCK_CACHE_TTL
    )

    cache_key = f"history:{symbol.upper()}:{period}:{interval}"
    cached = _stock_cache.get(cache_key, ttl=ttl)
    if cached is not None:
        return cached

    import re as _re
    def _fetch_hist(sym: str):
        return market_data.get_ticker(sym).history(period=yf_period, interval=yf_interval)

    try:
        hist = _fetch_hist(symbol)

        # Auto-retry with .BK suffix for Thai SET stocks (pure uppercase letters, no exchange suffix)
        if hist.empty and _re.fullmatch(r"[A-Z]{2,6}", symbol.upper()):
            hist = _fetch_hist(f"{symbol.upper()}.BK")

        if hist.empty:
            return {"quotes": []}

        # ── Resample 1h -> 2h or 4h ──────────────────────────────────────────
        if resample_rule:
            hist = (
                hist.resample(resample_rule, label="left", closed="left")
                .agg({"Open": "first", "High": "max", "Low": "min",
                      "Close": "last", "Volume": "sum"})
                .dropna(subset=["Close"])
            )

        date_fmt = "%Y-%m-%dT%H:%M:%S" if is_intraday else "%Y-%m-%d"
        quotes = [
            {
                "date":   row_date.strftime(date_fmt),
                "close":  round(float(row["Close"]), 4),
                "open":   round(float(row["Open"]), 4),
                "high":   round(float(row["High"]), 4),
                "low":    round(float(row["Low"]), 4),
                "volume": int(row["Volume"]) if not pd.isna(row["Volume"]) else 0,
            }
            for row_date, row in hist.iterrows()
            if not pd.isna(row["Close"])
        ]

        data = {"quotes": quotes}
        _stock_cache.set(cache_key, data)
        return data

    except Exception as exc:
        print(f"[history] {symbol}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ── Financials (Income Statement + Cash Flow) ────────────────────────────────

@router.get("/api/stock/financials/{symbol}")
def stock_financials(symbol: str):
    """Annual + quarterly income statement and free cash flow."""
    cache_key = f"financials:{symbol.upper()}"
    cached = _stock_cache.get(cache_key, ttl=_DETAIL_TTL)
    if cached is not None:
        return cached

    try:
        ticker = market_data.get_ticker(symbol)

        ann_inc = _parse_income(_get_df(ticker, "income_stmt", "financials"))
        qtr_inc = _parse_income(_get_df(ticker, "quarterly_income_stmt", "quarterly_financials"))
        ann_cf  = _parse_cashflow(_get_df(ticker, "cashflow", "cash_flow"))
        qtr_cf  = _parse_cashflow(_get_df(ticker, "quarterly_cashflow"))

        data = {
            "incomeStatementHistory": {
                "incomeStatementHistory": ann_inc,
            },
            "incomeStatementHistoryQuarterly": {
                "incomeStatementHistoryQuarterly": qtr_inc,
            },
            "cashflowStatementHistory": {
                "cashflowStatementHistory": ann_cf,
            },
            "cashflowStatementHistoryQuarterly": {
                "cashflowStatementHistoryQuarterly": qtr_cf,
            },
        }

        _stock_cache.set(cache_key, data)
        return data

    except Exception as exc:
        print(f"[financials] {symbol}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ── Balance Sheet ────────────────────────────────────────────────────────────

@router.get("/api/stock/balance-sheet/{symbol}")
def stock_balance_sheet(symbol: str):
    """Annual + quarterly balance sheet data."""
    cache_key = f"bs:{symbol.upper()}"
    cached = _stock_cache.get(cache_key, ttl=_DETAIL_TTL)
    if cached is not None:
        return cached
    try:
        ticker = market_data.get_ticker(symbol)
        ann = _parse_balance_sheet(_get_df(ticker, "balance_sheet"))
        qtr = _parse_balance_sheet(_get_df(ticker, "quarterly_balance_sheet"))
        data = {"annual": ann, "quarterly": qtr}
        _stock_cache.set(cache_key, data)
        return data
    except Exception as exc:
        print(f"[balance-sheet] {symbol}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ── Dividends History ────────────────────────────────────────────────────────

@router.get("/api/stock/dividends/{symbol}")
def stock_dividends(symbol: str):
    """Dividend history + splits."""
    cache_key = f"divs:{symbol.upper()}"
    cached = _stock_cache.get(cache_key, ttl=_DETAIL_TTL)
    if cached is not None:
        return cached
    try:
        ticker = market_data.get_ticker(symbol)
        divs = ticker.dividends
        splits = ticker.splits
        div_list = []
        if divs is not None and len(divs) > 0:
            for dt, val in divs.items():
                div_list.append({"date": dt.strftime("%Y-%m-%d"), "dividend": float(val)})
        split_list = []
        if splits is not None and len(splits) > 0:
            for dt, val in splits.items():
                split_list.append({"date": dt.strftime("%Y-%m-%d"), "ratio": float(val)})
        data = {"dividends": div_list, "splits": split_list}
        _stock_cache.set(cache_key, data)
        return data
    except Exception as exc:
        print(f"[dividends] {symbol}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ── Analyst: Price Targets + Recommendations + Upgrades ──────────────────────

@router.get("/api/stock/analyst/{symbol}")
def stock_analyst(symbol: str):
    """Analyst price targets, recommendation summary, and recent upgrades/downgrades."""
    cache_key = f"analyst:{symbol.upper()}"
    cached = _stock_cache.get(cache_key)
    if cached is not None:
        return cached
    try:
        ticker = market_data.get_ticker(symbol)

        # Price targets
        pt = ticker.analyst_price_targets
        price_targets = dict(pt) if pt else None

        # Recommendation summary (monthly)
        rec_df = ticker.recommendations_summary
        rec_summary = []
        if rec_df is not None and not rec_df.empty:
            for _, row in rec_df.iterrows():
                rec_summary.append({
                    "period":     row.get("period", ""),
                    "strongBuy":  int(row.get("strongBuy", 0)),
                    "buy":        int(row.get("buy", 0)),
                    "hold":       int(row.get("hold", 0)),
                    "sell":       int(row.get("sell", 0)),
                    "strongSell": int(row.get("strongSell", 0)),
                })

        # Upgrades/Downgrades (recent)
        ud_df = ticker.upgrades_downgrades
        upgrades = []
        if ud_df is not None and not ud_df.empty:
            for dt, row in ud_df.head(30).iterrows():
                upgrades.append({
                    "date":               dt.strftime("%Y-%m-%d") if hasattr(dt, "strftime") else str(dt),
                    "firm":               row.get("Firm", ""),
                    "toGrade":            row.get("ToGrade", ""),
                    "fromGrade":          row.get("FromGrade", ""),
                    "action":             row.get("Action", ""),
                    "currentPriceTarget": _safe_float(row.get("currentPriceTarget")),
                    "priorPriceTarget":   _safe_float(row.get("priorPriceTarget")),
                })

        data = {
            "priceTargets":       price_targets,
            "recommendations":    rec_summary,
            "upgradesDowngrades":  upgrades,
        }
        _stock_cache.set(cache_key, data)
        return data
    except Exception as exc:
        print(f"[analyst] {symbol}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ── Analyst: Earnings & Revenue Estimates ────────────────────────────────────

@router.get("/api/stock/estimates/{symbol}")
def stock_estimates(symbol: str):
    """Earnings estimates, revenue estimates, EPS trend, growth estimates, earnings history."""
    cache_key = f"est:{symbol.upper()}"
    cached = _stock_cache.get(cache_key)
    if cached is not None:
        return cached
    try:
        ticker = market_data.get_ticker(symbol)

        def _df_to_records(df: Any) -> list[dict]:
            if df is None or df.empty:
                return []
            recs = []
            for period, row in df.iterrows():
                d = {"period": str(period)}
                for col in row.index:
                    v = row[col]
                    if v is None or (isinstance(v, float) and pd.isna(v)):
                        d[col] = None
                    else:
                        try:
                            d[col] = float(v)
                        except (ValueError, TypeError):
                            d[col] = str(v)
                recs.append(d)
            return recs

        data = {
            "earningsEstimate": _df_to_records(ticker.earnings_estimate),
            "revenueEstimate":  _df_to_records(ticker.revenue_estimate),
            "epsTrend":         _df_to_records(ticker.eps_trend),
            "epsRevisions":     _df_to_records(ticker.eps_revisions),
            "growthEstimates":  _df_to_records(ticker.growth_estimates),
        }

        # Earnings history (actual vs estimate)
        eh = ticker.earnings_history
        if eh is not None and not eh.empty:
            eh_list = []
            for period, row in eh.iterrows():
                eh_list.append({
                    "period":       str(period),
                    "epsEstimate":  _safe_float(row.get("epsEstimate")),
                    "epsActual":    _safe_float(row.get("epsActual")),
                    "epsDifference": _safe_float(row.get("epsDifference")),
                    "surprisePercent": _safe_float(row.get("surprisePercent")),
                })
            data["earningsHistory"] = eh_list
        else:
            data["earningsHistory"] = []

        _stock_cache.set(cache_key, data)
        return data
    except Exception as exc:
        print(f"[estimates] {symbol}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ── Ownership: Insider + Institutional + Major Holders ───────────────────────

@router.get("/api/stock/ownership/{symbol}")
def stock_ownership(symbol: str):
    """Insider transactions, institutional holders, mutual fund holders, major holders breakdown."""
    cache_key = f"own:{symbol.upper()}"
    cached = _stock_cache.get(cache_key, ttl=_DETAIL_TTL)
    if cached is not None:
        return cached
    try:
        ticker = market_data.get_ticker(symbol)

        # Insider transactions
        it_df = ticker.insider_transactions
        insiders = []
        if it_df is not None and not it_df.empty:
            for _, row in it_df.head(50).iterrows():
                sd = row.get("Start Date")
                insiders.append({
                    "insider":     row.get("Insider", ""),
                    "position":    row.get("Position", ""),
                    "transaction": row.get("Transaction", ""),
                    "date":        sd.strftime("%Y-%m-%d") if hasattr(sd, "strftime") else str(sd or ""),
                    "shares":      _safe_float(row.get("Shares")),
                    "value":       _safe_float(row.get("Value")),
                    "text":        row.get("Text", ""),
                    "ownership":   row.get("Ownership", ""),
                })

        # Institutional holders
        ih_df = ticker.institutional_holders
        institutions = []
        if ih_df is not None and not ih_df.empty:
            for _, row in ih_df.iterrows():
                dr = row.get("Date Reported")
                institutions.append({
                    "holder":      row.get("Holder", ""),
                    "shares":      _safe_float(row.get("Shares")),
                    "value":       _safe_float(row.get("Value")),
                    "pctHeld":     _safe_float(row.get("pctHeld")),
                    "pctChange":   _safe_float(row.get("pctChange")),
                    "dateReported": dr.strftime("%Y-%m-%d") if hasattr(dr, "strftime") else str(dr or ""),
                })

        # Mutual fund holders
        mf_df = ticker.mutualfund_holders
        mutual_funds = []
        if mf_df is not None and not mf_df.empty:
            for _, row in mf_df.iterrows():
                dr = row.get("Date Reported")
                mutual_funds.append({
                    "holder":      row.get("Holder", ""),
                    "shares":      _safe_float(row.get("Shares")),
                    "value":       _safe_float(row.get("Value")),
                    "pctHeld":     _safe_float(row.get("pctHeld")),
                    "pctChange":   _safe_float(row.get("pctChange")),
                    "dateReported": dr.strftime("%Y-%m-%d") if hasattr(dr, "strftime") else str(dr or ""),
                })

        # Major holders (summary %)
        mh_df = ticker.major_holders
        major = {}
        if mh_df is not None and not mh_df.empty:
            for idx, row in mh_df.iterrows():
                major[idx] = _safe_float(row.get("Value"))

        data = {
            "insiderTransactions":  insiders,
            "institutionalHolders": institutions,
            "mutualFundHolders":    mutual_funds,
            "majorHolders":         major,
        }
        _stock_cache.set(cache_key, data)
        return data
    except Exception as exc:
        print(f"[ownership] {symbol}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ── Calendar: Earnings Dates ─────────────────────────────────────────────────

@router.get("/api/stock/earnings-calendar/{symbol}")
def stock_earnings_calendar(symbol: str):
    """Earnings dates with EPS estimates and surprises."""
    cache_key = f"ecal:{symbol.upper()}"
    cached = _stock_cache.get(cache_key, ttl=_DETAIL_TTL)
    if cached is not None:
        return cached
    try:
        ticker = market_data.get_ticker(symbol)
        ed_df = ticker.earnings_dates
        dates = []
        if ed_df is not None and not ed_df.empty:
            for dt, row in ed_df.iterrows():
                dates.append({
                    "date":        dt.strftime("%Y-%m-%d %H:%M") if hasattr(dt, "strftime") else str(dt),
                    "epsEstimate": _safe_float(row.get("EPS Estimate")),
                    "reportedEPS": _safe_float(row.get("Reported EPS")),
                    "surprise":    _safe_float(row.get("Surprise(%)")),
                    "eventType":   row.get("Event Type", ""),
                })
        data = {"earningsDates": dates}
        _stock_cache.set(cache_key, data)
        return data
    except Exception as exc:
        print(f"[earnings-calendar] {symbol}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ── Trailing P/E History ─────────────────────────────────────────────────────

@router.get("/api/stock/pe-history/{symbol}")
def stock_pe_history(symbol: str):
    """Weekly trailing P/E series built from TTM (rolling 4-quarter) Reported EPS.

    Yahoo's Reported EPS is street/adjusted (not GAAP), so the absolute P/E runs
    lower than GAAP-based sources — the shape/trend is what matters. Quarters with
    negative TTM EPS yield an undefined P/E and are left as gaps.
    """
    cache_key = f"pehist:{symbol.upper()}"
    cached = _stock_cache.get(cache_key, ttl=_DETAIL_TTL)
    if cached is not None:
        return cached

    def _to_date(ts: Any):
        try:
            return pd.Timestamp(ts).tz_localize(None).date()
        except (TypeError, ValueError):
            return pd.Timestamp(ts).date()

    try:
        ticker = market_data.get_ticker(symbol)

        def _load(tk):
            eps_df = tk.get_earnings_dates(limit=60)
            px = tk.history(period="max", interval="1wk")
            return eps_df, px

        eps_df, px = _load(ticker)

        # .BK retry for bare Thai tickers
        if (px is None or px.empty) and re.fullmatch(r"[A-Z]{2,6}", symbol.upper()):
            ticker = market_data.get_ticker(f"{symbol.upper()}.BK")
            eps_df, px = _load(ticker)

        if px is None or px.empty or eps_df is None or eps_df.empty:
            data = {"history": [], "stats": None, "earnings": []}
            _stock_cache.set(cache_key, data)
            return data

        # Quarterly reported EPS, oldest → newest
        quarters = []
        earnings_out = []
        for idx, row in eps_df.iterrows():
            rep = _safe_float(row.get("Reported EPS"))
            d = _to_date(idx)
            if rep is not None:
                quarters.append((d, rep))
            earnings_out.append({
                "date":        d.strftime("%Y-%m-%d"),
                "reportedEPS": rep,
                "epsEstimate": _safe_float(row.get("EPS Estimate")),
                "surprise":    _safe_float(row.get("Surprise(%)")),
            })
        quarters.sort(key=lambda x: x[0])
        earnings_out.sort(key=lambda e: e["date"])

        if len(quarters) < 4:
            data = {"history": [], "stats": None, "earnings": earnings_out}
            _stock_cache.set(cache_key, data)
            return data

        q_dates = [q[0] for q in quarters]
        q_eps = [q[1] for q in quarters]

        import bisect
        history = []
        for ts, prow in px.iterrows():
            close = _safe_float(prow.get("Close"))
            if close is None:
                continue
            bar_date = _to_date(ts)
            # index of last quarter reported on/before this bar
            j = bisect.bisect_right(q_dates, bar_date) - 1
            if j < 3:
                continue  # need 4 trailing quarters
            ttm_eps = q_eps[j] + q_eps[j - 1] + q_eps[j - 2] + q_eps[j - 3]
            pe = round(close / ttm_eps, 2) if ttm_eps > 0 else None
            history.append({
                "time":  bar_date.strftime("%Y-%m-%d"),
                "pe":    pe,
                "eps":   round(ttm_eps, 4),
                "close": round(close, 2),
            })

        pe_vals = [h["pe"] for h in history if h["pe"] is not None]
        stats = None
        if pe_vals:
            s = pd.Series(pe_vals)
            stats = {
                "current": pe_vals[-1],
                "min":     round(float(s.min()), 2),
                "max":     round(float(s.max()), 2),
                "median":  round(float(s.median()), 2),
                "p10":     round(float(s.quantile(0.10)), 2),
                "p90":     round(float(s.quantile(0.90)), 2),
                # percentile rank of the latest P/E within its own history (0–100)
                "currentPct": round(float((s <= pe_vals[-1]).mean() * 100), 1),
            }

        data = {"history": history, "stats": stats, "earnings": earnings_out}
        _stock_cache.set(cache_key, data)
        return data

    except Exception as exc:
        print(f"[pe-history] {symbol}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ── SEC Filings ──────────────────────────────────────────────────────────────

@router.get("/api/stock/sec-filings/{symbol}")
def stock_sec_filings(symbol: str):
    """Recent SEC filings for a symbol."""
    cache_key = f"sec:{symbol.upper()}"
    cached = _stock_cache.get(cache_key, ttl=_DETAIL_TTL)
    if cached is not None:
        return cached
    try:
        ticker = market_data.get_ticker(symbol)
        filings_raw = ticker.sec_filings
        filings = []
        if filings_raw:
            for f in (filings_raw[:30] if isinstance(filings_raw, list) else []):
                filings.append({
                    "date":  f.get("date", ""),
                    "type":  f.get("type", ""),
                    "title": f.get("title", ""),
                    "url":   f.get("edgarUrl", ""),
                })
        data = {"filings": filings}
        _stock_cache.set(cache_key, data)
        return data
    except Exception as exc:
        print(f"[sec-filings] {symbol}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ── Financial Ratios ─────────────────────────────────────────────────────────

@router.get("/api/stock/ratios/{symbol}")
def stock_ratios(symbol: str):
    """Financial ratios extracted from ticker.info."""
    cache_key = f"ratios:{symbol.upper()}"
    cached = _stock_cache.get(cache_key, ttl=_DETAIL_TTL)
    if cached is not None:
        return cached
    try:
        info = market_data.get_ticker(symbol).info or {}

        def _g(k):
            v = info.get(k)
            return round(v, 4) if isinstance(v, (int, float)) else v

        data = {
            "profitability": {
                "returnOnEquity": _g("returnOnEquity"),
                "returnOnAssets": _g("returnOnAssets"),
                "grossMargins": _g("grossMargins"),
                "operatingMargins": _g("operatingMargins"),
                "profitMargins": _g("profitMargins"),
                "ebitdaMargins": _g("ebitdaMargins"),
            },
            "leverage": {
                "debtToEquity": _g("debtToEquity"),
                "currentRatio": _g("currentRatio"),
                "quickRatio": _g("quickRatio"),
                "totalDebt": _g("totalDebt"),
                "totalCash": _g("totalCash"),
                "totalCashPerShare": _g("totalCashPerShare"),
            },
            "valuation": {
                "trailingPE": _g("trailingPE"),
                "forwardPE": _g("forwardPE"),
                "priceToBook": _g("priceToBook"),
                "priceToSalesTrailing12Months": _g("priceToSalesTrailing12Months"),
                "enterpriseToRevenue": _g("enterpriseToRevenue"),
                "enterpriseToEbitda": _g("enterpriseToEbitda"),
                "pegRatio": _g("pegRatio"),
            },
            "growth": {
                "revenueGrowth": _g("revenueGrowth"),
                "earningsGrowth": _g("earningsGrowth"),
                "earningsQuarterlyGrowth": _g("earningsQuarterlyGrowth"),
                "revenueQuarterlyGrowth": _g("revenueQuarterlyGrowth"),
            },
            "perShare": {
                "bookValue": _g("bookValue"),
                "trailingEps": _g("trailingEps"),
                "forwardEps": _g("forwardEps"),
                "revenuePerShare": _g("revenuePerShare"),
            },
            "dividends": {
                "dividendRate": _g("dividendRate"),
                "dividendYield": _g("dividendYield"),
                "payoutRatio": _g("payoutRatio"),
                "fiveYearAvgDividendYield": _g("fiveYearAvgDividendYield"),
            },
        }
        _stock_cache.set(cache_key, data)
        return data
    except Exception as exc:
        print(f"[ratios] {symbol}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ── Management / Company Officers ────────────────────────────────────────────

@router.get("/api/stock/management/{symbol}")
def stock_management(symbol: str):
    """Company officers/management team."""
    cache_key = f"mgmt:{symbol.upper()}"
    cached = _stock_cache.get(cache_key, ttl=_DETAIL_TTL)
    if cached is not None:
        return cached
    try:
        info = market_data.get_ticker(symbol).info or {}
        officers_raw = info.get("companyOfficers", [])
        officers = []
        for o in officers_raw:
            officers.append({
                "name": o.get("name", ""),
                "title": o.get("title", ""),
                "age": o.get("age"),
                "yearBorn": o.get("yearBorn"),
                "totalPay": o.get("totalPay"),
                "exercisedValue": o.get("exercisedValue"),
                "unexercisedValue": o.get("unexercisedValue"),
            })
        data = {
            "companyName": info.get("shortName", ""),
            "sector": info.get("sector", ""),
            "industry": info.get("industry", ""),
            "fullTimeEmployees": info.get("fullTimeEmployees"),
            "website": info.get("website", ""),
            "officers": officers,
        }
        _stock_cache.set(cache_key, data)
        return data
    except Exception as exc:
        print(f"[management] {symbol}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))
