"""
Cloud sync for the rendered analysis pages that the `graphs` rows point at.

A graph is two things: a row in SQLite (title, symbol, thesis, version) and an
HTML file on disk under GRAPHS_DIR. The row travels in the ordinary snapshot;
without this module the file does not, so a second machine pulls an index of
pages it cannot open — the GRAPHS tab lists four analyses and renders 404 for
every one.

Design, and why:

* **Only `index.html` travels.** The `v<N>.html` history stays on the machine
  that made the edit (and in git, where it belongs). Versions are a local audit
  trail; shipping them would multiply the cloud folder by the number of
  revisions for something nobody opens across devices.
* **Content hash, not mtime, decides equality.** Google Drive rewrites mtimes on
  its own schedule, so an mtime comparison copies files forever.
* **A newer local file is never clobbered.** When both sides changed, the copy
  is skipped and reported — the row-level merge already decided which row wins,
  and silently overwriting a page the user just wrote on this machine is the one
  outcome that loses work. The skipped pair is surfaced in the push/pull result.
* **A slug is a path segment.** It is validated the same way the router does,
  because a snapshot arrives from another machine and a '..' in it would let a
  peer write anywhere on disk.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

SUBDIR = "graphs"
MANIFEST = "manifest.json"
PAGE = "index.html"

# Same alphabet the router's _slugify produces. Anything else is refused rather
# than sanitized: a name we have to repair did not come from our writer.
_SLUG_OK = re.compile(r"^[a-z0-9][a-z0-9-]{0,59}$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _graphs_dir() -> Path:
    from config import GRAPHS_DIR

    return GRAPHS_DIR


def _read_manifest(root: Path) -> dict:
    path = root / SUBDIR / MANIFEST
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_manifest(root: Path, data: dict) -> None:
    from .snapshot import write_json

    write_json(root / SUBDIR / MANIFEST, data)


def _safe_slug(slug: str) -> bool:
    return bool(_SLUG_OK.match(slug or ""))


def push_files(root: Path, slugs: list[str], device: str) -> dict:
    """Copy local pages into the cloud folder for the given slugs.

    `slugs` comes from the `graphs` table (non-deleted rows), so a page whose
    row was removed stops being published without its file being deleted from
    either side.
    """
    manifest = _read_manifest(root)
    entries: dict = manifest.get("pages") if isinstance(manifest.get("pages"), dict) else {}
    sent, skipped = [], []

    for slug in slugs:
        if not _safe_slug(slug):
            skipped.append({"slug": slug, "why": "unsafe slug"})
            continue
        local = _graphs_dir() / slug / PAGE
        if not local.exists():
            continue
        local_sha = _sha(local)
        entry = entries.get(slug) or {}
        if entry.get("sha") == local_sha:
            continue
        remote = root / SUBDIR / slug / PAGE
        # Another device published a different page under this slug and we have
        # not taken it yet: pull decides, not push.
        if remote.exists() and _sha(remote) != entry.get("sha") and entry.get("sha"):
            skipped.append({"slug": slug, "why": "remote changed too — pull first"})
            continue
        remote.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(local, remote)
        entries[slug] = {
            "sha": local_sha,
            "bytes": local.stat().st_size,
            "device": device,
            "updated_at": _now(),
        }
        sent.append(slug)

    if sent or entries != manifest.get("pages"):
        manifest["pages"] = entries
        manifest["updated_at"] = _now()
        _write_manifest(root, manifest)
    if skipped:
        logger.info("sync: %d graph page(s) skipped on push", len(skipped))
    return {"sent": sent, "skipped": skipped}


def pull_files(root: Path, slugs: list[str]) -> dict:
    """Copy cloud pages down for slugs this device now has rows for.

    Called after the row merge, so `slugs` already reflects what the merged
    `graphs` table holds — a page nobody's row references is left in the cloud
    rather than restored.
    """
    manifest = _read_manifest(root)
    entries = manifest.get("pages") if isinstance(manifest.get("pages"), dict) else {}
    taken, skipped = [], []

    for slug in slugs:
        if not _safe_slug(slug):
            skipped.append({"slug": slug, "why": "unsafe slug"})
            continue
        remote = root / SUBDIR / slug / PAGE
        if not remote.exists():
            continue
        remote_sha = _sha(remote)
        local = _graphs_dir() / slug / PAGE
        if local.exists():
            local_sha = _sha(local)
            if local_sha == remote_sha:
                continue
            # Both sides moved since the last exchange — see the module note.
            known = (entries.get(slug) or {}).get("sha")
            if known and local_sha != known:
                skipped.append({"slug": slug, "why": "local page also changed"})
                continue
        local.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(remote, local)
        taken.append(slug)

    if skipped:
        logger.info("sync: %d graph page(s) skipped on pull", len(skipped))
    return {"taken": taken, "skipped": skipped}


def live_slugs(conn) -> list[str]:
    """Slugs of the pages that currently belong to the book."""
    try:
        rows = conn.execute(
            "SELECT slug FROM graphs WHERE deleted_at IS NULL ORDER BY slug"
        ).fetchall()
    except Exception:  # table not created yet on an older peer
        return []
    return [r["slug"] for r in rows]
