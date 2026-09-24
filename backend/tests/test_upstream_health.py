"""upstream_health + last_good: failures become a visible status instead of a
blank panel (2026-09-24: Yahoo 429 + DNS loss, and the app said nothing)."""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import last_good  # noqa: E402
import upstream_health as uh  # noqa: E402


@pytest.fixture(autouse=True)
def _clean(monkeypatch, tmp_path):
    # Never write test events into the real logs/upstream.jsonl.
    monkeypatch.setattr(uh, "LOG_PATH", tmp_path / "upstream.jsonl")
    uh.reset()
    last_good.reset()
    yield
    uh.reset()
    last_good.reset()


def test_source_names_and_local_hosts_ignored():
    assert uh.source_of("https://query2.finance.yahoo.com/v8/finance/chart/SPY") == "Yahoo"
    assert uh.source_of("https://api.stlouisfed.org/fred/series/observations?api_key=x") == "FRED"
    assert uh.source_of("https://cdn.cboe.com/api/x.csv") == "CBOE"
    assert uh.source_of("http://localhost:11434/api/tags") is None
    assert uh.source_of("https://example.org/x") == "example.org"


def test_classify():
    assert uh.classify_status(200) is None
    assert uh.classify_status(404) is None          # "no such symbol" is data, not an outage
    assert uh.classify_status(429) == "rate_limit"
    assert uh.classify_status(503) == "http_5xx"
    assert uh.classify_status(403) == "http_4xx"

    class NameResolutionError(Exception):
        pass

    assert uh.classify_exception(NameResolutionError("Failed to resolve 'api.stlouisfed.org'")) == "dns"
    assert uh.classify_exception(TimeoutError("read timed out")) == "timeout"
    assert uh.classify_exception(Exception("HTTP Error 429: Too Many Requests")) == "rate_limit"


def test_status_ladder_ok_degraded_down():
    t = 1_000_000.0
    uh.record("Yahoo", None, now=t)
    assert uh.snapshot(now=t)["overall"] == "OK"
    uh.record("Yahoo", "rate_limit", now=t + 1)
    assert uh.snapshot(now=t + 2)["overall"] == "OK"        # one failure is noise
    uh.record("Yahoo", "rate_limit", now=t + 2)
    assert uh.snapshot(now=t + 2)["overall"] == "DEGRADED"
    uh.record("Yahoo", "rate_limit", now=t + 3)
    uh.record("Yahoo", "rate_limit", now=t + 4)
    snap = uh.snapshot(now=t + 5)
    assert snap["overall"] == "DOWN"
    assert snap["sources"][0]["source"] == "Yahoo"
    assert snap["sources"][0]["last_kind"] == "rate_limit"
    # A success resets the streak; the window still remembers the failures.
    uh.record("Yahoo", None, now=t + 6)
    assert uh.snapshot(now=t + 7)["overall"] == "DEGRADED"
    # …until they age out.
    assert uh.snapshot(now=t + uh.WINDOW_S + 10)["overall"] == "OK"


def test_dns_failures_across_sources_mean_network():
    t = 2_000_000.0
    uh.record("FRED", "dns", now=t)
    assert uh.snapshot(now=t)["overall"] != "NETWORK"   # one source could be that vendor
    uh.record("CNN F&G", "dns", now=t + 5)
    snap = uh.snapshot(now=t + 6)
    assert snap["overall"] == "NETWORK"
    assert snap["dns_failed_sources"] == ["CNN F&G", "FRED"]


def test_incidents_collapse_bursts_and_hold_no_url():
    t = 3_000_000.0
    for i in range(10):
        uh.record("FRED", "dns", now=t + i)
    inc = uh.snapshot(now=t + 11)["incidents"]
    assert len(inc) == 1 and inc[0]["count"] == 10
    assert set(inc[0]) >= {"source", "kind", "kind_label"}
    assert not any("http" in str(v) for v in inc[0].values())


def test_requests_hook_records_and_reraises(monkeypatch):
    """The installed Session.send wrapper sees a DNS failure raised by the
    transport, records it under FRED, and re-raises it unchanged."""
    import requests

    assert uh.install() is True

    def dns_fail(self, request, **kw):
        raise requests.exceptions.ConnectionError("Failed to resolve 'api.stlouisfed.org'")

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", dns_fail)
    with pytest.raises(requests.exceptions.ConnectionError):
        requests.get("https://api.stlouisfed.org/fred/x?api_key=SECRET", timeout=1)
    snap = uh.snapshot()
    src = {s["source"]: s for s in snap["sources"]}
    assert src["FRED"]["last_kind"] == "dns"
    assert "SECRET" not in str(snap)


def test_yahoo_gate_reports_failures(monkeypatch):
    import yahoo_gate
    from yfinance.data import YfData

    def rate_limited(self, url, *a, **kw):
        raise Exception("YFRateLimitError: Too Many Requests. Rate limited.")

    monkeypatch.setattr(YfData, "_make_request", rate_limited)
    assert yahoo_gate.install() is True
    with pytest.raises(Exception):
        YfData._make_request(None, "https://query2.finance.yahoo.com/v8/finance/chart/SPY", None)
    src = {s["source"]: s for s in uh.snapshot()["sources"]}
    assert src["Yahoo"]["last_kind"] == "rate_limit"


# ── last_good ─────────────────────────────────────────────────────────────────


class _Cache:
    def __init__(self):
        self.d = {}

    def get_or_set(self, key, fn, ttl=None):
        if key not in self.d:
            self.d[key] = fn()
        return self.d[key]

    def delete(self, key):
        self.d.pop(key, None)


def test_cached_fetch_serves_last_good_and_reports_stale(monkeypatch, tmp_path):
    monkeypatch.setattr(last_good, "DIR", tmp_path)
    cache = _Cache()
    df = pd.DataFrame({"a": [1.0, 2.0]})
    val, stale = last_good.cached_fetch(cache, "k", lambda: df, label="Test panel", source="Yahoo")
    assert stale is None and val is df
    assert uh.snapshot()["stale"] == []

    cache.d.clear()
    monkeypatch.setattr(last_good, "STALE_REPORT_AFTER_S", 0)
    val, stale = last_good.cached_fetch(cache, "k", lambda: None, label="Test panel", source="Yahoo")
    assert val is not None and stale is not None
    st = uh.snapshot()["stale"]
    assert st and st[0]["label"] == "Test panel" and st[0]["source"] == "Yahoo"

    cache.d.clear()
    last_good.cached_fetch(cache, "k", lambda: df)
    assert uh.snapshot()["stale"] == []            # fresh again → alert clears


def test_empty_result_is_not_cached_as_a_hit(monkeypatch, tmp_path):
    """FRED failure used to return {}, which the TTL cache kept for an hour."""
    monkeypatch.setattr(last_good, "DIR", tmp_path)
    cache = _Cache()
    last_good.cached_fetch(cache, "e", lambda: {})
    assert "e" not in cache.d


# ── retry / cap / redaction (FRED timeouts, 2026-09-24) ───────────────────────


@pytest.fixture
def fake_transport(monkeypatch):
    """Scripted HTTPAdapter.send: each call pops the next outcome."""
    import requests

    assert uh.install() is True
    monkeypatch.setattr(uh.time, "sleep", lambda s: None)
    calls = {"n": 0, "script": []}

    def send(self, request, **kw):
        calls["n"] += 1
        outcome = calls["script"].pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        r = requests.Response()
        r.status_code = outcome
        r.url = request.url
        r._content = b"{}"
        return r

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)
    return calls


FRED_URL = "https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=SECRET123"


def test_fred_timeout_recovered_by_retry_is_not_a_failure(fake_transport):
    import requests

    fake_transport["script"] = [requests.exceptions.ReadTimeout("Read timed out. (read timeout=15)"), 200]
    r = requests.get(FRED_URL, timeout=1)
    assert r.status_code == 200 and fake_transport["n"] == 2
    fred = {s["source"]: s for s in uh.snapshot()["sources"]}["FRED"]
    assert fred["status"] == "OK" and fred["failures_window"] == 0
    assert fred["retries_window"] == 1


def test_fred_502_retried(fake_transport):
    import requests

    fake_transport["script"] = [502, 502, 200]
    assert requests.get(FRED_URL, timeout=1).status_code == 200
    assert fake_transport["n"] == 3


def test_fred_exhausted_retries_record_once_and_redact(fake_transport):
    import requests

    msg = f"HTTPSConnectionPool: Max retries exceeded with url: {FRED_URL} (Read timed out)"
    fake_transport["script"] = [requests.exceptions.ReadTimeout(msg) for _ in range(3)]
    with pytest.raises(requests.exceptions.ReadTimeout) as ei:
        requests.get(FRED_URL, timeout=1)
    assert fake_transport["n"] == 3
    assert "SECRET123" not in str(ei.value) and "api_key=***" in str(ei.value)
    fred = {s["source"]: s for s in uh.snapshot()["sources"]}["FRED"]
    assert fred["failures_window"] == 1                     # one final failure, not three


def test_dns_failure_is_not_retried(fake_transport):
    import requests

    fake_transport["script"] = [requests.exceptions.ConnectionError("Failed to resolve 'api.stlouisfed.org'")]
    with pytest.raises(requests.exceptions.ConnectionError):
        requests.get(FRED_URL, timeout=1)
    assert fake_transport["n"] == 1


def test_post_is_never_retried(fake_transport):
    import requests

    fake_transport["script"] = [503]
    assert requests.post(FRED_URL, timeout=1).status_code == 503
    assert fake_transport["n"] == 1


def test_error_url_redacted_for_raise_for_status(fake_transport):
    import requests

    fake_transport["script"] = [502, 502, 502]
    r = requests.get(FRED_URL, timeout=1)
    with pytest.raises(requests.exceptions.HTTPError) as ei:
        r.raise_for_status()
    assert "SECRET123" not in str(ei.value)


def test_fred_concurrency_capped(monkeypatch):
    import threading
    import time as _t

    import requests

    assert uh.install() is True
    live, peak, lock = 0, 0, threading.Lock()

    def slow(self, request, **kw):
        nonlocal live, peak
        with lock:
            live += 1
            peak = max(peak, live)
        _t.sleep(0.05)
        with lock:
            live -= 1
        r = requests.Response()
        r.status_code = 200
        r.url = request.url
        r._content = b"{}"
        return r

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", slow)
    ts = [threading.Thread(target=lambda: requests.get(FRED_URL, timeout=1)) for _ in range(12)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert 1 <= peak <= uh.SOURCE_LIMITS["FRED"]


def test_no_retries_once_source_is_down(fake_transport):
    """During a real outage retries only multiply the wait — fail fast."""
    import requests

    for _ in range(uh.FAIL_FAST_AFTER):
        uh.record("FRED", "timeout")
    fake_transport["script"] = [requests.exceptions.ReadTimeout("Read timed out")]
    with pytest.raises(requests.exceptions.ReadTimeout):
        requests.get(FRED_URL, timeout=1)
    assert fake_transport["n"] == 1


def test_incident_names_the_series_not_the_key(fake_transport):
    import requests

    fake_transport["script"] = [requests.exceptions.ReadTimeout("t") for _ in range(3)]
    with pytest.raises(requests.exceptions.ReadTimeout):
        requests.get(FRED_URL, timeout=1)
    inc = [i for i in uh.snapshot()["incidents"] if i["source"] == "FRED"][0]
    assert inc["targets"] == ["/fred/series/observations?series_id=DGS10"]
    assert inc["elapsed_s"] is not None
    assert "SECRET123" not in str(inc)


# ── event log (logs/upstream.jsonl) ───────────────────────────────────────────


def _events():
    import json

    if not uh.LOG_PATH.exists():
        return []
    return [json.loads(l) for l in uh.LOG_PATH.read_text(encoding="utf-8").splitlines()]


def test_log_records_fail_with_target_and_no_key(fake_transport):
    import requests

    fake_transport["script"] = [requests.exceptions.ReadTimeout("t") for _ in range(3)]
    with pytest.raises(requests.exceptions.ReadTimeout):
        requests.get(FRED_URL, timeout=1)
    ev = _events()
    kinds = [e["event"] for e in ev]
    assert kinds.count("retry") == 2 and kinds.count("fail") == 1
    fail = next(e for e in ev if e["event"] == "fail")
    assert fail["source"] == "FRED" and fail["kind"] == "timeout"
    assert fail["target"] == "/fred/series/observations?series_id=DGS10"
    assert "SECRET123" not in uh.LOG_PATH.read_text(encoding="utf-8")


def test_log_status_transitions():
    t = 5_000_000.0
    for i in range(3):
        uh.record("Yahoo", "rate_limit", now=t + i)
    st = [e for e in _events() if e["event"] == "status"]
    assert [(e["from"], e["to"]) for e in st] == [("OK", "DEGRADED"), ("DEGRADED", "DOWN")]


def test_log_network_down_and_back():
    t = time_now = __import__("time").time()
    uh.record("FRED", "dns", now=t)
    uh.record("Yahoo", "dns", now=t + 1)
    assert any(e["event"] == "network" for e in _events())
    uh.record("Yahoo", None, now=t + uh.DNS_WINDOW_S + 5)
    assert any(e["event"] == "network_ok" for e in _events())


def test_log_stale_and_fresh_once_each():
    uh.mark_stale("k", "Panel", 100, "Yahoo")
    uh.mark_stale("k", "Panel", 200, "Yahoo")       # still stale: no second event
    uh.clear_stale("k")
    uh.clear_stale("k")                              # already fresh: no event
    kinds = [e["event"] for e in _events()]
    assert kinds == ["stale", "fresh"]


def test_log_summary_every_window(monkeypatch):
    t = 6_000_000.0
    monkeypatch.setattr(uh, "_last_summary", t)
    uh.record("CBOE", None, now=t + 1)
    assert not [e for e in _events() if e["event"] == "summary"]
    uh.record("CBOE", None, now=t + uh.SUMMARY_EVERY_S + 1)
    summ = [e for e in _events() if e["event"] == "summary"]
    assert len(summ) == 1 and summ[0]["sources"]["CBOE"]["calls"] >= 1


def test_log_rotates(monkeypatch):
    monkeypatch.setattr(uh, "LOG_MAX_BYTES", 200)
    for i in range(20):
        uh.record("FRED", "timeout", now=7_000_000.0 + i * 100)
    assert uh.LOG_PATH.with_suffix(".jsonl.1").exists()


def test_young_copy_is_not_reported_stale(monkeypatch, tmp_path):
    monkeypatch.setattr(last_good, "DIR", tmp_path)
    last_good.remember("y", pd.DataFrame({"a": [1.0]}))
    val, age = last_good.recall("y", "Panel", "Yahoo")
    assert val is not None and age is not None
    assert uh.snapshot()["stale"] == []            # seconds old: served, not reported


def test_yahoo_401_crumb_refresh_is_not_a_failure(monkeypatch):
    import yahoo_gate
    from yfinance.data import YfData

    class R:
        status_code = 401

    monkeypatch.setattr(YfData, "_make_request", lambda self, url, *a, **k: R())
    assert yahoo_gate.install() is True
    YfData._make_request(None, "https://query2.finance.yahoo.com/v7/finance/quote?symbols=SPY", None)
    y = {s["source"]: s for s in uh.snapshot()["sources"]}["Yahoo"]
    assert y["failures_window"] == 0
