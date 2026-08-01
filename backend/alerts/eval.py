"""
Alert Rule Engine — AST evaluator with three-valued (value/valid) semantics.

evaluate(node, bars, resolve_indicator) walks the AST and returns a boolean
series (`value`) plus a validity mask (`valid`) of the same length as `bars`.
Only `fires(result)` (value & valid) should ever reach a trigger — a bar that
couldn't be evaluated (warm-up, halted symbol, gappy data) must never read as
False, because `NOT(False) = True` would make every rule with a NOT fire on
exactly the bars it has no information about. See
memory/plans/alert-rule-engine.md §11.

No indicator math lives here — `resolve_indicator` is injected so this module
is testable without the real indicator library (that's operands.py, phase 2).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np
import pandas as pd

from .ast import (
    AndNode,
    ConstOperand,
    IndicatorOperand,
    NotNode,
    Operand,
    OrNode,
    PctRankOperand,
    Predicate,
    PriceOperand,
    RuleNode,
    SustainedNode,
    WithinNode,
)


class EvalError(ValueError):
    pass


@dataclass(frozen=True)
class Bars:
    """OHLCV columns as equal-length float arrays, oldest bar first."""

    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    volume: np.ndarray

    def __len__(self) -> int:
        return len(self.close)


@dataclass(frozen=True)
class OperandResult:
    values: np.ndarray  # float64, NaN where undefined
    valid: np.ndarray  # bool


@dataclass(frozen=True)
class BoolResult:
    value: np.ndarray  # bool
    valid: np.ndarray  # bool


# (indicator id, params, output) -> raw float series, same length as bars.
# NaN = "not computable at this bar" (e.g. RSI's warm-up window) — the
# resolver owns that decision, evaluate() just propagates it into `valid`.
IndicatorResolver = Callable[[str, dict, str], "np.ndarray"]


def _shift(values: np.ndarray, offset: int, fill) -> np.ndarray:
    """Look back `offset` bars. Slots that would read before bar 0 get `fill`."""
    if offset == 0:
        return values
    if offset < 0:
        raise EvalError(f"offset must be >= 0, got {offset}")
    out = np.full(values.shape, fill, dtype=values.dtype)
    if offset < len(values):
        out[offset:] = values[: len(values) - offset]
    return out


def resolve_operand(
    op: Operand, bars: Bars, resolve_indicator: IndicatorResolver
) -> OperandResult:
    n = len(bars)

    if isinstance(op, ConstOperand):
        return OperandResult(np.full(n, op.value, dtype=float), np.ones(n, dtype=bool))

    if isinstance(op, PriceOperand):
        raw = getattr(bars, op.field_).astype(float)
        values = _shift(raw, op.offset, np.nan)
        # isfinite, not ~isnan: a divide-by-zero (e.g. rvol against a
        # zero-volume baseline, bb-width against a zero SMA) produces +/-inf,
        # which is not NaN and would otherwise sail through as "valid" —
        # letting a rule fire off a value nobody can act on.
        return OperandResult(values, np.isfinite(values))

    if isinstance(op, IndicatorOperand):
        raw = np.asarray(resolve_indicator(op.id, op.params, op.output), dtype=float)
        if len(raw) != n:
            raise EvalError(
                f"indicator {op.id}.{op.output} returned {len(raw)} bars, expected {n}"
            )
        values = _shift(raw, op.offset, np.nan)
        return OperandResult(values, np.isfinite(values))

    if isinstance(op, PctRankOperand):
        inner = resolve_operand(op.of, bars, resolve_indicator)
        # Percentile rank of the CURRENT bar within its trailing window,
        # inclusive — a strictly rising series is always at the 100th
        # percentile of its own window, which is the intended reading.
        series = pd.Series(inner.values)
        pct = series.rolling(op.window).apply(lambda w: (w[-1] >= w).mean(), raw=True).to_numpy()
        valid = inner.valid.copy()
        valid[: op.window - 1] = False  # can't form a full window yet
        valid &= ~np.isnan(pct)
        return OperandResult(pct, valid)

    raise EvalError(f"unknown operand type {type(op)}")


_CMP_FN: dict[str, Callable[[np.ndarray, np.ndarray], np.ndarray]] = {
    "lt": np.less,
    "lte": np.less_equal,
    "gt": np.greater,
    "gte": np.greater_equal,
    "eq": np.equal,
    "neq": np.not_equal,
}


def _evaluate_predicate(
    node: Predicate, bars: Bars, resolve_indicator: IndicatorResolver
) -> BoolResult:
    left = resolve_operand(node.left, bars, resolve_indicator)
    right = resolve_operand(node.right, bars, resolve_indicator)

    if node.cmp in _CMP_FN:
        value = _CMP_FN[node.cmp](left.values, right.values)
        valid = left.valid & right.valid
        return BoolResult(value, valid)

    if node.cmp in ("between", "outside"):
        if node.right2 is None:
            raise EvalError("between/outside requires right2")  # unreachable if parsed via ast.py
        right2 = resolve_operand(node.right2, bars, resolve_indicator)
        inside = (left.values >= right.values) & (left.values <= right2.values)
        value = inside if node.cmp == "between" else ~inside
        valid = left.valid & right.valid & right2.valid
        return BoolResult(value, valid)

    if node.cmp in ("crossesAbove", "crossesBelow"):
        cmp_fn = np.greater if node.cmp == "crossesAbove" else np.less
        cur = cmp_fn(left.values, right.values)
        prev = cmp_fn(_shift(left.values, 1, np.nan), _shift(right.values, 1, np.nan))
        value = cur & ~prev
        prev_valid = _shift(left.valid, 1, False) & _shift(right.valid, 1, False)
        valid = left.valid & right.valid & prev_valid
        return BoolResult(value, valid)

    raise EvalError(f"unknown comparator {node.cmp!r}")


def _rolling_bool(values: np.ndarray, bars: int, mode: str) -> np.ndarray:
    """mode='any' -> within(); mode='all' -> sustained(). Bars before the
    window is full (index < bars - 1) are False — can't confirm the
    quantifier without seeing the whole window."""
    n = len(values)
    s = pd.Series(values.astype(int))
    roll = s.rolling(bars).max() if mode == "any" else s.rolling(bars).min()
    filled = roll.to_numpy()
    out = np.zeros(n, dtype=bool)
    if bars - 1 < n:
        out[bars - 1 :] = filled[bars - 1 :] >= 1
    return out


def evaluate(node: RuleNode, bars: Bars, resolve_indicator: IndicatorResolver) -> BoolResult:
    """AST -> boolean series with three-valued semantics (§11). Only
    `fires()` on the result should ever be used to decide whether to trigger."""
    if isinstance(node, Predicate):
        return _evaluate_predicate(node, bars, resolve_indicator)

    if isinstance(node, AndNode):
        results = [evaluate(c, bars, resolve_indicator) for c in node.children]
        value = results[0].value.copy()
        valid = results[0].valid.copy()
        for r in results[1:]:
            value &= r.value
            valid &= r.valid
        return BoolResult(value, valid)

    if isinstance(node, OrNode):
        results = [evaluate(c, bars, resolve_indicator) for c in node.children]
        value = results[0].value.copy()
        valid = results[0].valid.copy()
        for r in results[1:]:
            value |= r.value
            valid &= r.valid
        return BoolResult(value, valid)

    if isinstance(node, NotNode):
        child = evaluate(node.child, bars, resolve_indicator)
        return BoolResult(~child.value, child.valid)  # valid untouched — the §11 invariant

    if isinstance(node, WithinNode):
        child = evaluate(node.child, bars, resolve_indicator)
        return BoolResult(
            _rolling_bool(child.value, node.bars, "any"),
            _rolling_bool(child.valid, node.bars, "all"),
        )

    if isinstance(node, SustainedNode):
        child = evaluate(node.child, bars, resolve_indicator)
        return BoolResult(
            _rolling_bool(child.value, node.bars, "all"),
            _rolling_bool(child.valid, node.bars, "all"),
        )

    raise EvalError(f"unknown node type {type(node)}")


def fires(result: BoolResult) -> np.ndarray:
    """The only array that should ever reach a trigger — unknown bars never fire (§11)."""
    return result.value & result.valid
