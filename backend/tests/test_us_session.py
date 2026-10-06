"""backend/us_session.py — which US session a market reading belongs to.

The case that started it (2026-10-06): a machine in UTC+7 filed Friday's
session and a Saturday-morning chain both under Saturday 2026-10-03.
"""
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import pytest

import us_session

ET = ZoneInfo("America/New_York")
UTC = timezone.utc


@pytest.mark.parametrize("when_et,expected", [
    (datetime(2026, 10, 2, 13, 6), date(2026, 10, 2)),    # Fri mid-session (alvis, 2026-10-02 17:06 UTC)
    (datetime(2026, 10, 2, 16, 32), date(2026, 10, 2)),   # Fri after the close
    (datetime(2026, 10, 3, 6, 48), date(2026, 10, 2)),    # Sat morning: Friday's chain (this machine)
    (datetime(2026, 10, 4, 22, 0), date(2026, 10, 2)),    # Sun night
    (datetime(2026, 10, 5, 9, 29), date(2026, 10, 2)),    # Mon before the open
    (datetime(2026, 10, 5, 9, 30), date(2026, 10, 5)),    # Mon at the open
    (datetime(2026, 10, 6, 8, 0), date(2026, 10, 5)),     # Tue pre-market → Monday
])
def test_session_date(when_et, expected):
    assert us_session.session_date(when_et.replace(tzinfo=ET)) == expected


def test_both_readings_of_the_2026_10_03_conflict_belong_to_friday():
    alvis = datetime(2026, 10, 2, 17, 6, tzinfo=UTC)
    here = datetime(2026, 10, 3, 10, 48, tzinfo=UTC)
    assert us_session.session_date(alvis) == us_session.session_date(here) == date(2026, 10, 2)


def test_is_after_close():
    assert not us_session.is_after_close(datetime(2026, 10, 7, 15, 59, tzinfo=ET))
    assert us_session.is_after_close(datetime(2026, 10, 7, 16, 0, tzinfo=ET))
    assert us_session.is_after_close(datetime(2026, 10, 8, 7, 0, tzinfo=ET))    # next pre-market
    assert us_session.is_after_close(datetime(2026, 10, 10, 12, 0, tzinfo=ET))  # Saturday
    assert not us_session.is_after_close(datetime(2026, 10, 8, 10, 0, tzinfo=ET))


def test_written_after_close_compares_with_the_rows_own_session():
    friday = "2026-10-02"
    assert us_session.written_after_close("2026-10-02 17:06:00", friday) is False   # 13:06 ET
    assert us_session.written_after_close("2026-10-02 20:32:01.123", friday) is True  # 16:32 ET
    assert us_session.written_after_close("2026-10-03 10:48:47", friday) is True    # Saturday
    assert us_session.written_after_close("garbage", friday) is None
    assert us_session.written_after_close(None, friday) is None


def test_close_follows_daylight_saving():
    assert us_session.close_utc(date(2026, 7, 1)).hour == 20     # EDT
    assert us_session.close_utc(date(2026, 12, 1)).hour == 21    # EST


def test_the_writer_files_a_snapshot_under_the_session(monkeypatch):
    """routers/options.py must date the row by the session, not by date.today()."""
    import routers.options as opt

    rows = []

    class _Conn:
        def execute(self, sql, params=()):
            rows.append(params)

    class _Ctx:
        def __enter__(self):
            return _Conn()

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(opt, "get_db", lambda: _Ctx())
    monkeypatch.setattr(us_session, "session_date", lambda now=None: date(2026, 10, 2))
    assert opt._record_iv_snapshot("spy", "2099-01-16", 500.0, 500.0, 0.2, 0.2, 0.2) is True
    assert rows[0][0] == "SPY" and rows[0][1] == "2026-10-02"
