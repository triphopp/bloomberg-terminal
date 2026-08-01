"""
Alert Rule Engine — AST types + structural validation (Python side).

Mirrors lib/alerts/ast.ts field-for-field — a rule's `expr` crosses the wire
as plain JSON (stored as expr_json, sent from the modal as-is), so both sides
parse/serialize the exact same shape.

See memory/plans/alert-rule-engine.md §1.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Union

Comparator = Literal[
    "lt", "lte", "gt", "gte", "eq", "neq",
    "crossesAbove", "crossesBelow",
    "between", "outside",
]

_COMPARATORS = {
    "lt", "lte", "gt", "gte", "eq", "neq",
    "crossesAbove", "crossesBelow", "between", "outside",
}
_RANGE_COMPARATORS = {"between", "outside"}
_PRICE_FIELDS = {"open", "high", "low", "close", "volume"}


class AstValidationError(ValueError):
    def __init__(self, message: str, path: str):
        super().__init__(f"{path}: {message}")
        self.path = path


def _is_int_at_least(x: Any, minimum: int) -> bool:
    return isinstance(x, int) and not isinstance(x, bool) and x >= minimum


# ── Operands ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class IndicatorOperand:
    id: str
    output: str
    params: dict[str, Any] = field(default_factory=dict)
    offset: int = 0
    src: Literal["indicator"] = "indicator"


@dataclass(frozen=True)
class PriceOperand:
    # named field_ — `field` would shadow dataclasses.field
    field_: str  # "open" | "high" | "low" | "close" | "volume"
    offset: int = 0
    src: Literal["price"] = "price"


@dataclass(frozen=True)
class ConstOperand:
    value: float
    src: Literal["const"] = "const"


@dataclass(frozen=True)
class PctRankOperand:
    of: "Operand"
    window: int
    src: Literal["pctRank"] = "pctRank"


Operand = Union[IndicatorOperand, PriceOperand, ConstOperand, PctRankOperand]


# ── Nodes ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Predicate:
    left: Operand
    cmp: Comparator
    right: Operand
    right2: Operand | None = None
    origin: dict[str, Any] | None = None
    op: Literal["cmp"] = "cmp"


@dataclass(frozen=True)
class AndNode:
    children: tuple["RuleNode", ...]
    op: Literal["and"] = "and"


@dataclass(frozen=True)
class OrNode:
    children: tuple["RuleNode", ...]
    op: Literal["or"] = "or"


@dataclass(frozen=True)
class NotNode:
    child: "RuleNode"
    op: Literal["not"] = "not"


@dataclass(frozen=True)
class WithinNode:
    bars: int
    child: "RuleNode"
    op: Literal["within"] = "within"


@dataclass(frozen=True)
class SustainedNode:
    bars: int
    child: "RuleNode"
    op: Literal["sustained"] = "sustained"


RuleNode = Union[AndNode, OrNode, NotNode, WithinNode, SustainedNode, Predicate]


# ── Parse: JSON dict -> dataclass tree ──────────────────────────────────────


def parse_operand(d: Any, path: str) -> Operand:
    if not isinstance(d, dict):
        raise AstValidationError("operand must be an object", path)
    src = d.get("src")

    if src in ("indicator", "price"):
        offset = d.get("offset", 0)
        if not _is_int_at_least(offset, 0):
            raise AstValidationError("offset must be a non-negative integer", path)
    else:
        offset = 0

    if src == "indicator":
        if not d.get("id"):
            raise AstValidationError("indicator operand requires id", path)
        if not d.get("output"):
            raise AstValidationError("indicator operand requires output", path)
        return IndicatorOperand(
            id=d["id"], output=d["output"], params=dict(d.get("params", {})), offset=offset
        )
    if src == "price":
        if d.get("field") not in _PRICE_FIELDS:
            raise AstValidationError(f"invalid price field {d.get('field')!r}", path)
        return PriceOperand(field_=d["field"], offset=offset)
    if src == "const":
        value = d.get("value")
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise AstValidationError("const operand requires a numeric value", path)
        return ConstOperand(value=float(value))
    if src == "pctRank":
        window = d.get("window")
        if not _is_int_at_least(window, 2):
            raise AstValidationError("pctRank.window must be an integer >= 2", path)
        return PctRankOperand(of=parse_operand(d.get("of"), f"{path}.of"), window=window)
    raise AstValidationError(f"unknown operand src {src!r}", path)


def parse_node(d: Any, path: str = "$") -> RuleNode:
    if not isinstance(d, dict):
        raise AstValidationError("node must be an object", path)
    op = d.get("op")

    if op in ("and", "or"):
        children = d.get("children")
        if not isinstance(children, list) or len(children) == 0:
            raise AstValidationError(f"{op} requires at least 1 child", path)
        parsed = tuple(parse_node(c, f"{path}.children[{i}]") for i, c in enumerate(children))
        return AndNode(children=parsed) if op == "and" else OrNode(children=parsed)

    if op == "not":
        child = d.get("child")
        if child is None:
            raise AstValidationError("not requires a child", path)
        return NotNode(child=parse_node(child, f"{path}.child"))

    if op in ("within", "sustained"):
        bars = d.get("bars")
        if not _is_int_at_least(bars, 1):
            raise AstValidationError(f"{op}.bars must be a positive integer", path)
        child = d.get("child")
        if child is None:
            raise AstValidationError(f"{op} requires a child", path)
        parsed_child = parse_node(child, f"{path}.child")
        return (
            WithinNode(bars=bars, child=parsed_child)
            if op == "within"
            else SustainedNode(bars=bars, child=parsed_child)
        )

    if op == "cmp":
        cmp = d.get("cmp")
        if cmp not in _COMPARATORS:
            raise AstValidationError(f'unknown comparator "{cmp}"', path)
        left = parse_operand(d.get("left"), f"{path}.left")
        right = parse_operand(d.get("right"), f"{path}.right")
        right2_raw = d.get("right2")
        if cmp in _RANGE_COMPARATORS:
            if right2_raw is None:
                raise AstValidationError(f"{cmp} requires right2", path)
            right2 = parse_operand(right2_raw, f"{path}.right2")
            # eval.py reads between as `right <= x <= right2`, so bounds given
            # the wrong way round produce a predicate that is false on every
            # bar forever. The §4 interval analysis can't catch it — that only
            # inspects AND-groups holding two or more predicates on the same
            # operand, and this is one self-contradictory predicate. Reject it
            # here, where every save and preview already passes through.
            if isinstance(right, ConstOperand) and isinstance(right2, ConstOperand):
                if right.value >= right2.value:
                    raise AstValidationError(
                        f"{cmp} needs an ascending range: lower bound {right.value} "
                        f"must be less than upper bound {right2.value}",
                        path,
                    )
        else:
            if right2_raw is not None:
                raise AstValidationError(
                    f"right2 is only valid for between/outside, not {cmp}", path
                )
            right2 = None
        return Predicate(left=left, cmp=cmp, right=right, right2=right2, origin=d.get("origin"))

    raise AstValidationError(f'unknown node op "{op}"', path)


def validate(d: Any) -> RuleNode:
    """Parse + structurally validate. Raises AstValidationError on any problem."""
    return parse_node(d)


# ── Serialize: dataclass tree -> JSON dict (inverse of parse_node) ─────────


def _operand_to_dict(op: Operand) -> dict[str, Any]:
    if isinstance(op, IndicatorOperand):
        return {
            "src": "indicator", "id": op.id, "output": op.output,
            "params": op.params, "offset": op.offset,
        }
    if isinstance(op, PriceOperand):
        return {"src": "price", "field": op.field_, "offset": op.offset}
    if isinstance(op, ConstOperand):
        return {"src": "const", "value": op.value}
    if isinstance(op, PctRankOperand):
        return {"src": "pctRank", "of": _operand_to_dict(op.of), "window": op.window}
    raise TypeError(f"unknown operand type {type(op)}")


def to_dict(node: RuleNode) -> dict[str, Any]:
    if isinstance(node, (AndNode, OrNode)):
        return {"op": node.op, "children": [to_dict(c) for c in node.children]}
    if isinstance(node, NotNode):
        return {"op": "not", "child": to_dict(node.child)}
    if isinstance(node, (WithinNode, SustainedNode)):
        return {"op": node.op, "bars": node.bars, "child": to_dict(node.child)}
    if isinstance(node, Predicate):
        out: dict[str, Any] = {
            "op": "cmp", "left": _operand_to_dict(node.left), "cmp": node.cmp,
            "right": _operand_to_dict(node.right),
        }
        if node.right2 is not None:
            out["right2"] = _operand_to_dict(node.right2)
        if node.origin is not None:
            out["origin"] = node.origin
        return out
    raise TypeError(f"unknown node type {type(node)}")


# ── Canonical keys — dedup + operand memoization (§6, §8.5.1) ──────────────


def operand_key(op: Operand) -> str:
    if isinstance(op, ConstOperand):
        return f"const:{op.value}"
    if isinstance(op, PriceOperand):
        return f"price:{op.field_}:{op.offset}"
    if isinstance(op, IndicatorOperand):
        params = ",".join(f"{k}={v}" for k, v in sorted(op.params.items()))
        return f"ind:{op.id}:{params}:{op.output}:{op.offset}"
    if isinstance(op, PctRankOperand):
        return f"pctRank:{operand_key(op.of)}:{op.window}"
    raise TypeError(f"unknown operand type {type(op)}")


def node_key(node: RuleNode) -> str:
    if isinstance(node, (AndNode, OrNode)):
        return f"{node.op}({','.join(sorted(node_key(c) for c in node.children))})"
    if isinstance(node, NotNode):
        return f"not({node_key(node.child)})"
    if isinstance(node, (WithinNode, SustainedNode)):
        return f"{node.op}({node.bars},{node_key(node.child)})"
    if isinstance(node, Predicate):
        parts = [operand_key(node.left), node.cmp, operand_key(node.right)]
        if node.right2 is not None:
            parts.append(operand_key(node.right2))
        return f"cmp({','.join(parts)})"
    raise TypeError(f"unknown node type {type(node)}")


# ── Normalize: NNF -> flatten -> dedup, + interval-analysis warnings ───────
#
# Mirrors lib/alerts/normalize.ts exactly — the backend is authoritative
# (it re-validates on every save regardless of what the client already
# checked), so both sides must agree bit-for-bit. See plan §4.

_NEGATED_COMPARATOR: dict[Comparator, Comparator] = {
    "lt": "gte", "gte": "lt",
    "lte": "gt", "gt": "lte",
    "eq": "neq", "neq": "eq",
    "between": "outside", "outside": "between",
}


def to_nnf(node: RuleNode) -> RuleNode:
    """Push NOT down to the leaves via De Morgan. crossesAbove/crossesBelow
    have no complement comparator, so NOT wraps them unchanged — that's
    correct, not a gap (plan §1 design note). Same for NOT(within/sustained)."""
    if isinstance(node, NotNode):
        child = node.child
        if isinstance(child, AndNode):
            return OrNode(children=tuple(to_nnf(NotNode(child=c)) for c in child.children))
        if isinstance(child, OrNode):
            return AndNode(children=tuple(to_nnf(NotNode(child=c)) for c in child.children))
        if isinstance(child, NotNode):
            return to_nnf(child.child)
        if isinstance(child, Predicate):
            negated = _NEGATED_COMPARATOR.get(child.cmp)
            if negated is None:
                return NotNode(child=to_nnf(child))
            return Predicate(
                left=child.left, cmp=negated, right=child.right,
                right2=child.right2, origin=child.origin,
            )
        # within / sustained
        return NotNode(child=to_nnf(child))

    if isinstance(node, AndNode):
        return AndNode(children=tuple(to_nnf(c) for c in node.children))
    if isinstance(node, OrNode):
        return OrNode(children=tuple(to_nnf(c) for c in node.children))
    if isinstance(node, WithinNode):
        return WithinNode(bars=node.bars, child=to_nnf(node.child))
    if isinstance(node, SustainedNode):
        return SustainedNode(bars=node.bars, child=to_nnf(node.child))
    return node  # Predicate


def flatten_node(node: RuleNode) -> RuleNode:
    """Merge nested AND-under-AND / OR-under-OR into a single flat group."""
    if isinstance(node, (AndNode, OrNode)):
        children: list[RuleNode] = []
        for raw in node.children:
            c = flatten_node(raw)
            if type(c) is type(node):
                children.extend(c.children)  # type: ignore[union-attr]
            else:
                children.append(c)
        return type(node)(children=tuple(children))
    if isinstance(node, NotNode):
        return NotNode(child=flatten_node(node.child))
    if isinstance(node, WithinNode):
        return WithinNode(bars=node.bars, child=flatten_node(node.child))
    if isinstance(node, SustainedNode):
        return SustainedNode(bars=node.bars, child=flatten_node(node.child))
    return node


def dedupe_node(node: RuleNode) -> RuleNode:
    """Drop children that are structurally identical (same canonical key)
    within the same AND/OR group."""
    if isinstance(node, (AndNode, OrNode)):
        seen: set[str] = set()
        children: list[RuleNode] = []
        for raw in node.children:
            c = dedupe_node(raw)
            k = node_key(c)
            if k in seen:
                continue
            seen.add(k)
            children.append(c)
        return type(node)(children=tuple(children))
    if isinstance(node, NotNode):
        return NotNode(child=dedupe_node(node.child))
    if isinstance(node, WithinNode):
        return WithinNode(bars=node.bars, child=dedupe_node(node.child))
    if isinstance(node, SustainedNode):
        return SustainedNode(bars=node.bars, child=dedupe_node(node.child))
    return node


# ── Interval analysis (plan §4 item 4) — self-contained: only catches
# contradictions/redundancy that don't need external domain knowledge (e.g.
# RSI's natural [0,100] range). A true tautology check needs that range,
# which lives in the frontend registry (plan §8.5.1) — not here.


@dataclass(frozen=True)
class _Interval:
    lo: float
    lo_open: bool
    hi: float
    hi_open: bool


_FULL = _Interval(float("-inf"), False, float("inf"), False)


def _predicate_interval(p: Predicate) -> _Interval | None:
    if not isinstance(p.right, ConstOperand):
        return None
    v = p.right.value
    if p.cmp == "lt":
        return _Interval(_FULL.lo, _FULL.lo_open, v, True)
    if p.cmp == "lte":
        return _Interval(_FULL.lo, _FULL.lo_open, v, False)
    if p.cmp == "gt":
        return _Interval(v, True, _FULL.hi, _FULL.hi_open)
    if p.cmp == "gte":
        return _Interval(v, False, _FULL.hi, _FULL.hi_open)
    if p.cmp == "eq":
        return _Interval(v, False, v, False)
    if p.cmp == "between":
        if not isinstance(p.right2, ConstOperand):
            return None
        return _Interval(v, False, p.right2.value, False)
    return None  # neq/outside/crossesAbove/crossesBelow aren't a single convex interval


def _intersect(a: _Interval, b: _Interval) -> _Interval:
    if a.lo > b.lo:
        lo, lo_open = a.lo, a.lo_open
    elif b.lo > a.lo:
        lo, lo_open = b.lo, b.lo_open
    else:
        lo, lo_open = a.lo, a.lo_open or b.lo_open
    if a.hi < b.hi:
        hi, hi_open = a.hi, a.hi_open
    elif b.hi < a.hi:
        hi, hi_open = b.hi, b.hi_open
    else:
        hi, hi_open = a.hi, a.hi_open or b.hi_open
    return _Interval(lo, lo_open, hi, hi_open)


def _is_empty(iv: _Interval) -> bool:
    if iv.lo > iv.hi:
        return True
    if iv.lo == iv.hi and (iv.lo_open or iv.hi_open):
        return True
    return False


def _same_interval(a: _Interval, b: _Interval) -> bool:
    return a.lo == b.lo and a.lo_open == b.lo_open and a.hi == b.hi and a.hi_open == b.hi_open


def _analyze_and_group(children: tuple[RuleNode, ...], warnings: list[dict]) -> None:
    by_operand: dict[str, list[_Interval]] = {}
    for c in children:
        if not isinstance(c, Predicate):
            continue
        iv = _predicate_interval(c)
        if iv is None:
            continue
        key = operand_key(c.left)
        by_operand.setdefault(key, []).append(iv)

    for key, intervals in by_operand.items():
        if len(intervals) < 2:
            continue
        running = _FULL
        for iv in intervals:
            nxt = _intersect(running, iv)
            if _is_empty(nxt):
                warnings.append({
                    "kind": "contradiction", "operandKey": key,
                    "detail": f"conditions on {key} can never all be true at once",
                })
                return  # one contradiction report per group is enough
            if _same_interval(running, nxt):
                warnings.append({
                    "kind": "redundant", "operandKey": key,
                    "detail": f"a condition on {key} is already implied by the others in this group",
                })
            running = nxt


def normalize_node(node: RuleNode) -> tuple[RuleNode, list[dict]]:
    """Full pipeline: NNF -> flatten -> dedup, plus interval-analysis
    warnings. Authoritative — the CRUD router runs this before every save."""
    result = to_nnf(node)
    result = flatten_node(result)
    result = dedupe_node(result)

    warnings: list[dict] = []

    def walk(n: RuleNode) -> None:
        if isinstance(n, AndNode):
            _analyze_and_group(n.children, warnings)
        if isinstance(n, (AndNode, OrNode)):
            for c in n.children:
                walk(c)
        elif isinstance(n, NotNode):
            walk(n.child)
        elif isinstance(n, (WithinNode, SustainedNode)):
            walk(n.child)

    walk(result)
    return result, warnings
