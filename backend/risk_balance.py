"""
Bringing a book back to risk balance — "how much of what do I trade so that no
holding carries more than its share of the risk?"

Balance = Equal Risk Contribution: every holding's share of the book's
volatility is 1/n. A holding's share is w_i·(Σw)_i / w'Σw — its weight times how
much the book moves when it moves, so a name that moves against the rest earns
a large weight and one that moves with everything a small one.

    erc_weights(cov)            the balanced weights. Solved as the convex
                                problem  min ½·y'Σy − Σ b_i·ln y_i  (Spinu 2013):
                                its minimum has y_i·(Σy)_i = b_i, i.e. risk
                                shares exactly b, and it is unique. (The
                                coordinate-descent that used to do this
                                re-normalised w inside the loop, which moves the
                                fixed point: five holdings came out 13–30% each
                                instead of 20% — found 2026-10-07.)

Two ways to get there, both from the same covariance:

    rebalance(values, w*)       sell what carries too much, buy what carries too
                                little; the money in the book is unchanged.
                                Reaches balance exactly.
    add_to_balance(values, w*)  put NEW money in and sell nothing. The smallest
                                book that holds every position at its balanced
                                weight without selling is T = max_i value_i/w*_i;
                                the buys are w*·T − value (≥ 0, zero for the
                                holding that sets T) and their sum is the cash
                                it takes. With less cash, the same buys scaled
                                down — the same direction, part of the way.

Limits, said on screen too: the covariance is ~1y of daily returns and will not
hold exactly; lot sizes, fees and taxes are not in it; "equal risk" is a
definition of balance, not a claim that it earns more.

Pure numpy + scipy; routers/risk.py GET /risk/balance does the I/O.
"""
from __future__ import annotations

from typing import Optional

import numpy as np


def risk_shares(values: np.ndarray, cov: np.ndarray) -> np.ndarray:
    """Each holding's share of the book's variance; sums to 1. `values` may be
    money or weights — only the proportions matter."""
    v = np.asarray(values, dtype=float)
    total = v @ cov @ v
    if total <= 0:
        return np.full(len(v), 1.0 / len(v))
    return v * (cov @ v) / total


def book_vol_annual(values: np.ndarray, cov: np.ndarray) -> float:
    """Annualised volatility of the invested book, as a fraction."""
    v = np.asarray(values, dtype=float)
    s = v.sum()
    if s <= 0:
        return 0.0
    w = v / s
    return float(np.sqrt(max(w @ cov @ w, 0.0) * 252))


def erc_weights(cov: np.ndarray, budget: Optional[np.ndarray] = None) -> np.ndarray:
    """Long-only weights (sum 1) whose risk shares equal `budget` (default 1/n each)."""
    from scipy.optimize import minimize

    cov = np.asarray(cov, dtype=float)
    n = cov.shape[0]
    b = np.full(n, 1.0 / n) if budget is None else np.asarray(budget, dtype=float) / np.sum(budget)
    # Work in units of each holding's own volatility: the problem is then well
    # scaled whether a daily variance is 1e-4 or 1e-2.
    sd = np.sqrt(np.clip(np.diag(cov), 1e-18, None))
    corr = cov / np.outer(sd, sd)

    def f(y: np.ndarray) -> tuple[float, np.ndarray]:
        cy = corr @ y
        return 0.5 * float(y @ cy) - float(b @ np.log(y)), cy - b / y

    res = minimize(f, np.sqrt(b), jac=True, method="L-BFGS-B", bounds=[(1e-9, None)] * n,
                   options={"maxiter": 1000, "ftol": 1e-15, "gtol": 1e-12})
    w = res.x / sd
    return w / w.sum()


MIN_SHARE = 1e-4      # a 0% target still needs a positive number: ln(0) has no minimum


def target_shares(names: list[str], budgets: dict[str, float]) -> tuple[np.ndarray, list[str]]:
    """The risk share each holding should carry, from the user's own budgets.

    `budgets` = name → percent of total risk (PUT /risk/budget, scope symbol).
    A holding with a budget gets it; the ones without split what is left of
    100% equally ("remainder"). When the budgets leave nothing for the others,
    or every holding has one and they do not add to 100, the shares are scaled
    to add to 1 — the proportions the user typed are kept. No budget at all →
    1/n each ("equal").
    → (shares summing to 1, per-holding source: budget | remainder | equal).
    """
    n = len(names)
    have = {k: float(v) for k, v in budgets.items() if k in names and v is not None}
    if not have:
        return np.full(n, 1.0 / n), ["equal"] * n
    left = max(0.0, 100.0 - sum(have.values()))
    free = [k for k in names if k not in have]
    each = left / len(free) if free else 0.0
    raw = np.array([have.get(k, each) for k in names]) / 100.0
    raw = np.maximum(raw, MIN_SHARE)
    return raw / raw.sum(), ["budget" if k in have else "remainder" for k in names]


def group_target_shares(
    unit_groups: list[str], budgets: dict[str, float],
) -> tuple[np.ndarray, dict[str, float], dict[str, str]]:
    """Targets set per GROUP (a sector, a thesis, an account) → the share each
    holding in it should carry.

    `unit_groups[i]` = the group of holding i. Groups take their share the way
    single holdings do (`target_shares`: the user's number, else an equal part
    of what is left, else 1/G each), and a group's share is split equally
    among its holdings — the group is what the user sized; inside it nothing
    says one name should carry more than another.
    → (share per holding, share per group, source per group).
    """
    keys = list(dict.fromkeys(unit_groups))
    g_shares, g_source = target_shares(keys, budgets)
    share = dict(zip(keys, (float(x) for x in g_shares)))
    count = {k: unit_groups.count(k) for k in keys}
    unit = np.array([share[g] / count[g] for g in unit_groups])
    return unit, share, dict(zip(keys, g_source))


def rebalance(values: np.ndarray, target_w: np.ndarray) -> np.ndarray:
    """Money to move per holding (+ buy, − sell) to hold `target_w` with the
    book's total unchanged."""
    v = np.asarray(values, dtype=float)
    return np.asarray(target_w, dtype=float) * v.sum() - v


def add_to_balance(values: np.ndarray, target_w: np.ndarray) -> np.ndarray:
    """Buys (≥ 0) that reach `target_w` without selling anything. Their sum is
    the new money it takes; scale them down for a smaller budget."""
    v = np.asarray(values, dtype=float)
    w = np.asarray(target_w, dtype=float)
    total = float(np.max(v / np.maximum(w, 1e-12)))
    return np.maximum(w * total - v, 0.0)
