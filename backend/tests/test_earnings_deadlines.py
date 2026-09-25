"""SET filing deadline — 45 days after a quarter, 60 after the year."""

from __future__ import annotations

from datetime import date

from earnings_deadlines import set_filing_deadline


def test_next_quarter_deadline_after_quarter_end():
    out = set_filing_deadline(date(2026, 9, 25), [date(2026, 8, 10)])
    assert out["date"] == "2026-11-14" and out["period"] == "Q3 2026"
    assert out["deadline"] is True and out["periodEnd"] == "2026-09-30"


def test_inside_filing_window_before_report():
    # Q2 ended 06-30, deadline 08-14; nothing filed yet on 08-01.
    out = set_filing_deadline(date(2026, 8, 1), [date(2026, 5, 12)])
    assert out["date"] == "2026-08-14" and out["period"] == "Q2 2026"


def test_period_already_filed_moves_to_next():
    out = set_filing_deadline(date(2026, 11, 10), [date(2026, 11, 5)])
    assert out["period"] == "FY 2026" and out["date"] == "2027-03-01"


def test_annual_deadline_leap_year():
    out = set_filing_deadline(date(2028, 1, 15), [])
    assert out["date"] == "2028-02-29" and out["period"] == "FY 2027"


def test_deadline_today_is_still_upcoming():
    out = set_filing_deadline(date(2026, 11, 14), [])
    assert out["date"] == "2026-11-14"
