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

import requests
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

API = os.getenv("PYTHON_API_URL", "http://localhost:9317").rstrip("/")
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
        "Never rewrite the thesis body or change status/conviction unless asked, and "
        "always give a reason."
    ),
)


# ── HTTP helpers ─────────────────────────────────────────────────────────────

class BackendError(ToolError):
    """Surfaced to the agent verbatim — the SDK hides the text of any other exception."""


def _call(method: str, url: str, *, params: Optional[dict] = None,
          body: Optional[dict] = None, timeout: float = 30) -> Any:
    try:
        r = requests.request(
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
) -> str:
    """List investment theses (without the markdown body). Includes event_count
    and open_note_count per thesis. Use get_thesis for full detail."""
    rows = _call("GET", THESES, params={"status": status, "symbol": symbol,
                                        "category": category})["theses"]
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
) -> str:
    """Create a new thesis. Always starts as status=draft with no conviction —
    promoting it is the user's call. `body` is markdown (## Claim, ## Condition
    Killers, ## Catalysts, ## Valuation, ## Key Risks are recognised headers)."""
    payload = _clean({
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


# ── Prompts ──────────────────────────────────────────────────────────────────

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
def review_thesis(thesis_id: str) -> str:
    """Stress-test one thesis against current data and record the result."""
    return f"""Review thesis {thesis_id} with me.

1. get_thesis — read the claim, condition killers, targets and open notes.
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
