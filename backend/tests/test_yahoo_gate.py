"""yahoo_gate: no more than MAX_CONCURRENT Yahoo requests in flight, however
many threads the routers start (2026-09-24: 109 at once on page load)."""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import yahoo_gate  # noqa: E402


def test_gate_caps_concurrency(monkeypatch):
    from yfinance.data import YfData

    live, peak, lock = 0, 0, threading.Lock()

    def fake(self, *args, **kwargs):
        nonlocal live, peak
        with lock:
            live += 1
            peak = max(peak, live)
        time.sleep(0.05)
        with lock:
            live -= 1
        return "ok"

    monkeypatch.setattr(YfData, "_make_request", fake)
    assert yahoo_gate.install() is True
    assert getattr(YfData._make_request, "_yahoo_gated", False)

    threads = [threading.Thread(target=lambda: YfData._make_request(None, "u", None)) for _ in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert 1 <= peak <= yahoo_gate.MAX_CONCURRENT


def test_install_is_idempotent():
    from yfinance.data import YfData

    assert yahoo_gate.install() is True
    first = YfData._make_request
    assert yahoo_gate.install() is True
    assert YfData._make_request is first
