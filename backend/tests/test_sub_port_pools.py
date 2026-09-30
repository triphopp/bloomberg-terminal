"""Sub-ports pool average cost apart (no network).

Finansia 6065151 and 6065157 are two sub-accounts at the broker: OR held in
both is two positions, each with its own average. Before this, /sell and the
AVCO replay pooled every open lot of (account, symbol), so a sale in one
sub-port was priced — and the other sub-port's lots rebased — on a mixed average.
"""
import importlib

import pytest

from sub_port import sub_port_of, sub_port_segment

mod = None
db = None
A, B = "Finansia (6065151)", "Finansia (6065157)"


@pytest.fixture()
def book(tmp_path, monkeypatch):
    global mod, db
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "subport.db"))
    import config
    importlib.reload(config)
    import db as db_mod
    importlib.reload(db_mod)
    db = db_mod
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema()
    db.init_alerts_schema(); db.init_sync_layer(); db.init_audit_layer()
    import portfolio_currency
    importlib.reload(portfolio_currency)
    import routers.portfolio_v2 as m
    importlib.reload(m)
    mod = m
    with db.get_db() as conn:
        for acc in ("fin", "solo"):
            conn.execute(
                "INSERT INTO portfolio_accounts (id, name, broker, country, currency, account_type) "
                "VALUES (?, ?, '', 'TH', 'THB', 'equity')", (acc, acc.upper()))
    return m


def _buy(price, volume, date, note, account="fin", symbol="OR"):
    return mod.create_trade(mod.TradeIn(
        account_id=account, symbol=symbol, market="TH", currency="THB", sector="Energy",
        date_entry=date, price_entry=price, volume=volume, win_loss="P", fee_entry=0, note=note,
    ))["id"]


def _sell(trade_id, volume, price, date):
    return mod.sell_position(mod.SellIn(trade_id=trade_id, sell_volume=volume,
                                        sell_price=price, sell_date=date, commission=0))


def _rows(account="fin", symbol="OR"):
    with db.get_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM trades WHERE account_id = ? AND symbol = ? ORDER BY date_entry, rowid",
            (account, symbol))]


def test_parser_takes_only_the_leading_tag():
    assert sub_port_of("Finansia (6065151) | TAKEOVER 2026-02-08") == "6065151"
    assert sub_port_of("Finansia (6065151)\n[SOLD 2026-06-26] @ 188.0 | P&L: 1") == "6065151"
    assert sub_port_segment("Dime (TH DIME) | VAT: 61.49") == "Dime (TH DIME)"
    # free text that merely ends in a parenthesis is not a sub-port
    assert sub_port_of("\n[SOLD 2026-06-06] @ 39.1 | est. exit (price-match; was 2026-06-06)") == ""
    assert sub_port_of("Historical Excel reconciliation; source Dime!96 (dominant lot Dime!78)") == ""
    assert sub_port_of("VAT: 7 (x)") == ""
    assert sub_port_of(None) == ""


def test_open_lots_keep_their_own_sub_port_average(book):
    _buy(13.8, 6900, "2026-02-08", B)
    _buy(13.8, 4500, "2026-02-08", A)
    _buy(13.0, 3000, "2026-07-16", A)
    by_sub = {}
    for r in _rows():
        by_sub.setdefault(sub_port_of(r["note"]), set()).add(round(r["price_entry"], 6))
    # 6065151 = (4500×13.8 + 3000×13) / 7500; 6065157 untouched
    assert by_sub == {"6065157": {13.8}, "6065151": {13.48}}


def test_sale_is_priced_off_its_own_sub_port_only(book):
    _buy(20, 100, "2026-01-05", B)
    a = _buy(10, 100, "2026-01-05", A)
    _sell(a, 50, 12, "2026-01-20")
    rows = _rows()
    sold = next(r for r in rows if r["win_loss"] != "P")
    assert sold["price_entry"] == pytest.approx(10)       # not the pooled 15
    assert sold["pnl_amount"] == 100
    # the partial sale keeps its sub-port; the free text does not travel
    assert sold["note"] == A
    other = next(r for r in rows if r["win_loss"] == "P" and sub_port_of(r["note"]) == "6065157")
    assert other["price_entry"] == pytest.approx(20)       # never rebased to the sale's average


def test_ledger_check_reports_each_sub_port_apart(book):
    import ledger_backfill as lb
    _buy(20, 100, "2026-01-05", B)
    a = _buy(10, 100, "2026-01-05", A)
    _sell(a, 100, 12, "2026-01-20")
    with db.get_db() as conn:
        rep = lb.report(conn)
    assert ("fin", "OR", "6065151") in rep["cards"]
    assert ("fin", "OR", "6065157") in rep["cards"]
    assert not [i for i in rep["issues"] if i.code in ("I1", "I2", "I3", "I6")]


def test_same_day_same_price_sales_in_two_sub_ports_are_two_sales(book):
    import ledger_backfill as lb
    a = _buy(10, 100, "2026-01-05", A)
    b = _buy(20, 100, "2026-01-05", B)
    _sell(a, 0, 15, "2026-01-20")
    _sell(b, 0, 15, "2026-01-20")
    with db.get_db() as conn:
        events, _ = lb.build_events(conn)
    sells = [e for e in events if e.type == "SELL"]
    assert len(sells) == 2 and len({e.id for e in sells}) == 2
    by_sub = {e.sub_port: e.stored_pnl for e in sells}
    assert by_sub == {"6065151": 500, "6065157": -500}


def test_moving_a_lot_to_another_sub_port_replays_both(book):
    _buy(10, 100, "2026-01-05", A)
    b = _buy(20, 100, "2026-01-05", A)          # one pool at 15
    assert {r["price_entry"] for r in _rows()} == {15}
    res = mod.patch_trade(b, mod.TradePatch(note=B))
    assert res["replay"] is not None
    assert sorted(r["price_entry"] for r in _rows()) == [10, 20]


def test_single_tag_account_stays_one_pool(book):
    # One labelled row on an account without sub-accounts is a label, not a
    # second position (Dime "TH DIME").
    _buy(10, 100, "2026-01-05", "", account="solo", symbol="PTT")
    _buy(20, 100, "2026-01-06", "Solo (MAIN)", account="solo", symbol="PTT")
    assert {r["price_entry"] for r in _rows("solo", "PTT")} == {15}


def test_sell_all_lots_prices_each_sub_port_at_its_own_average(book):
    _buy(10, 100, "2026-01-05", A)
    _buy(20, 100, "2026-01-05", B)
    mod.sell_all_lots(mod.SellAllLotsIn(account_id="fin", symbol="OR", sell_price=15,
                                        sell_date="2026-01-20", commission=0))
    pnl = {sub_port_of(r["note"]): r["pnl_amount"] for r in _rows()}
    assert pnl == {"6065151": 500, "6065157": -500}
