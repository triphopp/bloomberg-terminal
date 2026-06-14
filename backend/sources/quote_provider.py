"""
QuoteProvider — narrow, swappable interface for the *live-quote path only*.

Why a second, smaller interface alongside ``MarketDataSource``?
  Heavy methods (options chains, financials, ETF holdings, news) are only
  served well by yfinance among free sources.  But the freshness-sensitive
  methods (latest price / quote / recent history) can come from *any* vendor.
  Splitting them lets us run multiple price vendors behind a registry with
  manual switching + automatic failover, while heavy methods stay on the
  primary source untouched.

A provider implements only price/quote/history.  Anything it cannot serve
should return an empty/None-filled model (never raise) so the registry can
detect the gap and fail over.
"""
from abc import ABC, abstractmethod

from .models import BatchPriceResult, BatchQuoteResult, OHLCVFrame, QuoteSnapshot


class QuoteProvider(ABC):
    """Contract for a price/quote vendor (one of possibly many)."""

    #: Stable identifier shown in the UI and used by ``set_active(name)``.
    name: str = "base"

    #: Human-readable label for the switch UI.
    label: str = "Base"

    @abstractmethod
    def healthy(self) -> bool:
        """Cheap liveness probe — True if the vendor is reachable right now.

        Implementations should be fast (single tiny request, short timeout)
        and must never raise; return False on any error.
        """
        ...

    @abstractmethod
    def get_quotes(self, symbols: list[str]) -> BatchQuoteResult:
        """Batch latest quotes.  Missing symbols → empty QuoteSnapshot."""
        ...

    @abstractmethod
    def get_quote(self, symbol: str) -> QuoteSnapshot:
        """Single latest quote.  Unknown symbol → empty QuoteSnapshot."""
        ...

    @abstractmethod
    def get_history(self, symbol: str, period: str = "1mo",
                    interval: str = "1d") -> OHLCVFrame:
        """Historical OHLCV.  Unsupported → OHLCVFrame with empty df."""
        ...

    @abstractmethod
    def download(self, symbols: list[str], period: str = "1y",
                 interval: str = "1d") -> BatchPriceResult:
        """Batch latest close prices.  Missing → None."""
        ...
