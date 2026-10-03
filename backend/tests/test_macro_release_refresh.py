"""
A monthly series is refetched when its scheduled release lands, not a week
after the last fetch — the NFP of 2026-10-02 sat unseen for that reason.
"""
from datetime import datetime
from zoneinfo import ZoneInfo

import routers.macro as macro

ET = ZoneInfo("America/New_York")


def _ts(y, m, d, hh, mm):
    return datetime(y, m, d, hh, mm, tzinfo=ET).timestamp()


RELEASE = _ts(2026, 10, 2, 8, 30)
MOMENTS = {"NFP": RELEASE}


def test_fetch_before_release_is_superseded():
    entry = {"ts": _ts(2026, 9, 29, 10, 0), "ttl": 7 * 86400}
    assert macro._superseded("nfp", entry, MOMENTS, _ts(2026, 10, 2, 12, 30)) is True
    assert macro._superseded("unemployment", entry, MOMENTS, _ts(2026, 10, 5, 9, 0)) is True
    # Not yet released that morning.
    assert macro._superseded("nfp", entry, {}, _ts(2026, 10, 2, 8, 0)) is False


def test_fetch_inside_fred_lag_is_retried_then_settles():
    early = {"ts": _ts(2026, 10, 2, 8, 35)}  # FRED had not picked the print up yet
    assert macro._superseded("nfp", early, MOMENTS, _ts(2026, 10, 2, 8, 40)) is False
    assert macro._superseded("nfp", early, MOMENTS, _ts(2026, 10, 2, 8, 55)) is True
    assert macro._superseded("nfp", early, MOMENTS, _ts(2026, 10, 3, 20, 0)) is True
    settled = {"ts": _ts(2026, 10, 2, 11, 45)}
    assert macro._superseded("nfp", settled, MOMENTS, _ts(2026, 10, 4, 9, 0)) is False


def test_series_without_a_release_keeps_its_ttl():
    old = {"ts": _ts(2026, 9, 1, 0, 0)}
    assert macro._superseded("consumer_sentiment", old, MOMENTS, _ts(2026, 10, 2, 12, 0)) is False
    assert macro._superseded("cpi", old, MOMENTS, _ts(2026, 10, 2, 12, 0)) is False


def test_release_moment_is_0830_eastern(monkeypatch):
    import event_calendar as ec
    monkeypatch.setattr(ec, "release_events", lambda a, b: (
        [{"date": "2026-09-04", "kind": "NFP"}, {"date": "2026-10-02", "kind": "NFP"}], True))
    assert macro._last_release_moments(_ts(2026, 10, 2, 12, 0)) == {"NFP": RELEASE}
    assert macro._last_release_moments(_ts(2026, 10, 2, 8, 0)) == {"NFP": _ts(2026, 9, 4, 8, 30)}

    def boom(a, b):
        raise RuntimeError("FRED down")
    monkeypatch.setattr(ec, "release_events", boom)
    assert macro._last_release_moments(_ts(2026, 10, 2, 12, 0)) == {}


def test_release_mark_new_then_ordinary_and_pending():
    seen = {"ts": _ts(2026, 10, 2, 11, 45)}
    assert macro._release_mark("nfp", seen, MOMENTS, _ts(2026, 10, 2, 12, 0)) == {
        "released": "2026-10-02", "new": True, "pending": False}
    # A Friday print is still marked on Monday, not on Tuesday.
    assert macro._release_mark("nfp", seen, MOMENTS, _ts(2026, 10, 5, 8, 0))["new"] is True
    assert macro._release_mark("nfp", seen, MOMENTS, _ts(2026, 10, 6, 9, 0))["new"] is False
    stale = {"ts": _ts(2026, 9, 29, 10, 0)}
    assert macro._release_mark("nfp", stale, MOMENTS, _ts(2026, 10, 2, 12, 0)) == {
        "released": "2026-10-02", "new": False, "pending": True}
    assert macro._release_mark("consumer_sentiment", seen, MOMENTS, _ts(2026, 10, 2, 12, 0)) == {
        "released": None, "new": False, "pending": False}
