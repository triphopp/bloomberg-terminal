"""
Analysis graphs — rendered research pages that belong to the book, not to a chat.

A "graph" here is a self-contained HTML page (inline SVG, tables, its own CSS)
written by an agent or by hand: a money-flow map, a cycle diagram, a comparison
sheet. The page lives on disk under GRAPHS_DIR so it opens without the backend
and diffs in git; this router is the index, the writer and the renderer.

  research/graphs/<slug>/index.html   ← current version, what /render serves
  research/graphs/<slug>/v3.html      ← what index.html held before the last edit
  research/graphs/<slug>/meta.json    ← same metadata as the DB row, for git

Two things are deliberate:

1. **The page is untrusted.** It was written by a model. /render therefore sends
   a CSP that allows inline styles and scripts but forbids the page from reaching
   anything off-box, and the UI embeds it in a sandboxed iframe WITHOUT
   allow-same-origin, so it cannot touch the terminal's own origin, cookies or
   localStorage. Never serve one of these through a route that skips those headers.

2. **Nothing is destroyed.** An update copies the old index.html to v<N>.html
   before writing, and DELETE only sets `deleted_at`. Same rule as theses: the
   agent can add, the human removes.
"""
import json
import re
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

import graph_shell
from actor import capture_actor, current_actor
from config import GRAPHS_DIR
from db import get_db
from routers.theses import _log_event

router = APIRouter(prefix="/api/v2/graphs", dependencies=[Depends(capture_actor)])

VALID_KIND = {"html"}
MAX_BYTES = 4_000_000  # a page bigger than this is a data dump, not a diagram

# Inline styles/scripts are the whole point of a self-contained page; everything
# that would let it phone home, or be framed by a site that is not ours, is not.
RENDER_CSP = (
    "default-src 'none'; "
    "style-src 'unsafe-inline'; "
    "script-src 'unsafe-inline'; "
    "img-src data:; "
    "font-src data:; "
    "form-action 'none'; "
    "base-uri 'none'; "
    "frame-ancestors 'self'"
)


def _uid() -> str:
    return str(uuid.uuid4())


def _now() -> str:
    return datetime.utcnow().isoformat()


def _slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").strip().lower()).strip("-")
    return (s or "graph")[:60]


def _dir_for(slug: str) -> Path:
    """Resolve under GRAPHS_DIR and refuse anything that escapes it.

    `slug` reaches here from a URL path segment, so a '..' or an absolute path
    would otherwise let a request read or overwrite files anywhere on disk.
    """
    root = GRAPHS_DIR.resolve()
    target = (root / slug).resolve()
    if target != root and root not in target.parents:
        raise HTTPException(400, "bad slug")
    return target


def _row_to_dict(row) -> dict:
    d = dict(row)
    try:
        d["sources"] = json.loads(d.get("sources") or "[]")
    except (ValueError, TypeError):
        d["sources"] = []
    d["render_url"] = f"/api/v2/graphs/{d['slug']}/render"
    d["file"] = str((GRAPHS_DIR / d["slug"] / "index.html").as_posix())
    return d


def _fetch(conn, slug: str, *, include_deleted: bool = False):
    sql = "SELECT * FROM graphs WHERE slug = ?"
    if not include_deleted:
        sql += " AND deleted_at IS NULL"
    row = conn.execute(sql, (slug,)).fetchone()
    if not row:
        raise HTTPException(404, f"graph '{slug}' not found")
    return row


def _write_page(slug: str, html: str, *, previous_version: Optional[int]) -> int:
    """Write index.html, keeping the version it replaces as v<N>.html."""
    folder = _dir_for(slug)
    folder.mkdir(parents=True, exist_ok=True)
    index = folder / "index.html"
    if index.exists() and previous_version:
        shutil.copy2(index, folder / f"v{previous_version}.html")
    index.write_text(html, encoding="utf-8")
    return len(html.encode("utf-8"))


def _write_meta(slug: str, meta: dict) -> None:
    """Metadata beside the page so a checkout carries it even without the DB."""
    folder = _dir_for(slug)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )


# Resources the CSP will not load. A page that points at one is not "slightly
# degraded", it is broken — no image, no font, no chart — so it is refused at
# write time, where the agent can still fix it, instead of at read time, where
# only the human finds out.
_EXTERNAL_RES = re.compile(
    r"<(?:img|script|link|iframe|object|source|embed|use|image)\b[^>]*?"
    r"(?:src|href|data|xlink:href)\s*=\s*[\"']\s*(?:https?:)?//",
    re.I,
)


def _lint_page(html: str) -> list[str]:
    """Refuse what cannot render; warn about what will render badly.

    The warnings travel back in the POST/PATCH response so the agent that wrote
    the page sees them in the same turn.
    """
    if _EXTERNAL_RES.search(html):
        raise HTTPException(
            400,
            "the page loads a resource over the network (img/script/link/iframe). "
            "The render CSP blocks every off-box request, so it would show as a "
            "hole in the page — inline the SVG, or embed the asset as a data: URI.",
        )
    warnings: list[str] = []
    if not re.search(r"<h2\b", html, re.I):
        warnings.append(
            "no <h2> in the page — the render shell builds the section tabs from "
            "<h2>/<h3>, so the reader gets no way to navigate. See "
            "research/graphs/_template.html."
        )
    if re.search(r"<(?:html|head|body)\b", html, re.I):
        warnings.append(
            "the page is a full HTML document — the shell supplies <html>/<head> "
            "and unwraps yours. Send the content only (headings, prose, tables, SVG)."
        )
    return warnings


# ── Models ───────────────────────────────────────────────────────────────────

class GraphCreate(BaseModel):
    title: str
    html: str
    slug: Optional[str] = None
    description: str = ""
    symbol: Optional[str] = None
    thesis_id: Optional[str] = None
    zettel_refs: str = ""
    tags: str = ""
    as_of: Optional[str] = None
    sources: list[Any] = []
    kind: str = "html"


class GraphUpdate(BaseModel):
    title: Optional[str] = None
    html: Optional[str] = None
    description: Optional[str] = None
    symbol: Optional[str] = None
    thesis_id: Optional[str] = None
    zettel_refs: Optional[str] = None
    tags: Optional[str] = None
    as_of: Optional[str] = None
    sources: Optional[list[Any]] = None
    reason: str = ""


# ── Read ─────────────────────────────────────────────────────────────────────

@router.get("")
def list_graphs(
    symbol: Optional[str] = None,
    thesis_id: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = Query(100, ge=1, le=500),
) -> dict:
    """Index of analysis pages, newest first. Never includes the HTML."""
    sql = "SELECT * FROM graphs WHERE deleted_at IS NULL"
    params: list[Any] = []
    if symbol:
        sql += " AND UPPER(symbol) = ?"
        params.append(symbol.upper())
    if thesis_id:
        sql += " AND thesis_id = ?"
        params.append(thesis_id)
    if q:
        sql += " AND (title LIKE ? OR description LIKE ? OR tags LIKE ?)"
        params += [f"%{q}%"] * 3
    sql += " ORDER BY datetime(updated_at) DESC LIMIT ?"
    params.append(limit)
    with get_db() as conn:
        rows = conn.execute(sql, params).fetchall()
    return {"graphs": [_row_to_dict(r) for r in rows]}


@router.get("/{slug}")
def get_graph(slug: str, include_html: bool = False) -> dict:
    """One graph's metadata; `include_html=true` also returns the page source."""
    with get_db() as conn:
        row = _fetch(conn, slug)
    out = _row_to_dict(row)
    if include_html:
        index = _dir_for(slug) / "index.html"
        out["html"] = index.read_text(encoding="utf-8") if index.exists() else ""
    return out


@router.get("/{slug}/render", response_class=HTMLResponse)
def render_graph(slug: str, v: Optional[int] = None, shell: int = 1) -> HTMLResponse:
    """The page itself, for an iframe or a browser tab.

    Served with a locked-down CSP because the document is model-written: see the
    module docstring. `v` opens an older version kept beside the current one.

    The stored file holds only what the agent wrote; `graph_shell.wrap` adds the
    masthead, the academic typography, the Thai face and the section tabs at
    render time, so a page written a month ago picks up today's format without
    being rewritten. `shell=0` returns the raw file — for judging what an agent
    actually produced.
    """
    with get_db() as conn:
        row = _fetch(conn, slug)
    folder = _dir_for(slug)
    path = folder / (f"v{v}.html" if v else "index.html")
    if not path.exists():
        raise HTTPException(404, f"no rendered page for '{slug}'" + (f" v{v}" if v else ""))
    raw = path.read_text(encoding="utf-8")
    meta = _row_to_dict(row)
    if v:
        meta["version"] = v
    body = raw if shell == 0 else graph_shell.wrap(raw, meta)
    return HTMLResponse(
        body,
        headers={
            "Content-Security-Policy": RENDER_CSP,
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-store",
        },
    )


# ── Write ────────────────────────────────────────────────────────────────────

@router.post("")
def create_graph(body: GraphCreate) -> dict:
    if body.kind not in VALID_KIND:
        raise HTTPException(400, f"kind must be one of {sorted(VALID_KIND)}")
    if not body.title.strip():
        raise HTTPException(400, "title is required")
    html = body.html or ""
    if not html.strip():
        raise HTTPException(400, "html is empty — nothing to render")
    if len(html.encode("utf-8")) > MAX_BYTES:
        raise HTTPException(413, f"page is over {MAX_BYTES // 1_000_000}MB")
    warnings = _lint_page(html)

    slug = _slugify(body.slug or body.title)
    now = _now()
    actor = current_actor()
    with get_db() as conn:
        if conn.execute("SELECT 1 FROM graphs WHERE slug = ?", (slug,)).fetchone():
            raise HTTPException(
                409, f"slug '{slug}' already exists — PATCH it to update, or pass a different slug"
            )
        gid = _uid()
        size = _write_page(slug, html, previous_version=None)
        conn.execute(
            """INSERT INTO graphs
               (id, slug, title, description, kind, symbol, thesis_id, zettel_refs,
                tags, as_of, sources, version, bytes, actor, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)""",
            (
                gid, slug, body.title.strip(), body.description, body.kind,
                (body.symbol or "").upper() or None, body.thesis_id, body.zettel_refs,
                body.tags, body.as_of, json.dumps(body.sources, ensure_ascii=False),
                size, actor, now, now,
            ),
        )
        if body.thesis_id:
            _log_event(
                conn, body.thesis_id, "GRAPH_ADDED",
                payload={"slug": slug, "graph_id": gid},
                note=body.title.strip(),
            )
        row = _fetch(conn, slug)
    out = _row_to_dict(row)
    _write_meta(slug, {k: v for k, v in out.items() if k != "html"})
    if warnings:
        out["warnings"] = warnings
    return out


@router.patch("/{slug}")
def update_graph(slug: str, body: GraphUpdate) -> dict:
    with get_db() as conn:
        row = _fetch(conn, slug)
        version = int(row["version"])
        fields: dict[str, Any] = {}
        for key in ("title", "description", "symbol", "thesis_id", "zettel_refs", "tags", "as_of"):
            val = getattr(body, key)
            if val is not None:
                fields[key] = val.upper() if key == "symbol" else val
        if body.sources is not None:
            fields["sources"] = json.dumps(body.sources, ensure_ascii=False)
        warnings: list[str] = []
        if body.html is not None:
            if not body.html.strip():
                raise HTTPException(400, "html is empty — nothing to render")
            if len(body.html.encode("utf-8")) > MAX_BYTES:
                raise HTTPException(413, f"page is over {MAX_BYTES // 1_000_000}MB")
            warnings = _lint_page(body.html)
            fields["bytes"] = _write_page(slug, body.html, previous_version=version)
            fields["version"] = version + 1
        if not fields:
            raise HTTPException(400, "nothing to update")
        fields["updated_at"] = _now()
        conn.execute(
            f"UPDATE graphs SET {', '.join(f'{k} = ?' for k in fields)} WHERE slug = ?",
            [*fields.values(), slug],
        )
        thesis_id = fields.get("thesis_id") or row["thesis_id"]
        if thesis_id:
            _log_event(
                conn, thesis_id, "GRAPH_UPDATED",
                payload={"slug": slug, "version": fields.get("version", version)},
                note=body.reason or "",
            )
        updated = _fetch(conn, slug)
    out = _row_to_dict(updated)
    _write_meta(slug, out)
    if warnings:
        out["warnings"] = warnings
    return out


@router.delete("/{slug}")
def delete_graph(slug: str) -> dict:
    """Soft delete — the row is hidden and the files stay on disk.

    There is no MCP tool for this on purpose: an agent adds analysis, a human
    decides what stops being part of the book.
    """
    with get_db() as conn:
        row = _fetch(conn, slug)
        conn.execute(
            "UPDATE graphs SET deleted_at = ?, updated_at = ? WHERE slug = ?",
            (_now(), _now(), slug),
        )
        if row["thesis_id"]:
            _log_event(conn, row["thesis_id"], "GRAPH_REMOVED", payload={"slug": slug})
    return {"ok": True, "slug": slug, "files_kept": str(_dir_for(slug))}
