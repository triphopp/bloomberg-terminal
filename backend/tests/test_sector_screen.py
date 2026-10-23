"""Sector screen — percentiles, factor scores, regime rule, betas, flags. No network."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

import sector_screen as ss


def test_pct_rank_direction_ties_and_gaps():
    r = ss.pct_rank({"A": 1.0, "B": 2.0, "C": 3.0, "D": None})
    assert r == {"A": 0.0, "B": 50.0, "C": 100.0, "D": None}
    assert ss.pct_rank({"A": 1.0, "B": 2.0, "C": 3.0}, higher_is_better=False)["A"] == 100.0
    assert ss.pct_rank({"A": 1.0, "B": 1.0, "C": 3.0})["A"] == 25.0
    # too few to rank
    assert ss.pct_rank({"A": 1.0, "B": 2.0}) == {"A": None, "B": None}


@pytest.mark.parametrize("vix,move,fg,state", [
    (50, 50, 50, "normal"),
    (85, 50, 50, "stress"),
    (50, 96, 50, "stress"),
    (50, 50, 20, "stress"),
    (20, 50, 80, "greed"),
    (60, 50, 80, "normal"),   # greedy but VIX not calm
    (None, None, None, "normal"),
])
def test_regime_rule(vix, move, fg, state):
    assert ss.regime(vix, move, fg) == state


def test_weights_sum_to_one():
    for w in ss.WEIGHTS.values():
        assert sum(w.values()) == pytest.approx(1.0)
    assert ss.WEIGHTS["stress"]["momentum"] < ss.WEIGHTS["normal"]["momentum"]


def _raw(mom, vol, roe, pe_inv):
    return {"mom_12_1": mom, "vol_1y": vol, "roe": roe, "roa": roe, "gross_margin": roe,
            "debt_to_equity": None, "earnings_yield": pe_inv, "ebitda_to_ev": pe_inv, "book_to_price": pe_inv}


def test_score_uses_the_factors_a_stock_has():
    raw = {"A": _raw(0.5, 0.2, 0.3, 0.10), "B": _raw(0.1, 0.4, 0.1, 0.05), "C": _raw(0.3, 0.3, 0.2, None)}
    out = ss.score(raw, ss.WEIGHTS["normal"])
    assert out["A"]["factors"] == {"momentum": 100.0, "quality": 100.0, "value": None, "low_vol": 100.0}
    # value: only two members have it — not ranked
    assert out["A"]["coverage"] == 3 and out["A"]["score"] == 100.0
    assert out["B"]["score"] == 0.0


def test_financial_quality_skips_margin_and_leverage():
    raw = {s: {"roe": r, "roa": r, "gross_margin": g, "debt_to_equity": d}
           for s, r, g, d in (("A", 0.2, 0.1, 900), ("B", 0.1, 0.9, 100), ("C", 0.15, 0.5, 500))}
    plain = ss.score(raw, ss.WEIGHTS["normal"])["A"]["factors"]["quality"]
    fin = ss.score(raw, ss.WEIGHTS["normal"], financial=True)["A"]["factors"]["quality"]
    assert fin == 100.0 and plain < fin


def _series(rets, start=100.0):
    idx = pd.bdate_range("2025-01-01", periods=len(rets) + 1)
    return pd.Series(start * np.cumprod(np.r_[1.0, 1 + np.asarray(rets)]), index=idx)


def test_momentum_skips_the_last_month_and_vol_is_annualised():
    c = _series([0.001] * 260)
    m = ss.momentum_12_1(c)
    assert m == pytest.approx(c.iloc[-22] / c.iloc[-252] - 1)
    assert ss.momentum_12_1(_series([0.0] * 100)) is None
    rng = np.random.default_rng(0)
    v = ss.vol_1y(_series(rng.normal(0, 0.01, 300)))
    assert 0.12 < v < 0.20


def test_beta_recovers_a_known_slope():
    rng = np.random.default_rng(1)
    idx_r = rng.normal(0, 0.05, 300)
    stock_r = -0.2 * idx_r + rng.normal(0, 0.002, 300)
    b = ss.beta(_series(stock_r), _series(idx_r, 20))
    assert b == pytest.approx(-0.2, abs=0.02)


def test_series_pct():
    s = pd.Series(range(100), dtype=float)
    assert ss.series_pct(s) == 99.0
    assert ss.series_pct(pd.Series([1.0] * 5)) is None
