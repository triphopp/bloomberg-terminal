"""Rotation map (RRG trail) — agrees with the table's quadrant, shapes the trail.

No network: synthetic daily closes with a known relative trend.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from routers import rotation


def _series(daily_drift: float, n: int = 200, seed: int = 0) -> pd.Series:
    idx = pd.bdate_range("2026-01-02", periods=n)
    rng = np.random.default_rng(seed)
    ret = daily_drift + rng.normal(0, 0.002, n)
    return pd.Series(100 * np.exp(np.cumsum(ret)), index=idx)


@pytest.fixture
def bench() -> pd.Series:
    return _series(0.0, seed=1)


def test_trail_is_oldest_first_and_capped(bench):
    trail = rotation._rrg_trail(_series(0.001, seed=2), bench, tail=8)
    assert len(trail) == 8
    dates = [p["date"] for p in trail]
    assert dates == sorted(dates)
    assert all({"date", "ratio", "mom"} <= p.keys() for p in trail)


def test_trail_head_matches_table_quadrant(bench):
    for drift, seed in [(0.002, 3), (-0.002, 4), (0.0, 5)]:
        close = _series(drift, seed=seed)
        quad, _ = rotation._rrg_state(close, bench)
        head = rotation._rrg_trail(close, bench, tail=4)[-1]
        assert rotation._quadrant(head["ratio"], head["mom"]) == quad


def test_outperformer_has_ratio_above_100(bench):
    head = rotation._rrg_trail(_series(0.003, seed=6), bench, tail=2)[-1]
    assert head["ratio"] > 100


def test_short_history_gives_empty_trail(bench):
    assert rotation._rrg_trail(_series(0.001, n=40, seed=7), bench, tail=8) == []
    assert rotation._rrg_state(_series(0.001, n=40, seed=7), bench) == (None, None)


def test_quadrant_boundaries():
    assert rotation._quadrant(100, 100) == "Leading"
    assert rotation._quadrant(99.9, 100) == "Improving"
    assert rotation._quadrant(100, 99.9) == "Weakening"
    assert rotation._quadrant(99.9, 99.9) == "Lagging"


def test_build_map_us_uses_sectors_only(monkeypatch):
    syms = [s for _, s in rotation.SECTORS] + ["SPY"]
    frame = pd.DataFrame(
        {s: _series(0.0005 * (i - 5), seed=10 + i) for i, s in enumerate(syms)}
    )
    monkeypatch.setattr(rotation, "_download_closes", lambda _: frame)
    out = rotation._build_map("US", "SPY", tail=6)
    assert out["bench"] == "SPY" and out["tail"] == 6
    assert {r["symbol"] for r in out["rows"]} == {s for _, s in rotation.SECTORS}
    assert all(len(r["points"]) == 6 for r in out["rows"])


def test_build_map_missing_bench_reports_error(monkeypatch):
    monkeypatch.setattr(
        rotation, "_download_closes", lambda _: pd.DataFrame({"XLK": _series(0.0)})
    )
    out = rotation._build_map("US", "SPY", tail=6)
    assert out["rows"] == [] and out["error"]


def test_th_bench_falls_back_when_set_index_is_one_bar():
    closes = pd.DataFrame({"TDEX.BK": _series(0.0, seed=20)})
    closes["^SET.BK"] = np.nan
    closes.iloc[-1, closes.columns.get_loc("^SET.BK")] = 1600.0
    sym, series = rotation._th_bench(closes)
    assert sym == "TDEX.BK" and len(series) == len(closes)


def test_week_labels_are_real_sessions(bench):
    close = _series(0.001, seed=21)
    trail = rotation._rrg_trail(close, bench, tail=3)
    assert trail[-1]["date"] == str(close.index[-1].date())
