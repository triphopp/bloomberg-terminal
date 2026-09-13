"""
Per-symbol Market State endpoints — the REGIME panel in NEWS and stock-view.

Two endpoints on purpose, because they answer two different questions and only
one of them is cheap:

    GET /api/market-state/{symbol}              what state is it in now
    GET /api/market-state/{symbol}/validation   does the state mean anything

The second refits the model walk-forward (tens of fits), so it is never called
on page load — the UI asks for it explicitly and it caches for a day.
"""
from __future__ import annotations

from fastapi import APIRouter, Query

from analytics import market_state
from analytics.market_state import hmm, validate
from cache import TTLCache

router = APIRouter(prefix="/api/market-state")

# One fit is ~1s on ten years of daily bars, and daily bars change once a day.
_cache = TTLCache(ttl=3600, maxsize=128)
# Tens of fits. Nothing about it changes intraday.
_validation_cache = TTLCache(ttl=86400, maxsize=64)


@router.get("/{symbol}")
def get_state(
    symbol: str,
    period: str = Query("10y", description="History window: 3y | 5y | 10y | max"),
    n_states: int = Query(hmm.DEFAULT_N_STATES, ge=2, le=6),
    history: int = Query(market_state.DEFAULT_HISTORY, ge=60, le=market_state.MAX_HISTORY),
):
    """Current Market State Vector, regime posterior and the series behind them."""
    key = f"{symbol.upper()}:{period}:{n_states}:{history}"
    cached = _cache.get(key)
    if cached is not None:
        return cached
    data = market_state.get_market_state(
        symbol, period=period, n_states=n_states, history_bars=history
    )
    # A failed fit must not be cached for an hour — the next reload should try
    # again rather than show a stale error the user cannot clear.
    if data.get("status") == "ok":
        _cache.set(key, data)
    return data


@router.get("/{symbol}/validation")
def get_validation(
    symbol: str,
    period: str = Query("max", description="History window; longer is better here"),
    n_states: int = Query(hmm.DEFAULT_N_STATES, ge=2, le=6),
):
    """Walk-forward refit: what actually followed each state, out-of-sample."""
    key = f"{symbol.upper()}:{period}:{n_states}"
    cached = _validation_cache.get(key)
    if cached is not None:
        return cached

    ohlcv = market_state.fetch_ohlcv(symbol, period)
    if ohlcv is None or len(ohlcv) < validate.MIN_TRAIN:
        return {
            "symbol": symbol.upper(),
            "status": "insufficient",
            "detail": f"{symbol.upper()} needs at least {validate.MIN_TRAIN} daily bars before a "
            "walk-forward refit says anything.",
        }

    data = validate.walk_forward(ohlcv, n_states=n_states)
    data["symbol"] = symbol.upper()
    data["period"] = period
    if data.get("status") == "ok":
        _validation_cache.set(key, data)
    return data
