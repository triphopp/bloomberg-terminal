"""
ProviderRegistry — runtime selection + automatic failover across N quote vendors.

Design goals:
  - provider-agnostic: never hardcodes a vendor name; works with any number
    of ``QuoteProvider`` implementations registered in priority order
  - manual switch: ``set_active(name)`` pins a provider (UI button)
  - auto-failover: if the active provider errors / returns empty / is
    unhealthy, transparently try the next healthy provider in priority order
  - cheap health: liveness probes are cached (default 30s) so failover
    decisions don't add a network round-trip to every request

Only the live-quote path lives here.  Heavy methods (options, financials)
stay on the primary source via FailoverSource — see failover_source.py.
"""
import threading
import time
from typing import Optional

from .models import BatchPriceResult, BatchQuoteResult, OHLCVFrame, QuoteSnapshot
from .quote_provider import QuoteProvider

_HEALTH_TTL = 30.0  # seconds — cache liveness probe results


class ProviderRegistry:
    def __init__(self, auto_failover: bool = True):
        self._providers: list[QuoteProvider] = []   # in priority order
        self._active: Optional[str] = None
        self._auto_failover = auto_failover
        self._health: dict[str, tuple[bool, float]] = {}  # name → (healthy, ts)
        self._lock = threading.Lock()
        self._last_served: Optional[str] = None      # which provider answered last

    # ── Registration / selection ────────────────────────────────────────────

    def register(self, provider: QuoteProvider) -> None:
        """Add a provider.  First registered becomes the default active one."""
        with self._lock:
            self._providers.append(provider)
            if self._active is None:
                self._active = provider.name

    def set_active(self, name: str) -> bool:
        """Manually pin the active provider.  Returns False if unknown."""
        with self._lock:
            if name not in [p.name for p in self._providers]:
                return False
            self._active = name
            return True

    def set_auto_failover(self, enabled: bool) -> None:
        with self._lock:
            self._auto_failover = enabled

    @property
    def active(self) -> Optional[str]:
        return self._active

    # ── Health ───────────────────────────────────────────────────────────────

    def _is_healthy(self, p: QuoteProvider) -> bool:
        cached = self._health.get(p.name)
        now = time.time()
        if cached and now - cached[1] < _HEALTH_TTL:
            return cached[0]
        ok = False
        try:
            ok = p.healthy()
        except Exception:
            ok = False
        self._health[p.name] = (ok, now)
        return ok

    def status(self) -> list[dict]:
        """Snapshot for the UI: each provider's name, label, health, active flag."""
        out = []
        for p in self._providers:
            out.append({
                "name": p.name,
                "label": p.label,
                "healthy": self._is_healthy(p),
                "active": p.name == self._active,
                "auto_failover": self._auto_failover,
                "last_served": p.name in (self._last_served or "").split("+"),
            })
        return out

    # ── Ordered candidate list ────────────────────────────────────────────────

    def _candidates(self) -> list[QuoteProvider]:
        """Active provider first, then the rest in priority order (for failover)."""
        if not self._providers:
            return []
        active = next((p for p in self._providers if p.name == self._active), None)
        rest = [p for p in self._providers if p.name != self._active]
        ordered = ([active] if active else []) + rest
        if not self._auto_failover:
            return ordered[:1]   # no failover → only the active provider
        return ordered

    # ── Quote-path operations (with failover) ─────────────────────────────────

    def get_quotes(self, symbols: list[str]) -> BatchQuoteResult:
        """Gap-fill across providers.

        Run the active provider first, then route only the still-missing
        symbols (``last_price is None``) to each next provider in priority
        order, merging the results.  A mixed batch (e.g. TH ``.BK`` + US
        tickers) is served by whichever provider can price each symbol —
        no provider needs to declare what it supports; the gaps drive it.
        """
        if not symbols:
            return BatchQuoteResult(quotes={})
        merged: dict[str, QuoteSnapshot] = {s: QuoteSnapshot(symbol=s) for s in symbols}
        pending = list(symbols)
        served: list[str] = []
        for p in self._candidates():
            if not pending:
                break
            try:
                res = p.get_quotes(pending)
            except Exception:
                continue
            filled = False
            for sym, q in res.quotes.items():
                if q and q.last_price is not None and merged[sym].last_price is None:
                    merged[sym] = q
                    filled = True
            if filled:
                served.append(p.name)
            pending = [s for s in pending if merged[s].last_price is None]
        if served:
            self._last_served = served[0] if len(served) == 1 else "+".join(served)
        return BatchQuoteResult(quotes=merged)

    def get_quote(self, symbol: str) -> QuoteSnapshot:
        for p in self._candidates():
            try:
                q = p.get_quote(symbol)
            except Exception:
                continue
            if q and q.last_price is not None:
                self._last_served = p.name
                return q
        return QuoteSnapshot(symbol=symbol)

    def get_history(self, symbol: str, period: str = "1mo",
                    interval: str = "1d") -> OHLCVFrame:
        from .models import OHLCVFrame as _F
        last = _F(symbol=symbol, df=_empty_df())
        for p in self._candidates():
            try:
                frame = p.get_history(symbol, period=period, interval=interval)
            except Exception:
                continue
            if frame is not None and not frame.df.empty:
                self._last_served = p.name
                return frame
            if frame is not None:
                last = frame
        return last

    def download(self, symbols: list[str], period: str = "1y",
                 interval: str = "1d") -> BatchPriceResult:
        if not symbols:
            return BatchPriceResult(prices={})
        merged: dict[str, Optional[float]] = {s: None for s in symbols}
        pending = list(symbols)
        served: list[str] = []
        for p in self._candidates():
            if not pending:
                break
            try:
                res = p.download(pending, period=period, interval=interval)
            except Exception:
                continue
            filled = False
            for sym, val in res.prices.items():
                if val is not None and merged[sym] is None:
                    merged[sym] = val
                    filled = True
            if filled:
                served.append(p.name)
            pending = [s for s in pending if merged[s] is None]
        if served:
            self._last_served = served[0] if len(served) == 1 else "+".join(served)
        return BatchPriceResult(prices=merged)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _empty_df():
    import pandas as pd
    return pd.DataFrame()
