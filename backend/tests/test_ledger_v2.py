"""Ledger v2 (plans/port-ledger-v2.md): wallets, Decimal money, period close,
SHADOW projection of legacy writes, append-only sync.

The failure these guard against is the one the legacy book had: an edit to an
old row moving today's cash with nobody noticing, then an EDIT offset hiding it.
"""
import importlib
import sqlite3
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

TODAY = date.today().isoformat()
D1 = (date.today() - timedelta(days=40)).isoformat()
D2 = (date.today() - timedelta(days=30)).isoformat()
D3 = (date.today() - timedelta(days=20)).isoformat()


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "ledger_v2.db"))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema()
    db.init_alerts_schema(); db.init_sync_layer()
    import portfolio_currency
    importlib.reload(portfolio_currency)
    import ledger_backfill
    importlib.reload(ledger_backfill)
    import ledger
    importlib.reload(ledger)
    import routers.portfolio_v2 as pv2
    importlib.reload(pv2)
    with db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('dime','Dime','USD')")
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('fin','Finansia','THB')")
    return db, ledger, pv2


# ── numbers ──────────────────────────────────────────────────────────────────
def test_decimal_money_sums_exactly(env):
    db, L, _ = env
    with db.get_db() as c:
        for _ in range(10):
            L.post_cash(c, account_id="fin", type="DEPOSIT", amount="0.1", trade_date=D1, currency="THB")
        assert L.balance(c, "fin", "THB") == Decimal("1")
        assert c.execute("SELECT net_cash FROM ledger_events LIMIT 1").fetchone()[0] == "0.1"
    assert L.txt(Decimal("1.2300")) == "1.23" and L.txt(Decimal("-0")) == "0" and L.txt(1e-7) == "0.0000001"


def test_buy_cash_rounds_to_minor_unit_and_counts_fees(env):
    db, L, _ = env
    with db.get_db() as c:
        e = L.post_trade(c, account_id="dime", side="BUY", symbol="SNDK", qty="6.0552718",
                         price="1648.8074", trade_date=D1, currency="USD", fee="1.50", vat="0.11")
        # 6.0552718 × 1648.8074 = 9983.977… + 1.61 fees = 9985.587 → half-up
        assert e["net_cash"] == "-9985.59"
        assert e["wallet"] == "USD" and e["fee_basis"] == "POSTED"


# ── wallets and FX ───────────────────────────────────────────────────────────
def test_fx_convert_is_two_legs_and_reverses_together(env):
    db, L, _ = env
    with db.get_db() as c:
        L.set_wallet(c, "dime", "SAVE_THB", "THB", is_default=True)
        L.post_cash(c, account_id="dime", type="DEPOSIT", amount=100000, trade_date=D1, currency="THB")
        legs = L.post_fx_convert(c, account_id="dime", trade_date=D1, from_currency="THB",
                                 from_amount=100000, to_currency="USD", to_amount="3012.05",
                                 evidence_ref="dime-fx-slip")
        bal = {b["wallet"]: b["balance"] for b in L.balances(c, "dime")}
        assert bal == {"SAVE_THB": "0", "USD": "3012.05"}
        assert not [f for f in L.check(c, "dime")["findings"] if f["code"] == "L1_FX_UNPAIRED"]
        L.reverse(c, legs[1]["id"], "typed the wrong rate")
        bal = {b["wallet"]: b["balance"] for b in L.balances(c, "dime")}
        assert bal == {"SAVE_THB": "100000", "USD": "0"}


def test_wallet_currency_must_match(env):
    db, L, _ = env
    with db.get_db() as c:
        L.set_wallet(c, "dime", "FCD", "USD")
        with pytest.raises(L.LedgerError, match="holds USD"):
            L.post_cash(c, account_id="dime", type="DEPOSIT", amount=1, trade_date=D1,
                        currency="THB", wallet="FCD")


def test_negative_wallet_is_reported(env):
    db, L, _ = env
    with db.get_db() as c:
        L.post_cash(c, account_id="dime", type="DEPOSIT", amount=50000, trade_date=D1, currency="THB")
        L.post_trade(c, account_id="dime", side="BUY", symbol="MSFT", qty=2, price=400, trade_date=D2,
                     currency="USD")
        f = [f for f in L.check(c, "dime")["findings"] if f["code"] == "L2_NEGATIVE_WALLET"]
        assert f and f[0]["wallet"] == "USD" and f[0]["evidence"]["lowest"] == "-800"


# ── append-only + reversal ───────────────────────────────────────────────────
def test_posted_events_cannot_be_edited_or_deleted(env):
    db, L, _ = env
    with db.get_db() as c:
        e = L.post_cash(c, account_id="fin", type="DEPOSIT", amount=10, trade_date=D1, currency="THB")
    for sql in ("UPDATE ledger_events SET net_cash='99'", "DELETE FROM ledger_events"):
        with pytest.raises(sqlite3.IntegrityError, match="append-only"), db.get_db() as c:
            c.execute(sql)
    with db.get_db() as c:
        L.reverse(c, e["id"], "duplicate")
        with pytest.raises(L.LedgerError, match="already reversed"):
            L.reverse(c, e["id"], "again")
        rev = c.execute("SELECT id FROM ledger_events WHERE type='REVERSAL'").fetchone()[0]
        with pytest.raises(L.LedgerError, match="cannot be reversed"):
            L.reverse(c, rev, "undo the undo")


def test_adjust_needs_category_and_reason(env):
    db, L, _ = env
    with db.get_db() as c:
        with pytest.raises(L.LedgerError, match="category"):
            L.post_adjust(c, account_id="fin", trade_date=D1, currency="THB", amount=5, category="UNKNOWN",
                          note="x")
        with pytest.raises(L.LedgerError, match="reason"):
            L.post_adjust(c, account_id="fin", trade_date=D1, currency="THB", amount=5, category="DATA_FIX",
                          note=" ")
        with pytest.raises(L.LedgerError, match="statement"):
            L.post_opening(c, account_id="fin", trade_date=D1, currency="THB", amount=5, evidence_ref="")


def test_fee_trueup_posts_the_difference_once(env):
    db, L, _ = env
    with db.get_db() as c:
        e = L.post_trade(c, account_id="dime", side="SELL", symbol="V", qty=10, price=300, trade_date=D1,
                         currency="USD", fee="4.50", fee_basis="ESTIMATED")
        assert [f for f in L.check(c, "dime")["findings"] if f["code"] == "L4_FEE_ESTIMATED"]
        t = L.fee_trueup(c, e["id"], "4.62", evidence_ref="confirmation 123")
        assert t["net_cash"] == "-0.12"
        assert not [f for f in L.check(c, "dime")["findings"] if f["code"] == "L4_FEE_ESTIMATED"]
        with pytest.raises(L.LedgerError, match="already"):
            L.fee_trueup(c, e["id"], "4.70")


# ── period close ─────────────────────────────────────────────────────────────
def test_close_requires_exact_match_and_then_locks(env):
    db, L, _ = env
    with db.get_db() as c:
        L.post_cash(c, account_id="fin", type="DEPOSIT", amount="1000.00", trade_date=D1, currency="THB")
        with pytest.raises(L.CloseMismatch) as exc:
            L.close_period(c, account_id="fin", wallet="THB", as_of=D2, statement_balance="1000.01",
                           source_ref="statement Aug")
        assert exc.value.evidence["difference"] == "0.01"
        L.close_period(c, account_id="fin", wallet="THB", as_of=D2, statement_balance="1000",
                       source_ref="statement Aug")
        with pytest.raises(L.PeriodClosed):
            L.post_cash(c, account_id="fin", type="WITHDRAW", amount=1, trade_date=D1, currency="THB")
        # With a stated reason the correction lands today; the agreed day stays agreed.
        with L.correction("bank fee missed on the statement day"):
            e = L.post_cash(c, account_id="fin", type="FEE", amount=1, trade_date=D1, currency="THB")
        assert e["book_date"] == TODAY and e["trade_date"] == D1 and "correction" in e["note"]
        assert L.balance(c, "fin", "THB", D2) == Decimal("1000")
        assert L.balance(c, "fin", "THB") == Decimal("999")


def test_period_lock_is_enforced_by_the_database(env):
    db, L, _ = env
    with db.get_db() as c:
        L.post_cash(c, account_id="fin", type="DEPOSIT", amount=5, trade_date=D1, currency="THB")
        L.close_period(c, account_id="fin", wallet="THB", as_of=D2, statement_balance=5, source_ref="s")
    with pytest.raises(sqlite3.IntegrityError, match="LEDGER_PERIOD_CLOSED"), db.get_db() as c:
        c.execute("INSERT INTO ledger_events (id, account_id, wallet, trade_date, book_date, type, net_cash, "
                  "currency) VALUES ('x','fin','THB',?,?,'DEPOSIT','1','THB')", (D1, D1))
    with db.get_db() as c:
        L.reopen_period(c, account_id="fin", wallet="THB", reason="statement was revised")
        L.post_cash(c, account_id="fin", type="DEPOSIT", amount=1, trade_date=D1, currency="THB")


# ── SHADOW projection ────────────────────────────────────────────────────────
def _buy(pv2, **kw):
    body = dict(account_id="fin", symbol="PTT", date_entry=D1, price_entry=34.25, volume=1000,
                currency="THB", market="TH", fee_entry=0)
    body.update(kw)
    return pv2.create_trade(pv2.TradeIn(**body))


def test_shadow_projects_every_legacy_write_in_the_same_transaction(env):
    db, L, pv2 = env
    pv2.add_cash(pv2.CashIn(account_id="fin", date=D1, flow_type="DEPOSIT", amount=100000))
    with db.get_db() as c:
        out = L.set_mode(c, "fin", "SHADOW")
    assert out["projection"]["post"] == 1
    tid = _buy(pv2)["id"]
    with db.get_db() as c:
        assert L.balance(c, "fin", "THB") == Decimal("65750")
    # An edit is a reversal + a new event — the old one is still there.
    pv2.patch_trade(tid, pv2.TradePatch(price_entry=34.5))
    with db.get_db() as c:
        assert L.balance(c, "fin", "THB") == Decimal("65500")
        types = [r[0] for r in c.execute("SELECT type FROM ledger_events ORDER BY created_at")]
        assert types.count("REVERSAL") == 1 and types.count("BUY") == 2
        assert L.project(c, "fin", dry_run=True)["post"] == 0


def test_shadow_refuses_a_legacy_edit_into_a_closed_period(env):
    db, L, pv2 = env
    pv2.add_cash(pv2.CashIn(account_id="fin", date=D1, flow_type="DEPOSIT", amount=100000))
    with db.get_db() as c:
        L.set_mode(c, "fin", "SHADOW")
    tid = _buy(pv2)["id"]
    with db.get_db() as c:
        L.close_period(c, account_id="fin", wallet="THB", as_of=D2, statement_balance="65750",
                       source_ref="Finansia statement")
    with pytest.raises(L.PeriodClosed):
        pv2.patch_trade(tid, pv2.TradePatch(price_entry=34.5))
    with db.get_db() as c:  # rolled back — the legacy row did not move either
        assert c.execute("SELECT price_entry FROM trades WHERE id=?", (tid,)).fetchone()[0] == 34.25
    with L.correction("price typo, contract note says 34.50"):
        pv2.patch_trade(tid, pv2.TradePatch(price_entry=34.5))
    with db.get_db() as c:
        assert L.balance(c, "fin", "THB", D2) == Decimal("65750")  # the agreed day stays agreed
        assert L.balance(c, "fin", "THB") == Decimal("65500")
        booked = {r[0] for r in c.execute("SELECT book_date FROM ledger_events WHERE created_at > "
                                          "(SELECT MAX(created_at) FROM ledger_period_close)")}
        assert booked == {TODAY}


def test_writes_outside_get_db_show_up_as_pending(env):
    db, L, pv2 = env
    with db.get_db() as c:
        L.set_mode(c, "fin", "SHADOW")
    raw = db.connect()  # a script, not a request
    raw.execute("INSERT INTO cash_ledger (id, account_id, date, investment) VALUES ('s1','fin',?,500)", (D1,))
    raw.commit(); raw.close()
    with db.get_db() as c:
        f = [f for f in L.check(c, "fin")["findings"] if f["code"] == "L6_PROJECTION_PENDING"]
        assert f and "1 to post" in f[0]["message"]
        L.project(c, "fin")
        assert not [f for f in L.check(c, "fin")["findings"] if f["code"] == "L6_PROJECTION_PENDING"]


def test_manual_trade_posting_is_refused_in_shadow(env):
    db, L, _ = env
    with db.get_db() as c:
        L.set_mode(c, "fin", "SHADOW")
        with pytest.raises(L.LedgerError, match="SHADOW"):
            L.post_trade(c, account_id="fin", side="BUY", symbol="PTT", qty=1, price=1, trade_date=D1,
                         currency="THB")
        with pytest.raises(L.LedgerError, match="PRIMARY"):
            L.set_mode(c, "fin", "PRIMARY")


# ── HTTP: header → correction, errors → 409 ──────────────────────────────────
def test_http_correction_header_and_409(env):
    db, L, pv2 = env
    import routers.ledger as lr
    importlib.reload(lr)
    app = FastAPI()
    app.add_middleware(lr.LedgerCorrectionMiddleware)
    app.include_router(pv2.router)
    app.include_router(lr.router)
    app.add_exception_handler(L.LedgerError, lambda req, exc: JSONResponse(status_code=exc.status,
                                                                           content=exc.as_dict()))
    client = TestClient(app)
    pv2.add_cash(pv2.CashIn(account_id="fin", date=D1, flow_type="DEPOSIT", amount=100000))
    assert client.put("/api/v2/ledger/accounts/fin/mode", json={"mode": "SHADOW"}).status_code == 200
    tid = _buy(pv2)["id"]
    r = client.post("/api/v2/ledger/close", json={"account_id": "fin", "wallet": "THB", "as_of": D2,
                                                  "statement_balance": "65750", "source_ref": "stmt"})
    assert r.status_code == 201, r.text
    r = client.patch(f"/api/v2/portfolio/trades/{tid}", json={"price_entry": 34.5})
    assert r.status_code == 409 and r.json()["code"] == "LEDGER_PERIOD_CLOSED"
    r = client.patch(f"/api/v2/portfolio/trades/{tid}", json={"price_entry": 34.5},
                     headers={"X-Ledger-Correction": "%E0%B8%A3%E0%B8%B2%E0%B8%84%E0%B8%B2%E0%B8%9C%E0%B8%B4%E0%B8%94"})
    assert r.status_code == 200, r.text
    notes = [e["note"] for e in client.get("/api/v2/ledger/events?account_id=fin").json()["events"]]
    assert any("ราคาผิด" in n for n in notes)
    r = client.post("/api/v2/ledger/close", json={"account_id": "fin", "wallet": "THB", "as_of": D3,
                                                  "statement_balance": "1", "source_ref": "stmt"})
    assert r.status_code == 409 and r.json()["evidence"]["difference"] == "-65749"


# ── sync ─────────────────────────────────────────────────────────────────────
def test_snapshot_merge_is_a_union_for_append_only_tables():
    from sync.merge import merge_snapshots
    row = {"id": "e1", "net_cash": "10", "updated_at": "2026-09-01 00:00:00.000", "created_at": "a"}
    peer_same = dict(row, updated_at="2026-09-02 00:00:00.000", created_at="b")
    peer_diff = dict(row, net_cash="99", updated_at="2026-09-03 00:00:00.000")
    peer_new = {"id": "e2", "net_cash": "5", "updated_at": "2026-09-01 00:00:00.000"}
    snaps = [{"device": "me", "tables": {"ledger_events": [row]}, "tombstones": []},
             {"device": "a", "tables": {"ledger_events": [peer_same, peer_new]},
              "tombstones": [{"table_name": "ledger_events", "row_id": "e1", "deleted_at": "2027"}]},
             {"device": "b", "tables": {"ledger_events": [peer_diff]}, "tombstones": []}]
    tables, _, conflicts = merge_snapshots(snaps)
    got = {r["id"]: r["net_cash"] for r in tables["ledger_events"]}
    assert got == {"e1": "10", "e2": "5"}  # newer peer edit ignored, tombstone ignored
    assert [c["fields"] for c in conflicts] == [["__append_only__"]]


def test_restore_never_updates_an_append_only_row(env):
    db, L, _ = env
    from sync.restore import restore
    with db.get_db() as c:
        e = L.post_cash(c, account_id="fin", type="DEPOSIT", amount=10, trade_date=D1, currency="THB")
        row = dict(c.execute("SELECT * FROM ledger_events WHERE id=?", (e["id"],)).fetchone())
        new = dict(row, id="peer-1", created_at="2026-01-01 00:00:00.000")
        restore(c, {"ledger_events": [dict(row, net_cash="999", updated_at="2099-01-01"), new]},
                [{"table_name": "ledger_events", "row_id": e["id"], "deleted_at": "2099-01-01"}])
        assert c.execute("SELECT net_cash FROM ledger_events WHERE id=?", (e["id"],)).fetchone()[0] == "10"
        assert c.execute("SELECT COUNT(*) FROM ledger_events").fetchone()[0] == 2


# ── moving between wallets ───────────────────────────────────────────────────
def test_move_same_currency_is_a_transfer_pair(env):
    db, L, _ = env
    with db.get_db() as c:
        L.set_wallet(c, "dime", "USD", "USD", is_default=True)
        L.set_wallet(c, "dime", "FCD", "USD")
        L.post_cash(c, account_id="dime", type="DEPOSIT", amount="100", trade_date=D1, currency="USD")
        rows = L.move_between_wallets(c, account_id="dime", from_wallet="USD", to_wallet="fcd", amount="40.5",
                                      trade_date=D2)
        assert [r["type"] for r in rows] == ["TRANSFER_OUT", "TRANSFER_IN"]
        assert {b["wallet"]: b["balance"] for b in L.balances(c, "dime")} == {"FCD": "40.5", "USD": "59.5"}
        with pytest.raises(L.LedgerError, match="must equal"):
            L.move_between_wallets(c, account_id="dime", from_wallet="USD", to_wallet="FCD", amount=1,
                                   to_amount=2, trade_date=D2)
        L.reverse(c, rows[1]["id"], "wrong wallet")  # both legs go back
        assert {b["wallet"]: b["balance"] for b in L.balances(c, "dime")} == {"FCD": "0", "USD": "100"}


def test_move_across_currencies_needs_the_amount_that_arrived(env):
    db, L, _ = env
    with db.get_db() as c:
        L.set_wallet(c, "dime", "SAVE", "THB")
        L.set_wallet(c, "dime", "USD", "USD")
        L.post_cash(c, account_id="dime", type="DEPOSIT", amount=33550, trade_date=D1, currency="THB",
                    wallet="SAVE")
        with pytest.raises(L.LedgerError, match="conversion"):
            L.move_between_wallets(c, account_id="dime", from_wallet="SAVE", to_wallet="USD", amount=33550,
                                   trade_date=D2)
        rows = L.move_between_wallets(c, account_id="dime", from_wallet="SAVE", to_wallet="USD", amount=33550,
                                      to_amount=1000, trade_date=D2, evidence_ref="slip")
        assert [r["type"] for r in rows] == ["FX_CONVERT", "FX_CONVERT"]
        assert Decimal(rows[0]["fx_rate"]) * 33550 == Decimal(1000)  # the slip's rate, not a quote
        assert {b["wallet"]: b["balance"] for b in L.balances(c, "dime")} == {"SAVE": "0", "USD": "1000"}


# ── cutover: start from a statement, not from history ────────────────────────
def test_cutover_starts_from_opening_and_flags_later_history_edits(env):
    db, L, pv2 = env
    pv2.add_cash(pv2.CashIn(account_id="fin", date=D1, flow_type="DEPOSIT", amount=100000))
    tid = _buy(pv2)["id"]  # dated D1, before the cutover
    with db.get_db() as c:
        out = L.set_mode(c, "fin", "SHADOW", cutover_date=D2)
        assert out["projection"]["post"] == 0 and out["cutover"] == D2
        L.post_opening(c, account_id="fin", trade_date=D2, currency="THB", amount="65750",
                       evidence_ref="Finansia statement")
        L.close_period(c, account_id="fin", wallet="THB", as_of=D2, statement_balance="65750", source_ref="s")
        assert not [f for f in L.check(c, "fin")["findings"] if f["code"].startswith("L10")]
    # a trade after the cutover is projected; an edit of pre-cutover history is not, but is reported
    _buy(pv2, date_entry=D3, volume=100)
    pv2.patch_trade(tid, pv2.TradePatch(price_entry=34.5))
    with db.get_db() as c:
        assert L.balance(c, "fin", "THB") == Decimal("62325")
        f = [f for f in L.check(c, "fin")["findings"] if f["code"] == "L10_PRE_CUTOVER_CHANGE"]
        assert f and "1 edited" in f[0]["message"]


# ── routing: typed → slip → rule → default ───────────────────────────────────
def _dime_wallets(L, c):
    L.set_wallet(c, "dime", "USD", "USD", is_default=True, broker_label="Dime! USD")
    L.set_wallet(c, "dime", "FCD", "USD", broker_label="Dime! FCD")
    L.set_wallet(c, "dime", "SAVE", "THB", is_default=True, broker_label="Dime! Save")


def test_route_wallet_order(env):
    db, L, _ = env
    with db.get_db() as c:
        _dime_wallets(L, c)
        L.set_wallet_rule(c, "dime", "GC=F", "FCD", "Dime gold settles in FCD")
        assert L.entry_wallet(c, "dime", "USD", "GC=F") is None  # LEGACY account: nothing stored
        L.set_mode(c, "dime", "SHADOW", cutover_date=D1)
        assert L.route_wallet(c, "dime", "USD", symbol="GC=F")["wallet"] == "FCD"
        assert L.route_wallet(c, "dime", "USD", symbol="UNH")["wallet"] == "USD"
        assert L.route_wallet(c, "dime", "USD", symbol="UNH", broker_label="DIME! FCD")["wallet"] == "FCD"
        assert L.route_wallet(c, "dime", "USD", symbol="GC=F", wallet="usd")["reason"] == "chosen"
        # a label in the wrong currency is ignored rather than trusted
        assert L.route_wallet(c, "dime", "USD", symbol="UNH", broker_label="Dime! Save")["wallet"] == "USD"
        with pytest.raises(L.LedgerError, match="holds USD"):
            L.route_wallet(c, "dime", "THB", wallet="FCD")


def test_sell_lands_in_the_slips_wallet_and_can_be_moved(env, monkeypatch):
    db, L, pv2 = env
    monkeypatch.setattr(pv2, "_capture_thb_rate", lambda ccy, day, given=None, conn=None: given or 33.5)
    with db.get_db() as c:
        _dime_wallets(L, c)
        L.set_mode(c, "dime", "SHADOW", cutover_date=D1)
        L.post_opening(c, account_id="dime", trade_date=D1, currency="USD", wallet="USD", amount="5000",
                       evidence_ref="app")
    tid = pv2.create_trade(pv2.TradeIn(account_id="dime", symbol="UNH", date_entry=D2, price_entry=400,
                                       volume=5, currency="USD", market="US", fee_entry=0,
                                       exchange_rate=33.5, exit_exchange_rate=33.5))["id"]
    pv2.sell_position(pv2.SellIn(trade_id=tid, sell_volume=0, sell_price=410, sell_date=D3, commission=0,
                                 settlement_label="DIME! FCD"))
    with db.get_db() as c:
        assert c.execute("SELECT wallet_entry, wallet_exit FROM trades WHERE id=?", (tid,)).fetchone()[:] == \
            ("USD", "FCD")
        assert {b["wallet"]: b["balance"] for b in L.balances(c, "dime")} == {"FCD": "2050", "USD": "3000"}
    # wrong wallet typed at sale → fixed by editing the trade; the journal reverses and re-posts
    pv2.patch_trade(tid, pv2.TradePatch(wallet_exit="USD"))
    with db.get_db() as c:
        assert {b["wallet"]: b["balance"] for b in L.balances(c, "dime")} == {"FCD": "0", "USD": "5050"}
    with pytest.raises(L.LedgerError):
        pv2.patch_trade(tid, pv2.TradePatch(wallet_exit="SAVE"))  # THB wallet for a USD sale


def test_deposit_goes_to_the_chosen_thb_wallet(env):
    db, L, pv2 = env
    with db.get_db() as c:
        _dime_wallets(L, c)
        L.set_wallet(c, "dime", "BANK", "THB")
        L.set_mode(c, "dime", "SHADOW", cutover_date=D1)
    pv2.add_cash(pv2.CashIn(account_id="dime", date=D2, flow_type="DEPOSIT", amount=1000, wallet="BANK"))
    pv2.add_cash(pv2.CashIn(account_id="dime", date=D2, flow_type="DEPOSIT", amount=500))
    with db.get_db() as c:
        assert {b["wallet"]: b["balance"] for b in L.balances(c, "dime")} == {"BANK": "1000", "SAVE": "500"}


def test_cutover_is_a_moment_not_a_day(env):
    """Dime 2026-09-30: the app snapshot was 00:54 Bangkok; buys filled at 01:46
    still carry the US trade date of the cutover day. They are not in the
    OPENING balance, so they must be posted — on the day after, leaving the
    close agreed with the snapshot untouched."""
    db, L, pv2 = env
    with db.get_db() as c:
        L.set_wallet(c, "dime", "USD", "USD", is_default=True)
        L.set_mode(c, "dime", "SHADOW", cutover_date=D2, cutover_moment=f"{D2}T00:54+07:00")
        L.post_opening(c, account_id="dime", trade_date=D2, currency="USD", wallet="USD", amount="10000",
                       evidence_ref="app 00:54")
        L.close_period(c, account_id="dime", wallet="USD", as_of=D2, statement_balance="10000", source_ref="app")
    # filled 01:46 Bangkok, US date = cutover day
    pv2.create_trade(pv2.TradeIn(account_id="dime", symbol="SNDK", date_entry=D2, price_entry=1000, volume=2,
                                 currency="USD", market="US", fee_entry=0, exchange_rate=33.5,
                                 executed_at=f"{D2}T01:46+07:00"))
    # filled 00:37 Bangkok (before the snapshot) but typed in afterwards: in the opening already
    pv2.create_trade(pv2.TradeIn(account_id="dime", symbol="V", date_entry=D2, price_entry=100, volume=1,
                                 currency="USD", market="US", fee_entry=0, exchange_rate=33.5,
                                 executed_at=f"{D2}T00:37+07:00"))
    with db.get_db() as c:
        assert L.balance(c, "dime", "USD", D2) == Decimal("10000")        # the close holds
        assert L.balance(c, "dime", "USD") == Decimal("8000")             # SNDK posted, V not
        buy = c.execute("SELECT trade_date, book_date FROM ledger_events WHERE type='BUY'").fetchall()
        assert [tuple(r) for r in buy] == [(D2, (date.fromisoformat(D2) + timedelta(days=1)).isoformat())]
        # V was already in the snapshot but typed afterwards: flagged for a look, not posted
        l10 = [f for f in L.check(c, "dime")["findings"] if f["code"] == "L10_PRE_CUTOVER_CHANGE"]
        assert l10 and "1 new" in l10[0]["message"]
