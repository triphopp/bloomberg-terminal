"""
Portfolio theses, research, transactions, backtest — extracted from main.py.
"""
import json
import re
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

import pandas as pd
import requests
import yaml
from fastapi import APIRouter, HTTPException, Query
from sources import market_data
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from cache import TTLCache
from config import (
    THESES_DIR,
    SOURCES_DIR,
    OBSIDIAN_WIKI_DIR,
    OLLAMA_URL,
    CLAUDE_API_KEY,
    STOCK_CACHE_TTL,
    CLAUDE_MODEL,
    CLAUDE_MAX_TOKENS,
)
from db import get_db, compute_holdings

router = APIRouter()

_theses_cache = TTLCache(ttl=300, maxsize=50)
_sources_cache = TTLCache(ttl=300, maxsize=50)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _parse_frontmatter(text: str) -> tuple[dict, str]:
    """Split YAML frontmatter from body. Returns ({}, text) if no frontmatter."""
    if not text.startswith("---"):
        return {}, text
    lines = text.split("\n")
    try:
        end = next(i for i, ln in enumerate(lines[1:], 1) if ln.strip() == "---")
    except StopIteration:
        return {}, text
    fm_raw = "\n".join(lines[1:end])
    body = "\n".join(lines[end + 1:]).lstrip("\n")
    try:
        fm = yaml.safe_load(fm_raw) or {}
    except Exception:
        fm = {}
    return fm if isinstance(fm, dict) else {}, body


def _parse_thesis_sections(body: str) -> dict[str, str]:
    """Split thesis markdown body into labelled sections by ## headers."""
    sections: dict[str, str] = {}
    current_key = "preamble"
    current_lines: list[str] = []

    for line in body.split("\n"):
        if line.startswith("## "):
            if current_lines:
                sections[current_key] = "\n".join(current_lines).strip()
            title = line[3:].strip().lower()
            if "claim" in title:
                key = "claim"
            elif "condition" in title or "killer" in title:
                key = "condition_killers"
            elif "catalyst" in title:
                key = "catalysts"
            elif "valuation" in title:
                key = "valuation"
            elif "compelling" in title or "น่าสนใจ" in title:
                key = "compelling"
            elif "supporting" in title or "evidence" in title:
                key = "supporting_evidence"
            elif "challenge" in title:
                key = "challenges"
            elif "key risk" in title or "risk" in title:
                key = "key_risks"
            elif "related" in title:
                key = "related"
            elif "source" in title:
                key = "sources"
            else:
                key = re.sub(r"[^a-z0-9_]", "_", title)[:40]
            current_key = key
            current_lines = []
        else:
            current_lines.append(line)

    if current_lines:
        sections[current_key] = "\n".join(current_lines).strip()
    return sections


def _parse_condition_killers(text: str) -> list[dict]:
    """Parse Condition Killers section into structured KO cards."""
    kos = []
    # Split on H3 headers: "### KO #N: Title" or "### ❌ N. Title"
    blocks = re.split(r"\n(?=### (?:KO #\d+|❌ \d+\.|❌ \w+\.))", text)
    for block in blocks:
        block = block.strip()
        if not block:
            continue
        header_match = re.match(
            r"### (?:KO #(\d+)[:\s]+|❌ (\d+)\.\s+|❌ (\w+)\.\s*)(.+)", block
        )
        if not header_match:
            continue
        ko_id = (
            header_match.group(1)
            or header_match.group(2)
            or header_match.group(3)
            or "?"
        )
        title = header_match.group(4).strip()
        content = block[header_match.end():].strip()

        prob_match = re.search(
            r"\*\*ความน่าจะเป็น[^*]*\*\*[:\s]*(.+?)(?:\n|$)", content
        )
        probability = prob_match.group(1).strip() if prob_match else ""

        monitor_match = re.search(
            r"\*\*(?:เงื่อนไขที่ต้องสังเกต|Monitor)[^*]*\*\*[:\s]*(.+?)(?:\n\n|$)",
            content,
            re.DOTALL,
        )
        monitor = monitor_match.group(1).strip() if monitor_match else ""

        kos.append(
            {
                "id": ko_id,
                "title": title,
                "content": content,
                "probability": probability,
                "monitor": monitor,
            }
        )
    return kos


def _find_relevant_sources(symbol: str, max_total_chars: int = 10_000) -> list[dict]:
    """Find source .md files relevant to a symbol (matches tags or filename).

    Returns list of dicts sorted by date (newest first), each containing:
      file, title, source_type, original_date, authors, excerpt
    Total excerpt chars are capped at max_total_chars to fit Ollama context windows.
    """
    sym = symbol.upper()
    cache_key = f"sources:{sym}"
    cached = _sources_cache.get(cache_key)
    if cached is not None:
        return cached

    if not SOURCES_DIR.exists():
        return []

    candidates = []
    for path in SOURCES_DIR.glob("*.md"):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
            fm, body = _parse_frontmatter(text)
            tags_upper = [str(t).upper() for t in (fm.get("tags") or [])]

            # Include if symbol is in tags OR file stem contains symbol
            if sym not in tags_upper and sym not in path.stem.upper():
                continue

            # Extract the most useful sections for research context
            sections = _parse_thesis_sections(body)
            excerpt_parts = []
            for sec_key in ("abstract", "key_claims", "investment_relevance", "investment_thesis"):
                content = sections.get(sec_key, "").strip()
                if content:
                    # Cap each section at 2 000 chars to prevent single-source domination
                    excerpt_parts.append(content[:2_000])

            # Fallback: first 1 500 chars of body if no structured sections found
            if not excerpt_parts:
                excerpt_parts.append(body[:1_500])

            original_date = str(
                fm.get("original_date") or fm.get("date_ingested") or ""
            )
            candidates.append({
                "file":          path.name,
                "title":         fm.get("title") or path.stem,
                "source_type":   fm.get("source_type") or fm.get("type") or "",
                "original_date": original_date,
                "authors":       fm.get("authors") or [],
                "tags":          fm.get("tags") or [],
                "excerpt":       "\n\n".join(excerpt_parts),
                "char_count":    len(body),
            })
        except Exception as exc:
            print(f"[sources] {path.name}: {exc}")

    # Newest first
    candidates.sort(key=lambda x: x["original_date"], reverse=True)

    # Budget: add sources until we exceed max_total_chars
    result: list[dict] = []
    total = 0
    for c in candidates:
        size = len(c["excerpt"])
        if total + size > max_total_chars and result:
            break
        result.append(c)
        total += size

    _sources_cache.set(cache_key, result)
    return result


def _build_sources_block(sources: list[dict]) -> str:
    """Format sources list into a readable context block for the LLM prompt."""
    if not sources:
        return ""
    parts = []
    for i, s in enumerate(sources, 1):
        date_str = f" ({s['original_date']})" if s["original_date"] else ""
        author_str = f" — {', '.join(s['authors'][:2])}" if s.get("authors") else ""
        header = f"--- SOURCE {i}: {s['title']}{date_str}{author_str} ---"
        parts.append(f"{header}\n{s['excerpt']}")
    return (
        "=== RESEARCH SOURCES (Claude-analyzed notes from Obsidian vault) ===\n"
        "Use these as PRIMARY evidence. Prioritise recent sources over general knowledge.\n\n"
        + "\n\n".join(parts)
        + "\n\n"
    )


def _find_thesis_file(symbol: str) -> Path | None:
    """Find a thesis .md file for the given symbol (prefix match)."""
    sym_upper = symbol.upper()
    if not THESES_DIR.exists():
        return None
    # Exact prefix match: PLTR-*.md
    for p in THESES_DIR.glob(f"{sym_upper}-*.md"):
        return p
    # Fallback: any .md containing the symbol in its name
    for p in THESES_DIR.glob("*.md"):
        if sym_upper in p.stem.upper():
            return p
    return None


def _save_research_note(
    symbol: str,
    content: str,
    date: str,
    sources_meta: list[dict] | None = None,
) -> None:
    """Save AI research output as a markdown note in Obsidian vault."""
    try:
        research_dir = OBSIDIAN_WIKI_DIR / "research"
        research_dir.mkdir(parents=True, exist_ok=True)
        # Security: symbol/date are user-influenced — strip anything that could
        # escape research_dir (path separators, '..', etc.) before building name.
        safe_symbol = re.sub(r"[^A-Za-z0-9._-]", "", symbol)[:32] or "UNKNOWN"
        safe_date = re.sub(r"[^0-9-]", "", date)[:10]
        filename = f"{safe_symbol}-KO-Research-{safe_date}.md"
        note_path = (research_dir / filename).resolve()
        if research_dir.resolve() not in note_path.parents:
            print(f"[research] Rejected unsafe note path: {note_path}")
            return

        # Build sources citation block
        sources_section = ""
        if sources_meta:
            citations = "\n".join(
                f"- [[{s['file'].replace('.md', '')}]] ({s['date']})"
                for s in sources_meta
            )
            sources_section = f"\n\n## Sources Used\n{citations}\n"

        header = f"""---
title: "KO Research: {symbol} — {date}"
type: research
symbol: {symbol}
date: {date}
sources_count: {len(sources_meta) if sources_meta else 0}
tags: [research, condition-killers, {symbol.lower()}]
---

# Condition Killer Analysis: {symbol}
*Generated: {date} | Sources: {len(sources_meta) if sources_meta else 0} Obsidian notes*
{sources_section}
## Analysis

"""
        note_path.write_text(header + content, encoding="utf-8")
        print(f"[research] Saved note: {note_path}")
    except Exception as exc:
        print(f"[research] Failed to save note: {exc}")


# ── Pydantic models ──────────────────────────────────────────────────────────

class TransactionIn(BaseModel):
    symbol: str
    type: str            # 'buy' | 'sell'
    shares: float
    price: float
    date: str            # YYYY-MM-DD
    commission: float = 0.0
    notes: str = ""


class ImportHoldingsRequest(BaseModel):
    holdings: list[dict]  # [{symbol, shares, avgCost, purchaseDate, notes?}]


class ResearchRequest(BaseModel):
    symbol: str
    model: str = "llama3.2"
    provider: str = "ollama"   # "ollama" | "claude"
    claude_api_key: str = ""   # override ANTHROPIC_API_KEY if provided
    save_to_obsidian: bool = True
    use_sources: bool = True   # inject Obsidian source notes as context


class PortfolioExportRequest(BaseModel):
    holdings: list[dict]  # [{symbol, shares, avgCost, purchaseDate, notes?}]


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/api/portfolio/theses")
def list_theses():
    """List all thesis .md files in THESES_DIR with frontmatter metadata."""
    cache_key = "theses:list"
    cached = _theses_cache.get(cache_key, ttl=120)
    if cached is not None:
        return cached

    if not THESES_DIR.exists():
        return {"theses": [], "dir": str(THESES_DIR), "error": f"Directory not found: {THESES_DIR}"}

    items = []
    for path in sorted(THESES_DIR.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
            fm, body = _parse_frontmatter(text)
            # Try to guess symbol from filename (first segment before "-")
            symbol_guess = path.stem.split("-")[0].upper()
            items.append({
                "file": path.name,
                "symbol": symbol_guess,
                "title": fm.get("title") or path.stem,
                "status": fm.get("status") or "unknown",
                "confidence": fm.get("confidence") or "",
                "last_updated": str(fm.get("last_updated") or ""),
                "tags": fm.get("tags") or [],
            })
        except Exception as exc:
            print(f"[theses] {path.name}: {exc}")

    data = {"theses": items, "dir": str(THESES_DIR)}
    _theses_cache.set(cache_key, data)
    return data


@router.get("/api/portfolio/thesis/{symbol}")
def get_thesis(symbol: str):
    """Return parsed thesis for a symbol (e.g. PLTR)."""
    sym = symbol.upper()
    cache_key = f"thesis:{sym}"
    cached = _theses_cache.get(cache_key)
    if cached is not None:
        return cached

    path = _find_thesis_file(sym)
    if not path:
        raise HTTPException(status_code=404, detail=f"No thesis found for {sym}")

    text = path.read_text(encoding="utf-8", errors="replace")
    fm, body = _parse_frontmatter(text)
    sections = _parse_thesis_sections(body)
    condition_killers = _parse_condition_killers(sections.get("condition_killers", ""))

    data = {
        "symbol": sym,
        "file": path.name,
        "meta": {
            "title": fm.get("title") or path.stem,
            "type": fm.get("type") or "thesis",
            "status": fm.get("status") or "unknown",
            "confidence": fm.get("confidence") or "",
            "last_updated": str(fm.get("last_updated") or ""),
            "tags": fm.get("tags") or [],
        },
        "sections": sections,
        "condition_killers": condition_killers,
        "raw_body": body,
    }
    _theses_cache.set(cache_key, data)
    return data


@router.post("/api/portfolio/research")
def portfolio_research(req: ResearchRequest):
    """Stream a multi-KO condition-killer analysis via Ollama or Claude API (SSE).

    When use_sources=True (default), relevant source notes from SOURCES_DIR are
    fetched and injected into the prompt as primary evidence, giving Ollama access
    to recent Claude-analyzed research instead of relying on training data alone.
    """
    sym = req.symbol.upper()
    path = _find_thesis_file(sym)
    if not path:
        return StreamingResponse(
            iter([f"data: {json.dumps({'error': f'No thesis found for {sym}', 'done': True})}\n\n"]),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    text = path.read_text(encoding="utf-8", errors="replace")
    fm, body = _parse_frontmatter(text)
    sections = _parse_thesis_sections(body)
    kos = _parse_condition_killers(sections.get("condition_killers", ""))

    thesis_claim = sections.get("claim", "")
    ko_list = "\n".join(
        f"KO #{ko['id']}: {ko['title']}\n  Monitor signals: {ko['monitor']}"
        for ko in kos
    ) if kos else "(no condition killers found in thesis)"

    # ── Gather relevant Obsidian source notes ─────────────────────────────
    sources: list[dict] = []
    if req.use_sources:
        sources = _find_relevant_sources(sym)

    sources_block = _build_sources_block(sources)
    sources_guidance = (
        "Base your analysis **primarily on the provided sources** above. "
        "Cite source titles when referencing specific data points. "
        "Only fall back to general knowledge when sources do not cover a KO."
        if sources else
        "No Obsidian source notes found for this symbol. "
        "Base your analysis on your training knowledge and flag where recent data is needed."
    )

    today = datetime.now().strftime("%Y-%m-%d")
    prompt = f"""You are an investment analyst. Today is {today}.

{sources_block}=== INVESTMENT THESIS: {sym} ===
{thesis_claim[:800]}

=== CONDITION KILLERS TO ANALYZE ===
{ko_list}

=== YOUR TASK ===
{sources_guidance}

For each Condition Killer, provide:
1. **Current Status**: Has this condition been triggered or shown early warning signs?
2. **Probability Change**: Higher / Lower / Unchanged vs. original estimate — and why?
3. **Evidence**: Specific data points from the sources (or training data) that support your view.
4. **Watch List**: 2-3 concrete signals to monitor next quarter.

Format as a section per KO (e.g., "## KO #1 — [Title]").
Be direct and evidence-based. Flag uncertainty clearly rather than speculating."""

    # Metadata event — sent once before tokens so the UI can show which sources were loaded
    sources_meta = [{"file": s["file"], "title": s["title"], "date": s["original_date"]} for s in sources]

    def _stream_ollama():
        # First event: sources metadata
        yield f"data: {json.dumps({'sources': sources_meta, 'token': '', 'done': False})}\n\n"
        try:
            with requests.post(
                f"{OLLAMA_URL}/api/generate",
                json={"model": req.model, "prompt": prompt, "stream": True},
                stream=True,
                timeout=300,
            ) as r:
                if not r.ok:
                    yield f"data: {json.dumps({'error': f'Ollama {r.status_code}', 'done': True})}\n\n"
                    return
                full_response: list[str] = []
                for line in r.iter_lines():
                    if not line:
                        continue
                    chunk = json.loads(line)
                    token = chunk.get("response", "")
                    done = chunk.get("done", False)
                    full_response.append(token)
                    yield f"data: {json.dumps({'token': token, 'done': done})}\n\n"
                    if done:
                        if req.save_to_obsidian:
                            _save_research_note(sym, "".join(full_response), today, sources_meta)
                        break
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc), 'done': True})}\n\n"

    def _stream_claude():
        yield f"data: {json.dumps({'sources': sources_meta, 'token': '', 'done': False})}\n\n"
        try:
            import anthropic  # type: ignore
            api_key = req.claude_api_key or CLAUDE_API_KEY
            if not api_key:
                yield f"data: {json.dumps({'error': 'ANTHROPIC_API_KEY not set', 'done': True})}\n\n"
                return
            client = anthropic.Anthropic(api_key=api_key)
            full_response: list[str] = []
            with client.messages.stream(
                model=CLAUDE_MODEL,
                max_tokens=CLAUDE_MAX_TOKENS,
                messages=[{"role": "user", "content": prompt}],
            ) as stream:
                for token in stream.text_stream:
                    full_response.append(token)
                    yield f"data: {json.dumps({'token': token, 'done': False})}\n\n"
            yield f"data: {json.dumps({'token': '', 'done': True})}\n\n"
            if req.save_to_obsidian:
                _save_research_note(sym, "".join(full_response), today, sources_meta)
        except ImportError:
            yield f"data: {json.dumps({'error': 'anthropic package not installed. Run: pip install anthropic', 'done': True})}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc), 'done': True})}\n\n"

    stream_fn = _stream_claude if req.provider == "claude" else _stream_ollama
    return StreamingResponse(
        stream_fn(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/api/portfolio/sources/{symbol}")
def list_sources_for_symbol(symbol: str):
    """List all Obsidian source notes relevant to a given stock symbol."""
    sym = symbol.upper()
    sources = _find_relevant_sources(sym)
    return {
        "symbol": sym,
        "sources": [
            {
                "file":          s["file"],
                "title":         s["title"],
                "source_type":   s["source_type"],
                "original_date": s["original_date"],
                "authors":       s["authors"],
                "char_count":    s["char_count"],
            }
            for s in sources
        ],
        "sources_dir": str(SOURCES_DIR),
    }


@router.post("/api/portfolio/export")
def export_portfolio_to_obsidian(req: PortfolioExportRequest):
    """Write current portfolio holdings to Obsidian wiki/portfolio/holdings.md."""
    try:
        portfolio_dir = OBSIDIAN_WIKI_DIR / "portfolio"
        portfolio_dir.mkdir(parents=True, exist_ok=True)

        today = datetime.now().strftime("%Y-%m-%d")
        lines = [
            "---",
            'title: "Portfolio Holdings"',
            "type: portfolio",
            f"last_updated: {today}",
            "---",
            "",
            "# Portfolio Holdings",
            f"*Last updated: {today}*",
            "",
            "| Symbol | Shares | Avg Cost | Purchase Date | Notes |",
            "|--------|--------|----------|---------------|-------|",
        ]
        for h in req.holdings:
            symbol = h.get("symbol", "")
            shares = h.get("shares", 0)
            avg_cost = h.get("avgCost", 0)
            purchase_date = h.get("purchaseDate", "")
            notes = h.get("notes", "").replace("|", "\\|") if h.get("notes") else ""
            lines.append(f"| [[{symbol}]] | {shares} | ${avg_cost:.2f} | {purchase_date} | {notes} |")

        filepath = portfolio_dir / "holdings.md"
        filepath.write_text("\n".join(lines), encoding="utf-8")
        return {"success": True, "path": str(filepath)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ── Portfolio DB (SQLite) endpoints ──────────────────────────────────────────

@router.get("/api/portfolio/db/transactions")
def db_list_transactions():
    """Return all transactions ordered by date desc."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM transactions ORDER BY date DESC, created_at DESC"
        ).fetchall()
    return {"transactions": [dict(r) for r in rows]}


@router.post("/api/portfolio/db/transactions")
def db_add_transaction(tx: TransactionIn):
    """Record a buy or sell transaction."""
    if tx.type not in ("buy", "sell"):
        raise HTTPException(status_code=400, detail="type must be 'buy' or 'sell'")
    if tx.shares <= 0:
        raise HTTPException(status_code=400, detail="shares must be > 0")
    if tx.price < 0:
        raise HTTPException(status_code=400, detail="price must be >= 0")
    tx_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO transactions (id,symbol,type,shares,price,date,commission,notes,created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (tx_id, tx.symbol.upper(), tx.type, tx.shares,
             tx.price, tx.date, tx.commission, tx.notes, now),
        )
    return {"id": tx_id, "success": True}


@router.delete("/api/portfolio/db/transactions/{tx_id}")
def db_delete_transaction(tx_id: str):
    """Delete a single transaction by id."""
    with get_db() as conn:
        cur = conn.execute("DELETE FROM transactions WHERE id = ?", (tx_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Transaction not found")
    return {"success": True}


@router.get("/api/portfolio/db/holdings")
def db_get_holdings():
    """Return current holdings computed from transaction history."""
    return {"holdings": compute_holdings()}


@router.post("/api/portfolio/db/import")
def db_import_holdings(req: ImportHoldingsRequest):
    """
    One-time import: convert localStorage-style holdings
    [{symbol, shares, avgCost, purchaseDate, notes?}] into 'buy' transactions.
    Idempotent — uses the holding 'id' field to avoid duplicate imports.
    """
    now = datetime.utcnow().isoformat()
    imported = 0
    with get_db() as conn:
        for h in req.holdings:
            tx_id = h.get("id") or str(uuid.uuid4())
            exists = conn.execute(
                "SELECT 1 FROM transactions WHERE id = ?", (tx_id,)
            ).fetchone()
            if exists:
                continue
            conn.execute(
                "INSERT INTO transactions (id,symbol,type,shares,price,date,commission,notes,created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    tx_id,
                    str(h.get("symbol", "")).upper(),
                    "buy",
                    float(h.get("shares", 0)),
                    float(h.get("avgCost", 0)),
                    str(h.get("purchaseDate", now[:10])),
                    0.0,
                    str(h.get("notes", "Imported from localStorage")),
                    now,
                ),
            )
            imported += 1
    return {"imported": imported, "success": True}


@router.get("/api/portfolio/db/backtest")
def db_backtest(benchmark: str = Query(default="SPY")):
    """
    Reconstruct full daily portfolio value from transaction history.
    Returns daily series (date, portfolio_value, portfolio_return, benchmark_return,
    total_invested) + performance metrics (CAGR, Sharpe, max drawdown, alpha, beta).
    """
    with get_db() as conn:
        all_tx = conn.execute(
            "SELECT * FROM transactions ORDER BY date ASC, created_at ASC"
        ).fetchall()

    if not all_tx:
        return {"error": "No transactions found", "daily": [], "metrics": {}}

    start_date = all_tx[0]["date"]
    symbols = list({r["symbol"] for r in all_tx})
    fetch_syms = symbols + ([benchmark] if benchmark not in symbols else [])

    # ── Fetch daily price history ─────────────────────────────────────────────
    price_data: dict[str, dict[str, float]] = {}  # sym -> {date -> close}

    def _fetch_hist(sym: str) -> tuple[str, dict[str, float]]:
        try:
            frame = market_data.get_history(sym, period="5y", interval="1d")
            hist = frame.df if frame is not None else None
            if hist is None or hist.empty:
                return sym, {}
            return sym, {str(d.date()): float(row["Close"])
                         for d, row in hist.iterrows()}
        except Exception:
            return sym, {}

    with ThreadPoolExecutor(max_workers=8) as exe:
        for sym, data in exe.map(_fetch_hist, fetch_syms):
            price_data[sym] = data

    bench_prices = price_data.get(benchmark, {})
    all_dates = sorted(d for d in bench_prices if d >= start_date)
    if not all_dates:
        return {"error": "No benchmark price data", "daily": [], "metrics": {}}

    # AF-1: pre-sort price history once per symbol → O(S·K log K) instead of O(D·S·K log K)
    price_sorted: dict[str, list[tuple[str, float]]] = {
        sym: sorted(pd.items())  # ascending (date_str, price)
        for sym, pd in price_data.items()
    }
    price_ptr: dict[str, int] = {sym: -1 for sym in price_sorted}

    # ── Group transactions by date ────────────────────────────────────────────
    tx_by_date: dict[str, list] = {}
    for r in all_tx:
        tx_by_date.setdefault(r["date"], []).append(dict(r))

    # ── Simulate day by day ───────────────────────────────────────────────────
    port_state: dict[str, dict] = {}  # sym -> {shares, total_cost}
    initial_bench: float | None = None
    daily: list[dict] = []

    for date in all_dates:
        for tx in tx_by_date.get(date, []):
            sym = tx["symbol"]
            if sym not in port_state:
                port_state[sym] = {"shares": 0.0, "total_cost": 0.0}
            ps = port_state[sym]
            if tx["type"] == "buy":
                ps["shares"] += tx["shares"]
                ps["total_cost"] += tx["shares"] * tx["price"] + tx["commission"]
            else:
                sold = min(tx["shares"], ps["shares"])
                if ps["shares"] > 0:
                    avg = ps["total_cost"] / ps["shares"]
                    ps["total_cost"] -= sold * avg
                ps["shares"] -= sold

        if not port_state or all(ps["shares"] <= 0 for ps in port_state.values()):
            continue

        # Compute portfolio value — AF-1: O(1) amortized pointer advance replaces O(K log K) sort
        port_value = 0.0
        for sym, ps in port_state.items():
            if ps["shares"] <= 1e-6:
                continue
            sorted_prices = price_sorted.get(sym)
            if not sorted_prices:
                price = ps["total_cost"] / ps["shares"] if ps["shares"] > 0 else 0
            else:
                ptr = price_ptr[sym]
                while ptr + 1 < len(sorted_prices) and sorted_prices[ptr + 1][0] <= date:
                    ptr += 1
                price_ptr[sym] = ptr
                if ptr >= 0:
                    price = sorted_prices[ptr][1]
                else:
                    price = sorted_prices[0][1] if sorted_prices else 0
                    if price == 0:
                        price = ps["total_cost"] / ps["shares"] if ps["shares"] > 0 else 0
            port_value += ps["shares"] * price

        bench_close = bench_prices.get(date)
        if bench_close is None:
            continue
        if initial_bench is None:
            initial_bench = bench_close

        total_invested = sum(s["total_cost"] for s in port_state.values())
        port_ret = ((port_value - total_invested) / total_invested * 100) if total_invested > 0 else 0
        bench_ret = ((bench_close - initial_bench) / initial_bench * 100) if initial_bench else 0

        daily.append({
            "date":             date,
            "portfolio_value":  round(port_value, 2),
            "portfolio_return": round(port_ret, 2),
            "benchmark_return": round(bench_ret, 2),
            "total_invested":   round(total_invested, 2),
        })

    if not daily:
        return {"daily": [], "metrics": {}}

    # ── Compute performance metrics ───────────────────────────────────────────
    values = pd.Series([d["portfolio_value"] for d in daily])
    p_rets = values.pct_change().dropna()
    n_years = max(len(daily) / 252, 1e-6)

    total_return = daily[-1]["portfolio_return"]
    cagr = ((1 + total_return / 100) ** (1 / n_years) - 1) * 100

    rf_daily = 0.05 / 252
    excess = p_rets - rf_daily
    sharpe = float(excess.mean() / excess.std() * (252 ** 0.5)) if excess.std() > 0 else 0.0

    cummax = values.cummax()
    drawdown = (values - cummax) / cummax * 100
    max_dd = float(drawdown.min())
    vol = float(p_rets.std() * (252 ** 0.5) * 100)

    # Beta / alpha vs benchmark
    b_vals = pd.Series({d["date"]: bench_prices.get(d["date"], float("nan")) for d in daily}).dropna()
    b_rets = b_vals.pct_change().dropna()
    p_rets2 = pd.Series({daily[i]["date"]: p_rets.iloc[i] for i in range(len(p_rets)) if i < len(daily)})
    aligned = p_rets2.reindex(b_rets.index).dropna()
    b_aligned = b_rets.reindex(aligned.index).dropna()
    aligned = aligned.reindex(b_aligned.index)

    if len(aligned) > 5 and b_aligned.var() > 0:
        beta = float(aligned.cov(b_aligned) / b_aligned.var())
        b_cagr = ((1 + daily[-1]["benchmark_return"] / 100) ** (1 / n_years) - 1) * 100
        alpha = cagr - (5.0 + beta * (b_cagr - 5.0))
    else:
        beta = 1.0
        alpha = 0.0

    # Per-symbol attribution
    attribution = []
    for s in compute_holdings():
        sym = s["symbol"]
        prices = price_data.get(sym, {})
        cur_p = next((prices[d] for d in sorted(prices, reverse=True)), s["avg_cost"])
        mkt_val = s["shares"] * cur_p
        cost_val = s["shares"] * s["avg_cost"]
        sym_ret = ((mkt_val - cost_val) / cost_val * 100) if cost_val > 0 else 0
        attribution.append({
            "symbol":        sym,
            "shares":        round(s["shares"], 4),
            "avg_cost":      round(s["avg_cost"], 4),
            "current_price": round(cur_p, 4),
            "market_value":  round(mkt_val, 2),
            "cost_basis":    round(cost_val, 2),
            "return_pct":    round(sym_ret, 2),
            "pnl":           round(mkt_val - cost_val, 2),
        })

    metrics = {
        "total_return":           round(total_return, 2),
        "benchmark_total_return": round(daily[-1]["benchmark_return"], 2),
        "cagr":                   round(cagr, 2),
        "sharpe_ratio":           round(sharpe, 2),
        "max_drawdown":           round(max_dd, 2),
        "volatility":             round(vol, 2),
        "beta":                   round(beta, 2),
        "alpha":                  round(alpha, 2),
        "n_days":                 len(daily),
        "benchmark":              benchmark,
    }

    return {"daily": daily, "metrics": metrics, "attribution": attribution}
