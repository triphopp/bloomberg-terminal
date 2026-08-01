"""
Unit tests for backend/alerts/ast.py — parse/validate/serialize/canonical keys.
Run: cd backend && python -m pytest tests/test_alerts_ast.py -v
"""
import pytest

from alerts.ast import (
    AndNode,
    AstValidationError,
    ConstOperand,
    IndicatorOperand,
    Predicate,
    node_key,
    operand_key,
    to_dict,
    validate,
)


# ── parse_node / validate: accepted shapes ──────────────────────────────────


def test_validate_accepts_plain_predicate():
    node = validate(
        {
            "op": "cmp",
            "left": {"src": "indicator", "id": "rsi", "params": {"period": 14}, "output": "rsi"},
            "cmp": "lte",
            "right": {"src": "const", "value": 30},
        }
    )
    assert isinstance(node, Predicate)
    assert isinstance(node.left, IndicatorOperand)
    assert node.left.params == {"period": 14}


def test_validate_accepts_nested_and_or_not_within_sustained():
    node = validate(
        {
            "op": "and",
            "children": [
                {
                    "op": "not",
                    "child": {
                        "op": "cmp",
                        "left": {"src": "price", "field": "close"},
                        "cmp": "gt",
                        "right": {"src": "const", "value": 0},
                    },
                },
                {
                    "op": "within",
                    "bars": 3,
                    "child": {
                        "op": "cmp",
                        "left": {"src": "indicator", "id": "macd", "params": {}, "output": "hist"},
                        "cmp": "crossesAbove",
                        "right": {"src": "const", "value": 0},
                    },
                },
                {
                    "op": "or",
                    "children": [
                        {
                            "op": "cmp",
                            "left": {"src": "price", "field": "close"},
                            "cmp": "gte",
                            "right": {"src": "const", "value": 100},
                        },
                        {
                            "op": "sustained",
                            "bars": 5,
                            "child": {
                                "op": "cmp",
                                "left": {"src": "price", "field": "volume"},
                                "cmp": "gt",
                                "right": {"src": "const", "value": 0},
                            },
                        },
                    ],
                },
            ],
        }
    )
    assert isinstance(node, AndNode)
    assert len(node.children) == 3


def test_validate_accepts_between_with_right2():
    node = validate(
        {
            "op": "cmp",
            "left": {"src": "price", "field": "close"},
            "cmp": "between",
            "right": {"src": "const", "value": 10},
            "right2": {"src": "const", "value": 20},
        }
    )
    assert node.right2 == ConstOperand(20.0)


@pytest.mark.parametrize("cmp", ["between", "outside"])
def test_validate_rejects_a_descending_constant_range(cmp):
    """eval.py reads between as `right <= x <= right2`, so 40..0 is false on
    every bar forever. §4's interval analysis can't catch it — that only looks
    at AND-groups with two or more predicates on one operand, and this is a
    single self-contradictory predicate. A real rule shaped exactly like this
    ("RSI(14) between 40 and 0") got saved before this check existed."""
    with pytest.raises(AstValidationError, match="ascending"):
        validate(
            {
                "op": "cmp",
                "left": {"src": "indicator", "id": "rsi", "output": "rsi", "params": {"period": 14}},
                "cmp": cmp,
                "right": {"src": "const", "value": 40},
                "right2": {"src": "const", "value": 0},
            }
        )


def test_validate_rejects_a_degenerate_equal_bound_range():
    with pytest.raises(AstValidationError, match="ascending"):
        validate(
            {
                "op": "cmp",
                "left": {"src": "price", "field": "close"},
                "cmp": "between",
                "right": {"src": "const", "value": 10},
                "right2": {"src": "const", "value": 10},
            }
        )


def test_validate_allows_a_range_between_non_constant_operands():
    """Only constants can be ordered at validation time — `close between
    EMA(50) and EMA(200)` is a legitimate rule whose ordering is data."""
    node = validate(
        {
            "op": "cmp",
            "left": {"src": "price", "field": "close"},
            "cmp": "between",
            "right": {"src": "indicator", "id": "ema", "output": "ema", "params": {"period": 200}},
            "right2": {"src": "indicator", "id": "ema", "output": "ema", "params": {"period": 50}},
        }
    )
    assert node.cmp == "between"


def test_validate_accepts_pctrank_operand():
    node = validate(
        {
            "op": "cmp",
            "left": {
                "src": "pctRank",
                "of": {"src": "indicator", "id": "bb-width", "params": {"period": 20}, "output": "width"},
                "window": 120,
            },
            "cmp": "lt",
            "right": {"src": "const", "value": 0.1},
        }
    )
    assert node.left.window == 120


# ── validate: structural errors ─────────────────────────────────────────────


@pytest.mark.parametrize("op", ["and", "or"])
def test_validate_rejects_empty_children(op):
    with pytest.raises(AstValidationError):
        validate({"op": op, "children": []})


def test_validate_rejects_unknown_op():
    with pytest.raises(AstValidationError):
        validate({"op": "xor"})


def test_validate_rejects_unknown_comparator():
    with pytest.raises(AstValidationError):
        validate(
            {
                "op": "cmp",
                "left": {"src": "const", "value": 1},
                "cmp": "wat",
                "right": {"src": "const", "value": 2},
            }
        )


def test_validate_requires_right2_for_between():
    with pytest.raises(AstValidationError):
        validate(
            {
                "op": "cmp",
                "left": {"src": "const", "value": 1},
                "cmp": "between",
                "right": {"src": "const", "value": 2},
            }
        )


def test_validate_rejects_right2_on_non_range_comparator():
    with pytest.raises(AstValidationError):
        validate(
            {
                "op": "cmp",
                "left": {"src": "const", "value": 1},
                "cmp": "lt",
                "right": {"src": "const", "value": 2},
                "right2": {"src": "const", "value": 3},
            }
        )


@pytest.mark.parametrize("bars", [0, -1, 1.5, True])
def test_validate_rejects_non_positive_within_bars(bars):
    with pytest.raises(AstValidationError):
        validate(
            {
                "op": "within",
                "bars": bars,
                "child": {
                    "op": "cmp",
                    "left": {"src": "const", "value": 1},
                    "cmp": "gt",
                    "right": {"src": "const", "value": 0},
                },
            }
        )


def test_validate_rejects_negative_offset():
    with pytest.raises(AstValidationError):
        validate(
            {
                "op": "cmp",
                "left": {"src": "price", "field": "close", "offset": -1},
                "cmp": "gt",
                "right": {"src": "const", "value": 0},
            }
        )


def test_validate_rejects_invalid_price_field():
    with pytest.raises(AstValidationError):
        validate(
            {
                "op": "cmp",
                "left": {"src": "price", "field": "wat"},
                "cmp": "gt",
                "right": {"src": "const", "value": 0},
            }
        )


def test_validate_rejects_indicator_missing_id():
    with pytest.raises(AstValidationError):
        validate(
            {
                "op": "cmp",
                "left": {"src": "indicator", "params": {}, "output": "rsi"},
                "cmp": "gt",
                "right": {"src": "const", "value": 0},
            }
        )


def test_validate_rejects_pctrank_window_below_2():
    with pytest.raises(AstValidationError):
        validate(
            {
                "op": "cmp",
                "left": {"src": "pctRank", "of": {"src": "const", "value": 1}, "window": 1},
                "cmp": "lt",
                "right": {"src": "const", "value": 0.5},
            }
        )


# ── to_dict round trip ──────────────────────────────────────────────────────


def test_to_dict_round_trips_through_validate():
    original = {
        "op": "and",
        "children": [
            {
                "op": "cmp",
                "left": {"src": "indicator", "id": "rsi", "params": {"period": 14}, "output": "rsi"},
                "cmp": "lte",
                "right": {"src": "const", "value": 30},
            },
            {
                "op": "cmp",
                "left": {"src": "price", "field": "close", "offset": 1},
                "cmp": "gt",
                "right": {"src": "const", "value": 0},
                "right2": None,
            },
        ],
    }
    node = validate(original)
    d = to_dict(node)
    reparsed = validate(d)
    assert to_dict(reparsed) == d


# ── operand_key / node_key ───────────────────────────────────────────────────


def test_operand_key_stable_regardless_of_param_order():
    a = operand_key(IndicatorOperand(id="macd", output="hist", params={"fast": 12, "slow": 26}))
    b = operand_key(IndicatorOperand(id="macd", output="hist", params={"slow": 26, "fast": 12}))
    assert a == b


def test_operand_key_distinguishes_offsets():
    from alerts.ast import PriceOperand

    a = operand_key(PriceOperand(field_="close", offset=0))
    b = operand_key(PriceOperand(field_="close", offset=1))
    assert a != b


def test_node_key_order_independent_for_and_children():
    p1 = Predicate(left=ConstOperand(1), cmp="gt", right=ConstOperand(0))
    p2 = Predicate(left=ConstOperand(2), cmp="gt", right=ConstOperand(0))
    a = AndNode(children=(p1, p2))
    b = AndNode(children=(p2, p1))
    assert node_key(a) == node_key(b)


def test_node_key_distinguishes_different_comparators():
    a = Predicate(left=ConstOperand(1), cmp="gt", right=ConstOperand(0))
    b = Predicate(left=ConstOperand(1), cmp="gte", right=ConstOperand(0))
    assert node_key(a) != node_key(b)
