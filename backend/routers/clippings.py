"""
Obsidian clippings + Ollama AI endpoints — extracted from main.py.
"""
import json
import re
from pathlib import Path

import requests
import yaml
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator

from cache import TTLCache
from config import CLIPPINGS_DIR, OLLAMA_URL, OBSIDIAN_WIKI_DIR, THESES_DIR, SOURCES_DIR

router = APIRouter()

# ── Allowed roots for the `dir` override ──────────────────────────────────────
# Security: the `dir` query param is user-controlled. Without this whitelist an
# attacker could pass dir=C:/Windows (or any path) and read arbitrary files via
# the /content and /ai endpoints. Only directories inside these roots are served.
_ALLOWED_ROOTS: list[Path] = []
for _r in (CLIPPINGS_DIR, OBSIDIAN_WIKI_DIR, THESES_DIR, SOURCES_DIR):
    try:
        _ALLOWED_ROOTS.append(Path(_r).resolve())
    except Exception:
        pass


def _is_allowed_dir(p: Path) -> bool:
    """True if resolved path p is inside (or equal to) an allowed root."""
    try:
        rp = p.resolve()
    except Exception:
        return False
    for root in _ALLOWED_ROOTS:
        try:
            rp.relative_to(root)
            return True
        except ValueError:
            continue
    return False

# ── Module-level cache ──────────────────────────────────────��────────────────
_clippings_cache = TTLCache(ttl=60, maxsize=50)


# ── Helpers ───────────���──────────────────────────────────────────────────────

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


def _resolve_dir(dir_override: str = "") -> Path:
    """Return the effective clippings directory (override or global default).

    The override is validated against _ALLOWED_ROOTS to prevent arbitrary
    filesystem access. An override outside every allowed root is rejected.
    """
    if dir_override.strip():
        candidate = Path(dir_override.strip())
        if not _is_allowed_dir(candidate):
            raise HTTPException(status_code=403, detail="Directory not allowed")
        return candidate
    return CLIPPINGS_DIR


def _safe_path(filename: str, base: Path | None = None) -> Path:
    """Resolve and validate that the file is inside the clippings dir."""
    base = base or CLIPPINGS_DIR
    target = (base / filename).resolve()
    try:
        target.relative_to(base.resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied")
    return target


def _strip_images(md: str) -> str:
    """Remove markdown image syntax before sending to Ollama to save tokens."""
    return re.sub(r"!\[.*?\]\([^)]*\)", "", md)


# ── Pydantic models ─────────────────────��────────────────────────────────────

_VALID_MODEL_RE = re.compile(r'^[a-zA-Z0-9]([a-zA-Z0-9._:\-]{0,98}[a-zA-Z0-9])?$')


class ClippingsAiRequest(BaseModel):
    file: str
    action: str          # summarize | translate_th | custom
    model: str = "llama3.2"
    custom_prompt: str = ""
    dir: str = ""

    @field_validator("model")
    @classmethod
    def validate_model(cls, v: str) -> str:
        if not _VALID_MODEL_RE.match(v):
            raise ValueError("Invalid model name")
        return v


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/api/clippings")
def list_clippings(q: str = Query(default=""), dir: str = Query(default="")):
    """List all .md files in CLIPPINGS_DIR (or override dir) with frontmatter metadata."""
    effective_dir = _resolve_dir(dir)
    cache_key = f"clippings:list:{effective_dir}"
    cached = _clippings_cache.get(cache_key)
    if cached is not None:
        items: list[dict] = cached
    else:
        if not effective_dir.exists():
            return {"clippings": [], "dir": str(effective_dir), "error": f"Directory not found: {effective_dir}"}
        items = []
        for path in sorted(effective_dir.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True):
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
                fm, body = _parse_frontmatter(text)
                clean_preview = _strip_images(body)[:200].strip()
                items.append({
                    "file": path.name,
                    "title": fm.get("title") or path.stem,
                    "source": fm.get("source") or fm.get("url") or "",
                    "author": fm.get("author") or "",
                    "published": str(fm.get("published") or fm.get("created") or ""),
                    "tags": fm.get("tags") or [],
                    "description": fm.get("description") or "",
                    "preview": clean_preview,
                    "char_count": len(body),
                })
            except Exception as exc:
                print(f"[clippings] {path.name}: {exc}")
        _clippings_cache.set(cache_key, items)

    if q:
        ql = q.lower()
        items = [
            i for i in items
            if ql in i["title"].lower()
            or ql in i["preview"].lower()
            or any(ql in str(t).lower() for t in i["tags"])
        ]
    return {"clippings": items, "dir": str(effective_dir)}


@router.get("/api/clippings/content")
def get_clipping_content(file: str = Query(...), dir: str = Query(default="")):
    """Return full content + parsed frontmatter of a single clipping."""
    effective_dir = _resolve_dir(dir)
    filepath = _safe_path(file, effective_dir)
    if not filepath.exists() or filepath.suffix != ".md":
        raise HTTPException(status_code=404, detail="File not found")
    text = filepath.read_text(encoding="utf-8", errors="replace")
    fm, body = _parse_frontmatter(text)
    return {
        "file": file,
        "title": fm.get("title") or filepath.stem,
        "source": fm.get("source") or fm.get("url") or "",
        "author": fm.get("author") or "",
        "published": str(fm.get("published") or fm.get("created") or ""),
        "tags": fm.get("tags") or [],
        "body": body,
        "char_count": len(body),
    }


@router.post("/api/clippings/ai")
def clippings_ai(req: ClippingsAiRequest):
    """Stream AI response from Ollama for a clipping (summarize / translate / custom)."""
    effective_dir = _resolve_dir(req.dir)
    filepath = _safe_path(req.file, effective_dir)
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="File not found")

    text = filepath.read_text(encoding="utf-8", errors="replace")
    fm, body = _parse_frontmatter(text)
    title = fm.get("title") or filepath.stem
    # Strip images and cap length to avoid overwhelming smaller models
    snippet = _strip_images(body)[:8_000]

    if req.action == "summarize":
        prompt = (
            f"Please summarize the following article in 5-7 clear bullet points.\n"
            f"Focus on key insights and important facts. Be concise.\n\n"
            f"Title: {title}\n\n{snippet}"
        )
    elif req.action == "translate_th":
        prompt = (
            f"Please translate the following content into Thai (ภาษาไท��).\n"
            f"Maintain a natural Thai writing style and preserve all key information.\n\n"
            f"Title: {title}\n\n{snippet}"
        )
    elif req.action == "custom" and req.custom_prompt:
        prompt = f"{req.custom_prompt}\n\n{snippet}"
    else:
        raise HTTPException(status_code=400, detail="Invalid action or missing custom_prompt")

    def _stream():
        try:
            with requests.post(
                f"{OLLAMA_URL}/api/generate",
                json={"model": req.model, "prompt": prompt, "stream": True},
                stream=True,
                timeout=180,
            ) as r:
                if not r.ok:
                    yield f"data: {json.dumps({'error': f'Ollama returned {r.status_code}', 'done': True})}\n\n"
                    return
                for line in r.iter_lines():
                    if not line:
                        continue
                    chunk = json.loads(line)
                    yield f"data: {json.dumps({'token': chunk.get('response', ''), 'done': chunk.get('done', False)})}\n\n"
                    if chunk.get("done"):
                        break
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc), 'done': True})}\n\n"

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/api/clippings/ai/models")
def ollama_models():
    """List models available in the local Ollama instance."""
    try:
        res = requests.get(f"{OLLAMA_URL}/api/tags", timeout=5)
        if not res.ok:
            return {"models": [], "error": f"Ollama returned {res.status_code}", "ollama_url": OLLAMA_URL}
        models = [m["name"] for m in res.json().get("models", [])]
        return {"models": models, "ollama_url": OLLAMA_URL}
    except Exception as exc:
        return {"models": [], "error": f"Cannot reach Ollama: {exc}", "ollama_url": OLLAMA_URL}
