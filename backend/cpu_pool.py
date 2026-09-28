"""Process pool for the few jobs that are pure-Python CPU for seconds.

Threads are right for this backend's usual work — waiting on vendors — but a
pure-Python parse holds the GIL: while it runs every other request, the SSE
loop and the schedulers stall. Measured 2026-09-28 (cold, per call):

    NY Fed ACM .xls (xlrd, ~10 MB)     2–3 s CPU, pure Python  → here
    everything else profiled           network wait, TLS setup (fixed in
                                       http_tls.py) or < 0.5 s of numpy/pandas

`run(fn, *args)` executes `fn` in a worker process and returns its result.
`fn` and its arguments/result must pickle; keep task functions in modules
that import little (cpu_tasks.py) — Windows spawns workers, and each worker
imports the task's module on first use.

Degrades, never fails worse than inline: a broken pool is rebuilt and the job
runs inline once; `CPU_POOL_WORKERS=0` turns the pool off (tests, debugging).
"""

from __future__ import annotations

import atexit
import multiprocessing
import os
import threading
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from typing import Any, Callable, TypeVar

T = TypeVar("T")

WORKERS = max(0, int(os.getenv("CPU_POOL_WORKERS", "2")))

_pool: ProcessPoolExecutor | None = None
_lock = threading.Lock()


def _get_pool() -> ProcessPoolExecutor:
    global _pool
    with _lock:
        if _pool is None:
            _pool = ProcessPoolExecutor(
                max_workers=WORKERS,
                mp_context=multiprocessing.get_context("spawn"),
            )
        return _pool


def _reset() -> None:
    global _pool
    with _lock:
        pool, _pool = _pool, None
    if pool is not None:
        pool.shutdown(wait=False, cancel_futures=True)


def run(fn: Callable[..., T], *args: Any, timeout: float = 120) -> T:
    """Run `fn(*args)` in the process pool; inline when the pool is off/broken.
    Exceptions raised by `fn` propagate as they would inline."""
    if WORKERS == 0:
        return fn(*args)
    try:
        return _get_pool().submit(fn, *args).result(timeout=timeout)
    except BrokenProcessPool:
        print(f"[cpu_pool] pool broken running {getattr(fn, '__name__', fn)} — rebuilt; ran inline")
        _reset()
        return fn(*args)


atexit.register(_reset)
