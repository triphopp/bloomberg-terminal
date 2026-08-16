"""
ALLOCATION (OPEN) basis analytics: growth vs cost, weight drift, and the
rebalance trade size.

The card this feeds used to weight sectors by COST alone, which cannot answer
"how much has this winner grown into the book?" — the cost weight is frozen at
entry. These tests pin the two-basis math and the FX rule that makes it honest.
"""
import importlib

import pytest


@pytest.fixture()
def pv2(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "alloc.db"))
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
    return mod


def _pos(symbol, sector, vol, entry, price, **kw):
    """One open lot in the shape /open-positions hands back."""
    row = {
        "id": kw.get("id", symbol),
        "account_id": kw.get("account_id", "acc"),
        "acc_name": "ACC",
        "symbol": symbol,
        "sector": sector,
        "volume": vol,
        "price_entry": entry,
        "amount": kw.get("amount"),
        "current_price": price,
        "currency": kw.get("currency", "THB"),
        "pos_currency": kw.get("currency", "THB"),
        "acc_currency": kw.get("currency", "THB"),
        "exchange_rate": kw.get("exchange_rate", 1),
        "date_entry": "2026-01-05",
        "market": kw.get("market", "TH"),
        "resolved_symbol": kw.get("resolved_symbol", symbol),
    }
    return row


def _stub(pv2, positions):
    pv2._open_positions_enriched = lambda account_id, base_currency: {
        "positions": positions,
        "thb_per_usd": 35.0,
    }


def _detail(pv2, positions, account_id=None, base="THB"):
    _stub(pv2, positions)
    return pv2.get_allocation_detail(account_id, base)


# ── Growth from basis ────────────────────────────────────────────────────────

def test_growth_pct_is_market_value_over_cost(pv2):
    out = _detail(pv2, [_pos("AOT", "Transport", 100, 50.0, 75.0)])
    sym = out["symbols"][0]
    assert sym["cost_base"] == 5000.0
    assert sym["market_value"] == 7500.0
    assert sym["growth_pct"] == 50.0
    assert sym["unrealized"] == 2500.0


def test_totals_and_portfolio_growth(pv2):
    out = _detail(pv2, [
        _pos("AOT", "Transport", 100, 50.0, 75.0),    # +2500
        _pos("PTT", "Energy",    100, 30.0, 24.0),    # -600
    ])
    t = out["totals"]
    assert t["cost_base"] == 8000.0
    assert t["market_value"] == 9900.0
    assert t["unrealized"] == 1900.0
    assert t["growth_pct"] == 23.75


def test_weight_drift_shows_the_winner_inflating_the_book(pv2):
    """Equal cost, one doubles: cost weights stay 50/50 while value weights move
    to 67/33. `drift_pp` is exactly the number the old cost-only pie hid."""
    out = _detail(pv2, [
        _pos("WIN",  "Tech",   100, 50.0, 100.0),
        _pos("FLAT", "Energy", 100, 50.0,  50.0),
    ])
    win = next(s for s in out["symbols"] if s["symbol"] == "WIN")
    flat = next(s for s in out["symbols"] if s["symbol"] == "FLAT")
    assert win["weight_cost_pct"] == 50.0
    assert win["weight_mv_pct"] == 66.67
    assert win["drift_pp"] == 16.67
    assert flat["drift_pp"] == -16.67


def test_share_of_gain_attributes_the_profit(pv2):
    out = _detail(pv2, [
        _pos("A", "Tech",   100, 10.0, 40.0),   # +3000
        _pos("B", "Energy", 100, 10.0, 20.0),   # +1000
        _pos("C", "Bank",   100, 10.0,  5.0),   # -500, must not dilute the split
    ])
    by = {s["symbol"]: s for s in out["symbols"]}
    assert by["A"]["share_of_gain_pct"] == 75.0
    assert by["B"]["share_of_gain_pct"] == 25.0
    assert by["C"]["share_of_gain_pct"] == 0.0
    assert out["totals"]["gain_concentration_symbol"] == "A"
    assert out["totals"]["gain_concentration_pct"] == 75.0


def test_lots_of_the_same_symbol_fold_into_one_row(pv2):
    out = _detail(pv2, [
        _pos("AOT", "Transport", 100, 40.0, 60.0, id="l1"),
        _pos("AOT", "Transport", 100, 50.0, 60.0, id="l2"),
    ])
    assert len(out["symbols"]) == 1
    sym = out["symbols"][0]
    assert sym["lots"] == 2
    assert sym["volume"] == 200
    assert sym["cost_base"] == 9000.0
    assert sym["avg_cost"] == 45.0
    assert sym["market_value"] == 12000.0


def test_unpriced_lot_marks_the_symbol_unpriced(pv2):
    """A missing quote must be visible, not silently shrink the market value."""
    out = _detail(pv2, [
        _pos("X", "Tech", 100, 10.0, 20.0, id="l1"),
        _pos("X", "Tech", 100, 10.0, None, id="l2"),
    ])
    sym = out["symbols"][0]
    assert sym["priced"] is False
    assert sym["market_value"] is None
    assert sym["growth_pct"] is None


# ── Cost overrides ───────────────────────────────────────────────────────────

def test_manual_cost_override_drives_growth(pv2):
    """Must agree with the positions table, which renders the override."""
    import db
    with db.get_db() as c:
        c.execute(
            "INSERT INTO position_cost_overrides(account_id,symbol,avg_cost) VALUES(?,?,?)",
            ("acc", "AOT", 25.0),
        )
    out = _detail(pv2, [_pos("AOT", "Transport", 100, 50.0, 75.0)])
    sym = out["symbols"][0]
    assert sym["has_override"] is True
    assert sym["cost_base"] == 2500.0     # override 25, not the 50 lot price
    assert sym["growth_pct"] == 200.0


# ── FX: cost at entry rate, market value at live rate ───────────────────────

def test_foreign_holding_growth_includes_the_currency_move(pv2):
    """USD lot bought at 30 THB/USD and flat in USD is NOT flat in THB — the
    growth is the currency move. Using one rate on both sides would cancel it
    out entirely, which is the bug this endpoint exists to avoid."""
    import portfolio_currency
    live = portfolio_currency.convert_amount(1.0, "USD", "THB")   # live THB/USD
    pos = _pos("AAPL", "Tech", 10, 100.0, 100.0, currency="USD", market="US", exchange_rate=30.0)
    out = _detail(pv2, [pos])
    sym = out["symbols"][0]
    assert sym["cost_base"] == 30000.0                       # 10 × 100 × 30 (entry rate)
    assert sym["market_value"] == round(1000 * live, 2)      # 10 × 100 × live rate
    assert sym["growth_pct"] == round((live / 30 - 1) * 100, 2)


# ── Rebalance sizing ─────────────────────────────────────────────────────────

def test_default_target_is_the_cost_weight(pv2):
    """With no target set, the trade shown is 'trim back to the slice you chose
    to deploy' — the drift column made actionable."""
    out = _detail(pv2, [
        _pos("WIN",  "Tech",   100, 50.0, 100.0),
        _pos("FLAT", "Energy", 100, 50.0,  50.0),
    ])
    win = next(s for s in out["symbols"] if s["symbol"] == "WIN")
    assert win["target_source"] == "cost_weight"
    assert win["target_pct"] == 50.0
    # half the book is 7500; WIN is 10000 → sell 2500 = 25 shares, rounded to the
    # 100-share TH board lot → 0 shares but the value delta still reads -2500
    assert win["delta_value"] == -2500.0
    assert win["action"] == "SELL"
    assert win["lot_size"] == 100


def test_rebalance_shares_and_realized_estimate(pv2):
    """US lot (lot size 1): the share count and the P&L it realises."""
    out = _detail(pv2, [
        _pos("NVDA", "Tech",   100, 100.0, 200.0, market="US", currency="THB"),
        _pos("CASHY", "Bank",  100, 100.0, 100.0, market="US", currency="THB"),
    ])
    nvda = next(s for s in out["symbols"] if s["symbol"] == "NVDA")
    # book MV 30000, target 50% = 15000, NVDA at 20000 → sell 5000 = 25 shares
    assert nvda["delta_shares"] == -25
    assert nvda["est_value"] == 5000.0
    # unrealised on the whole 100 shares is +10000; 25/100 of it is realised
    assert nvda["est_realized"] == 2500.0


def test_explicit_target_and_band(pv2):
    import db
    with db.get_db() as c:
        c.execute(
            "INSERT INTO allocation_targets(id,account_id,scope,key,target_pct,band_pct) "
            "VALUES('t1','all','sector','Tech',40,5)",
        )
    out = _detail(pv2, [
        _pos("A", "Tech",   100, 50.0, 100.0),   # MV 10000
        _pos("B", "Energy", 100, 50.0,  50.0),   # MV  5000
    ])
    tech = next(s for s in out["sectors"] if s["sector"] == "Tech")
    assert tech["target_source"] == "explicit"
    assert tech["target_pct"] == 40.0
    assert tech["weight_mv_pct"] == 66.67
    assert tech["in_band"] is False
    assert tech["delta_value"] == -4000.0        # 40% of 15000 = 6000, holding 10000


def test_position_inside_the_band_is_hold(pv2):
    import db
    with db.get_db() as c:
        c.execute(
            "INSERT INTO allocation_targets(id,account_id,scope,key,target_pct,band_pct) "
            "VALUES('t1','all','sector','Tech',65,5)",
        )
    out = _detail(pv2, [
        _pos("A", "Tech",   100, 50.0, 100.0),
        _pos("B", "Energy", 100, 50.0,  50.0),
    ])
    tech = next(s for s in out["sectors"] if s["sector"] == "Tech")
    assert tech["in_band"] is True
    assert tech["action"] == "HOLD"


def test_sell_never_exceeds_the_shares_held(pv2):
    import db
    with db.get_db() as c:
        c.execute(
            "INSERT INTO allocation_targets(id,account_id,scope,key,target_pct,band_pct) "
            "VALUES('t1','all','symbol','A',0.01,0)",
        )
    out = _detail(pv2, [_pos("A", "Tech", 100, 50.0, 100.0, market="US")])
    a = out["symbols"][0]
    assert a["delta_shares"] == -100      # the whole position, not more
    assert abs(a["est_realized"] - a["unrealized"]) < 0.01


def test_targets_over_100_rejected(pv2):
    body = [
        pv2.AllocationTargetIn(scope="sector", key="Tech", target_pct=70),
        pv2.AllocationTargetIn(scope="sector", key="Energy", target_pct=45),
    ]
    with pytest.raises(Exception):
        pv2.put_allocation_targets(body)


def test_zero_target_clears_the_row(pv2):
    pv2.put_allocation_targets([pv2.AllocationTargetIn(scope="sector", key="Tech", target_pct=30)])
    assert len(pv2.list_allocation_targets(None)["targets"]) == 1
    pv2.put_allocation_targets([pv2.AllocationTargetIn(scope="sector", key="Tech", target_pct=0)])
    assert pv2.list_allocation_targets(None)["targets"] == []


def test_account_specific_target_beats_the_all_default(pv2):
    import db
    with db.get_db() as c:
        c.execute("INSERT INTO allocation_targets(id,account_id,scope,key,target_pct,band_pct) "
                  "VALUES('t1','all','sector','Tech',40,0)")
        c.execute("INSERT INTO allocation_targets(id,account_id,scope,key,target_pct,band_pct) "
                  "VALUES('t2','acc','sector','Tech',20,0)")
    out = _detail(pv2, [_pos("A", "Tech", 100, 50.0, 100.0)], account_id="acc")
    assert out["sectors"][0]["target_pct"] == 20.0


def test_empty_book_does_not_divide_by_zero(pv2):
    out = _detail(pv2, [])
    assert out["totals"]["cost_base"] == 0
    assert out["totals"]["growth_pct"] is None
    assert out["sectors"] == []
