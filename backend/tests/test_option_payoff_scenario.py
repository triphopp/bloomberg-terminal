"""Scenario repricing in analytics/option_payoff.py — the PORT → OPTIONS simulator."""

from datetime import date, timedelta

import pytest

from analytics.option_payoff import (
    build_payoff,
    payoff_at_expiry,
    scenario_horizons,
    value_at,
    value_today,
)


def _exp(days: int) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


def _leg(**kw):
    base = dict(underlying="XYZ", expiry=_exp(30), strike=100.0, option_type="call",
                quantity=1, entry_price=3.0, multiplier=100, fees=0)
    base.update(kw)
    return base


def test_value_at_zero_offset_matches_value_today():
    legs = [_leg()]
    assert value_at(legs, 105.0, [0.3]) == pytest.approx(value_today(legs, 105.0, [0.3]))


def test_value_at_expiry_horizon_is_the_arithmetic_payoff():
    legs = [_leg(), _leg(strike=110.0, quantity=-1, entry_price=1.0)]
    for s in (80.0, 100.0, 104.0, 130.0):
        assert value_at(legs, s, [0.3, 0.3], days_forward=30) == pytest.approx(
            payoff_at_expiry(legs, s)
        )


def test_expired_leg_needs_no_iv():
    # Past the horizon the leg is intrinsic — a missing IV must not blank it.
    assert value_at([_leg()], 110.0, [None], days_forward=30) == pytest.approx(700.0)
    assert value_at([_leg()], 110.0, [None], days_forward=10) is None


def test_iv_shift_moves_long_and_short_in_opposite_directions():
    long_, short = [_leg()], [_leg(quantity=-1)]
    assert value_at(long_, 100.0, [0.3], iv_shift=0.1) > value_at(long_, 100.0, [0.3])
    assert value_at(short, 100.0, [0.3], iv_shift=0.1) < value_at(short, 100.0, [0.3])


def test_iv_shift_floors_rather_than_going_negative():
    assert value_at([_leg()], 100.0, [0.05], iv_shift=-0.5) is not None


def test_time_decay_hurts_a_long_atm_option():
    legs = [_leg()]
    assert value_at(legs, 100.0, [0.3], days_forward=20) < value_at(legs, 100.0, [0.3])


def test_horizons_give_each_expiry_its_own_column():
    legs = [_leg(expiry=_exp(10)), _leg(expiry=_exp(40), quantity=-1)]
    h = scenario_horizons(legs, days_forward=5)
    assert [x["days"] for x in h] == [0, 5, 10, 40]
    assert [x["expiry"] for x in h] == [False, False, True, True]
    # A chosen date that lands on an expiry is not duplicated.
    assert [x["days"] for x in scenario_horizons(legs, 10)] == [0, 10, 40]


def test_build_payoff_scenario_block():
    legs = [_leg()]
    out = build_payoff(legs, 100.0, [0.3], days_forward=15, iv_shift=-0.05, moves=[-10, 0, 10])
    sc = out["scenario"]
    assert sc["active"] is True
    assert [r["move_pct"] for r in sc["grid"]] == [-10, 0, 10]
    assert all(len(r["values"]) == len(sc["horizons"]) for r in sc["grid"])
    assert all("sim" in p for p in out["curve"])
    assert out["current"]["pnl_sim"] is not None
    # Expiry column of the grid equals the arithmetic payoff.
    col = [h["expiry"] for h in sc["horizons"]].index(True)
    up = next(r for r in sc["grid"] if r["move_pct"] == 10)
    assert up["values"][col] == pytest.approx(payoff_at_expiry(legs, 110.0))


def test_build_payoff_no_scenario_has_no_sim_line():
    out = build_payoff([_leg()], 100.0, [0.3])
    assert out["scenario"]["active"] is False
    assert all("sim" not in p for p in out["curve"])
    assert out["current"]["pnl_sim"] is None


def test_days_forward_is_clamped_to_the_last_expiry():
    out = build_payoff([_leg()], 100.0, [0.3], days_forward=999)
    assert out["scenario"]["days_forward"] == 30
