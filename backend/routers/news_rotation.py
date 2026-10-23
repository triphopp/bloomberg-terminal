"""
Rotation news — headlines for each MKT → ROT group, scored for tone, beside
the group's RRG quadrant.

GET /api/news/rotation?market=US&kind=sector&wait=4

The groups are exactly ROT's (`routers/rotation.rotation_table`, same cache),
so a quadrant here can never disagree with MKT → ROT. Per group:

* US sector / theme — Google News on the group's name + Yahoo's RSS for its ETF;
* TH industry group / sector — Google News on the names of its largest members
  (the ROT basket), since "Thailand <sector> stocks" finds mostly foreign DRs.

A headline is kept only when it names the group (`_relevant`): a sector word,
the ETF, or for TH a member — Yahoo's ETF feed and the searches also return
other markets' sector wraps (ASX, TSX …) and quote pages, which are dropped.

Tone is `headline_tone.tone_of`, the word list the WATCHLIST tab uses too:
POS / NEG / NEU per title, counted per group. It reads words, not meaning — a
context line beside price, never a signal, and the response says so (`method`).

`read` compares the two: CONFIRMS when price strength and tone point the same
way (Leading/Improving with net tone > 0, Lagging/Weakening with net < 0),
DIVERGES when they point opposite ways, null when tone is flat or too thin.

Each group's pull is cached 10 min (a failed one keeps the last good items
and is retried after 2 min). `wait` caps how long the request holds on pulls
it has nothing for; the rest are counted in `pending` and the view asks again.
Without `wait` the request holds until every pull has answered (ASK).
"""
from __future__ import annotations

import datetime
import re
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, wait as wait_futures
from urllib.parse import quote_plus

from fastapi import APIRouter, Query

import sector_membership as sm
from headline_tone import tone_of
from routers import news_watchlist, rotation
from routers.news_watchlist import _rss_items, _src_yahoo_ticker

router = APIRouter()

_FRESH_S = 600          # a good pull is not repeated for 10 min
_RETRY_S = 120          # a failed one is retried after 2 min
_WAIT_ALL_S = 30.0      # no `wait` → hold until everything has answered
_PER_SOURCE = 20
_PER_GROUP = 12         # headlines kept per group
_MIN_FOR_READ = 3       # fewer scored headlines than this → no CONFIRMS / DIVERGES

_pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="rot-news")
_lock = threading.Lock()
# "<market>|<id>" → {"items", "ts", "retry_at", "error"}
_store: dict[str, dict] = {}
_inflight: dict[str, Future] = {}

_KINDS = {"US": ("sector", "theme"), "TH": ("industry", "sector")}


# ── Relevance ─────────────────────────────────────────────────────────────────
# Words that place a headline in a GICS sector. The ETF's own ticker counts too.
_SECTOR_WORDS = {
    "XLK": "tech|technology|software|semiconductors?|chips?|chipmakers?|AI|cloud",
    "XLF": "financials?|banks?|banking|lenders?|insurers?|brokers?",
    "XLV": "health ?care|pharma|pharmaceuticals?|drugmakers?|biotech|medical|hospitals?",
    "XLE": "energy|oil|gas|crude|refiners?|drillers?|OPEC",
    "XLI": "industrials?|aerospace|defen[cs]e|machinery|railroads?|transports?|airlines?",
    "XLY": "consumer discretionary|retail|retailers?|automakers?|restaurants?|travel|homebuilders?",
    "XLP": "consumer staples|staples|grocers?|beverages?|food|tobacco|household",
    "XLRE": "real estate|REITs?|property|landlords?",
    "XLU": "utilit(y|ies)|power|electricity|grid",
    "XLB": "materials|chemicals?|metals|mining|miners?|steel|copper|gold",
    "XLC": "communication services|telecoms?|media|streaming|advertising",
}
# Another market's wrap ("ASX Midday Sector Update …") is not about the US group.
_FOREIGN = re.compile(r"\b(ASX|TSXV?|FTSE|DAX|Nikkei|Sensex|Nifty|Hang Seng|KOSPI|LSE|Canadian|Australian|India|Indian|Korean|Europe|European|crore|Sri Lanka|Sri Lankan|Pakistan|Pakistani|Bangladesh|Bangladeshi|Nigeria|Nigerian|Kenya|Kenyan|Egypt|Egyptian|Saudi|Philippine|Vietnam|Vietnamese|Malaysia|Malaysian|Indonesia|Indonesian|DSE|PSX|JSE|NGX)\b")
_JUNK = re.compile(r"stock price, news|quote & history|how to buy|depositary receipts?|alien mkt|price target . prediction|\(\w+\.F\)", re.I)
_CORP = re.compile(r"\b(pcl|public company limited|co\.?,? ltd\.?|ltd\.?|inc\.?|corp\.?|holdings?|group)\b", re.I)

_th_baskets: dict[str, list[dict]] = {}


def _th_basket(group_id: str) -> list[dict]:
    if not _th_baskets:
        for g in rotation._th_groups():
            _th_baskets[g["id"]] = g["basket"]
    return _th_baskets.get(group_id, [])


def _company(name: str) -> str:
    """'CHAROEN POKPHAND FOODS PCL' → 'Charoen Pokphand Foods'."""
    return re.sub(r"\s+", " ", _CORP.sub("", name or "")).strip(" ,.").title()


def _matcher(market: str, row: dict) -> re.Pattern:
    if market == "TH":
        # The first two words of each name ("Central Pattana", "Charoen Pokphand"),
        # and the ticker only when it is long enough not to be a common word.
        terms = []
        for m in _th_basket(row["id"])[:5]:
            name = " ".join(_company(m["name"]).split(" ")[:2])
            if len(name) > 3:
                terms.append(re.escape(name))
            if len(m["symbol"]) >= 5:
                terms.append(re.escape(m["symbol"]))
        return re.compile(r"\b(" + "|".join(terms or ["$^"]) + r")\b", re.I)
    sym = row["id"]
    words = _SECTOR_WORDS.get(sym)
    if words is None:  # a theme: the words of its own label
        label = row["name"].split(" (")[0]
        # "Banks" → Banks? so "Bank stocks" counts too
        stems = (re.sub(r"s$", "", w) if len(w) > 4 else w
                 for w in re.split(r"[\s&/]+", label) if len(w) > 2)
        words = "|".join(re.escape(w) + "s?" for w in stems)
    return re.compile(r"\b(" + re.escape(sym) + "|" + words + r")\b", re.I)


def _relevant(market: str, title: str, matcher: re.Pattern) -> bool:
    if _JUNK.search(title):
        return False
    if market == "US" and _FOREIGN.search(title):
        return False
    return bool(matcher.search(title))


# ── Pulls ─────────────────────────────────────────────────────────────────────

def _google(query: str, days: int) -> list[dict]:
    url = (
        f"https://news.google.com/rss/search?q={quote_plus(query)}+when:{days}d"
        "&hl=en-US&gl=US&ceid=US:en"
    )
    return _rss_items(url, "Google News", _PER_SOURCE)


def _queries(market: str, row: dict) -> list[tuple[str, callable]]:
    """(label, fetcher) pairs for one ROT row."""
    if market == "TH":
        names = [_company(m["name"]) for m in _th_basket(row["id"])[:4]]
        names = " OR ".join(f'"{n}"' for n in names if n)
        query = f"({names}) Thailand" if names else f'Thailand "{row["name"]}" stocks'
        return [("google", lambda: _google(query, 7))]
    sym = row["id"]
    gics = sm.GICS_BY_ETF.get(sym)
    name = gics[1] if gics else row["name"].split(" (")[0]
    query = f'"{name}" stocks'
    return [
        ("google", lambda: _google(query, 3)),
        ("yahoo", lambda: _src_yahoo_ticker(sym, name, _PER_SOURCE)),
    ]


def _pull(key: str, market: str, row: dict) -> None:
    items: list[dict] = []
    errors: list[str] = []
    for label, fetch in _queries(market, row):
        try:
            items.extend(fetch())
        except Exception as exc:  # one dead source must not drop the other
            errors.append(f"{label}: {exc}")
    matcher = _matcher(market, row)
    seen: set[str] = set()
    kept: list[dict] = []
    for it in sorted(items, key=lambda i: i.get("published_at") or "", reverse=True):
        if not _relevant(market, it["title"], matcher):
            continue
        title_key = it["title"].lower()[:80]
        url_key = it["url"].split("?")[0]
        if title_key in seen or url_key in seen:
            continue
        seen.update((title_key, url_key))
        kept.append({
            "title": it["title"],
            "url": it["url"],
            "source": it["source"],
            "published_at": it.get("published_at") or "",
            "tone": tone_of(it["title"]),
        })
    now = time.time()
    with _lock:
        prev = _store.get(key)
        if kept or not prev:
            _store[key] = {"items": kept[:_PER_GROUP], "ts": now,
                           "retry_at": now + (_FRESH_S if kept else _RETRY_S),
                           "error": "; ".join(errors) or None}
        else:  # nothing came back: keep the last good items, try again sooner
            prev.update(retry_at=now + _RETRY_S, error="; ".join(errors) or "no headlines")
        _inflight.pop(key, None)


def _job(key: str, market: str, row: dict) -> Future:
    with _lock:
        fut = _inflight.get(key)
        if fut is None:
            fut = _pool.submit(_pull, key, market, row)
            _inflight[key] = fut
        return fut


def _tone(items: list[dict]) -> dict:
    pos = sum(1 for i in items if i["tone"] == "POS")
    neg = sum(1 for i in items if i["tone"] == "NEG")
    n = len(items)
    return {"n": n, "pos": pos, "neg": neg, "neu": n - pos - neg,
            "net": round((pos - neg) / n, 3) if n else None}


def _read(quadrant: str | None, tone: dict) -> str | None:
    if not quadrant or tone["net"] is None or tone["pos"] + tone["neg"] < _MIN_FOR_READ:
        return None
    if tone["net"] == 0:
        return None
    strong = quadrant in ("Leading", "Improving")
    return "CONFIRMS" if strong == (tone["net"] > 0) else "DIVERGES"


def _match_rows(rows: list[dict], needle: str) -> list[dict]:
    """A group by its id, else every group whose name contains the word."""
    exact = [r for r in rows if str(r.get("id", "")).lower() == needle]
    return exact or [r for r in rows if needle in str(r.get("name", "")).lower()]


@router.get("/api/news/rotation")
def rotation_news(
    market: str = Query("US", pattern="^(US|TH|us|th)$"),
    kind: str = Query("", description="sector | theme (US) · industry | sector (TH) · all; "
                                      "empty = sector (US) / industry (TH)"),
    fresh: int = Query(0, description="1 = re-pull every group now (REFRESH)"),
    wait: float | None = Query(None, ge=0, le=30,
                               description="Answer after at most this many seconds; the rest is "
                                           "counted in `pending`. Omit to hold for everything."),
    group: str = Query("", max_length=60,
                       description="One group only: its id (XLE, SMH, FINCIAL) or a word of its name "
                                   "(energy, banks); searches every kind of the market"),
    headlines: int = Query(_PER_GROUP, ge=0, le=_PER_GROUP,
                           description="Headlines returned per group (tone is always counted over all "
                                       "of them)"),
):
    """Headlines and their tone for every ROT group of one market."""
    mkt = market.upper()
    kinds = _KINDS[mkt]
    want = (kind or kinds[0]).lower()
    if want != "all" and want not in kinds:
        want = kinds[0]
    table = rotation.rotation_table(bench=rotation._DEFAULT_BENCH, market=mkt)
    all_rows = table.get("rows") or []
    needle = group.strip().lower()
    if needle:
        want = "all"
        rows = _match_rows(all_rows, needle)
    else:
        rows = [r for r in all_rows if want == "all" or r.get("kind") == want]

    started = time.monotonic()
    deadline = started + (_WAIT_ALL_S if wait is None else wait)
    now = time.time()
    awaited: list[Future] = []
    for r in rows:
        key = f"{mkt}|{r['id']}"
        with _lock:
            entry = _store.get(key)
        due = entry is None or now >= entry["retry_at"] or (fresh and now - entry["ts"] > 10)
        if not due:
            continue
        fut = _job(key, mkt, r)
        if entry is None or fresh or wait is None:
            awaited.append(fut)
    pending = 0
    if awaited:
        _, not_done = wait_futures(awaited, timeout=max(0.0, deadline - time.monotonic()))
        pending = len(not_done)

    groups: list[dict] = []
    oldest: float | None = None
    with _lock:
        for r in rows:
            entry = _store.get(f"{mkt}|{r['id']}")
            items = entry["items"] if entry else []
            if entry:
                oldest = entry["ts"] if oldest is None else min(oldest, entry["ts"])
            tone = _tone(items)
            groups.append({
                "id": r["id"],
                "name": r["name"],
                "kind": r.get("kind"),
                "quadrant": r.get("quadrant"),
                "mom_dir": r.get("mom_dir"),
                "m1": r.get("m1"),
                "m1_vs_bench": r.get("m1_vs_bench"),
                "tone": tone,
                "read": _read(r.get("quadrant"), tone),
                "headlines": items[:headlines],
                "loading": entry is None,
                "error": entry.get("error") if entry else None,
            })

    as_of = datetime.datetime.utcfromtimestamp(oldest or time.time())
    return {
        "market": mkt,
        "kind": want,
        "kinds": list(kinds),
        "bench": table.get("bench"),
        "rotation_as_of": table.get("as_of"),
        "as_of": as_of.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "groups": groups,
        "pending": pending,
        **({"error": f"no {mkt} ROT group matches '{group.strip()}' — groups: "
                     + ", ".join(f"{r.get('id')} ({r.get('name')})" for r in all_rows)}
           if needle and not rows else {}),
        "method": "headlines that name the group (a sector word, the ETF, or for TH one of its largest "
                  "members); tone = a word list over each title (gains, surge, upgrade … / falls, miss, "
                  "downgrade …), counted per group — it reads words, not meaning. CONFIRMS / DIVERGES "
                  f"compares it with the ROT quadrant when ≥{_MIN_FOR_READ} headlines carry a tone. "
                  "Context beside price, not a signal.",
    }


# ── Members: the group's largest holdings, each with its own headlines ───────
# The news of the stocks the group is made of, read through the WATCHLIST tab's
# per-(symbol, source) store — same sources, same 5-min freshness, and a pull
# made here is one the WATCHLIST tab will not repeat. A headline counts for a
# member only when it names that stock (`relevance: direct`, or it was
# cross-tagged because it mentions it).

_MEMBERS_MAX = 25


def _news_symbol(market: str, symbol: str) -> str:
    return f"{symbol}.BK" if market == "TH" and not symbol.endswith(".BK") else symbol


# A first word this common names many companies ("Bank of Ayudhya", "First
# Solar", "Thai Union"): the first two words are needed instead.
_GENERIC_FIRST = {"bank", "first", "american", "general", "united", "international", "national",
                  "global", "thai", "the", "siam", "bangkok", "krung", "new", "royal", "central"}


def _stock_pattern(symbol: str, name: str) -> re.Pattern:
    """The ticker as a capitalised word, or the company's name. A name word may
    not run on into a hyphen: "Williams" is not "Williams-Sonoma"."""
    words = _company(name).split(" ")
    lead = " ".join(words[:2]) if words and words[0].lower() in _GENERIC_FIRST else words[0] if words else ""
    parts = [rf"(?<![A-Za-z0-9.]){re.escape(symbol)}(?![A-Za-z0-9])"]
    if len(lead) >= 4:
        parts.append(rf"(?i:(?<![A-Za-z]){re.escape(lead)}(?![A-Za-z-]))")
    return re.compile("|".join(parts))


def _member_articles(articles: list[dict], sym: str, name: str) -> list[dict]:
    """Stories in the answer that name this member. The WATCHLIST merge tags a
    story with every symbol whose feed carried the same link, so a general
    market item off Yahoo's .BK feeds is listed under all of them — the
    headline itself has to name the stock."""
    pat = _stock_pattern(sym.removesuffix(".BK"), name)
    return [a for a in articles
            if sym in (a.get("symbols") or []) and pat.search(f"{a.get('title', '')} {a.get('summary', '')}")]


def _rollup(members: list[dict], quadrant: str | None) -> dict:
    """Each member's net tone weighted by its weight in the group, over the
    members that have any headline; breadth counts members, not headlines."""
    with_news = [m for m in members if m["tone"]["n"]]
    wsum = sum(m["weight"] or 0 for m in with_news)
    weighted = (round(sum((m["weight"] or 0) * m["tone"]["net"] for m in with_news) / wsum, 3)
                if wsum else None)
    pos = sum(m["tone"]["pos"] for m in members)
    neg = sum(m["tone"]["neg"] for m in members)
    if weighted is None or weighted == 0 or pos + neg < _MIN_FOR_READ or not quadrant:
        read = None
    else:
        read = "CONFIRMS" if (quadrant in ("Leading", "Improving")) == (weighted > 0) else "DIVERGES"
    return {
        "weighted_net": weighted,
        "weight_covered": round(wsum, 2),
        "weight_listed": round(sum(m["weight"] or 0 for m in members), 2),
        "pos": pos,
        "neg": neg,
        "n": sum(m["tone"]["n"] for m in members),
        "breadth": {
            "positive": sum(1 for m in with_news if m["tone"]["net"] > 0),
            "negative": sum(1 for m in with_news if m["tone"]["net"] < 0),
            "flat": sum(1 for m in with_news if m["tone"]["net"] == 0),
            "no_news": len(members) - len(with_news),
        },
        "read": read,
    }


@router.get("/api/news/rotation/members")
def rotation_member_news(
    market: str = Query("US", pattern="^(US|TH|us|th)$"),
    group: str = Query(..., min_length=1, max_length=60,
                       description="ROT group id (XLE, SMH, FINCIAL) or a word of its name"),
    top: int = Query(10, ge=1, le=_MEMBERS_MAX, description="Largest members by weight"),
    headlines: int = Query(3, ge=0, le=10, description="Headlines returned per member"),
    fresh: int = Query(0, description="1 = re-pull every member's sources now"),
    wait: float | None = Query(None, ge=0, le=40,
                               description="Answer after at most this many seconds; the rest is in "
                                           "`pending`. Omit to hold for everything."),
):
    """Headlines and tone of a ROT group's largest members, rolled up by weight."""
    mkt = market.upper()
    table = rotation.rotation_table(bench=rotation._DEFAULT_BENCH, market=mkt)
    all_rows = table.get("rows") or []
    found = _match_rows(all_rows, group.strip().lower())
    if not found:
        return {"market": mkt, "group": None, "members": [], "pending": 0,
                "error": f"no {mkt} ROT group matches '{group.strip()}' — groups: "
                         + ", ".join(f"{r.get('id')} ({r.get('name')})" for r in all_rows)}
    row = found[0]
    cons = rotation.rotation_constituents(id=row["id"], market=mkt)
    members = sorted(cons.get("rows") or [], key=lambda m: -(m.get("weight") or 0))[:top]
    group_out = {"id": row["id"], "name": row["name"], "kind": row.get("kind"),
                 "quadrant": row.get("quadrant"), "m1": row.get("m1"),
                 "m1_vs_bench": row.get("m1_vs_bench")}
    if not members:
        return {"market": mkt, "group": group_out, "members": [], "pending": 0,
                "error": cons.get("error") or "no members listed for this group"}

    syms = [_news_symbol(mkt, m["symbol"]) for m in members]
    news = news_watchlist.watchlist_news(
        symbols=",".join(syms), per_symbol=8, per_source=6, sources="all", polymarket=0,
        fresh=fresh, wait=wait, settle=0,
    )
    articles = news.get("articles") or []

    out: list[dict] = []
    for m, sym in zip(members, syms):
        items = [{
            "title": a["title"], "url": a["url"], "source": a.get("source"),
            "published_at": a.get("published_at") or "", "tone": tone_of(a["title"]),
        } for a in _member_articles(articles, sym, m.get("name") or "")]
        tone = _tone(items)
        out.append({
            "symbol": m["symbol"],
            "name": m.get("name"),
            "weight": m.get("weight"),
            "m1": m.get("m1"),
            "m1_vs_bench": m.get("m1_vs_bench"),
            "quadrant": m.get("quadrant"),
            "tone": tone,
            "read": _read(m.get("quadrant"), tone),
            "headlines": items[:headlines],
        })

    return {
        "market": mkt,
        "group": group_out,
        "bench": cons.get("bench"),
        "weight_basis": ((cons.get("group") or {}).get("source") or {}).get("weight_basis"),
        "members_total": len(cons.get("rows") or []),
        "members": out,
        "rollup": _rollup(out, row.get("quadrant")),
        "as_of": news.get("as_of"),
        "pending": news.get("pending", 0),
        "method": "the group's largest members by weight, each with the headlines that name it (the "
                  "WATCHLIST tab's sources); tone = the same word list as the group view. weighted_net "
                  "= sum(weight × member net) / sum(weight) over members with news; breadth counts "
                  "members. A member's quadrant is its own vs the benchmark. Context beside price, "
                  "not a signal.",
    }
