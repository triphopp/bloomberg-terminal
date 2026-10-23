"""yahoo_search.search_news reads Yahoo fresh on every call (yf.Search's
process-long lru_cache kept one empty answer until restart) and reports an
empty answer to upstream_health."""

import pytest

import upstream_health
import yahoo_search


class _Resp:
    def __init__(self, payload, status=200):
        self._payload, self.status_code = payload, status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


@pytest.fixture
def answers(monkeypatch):
    queue: list = []
    calls: list[dict] = []

    def get(self, url, params=None, timeout=30):
        calls.append(params)
        return queue.pop(0)

    monkeypatch.setattr(yahoo_search.YfData, "get", get)
    return queue, calls


def test_every_call_reaches_yahoo(answers):
    queue, calls = answers
    queue += [_Resp({"news": []}), _Resp({"news": [{"title": "Fed holds", "link": "u"}]})]
    assert yahoo_search.search_news("economy", 30) == []
    assert yahoo_search.search_news("economy", 30) == [{"title": "Fed holds", "link": "u"}]
    assert len(calls) == 2
    assert calls[0]["q"] == "economy" and calls[0]["newsCount"] == 30


def test_empty_answer_is_recorded(answers, monkeypatch):
    queue, _ = answers
    seen = []
    monkeypatch.setattr(upstream_health, "record", lambda src, kind, **kw: seen.append((src, kind)))
    queue.append(_Resp({"news": []}))
    yahoo_search.search_news("Fed", 30)
    assert seen == [("Yahoo", "empty")]


def test_not_a_search_answer_raises(answers):
    queue, _ = answers
    queue.append(_Resp({"finance": {"error": "x"}}))
    with pytest.raises(RuntimeError):
        yahoo_search.search_news("Fed", 30)
    queue.append(_Resp({}, status=429))
    with pytest.raises(RuntimeError):
        yahoo_search.search_news("Fed", 30)
