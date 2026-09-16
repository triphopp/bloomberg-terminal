"""
Cash reconciliation: idle cash stays DERIVED from the trade log, and a user's
EDIT is stored as an offset so later trades keep moving the balance.

The bug this guards: NAV charted holdings only, so every sale looked like money
vanishing and every buy like it came back.
"""
import importlib

import pytest


@pytest.fixture()
def pv2(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "cash.db"))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema()
    db.init_alerts_schema(); db.init_sync_layer()
    import portfolio_currency
    importlib.reload(portfolio_currency)
    import routers.portfolio_v2 as mod
    importlib.reload(mod)
    monkeypatch.setattr(mod, "_get_thb_per_usd", lambda: 35.0)
    monkeypatch.setattr(mod, "open_option_positions", lambda *a, **k: [])
    monkeypatch.setattr(mod, "closed_option_positions", lambda *a, **k: [])
    with db.get_db() as conn:
        conn.execute(
            "INSERT INTO portfolio_accounts (id, name, currency) VALUES ('acc', 'ACC', 'THB')"
        )
        # 100k deposited, one open lot costing 30k → derived cash 70k.
        conn.execute(
            "INSERT INTO cash_ledger (id, account_id, date, investment) "
            "VALUES ('c1', 'acc', '2026-01-01', 100000)"
        )
        conn.execute(
            """INSERT INTO trades (id, account_id, symbol, date_entry, price_entry, volume,
                                   amount, currency, win_loss, market)
               VALUES ('t1', 'acc', 'PTT', '2026-01-02', 30, 1000, 30000, 'THB', 'P', 'TH')"""
        )
    return mod, db


def _acct(summary):
    return summary["accounts"][0]


def test_derived_cash_without_adjustment(pv2):
    mod, _ = pv2
    s = mod.get_summary(base_currency="THB")
    assert _acct(s)["cash_base"] == 70000
    assert _acct(s)["cash_adjustment_base"] == 0
    assert _acct(s)["cash_reconciled_at"] is None
    assert s["cash_is_estimate"] is True


def test_reconcile_stores_offset_and_keeps_deriving(pv2):
    mod, db = pv2
    res = mod.reconcile_cash(mod.CashReconcileIn(
        account_id="acc", actual_balance=69500, currency="THB", date="2026-02-01", note="fees",
    ))
    assert res["amount"] == -500
    s = mod.get_summary(base_currency="THB")
    assert _acct(s)["cash_base"] == 69500
    assert _acct(s)["cash_derived_base"] == 70000
    assert _acct(s)["cash_reconciled_at"] == "2026-02-01"
    assert s["cash_is_estimate"] is False

    # Selling the lot for 33k: cash must rise by the proceeds, offset preserved.
    with db.get_db() as conn:
        conn.execute(
            "UPDATE trades SET win_loss='W', date_exit='2026-03-01', price_exit=33, "
            "pnl_amount=3000 WHERE id='t1'"
        )
    s = mod.get_summary(base_currency="THB")
    assert _acct(s)["cash_base"] == pytest.approx(102500)

    # A second reconcile stacks on the first rather than replacing it.
    res = mod.reconcile_cash(mod.CashReconcileIn(
        account_id="acc", actual_balance=102000, currency="THB",
    ))
    assert res["amount"] == -500
    assert mod.get_summary(base_currency="THB")["accounts"][0]["cash_base"] == 102000

    # Undo restores the previous balance.
    mod.delete_cash_adjustment(res["id"])
    assert mod.get_summary(base_currency="THB")["accounts"][0]["cash_base"] == 102500


def test_reconcile_in_usd_converts(pv2):
    mod, _ = pv2
    # Cost basis converts at the entry-date rate, so the USD figure is not simply
    # 70k / 35 — assert the reconcile lands exactly where the user said instead.
    before = _acct(mod.get_summary(base_currency="USD"))["cash_base"]
    res = mod.reconcile_cash(mod.CashReconcileIn(
        account_id="acc", actual_balance=1990, currency="USD",
    ))
    assert res["amount"] == pytest.approx(1990 - before, abs=0.01)
    assert _acct(mod.get_summary(base_currency="USD"))["cash_base"] == pytest.approx(1990, abs=0.01)
    # Seen from THB the offset is worth amount × 35.
    thb = _acct(mod.get_summary(base_currency="THB"))
    assert thb["cash_adjustment_base"] == pytest.approx(res["amount"] * 35, abs=0.01)


def test_nav_history_adds_cash_so_a_sale_is_flat(pv2):
    mod, db = pv2
    with db.get_db() as conn:
        rows = [
            # Holding: 30k cost, marked at 33k, 70k idle cash.
            ("acc", "2026-02-27", 33000, 30000, 3000, 0, 100000, 0),
            # Sold at 33k: holdings gone, realized +3k.
            ("acc", "2026-03-02", 0, 0, 0, 3000, 100000, 0),
        ]
        conn.executemany(
            """INSERT INTO portfolio_nav_snapshots
                   (account_id, snapshot_date, total_value, open_cost_basis,
                    unrealized_pnl, realized_pnl, invested_capital, dividends)
               VALUES (?,?,?,?,?,?,?,?)""",
            rows,
        )
        conn.execute(
            "INSERT INTO cash_adjustments (id, account_id, date, amount, currency) "
            "VALUES ('a1', 'acc', '2026-03-01', -500, 'THB')"
        )
    hist = mod.get_nav_history(account_id="acc", days=30)
    assert [h["nav_with_cash"] for h in hist] == [103000, 102500]
    # Adjustment applies only from its effective date forward.
    assert hist[0]["cash_balance"] == 70000
    assert hist[1]["cash_balance"] == 102500
