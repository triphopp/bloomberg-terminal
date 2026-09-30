"""
Request latency — where a slow request spent its time.

"Reading from the DB is sometimes slow" has three very different causes, and
each needs a different fix:

    queue   the request waited for one of anyio's worker threads (every sync
            `def` route runs on that pool — 40 threads by default, shared with
            routes that block for seconds on Yahoo/FRED)
    db      time inside db.get_db(): connect + PRAGMA + ledger mark (open),
            the body, and commit (a writer blocked on SQLite's write lock waits
            here, up to the connection's busy timeout)
    run     the handler itself (network fetches, pandas, …)

This module measures all three per request, cheaply:

  * `LatencyMiddleware` — pure ASGI, outermost. Arrival → last body byte.
  * `install()` wraps `anyio.to_thread.run_sync` so a thread call made while a
    request is in flight records submit → start (queue wait) and start → end.
  * `note_db()` is called by db.get_db() with its phase timings.

Nothing is stored per request except in bounded deques. Requests slower than
LATENCY_SLOW_MS (default 200) go to `logs/latency.jsonl` (override:
LATENCY_LOG), rotated to `.1` at 5 MB — route TEMPLATE only (`/api/stock/quote/{symbol}`),
never a query string. `GET /api/health/latency` returns `snapshot()` from memory,
on the event loop (async route), so it answers even when every worker thread is busy.

Lanes (see `lane_for`): sync routes whose path is in LOCAL_PREFIXES — local
DB/state only, no outbound calls — run on their own CapacityLimiter, so a burst
of upstream-bound routes holding every default worker cannot queue a 2 ms
pins/portfolio read behind them. LATENCY_LOCAL_LANE=0 turns lanes off.
"""

from __future__ import annotations

import contextvars
import json
import os
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter

SLOW_MS = float(os.getenv("LATENCY_SLOW_MS", "200"))
LOG_PATH = Path(os.getenv("LATENCY_LOG") or
                (Path(__file__).resolve().parent.parent / "logs" / "latency.jsonl"))
LOG_MAX_BYTES = 5 * 1024 * 1024
#: Background (no request) get_db() holds longer than this are remembered —
#: they are the writers other connections queue behind.
BG_HOLD_S = 0.25

#: Sync routes that only touch the local DB / in-process state. They get their
#: own thread lane. Keep this to routers that never call a vendor on the
#: request path; a wrong entry only makes that route share the local lane.
LOCAL_PREFIXES: tuple[str, ...] = (
    # Checked 2026-09-30: these routers import no vendor client and read no
    # quote on the request path. NOT here on purpose: /api/v2/portfolio (open
    # positions / summary price holdings), /api/v2/portfolio/margin (uses the
    # enriched positions), /api/alerts (rule preview/scan download bars),
    # /api/v2/series (/refresh fetches), /api/clippings (AI), /api/sync (Drive I/O).
    "/api/pins",
    "/api/v2/ledger",
    "/api/v2/theses",
    "/api/v2/zettel",
    "/api/v2/graphs",
    "/api/v2/chart-drawings",
    "/api/changes",
    "/api/config",
    "/api/dev",
    "/api/health",
    "/health",
)
LOCAL_LANE_ENABLED = os.getenv("LATENCY_LOCAL_LANE", "1") not in ("0", "false", "no")
LOCAL_LANE_TOKENS = int(os.getenv("LATENCY_LOCAL_TOKENS", "16"))


@dataclass
class _Req:
    arrived: float
    lane: str = "default"
    thread_wait: float = 0.0
    thread_run: float = 0.0
    thread_calls: int = 0
    db_calls: int = 0
    db_open: float = 0.0
    db_held: float = 0.0
    db_commit: float = 0.0
    db_locked: int = 0
    busy_at_arrival: int = -1
    waiting_at_arrival: int = -1


_current: contextvars.ContextVar[_Req | None] = contextvars.ContextVar("req_latency", default=None)

_lock = threading.Lock()
_log_lock = threading.Lock()
_routes: dict[str, deque] = {}
_MAX_ROUTES = 400
_slow: deque = deque(maxlen=50)
_bg_holds: deque = deque(maxlen=50)
_counters = {"requests": 0, "slow": 0, "db_locked": 0, "bg_db_locked": 0}
_peak = {"busy": 0, "waiting": 0, "local_busy": 0}
_started = time.time()
_local_limiter = None  # anyio.CapacityLimiter, created lazily on the event loop


def lane_for(path: str) -> str:
    if not LOCAL_LANE_ENABLED:
        return "default"
    for p in LOCAL_PREFIXES:
        if path == p or path.startswith(p + "/"):
            return "local"
    return "default"


# ── DB hook (called from db.get_db, any thread) ───────────────────────────────

def note_db(open_s: float, held_s: float, commit_s: float, locked: bool = False) -> None:
    req = _current.get()
    if req is not None:
        req.db_calls += 1
        req.db_open += open_s
        req.db_held += held_s
        req.db_commit += commit_s
        if locked:
            req.db_locked += 1
    if locked:
        with _lock:
            _counters["db_locked" if req is not None else "bg_db_locked"] += 1
    if req is None and held_s >= BG_HOLD_S:
        _bg_holds.append({
            "time": time.strftime("%H:%M:%S"),
            "thread": threading.current_thread().name,
            "held_ms": round(held_s * 1000, 1),
            "commit_ms": round(commit_s * 1000, 1),
        })


# ── thread-pool wrapper ───────────────────────────────────────────────────────

_orig_run_sync = None


def install() -> None:
    """Wrap anyio.to_thread.run_sync (Starlette/FastAPI look it up at call time)."""
    global _orig_run_sync
    import anyio.to_thread as to_thread

    if _orig_run_sync is not None:
        return
    _orig_run_sync = to_thread.run_sync

    async def run_sync(func, *args, abandon_on_cancel=False, cancellable=None, limiter=None):
        req = _current.get()
        if req is None:
            return await _orig_run_sync(func, *args, abandon_on_cancel=abandon_on_cancel,
                                        cancellable=cancellable, limiter=limiter)
        if limiter is None and req.lane == "local":
            limiter = _get_local_limiter()
        submitted = perf_counter()

        def timed(*a):
            started = perf_counter()
            req.thread_wait += started - submitted
            try:
                return func(*a)
            finally:
                req.thread_run += perf_counter() - started
                req.thread_calls += 1

        return await _orig_run_sync(timed, *args, abandon_on_cancel=abandon_on_cancel,
                                    cancellable=cancellable, limiter=limiter)

    to_thread.run_sync = run_sync


def _get_local_limiter():
    global _local_limiter
    if _local_limiter is None:
        import anyio
        _local_limiter = anyio.CapacityLimiter(LOCAL_LANE_TOKENS)
    return _local_limiter


def _default_limiter():
    try:
        import anyio.to_thread as to_thread
        return to_thread.current_default_thread_limiter()
    except Exception:
        return None


# ── middleware ────────────────────────────────────────────────────────────────

class LatencyMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        req = _Req(arrived=perf_counter(), lane=lane_for(path))
        lim = _default_limiter()
        if lim is not None:
            try:
                req.busy_at_arrival = int(lim.borrowed_tokens)
                req.waiting_at_arrival = lim.statistics().tasks_waiting
            except Exception:
                pass
        token = _current.set(req)
        status = [0]

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status[0] = message.get("status", 0)
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            _current.reset(token)
            _finish(scope, req, status[0])


def _route_of(scope) -> str:
    route = scope.get("route")
    tmpl = getattr(route, "path", None) if route is not None else None
    return tmpl or scope.get("path", "?")


def _finish(scope, req: _Req, status: int) -> None:
    total = perf_counter() - req.arrived
    route = f'{scope.get("method", "?")} {_route_of(scope)}'
    sample = (total, req.thread_wait, req.db_held)
    with _lock:
        _counters["requests"] += 1
        dq = _routes.get(route)
        if dq is None and len(_routes) < _MAX_ROUTES:
            dq = _routes[route] = deque(maxlen=200)
        if dq is not None:
            dq.append(sample)
        if req.busy_at_arrival > _peak["busy"]:
            _peak["busy"] = req.busy_at_arrival
        if req.waiting_at_arrival > _peak["waiting"]:
            _peak["waiting"] = req.waiting_at_arrival
        if _local_limiter is not None:
            try:
                _peak["local_busy"] = max(_peak["local_busy"], int(_local_limiter.borrowed_tokens))
            except Exception:
                pass
    if total * 1000 < SLOW_MS:
        return
    rec = {
        "route": route,
        "status": status,
        "lane": req.lane,
        "total_ms": round(total * 1000, 1),
        "queue_ms": round(req.thread_wait * 1000, 1),
        "run_ms": round(req.thread_run * 1000, 1),
        "threads": req.thread_calls,
        "db_calls": req.db_calls,
        "db_open_ms": round(req.db_open * 1000, 1),
        "db_held_ms": round(req.db_held * 1000, 1),
        "db_commit_ms": round(req.db_commit * 1000, 1),
        "db_locked": req.db_locked,
        "busy_at_arrival": req.busy_at_arrival,
        "waiting_at_arrival": req.waiting_at_arrival,
    }
    with _lock:
        _counters["slow"] += 1
        _slow.append({"time": time.strftime("%H:%M:%S"), **rec})
    _event("slow", **rec)


def _event(event: str, **fields) -> None:
    """Append one JSON line. Never raises."""
    now = time.time()
    line = {"ts": round(now, 3), "time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now)),
            "event": event, **fields}
    try:
        text = json.dumps(line, ensure_ascii=False, default=str) + "\n"
        with _log_lock:
            LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
            if LOG_PATH.exists() and LOG_PATH.stat().st_size > LOG_MAX_BYTES:
                LOG_PATH.replace(LOG_PATH.with_suffix(LOG_PATH.suffix + ".1"))
            with LOG_PATH.open("a", encoding="utf-8") as fh:
                fh.write(text)
    except Exception:
        pass


def _pct(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    values = sorted(values)
    return values[min(len(values) - 1, int(q * len(values)))]


def snapshot(top: int = 25) -> dict:
    """Answered from memory. Call from the event loop for live limiter numbers."""
    with _lock:
        routes = {k: list(v) for k, v in _routes.items()}
        slow = list(_slow)[-20:]
        counters = dict(_counters)
        peak = dict(_peak)
    rows = []
    for route, samples in routes.items():
        totals = [s[0] for s in samples]
        waits = [s[1] for s in samples]
        db = [s[2] for s in samples]
        rows.append({
            "route": route,
            "n": len(samples),
            "p50_ms": round(_pct(totals, 0.5) * 1000, 1),
            "p95_ms": round(_pct(totals, 0.95) * 1000, 1),
            "max_ms": round(max(totals) * 1000, 1),
            "queue_p95_ms": round(_pct(waits, 0.95) * 1000, 1),
            "db_p95_ms": round(_pct(db, 0.95) * 1000, 1),
        })
    rows.sort(key=lambda r: r["p95_ms"], reverse=True)
    lim = _default_limiter()
    threads = {"peak_busy": peak["busy"], "peak_waiting": peak["waiting"]}
    if lim is not None:
        try:
            threads.update(total=lim.total_tokens, busy=lim.borrowed_tokens,
                           waiting=lim.statistics().tasks_waiting)
        except Exception:
            pass
    local = {"enabled": LOCAL_LANE_ENABLED, "tokens": LOCAL_LANE_TOKENS, "peak_busy": peak["local_busy"]}
    if _local_limiter is not None:
        local.update(busy=_local_limiter.borrowed_tokens)
    return {
        "since": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(_started)),
        "slow_ms": SLOW_MS,
        "counters": counters,
        "threads": threads,
        "local_lane": local,
        "routes": rows[:top],
        "recent_slow": slow,
        "background_db_holds": list(_bg_holds)[-20:],
    }


def reset() -> None:
    """Tests only."""
    with _lock:
        _routes.clear()
        _slow.clear()
        _bg_holds.clear()
        for k in _counters:
            _counters[k] = 0
        for k in _peak:
            _peak[k] = 0
