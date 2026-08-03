"""
Trading-session freshness — "is this quote from TODAY's session?"

Why this exists
---------------
A quote's day change is ``last_price - previous_close``. Yahoo keeps serving the
LAST COMPLETED session's pair once a market closes, so before the US open a
Bangkok user sees Friday's -7.35% on AAPL labelled as today's move. Nothing in
the numbers themselves reveals this: the values are internally consistent, just
from the wrong day.

The only reliable discriminator is the timestamp of the last regular trade,
compared against the current date **in the exchange's own timezone** (comparing
against server-local time gets Asia/US pairs wrong by a whole day).

Cost
----
``regularMarketTime`` lives in the heavy ``.info`` payload, not in ``fast_info``.
Fetching it per symbol would undo the batched fast-quote path callers rely on —
but the answer is a property of the EXCHANGE, not the symbol. So we probe one
representative symbol per exchange and cache the verdict briefly: a portfolio
spanning NMS + SET + CMX costs 3 probes instead of 40.

Keyed on the exchange code (NMS, SET, CMX, …) rather than the timezone, because
venues sharing a timezone do NOT share a session: COMEX gold (CMX) trades
through the night that Nasdaq equities (NMS) sit closed, and a timezone-keyed
cache would hand gold the equities' "stale" verdict.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone as dt_timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from cache import TTLCache
from sources import market_data

logger = logging.getLogger(__name__)

# Short TTL: the verdict flips at the opening bell and we want the UI to notice
# within a minute of it, not a refresh later.
_probe_cache: TTLCache = TTLCache(ttl=120, maxsize=50)

# Markets that never close — a "previous session" never goes stale for them.
_ALWAYS_OPEN_QUOTE_TYPES = {"CRYPTOCURRENCY", "CURRENCY"}


def _local_today(tz_name: str) -> Optional[str]:
    """Current calendar date inside the exchange's timezone."""
    try:
        return datetime.now(ZoneInfo(tz_name)).strftime("%Y-%m-%d")
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        return None


def local_date_of(epoch, tz_name: Optional[str]) -> Optional[str]:
    """Exchange-local calendar date of a Yahoo epoch timestamp."""
    if not isinstance(epoch, (int, float)) or epoch <= 0 or not tz_name:
        return None
    try:
        stamped = datetime.fromtimestamp(float(epoch), dt_timezone.utc)
        return stamped.astimezone(ZoneInfo(tz_name)).strftime("%Y-%m-%d")
    except (ZoneInfoNotFoundError, ValueError, TypeError, OSError, OverflowError):
        return None


def is_today_at(epoch, tz_name: Optional[str]) -> bool:
    """True when `epoch` falls on the current exchange-local date.

    Fails OPEN like `is_current_session`: an unreadable timestamp counts as
    today rather than blanking the field.
    """
    stamp_date = local_date_of(epoch, tz_name)
    if stamp_date is None or not tz_name:
        return True
    today = _local_today(tz_name)
    return today is None or stamp_date == today


def probe_session(probe_symbol: str, tz_name: str, exchange: Optional[str] = None) -> dict:
    """Last regular-session date + market state for `probe_symbol`'s exchange.

    `probe_symbol` is any symbol trading on that exchange; the result is cached
    under `exchange` and reused for every other symbol listed there.

    Returns ``{"session_date", "market_state", "quote_type"}`` — all optional,
    every field ``None`` when the probe fails (callers must degrade to "assume
    current", never to "hide everything").
    """
    if not tz_name:
        return {"session_date": None, "market_state": None, "quote_type": None}

    # Fall back to the symbol itself when the exchange is unknown, so an
    # unlabelled symbol gets its own verdict instead of borrowing a stranger's.
    cache_key = exchange or f"sym:{probe_symbol}"
    cached = _probe_cache.get(cache_key)
    if cached is not None:
        return cached

    result = {"session_date": None, "market_state": None, "quote_type": None}
    try:
        raw = market_data.get_info(probe_symbol).raw or {}
        market_time = raw.get("regularMarketTime")
        # Yahoo reports the exchange's own tz here; trust it over the caller's.
        tz_for_stamp = raw.get("exchangeTimezoneName") or tz_name
        result["market_state"] = raw.get("marketState")
        result["quote_type"] = (raw.get("quoteType") or "").upper() or None
        if isinstance(market_time, (int, float)) and market_time > 0:
            stamped = datetime.fromtimestamp(float(market_time), dt_timezone.utc)
            try:
                stamped = stamped.astimezone(ZoneInfo(tz_for_stamp))
            except (ZoneInfoNotFoundError, ValueError, TypeError):
                pass
            result["session_date"] = stamped.strftime("%Y-%m-%d")
    except Exception as exc:  # network, rate limit, unknown symbol
        logger.debug("session probe failed for %s (%s): %s", probe_symbol, cache_key, exc)

    _probe_cache.set(cache_key, result)
    return result


def is_current_session(
    probe_symbol: str, tz_name: Optional[str], exchange: Optional[str] = None
) -> bool:
    """True when the latest quote for this exchange belongs to today's session.

    Fails OPEN: anything we cannot determine (no timezone, probe error, 24/7
    market) counts as current, so a data hiccup never blanks a whole portfolio.
    """
    if not tz_name:
        return True

    info = probe_session(probe_symbol, tz_name, exchange)

    if info.get("quote_type") in _ALWAYS_OPEN_QUOTE_TYPES:
        return True

    session_date = info.get("session_date")
    if not session_date:
        return True

    today = _local_today(tz_name)
    if today is None:
        return True

    return session_date == today


def session_date_for(
    probe_symbol: str, tz_name: Optional[str], exchange: Optional[str] = None
) -> Optional[str]:
    """Exchange-local date of the quote currently being served, if known."""
    if not tz_name:
        return None
    return probe_session(probe_symbol, tz_name, exchange).get("session_date")
