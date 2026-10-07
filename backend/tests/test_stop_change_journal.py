"""PATCH /trades/{id}: a moved stop on an open lot goes in the risk decision
journal with its reason — and a missing journal never blocks the edit."""
import importlib

import pytest


def _env(tmp_path, monkeypatch, with_journal: bool):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "levels.db"))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema()
    if with_journal:
        db.init_guard_schema()
    db.init_alerts_schema(); db.init_sync_layer(); db.init_audit_layer()
    import routers.portfolio_v2 as mod
    importlib.reload(mod)
    with db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('acc','ACC','USD')")
        conn.execute(
            "INSERT INTO trades (id, account_id, symbol, date_entry, price_entry, volume, win_loss,"
            " price_stoploss) VALUES ('t1','acc','V','2026-09-28',369.38,19,'P',340.0)"
        )
        conn.execute(
            "INSERT INTO trades (id, account_id, symbol, date_entry, date_exit, price_entry, price_exit,"
            " volume, win_loss, price_stoploss) VALUES ('t2','acc','V','2026-08-01','2026-09-01',300,350,5,'W',280.0)"
        )
    return mod, db


@pytest.fixture()
def env(tmp_path, monkeypatch):
    return _env(tmp_path, monkeypatch, with_journal=True)


def _journal(db):
    import risk_journal
    with db.get_db() as conn:
        return risk_journal.list_decisions(conn)


def test_moved_stop_is_journalled_with_the_reason_and_both_levels(env):
    mod, db = env
    mod.patch_trade("t1", mod.TradePatch(price_stoploss=320.0, adjustment_reason="ให้ที่หายใจก่อนงบ"))
    rows = _journal(db)
    assert len(rows) == 1
    r = rows[0]
    assert (r["kind"], r["decision"], r["symbol"], r["account_id"]) == ("STOP", "CHANGE", "V", "acc")
    assert r["reason"] == "ให้ที่หายใจก่อนงบ" and r["source"] == "trade_edit" and r["ref_id"] == "t1"
    assert r["snapshot"]["stop_from"] == 340.0 and r["snapshot"]["stop_to"] == 320.0
    assert r["active"] is False                       # a change is a record, not a live hold


def test_cleared_stop_is_journalled_and_a_blank_reason_is_said(env):
    mod, db = env
    mod.patch_trade("t1", mod.TradePatch(price_stoploss=None))
    r = _journal(db)[0]
    assert r["snapshot"] == {"stop_from": 340.0, "price_entry": 369.38, "trade_id": "t1"}
    assert r["reason"] == "ไม่ระบุเหตุผล"


def test_same_stop_other_fields_and_closed_lots_write_nothing(env):
    mod, db = env
    mod.patch_trade("t1", mod.TradePatch(price_stoploss=340.0))          # unchanged
    mod.patch_trade("t1", mod.TradePatch(price_target=420.0))            # not the stop
    mod.patch_trade("t2", mod.TradePatch(price_stoploss=250.0))          # lot already closed
    assert _journal(db) == []


def test_edit_goes_through_on_a_db_without_the_journal_table(tmp_path, monkeypatch):
    mod, db = _env(tmp_path, monkeypatch, with_journal=False)
    assert mod.patch_trade("t1", mod.TradePatch(price_stoploss=320.0))["ok"] is True
    with db.get_db() as conn:
        assert conn.execute("SELECT price_stoploss FROM trades WHERE id = 't1'").fetchone()[0] == 320.0
