"""Slip → trade: order-number dedupe, provenance columns, broker_executions evidence."""
import hashlib
import importlib
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from slip_ocr import parse_tokens
from slip_ocr.layout import Token

FIXTURE = Path(__file__).parents[1] / "slip_ocr" / "tests" / "fixtures" / "dime_buy_cost_tokens.json"
REF = "STKBMF20260925014541145317"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "slip.db"))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema()
    db.init_alerts_schema(); db.init_sync_layer(); db.init_audit_layer()
    import slip_evidence
    importlib.reload(slip_evidence)
    import routers.portfolio_v2 as mod
    importlib.reload(mod)
    monkeypatch.setattr(mod, "_get_thb_per_usd", lambda: 33.0)
    with db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('dime','Dime','USD')")
    image = b"RIFF\x00\x00\x00\x00WEBPfake-slip"
    out = parse_tokens([Token(**t) for t in json.loads(FIXTURE.read_text(encoding="utf-8"))])
    out["image_sha256"] = hashlib.sha256(image).hexdigest()
    out["ocr"] = {"backend": "fixture"}
    slip_evidence.save(image, out)
    return mod, db, slip_evidence, out


def _save(mod, out, **kw):
    f = out["form"]
    body = dict(account_id="dime", symbol=f["symbol"], market="US", currency="USD",
                date_entry=f["date_entry"], price_entry=float(f["price_entry"]),
                volume=float(f["volume"]), exchange_rate=33.0, fee_entry=float(f["fee_entry"]),
                fee_entry_breakdown=f["fee_breakdown"], slip_sha256=out["image_sha256"])
    body.update(kw)
    return mod.create_trade(mod.TradeIn(**body))


def _one(db, sql, *args):
    with db.get_db() as conn:
        row = conn.execute(sql, args).fetchone()
        return dict(row) if row else None


def test_slip_trade_carries_provenance_and_evidence(env):
    mod, db, ev, out = env
    r = _save(mod, out)
    t = _one(db, "SELECT * FROM trades WHERE id=?", r["id"])
    assert (t["broker_order_ref"], t["executed_at"], t["entry_source"], t["source_sha256"]) == (
        REF, "2026-09-25T20:45+07:00", "slip", out["image_sha256"])
    e = _one(db, "SELECT * FROM broker_executions WHERE id=?", r["evidence_id"])
    assert e["trade_id"] == r["id"] and e["order_ref"] == REF
    assert (e["quantity"], e["unit_price"], e["gross_value"], e["commission"], e["vat"]) == (
        "2.0751791", "914.11", "1896.96", "2.84", "0.20")
    assert (e["side"], e["executed_at_local"], e["display_timezone"]) == ("BUY", "2026-09-25T20:45:00", "Asia/Bangkok")
    assert (e["order_amount"], e["exchange"], e["order_type"]) == ("1900.00", "NASDAQ", "MARKET")
    assert (ev.slip_dir() / e["source_image"]).is_file()


def test_same_order_twice_is_refused(env):
    mod, db, _, out = env
    _save(mod, out)
    with pytest.raises(HTTPException) as exc:
        _save(mod, out)
    assert exc.value.status_code == 409 and REF in exc.value.detail
    # a hand-typed order number is checked the same way
    with pytest.raises(HTTPException):
        _save(mod, out, slip_sha256=None, broker_order_ref=REF.lower())
    assert _one(db, "SELECT count(*) n FROM trades")["n"] == 1


def test_partial_sell_keeps_the_order_on_both_pieces(env):
    mod, db, _, out = env
    r = _save(mod, out)
    mod.sell_position(mod.SellIn(trade_id=r["id"], sell_volume=1, sell_price=950, sell_date="2026-09-26"))
    with db.get_db() as conn:
        refs = [x[0] for x in conn.execute("SELECT broker_order_ref FROM trades").fetchall()]
    assert refs == [REF, REF]


def test_delete_unlinks_evidence_and_allows_reentry(env):
    mod, db, _, out = env
    r = _save(mod, out)
    mod.delete_trade(r["id"])
    assert _one(db, "SELECT trade_id FROM broker_executions")["trade_id"] is None
    r2 = _save(mod, out)
    assert r2["evidence_id"] == r["evidence_id"]            # same fill, relinked
    assert _one(db, "SELECT trade_id FROM broker_executions")["trade_id"] == r2["id"]
    assert _one(db, "SELECT count(*) n FROM broker_executions")["n"] == 1


def test_unknown_slip_is_rejected(env):
    mod, _, _, out = env
    with pytest.raises(HTTPException) as exc:
        _save(mod, out, slip_sha256="0" * 64)
    assert exc.value.status_code == 422


def test_host_fee_schedule_is_the_dime_profile(env):
    _, _, ev, _ = env
    toks = [Token(**t) for t in json.loads(FIXTURE.read_text(encoding="utf-8"))]
    out = parse_tokens(toks, fee_schedule=ev.fee_schedule)
    check = next(c for c in out["checks"] if c["id"] == "schedule")
    assert check["level"] == "ok" and "Dime schedule" in check["message"]
    assert ev.fee_schedule("OTHER", "USD", "BUY", 1, 1) is None
    assert ev.fee_schedule("DIME", "THB", "BUY", 1, 1) is None


def test_manual_trade_is_marked_manual(env):
    mod, db, _, out = env
    r = _save(mod, out, slip_sha256=None)
    t = _one(db, "SELECT entry_source, broker_order_ref FROM trades WHERE id=?", r["id"])
    assert t == {"entry_source": "manual", "broker_order_ref": None}
