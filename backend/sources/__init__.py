"""
Market-data source wiring.

``market_data`` is the singleton every router imports.  It is a FailoverSource
facade: the live-quote path goes through a multi-vendor registry (manual switch
+ auto-failover), while heavy methods delegate to the primary yfinance source.

To add a price vendor: implement ``QuoteProvider``, then ``registry.register()``
it below — no router changes needed.
"""
from config import QUOTE_AUTO_FAILOVER, QUOTE_PROVIDER_DEFAULT

from .failover_source import FailoverSource
from .providers.stooq_quote import StooqQuoteProvider
from .providers.yf_quote import YFQuoteProvider
from .registry import ProviderRegistry
from .yfinance_source import YFinanceSource

# Primary full-coverage source (heavy methods + yfinance quote vendor)
_primary = YFinanceSource()

# Quote-path registry — priority order = registration order
registry = ProviderRegistry(auto_failover=QUOTE_AUTO_FAILOVER)
registry.register(YFQuoteProvider(_primary))   # default active (first registered)
registry.register(StooqQuoteProvider())        # keyless free fallback

# Honor configured default active provider (falls back to first if unknown)
registry.set_active(QUOTE_PROVIDER_DEFAULT)

market_data = FailoverSource(_primary, registry)

__all__ = ["market_data", "registry"]
