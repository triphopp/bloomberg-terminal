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
        "Record findings as notes (EVIDENCE / RISK / CATALYST / SCENARIO / QUESTION) or "
        "log_event — do not rewrite the thesis body or change status/conviction unless "
        "the user asked, and always give a reason. Cite sources (URL, filing, date) in "
        "note bodies."
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


# ── Prompts ──────────────────────────────────────────────────────────────────

@mcp.prompt()
def review_thesis(thesis_id: str) -> str:
    """Stress-test one thesis against current data and record the result."""
    return f"""Review thesis {thesis_id} with me.

1. get_thesis — read the claim, condition killers, targets and open notes.
2. get_positions for its symbol — how much capital rides on it.
3. Research: get_stock_data (quote, estimates, analyst, earnings-calendar),
   get_news, get_filings. Look for evidence AGAINST the thesis first.
4. For each condition killer / open note: is it triggered, closer, or further?
   - new evidence → add_note kind=EVIDENCE (impact bull/bear, cite URL + date)
   - new risk or catalyst → add_note RISK / CATALYST with watch_date if dated
   - a note now resolved → update_note status confirmed/dismissed with the reason
5. log_event event_type=REVIEW with a 2–3 line verdict: intact / weakened / broken.
6. Do NOT change status, conviction or targets yourself — propose the change and
   the reasoning in chat, and apply update_thesis only if I agree."""


if __name__ == "__main__":
    mcp.run("stdio")
