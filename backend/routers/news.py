"""
News feed endpoints — Facebook social feed + multi-source financial newswire.
"""
import datetime
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

import requests
import yfinance as yf  # yf.Search for topic-based news (no typed wrapper yet)
from fastapi import APIRouter, Query

from cache import TTLCache
from config import FACEBOOK_TOKEN, RSSHUB_URL, FB_CACHE_TTL
from rss import fetch_feed, fetch_items
from sources import market_data

router = APIRouter()

# ── Module-level caches ───────────────────────────────────────────────────────
_fb_cache   = TTLCache(ttl=FB_CACHE_TTL, maxsize=50)
# /api/news/feed, two layers:
#   _feed_cache   topics+limit → {"data", "ts"}. Fresh for 5 min; up to 30 min
#                 old it is served at once while a refresh runs behind it.
#   _piece_cache  one topic search / one RSS feed, 5 min. Adding or removing a
#                 topic re-reads only the piece that is new.
_FEED_FRESH_S = 300
_feed_cache = TTLCache(ttl=1800, maxsize=100)
_piece_cache = TTLCache(ttl=_FEED_FRESH_S, maxsize=200)
_feed_pool = ThreadPoolExecutor(max_workers=10, thread_name_prefix="news-feed")
_feed_refreshing: set[str] = set()
_feed_refresh_lock = threading.Lock()
#: Headlines asked of yfinance per topic, rounded up to one of these — so a
#: topic's cache entry does not change with every other topic added or removed.
_TOPIC_BUCKETS = (30, 80, 150)

# ── Curated free RSS feeds (no auth) ─────────────────────────────────────────
# Dropped 2026-09-30: Reuters (feeds.reuters.com no longer resolves) and
# Investopedia (403 with a 680 KB error page on every call). MarketWatch points
# at the Dow Jones URL its old address 301s to.
_RSS_FEEDS: dict[str, str] = {
    "Yahoo Finance": "https://finance.yahoo.com/rss/topfinstories",
    "CNBC":          "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114",
    "MarketWatch":   "https://feeds.content.dowjones.io/public/rss/mw_topstories",
}


# ── Helpers ──────────────────────────────────────────────────────────────────

def _extract_fb_username(raw: str) -> str:
    """Extract page username/ID from a Facebook URL or plain username."""
    raw = raw.strip().rstrip("/")
    try:
        parsed = urlparse(raw if raw.startswith("http") else f"https://{raw}")
        if "facebook.com" in (parsed.netloc or ""):
            parts = [p for p in parsed.path.split("/") if p]
            return parts[0] if parts else raw
    except Exception:
        pass
    return raw


def _fetch_via_rsshub(username: str, limit: int) -> list[dict]:
    """Fetch Facebook page posts via RSSHub RSS feed."""
    feed = fetch_feed(
        f"{RSSHUB_URL}/facebook/page/{username}",
        headers={"User-Agent": "Mozilla/5.0 (compatible; BloombergTerminal/1.0)"},
    )
    if feed.get("bozo") and not feed.entries:
        raise RuntimeError(f"feedparser bozo: {feed.get('bozo_exception')}")

    page_name = feed.feed.get("title", username)
    # Strip trailing " - Facebook" that RSSHub sometimes includes
    page_name = page_name.removesuffix(" - Facebook").strip() or username

    posts = []
    for entry in feed.entries[:limit]:
        posts.append({
            "page_name": page_name,
            "page_username": username,
            "page_url": f"https://www.facebook.com/{username}",
            "title": (entry.get("title") or "")[:300],
            "summary": (entry.get("summary") or "")[:600],
            "published": entry.get("published") or entry.get("updated") or "",
            "post_url": entry.get("link") or "",
        })
    return posts


def _fetch_via_graph_api(username: str, limit: int) -> list[dict]:
    """Fetch Facebook page posts via Graph API (requires FACEBOOK_ACCESS_TOKEN)."""
    headers = {"User-Agent": "Mozilla/5.0"}
    params_info = {"access_token": FACEBOOK_TOKEN, "fields": "id,name"}
    info_res = requests.get(
        f"https://graph.facebook.com/v18.0/{username}",
        params=params_info, headers=headers, timeout=10
    )
    info = info_res.json()
    if "error" in info:
        raise RuntimeError(info["error"].get("message", "Graph API error"))

    page_id = info["id"]
    page_name = info.get("name", username)

    posts_res = requests.get(
        f"https://graph.facebook.com/v18.0/{page_id}/posts",
        params={
            "access_token": FACEBOOK_TOKEN,
            "fields": "id,message,story,created_time,permalink_url",
            "limit": limit,
        },
        headers=headers, timeout=10,
    )
    posts = []
    for post in posts_res.json().get("data", []):
        msg = post.get("message") or post.get("story") or ""
        posts.append({
            "page_name": page_name,
            "page_username": username,
            "page_url": f"https://www.facebook.com/{username}",
            "title": msg[:300],
            "summary": msg,
            "published": post.get("created_time", ""),
            "post_url": post.get("permalink_url", ""),
        })
    return posts


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/api/news/facebook")
def facebook_news(
    pages: str = Query(..., description="Comma-separated Facebook page usernames or URLs"),
    limit: int = Query(default=8, le=20),
):
    """Fetch recent posts from a list of Facebook pages.

    Uses Facebook Graph API when FACEBOOK_ACCESS_TOKEN env var is set,
    otherwise falls back to RSSHub (https://rsshub.app/facebook/page/{username}).
    """
    page_list = [_extract_fb_username(p) for p in pages.split(",") if p.strip()]
    page_list = [p for p in page_list if p]
    if not page_list:
        return {"posts": [], "source": "none"}

    cache_key = f"fb:{','.join(sorted(page_list))}:{limit}"
    cached = _fb_cache.get(cache_key)
    if cached is not None:
        return cached

    fetch_fn = _fetch_via_graph_api if FACEBOOK_TOKEN else _fetch_via_rsshub
    source = "graph_api" if FACEBOOK_TOKEN else "rsshub"

    all_posts: list[dict] = []
    errors: list[str] = []

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(fetch_fn, username, limit): username for username in page_list}
        for future in as_completed(futures):
            username = futures[future]
            try:
                all_posts.extend(future.result())
            except Exception as exc:
                print(f"[facebook] {username}: {exc}")
                errors.append(f"{username}: {exc}")

    # Sort newest-first; ISO-8601 and RFC-2822 both sort correctly as strings
    all_posts.sort(key=lambda x: x.get("published", ""), reverse=True)

    data = {"posts": all_posts, "source": source, "errors": errors}
    _fb_cache.set(cache_key, data)
    return data


# ── /api/news/feed ────────────────────────────────────────────────────────────

def _ts_to_iso(ts: int | float) -> str:
    try:
        return datetime.datetime.utcfromtimestamp(ts).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return ""


def _fetch_yfinance_topic(topic: str, count: int) -> list[dict]:
    try:
        result = yf.Search(topic, news_count=count, enable_fuzzy_query=True)
        items = result.news or []
    except Exception:
        try:
            # Typed fallback via market_data contract
            news_items = market_data.get_news(topic, max_results=count)
            items = []
            for ni in news_items:
                items.append({
                    "title":    ni.title,
                    "link":     ni.url,
                    "publisher": ni.source or "Yahoo Finance",
                    "providerPublishTime": ni.published or "",
                    "summary":  ni.summary or "",
                })
        except Exception as e:
            print(f"[news/yfinance] '{topic}': {e}")
            return []
    out = []
    for item in items:
        title = item.get("title", "").strip()
        url   = item.get("link", "")
        if not title or not url:
            continue
        out.append({
            "title":        title,
            "url":          url,
            "source":       item.get("publisher", "Yahoo Finance"),
            "published_at": _ts_to_iso(item.get("providerPublishTime", 0)),
            "topic":        topic,
        })
    return out


def _fetch_rss(name: str, url: str, limit: int) -> list[dict]:
    try:
        _, entries = fetch_items(
            url,
            headers={"User-Agent": "Mozilla/5.0 (compatible; BloombergTerminal/1.0)"},
            limit=limit,
        )
        out = []
        for entry in entries:
            title = entry["title"]
            link  = entry["link"]
            if not title or not link:
                continue
            out.append({
                "title":        title,
                "url":          link,
                "source":       name,
                "published_at": entry["published"],
                "topic":        "general",
            })
        return out
    except Exception as e:
        print(f"[news/rss] '{name}': {e}")
        return []


def _topic_piece(topic: str, need: int, fresh: bool) -> list[dict]:
    """One topic's headlines, at least `need` of them when Yahoo has that many."""
    name = topic.lower()
    bucket = next((b for b in _TOPIC_BUCKETS if b >= need), _TOPIC_BUCKETS[-1])
    if fresh:
        for b in _TOPIC_BUCKETS:
            _piece_cache.delete(f"topic:{name}:{b}")
    else:
        # A bigger pull already in the cache answers a smaller need.
        for b in _TOPIC_BUCKETS:
            if b > bucket:
                hit = _piece_cache.get(f"topic:{name}:{b}")
                if hit is not None:
                    return hit
    # get_or_set: one fetch per piece even when two requests want it at once,
    # and an empty answer is kept too (a failed source is not re-hit for 5 min).
    return _piece_cache.get_or_set(f"topic:{name}:{bucket}",
                                   lambda: _fetch_yfinance_topic(topic, bucket))


def _rss_piece(name: str, url: str, fresh: bool) -> list[dict]:
    if fresh:
        _piece_cache.delete(f"rss:{name}")
    return _piece_cache.get_or_set(f"rss:{name}", lambda: _fetch_rss(name, url, 20))


def _build_feed(topic_list: list[str], limit: int, fresh: bool = False) -> dict:
    """Pull every piece (cached 5 min each), merge, de-duplicate, newest first."""
    per_topic = max(8, limit // max(len(topic_list), 1))
    futures = [
        *[(_feed_pool.submit(_topic_piece, t, per_topic, fresh), per_topic) for t in topic_list],
        *[(_feed_pool.submit(_rss_piece, name, url, fresh), None) for name, url in _RSS_FEEDS.items()],
    ]

    # Deduplicate by URL (keep first seen), in request order so the result does
    # not depend on which source happened to answer first.
    seen: set[str] = set()
    unique: list[dict] = []
    for future, cap in futures:
        try:
            items = future.result() or []
        except Exception as e:
            print(f"[news/feed] {e}")
            continue
        for item in items[:cap]:
            u = item["url"]
            if u and u not in seen:
                seen.add(u)
                unique.append(item)

    unique.sort(key=lambda x: x.get("published_at", ""), reverse=True)
    return {"articles": unique[:limit]}


def _refresh_feed_behind(cache_key: str, topic_list: list[str], limit: int) -> None:
    with _feed_refresh_lock:
        if cache_key in _feed_refreshing:
            return
        _feed_refreshing.add(cache_key)

    def run() -> None:
        try:
            _feed_cache.set(cache_key, {"data": _build_feed(topic_list, limit), "ts": time.time()})
        except Exception as exc:  # noqa: BLE001 - the stale copy stays in place
            print(f"[news/feed] refresh: {exc}")
        finally:
            with _feed_refresh_lock:
                _feed_refreshing.discard(cache_key)

    threading.Thread(target=run, name="news-feed-swr", daemon=True).start()


@router.get("/api/news/feed")
def news_feed(
    topics: str = Query(default="market", description="Comma-separated search terms or ticker symbols"),
    limit: int = Query(default=60, le=150),
    fresh: int = Query(default=0, description="1 = skip the cache (REFRESH button)"),
    swr: int = Query(default=0, description="1 = a copy up to 30 min old may be returned at once "
                                           "(`refreshing: true`) while the new one is fetched"),
):
    """Multi-source financial newswire: yfinance Search + curated RSS feeds."""
    topic_list = [t.strip() for t in topics.split(",") if t.strip()][:10]
    cache_key = f"feed:{','.join(sorted(topic_list))}:{limit}"
    cached = None if fresh else _feed_cache.get(cache_key)
    if cached is not None:
        if time.time() - cached["ts"] < _FEED_FRESH_S:
            return cached["data"]
        if swr:
            # Only for a caller that will ask again (the NEWSFEED tab). ASK and
            # other one-shot readers get the rebuilt feed below.
            _refresh_feed_behind(cache_key, topic_list, limit)
            return {**cached["data"], "refreshing": True}

    result = _build_feed(topic_list, limit, fresh=bool(fresh))
    _feed_cache.set(cache_key, {"data": result, "ts": time.time()})
    return result
