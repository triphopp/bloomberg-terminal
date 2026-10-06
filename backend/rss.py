"""RSS / Atom fetch with a timeout, over one pooled `requests.Session`.

`feedparser.parse(url)` fetches through urllib with no timeout at all, and
nothing in the backend sets `socket.setdefaulttimeout` — one feed that stops
answering holds its worker until the Next proxy gives up (45 s on the NEWS
watchlist). It also opens a fresh TLS connection per call and bypasses
`upstream_health`, which only watches `requests`. Fetch the bytes here, then
parse them.

Two parsers:

* `fetch_items` / `parse_items` — the headline path. ElementTree (C) reads the
  four fields a headline row needs. feedparser is pure Python and sanitises
  every entry: 44 ms for one Google News answer (100 entries, 124 KB) of which
  6 are kept, ~2.8 s of GIL-bound work across a 26-symbol watchlist — the
  threads fetching the other feeds wait behind it (measured 2026-10-05).
* `fetch_feed` — full feedparser object, for callers that need the rest.
"""
from __future__ import annotations

import datetime
import html
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

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


def fetch_items(url: str, *, headers: dict | None = None, limit: int | None = None,
                timeout: tuple[float, float] = FEED_TIMEOUT) -> tuple[str, list[dict]]:
    """GET `url` → (feed title, items). Raises on network errors and non-2xx answers."""
    res = _SESSION.get(url, headers=headers, timeout=timeout)
    res.raise_for_status()
    return parse_items(res.content, limit)


# ── Fast item parser ──────────────────────────────────────────────────────────

def _iso_utc(dt: datetime.datetime) -> str:
    if dt.tzinfo is not None:
        dt = dt.astimezone(datetime.timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def to_iso(value: str) -> str:
    """RFC 822 (RSS pubDate) or ISO 8601 (Atom) → `YYYY-MM-DDTHH:MM:SSZ` in UTC.
    A date without a zone is read as UTC, as feedparser does. Unreadable → ""."""
    value = (value or "").strip()
    if not value:
        return ""
    try:
        if value[:4].isdigit() and "-" in value[:8]:
            return _iso_utc(datetime.datetime.fromisoformat(value.replace("Z", "+00:00")))
        return _iso_utc(parsedate_to_datetime(value))
    except Exception:
        return ""


def _local(tag) -> str:
    # Comments and processing instructions carry a function as their tag.
    return tag.rpartition("}")[2].lower() if isinstance(tag, str) else ""


def _text(el) -> str:
    """Element text with entities resolved twice over — feeds escape HTML inside
    XML, so "AT&amp;amp;T" is what an "AT&T" headline often looks like."""
    if len(el):  # Atom xhtml content: text is spread over child elements
        return html.unescape("".join(el.itertext())).strip()
    return html.unescape(el.text or "").strip()


def _item(el) -> dict:
    title = link = summary = content = published = updated = thumbnail = video_id = ""
    for child in el:
        name = _local(child.tag)
        if name == "title":
            # `media:title` sits inside media:group, not here — this is the item's own.
            title = title or _text(child)
        elif name == "link":
            href = child.get("href")
            if href is None:
                link = link or (child.text or "").strip()
            elif child.get("rel", "alternate") == "alternate":
                link = href.strip()
            elif not link:
                link = href.strip()
        elif name in ("description", "summary"):
            summary = summary or _text(child)
        elif name == "content":
            content = content or _text(child)
        elif name in ("pubdate", "published"):
            published = published or (child.text or "")
        elif name in ("updated", "date"):
            updated = updated or (child.text or "")
        elif name == "thumbnail":
            thumbnail = thumbnail or (child.get("url") or "")
        elif name == "videoid":
            video_id = (child.text or "").strip()
        elif name == "group":  # media:group (YouTube) holds the thumbnail
            for sub in child:
                if _local(sub.tag) == "thumbnail" and not thumbnail:
                    thumbnail = sub.get("url") or ""
    return {
        "title": title,
        "link": link,
        "summary": summary or content,
        "published": to_iso(published) or to_iso(updated),
        "thumbnail": thumbnail,
        "video_id": video_id,
    }


def _via_feedparser(content: bytes, limit: int | None) -> tuple[str, list[dict]]:
    """Same shape from feedparser, which reads XML that is not well-formed."""
    import calendar

    feed = feedparser.parse(content)
    if feed.get("bozo") and not feed.entries:
        raise ValueError(str(feed.get("bozo_exception") or "empty feed"))

    def iso(struct) -> str:
        try:
            return _iso_utc(datetime.datetime.utcfromtimestamp(calendar.timegm(struct)))
        except Exception:
            return ""

    items = []
    for entry in feed.entries[:limit]:
        struct = entry.get("published_parsed") or entry.get("updated_parsed")
        thumbs = entry.get("media_thumbnail") or []
        items.append({
            "title": (entry.get("title") or "").strip(),
            "link": (entry.get("link") or "").strip(),
            "summary": entry.get("summary") or "",
            "published": iso(struct) if struct else "",
            "thumbnail": (thumbs[0].get("url") or "") if thumbs else "",
            "video_id": entry.get("yt_videoid") or "",
        })
    return (feed.feed.get("title") or "").strip(), items


def parse_items(content: bytes, limit: int | None = None) -> tuple[str, list[dict]]:
    """(feed title, items) from RSS 2.0, RSS 1.0 (RDF) or Atom bytes.

    Each item: title, link, summary, published (ISO UTC or ""), thumbnail,
    video_id. Text has entities resolved; tags inside it are left for the
    caller. Stops after `limit` items. Raises ValueError when the bytes are
    not a feed at all (an HTML error page, an empty body).
    """
    body = content.lstrip()
    if not body:
        raise ValueError("empty body")
    # An inline DTD can define entities; none of the feeds read here needs one,
    # so leave those to feedparser, which drops them.
    if b"<!ENTITY" in body[:8192]:
        return _via_feedparser(content, limit)
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return _via_feedparser(content, limit)

    kind = _local(root.tag)
    if kind == "rss":
        channel = next((c for c in root if _local(c.tag) == "channel"), None)
        if channel is None:
            raise ValueError("rss without a channel")
        holders, item_tag = [channel], "item"
    elif kind == "rdf":
        channel = next((c for c in root if _local(c.tag) == "channel"), None)
        holders, item_tag = [root], "item"
    elif kind == "feed":
        channel, holders, item_tag = root, [root], "entry"
    else:
        raise ValueError(f"not a feed: <{kind}>")

    feed_title = ""
    if channel is not None:
        title_el = next((c for c in channel if _local(c.tag) == "title"), None)
        feed_title = _text(title_el) if title_el is not None else ""

    items: list[dict] = []
    for holder in holders:
        for el in holder:
            if _local(el.tag) != item_tag:
                continue
            items.append(_item(el))
            if limit is not None and len(items) >= limit:
                return feed_title, items
    return feed_title, items
