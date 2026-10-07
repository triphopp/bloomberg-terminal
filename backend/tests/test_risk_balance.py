"""Risk balance — backend/risk_balance.py (no network)."""
import numpy as np
import pytest

import risk_balance as rb


def _cov(seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    a = rng.normal(size=(400, 5)) * [0.01, 0.02, 0.03, 0.015, 0.05]
    a[:, 1] += a[:, 2] * 0.8                     # two that move together
    a[:, 3] -= a[:, 0] * 0.5                     # one that moves against another
    return np.cov(a.T)


def test_balanced_weights_give_every_holding_the_same_share_of_risk():
    cov = _cov()
    w = rb.erc_weights(cov)
    assert w.sum() == pytest.approx(1) and (w > 0).all()
    assert rb.risk_shares(w, cov) == pytest.approx(np.full(5, 0.2), abs=1e-5)


def test_the_old_solver_path_is_exact_too():
    # routers.risk._risk_parity_weights used to stop 13–30% apart on this book.
    from routers.risk import _risk_parity_weights

    cov = _cov()
    assert rb.risk_shares(_risk_parity_weights(cov), cov) == pytest.approx(np.full(5, 0.2), abs=1e-5)


def test_a_risk_budget_is_met():
    cov = _cov(3)
    w = rb.erc_weights(cov, np.array([4.0, 1, 1, 1, 1]))
    assert rb.risk_shares(w, cov) == pytest.approx([0.5, 0.125, 0.125, 0.125, 0.125], abs=1e-5)


def test_scale_of_the_covariance_does_not_matter():
    cov = _cov()
    assert rb.erc_weights(cov * 1e-4) == pytest.approx(rb.erc_weights(cov), abs=1e-6)


def test_uncorrelated_holdings_are_weighted_by_inverse_volatility():
    sd = np.array([0.01, 0.02, 0.04])
    w = rb.erc_weights(np.diag(sd ** 2))
    assert w == pytest.approx((1 / sd) / (1 / sd).sum(), abs=1e-6)


def test_rebalance_moves_no_money_in_or_out_and_lands_on_balance():
    cov = _cov()
    v = np.array([300.0, 400, 60, 240, 100])
    d = rb.rebalance(v, rb.erc_weights(cov))
    assert d.sum() == pytest.approx(0, abs=1e-6)
    assert rb.risk_shares(v + d, cov) == pytest.approx(np.full(5, 0.2), abs=1e-5)


def test_add_only_sells_nothing_reaches_balance_and_one_holding_buys_nothing():
    cov = _cov()
    v = np.array([300.0, 400, 60, 240, 100])
    buys = rb.add_to_balance(v, rb.erc_weights(cov))
    assert (buys >= 0).all() and buys.min() == pytest.approx(0, abs=1e-6)
    assert rb.risk_shares(v + buys, cov) == pytest.approx(np.full(5, 0.2), abs=1e-5)


def test_part_of_the_money_goes_part_of_the_way():
    cov = _cov()
    v = np.array([300.0, 400, 60, 240, 100])
    buys = rb.add_to_balance(v, rb.erc_weights(cov))
    gap = lambda x: float(np.abs(rb.risk_shares(x, cov) - 0.2).max())  # noqa: E731
    assert gap(v) > gap(v + buys * 0.5) > gap(v + buys) == pytest.approx(0, abs=1e-5)


def test_a_balanced_book_needs_nothing():
    cov = _cov()
    v = rb.erc_weights(cov) * 1000
    assert rb.add_to_balance(v, rb.erc_weights(cov)).sum() == pytest.approx(0, abs=1e-3)
    assert np.abs(rb.rebalance(v, rb.erc_weights(cov))).max() == pytest.approx(0, abs=1e-3)


def test_book_volatility_falls_on_the_way_to_balance_here():
    cov = _cov()
    v = np.array([50.0, 50, 50, 50, 800])        # almost all in the most volatile name
    w = rb.erc_weights(cov)
    assert rb.book_vol_annual(v + rb.rebalance(v, w), cov) < rb.book_vol_annual(v, cov)


# ── the user's own targets ───────────────────────────────────────────────────

def test_no_budget_means_equal_shares():
    shares, source = rb.target_shares(["A", "B", "C", "D"], {})
    assert shares == pytest.approx([0.25] * 4) and source == ["equal"] * 4


def test_holdings_without_a_budget_split_what_is_left():
    shares, source = rb.target_shares(["A", "B", "C", "D"], {"A": 40, "B": 10, "ZZZ": 30})
    assert shares == pytest.approx([0.40, 0.10, 0.25, 0.25])          # ZZZ is not held: ignored
    assert source == ["budget", "budget", "remainder", "remainder"]


def test_budgets_that_do_not_add_to_100_keep_their_proportions():
    shares, _ = rb.target_shares(["A", "B"], {"A": 30, "B": 10})
    assert shares == pytest.approx([0.75, 0.25])
    full, _ = rb.target_shares(["A", "B", "C"], {"A": 60, "B": 40})   # nothing left for C
    assert full.sum() == pytest.approx(1) and full[2] < 0.001


def test_the_plan_lands_on_the_users_targets():
    cov = _cov()
    names = ["A", "B", "C", "D", "E"]
    v = np.array([300.0, 400, 60, 240, 100])
    shares, _ = rb.target_shares(names, {"A": 40, "E": 5})
    w = rb.erc_weights(cov, shares)
    assert rb.risk_shares(v + rb.rebalance(v, w), cov) == pytest.approx(shares, abs=1e-5)
    assert rb.risk_shares(v + rb.add_to_balance(v, w), cov) == pytest.approx(shares, abs=1e-5)


# ── targets per group (account / sector / thesis) ────────────────────────────

def test_a_groups_share_is_split_equally_among_its_holdings():
    unit, share, source = rb.group_target_shares(["X", "X", "Y", "Z", "Z", "Z"], {"X": 50})
    assert share == pytest.approx({"X": 0.5, "Y": 0.25, "Z": 0.25})
    assert unit == pytest.approx([0.25, 0.25, 0.25, 0.25 / 3, 0.25 / 3, 0.25 / 3])
    assert source == {"X": "budget", "Y": "remainder", "Z": "remainder"}
    assert unit.sum() == pytest.approx(1)


def test_no_group_target_means_every_group_the_same_not_every_holding():
    unit, share, source = rb.group_target_shares(["X", "X", "X", "Y"], {})
    assert share == pytest.approx({"X": 0.5, "Y": 0.5}) and set(source.values()) == {"equal"}
    assert unit == pytest.approx([1 / 6, 1 / 6, 1 / 6, 0.5])


def test_the_plan_lands_each_group_on_its_target():
    cov = _cov()
    groups = ["A", "A", "B", "B", "C"]
    v = np.array([300.0, 400, 60, 240, 100])
    unit, share, _ = rb.group_target_shares(groups, {"A": 20, "C": 30})
    after = rb.risk_shares(v + rb.rebalance(v, rb.erc_weights(cov, unit)), cov)
    by_group = {g: sum(after[i] for i, x in enumerate(groups) if x == g) for g in share}
    assert by_group == pytest.approx({"A": 0.20, "B": 0.50, "C": 0.30}, abs=1e-5)


def test_one_symbol_in_two_accounts_is_two_units_that_move_as_one():
    # level=account: the same return series twice — a singular covariance.
    cov3 = _cov()[:3, :3]
    idx = [0, 0, 1, 2]
    cov = cov3[np.ix_(idx, idx)]
    unit, _, _ = rb.group_target_shares(["acc1", "acc2", "acc1", "acc2"], {"acc1": 70})
    w = rb.erc_weights(cov, unit)
    assert np.isfinite(w).all() and (w > 0).all()
    assert rb.risk_shares(w, cov) == pytest.approx(unit, abs=1e-4)


def test_budget_keeps_account_targets_beside_the_three_budget_scopes():
    import risk_budget

    b = risk_budget.Budget.from_dict({"account": {"dime": 40, "finansia": 50}, "symbol": {"AAA": 10}})
    assert b.of("account") == {"dime": 40.0, "finansia": 50.0}
    assert b.as_dict()["account"] == {"dime": 40.0, "finansia": 50.0}
    assert "account" not in risk_budget.SCOPES                 # the budget table is not per account
    with pytest.raises(ValueError):
        risk_budget.Budget.from_dict({"account": {"a": 70, "b": 40}})
