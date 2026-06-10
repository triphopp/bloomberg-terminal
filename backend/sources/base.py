"""
Abstract interface for market data providers.

Every method returns a canonical model from ``sources.models``.
Implementations wrap specific providers (yfinance, Polygon, etc.) so routers
never import vendor SDKs directly.

To add a new provider:
  1. Subclass ``MarketDataSource`` and implement every abstract method.
  2. Swap the singleton in ``sources/__init__.py`` (one line).
"""
from abc import ABC, abstractmethod

from .models import (
    QuoteSnapshot,
    TickerDetail,
    OHLCVFrame,
    SearchResult,
    OptionChainResult,
    ETFProfile,
    DividendRecord,
    FinancialStatements,
    NewsItem,
    BatchPriceResult,
    BatchQuoteResult,
)


class MarketDataSource(ABC):
    """Contract for market data operations."""

    # ── Quote ──────────────────────────────────────────────────────────────

    @abstractmethod
    def get_fast_info(self, symbol: str) -> QuoteSnapshot:
        """Return a typed quote snapshot (last_price, previous_close, etc.).

        Field names match the yfinance ``fast_info`` attributes that routers
        already use (``.last_price``, ``.previous_close``), so existing code
        continues to work after the return type changes.
        """
        ...

    @abstractmethod
    def get_info(self, symbol: str) -> TickerDetail:
        """Return full ticker metadata as a typed model.

        Supports both attribute access (``detail.pe_ratio``) and the
        backward-compatible ``detail.get("trailingPE")`` / ``detail["key"]``
        bracket access via the ``raw`` fallback.
        """
        ...

    # ── OHLCV ──────────────────────────────────────────────────────────────

    @abstractmethod
    def get_history(self, symbol: str, period: str = "1mo",
                    interval: str = "1d") -> OHLCVFrame:
        """Return historical OHLCV data with canonical column names."""
        ...

    # ── Batch ──────────────────────────────────────────────────────────────

    @abstractmethod
    def download(self, symbols: list[str],
                 period: str = "1y", interval: str = "1d") -> BatchPriceResult:
        """Batch-download latest close prices for multiple symbols."""
        ...

    @abstractmethod
    def download_quotes(self, symbols: list[str]) -> BatchQuoteResult:
        """Batch-fetch QuoteSnapshots for multiple symbols."""
        ...

    # ── Search ─────────────────────────────────────────────────────────────

    @abstractmethod
    def search(self, query: str, max_results: int = 10) -> list[SearchResult]:
        """Search for symbols by name/ticker."""
        ...

    # ── Options ────────────────────────────────────────────────────────────

    @abstractmethod
    def get_option_expirations(self, symbol: str) -> list[str]:
        """Return available option expiration dates."""
        ...

    @abstractmethod
    def get_option_chain(self, symbol: str, expiry: str) -> OptionChainResult:
        """Return option chain (calls + puts) for an expiry."""
        ...

    # ── ETF ────────────────────────────────────────────────────────────────

    @abstractmethod
    def get_funds_data(self, symbol: str) -> ETFProfile:
        """Return ETF top holdings and sector weightings."""
        ...

    # ── New typed methods (replace get_ticker() bypass) ────────────────────

    @abstractmethod
    def get_dividends(self, symbol: str) -> list[DividendRecord]:
        """Return dividend history for a symbol."""
        ...

    @abstractmethod
    def get_financials(self, symbol: str) -> FinancialStatements:
        """Return income statement, cashflow, and balance sheet."""
        ...

    @abstractmethod
    def get_news(self, symbol: str, max_results: int = 10) -> list[NewsItem]:
        """Return recent news articles for a symbol."""
        ...

    # ── Deprecated — remove after router migration ─────────────────────────

    def get_batch_tickers(self, symbols: list[str]):
        """Deprecated — use ``download_quotes()`` instead.

        Returns a yfinance ``Tickers`` object.  Only used by crypto.py and
        fx.py for batch fast_info access.  Migrate to ``download_quotes()``
        then remove this method.
        """
        raise NotImplementedError("Migrate to download_quotes()")

    def get_ticker(self, symbol: str):
        """Deprecated — use typed methods instead.

        Returns the raw provider ticker object.  Each call site should be
        migrated to a specific typed method:

        - ``ticker.fast_info``     → ``get_fast_info()``
        - ``ticker.info``          → ``get_info()``
        - ``ticker.history(...)``  → ``get_history()``
        - ``ticker.dividends``     → ``get_dividends()``
        - ``ticker.news``          → ``get_news()``
        - ``ticker.financials``    → ``get_financials()``
        - ``ticker.options``       → ``get_option_expirations()``
        - ``ticker.option_chain()``→ ``get_option_chain()``
        - ``ticker.funds_data``    → ``get_funds_data()``
        """
        raise NotImplementedError("Use typed methods instead of get_ticker()")
