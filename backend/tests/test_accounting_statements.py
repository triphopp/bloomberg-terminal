import importlib
import sqlite3

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from accounting_io import read_book


@pytest.fixture()
def book(tmp_path, monkeypatch):
    path = tmp_path / "statement.db"
    monkeypatch.setenv("PORTFOLIO_DB", str(path))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db()
    db.init_portfolio_v2()
    db.init_sync_layer()
    db.init_audit_layer()
    with db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts(id,name,currency) VALUES ('a','A','THB')")
        conn.execute("INSERT INTO cash_ledger(id,account_id,date,investment) VALUES ('dep','a','2026-01-01',1000)")
        conn.execute("INSERT INTO trades(id,account_id,symbol,date_entry,price_entry,volume,currency,win_loss) VALUES ('buy','a','PTT','2026-01-02',10,10,'THB','P')")
    from routers.portfolio_v2 import router
    app = FastAPI()
    app.include_router(router)
    return path, db, TestClient(app)


def statement(**changes):
    return {**{"account_id": "a", "as_of": "2026-01-03", "currency": "THB",
        "cash": "900", "market_value": "1000", "source_ref": "broker-statement-jan",
        "positions": [{"symbol": "PTT", "qty": "10", "cost_basis": "100", "market_price": "10"}]}, **changes}


def test_cited_statement_is_versioned_reconciled_and_never_posts_cash(book):
    path, _db, client = book
    with read_book(path) as conn:
        assert conn.execute("SELECT count(*) FROM broker_statements").fetchone()[0] == 0
    assert client.get("/api/v2/portfolio/ledger/check?codes=R3").json()["checks"][0]["status"] == "skipped"
    response = client.post("/api/v2/portfolio/ledger/statements", json=statement())
    assert response.status_code == 201, response.text
    first = response.json()["id"]
    assert response.json()["comparison"]["matched"] is True
    assert response.json()["comparison"]["market_value_checked_against_history"] is False
    assert response.json()["comparison"]["broker_source_verified"] is False
    assert client.post("/api/v2/portfolio/ledger/statements", json=statement()).status_code == 422
    revision = client.post("/api/v2/portfolio/ledger/statements",
        json=statement(cash="901", market_value="1001", supersedes_id=first))
    assert revision.status_code == 201, revision.text
    assert revision.json()["comparison"]["cash_difference"] == 1
    listed = client.get("/api/v2/portfolio/ledger/statements?account_id=a").json()
    assert listed["count"] == 1
    assert listed["statements"][0]["statement"]["supersedes_id"] == first
    report = client.get("/api/v2/portfolio/ledger/check?codes=R3").json()
    assert report["counts"]["warn"] == 1
    with read_book(path) as conn:
        assert conn.execute("SELECT count(*) FROM broker_statements").fetchone()[0] == 2
        assert conn.execute("SELECT count(*) FROM audit_events WHERE table_name='broker_statements'").fetchone()[0] == 2
        assert conn.execute("SELECT investment FROM cash_ledger WHERE id='dep'").fetchone()[0] == 1000
        assert conn.execute("SELECT count(*) FROM ledger_events").fetchone()[0] == 0


@pytest.mark.parametrize("change", [
    {"source_ref": ""}, {"currency": "USD"}, {"market_value": "999"},
    {"as_of": "2099-01-01"}, {"cash": "NaN"},
])
def test_statement_requires_real_source_and_consistent_amounts(book, change):
    path, _db, client = book
    assert client.post("/api/v2/portfolio/ledger/statements", json=statement(**change)).status_code == 422
    with read_book(path) as conn:
        assert conn.execute("SELECT count(*) FROM broker_statements").fetchone()[0] == 0


def test_statement_quantity_mismatch_is_recorded_as_evidence(book):
    _path, _db, client = book
    r = client.post("/api/v2/portfolio/ledger/statements", json=statement(
        positions=[{"symbol": "PTT", "qty": "9", "cost_basis": "90", "market_price": "10"}],
        market_value="990"))
    assert r.status_code == 201
    assert r.json()["comparison"]["O2"] is False
    assert r.json()["comparison"]["matched"] is False


def test_statement_reconcile_ignores_cash_edit_offsets(book):
    path, db, client = book
    with db.get_db() as conn:
        conn.execute("INSERT INTO cash_adjustments(id,account_id,date,amount,currency) VALUES ('offset','a','2026-01-03',500,'THB')")
    r = client.post("/api/v2/portfolio/ledger/statements", json=statement())
    assert r.status_code == 201
    assert r.json()["comparison"]["reconstructed_cash_before_offsets"] == 900
    assert r.json()["comparison"]["matched"] is True


def test_statement_table_is_registered_for_sync_and_audit(book):
    from sync.config import MONEY_TABLES, SYNC_TABLES
    assert "broker_statements" in MONEY_TABLES
    assert ("broker_statements", ["id"]) in SYNC_TABLES
    with sqlite3.connect(book[0]) as conn:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(broker_statements)")}
    assert {"source_ref", "supersedes_id", "updated_at"} <= cols


def test_cash_edit_category_is_visible_and_unknown_is_not_silent(book):
    path, db, client = book
    with db.get_db() as conn:
        conn.execute("INSERT INTO cash_adjustments(id,account_id,date,amount,currency,note) "
                     "VALUES ('old','a','2026-01-03',25,'THB','unexplained')")
    with read_book(path) as conn:
        assert conn.execute("SELECT category FROM cash_adjustments WHERE id='old'").fetchone()[0] == "UNKNOWN"
    audit = client.get("/api/v2/portfolio/ledger/check?codes=R1,R2").json()
    assert audit["counts"]["error"] == 0
    assert any(f["code"] == "R2_UNVERIFIED" for f in audit["findings"])
    with db.get_db() as conn:
        conn.execute("UPDATE cash_adjustments SET category='FEE' WHERE id='old'")
    audit = client.get("/api/v2/portfolio/ledger/check?codes=R1,R2").json()
    assert audit["counts"] == {"error": 0, "warn": 0, "info": 0}


def test_invalid_cash_edit_category_is_rejected_before_cash_is_read(book):
    _path, _db, client = book
    r = client.post("/api/v2/portfolio/cash/reconcile", json={"account_id": "a",
                    "actual_balance": 901, "category": "MADE_UP"})
    assert r.status_code == 422


def test_concurrent_device_statements_are_reported_as_conflict(book):
    _path, db, client = book
    assert client.post("/api/v2/portfolio/ledger/statements", json=statement()).status_code == 201
    with db.get_db() as conn:
        conn.execute("""INSERT INTO broker_statements
            (id,account_id,as_of,currency,cash,market_value,holdings_json,source_ref)
            VALUES ('peer','a','2026-01-03','THB','900','1000',
                    '[{"symbol":"PTT","qty":"10","cost_basis":"100","market_price":"10"}]','peer-file')""")
    report = client.get("/api/v2/portfolio/ledger/check?codes=R3").json()
    assert any(f["code"] == "R3_CONFLICT" for f in report["findings"])
    assert report["counts"]["error"] == 1


def test_account_delete_removes_its_statement_revision_chain(book):
    path, db, client = book
    first = client.post("/api/v2/portfolio/ledger/statements", json=statement()).json()["id"]
    assert client.post("/api/v2/portfolio/ledger/statements",
        json=statement(supersedes_id=first, source_ref="revised-broker-statement")).status_code == 201
    with db.get_db() as conn:
        conn.execute("DELETE FROM trades WHERE account_id='a'")
    response = client.delete("/api/v2/portfolio/accounts/a")
    assert response.status_code == 200, response.text
    with read_book(path) as conn:
        assert conn.execute("SELECT count(*) FROM broker_statements").fetchone()[0] == 0
