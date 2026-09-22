"""Sector rotation tilt + the self-built AUM flow estimators.

The two things worth pinning down here are the ones a reader will trust without
checking: that the z printed next to a move is the z of the MOVE (not of the
level, which is nearly constant and would make every sector look normal), and
that a flow estimate is refused rather than guessed while the record is one day
long.
"""
import pandas as pd
import pytest

import etf_aum
from routers.rotation import (
    CYCLICAL,
    DEFENSIVE,
    UNALIGNED,
    _delta_z,
    _window_delta_bp,
    _z_last,
)


def test_buckets_are_disjoint_and_cover_the_complex():
    from routers.rotation import SECTOR_ETFS_ORDER

    assert not set(DEFENSIVE) & set(CYCLICAL)
    assert not set(DEFENSIVE) & set(UNALIGNED)
    assert not set(CYCLICAL) & set(UNALIGNED)
    assert set(DEFENSIVE) | set(CYCLICAL) | set(UNALIGNED) == set(SECTOR_ETFS_ORDER)


def test_window_delta_is_reported_in_basis_points():
    # share rises from 10% to 11% over the window → +100bp
    s = pd.Series([0.10] * 21 + [0.11])
    assert _window_delta_bp(s, 20) == pytest.approx(100.0, abs=0.5)


def test_window_delta_needs_a_full_window():
    assert _window_delta_bp(pd.Series([0.1, 0.1, 0.1]), 20) is None


def test_z_is_of_the_change_not_the_level():
    """A share parked at a high level is not news; a share that just moved is.

    The series below stepped up months ago and has been flat since. Scoring the
    LEVEL still calls it an outlier, because the level really is high relative
    to the trailing year. Scoring the CHANGE says what the panel means: nothing
    moved this window.
    """
    settled = pd.Series([0.30] * 300 + [0.40] * 200)
    level_z = _z_last(settled)
    change_z = _delta_z(settled, 20)
    assert level_z is not None and change_z is not None
    assert level_z > 0.5
    assert abs(change_z) < 0.5


def test_z_marks_a_move_that_just_happened():
    moving = pd.Series([0.30] * 400 + list(pd.Series(range(20)) / 20 * 0.06 + 0.30))
    z = _delta_z(moving, 20)
    assert z is not None and z > 1.5


def test_z_refuses_a_constant_series():
    assert _z_last(pd.Series([0.2] * 300)) is None


def test_flow_is_refused_until_two_days_exist(monkeypatch):
    monkeypatch.setattr(
        etf_aum,
        "history",
        lambda symbols=etf_aum.SECTOR_ETFS, days=400: [
            {"as_of": "2026-09-22", "symbol": "XLK", "total_assets": 1e11,
             "nav": 100.0, "close": 100.0, "implied_shares": 1e9},
        ],
    )
    out = etf_aum.flows(("XLK",))
    assert out["available"] is False
    assert out["days_stored"] == 1


def test_both_flow_estimators_see_the_same_creation(monkeypatch):
    """10M new shares created at a NAV that also rose 1%.

    shares method: +10M × 101 = +$1.01bn.
    return method: 101.0bn − 100.0bn × 1.01 = +$1.01bn (floating point aside).
    They agree because the day is clean; the panel keeps them apart precisely so
    that a day where they DON'T agree is visible.
    """
    monkeypatch.setattr(
        etf_aum,
        "history",
        lambda symbols=etf_aum.SECTOR_ETFS, days=400: [
            {"as_of": "2026-09-22", "symbol": "XLK", "total_assets": 100e9,
             "nav": 100.0, "close": 100.0, "implied_shares": 1e9},
            {"as_of": "2026-09-23", "symbol": "XLK", "total_assets": 101e9 + 1.01e9,
             "nav": 101.0, "close": 101.0, "implied_shares": 1.01e9},
        ],
    )
    out = etf_aum.flows(("XLK",))
    assert out["available"] is True
    row = out["rows"][0]
    assert row["flow_shares_method"] == pytest.approx(1.01e9, rel=1e-6)
    assert row["flow_return_method"] == pytest.approx(1.01e9, rel=1e-6)


def test_missing_shares_leaves_the_shares_method_undefined(monkeypatch):
    """A NAV Yahoo did not publish costs the exact estimator, not the row."""
    monkeypatch.setattr(
        etf_aum,
        "history",
        lambda symbols=etf_aum.SECTOR_ETFS, days=400: [
            {"as_of": "2026-09-22", "symbol": "XLU", "total_assets": 20e9,
             "nav": 40.0, "close": 40.0, "implied_shares": None},
            {"as_of": "2026-09-23", "symbol": "XLU", "total_assets": 21e9,
             "nav": 41.0, "close": 41.0, "implied_shares": None},
        ],
    )
    row = etf_aum.flows(("XLU",))["rows"][0]
    assert row["flow_shares_method"] is None
    assert row["flow_return_method"] is not None
