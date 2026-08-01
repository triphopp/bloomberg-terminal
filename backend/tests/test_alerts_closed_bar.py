"""
Unit tests for the closed-bar guard (memory/plans/alert-rule-engine.md §7.2,
§13) — `backend.routers.alert_rules._drop_unclosed_last_bar`.

yfinance's daily interval keeps rewriting today's row while the session is
open. Before this guard, a scan run mid-session evaluated that half-formed
bar as if it were a completed day, which the plan calls out by name for
RVOL/Volume rules: "engine ต้องมี option evaluateOnClosedBarsOnly (default
true) ไม่งั้น rule volume จะยิงมั่วทุกเช้า".

`datetime.date.today()` isn't mocked here — instead every test builds its
bar_times relative to the real today, which is both simpler and exercises the
exact comparison the guard makes.

Run: cd backend && python -m pytest tests/test_alerts_closed_bar.py -v
"""
import datetime

import numpy as np
import pytest

from alerts.eval import Bars
from routers.alert_rules import _drop_unclosed_last_bar

TODAY = str(datetime.date.today())
YESTERDAY = str(datetime.date.today() - datetime.timedelta(days=1))
TWO_DAYS_AGO = str(datetime.date.today() - datetime.timedelta(days=2))


def make_bars(n: int) -> Bars:
    vals = np.arange(1.0, n + 1)
    return Bars(open=vals, high=vals, low=vals, close=vals, volume=vals)


def test_drops_todays_row_when_present():
    bars = make_bars(3)
    trimmed, times = _drop_unclosed_last_bar(bars, [TWO_DAYS_AGO, YESTERDAY, TODAY])
    assert times == [TWO_DAYS_AGO, YESTERDAY]
    assert trimmed.close.tolist() == [1.0, 2.0]
    assert trimmed.volume.tolist() == [1.0, 2.0]


def test_leaves_a_fully_closed_history_untouched():
    """The common case after market close / on a symbol yfinance hasn't
    updated yet today — nothing to trim."""
    bars = make_bars(3)
    trimmed, times = _drop_unclosed_last_bar(bars, [TWO_DAYS_AGO, YESTERDAY, TWO_DAYS_AGO])
    assert times == [TWO_DAYS_AGO, YESTERDAY, TWO_DAYS_AGO]
    assert trimmed.close.tolist() == bars.close.tolist()


def test_only_the_last_row_can_be_dropped_even_if_todays_date_repeats_earlier():
    """A pathological/synthetic series shouldn't have this happen, but the
    guard must never touch anything but index -1 — every earlier row is a
    completed session by construction."""
    bars = make_bars(3)
    trimmed, times = _drop_unclosed_last_bar(bars, [TODAY, YESTERDAY, TODAY])
    assert times == [TODAY, YESTERDAY]
    assert len(trimmed.close) == 2


def test_empty_bar_times_is_a_no_op():
    bars = make_bars(0)
    trimmed, times = _drop_unclosed_last_bar(bars, [])
    assert times == []
    assert len(trimmed.close) == 0


def test_a_single_unclosed_bar_trims_to_fully_empty():
    """A brand-new listing with only today's row: nothing closed exists yet.
    Must produce an empty-but-valid Bars, matching what the caller already
    does for `bars is None` (skip the symbol), not raise or index -1 into
    nothing."""
    bars = make_bars(1)
    trimmed, times = _drop_unclosed_last_bar(bars, [TODAY])
    assert times == []
    assert len(trimmed.close) == 0
    assert len(trimmed.volume) == 0


def test_a_single_closed_bar_is_kept():
    bars = make_bars(1)
    trimmed, times = _drop_unclosed_last_bar(bars, [YESTERDAY])
    assert times == [YESTERDAY]
    assert trimmed.close.tolist() == [1.0]


def test_trimmed_arrays_stay_aligned_across_all_fields():
    n = 5
    bars = Bars(
        open=np.arange(10, 10 + n, dtype=float),
        high=np.arange(20, 20 + n, dtype=float),
        low=np.arange(30, 30 + n, dtype=float),
        close=np.arange(40, 40 + n, dtype=float),
        volume=np.arange(50, 50 + n, dtype=float),
    )
    times = [TWO_DAYS_AGO] * 4 + [TODAY]
    trimmed, kept_times = _drop_unclosed_last_bar(bars, times)
    assert len(kept_times) == 4
    assert trimmed.open[-1] == 13.0
    assert trimmed.high[-1] == 23.0
    assert trimmed.low[-1] == 33.0
    assert trimmed.close[-1] == 43.0
    assert trimmed.volume[-1] == 53.0
