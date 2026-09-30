"""RSS / Atom fetch with a timeout, over one pooled `requests.Session`.

`feedparser.parse(url)` fetches through urllib with no timeout at all, and
nothing in the backend sets `socket.setdefaulttimeout` — one feed that stops
answering holds its worker until the Next proxy gives up (45 s on the NEWS
watchlist). It also opens a fresh TLS connection per call and bypasses
`upstream_health`, which only watches `requests`. Fetch the bytes here, then
hand them to feedparser.
"""
from __future__ import annotations

import feedparser
import requests
from requests.adapters import HTTPAdapter

#: (connect, read) seconds. A healthy feed answers in < 2.5 s (measured 2026-09-30).
FEED_TIMEOUT = (4, 8)

_UA = "Mozilla/5.0 (compatible; BloombergTerminal/1.0; +news)"

_SESSION = requests.Session()
_SESSION.headers.update({"User-Agent": _UA})
# The NEWS watchlist runs ~6 symbols × 7 sources at once, several on one host
# (news.google.com, bing.com): the default pool of 10 would discard connections.
_adapter = HTTPAdapter(pool_connections=32, pool_maxsize=32)
_SESSION.mount("https://", _adapter)
_SESSION.mount("http://", _adapter)


def fetch_feed(url: str, *, headers: dict | None = None,
               timeout: tuple[float, float] = FEED_TIMEOUT) -> feedparser.FeedParserDict:
    """GET `url` and parse it. Raises on network errors and non-2xx answers."""
    res = _SESSION.get(url, headers=headers, timeout=timeout)
    res.raise_for_status()
    return feedparser.parse(res.content)
