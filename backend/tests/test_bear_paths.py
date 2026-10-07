"""Down-tilted paths — backend/bear_paths.py (no network)."""
import numpy as np
import pytest

import bear_paths as bp


def _days(seed: int = 3, T: int = 750, m: int = 3) -> np.ndarray:
    rng = np.random.default_rng(seed)
    common = rng.standard_normal((T, 1))
    z = 0.6 * common + 0.8 * rng.standard_normal((T, m))        # holdings move together
    return (z - z.mean(0)) / z.std(0)


LR = np.array([0.015, 0.02, 0.03]) ** 2
EXPO = np.array([400.0, 300.0, 200.0])
NAV = 1000.0


def _sim(**kw):
    args = dict(p_down=0.6, n_paths=4000)
    args.update(kw)
    return bp.simulate(EXPO, NAV, _days(), LR, LR, **args)


def test_down_days_are_the_days_this_book_lost():
    Z = _days()
    down = bp.classify_days(Z, EXPO / NAV, LR)
    book = (Z * np.sqrt(LR)) @ (EXPO / NAV)
    assert (book[down] < 0).all() and (book[~down] >= 0).all()


def test_every_path_holds_more_down_days_than_up():
    rng = np.random.default_rng(0)
    for H in (3, 5, 7, 21, 42):
        k = bp._down_counts(rng, 5000, H, 0.6)
        assert (k > H / 2).all() and (k <= H).all()
    # Even at a coin flip the condition still holds: the tilt is the condition.
    assert (bp._down_counts(rng, 2000, 7, 0.5) >= 4).all()


def test_tilted_paths_sit_below_the_neutral_run_at_every_horizon():
    out = _sim()
    assert [h["days"] for h in out["horizons"]] == [3, 5, 7, 21, 42]
    for h in out["horizons"]:
        assert h["p50"] < h["base"]["p50"]
        assert h["p_loss"] > h["base"]["p_loss"]
        assert h["p5"] <= h["p25"] <= h["p50"] <= h["p75"] <= h["p95"]
        assert h["p_loss"] + h["p_end_up"] == pytest.approx(100, abs=0.2)
        assert h["max_dd_p95"] <= h["max_dd_p50"] <= 0


def test_not_every_path_ends_down():
    # "Not only down": some paths still finish above today.
    assert all(h["p_end_up"] > 0 for h in _sim()["horizons"])


def test_a_heavier_tilt_loses_more():
    mild, hard = _sim(p_down=0.55), _sim(p_down=0.8)
    for a, b in zip(mild["horizons"], hard["horizons"]):
        assert b["p50"] < a["p50"]


def test_longer_horizon_loses_more_at_the_median():
    p50 = [h["p50"] for h in _sim()["horizons"]]
    assert p50[-1] < p50[0]


def test_amounts_are_the_percentages_of_nav():
    h = _sim()["horizons"][2]
    assert h["amount_p50"] == pytest.approx(h["p50"] / 100 * NAV, abs=0.2)


def test_a_book_with_no_exposure_is_refused_not_simulated():
    # All cash has no losing days to draw from: the model says so instead of
    # returning a flat line that reads like a result.
    with pytest.raises(ValueError):
        bp.simulate(np.zeros(3), NAV, _days(), LR, LR, n_paths=1000)


def test_same_seed_same_answer_and_fan_covers_the_longest_horizon():
    a, b = _sim(), _sim()
    assert a["horizons"] == b["horizons"]
    fan = a["fan"]
    assert fan["days"][0] == 0 and fan["days"][-1] == 42
    assert fan["p50"][0] == 100 and len(fan["p5"]) == 43
    assert fan["p50"][-1] < fan["base_p50"][-1]


def test_holdings_named_are_the_ones_that_cost_the_most():
    out = bp.simulate(EXPO, NAV, _days(), LR, LR, n_paths=3000, labels=["A", "B", "C"])
    names = [x["symbol"] for x in out["horizons"][-1]["holdings"]]
    assert set(names) <= {"A", "B", "C"} and names
    contrib = [x["contrib_pct"] for x in out["horizons"][-1]["holdings"]]
    assert contrib == sorted(contrib) and all(c < 0 for c in contrib)


def test_p_down_bounds():
    with pytest.raises(ValueError):
        _sim(p_down=0.4)
