import pytest

from accounting_preflight import dividend_amounts, entitlement_units, opening_balance, trade_dates, transfer_balance, wallet_value


@pytest.mark.parametrize("entry,exit_,label", [
    ("2026-01-02", None, "W"), ("2026-01-02", "2026-01-01", "L"),
    ("2026-99-99", None, "P"), (None, None, "P"),
])
def test_incomplete_history_cannot_pass_holdings_previews(entry, exit_, label):
    row = {"date_entry": entry, "date_exit": exit_, "win_loss": label}
    with pytest.raises(ValueError):
        trade_dates(row)
    with pytest.raises(ValueError):
        entitlement_units([row], "2026-02-23", today="2026-09-25")


def test_explicit_thai_dividend_gross_net_and_actual_withholding():
    assert dividend_amounts(gross=1350, tax_rate=0.1)["total_received"] == 1215
    assert dividend_amounts(net=1215, tax_rate=0.1)["gross_amount"] == 1350
    assert dividend_amounts(gross=1350, net=1215)["tax_withheld"] == 135
    with pytest.raises(ValueError, match="explicitly selected"):
        dividend_amounts(gross=1350)
    with pytest.raises(ValueError, match="must equal"):
        dividend_amounts(gross=1350, net=1215, tax_withheld=1)


@pytest.mark.parametrize("gross,rate", [(1.23, .15), (10.01, .1), (1350, .1)])
def test_rounded_dividend_conserves_cash(gross, rate):
    r = dividend_amounts(gross=gross, tax_rate=rate)
    assert r["gross_amount"] - r["tax_withheld"] == pytest.approx(r["total_received"], abs=.001)


def test_ex_date_boundaries_and_subaccounts():
    def t(sub, entry="2026-02-01", exit_=None, qty=4500):
        return {"account_id": "finansia", "symbol": "OR", "date_entry": entry, "date_exit": exit_, "volume": qty, "note": f"Finansia ({sub})"}
    rows = [t("6065151", exit_="2026-02-23"), t("6065157", qty=6900),
            t("6065151", entry="2026-02-23", qty=100), t("6065157", exit_="2026-02-22", qty=100)]
    entitlements = entitlement_units(rows, "2026-02-23", today="2026-09-25")
    assert [(e["sub_account"], e["units"]) for e in entitlements] == [("6065151", 4500), ("6065157", 6900)]
    assert sum(e["units"] for e in entitlements) == 11400
    with pytest.raises(ValueError, match="on or after"):
        entitlement_units(rows, "2027-02-23", today="2026-09-25")


def test_opening_uses_market_value_and_reports_missing_holding_evidence():
    positions = [{"symbol": "OR", "qty": 100, "market_price": 12, "cost_basis": 2800}]
    r = opening_balance(as_of="2025-12-31", cash=50, market_value=1250, positions=positions)
    assert r["O1"] is True and r["O2"] is None
    assert r["performance_basis"] == "market_value"
    assert r["pnl_basis"] == "cost_basis"
    r = opening_balance(as_of="2025-12-31", cash=50, market_value=1250, positions=positions, held_units={"OR": 101})
    assert r["O2"] is False
    assert r["quantity_differences"][0]["ledger_qty"] == 101


def test_wallet_fx_gain_is_not_deposit_and_missing_rates_never_zero():
    wallets = [{"wallet": "USD", "currency": "USD", "balance": 100}]
    assert wallet_value(wallets, {"USD": 35})["cash_base"] - wallet_value(wallets, {"USD": 34})["cash_base"] == 100
    assert wallet_value(wallets, {})["cash_base"] is None
    assert wallet_value([{**wallets[0], "balance": -1}], {"USD": 35})["wallets"][0]["W1"] is False


def test_actual_split_date_transfer_keeps_capital_in_transit():
    args = {"out_date": "2026-07-14", "amount": 98833.91,
            "in_legs": [{"date": "2026-07-14", "amount": 50000}, {"date": "2026-07-15", "amount": 48833.91}]}
    first = transfer_balance(**args, as_of="2026-07-14")
    assert first["in_transit"] == 48833.91
    assert first["received"] + first["in_transit"] + first["fee"] == first["amount"]
    assert first["all_scope_external_flow"] == 0
    assert transfer_balance(**args, as_of="2026-07-15")["in_transit"] == 0
    assert transfer_balance(**args, as_of="2026-07-13")["in_transit"] == 0


def test_transfer_overdue_and_overallocation():
    assert transfer_balance(out_date="2026-07-14", amount=100, in_legs=[], as_of="2026-07-23")["overdue"] is True
    with pytest.raises(ValueError, match="exceed"):
        transfer_balance(out_date="2026-07-14", amount=100, in_legs=[{"date": "2026-07-15", "amount": 101}])
