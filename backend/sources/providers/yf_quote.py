"""
yfinance QuoteProvider — thin adapter over the existing YFinanceSource.

This is the primary (default) price vendor.  It delegates to the same
``YFinanceSource`` instance the rest of the app already uses, so there is
no duplicated yfinance logic here.
"""
from ..base import MarketDataSource
from ..models import BatchPriceResult, BatchQuoteResult, OHLCVFrame, QuoteSnapshot
from ..quote_provider import QuoteProvider


class YFQuoteProvider(QuoteProvider):
    name = "yfinance"
    label = "Yahoo Finance"

    def __init__(self, source: MarketDataSource):
        self._source = source

    def healthy(self) -> bool:
        try:
            q = self._source.get_fast_info("AAPL")
            return q is not None and q.last_price is not None
        except Exception:
            return False

    def get_quotes(self, symbols: list[str]) -> BatchQuoteResult:
        return self._source.download_quotes(symbols)

    def get_quote(self, symbol: str) -> QuoteSnapshot:
        try:
            return self._source.get_fast_info(symbol)
        except Exception:
            return QuoteSnapshot(symbol=symbol)

    def get_history(self, symbol: str, period: str = "1mo",
                    interval: str = "1d") -> OHLCVFrame:
        return self._source.get_history(symbol, period=period, interval=interval)

    def download(self, symbols: list[str], period: str = "1y",
                 interval: str = "1d") -> BatchPriceResult:
        return self._source.download(symbols, period=period, interval=interval)
