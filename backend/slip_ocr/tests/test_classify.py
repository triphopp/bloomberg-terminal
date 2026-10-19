"""What kind of slip it is, before anything is read: a broker order (trade), a
bank transfer (money in / out), or neither. Engine-only, no OCR model."""
import json
from pathlib import Path

from slip_ocr import classify, parse_tokens
from slip_ocr.layout import Token

FIXTURES = Path(__file__).parent / "fixtures"


def _dime():
    path = FIXTURES / "dime_buy_cost_tokens_rapidocr.json"
    return [Token(**t) for t in json.loads(path.read_text(encoding="utf-8"))]


def _transfer():
    """A bank app's "transfer complete" slip (SCB layout), made-up people."""
    rows = [
        ("SCB", 360, 73, 566, 157), ("โอนเงินสำเร็จ", 310, 273, 599, 343),
        ("29 ก.ย. 2569 - 20:32", 235, 384, 674, 433),
        ("รหัสอ้างอิง:", 17, 462, 245, 523), ("202609290TESTrefCODE1234x", 233, 470, 896, 524),
        ("จาก", 53, 644, 145, 689), ("นาย ทดสอบ ก.", 523, 643, 859, 694),
        ("XXX-Xxx111-1", 575, 729, 858, 780),
        ("ไปยัง", 48, 884, 163, 950), ("บล. ทดสอบ จำกัด", 330, 888, 863, 954),
        ("XXX-XXx222-2", 575, 985, 858, 1038),
        ("จำนวนเงิน", 52, 1147, 266, 1209), ("10,000.00", 632, 1152, 860, 1213),
    ]
    return [Token(*r) for r in rows]


def test_a_broker_order_slip_is_a_trade():
    assert classify(_dime()) == "trade"
    assert parse_tokens(_dime())["slip_kind"] == "trade"


def test_a_bank_transfer_slip_is_a_transfer_not_a_failure():
    assert classify(_transfer()) == "transfer"
    out = parse_tokens(_transfer())
    assert out["slip_kind"] == "transfer" and out["form"] is None and out["status"] == "ok"
    t = out["transfer"]
    assert t["amount"] == "10000.00" and t["to_name"] == "บล. ทดสอบ จำกัด" and t["transferred_at"] == "2026-09-29T20:32"
    assert any("CASH" in w for w in out["warnings"])


def test_anything_else_is_neither_and_says_what_is_supported():
    junk = [Token("hello", 0, 0, 50, 20), Token("world 12.00", 0, 40, 200, 60)]
    assert classify(junk) is None
    out = parse_tokens(junk)
    assert out["slip_kind"] is None and out["status"] == "fail"
    assert "bank transfer" in out["warnings"][0] and "Dime" in out["warnings"][0]
