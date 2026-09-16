"""
Every write to a money table must leave an audit event, whichever code path
made it. The log is trigger-written, so these tests go straight at SQL as well
as through endpoints — a raw UPDATE is exactly the path an app-level logger
forgets.
"""
import importlib
import json

import pytest


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "audit.db"))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema()
    db.init_alerts_schema(); db.init_sync_layer(); db.init_audit_layer()
    import portfolio_currency
    importlib.reload(portfolio_currency)
    import routers.portfolio_v2 as mod
    importlib.reload(mod)
    monkeypatch.setattr(mod, "_get_thb_per_usd", lambda: 35.0)
    monkeypatch.setattr(mod, "open_option_positions", lambda *a, **k: [])
    monkeypatch.setattr(mod, "closed_option_positions", lambda *a, **k: [])
    with db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('acc','ACC','THB')")
    return mod, db


def _events(db, **where):
    sql = "SELECT * FROM audit_events"
    if where:
        sql += " WHERE " + " AND ".join(f"{k} = ?" for k in where)
    with db.get_db() as conn:
        return [dict(r) for r in conn.execute(sql + " ORDER BY created_at", list(where.values()))]


def test_insert_update_delete_each_logged_once(env):
    mod, db = env
    with db.get_db() as conn:
        conn.execute(
            "INSERT INTO cash_ledger (id, account_id, date, investment) VALUES ('c1','acc','2026-01-01',100)"
        )
    with db.get_db() as conn:
        conn.execute("UPDATE cash_ledger SET investment = 150 WHERE id = 'c1'")
    with db.get_db() as conn:
        conn.execute("DELETE FROM cash_ledger WHERE id = 'c1'")

    ev = _events(db, table_name="cash_ledger")
    # The sync layer re-stamps updated_at after every write; that must not
    # turn one edit into two events.
    assert [e["action"] for e in ev] == ["INSERT", "UPDATE", "DELETE"]
    assert all(e["account_id"] == "acc" and e["row_id"] == "c1" for e in ev)
    assert json.loads(ev[1]["old_data"])["investment"] == 100
    assert json.loads(ev[1]["new_data"])["investment"] == 150
    assert json.loads(ev[2]["old_data"])["investment"] == 150  # deleted row survives in the log


def test_timestamp_only_update_is_not_an_event(env):
    _, db = env
    with db.get_db() as conn:
        conn.execute("UPDATE portfolio_accounts SET updated_at = '2030-01-01' WHERE id = 'acc'")
    assert _events(db, table_name="portfolio_accounts", action="UPDATE") == []


def test_sync_import_is_not_logged(env):
    _, db = env
    with db.get_db() as conn:
        conn.execute("UPDATE _sync_guard SET active = 1")
        conn.execute("INSERT INTO dividends (id, account_id, asset) VALUES ('d1','acc','PTT')")
        conn.execute("UPDATE _sync_guard SET active = 0")
    assert _events(db, table_name="dividends") == []


def test_reason_is_attached_and_cleared(env):
    mod, db = env
    with db.get_db() as conn:
        conn.execute(
            """INSERT INTO trades (id, account_id, symbol, date_entry, price_entry, volume, currency)
               VALUES ('t1','acc','PTT','2026-01-02',30,100,'THB')"""
        )
    mod.patch_trade("t1", mod.TradePatch(price_entry=31, adjustment_reason="typo in price"))
    with db.get_db() as conn:
        conn.execute("UPDATE trades SET volume = 200 WHERE id = 't1'")

    upd = _events(db, table_name="trades", action="UPDATE")
    assert [e["reason"] for e in upd] == ["typo in price", None]


def test_reconcile_and_undo_are_logged_and_listed(env):
    mod, db = env
    res = mod.reconcile_cash(mod.CashReconcileIn(account_id="acc", actual_balance=500, note="broker stmt"))
    mod.delete_cash_adjustment(res["id"])

    out = mod.list_audit_events(account_id="acc", table_name="cash_adjustments",
                                row_id=None, action=None, before=None, limit=50)
    actions = [e["action"] for e in out["events"]]
    assert sorted(actions) == ["DELETE", "INSERT"]
    ins = next(e for e in out["events"] if e["action"] == "INSERT")
    assert ins["reason"] == "broker stmt"
    assert ins["new"]["amount"] == 500


def test_update_event_exposes_changed_fields(env):
    mod, db = env
    with db.get_db() as conn:
        conn.execute("UPDATE portfolio_accounts SET name = 'RENAMED' WHERE id = 'acc'")
    out = mod.list_audit_events(account_id="acc", table_name=None, row_id=None,
                                action="UPDATE", before=None, limit=50)
    assert out["events"][0]["changed"] == {"name": {"old": "ACC", "new": "RENAMED"}}
