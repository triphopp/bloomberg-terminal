"""ASK conversations kept as files — never inside the repository.

The page keeps the conversation it is in across a reload (sessionStorage). This
is the other half: every conversation saved as a file, so an earlier one can be
opened again, on this machine or on the other one.

**Where** is decided per machine (backend/.env, set from ASK → HISTORY or with
`python scripts/ask_sessions.py`):

    ASK_SESSIONS_DIR     an explicit folder — wins over everything below
    ASK_SESSIONS_STORE   auto (default) | drive | local | off
        drive  <cloud folder>/ask-sessions — the Google Drive folder the portfolio
               already syncs through (sync.config.sync_dir(): SYNC_DIR, or found
               by itself). Both machines see the same conversations.
        local  the user's app-data folder on this machine.
        auto   drive when this machine has the cloud folder, else local.
        off    nothing is written; the page still survives a reload.

A folder inside the repository is refused: a conversation holds what the model
read — the portfolio, a thesis — and must not be one `git add .` from a commit.

**Format.** `<root>/<YYYY-MM>/<id>.json`, one conversation each, `id` =
`YYYYMMDD-HHMMSS-xxxxxx` so names sort by time and nothing has to be indexed —
an index is one file two machines would both rewrite. Pictures are files beside
it (`<id>.<message>-<n>.jpg`), not base64 inside the JSON. Writes go through a
temp file and a rename, so the other machine never reads half a conversation.

**Delete** moves the files to `<root>/_deleted/` (HISTORY → TRASH), from where
they can be restored. Only `purge` erases, and only what is already in the trash
— so nothing is ever erased in one step from the list.
"""
from __future__ import annotations

import base64
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from sync import config as sync_config

router = APIRouter()

REPO_ROOT = Path(__file__).resolve().parent.parent
_ENV_FILE = Path(__file__).resolve().parent / ".env"

SUBDIR = "ask-sessions"
TRASH = "_deleted"
STORES = ("auto", "drive", "local", "off")

_ID_RE = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{6}$")
_DATA_URL_RE = re.compile(r"^data:image/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$")
_EXT = {"jpeg": "jpg", "png": "png", "webp": "webp", "gif": "gif"}
_MIME = {v: k for k, v in _EXT.items()}

# What of a message is kept. Anything else the page sends is dropped.
_KEEP = ("role", "content", "at", "tools", "sources", "error", "model", "private", "lostImages")
_MAX_MESSAGES = 400
_MAX_CONTENT = 80_000
_LIST_LIMIT = 80


# ── Where ────────────────────────────────────────────────────────────────────

def _setting(name: str) -> str:
    """backend/.env, re-read on every call, then the environment.

    The file first — the other way round from most settings — because both the
    panel and scripts/ask_sessions.py change it while the backend is running,
    and the backend's own environment still holds what the file said when it
    started. A change applies to the next request, without a restart."""
    try:
        from dotenv import dotenv_values

        in_file = dotenv_values(_ENV_FILE)
    except Exception:
        in_file = {}
    value = in_file[name] if name in in_file else os.getenv(name)
    return (value or "").strip().strip("'\"").strip()


def local_dir() -> Path:
    """This machine's own folder for the app's data — per user, outside any repository."""
    if sys.platform == "win32":
        base = Path(os.getenv("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        return base / "BloombergTerminal" / SUBDIR
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "BloombergTerminal" / SUBDIR
    return Path(os.getenv("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "bloomberg-terminal" / SUBDIR


def drive_dir() -> Path | None:
    """`ask-sessions` inside the cloud folder, when this machine has that folder."""
    try:
        root = sync_config.sync_dir()
    except Exception:
        root = None
    return root / SUBDIR if root and root.is_dir() else None


def _inside_repo(path: Path) -> bool:
    try:
        path.resolve().relative_to(REPO_ROOT)
        return True
    except (ValueError, OSError):
        return False


def resolve() -> dict:
    """Where conversations go on this machine, and why. Never raises."""
    choice = _setting("ASK_SESSIONS_STORE").lower() or "auto"
    if choice not in STORES:
        choice = "auto"
    explicit = _setting("ASK_SESSIONS_DIR")
    drive, local = drive_dir(), local_dir()

    store: str
    folder: Path | None
    reason: str | None = None
    if explicit:
        store, folder = "custom", Path(explicit)
        if not folder.is_absolute():
            folder, reason = None, "ASK_SESSIONS_DIR must be a full path"
        elif _inside_repo(folder):
            folder, reason = None, "ASK_SESSIONS_DIR is inside the repository — conversations are not kept there"
    elif choice == "off":
        store, folder = "off", None
    elif choice == "local":
        store, folder = "local", local
    elif choice == "drive":
        store, folder = "drive", drive
        if folder is None:
            store, folder = "local", local
            reason = "the Google Drive folder is not on this machine right now — saving on this machine instead"
    else:
        store, folder = ("drive", drive) if drive else ("local", local)

    return {
        "store": store,                 # what is in effect: drive | local | custom | off
        "choice": "custom" if explicit else choice,
        "dir": str(folder) if folder else None,
        "reason": reason,
        "drive_dir": str(drive) if drive else None,
        "local_dir": str(local),
        "device": sync_config.device_id(),
    }


def _root() -> Path:
    cfg = resolve()
    if not cfg["dir"]:
        raise HTTPException(409, cfg["reason"] or "conversation history is off on this machine")
    root = Path(cfg["dir"])
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(503, f"cannot use {root}: {exc.strerror or exc}") from exc
    return root


# ── Files ────────────────────────────────────────────────────────────────────

def _file(root: Path, sid: str) -> Path:
    if not _ID_RE.match(sid or ""):
        raise HTTPException(422, "not a conversation id")
    return root / f"{sid[:4]}-{sid[4:6]}" / f"{sid}.json"


def _write(path: Path, data: Any, binary: bool = False) -> None:
    """Temp file in the same folder, then rename: a reader never sees half of it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        if binary:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
        else:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _clean(message: Any) -> dict | None:
    if not isinstance(message, dict) or message.get("role") not in ("user", "assistant"):
        return None
    if not isinstance(message.get("content"), str):
        return None
    out = {k: message[k] for k in _KEEP if message.get(k) not in (None, "", [], {})}
    out["role"], out["content"] = message["role"], message["content"][:_MAX_CONTENT]
    return out


def _meta(sid: str, data: dict) -> dict:
    messages = data.get("messages") or []
    questions = [m for m in messages if m.get("role") == "user"]
    return {
        "id": sid,
        "title": (questions[0]["content"] if questions else "").strip().replace("\n", " ")[:140],
        "created_at": data.get("created_at"),
        "updated_at": data.get("updated_at"),
        "questions": len(questions),
        "private": any(m.get("private") for m in messages),
        "pinned": bool(data.get("pinned")),
        "device": data.get("device"),
        "page": data.get("page"),
    }


def save(sid: str, messages: list, page: str | None = None, model: str | None = None) -> dict:
    """Write one conversation. Pictures arrive as data URLs and are stored as files."""
    root = _root()
    path = _file(root, sid)
    kept: list[dict] = []
    for index, raw in enumerate(messages[:_MAX_MESSAGES]):
        message = _clean(raw)
        if message is None or raw.get("pending"):
            continue    # an answer still streaming is not a record of anything yet
        names: list[str] = []
        lost = 0
        for n, url in enumerate((raw.get("images") or [])[:4] if message["role"] == "user" else []):
            match = _DATA_URL_RE.match(url) if isinstance(url, str) else None
            if not match:
                lost += 1
                continue
            name = f"{sid}.{index}-{n}.{_EXT[match.group(1)]}"
            target = path.parent / name
            blob = base64.b64decode(match.group(2))
            # Written once: a conversation is saved after every answer.
            if not (target.exists() and target.stat().st_size == len(blob)):
                _write(target, blob, binary=True)
            names.append(name)
        if names:
            message["image_files"] = names
        if lost:
            message["lostImages"] = int(message.get("lostImages") or 0) + lost
        kept.append(message)
    if not any(m["role"] == "user" for m in kept):
        raise HTTPException(422, "nothing to save")

    created, pinned = None, False
    if path.exists():
        try:
            before = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            before = {}
        # The page saves on every reload and every time a conversation is opened.
        # One that has not changed is left alone: its time and its machine are
        # when and where it was last added to, not when it was last looked at.
        if before.get("messages") == kept:
            return _meta(sid, before)
        created, pinned = before.get("created_at"), bool(before.get("pinned"))
    data = {
        "v": 1, "id": sid,
        "created_at": created or _now(), "updated_at": _now(),
        # Set from HISTORY (pin()); the page never sends it, so it is carried over.
        **({"pinned": True} if pinned else {}),
        "device": sync_config.device_id(), "page": (page or "")[:40] or None, "model": (model or "")[:120] or None,
        "messages": kept,
    }
    _write(path, data)
    return _meta(sid, data)


def _read(sid: str) -> tuple[Path, dict]:
    path = _file(_root(), sid)
    try:
        return path, json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise HTTPException(404, "no such conversation") from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(503, f"cannot read the conversation: {exc.__class__.__name__}") from exc


def load(sid: str) -> dict:
    """One conversation as the page holds it: pictures back as data URLs."""
    path, data = _read(sid)
    messages = []
    for message in data.get("messages") or []:
        message = dict(message)
        names = message.pop("image_files", None) or []
        images, lost = [], int(message.get("lostImages") or 0)
        for name in names:
            target = path.parent / Path(str(name)).name      # a name, never a path
            ext = target.suffix.lstrip(".").lower()
            try:
                images.append(f"data:image/{_MIME[ext]};base64,{base64.b64encode(target.read_bytes()).decode()}")
            except (OSError, KeyError):
                lost += 1     # not downloaded yet, or removed by hand
        if images:
            message["images"] = images
        if lost:
            message["lostImages"] = lost
        messages.append(message)
    return {**_meta(sid, data), "model": data.get("model"), "messages": messages}


_PIN_SCAN = 240            # files looked through, past the newest, for pinned ones


def list_sessions(limit: int = _LIST_LIMIT) -> list[dict]:
    """The newest conversations, and any pinned one older than those. Names sort
    by time, so only that many files are opened — plus up to _PIN_SCAN more
    while looking for pins (a pin lives in its file; there is no index)."""
    root = _root()
    out: list[dict] = []
    opened = 0
    months = sorted((d for d in root.iterdir() if d.is_dir() and re.fullmatch(r"\d{4}-\d{2}", d.name)), reverse=True)
    for month in months:
        for path in sorted(month.glob("*.json"), reverse=True):
            sid = path.stem
            if not _ID_RE.match(sid):
                continue    # a "(1)" conflict copy from the cloud client, or someone's own file
            if opened >= limit + _PIN_SCAN:
                return out
            opened += 1
            try:
                meta = _meta(sid, json.loads(path.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                continue    # half-synced: it will read on a later look
            if len(out) < limit or meta["pinned"]:
                out.append(meta)
    return out


def pin(sid: str, pinned: bool) -> dict:
    """Pin or unpin. Its time is left alone: a pin is not an addition to the conversation."""
    path, data = _read(sid)
    if pinned:
        data["pinned"] = True
    else:
        data.pop("pinned", None)
    _write(path, data)
    return _meta(sid, data)


# ── Read by ASK itself (search_sessions / read_session in routers/news_ai.py) ─

_SCAN_FILES = 400          # files one search opens at most, newest first
_SEARCH_HITS = 12
_SNIPPET = 140             # characters each side of a match
_QUESTION_CHARS = 2_000
_ANSWER_CHARS = 4_000


def stamp(at: Any) -> str | None:
    """A message's `at` (epoch ms, set by the browser) as local `YYYY-MM-DD HH:MM`."""
    try:
        return datetime.fromtimestamp(float(at) / 1000).astimezone().strftime("%Y-%m-%d %H:%M")
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _exchanges(messages: list[dict]) -> list[tuple[dict, dict | None]]:
    """Each question with the answer that followed it (None when there was none)."""
    out: list[tuple[dict, dict | None]] = []
    for m in messages:
        if m.get("role") == "user":
            out.append((m, None))
        elif out and out[-1][1] is None:
            out[-1] = (out[-1][0], m)
    return out


def _snippets(text: str, word: str, limit: int = 2) -> list[str]:
    low, out, start = text.lower(), [], 0
    while len(out) < limit:
        i = low.find(word, start)
        if i < 0:
            break
        a, b = max(0, i - _SNIPPET), min(len(text), i + len(word) + _SNIPPET)
        out.append(("…" if a else "") + " ".join(text[a:b].split()) + ("…" if b < len(text) else ""))
        start = b
    return out


def search(query: str, days: int, current: str | None = None) -> dict:
    """Saved conversations whose questions or answers hold every word of `query`,
    last added to within `days`, newest first. An empty query lists the latest."""
    root = _root()
    words = [w for w in query.lower().split() if w][:8]
    cutoff = (datetime.now().astimezone() - timedelta(days=days)).isoformat(timespec="seconds")
    hits: list[dict] = []
    scanned = 0
    months = sorted((d for d in root.iterdir() if d.is_dir() and re.fullmatch(r"\d{4}-\d{2}", d.name)), reverse=True)
    for month in months:
        for path in sorted(month.glob("*.json"), reverse=True):
            if scanned >= _SCAN_FILES or len(hits) >= _SEARCH_HITS:
                break
            sid = path.stem
            if not _ID_RE.match(sid):
                continue
            scanned += 1
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if (data.get("updated_at") or "") < cutoff:
                continue
            messages = data.get("messages") or []
            found: list[dict] = []
            if words:
                text = "\n".join(m.get("content") or "" for m in messages).lower()
                if not all(w in text for w in words):
                    continue
                for m in messages:
                    for s in _snippets(m.get("content") or "", words[0]):
                        found.append({"role": m.get("role"), "asked": stamp(m.get("at")), "text": s})
                found = found[:4]
            meta = _meta(sid, data)
            hit = {k: meta[k] for k in ("id", "title", "created_at", "updated_at", "questions")}
            if sid == current:
                hit["current"] = True     # the conversation this question is in
            if found:
                hit["matches"] = found
            hits.append(hit)
    hits.sort(key=lambda h: h.get("updated_at") or "", reverse=True)
    return {"query": query, "days": days, "sessions": hits, "scanned": scanned}


def transcript(sid: str, start: int, room: int) -> dict:
    """One conversation as text for the model: each exchange with when it was
    asked. No pictures, tools or sources. Stops before `room` characters and
    says where to continue."""
    _, data = _read(sid)
    pairs = _exchanges(data.get("messages") or [])
    items: list[dict] = []
    used, resume = 0, None
    for n, (q, a) in enumerate(pairs, 1):
        if n < start:
            continue
        item: dict[str, Any] = {"n": n, "asked": stamp(q.get("at")), "question": q.get("content", "")[:_QUESTION_CHARS]}
        pictures = len(q.get("image_files") or []) + int(q.get("lostImages") or 0)
        if pictures:
            item["pictures"] = pictures
        if a is None:
            item["answer"] = None
        else:
            text = a.get("content") or ""
            item["answer"] = text[:_ANSWER_CHARS] + ("\n… [answer cut here]" if len(text) > _ANSWER_CHARS else "")
            if a.get("error"):
                item["error"] = a["error"]
        size = len(json.dumps(item, ensure_ascii=False))
        if items and used + size > room:
            resume = n
            break
        items.append(item)
        used += size
    return {
        "id": sid,
        "title": _meta(sid, data)["title"],
        "created_at": data.get("created_at"),
        "updated_at": data.get("updated_at"),
        "exchanges": len(pairs),
        "items": items,
        "continue_from": resume,
    }


def remove(sid: str) -> dict:
    """Out of the list, into `_deleted/`. Nothing is erased."""
    root = _root()
    path = _file(root, sid)
    if not path.exists():
        raise HTTPException(404, "no such conversation")
    trash = root / TRASH
    trash.mkdir(parents=True, exist_ok=True)
    moved = 0
    for item in [path, *path.parent.glob(f"{sid}.*")]:
        if item.exists():
            shutil.move(str(item), str(trash / item.name))
            moved += 1
    # A rename keeps the old time; the trash is ordered by when it went in.
    os.utime(trash / f"{sid}.json")
    return {"id": sid, "moved_to": str(trash), "files": moved}


def _trashed(root: Path, sid: str) -> Path:
    if not _ID_RE.match(sid or ""):
        raise HTTPException(422, "not a conversation id")
    path = root / TRASH / f"{sid}.json"
    if not path.exists():
        raise HTTPException(404, "not in the trash")
    return path


def list_trash(limit: int = _LIST_LIMIT) -> list[dict]:
    """What DELETE moved aside, most recently deleted first."""
    trash = _root() / TRASH
    if not trash.is_dir():
        return []
    files = [p for p in trash.glob("*.json") if _ID_RE.match(p.stem)]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    out: list[dict] = []
    for path in files[:limit]:
        try:
            meta = _meta(path.stem, json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue
        meta["deleted_at"] = datetime.fromtimestamp(path.stat().st_mtime).astimezone().isoformat(timespec="seconds")
        out.append(meta)
    return out


def restore(sid: str) -> dict:
    """Back from `_deleted/` into its month folder, pictures with it."""
    root = _root()
    path = _trashed(root, sid)
    target = _file(root, sid)
    if target.exists():
        raise HTTPException(409, "a conversation with this id is already in the list")
    target.parent.mkdir(parents=True, exist_ok=True)
    for item in [path, *(root / TRASH).glob(f"{sid}.*")]:
        if item.exists():
            shutil.move(str(item), str(target.parent / item.name))
    return _meta(sid, json.loads(target.read_text(encoding="utf-8")))


def purge(sid: str) -> dict:
    """Erase a conversation for good — only one that is already in the trash, so
    nothing is ever erased in one step from the list."""
    root = _root()
    path = _trashed(root, sid)
    gone = 0
    for item in [path, *(root / TRASH).glob(f"{sid}.*")]:
        if item.exists():
            item.unlink()
            gone += 1
    return {"id": sid, "files": gone}


def configure(store: str | None, folder: str | None) -> dict:
    """Set where this machine keeps conversations (backend/.env)."""
    from routers import news_ai     # its .env writer; imported here, it imports this module

    updates: dict[str, str] = {}
    folder = (folder or "").strip().strip("'\"").strip()
    if folder:
        path = Path(folder)
        if not path.is_absolute():
            raise HTTPException(422, "give the folder as a full path")
        if _inside_repo(path):
            raise HTTPException(422, "that folder is inside the repository — pick one outside it")
        try:
            path.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise HTTPException(422, f"cannot create {path}: {exc.strerror or exc}") from exc
        updates = {"ASK_SESSIONS_DIR": str(path), "ASK_SESSIONS_STORE": "auto"}
    else:
        store = (store or "").strip().lower()
        if store not in STORES:
            raise HTTPException(422, f"store is one of {', '.join(STORES)} — or give a folder")
        updates = {"ASK_SESSIONS_STORE": store, "ASK_SESSIONS_DIR": ""}
    news_ai._write_env(updates)
    return resolve()


# ── HTTP ─────────────────────────────────────────────────────────────────────

class SessionIn(BaseModel):
    messages: list[dict] = Field(default_factory=list)
    page: str | None = None
    model: str | None = None


class ConfigIn(BaseModel):
    store: str | None = Field(default=None, max_length=20)
    dir: str | None = Field(default=None, max_length=400)


@router.get("/api/news/ask/sessions")
def sessions_list():
    """The newest conversations and where they are kept. An unusable folder is a
    state to show, not an error: the list is empty and `reason` says why."""
    cfg = resolve()
    if not cfg["dir"]:
        return {**cfg, "sessions": []}
    try:
        return {**cfg, "sessions": list_sessions()}
    except HTTPException as exc:
        return {**cfg, "sessions": [], "reason": str(exc.detail)}
    except OSError as exc:
        return {**cfg, "sessions": [], "reason": f"cannot read {cfg['dir']}: {exc.strerror or exc}"}


@router.get("/api/news/ask/sessions/config")
def sessions_config():
    return resolve()


@router.post("/api/news/ask/sessions/config")
def sessions_configure(body: ConfigIn, request: Request):
    """Where this machine keeps conversations. From this machine only, like the API key."""
    client = request.client.host if request.client else ""
    if client not in ("127.0.0.1", "::1", "localhost", "testclient"):
        raise HTTPException(403, "storage can only be set from this machine")
    return configure(body.store, body.dir)


# The trash — declared before /{sid} so "trash" is never read as an id.
@router.get("/api/news/ask/sessions/trash")
def trash_list():
    return {"sessions": list_trash()}


@router.post("/api/news/ask/sessions/trash/{sid}/restore")
def trash_restore(sid: str):
    return restore(sid)


@router.delete("/api/news/ask/sessions/trash/{sid}")
def trash_purge(sid: str):
    return purge(sid)


@router.get("/api/news/ask/sessions/{sid}")
def session_get(sid: str):
    return load(sid)


@router.put("/api/news/ask/sessions/{sid}")
def session_put(sid: str, body: SessionIn):
    return save(sid, body.messages, body.page, body.model)


class PinIn(BaseModel):
    pinned: bool


@router.patch("/api/news/ask/sessions/{sid}")
def session_pin(sid: str, body: PinIn):
    return pin(sid, body.pinned)


@router.delete("/api/news/ask/sessions/{sid}")
def session_delete(sid: str):
    return remove(sid)
