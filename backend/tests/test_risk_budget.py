"""Risk budget model (risk_budget.py) and its saved-budget endpoints — no network."""
import importlib

import numpy as np
import pytest

import risk_budget as rb


def _items(weights, keys=None, values=None):
    keys = keys or [f"S{i}" for i in range(len(weights))]
    return [{"symbol": f"S{i}", "weight": w, "value": (values or [w * 1000 for w in weights])[i],
             "key": keys[i], "label": keys[i]} for i, w in enumerate(weights)]


def _cov(vols, corr=0.0):
    v = np.array(vols) / np.sqrt(252)
    c = np.full((len(v), len(v)), corr)
    np.fill_diagonal(c, 1.0)
    return np.outer(v, v) * c


def test_contributions_add_up_to_book_volatility():
    w, cov = np.array([0.5, 0.3, 0.2]), _cov([0.2, 0.4, 0.1], corr=0.3)
    rc, sigma = rb.contributions(w, cov)
    assert rc.sum() == pytest.approx(sigma)
    assert sigma == pytest.approx(np.sqrt(w @ cov @ w))


def test_money_weight_is_not_risk_weight():
    # 50/50 in money, one twice as volatile → it carries 80% of the risk.
    out = rb.plan(_items([0.5, 0.5]), _cov([0.4, 0.2]), rb.Budget(), "symbol")
    by = {r["key"]: r for r in out["rows"]}
    assert by["S0"]["risk_pct"] == pytest.approx(80.0) and by["S1"]["risk_pct"] == pytest.approx(20.0)
    assert by["S0"]["status"] == "UNSET" and by["S0"]["budget_pct"] is None
    assert out["vol"]["used_pct"] == pytest.approx(np.sqrt(0.25 * 0.16 + 0.25 * 0.04) * 100, abs=0.01)


def test_over_budget_trim_is_solved_so_the_share_lands_on_the_budget():
    w, cov = [0.5, 0.5], _cov([0.4, 0.2])
    out = rb.plan(_items(w), cov, rb.Budget(symbol={"S0": 50.0, "S1": 50.0}), "symbol")
    over = out["rows"][0]
    assert over["key"] == "S0" and over["status"] == "OVER" and over["over_pp"] == pytest.approx(30.0)
    # equal risk needs S0 at half of S1's size → sell half; pro-rating 50/80 would say 37.5%
    assert over["trim_pct"] == pytest.approx(50.0, abs=0.1)
    assert over["trim_value"] == pytest.approx(250.0, abs=0.5)
    after = np.array([0.5 * (1 - over["trim_pct"] / 100), 0.5])
    assert rb.share_of(after, cov, [0]) == pytest.approx(0.5, abs=1e-3)
    under = next(r for r in out["rows"] if r["key"] == "S1")
    assert under["status"] == "UNDER" and under["add_value"] == pytest.approx(500.0, abs=1.0)
    assert out["counts"]["OVER"] == 1 and out["counts"]["UNDER"] == 1


def test_band_keeps_small_gaps_quiet():
    out = rb.plan(_items([0.5, 0.5]), _cov([0.4, 0.2]),
                  rb.Budget(band_pp=5, symbol={"S0": 77.0, "S1": 23.0}), "symbol")
    assert {r["status"] for r in out["rows"]} == {"OK"}
    assert all(r["trim_value"] is None and r["add_value"] is None for r in out["rows"])


def test_buckets_sum_their_members_and_a_budget_without_holdings_is_listed():
    items = _items([0.3, 0.3, 0.4], keys=["Tech", "Tech", "Bank"])
    out = rb.plan(items, _cov([0.3, 0.3, 0.3]), rb.Budget(sector={"Tech": 40.0, "Gold": 10.0}), "sector")
    by = {r["key"]: r for r in out["rows"]}
    assert by["Tech"]["n"] == 2 and by["Tech"]["weight_pct"] == pytest.approx(60.0)
    assert by["Tech"]["risk_pct"] + by["Bank"]["risk_pct"] == pytest.approx(100.0, abs=0.02)
    assert [m["symbol"] for m in by["Tech"]["members"]] == ["S0", "S1"]
    assert by["Bank"]["status"] == "UNSET"
    assert by["Gold"]["status"] == "EMPTY" and by["Gold"]["risk_pct"] == 0
    assert out["budget_total_pct"] == 50.0 and out["unallocated_pct"] == 50.0
    assert out["rows"][0]["key"] == "Tech"               # OVER sorts first


def test_a_hedge_has_a_negative_share():
    out = rb.plan(_items([0.8, 0.2]), _cov([0.2, 0.2], corr=-0.9), rb.Budget(), "symbol")
    assert next(r for r in out["rows"] if r["key"] == "S1")["risk_pct"] < 0


def test_the_whole_book_in_one_bucket_has_no_trim():
    out = rb.plan(_items([0.6, 0.4], keys=["All", "All"]), _cov([0.3, 0.2]),
                  rb.Budget(sector={"All": 50.0}), "sector")
    row = out["rows"][0]
    assert row["status"] == "OVER" and row["trim_value"] is None


def test_vol_cap_says_how_much_of_everything_to_move_to_cash():
    items, cov = _items([0.5, 0.5]), _cov([0.4, 0.2])
    used = rb.plan(items, cov, rb.Budget(), "symbol")["vol"]["used_pct"]
    vol = rb.plan(items, cov, rb.Budget(vol_cap_pct=used / 2), "symbol")["vol"]
    assert vol["status"] == "OVER" and vol["derisk_pct"] == pytest.approx(50.0, abs=0.1)
    assert vol["derisk_value"] == pytest.approx(500.0, abs=1.0)
    assert rb.plan(items, cov, rb.Budget(vol_cap_pct=used * 2), "symbol")["vol"]["status"] == "OK"
    assert rb.plan(items, cov, rb.Budget(), "symbol")["vol"]["status"] == "UNSET"


@pytest.mark.parametrize("bad", [
    {"symbol": {"A": 60, "B": 50}},        # more than the whole
    {"sector": {"Tech": -1}},
    {"vol_cap_pct": 0},
    {"band_pp": -1},
    {"thesis": [1, 2]},
])
def test_budget_rejects_nonsense(bad):
    with pytest.raises(ValueError):
        rb.Budget.from_dict(bad)


def test_empty_book_still_answers():
    out = rb.plan([], np.zeros((0, 0)), rb.Budget(symbol={"X": 10.0}), "symbol")
    assert out["vol"]["used_pct"] == 0 and [r["status"] for r in out["rows"]] == ["EMPTY"]


# ── saved budgets (isolated DB) ──────────────────────────────────────────────

@pytest.fixture()
def risk(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "t.db"))
    monkeypatch.setenv("SYNC_DEVICE_ID", "PC")
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_guard_schema(); db.init_sync_layer()
    import routers.risk as mod
    importlib.reload(mod)
    return mod


def test_put_replaces_one_scope_and_keeps_the_rest(risk):
    risk.put_risk_budget(risk.RiskBudgetIn(scope="sector", budgets={"Tech": 40, "Bank": 30}, vol_cap_pct=20))
    risk.put_risk_budget(risk.RiskBudgetIn(scope="symbol", budgets={"AOT.BK": 15}))
    saved = risk.put_risk_budget(risk.RiskBudgetIn(scope="sector", budgets={"Tech": 35}))["budget"]
    assert saved["sector"] == {"Tech": 35.0} and saved["symbol"] == {"AOT.BK": 15.0}
    assert saved["vol_cap_pct"] == 20.0                   # not sent → kept
    assert risk.put_risk_budget(risk.RiskBudgetIn(vol_cap_pct=None))["budget"]["vol_cap_pct"] is None
    assert risk._risk_budget_saved("dime").as_dict()["sector"] == {}    # per book view
    assert risk.delete_risk_budget(None)["budget"]["sector"] == {}
    assert risk._risk_budget_saved(None).as_dict()["symbol"] == {}


def test_put_refuses_a_budget_over_100(risk):
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as e:
        risk.put_risk_budget(risk.RiskBudgetIn(scope="symbol", budgets={"A": 70, "B": 40}))
    assert e.value.status_code == 400 and "more than 100%" in e.value.detail
    with pytest.raises(HTTPException):
        risk.put_risk_budget(risk.RiskBudgetIn(scope="factor", budgets={"A": 10}))


def test_risk_budgets_table_is_machine_local(risk):
    from sync.config import SYNC_TABLES
    assert "risk_budgets" not in {t[0] if isinstance(t, tuple) else t for t in SYNC_TABLES}
