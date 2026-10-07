"""What ASK may read of the terminal's own pages.

Two levels, cheapest first:

1. The screen — the text of the view the user has open, captured by the browser
   when the question is sent (`components/bloomberg/ask/screen.ts`). It is what
   the user sees: the tab that is open, the period that is picked, the numbers
   as displayed. No request is made to read it.
2. The data behind a view — one section at a time, from the endpoint the view
   itself reads, with long series cut to the latest `points` observations.

The model starts at 1 and goes to 2 only for what the screen does not hold
(the history behind a chart, a section that is not on screen, more precision).
`_SYSTEM` in routers/news_ai.py says so; the section list below is what it is
shown, so a description here is prompt text — say what the section holds.

Add a view: one entry in PAGES, sections → (backend path, params, description).
A path or a param may hold `{symbol}` (the ticker on screen, or the tool's
`key`), `{market}` (heatmap market code) or `{symbols}` (the watchlist). A
section whose answer is a long table rather than a series — an option chain,
275 heatmap tiles — gets a function in `_SHAPES` that picks what matters;
`shrink` would keep an arbitrary end of it.
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable

SCREEN_CHARS = 24_000

# Longest series a section may return, and what `points` falls back to.
MAX_POINTS = 260
DEFAULT_POINTS = 20
# A list no longer than this is a table (positions, tenors, KPIs), not a series: kept whole.
_TABLE_ROWS = 30

PAGES: dict[str, dict[str, tuple[str, dict, str]]] = {
    "bonds": {
        "overview": ("/api/bonds/overview", {},
                     "KPI strip (2/10/30Y, real yield, term premium, IG/HY OAS, Baa-Aaa, BBB) and their daily history"),
        "decomposition": ("/api/bonds/decomposition", {},
                          "10Y yield = expected real rate + breakeven + term premium (ACM): snapshot, 20D driver, "
                          "1/5/20/60D attribution, tripwires, daily history"),
        "supply": ("/api/bonds/supply", {},
                   "Treasury auctions (recent and upcoming, bid-to-cover, tails), weekly supply, debt stock (Z.1, C&I, SLOOS)"),
        "issuance": ("/api/bonds/issuance", {},
                     "corporate bond deals from SEC filings: daily and weekly counts, recent deals, heavy-day event study"),
        "conditions": ("/api/crisis", {},
                       "CONDITIONS tab: crisis level L0-3, triggered signals, STL FSI / NFCI, breakevens, mortgage rate, delinquencies"),
        "basis": ("/api/cot/basis", {},
                  "CFTC Treasury futures positioning by tenor and the basis trade (leveraged shorts vs asset-manager longs), weekly"),
    },
    "tail": {
        "signals": ("/api/tail-risk/signals", {},
                    "composite risk level and its six dimensions, named market events and their inputs, event log"),
        "macro": ("/api/macro", {},
                  "MACRO CONTEXT: Fed funds and stance, curve, regime, latest inflation / labour / growth prints"),
        "cycle": ("/api/cycle", {},
                  "BUSINESS CYCLE: official indicators by their published definitions — NBER, Sahm rule, recession "
                  "probability, CFNAI, GDP-based index, yield-curve probit, OECD CLI phase, output and unemployment gap, "
                  "PCE against the 2% goal, policy rate against the SEP longer-run median and Taylor (1993), NFCI; each "
                  "with its rule, source, track record against NBER recessions and the S&P 500 after past signals; "
                  "WHAT FOLLOWS lines (know / do / don't)"),
    },
    "market": {
        "indices": ("/api/market-data", {}, "TICK DATA board: equity indices by region, last and change"),
        "volatility": ("/api/volatility", {}, "VIX-family indices: S&P term structure, vol of vol, equity, global, commodity and rates vol (incl. MOVE, Treasury implied vol)"),
        "fx": ("/api/fx", {"type": "overview"}, "20 currency pairs, last and change"),
        "positioning": ("/api/cot/snapshot", {"window": 156},
                        "CFTC COT by contract: net positions, z-scores and crowding flags, weekly"),
    },
    "portfolio": {
        "summary": ("/api/v2/portfolio/summary", {"base_currency": "THB"},
                    "accounts with NAV, cash, realised and unrealised P&L, totals in THB"),
        "positions": ("/api/v2/portfolio/open-positions", {"base_currency": "THB"},
                      "every open position: quantity, cost, price, market value, P&L, weight; open options"),
        "guard": ("/api/v2/portfolio/risk/guard", {"base_currency": "THB"},
                  "TRADE GUARD: light, required actions, per-position and per-sector risk, heat, drawdown, sizing multiplier"),
        "factors": ("/api/v2/portfolio/risk/factors", {"base_currency": "THB"},
                    "RISK → BUDGET · FACTOR: the book's beta to US / Thai equity, size, value, momentum, rates, credit, USD/THB, oil, "
                    "gold, Bitcoin; each factor's share of the book's risk, the effect of a one-SD month, which holdings bring it"),
        "budget": ("/api/v2/portfolio/risk/budget", {"base_currency": "THB", "scope": "symbol"},
                   "RISK → BUDGET · FACTOR: share of the book's risk each holding uses against the budget the user set, "
                   "over / under budget and how much to sell or room to add, the volatility cap"),
        "rebalance": ("/api/v2/portfolio/risk/rebalance", {},
                      "RISK → REBALANCE: holdings whose gain pushed their weight past target — TRIM (sell now, how much), "
                      "HOLD (declined for now, with the user's reason and review date), WAIT, WATCH; the rules in force"),
        "bear-paths": ("/api/v2/portfolio/risk/bear-paths", {"base_currency": "THB"},
                       "RISK → down-tilted paths: the book held as is through random paths with more losing days than "
                       "winning ones at 3 / 5 / 7 / 21 / 42 trading days — median, worst 5%, chance of ending down, "
                       "drawdown on the way, the neutral run beside it, which holdings cost most. A stress, not a forecast"),
        "decisions": ("/api/v2/portfolio/risk/decisions", {"limit": 60},
                      "RISK → decision journal: why a stop-loss or a rebalance was held, followed or changed — the "
                      "reason typed, the numbers at that moment, the review date, whether the hold is still live"),
    },
    "stock": {
        "overview": ("/api/stock/{symbol}", {},
                     "the header: price, change, market cap, 52-week range, P/E — and the daily price series of the chart"),
        "options": ("/api/options/{symbol}", {},
                    "OPTIONS tab: the nearest expiry's chain around the money (bid, ask, IV, volume, OI), put/call ratio, ATM IV, expiries"),
        "sd-bands": ("/api/options/{symbol}/sd-bands", {},
                     "implied against realised move: 1-2 SD price bands for the next 30 days and how often past bands held"),
        "market-state": ("/api/market-state/{symbol}", {},
                         "MARKET STATE tab: the regime (probability, expected duration), trend / momentum / volatility scores, what it rests on"),
        "rate-stress": ("/api/ir-stress/{symbol}", {},
                        "RATE STRESS tab: debt ladder and interest cost, equity duration, measured sensitivity to 2Y and 10Y yields"),
        "dcf": ("/api/dcf/{symbol}", {},
                "DCF tab: intrinsic value per share against price, the EV bridge, the model and its base-case assumptions"),
    },
    "heatmap": {
        "market": ("/api/market-heatmap", {"market": "{market}"},
                   "one equity market by sector: breadth, cap-weighted move of each sector, biggest gainers and losers, largest names"),
    },
    "news": {
        "watchlist": ("/api/news/watchlist", {"symbols": "{symbols}", "per_symbol": 4, "polymarket": 0},
                      "WATCHLIST tab: the latest headlines of every watchlist ticker"),
        "feed": ("/api/news/feed", {"topics": "market", "limit": 60},
                 "the general market newswire (the NEWSFEED tab's own topic filter is what the screen shows)"),
        "polymarket": ("/api/polymarket/signals", {},
                       "Polymarket column: macro prediction markets (Fed, inflation, recession …) with their YES probability"),
        "data": ("/api/v2/series", {},
                 "DATA tab: published series recorded here day by day (e.g. DRAM spot prices): last value, date, source"),
    },
}

# Said under a view's section list: where the rest of what the view shows comes from.
_ALSO = {
    "stock": "Statements, ratios, estimates, analyst and ownership data of the same ticker: get_company_data.",
    "news": "Headlines of chosen tickers or topics: get_watchlist_news, get_topic_news.",
}

_SYMBOL_RE = re.compile(r"^[A-Z0-9][A-Z0-9.\-=^]{0,19}$")
_MARKET_RE = re.compile(r"^[A-Z]{2,3}$")

_DATE_KEYS = ("date", "d", "t", "time", "week", "period", "month", "as_of", "auction_date", "filed", "published_at")


def section_index(page: str | None) -> str:
    """The sections of one view, as lines for the model's context note. '' for a view with none."""
    sections = PAGES.get(page or "")
    if not sections:
        return ""
    lines = [f"  {name} — {desc}" for name, (_, _, desc) in sections.items()]
    if any("{symbol}" in path for path, _, _ in sections.values()):
        lines.append("  (key = the ticker; left empty it is the one on screen)")
    if any("{market}" in str(params) for _, params, _ in sections.values()):
        lines.append("  (key = the market code on screen, e.g. US, TH, JP)")
    if page in _ALSO:
        lines.append(f"  {_ALSO[page]}")
    return "\n".join(lines)


def all_sections() -> str:
    """`page: section, section` for every view — the tool description."""
    return "; ".join(f"{page}: {', '.join(sections)}" for page, sections in PAGES.items())


Shape = Callable[[Any, int], Any]


def lookup(page: str, section: str, key: str = "", focus: list[str] | None = None,
           symbols: list[str] | None = None) -> tuple[str, dict, Shape | None]:
    """Backend path, params and shaping function of one section, its placeholders filled.

    `key` is what the model named (a ticker, a market), `focus` the tickers on
    screen, `symbols` the watchlist. Raises with what does exist, or with what is
    missing — the text goes back to the model.
    """
    page = page.strip().lower()
    section = section.strip().lower()
    sections = PAGES.get(page)
    if not sections:
        raise RuntimeError(f"no page '{page}' — pages with data: {', '.join(PAGES)}")
    entry = sections.get(section)
    if not entry:
        raise RuntimeError(f"no section '{section}' on {page} — sections: {', '.join(sections)}")
    path, params, _ = entry
    key = key.strip().upper()

    values: dict[str, str] = {}
    wanted = path + " " + " ".join(str(v) for v in params.values())
    if "{symbol}" in wanted:
        symbol = key or (focus[0].strip().upper() if focus else "")
        if not symbol:
            raise RuntimeError("which ticker? pass key=<symbol> — no ticker is on screen")
        # It becomes part of a URL on this machine: a ticker and nothing else.
        if not _SYMBOL_RE.match(symbol):
            raise RuntimeError(f"'{symbol}' is not a ticker")
        values["{symbol}"] = symbol
    if "{market}" in wanted:
        market = key or "US"
        if not _MARKET_RE.match(market):
            raise RuntimeError(f"'{market}' is not a market code — e.g. US, TH, JP")
        values["{market}"] = market
    if "{symbols}" in wanted:
        if not symbols:
            raise RuntimeError("the watchlist is empty — use get_watchlist_news with the tickers you mean")
        values["{symbols}"] = ",".join(symbols[:30])

    def fill(value: Any) -> Any:
        if not isinstance(value, str):
            return value
        for name, replacement in values.items():
            value = value.replace(name, replacement)
        return value

    return fill(path), {k: fill(v) for k, v in params.items()}, _SHAPES.get((page, section))


# ── Shapes: a long table cut down to what a question is about ────────────────

_TILE = ("s", "sec", "d1", "w52", "d50", "d200", "hi", "rv", "pe")


def _heatmap(data: Any, points: int) -> Any:
    """~275 tiles → the market in a page: breadth, each sector, the movers, the giants."""
    tiles = [t for t in (data.get("tiles") or []) if isinstance(t, dict) and t.get("d1") is not None]
    if not tiles:
        return data

    def row(t: dict) -> dict:
        out = {k: t[k] for k in _TILE if t.get(k) is not None}
        if t.get("cap"):
            out["cap_bn"] = round(t["cap"] / 1e9, 1)
        return out

    sectors: dict[str, dict] = {}
    for name in sorted({t.get("sec") or "?" for t in tiles}):
        members = [t for t in tiles if (t.get("sec") or "?") == name]
        cap = sum(t.get("cap") or 0 for t in members)
        best = max(members, key=lambda t: t["d1"])
        worst = min(members, key=lambda t: t["d1"])
        sectors[name] = {
            "names": len(members),
            "d1_cap_weighted": round(sum((t.get("cap") or 0) * t["d1"] for t in members) / cap, 2) if cap else None,
            "up": sum(t["d1"] > 0 for t in members),
            "down": sum(t["d1"] < 0 for t in members),
            "best": f"{best['s']} {best['d1']:+.2f}",
            "worst": f"{worst['s']} {worst['d1']:+.2f}",
        }
    by_move = sorted(tiles, key=lambda t: t["d1"], reverse=True)
    n = max(3, points // 2)
    return {
        "market": data.get("market"), "currency": data.get("currency"), "as_of": data.get("asOf"),
        "partial": data.get("partial"), "names": len(tiles),
        "breadth": {"up": sum(t["d1"] > 0 for t in tiles), "down": sum(t["d1"] < 0 for t in tiles)},
        "fields": "d1 = 1-day %, w52 = 52-week %, d50 / d200 = % from the 50 / 200-day average, "
                  "hi = % from the 52-week high, rv = relative volume, cap_bn = market cap, billions",
        "sectors": sectors,
        "gainers": [row(t) for t in by_move[:n]],
        "losers": [row(t) for t in by_move[-n:][::-1]],
        "largest": [row(t) for t in sorted(tiles, key=lambda t: t.get("cap") or 0, reverse=True)[:10]],
        "_note": f"{n} gainers and {n} losers of {len(tiles)} names — ask for more points for more of them",
    }


_OPTION = ("strike", "lastPrice", "bid", "ask", "impliedVolatility", "volume", "openInterest")


def _options(data: Any, points: int) -> Any:
    """A chain of ~100 contracts → the `points` strikes nearest the money, each side."""
    if not isinstance(data, dict):
        return data
    money = data.get("atmStrike") or data.get("spot") or 0

    def near(rows: Any) -> list[dict]:
        rows = [r for r in (rows or []) if isinstance(r, dict) and r.get("strike") is not None]
        kept = sorted(sorted(rows, key=lambda r: abs(r["strike"] - money))[:points], key=lambda r: r["strike"])
        return [{k: r[k] for k in _OPTION if r.get(k) is not None} for r in kept]

    out = {k: v for k, v in data.items() if k not in ("calls", "puts", "expirations")}
    out["expirations"] = (data.get("expirations") or [])[:12]
    out["calls"], out["puts"] = near(data.get("calls")), near(data.get("puts"))
    total = len(data.get("calls") or []) + len(data.get("puts") or [])
    out["_note"] = f"the {points} strikes nearest the money of each side, of {total} contracts — more points for the wings"
    return out


_ARTICLE = ("symbol", "primary_symbol", "title", "url", "source", "published_at", "summary", "topic")


def _articles(data: Any, points: int) -> Any:
    """News rows without the fields only the panel uses."""
    if not isinstance(data, dict):
        return data
    rows = [{k: (a[k][:300] if k == "summary" else a[k]) for k in _ARTICLE if a.get(k)} for a in data.get("articles", [])]
    return {"as_of": data.get("as_of"), "articles": rows}


_SHAPES: dict[tuple[str, str], Shape] = {
    ("heatmap", "market"): _heatmap,
    ("stock", "options"): _options,
    ("news", "watchlist"): _articles,
    ("news", "feed"): _articles,
}


def _stamp(item: Any) -> str | None:
    """The date of one observation, when it carries one."""
    if isinstance(item, dict):
        for key in _DATE_KEYS:
            value = item.get(key)
            if isinstance(value, str) and value[:4].isdigit():
                return value
    if isinstance(item, (list, tuple)) and item and isinstance(item[0], str) and item[0][:4].isdigit():
        return item[0]
    return None


def fit(data: Any, points: int, max_chars: int) -> Any:
    """`shrink`, with fewer points when the answer would not fit in one tool result.

    A result cut off at the character limit loses its end — for a series, the
    newest observations. Halving the points keeps the latest ones and says so.
    """
    asked = points
    while True:
        out = shrink(data, points)
        size = len(json.dumps(out, ensure_ascii=False, default=str, separators=(",", ":")))
        if size <= max_chars or points <= 5:
            break
        points = max(5, points // 2)
    if points != asked and isinstance(out, dict):
        out = {"_note": f"{asked} points did not fit in one result; showing the latest {points}", **out}
    return out


def shrink(data: Any, points: int) -> Any:
    """Cut every long series in a response to its latest `points` observations.

    A 573-day history is most of a section's size and almost never what a
    question needs; the model asks for more points when it does. Which end is
    "latest" is read from the dates (newest-first lists keep their head). The
    cut is stated in place, so the model knows the series goes further back.
    """
    if isinstance(data, dict):
        # Empty fields say nothing and a wide table has many of them.
        return {
            k: shrink(v, points) for k, v in data.items()
            if v is not None and v != "" and v != [] and v != {}
        }
    if isinstance(data, float):
        return round(data, 6)       # 0.9137000000000001 is noise, and it is paid for per character
    if not isinstance(data, list):
        return data
    if len(data) <= max(points, _TABLE_ROWS):
        return [shrink(v, points) for v in data]
    first, last = _stamp(data[0]), _stamp(data[-1])
    newest_first = bool(first and last and first > last)
    kept = data[:points] if newest_first else data[-points:]
    return {
        "_series": f"latest {points} of {len(data)} observations — ask for more points to go further back",
        "rows": [shrink(v, points) for v in kept],
    }
