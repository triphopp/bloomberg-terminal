"""NEWS watchlist: one stored pull per (symbol, source), partial answers, refresh behind."""
import threading
import time

import pytest
import requests

from persist_cache import PersistentStore
from routers import news_watchlist as nw


def _item(tag: str, n: int = 0) -> dict:
    return {
        "title": f"{tag} headline {n}", "url": f"https://example.com/{tag}/{n}",
        "source": tag, "source_kind": "wire",
        "published_at": f"2026-10-05T10:0{n}:00Z", "summary": "",
    }


class Fake:
    """Two sources: `fast` answers at once, `slow` waits for `release`."""

    def __init__(self):
        self.calls: list[tuple[str, str]] = []
        self.release = threading.Event()
        self.fail: set[str] = set()
        self.version = 0

    def fast(self, symbol, company, limit):
        self.calls.append((symbol, "fast"))
        if "fast" in self.fail:
            raise RuntimeError("fast is down")
        return [_item(f"{symbol}-fast-v{self.version}")]

    def slow(self, symbol, company, limit):
        self.calls.append((symbol, "slow"))
        self.release.wait(5)
        return [_item(f"{symbol}-slow-v{self.version}")]


@pytest.fixture
def fake(monkeypatch):
    f = Fake()
    monkeypatch.setattr(nw, "_store", PersistentStore(None, max_age=nw._NEWS_STALE_S))
    monkeypatch.setattr(nw, "_SOURCES", {"fast": f.fast, "slow": f.slow})
    monkeypatch.setattr(nw, "_KEYWORD_SOURCES", set())
    monkeypatch.setattr(nw, "_inflight", {})
    monkeypatch.setattr(nw, "_resolve_metas", lambda syms, errors: {
        s: {"symbol": s, "sector": "Tech", "industry": None, "company": f"{s} Corp", "country": "US"}
        for s in syms
    })
    yield f
    f.release.set()  # never leave a worker thread parked


def ask(symbols="AAA,BBB", sources="fast,slow", **kw):
    args = dict(per_symbol=6, per_source=6, polymarket=0, fresh=0, wait=None, settle=0)
    args.update(kw)
    return nw.watchlist_news(symbols=symbols, sources=sources, **args)


def titles(res) -> set[str]:
    return {a["title"] for a in res["articles"]}


def test_partial_answer_then_settle(fake):
    first = ask(wait=0.3)
    assert titles(first) == {"AAA-fast-v0 headline 0", "BBB-fast-v0 headline 0"}
    assert first["pending"] == 2  # both `slow` pulls still running

    fake.release.set()
    second = ask(wait=3, settle=1)
    assert second["pending"] == 0
    assert len(second["articles"]) == 4
    # The follow-up joined the running pulls instead of starting new ones.
    assert sorted(fake.calls) == [("AAA", "fast"), ("AAA", "slow"), ("BBB", "fast"), ("BBB", "slow")]


def test_no_wait_param_holds_for_everything(fake):
    fake.release.set()
    res = ask()
    assert res["pending"] == 0
    assert len(res["articles"]) == 4


def test_fresh_pull_is_not_repeated(fake):
    fake.release.set()
    ask()
    fake.calls.clear()
    res = ask(wait=0.3)
    assert fake.calls == []
    assert res["pending"] == 0 and len(res["articles"]) == 4


def test_source_toggle_reuses_the_other_sources(fake):
    fake.release.set()
    ask(sources="fast")
    fake.calls.clear()
    ask(sources="fast,slow")
    assert sorted(fake.calls) == [("AAA", "slow"), ("BBB", "slow")]


def _age_store(seconds: float) -> None:
    """Make every stored pull look `seconds` older."""
    with nw._store._lock:
        for key, entry in list(nw._store._data.items()):
            nw._store._data[key] = {
                **entry, "ts": entry["ts"] - seconds, "retry_at": entry["retry_at"] - seconds,
            }


def test_stale_copy_is_served_at_once_and_refreshed_behind(fake):
    fake.release.set()
    ask()
    _age_store(nw._NEWS_FRESH_S + 60)
    fake.release.clear()
    fake.version = 1
    fake.calls.clear()

    t0 = time.monotonic()
    stale = ask(wait=2)
    assert time.monotonic() - t0 < 1.0          # did not hold for the refresh
    assert "AAA-slow-v0 headline 0" in titles(stale)
    assert stale["pending"] >= 2                 # the slow refreshes, at least
    assert stale["as_of"] < time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 300))

    fake.release.set()
    fresh = ask(wait=3, settle=1)
    assert fresh["pending"] == 0
    assert titles(fresh) == {f"{s}-{src}-v1 headline 0" for s in ("AAA", "BBB") for src in ("fast", "slow")}


def test_default_caller_gets_the_refreshed_answer(fake):
    """ASK / MCP send no `wait`: they must not be handed a stored copy that is due."""
    fake.release.set()
    ask()
    _age_store(nw._NEWS_FRESH_S + 60)
    fake.version = 1
    res = ask()
    assert res["pending"] == 0
    assert all("-v1 " in t for t in titles(res))


def test_failed_refresh_keeps_the_last_good_pull(fake):
    fake.release.set()
    ask()
    _age_store(nw._NEWS_FRESH_S + 60)
    fake.fail.add("fast")
    fake.version = 1
    res = ask()
    got = titles(res)
    assert "AAA-fast-v0 headline 0" in got       # kept
    assert "AAA-slow-v1 headline 0" in got       # the healthy source moved on

    # Negative cache: the failed source is not hit again straight away.
    fake.calls.clear()
    ask(wait=0.3)
    assert fake.calls == []
    entry = nw._store.get(nw._source_key("AAA", "fast", 6))
    assert 0 < entry["retry_at"] - time.time() <= nw._NEWS_RETRY_S


def test_first_failure_is_negative_cached_as_empty(fake):
    fake.release.set()
    fake.fail.add("fast")
    res = ask()
    assert titles(res) == {"AAA-slow-v0 headline 0", "BBB-slow-v0 headline 0"}
    fake.calls.clear()
    ask(wait=0.3)
    assert fake.calls == []


def test_404_means_not_covered_not_an_outage(fake, monkeypatch):
    def not_covered(symbol, company, limit):
        resp = requests.Response()
        resp.status_code = 404
        raise requests.HTTPError("404", response=resp)

    monkeypatch.setattr(nw, "_SOURCES", {"fast": not_covered})
    ask(sources="fast")
    entry = nw._store.get(nw._source_key("AAA", "fast", 6))
    assert entry["items"] == []
    assert entry["retry_at"] - time.time() > nw._NEWS_RETRY_S  # full fresh window


def test_refresh_button_repulls_but_not_what_just_arrived(fake):
    fake.release.set()
    ask()
    fake.calls.clear()
    ask(fresh=1, wait=2)
    assert fake.calls == []                      # pulled seconds ago

    _age_store(nw._NEWS_MIN_REPULL_S + 5)        # still "fresh", but old enough to repull
    fake.version = 1
    res = ask(fresh=1, wait=2)
    assert len(fake.calls) == 4
    assert all("-v1 " in t for t in titles(res))


def test_duplicate_headlines_across_sources_collapse(fake, monkeypatch):
    def a(symbol, company, limit):
        return [{**_item("x"), "title": "Same Story!", "url": "https://a.example/1?utm=1"}]

    def b(symbol, company, limit):
        return [{**_item("y"), "title": "same story", "url": "https://b.example/9"}]

    monkeypatch.setattr(nw, "_SOURCES", {"a": a, "b": b})
    res = ask(symbols="AAA", sources="a,b")
    assert [x["url"] for x in res["articles"]] == ["https://a.example/1?utm=1"]


def test_persistent_store_round_trip(tmp_path):
    store = PersistentStore("t", max_age=100, directory=tmp_path, flush_after=0.01)
    store.put("fresh", {"items": [1], "ts": time.time()})
    store.put("old", {"items": [2], "ts": time.time() - 500})
    store.flush()

    again = PersistentStore("t", max_age=100, directory=tmp_path)
    assert again.get("fresh")["items"] == [1]
    assert again.get("old") is None

    (tmp_path / "t.json").write_text("{not json", encoding="utf-8")
    assert len(PersistentStore("t", max_age=100, directory=tmp_path)) == 0  # cold start, no crash
