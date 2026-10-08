"""What ASK may read of the user's own research and of a company's accounts.

Read-only, like every ASK tool: theses, questions, tracked numbers, the
anti-thesis board and zettel are the user's writing (PORT → TOOLS → THESES /
QUESTIONS / TRACK), served by routers/theses.py, questions.py, tracking.py,
antithesis.py and zettel.py; ASK never writes to them — proposing an answer,
recording a reading, raising an objection or adding a note is the MCP's job
(`question_answer`, `track_record`, `anti_object`, `zettel_create`), with its
evidence rules.

Same rule as ask_pages: the model takes the index first and then the one part
it needs. A list carries no bodies; a thesis is read a part at a time.

Each function takes `get(path, params=None, timeout=…)` — the loopback GET that
routers/news_ai.py gives every tool.
"""
from __future__ import annotations

import re
from typing import Any, Callable

import ask_pages

Get = Callable[..., Any]

# Company data by kind → what it holds. The text is shown to the model.
COMPANY_KINDS: dict[str, str] = {
    "financials": "income statement and cash flow, annual and quarterly",
    "balance-sheet": "balance sheet, annual and quarterly",
    "ratios": "profitability, leverage, valuation, growth, per-share",
    "xbrl": "quarterly line items as filed with the SEC (US issuers): revenue, margins, capex, buybacks …",
    "estimates": "consensus EPS and revenue estimates, revisions, surprise history",
    "analyst": "price targets, recommendation counts, upgrades and downgrades",
    "earnings-calendar": "past and next earnings dates with estimate and actual EPS",
    "ownership": "insider transactions, institutional and fund holders",
    "quality": "earnings-quality screens: accruals, Beneish M, Piotroski, Altman",
    "dividends": "dividend history",
    "pe-history": "weekly P/E, EPS and close since listing",
    "management": "company profile and officers",
}

THESIS_PARTS = ("body", "notes", "events")

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_THESIS_KEEP = (
    "id", "symbol", "title", "status", "conviction", "kind_eff", "sector_eff", "strategy",
    "time_horizon", "target_price", "stop_price", "currency", "updated_at",
    "open_note_count", "zettel_count", "conflict_count",
)
_QUESTION_KEEP = (
    "id", "ref", "symbol", "title", "thought", "is_root", "priority", "next_check", "state", "gaps",
)


def _cut(value: Any, chars: int) -> Any:
    return value[:chars] + "…" if isinstance(value, str) and len(value) > chars else value


def _pick(row: dict, keys: tuple[str, ...], chars: int = 300) -> dict:
    return {k: _cut(row[k], chars) for k in keys if row.get(k) not in (None, "", [], {})}


def company_data(get: Get, symbol: str, kind: str, points: int, max_chars: int) -> Any:
    kind = kind.strip().lower()
    if kind not in COMPANY_KINDS:
        raise RuntimeError(f"no kind '{kind}' — one of {', '.join(COMPANY_KINDS)}")
    if not symbol:
        raise RuntimeError("symbol is required")
    path = f"/api/company/xbrl/{symbol}" if kind == "xbrl" else f"/api/stock/{kind}/{symbol}"
    return ask_pages.fit(get(path, timeout=90), points, max_chars)


def list_theses(get: Get) -> dict:
    """Every thesis without its body: enough to pick one."""
    rows = get("/api/v2/theses").get("theses", [])
    return {"theses": [_pick(t, _THESIS_KEEP) for t in rows if not t.get("deleted_at")]}


def _thesis_id(get: Get, thesis: str) -> str:
    """A thesis id from an id or a ticker. Raises with the choices when a ticker has several."""
    thesis = thesis.strip()
    if _UUID_RE.match(thesis):
        return thesis
    want = thesis.upper()
    rows = [
        t for t in get("/api/v2/theses").get("theses", [])
        if not t.get("deleted_at") and want in {str(t.get("symbol") or "").upper(), str(t.get("resolved_symbol") or "").upper()}
    ]
    if not rows:
        raise RuntimeError(f"no thesis for '{thesis}' — call list_theses for what exists")
    if len(rows) > 1:
        choices = "; ".join(f"{t['id']} = {_cut(t.get('title') or '', 80)}" for t in rows)
        raise RuntimeError(f"{len(rows)} theses for {want} — pass one id: {choices}")
    return rows[0]["id"]


def get_thesis(get: Get, thesis: str, part: str, points: int, max_chars: int) -> Any:
    """One part of one thesis: the text, its open notes, or its latest events."""
    part = (part or "body").strip().lower()
    if part not in THESIS_PARTS:
        raise RuntimeError(f"no part '{part}' — one of {', '.join(THESIS_PARTS)}")
    tid = _thesis_id(get, thesis)
    if part == "notes":
        return ask_pages.fit(get(f"/api/v2/theses/{tid}/notes"), points, max_chars)
    data = get(f"/api/v2/theses/{tid}")
    if part == "events":
        return ask_pages.fit({"thesis_id": tid, "events": data.get("events", [])}, points, max_chars)
    thesis_row = {k: v for k, v in (data.get("thesis") or {}).items() if v not in (None, "", [], {})}
    thesis_row["body"] = _cut(thesis_row.get("body"), max_chars - 4_000)
    return {"thesis": thesis_row, "counts": data.get("counts")}


def list_questions(get: Get, thesis: str) -> dict:
    """Open questions: of one thesis (its whole tree) or, with no thesis, what is waiting everywhere."""
    if thesis.strip():
        nodes = get("/api/v2/questions/tree", {"thesis_id": _thesis_id(get, thesis)}).get("nodes", [])
        return {"questions": [_pick(q, _QUESTION_KEEP) for q in nodes]}
    data = get("/api/v2/questions/queue")
    return {"counts": data.get("counts"), "queue": [_pick(q, _QUESTION_KEEP) for q in data.get("queue", [])]}


def get_question(get: Get, question_id: str, points: int, max_chars: int) -> Any:
    """One question with its answers, parents, children and dates."""
    question_id = question_id.strip()
    if not _UUID_RE.match(question_id):
        raise RuntimeError("pass the question's id (the `id` field from list_questions), not its Q- reference")
    return ask_pages.fit(get(f"/api/v2/questions/{question_id}"), points, max_chars)


# ── Tracked numbers (PORT → TOOLS → TRACK) ───────────────────────────────────

# The list names a metric by its ref (get_tracked takes it); the id and where the
# number is read are in get_tracked — left out here so every metric fits one result.
_METRIC_KEEP = ("ref", "symbol", "title", "role", "unit", "kill_rule", "cadence")
_STATE_KEEP = ("status", "gaps", "next", "due", "unexplained")
_LAST_KEEP = ("period", "as_of", "value_text", "verdict", "kill", "explained")


def _metric_row(m: dict) -> dict:
    row = _pick(m, _METRIC_KEEP, 120)
    state = m.get("state") or {}
    # Only what is out of the ordinary is said: not due, nothing unexplained, no kill
    # line crossed and an explained reading are the normal case, 34 times over.
    row["state"] = {k: v for k, v in _pick(state, _STATE_KEEP).items() if v not in (False, 0)}
    if state.get("last"):
        row["state"]["last"] = {
            k: v for k, v in _pick(state["last"], _LAST_KEEP).items()
            if not (k == "kill" and v is False) and not (k == "explained" and v is True)
        }
    return row


def list_tracked(get: Get, thesis: str, due_days: int) -> dict:
    """The numbers a thesis stands or falls on, with where each stands. `due_days` > 0
    keeps only what has come due or is due within that many days."""
    params = {"thesis_id": _thesis_id(get, thesis)} if thesis.strip() else {}
    if due_days > 0:
        data = get("/api/v2/tracking/due", {**params, "days": due_days})
    else:
        data = get("/api/v2/tracking", params)
    rows = [m for m in data.get("metrics", []) if not m.get("deleted_at") and not m.get("retired_at")]
    return {"counts": data.get("counts"), "metrics": [_metric_row(m) for m in rows]}


def get_tracked(get: Get, metric: str, points: int, max_chars: int) -> Any:
    """One tracked number in full: definition, source, kill line, every period's forecast and reading."""
    if not metric.strip():
        raise RuntimeError("pass a metric id or reference from list_tracked")
    return ask_pages.fit(get(f"/api/v2/tracking/{metric.strip()}"), points, max_chars)


# ── Anti-thesis (THESES → ANTI-THESIS) ───────────────────────────────────────

_CLAIM_KEEP = ("ref", "statement", "negation", "basis", "stake")
_OBJECTION_KEEP = ("ref", "angle", "argument", "would_see", "look_where")
_VERDICT_KEEP = ("result", "reasoning", "consequence", "revised_statement", "searched",
                 "next_check", "actor")


def get_antithesis(get: Get, thesis: str, points: int, max_chars: int) -> Any:
    """How one thesis has been argued against: its beliefs, each with its negation,
    the objections raised and what became of them. Claims that were replaced or
    retired are left out — the board as it stands."""
    if not thesis.strip():
        raise RuntimeError("pass a thesis id or ticker")
    data = get("/api/v2/antithesis", {"thesis_id": _thesis_id(get, thesis), "include_closed": False})
    claims = []
    for c in data.get("claims", []):
        state = c.get("state") or {}
        row = _pick(c, _CLAIM_KEEP, 400)
        row["status"] = state.get("status")
        # Only what is out of the ordinary: a first wording and a full set of
        # angles are the normal case.
        if (state.get("round") or 1) > 1:
            row["round"] = state["round"]
        if state.get("untried"):
            row["untried_angles"] = state["untried"]
        if state.get("settled"):
            row["settled"] = True
        row["objections"] = []
        for o in c.get("objections", []):
            status = (o.get("state") or {}).get("status")
            if status == "WITHDRAWN":
                continue
            verdict = o.get("proposal") or o.get("verdict") or {}
            item = {**_pick(o, _OBJECTION_KEEP, 300), "status": status}
            if verdict:
                item["verdict"] = _pick(verdict, _VERDICT_KEEP, 400)
                refs = [z.get("ref") for z in verdict.get("evidence") or [] if z.get("ref")]
                if refs:
                    item["verdict"]["evidence"] = refs
            row["objections"].append(item)
        none_found = [w.get("angle") for w in c.get("sweeps", [])]
        if none_found:
            row["searched_no_objection"] = none_found
        claims.append(row)
    return ask_pages.fit(
        {"summary": data.get("summary"), "counts": data.get("counts"), "claims": claims},
        points, max_chars)


# ── Zettelkasten (findings attached to theses) ───────────────────────────────

_ZETTEL_KEEP = (
    "id", "ref", "kind", "title", "stance", "confidence", "status", "tags", "occurred_at",
    "snippet", "source_count", "open_conflicts",
)
_SEARCH_ROWS = 20
_LIST_ROWS = 40


def search_zettel(get: Get, query: str, thesis: str) -> dict:
    """Findings by text, or — with no query — the notes of one thesis. Titles only:
    a zettel's title is the finding written as a sentence."""
    query = query.strip()
    if query:
        rows = get("/api/v2/zettel/search", {"q": query[:200], "limit": _SEARCH_ROWS}).get("zettel", [])
    elif thesis.strip():
        rows = get("/api/v2/zettel", {"thesis_id": _thesis_id(get, thesis), "limit": _LIST_ROWS}).get("zettel", [])
    else:
        raise RuntimeError("pass a query, or a thesis to list its notes")
    return {"zettel": [_pick(z, _ZETTEL_KEEP, 400) for z in rows if not z.get("deleted_at")]}


def get_zettel(get: Get, zettel: str, points: int, max_chars: int) -> Any:
    """One note in full: body, sources (url and quote), links to other notes, theses it is attached to."""
    if not zettel.strip():
        raise RuntimeError("pass a zettel id or reference from search_zettel")
    return ask_pages.fit(get(f"/api/v2/zettel/{zettel.strip()}"), points, max_chars)


_CONFLICT_KEEP = (
    "id", "rel", "note", "created_at",
    "src_ref", "src_title", "src_kind", "src_stance", "src_occurred_at",
    "dst_ref", "dst_title", "dst_kind", "dst_stance", "dst_occurred_at",
)


def list_conflicts(get: Get, thesis: str) -> dict:
    """Findings that contradict each other and have not been resolved."""
    params = {"thesis_id": _thesis_id(get, thesis)} if thesis.strip() else {}
    data = get("/api/v2/zettel/conflicts", params)
    return {
        "open_count": data.get("open_count"),
        "conflicts": [
            _pick(c, _CONFLICT_KEEP, 400) for c in data.get("conflicts", []) if not c.get("resolved_at")
        ],
    }
