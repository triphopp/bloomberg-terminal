"""Take-profit rebalance rules (rebalance.py) — no network, no DB."""
from datetime import date

import numpy as np
import pytest

import rebalance as rb
import stop_sim as ss
from guard_scheduler import rebalance_events

TODAY = date(2026, 10, 2)


def _row(symbol="AAA", weight=20.0, target=10.0, growth=50.0, mv=200.0, vol=10.0, **kw):
    r = {"symbol": symbol, "weight_mv_pct": weight, "target_pct": target,
         "target_source": "cost_weight", "band_pct": 0, "growth_pct": growth,
         "unrealized": mv - mv / (1 + growth / 100), "market_value": mv, "volume": vol,
         "price": mv / vol, "instrument": "equity", "priced": True, "yf_symbol": symbol}
    r.update(kw)
    return r


def _plan(rows, total=1000.0, rules=None, **kw):
    return rb.plan(rows, total, rules or rb.Rules(), TODAY, **kw)


def test_band_is_5_points_or_25pct_of_target_whichever_first():
    r = rb.Rules()
    assert rb.band_for(40, r) == 5            # 25% of 40 = 10 → 5 points first
    assert rb.band_for(8, r) == 2             # 25% of 8 = 2 → first
    assert rb.band_for(8, r, explicit_band=3) == 3


def test_winner_over_band_with_gain_trims_halfway_by_default():
    out = _plan([_row()], first_entry={"AAA": "2026-01-01"})
    row = out["rows"][0]
    assert row["status"] == "TRIM"
    # 20% → halfway to 10% = 15% of 1000 = sell 50 = 2.5 shares → whole shares: 2
    assert row["sell_shares"] == 2
    assert row["sell_value"] == pytest.approx(40)
    assert out["trades"] == [{"symbol": "AAA", "delta_shares": -2}]


@pytest.mark.parametrize("to,shares", [("target", 5), ("band", 3)])
def test_rebal_to_target_and_band_edge(to, shares):
    # 20 per share. target: sell 10% of 1000 = 100 → 5. band edge = 10 + min(5, 2.5)
    # = 12.5% → sell 75 → 3.75 → whole shares round DOWN → 3.
    out = _plan([_row()], rules=rb.Rules(rebal_to=to), first_entry={"AAA": "2026-01-01"})
    assert out["rows"][0]["sell_shares"] == shares


def test_gain_below_threshold_is_watch_not_trim():
    out = _plan([_row(growth=10.0)])
    assert out["rows"][0]["status"] == "WATCH"
    assert out["trades"] == []


def test_inside_band_is_ok():
    assert _plan([_row(weight=11.0)])["rows"][0]["status"] == "OK"


def test_near_band_with_gain_is_watch():
    # band 2.5, over 1.8 ≥ 60%
    assert _plan([_row(weight=11.8)])["rows"][0]["status"] == "WATCH"


def test_recent_buy_waits_until_min_hold():
    out = _plan([_row()], first_entry={"AAA": "2026-09-20"})
    row = out["rows"][0]
    assert row["status"] == "WAIT"
    assert row["ready_on"] == "2026-10-20"


def test_recent_sell_waits_min_gap():
    out = _plan([_row()], first_entry={"AAA": "2026-01-01"}, last_sell={"AAA": "2026-09-25"})
    assert out["rows"][0]["status"] == "WAIT"
    assert out["rows"][0]["ready_on"] == "2026-10-25"


def test_earnings_blackout_blocks_and_unknown_dates_warn():
    out = _plan([_row()], first_entry={"AAA": "2026-01-01"}, earnings={"AAA": ["2026-10-04"]})
    row = out["rows"][0]
    assert row["status"] == "WAIT"
    assert row["earnings_window"] == ["2026-10-01", "2026-10-09"]
    assert row["ready_on"] == "2026-10-10"
    out = _plan([_row()], first_entry={"AAA": "2026-01-01"}, earnings={"AAA": []})
    assert out["rows"][0]["status"] == "TRIM"
    assert any("ไม่ทราบวันประกาศงบ" in t for t in out["rows"][0]["reasons"])


def test_set_board_lot_rounds_down_and_small_when_under_one_lot():
    # SET: per share 2, sell 50 → 25 shares → under one 100-share lot
    out = _plan([_row("PTT.BK", vol=100.0, mv=200.0)], first_entry={"PTT.BK": "2026-01-01"})
    assert out["rows"][0]["status"] == "SMALL"
    out = _plan([_row("PTT.BK", vol=1000.0, mv=200.0)], first_entry={"PTT.BK": "2026-01-01"})
    assert out["rows"][0]["sell_shares"] == 200      # 250 → 200


def test_crypto_trims_fractionally():
    out = _plan([_row("BTC-USD", vol=0.01, mv=200.0)], first_entry={"BTC-USD": "2026-01-01"})
    assert out["rows"][0]["status"] == "TRIM"
    assert out["rows"][0]["sell_shares"] == pytest.approx(0.0025)


def test_options_and_unpriced_are_skipped():
    out = _plan([_row(instrument="option"), {**_row("BBB"), "market_value": None, "priced": False}])
    assert {r["status"] for r in out["rows"]} == {"SKIP"}


def test_explicit_target_band_wins():
    out = _plan([_row(target_source="explicit", band_pct=12.0)], first_entry={"AAA": "2026-01-01"})
    assert out["rows"][0]["status"] == "WATCH"     # over 10 < band 12


def test_rules_validation():
    with pytest.raises(ValueError):
        rb.Rules.from_dict({"rebal_to": "all"})
    with pytest.raises(ValueError):
        rb.Rules.from_dict({"band_abs_pp": 0})
    assert rb.Rules.from_dict({"min_gain_pct": "30"}).min_gain_pct == 30.0


def test_alert_is_once_per_iso_week():
    from datetime import datetime, timezone
    out = _plan([_row()], first_entry={"AAA": "2026-01-01"})
    ev = rebalance_events(out, datetime(2026, 10, 2, tzinfo=timezone.utc))
    assert [(e["rule_id"], e["symbol"], e["bar_time"]) for e in ev] == \
        [("guard:REBALANCE", "AAA", "2026-W40")]


# ── stop_sim random-market mode ──────────────────────────────────────────────

def test_random_market_is_one_unpinned_scenario_wider_than_pinned():
    h = ss.Holding(symbol="A", value=100.0, price=100.0, stop=None, factor="M", beta=1.0,
                   resid_vol=0.005)
    cov = np.array([[0.015 ** 2]])
    rnd = ss.simulate([h], cov, ["M"], horizon=20, n_paths=2000, market="random")
    assert rnd["market"] == "random"
    assert len(rnd["scenarios"]) == 1 and rnd["scenarios"][0]["k"] is None
    sc = rnd["scenarios"][0]
    lo, mid, hi = sc["market_move_range"]["M"]
    assert lo < mid < hi
    assert 30 < sc["hold"]["p_loss"] < 70          # zero drift → about a coin flip
    pinned = ss.simulate([h], cov, ["M"], horizon=20, n_paths=2000, scenarios=(0.0,))
    width = lambda s: s["hold"]["final_p90"] - s["hold"]["final_p10"]  # noqa: E731
    assert width(sc) > 2 * width(pinned["scenarios"][0])


def test_do_minus_dont_is_paired_per_path_not_rounded_medians():
    hs = [ss.Holding(symbol=s, value=100.0, price=100.0, stop=None, factor="M", beta=1.0,
                     resid_vol=0.01, key=s) for s in ("A", "B")]
    cov = np.array([[0.01 ** 2]])
    same = ss.simulate(hs, cov, ["M"], horizon=20, n_paths=500, scenarios=(-2.0,))
    assert same["scenarios"][0]["diff_value"] == {"p10": 0.0, "p50": 0.0, "p90": 0.0}
    assert same["scenarios"][0]["p_do_better"] == 0
    # Sell 3% of A into cash in a −2 SD market: a small, NOT 0.01%-quantised gain.
    out = ss.simulate(hs, cov, ["M"], horizon=20, n_paths=500, scenarios=(-2.0,), scale=[0.97, 1.0])
    sc = out["scenarios"][0]
    assert 0 < sc["diff_value"]["p50"] < 0.5
    assert sc["p_do_better"] > 90
