"""Reg T margin engine (backend/margin.py) — hand-computed cases."""
import pytest

from margin import (
    Book, OptionLine, Settings, StockLine, analyse, distance_to_call, evaluate,
    level_for, option_requirements, with_trade,
)


def stock(key, qty, price, usd=True):
    return StockLine(key, key, qty, price, usd)


def opt(u, t, k, qty, mark, spot, expiry="2026-12-18", mult=100):
    return OptionLine(u, f"{u} {k}{t[0].upper()}", t, k, expiry, qty, mult, mark, spot)


def test_two_to_one_long_on_margin():
    # $100k equity, $200k of stock → $100k loan.
    book = Book(cash=-100_000, stocks=[stock("AAPL", 2000, 100)], options=[])
    r = evaluate(book, Settings())
    assert r["nlv"] == pytest.approx(100_000)
    assert r["elv"] == pytest.approx(100_000)
    assert r["maint_margin"] == pytest.approx(50_000)      # 25%
    assert r["initial_margin"] == pytest.approx(100_000)   # 50%
    assert r["excess_liquidity"] == pytest.approx(50_000)
    assert r["available_funds"] == pytest.approx(0)
    assert r["cushion"] == pytest.approx(0.5)
    assert r["loan"] == pytest.approx(100_000)
    assert r["level"] == "SAFE"
    # −100k + 0.75·200k·(1−d) = 0 → d = 1/3
    assert distance_to_call(book, Settings()) == pytest.approx(1 / 3, abs=1e-4)


def test_cash_account_never_reaches_a_call():
    book = Book(cash=5_000, stocks=[stock("MSFT", 10, 400)], options=[])
    r = analyse(book, Settings())
    assert r["drop_to_call"] is None
    assert r["uses_margin"] is False
    assert r["assets"][0]["level"] == "SAFE"


def test_naked_put_reg_t():
    # short 1 put K100, S105, mark 2: max(2 + 21 − 5, 2 + 10) = 18/sh
    book = Book(cash=10_200, stocks=[], options=[opt("XYZ", "put", 100, -1, 2.0, 105)])
    r = evaluate(book, Settings())
    assert r["maint_margin"] == pytest.approx(1_800)
    assert r["nlv"] == pytest.approx(10_000)
    assert r["elv"] == pytest.approx(10_200)       # option value has no loan value
    assert r["excess_liquidity"] == pytest.approx(8_400)
    assert r["lines"][0]["rate_source"] == "NAKED"


def test_naked_call_floor_and_index_rate():
    # deep OTM call: 20%·S − OTM < 10%·S → floor wins. S100 K150 mark .1 → .1 + 10 = 10.1
    o = opt("XYZ", "call", 150, -2, 0.1, 100)
    reqs = option_requirements(Book(0, [], [o]))
    assert reqs[0]["req"] == pytest.approx(10.1 * 100 * 2)
    # broad index 15%: SPX S5000 K5000 ATM mark 50 → 50 + 750 = 800/unit
    spx = opt("SPX", "call", 5000, -1, 50, 5000)
    assert option_requirements(Book(0, [], [spx]))[0]["req"] == pytest.approx(80_000)


def test_covered_call_needs_nothing():
    book = Book(cash=0, stocks=[stock("KO", 100, 50)], options=[opt("KO", "call", 55, -1, 1.0, 50)])
    r = evaluate(book, Settings())
    assert r["maint_margin"] == pytest.approx(1_250)   # only the stock's 25%
    call = [ln for ln in r["lines"] if ln["kind"] == "option"][0]
    assert call["rate_source"] == "COVERED" and call["maint"] == 0


def test_partial_cover_rest_naked():
    book = Book(cash=0, stocks=[stock("KO", 100, 50)], options=[opt("KO", "call", 55, -2, 1.0, 50)])
    reqs = option_requirements(book)
    assert reqs[0]["covered"] == 1 and reqs[0]["naked"] == 1
    # naked leg: max(1 + 10 − 5, 1 + 5) = 6 → 600
    assert reqs[0]["req"] == pytest.approx(600)


def test_put_credit_spread_is_max_loss():
    book = Book(cash=10_000, stocks=[], options=[
        opt("XYZ", "put", 100, -1, 3.0, 102), opt("XYZ", "put", 95, 1, 1.0, 102)])
    reqs = option_requirements(book)
    assert reqs[0]["req"] == pytest.approx(500)
    assert reqs[0]["method"] == "SPREAD"
    assert reqs[1]["req"] == 0


def test_spread_needs_long_expiring_no_earlier():
    book = Book(cash=0, stocks=[], options=[
        opt("XYZ", "put", 100, -1, 3.0, 102, expiry="2026-12-18"),
        opt("XYZ", "put", 95, 1, 1.0, 102, expiry="2026-11-20")])
    assert option_requirements(book)[0]["method"] == "NAKED"


def test_short_stock_finra_floors():
    low = Book(cash=8_000, stocks=[stock("PENNY", -1000, 4.0)], options=[])
    assert evaluate(low, Settings())["maint_margin"] == pytest.approx(4_000)   # max($2.5, 100%)
    mid = Book(cash=16_000, stocks=[stock("MID", -1000, 8.0)], options=[])
    assert evaluate(mid, Settings())["maint_margin"] == pytest.approx(5_000)   # max($5, 30%)
    high = Book(cash=200_000, stocks=[stock("BIG", -1000, 100.0)], options=[])
    assert evaluate(high, Settings())["maint_margin"] == pytest.approx(30_000)


def test_override_replaces_maint_rate():
    st = Settings(overrides={"TQQQ": 0.75})
    r = evaluate(Book(cash=0, stocks=[stock("TQQQ", 100, 50)], options=[]), st)
    assert r["maint_margin"] == pytest.approx(3_750)
    assert r["initial_margin"] == pytest.approx(3_750)   # max(initial, override)
    assert r["lines"][0]["rate_source"] == "OVERRIDE"


def test_levels():
    th = Settings().thresholds
    assert level_for(0.30, 1, th) == "SAFE"
    assert level_for(0.15, 1, th) == "WATCH"
    assert level_for(0.07, 1, th) == "WARNING"
    assert level_for(0.02, 1, th) == "DANGER"
    assert level_for(-0.01, -1, th) == "LIQUIDATION"


def test_short_put_gets_worse_as_market_falls():
    # $3k equity writing a 100-strike put: a fall adds intrinsic and requirement.
    book = Book(cash=3_200, stocks=[], options=[opt("XYZ", "put", 100, -1, 2.0, 105)])
    d = distance_to_call(book, Settings())
    assert d is not None and 0 < d < 0.25
    # a rally never hurts a short put
    assert distance_to_call(book, Settings(), direction=+1, limit=1.0) is None


def test_per_asset_distance_and_ranking():
    book = Book(cash=-60_000, stocks=[stock("A", 500, 100), stock("B", 500, 100)], options=[])
    r = analyse(book, Settings())
    # EL = −60k + .75·100k = 15k; A alone: .75·50k·d = 15k → d = .4
    a = next(x for x in r["assets"] if x["key"] == "A")
    assert a["drop_to_call"] == pytest.approx(0.4, abs=1e-4)
    assert a["mm_share"] == pytest.approx(0.5)
    assert r["drop_to_call"] == pytest.approx(0.2, abs=1e-4)
    assert r["level"] == "SAFE"   # cushion 15k / 40k


def test_already_liquidating():
    book = Book(cash=-90_000, stocks=[stock("A", 1000, 100)], options=[])
    r = analyse(book, Settings())
    assert r["excess_liquidity"] < 0
    assert r["level"] == "LIQUIDATION"
    assert r["drop_to_call"] == 0.0
    assert r["assets"][0]["level"] == "LIQUIDATION"


def test_with_trade_pro_forma():
    book = Book(cash=50_000, stocks=[stock("A", 100, 100)], options=[])
    after = with_trade(book, stock=stock("A", 1000, 100), cash_delta=-100_000)
    r = evaluate(after, Settings())
    assert after.stocks[0].qty == 1100
    # ELV = −50k + 110k = 60k; IM = 55k → AF 5k
    assert r["available_funds"] == pytest.approx(5_000)
