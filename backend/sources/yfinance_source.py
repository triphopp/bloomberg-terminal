"""
yfinance implementation of MarketDataSource.

All yfinance-specific code lives here — routers never import yfinance directly.
Each method maps yfinance raw responses → canonical models from ``sources.models``.

To swap providers: create a new adapter (e.g. polygon_source.py) implementing
the same interface, then change ``sources/__init__.py`` one line.
"""
from datetime import datetime
from typing import Optional

import pandas as pd
import yfinance as yf

from .base import MarketDataSource
from .models import (
    QuoteSnapshot,
    TickerDetail,
    OHLCVFrame,
    SearchResult,
    OptionChainResult,
    ETFProfile,
    ETFHolding,
    DividendRecord,
    FinancialStatements,
    NewsItem,
    BatchPriceResult,
    BatchQuoteResult,
)


# ── Ticker factory ───────────────────────────────────────────────────────────────
# Do NOT inject a custom session: yfinance already reuses one connection pool
# internally (singleton YfData) and *requires* a curl_cffi session — passing a
# plain requests.Session raises YFDataException. Let yfinance manage it.
def _ticker(symbol: str):
    return yf.Ticker(symbol)


# ── Helpers ─────────────────────────────────────────────────────────────────────

def _normalize_dividend_yield(raw_yield) -> Optional[float]:
    """Normalize dividend yield: yfinance returns either decimal (0.0129)
    or percentage (1.29).  Normalize to decimal (0.0129)."""
    if raw_yield is None:
        return None
    val = float(raw_yield)
    if val > 0.5:       # percentage form (>50% yield is impossible)
        val = val / 100.0
    return round(val, 6)


def _safe_float(val) -> Optional[float]:
    """Coerce to float, returning None on failure."""
    if val is None:
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _safe_int(val) -> Optional[int]:
    """Coerce to int, returning None on failure."""
    if val is None:
        return None
    try:
        return int(val)
    except (TypeError, ValueError):
        return None


# ── YFinanceSource ──────────────────────────────────────────────────────────────

class YFinanceSource(MarketDataSource):

    # ═══════════════════════════════════════════════════════════════════════════
    # Quote
    # ═══════════════════════════════════════════════════════════════════════════

    def get_fast_info(self, symbol: str) -> QuoteSnapshot:
        """Map yfinance fast_info → QuoteSnapshot.

        Attribute names (``last_price``, ``previous_close``, etc.) are
        preserved so existing router code continues to work.
        """
        fi = _ticker(symbol).fast_info
        return QuoteSnapshot(
            symbol=symbol,
            last_price=_safe_float(getattr(fi, "last_price", None)),
            previous_close=_safe_float(getattr(fi, "previous_close", None)),
            regular_market_volume=_safe_int(getattr(fi, "regular_market_volume", None)),
            three_month_average_volume=_safe_float(getattr(fi, "three_month_average_volume", None)),
            market_cap=_safe_float(getattr(fi, "market_cap", None)),
        )

    def get_info(self, symbol: str) -> TickerDetail:
        """Map yfinance ``.info`` dict → TickerDetail.

        Supports both attribute access (``detail.pe_ratio``) and backward-
        compatible dict-style access (``detail.get("trailingPE")``).
        """
        raw = _ticker(symbol).info or {}
        return TickerDetail(
            symbol=symbol,
            short_name=raw.get("shortName"),
            long_name=raw.get("longName"),
            exchange=raw.get("exchange"),
            quote_type=raw.get("quoteType"),
            regular_market_price=_safe_float(raw.get("regularMarketPrice")),
            regular_market_change=_safe_float(raw.get("regularMarketChange")),
            regular_market_change_pct=_safe_float(raw.get("regularMarketChangePercent")),
            regular_market_volume=_safe_int(raw.get("regularMarketVolume")),
            market_cap=_safe_float(raw.get("marketCap")),
            pe_ratio=_safe_float(raw.get("trailingPE")),
            forward_pe=_safe_float(raw.get("forwardPE")),
            eps=_safe_float(raw.get("trailingEps")),
            dividend_yield=_normalize_dividend_yield(raw.get("dividendYield")),
            fifty_two_week_high=_safe_float(raw.get("fiftyTwoWeekHigh")),
            fifty_two_week_low=_safe_float(raw.get("fiftyTwoWeekLow")),
            beta=_safe_float(raw.get("beta")),
            sector=raw.get("sector"),
            industry=raw.get("industry"),
            country=raw.get("country"),
            currency=raw.get("currency"),
            previous_close=_safe_float(raw.get("previousClose")),
            price_to_book=_safe_float(raw.get("priceToBook")),
            book_value=_safe_float(raw.get("bookValue")),
            revenue=_safe_float(raw.get("totalRevenue")),
            total_cash=_safe_float(raw.get("totalCash")),
            total_debt=_safe_float(raw.get("totalDebt")),
            shares_outstanding=_safe_float(raw.get("sharesOutstanding")),
            raw=raw,
        )

    # ═══════════════════════════════════════════════════════════════════════════
    # OHLCV
    # ═══════════════════════════════════════════════════════════════════════════

    def get_history(self, symbol: str, period: str = "1mo",
                    interval: str = "1d") -> OHLCVFrame:
        """Return historical OHLCV with canonical column names."""
        df = _ticker(symbol).history(period=period, interval=interval)
        # Normalize column names — ensure consistent casing
        col_map = {}
        for col in df.columns:
            col_lower = str(col).lower()
            if col_lower == "open":       col_map[col] = "Open"
            elif col_lower == "high":     col_map[col] = "High"
            elif col_lower == "low":      col_map[col] = "Low"
            elif col_lower == "close":    col_map[col] = "Close"
            elif col_lower == "volume":   col_map[col] = "Volume"
            elif col_lower == "dividends": col_map[col] = "Dividends"  # keep for carry calc
        if col_map:
            df = df.rename(columns=col_map)
        # Keep OHLCV + Dividends — "Dividends" needed by country_rotation carry layer
        wanted = [c for c in ["Open", "High", "Low", "Close", "Volume", "Dividends"]
                  if c in df.columns]
        return OHLCVFrame(symbol=symbol, df=df[wanted].copy() if wanted else df)

    # ═══════════════════════════════════════════════════════════════════════════
    # Batch
    # ═══════════════════════════════════════════════════════════════════════════

    def download(self, symbols: list[str],
                 period: str = "1y", interval: str = "1d") -> BatchPriceResult:
        """Batch-download latest close prices.

        Replaces direct ``yf.download()`` calls in portfolio_v2.py,
        backtest_v2.py, and risk.py.
        """
        if not symbols:
            return BatchPriceResult(prices={})
        df = yf.download(symbols, period=period, interval=interval,
                         auto_adjust=True, progress=False)
        prices: dict[str, Optional[float]] = {}
        if df.empty:
            return BatchPriceResult(prices={s: None for s in symbols})

        # Handle single vs multi-symbol (yfinance returns different shapes)
        if len(symbols) == 1:
            close_col = df.get("Close", df)
            col = close_col.dropna()
            prices[symbols[0]] = float(col.iloc[-1]) if not col.empty else None
        else:
            close = df.get("Close", df)
            for sym in symbols:
                try:
                    col = close[sym].dropna()
                    prices[sym] = float(col.iloc[-1]) if not col.empty else None
                except (KeyError, Exception):
                    prices[sym] = None
        return BatchPriceResult(prices=prices)

    def download_quotes(self, symbols: list[str]) -> BatchQuoteResult:
        """Batch-fetch QuoteSnapshots via yfinance Tickers object.

        Replaces ``get_batch_tickers()`` calls in crypto.py and fx.py.
        """
        if not symbols:
            return BatchQuoteResult(quotes={})
        try:
            tickers = yf.Tickers(" ".join(symbols))
            quotes: dict[str, QuoteSnapshot] = {}
            for sym in symbols:
                try:
                    t = tickers.tickers.get(sym)
                    if t is None:
                        quotes[sym] = QuoteSnapshot(symbol=sym)
                        continue
                    fi = t.fast_info
                    quotes[sym] = QuoteSnapshot(
                        symbol=sym,
                        last_price=_safe_float(getattr(fi, "last_price", None)),
                        previous_close=_safe_float(getattr(fi, "previous_close", None)),
                        regular_market_volume=_safe_int(getattr(fi, "regular_market_volume", None)),
                        three_month_average_volume=_safe_float(
                            getattr(fi, "three_month_average_volume", None)),
                        market_cap=_safe_float(getattr(fi, "market_cap", None)),
                    )
                except Exception:
                    quotes[sym] = QuoteSnapshot(symbol=sym)
            return BatchQuoteResult(quotes=quotes)
        except Exception:
            return BatchQuoteResult(quotes={s: QuoteSnapshot(symbol=s) for s in symbols})

    # ═══════════════════════════════════════════════════════════════════════════
    # Search
    # ═══════════════════════════════════════════════════════════════════════════

    def search(self, query: str, max_results: int = 10) -> list[SearchResult]:
        """Search symbols — maps yfinance Search → list[SearchResult]."""
        result = yf.Search(query, max_results=max_results)
        out = []
        for q in (result.quotes or []):
            d = dict(q) if not isinstance(q, dict) else q
            sym = str(d.get("symbol") or "").strip()
            if not sym:
                continue
            out.append(SearchResult(
                symbol=sym,
                short_name=str(d.get("shortname") or d.get("shortName") or ""),
                long_name=str(d.get("longname") or d.get("longName") or ""),
                exchange=str(d.get("exchDisp") or d.get("exchange") or ""),
                quote_type=str(d.get("typeDisp") or d.get("quoteType") or ""),
            ))
        return out

    # ═══════════════════════════════════════════════════════════════════════════
    # Options
    # ═══════════════════════════════════════════════════════════════════════════

    def get_option_expirations(self, symbol: str) -> list[str]:
        return list(_ticker(symbol).options)

    def get_option_chain(self, symbol: str, expiry: str) -> OptionChainResult:
        chain = _ticker(symbol).option_chain(expiry)
        return OptionChainResult(
            symbol=symbol,
            expiry=expiry,
            calls=chain.calls,
            puts=chain.puts,
        )

    # ═══════════════════════════════════════════════════════════════════════════
    # ETF
    # ═══════════════════════════════════════════════════════════════════════════

    def get_funds_data(self, symbol: str) -> ETFProfile:
        fd = _ticker(symbol).funds_data
        holdings = []
        top_h = getattr(fd, "top_holdings", None) or []
        for h in top_h:
            if isinstance(h, dict):
                holdings.append(ETFHolding(
                    symbol=str(h.get("symbol", "")),
                    name=str(h.get("holdingName", "")),
                    weight_pct=_safe_float(h.get("holdingPercent", 0)) * 100,
                ))
        sectors: dict[str, float] = {}
        raw_sec = getattr(fd, "sector_weightings", None) or {}
        for k, v in raw_sec.items():
            sectors[str(k)] = float(v) * 100
        return ETFProfile(
            symbol=symbol,
            top_holdings=holdings,
            sector_weightings=sectors,
        )

    # ═══════════════════════════════════════════════════════════════════════════
    # New typed methods (replace get_ticker() bypass)
    # ═══════════════════════════════════════════════════════════════════════════

    def get_dividends(self, symbol: str) -> list[DividendRecord]:
        series = _ticker(symbol).dividends
        if series is None or series.empty:
            return []
        out = []
        for dt, amount in series.items():
            out.append(DividendRecord(
                ex_date=str(dt)[:10],
                amount=float(amount),
            ))
        return out

    def get_financials(self, symbol: str) -> FinancialStatements:
        t = _ticker(symbol)
        # Reuse existing parsing logic — these helpers live in stock.py but
        # are imported at runtime here.  If unavailable, return raw-as-dict.
        try:
            from routers.stock import _parse_income, _parse_cashflow, _parse_balance_sheet
            income = _parse_income(t.income_stmt or t.financials)
            cashflow = _parse_cashflow(t.cashflow)
            balance = _parse_balance_sheet(t.balance_sheet)
        except ImportError:
            # Fallback: store raw DataFrames as list-of-dict
            def _df_to_dicts(df):
                if df is None or df.empty:
                    return []
                return df.reset_index().to_dict(orient="records")
            income = _df_to_dicts(t.income_stmt or t.financials)
            cashflow = _df_to_dicts(t.cashflow)
            balance = _df_to_dicts(t.balance_sheet)

        return FinancialStatements(
            symbol=symbol,
            income=income,
            cashflow=cashflow,
            balance_sheet=balance,
        )

    def get_news(self, symbol: str, max_results: int = 10) -> list[NewsItem]:
        raw = _ticker(symbol).news or []
        out = []
        for item in raw[:max_results]:
            title = str(item.get("title", ""))
            url = str(item.get("link", ""))
            pub_raw = item.get("providerPublishTime")
            if pub_raw:
                try:
                    published = datetime.fromtimestamp(int(pub_raw)).isoformat()
                except (TypeError, ValueError, OSError):
                    published = str(pub_raw)
            else:
                published = None
            out.append(NewsItem(
                title=title,
                url=url,
                published=published,
                source=str(item.get("publisher", "")),
                summary=str(item.get("summary", "")),
            ))
        return out

    # ═══════════════════════════════════════════════════════════════════════════
    # Deprecated — remove after all routers migrated
    # ═══════════════════════════════════════════════════════════════════════════

    def get_batch_tickers(self, symbols: list[str]):
        """Deprecated — use ``download_quotes()`` instead.

        Still functional for crypto.py and fx.py until they migrate.
        """
        return yf.Tickers(" ".join(symbols))

    def get_ticker(self, symbol: str):
        """Deprecated — use typed methods instead.

        Still functional for stock.py (14 calls), market.py (6 calls),
        options.py (2 calls), etf.py (1 call) until they migrate.
        Each call site should be replaced with the specific typed method
        that matches its use case:

        - ``.fast_info``      → ``get_fast_info()``
        - ``.info``           → ``get_info()``
        - ``.history(...)``   → ``get_history()``
        - ``.dividends``      → ``get_dividends()``
        - ``.financials``     → ``get_financials()``
        - ``.news``           → ``get_news()``
        """
        return _ticker(symbol)


# Module-level singleton — import this in all routers
market_data = YFinanceSource()
