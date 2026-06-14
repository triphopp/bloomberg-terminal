"""
FailoverSource — the singleton routers import as ``market_data``.

It is a thin facade with two backends:
  - the *quote path* (latest quote / price / recent history) is routed through
    a ``ProviderRegistry`` → manual switch + automatic failover across vendors
  - everything else (options chains, financials, ETF holdings, news, search,
    deprecated ``get_ticker`` access) is delegated unchanged to the *primary*
    ``MarketDataSource`` (yfinance), which has the widest free coverage

Routers keep doing ``from sources import market_data`` and calling the same
methods — they are unaware a registry sits underneath the price calls.
"""
from .base import MarketDataSource
from .models import BatchPriceResult, BatchQuoteResult, OHLCVFrame, QuoteSnapshot
from .registry import ProviderRegistry


class FailoverSource:
    """Quote-path → registry; all other methods → primary source."""

    def __init__(self, primary: MarketDataSource, registry: ProviderRegistry):
        self._primary = primary
        self.registry = registry

    # ── Quote path (registry: switch + failover) ─────────────────────────────

    def download_quotes(self, symbols: list[str]) -> BatchQuoteResult:
        return self.registry.get_quotes(symbols)

    def download(self, symbols: list[str], period: str = "1y",
                 interval: str = "1d") -> BatchPriceResult:
        return self.registry.download(symbols, period=period, interval=interval)

    def get_history(self, symbol: str, period: str = "1mo",
                    interval: str = "1d") -> OHLCVFrame:
        return self.registry.get_history(symbol, period=period, interval=interval)

    def get_fast_info(self, symbol: str) -> QuoteSnapshot:
        return self.registry.get_quote(symbol)

    # ── Everything else → primary (yfinance) ─────────────────────────────────

    def __getattr__(self, name: str):
        # Only reached for attributes not defined on FailoverSource itself
        # (e.g. get_info, search, get_option_chain, get_financials, get_ticker).
        return getattr(self._primary, name)
