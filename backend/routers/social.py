"""
Multi-platform social feed aggregator.
Supported platforms: Facebook (RSSHub), Twitter/X (Nitter RSS), YouTube (official RSS), Reddit (official RSS), generic RSS.
"""
import calendar
import datetime
import json
from concurrent.futures import ThreadPoolExecutor, as_completed

import feedparser
from fastapi import APIRouter, Query

from cache import TTLCache
from config import RSSHUB_URL

router = APIRouter()

_social_cache = TTLCache(ttl=300, maxsize=200)

# Nitter instances to try in order (many go offline; try multiple)
_NITTER_INSTANCES = [
    "nitter.privacydev.net",
    "nitter.poast.org",
    "nitter.1d4.us",
    "nitter.net",
    "nitter.kavin.rocks",
]

_UA = "Mozilla/5.0 (compatible; BloombergTerminal/1.0)"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _struct_to_iso(struct) -> str:
    try:
        return datetime.datetime.utcfromtimestamp(calendar.timegm(struct)).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return ""


def _parse_rss(url: str, platform: str, handle: str, limit: int) -> list[dict]:
    feed = feedparser.parse(url, request_headers={"User-Agent": _UA})
    if feed.get("bozo") and not feed.entries:
        exc_str = str(feed.get("bozo_exception", ""))
        if "not well-formed" in exc_str or "invalid token" in exc_str:
            raise RuntimeError("Feed returned HTML instead of XML — RSSHub route may be disabled or requires auth")
        raise RuntimeError(exc_str or "empty feed")

    display_name = (feed.feed.get("title") or handle).strip()
    posts = []
    for entry in feed.entries[:limit]:
        title = (entry.get("title") or "").strip()
        link  = entry.get("link", "").strip()
        if not title and not link:
            continue
        struct    = entry.get("published_parsed") or entry.get("updated_parsed")
        thumbnail = None
        if hasattr(entry, "media_thumbnail") and entry.media_thumbnail:
            thumbnail = entry.media_thumbnail[0].get("url")
        elif hasattr(entry, "yt_videoid") and entry.yt_videoid:
            thumbnail = f"https://img.youtube.com/vi/{entry.yt_videoid}/mqdefault.jpg"
        posts.append({
            "platform":    platform,
            "handle":      handle,
            "display_name": display_name,
            "title":       title or link,
            "url":         link,
            "published_at": _struct_to_iso(struct) if struct else "",
            "thumbnail":   thumbnail,
        })
    return posts


# ── Platform fetchers ─────────────────────────────────────────────────────────


def _fetch_twitter(handle: str, limit: int) -> list[dict]:
    handle = handle.lstrip("@").strip()
    # Try RSSHub first (works if user has their own RSSHub with Twitter route)
    try:
        posts = _parse_rss(f"{RSSHUB_URL}/twitter/user/{handle}", "twitter", handle, limit)
        if posts:
            return posts
    except Exception:
        pass
    # Fall back to Nitter RSS instances
    for instance in _NITTER_INSTANCES:
        try:
            posts = _parse_rss(f"https://{instance}/{handle}/rss", "twitter", handle, limit)
            if posts:
                return posts
        except Exception:
            continue
    return []


def _fetch_youtube(channel: str, limit: int) -> list[dict]:
    channel = channel.strip()
    # Try channel_id feed first (UC... format)
    if channel.startswith("UC") and len(channel) > 10:
        url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel}"
    elif channel.startswith("@"):
        # @handle → try user feed; YouTube also accepts this format
        url = f"https://www.youtube.com/feeds/videos.xml?user={channel[1:]}"
    else:
        url = f"https://www.youtube.com/feeds/videos.xml?user={channel}"
    return _parse_rss(url, "youtube", channel, limit)


def _fetch_reddit(subreddit: str, limit: int) -> list[dict]:
    subreddit = subreddit.strip().lstrip("/").removeprefix("r/")
    url = f"https://www.reddit.com/r/{subreddit}/.rss"
    return _parse_rss(url, "reddit", subreddit, limit)


def _fetch_generic_rss(rss_url: str, limit: int) -> list[dict]:
    return _parse_rss(rss_url.strip(), "rss", rss_url, limit)


_FETCHERS = {
    "twitter": _fetch_twitter,
    "youtube": _fetch_youtube,
    "reddit":  _fetch_reddit,
    "rss":     _fetch_generic_rss,
}


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.get("/api/social/feed")
def social_feed(
    handles: str = Query(..., description='JSON map: {"facebook":["page"],"youtube":["UCxxx"],"reddit":["sub"],"twitter":["handle"],"rss":["url"]}'),
    limit: int = Query(default=50, le=200),
):
    """Unified multi-platform social feed — Facebook, Twitter/X, YouTube, Reddit, generic RSS."""
    try:
        handle_map: dict[str, list[str]] = json.loads(handles)
    except Exception:
        return {"posts": [], "errors": ["Invalid handles JSON"]}

    cache_key = f"social:{handles}:{limit}"
    cached = _social_cache.get(cache_key)
    if cached is not None:
        return cached

    total_handles = sum(len(v) for v in handle_map.values())
    per_handle    = max(10, limit // max(total_handles, 1))

    all_posts: list[dict] = []
    errors:    list[str]  = []

    tasks: list[tuple] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for platform, handles_list in handle_map.items():
            fetcher = _FETCHERS.get(platform)
            if not fetcher:
                continue
            for hdl in handles_list:
                future = pool.submit(fetcher, hdl, per_handle)
                tasks.append((future, platform, hdl))

        for future, platform, hdl in tasks:
            try:
                all_posts.extend(future.result())
            except Exception as exc:
                print(f"[social] {platform}/{hdl}: {exc}")
                errors.append(f"{platform}/{hdl}: {exc}")

    all_posts.sort(key=lambda x: x.get("published_at", ""), reverse=True)
    result = {"posts": all_posts[:limit], "errors": errors}
    _social_cache.set(cache_key, result)
    return result
