"""
Sync orchestration: startup pull, background push, status, conflict handling.

Flow:
  sync_startup()  → pull() then push()  → our device file == merged union
  pull()  : read every device snapshot from cloud → merge → restore into local
  push()  : export local → write snapshots/<device>.json (+ manifest, daily backup)

All cloud I/O is fail-soft. If SYNC_DIR is offline / unmounted the app keeps
running local-only; sync simply resumes when the drive comes back.
"""
import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from . import config as cfg
from .merge import merge_snapshots
from .restore import restore
from .snapshot import compute_hash, export_snapshot, read_snapshot, write_json

logger = logging.getLogger("sync")

_STATE_FILE = Path(__file__).resolve().parent.parent / ".sync_state.json"
_lock = threading.Lock()
_bg_started = False


# ── local state (base hash + last sync times) ────────────────────────────────
def _load_state() -> dict:
    try:
        with open(_STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _save_state(state: dict) -> None:
    try:
        write_json(_STATE_FILE, state)
    except OSError:
        logger.warning("could not persist sync state")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── cloud layout ─────────────────────────────────────────────────────────────
def _dirs() -> dict[str, Path]:
    base = cfg.sync_dir()
    return {
        "base":      base,
        "snapshots": base / "snapshots",
        "conflicts": base / "conflicts",
        "backups":   base / "backups",
        "manifest":  base / "manifest.json",
    }


def _ensure_dirs(d: dict[str, Path]) -> None:
    for key in ("snapshots", "conflicts", "backups"):
        d[key].mkdir(parents=True, exist_ok=True)


# ── public ops ───────────────────────────────────────────────────────────────
def pull() -> dict:
    if not cfg.enabled():
        return {"status": "disabled"}
    d = _dirs()
    if not d["base"].exists():
        return {"status": "offline", "reason": "SYNC_DIR not reachable"}

    with _lock:
        _ensure_dirs(d)
        snaps = []
        for f in sorted(d["snapshots"].glob("*.json")):
            snap = read_snapshot(f)
            if snap:
                snaps.append(snap)
            else:
                logger.warning("skip unreadable snapshot %s", f.name)
        if not snaps:
            return {"status": "empty", "applied": 0}

        merged, tombs, conflicts = merge_snapshots(snaps)

        from db import get_db
        with get_db() as conn:
            applied = restore(conn, merged, tombs)

        if conflicts:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            write_json(d["conflicts"] / f"conflict-{stamp}-{cfg.device_id()}.json",
                       {"generated_at": _now(), "conflicts": conflicts})
            logger.info("sync: %d conflict row(s) preserved", len(conflicts))

        state = _load_state()
        state["last_pull"] = _now()
        state["last_conflicts"] = len(conflicts)
        _save_state(state)
        return {"status": "ok", "applied": applied,
                "devices": len(snaps), "conflicts": len(conflicts)}


def push() -> dict:
    if not cfg.enabled():
        return {"status": "disabled"}
    d = _dirs()
    if not d["base"].exists():
        return {"status": "offline", "reason": "SYNC_DIR not reachable"}

    with _lock:
        _ensure_dirs(d)
        device = cfg.device_id()
        from db import get_db
        with get_db() as conn:
            snap = export_snapshot(conn, device)

        state = _load_state()
        if snap["hash"] == state.get("last_push_hash"):
            return {"status": "unchanged"}

        write_json(d["snapshots"] / f"{device}.json", snap)

        # daily rolling backup
        day = datetime.now(timezone.utc).strftime("%Y%m%d")
        write_json(d["backups"] / f"{device}-{day}.json", snap)

        # manifest pointer
        manifest = {}
        if d["manifest"].exists():
            try:
                with open(d["manifest"], encoding="utf-8") as f:
                    manifest = json.load(f)
            except (OSError, json.JSONDecodeError):
                manifest = {}
        manifest.setdefault("schema_ver", cfg.SCHEMA_VER)
        manifest.setdefault("devices", {})
        manifest["devices"][device] = {"ts": snap["generated_at"], "hash": snap["hash"]}
        manifest["updated_at"] = _now()
        write_json(d["manifest"], manifest)

        state["last_push"] = _now()
        state["last_push_hash"] = snap["hash"]
        _save_state(state)
        return {"status": "ok", "hash": snap["hash"][:12]}


def sync_startup() -> dict:
    """Startup: pull cloud → local, then push merged union back."""
    try:
        p = pull()
        push()
        return p
    except Exception as e:  # never block app startup
        logger.warning("sync_startup failed (continuing local-only): %s", e)
        return {"status": "error", "error": str(e)}


def get_status() -> dict:
    state = _load_state()
    d = _dirs() if cfg.sync_dir() else None
    return {
        "enabled":   cfg.enabled(),
        "device":    cfg.device_id(),
        "sync_dir":  str(cfg.sync_dir()) if cfg.sync_dir() else None,
        "autodetected": not os.getenv("SYNC_DIR", "").strip() and cfg.sync_dir() is not None,
        "reachable": bool(d and d["base"].exists()),
        "last_pull": state.get("last_pull"),
        "last_push": state.get("last_push"),
        "last_conflicts": state.get("last_conflicts", 0),
    }


# ── background pusher (approximates "push after each change") ─────────────────
def _bg_loop() -> None:
    while True:
        time.sleep(cfg.PUSH_INTERVAL)
        try:
            push()
        except Exception as e:
            logger.debug("background push skipped: %s", e)


def start_background_push() -> None:
    global _bg_started
    if _bg_started or not cfg.enabled():
        return
    _bg_started = True
    threading.Thread(target=_bg_loop, daemon=True, name="sync-push").start()
    logger.info("sync: background pusher started (every %ds)", cfg.PUSH_INTERVAL)
