"""Polymarket: the market pool is refreshed behind its callers; a ticker's
ladder is built from the search answer alone; the topic feed re-reads only the
piece that is new."""
import threading
import time

import pytest

from market_requests import MarketRequests
from persist_cache import PersistentStore
from routers import news
from routers import polymarket as pm
from routers import polymarket_stock as pms


def _market(slug: str, question: str, description: str = "", volume: float = 1.0) -> dict:
    return {"slug": slug, "question": question, "description": description, "volume": volume,
            "outcomePrices": '["0.25", "0.75"]'}


@pytest.fixture
def pool(monkeypatch):
    """A controllable Gamma: `pages` is what the next fetch returns."""
    state = {"pages": [_market("a", "Will the Fed cut?")], "calls": 0, "gate": threading.Event()}
    state["gate"].set()

    def fetch():
        state["calls"] += 1
        state["gate"].wait(5)
        return [dict(m, **{pm._HAY: pm._haystack(m)}) for m in state["pages"]]

    monkeypatch.setattr(pm, "_fetch_pool_pages", fetch)
    monkeypatch.setattr(pm, "_market_pool", [])
    monkeypatch.setattr(pm, "_pool_ts", 0)
    monkeypatch.setattr(pm, "_pool_failed_at", 0)
    monkeypatch.setattr(pm, "_kept_signals", PersistentStore(None, max_age=pm._POOL_STALE_MAX))
    pm._pm_cache.clear()
    yield state
    state["gate"].set()
    if pm._pool_lock.locked():  # a refresh thread from the test is still finishing
        deadline = time.time() + 3
        while pm._pool_lock.locked() and time.time() < deadline:
            time.sleep(0.01)


def test_cold_start_waits_for_the_pool(pool):
    assert [m["slug"] for m in pm._refresh_market_pool()] == ["a"]
    assert pool["calls"] == 1
    pm._refresh_market_pool()
    assert pool["calls"] == 1  # fresh: no second download


def test_expired_pool_is_served_while_one_refresh_runs(pool, monkeypatch):
    pm._refresh_market_pool()
    monkeypatch.setattr(pm, "_pool_ts", time.time() - pm._POOL_TTL - 5)
    pool["pages"] = [_market("b", "New market?")]
    pool["gate"].clear()

    t0 = time.monotonic()
    served = [pm._refresh_market_pool() for _ in range(5)]
    assert time.monotonic() - t0 < 0.5                     # nobody waited on the download
    assert all(m[0]["slug"] == "a" for m in served)        # the old pool, meanwhile
    assert pm._pool_stamp()["refreshing"] is True

    pool["gate"].set()
    deadline = time.time() + 3
    while pm._market_pool[0]["slug"] != "b" and time.time() < deadline:
        time.sleep(0.01)
    assert pm._market_pool[0]["slug"] == "b"
    assert pool["calls"] == 2                              # one refresh for five callers
    assert pm._pool_stamp()["refreshing"] is False


def test_pool_too_old_to_show_makes_the_caller_wait(pool, monkeypatch):
    pm._refresh_market_pool()
    monkeypatch.setattr(pm, "_pool_ts", time.time() - pm._POOL_STALE_MAX - 5)
    pool["pages"] = [_market("b", "New market?")]
    assert pm._refresh_market_pool()[0]["slug"] == "b"


def test_failed_refresh_keeps_the_pool_and_is_not_retried_by_every_caller(pool, monkeypatch):
    pm._refresh_market_pool()
    monkeypatch.setattr(pm, "_pool_ts", time.time() - pm._POOL_STALE_MAX - 5)
    pool["pages"] = []
    assert pm._refresh_market_pool()[0]["slug"] == "a"
    assert pool["calls"] == 2

    # Gamma is down: the next callers get the old pool at once, no new attempt.
    for _ in range(5):
        assert pm._refresh_market_pool()[0]["slug"] == "a"
    assert pool["calls"] == 2

    # ...until the retry window has passed.
    monkeypatch.setattr(pm, "_pool_failed_at", time.time() - pm._POOL_RETRY_S - 1)
    pool["pages"] = [_market("b", "Back?")]
    assert pm._refresh_market_pool()[0]["slug"] == "b"


def test_cold_start_with_gamma_down_does_not_queue_callers(pool):
    pool["pages"] = []
    assert pm._refresh_market_pool() == []
    assert pm._refresh_market_pool() == []
    assert pool["calls"] == 1


def test_answer_cached_from_a_replaced_pool_is_not_reused(pool, monkeypatch):
    pm._refresh_market_pool()
    pm._pm_cache.set("signals", {"signals": [], **pm._pool_stamp()})
    assert pm._cached_answer("signals") is not None
    monkeypatch.setattr(pm, "_pool_ts", pm._pool_ts + 1)   # a new pool arrived
    assert pm._cached_answer("signals") is None


def test_signals_after_a_restart_come_from_disk_while_the_pool_loads(pool, monkeypatch):
    monkeypatch.setattr(pm, "_extract_all_signals", lambda: [{"signal_type": "fed_rate", "probability": 0.4}])
    first = pm.get_all_signals()                 # computes, and keeps a copy
    assert first["refreshing"] is False

    # "Restart": memory is empty, the copy on disk is not.
    monkeypatch.setattr(pm, "_market_pool", [])
    monkeypatch.setattr(pm, "_pool_ts", 0)
    pm._pm_cache.clear()
    pool["calls"] = 0
    pool["gate"].clear()

    t0 = time.monotonic()
    kept = pm.get_all_signals()
    assert time.monotonic() - t0 < 0.5           # did not wait for the download
    assert kept["refreshing"] is True
    assert kept["signals"] == first["signals"] and kept["as_of"] == first["as_of"]

    pool["gate"].set()
    deadline = time.time() + 3
    while not pm._market_pool and time.time() < deadline:
        time.sleep(0.01)
    assert pool["calls"] == 1                    # one download, started behind the answer
    assert pm.get_all_signals()["refreshing"] is False


def test_pool_matches_phrase_first_per_slug_case_insensitive():
    markets = [
        _market("a", "Will the FED RATE CUT happen?"),
        _market("a", "duplicate slug — fed rate cut"),
        _market("b", "Unrelated", description="x" * 450 + " fed rate cut"),  # beyond 400 chars
        _market("c", "Other", description="mentions a Fed Rate Cut early"),
        {"slug": "d", "question": None, "description": None},
    ]
    for m in markets[:3]:
        m[pm._HAY] = pm._haystack(m)                       # the rest fall back to building it
    assert [m["slug"] for m in pm._pool_matches(markets, ["fed rate cut"])] == ["a", "c"]


# ── per-ticker ladders ───────────────────────────────────────────────────────

@pytest.fixture
def coordinator(monkeypatch):
    service = MarketRequests(workers=4)
    monkeypatch.setattr(pms, "market_requests", service)
    pms._events_cache.clear()
    pms._miss_cache.clear()
    yield service
    service.close()


def _event(slug: str, title: str, markets: list[dict] | None) -> dict:
    return {"slug": slug, "title": title, "endDate": "2099-01-01T00:00:00Z", "closed": False,
            "volume": 10, "liquidity": 5, "markets": markets}


def test_ladder_is_built_from_the_search_answer(coordinator, monkeypatch):
    rungs = [
        {"groupItemTitle": "$500", "question": "Will MSFT close above $500?",
         "outcomePrices": '["0.8", "0.2"]', "volume": 3, "slug": "r500"},
        {"groupItemTitle": "$600", "question": "Will MSFT close above $600?",
         "outcomePrices": '["0.1", "0.9"]', "volume": 2, "slug": "r600"},
    ]
    asked: list[str] = []

    def search(query, *a):
        asked.append(query)
        return [_event("msft-above", "MSFT close above ___ ?", rungs)]

    monkeypatch.setattr(pms, "_search_events", search)
    monkeypatch.setattr(pms, "_event_detail", lambda slug: pytest.fail("event fetched again"))
    monkeypatch.setattr(pms, "_spot", lambda s: 550.0)

    data = pms._stock_markets("MSFT", "Microsoft")
    assert sorted(asked) == ["MSFT", "Microsoft"]          # ticker and name, both asked
    assert [e["slug"] for e in data["events"]] == ["msft-above"]
    assert [s["strike"] for s in data["events"][0]["strikes"]] == [600.0, 500.0]
    assert data["summary"]["prob_above_spot"] == pytest.approx(0.45)


def test_event_without_markets_still_gets_its_detail(coordinator, monkeypatch):
    detail = _event("mu-up", "MU Up or Down today?", [
        {"groupItemTitle": "Up", "question": "MU up?", "outcomePrices": '["0.6", "0.4"]', "slug": "up"},
    ])
    monkeypatch.setattr(pms, "_search_events", lambda q, *a: [_event("mu-up", "MU Up or Down today?", None)])
    monkeypatch.setattr(pms, "_event_detail", lambda slug: detail)
    monkeypatch.setattr(pms, "_spot", lambda s: 100.0)
    data = pms._stock_markets("MU")
    assert data["events"][0]["prob_up"] == 0.6


# ── topic newswire ───────────────────────────────────────────────────────────

@pytest.fixture
def feed(monkeypatch):
    calls: list[str] = []

    def topic(t, count):
        calls.append(f"topic:{t}")
        return [{"title": f"{t} {i}", "url": f"https://example.com/{t}/{i}", "source": "Y",
                 "published_at": f"2026-10-05T10:{i:02d}:00Z", "topic": t} for i in range(count)]

    def rss(name, url, limit):
        calls.append(f"rss:{name}")
        return [{"title": f"{name} top", "url": f"https://example.com/{name}", "source": name,
                 "published_at": "2026-10-05T12:00:00Z", "topic": "general"}]

    monkeypatch.setattr(news, "_fetch_yfinance_topic", topic)
    monkeypatch.setattr(news, "_fetch_rss", rss)
    news._feed_cache.clear()
    news._piece_cache.clear()
    return calls


def test_feed_adding_a_topic_reads_only_the_new_piece(feed):
    first = news.news_feed(topics="Fed,oil", limit=80, fresh=0, swr=1)
    assert len(first["articles"]) == 80
    assert sorted(feed) == sorted(["topic:Fed", "topic:oil", *[f"rss:{n}" for n in news._RSS_FEEDS]])

    feed.clear()
    news.news_feed(topics="Fed,oil,gold", limit=80, fresh=0, swr=1)
    assert feed == ["topic:gold"]

    feed.clear()
    news.news_feed(topics="Fed", limit=80, fresh=0, swr=1)   # removing one reads nothing
    assert feed == []


def test_feed_stale_copy_only_for_callers_that_ask_again(feed):
    news.news_feed(topics="Fed", limit=20, fresh=0, swr=1)
    key = "feed:Fed:20"
    entry = news._feed_cache.get(key)
    news._feed_cache.set(key, {**entry, "ts": time.time() - news._FEED_FRESH_S - 5})
    news._piece_cache.clear()

    feed.clear()
    stale = news.news_feed(topics="Fed", limit=20, fresh=0, swr=1)
    assert stale["refreshing"] is True
    deadline = time.time() + 3
    while key in news._feed_refreshing or not feed:
        assert time.time() < deadline
        time.sleep(0.01)
    after = news.news_feed(topics="Fed", limit=20, fresh=0, swr=1)
    assert "refreshing" not in after

    # A one-shot reader (ASK) never gets the old copy.
    entry = news._feed_cache.get(key)
    news._feed_cache.set(key, {**entry, "ts": time.time() - news._FEED_FRESH_S - 5})
    assert "refreshing" not in news.news_feed(topics="Fed", limit=20, fresh=0, swr=0)


def test_feed_refresh_button_rereads_every_piece(feed):
    news.news_feed(topics="Fed", limit=20, fresh=0, swr=1)
    feed.clear()
    news.news_feed(topics="Fed", limit=20, fresh=1, swr=1)
    assert len(feed) == 1 + len(news._RSS_FEEDS)
