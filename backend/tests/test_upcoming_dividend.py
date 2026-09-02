"""The next ex-dividend date, which the paid history can never contain.

``ticker.dividends`` only records cash that has already gone ex, so a chart fed
from it alone shows the last dividend where the reader expects the next one.
Yahoo's calendar carries the declared date — but not always a *future* one, and
that is the case these tests pin down.
"""

import datetime as dt

import pytest

from routers.stock import _upcoming_dividend


class FakeTicker:
    def __init__(self, calendar):
        self._calendar = calendar

    @property
    def calendar(self):
        if isinstance(self._calendar, Exception):
            raise self._calendar
        return self._calendar


def _days(offset: int) -> dt.date:
    return dt.date.today() + dt.timedelta(days=offset)


PAID = [
    {"date": "2026-03-13", "dividend": 0.53},
    {"date": "2026-06-15", "dividend": 0.53},
]


def test_declared_future_ex_date_is_reported_with_the_last_amount():
    t = FakeTicker({"Ex-Dividend Date": _days(15), "Dividend Date": _days(31)})
    out = _upcoming_dividend(t, PAID)
    assert out["date"] == _days(15).strftime("%Y-%m-%d")
    assert out["payDate"] == _days(31).strftime("%Y-%m-%d")
    assert out["dividend"] == 0.53
    assert out["estimated"] is True


def test_a_stale_calendar_date_is_not_sold_as_upcoming():
    # Between the ex-date and the next declaration Yahoo keeps reporting the one
    # that just paid — AAPL sits like this for most of a quarter. Drawing it
    # ahead of the last bar would invent a dividend that is already gone.
    t = FakeTicker({"Ex-Dividend Date": _days(-20), "Dividend Date": _days(-6)})
    assert _upcoming_dividend(t, PAID) is None


def test_today_is_not_upcoming():
    t = FakeTicker({"Ex-Dividend Date": _days(0)})
    assert _upcoming_dividend(t, PAID) is None


def test_a_future_date_already_in_the_paid_history_is_dropped():
    future = _days(5)
    paid = PAID + [{"date": future.strftime("%Y-%m-%d"), "dividend": 0.53}]
    t = FakeTicker({"Ex-Dividend Date": future})
    assert _upcoming_dividend(t, paid) is None


def test_no_paid_history_still_reports_the_date_without_an_amount():
    t = FakeTicker({"Ex-Dividend Date": _days(9)})
    out = _upcoming_dividend(t, [])
    assert out["dividend"] is None
    assert out["estimated"] is False
    assert out["payDate"] is None


@pytest.mark.parametrize(
    "calendar",
    [{}, {"Ex-Dividend Date": None}, "not a dict", RuntimeError("yahoo said no")],
)
def test_a_missing_or_broken_calendar_is_silent(calendar):
    assert _upcoming_dividend(FakeTicker(calendar), PAID) is None
