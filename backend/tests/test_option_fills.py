"""
option_fills: the one write path PORT → ENTRY uses for an option fill.

A close consumes open lots oldest first by FILL TIME (not by the order they
were typed in), or exactly the lots the caller names; realized P&L carries
both legs' fees; dry_run writes nothing; an order number is booked once.
"""
import importlib

import pytest


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "book.db"))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema()
    db.init_alerts_schema(); db.init_sync_layer(); db.init_audit_layer()
    import option_fills as of
    importlib.reload(of)
    import accounting_checks as ac
    importlib.reload(ac)
    with db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('dime','Dime','USD')")
    return db, of, ac


def fill(**kw):
    base = dict(account_id="dime", underlying="INTC", expiry="2026-04-24", strike=70, option_type="call",
                action="OPEN", side="BUY", quantity=10, price=0.54, trade_date="2026-04-08",
                fee_items=[{"component": "COMMISSION", "amount": "5.50"},
                           {"component": "COMMISSION_DISCOUNT", "amount": "-5.50"},
                           {"component": "OCC", "amount": "0.25"}, {"component": "ORF", "amount": "0.23"}])
    base.update(kw)
    return base


def test_open_books_fill_fees_and_provenance(env):
    db, of, ac = env
    with db.get_db() as conn:
        r = of.book(conn, fill(executed_at="2026-04-08T20:43:54+07:00", broker_order_ref="optblo1"))
        t = conn.execute("SELECT * FROM option_trades WHERE trade_id=?", (r["trade_id"],)).fetchone()
        items = conn.execute("SELECT component, amount, source FROM trade_fee_items WHERE trade_id=?",
                             (r["trade_id"],)).fetchall()
        assert not ac.run(conn, codes=["F1"])["findings"]
    assert t["fees"] == pytest.approx(0.48) and t["broker_order_ref"] == "OPTBLO1"
    assert t["entry_source"] == "manual" and t["executed_at"] == "2026-04-08T20:43:54+07:00"
    assert {(c, a) for c, a, _ in items} >= {("COMMISSION_DISCOUNT", "-5.50"), ("OCC", "0.25")}
    assert r["cash_effect"] == pytest.approx(-540.48)


def test_fifo_close_follows_fill_time_not_entry_order(env):
    db, of, ac = env
    with db.get_db() as conn:
        late = of.book(conn, fill(quantity=100, price=0.79, executed_at="2026-04-08T21:00:00+07:00"))
        early = of.book(conn, fill(quantity=10, price=0.54, executed_at="2026-04-08T20:43:54+07:00"))
        r = of.book(conn, fill(action="CLOSE", side="SELL", quantity=10, price=0.64,
                               executed_at="2026-04-08T21:31:00+07:00",
                               fee_items=[{"component": "OCC", "amount": "0.25"}, {"component": "ORF", "amount": "0.23"},
                                          {"component": "TAF", "amount": "0.04"}]))
    assert [m["open_trade_id"] for m in r["matches"]] == [early["trade_id"]]
    assert r["realized_total"] == pytest.approx(100 - 0.48 - 0.52)
    assert late["trade_id"] != early["trade_id"]


def test_named_allocation_and_dry_run_writes_nothing(env):
    db, of, ac = env
    with db.get_db() as conn:
        a = of.book(conn, fill(quantity=10))
        b = of.book(conn, fill(quantity=100, price=0.79))
        body = fill(action="CLOSE", side="SELL", quantity=30, price=0.80, fee_items=[],
                    allocations=[{"open_trade_id": b["trade_id"], "quantity": 30}])
        preview = of.plan(conn, body)
        n = conn.execute("SELECT COUNT(*) FROM option_trades").fetchone()[0]
    assert n == 2
    assert preview["matches"][0]["open_trade_id"] == b["trade_id"]
    assert preview["realized_total"] == pytest.approx(30 * 100 * 0.01 - 0.48 * 30 / 100, abs=0.005)
    assert a["trade_id"] not in [m["open_trade_id"] for m in preview["matches"]]


def test_refusals(env):
    db, of, ac = env
    with db.get_db() as conn:
        of.book(conn, fill(broker_order_ref="OPTBLO1"))
        with pytest.raises(of.FillError, match="already booked"):
            of.plan(conn, fill(broker_order_ref="OPTBLO1"))
        with pytest.raises(of.FillError, match="only 10"):
            of.plan(conn, fill(action="CLOSE", side="SELL", quantity=11, price=0.6))
        with pytest.raises(of.FillError, match="no open short"):
            of.plan(conn, fill(action="CLOSE", side="BUY", quantity=1, price=0.6))
        with pytest.raises(of.FillError, match="expiry"):
            of.plan(conn, fill(action="CLOSE", side="SELL", quantity=1, price=0))
        with pytest.raises(of.FillError, match="offset"):
            of.plan(conn, fill(executed_at="2026-04-08T20:43:54"))


def test_expired_close_defaults_to_zero_and_realizes_the_whole_cost(env):
    db, of, ac = env
    with db.get_db() as conn:
        of.book(conn, fill(quantity=2, price=0.29, expiry="2026-02-06", trade_date="2026-01-29",
                           fee_items=[{"component": "OCC", "amount": "0.04"}, {"component": "ORF", "amount": "0.01"}]))
        r = of.book(conn, fill(action="CLOSE", side="SELL", quantity=2, price=None, close_reason="EXPIRED",
                               expiry="2026-02-06", trade_date="2026-02-06", fee_items=[]))
    assert r["realized_total"] == pytest.approx(-58.05)
