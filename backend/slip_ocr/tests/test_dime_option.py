"""Dime US option order slips: real OCR tokens (rapidocr) of 2026 orders, account number masked.

A long slip is sent as a top and a bottom screenshot; `stack` joins them.
"""
import json
from pathlib import Path

import pytest

from slip_ocr import parse_tokens, stack
from slip_ocr.layout import Token

D = Path(__file__).parent / "fixtures" / "dime_option"


def _slip(*names):
    return parse_tokens(stack([[Token(**t) for t in json.loads((D / f"{n}.json").read_text(encoding="utf-8"))]
                               for n in names]))


def _fees(form):
    return {i["component"]: i["amount"] for i in form["fee_items"]}


def test_buy_top_and_bottom_screenshots_make_one_order():
    out = _slip("dime-opt-intc-260424c70-buy100", "dime-opt-intc-260424c70-buy100-time")
    assert out["status"] == "ok", out["checks"]
    f = out["form"]
    assert (f["instrument"], f["side"], f["underlying"], f["option_type"]) == ("option", "buy", "INTC", "call")
    assert (f["strike"], f["expiry"], f["contracts"], f["multiplier"], f["price"]) == \
        ("70.00", "2026-04-24", "100", "100", "0.79")
    # OCR reads the O of OPTBLO as a zero
    assert f["broker_order_ref"] == "OPTBLO20260408020028167065"
    assert f["executed_at"] == "2026-04-08T21:00:00+07:00" and f["trade_date"] == "2026-04-08"
    assert _fees(f) == {"COMMISSION": "55.00", "COMMISSION_DISCOUNT": "-55.00", "VAT": "0.00",
                        "OCC": "2.50", "ORF": "2.30"}
    assert f["fee_total"] == "4.80"


def test_sell_reads_negative_commission_as_a_cost_and_the_settle_date():
    out = _slip("dime-opt-intc-260424c70-sell100")
    assert out["status"] == "ok", out["checks"]
    f = out["form"]
    assert f["side"] == "sell" and f["price"] == "0.80" and f["settle_date"] == "2026-04-09"
    assert _fees(f)["COMMISSION"] == "55.00" and _fees(f)["TAF"] == "0.33"
    assert {c["id"]: c["level"] for c in out["checks"]}["total"] == "ok"   # 8000 − 5.13 = 7994.87


@pytest.mark.parametrize("names,expect", [
    (("dime-opt-intc-260130p40-buy4", "dime-opt-intc-260130p40-buy4-time"),
     ("buy", "40.00", "2026-01-30", "4", "0.24", "0.10", "2026-01-26T21:39:00+07:00")),
    (("dime-opt-intc-260130p39.5-buy50", "dime-opt-intc-260130p39.5-buy50-time-2"),
     ("buy", "39.50", "2026-01-30", "50", "0.23", "1.13", "2026-01-26T22:23:00+07:00")),
    (("dime-opt-unh-260130p270-sell1", "dime-opt-unh-260130p270-sell1-time"),
     ("sell", "270.00", "2026-01-30", "1", "1.57", "0.04", "2026-01-27T21:57:00+07:00")),
    (("dime-opt-intc-260501p40-sell10", "dime-opt-intc-260501p40-sell10-time"),
     ("sell", "40.00", "2026-05-01", "10", "0.07", "0.52", "2026-04-15T21:07:00+07:00")),
])
def test_order_pairs(names, expect):
    out = _slip(*names)
    assert out["status"] == "ok", out["checks"]
    f = out["form"]
    assert (f["side"], f["strike"], f["expiry"], f["contracts"], f["price"], f["fee_total"], f["executed_at"]) == expect


def test_date_under_a_fast_chip_is_found():
    # "วันที่ส่งคำสั่ง  [Dime! Fast]" pushes the date to the next line
    out = _slip("dime-opt-intc-260130p40-buy4-time")
    assert out["slip"]["fields"]["submitted_at"]["value"] == "2026-01-26T21:38"


def test_bottom_only_screenshot_is_a_fail_that_asks_for_the_top():
    out = _slip("dime-opt-intc-260206p42.5-buy2")
    assert out["status"] == "fail"
    assert out["form"]["fee_total"] == "0.05"          # commission taken from the promo, net 0
    assert any("top screenshot" in w for w in out["warnings"])


def test_stock_slip_still_goes_to_the_stock_parser():
    fx = Path(__file__).parent / "fixtures" / "dime_buy_cost_tokens_rapidocr.json"
    out = parse_tokens([Token(**t) for t in json.loads(fx.read_text(encoding="utf-8"))])
    assert out["slip"]["kind"] == "stock" and out["form"]["symbol"] == "COST"
