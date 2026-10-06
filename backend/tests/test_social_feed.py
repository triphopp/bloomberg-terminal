"""SOCIAL feed: X mirrors are raced, and a mirror that is down is left alone for a while."""
import threading
import time

import pytest
import requests

from routers import social


@pytest.fixture(autouse=True)
def clean():
    social._x_down.clear()
    yield
    social._x_down.clear()


def _post(handle: str) -> dict:
    return {"platform": "twitter", "handle": handle, "display_name": handle, "title": "hi",
            "url": "https://x.example/1", "published_at": "", "thumbnail": None}


def test_first_mirror_with_posts_wins_without_waiting_for_the_rest(monkeypatch):
    release = threading.Event()

    def parse(url, platform, handle, limit):
        if "nitter.net" in url:
            return [_post(handle)]
        release.wait(5)  # every other mirror hangs
        raise requests.ConnectionError("down")

    monkeypatch.setattr(social, "_parse_rss", parse)
    t0 = time.monotonic()
    try:
        assert social._fetch_twitter("@someone", 5) == [_post("someone")]
        assert time.monotonic() - t0 < 2
    finally:
        release.set()


def test_dead_mirrors_are_not_asked_again(monkeypatch):
    asked: list[str] = []

    def parse(url, platform, handle, limit):
        asked.append(url)
        raise requests.ConnectionError("dns")

    monkeypatch.setattr(social, "_parse_rss", parse)
    with pytest.raises(RuntimeError, match="no RSSHub or Nitter"):
        social._fetch_twitter("someone", 5)
    assert len(asked) == 1 + len(social._NITTER_INSTANCES)

    asked.clear()
    with pytest.raises(RuntimeError):
        social._fetch_twitter("someone-else", 5)
    assert asked == []  # every mirror is marked down: answered at once, no request


def test_a_missing_handle_does_not_mark_the_mirror_down(monkeypatch):
    def parse(url, platform, handle, limit):
        resp = requests.Response()
        resp.status_code = 404
        raise requests.HTTPError("404", response=resp)

    monkeypatch.setattr(social, "_parse_rss", parse)
    with pytest.raises(RuntimeError):
        social._fetch_twitter("nobody", 5)
    assert social._x_down == {}
