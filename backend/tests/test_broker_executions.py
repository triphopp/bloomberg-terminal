"""Broker image facts stay cited, idempotent and separate from live cash/lots."""
import hashlib
import importlib
import json

import pytest

from broker_executions import import_prepared, prepare_manifest


@pytest.fixture()
def book(tmp_path, monkeypatch):
    db_path = tmp_path / "portfolio.db"
    monkeypatch.setenv("PORTFOLIO_DB", str(db_path))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db()
    db.init_portfolio_v2()
    db.init_sync_layer()
    db.init_audit_layer()
    with db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts(id,name,currency) VALUES ('dime','Dime','USD')")
        conn.execute("INSERT INTO trades(id,account_id,symbol,date_entry,price_entry,volume,currency) VALUES ('old','dime','GRID','2026-05-06',194,24,'USD')")
    return tmp_path, db


def _manifest(folder, *, sale_amount=False):
    image = folder / "dime-activity.png"
    image.write_bytes(b"test image of the broker Activity screen")
    digest = hashlib.sha256(image.read_bytes()).hexdigest()
    payload = {"account_id": "dime", "broker": "Dime", "images": {image.name: digest},
        "executions": [
            {"symbol": "GRID", "side": "BUY", "executed_at_display": "2026-05-05T20:43:33",
             "quantity": "3.1392246", "unit_price": "191.13", "order_amount": "600.00",
             "order_ccy": "USD", "source_image": image.name},
            {"symbol": "GRID", "side": "SELL", "executed_at_display": "2026-06-22T22:48:12",
             "quantity": "24.8755543", "unit_price": "196.2960", "source_image": image.name},
        ]}
    if sale_amount:
        payload["executions"][1].update(order_amount="4882", order_ccy="USD")
    manifest = folder / "manifest.json"
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    return manifest, image


def test_image_cited_import_is_idempotent_and_does_not_post_money(book):
    folder, db = book
    manifest, _image = _manifest(folder)
    rows = prepare_manifest(manifest, folder)
    with db.get_db() as conn:
        with db.audit_reason(conn, "broker image evidence"):
            assert import_prepared(conn, rows) == {"inserted": 2, "already_present": 0}
    with db.get_db() as conn:
        assert import_prepared(conn, rows) == {"inserted": 0, "already_present": 2}
        assert conn.execute("SELECT count(*) FROM trades").fetchone()[0] == 1
        assert conn.execute("SELECT count(*) FROM cash_ledger").fetchone()[0] == 0
        assert conn.execute("SELECT count(*) FROM cash_adjustments").fetchone()[0] == 0
        assert conn.execute("SELECT count(*) FROM ledger_events").fetchone()[0] == 0
        assert conn.execute("SELECT count(*) FROM broker_executions").fetchone()[0] == 2
        assert conn.execute("SELECT count(*) FROM audit_events WHERE table_name='broker_executions'").fetchone()[0] == 2
        assert conn.execute("SELECT order_amount FROM broker_executions WHERE side='SELL'").fetchone()[0] is None


def test_tampered_image_and_unproven_sale_proceeds_are_rejected(book):
    folder, _db = book
    manifest, image = _manifest(folder)
    image.write_bytes(b"different file")
    with pytest.raises(ValueError, match="hash mismatch"):
        prepare_manifest(manifest, folder)
    manifest, _ = _manifest(folder, sale_amount=True)
    with pytest.raises(ValueError, match="Sale proceeds"):
        prepare_manifest(manifest, folder)


def test_account_delete_clears_cited_fills_after_trade_gate(book, monkeypatch):
    folder, db = book
    manifest, _ = _manifest(folder)
    with db.get_db() as conn:
        import_prepared(conn, prepare_manifest(manifest, folder))
    from routers import portfolio_v2
    monkeypatch.setattr(portfolio_v2, "get_db", db.get_db)
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as blocked:
        portfolio_v2.delete_account("dime")
    assert blocked.value.status_code == 409
    with db.get_db() as conn:
        assert conn.execute("SELECT count(*) FROM broker_executions").fetchone()[0] == 2
        conn.execute("DELETE FROM trades WHERE account_id='dime'")
    assert portfolio_v2.delete_account("dime") == {"ok": True}
    with db.get_db() as conn:
        assert conn.execute("SELECT count(*) FROM broker_executions").fetchone()[0] == 0
