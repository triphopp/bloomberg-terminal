"""PATCH /trades/{id}: the S/L and target levels can be set, changed and cleared.

Every other field treats null as "not sent"; for these two an explicit null is
how the EDIT modal clears a level the user no longer wants.
"""
import importlib

import pytest


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "levels.db"))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema()
    db.init_alerts_schema(); db.init_sync_layer(); db.init_audit_layer()
    import routers.portfolio_v2 as mod
    importlib.reload(mod)
    with db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('acc','ACC','USD')")
        conn.execute(
            "INSERT INTO trades (id, account_id, symbol, date_entry, price_entry, volume, win_loss, note)"
            " VALUES ('t1','acc','V','2026-09-28',369.38,19.1523365,'P','keep me')"
        )
    return mod, db


def _row(db):
    with db.get_db() as conn:
        return dict(conn.execute("SELECT * FROM trades WHERE id = 't1'").fetchone())


def test_set_then_clear_levels(env):
    mod, db = env
    mod.patch_trade("t1", mod.TradePatch(price_stoploss=340.0, price_target=420.5))
    r = _row(db)
    assert (r["price_stoploss"], r["price_target"]) == (340.0, 420.5)

    mod.patch_trade("t1", mod.TradePatch(price_stoploss=None))
    r = _row(db)
    assert r["price_stoploss"] is None
    assert r["price_target"] == 420.5  # not sent → untouched


def test_null_on_other_fields_is_still_ignored(env):
    mod, db = env
    mod.patch_trade("t1", mod.TradePatch(note=None, price_target=400.0))
    r = _row(db)
    assert r["note"] == "keep me"
    assert r["price_target"] == 400.0
