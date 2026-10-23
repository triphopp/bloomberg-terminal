"""
TTLCache.get_or_refresh — stale-while-revalidate (backend/cache.py).

Run:
    cd backend
    python -m pytest tests/test_cache_swr.py -v
"""

import sys
import threading
import time

sys.path.insert(0, ".")

import cache as cache_mod
from cache import TTLCache


def _age(c: TTLCache, key: str, seconds: float) -> None:
    with c._lock:
        c._store[key]["ts"] -= seconds


def _wait_refresh(c: TTLCache, key: str) -> None:
    for _ in range(200):
        with c._lock:
            if key not in c._inflight:
                return
        time.sleep(0.01)
    raise AssertionError("refresh never finished")


def test_cold_computes_in_request():
    c = TTLCache(ttl=60)
    assert c.get_or_refresh("k", lambda: {"v": 1}) == {"v": 1}


def test_stale_is_served_at_once_and_refreshed_behind():
    c = TTLCache(ttl=60)
    c.get_or_refresh("k", lambda: "old")
    _age(c, "k", 120)
    gate = threading.Event()

    def slow():
        gate.wait(2)
        return "new"

    started = time.time()
    assert c.get_or_refresh("k", slow, max_stale=3600) == "old"
    assert time.time() - started < 0.5  # did not wait on the refresh
    gate.set()
    _wait_refresh(c, "k")
    assert c.get_or_refresh("k", lambda: "unused") == "new"


def test_refresh_is_coalesced():
    c = TTLCache(ttl=60)
    c.get_or_refresh("k", lambda: 0)
    _age(c, "k", 120)
    calls = []
    gate = threading.Event()

    def fn():
        calls.append(1)
        gate.wait(2)
        return 1

    for _ in range(5):
        c.get_or_refresh("k", fn, max_stale=3600)
    gate.set()
    _wait_refresh(c, "k")
    assert len(calls) == 1


def test_failed_refresh_keeps_stale_and_backs_off():
    c = TTLCache(ttl=60)
    c.get_or_refresh("k", lambda: {"ok": True, "n": 1})
    _age(c, "k", 120)
    calls = []

    def bad():
        calls.append(1)
        return {"ok": False}

    valid = lambda d: d.get("ok")  # noqa: E731
    assert c.get_or_refresh("k", bad, max_stale=3600, valid=valid)["n"] == 1
    _wait_refresh(c, "k")
    # Backoff: the next request serves stale without starting another pull.
    assert c.get_or_refresh("k", bad, max_stale=3600, valid=valid)["n"] == 1
    _wait_refresh(c, "k")
    assert len(calls) == 1


def test_beyond_max_stale_recomputes_in_request():
    c = TTLCache(ttl=60)
    c.get_or_refresh("k", lambda: "old")
    _age(c, "k", 7200)
    assert c.get_or_refresh("k", lambda: "new", max_stale=3600) == "new"


def test_invalid_cold_result_is_not_cached():
    c = TTLCache(ttl=60)
    valid = lambda d: d != "bad"  # noqa: E731
    assert c.get_or_refresh("k", lambda: "bad", valid=valid) == "bad"
    assert c.get_or_refresh("k", lambda: "good", valid=valid) == "good"


def test_persisted_copy_survives_restart(tmp_path, monkeypatch):
    monkeypatch.setattr(cache_mod, "PERSIST_DIR", tmp_path)
    TTLCache(ttl=60).get_or_refresh("k", lambda: {"v": 1}, persist="t1", max_stale=3600)
    # A new process: nothing in memory, the file answers, a refresh runs behind.
    fresh = TTLCache(ttl=60)
    assert fresh.get_or_refresh("k", lambda: {"v": 2}, persist="t1", max_stale=3600) == {"v": 1}


def test_persisted_copy_older_than_max_stale_is_ignored(tmp_path, monkeypatch):
    import os

    monkeypatch.setattr(cache_mod, "PERSIST_DIR", tmp_path)
    TTLCache(ttl=60).get_or_refresh("k", lambda: "old", persist="t2", max_stale=3600)
    f = TTLCache._persist_path("t2")
    past = time.time() - 7200
    os.utime(f, (past, past))
    assert TTLCache(ttl=60).get_or_refresh("k", lambda: "new", persist="t2", max_stale=3600) == "new"


def test_invalid_result_is_never_persisted(tmp_path, monkeypatch):
    monkeypatch.setattr(cache_mod, "PERSIST_DIR", tmp_path)
    TTLCache(ttl=60).get_or_refresh("k", lambda: "bad", persist="t3", valid=lambda d: d != "bad")
    assert not TTLCache._persist_path("t3").exists()


def test_drop_persisted(tmp_path, monkeypatch):
    monkeypatch.setattr(cache_mod, "PERSIST_DIR", tmp_path)
    TTLCache(ttl=60).get_or_refresh("k", lambda: 1, persist="t4")
    TTLCache.drop_persisted("t4")
    assert not TTLCache._persist_path("t4").exists()


def test_peek_keeps_expired_entry():
    c = TTLCache(ttl=60)
    c.set("k", 1)
    _age(c, "k", 120)
    assert c.peek("k") is None
    assert "k" in c._store  # get() would have deleted it
