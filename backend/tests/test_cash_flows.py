"""
Typed cash flows: DEPOSIT puts capital in, WITHDRAW takes it out.

Withdrawals used to exist only as a negative `investment` typed by hand (the
Excel "Case Out" rows) and the CASH table hid them — a negative amount rendered
as "—". The sign now comes from the type, and every figure that reads
SUM(investment) sees the withdrawal.
"""
import importlib

import pytest
from fastapi import HTTPException


@pytest.fixture()
def pv2(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "flows.db"))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema()
    db.init_alerts_schema(); db.init_sync_layer()
    import portfolio_currency
    importlib.reload(portfolio_currency)
    import routers.portfolio_v2 as mod
    importlib.reload(mod)
    monkeypatch.setattr(mod, "_get_thb_per_usd", lambda: 35.0)
    monkeypatch.setattr(mod, "open_option_positions", lambda *a, **k: [])
    monkeypatch.setattr(mod, "closed_option_positions", lambda *a, **k: [])
    with db.get_db() as conn:
        conn.execute(
            "INSERT INTO portfolio_accounts (id, name, currency) VALUES ('acc', 'ACC', 'THB')"
        )
    return mod, db


def _cash(mod):
    return mod.get_summary(base_currency="THB")["accounts"][0]


def test_withdraw_reduces_invested_and_cash(pv2):
    mod, _ = pv2
    mod.add_cash(mod.CashIn(account_id="acc", date="2026-01-01", flow_type="DEPOSIT", amount=100000))
    r = mod.add_cash(mod.CashIn(account_id="acc", date="2026-02-01", flow_type="WITHDRAW", amount=30000))
    assert r["investment"] == -30000
    a = _cash(mod)
    assert a["total_invested"] == 70000
    assert a["cash_base"] == 70000


def test_list_labels_every_direction(pv2):
    mod, db = pv2
    mod.add_cash(mod.CashIn(account_id="acc", date="2026-01-01", flow_type="deposit", amount=500))
    mod.add_cash(mod.CashIn(account_id="acc", date="2026-01-02", flow_type="WITHDRAW", amount=200))
    # legacy row: a withdrawal known only by its sign
    with db.get_db() as conn:
        conn.execute(
            "INSERT INTO cash_ledger (id, account_id, date, income, investment) "
            "VALUES ('old', 'acc', '2025-12-01', 50, -50)"
        )
    types = {r["date"]: r["flow_type"] for r in mod.list_cash(account_id="acc")}
    assert types == {"2026-01-01": "DEPOSIT", "2026-01-02": "WITHDRAW", "2025-12-01": "WITHDRAW"}


@pytest.mark.parametrize("kw", [
    {"flow_type": "WITHDRAW", "amount": -5},      # sign belongs to the type
    {"flow_type": "WITHDRAW", "amount": 0},
    {"flow_type": "FEE", "amount": 5},             # not a capital flow
])
def test_rejects_bad_flow(pv2, kw):
    mod, _ = pv2
    with pytest.raises(HTTPException) as e:
        mod.add_cash(mod.CashIn(account_id="acc", date="2026-01-01", **kw))
    assert e.value.status_code == 400


def test_unknown_account_rejected(pv2):
    mod, _ = pv2
    with pytest.raises(HTTPException) as e:
        mod.add_cash(mod.CashIn(account_id="nope", date="2026-01-01", flow_type="DEPOSIT", amount=1))
    assert e.value.status_code == 404


def test_edit_flips_direction(pv2):
    mod, _ = pv2
    r = mod.add_cash(mod.CashIn(account_id="acc", date="2026-01-01", flow_type="DEPOSIT", amount=1000))
    mod.update_cash(r["id"], mod.CashIn(account_id="acc", date="2026-01-01", flow_type="WITHDRAW", amount=1000))
    assert _cash(mod)["total_invested"] == -1000


def test_transfer_leg_cannot_be_edited_alone(pv2):
    mod, db = pv2
    with db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('b', 'B', 'THB')")
    t = mod.transfer_cash(mod.CashTransferIn(from_account_id="acc", to_account_id="b",
                                             date="2026-01-01", amount=100))
    with pytest.raises(HTTPException) as e:
        mod.update_cash(t["ids"][0], mod.CashIn(account_id="acc", date="2026-01-01",
                                                flow_type="WITHDRAW", amount=999))
    assert e.value.status_code == 409


def test_legacy_two_column_post_still_works(pv2):
    mod, _ = pv2
    r = mod.add_cash(mod.CashIn(account_id="acc", date="2026-01-01", income=10, investment=10))
    assert r["entry_type"] == "CASH"
    assert _cash(mod)["total_invested"] == 10


def test_empty_row_rejected(pv2):
    """What an old client (or a new client on an old server) produces: no amount."""
    mod, _ = pv2
    with pytest.raises(HTTPException) as e:
        mod.add_cash(mod.CashIn(account_id="acc", date="2026-01-01"))
    assert e.value.status_code == 400
