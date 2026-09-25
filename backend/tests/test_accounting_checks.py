import importlib
import json
import sqlite3

import pytest

import accounting_checks as ac
from accounting_io import backup_book, read_book


@pytest.fixture()
def book(tmp_path, monkeypatch):
    path = tmp_path / "book.db"
    monkeypatch.setenv("PORTFOLIO_DB", str(path))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db()
    db.init_portfolio_v2()
    with db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts(id,name,currency) VALUES ('a','A','THB'),('b','B','THB')")
        conn.execute("INSERT INTO cash_ledger(id,account_id,date,investment) VALUES ('dep','a','2026-01-01',1000)")
        conn.execute("INSERT INTO trades(id,account_id,symbol,date_entry,price_entry,volume,currency,win_loss) VALUES ('buy','a','PTT','2026-01-02',10,10,'THB','P')")
    def no_market(*args, **kwargs):
        raise AssertionError("local audit must not fetch market data")
    monkeypatch.setattr(ac.dividend_check, "_market_dividends", no_market)
    return path, db


def run(book, codes=None, **kwargs):
    with read_book(book[0]) as conn:
        return ac.run(conn, codes=codes, today="2026-09-25", **kwargs)


def codes(report):
    return {f["code"] for f in report["findings"]}


def test_clean_local_book_and_explicit_unchecked_external_checks(book):
    report = run(book)
    assert report["counts"] == {"error": 0, "warn": 0, "info": 0}
    status = {c["code"]: c["status"] for c in report["checks"]}
    assert status["C1"] == status["N1"] == "skipped"
    assert status["D1"] == "partial"
    assert report["ready_for_read_switch"] is False
    assert report["source"] == "reconstructed"
    gates = {g["id"]: g for g in report["read_switch_gates"]}
    assert gates["posted_journal"]["status"] == "blocked"
    assert gates["broker_statements"]["missing_account_ids"] == ["a", "b"]


def test_check_filter_cannot_hide_read_switch_requirements(book):
    report = run(book, ["I2"], account_id="a")
    assert report["counts"]["error"] == 0
    assert report["ready_for_read_switch"] is False
    gates = {g["id"]: g for g in report["read_switch_gates"]}
    assert gates["broker_statements"]["missing_account_ids"] == ["a"]
    assert gates["shadow_comparison"]["status"] == "pending"


def test_duplicate_withdrawal_detected_despite_cash_offset(book):
    with book[1].get_db() as conn:
        conn.execute("INSERT INTO cash_ledger(id,account_id,date,investment) VALUES ('wa','a','2026-03-27',-67100),('wb','b','2026-03-27',-67100)")
        conn.execute("INSERT INTO cash_adjustments(id,account_id,date,amount,currency,target_balance,derived_before) VALUES ('offset','b','2026-09-25',67100,'THB',0,-67100)")
    report = run(book, ["H1", "H2"])
    assert "H1_DUPLICATE_WITHDRAW" in codes(report)
    assert "H2" in codes(report)
    assert {f["account_id"] for f in report["findings"] if f["code"] == "H1_DUPLICATE_WITHDRAW"} == {"a", "b"}
    assert all(f["evidence"]["first_negative_date"] == "2026-03-27"
               for f in report["findings"] if f["code"] == "H2")
    assert all("not a broker overdraft claim" in f["evidence"]["basis"]
               for f in report["findings"] if f["code"] == "H2")


def test_duplicate_trade_and_invalid_dates(book):
    with book[1].get_db() as conn:
        conn.execute("INSERT INTO trades(id,account_id,symbol,date_entry,price_entry,volume,currency,win_loss) VALUES ('dup','a','PTT','2026-01-02',10,10,'THB','P')")
        conn.execute("INSERT INTO trades(id,account_id,symbol,date_entry,date_exit,price_entry,price_exit,volume,currency,win_loss,pnl_amount) VALUES ('bad','a','BAD','2026-01-02','2026-01-01',10,9,1,'THB','W',-1)")
        conn.execute("INSERT INTO cash_ledger(id,account_id,date,investment) VALUES ('future','a','2027-01-01',1)")
    assert {"H1_DUPLICATE", "H1_EXIT_BEFORE_ENTRY", "H1_PNL_SIGN", "H1_FUTURE"} <= codes(run(book, ["H1"]))


def test_opposite_cash_rows_reported_for_both_accounts_then_linked_pair_passes(book):
    with book[1].get_db() as conn:
        conn.execute("INSERT INTO cash_ledger(id,account_id,date,investment) VALUES ('out','a','2026-03-01',-100),('in','b','2026-03-01',100)")
    assert "H3" in codes(run(book, ["H3"], account_id="b"))
    with book[1].get_db() as conn:
        conn.execute("UPDATE cash_ledger SET entry_type='TRANSFER',linked_id='link' WHERE id IN ('out','in')")
    assert run(book, ["H3", "I5"])["counts"]["warn"] == 0
    with book[1].get_db() as conn:
        conn.execute("DELETE FROM cash_ledger WHERE id='in'")
    assert "I5" in codes(run(book, ["I5"]))


def test_account_filter_and_unknown_codes(book):
    assert run(book, ["H2"], account_id="b")["events"] == 0
    with pytest.raises(ValueError, match="Unknown accounting"):
        run(book, ["TYPO"])
    with pytest.raises(ValueError, match="Unknown account"):
        run(book, account_id="missing")


def test_missing_fx_is_reported_not_zero_cash(book):
    with book[1].get_db() as conn:
        conn.execute("UPDATE trades SET currency='USD',exchange_rate=NULL WHERE id='buy'")
    assert "H2_MISSING_FX" in codes(run(book, ["H2"]))


def test_dividend_on_ex_date_purchase_has_no_entitlement(book):
    with book[1].get_db() as conn:
        conn.execute("INSERT INTO dividends(id,account_id,asset,ex_date,pay_date,amount_per_unit,total_received,currency) VALUES ('d','a','PTT','2026-01-02','2026-01-10',1,10,'THB')")
    assert "D1_NOT_HELD" in codes(run(book, ["D1"]))


def test_stock_card_is_preview_and_does_not_post(book):
    with read_book(book[0]) as conn:
        result = ac.stock_card(conn, "a", "PTT", "FIFO")
        assert result["remaining_cost"] == 100
        assert result["source"] == "reconstructed"
        assert conn.execute("SELECT COUNT(*) FROM ledger_events").fetchone()[0] == 0
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            conn.execute("DELETE FROM trades")


def samples():
    s = {"account": {"id": "a"}, "total_invested_base": 1000, "total_dividends_base": 0,
         "pnl_base": 0, "open_cost_base": 100, "cash_base": 900, "cash_adjustment_base": 0}
    r = {"net_deposited": 1000, "realized": 0, "dividends": 0, "nav_now": 1000}
    h = {"snapshot_date": "2026-09-25", "invested_capital": 1000, "dividends": 0,
         "realized_pnl": 0, "open_cost_basis": 100, "cash_balance": 900, "nav_with_cash": 1000}
    return {"summary": {"base_currency": "THB", "accounts": [s], "total_pnl_base": 0,
                        "total_open_cost_base": 100, "total_cash_base": 900, "total_cash_adjustment_base": 0},
            "returns": {"base_currency": "THB", "accounts": {"a": r}, "total": r},
            "histories": {"a": [h], "all": [h]}}


def test_cross_endpoint_agrees_then_detects_frozen_realized(book):
    data = samples()
    good = run(book, ["C1"], endpoint_samples=data)
    assert good["checks"][0]["evaluated"] == 22
    assert good["counts"]["error"] == 0
    data["histories"]["a"][0]["realized_pnl"] = 200
    bad = run(book, ["C1"], endpoint_samples=data)
    assert bad["counts"]["error"] == 2
    assert all(f["evidence"]["difference"] == -200 for f in bad["findings"])


def test_missing_endpoint_sample_never_passes(book):
    data = samples()
    data["histories"]["a"] = []
    assert "C1_MISSING" in codes(run(book, ["C1"], endpoint_samples=data))


@pytest.mark.parametrize("rebuilt,failed", [(100.5, False), (102, True)])
def test_nav_validation_uses_one_percent_threshold(book, rebuilt, failed):
    result = run(book, ["N1"], nav_validation=[{"account_id": "a", "rebuilt": rebuilt, "live": 100, "source": "live"}])
    assert ("N1" in codes(result)) is failed


def test_nav_validation_never_validates_against_its_own_backfill(book):
    from scripts.backfill_nav import live_nav_rows
    rows = [{"snapshot_date": "2026-01-01", "source": "backfill"},
            {"snapshot_date": "2026-07-01", "source": "live"}]
    assert list(live_nav_rows(rows)) == ["2026-07-01"]
    fake = [{"account_id": "a", "rebuilt": 100, "live": 100, "source": "backfill"}]
    assert "N1_MISSING" in codes(run(book, ["N1"], nav_validation=fake))
    assert "N1_MISSING" in codes(run(book, ["N1"], nav_validation=[]))


def test_wal_backup_preserves_uncheckpointed_committed_rows(tmp_path):
    path = tmp_path / "wal.db"
    with sqlite3.connect(path) as live:
        live.execute("PRAGMA journal_mode=WAL")
        live.execute("PRAGMA wal_autocheckpoint=0")
        live.execute("CREATE TABLE example(value)")
        live.execute("INSERT INTO example VALUES (123)")
        live.commit()
        backup = backup_book(path)
        with read_book(backup) as copied:
            assert copied.execute("SELECT value FROM example").fetchone()[0] == 123
            assert copied.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_apply_refuses_failed_audit_and_leaves_no_partial_events(book):
    from scripts.backfill_ledger import apply_reviewed_book
    with book[1].get_db() as conn:
        conn.execute("DELETE FROM cash_ledger")
    with pytest.raises(ValueError, match="Apply blocked"):
        apply_reviewed_book(book[0], accept_warnings=True)
    with read_book(book[0]) as conn:
        assert conn.execute("SELECT COUNT(*) FROM ledger_events").fetchone()[0] == 0
    assert len(list((book[0].parent / "backups").glob("*.db"))) == 1


def test_apply_validated_book_is_idempotent(book):
    from scripts.backfill_ledger import apply_reviewed_book
    assert apply_reviewed_book(book[0])["inserted"] == 2
    assert apply_reviewed_book(book[0])["inserted"] == 0


def test_posted_backfill_cannot_silently_diverge_after_legacy_edit(book):
    from scripts.backfill_ledger import apply_reviewed_book
    import ledger_backfill
    apply_reviewed_book(book[0])
    with book[1].get_db() as conn:
        conn.execute("UPDATE trades SET price_entry=11 WHERE id='buy'")
    with book[1].get_db() as conn:
        with pytest.raises(ValueError, match="reviewed reversal"):
            ledger_backfill.apply(conn, ledger_backfill.build_events(conn)[0])
        assert conn.execute("SELECT gross FROM ledger_events WHERE type='BUY'").fetchone()[0] == 100


def test_cli_exit_code_and_json(book, capsys):
    from scripts.accounting_audit import main
    assert main(["--db", str(book[0]), "--codes", "H2", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["counts"]["error"] == 0
    with book[1].get_db() as conn:
        conn.execute("DELETE FROM cash_ledger")
    assert main(["--db", str(book[0]), "--codes", "H2", "--json"]) == 1
    assert json.loads(capsys.readouterr().out)["counts"]["error"] == 1


def test_http_endpoints_return_preview_and_validate_parameters(book):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers.portfolio_v2 import router
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    response = client.get("/api/v2/portfolio/ledger/check", params={"account_id": "a", "codes": "H1,H2"})
    assert response.status_code == 200
    assert response.json()["counts"]["error"] == 0
    response = client.get("/api/v2/portfolio/ledger/stock-card", params={"account_id": "a", "symbol": "PTT", "method": "FIFO"})
    assert response.status_code == 200
    assert response.json()["remaining_qty"] == 10
    assert client.get("/api/v2/portfolio/ledger/check?codes=TYPO").status_code == 422
    assert client.get("/api/v2/portfolio/ledger/stock-card?account_id=a&symbol=PTT&method=INVALID").status_code == 422
    dividend = client.post("/api/v2/portfolio/ledger/prepare-dividend", json={"account_id": "a", "symbol": "PTT", "ex_date": "2026-02-01", "amount_per_unit": 1, "tax_rate": .1})
    assert dividend.status_code == 200
    assert dividend.json()["entitlements"][0]["total_received"] == 9
    opening = client.post("/api/v2/portfolio/ledger/check-opening", json={"account_id": "a", "as_of": "2026-02-01", "cash": 900, "market_value": 1050, "positions": [{"symbol": "PTT", "qty": 10, "market_price": 15, "cost_basis": 100}]})
    assert opening.status_code == 200
    assert opening.json()["O1"] is True and opening.json()["O2"] is True
    with read_book(book[0]) as conn:
        assert conn.execute("SELECT COUNT(*) FROM ledger_events").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM dividends").fetchone()[0] == 0
