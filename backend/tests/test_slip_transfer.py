"""A bank transfer slip in PORT → ENTRY goes to CASH (routers/slip_ocr.py),
and a broker order slip in FUND → DEPOSITS is not read as a deposit."""
import importlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from slip_ocr.tests.test_classify import _dime, _transfer

ACCOUNTS = [
    {"id": "finansia", "name": "Finansia", "broker": "Finansia Securities", "currency": "THB"},
    {"id": "dime", "name": "Dime", "broker": "", "currency": "USD"},
]


def _hint(from_name, to_name):
    from routers.slip_ocr import transfer_hint
    return transfer_hint({"from_name": from_name, "to_name": to_name, "amount": "500.00",
                          "transferred_at": "2026-10-19T09:00", "ref_code": "R1"}, ACCOUNTS)


def test_money_to_a_broker_account_is_a_deposit_into_it():
    h = _hint("นาย ทดสอบ", "บล. ฟินันเซีย ไซรัส จำกัด (มหาชน)")
    assert h == {"flow_type": "DEPOSIT", "account_id": "finansia", "date": "2026-10-19",
                 "amount": "500.00", "ref_code": "R1"}


def test_money_from_a_broker_account_is_a_withdrawal():
    h = _hint("FINANSIA SECURITIES", "นาย ทดสอบ")
    assert h["flow_type"] == "WITHDRAW" and h["account_id"] == "finansia"


def test_an_unknown_broker_still_gives_the_direction_but_no_account():
    h = _hint("นาย ทดสอบ", "บริษัทหลักทรัพย์ อื่น จำกัด")
    assert h["flow_type"] == "DEPOSIT" and h["account_id"] is None


def test_a_transfer_between_people_decides_nothing():
    h = _hint("นาย ก", "นาง ข")
    assert h["flow_type"] is None and h["account_id"] is None


@pytest.fixture()
def db_env(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "p.db"))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_fund_schema()
    with db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts (id, name, broker, currency) "
                     "VALUES ('finansia', 'Finansia', 'Finansia Securities', 'THB')")
    return db


def test_entry_reads_a_transfer_slip_and_hands_it_to_cash(db_env, monkeypatch):
    import routers.slip_ocr as api
    importlib.reload(api)
    from slip_ocr import ocr
    tokens = [t for t in _transfer()]
    monkeypatch.setattr(ocr, "read", lambda data: tokens)
    app = FastAPI()
    app.include_router(api.router)
    r = TestClient(app).post("/api/v2/portfolio/slip/read", files={"file": ("s.png", b"\x89PNG x", "image/png")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["slip_kind"] == "transfer" and body["form"] is None
    assert body["transfer_hint"]["flow_type"] == "DEPOSIT" and body["transfer_hint"]["amount"] == "10000.00"


def test_fund_refuses_to_read_an_order_slip_as_a_deposit(db_env, monkeypatch):
    import fund_slips
    importlib.reload(fund_slips)
    from slip_ocr import ocr
    monkeypatch.setattr(ocr, "read", lambda data: _dime())
    out = fund_slips.read(b"\x89PNG an order slip")
    r = out["reading"]
    assert r["kind"] == "trade" and r["amount"] is None and "amount" in r["unread"]
