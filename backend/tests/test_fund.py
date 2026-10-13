"""Fund book (fund.py + routers/fund.py) — plans/fund-book.md, Step 1.

The worked example is the one the design was argued with: A puts in 100,000,
the fund grows to 150,000, B puts in 150,000. By capital they stand 40/60, by
units 50/50 — the system keeps both and says which is which.
"""
import importlib
import sqlite3
from datetime import date, timedelta

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

TODAY = date.today().isoformat()


@pytest.fixture()
def fx(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "fund.db"))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema(); db.init_fund_schema()
    db.init_alerts_schema(); db.init_sync_layer()
    import portfolio_currency
    importlib.reload(portfolio_currency)
    monkeypatch.setattr(portfolio_currency, "live_usd_thb", lambda: 35.0)
    monkeypatch.setattr(portfolio_currency, "_ensure_history_once", lambda conn=None: None)
    import portfolio_options
    importlib.reload(portfolio_options)
    import routers.portfolio_v2 as pv2
    importlib.reload(pv2)
    import fund as core
    importlib.reload(core)
    import routers.fund as api
    importlib.reload(api)
    prices: dict[str, float] = {}
    monkeypatch.setattr(pv2, "_get_thb_per_usd", lambda: 35.0)
    monkeypatch.setattr(pv2, "_batch_fetch_prices",
                        lambda syms: {s: {"price": prices[s]} for s in syms if s in prices})
    with db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('mine', 'MINE', 'THB')")
        conn.execute("INSERT INTO cash_ledger (id, account_id, date, investment) VALUES ('c0', 'mine', '2026-01-01', 5000)")
    fund = api.create_fund(api.FundIn(name="Kongsi"))
    fid = fund["id"]
    api.add_account(fid, api.AccountIn(id="kongsi-th", name="Kongsi TH", currency="THB"))
    a = api.add_member(fid, api.MemberIn(name="A"))
    b = api.add_member(fid, api.MemberIn(name="B"))

    class Ctx:
        pass
    c = Ctx()
    c.db, c.pv2, c.core, c.api, c.fid, c.a, c.b, c.prices = db, pv2, core, api, fid, a["id"], b["id"], prices
    return c


def _deposit(c, member, amount, **kw):
    return c.api.add_contribution(c.fid, c.api.ContributionIn(
        member_id=member, account_id=kw.pop("account_id", "kongsi-th"), date=kw.pop("date", TODAY),
        amount=str(amount), **kw))


def _buy(c, symbol, volume, price, account="kongsi-th"):
    with c.db.get_db() as conn:
        conn.execute(
            "INSERT INTO trades (id, account_id, symbol, resolved_symbol, market, currency, date_entry, "
            "price_entry, volume, amount, win_loss, exchange_rate) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (f"t-{symbol}", account, symbol, symbol, "TH", "THB", TODAY, price, volume, price * volume, "P", 1.0))


def _code(exc_info):
    return exc_info.value.detail["code"]


def _two_members(c):
    _deposit(c, c.a, 100000)
    _buy(c, "ETF.BK", 10000, 10)          # all 100,000 goes into one holding
    c.prices["ETF.BK"] = 15.0             # ... which is now worth 150,000
    _deposit(c, c.b, 150000)


# ── the first deposit ────────────────────────────────────────────────────────

def test_the_first_deposit_buys_units_at_par_and_reaches_the_cash_book_once(fx):
    row = _deposit(fx, fx.a, "100,000", evidence_ref="slip-001")
    assert (row["unit_price"], row["units_issued"], row["price_source"]) == ("10", "10000.000000", "par")
    assert row["amount_base"] == "100000.00" and row["entered_by"] == "user" and row["evidence_ref"] == "slip-001"
    with fx.db.get_db() as conn:
        cash = [dict(r) for r in conn.execute("SELECT * FROM cash_ledger WHERE account_id = 'kongsi-th'")]
    assert len(cash) == 1 and cash[0]["id"] == row["cash_ledger_id"] and cash[0]["investment"] == 100000
    nav = fx.api.get_nav(fx.fid)
    assert (nav["nav"], nav["cash"], nav["unit_price"], nav["units"]) == ("100000.00", "100000.0", "10.000000", "10000.000000") \
        or (float(nav["nav"]), float(nav["unit_price"])) == (100000.0, 10.0)


def test_a_deposit_never_touches_the_personal_book(fx):
    before = fx.pv2.get_summary(base_currency="THB")
    _two_members(fx)
    after = fx.pv2.get_summary(base_currency="THB")
    assert after == before
    assert [a["account"]["id"] for a in after["accounts"]] == ["mine"]


# ── two members, two measures ────────────────────────────────────────────────

def test_capital_says_40_60_and_units_say_50_50(fx):
    _two_members(fx)
    view = fx.api.list_members(fx.fid)
    a, b = view["members"]
    assert view["split_basis"] == "CAPITAL"
    assert (a["capital"], b["capital"]) == ("100000.00", "150000.00")
    assert (a["capital_share_pct"], b["capital_share_pct"]) == ("40.0000", "60.0000")
    assert (a["units"], b["units"]) == ("10000.000000", "10000.000000")
    assert (a["units_share_pct"], b["units_share_pct"]) == ("50.0000", "50.0000")
    assert float(view["nav"]) == 300000.0 and float(view["unit_price"]) == 15.0
    # the same 300,000 under each measure — the 30,000 the design table showed
    assert (a["value_by_capital"], b["value_by_capital"]) == ("120000.00", "180000.00")
    assert (a["value_by_units"], b["value_by_units"]) == ("150000.00", "150000.00")


def test_the_second_deposit_is_priced_before_its_money_arrives(fx):
    _two_members(fx)
    rows = fx.api.list_contributions(fx.fid)["contributions"]
    second = rows[1]
    assert (second["nav_before"], second["units_before"]) == ("150000.00", "10000.000000") \
        or (float(second["nav_before"]), float(second["units_before"])) == (150000.0, 10000.0)
    assert float(second["unit_price"]) == 15.0 and second["price_source"] == "live"
    assert float(second["units_issued"]) == 10000.0


def test_money_coming_in_does_not_move_the_unit_price(fx):
    _two_members(fx)
    before = float(fx.api.get_nav(fx.fid)["unit_price"])
    _deposit(fx, fx.a, 45000)
    after = fx.api.get_nav(fx.fid)
    assert float(after["unit_price"]) == pytest.approx(before, abs=1e-6)
    assert float(after["nav"]) == 345000.0 and float(after["units"]) == 23000.0


def test_every_sum_is_over_every_row(fx):
    _two_members(fx)
    _deposit(fx, fx.a, 45000)
    view = fx.api.list_members(fx.fid)
    with fx.db.get_db() as conn:
        cap, units = conn.execute(
            "SELECT SUM(CAST(amount_base AS REAL)), SUM(CAST(units_issued AS REAL)) FROM fund_contributions").fetchone()
    assert float(view["capital_total"]) == cap == 295000.0
    assert float(view["units_total"]) == pytest.approx(units)
    assert sum(float(m["capital"]) for m in view["members"]) == cap


# ── when the fund cannot be valued ───────────────────────────────────────────

def test_a_holding_without_a_price_stops_the_deposit_and_is_named(fx):
    _deposit(fx, fx.a, 100000)
    _buy(fx, "NOPRICE.BK", 10000, 10)
    assert fx.api.get_nav(fx.fid)["nav"] is None and fx.api.get_nav(fx.fid)["unpriced"] == ["NOPRICE.BK"]
    with pytest.raises(HTTPException) as e:
        _deposit(fx, fx.b, 150000)
    assert e.value.status_code == 422 and _code(e) == "nav_unknown" and "NOPRICE.BK" in e.value.detail["detail"]
    with pytest.raises(HTTPException) as e:
        _deposit(fx, fx.b, 150000, unit_price="15")
    assert _code(e) == "reason_required"
    row = _deposit(fx, fx.b, 150000, unit_price="15", price_reason="broker statement 13 Oct")
    assert row["price_source"] == "manual" and float(row["units_issued"]) == 10000.0


def test_a_back_dated_deposit_needs_that_days_value(fx):
    _deposit(fx, fx.a, 100000, date=(date.today() - timedelta(days=10)).isoformat())
    with pytest.raises(HTTPException) as e:
        _deposit(fx, fx.b, 50000, date=(date.today() - timedelta(days=5)).isoformat())
    assert _code(e) == "nav_unknown"
    with pytest.raises(HTTPException) as e:
        _deposit(fx, fx.b, 50000, date=(date.today() - timedelta(days=20)).isoformat())
    assert _code(e) in ("before_first_deposit", "nav_unknown")


def test_preview_shows_the_units_and_keeps_nothing(fx):
    _deposit(fx, fx.a, 100000)
    out = fx.api.preview_contribution(fx.fid, fx.api.ContributionIn(
        member_id=fx.b, account_id="kongsi-th", date=TODAY, amount="50000"))
    assert out["preview"] is True and float(out["units_issued"]) == 5000.0
    assert len(fx.api.list_contributions(fx.fid)["contributions"]) == 1
    with fx.db.get_db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM cash_ledger WHERE account_id = 'kongsi-th'").fetchone()[0] == 1


# ── what is refused ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("kw, code", [
    ({"amount": "-5"}, "bad_amount"),
    ({"amount": "abc"}, "bad_number"),
    ({"date": (date.today() + timedelta(days=1)).isoformat()}, "future_date"),
    ({"date": "13/10/2026"}, "bad_date"),
    ({"account_id": "mine"}, "not_a_fund_account"),
    ({"currency": "USD"}, "fx_rate_required"),
    ({"member_id": "nobody"}, "unknown_member"),
])
def test_a_bad_deposit_is_refused_with_its_reason(fx, kw, code):
    args = {"member_id": fx.a, "account_id": "kongsi-th", "date": TODAY, "amount": "100", **kw}
    with pytest.raises(HTTPException) as e:
        fx.api.add_contribution(fx.fid, fx.api.ContributionIn(**args))
    assert e.value.status_code in (404, 422) and _code(e) == code
    assert fx.api.list_contributions(fx.fid)["contributions"] == []


def test_a_usd_deposit_is_kept_in_both_currencies(fx):
    fx.api.add_account(fx.fid, fx.api.AccountIn(id="kongsi-us", name="Kongsi US", currency="USD"))
    row = _deposit(fx, fx.a, 1000, account_id="kongsi-us", fx_rate="33.5")
    assert (row["amount"], row["currency"], row["fx_rate"], row["amount_base"]) == ("1000.00", "USD", "33.5", "33500.00")
    with fx.db.get_db() as conn:
        cash = conn.execute("SELECT investment, exchange_rate FROM cash_ledger WHERE id = ?",
                            (row["cash_ledger_id"],)).fetchone()
    assert (cash["investment"], cash["exchange_rate"]) == (33500.0, 33.5)


def test_a_personal_account_cannot_become_a_fund_account(fx):
    with pytest.raises(HTTPException) as e:
        fx.api.add_account(fx.fid, fx.api.AccountIn(id="mine", name="x", currency="THB"))
    assert e.value.status_code == 409 and _code(e) == "account_exists"
    for bad in ("all", "fund:x", "*", " "):
        with pytest.raises(HTTPException) as e:
            fx.api.add_account(fx.fid, fx.api.AccountIn(id=bad, name="x", currency="THB"))
        assert _code(e) == "bad_account_id"


def test_only_the_decided_split_rule_is_accepted(fx):
    assert fx.api.get_fund(fx.fid)["split_rule"]["basis"] == "CAPITAL"
    with pytest.raises(HTTPException) as e:
        fx.api.set_split_rule(fx.fid, fx.api.SplitRuleIn(basis="EQUAL", effective_from=TODAY, reason="try"))
    assert _code(e) == "basis_undecided"
    with pytest.raises(HTTPException) as e:
        fx.api.set_split_rule(fx.fid, fx.api.SplitRuleIn(basis="CAPITAL", effective_from=TODAY, reason=" "))
    assert _code(e) == "reason_required"


# ── corrections ──────────────────────────────────────────────────────────────

def test_a_reversal_takes_the_money_and_the_units_back(fx):
    _deposit(fx, fx.a, 100000)
    wrong = _deposit(fx, fx.b, 70000)
    rev = fx.api.reverse_contribution(fx.fid, wrong["id"], fx.api.ReverseIn(reason="typed 70,000 for 7,000"))
    assert rev["reverses_id"] == wrong["id"] and rev["amount_base"] == "-70000.00"
    view = fx.api.list_members(fx.fid)
    assert [m["capital"] for m in view["members"]] == ["100000.00", "0.00"]
    assert float(view["units_total"]) == 10000.0 and float(view["nav"]) == 100000.0
    rows = fx.api.list_contributions(fx.fid)["contributions"]
    assert len(rows) == 3 and [r["reversed"] for r in rows] == [False, True, False]
    with pytest.raises(HTTPException) as e:
        fx.api.reverse_contribution(fx.fid, wrong["id"], fx.api.ReverseIn(reason="again"))
    assert e.value.status_code == 409 and _code(e) == "already_reversed"
    with pytest.raises(HTTPException) as e:
        fx.api.reverse_contribution(fx.fid, rev["id"], fx.api.ReverseIn(reason="undo the undo"))
    assert _code(e) == "is_a_reversal"


def test_an_earlier_deposit_cannot_be_pulled_from_under_a_later_one(fx):
    first = _deposit(fx, fx.a, 100000)
    _deposit(fx, fx.b, 50000)
    with pytest.raises(HTTPException) as e:
        fx.api.reverse_contribution(fx.fid, first["id"], fx.api.ReverseIn(reason="oops"))
    assert e.value.status_code == 409 and _code(e) == "later_deposits_exist"
    with pytest.raises(HTTPException) as e:
        fx.api.reverse_contribution(fx.fid, first["id"], fx.api.ReverseIn(reason=""))
    assert _code(e) in ("reason_required", "later_deposits_exist")


def test_deposit_rows_cannot_be_edited_or_deleted(fx):
    row = _deposit(fx, fx.a, 100000)
    with fx.db.get_db() as conn:
        for sql in ("UPDATE fund_contributions SET amount = '1' WHERE id = ?",
                    "DELETE FROM fund_contributions WHERE id = ?"):
            with pytest.raises(sqlite3.DatabaseError, match="append-only"):
                conn.execute(sql, (row["id"],))


# ── who may write ────────────────────────────────────────────────────────────

def test_an_agent_reads_but_does_not_record_money(fx):
    _deposit(fx, fx.a, 100000)
    app = FastAPI()
    app.include_router(fx.api.router)
    client = TestClient(app)
    agent = {"X-Thesis-Actor": "agent:test"}
    assert client.get(f"/api/v2/fund/{fx.fid}/members", headers=agent).status_code == 200
    body = {"member_id": fx.a, "account_id": "kongsi-th", "date": TODAY, "amount": "1"}
    r = client.post(f"/api/v2/fund/{fx.fid}/contributions", json=body, headers=agent)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "user_only"
    assert client.post("/api/v2/fund", json={"name": "x"}, headers=agent).status_code == 403
    assert client.post(f"/api/v2/fund/{fx.fid}/contributions", json=body).status_code == 201
    assert client.get("/api/v2/fund/nope").status_code == 404


# ── a write lands in the book it was typed in (book_guard.py) ────────────────

def _client(fx):
    import book_guard
    importlib.reload(book_guard)
    importlib.reload(fx.pv2)
    app = FastAPI()
    app.include_router(fx.pv2.router)
    return TestClient(app)


def test_a_fund_account_takes_writes_only_from_the_fund_book(fx):
    client = _client(fx)
    cash = {"date": TODAY, "flow_type": "DEPOSIT", "amount": 10}
    r = client.post("/api/v2/portfolio/cash", json={**cash, "account_id": "kongsi-th"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "wrong_book"
    r = client.post("/api/v2/portfolio/cash", json={**cash, "account_id": "kongsi-th", "book": "fund:other"})
    assert r.status_code == 409
    r = client.post("/api/v2/portfolio/cash", json={**cash, "account_id": "kongsi-th", "book": f"fund:{fx.fid}"})
    assert r.status_code == 201


def test_a_personal_account_refuses_a_write_typed_in_the_fund_view(fx):
    client = _client(fx)
    cash = {"date": TODAY, "flow_type": "DEPOSIT", "amount": 10, "account_id": "mine"}
    r = client.post("/api/v2/portfolio/cash", json={**cash, "book": f"fund:{fx.fid}"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "wrong_book"
    assert client.post("/api/v2/portfolio/cash", json=cash).status_code == 201
    assert client.post("/api/v2/portfolio/cash", json={**cash, "book": "all"}).status_code == 201


def test_money_never_moves_between_the_two_books_in_one_transfer(fx):
    client = _client(fx)
    body = {"from_account_id": "mine", "to_account_id": "kongsi-th", "date": TODAY, "amount": 100}
    for book in (None, "all", f"fund:{fx.fid}"):
        r = client.post("/api/v2/portfolio/cash/transfer", json={**body, **({"book": book} if book else {})})
        assert r.status_code == 409 and r.json()["detail"]["code"] == "cross_book"
