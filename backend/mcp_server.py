"""
Bloomberg Terminal MCP server — lets an agent work on investment theses with you.

Transport: stdio. Talks to the running backend over HTTP (PYTHON_API_URL, default
http://localhost:9317) rather than opening portfolio.db itself, so every write
goes through the same validation, event log and sync triggers as the UI.

Every write carries `X-Thesis-Actor: agent:<MCP_AGENT_NAME>`, which the theses
router stamps onto the event payload — the THESES timeline shows which changes
the agent made. There is deliberately no delete tool: soft-deleting or purging
a thesis stays a human action in the UI.

Run:  python backend/mcp_server.py        (registered in .mcp.json at repo root)
"""
import json
import os
from typing import Any, Literal, Optional

from urllib.parse import urlsplit, urlunsplit

from pathlib import Path

import requests
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

def _ipv4_loopback(url: str) -> str:
    """`localhost` → `127.0.0.1`, same server.

    uvicorn binds 127.0.0.1 (IPv4 only). On Windows `localhost` resolves to ::1
    first and Python HTTP clients wait for that connect to time out before
    falling back — measured 2,050 ms added to EVERY tool call, vs 15–30 ms.
    (Browsers and Node's fetch race both families, so they never showed it.)
    """
    parts = urlsplit(url)
    if parts.hostname != "localhost":
        return url
    netloc = "127.0.0.1" + (f":{parts.port}" if parts.port else "")
    return urlunsplit(parts._replace(netloc=netloc))


API = _ipv4_loopback(os.getenv("PYTHON_API_URL", "http://localhost:9317").rstrip("/"))
ACTOR = f"agent:{os.getenv('MCP_AGENT_NAME', 'claude')}"
THESES = f"{API}/api/v2/theses"

# Tool results go straight into the agent's context — cap them so one news
# call cannot eat the window.
MAX_CHARS = 40_000

mcp = MCPServer(
    name="bloomberg-terminal",
    instructions=(
        "Investment-thesis workspace shared with the user. The DB is the source of "
        "truth; the user sees every change in PORT → TOOLS → THESES. "
        "Read before you write: get_thesis first, then research with the market tools. "
        "Findings belong in the Zettelkasten: zettel_search FIRST (never jot a "
        "duplicate), then zettel_create one idea per note with its source and the "
        "date of the fact, attached to the thesis. When a finding clashes with "
        "something already written, do NOT overwrite it — zettel_link rel=CONTRADICTS "
        "and leave the conflict open for the user. Thesis-local scenarios and dated "
        "watch items still go in add_note; log_event records a REVIEW verdict. "
        "A finding that is only legible as a picture — a money-flow map, a cycle "
        "ladder, a cross-company comparison — goes in graph_create as one "
        "self-contained HTML page attached to the thesis (graph_list first). "
        "Never rewrite the thesis body or change status/conviction unless asked, and "
        "always give a reason. "
        "OPEN QUESTIONS: what a thesis does not know yet lives in PORT → TOOLS → "
        "QUESTIONS, not in the thesis body. question_queue shows what is waiting; "
        "call get_question_spec BEFORE answering one and follow it — competing "
        "explanations first, then the signals each would leave, then the search. "
        "question_answer is refused without evidence (zettel with url + quote); "
        "inference is allowed only with an assumption someone can test. Your answer "
        "is a proposal: only the user accepts it or drops a question. "
        "TRACKED NUMBERS: a number a thesis stands or falls on (a kill condition, a "
        "margin, an inventory figure, a contract price) lives in PORT → TOOLS → TRACK, "
        "not as a line in the thesis body: where it is read, what was expected for the "
        "period and why, and the date it comes out. track_due shows what has come due; "
        "read the number from the source the row names, then track_record it with its "
        "evidence. The server compares it with the forecast, and a miss opens a "
        "question for you to answer. Call get_tracking_spec before the first track_* "
        "write. You cannot move a kill line, retire a metric or change a thesis's "
        "status because a line was crossed — report it and let the user decide. "
        "ANTI-THESIS (step back): what a thesis believes is argued against in PORT → "
        "TOOLS → THESES → ANTI-THESIS — each belief beside its negation, attacked from "
        "five angles (FACT, CAUSE, LOGIC, TIME, PRICE). Call get_antithesis_spec before "
        "the first anti_* write. Raising an objection needs only the argument; "
        "dismissing one (anti_verdict REBUTTED) is refused without evidence (zettel "
        "with url + quote). Your job there is to ATTACK the thesis, not to defend it: "
        "an objection you cannot rebut with evidence stays open or is conceded. Your "
        "verdict is a proposal — only the user accepts it, withdraws an objection, or "
        "rewrites, retires or deletes a claim. A fallen claim never changes the thesis "
        "by itself. "
        "Fundamental analysis (\"วิเคราะห์พื้นฐาน\" a ticker): call "
        "get_fundamental_spec FIRST and follow it exactly — which data to pull "
        "(get_stock_data, get_filings, get_fiscal_data, get_news, the earnings call), "
        "the 12 Thai sections, and its rules: facts only, say unclear when unclear. "
        "WHERE TO LOOK: before searching for any data (macro, country, rates, "
        "company, news) call get_data_sources and follow its order — these MCP tools, "
        "then the backend endpoints it lists, then the free external APIs it lists, "
        "and only then the open web. "
        "SOURCES — ALWAYS: every number or factual claim you write (thesis body, "
        "note, zettel, graph, chat answer) names its source: publisher/tool + URL or "
        "filing (form, period, filed date) + the date of the fact. Tool results carry "
        "a `source`/`url` field — pass it through. No source = do not state it as fact; "
        "label opinions (scores, ratings, sell-side views) as opinions. "
        "FREE FIRST: use free/public sources before anything paid — SEC EDGAR "
        "(filings, XBRL), company IR/press releases, central banks, FRED, Google Trends, "
        "then free news. Paid/licensed sources (Bloomberg, Moody's/S&P/Fitch research, "
        "paid transcripts) only when the user has access and asks; never scrape a "
        "paywalled or ToS-restricted site, never work around a rate limit."
    ),
)


# The fundamental-analysis spec lives in one file; the MCP serves it (tool, prompt,
# resource) so agents outside the repo — Claude Desktop, HTTP clients — follow
# the same 12 sections. Read on every call: edits need no MCP restart.
SPEC_FILE = Path(__file__).resolve().parent.parent / "memory" / "reference" / "fundamental-analysis.md"
# Same idea for the data-source registry: where to look, in which order.
SOURCES_FILE = SPEC_FILE.with_name("data-sources.md")
# And for answering open questions: the research protocol and the answer levels.
QUESTION_SPEC_FILE = SPEC_FILE.with_name("question-research.md")
# And for tracked metrics: how to set one up, forecast it and record the result.
TRACKING_SPEC_FILE = SPEC_FILE.with_name("thesis-tracking.md")
# And for stepping back from a thesis: claims, negations, objections, verdicts.
ANTITHESIS_SPEC_FILE = SPEC_FILE.with_name("anti-thesis.md")


def _read_ref(path: Path, what: str) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ToolError(f"{what} not found at {path}") from exc


def _spec_text() -> str:
    return _read_ref(SPEC_FILE, "fundamental-analysis spec")


# ── HTTP helpers ─────────────────────────────────────────────────────────────

class BackendError(ToolError):
    """Surfaced to the agent verbatim — the SDK hides the text of any other exception."""


# One pooled connection for the life of the MCP process instead of a new TCP
# handshake per call.
_SESSION = requests.Session()


def _call(method: str, url: str, *, params: Optional[dict] = None,
          body: Optional[dict] = None, timeout: float = 30) -> Any:
    try:
        r = _SESSION.request(
            method, url,
            params={k: v for k, v in (params or {}).items() if v is not None},
            json=body,
            headers={"X-Thesis-Actor": ACTOR},
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise BackendError(
            f"Backend unreachable at {API} ({exc.__class__.__name__}). "
            "Is the Bloomberg Terminal backend running?"
        ) from exc
    if not r.ok:
        try:
            detail = r.json().get("detail", r.text)
        except ValueError:
            detail = r.text
        raise BackendError(f"{method} {url.removeprefix(API)} → {r.status_code}: {detail}")
    return r.json()


def _out(data: Any) -> str:
    text = json.dumps(data, ensure_ascii=False, default=str)
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS] + f"… [truncated {len(text) - MAX_CHARS} chars — narrow the query]"
    return text


def _clean(d: dict) -> dict:
    return {k: v for k, v in d.items() if v is not None}


# ── Theses: read ─────────────────────────────────────────────────────────────

@mcp.tool()
def list_theses(
    status: Optional[Literal["draft", "active", "watch", "invalidated", "closed"]] = None,
    symbol: Optional[str] = None,
    category: Optional[str] = None,
    kind: Optional[str] = None,
    sector: Optional[str] = None,
    tag: Optional[str] = None,
    q: Optional[str] = None,
) -> str:
    """List investment theses (without the markdown body). Includes event_count
    and open_note_count per thesis. Use get_thesis for full detail.
    kind = what the thesis is about (equity, credit, fund, macro, theme, process,
    or one the user made up); sector = GICS name; tag = one tag; q = text search
    over symbol, title, tags, strategy and body."""
    rows = _call("GET", THESES, params={"status": status, "symbol": symbol,
                                        "category": category, "kind": kind,
                                        "sector": sector, "tag": tag, "q": q})["theses"]
    for r in rows:
        body = r.pop("body", "") or ""
        r["body_chars"] = len(body)
    return _out(rows)


@mcp.tool()
def get_thesis(thesis_id: str, event_limit: int = 30) -> str:
    """Full thesis: markdown body, standing notes (scenarios/risks/catalysts/
    evidence), the append-only history of how the view changed, and linked trades."""
    return _out(_call("GET", f"{THESES}/{thesis_id}", params={"event_limit": event_limit}))


@mcp.tool()
def notes_due(days: int = 14, include_undated: bool = False) -> str:
    """Open/watching notes across all theses whose watch_date falls within `days`
    — what the book is waiting on (earnings, catalysts, deadlines)."""
    return _out(_call("GET", f"{THESES}/notes/due",
                      params={"days": days, "include_undated": include_undated}))


# ── Theses: write ────────────────────────────────────────────────────────────

@mcp.tool()
def create_thesis(
    symbol: str,
    title: str,
    body: str = "",
    category: Optional[str] = None,
    strategy: Optional[str] = None,
    time_horizon: Optional[str] = None,
    target_price: Optional[float] = None,
    stop_price: Optional[float] = None,
    currency: Optional[str] = None,
    kind: Optional[str] = None,
    sector: Optional[str] = None,
    tags: Optional[str] = None,
) -> str:
    """Create a new thesis. Always starts as status=draft with no conviction —
    promoting it is the user's call. `body` is markdown (## Claim, ## Condition
    Killers, ## Catalysts, ## Valuation, ## Key Risks are recognised headers).
    Say what it is about with `kind`: equity (default), credit, fund (a fund, an
    ETF, a manager's product), macro (an economy, rates, inflation), theme (an
    industry or supply chain), process. A thesis that is not about one ticker
    still needs `symbol` — use a short handle such as TH-RATES or NAND.
    `sector` is a GICS name; `tags` is comma-separated. `category` is the
    portfolio bucket (CORE, GROWTH, …), not the kind."""
    payload = _clean({
        "kind": kind, "sector": sector, "tags": tags,
        "symbol": symbol, "title": title, "body": body, "category": category,
        "strategy": strategy, "time_horizon": time_horizon, "target_price": target_price,
        "stop_price": stop_price, "currency": currency, "status": "draft",
    })
    return _out(_call("POST", THESES, body=payload)["thesis"])


@mcp.tool()
def update_thesis(
    thesis_id: str,
    reason: str,
    title: Optional[str] = None,
    body: Optional[str] = None,
    status: Optional[Literal["draft", "active", "watch", "invalidated", "closed"]] = None,
    conviction: Optional[int] = None,
    target_price: Optional[float] = None,
    stop_price: Optional[float] = None,
    time_horizon: Optional[str] = None,
    category: Optional[str] = None,
    strategy: Optional[str] = None,
    kind: Optional[str] = None,
    sector: Optional[str] = None,
    tags: Optional[str] = None,
) -> str:
    """Edit thesis fields. Only changed fields are written; the diff plus `reason`
    lands in the history. `body` REPLACES the whole markdown — fetch it with
    get_thesis first and send the full edited text. conviction is 1–5."""
    if not reason.strip():
        raise ToolError("reason is required — it is what the user reads in the timeline")
    fields = _clean({
        "title": title, "body": body, "status": status, "conviction": conviction,
        "target_price": target_price, "stop_price": stop_price,
        "time_horizon": time_horizon, "category": category, "strategy": strategy,
        "kind": kind, "sector": sector, "tags": tags,
    })
    if conviction is not None and not 1 <= conviction <= 5:
        raise ToolError("conviction must be 1–5")
    return _out(_call("PATCH", f"{THESES}/{thesis_id}", body={**fields, "note": reason}))


@mcp.tool()
def log_event(
    thesis_id: str,
    note: str,
    event_type: Literal["NOTE", "REVIEW", "EVIDENCE", "CHECKPOINT"] = "NOTE",
    payload: Optional[dict] = None,
    occurred_at: Optional[str] = None,
) -> str:
    """Append an immutable entry to the thesis timeline — e.g. a REVIEW verdict
    ("thesis intact after Q3: margin guide held") or a dated fact. Use add_note
    instead for something that stays open and gets revisited."""
    return _out(_call("POST", f"{THESES}/{thesis_id}/events", body=_clean({
        "event_type": event_type, "note": note, "payload": payload,
        "occurred_at": occurred_at,
    }))["event"])


@mcp.tool()
def add_note(
    thesis_id: str,
    kind: Literal["NOTE", "SCENARIO", "RISK", "CATALYST", "QUESTION", "EVIDENCE"],
    title: str,
    body: str = "",
    impact: Optional[Literal["bull", "bear", "mixed"]] = None,
    likelihood: Optional[int] = None,
    severity: Optional[int] = None,
    watch_date: Optional[str] = None,
    status: Literal["open", "watching"] = "open",
) -> str:
    """Add a standing note to a thesis. likelihood/severity are 1–5; watch_date is
    YYYY-MM-DD (e.g. the earnings date that resolves it). Put sources in body."""
    return _out(_call("POST", f"{THESES}/{thesis_id}/notes", body=_clean({
        "kind": kind, "title": title, "body": body, "impact": impact,
        "likelihood": likelihood, "severity": severity, "watch_date": watch_date,
        "status": status,
    }))["note"])


@mcp.tool()
def update_note(
    thesis_id: str,
    note_id: str,
    status: Optional[Literal["open", "watching", "confirmed", "dismissed"]] = None,
    title: Optional[str] = None,
    body: Optional[str] = None,
    impact: Optional[Literal["bull", "bear", "mixed"]] = None,
    likelihood: Optional[int] = None,
    severity: Optional[int] = None,
    watch_date: Optional[str] = None,
) -> str:
    """Revise a note. Setting status to confirmed/dismissed resolves it and writes
    a NOTE_RESOLVED event — say why in `body` first."""
    fields = _clean({
        "status": status, "title": title, "body": body, "impact": impact,
        "likelihood": likelihood, "severity": severity, "watch_date": watch_date,
    })
    if not fields:
        raise ToolError("nothing to update")
    return _out(_call("PATCH", f"{THESES}/{thesis_id}/notes/{note_id}", body=fields)["note"])


@mcp.tool()
def link_trade(thesis_id: str, trade_id: str, role: str = "") -> str:
    """Link a trade (id from get_trades) to a thesis, e.g. role='entry' / 'add' / 'trim'."""
    return _out(_call("POST", f"{THESES}/{thesis_id}/links",
                      body={"trade_id": trade_id, "role": role}))


# ── Portfolio context (read-only) ────────────────────────────────────────────

@mcp.tool()
def get_positions(symbol: Optional[str] = None, account_id: Optional[str] = None) -> str:
    """Open positions with live P&L (base currency THB). Filter by symbol to see
    how much of the book a thesis actually controls."""
    data = _call("GET", f"{API}/api/v2/portfolio/open-positions",
                 params={"account_id": account_id}, timeout=60)
    if symbol:
        sym = symbol.upper()
        data["positions"] = [p for p in data.get("positions", [])
                             if str(p.get("symbol", "")).upper() == sym]
    return _out(data)


@mcp.tool()
def get_trades(symbol: Optional[str] = None, account_id: Optional[str] = None,
               limit: int = 50) -> str:
    """Trade log (entries/exits), newest first."""
    return _out(_call("GET", f"{API}/api/v2/portfolio/trades",
                      params={"symbol": symbol, "account_id": account_id, "limit": limit}))


# ── Market research (read-only) ──────────────────────────────────────────────

StockData = Literal[
    "quote", "financials", "balance-sheet", "ratios", "estimates", "analyst",
    "earnings-calendar", "ownership", "management", "dividends", "pe-history",
    "quality", "sector", "sec-filings",
]


@mcp.tool()
def get_stock_data(symbol: str, kind: StockData = "quote") -> str:
    """Company data from the terminal backend: quote, financials, balance-sheet,
    ratios, estimates, analyst (targets/ratings), earnings-calendar, ownership,
    management, dividends, pe-history, quality, sector, sec-filings."""
    return _out(_call("GET", f"{API}/api/stock/{kind}/{symbol.upper()}", timeout=60))


@mcp.tool()
def get_price_history(
    symbol: str,
    period: Literal["1d", "5d", "1m", "3m", "ytd", "1y", "5y"] = "1y",
    interval: Literal["", "1h", "1d", "1wk"] = "1wk",
) -> str:
    """OHLCV history. Prefer weekly bars for long periods to keep output small."""
    return _out(_call("GET", f"{API}/api/stock/history/{symbol.upper()}",
                      params={"period": period, "interval": interval or None}, timeout=60))


@mcp.tool()
def get_news(symbols: str, per_symbol: int = 6) -> str:
    """Recent headlines for comma-separated tickers from 7 sources (Yahoo, Google,
    Bing, Seeking Alpha, Nasdaq, SEC…). Returns title, url, source, date, summary."""
    data = _call("GET", f"{API}/api/news/watchlist", timeout=90, params={
        "symbols": symbols, "per_symbol": per_symbol, "polymarket": 0,
    })
    keep = ("symbol", "title", "url", "source", "published_at", "summary")
    return _out({
        "as_of": data.get("as_of"),
        "articles": [{k: a.get(k) for k in keep if k in a} for a in data.get("articles", [])],
    })


@mcp.tool()
def get_filings(symbol: str, forms: str = "10-K,10-Q,8-K", limit: int = 10) -> str:
    """Recent SEC EDGAR filings (US issuers), newest first, with document links."""
    return _out(_call("GET", f"{API}/api/company/filings/{symbol.upper()}",
                      params={"forms": forms, "limit": limit}, timeout=60))


@mcp.tool()
def get_google_trends(
    keywords: str,
    geo: str = "",
    timeframe: Literal["now 7-d", "today 1-m", "today 3-m", "today 12-m", "today 5-y"] = "today 12-m",
) -> str:
    """Google search interest over time for up to 5 comma-separated keywords
    (geo '' = worldwide, else e.g. US, TH). Values are a 0–100 index relative to
    the peak in this window and keyword set — NOT search volume, and they shift if
    the keywords or window change. Context for demand/attention, never a
    fundamental. Google rate-limits this (429 with the explore URL = try in ~30 min).
    Cite the returned `source.url`."""
    return _out(_call("GET", f"{API}/api/trends/interest", timeout=60,
                      params={"keywords": keywords, "geo": geo, "timeframe": timeframe}))


FiscalKind = Literal[
    "profile", "income", "balance", "cashflow", "ratios", "adjusted", "segments-kpis",
    "earnings-summary", "ir-events", "fund-letters", "news-summary", "transcript",
]


@mcp.tool()
def get_fiscal_data(symbol: str, kind: FiscalKind = "segments-kpis", period: str = "annual",
                    event_key: str = "") -> str:
    """Fiscal.ai fundamentals (secondary source — cross-check vs SEC filings).
    Free trial: only 100 fixed companies and 250 calls/day, so ask for what you need.
    kind: profile · income / balance / cashflow (standardized) · ratios · adjusted ·
    segments-kpis (company-specific KPIs + segment revenue) · earnings-summary ·
    ir-events (lists earnings calls and their event keys) · transcript (needs
    event_key like 'q3-2026' from ir-events) · fund-letters · news-summary.
    period (periodic kinds): annual | quarterly | ltm | ytd | latest, comma-separated.
    Cite the returned `source`."""
    if kind == "transcript":
        if not event_key:
            raise BackendError("transcript needs event_key (e.g. q3-2026) — call kind=ir-events first")
        return _out(_call("GET", f"{API}/api/fiscal/transcript/{symbol}/{event_key}", timeout=60))
    return _out(_call("GET", f"{API}/api/fiscal/{kind}/{symbol}", params={"period": period}, timeout=60))


@mcp.tool()
def get_trending_searches(geo: str = "US") -> str:
    """Today's trending Google searches for a country (public RSS): query,
    approx traffic bucket, and the news stories behind each. Cite `source.url`."""
    return _out(_call("GET", f"{API}/api/trends/daily", params={"geo": geo}, timeout=30))


# ── Zettelkasten knowledge base ──────────────────────────────────────────────
#
# A zettel is one idea, reusable across theses — the place where research an
# agent does becomes something the user can reread, trace and re-argue later.
# Conflicting findings are recorded as a CONTRADICTS edge that stays open until
# it is settled in writing, rather than as two notes that never meet.

ZETTEL = f"{API}/api/v2/zettel"

ZKind = Literal["CLAIM", "EVIDENCE", "QUESTION", "MECHANISM", "DEFINITION", "SOURCE_NOTE"]
ZRel = Literal["SUPPORTS", "CONTRADICTS", "REFINES", "SUPERSEDES", "FOLLOWS_FROM", "CONTEXT"]


@mcp.tool()
def zettel_search(
    q: str,
    kind: Optional[ZKind] = None,
    status: Optional[Literal["open", "settled", "superseded", "retracted"]] = None,
    limit: int = 20,
) -> str:
    """Search the knowledge base (matches inside Thai text too).

    ALWAYS run this before zettel_create: if the idea is already written down,
    add a source to it or link a new note to it instead of jotting a duplicate."""
    data = _call("GET", f"{ZETTEL}/search", params={"q": q, "limit": limit})
    rows = data.get("zettel", [])
    if kind:
        rows = [r for r in rows if r.get("kind") == kind]
    if status:
        rows = [r for r in rows if r.get("status") == status]
    return _out({"engine": data.get("engine"), "zettel": rows})


@mcp.tool()
def zettel_list(
    thesis_id: Optional[str] = None,
    symbol: Optional[str] = None,
    kind: Optional[ZKind] = None,
    tag: Optional[str] = None,
    limit: int = 50,
) -> str:
    """Notes attached to a thesis or ticker, newest fact first. Each row carries
    source_count and open_conflicts, so a thin or disputed claim is visible."""
    return _out(_call("GET", ZETTEL, params={
        "thesis_id": thesis_id, "symbol": symbol, "kind": kind, "tag": tag, "limit": limit,
    })["zettel"])


@mcp.tool()
def zettel_get(ref_or_id: str) -> str:
    """One note in full: body, sources, both link directions (backlinks) and what
    it is attached to. Accepts either the Z-0042 label or the uuid."""
    return _out(_call("GET", f"{ZETTEL}/{ref_or_id}"))


@mcp.tool()
def zettel_create(
    title: str,
    kind: ZKind = "CLAIM",
    body: str = "",
    stance: Optional[Literal["bull", "bear", "neutral"]] = None,
    confidence: Optional[int] = None,
    tags: str = "",
    occurred_at: Optional[str] = None,
    thesis_id: Optional[str] = None,
    symbol: Optional[str] = None,
    source_url: str = "",
    source_publisher: str = "",
    source_published_at: Optional[str] = None,
    source_quote: str = "",
    source_reliability: Literal["primary", "secondary", "rumor"] = "secondary",
) -> str:
    """Write one idea down. The title IS the idea, stated as a sentence
    ("CXMT ships DDR5 at >90% yield"), not a topic ("CXMT yield").

    kind=EVIDENCE requires a source. `occurred_at` is the date of the FACT (the
    filing, the article), not today — the archive is ordered by it. Quote the
    sentence you are relying on in source_quote so a later reader can check it
    without refetching. Returns 409 with the existing note if the idea is already
    in the base: extend that one instead."""
    src = {}
    if source_url or source_quote or source_publisher:
        src = {
            "url": source_url, "publisher": source_publisher, "quote": source_quote,
            "published_at": source_published_at, "reliability": source_reliability,
        }
    if kind == "EVIDENCE" and not src:
        raise ToolError("an EVIDENCE note needs a source — pass source_url or source_quote")
    payload = _clean({
        "title": title, "kind": kind, "body": body, "stance": stance,
        "confidence": confidence, "tags": tags, "occurred_at": occurred_at,
        "thesis_id": thesis_id, "symbol": symbol.upper() if symbol else None,
        "sources": [src] if src else [],
    })
    return _out(_call("POST", ZETTEL, body=payload))


@mcp.tool()
def zettel_update(
    ref_or_id: str,
    reason: str,
    title: Optional[str] = None,
    body: Optional[str] = None,
    stance: Optional[Literal["bull", "bear", "neutral"]] = None,
    confidence: Optional[int] = None,
    status: Optional[Literal["open", "settled", "superseded", "retracted"]] = None,
    tags: Optional[str] = None,
) -> str:
    """Revise a note. Prefer a NEW note linked with REFINES or CONTRADICTS when
    the view actually changed — rewriting history is what this archive exists to
    prevent. Use this for wording, tags, or marking a question settled."""
    if not reason.strip():
        raise ToolError("reason is required — it is what the user reads in the timeline")
    fields = _clean({
        "title": title, "body": body, "stance": stance, "confidence": confidence,
        "status": status, "tags": tags,
    })
    if not fields:
        raise ToolError("nothing to update")
    return _out(_call("PATCH", f"{ZETTEL}/{ref_or_id}", body={**fields, "reason": reason}))


@mcp.tool()
def zettel_link(src: str, dst: str, rel: ZRel, note: str = "") -> str:
    """Connect two notes. Direction matters: src → dst.

    SUPPORTS/CONTRADICTS: src is the newer evidence, dst the claim it bears on.
    REFINES: src sharpens dst. SUPERSEDES: src replaces dst (dst becomes
    `superseded` but stays readable). FOLLOWS_FROM: src is implied by dst.
    Say WHY in `note` — an unexplained line is unreadable a month later."""
    return _out(_call("POST", f"{ZETTEL}/edges",
                      body={"src_id": src, "dst_id": dst, "rel": rel, "note": note}))


@mcp.tool()
def zettel_add_source(
    ref_or_id: str,
    url: str = "",
    publisher: str = "",
    title: str = "",
    published_at: Optional[str] = None,
    quote: str = "",
    reliability: Literal["primary", "secondary", "rumor"] = "secondary",
) -> str:
    """Add a citation to an existing note — the right move when new reporting
    confirms something already written down."""
    return _out(_call("POST", f"{ZETTEL}/{ref_or_id}/sources", body=_clean({
        "url": url, "publisher": publisher, "title": title, "published_at": published_at,
        "quote": quote, "reliability": reliability,
    })))


@mcp.tool()
def zettel_attach(ref_or_id: str, thesis_id: str, role: str = "") -> str:
    """Attach an existing note to another thesis — how one finding comes to serve
    several theses instead of being retyped under each."""
    return _out(_call("POST", f"{ZETTEL}/{ref_or_id}/refs",
                      body={"target_type": "thesis", "target_id": thesis_id, "role": role}))


@mcp.tool()
def open_conflicts(thesis_id: Optional[str] = None, limit: int = 50) -> str:
    """Contradictions still unsettled, both sides in full. This is the queue to
    work through when the user asks what is unresolved."""
    return _out(_call("GET", f"{ZETTEL}/conflicts",
                      params={"thesis_id": thesis_id, "limit": limit}))


@mcp.tool()
def resolve_conflict(edge_id: str, resolution: str, superseded_id: Optional[str] = None) -> str:
    """Close a contradiction by recording how it was settled, optionally marking
    one side superseded. Only do this when the user has agreed with the reading —
    an unresolved conflict is more honest than a wrong resolution."""
    if not resolution.strip():
        raise ToolError("resolution is required — what settled it, and on what evidence")
    return _out(_call("PATCH", f"{ZETTEL}/edges/{edge_id}",
                      body=_clean({"resolution": resolution, "superseded_id": superseded_id})))


@mcp.tool()
def zettel_by_source(url: str) -> str:
    """Every claim resting on one story — run this when a source turns out to be
    wrong, retracted or paywalled-over, to see what else has to move."""
    return _out(_call("GET", f"{ZETTEL}/sources/by-url", params={"url": url}))


# ── Questions: what a thesis does not know yet ──────────────────────────────
#
# A zettel records something found. A question records something NOT known, and
# stays on the user's badge until it is answered with evidence. The server, not
# this file, decides whether an answer is good enough — these tools pass the
# refusal back verbatim so the agent can see exactly what is missing.

QUESTIONS = f"{API}/api/v2/questions"

QLevel = Literal["CONFIRMED", "INFERRED", "UNCLEAR", "UNANSWERABLE"]
QBasis = Literal["NUMBER", "CIRCUMSTANTIAL", "EVENT"]


@mcp.tool()
def question_queue(thesis_id: Optional[str] = None, limit: int = 20) -> str:
    """Questions waiting for research, most load-bearing first (`blocks` = how many
    questions above it are waiting on this one). Includes unanswered questions,
    ones whose assumption broke, and watched ones whose check date has come.
    Each row carries its parents with if_a / if_b — why the answer matters.
    `counts` = the user's two badge numbers (pending, watch)."""
    return _out(_call("GET", f"{QUESTIONS}/queue", params={"thesis_id": thesis_id, "limit": limit}))


@mcp.tool()
def question_list(
    thesis_id: Optional[str] = None,
    symbol: Optional[str] = None,
    status: Optional[Literal["OPEN", "WATCH", "CLEAR", "DROPPED"]] = None,
) -> str:
    """Every tracked question for a thesis or ticker with its derived status.
    Run this before question_add — asking the same thing twice is refused."""
    return _out(_call("GET", QUESTIONS,
                      params={"thesis_id": thesis_id, "symbol": symbol, "status": status}))


@mcp.tool()
def question_tree(thesis_id: str) -> str:
    """One thesis's questions as a tree (nodes + child→parent edges) with the
    roll-up: how many leaf questions are answered clearly."""
    return _out(_call("GET", f"{QUESTIONS}/tree", params={"thesis_id": thesis_id}))


@mcp.tool()
def question_get(ref_or_id: str) -> str:
    """One question in full: the thought behind it, its parents (if_a / if_b),
    children, and every answer so far with signals, assumptions, their checks and
    the user's review — including WHY an earlier answer was rejected. Read this
    before researching. Accepts the Q-0007 label or the uuid."""
    return _out(_call("GET", f"{QUESTIONS}/{ref_or_id}"))


@mcp.tool()
def question_add(
    title: str,
    thought: str = "",
    parent: str = "",
    if_a: str = "",
    if_b: str = "",
    thesis_id: Optional[str] = None,
    is_root: bool = False,
    priority: Optional[int] = None,
    next_check: Optional[str] = None,
) -> str:
    """Track a new question. Only `title` (the question) and where it belongs
    (`thesis_id` or a `parent`) are required — capture it now, place it later.

    Do fill in what you know, because it is what makes the question useful:
    `thought` (what was noticed that raised it), a `parent` (Q-ref or id), and how
    that parent moves under each outcome — `if_a` (answered one way), `if_b` (the
    other). Whatever is left out comes back as `gaps` on the question and can be
    added later (question_add_parent, question_set_effect). The one refusal: if_a
    equal to if_b says the answer changes nothing. A root (is_root=True,
    thesis_id set, no parent) is the thesis's decision question; one per thesis.
    next_check is YYYY-MM-DD, e.g. the earnings date that could answer it."""
    parents = [{"parent": parent, "if_a": if_a, "if_b": if_b}] if parent else []
    return _out(_call("POST", QUESTIONS, body=_clean({
        "title": title, "thought": thought, "thesis_id": thesis_id, "is_root": is_root,
        "parents": parents, "priority": priority, "next_check": next_check,
    })))


@mcp.tool()
def question_import(questions: list[dict], thesis_id: Optional[str] = None) -> str:
    """Add a whole tree of questions in one transaction — use this instead of many
    question_add calls when breaking a thesis down.

    Each item: {key, title, thought?, is_root?, parents?: [{parent, if_a?, if_b?}],
    next_check?, priority?, answer?}. `key` is a local handle; a parent may name
    the key of an item EARLIER in the list, or the Q-ref / id of an existing
    question. `answer` takes the same fields as question_answer (level, answer,
    basis, value, as_of, evidence as a LIST of Z-refs, alternatives, signals,
    assumptions, searched, next_check). Every rule of question_add and
    question_answer applies; the first item that breaks one is reported by key and
    NOTHING is written, so fix it and send the whole list again."""
    return _out(_call("POST", f"{QUESTIONS}/import",
                      body=_clean({"thesis_id": thesis_id, "questions": questions})))


@mcp.tool()
def question_add_parent(ref_or_id: str, parent: str, if_a: str = "", if_b: str = "") -> str:
    """Hang an existing question under a parent: the first one for a question that
    was captured unplaced, or a second one — how two lines of thought come to
    meet at one question instead of it being asked twice."""
    return _out(_call("POST", f"{QUESTIONS}/{ref_or_id}/parents",
                      body={"parent": parent, "if_a": if_a, "if_b": if_b}))


@mcp.tool()
def question_set_effect(edge_id: str, if_a: str, if_b: str) -> str:
    """Fill in how a parent moves under each answer, for a link that was created
    without it (the question shows `effect` in its gaps). edge_id comes from
    question_get → parents[].edge_id."""
    return _out(_call("PATCH", f"{QUESTIONS}/edges/{edge_id}", body={"if_a": if_a, "if_b": if_b}))


@mcp.tool()
def question_claim(ref_or_id: str) -> str:
    """Mark a question as being researched by you so another agent skips it.
    Expires after 2 hours; submitting an answer releases it."""
    return _out(_call("POST", f"{QUESTIONS}/{ref_or_id}/claim"))


@mcp.tool()
def question_release(ref_or_id: str) -> str:
    """Give a claimed question back to the queue without answering it."""
    return _out(_call("POST", f"{QUESTIONS}/{ref_or_id}/release"))


@mcp.tool()
def question_answer(
    ref_or_id: str,
    level: QLevel,
    answer: str,
    basis: Optional[QBasis] = None,
    value: Optional[str] = None,
    unit: Optional[str] = None,
    as_of: Optional[str] = None,
    evidence: str = "",
    alternatives: Optional[list[str]] = None,
    signals: Optional[list[dict]] = None,
    assumptions: Optional[list[dict]] = None,
    searched: str = "",
    next_check: Optional[str] = None,
) -> str:
    """Propose an answer. The server checks its shape and REFUSES (422, with every
    missing piece listed) an answer that lacks evidence — fix what it lists or
    answer at a lower level; never fill a field with something you did not find.

    evidence: comma-separated Z-refs; each zettel needs a source with url + quote.
    signals: [{expectation, result FOUND|NOT_FOUND|CONTRARY|NOT_SEARCHED, finding,
      zettel, origin, diagnostic, supports, searched_where}] — what you expected to
      see under each explanation and what you found. NOT_FOUND needs searched_where.
    assumptions: [{statement, metric, source_hint, check_by YYYY-MM-DD, falsifier}].

    CONFIRMED needs basis: NUMBER (value, as_of, a PRIMARY-source zettel) · EVENT
    (as_of, evidence) · CIRCUMSTANTIAL (alternatives ≥2, two FOUND signals that are
    diagnostic and from different origins, none CONTRARY).
    INFERRED needs evidence or a FOUND signal, plus ≥1 complete assumption.
    UNCLEAR / UNANSWERABLE need `searched` (where you looked) and next_check.

    The result is a proposal: the question stays on the user's pending count until
    they accept it. Call get_question_spec first if you have not this session."""
    return _out(_call("POST", f"{QUESTIONS}/{ref_or_id}/answers", body=_clean({
        "level": level, "basis": basis, "answer": answer, "value": value, "unit": unit,
        "as_of": as_of,
        "evidence": [e.strip() for e in evidence.split(",") if e.strip()],
        "alternatives": alternatives or [], "signals": signals or [],
        "assumptions": assumptions or [], "searched": searched, "next_check": next_check,
    })))


@mcp.tool()
def assumption_check(
    assumption_id: str,
    result: Literal["HELD", "BROKEN"],
    note: str,
    zettel: str,
) -> str:
    """Record that an assumption was tested: what the metric came out as (`note`)
    and the evidence zettel it was read from. BROKEN sends the question back to
    pending; HELD on every assumption of an accepted inference clears it.
    assumption_id comes from question_get → answers[].assumptions[].id."""
    return _out(_call("POST", f"{QUESTIONS}/assumptions/{assumption_id}/check",
                      body={"result": result, "note": note, "zettel": zettel}))


@mcp.tool()
def question_calendar(thesis_id: Optional[str] = None, symbol: Optional[str] = None,
                      include_past: bool = True) -> str:
    """The dates questions are waiting on, soonest first: what happens, when, whether
    the date is CONFIRMED or only ESTIMATED, where the date came from, and which
    questions it could answer (with what to read for each). `due` = the date has
    arrived and a linked question has not been looked at since."""
    return _out(_call("GET", f"{QUESTIONS}/calendar", params={
        "thesis_id": thesis_id, "symbol": symbol, "include_past": include_past}))


@mcp.tool()
def question_date_add(
    title: str,
    date: str,
    source: str,
    status: Literal["CONFIRMED", "ESTIMATED"] = "ESTIMATED",
    source_url: str = "",
    kind: Literal["EARNINGS", "FILING", "DATA_RELEASE", "EVENT", "OTHER"] = "OTHER",
    symbol: Optional[str] = None,
    note: str = "",
    questions: Optional[list[dict]] = None,
) -> str:
    """Put a dated event on the question calendar. `title` is what happens ("Intel
    Q3/26 10-Q"), `date` YYYY-MM-DD.

    A date is a claim like any other: `source` says where it came from (a calendar
    tool, an IR announcement, or "estimated from <pattern>"). Use CONFIRMED only
    when the publisher itself announced the date, and pass that announcement as
    source_url; anything inferred from past schedules is ESTIMATED. Check
    question_calendar first — one event serves every question that waits on it.
    questions: [{question: Q-ref, reads: what will be read from it}]."""
    return _out(_call("POST", f"{QUESTIONS}/calendar", body=_clean({
        "title": title, "date": date, "status": status, "source": source,
        "source_url": source_url, "kind": kind, "symbol": symbol, "note": note,
        "questions": questions or [],
    })))


@mcp.tool()
def question_date_update(
    ref_or_id: str,
    reason: str,
    date: Optional[str] = None,
    status: Optional[Literal["CONFIRMED", "ESTIMATED"]] = None,
    source: Optional[str] = None,
    source_url: Optional[str] = None,
    title: Optional[str] = None,
    note: Optional[str] = None,
) -> str:
    """Move a calendar date or confirm an estimated one (D-ref or id). `reason` is
    required when the date or status changes; the previous value stays in the
    revision trail. Confirming needs source_url — the announcement."""
    return _out(_call("PATCH", f"{QUESTIONS}/calendar/{ref_or_id}", body=_clean({
        "date": date, "status": status, "source": source, "source_url": source_url,
        "title": title, "note": note, "reason": reason,
    })))


@mcp.tool()
def question_date_link(date_ref_or_id: str, question: str, reads: str = "") -> str:
    """Tie a question to a calendar date: this event could answer it. `reads` = the
    number or statement to look for when the date arrives."""
    return _out(_call("POST", f"{QUESTIONS}/calendar/{date_ref_or_id}/questions",
                      body={"question": question, "reads": reads}))


@mcp.tool()
def get_question_spec() -> str:
    """How to answer an open question: the research order (competing explanations →
    expected signals → search → zettels → answer), what each answer level needs,
    and how signals are judged. Call this BEFORE the first question_answer."""
    return _read_ref(QUESTION_SPEC_FILE, "question-research spec")


@mcp.resource("spec://question-research", name="question-research-spec",
              description="Question research protocol: signals, answer levels, assumptions",
              mime_type="text/markdown")
def question_spec_resource() -> str:
    return _read_ref(QUESTION_SPEC_FILE, "question-research spec")


# ── Tracking: the numbers a thesis stands or falls on ────────────────────────
#
# A question is something not known. A tracked metric is something that WILL be
# known on a date. It keeps where the number is read, what was expected and why,
# and what it came out as — and the server, not this file, decides the verdict
# and opens the "why" question when a number misses.

TRACKING = f"{API}/api/v2/tracking"

TrackStatus = Literal["KILL", "DUE", "OFF", "SETUP", "WAITING", "RETIRED"]
TrackCadence = Literal["QUARTERLY", "MONTHLY", "WEEKLY", "DAILY", "EVENT"]
KillOp = Literal["<", "<=", ">", ">="]


@mcp.tool()
def track_due(days: int = 14, thesis_id: Optional[str] = None) -> str:
    """What to read now and soon: tracked numbers whose date has come (DUE), misses
    still waiting for an explanation (OFF), crossed kill lines (KILL), and forecasts
    due within `days`. Each row carries where the number is read — source_name,
    source_url, source_locator, source_tool — so go straight there; do not search
    again. `state.next` = the forecast being waited on (period, expected, low/high,
    date). `counts.alert` = the user's red badge."""
    return _out(_call("GET", f"{TRACKING}/due", params={"days": days, "thesis_id": thesis_id}))


@mcp.tool()
def track_list(
    thesis_id: Optional[str] = None,
    symbol: Optional[str] = None,
    status: Optional[TrackStatus] = None,
) -> str:
    """Every tracked metric for a thesis or ticker with its derived state and
    `gaps` (source / kill_rule / expectation still missing), most urgent first.
    Run this before track_add — tracking the same number twice is refused."""
    return _out(_call("GET", TRACKING,
                      params={"thesis_id": thesis_id, "symbol": symbol, "status": status}))


@mcp.tool()
def track_get(ref_or_id: str) -> str:
    """One tracked metric in full: its source, kill rule, and every period with the
    forecast (and its revisions), the number that came out (and corrections), the
    verdict, and the question a miss opened. Accepts the K-0007 label or the uuid."""
    return _out(_call("GET", f"{TRACKING}/{ref_or_id}"))


@mcp.tool()
def track_add(
    thesis_id: str,
    title: str,
    role: Literal["KILLER", "WATCH"] = "WATCH",
    unit: str = "",
    definition: str = "",
    why: str = "",
    kill_rule: str = "",
    kill_op: Optional[KillOp] = None,
    kill_value: Optional[float] = None,
    source_name: str = "",
    source_url: str = "",
    source_locator: str = "",
    source_tool: str = "",
    series_id: Optional[str] = None,
    question: Optional[str] = None,
    cadence: TrackCadence = "QUARTERLY",
    expectation: Optional[dict] = None,
) -> str:
    """Track a number a thesis depends on. Only `title` and `thesis_id` are
    required; whatever else is missing comes back as `gaps` and keeps it in SETUP.

    The point of the row is that the number can be fetched without searching when
    its date comes — so fill the source: source_name (who publishes it / which
    document), source_url (a link that opens), source_locator (where inside:
    statement and line, table, XBRL tag), source_tool (the call that fetches it,
    e.g. "get_stock_data(MU, kind=balance-sheet)"). `definition` is the formula,
    applied the same way every period. series_id binds an indicator series the
    terminal already records (GET /api/v2/series).

    role KILLER = crossing the line breaks the thesis. kill_rule states the whole
    condition in words; kill_op + kill_value are its numeric part (checked on
    every reading). `question` = Q-ref this number helps answer; a miss hangs its
    "why" there. `expectation` = the first forecast, same fields as track_expect,
    written in the same transaction."""
    return _out(_call("POST", TRACKING, body=_clean({
        "thesis_id": thesis_id, "title": title, "role": role, "unit": unit,
        "definition": definition, "why": why, "kill_rule": kill_rule, "kill_op": kill_op,
        "kill_value": kill_value, "source_name": source_name, "source_url": source_url,
        "source_locator": source_locator, "source_tool": source_tool, "series_id": series_id,
        "question": question, "cadence": cadence, "expectation": expectation,
    })))


@mcp.tool()
def track_update(
    ref_or_id: str,
    title: Optional[str] = None,
    unit: Optional[str] = None,
    definition: Optional[str] = None,
    why: Optional[str] = None,
    kill_rule: Optional[str] = None,
    kill_op: Optional[KillOp] = None,
    kill_value: Optional[float] = None,
    source_name: Optional[str] = None,
    source_url: Optional[str] = None,
    source_locator: Optional[str] = None,
    source_tool: Optional[str] = None,
    series_id: Optional[str] = None,
    question: Optional[str] = None,
    cadence: Optional[TrackCadence] = None,
) -> str:
    """Fill in or correct a tracked metric — usually its source, once you know
    exactly where the number sits. A kill rule can be filled in while it is empty;
    one that is already set, and the role, are the user's to change (403 here):
    propose the change in chat with the reason."""
    return _out(_call("PATCH", f"{TRACKING}/{ref_or_id}", body=_clean({
        "title": title, "unit": unit, "definition": definition, "why": why,
        "kill_rule": kill_rule, "kill_op": kill_op, "kill_value": kill_value,
        "source_name": source_name, "source_url": source_url, "source_locator": source_locator,
        "source_tool": source_tool, "series_id": series_id, "question": question,
        "cadence": cadence,
    })))


@mcp.tool()
def track_expect(
    ref_or_id: str,
    period: str,
    expected: str,
    basis: str,
    low: Optional[float] = None,
    high: Optional[float] = None,
    date: Optional[str] = None,
    new_date: Optional[dict] = None,
    due_date: Optional[str] = None,
    release_time: str = "",
    evidence: str = "",
) -> str:
    """Set the forecast for one period: what is expected (`expected`, in words),
    WHY (`basis` — guidance, a model, a trend; cite Z-refs in `evidence`,
    comma-separated), and the band that counts as in line (`low` / `high`; either
    side may be left open; none = a forecast in words only).

    The date the number comes out is one of: `date` (a D-ref already on the
    question calendar — check question_calendar first, one event serves every
    metric read from it), `new_date` ({title, date, status CONFIRMED|ESTIMATED,
    source, source_url, kind EARNINGS|FILING|DATA_RELEASE|EVENT|OTHER} — puts the
    event on the calendar; CONFIRMED needs the announcement as source_url), or
    `due_date` (YYYY-MM-DD, a day to look when no event stands behind it).

    Calling it again for the same period revises the forecast and keeps the old
    one. Refused (409) once the period has its number — a forecast is not written
    after the result. This is the user's forecast: propose the numbers in chat
    unless you were asked to set them."""
    return _out(_call("POST", f"{TRACKING}/{ref_or_id}/expectations", body=_clean({
        "period": period, "expected": expected, "basis": basis, "low": low, "high": high,
        "date": date, "new_date": new_date, "due_date": due_date, "release_time": release_time,
        "evidence": [e.strip() for e in evidence.split(",") if e.strip()],
    })))


@mcp.tool()
def track_record(
    ref_or_id: str,
    as_of: str,
    value: Optional[float] = None,
    value_text: str = "",
    zettel: Optional[str] = None,
    source_url: str = "",
    quote: str = "",
    verdict: Optional[Literal["IN_LINE", "OFF"]] = None,
    kill: Optional[bool] = None,
    period: str = "",
    note: str = "",
) -> str:
    """Record what a tracked number came out as. Read it from the source the
    metric names and compute it by the metric's `definition`.

    Evidence is required: `zettel` (a Z-ref carrying url + quote — preferred, the
    fact then lives in the knowledge base) or source_url + quote. `as_of` = the
    date the number refers to or was published.

    When the forecast has a band and `value` is a number, the server decides the
    verdict (IN_LINE / ABOVE / BELOW) and whether the kill line was crossed; pass
    `verdict` only for a forecast in words (IN_LINE or OFF) and `kill` only for a
    kill rule in words. With no `period`, the reading answers the open forecast
    that is due first; name the period to correct a number already recorded or to
    record one that had no forecast (UNSCORED).

    A miss or a crossed kill line comes back with `opened_question` — a question
    now in question_queue asking why. Answer it by get_question_spec. Refused
    (422) → fix every item in `missing`; never fill a field with something you did
    not read."""
    return _out(_call("POST", f"{TRACKING}/{ref_or_id}/readings", body=_clean({
        "as_of": as_of, "value": value, "value_text": value_text, "zettel": zettel,
        "source_url": source_url, "quote": quote, "verdict": verdict, "kill": kill,
        "period": period, "note": note,
    })))


@mcp.tool()
def get_tracking_spec() -> str:
    """How tracked numbers work: what a metric row holds (source, kill rule), how a
    forecast and its date are set, what to do when a date comes due, and what only
    the user may change. Call this BEFORE the first track_* write."""
    return _read_ref(TRACKING_SPEC_FILE, "thesis-tracking spec")


@mcp.resource("spec://thesis-tracking", name="thesis-tracking-spec",
              description="Tracked metrics: source, forecast vs actual, kill lines",
              mime_type="text/markdown")
def tracking_spec_resource() -> str:
    return _read_ref(TRACKING_SPEC_FILE, "thesis-tracking spec")


# ── Anti-thesis: arguing against what a thesis believes ──────────────────────
#
# A question is something not known; a tracked number will be known on a date. A
# claim is something the thesis already believes — written beside its negation
# and attacked on purpose. The server derives whether it stands; this file only
# carries the argument in.

ANTITHESIS = f"{API}/api/v2/antithesis"

AntiAngle = Literal["FACT", "CAUSE", "LOGIC", "TIME", "PRICE", "OTHER"]


@mcp.tool()
def anti_board(thesis_id: str, include_closed: bool = False) -> str:
    """The step-back board of one thesis: every claim it rests on with its negation,
    stake (KEY = the thesis falls with it), the objections raised and what became of
    each, and `state` — status (UNTESTED / CONTESTED / STANDS / BROKEN / FALLEN),
    `angles` (per angle: untried / open / rebutted / conceded / none_found), `gaps`.
    `summary.verdict` reads the whole thesis: OPEN, KEY_FALLEN, STANDING, SETTLED.
    Run this before anti_claim_add / anti_object — writing one twice is refused."""
    return _out(_call("GET", ANTITHESIS,
                      params={"thesis_id": thesis_id, "include_closed": include_closed}))


@mcp.tool()
def anti_queue(thesis_id: Optional[str] = None, limit: int = 20) -> str:
    """What a step back still owes. `objections` = raised and not answered (or
    UNDECIDED with its look-again date come) — each with would_see / look_where, so
    go and look. `claims` = beliefs with gaps: no negation, angles never tried
    (`untried`), objections with no would_see. Key claims first. `angles` explains
    what each angle argues."""
    return _out(_call("GET", f"{ANTITHESIS}/queue",
                      params={"thesis_id": thesis_id, "limit": limit}))


@mcp.tool()
def anti_claim_add(
    thesis_id: str,
    statement: str,
    negation: str = "",
    stake: Literal["KEY", "SUPPORT"] = "SUPPORT",
    basis: str = "",
) -> str:
    """Put one belief the thesis rests on onto the board. `statement` = the belief as
    one sentence that could turn out false (not a topic, not a hope). `negation` =
    what the world looks like if it IS false — concrete enough to go looking for.
    stake KEY = the thesis falls if this does. `basis` = why it is believed (cite
    Z-refs in the text). It starts UNTESTED. For a whole thesis use anti_import."""
    return _out(_call("POST", ANTITHESIS, body={
        "thesis_id": thesis_id, "statement": statement, "negation": negation,
        "stake": stake, "basis": basis}))


@mcp.tool()
def anti_claim_update(
    ref_or_id: str,
    negation: Optional[str] = None,
    basis: Optional[str] = None,
    statement: Optional[str] = None,
) -> str:
    """Fill in a claim's negation or basis. `statement` can be corrected only on a
    claim an agent wrote and nobody has argued over yet; after that the wording
    changes through anti_verdict CONCEDED + consequence=REVISE (409 / 403 here).
    The stake is the user's to change."""
    return _out(_call("PATCH", f"{ANTITHESIS}/{ref_or_id}", body=_clean({
        "negation": negation, "basis": basis, "statement": statement})))


@mcp.tool()
def anti_object(
    claim: str,
    argument: str,
    angle: AntiAngle = "OTHER",
    would_see: str = "",
    look_where: str = "",
    parent: Optional[str] = None,
) -> str:
    """Raise an objection against a claim (C-ref or id). `argument` = the reason the
    claim could be false, as one sentence. `angle` = the way it would be wrong:
    FACT (data false / stale / measures something else) · CAUSE (another cause
    explains what we see) · LOGIC (conclusion does not follow) · TIME (true but not
    long / wide / soon enough) · PRICE (true and already paid for).
    `would_see` = what we would observe if the objection were right — the thing to
    go and look for; `look_where` = the document, table or tool. `parent` = A-ref
    of an objection this continues (e.g. the evidence used to rebut it is flawed).
    Raising one needs no evidence. Do not hold back an objection because you think
    you can answer it — raise it, then answer it with anti_verdict."""
    return _out(_call("POST", f"{ANTITHESIS}/{claim}/objections", body=_clean({
        "argument": argument, "angle": angle, "would_see": would_see,
        "look_where": look_where, "parent": parent})))


@mcp.tool()
def anti_none_found(
    claim: str,
    angle: Literal["FACT", "CAUSE", "LOGIC", "TIME", "PRICE"],
    searched: str,
) -> str:
    """Record that one angle was searched for an objection and none was found.
    `searched` = where you looked and what for — required: an angle nobody searched
    is untried, not clean. Refused (409) when the angle already has an objection.
    Only after really looking: this is what lets a claim be called settled."""
    return _out(_call("POST", f"{ANTITHESIS}/{claim}/sweeps",
                      body={"angle": angle, "searched": searched}))


@mcp.tool()
def anti_verdict(
    objection: str,
    result: Literal["REBUTTED", "CONCEDED", "UNDECIDED"],
    reasoning: str,
    evidence: str = "",
    consequence: Optional[Literal["REVISE", "FALLS"]] = None,
    revised_statement: str = "",
    revised_negation: str = "",
    searched: str = "",
    next_check: Optional[str] = None,
) -> str:
    """Say what became of an objection (A-ref or id), after looking for what its
    `would_see` names.

    REBUTTED  — it does not hold. `evidence` (Z-refs, comma-separated) is required:
                zettel carrying a url and the quoted sentence, none in an open
                conflict. zettel_create the finding first.
    CONCEDED  — it holds. consequence=REVISE with `revised_statement` (the claim as
                it has to read now; + `revised_negation`) or consequence=FALLS (the
                claim is given up).
    UNDECIDED — searched and cannot tell: `searched` + `next_check` (YYYY-MM-DD).

    Your verdict is a proposal; the user accepts or rejects it. Refused (422) → fix
    every item in `missing` or go down to UNDECIDED — never rebut with a zettel you
    did not read. Conceding is as good a result as rebutting."""
    return _out(_call("POST", f"{ANTITHESIS}/objections/{objection}/verdicts", body=_clean({
        "result": result, "reasoning": reasoning,
        "evidence": [e.strip() for e in evidence.split(",") if e.strip()],
        "consequence": consequence, "revised_statement": revised_statement,
        "revised_negation": revised_negation, "searched": searched, "next_check": next_check,
    })))


@mcp.tool()
def anti_to_question(objection: str) -> str:
    """Send an objection that cannot be settled yet to the open questions (it gets
    a Q-ref and enters question_queue, answered by get_question_spec). The
    objection stays open on the board until a verdict is given on it."""
    return _out(_call("POST", f"{ANTITHESIS}/objections/{objection}/question"))


@mcp.tool()
def anti_import(thesis_id: str, claims: list[dict]) -> str:
    """A whole step back in one transaction. Each claim: {statement, negation,
    stake KEY|SUPPORT, basis, objections: [{argument, angle, would_see, look_where}],
    none_found: [{angle, searched}]}. One refused item and nothing is written — the
    error names the item and what is missing. anti_board first: a belief already on
    the board is refused as a duplicate."""
    return _out(_call("POST", f"{ANTITHESIS}/import",
                      body={"thesis_id": thesis_id, "claims": claims}))


@mcp.tool()
def get_antithesis_spec() -> str:
    """How a step back works: breaking a thesis into claims, writing the negation,
    the five angles of attack, what an objection and each verdict need, when a
    claim is settled, and what only the user may do. Call this BEFORE the first
    anti_* write."""
    return _read_ref(ANTITHESIS_SPEC_FILE, "anti-thesis spec")


@mcp.resource("spec://anti-thesis", name="anti-thesis-spec",
              description="Step back: claims, negations, objections by angle, evidence-gated verdicts",
              mime_type="text/markdown")
def antithesis_spec_resource() -> str:
    return _read_ref(ANTITHESIS_SPEC_FILE, "anti-thesis spec")


# ── Graphs: rendered analysis pages ──────────────────────────────────────────
#
# A zettel holds one claim in prose. Some findings are only legible as a picture:
# a money-flow map, a cycle ladder, a side-by-side of five companies' cash flow.
# Those go here — one self-contained HTML page per analysis, stored in
# research/graphs/<slug>/ and listed in PORT → TOOLS → THESES → RESEARCH.
#
# Write the page the way you would write any standalone document: inline <style>,
# inline SVG for the diagram, no external scripts or fonts (the render CSP blocks
# every off-box request, so a CDN link silently does nothing). Cite the numbers
# you drew from, and attach the graph to the thesis it argues.

GRAPHS = f"{API}/api/v2/graphs"


@mcp.tool()
def graph_list(symbol: Optional[str] = None, thesis_id: Optional[str] = None,
               q: Optional[str] = None, limit: int = 100) -> str:
    """Analysis pages already in the book (metadata only, never the HTML).
    Run this before graph_create — updating an existing page beats a near-duplicate."""
    return _out(_call("GET", GRAPHS, params={
        "symbol": symbol, "thesis_id": thesis_id, "q": q, "limit": limit,
    })["graphs"])


@mcp.tool()
def graph_get(slug: str, include_html: bool = False) -> str:
    """One page's metadata, and with include_html=True its source — which is how
    you edit an existing page instead of replacing it blind."""
    return _out(_call("GET", f"{GRAPHS}/{slug}", params={"include_html": include_html}))


@mcp.tool()
def graph_create(
    title: str,
    html: str,
    slug: Optional[str] = None,
    description: str = "",
    symbol: Optional[str] = None,
    thesis_id: Optional[str] = None,
    zettel_refs: str = "",
    tags: str = "",
    as_of: Optional[str] = None,
    sources: Optional[list] = None,
) -> str:
    """Save an analysis page. `html` is the CONTENT — headings, prose, tables,
    inline SVG — not a document: the render shell supplies <html>, the masthead,
    the Thai typeface and the contents rail, which is built from your <h2>/<h3>.
    Read `research/graphs/_template.html` before writing the first one.

    Two rules are enforced on save: no resource may be loaded over the network
    (the render CSP blocks every off-box request, so an external <img> or
    stylesheet is a hole in the page — inline the SVG or embed a data: URI), and
    the page needs at least one <h2> or the reader gets no way to navigate.
    Anything else that will render badly comes back in `warnings`.

    Attach it: `thesis_id` puts it on that thesis and writes a GRAPH_ADDED event,
    `zettel_refs` ("Z-0019,Z-0021") points back at the notes it draws on, `as_of`
    is the date of the DATA, not today. `sources` is a list of {title, url} and
    is printed at the foot of the page.
    Returns `render_url` — the link the user can open in a browser tab."""
    return _out(_call("POST", GRAPHS, body=_clean({
        "title": title, "html": html, "slug": slug, "description": description,
        "symbol": symbol, "thesis_id": thesis_id, "zettel_refs": zettel_refs,
        "tags": tags, "as_of": as_of, "sources": sources or [],
    })))


@mcp.tool()
def graph_update(
    slug: str,
    html: Optional[str] = None,
    title: Optional[str] = None,
    description: Optional[str] = None,
    symbol: Optional[str] = None,
    thesis_id: Optional[str] = None,
    zettel_refs: Optional[str] = None,
    tags: Optional[str] = None,
    as_of: Optional[str] = None,
    sources: Optional[list] = None,
    reason: str = "",
) -> str:
    """Revise a page in place. Passing `html` bumps the version and keeps the
    previous one beside it (openable at ?v=<n>), so a correction never erases
    what the chart used to claim. Say why in `reason` — it lands on the timeline.

    `html` follows the same contract as graph_create: content only, no network
    resources, at least one <h2>. Changing how a page LOOKS is never a reason to
    rewrite it — the shell restyles every page at render time."""
    return _out(_call("PATCH", f"{GRAPHS}/{slug}", body=_clean({
        "html": html, "title": title, "description": description, "symbol": symbol,
        "thesis_id": thesis_id, "zettel_refs": zettel_refs, "tags": tags,
        "as_of": as_of, "sources": sources, "reason": reason,
    })))


# ── Fundamental-analysis spec ────────────────────────────────────────────────

@mcp.tool()
def get_fundamental_spec() -> str:
    """The fundamental-analysis spec ("วิเคราะห์พื้นฐาน [ticker]"): which data to
    pull and from which tool, the 12-section Thai report, and the rules (sources on
    every fact, free first, facts only). Call this BEFORE any fundamental analysis."""
    return _spec_text()


@mcp.resource("spec://fundamental-analysis", name="fundamental-analysis-spec",
              description="Fundamental-analysis spec: data sources, 12 Thai sections, rules",
              mime_type="text/markdown")
def fundamental_spec_resource() -> str:
    return _spec_text()


# ── Data-source registry ─────────────────────────────────────────────────────

@mcp.tool()
def get_data_sources() -> str:
    """Where to look for data, in order: these MCP tools → backend endpoints that
    exist but have no tool yet → verified free external APIs (IMF, World Bank, BIS,
    OECD, BOT, …) with example queries and known traps → only then the web.
    Call this BEFORE searching for any data you don't already have a tool for."""
    return _read_ref(SOURCES_FILE, "data-source registry")


@mcp.resource("spec://data-sources", name="data-sources",
              description="Data-source registry: lookup order, in-house endpoints, free APIs, traps",
              mime_type="text/markdown")
def data_sources_resource() -> str:
    return _read_ref(SOURCES_FILE, "data-source registry")


# ── Prompts ──────────────────────────────────────────────────────────────────

@mcp.prompt()
def fundamental_analysis(symbol: str, thesis_id: str = "") -> str:
    """วิเคราะห์พื้นฐาน a ticker by the house spec; optionally write it into a thesis."""
    target = (f"Write the result into thesis {thesis_id}: get_thesis first, keep what is there, "
              "add/replace the '## Fundamental' section via update_thesis with a reason."
              if thesis_id else
              "Answer in chat. If I ask to save it: list_theses for the symbol first; "
              "create_thesis only if none exists.")
    return f"""วิเคราะห์พื้นฐาน {symbol.upper()} ตาม spec ด้านล่างทุกข้อ.

Before writing:
1. Pull every data item in spec §1 for {symbol.upper()}. Free sources first; label the
   period (FY/quarter) and source of every number; cross-check yfinance margins/profit
   against the 10-K/10-Q — never use a figure the company does not report.
2. zettel_search "{symbol.upper()}" — reuse what the archive already holds; new findings
   → zettel_create (kind=EVIDENCE, source url + quote + date of the fact).
3. {target}

--- SPEC (memory/reference/fundamental-analysis.md) ---
{_spec_text()}"""


@mcp.prompt()
def triage_conflicts(thesis_id: str = "") -> str:
    """Work through unresolved contradictions in the knowledge base."""
    scope = f" for thesis {thesis_id}" if thesis_id else " across the whole book"
    return f"""Triage the open conflicts{scope}.

1. open_conflicts — list what is unsettled.
2. For each: zettel_get both sides. Compare the SOURCES, not the wording —
   which is primary, which is newer, which measures the thing actually in dispute.
3. Check whether either side has been overtaken: get_news / get_filings /
   get_stock_data for the ticker, and zettel_by_source if one rests on a single story.
4. Report each conflict as: what the disagreement really is · what the evidence
   now supports · what would settle it for good.
5. Do NOT call resolve_conflict on your own. Propose the resolution text and which
   side (if any) is superseded, and wait for me. If new evidence turned up that
   neither side records, zettel_create it and link it with zettel_link first."""


@mcp.prompt()
def investigate_questions(thesis_id: str = "", limit: int = 3) -> str:
    """Work the open-question queue by the house research protocol."""
    scope = f"thesis {thesis_id}" if thesis_id else "the whole book"
    return f"""Work the open questions for {scope}, up to {limit} of them.

For each, in order:
1. question_queue — take the top one that is not claimed; question_claim it.
2. question_get — read the thought, the parents' if_a / if_b, and why any earlier
   answer was rejected.
3. Follow the spec below step by step. Write the competing explanations and the
   signal list BEFORE searching. Record what you looked for and did not find.
4. question_answer at the level the evidence supports. If it is refused, fix what
   `missing` lists or go down a level — never pad a field.
5. Tell me in chat: the question, the answer and its level, and what would move it.

Do not accept your own answer and do not drop a question — those are mine.

--- SPEC (memory/reference/question-research.md) ---
{_read_ref(QUESTION_SPEC_FILE, "question-research spec")}"""


@mcp.prompt()
def step_back(thesis_id: str) -> str:
    """Argue against one thesis: its beliefs, their negations, the objections."""
    return f"""Step back from thesis {thesis_id} with me. Your side is the opposition.

1. get_thesis — read the body. anti_board — what is already on the board.
2. Claims: list every belief the thesis needs to be true (5–12, one sentence each,
   each one able to turn out false). Mark the ones the thesis cannot survive losing
   as KEY. Write each negation as a state of the world, not as "not X".
3. For each claim, each angle (FACT, CAUSE, LOGIC, TIME, PRICE): the strongest
   objection you can make, with what we would see if it were right and where to
   look. anti_import the claims with their objections in one call.
4. Then look. For each objection: zettel_search first, then the data tools in the
   order of get_data_sources. Record findings as zettel (EVIDENCE, url + quote).
5. anti_verdict at what the evidence supports — REBUTTED only with evidence,
   CONCEDED when the objection holds (say how the claim must change), UNDECIDED
   with where you looked and when to look again. An angle that gave nothing after a
   real search → anti_none_found with where you searched.
6. Tell me in chat: which claims stand, which are contested, which should be
   rewritten or given up — key claims first — and what would change each.

Do not accept your own verdicts, withdraw an objection, or rewrite, retire or
delete a claim — those are mine. Do not touch the thesis body or its status.

--- SPEC (memory/reference/anti-thesis.md) ---
{_read_ref(ANTITHESIS_SPEC_FILE, "anti-thesis spec")}"""


@mcp.prompt()
def review_thesis(thesis_id: str) -> str:
    """Stress-test one thesis against current data and record the result."""
    return f"""Review thesis {thesis_id} with me.

1. get_thesis — read the claim, condition killers, targets and open notes.
   track_list for it — the killers and watch numbers already tracked, what came
   due, and which condition killers in the body are still only words.
2. get_positions for its symbol — how much capital rides on it.
3. Research: get_stock_data (quote, estimates, analyst, earnings-calendar),
   get_news, get_filings. Look for evidence AGAINST the thesis first.
4. zettel_list for this thesis + open_conflicts — what the archive already holds,
   and what is already in dispute. zettel_search before recording anything new.
5. For each condition killer / open item: is it triggered, closer, or further?
   - a new finding → zettel_create (title = the finding as a sentence, kind=EVIDENCE,
     stance bull/bear, source url + quote + the date of the fact, thesis_id set)
   - it clashes with an existing note → zettel_link rel=CONTRADICTS and leave it OPEN
   - it sharpens one → zettel_link rel=REFINES
   - a dated thing to wait for → add_note CATALYST/RISK with watch_date
6. log_event event_type=REVIEW with a 2–3 line verdict: intact / weakened / broken,
   naming the Z-refs the verdict rests on.
7. Do NOT change status, conviction or targets yourself, and do not resolve a
   conflict — propose those in chat, and apply them only if I agree."""


if __name__ == "__main__":
    # stdio is what Claude Code / Claude Desktop / Cursor spawn. Agents that
    # cannot spawn a process (n8n, a browser-side agent, anything on another
    # machine) get the same tools over HTTP instead:
    #   MCP_TRANSPORT=streamable-http MCP_PORT=9319 python backend/mcp_server.py
    # Binding stays on 127.0.0.1: this server writes to the portfolio and has no
    # auth of its own, so reaching it from another host is a deliberate act
    # (an SSH tunnel), never the default.
    transport = os.getenv("MCP_TRANSPORT", "stdio")
    if transport == "stdio":
        mcp.run("stdio")
    else:
        mcp.run(transport, host=os.getenv("MCP_HOST", "127.0.0.1"),
                port=int(os.getenv("MCP_PORT", "9319")))
