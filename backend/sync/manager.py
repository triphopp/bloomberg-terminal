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
from .derived import rebuild_all
from .merge import merge_snapshots
from .restore import restore
from .snapshot import compute_hash, export_snapshot, read_snapshot, write_json

logger = logging.getLogger("sync")

_LEGACY_STATE_FILE = Path(__file__).resolve().parent.parent / ".sync_state.json"
_lock = threading.Lock()
_bg_started = False


def _sidecar(kind: str) -> Path:
    """Per-database sidecar path.

    Keyed to the DB rather than to the package directory: both files describe
    what one specific database has synced, so a second DB (a test's simulated
    other machine, a scratch copy) must not inherit the first one's base — the
    3-way merge would then compare against a foreign ancestor and mistake every
    untouched field for an edit."""
    from config import DB_PATH
    p = Path(DB_PATH)
    return p.with_name(f".sync_{kind}_{p.stem}.json")

# Set once the startup pull+push has finished (or failed / been skipped). Cloud
# I/O on a cold boot can take tens of seconds while Google Drive File Stream is
# still mounting, so main.py runs sync_startup() on a worker thread to let
# uvicorn bind its port immediately. Endpoints backed by SYNC_TABLES must wait
# on this flag — serving them mid-pull would hand out pre-merge rows and let the
# user edit data the merge is about to rewrite.
startup_done = threading.Event()


# ── local state (base hash + last sync times) ────────────────────────────────
def _load_state() -> dict:
    for path in (_sidecar("state"), _LEGACY_STATE_FILE):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)   # legacy read-through: keeps last_push_hash
        except (OSError, json.JSONDecodeError):
            continue
    return {}


def _save_state(state: dict) -> None:
    try:
        write_json(_sidecar("state"), state)
    except OSError:
        logger.warning("could not persist sync state")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_base() -> dict | None:
    """The merged state this device last agreed on — the third leg of the 3-way
    merge. Stays local: it describes what THIS device has seen, not what the
    cloud holds, so it must never be pushed."""
    try:
        with open(_sidecar("base"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None  # first run → merge degrades to plain LWW


def _save_base(tables: dict, tombstones: list) -> None:
    try:
        write_json(_sidecar("base"), {"saved_at": _now(), "tables": tables,
                                      "tombstones": tombstones})
    except OSError:
        logger.warning("could not persist sync base (next merge falls back to LWW)")


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
        device = cfg.device_id()

        peers = []
        for f in sorted(d["snapshots"].glob("*.json")):
            snap = read_snapshot(f)
            if not snap:
                logger.warning("skip unreadable snapshot %s", f.name)
                continue
            if snap.get("device") == device or f.stem == device:
                continue  # our own file — the live DB below is fresher
            peers.append(snap)
        if not peers:
            return {"status": "empty", "applied": 0}

        from db import get_db
        with get_db() as conn:
            # The LOCAL side of the merge is the DB as it stands right now, not
            # our last pushed file: edits made since that push must take part in
            # the 3-way comparison, or they read as "unchanged" and lose.
            local_snap = export_snapshot(conn, device)
            merged, tombs, conflicts = merge_snapshots(
                [local_snap, *peers], base=_load_base()
            )
            applied = restore(conn, merged, tombs)
            rebuilt = rebuild_all(conn)

        # The merge result is now the state this device has seen — next merge
        # compares against it. Saved after restore so a crash mid-restore leaves
        # the OLD base in place (stale base = extra conflicts; wrong base = lost
        # edits, because unchanged fields would look changed and vice versa).
        _save_base(merged, tombs)

        if conflicts:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            write_json(d["conflicts"] / f"conflict-{stamp}-{cfg.device_id()}.json",
                       {"generated_at": _now(), "conflicts": conflicts})
            logger.info("sync: %d conflict row(s) preserved", len(conflicts))

        state = _load_state()
        state["last_pull"] = _now()
        state["last_conflicts"] = len(conflicts)
        _save_state(state)
        return {"status": "ok", "applied": applied, "devices": len(peers) + 1,
                "conflicts": len(conflicts), "rebuilt": rebuilt}


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

        # Cold start ONLY: a device that has pushed but never pulled has no
        # ancestor, so every field reads as changed on both sides and the merge
        # degrades to row-level last-write-wins — the peer's untouched fields
        # get thrown away. What we just published is the state peers will pull
        # from, which makes it a sound first ancestor.
        #
        # Never done on a later push: once a base exists, moving it forward on
        # push would mark our own just-pushed values as "unchanged" while a peer
        # still editing from the older ancestor reads as "changed", and its
        # stale field would silently overwrite the edit we just published.
        if not _sidecar("base").exists():
            _save_base(snap["tables"], snap["tombstones"])

        return {"status": "ok", "hash": snap["hash"][:12]}


# ── event-driven push (local writes) ─────────────────────────────────────────
# Deliberately NOT advancing the base on push: a peer that has not seen our
# snapshot yet still edits from the OLD base, and if we moved ours forward its
# stale field would read as "remote changed, local unchanged" and quietly
# overwrite the very edit we just pushed. The base only moves on merge.
_push_timer: threading.Timer | None = None
_timer_lock = threading.Lock()

PUSH_DEBOUNCE = float(os.getenv("SYNC_PUSH_DEBOUNCE", "2"))


def request_push(delay: float | None = None) -> None:
    """Ask for a push shortly after a local write, coalescing bursts.

    Called from the write path, so a form that fires five PUTs in a row still
    produces one snapshot write instead of five. Never raises and never blocks
    the request — a dead cloud drive must not fail a save that already
    committed locally."""
    global _push_timer
    if not cfg.enabled():
        return
    with _timer_lock:
        if _push_timer is not None:
            _push_timer.cancel()
        _push_timer = threading.Timer(
            PUSH_DEBOUNCE if delay is None else delay, _debounced_push
        )
        _push_timer.daemon = True
        _push_timer.start()


def _debounced_push() -> None:
    try:
        push()  # no-op when the content hash is unchanged
    except Exception as e:
        logger.debug("debounced push skipped: %s", e)


def sync_startup() -> dict:
    """Startup: pull cloud → local, then push merged union back."""
    try:
        p = pull()
        push()
        return p
    except Exception as e:  # never block app startup
        logger.warning("sync_startup failed (continuing local-only): %s", e)
        return {"status": "error", "error": str(e)}
    finally:
        # Always released, including on failure — a dead cloud drive must not
        # leave the portfolio endpoints gated forever.
        startup_done.set()


def start_startup_async() -> None:
    """Run sync_startup() (then arm the background pusher) on a worker thread so
    module import — and therefore the uvicorn port bind — never waits on cloud
    I/O. Callers gate SYNC_TABLES-backed reads on `startup_done`."""

    def _run() -> None:
        result = sync_startup()
        logger.info("sync_startup finished: %s", result.get("status"))
        start_background_push()

    threading.Thread(target=_run, name="sync-startup", daemon=True).start()


def get_status() -> dict:
    state = _load_state()
    d = _dirs() if cfg.sync_dir() else None
    return {
        "enabled":   cfg.enabled(),
        "device":    cfg.device_id(),
        "sync_dir":  str(cfg.sync_dir()) if cfg.sync_dir() else None,
        "autodetected": not os.getenv("SYNC_DIR", "").strip() and cfg.sync_dir() is not None,
        "reachable": bool(d and d["base"].exists()),
        "startup_done": startup_done.is_set(),
        "last_pull": state.get("last_pull"),
        "last_push": state.get("last_push"),
        "last_conflicts": state.get("last_conflicts", 0),
    }


# ── peer-change detection ────────────────────────────────────────────────────
def _peer_fingerprint() -> str | None:
    """Hashes the OTHER devices' manifest entries. Changes only when a peer has
    pushed new data, so the expensive merge runs on real remote edits instead of
    on a timer. None = manifest unreadable (drive offline / first boot)."""
    if not cfg.sync_dir():
        return None
    d = _dirs()
    try:
        with open(d["manifest"], encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    me = cfg.device_id()
    peers = {k: v.get("hash") for k, v in (manifest.get("devices") or {}).items() if k != me}
    return json.dumps(peers, sort_keys=True)


# ── background worker: auto-pull on peer change + auto-push on local change ───
def _bg_loop() -> None:
    last_peer = _peer_fingerprint()
    next_push = time.monotonic() + cfg.PUSH_INTERVAL
    while True:
        time.sleep(cfg.PULL_INTERVAL)
        try:
            peer = _peer_fingerprint()
            if peer is not None and peer != last_peer:
                result = pull()
                if result.get("status") == "ok":
                    last_peer = peer
                    logger.info("sync: auto-pull applied %d row(s)", result.get("applied", 0))
                    # our merged union must go back out so the peer converges too
                    push()
                    next_push = time.monotonic() + cfg.PUSH_INTERVAL
        except Exception as e:
            logger.debug("background pull skipped: %s", e)

        if time.monotonic() >= next_push:
            next_push = time.monotonic() + cfg.PUSH_INTERVAL
            try:
                push()  # no-op when the local hash is unchanged
            except Exception as e:
                logger.debug("background push skipped: %s", e)


def start_background_push() -> None:
    global _bg_started
    if _bg_started or not cfg.enabled():
        return
    _bg_started = True
    threading.Thread(target=_bg_loop, daemon=True, name="sync-worker").start()
    logger.info("sync: background worker started (pull check %ds, push %ds)",
                cfg.PULL_INTERVAL, cfg.PUSH_INTERVAL)
