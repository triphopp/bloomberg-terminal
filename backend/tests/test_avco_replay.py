"""AVCO replay by date (no network).

A sale is priced off the average cost AT ITS DATE. Before avco_replay a buy
typed after a sale but dated before it, or an edited lot, left the booked sale
on the old average — ledger check I3/I2 (the DELTA / NFLX / INTC cases).
"""
import importlib

import pytest

mod = None
db = None


@pytest.fixture()
def book(tmp_path, monkeypatch):
    global mod, db
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "replay.db"))
    import config
    importlib.reload(config)
    import db as db_mod
    importlib.reload(db_mod)
    db = db_mod
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema()
    db.init_alerts_schema(); db.init_sync_layer(); db.init_audit_layer()
    import portfolio_currency
    importlib.reload(portfolio_currency)
    import routers.portfolio_v2 as m
    importlib.reload(m)
    mod = m
    with db.get_db() as conn:
        conn.execute(
            "INSERT INTO portfolio_accounts (id, name, broker, country, currency, account_type) "
            "VALUES ('fin','FIN','','TH','THB','equity')"
        )
    return m


def _buy(price, volume, date, symbol="PTT"):
    return mod.create_trade(mod.TradeIn(
        account_id="fin", symbol=symbol, market="TH", currency="THB", sector="Energy",
        date_entry=date, price_entry=price, volume=volume, win_loss="P", fee_entry=0,
    ))["id"]


def _sell(trade_id, volume, price, date):
    return mod.sell_position(mod.SellIn(trade_id=trade_id, sell_volume=volume,
                                        sell_price=price, sell_date=date, commission=0))


def _rows(symbol="PTT"):
    with db.get_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM trades WHERE symbol = ? ORDER BY date_entry, rowid", (symbol,))]


def test_backdated_buy_reprices_a_booked_sale(book):
    a = _buy(10, 100, "2026-01-05")
    _sell(a, 50, 12, "2026-01-20")                  # avg 10 → +100
    sold = next(r for r in _rows() if r["win_loss"] != "P")
    assert sold["pnl_amount"] == 100

    _buy(20, 100, "2026-01-10")                      # typed later, dated before the sale
    rows = _rows()
    sold = next(r for r in rows if r["win_loss"] != "P")
    # avg at the sale = (100×10 + 100×20) / 200 = 15 → (12 − 15) × 50
    assert sold["price_entry"] == pytest.approx(15)
    assert sold["pnl_amount"] == -150
    assert sold["win_loss"] == "L"
    for r in rows:
        if r["win_loss"] == "P":
            assert r["price_entry"] == pytest.approx(15)   # 150 left at 15
    with db.get_db() as conn:
        actions = {r[0] for r in conn.execute("SELECT action FROM trade_audit_log")}
    assert "AVCO_REPAIR" in actions


def test_buy_dated_after_the_sale_does_not_touch_it(book):
    a = _buy(10, 100, "2026-01-05")
    _sell(a, 50, 12, "2026-01-20")
    _buy(20, 100, "2026-02-01")
    rows = _rows()
    sold = next(r for r in rows if r["win_loss"] != "P")
    assert sold["pnl_amount"] == 100
    open_rows = [r for r in rows if r["win_loss"] == "P"]
    # 50 @10 + 100 @20 → 16.667
    for r in open_rows:
        assert r["price_entry"] == pytest.approx((50 * 10 + 100 * 20) / 150)


def test_multi_lot_sale_uses_one_average(book):
    """DELTA: 200 @276 + 400 @279, sell 400 @250 lot by lot → 400 × 278 cost."""
    a = _buy(276, 200, "2026-08-17", "DELTA")
    b = _buy(279, 400, "2026-08-17", "DELTA")
    _sell(a, 0, 250, "2026-08-25")
    _sell(b, 200, 250, "2026-08-25")
    rows = _rows("DELTA")
    realized = sum(r["pnl_amount"] for r in rows if r["win_loss"] != "P")
    assert realized == pytest.approx((250 - 278) * 400)
    assert [r["price_entry"] for r in rows if r["win_loss"] == "P"] == [pytest.approx(278)]


def test_editing_the_buy_price_reprices_the_sale(book):
    a = _buy(10, 100, "2026-01-05")
    _sell(a, 50, 12, "2026-01-20")
    lot = next(r for r in _rows() if r["win_loss"] == "P")
    mod.patch_trade(lot["id"], mod.TradePatch(price_entry=11, adjustment_reason="typo"))
    rows = _rows()
    assert {r["lot_price"] for r in rows} == {11}     # both halves of the lot
    sold = next(r for r in rows if r["win_loss"] != "P")
    assert sold["pnl_amount"] == 50                    # (12 − 11) × 50


def test_note_edit_does_not_replay(book):
    a = _buy(10, 100, "2026-01-05")
    res = mod.patch_trade(a, mod.TradePatch(note="hello"))
    assert res["replay"] is None


def test_delete_of_a_buy_reprices(book):
    a = _buy(10, 100, "2026-01-05")
    b = _buy(20, 100, "2026-01-10")
    _sell(a, 50, 12, "2026-01-20")                   # avg 15 → −150
    sold = next(r for r in _rows() if r["win_loss"] != "P")
    assert sold["pnl_amount"] == -150
    mod.delete_trade(b)
    sold = next(r for r in _rows() if r["win_loss"] != "P")
    assert sold["pnl_amount"] == 100


def test_cost_override_is_left_alone(book):
    a = _buy(10, 100, "2026-01-05")
    with db.get_db() as conn:
        conn.execute("INSERT INTO position_cost_overrides (account_id, symbol, avg_cost, reason) "
                     "VALUES ('fin','PTT',9,'broker')")
    _sell(a, 50, 12, "2026-01-20")
    sold = next(r for r in _rows() if r["win_loss"] != "P")
    assert sold["pnl_amount"] == 150                   # (12 − 9) × 50, as the override says


def test_history_that_oversells_is_not_rewritten(book):
    import avco_replay
    a = _buy(10, 100, "2026-01-05")
    _sell(a, 0, 12, "2026-01-20")
    with db.get_db() as conn:
        # buy moved after the sale → the sale sold shares not yet held
        conn.execute("UPDATE trades SET date_entry = '2026-02-01' WHERE id = ?", (a,))
        out = avco_replay.replay(conn, "fin", "PTT")
    assert out["skipped"]
    assert out["rows_changed"] == 0


def test_lot_price_backfilled_from_audit_for_old_rows(book):
    import avco_replay
    a = _buy(10, 100, "2026-01-05")
    b = _buy(20, 100, "2026-01-10")
    _sell(a, 50, 12, "2026-01-20")
    with db.get_db() as conn:
        conn.execute("UPDATE trades SET lot_price = NULL")   # rows from before the column
        avco_replay.replay(conn, "fin", "PTT")
        prices = {r["id"]: r["lot_price"] for r in conn.execute("SELECT id, lot_price FROM trades")}
    assert prices[a] == 10 and prices[b] == 20
