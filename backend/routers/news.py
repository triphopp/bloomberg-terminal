"""
News feed endpoints — Facebook social feed + multi-source financial newswire.
"""
import calendar
import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

import feedparser
import requests
import yfinance as yf  # yf.Search for topic-based news (no typed wrapper yet)
from fastapi import APIRouter, Query

from cache import TTLCache
from config import FACEBOOK_TOKEN, RSSHUB_URL, FB_CACHE_TTL
from sources import market_data

router = APIRouter()

# ── Module-level caches ───────────────────────────────────────────────────────
_fb_cache   = TTLCache(ttl=FB_CACHE_TTL, maxsize=50)
_feed_cache = TTLCache(ttl=300, maxsize=100)  # 5-min cache

# ── Curated free RSS feeds (no auth) ─────────────────────────────────────────
_RSS_FEEDS: dict[str, str] = {
    "Yahoo Finance": "https://finance.yahoo.com/rss/topfinstories",
    "CNBC":          "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114",
    "MarketWatch":   "https://feeds.marketwatch.com/marketwatch/topstories/",
    "Reuters Biz":   "https://feeds.reuters.com/reuters/businessNews",
    "Investopedia":  "https://www.investopedia.com/feedbuilder/feed/getfeed?feedName=rss_articles",
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
    feed = feedparser.parse(
        f"{RSSHUB_URL}/facebook/page/{username}",
        request_headers={"User-Agent": "Mozilla/5.0 (compatible; BloombergTerminal/1.0)"},
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


def _struct_to_iso(struct) -> str:
    try:
        return datetime.datetime.utcfromtimestamp(calendar.timegm(struct)).strftime("%Y-%m-%dT%H:%M:%SZ")
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
        feed = feedparser.parse(
            url,
            request_headers={"User-Agent": "Mozilla/5.0 (compatible; BloombergTerminal/1.0)"},
        )
        out = []
        for entry in feed.entries[:limit]:
            title = (entry.get("title") or "").strip()
            link  = entry.get("link", "")
            if not title or not link:
                continue
            struct = entry.get("published_parsed") or entry.get("updated_parsed")
            out.append({
                "title":        title,
                "url":          link,
                "source":       name,
                "published_at": _struct_to_iso(struct) if struct else "",
                "topic":        "general",
            })
        return out
    except Exception as e:
        print(f"[news/rss] '{name}': {e}")
        return []


@router.get("/api/news/feed")
def news_feed(
    topics: str = Query(default="market", description="Comma-separated search terms or ticker symbols"),
    limit: int = Query(default=60, le=150),
):
    """Multi-source financial newswire: yfinance Search + curated RSS feeds."""
    topic_list = [t.strip() for t in topics.split(",") if t.strip()][:10]
    cache_key = f"feed:{','.join(sorted(topic_list))}:{limit}"
    cached = _feed_cache.get(cache_key)
    if cached is not None:
        return cached

    per_topic = max(8, limit // max(len(topic_list), 1))
    all_items: list[dict] = []

    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = [
            *[pool.submit(_fetch_yfinance_topic, t, per_topic) for t in topic_list],
            *[pool.submit(_fetch_rss, name, url, 20) for name, url in _RSS_FEEDS.items()],
        ]
        for f in as_completed(futures):
            try:
                all_items.extend(f.result())
            except Exception as e:
                print(f"[news/feed] {e}")

    # Deduplicate by URL (keep first seen)
    seen: set[str] = set()
    unique: list[dict] = []
    for item in all_items:
        u = item["url"]
        if u and u not in seen:
            seen.add(u)
            unique.append(item)

    unique.sort(key=lambda x: x.get("published_at", ""), reverse=True)

    result = {"articles": unique[:limit]}
    _feed_cache.set(cache_key, result)
    return result
