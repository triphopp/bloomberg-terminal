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
* **"Changed" is judged per device.** Each manifest entry keeps `seen`, the sha
  every device last pushed or pulled for that slug. A local copy equal to what
  THIS device last saw is unchanged and takes a newer cloud page; the shared
  `sha` alone could not tell that (it is whoever pushed last), so before
  2026-09-27 an edit made on one machine was refused on the other as "local
  page also changed" and never arrived. Entries without `seen` (written before
  that) fall back to the old rule until a round records this device.
* **The cloud folder is `research/`** (2026-10-02; it was `graphs/`, named
  after the first pages). `adopt_legacy` runs before every push and pull: an
  old `graphs/` folder is renamed when `research/` does not exist yet, and when
  both exist — a peer still on older code keeps publishing into `graphs/` —
  its newer pages are copied across. Nothing is deleted from the old folder;
  once every machine runs this code it stops changing and can be removed by
  hand. The local folder (GRAPHS_DIR), the table and the API keep their names.
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

SUBDIR = "research"
LEGACY_SUBDIR = "graphs"
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


def _load(path: Path) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def adopt_legacy(root: Path) -> dict:
    """Bring pages published under the old `graphs/` cloud folder into `research/`.

    Returns {"renamed": bool, "adopted": [slugs]}. Never raises: a cloud folder
    that cannot be renamed right now (Drive still syncing it) is tried again on
    the next round, and the sync itself goes on.
    """
    old, new = root / LEGACY_SUBDIR, root / SUBDIR
    out: dict = {"renamed": False, "adopted": []}
    try:
        if not old.is_dir():
            return out
        if not new.exists():
            old.rename(new)
            logger.info("sync: cloud folder %s/ renamed to %s/", LEGACY_SUBDIR, SUBDIR)
            return {**out, "renamed": True}

        # Both exist: a peer on older code published into graphs/ after the
        # rename. Take a page only when its manifest entry is NEWER than ours
        # and the content differs — the old folder also holds stale copies of
        # everything this device has since republished under research/.
        theirs = _load(old / MANIFEST).get("pages")
        theirs = theirs if isinstance(theirs, dict) else {}
        manifest = _read_manifest(root)
        mine = manifest.get("pages") if isinstance(manifest.get("pages"), dict) else {}
        for slug, entry in theirs.items():
            page = old / slug / PAGE
            if not _safe_slug(slug) or not isinstance(entry, dict) or not page.exists():
                continue
            have = mine.get(slug) or {}
            if entry.get("sha") == have.get("sha"):
                continue
            if have and str(entry.get("updated_at") or "") <= str(have.get("updated_at") or ""):
                continue
            # Only a file the old manifest vouches for (Drive may be mid-upload).
            if _sha(page) != entry.get("sha"):
                continue
            target = new / slug / PAGE
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(page, target)
            # `seen` of the new folder is kept: it is what tells each device
            # whether ITS copy moved, and the old folder's is a different history.
            mine[slug] = {**entry, "seen": have.get("seen") or {}}
            out["adopted"].append(slug)
        if out["adopted"]:
            manifest["pages"] = mine
            manifest["updated_at"] = _now()
            _write_manifest(root, manifest)
            logger.info("sync: adopted %d page(s) from the old %s/ folder",
                        len(out["adopted"]), LEGACY_SUBDIR)
    except OSError as exc:
        logger.warning("sync: could not adopt the old %s/ folder: %s", LEGACY_SUBDIR, exc)
    return out


def push_files(root: Path, slugs: list[str], device: str) -> dict:
    """Copy local pages into the cloud folder for the given slugs.

    `slugs` comes from the `graphs` table (non-deleted rows), so a page whose
    row was removed stops being published without its file being deleted from
    either side.
    """
    adopt_legacy(root)
    manifest = _read_manifest(root)
    entries: dict = manifest.get("pages") if isinstance(manifest.get("pages"), dict) else {}
    sent, skipped = [], []
    marked = False

    for slug in slugs:
        if not _safe_slug(slug):
            skipped.append({"slug": slug, "why": "unsafe slug"})
            continue
        local = _graphs_dir() / slug / PAGE
        if not local.exists():
            continue
        local_sha = _sha(local)
        entry = entries.get(slug) or {}
        seen = entry.get("seen") if isinstance(entry.get("seen"), dict) else {}
        if entry.get("sha") == local_sha:
            if seen.get(device) != local_sha:  # in step — just record that we saw it
                entries[slug] = {**entry, "seen": {**seen, device: local_sha}}
                marked = True
            continue
        remote = root / SUBDIR / slug / PAGE
        # Another device published a different page under this slug and we have
        # not taken it yet: pull decides, not push.
        if remote.exists() and _sha(remote) != entry.get("sha") and entry.get("sha"):
            skipped.append({"slug": slug, "why": "remote changed too — pull first"})
            continue
        # The cloud moved past what we last saw AND our copy moved too (pull ran
        # first and would have taken it otherwise): both edited — keep both.
        mine = seen.get(device)
        if entry.get("sha") and mine and entry["sha"] != mine:
            skipped.append({"slug": slug, "why": "both devices changed the page"})
            continue
        remote.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(local, remote)
        entries[slug] = {
            "sha": local_sha,
            "bytes": local.stat().st_size,
            "device": device,
            "updated_at": _now(),
            "seen": {**seen, device: local_sha},
        }
        sent.append(slug)

    # `entries` is manifest["pages"] itself, so comparing the two can never
    # see a change — track it.
    if sent or marked:
        manifest["pages"] = entries
        manifest["updated_at"] = _now()
        _write_manifest(root, manifest)
    if skipped:
        logger.info("sync: %d graph page(s) skipped on push", len(skipped))
    return {"sent": sent, "skipped": skipped}


def pull_files(root: Path, slugs: list[str], device: str | None = None) -> dict:
    """Copy cloud pages down for slugs this device now has rows for.

    Called after the row merge, so `slugs` already reflects what the merged
    `graphs` table holds — a page nobody's row references is left in the cloud
    rather than restored. With `device`, what this device saw is recorded in the
    manifest (`seen`) so its next edit check is per device (module note).
    """
    adopt_legacy(root)
    manifest = _read_manifest(root)
    entries = manifest.get("pages") if isinstance(manifest.get("pages"), dict) else {}
    taken, skipped = [], []
    marked = False

    for slug in slugs:
        if not _safe_slug(slug):
            skipped.append({"slug": slug, "why": "unsafe slug"})
            continue
        remote = root / SUBDIR / slug / PAGE
        if not remote.exists():
            continue
        remote_sha = _sha(remote)
        entry = entries.get(slug) or {}
        seen = entry.get("seen") if isinstance(entry.get("seen"), dict) else {}
        local = _graphs_dir() / slug / PAGE
        if local.exists():
            local_sha = _sha(local)
            if local_sha != remote_sha:
                # Both sides moved since the last exchange — see the module note.
                known = seen.get(device) if device and device in seen else entry.get("sha")
                if known and local_sha != known:
                    skipped.append({"slug": slug, "why": "local page also changed"})
                    continue
                local.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(remote, local)
                taken.append(slug)
        else:
            local.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(remote, local)
            taken.append(slug)
        # Record only a copy the manifest vouches for: a remote file Drive has
        # not finished replacing must not become this device's baseline.
        if device and entry and remote_sha == entry.get("sha") and seen.get(device) != remote_sha:
            entries[slug] = {**entry, "seen": {**seen, device: remote_sha}}
            marked = True

    if marked:
        manifest["pages"] = entries
        _write_manifest(root, manifest)
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
