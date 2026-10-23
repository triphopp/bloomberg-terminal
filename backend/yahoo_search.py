"""
Yahoo Finance search, news only — read fresh on every call.

Not `yf.Search`: it reads through `YfData.cache_get`, an `lru_cache` that lives
as long as the process. Yahoo now and then answers a search with no stories,
and that one empty answer was then served for the same query until the backend
restarted — REFRESH and every 5-min cache above it could not reach past it
(2026-10-23: NEWS → MACRO "economy" was empty in the server for hours while a
fresh process got 27 stories). Callers keep their own TTL cache instead.

`YfData().get` still carries yfinance's cookie/crumb handling, and every call
goes through the app's Yahoo gate (`yahoo_gate.py`) and `upstream_health`.
"""

from __future__ import annotations

from yfinance.const import _BASE_URL_
from yfinance.data import YfData

import upstream_health

SEARCH_URL = f"{_BASE_URL_}/v1/finance/search"


def search_news(query: str, count: int, timeout: float = 15) -> list[dict]:
    """The `news` list of a Yahoo search: dicts with title, link, publisher,
    providerPublishTime, relatedTickers. Raises when Yahoo's answer is not a
    search result; an empty list is a real (if suspicious) answer."""
    params = {
        "q": query,
        "quotesCount": 0,
        "newsCount": count,
        "enableFuzzyQuery": True,
        "quotesQueryId": "tss_match_phrase_query",
        "newsQueryId": "news_cie_vespa",
        "listsCount": 0,
        "enableCb": False,
        "enableNavLinks": False,
        "enableResearchReports": False,
        "enableCulturalAssets": False,
        "recommendedCount": 0,
    }
    resp = YfData().get(SEARCH_URL, params=params, timeout=timeout)
    resp.raise_for_status()
    news = resp.json().get("news")
    if not isinstance(news, list):
        raise RuntimeError("search answer has no news list")
    if not news:
        # The gate logged this 200 as a call that went fine; say otherwise.
        upstream_health.record("Yahoo", "empty", target=upstream_health.target_of(SEARCH_URL))
    return news
