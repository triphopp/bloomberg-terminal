"""SET filing deadlines — the latest date a Thai listed company may publish.

Yahoo carries report dates only for the larger SET names; for the rest the
chart would show no upcoming earnings at all. The exchange's disclosure rule
still pins down *when at the latest* the numbers must arrive:

- quarterly statements (Q1–Q3): within 45 days of the quarter end
- annual statements: within 60 days of the year end for companies that skip a
  separate Q4 review (the common case; the outer limit is 3 months)

This is a deadline, not a scheduled date — companies often file earlier — so
the marker is flagged `deadline` and the UI says so. It assumes a calendar
fiscal year; a company with another year-end gets the wrong period label.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Iterable, Optional

QUARTER_DAYS = 45
ANNUAL_DAYS = 60


def _quarter_ends(around: date) -> list[date]:
    return [
        date(y, m, d)
        for y in (around.year - 1, around.year, around.year + 1)
        for m, d in ((3, 31), (6, 30), (9, 30), (12, 31))
    ]


def set_filing_deadline(today: date, reported: Iterable[date]) -> Optional[dict]:
    """Next deadline on/after `today` for a period the company has not reported yet.

    `reported` are past report dates (Yahoo's earnings history). A report that
    lands between a period's end and its deadline counts as that period filed.
    """
    done = sorted(set(reported))
    for qe in _quarter_ends(today):
        annual = qe.month == 12
        deadline = qe + timedelta(days=ANNUAL_DAYS if annual else QUARTER_DAYS)
        if deadline < today:
            continue
        if any(qe < r <= deadline for r in done):
            continue
        return {
            "date": deadline.isoformat(),
            "epsEstimate": None,
            "reportedEPS": None,
            "surprise": None,
            "eventType": "SET filing deadline",
            "source": "set_rule",
            "deadline": True,
            "period": f"FY {qe.year}" if annual else f"Q{(qe.month - 1) // 3 + 1} {qe.year}",
            "periodEnd": qe.isoformat(),
        }
    return None
