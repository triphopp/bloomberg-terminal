"""
Unit tests for the normalize pipeline in backend/alerts/ast.py — ports
lib/alerts/normalize.ts's test cases 1:1 so both languages stay provably in
sync (memory/plans/alert-rule-engine.md §4).
Run: cd backend && python -m pytest tests/test_alerts_normalize.py -v
"""
from alerts.ast import (
    AndNode,
    ConstOperand,
    IndicatorOperand,
    NotNode,
    OrNode,
    Predicate,
    WithinNode,
    dedupe_node,
    flatten_node,
    normalize_node,
    to_nnf,
)


def cmp(left, comparator, right, right2=None):
    return Predicate(left=ConstOperand(left), cmp=comparator, right=ConstOperand(right), right2=right2 and ConstOperand(right2))


def rsi_lte(value):
    return Predicate(
        left=IndicatorOperand(id="rsi", output="rsi", params={"period": 14}), cmp="lte", right=ConstOperand(value)
    )


def rsi_gte(value):
    return Predicate(
        left=IndicatorOperand(id="rsi", output="rsi", params={"period": 14}), cmp="gte", right=ConstOperand(value)
    )


# ── to_nnf ───────────────────────────────────────────────────────────────────


def test_to_nnf_flips_comparators_via_de_morgan():
    pairs = [("lt", "gte"), ("gte", "lt"), ("lte", "gt"), ("gt", "lte"), ("eq", "neq"), ("neq", "eq")]
    for frm, to in pairs:
        node = NotNode(child=cmp(1, frm, 2))
        result = to_nnf(node)
        assert isinstance(result, Predicate)
        assert result.cmp == to

    node = NotNode(child=cmp(1, "between", 2, right2=3))
    result = to_nnf(node)
    assert result.cmp == "outside"


def test_to_nnf_pushes_not_through_and():
    node = NotNode(child=AndNode(children=(cmp(1, "gt", 0), cmp(2, "lt", 5))))
    result = to_nnf(node)
    assert isinstance(result, OrNode)
    assert result.children[0].cmp == "lte"  # NOT(gt) -> lte
    assert result.children[1].cmp == "gte"  # NOT(lt) -> gte


def test_to_nnf_pushes_not_through_or():
    node = NotNode(child=OrNode(children=(cmp(1, "eq", 0), cmp(2, "neq", 5))))
    result = to_nnf(node)
    assert isinstance(result, AndNode)
    assert result.children[0].cmp == "neq"
    assert result.children[1].cmp == "eq"


def test_to_nnf_eliminates_double_negation():
    node = NotNode(child=NotNode(child=cmp(1, "gt", 0)))
    result = to_nnf(node)
    assert isinstance(result, Predicate)
    assert result.cmp == "gt"


def test_to_nnf_leaves_crosses_above_wrapped():
    node = NotNode(child=Predicate(left=ConstOperand(1), cmp="crossesAbove", right=ConstOperand(2)))
    result = to_nnf(node)
    assert isinstance(result, NotNode)


def test_to_nnf_leaves_not_within_wrapped_but_normalizes_inside():
    node = NotNode(child=WithinNode(bars=3, child=NotNode(child=cmp(1, "gt", 0))))
    result = to_nnf(node)
    assert isinstance(result, NotNode)
    assert isinstance(result.child, WithinNode)
    inner = result.child.child
    assert inner.cmp == "lte"  # the nested NOT(gt) was still pushed to lte


# ── flatten ──────────────────────────────────────────────────────────────────


def test_flatten_merges_nested_and_under_and():
    node = AndNode(children=(AndNode(children=(cmp(1, "gt", 0), cmp(2, "gt", 0))), cmp(3, "gt", 0)))
    result = flatten_node(node)
    assert isinstance(result, AndNode)
    assert len(result.children) == 3


def test_flatten_does_not_merge_and_under_or():
    node = OrNode(children=(AndNode(children=(cmp(1, "gt", 0), cmp(2, "gt", 0))),))
    result = flatten_node(node)
    assert isinstance(result, OrNode)
    assert len(result.children) == 1
    assert isinstance(result.children[0], AndNode)


# ── dedupe ───────────────────────────────────────────────────────────────────


def test_dedupe_drops_duplicate_predicates_regardless_of_param_order():
    a = Predicate(
        left=IndicatorOperand(id="macd", output="hist", params={"fast": 12, "slow": 26}), cmp="gt", right=ConstOperand(0)
    )
    b = Predicate(
        left=IndicatorOperand(id="macd", output="hist", params={"slow": 26, "fast": 12}), cmp="gt", right=ConstOperand(0)
    )
    node = AndNode(children=(a, b))
    result = dedupe_node(node)
    assert len(result.children) == 1


# ── normalize_node: interval analysis ───────────────────────────────────────


def test_normalize_flags_contradiction():
    node = AndNode(children=(rsi_lte(30), rsi_gte(70)))
    _, warnings = normalize_node(node)
    assert any(w["kind"] == "contradiction" for w in warnings)


def test_normalize_flags_redundancy():
    node = AndNode(children=(rsi_lte(30), rsi_lte(50)))
    _, warnings = normalize_node(node)
    assert any(w["kind"] == "redundant" for w in warnings)


def test_normalize_has_no_warnings_for_independent_operands():
    rvol = Predicate(
        left=IndicatorOperand(id="rvol", output="rvol", params={"lookback": 20}), cmp="gte", right=ConstOperand(2)
    )
    node = AndNode(children=(rsi_lte(30), rvol))
    _, warnings = normalize_node(node)
    assert warnings == []


def test_normalize_does_not_cross_contaminate_or_branches():
    rvol = Predicate(
        left=IndicatorOperand(id="rvol", output="rvol", params={"lookback": 20}), cmp="gte", right=ConstOperand(2)
    )
    node = AndNode(children=(rsi_lte(30), OrNode(children=(rsi_gte(70), rvol))))
    _, warnings = normalize_node(node)
    assert not any(w["kind"] == "contradiction" for w in warnings)


def test_normalize_is_idempotent():
    node = AndNode(children=(rsi_lte(30), rsi_lte(50)))
    once_node, once_warnings = normalize_node(node)
    twice_node, twice_warnings = normalize_node(once_node)
    assert once_warnings == twice_warnings
