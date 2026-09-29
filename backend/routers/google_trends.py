"""Google Trends — free, public channels only.

Two endpoints, both returning a `source` block so an agent can cite them:

  GET /api/trends/daily?geo=US
      Daily trending searches from the public RSS feed
      (trends.google.com/trending/rss). Stable, no key.

  GET /api/trends/interest?keywords=Visa,Mastercard&geo=US&timeframe=today 12-m
      Search interest over time (0–100 index, relative to the peak in the
      window — NOT search volume). Uses the same unofficial endpoints the
      trends.google.com page calls. Google rate-limits them hard (429); a 429
      is negative-cached and returned as 429 (not 5xx — main.py masks 5xx
      details), never retried around. The official
      Trends API is an application-gated alpha (developers.google.com/search/
      apis/trends) — swap it in here if access is granted.

Calls go through `requests`, so upstream_health records them as "Google Trends".
"""

from __future__ import annotations

import json
import threading
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote

import requests
from fastapi import APIRouter, HTTPException, Query

from cache import TTLCache

router = APIRouter()

_BASE = "https://trends.google.com"
_RSS = f"{_BASE}/trending/rss"
_HT = "{https://trends.google.com/trending/rss}"
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")
_TIMEFRAMES = {"now 7-d", "today 1-m", "today 3-m", "today 12-m", "today 5-y"}

_daily = TTLCache(ttl=30 * 60, maxsize=64)
_daily_fail = TTLCache(ttl=5 * 60, maxsize=64)          # negative cache
_interest = TTLCache(ttl=6 * 3600, maxsize=256)
_interest_fail = TTLCache(ttl=30 * 60, maxsize=256)     # negative cache — 429s are sticky

_session = requests.Session()
_session.headers.update({"User-Agent": _UA, "Accept-Language": "en-US,en;q=0.9"})
_lock = threading.Lock()   # one interest pull at a time: parallel calls only earn more 429s


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _text(el: ET.Element | None) -> str | None:
    return el.text.strip() if el is not None and el.text else None


def _iso(rfc822: str | None) -> str | None:
    try:
        return parsedate_to_datetime(rfc822).astimezone(timezone.utc).isoformat() if rfc822 else None
    except (TypeError, ValueError):
        return None


def parse_daily_rss(xml_text: str) -> list[dict]:
    """RSS → [{query, approx_traffic, published_at, news:[{title,url,source}]}]."""
    root = ET.fromstring(xml_text)
    out = []
    for item in root.iter("item"):
        news = [{
            "title": _text(n.find(f"{_HT}news_item_title")),
            "url": _text(n.find(f"{_HT}news_item_url")),
            "source": _text(n.find(f"{_HT}news_item_source")),
        } for n in item.findall(f"{_HT}news_item")]
        out.append({
            "query": _text(item.find("title")),
            "approx_traffic": _text(item.find(f"{_HT}approx_traffic")),
            "published_at": _iso(_text(item.find("pubDate"))),
            "news": [n for n in news if n["title"] or n["url"]],
        })
    return out


@router.get("/api/trends/daily")
def trends_daily(geo: str = Query("US", min_length=2, max_length=5)):
    geo = geo.upper()
    key = f"daily:{geo}"
    if (hit := _daily.get(key)) is not None:
        return hit
    if (err := _daily_fail.get(key)) is not None:
        raise HTTPException(503, err)
    url = f"{_RSS}?geo={geo}"
    try:
        r = _session.get(url, timeout=20)
        r.raise_for_status()
        items = parse_daily_rss(r.text)
    except (requests.RequestException, ET.ParseError) as exc:
        msg = f"Google Trends daily RSS failed for geo={geo}: {exc.__class__.__name__}"
        _daily_fail.set(key, msg)
        raise HTTPException(503, msg) from exc
    data = {
        "geo": geo,
        "items": items,
        "source": {
            "name": "Google Trends — Daily Search Trends (RSS)",
            "url": url,
            "retrieved_at": _now(),
            "tier": "free/public",
            "note": "approx_traffic is Google's bucketed estimate (e.g. '2000+'), not an exact count.",
        },
    }
    _daily.set(key, data)
    return data


def _strip_xssi(text: str) -> dict:
    # Trends JSON is prefixed with ")]}'," to defeat XSSI.
    return json.loads(text[text.index("{"):])


@router.get("/api/trends/interest")
def trends_interest(
    keywords: str = Query(..., description="Comma-separated, up to 5"),
    geo: str = Query("", max_length=5, description="'' = worldwide, else ISO country e.g. US, TH"),
    timeframe: str = Query("today 12-m"),
):
    kws = [k.strip() for k in keywords.split(",") if k.strip()][:5]
    if not kws:
        raise HTTPException(400, "keywords is empty")
    if timeframe not in _TIMEFRAMES:
        raise HTTPException(400, f"timeframe must be one of {sorted(_TIMEFRAMES)}")
    geo = geo.upper()
    key = f"interest:{'|'.join(k.lower() for k in kws)}:{geo}:{timeframe}"
    if (hit := _interest.get(key)) is not None:
        return hit
    if (err := _interest_fail.get(key)) is not None:
        status, msg = err
        raise HTTPException(status, msg, headers={"Retry-After": "1800"} if status == 429 else None)

    explore_url = (f"{_BASE}/trends/explore?date={quote(timeframe)}&q={quote(','.join(kws))}"
                   + (f"&geo={geo}" if geo else ""))
    req = {"comparisonItem": [{"keyword": k, "geo": geo, "time": timeframe} for k in kws],
           "category": 0, "property": ""}
    with _lock:
        try:
            r = _session.get(f"{_BASE}/trends/api/explore", timeout=20,
                             params={"hl": "en-US", "tz": "0", "req": json.dumps(req)})
            r.raise_for_status()
            widget = next(w for w in _strip_xssi(r.text)["widgets"] if w.get("id") == "TIMESERIES")
            r2 = _session.get(f"{_BASE}/trends/api/widgetdata/multiline", timeout=20, params={
                "hl": "en-US", "tz": "0", "req": json.dumps(widget["request"]), "token": widget["token"],
            })
            r2.raise_for_status()
            timeline = _strip_xssi(r2.text)["default"]["timelineData"]
        except requests.HTTPError as exc:
            code = exc.response.status_code if exc.response is not None else None
            if code == 429:
                # 4xx on purpose: main.py masks every 5xx detail as "Internal server
                # error", and the caller needs the explore URL to check by hand.
                msg = ("Google Trends is rate limiting this machine (429) — not retried; try again "
                       f"in ~30 min or open the explore URL manually: {explore_url}")
                _interest_fail.set(key, (429, msg))
                raise HTTPException(429, msg, headers={"Retry-After": "1800"}) from exc
            msg = f"Google Trends returned {code}"
            _interest_fail.set(key, (503, msg))
            raise HTTPException(503, msg) from exc
        except (requests.RequestException, ValueError, KeyError, StopIteration) as exc:
            msg = f"Google Trends interest failed: {exc.__class__.__name__}"
            _interest_fail.set(key, (503, msg))
            raise HTTPException(503, msg) from exc

    series = [{
        "date": datetime.fromtimestamp(int(p["time"]), timezone.utc).date().isoformat(),
        "values": dict(zip(kws, p.get("value", []))),
        "partial": bool(p.get("isPartial")),
    } for p in timeline]
    data = {
        "keywords": kws,
        "geo": geo or "WORLD",
        "timeframe": timeframe,
        "series": series,
        "source": {
            "name": "Google Trends — Interest over time",
            "url": explore_url,
            "retrieved_at": _now(),
            "tier": "free/public (unofficial endpoint)",
            "note": ("0–100 index relative to the peak within this window and keyword set — "
                     "not search volume; values change if the keywords or window change. "
                     "Use as context, never as a fundamental."),
        },
    }
    _interest.set(key, data)
    return data
