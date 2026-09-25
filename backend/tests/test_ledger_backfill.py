"""
Ledger backfill: rebuild what was actually bought from rows that sales have
since rewritten, then replay it as a weighted-average stock card.

The trap this guards: after a partial sell the buy row carries a smaller
volume and (since the AVCO rebase fix) the pooled average instead of its own
price. Reading the rows as they stand would post the wrong buys.
"""
import importlib
import sqlite3

import pytest


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "ledger.db"))
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
    import ledger_backfill as lb
    importlib.reload(lb)
    with db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('acc','ACC','THB')")
        conn.execute("INSERT INTO cash_ledger (id, account_id, date, investment) "
                     "VALUES ('c1','acc','2026-01-01',100000)")
    return mod, db, lb


def _buy(db, tid, date, price, vol, created):
    with db.get_db() as conn:
        conn.execute(
            """INSERT INTO trades (id, account_id, symbol, date_entry, price_entry, volume,
                                   currency, win_loss, market, created_at)
               VALUES (?, 'acc', 'PTT', ?, ?, ?, 'THB', 'P', 'TH', ?)""",
            (tid, date, price, vol, created))


def _events(db, lb):
    with db.get_db() as conn:
        return lb.report(conn)


def test_partial_sells_rebuild_original_buys(env):
    """Plan example: buy 100@10, 200@12, sell 150, buy 50@9, sell 200."""
    mod, db, lb = env
    _buy(db, "a", "2026-01-05", 10, 100, "2026-01-05 03:00:00")
    _buy(db, "b", "2026-02-10", 12, 200, "2026-02-10 03:00:00")
    # SellModal sells lot by lot: 100 from a, then 50 from b
    mod.sell_position(mod.SellIn(trade_id="a", sell_volume=0, sell_price=15, sell_date="2026-03-15"))
    mod.sell_position(mod.SellIn(trade_id="b", sell_volume=50, sell_price=15, sell_date="2026-03-15"))
    _buy(db, "c", "2026-04-20", 9, 50, "2026-04-20 03:00:00")
    mod.sell_all_lots(mod.SellAllLotsIn(account_id="acc", symbol="PTT", sell_price=11,
                                        sell_date="2026-05-25"))

    # the rows no longer say what was bought
    with db.get_db() as conn:
        b = conn.execute("SELECT price_entry, volume FROM trades WHERE id='b'").fetchone()
    assert (round(b["price_entry"], 4), b["volume"]) != (12, 200)

    rep = _events(db, lb)
    buys = sorted((e.trade_date, e.qty, round(e.price, 6)) for e in rep["events"] if e.type == "BUY")
    assert buys == [("2026-01-05", 100, 10), ("2026-02-10", 200, 12), ("2026-04-20", 50, 9)]
    sells = sorted((e.trade_date, e.qty) for e in rep["events"] if e.type == "SELL")
    assert sells == [("2026-03-15", 150), ("2026-05-25", 200)]

    card = rep["cards"][("acc", "PTT")]
    realized = [round(r["realized"], 2) for r in card if r["realized"] is not None]
    # 150 × (15 − 11.3333) = 550 ; 200 × 11 − 2000(=50×9 + 150×11.3333... ) → see below
    assert realized[0] == 550.0
    assert round(card[-1]["bal_cost"], 6) == 0 and card[-1]["bal_qty"] == 0
    # cost conservation: everything bought left through a sale
    cost_in = sum(r["cost_in"] for r in card)
    cost_out = sum(r["cost_out"] for r in card)
    assert round(cost_in - cost_out, 6) == 0
    assert not [i for i in rep["issues"] if i.code in ("I1", "I2", "I3", "I6")]


def test_sale_before_buy_is_reported(env):
    _, db, lb = env
    with db.get_db() as conn:
        conn.execute(
            """INSERT INTO trades (id, account_id, symbol, date_entry, date_exit, price_entry,
                                   price_exit, volume, pnl_amount, currency, win_loss, market)
               VALUES ('v','acc','VT','2026-06-01','2026-03-17',140,139,4,-4,'THB','L','TH')""")
    codes = {i.code for i in _events(db, lb)["issues"]}
    assert {"I6", "I7"} <= codes


def test_same_day_order_follows_record_time(env):
    """Sold the old lot, THEN bought: the sale must not average in the new buy."""
    mod, db, lb = env
    _buy(db, "a", "2026-01-05", 10, 100, "2026-01-05 03:00:00")
    mod.sell_position(mod.SellIn(trade_id="a", sell_volume=0, sell_price=12, sell_date="2026-02-01"))
    _buy(db, "b", "2026-02-01", 20, 100, "2999-01-01 00:00:00")  # typed in after the sale
    rep = _events(db, lb)
    sale = next(r for r in rep["cards"][("acc", "PTT")] if r["realized"] is not None)
    assert round(sale["realized"], 2) == 200.0
    assert any(i.code == "I8_SAME_DAY" for i in rep["issues"])


def test_cash_check_ignores_same_day_trades_typed_after_the_target(env):
    """A broker balance typed at noon cannot include a buy recorded that evening
    (2026-09-25 Dime: COST/SNDK entered after the day's EDIT inflated I4)."""
    mod, db, lb = env
    _buy(db, "early", "2026-02-01", 10, 100, "2026-02-01 02:00:00")
    with db.get_db() as conn:
        conn.execute("""INSERT INTO cash_adjustments
            (id, account_id, date, amount, currency, target_balance, derived_before, created_at)
            VALUES ('adj', 'acc', '2026-02-01', 0, 'THB', 99000, 99000, '2026-02-01 05:00:00')""")
    _buy(db, "late", "2026-02-01", 10, 500, "2026-02-01 13:00:00")
    chk = next(c for c in _events(db, lb)["cash_checks"] if c["date"] == "2026-02-01")
    assert round(chk["ledger_balance"], 2) == 99000.0
    assert round(chk["unexplained"], 2) == 0.0
    assert chk["after_target"] == 1


def test_withdrawal_is_a_cash_event(env):
    mod, db, lb = env
    mod.add_cash(mod.CashIn(account_id="acc", date="2026-02-01", flow_type="WITHDRAW", amount=300))
    ev = [e for e in _events(db, lb)["events"] if e.type == "WITHDRAW"]
    assert [(e.net_cash, e.currency) for e in ev] == [(-300, "THB")]


def test_apply_is_idempotent_and_table_is_append_only(env):
    mod, db, lb = env
    _buy(db, "a", "2026-01-05", 10, 100, "2026-01-05 03:00:00")
    with db.get_db() as conn:
        events = lb.report(conn)["events"]
        first = lb.apply(conn, events)
        second = lb.apply(conn, events)
    assert first["inserted"] == len(events) and second["inserted"] == 0
    with db.get_db() as conn:
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            conn.execute("UPDATE ledger_events SET qty = 1")
    with db.get_db() as conn:
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            conn.execute("DELETE FROM ledger_events")
