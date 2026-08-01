"""
Unit tests for backend/alerts/eval.py — AST -> boolean series, three-valued
semantics (memory/plans/alert-rule-engine.md §11).
Run: cd backend && python -m pytest tests/test_alerts_eval.py -v
"""
import numpy as np
import pytest

from alerts.ast import (
    AndNode,
    ConstOperand,
    IndicatorOperand,
    NotNode,
    OrNode,
    PctRankOperand,
    Predicate,
    PriceOperand,
    SustainedNode,
    WithinNode,
)
from alerts.eval import Bars, EvalError, evaluate, fires


def make_bars(close, high=None, low=None, open_=None, volume=None) -> Bars:
    close = np.asarray(close, dtype=float)
    n = len(close)
    return Bars(
        open=np.asarray(open_ if open_ is not None else close, dtype=float),
        high=np.asarray(high if high is not None else close, dtype=float),
        low=np.asarray(low if low is not None else close, dtype=float),
        close=close,
        volume=np.asarray(volume if volume is not None else np.ones(n), dtype=float),
    )


def no_indicator(_id, _params, _output):  # pragma: no cover - guard for tests that shouldn't need one
    raise AssertionError("this test should not resolve an indicator operand")


# ── basic comparators ────────────────────────────────────────────────────────


def test_simple_gt_predicate():
    bars = make_bars([1, 2, 3, 4, 5])
    node = Predicate(left=PriceOperand(field_="close"), cmp="gt", right=ConstOperand(3))
    result = evaluate(node, bars, no_indicator)
    np.testing.assert_array_equal(result.value, [False, False, False, True, True])
    np.testing.assert_array_equal(result.valid, [True] * 5)


def test_between_and_outside():
    bars = make_bars([1, 5, 10, 15, 20])
    inside = Predicate(
        left=PriceOperand(field_="close"), cmp="between", right=ConstOperand(5), right2=ConstOperand(15)
    )
    outside = Predicate(
        left=PriceOperand(field_="close"), cmp="outside", right=ConstOperand(5), right2=ConstOperand(15)
    )
    r_in = evaluate(inside, bars, no_indicator)
    r_out = evaluate(outside, bars, no_indicator)
    np.testing.assert_array_equal(r_in.value, [False, True, True, True, False])
    np.testing.assert_array_equal(r_out.value, ~r_in.value)


def test_offset_reads_a_prior_bar():
    bars = make_bars([10, 20, 30, 40, 50])
    node = Predicate(
        left=PriceOperand(field_="close"),
        cmp="gt",
        right=PriceOperand(field_="close", offset=1),
    )
    result = evaluate(node, bars, no_indicator)
    # bar 0 has no prior bar -> invalid; bars 1..4 are each greater than the previous
    np.testing.assert_array_equal(result.valid, [False, True, True, True, True])
    np.testing.assert_array_equal(result.value[1:], [True, True, True, True])


def test_crosses_above_fires_only_on_the_crossing_bar():
    close = [1, 2, 3, 2, 1, 2, 3]
    threshold = 2.5
    bars = make_bars(close)
    node = Predicate(left=PriceOperand(field_="close"), cmp="crossesAbove", right=ConstOperand(threshold))
    result = evaluate(node, bars, no_indicator)
    # crosses above 2.5 at index 2 (2->3) and again at index 6 (2->3)
    np.testing.assert_array_equal(result.value, [False, False, True, False, False, False, True])
    assert result.valid[0] == False  # noqa: E712 — no bar -1 to compare against


def test_indicator_length_mismatch_raises():
    bars = make_bars([1, 2, 3])
    node = Predicate(
        left=IndicatorOperand(id="rsi", output="rsi", params={"period": 14}),
        cmp="gt",
        right=ConstOperand(0),
    )
    with pytest.raises(EvalError):
        evaluate(node, bars, lambda *_: np.array([1.0, 2.0]))  # wrong length


# ── §11: NaN / invalid propagation ──────────────────────────────────────────


def test_warmup_nan_is_invalid_not_false():
    """An indicator with NaN warm-up bars must mark those bars invalid, and a
    NOT wrapped around it must NOT read those bars as True."""
    n = 10
    warmup = 4
    raw = np.array([np.nan] * warmup + [10.0] * (n - warmup))

    def resolve(_id, _params, _output):
        return raw

    predicate = Predicate(
        left=IndicatorOperand(id="rsi", output="rsi", params={"period": 14}),
        cmp="gt",
        right=ConstOperand(50),
    )
    plain = evaluate(predicate, make_bars(np.zeros(n)), resolve)
    np.testing.assert_array_equal(plain.valid[:warmup], [False] * warmup)
    np.testing.assert_array_equal(plain.valid[warmup:], [True] * (n - warmup))
    # raw values are 10, so "> 50" is False on every computable bar
    np.testing.assert_array_equal(plain.value[warmup:], [False] * (n - warmup))

    negated = evaluate(NotNode(child=predicate), make_bars(np.zeros(n)), resolve)
    # valid must be UNCHANGED by NOT — this is the whole point of §11
    np.testing.assert_array_equal(negated.valid, plain.valid)
    # and the warm-up bars must NOT read as True just because NOT flipped False->True
    assert not np.any(negated.value[:warmup] & negated.valid[:warmup])
    assert np.array_equal(fires(negated)[:warmup], np.zeros(warmup, dtype=bool))


def test_infinite_indicator_value_is_invalid_not_true():
    """A divide-by-zero indicator (rvol against a zero-volume baseline,
    bb-width against a zero SMA) produces +/-inf, which is not NaN — must
    still be caught, or a rule fires off a value nobody can act on."""
    n = 5
    raw = np.array([1.0, 2.0, np.inf, -np.inf, 3.0])

    def resolve(_id, _params, _output):
        return raw

    predicate = Predicate(
        left=IndicatorOperand(id="rvol", output="rvol", params={"lookback": 20}),
        cmp="gt",
        right=ConstOperand(0),
    )
    result = evaluate(predicate, make_bars(np.zeros(n)), resolve)
    np.testing.assert_array_equal(result.valid, [True, True, False, False, True])
    # the inf/-inf bars must not read as "fired" just because inf > 0
    assert not np.any(fires(result)[2:4])


def test_infinite_price_value_is_invalid_not_true():
    bars = make_bars([1.0, np.inf, 3.0])
    node = Predicate(left=PriceOperand(field_="close"), cmp="gt", right=ConstOperand(0))
    result = evaluate(node, bars, no_indicator)
    np.testing.assert_array_equal(result.valid, [True, False, True])


def test_and_or_valid_is_conjunction_of_both_branches():
    n = 5
    always_valid = Predicate(left=PriceOperand(field_="close"), cmp="gt", right=ConstOperand(-1))
    raw = np.array([np.nan, np.nan, 1.0, 1.0, 1.0])

    def resolve(_id, _params, _output):
        return raw

    sometimes_valid = Predicate(
        left=IndicatorOperand(id="x", output="x", params={}), cmp="gt", right=ConstOperand(0)
    )
    bars = make_bars([1, 1, 1, 1, 1])

    and_result = evaluate(AndNode(children=(always_valid, sometimes_valid)), bars, resolve)
    or_result = evaluate(OrNode(children=(always_valid, sometimes_valid)), bars, resolve)

    expected_valid = [False, False, True, True, True]
    np.testing.assert_array_equal(and_result.valid, expected_valid)
    np.testing.assert_array_equal(or_result.valid, expected_valid)


def test_fires_never_true_on_invalid_bars():
    n = 6
    raw = np.array([np.nan, np.nan, 1.0, 1.0, 1.0, 1.0])

    def resolve(_id, _params, _output):
        return raw

    predicate = Predicate(
        left=IndicatorOperand(id="x", output="x", params={}), cmp="gt", right=ConstOperand(0)
    )
    result = evaluate(NotNode(child=NotNode(child=predicate)), make_bars(np.zeros(n)), resolve)
    f = fires(result)
    assert not f[0] and not f[1]


# ── within / sustained ───────────────────────────────────────────────────────


def test_within_is_true_if_child_fired_anywhere_in_the_window():
    # child true only at index 2
    close = [0, 0, 1, 0, 0, 0]
    bars = make_bars(close)
    child = Predicate(left=PriceOperand(field_="close"), cmp="gt", right=ConstOperand(0.5))
    node = WithinNode(bars=3, child=child)
    result = evaluate(node, bars, no_indicator)
    # window of 3: index0 invalid(window<3), idx1 invalid, idx2=[0,0,1]->True,
    # idx3=[0,1,0]->True, idx4=[1,0,0]->True, idx5=[0,0,0]->False
    np.testing.assert_array_equal(result.valid, [False, False, True, True, True, True])
    np.testing.assert_array_equal(result.value[2:], [True, True, True, False])


def test_sustained_requires_every_bar_in_the_window():
    close = [1, 1, 1, 0, 1, 1, 1]
    bars = make_bars(close)
    child = Predicate(left=PriceOperand(field_="close"), cmp="gt", right=ConstOperand(0.5))
    node = SustainedNode(bars=3, child=child)
    result = evaluate(node, bars, no_indicator)
    # idx2=[1,1,1]->True, idx3=[1,1,0]->False, idx4=[1,0,1]->False,
    # idx5=[0,1,1]->False, idx6=[1,1,1]->True
    np.testing.assert_array_equal(result.value[2:], [True, False, False, False, True])


def test_within_valid_requires_full_window_of_valid_child_bars():
    n = 6
    raw = np.array([np.nan, 1.0, 1.0, 1.0, 1.0, 1.0])

    def resolve(_id, _params, _output):
        return raw

    child = Predicate(
        left=IndicatorOperand(id="x", output="x", params={}), cmp="gt", right=ConstOperand(0)
    )
    node = WithinNode(bars=2, child=child)
    result = evaluate(node, make_bars(np.zeros(n)), resolve)
    # window [nan-bar, bar1] at idx1 is invalid because bar0 was invalid
    assert result.valid[1] == False  # noqa: E712
    assert result.valid[2] == True  # noqa: E712 — window [bar1, bar2], both valid


# ── pctRank ──────────────────────────────────────────────────────────────────


def test_pctrank_of_monotonic_series_is_always_top_percentile():
    raw = np.array([1.0, 2.0, 3.0, 4.0, 5.0])

    def resolve(_id, _params, _output):
        return raw

    operand = PctRankOperand(of=IndicatorOperand(id="x", output="x", params={}), window=3)
    node = Predicate(left=operand, cmp="gte", right=ConstOperand(0.99))
    result = evaluate(node, make_bars(np.zeros(5)), resolve)
    np.testing.assert_array_equal(result.valid, [False, False, True, True, True])
    np.testing.assert_array_equal(result.value[2:], [True, True, True])


def test_pctrank_of_a_local_minimum_is_low():
    raw = np.array([5.0, 4.0, 3.0, 2.0, 1.0])

    def resolve(_id, _params, _output):
        return raw

    operand = PctRankOperand(of=IndicatorOperand(id="x", output="x", params={}), window=3)
    node = Predicate(left=operand, cmp="lte", right=ConstOperand(0.5))
    result = evaluate(node, make_bars(np.zeros(5)), resolve)
    np.testing.assert_array_equal(result.value[2:], [True, True, True])
