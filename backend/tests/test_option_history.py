"""
Historical option round trips booked from transcribed broker slips, and the
accounting of option fees they exposed:

* realized P&L of a match carries its share of BOTH legs' fees (the opening
  fee used to be left out for good);
* a close whose price is unknown is not a sale at 0 in the ledger;
* option_trades.fees equals its fee items (check F1);
* the cash offset absorbs the booked P&L, so today's cash does not move.
"""
import hashlib
import importlib
import json

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
    import portfolio_currency
    importlib.reload(portfolio_currency)
    import ledger_backfill as lb
    importlib.reload(lb)
    import option_history as oh
    importlib.reload(oh)
    import accounting_checks as ac
    importlib.reload(ac)
    with db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('dime','Dime','USD')")
    return db, lb, oh, ac


def _fees(comm, occ, orf, taf=None):
    items = [["COMMISSION", comm], ["COMMISSION_DISCOUNT", "-" + comm], ["OCC", occ], ["ORF", orf]]
    if taf:
        items.append(["TAF", taf])
    return {"source": "SLIP", "items": items}


def _fill(key, action, side, n, price, day, at, fees, reason=None, expiry="2026-01-30", strike=40):
    return {"key": key, "excel_ref": "Dime!1", "action": action, "side": side, "contracts": n,
            "price": price, "trade_date": day, "executed_at": at, "submitted_at": at,
            "settle_date": None, "order_ref": None, "close_reason": reason, "fees": fees,
            "images": ["slip.webp"], "note": "",
            "contract": {"underlying": "INTC", "expiry": expiry, "strike": strike, "option_type": "put"}}


@pytest.fixture()
def manifest(tmp_path):
    img = tmp_path / "slip.webp"
    img.write_bytes(b"RIFF-test-slip")
    data = {
        "account_id": "dime", "broker": "Dime", "currency": "USD", "display_timezone": "Asia/Bangkok",
        "images": {"slip.webp": hashlib.sha256(img.read_bytes()).hexdigest()},
        "fills": [
            _fill("a-open", "OPEN", "BUY", 4, "0.24", "2026-01-26", "2026-01-26T21:39:00+07:00",
                  _fees("2.20", "0.08", "0.02")),
            _fill("a-close", "CLOSE", "SELL", 4, "0.37", "2026-01-26", "2026-01-26T22:43:00+07:00",
                  _fees("2.20", "0.08", "0.02", "0.02"), "TRADE"),
            _fill("b-open", "OPEN", "BUY", 2, "0.29", "2026-01-29", "2026-01-29T23:07:00+07:00",
                  _fees("1.10", "0.04", "0.01"), expiry="2026-02-06", strike=42.5),
            _fill("b-close", "CLOSE", "SELL", 2, "0", "2026-02-06", None,
                  {"source": "SLIP", "items": []}, "EXPIRED", expiry="2026-02-06", strike=42.5),
        ],
        "matches": [["a-close", "a-open", 4], ["b-close", "b-open", 2]],
    }
    path = tmp_path / "m.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def test_match_realized_charges_both_legs_pro_rata():
    from portfolio_options import match_realized
    # 3 of an opening fill of 10 (fees 1.00) closed by a sale of 3 (fees 0.30)
    realized, fees = match_realized(1, 0.50, 0.60, 3, 100, 1.00, 10, 0.30, 3)
    assert fees == pytest.approx(0.30 + 0.30)
    assert realized == pytest.approx(30 - 0.60)
    assert match_realized(1, 0.5, None, 3, 100, 1.0, 10, 0.3, 3)[0] is None


def test_prepare_books_fees_and_realized(env, manifest):
    db, lb, oh, ac = env
    plan = oh.prepare(manifest)
    pnl = {m["open_key"]: m["realized_pnl"] for m in plan["matches"]}
    assert pnl["a-open"] == pytest.approx(52 - 0.10 - 0.12)       # 0.13 x 400 − both legs
    assert pnl["b-open"] == pytest.approx(-58 - 0.05)             # expired worthless
    assert plan["cash_offset"]["amount"] == pytest.approx(-(51.78 - 58.05))
    by_key = {f["key"]: f for f in plan["fills"]}
    assert by_key["a-close"]["fees"] == pytest.approx(0.12)
    assert by_key["a-open"]["occ_symbol"] == "INTC  260130P00040000"
    # the expiry has no fill time, so it is no broker execution
    assert len(plan["evidence"]) == 3


def test_apply_is_idempotent_and_keeps_cash(env, manifest):
    db, lb, oh, ac = env
    plan = oh.prepare(manifest)
    with db.get_db() as conn:
        r1 = oh.apply(conn, plan)
    with db.get_db() as conn:
        r2 = oh.apply(conn, plan)
        realized = conn.execute("SELECT SUM(realized_pnl) FROM option_trade_matches").fetchone()[0]
        offset = conn.execute("SELECT SUM(amount) FROM cash_adjustments WHERE category='DATA_FIX'").fetchone()[0]
        ev = conn.execute("SELECT instrument_type, occ_fee, orf_fee, option_trade_id FROM broker_executions").fetchall()
        exp = conn.execute("SELECT close_reason, price FROM option_trades WHERE action='CLOSE' "
                           "AND close_reason='EXPIRED'").fetchone()
    assert r1["inserted"] == 4 and r2["inserted"] == 0 and not any(r2["amended"].values())
    assert realized + offset == pytest.approx(0, abs=0.005)
    assert {r[0] for r in ev} == {"OPTION"} and all(r[3] for r in ev)
    assert tuple(exp) == ("EXPIRED", 0)


def test_apply_refuses_a_fill_already_booked_by_hand(env, manifest):
    db, lb, oh, ac = env
    plan = oh.prepare(manifest)
    f = plan["fills"][0]
    with db.get_db() as conn:
        conn.execute("INSERT INTO option_contracts (contract_id, occ_symbol, underlying, expiry, strike, option_type) "
                     "VALUES ('c','INTC  260130P00040000','INTC','2026-01-30',40,'put')")
        conn.execute("INSERT INTO option_trades (trade_id, contract_id, account_id, trade_date, action, side, "
                     "quantity, price) VALUES ('hand','c','dime',?, 'OPEN','BUY',?,?)",
                     (f["trade_date"], f["quantity"], f["price"]))
    with db.get_db() as conn, pytest.raises(ValueError, match="other ids"):
        oh.apply(conn, plan)


def test_fee_check_holds_fees_to_their_items(env, manifest):
    db, lb, oh, ac = env
    with db.get_db() as conn:
        oh.apply(conn, oh.prepare(manifest))
    with db.get_db() as conn:
        assert not [f for f in ac.run(conn, codes=["F1"])["findings"]]
        conn.execute("UPDATE option_trades SET fees = 9 WHERE action='OPEN' AND quantity=4")
        found = ac.run(conn, codes=["F1"])["findings"]
    assert [f["code"] for f in found] == ["F1"]


def test_posted_fee_supersedes_estimate(env, manifest):
    db, lb, oh, ac = env
    with db.get_db() as conn:
        oh.apply(conn, oh.prepare(manifest))
        tid = conn.execute("SELECT trade_id FROM option_trades WHERE action='OPEN' AND quantity=4").fetchone()[0]
        conn.execute("""INSERT INTO trade_fee_items (id, account_id, trade_table, trade_id, leg, component,
                        amount, currency, basis, source) VALUES
                        ('p','dime','option_trades',?,'FILL','ORF','0.04','USD','POSTED','BROKER_POSTING')""", (tid,))
        found = ac.run(conn, codes=["F1"])["findings"]
        assert found and found[0]["evidence"]["items_total"] == "0.12"
        conn.execute("UPDATE option_trades SET fees = 0.12 WHERE trade_id=?", (tid,))
        assert not ac.run(conn, codes=["F1"])["findings"]


def test_unknown_close_price_is_not_a_sale_at_zero(env, manifest):
    db, lb, oh, ac = env
    with db.get_db() as conn:
        oh.apply(conn, oh.prepare(manifest))
        conn.execute("INSERT INTO option_trades (trade_id, contract_id, account_id, trade_date, action, side, "
                     "quantity, price, close_reason) SELECT 'u', contract_id, 'dime', '2026-02-01', 'CLOSE', "
                     "'SELL', 1, NULL, 'UNKNOWN' FROM option_contracts LIMIT 1")
        rep = lb.report(conn)
    assert "B_OPTION_PRICE" in {i.code for i in rep["issues"]}
    opt = [e for e in rep["events"] if e.note.startswith("option")]
    assert len(opt) == 4
    expired = [e for e in opt if e.type == "SELL" and e.price == 0]
    assert expired and expired[0].net_cash == 0
    # fill time orders the day: stored as UTC, comparable with created_at
    assert min(e.trade_time for e in opt) == "2026-01-26 14:39:00"


def test_stock_evidence_match_ignores_option_slips(env, manifest):
    db, lb, oh, ac = env
    import evidence_match
    importlib.reload(evidence_match)
    with db.get_db() as conn:
        oh.apply(conn, oh.prepare(manifest))
        assert evidence_match._load_fills(conn) == []


def test_corrected_manifest_amends_instead_of_booking_twice(env, manifest):
    db, lb, oh, ac = env
    with db.get_db() as conn:
        oh.apply(conn, oh.prepare(manifest))
    data = json.loads(manifest.read_text(encoding="utf-8"))
    data["fills"][1]["fees"]["items"].append(["OTHER", "0.50"])       # a fee the first slip missed
    data["fills"][1]["order_ref"] = "OPTSLO1"
    manifest.write_text(json.dumps(data), encoding="utf-8")
    plan = oh.prepare(manifest)
    with db.get_db() as conn:
        result = oh.apply(conn, plan)
        assert result["amended"]["fills"] == 1 and result["amended"]["matches"] == 1
        offsets = conn.execute("SELECT amount FROM cash_adjustments WHERE category='DATA_FIX'").fetchall()
        realized = conn.execute("SELECT SUM(realized_pnl) FROM option_trade_matches").fetchone()[0]
        assert len(offsets) == 1 and offsets[0][0] + realized == pytest.approx(0, abs=0.005)
        assert not ac.run(conn, codes=["F1"])["findings"]
        assert oh.apply(conn, plan)["amended"] == {"fills": 0, "fee_items": 0, "evidence": 0,
                                                     "matches": 0, "cash_offset": 0}
