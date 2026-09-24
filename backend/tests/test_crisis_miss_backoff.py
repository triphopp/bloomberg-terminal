"""A series that no source can serve is not re-requested on every call.

2026-09-24: FRED had deleted BAMLHE00EHY0D (EM HY OAS, now removed from the
config). Each /api/crisis call ran JSON → 400, CSV → 5s hang, retries → ~20s,
cached nothing, and did it again ~70s later — the recurring FRED alert. The
dead series here is synthetic so the guard stays tested.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from routers import crisis  # noqa: E402


def test_dead_series_backs_off(monkeypatch):
    calls: dict[str, int] = {}

    def fake_fred(series_id):
        calls[series_id] = calls.get(series_id, 0) + 1
        if series_id == "BAMLHE00EHY0D":
            return []                                   # deleted upstream
        return [{"date": "2026-09-22", "raw": 1.0}, {"date": "2026-09-21", "raw": 1.1}]

    monkeypatch.setattr(crisis, "_fetch_fred_raw", fake_fred)
    monkeypatch.setattr(crisis, "_yf_fallback_credit", lambda cache, keys: None)
    monkeypatch.setattr(crisis, "_fetch_shiller_cape", lambda: None)
    monkeypatch.setattr(crisis, "_miss_until", {})
    monkeypatch.setitem(crisis._CREDIT_CFG, "dead_series", {
        "fred_id": "BAMLHE00EHY0D", "signal_when": "above", "threshold": 6.0,
        "label": "dead", "unit": "%", "category": "spreads",
    })
    monkeypatch.setitem(crisis._CREDIT_TTL, "dead_series", 86400)

    cache: dict = {}
    crisis._refresh_credit(cache)
    first = calls.get("BAMLHE00EHY0D", 0)
    assert first == 1
    assert "dead_series" in crisis._miss_until

    crisis._refresh_credit(cache)                        # the next call ~70s later
    assert calls["BAMLHE00EHY0D"] == first               # not asked again

    # After the backoff it is tried once more.
    crisis._miss_until["dead_series"] = time.time() - 1
    crisis._refresh_credit(cache)
    assert calls["BAMLHE00EHY0D"] == first + 1
