"""
Watchlist-driven news — per-symbol headlines from many free sources, grouped by sector.

The NEWS view sends the user's watchlist symbols; this router resolves each symbol's
sector/company name (SQLite `sector_classifications` first, yfinance fallback), fans out
across every free news source we can reach, dedupes, cross-tags headlines that mention
more than one watchlist name, and attaches matching Polymarket markets.

Endpoint:
    GET /api/news/watchlist?symbols=AAPL,MSFT,PTT.BK&per_symbol=6&polymarket=1
"""
from __future__ import annotations

import calendar
import datetime
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import quote_plus

import feedparser
import requests
import yfinance as yf  # yf.Search — the typed contract returns empty NewsItems
from fastapi import APIRouter, Query

from cache import TTLCache
from db import get_db
from sources import market_data

router = APIRouter()

# ── Caches ────────────────────────────────────────────────────────────────────
_meta_cache = TTLCache(ttl=86_400, maxsize=500)   # symbol → sector/company (24h)
_news_cache = TTLCache(ttl=300, maxsize=500)      # symbol → merged articles (5 min)
_poly_cache = TTLCache(ttl=900, maxsize=200)      # symbol → polymarket matches (15 min)

_UA = {"User-Agent": "Mozilla/5.0 (compatible; BloombergTerminal/1.0; +news)"}
# EDGAR 403s generic browser agents. It wants "<app> <contact-email>" — plain, no
# parentheses (a bracketed comment in the UA string is enough to get blocked).
_SEC_UA = {
    "User-Agent": "BloombergTerminal/1.0 admin@localhost.com",
    "Accept-Encoding": "gzip, deflate",
    "Host": "www.sec.gov",
}
_TIMEOUT = 12

# Non-US suffixes: SEC EDGAR / StockTitan / Seeking Alpha only cover US listings
_US_LIKE = re.compile(r"^[A-Z][A-Z.\-]{0,6}$")

# ── Source registry ───────────────────────────────────────────────────────────
# kind: wire (news agency), aggregator (search index), analysis, filing, company
SOURCE_KIND: dict[str, str] = {
    "Yahoo Finance": "wire",
    "yfinance": "wire",
    "Google News": "aggregator",
    "Bing News": "aggregator",
    "Seeking Alpha": "analysis",
    "Nasdaq": "company",
    "SEC EDGAR": "filing",
}

# ── Sentiment lexicon (headline-level, deliberately small) ────────────────────
_POS = (
    "beat", "beats", "surge", "surges", "soar", "soars", "rally", "rallies", "jump",
    "jumps", "record high", "upgrade", "upgraded", "outperform", "raises guidance",
    "buyback", "profit rises", "tops estimates", "strong demand", "wins", "approval",
)
_NEG = (
    "miss", "misses", "plunge", "plunges", "slump", "slumps", "tumble", "tumbles",
    "downgrade", "downgraded", "underperform", "cuts guidance", "lawsuit", "probe",
    "recall", "layoff", "layoffs", "falls", "warns", "loss widens", "halt", "fraud",
)


def _sentiment(title: str) -> str:
    t = title.lower()
    pos = sum(1 for w in _POS if w in t)
    neg = sum(1 for w in _NEG if w in t)
    if pos > neg:
        return "POS"
    if neg > pos:
        return "NEG"
    return "NEU"


# ── Time helpers ──────────────────────────────────────────────────────────────

def _struct_to_iso(struct) -> str:
    try:
        return datetime.datetime.utcfromtimestamp(calendar.timegm(struct)).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return ""


def _ts_to_iso(ts) -> str:
    try:
        return datetime.datetime.utcfromtimestamp(float(ts)).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return ""


def _entry_time(entry) -> str:
    struct = entry.get("published_parsed") or entry.get("updated_parsed")
    if struct:
        return _struct_to_iso(struct)
    return ""


def _clean(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text or "").strip()


# ── Symbol metadata (sector / company) ────────────────────────────────────────

def _meta_from_db(symbol: str) -> dict | None:
    try:
        with get_db() as conn:
            row = conn.execute(
                """SELECT sector_display, sector_gics, industry_gics, company_name, country
                   FROM sector_classifications WHERE symbol = ? LIMIT 1""",
                (symbol,),
            ).fetchone()
    except Exception:
        return None
    if not row:
        return None
    sector = row["sector_display"] or row["sector_gics"]
    if not sector:
        return None
    return {
        "sector": sector,
        "industry": row["industry_gics"],
        "company": row["company_name"] or symbol,
        "country": row["country"],
    }


def _resolve_meta(symbol: str) -> dict:
    """sector / industry / company name for one symbol. DB → yfinance → unknown."""
    sym = symbol.upper()
    cached = _meta_cache.get(sym)
    if cached is not None:
        # A failed lookup (backend hiccup, yfinance throttle) must not stick for a
        # full day — retry after 10 minutes. `company == symbol` counts as failed
        # too: without the real name, headline matching can only ever see the
        # ticker, so "Alphabet beats" would never tie back to GOOGL.
        resolved = cached["sector"] != "Unclassified" and cached["company"] != sym
        if resolved or _meta_cache.get(sym, ttl=600) is not None:
            return cached

    meta = _meta_from_db(sym)
    if meta is None:
        meta = {"sector": None, "industry": None, "company": sym, "country": None}
        try:
            info = market_data.get_ticker(sym).info or {}
            meta["sector"] = info.get("sector")
            meta["industry"] = info.get("industry")
            meta["company"] = info.get("shortName") or info.get("longName") or sym
            meta["country"] = info.get("country")
        except Exception as exc:
            print(f"[news/watchlist] meta {sym}: {exc}")

        if meta["company"] == sym:
            # `.info` can come back empty under throttling; symbol search is a much
            # lighter call and still carries the company name.
            try:
                hits = market_data.search(sym, max_results=3)
                for hit in hits:
                    if hit.symbol.upper() == sym:
                        meta["company"] = hit.short_name or hit.long_name or sym
                        break
            except Exception as exc:
                print(f"[news/watchlist] search {sym}: {exc}")

    if not meta["sector"]:
        # Crypto pairs / FX / index symbols never carry a GICS sector
        if sym.endswith("-USD") or sym.endswith("=X"):
            meta["sector"] = "Crypto / FX"
        elif sym.startswith("^"):
            meta["sector"] = "Index"
        else:
            meta["sector"] = "Unclassified"
    else:
        # Keep what yfinance gave us. `sector_classifications` is only ever filled
        # by an explicit index-wide fetch, so on a machine that has never run one
        # every sector on this screen depends on `.info` answering — and the moment
        # Yahoo throttles, a watchlist of real companies renders as Unclassified.
        # Writing the answer down as it arrives means the throttle costs nothing
        # the second time.
        _remember_sector(sym, meta)

    meta["symbol"] = sym
    _meta_cache.set(sym, meta)
    return meta


def _remember_sector(symbol: str, meta: dict) -> None:
    """Persist a resolved sector so a later yfinance outage cannot blank it."""
    try:
        from datetime import date

        from db import upsert_sector_classification

        # `country` is the partition key of the table, and the rest of the app
        # writes short codes ("US", "TH") there rather than yfinance's
        # "United States" — a long name would create a second row for the same
        # company that the index-wide fetch would never update.
        country = "TH" if symbol.upper().endswith(".BK") else "US"

        upsert_sector_classification(
            symbol,
            country,
            {
                "sector_gics": meta.get("sector"),
                "sector_display": meta.get("sector"),
                "industry_gics": meta.get("industry"),
                "company_name": meta.get("company"),
                "source": "news_watchlist",
                "last_fetched": date.today().isoformat(),
            },
        )
    except Exception as exc:  # noqa: BLE001 - caching is a bonus, never a failure
        print(f"[news/watchlist] remember sector {symbol}: {exc}")


def _search_terms(symbol: str, company: str) -> list[str]:
    """Query strings used against the keyword-based sources."""
    terms = [symbol]
    name = (company or "").strip()
    # Drop corporate suffixes so "Apple Inc." → "Apple"
    name = re.sub(
        r"\b(inc|inc\.|corp|corp\.|corporation|co|co\.|ltd|ltd\.|plc|pcl|sa|nv|ag|holdings|group|company)\b\.?",
        "", name, flags=re.I,
    ).strip(" ,.-")
    if name and name.upper() != symbol:
        terms.append(name)
    return terms


# ── Per-source fetchers ───────────────────────────────────────────────────────

def _rss(url: str, source: str, limit: int) -> list[dict]:
    try:
        feed = feedparser.parse(url, request_headers=_UA)
    except Exception as exc:
        print(f"[news/watchlist] {source}: {exc}")
        return []
    out: list[dict] = []
    for entry in feed.entries[:limit]:
        title = _clean(entry.get("title", ""))
        link = entry.get("link", "")
        if not title or not link:
            continue
        # Google News prefixes the publisher onto the title: "Headline - Reuters"
        publisher = source
        if source == "Google News" and " - " in title:
            head, _, tail = title.rpartition(" - ")
            if head and len(tail) < 40:
                title, publisher = head, f"{tail} (GN)"
        out.append({
            "title": title[:300],
            "url": link,
            "source": publisher,
            "source_kind": SOURCE_KIND.get(source, "wire"),
            "published_at": _entry_time(entry),
            "summary": _clean(entry.get("summary", ""))[:400],
        })
    return out


def _src_yahoo_ticker(symbol: str, company: str, limit: int) -> list[dict]:
    url = (
        "https://feeds.finance.yahoo.com/rss/2.0/headline"
        f"?s={quote_plus(symbol)}&region=US&lang=en-US"
    )
    return _rss(url, "Yahoo Finance", limit)


def _src_yfinance(symbol: str, company: str, limit: int) -> list[dict]:
    """yfinance's own news index. `yf.Search` is used directly because the typed
    `market_data.get_news` contract currently returns blank NewsItems."""
    items: list[dict] = []
    try:
        items = yf.Search(symbol, news_count=limit, enable_fuzzy_query=True).news or []
    except Exception as exc:
        print(f"[news/watchlist] yf.Search {symbol}: {exc}")

    if not items:
        # Newer yfinance nests the payload under entry["content"]
        try:
            raw = yf.Ticker(symbol).news or []
        except Exception as exc:
            print(f"[news/watchlist] yf.Ticker.news {symbol}: {exc}")
            raw = []
        for entry in raw[:limit]:
            content = entry.get("content") or entry
            link = (
                (content.get("canonicalUrl") or {}).get("url")
                or (content.get("clickThroughUrl") or {}).get("url")
                or content.get("link", "")
            )
            items.append({
                "title": content.get("title", ""),
                "link": link,
                "publisher": (content.get("provider") or {}).get("displayName", "Yahoo Finance"),
                "providerPublishTime": content.get("pubDate", ""),
            })

    out: list[dict] = []
    for item in items:
        title = (item.get("title") or "").strip()
        url = item.get("link") or ""
        if not title or not url:
            continue
        published = item.get("providerPublishTime", "")
        out.append({
            "title": title[:300],
            "url": url,
            "source": item.get("publisher") or "Yahoo Finance",
            "source_kind": "wire",
            "published_at": published if isinstance(published, str) else _ts_to_iso(published),
            "summary": (item.get("summary") or "")[:400],
        })
    return out


def _src_google(symbol: str, company: str, limit: int) -> list[dict]:
    terms = _search_terms(symbol, company)
    query = f'"{terms[-1]}" stock' if len(terms) > 1 else f"{symbol} stock"
    url = (
        f"https://news.google.com/rss/search?q={quote_plus(query)}+when:7d"
        "&hl=en-US&gl=US&ceid=US:en"
    )
    return _rss(url, "Google News", limit)


def _src_bing(symbol: str, company: str, limit: int) -> list[dict]:
    terms = _search_terms(symbol, company)
    query = f"{terms[-1]} stock" if len(terms) > 1 else f"{symbol} stock"
    url = f"https://www.bing.com/news/search?q={quote_plus(query)}&format=RSS"
    return _rss(url, "Bing News", limit)


def _src_seeking_alpha(symbol: str, company: str, limit: int) -> list[dict]:
    if not _US_LIKE.match(symbol):
        return []
    return _rss(f"https://seekingalpha.com/api/sa/combined/{symbol}.xml", "Seeking Alpha", limit)


def _src_nasdaq(symbol: str, company: str, limit: int) -> list[dict]:
    if not _US_LIKE.match(symbol):
        return []
    return _rss(f"https://www.nasdaq.com/feed/rssoutbound?symbol={quote_plus(symbol)}",
                "Nasdaq", limit)


def _src_sec(symbol: str, company: str, limit: int) -> list[dict]:
    """Recent 8-K / 10-Q / 10-K filings straight from EDGAR (US listings only)."""
    if not _US_LIKE.match(symbol):
        return []
    url = (
        "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany"
        f"&CIK={quote_plus(symbol)}&type=8-K&dateb=&owner=include&count={limit}&output=atom"
    )
    try:
        res = requests.get(url, headers=_SEC_UA, timeout=_TIMEOUT)
        if not res.ok:
            return []
        feed = feedparser.parse(res.content)
    except Exception as exc:
        print(f"[news/watchlist] SEC {symbol}: {exc}")
        return []
    out: list[dict] = []
    for entry in feed.entries[:limit]:
        title = _clean(entry.get("title", ""))
        link = entry.get("link", "")
        if not title or not link:
            continue
        # EDGAR titles are all "8-K - Current report"; the date keeps them distinct
        # through the title-level dedupe.
        filed = _entry_time(entry)
        out.append({
            "title": f"FILING · {title}{f' · filed {filed[:10]}' if filed else ''}"[:300],
            "url": link,
            "source": "SEC EDGAR",
            "source_kind": "filing",
            "published_at": _entry_time(entry),
            "summary": _clean(entry.get("summary", ""))[:200],
        })
    return out


_SOURCES = {
    "yahoo": _src_yahoo_ticker,
    "yfinance": _src_yfinance,
    "google": _src_google,
    "bing": _src_bing,
    "seekingalpha": _src_seeking_alpha,
    "nasdaq": _src_nasdaq,
    "sec": _src_sec,
}


# Sources that answer a text query rather than a ticker feed — they drift onto
# unrelated companies, so their hits must actually name the stock.
_KEYWORD_SOURCES = {"google", "bing", "yfinance"}


def _mentions(item: dict, symbol: str, company: str) -> bool:
    """Does this headline actually name the stock?

    Short names are matched case-sensitively: "Arm" is a company, "arm" is a body
    part, and lower-casing the check turns every prose noun into a false hit.
    """
    text = f"{item.get('title', '')} {item.get('summary', '')}"
    if re.search(rf"(?<![A-Za-z0-9]){re.escape(symbol)}(?![A-Za-z0-9])", text):
        return True
    short = re.split(r"[ ,.]", (company or "").strip())[0]
    if len(short) < 3:
        return False
    flags = re.I if len(short) > 4 else 0
    return bool(re.search(rf"(?<![A-Za-z]){re.escape(short)}(?![A-Za-z])", text, flags))


def _fetch_symbol_news(symbol: str, company: str, per_source: int,
                       enabled: list[str]) -> list[dict]:
    """All enabled sources for one symbol, merged + deduped. Cached 5 min."""
    key = f"{symbol}:{','.join(sorted(enabled))}:{per_source}"
    cached = _news_cache.get(key)
    if cached is not None:
        return cached

    items: list[dict] = []
    with ThreadPoolExecutor(max_workers=len(enabled) or 1) as pool:
        futures = {
            pool.submit(_SOURCES[name], symbol, company, per_source): name
            for name in enabled if name in _SOURCES
        }
        for fut in as_completed(futures):
            name = futures[fut]
            try:
                result = fut.result()
            except Exception as exc:
                print(f"[news/watchlist] {symbol}/{name}: {exc}")
                continue
            if name in _KEYWORD_SOURCES:
                result = [it for it in result if _mentions(it, symbol, company)]
            items.extend(result)

    seen: set[str] = set()
    unique: list[dict] = []
    for it in items:
        fingerprint = it["url"].split("?")[0]
        title_key = re.sub(r"[^a-z0-9]", "", it["title"].lower())[:70]
        if fingerprint in seen or title_key in seen:
            continue
        seen.add(fingerprint)
        seen.add(title_key)
        unique.append(it)

    unique.sort(key=lambda x: x.get("published_at", ""), reverse=True)
    _news_cache.set(key, unique)
    return unique


# ── Polymarket matching ───────────────────────────────────────────────────────

def _poly_for_symbol(symbol: str, company: str, limit: int) -> list[dict]:
    cached = _poly_cache.get(symbol)
    if cached is not None:
        return cached[:limit]
    try:
        from routers.polymarket import _extract_probability, _refresh_market_pool
    except Exception:
        return []

    terms = _search_terms(symbol, company)
    # A bare 2–3 letter ticker matches far too much prose; keep the company name only.
    keywords = [t for t in terms if len(t) > 3]
    if not keywords:
        return []

    # Match the question text only, on word boundaries. The shared pool matcher
    # also scans 400 chars of description, which drags in every market whose
    # blurb happens to name a big-cap ("Costco" ↔ "…da Costa", "Google" in an
    # unrelated crypto market).
    pattern = re.compile(
        "|".join(rf"(?<![A-Za-z0-9]){re.escape(k)}(?![A-Za-z0-9])" for k in keywords),
        re.I,
    )
    try:
        pool = _refresh_market_pool()
    except Exception as exc:
        print(f"[news/watchlist] poly {symbol}: {exc}")
        return []

    markets = sorted(
        (m for m in pool if pattern.search(m.get("question", "") or "")),
        key=lambda m: -float(m.get("volume", 0) or 0),
    )[:limit]

    out: list[dict] = []
    for m in markets:
        out.append({
            "symbol": symbol,
            "question": m.get("question", ""),
            "slug": m.get("slug", ""),
            "event_slug": (m.get("events") or [{}])[0].get("slug", "") if m.get("events") else "",
            "probability": _extract_probability(m),
            "volume": float(m.get("volume", 0) or 0),
            "end_date": m.get("endDate", "") or "",
        })
    _poly_cache.set(symbol, out)
    return out


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.get("/api/news/watchlist")
def watchlist_news(
    symbols: str = Query(..., description="Comma-separated watchlist tickers"),
    per_symbol: int = Query(default=6, ge=1, le=20, description="Headlines kept per symbol"),
    per_source: int = Query(default=6, ge=1, le=20),
    sources: str = Query(default="all", description="Comma-separated source ids, or 'all'"),
    polymarket: int = Query(default=1, description="1 = attach matching prediction markets"),
):
    """Per-symbol news for the watchlist, grouped by resolved sector."""
    symbol_list = [s.strip().upper() for s in symbols.split(",") if s.strip()][:30]
    if not symbol_list:
        return {"articles": [], "symbols": [], "sectors": [], "markets": [], "errors": []}

    enabled = list(_SOURCES) if sources == "all" else [
        s.strip() for s in sources.split(",") if s.strip() in _SOURCES
    ]
    if not enabled:
        enabled = list(_SOURCES)

    errors: list[str] = []

    # 1 — metadata (sector + company) in parallel
    metas: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_resolve_meta, s): s for s in symbol_list}
        for fut in as_completed(futures):
            sym = futures[fut]
            try:
                metas[sym] = fut.result()
            except Exception as exc:
                errors.append(f"meta {sym}: {exc}")
                metas[sym] = {"symbol": sym, "sector": "Unclassified",
                              "industry": None, "company": sym, "country": None}

    # 2 — news per symbol in parallel
    per_symbol_items: dict[str, list[dict]] = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {
            pool.submit(_fetch_symbol_news, sym, metas[sym]["company"], per_source, enabled): sym
            for sym in symbol_list
        }
        for fut in as_completed(futures):
            sym = futures[fut]
            try:
                per_symbol_items[sym] = fut.result()[:per_symbol]
            except Exception as exc:
                errors.append(f"news {sym}: {exc}")
                per_symbol_items[sym] = []

    # 3 — merge + cross-tag. An article keeps every watchlist name it mentions.
    name_index: list[tuple[str, list[str]]] = []
    for sym in symbol_list:
        needles = [sym.lower()]
        company = (metas[sym]["company"] or "").strip()
        short = re.split(r"[ ,.]", company)[0].lower() if company else ""
        if len(short) > 3:
            needles.append(short)
        name_index.append((sym, needles))

    merged: dict[str, dict] = {}
    for sym, items in per_symbol_items.items():
        for it in items:
            key = it["url"].split("?")[0]
            existing = merged.get(key)
            if existing:
                if sym not in existing["symbols"]:
                    existing["symbols"].append(sym)
                continue
            haystack = f" {it['title'].lower()} "
            tagged = [sym]
            for other, needles in name_index:
                if other == sym:
                    continue
                if any(f" {n} " in haystack or f" {n}'" in haystack or f"({n})" in haystack
                       for n in needles):
                    tagged.append(other)
            merged[key] = {
                **it,
                "symbols": tagged,
                "primary_symbol": sym,
                "sector": metas[sym]["sector"],
                "company": metas[sym]["company"],
                "sentiment": _sentiment(it["title"]),
                # "direct" = the headline names the ticker or company; "feed" = it
                # came off that symbol's own wire without naming it (sector/market
                # colour). The UI defaults to direct-only.
                "relevance": (
                    "direct" if _mentions(it, sym, metas[sym]["company"]) else "feed"
                ),
            }

    articles = sorted(merged.values(), key=lambda a: a.get("published_at", ""), reverse=True)

    # 4 — per-symbol / per-sector counts
    counts: dict[str, int] = {s: 0 for s in symbol_list}
    for a in articles:
        for s in a["symbols"]:
            if s in counts:
                counts[s] += 1

    symbols_out = [
        {
            "symbol": sym,
            "company": metas[sym]["company"],
            "sector": metas[sym]["sector"],
            "industry": metas[sym]["industry"],
            "country": metas[sym]["country"],
            "article_count": counts[sym],
        }
        for sym in symbol_list
    ]

    sector_map: dict[str, dict] = {}
    for row in symbols_out:
        bucket = sector_map.setdefault(row["sector"], {"sector": row["sector"], "symbols": [],
                                                       "article_count": 0})
        bucket["symbols"].append(row["symbol"])
    for a in articles:
        bucket = sector_map.get(a["sector"])
        if bucket:
            bucket["article_count"] += 1
    sectors_out = sorted(sector_map.values(), key=lambda s: -s["article_count"])

    # 5 — Polymarket
    markets: list[dict] = []
    if polymarket:
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {
                pool.submit(_poly_for_symbol, sym, metas[sym]["company"], 3): sym
                for sym in symbol_list
            }
            for fut in as_completed(futures):
                sym = futures[fut]
                try:
                    for m in fut.result():
                        markets.append({**m, "sector": metas[sym]["sector"]})
                except Exception as exc:
                    errors.append(f"poly {sym}: {exc}")
        seen_slugs: set[str] = set()
        deduped: list[dict] = []
        for m in sorted(markets, key=lambda m: -m["volume"]):
            if m["slug"] in seen_slugs:
                continue
            seen_slugs.add(m["slug"])
            deduped.append(m)
        markets = deduped

    return {
        "as_of": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sources_used": enabled,
        "symbols": symbols_out,
        "sectors": sectors_out,
        "articles": articles,
        "markets": markets,
        "errors": errors,
    }


@router.get("/api/news/sources")
def news_sources():
    """Source registry the UI renders as toggles."""
    return {
        "sources": [
            {"id": sid, "label": label, "kind": SOURCE_KIND.get(label, "wire")}
            for sid, label in [
                ("yahoo", "Yahoo Finance"),
                ("yfinance", "yfinance"),
                ("google", "Google News"),
                ("bing", "Bing News"),
                ("seekingalpha", "Seeking Alpha"),
                ("nasdaq", "Nasdaq"),
                ("sec", "SEC EDGAR"),
            ]
        ]
    }
