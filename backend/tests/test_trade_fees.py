"""Broker fees on trades: estimated for Dime, kept out of the cost basis,
charged to cash on the day they are paid, and posted as FEE ledger events.

Numbers mirror the Dime SNDK confirmation of 2026-09-24.
"""
import importlib
import json

import pytest


@pytest.fixture()
def pv2(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "fees.db"))
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
    import ledger_backfill
    importlib.reload(ledger_backfill)
    monkeypatch.setattr(mod, "_get_thb_per_usd", lambda: 33.0)
    monkeypatch.setattr(mod, "open_option_positions", lambda *a, **k: [])
    monkeypatch.setattr(mod, "closed_option_positions", lambda *a, **k: [])
    with db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('dime','Dime','USD')")
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('other','Other','USD')")
    return mod, db, ledger_backfill


def _buy(mod, acct="dime", **kw):
    body = dict(account_id=acct, symbol="SNDK", market="US", currency="USD",
                date_entry="2026-09-11", price_entry=1587.0516, volume=4.4628775,
                exchange_rate=33.0)
    body.update(kw)
    return mod.create_trade(mod.TradeIn(**body))


def _row(db, tid):
    with db.get_db() as conn:
        return dict(conn.execute("SELECT * FROM trades WHERE id = ?", (tid,)).fetchone())


def _cash_usd(mod, acct="dime"):
    s = mod.get_summary(base_currency="USD")
    return next(a for a in s["accounts"] if a["account"]["id"] == acct)


def test_estimate_endpoint_matches_confirmation(pv2):
    mod, _, _ = pv2
    f = mod.estimate_fees(account_id="dime", side="SELL", qty=4.4628776, price=1754.96,
                          symbol="SNDK", market="US")
    assert (f["commission"], f["vat"], f["sec_fee"], f["taf_fee"]) == (11.75, 0.82, 0.17, 0.01)
    assert mod.estimate_fees(account_id="other", side="BUY", qty=1, price=1,
                             symbol="SNDK", market="US")["profile"] is None


def test_buy_fee_is_estimated_kept_out_of_cost_and_reduces_cash(pv2):
    mod, db, _ = pv2
    r = _buy(mod)
    row = _row(db, r["id"])
    assert row["price_entry"] == 1587.0516            # cost basis untouched
    assert row["fee_entry"] == pytest.approx(11.37, abs=0.02)   # 0.1605 % of 7,082.82
    assert json.loads(row["fee_detail"])["entry"]["source"] == "auto"
    acct = _cash_usd(mod)
    assert acct["entry_fees_base"] == pytest.approx(row["fee_entry"], abs=0.01)
    # No deposits: cash = −cost − fee
    assert acct["cash_base"] == pytest.approx(-(4.4628775 * 1587.0516) - row["fee_entry"], abs=0.02)


def test_typed_fee_wins_and_zero_means_none(pv2):
    mod, db, _ = pv2
    assert _row(db, _buy(mod, fee_entry=12.0)["id"])["fee_entry"] == 12.0
    assert _row(db, _buy(mod, fee_entry=0)["id"])["fee_entry"] == 0
    assert _row(db, _buy(mod, acct="other")["id"])["fee_entry"] is None


def test_sell_deducts_estimated_fees_from_pnl(pv2):
    mod, db, _ = pv2
    tid = _buy(mod, fee_entry=0)["id"]
    res = mod.sell_position(mod.SellIn(trade_id=tid, sell_price=1754.96, sell_date="2026-09-24"))
    row = _row(db, tid)
    assert row["fee_exit"] == pytest.approx(12.75, abs=0.02)
    gross = (1754.96 - 1587.0516) * 4.4628775
    assert row["pnl_amount"] == pytest.approx(round(gross, 2) - row["fee_exit"], abs=0.01)
    assert res["fee_exit"] == row["fee_exit"]


def test_partial_sell_records_fee_on_the_sold_row(pv2):
    mod, db, _ = pv2
    tid = _buy(mod, fee_entry=0, volume=10, price_entry=100)["id"]
    res = mod.sell_position(mod.SellIn(trade_id=tid, sell_volume=4, sell_price=110,
                                       sell_date="2026-09-20", commission=1.5))
    sold = _row(db, res["sold_trade_id"])
    assert sold["fee_exit"] == 1.5 and sold["pnl_amount"] == 38.5
    assert _row(db, tid)["fee_exit"] is None


def test_editing_the_sale_fee_keeps_pnl_net(pv2):
    mod, db, _ = pv2
    tid = _buy(mod, fee_entry=0)["id"]
    mod.sell_position(mod.SellIn(trade_id=tid, sell_price=1754.96, sell_date="2026-09-24"))
    before = _row(db, tid)
    mod.patch_trade(tid, mod.TradePatch(fee_exit=12.74, adjustment_reason="confirmation"))
    after = _row(db, tid)
    assert after["pnl_amount"] == pytest.approx(before["pnl_amount"] + before["fee_exit"] - 12.74, abs=0.001)


def test_ledger_posts_buy_fee_as_its_own_cash_event(pv2):
    mod, db, lb = pv2
    tid = _buy(mod, fee_entry=11.37)["id"]
    mod.sell_position(mod.SellIn(trade_id=tid, sell_price=1754.96, sell_date="2026-09-24",
                                 commission=12.74))
    with db.get_db() as conn:
        events, _ = lb.build_events(conn)
    by = {e.type: e for e in events if e.account_id == "dime"}
    assert by["FEE"].net_cash == pytest.approx(-11.37)
    assert by["BUY"].fee == 0                                   # cost stays qty × price
    assert by["SELL"].fee == pytest.approx(12.74)
    assert by["SELL"].net_cash == pytest.approx(4.4628775 * 1754.96 - 12.74, abs=0.01)
