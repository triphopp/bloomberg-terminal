"""
App-wide cap on concurrent Yahoo Finance requests.

Measured 2026-09-24 on the live backend: opening the web app opened 228 new
connections to Yahoo within ten seconds, 109 of them at the same time. Every
router fetches on its own — watchlist, ticker, heatmap, TAIL, rotation, Fear &
Greed — and `yf.download` adds one thread per ticker on top. The home
connection dropped repeatedly right after page loads (DNS failures in the log,
phone on mobile data unaffected), and Yahoo answered 429 for the whole IP.

Every yfinance HTTP call goes through `YfData._make_request`, so one semaphore
there bounds the whole process no matter how many threads the routers start.
Requests beyond the cap wait their turn instead of opening another socket.

    YAHOO_MAX_CONCURRENT   default 6

Imported for its side effect in main.py, before any router.
"""

from __future__ import annotations

import os
import threading

MAX_CONCURRENT = max(1, int(os.getenv("YAHOO_MAX_CONCURRENT", "6")))

_sem = threading.BoundedSemaphore(MAX_CONCURRENT)


def install() -> bool:
    """Wrap yfinance's single request path. Idempotent; False if yfinance's
    internals moved and the gate could not be installed."""
    try:
        from yfinance.data import YfData
    except Exception as exc:  # pragma: no cover - yfinance missing/renamed
        print(f"[yahoo_gate] not installed: {exc}")
        return False
    orig = getattr(YfData, "_make_request", None)
    if orig is None:
        print("[yahoo_gate] not installed: YfData._make_request not found")
        return False
    if getattr(orig, "_yahoo_gated", False):
        return True

    import upstream_health as uh

    def gated(self, *args, **kwargs):
        url = args[0] if args else kwargs.get("url")
        src = uh.source_of(url) or "Yahoo"
        with _sem:
            try:
                resp = orig(self, *args, **kwargs)
            except Exception as exc:
                # Every Yahoo failure reaches the health board — it used to
                # surface only as "possibly delisted" lines in the log.
                uh.record(src, uh.classify_exception(exc), target=uh.target_of(url))
                raise
        code = getattr(resp, "status_code", None)
        # 401 = Yahoo's "Invalid Crumb": yfinance fetches a new crumb and
        # retries on its own. Routine, not a failure.
        kind = None if code == 401 else uh.classify_status(code)
        uh.record(src, kind, target=uh.target_of(url) if kind else None)
        return resp

    gated._yahoo_gated = True  # type: ignore[attr-defined]
    gated.__wrapped__ = orig  # type: ignore[attr-defined]
    YfData._make_request = gated
    return True


INSTALLED = install()
