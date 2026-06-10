"""
Canonical data models for market data providers.

Every method in MarketDataSource returns one of these dataclasses.
Providers (yfinance, Polygon, etc.) are responsible for mapping their
native response shapes into these models.  Routers never touch provider-
specific attributes directly — they access typed fields or fall back to
the ``raw`` dict for unmapped keys.

Routers can use either attribute access (``snap.last_price``) or the
backward-compatible ``.get()`` method (``detail.get("regularMarketPrice")``)
during migration.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import pandas as pd


# ── Quote ──────────────────────────────────────────────────────────────────────

@dataclass
class QuoteSnapshot:
    """Real-time / delayed quote — replaces ``get_fast_info()`` raw object.

    Field names match the yfinance ``fast_info`` attributes that routers
    already use, so ``fi.last_price`` continues to work after the return
    type changes from yfinance object → QuoteSnapshot.
    """
    symbol:                     str
    last_price:                 Optional[float] = None
    previous_close:             Optional[float] = None
    regular_market_volume:      Optional[int]   = None
    three_month_average_volume: Optional[float] = None
    market_cap:                 Optional[float] = None

    # ── Extended fields (not in fast_info, populated from info when available) ──

    regular_market_price:       Optional[float] = None
    regular_market_change:      Optional[float] = None
    regular_market_change_pct:  Optional[float] = None
    day_high:                   Optional[float] = None
    day_low:                    Optional[float] = None
    currency:                   Optional[str]   = None
    exchange:                   Optional[str]   = None
    quote_type:                 Optional[str]   = None
    short_name:                 Optional[str]   = None
    long_name:                  Optional[str]   = None

    # Raw backup — provider-specific fields not explicitly mapped above
    _raw: dict = field(default_factory=dict, repr=False)

    def get(self, key: str, default=None):
        """Backward-compatible dict-style access during migration.

        Checks explicit dataclass fields first (using the *dataclass* field
        name, e.g. ``"previous_close"``), then falls back to ``_raw``.
        """
        # Dataclass field name → snake_case
        field_map = {
            "lastPrice":                  "last_price",
            "previousClose":              "previous_close",
            "regularMarketVolume":        "regular_market_volume",
            "threeMonthAverageVolume":    "three_month_average_volume",
            "marketCap":                  "market_cap",
            "regularMarketPrice":         "regular_market_price",
            "regularMarketChange":        "regular_market_change",
            "regularMarketChangePercent": "regular_market_change_pct",
            "dayHigh":                    "day_high",
            "dayLow":                     "day_low",
            "currency":                   "currency",
            "exchange":                   "exchange",
            "quoteType":                  "quote_type",
            "shortName":                  "short_name",
            "longName":                   "long_name",
        }
        attr = field_map.get(key, key)
        if hasattr(self, attr) and attr != "_raw":
            val = getattr(self, attr)
            if val is not None:
                return val
        return self._raw.get(key, default)


# ── Detail ─────────────────────────────────────────────────────────────────────

@dataclass
class TickerDetail:
    """Full ticker metadata — replaces ``get_info()`` returning plain dict.

    Typed fields cover the most-accessed yfinance ``info`` keys.  Everything
    else is available via ``detail.get("someYahooKey")`` or ``detail.raw``.
    """
    symbol:                      str
    short_name:                  Optional[str]   = None
    long_name:                   Optional[str]   = None
    exchange:                    Optional[str]   = None
    quote_type:                  Optional[str]   = None
    regular_market_price:        Optional[float] = None
    regular_market_change:       Optional[float] = None
    regular_market_change_pct:   Optional[float] = None
    regular_market_volume:       Optional[int]   = None
    market_cap:                  Optional[float] = None
    pe_ratio:                    Optional[float] = None      # trailingPE
    forward_pe:                  Optional[float] = None
    eps:                         Optional[float] = None      # trailingEps
    dividend_yield:              Optional[float] = None
    fifty_two_week_high:         Optional[float] = None
    fifty_two_week_low:          Optional[float] = None
    beta:                        Optional[float] = None
    sector:                      Optional[str]   = None
    industry:                    Optional[str]   = None
    country:                     Optional[str]   = None
    currency:                    Optional[str]   = None
    previous_close:              Optional[float] = None      # previousClose

    # Book value & financial ratios
    price_to_book:               Optional[float] = None
    book_value:                  Optional[float] = None
    revenue:                     Optional[float] = None
    total_cash:                  Optional[float] = None
    total_debt:                  Optional[float] = None
    shares_outstanding:          Optional[float] = None

    raw: dict = field(default_factory=dict, repr=False)

    # yfinance info → dataclass field mapping
    _INFO_KEY_MAP: dict[str, str] = field(default_factory=lambda: {
        "shortName":                  "short_name",
        "longName":                   "long_name",
        "exchange":                   "exchange",
        "quoteType":                  "quote_type",
        "regularMarketPrice":         "regular_market_price",
        "regularMarketChange":        "regular_market_change",
        "regularMarketChangePercent": "regular_market_change_pct",
        "regularMarketVolume":        "regular_market_volume",
        "marketCap":                  "market_cap",
        "trailingPE":                 "pe_ratio",
        "forwardPE":                  "forward_pe",
        "trailingEps":                "eps",
        "dividendYield":              "dividend_yield",
        "fiftyTwoWeekHigh":           "fifty_two_week_high",
        "fiftyTwoWeekLow":            "fifty_two_week_low",
        "beta":                       "beta",
        "sector":                     "sector",
        "industry":                   "industry",
        "country":                    "country",
        "currency":                   "currency",
        "previousClose":              "previous_close",
        "priceToBook":                "price_to_book",
        "bookValue":                  "book_value",
        "totalRevenue":               "revenue",
        "totalCash":                  "total_cash",
        "totalDebt":                  "total_debt",
        "sharesOutstanding":          "shares_outstanding",
    }, repr=False, hash=False, compare=False)

    def get(self, key: str, default=None):
        """Backward-compatible dict-style access during migration.

        Maps yfinance camelCase keys → snake_case dataclass fields, then
        falls back to ``raw``.
        """
        attr = self._INFO_KEY_MAP.get(key, key)
        if hasattr(self, attr) and attr not in ("raw", "_INFO_KEY_MAP"):
            val = getattr(self, attr)
            if val is not None:
                return val
        return self.raw.get(key, default)

    def __getitem__(self, key: str):
        """Allow ``detail["key"]`` bracket access → delegates to .get()."""
        return self.get(key)

    def __contains__(self, key: str) -> bool:
        return self.get(key) is not None


# ── OHLCV ──────────────────────────────────────────────────────────────────────

@dataclass
class OHLCVFrame:
    """Historical OHLCV data — replaces raw yfinance DataFrame.

    Columns guaranteed: Open, High, Low, Close, Volume (normalized by adapter).
    Index: DatetimeIndex (UTC).
    """
    symbol:   str
    df:       pd.DataFrame   # columns: Open, High, Low, Close, Volume
    currency: Optional[str] = None


# ── Search ─────────────────────────────────────────────────────────────────────

@dataclass
class SearchResult:
    """One result from symbol search."""
    symbol:     str
    short_name: str = ""
    long_name:  str = ""
    exchange:   str = ""
    quote_type: str = ""


# ── Options ────────────────────────────────────────────────────────────────────

@dataclass
class OptionChainResult:
    """Option chain for a single expiry."""
    symbol: str
    expiry: str
    calls:  pd.DataFrame   # strike, lastPrice, bid, ask, volume, openInterest, impliedVolatility
    puts:   pd.DataFrame


# ── ETF ────────────────────────────────────────────────────────────────────────

@dataclass
class ETFHolding:
    symbol:     str
    name:       str
    weight_pct: float


@dataclass
class ETFProfile:
    """ETF fund data — top holdings + sector weightings."""
    symbol:            str
    top_holdings:      list[ETFHolding] = field(default_factory=list)
    sector_weightings: dict[str, float] = field(default_factory=dict)


# ── Dividends ──────────────────────────────────────────────────────────────────

@dataclass
class DividendRecord:
    ex_date:  str    # YYYY-MM-DD
    amount:   float
    currency: str = "USD"


# ── Financials ─────────────────────────────────────────────────────────────────

@dataclass
class FinancialStatementLine:
    """One line item in a financial statement (typed row)."""
    label: str
    values: list[dict[str, object]]  # [{"year": "2024", "value": 123.4}, ...]


@dataclass
class FinancialStatements:
    """Structured financial statements."""
    symbol:        str
    income:        list[dict] = field(default_factory=list)   # _parse_income() shape
    cashflow:      list[dict] = field(default_factory=list)
    balance_sheet: list[dict] = field(default_factory=list)


# ── News ───────────────────────────────────────────────────────────────────────

@dataclass
class NewsItem:
    title:     str
    url:       str
    published: Optional[str] = None   # ISO 8601
    source:    Optional[str] = None
    summary:   Optional[str] = None


# ── Batch ──────────────────────────────────────────────────────────────────────

@dataclass
class BatchPriceResult:
    """Result from ``download()`` — symbol → latest close price."""
    prices: dict[str, Optional[float]]  # {"AAPL": 185.23, "MSFT": None}


# ── Batch Fast Info ────────────────────────────────────────────────────────────

@dataclass
class BatchQuoteResult:
    """Result from ``download_quotes()`` — symbol → QuoteSnapshot."""
    quotes: dict[str, QuoteSnapshot]
