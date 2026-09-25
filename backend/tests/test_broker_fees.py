"""Dime fee estimate vs the order confirmations it was fitted to."""
import pytest

from broker_fees import estimate


def test_sndk_sell_confirmation():
    f = estimate("DIME_US", "SELL", 4.4628776, 1754.96)
    assert f["value"] == 7832.17
    assert f["commission"] == pytest.approx(11.74, abs=0.011)
    assert f["vat"] == 0.82
    assert f["sec_fee"] == 0.17
    assert f["taf_fee"] == 0.01
    assert f["total"] == pytest.approx(12.74, abs=0.011)


def test_mu_sell_confirmation():
    f = estimate("DIME_US", "SELL", 1.1351884, 1048.4263)
    assert (f["commission"], f["vat"], f["sec_fee"], f["taf_fee"]) == (1.79, 0.12, 0.03, 0.01)


def test_buy_has_no_regulatory_fees_and_matches_order_amount():
    # GOOGL 2026-04-08: order 10,000.00 bought 31.4982528 @ 316.9692 (9,983.98)
    f = estimate("DIME_US", "BUY", 31.4982528, 316.9692)
    assert f["sec_fee"] == f["taf_fee"] == 0
    assert f["total"] == pytest.approx(10000.00 - 9983.98, abs=0.011)


def test_taf_is_capped():
    assert estimate("DIME_US", "SELL", 100000, 10)["taf_fee"] == 8.30


@pytest.mark.parametrize("side,qty,price", [("HOLD", 1, 1), ("BUY", 0, 1), ("SELL", 1, -1)])
def test_invalid_orders_rejected(side, qty, price):
    with pytest.raises(ValueError):
        estimate("DIME_US", side, qty, price)
