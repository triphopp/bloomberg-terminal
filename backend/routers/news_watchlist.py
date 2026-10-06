"""
Watchlist-driven news — per-symbol headlines from many free sources, grouped by sector.

The NEWS view sends the user's watchlist symbols; this router resolves each symbol's
sector/company name (SQLite `sector_classifications` first, yfinance fallback), fans out
across every free news source we can reach, dedupes, cross-tags headlines that mention
more than one watchlist name, and attaches matching Polymarket markets.

Endpoint:
    GET /api/news/watchlist?symbols=AAPL,MSFT,PTT.BK&per_symbol=6&polymarket=1

The answer is assembled from one cached pull per (symbol, source):

* a pull is fresh for 5 min; older than that it is still served at once while
  a refresh runs behind it, and it survives a backend restart (persist_cache);
* `wait` caps how long the request holds on pulls it has nothing for. What is
  still running when it answers is counted in `pending` — the NEWS view asks
  again (`settle=1`) and gets the rest. Without `wait` the request holds until
  everything has answered, which is what ASK and the MCP tool want.
"""
from __future__ import annotations

import datetime
import re
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, as_completed, wait as wait_futures
from urllib.parse import quote_plus

import yfinance as yf  # yf.Search — the typed contract returns empty NewsItems
from fastapi import APIRouter, Query

from cache import TTLCache
from db import get_db
from persist_cache import PersistentStore
from rss import fetch_items
from sources import market_data

router = APIRouter()

# ── Caches ────────────────────────────────────────────────────────────────────
_meta_cache = TTLCache(ttl=86_400, maxsize=500)   # symbol → sector/company (24h)
# What Yahoo last said about a symbol, kept across restarts: an ETF or a future
# has no sector to find, and asking `.info` again for each of them held every
# cold request for ~0.6 s.
_meta_store = PersistentStore("news_watchlist_meta", max_age=7 * 86_400, maxsize=1000)
_meta_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="wl-meta")

# "<symbol>|<source>|<per_source>" → {"items", "ts", "retry_at"}
#   ts        when these items were pulled (a failed refresh keeps items and ts)
#   retry_at  no new pull before this
_NEWS_FRESH_S = 300          # a good pull is not repeated for 5 min
_NEWS_RETRY_S = 90           # a failed one is retried sooner
_NEWS_MIN_REPULL_S = 10      # REFRESH does not repeat a pull younger than this
# Over a weekend too: Friday's headlines, each with its age, on screen for the
# two or three seconds the refresh takes read better than an empty panel.
_NEWS_STALE_S = 72 * 3600    # older than this is not shown at all
_store = PersistentStore("news_watchlist", max_age=_NEWS_STALE_S, maxsize=4000)

# One executor per source: its size is the number of requests that host sees at
# once, and a slow source cannot take the threads the fast ones need.
# Nasdaq holds the first request on every new connection for 1.5–3.5 s and
# answers in ~50 ms on a kept-alive one (measured 2026-10-05) — two connections
# reused beat six new ones. yfinance search shares the app-wide Yahoo gate
# (6 at a time, yahoo_gate.py) with every quote and chart: three leaves the
# other half for them while a watchlist refresh is running.
_SOURCE_WORKERS = {
    "yahoo": 8, "yfinance": 3, "google": 6, "bing": 4,
    "seekingalpha": 6, "nasdaq": 2, "sec": 4,
}
_source_pools: dict[str, ThreadPoolExecutor] = {}
_inflight: dict[str, Future] = {}
_inflight_lock = threading.Lock()

#: How long a request holds when the caller sets no `wait`: until every source
#: has answered (their own timeouts end well inside this).
_WAIT_ALL_S = 40.0

#: Once the headlines are in hand, the first answer gives market matching this
#: much longer before it goes out without them.
_POLY_GRACE_S = 0.15

_poly_cache = TTLCache(ttl=900, maxsize=200)      # symbol → polymarket matches (15 min)
_poly_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="wl-poly")
_poly_inflight: dict[str, Future] = {}

_UA = {"User-Agent": "Mozilla/5.0 (compatible; BloombergTerminal/1.0; +news)"}
# EDGAR 403s generic browser agents. It wants "<app> <contact-email>" — plain, no
# parentheses (a bracketed comment in the UA string is enough to get blocked).
_SEC_UA = {
    "User-Agent": "BloombergTerminal/1.0 admin@localhost.com",
    "Accept-Encoding": "gzip, deflate",
    "Host": "www.sec.gov",
}

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

def _ts_to_iso(ts) -> str:
    try:
        return datetime.datetime.utcfromtimestamp(float(ts)).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
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


# Yahoo quote types that never carry a GICS sector — "no sector" is the answer.
_NO_SECTOR_TYPES = {"ETF", "MUTUALFUND", "INDEX", "FUTURE", "CURRENCY", "CRYPTOCURRENCY"}


def _meta_cached(sym: str) -> dict | None:
    """The in-memory answer, unless it is a failed lookup that is due a retry."""
    cached = _meta_cache.get(sym)
    if cached is None:
        return None
    # A failed lookup (backend hiccup, yfinance throttle) must not stick for a
    # full day — retry after 10 minutes. `company == symbol` counts as failed
    # too: without the real name, headline matching can only ever see the
    # ticker, so "Alphabet beats" would never tie back to GOOGL.
    resolved = cached.get("final") or (
        cached["sector"] != "Unclassified" and cached["company"] != sym
    )
    if resolved or _meta_cache.get(sym, ttl=600) is not None:
        return cached
    return None


def _resolve_meta(symbol: str) -> dict:
    """sector / industry / company name for one symbol. DB → yfinance → unknown."""
    sym = symbol.upper()
    cached = _meta_cached(sym)
    if cached is not None:
        return cached

    meta = _meta_from_db(sym)
    from_db = meta is not None
    final = from_db
    if meta is None:
        stored = _meta_store.get(sym)
        if stored is not None:
            # Yahoo already said this one has no sector (ETF, future, index).
            meta = {k: stored.get(k) for k in ("sector", "industry", "company", "country")}
            final = True
    if meta is None:
        meta = {"sector": None, "industry": None, "company": sym, "country": None}
        try:
            info = market_data.get_ticker(sym).info or {}
            meta["sector"] = info.get("sector")
            meta["industry"] = info.get("industry")
            meta["company"] = info.get("shortName") or info.get("longName") or sym
            meta["country"] = info.get("country")
            if meta["company"] != sym and not meta["sector"] \
                    and str(info.get("quoteType") or "").upper() in _NO_SECTOR_TYPES:
                final = True
                _meta_store.put(sym, {**meta, "ts": time.time()})
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
    elif not from_db:
        # Keep what yfinance gave us. `sector_classifications` is only ever filled
        # by an explicit index-wide fetch, so on a machine that has never run one
        # every sector on this screen depends on `.info` answering — and the moment
        # Yahoo throttles, a watchlist of real companies renders as Unclassified.
        # Writing the answer down as it arrives means the throttle costs nothing
        # the second time.
        _remember_sector(sym, meta)

    meta["symbol"] = sym
    # "final": nothing more to learn by asking again before the 24 h cache ends.
    meta["final"] = final
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
# Each returns the headlines it found and RAISES when the source did not answer,
# so a failed refresh can leave the previous pull in place instead of replacing
# it with nothing.

def _rss_items(url: str, source: str, limit: int, headers: dict | None = None) -> list[dict]:
    _, entries = fetch_items(url, headers=headers or _UA, limit=limit)
    out: list[dict] = []
    for entry in entries:
        title = _clean(entry["title"])
        link = entry["link"]
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
            "published_at": entry["published"],
            "summary": _clean(entry["summary"])[:400],
        })
    return out


def _rss(url: str, source: str, limit: int) -> list[dict]:
    """`_rss_items` that answers [] on failure — for callers outside the
    watchlist cache (ASK's web news search)."""
    try:
        return _rss_items(url, source, limit)
    except Exception as exc:
        print(f"[news/watchlist] {source}: {exc}")
        return []


def _src_yahoo_ticker(symbol: str, company: str, limit: int) -> list[dict]:
    url = (
        "https://feeds.finance.yahoo.com/rss/2.0/headline"
        f"?s={quote_plus(symbol)}&region=US&lang=en-US"
    )
    return _rss_items(url, "Yahoo Finance", limit)


def _src_yfinance(symbol: str, company: str, limit: int) -> list[dict]:
    """yfinance's own news index. `yf.Search` is used directly because the typed
    `market_data.get_news` contract currently returns blank NewsItems."""
    items: list[dict] = []
    failed: Exception | None = None
    try:
        items = yf.Search(symbol, news_count=limit, enable_fuzzy_query=True).news or []
    except Exception as exc:
        failed = exc
        print(f"[news/watchlist] yf.Search {symbol}: {exc}")

    if not items:
        # Newer yfinance nests the payload under entry["content"]
        try:
            raw = yf.Ticker(symbol).news or []
        except Exception as exc:
            print(f"[news/watchlist] yf.Ticker.news {symbol}: {exc}")
            if failed is not None:
                raise  # neither index answered
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
    return _rss_items(url, "Google News", limit)


def _src_bing(symbol: str, company: str, limit: int) -> list[dict]:
    terms = _search_terms(symbol, company)
    query = f"{terms[-1]} stock" if len(terms) > 1 else f"{symbol} stock"
    url = f"https://www.bing.com/news/search?q={quote_plus(query)}&format=RSS"
    return _rss_items(url, "Bing News", limit)


def _src_seeking_alpha(symbol: str, company: str, limit: int) -> list[dict]:
    if not _US_LIKE.match(symbol):
        return []
    return _rss_items(f"https://seekingalpha.com/api/sa/combined/{symbol}.xml", "Seeking Alpha", limit)


def _src_nasdaq(symbol: str, company: str, limit: int) -> list[dict]:
    if not _US_LIKE.match(symbol):
        return []
    return _rss_items(f"https://www.nasdaq.com/feed/rssoutbound?symbol={quote_plus(symbol)}",
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
        items = _rss_items(url, "SEC EDGAR", limit, headers=_SEC_UA)
    except ValueError:
        # A ticker EDGAR does not know (an ETF, a foreign listing) is answered
        # with an HTML page, not a feed: no filings, not a failure.
        return []
    for it in items:
        # EDGAR titles are all "8-K - Current report"; the date keeps them distinct
        # through the title-level dedupe.
        filed = it["published_at"]
        it["title"] = f"FILING · {it['title']}{f' · filed {filed[:10]}' if filed else ''}"[:300]
        it["summary"] = it["summary"][:200]
    return items


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


# ── One pull per (symbol, source), shared by every request ────────────────────

def _source_key(symbol: str, source: str, per_source: int) -> str:
    return f"{symbol}|{source}|{per_source}"


def _pull_source(key: str, symbol: str, company: str, source: str, per_source: int) -> list[dict]:
    """Run one source for one symbol and store the answer. Never raises."""
    now = time.time()
    try:
        items = _SOURCES[source](symbol, company, per_source)
    except Exception as exc:  # noqa: BLE001 - one source down must not fail the symbol
        if getattr(getattr(exc, "response", None), "status_code", None) == 404:
            items = []  # the source does not cover this symbol: an answer, not an outage
        else:
            print(f"[news/watchlist] {symbol}/{source}: {exc}")
            # Negative cache: no retry for _NEWS_RETRY_S. What the last good pull
            # brought stays on screen (the store drops it once it is too old).
            previous = _store.get(key)
            entry = {
                "items": previous["items"] if previous else [],
                "ts": previous["ts"] if previous else now,
                "retry_at": now + _NEWS_RETRY_S,
            }
            _store.put(key, entry)
            return entry["items"]
    if source in _KEYWORD_SOURCES:
        items = [it for it in items if _mentions(it, symbol, company)]
    _store.put(key, {"items": items, "ts": now, "retry_at": now + _NEWS_FRESH_S})
    return items


def _source_job(key: str, symbol: str, company: str, source: str, per_source: int,
                start: bool) -> Future | None:
    """The pull running for `key`; started here when `start` and none is running."""
    with _inflight_lock:
        fut = _inflight.get(key)
        if fut is not None or not start:
            return fut
        pool = _source_pools.get(source)
        if pool is None:
            pool = _source_pools[source] = ThreadPoolExecutor(
                max_workers=_SOURCE_WORKERS.get(source, 4), thread_name_prefix=f"wl-{source}",
            )
        fut = _inflight[key] = pool.submit(_pull_source, key, symbol, company, source, per_source)

    def forget(done: Future, key: str = key) -> None:
        with _inflight_lock:
            if _inflight.get(key) is done:
                del _inflight[key]

    fut.add_done_callback(forget)
    return fut


def _merge_symbol(per_source_items: list[list[dict]]) -> list[dict]:
    """One symbol's sources merged, de-duplicated (URL, then title), newest first."""
    seen: set[str] = set()
    unique: list[dict] = []
    for items in per_source_items:
        for it in items:
            fingerprint = it["url"].split("?")[0]
            title_key = re.sub(r"[^a-z0-9]", "", it["title"].lower())[:70]
            if fingerprint in seen or title_key in seen:
                continue
            seen.add(fingerprint)
            seen.add(title_key)
            unique.append(it)
    unique.sort(key=lambda x: x.get("published_at", ""), reverse=True)
    return unique


def _gather_news(symbol_list: list[str], metas: dict[str, dict], enabled: list[str],
                 per_source: int, *, fresh: bool, settle: bool,
                 deadline: float) -> tuple[dict[str, list[dict]], int, float | None]:
    """Every symbol's merged headlines from the store, pulling what is missing.

    A stored pull is used as it is; one past its `retry_at` is refreshed behind
    the answer. The request holds until `deadline` (time.monotonic) only for
    pulls it has nothing for — and, with `fresh` or `settle`, for the refreshes
    too. Returns (items per symbol, pulls still running, oldest pull time used).
    """
    now = time.time()
    have: dict[tuple[str, str], list[dict]] = {}
    pulled: dict[tuple[str, str], float] = {}
    awaited: dict[Future, tuple[str, str]] = {}
    behind = 0

    for sym in symbol_list:
        for src in enabled:
            key = _source_key(sym, src, per_source)
            # Running pull first, store second: a pull that finishes in between
            # has already stored its answer, so it is never started twice.
            fut = _source_job(key, sym, "", src, per_source, start=False)
            entry = _store.get(key)
            if entry is not None:
                have[(sym, src)] = entry["items"]
                pulled[(sym, src)] = entry["ts"]
            if fut is None:
                if entry is None:
                    due = True
                elif fresh:
                    due = now - entry["ts"] >= _NEWS_MIN_REPULL_S
                else:
                    due = now >= entry.get("retry_at", 0)
                if not due:
                    continue
                fut = _source_job(key, sym, metas[sym]["company"], src, per_source, start=True)
            if entry is None or fresh or settle:
                awaited[fut] = (sym, src)
            else:
                behind += 1  # the stored copy is served; its refresh runs behind

    if awaited:
        done, not_done = wait_futures(awaited, timeout=max(0.0, deadline - time.monotonic()))
        for fut in done:
            where = awaited[fut]
            have[where] = fut.result()  # _pull_source never raises
            entry = _store.get(_source_key(where[0], where[1], per_source))
            pulled[where] = entry["ts"] if entry else now
        behind += len(not_done)

    merged = {
        sym: _merge_symbol([have.get((sym, src), []) for src in enabled])
        for sym in symbol_list
    }
    return merged, behind, (min(pulled.values()) if pulled else None)


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
        _poly_cache.set(symbol, [])
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
    if not pool:
        return []  # Gamma did not answer — not "no markets"; ask again next time

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


def _poly_job(symbol: str, company: str) -> Future:
    """Matching for one symbol, one run at a time (the first waits on the pool)."""
    with _inflight_lock:
        fut = _poly_inflight.get(symbol)
        if fut is not None:
            return fut
        fut = _poly_inflight[symbol] = _poly_pool.submit(_poly_for_symbol, symbol, company, 3)

    def forget(done: Future, symbol: str = symbol) -> None:
        with _inflight_lock:
            if _poly_inflight.get(symbol) is done:
                del _poly_inflight[symbol]

    fut.add_done_callback(forget)
    return fut


def _metas_from_db(symbols: list[str]) -> dict[str, dict]:
    """Symbols whose sector is already in SQLite, cached as resolved."""
    try:
        with get_db() as conn:
            rows = conn.execute(
                f"""SELECT symbol, sector_display, sector_gics, industry_gics, company_name, country
                    FROM sector_classifications
                    WHERE symbol IN ({",".join("?" * len(symbols))})""",
                symbols,
            ).fetchall()
    except Exception:
        return {}
    found: dict[str, dict] = {}
    for row in rows:
        sym = row["symbol"]
        sector = row["sector_display"] or row["sector_gics"]
        if not sector or sym in found:
            continue
        found[sym] = {
            "sector": sector,
            "industry": row["industry_gics"],
            "company": row["company_name"] or sym,
            "country": row["country"],
            "symbol": sym,
            "final": True,
        }
        _meta_cache.set(sym, found[sym])
    return found


def _resolve_metas(symbol_list: list[str], errors: list[str]) -> dict[str, dict]:
    """Sector + company per symbol; only the ones not in memory go to a thread."""
    metas: dict[str, dict] = {}
    missing: list[str] = []
    for sym in symbol_list:
        cached = _meta_cached(sym)
        if cached is not None:
            metas[sym] = cached
        else:
            missing.append(sym)
    if missing:
        # After a restart nothing is in memory: one query for the whole list
        # instead of a connection per symbol.
        metas.update(_metas_from_db(missing))
        missing = [s for s in missing if s not in metas]
    if missing:
        futures = {_meta_pool.submit(_resolve_meta, s): s for s in missing}
        for fut in as_completed(futures):
            sym = futures[fut]
            try:
                metas[sym] = fut.result()
            except Exception as exc:
                errors.append(f"meta {sym}: {exc}")
                metas[sym] = {"symbol": sym, "sector": "Unclassified",
                              "industry": None, "company": sym, "country": None}
    return metas


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.get("/api/news/watchlist")
def watchlist_news(
    symbols: str = Query(..., description="Comma-separated watchlist tickers"),
    per_symbol: int = Query(default=6, ge=1, le=20, description="Headlines kept per symbol"),
    per_source: int = Query(default=6, ge=1, le=20),
    sources: str = Query(default="all", description="Comma-separated source ids, or 'all'"),
    polymarket: int = Query(default=1, description="1 = attach matching prediction markets"),
    fresh: int = Query(default=0, description="1 = re-pull every source now (REFRESH button)"),
    wait: float | None = Query(
        default=None, ge=0, le=60,
        description="Answer after at most this many seconds with what has arrived; the rest is "
                    "counted in `pending`. Omit to hold until every source has answered.",
    ),
    settle: int = Query(default=0, description="1 = also hold for refreshes running behind a stored copy"),
):
    """Per-symbol news for the watchlist, grouped by resolved sector."""
    started = time.monotonic()
    symbol_list = [s.strip().upper() for s in symbols.split(",") if s.strip()][:30]
    if not symbol_list:
        return {"articles": [], "symbols": [], "sectors": [], "markets": [], "errors": [],
                "pending": 0}

    enabled = list(_SOURCES) if sources == "all" else [
        s.strip() for s in sources.split(",") if s.strip() in _SOURCES
    ]
    if not enabled:
        enabled = list(_SOURCES)

    errors: list[str] = []
    # A caller that sets no `wait` wants the finished answer (ASK, MCP): hold
    # for the refreshes as well, so nothing older than 5 min comes back.
    deadline = started + (_WAIT_ALL_S if wait is None else wait)
    settle_all = bool(settle) or wait is None

    # 1 — metadata (sector + company)
    metas = _resolve_metas(symbol_list, errors)

    # 2 — Polymarket needs only the company names, so it runs alongside the news
    # pulls instead of after them (collected in step 6).
    poly_ready: dict[str, list[dict]] = {}
    poly_futures: dict[Future, str] = {}
    if polymarket:
        for sym in symbol_list:
            cached = _poly_cache.get(sym)
            if cached is not None:
                poly_ready[sym] = cached[:3]
            else:
                poly_futures[_poly_job(sym, metas[sym]["company"])] = sym

    # 3 — news per symbol, from the store and from the pulls that are due
    news, pending, oldest = _gather_news(
        symbol_list, metas, enabled, per_source,
        fresh=bool(fresh), settle=settle_all, deadline=deadline,
    )
    per_symbol_items = {sym: items[:per_symbol] for sym, items in news.items()}

    # 4 — merge + cross-tag. An article keeps every watchlist name it mentions.
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

    # 5 — per-symbol / per-sector counts
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

    # 6 — Polymarket (started in step 2). On a cold start the matching waits
    # for the 16 MB market pool; headlines that are already here do not wait
    # with it — the markets follow in the next answer, like a slow source.
    markets: list[dict] = []
    if poly_futures:
        # No grace at all when sources are still running: a follow-up is coming anyway.
        grace = 0.0 if pending else _POLY_GRACE_S
        poly_deadline = deadline if settle_all else min(deadline, time.monotonic() + grace)
        done, not_done = wait_futures(poly_futures, timeout=max(0.0, poly_deadline - time.monotonic()))
        pending += len(not_done)
        for fut in done:
            sym = poly_futures[fut]
            try:
                poly_ready[sym] = fut.result()
            except Exception as exc:
                errors.append(f"poly {sym}: {exc}")
    if poly_ready:
        seen_slugs: set[str] = set()
        ranked = sorted(
            ({**m, "sector": metas[sym]["sector"]} for sym, found in poly_ready.items() for m in found),
            key=lambda m: -m["volume"],
        )
        for m in ranked:
            if m["slug"] in seen_slugs:
                continue
            seen_slugs.add(m["slug"])
            markets.append(m)

    # `as_of` is the oldest pull in this answer, not the time of the request: a
    # stored copy shown while its refresh runs says how old it is.
    as_of = datetime.datetime.utcfromtimestamp(oldest or time.time())
    return {
        "as_of": as_of.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sources_used": enabled,
        "symbols": symbols_out,
        "sectors": sectors_out,
        "articles": articles,
        "markets": markets,
        "errors": errors,
        # Pulls still running when this was assembled. > 0 → ask again with
        # settle=1 to get them.
        "pending": pending,
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
