"""slip_ocr engine: parse + validate + map, from recorded OCR tokens (no model needed).

Engine-only: nothing from the host app is imported. Fixtures are real OCR
output of one Dime slip with the account number replaced (80000001234).
"""
import json
from dataclasses import replace
from pathlib import Path

from slip_ocr import parse_tokens
from slip_ocr.layout import Token, label_score, parse_money
from slip_ocr.thai_date import parse_thai_datetime

FIXTURE = Path(__file__).parent / "fixtures" / "dime_buy_cost_tokens.json"            # easyocr
FIXTURE_RAPID = Path(__file__).parent / "fixtures" / "dime_buy_cost_tokens_rapidocr.json"


def _tokens(path=FIXTURE):
    return [Token(**t) for t in json.loads(path.read_text(encoding="utf-8"))]


def _dime_like(broker, currency, side, qty, price):
    """Stand-in schedule: 0.15 % commission + 7 % VAT, rounded half-up."""
    value = qty * price
    commission = round(value * 0.0015 + 1e-9, 2)
    vat = round(value * 0.0015 * 0.07 + 1e-9, 2)
    return {"commission": commission, "vat": vat, "total": commission + vat}


def test_schedule_check_is_skipped_without_a_schedule():
    out = parse_tokens(_tokens())
    assert out["status"] == "ok"
    assert "schedule" not in {c["id"] for c in out["checks"]}


def test_schedule_mismatch_warns_but_keeps_slip_fees():
    out = parse_tokens(_tokens(), fee_schedule=lambda *a: {"commission": 9.0, "vat": 0.63, "total": 9.63})
    assert {c["id"]: c["level"] for c in out["checks"]}["schedule"] == "warn"
    assert out["form"]["fee_entry"] == "3.04" and out["status"] == "review"


def test_both_ocr_backends_give_the_same_form():
    a, b = parse_tokens(_tokens()), parse_tokens(_tokens(FIXTURE_RAPID))
    assert a["status"] == b["status"] == "ok"
    assert a["form"] == b["form"]
    assert b["slip"]["fields"]["settlement"]["value"] == {"wallet": "DIME! USD", "account_tail": "1234"}


def test_dime_buy_slip_fills_entry_form():
    out = parse_tokens(_tokens(), fee_schedule=_dime_like)
    assert out["status"] == "ok", out["checks"]
    f = out["form"]
    assert f["side"] == "buy" and f["account_hint"] is None   # host decides the account
    assert f["symbol"] == "COST"
    assert f["volume"] == "2.0751791"
    assert f["date_entry"] == "2026-09-25"
    # value / qty, not the rounded 914.11 on screen
    assert f["price_entry"] == "914.1187"
    assert f["fee_entry"] == "3.04"
    assert f["fee_breakdown"] == {"commission": "2.84", "vat": "0.20"}
    assert f["broker_order_ref"] == "STKBMF20260925014541145317"
    fields = out["slip"]["fields"]
    assert fields["exchange"]["value"] == "NASDAQ"          # OCR read "nasdao"
    assert fields["order_amount"]["value"] == "1900.00"
    assert fields["order_type"]["value"] == "MARKET"
    assert fields["settlement"]["value"] == {"wallet": "DIME! USD", "account_tail": "1234"}
    assert {c["id"]: c["level"] for c in out["checks"]} == {
        "value": "ok", "total": "ok", "schedule": "ok", "ref_date": "ok"}


def test_misread_digit_is_caught():
    toks = [replace(t, text="1,996.96 usd") if t.text == "1,896.96 usd" else t for t in _tokens()]
    out = parse_tokens(toks)
    assert out["status"] == "review"
    assert {c["id"] for c in out["checks"] if c["level"] == "error"} == {"value", "total"}


def test_missing_value_is_derived_from_order_total():
    toks = [t for t in _tokens() if t.text != "1,896.96 usd"]
    out = parse_tokens(toks)
    assert out["slip"]["fields"]["gross_value"]["value"] == "1896.96"
    assert out["form"]["price_entry"] == "914.1187"
    assert out["status"] == "review"


def test_late_night_bangkok_fill_is_previous_us_session():
    toks = [replace(t, text="26 ก.ย. 69 - 01:30 น.") if "20:45" in t.text and "-" in t.text else t
            for t in _tokens()]
    out = parse_tokens(toks)
    assert out["form"]["executed_at"] == "2026-09-26T01:30"
    assert out["form"]["date_entry"] == "2026-09-25"


def test_unknown_layout():
    out = parse_tokens([Token("hello", 0, 0, 10, 10)])
    assert out["status"] == "fail" and out["form"] is None


def test_thai_dates():
    assert parse_thai_datetime("25 ก.ย. 69 - 20:45 น.").isoformat() == "2026-09-25T20:45:00"
    assert parse_thai_datetime("3 มี.ค. 2569 09:05").isoformat() == "2026-03-03T09:05:00"
    assert parse_thai_datetime("3 ม.ค. 69").isoformat() == "2026-01-03T00:00:00"
    assert parse_thai_datetime("12 Oct 2026 10:00").isoformat() == "2026-10-12T10:00:00"
    assert parse_thai_datetime("no date") is None


def test_label_tolerates_lost_thai_marks():
    assert label_score("วันทีส่งคำสัง", "วันที่ส่งคำสั่ง") == 1.0
    assert label_score("เลขที่บัญชีหลักทรัพย์ต่าง", "เลขที่คำสั่ง") < 0.8


def test_money_ocr_swaps():
    assert parse_money("1,9O0.00 usd") == (__import__("decimal").Decimal("1900.00"), "USD")
