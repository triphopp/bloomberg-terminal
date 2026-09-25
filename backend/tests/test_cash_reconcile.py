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


def test_withdrawal_after_capture_still_shows_on_its_date(pv2):
    """The snapshot froze invested capital on capture day. A withdrawal typed in
    afterwards (or backdated) must still land on its own date — as a flow, not
    a loss — and a cash EDIT offset must not be reported as a deposit."""
    mod, db = pv2
    with db.get_db() as conn:
        # Both snapshots were captured BEFORE the withdrawal was recorded:
        # invested_capital is 100k in each.
        conn.executemany(
            """INSERT INTO portfolio_nav_snapshots
                   (account_id, snapshot_date, total_value, open_cost_basis,
                    unrealized_pnl, realized_pnl, invested_capital, dividends)
               VALUES (?,?,?,?,?,?,?,?)""",
            [("acc", "2026-03-01", 30000, 30000, 0, 0, 100000, 0),
             ("acc", "2026-03-02", 30000, 30000, 0, 0, 100000, 0),
             ("acc", "2026-03-03", 30000, 30000, 0, 0, 100000, 0)],
        )
        conn.execute("INSERT INTO cash_ledger (id, account_id, date, investment, entry_type) "
                     "VALUES ('w1', 'acc', '2026-03-02', -20000, 'WITHDRAW')")
        conn.execute("INSERT INTO cash_adjustments (id, account_id, date, amount, currency) "
                     "VALUES ('a1', 'acc', '2026-03-03', -500, 'THB')")
    hist = mod.get_nav_history(account_id="acc", days=30)
    assert [h["invested_capital"] for h in hist] == [100000, 80000, 80000]
    assert hist[1]["invested_stored"] == 100000

    idx = mod.get_nav_index(account_id="acc", days=30, benchmark="SPY", base_currency="THB")
    pts = idx["points"]
    assert [p["capital_flow"] for p in pts] == [0, -20000, 0]
    assert [p["adjustment_flow"] for p in pts] == [0, 0, -500]
    # Neither the withdrawal nor the offset is performance.
    assert idx["port_twr_pct"] == 0
    assert idx["net_capital_flow"] == -20000


def test_backfilled_days_are_marked_estimated(pv2):
    mod, db = pv2
    with db.get_db() as conn:
        conn.executemany(
            """INSERT INTO portfolio_nav_snapshots
                   (account_id, snapshot_date, total_value, open_cost_basis,
                    unrealized_pnl, realized_pnl, invested_capital, dividends, source)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            [("acc", "2026-03-01", 30000, 30000, 0, 0, 0, 0, "backfill"),
             ("acc", "2026-03-02", 30000, 30000, 0, 0, 0, 0, "backfill"),
             ("acc", "2026-03-03", 30000, 30000, 0, 0, 100000, 0, "live")],
        )
    idx = mod.get_nav_index(account_id="acc", days=30, benchmark="SPY", base_currency="THB")
    assert [p["estimated"] for p in idx["points"]] == [True, True, False]
    assert idx["estimated_until"] == "2026-03-02"


def _returns(mod, monkeypatch):
    monkeypatch.setattr(mod, "_batch_fetch_prices", lambda syms: {})
    return mod.get_portfolio_returns(account_id=None, base_currency="THB")


def test_xirr_flags_dividends_before_the_first_buy(pv2, monkeypatch):
    """Dime 2026-09-25: 2025 dividends from holdings whose buys were never
    recorded made trade XIRR +276%. The rate is kept but flagged."""
    mod, db = pv2
    with db.get_db() as conn:
        conn.execute(
            """INSERT INTO dividends (id, account_id, asset, pay_date, total_received, currency)
               VALUES ('d1', 'acc', 'PTT', '2025-06-01', 5000, 'THB')"""
        )
    r = _returns(mod, monkeypatch)
    assert r["total"]["xirr_flag"] == "inflow_before_outflow"


def test_capital_xirr_uses_deposits_and_nav(pv2, monkeypatch):
    mod, db = pv2
    from datetime import datetime, timedelta
    today = datetime.now().strftime("%Y-%m-%d")
    with db.get_db() as conn:
        # 100k deposited 2026-01-01 (fixture); NAV today = 30k holdings + 70k cash.
        conn.execute(
            """INSERT INTO portfolio_nav_snapshots
                   (account_id, snapshot_date, total_value, open_cost_basis,
                    unrealized_pnl, realized_pnl, invested_capital, dividends)
               VALUES ('all', ?, 30000, 30000, 0, 0, 100000, 0)""", (today,))
    r = _returns(mod, monkeypatch)["total"]
    assert r["net_deposited"] == 100000
    assert r["nav_now"] == 100000
    assert abs(r["xirr_capital_pct"]) < 0.01          # flat money → 0%
    assert r["xirr_capital_flag"] is None


def test_capital_xirr_notes_an_opening_balance(pv2, monkeypatch):
    mod, db = pv2
    with db.get_db() as conn:
        conn.execute("UPDATE cash_ledger SET note = 'Finansia opening balance - was 2026-02-08'")
        conn.execute(
            """INSERT INTO portfolio_nav_snapshots
                   (account_id, snapshot_date, total_value, open_cost_basis,
                    unrealized_pnl, realized_pnl, invested_capital, dividends)
               VALUES ('all', date('now'), 30000, 30000, 0, 0, 100000, 0)""")
    assert _returns(mod, monkeypatch)["total"]["xirr_capital_flag"] == "opening_balance_at_cost"


def _row(d, nav, inv=0.0, adj=0.0, source="live"):
    return {"snapshot_date": d, "nav_with_cash": nav, "invested_capital": inv,
            "cash_adjustment": adj, "source": source}


def test_period_returns_start_from_prior_year_end_and_net_flows(pv2):
    mod, _ = pv2
    rows = [
        _row("2025-12-31", 100_000, inv=100_000, source="backfill"),
        _row("2026-03-01", 110_000, inv=100_000),
        _row("2026-03-02", 160_000, inv=150_000),     # +50k deposit, no gain
        _row("2026-06-30", 160_000, inv=150_000, adj=-5_000),  # EDIT offset, not a loss
    ]
    p = {x["period"]: x for x in mod._period_returns(rows, "THB", today="2026-09-25")}
    y = p["2026"]
    assert y["start"] == "2025-12-31" and y["ytd"] is True
    assert y["net_flow"] == 45_000
    # 100k grew 10% on money that was there; the deposit and the offset are flows
    assert 9 < y["period_pct"] < 11.5
    assert y["estimated"] is True              # starts on a rebuilt day
    assert "2025" not in p                     # one snapshot → no span to measure


def test_period_returns_ignore_history_before_the_period(pv2):
    """Dime: dividends before the first recorded buy broke all-time XIRR; a
    period starting from NAV cannot see them."""
    mod, _ = pv2
    rows = [_row("2027-01-01", 200_000, inv=150_000), _row("2027-07-01", 210_000, inv=150_000)]
    y = mod._period_returns(rows, "THB", today="2027-07-02")[0]
    assert y["flag"] is None and round(y["period_pct"], 2) == 5.0


def test_capital_xirr_treats_edit_offsets_as_flows(pv2, monkeypatch):
    """Same policy as GROWTH/periods: an EDIT that lifts cash to the broker's
    figure is not a gain (2026-09-25: ฿266K of offsets made capital XIRR look
    ~12 points better than it was)."""
    mod, db = pv2
    with db.get_db() as conn:
        conn.execute("INSERT INTO cash_adjustments (id, account_id, date, amount, currency) "
                     "VALUES ('a1', 'acc', '2026-01-02', 20000, 'THB')")
        conn.execute(
            """INSERT INTO portfolio_nav_snapshots
                   (account_id, snapshot_date, total_value, open_cost_basis,
                    unrealized_pnl, realized_pnl, invested_capital, dividends)
               VALUES ('all', date('now'), 30000, 30000, 0, 0, 100000, 0)""")
    r = _returns(mod, monkeypatch)["total"]
    assert r["nav_now"] == 120000          # 30k holdings + 70k cash + 20k offset
    assert r["net_deposited"] == 120000
    assert abs(r["xirr_capital_pct"]) < 0.01
