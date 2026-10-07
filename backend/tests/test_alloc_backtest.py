"""Allocation rules (alloc_rules.py) and their walk-forward simulator (alloc_backtest.py) — no network."""
import numpy as np
import pandas as pd
import pytest

from analytics import alloc_backtest as B
from analytics import alloc_rules as R

SECTORS = ["XLK", "XLF", "XLV", "XLI", "XLY", "XLP", "XLE", "XLB", "XLU"]


def _inputs(years=6, seed=7) -> B.Inputs:
    rng = np.random.default_rng(seed)
    days = pd.bdate_range("2010-01-01", periods=252 * years)
    cols = ["SPY"] + SECTORS
    drift = np.linspace(0.0002, 0.0006, len(cols))
    rets = rng.normal(drift, 0.01, size=(len(days), len(cols)))
    prices = pd.DataFrame(100 * np.exp(np.cumsum(rets, axis=0)), index=days, columns=cols)
    months = pd.period_range("2000-01", days[-1].to_period("M"), freq="M")
    surveys = pd.DataFrame({"philly": rng.normal(5, 15, len(months)),
                            "empire": rng.normal(5, 15, len(months))}, index=months)
    core_pce = pd.Series(100 * np.cumprod(1 + rng.normal(0.002, 0.0005, len(months))), index=months)
    target = pd.Series(2.0, index=days)
    target.iloc[400:] = 2.25
    target.iloc[900:] = 1.75
    return B.Inputs(prices=prices, tbill=pd.Series(3.0, index=days), surveys=surveys,
                    core_pce=core_pce, fed_target=target)


# ── Rules ─────────────────────────────────────────────────────────────────────

def test_trend_is_on_above_the_ten_month_average_and_off_below():
    rising = pd.Series(np.arange(1.0, 13.0))
    assert R.trend_weight(rising) == 1.0
    assert R.trend_weight(rising[::-1].reset_index(drop=True)) == 0.0
    assert R.trend_weight(rising.iloc[:9]) is None


def test_vol_weight_cuts_exposure_only_when_recent_vol_is_above_its_history():
    rng = np.random.default_rng(1)
    calm = rng.normal(0, 0.005, 600)
    storm = np.concatenate([calm, rng.normal(0, 0.03, 21)])
    quiet = np.concatenate([rng.normal(0, 0.02, 600), rng.normal(0, 0.004, 21)])
    w_storm = R.vol_weight(pd.Series(100 * np.exp(np.cumsum(storm))))
    assert 0 < w_storm < 0.5
    assert R.vol_weight(pd.Series(100 * np.exp(np.cumsum(quiet)))) == 1.0
    assert R.vol_weight(pd.Series(100 * np.exp(np.cumsum(calm[:100])))) is None


def test_momentum_skips_the_latest_month():
    idx = pd.period_range("2020-01", periods=13, freq="M")
    closes = pd.DataFrame({"A": np.linspace(100, 112, 13), "B": [100.0] * 12 + [500.0]}, index=idx)
    scores = R.momentum_scores(closes)
    assert scores["A"] == pytest.approx(111 / 100 - 1)
    assert scores["B"] == pytest.approx(0.0)        # the jump is in the skipped month


def test_universe_needs_thirteen_unbroken_month_ends():
    idx = pd.period_range("2020-01", periods=14, freq="M")
    closes = pd.DataFrame({"OLD": 1.0, "NEW": [np.nan] * 2 + [1.0] * 12}, index=idx)
    assert R.universe(closes) == ["OLD"]


@pytest.mark.parametrize("g, dg, gap, phase", [
    (-0.5, 0.2, 1.0, "Recovery"),
    (-0.5, -0.2, 1.0, "Contraction"),
    (-0.5, 0.0, 1.0, "Contraction"),
    (0.5, -0.1, 1.0, "Slowdown"),
    (0.5, 0.1, 0.4, "Expansion"),
    (0.5, 0.1, 0.41, "Overheat"),
    (0.5, np.nan, 0.1, None),
    (0.5, 0.1, np.nan, None),
])
def test_cycle_phase_quadrants(g, dg, gap, phase):
    assert R.cycle_phase(g, dg, gap) == phase


def test_phase_reads_core_pce_two_months_back_and_nothing_later():
    months = pd.period_range("2005-01", "2020-12", freq="M")
    surveys = pd.DataFrame({"philly": np.linspace(-20, 30, len(months))}, index=months)
    pce = pd.Series(np.linspace(100, 140, len(months)), index=months)
    asof = pd.Period("2015-06", "M")
    base = R.phase_at(surveys, pce, asof)
    later = pce.copy()
    later.loc[asof - 1:] = 1e6                      # anything after m-2 must not matter
    shocked = surveys.copy()
    shocked.loc[asof + 1:] = -1e6
    assert R.phase_at(shocked, later, asof) == base
    expect = (pce[asof - 2] / pce[asof - 14] - 1) * 100 - R.INFLATION_TARGET
    assert base["gap"] == pytest.approx(expect)


def test_growth_composite_keeps_zero_as_neutral_and_scales_each_survey_by_itself():
    months = pd.period_range("2000-01", periods=60, freq="M")
    wave = np.sin(np.arange(60) / 3.0)
    g = R.growth_composite(pd.DataFrame({"a": wave * 30, "b": wave * 3}, index=months))
    one = R.growth_composite(pd.DataFrame({"a": wave * 30}, index=months))
    assert np.allclose(g, one)                     # ten times the swing, same message
    assert np.sign(g.iloc[-1]) == np.sign(wave[-1])


def test_policy_stance_follows_the_last_change_in_the_target():
    days = pd.bdate_range("2020-01-01", periods=10)
    assert R.policy_stance(pd.Series(2.0, index=days)) is None
    assert R.policy_stance(pd.Series([2, 2, 2.25, 2.25, 2.25, 2.25, 2.25, 2.25, 2.25, 2.25], index=days)) == "TIGHTENING"
    assert R.policy_stance(pd.Series([2, 2, 2.25, 2.25, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0], index=days)) == "EASING"
    easing = R.policy_scores("EASING", ["XLY", "XLU", "XLRE"])
    assert list(easing) == [1.0, -1.0, 0.0]
    assert list(R.policy_scores("TIGHTENING", ["XLY", "XLU", "XLRE"])) == [-1.0, 1.0, 0.0]


def test_tilt_weights_sum_to_one_and_stay_inside_the_cap():
    z = R.cross_z(pd.Series(np.arange(9.0), index=SECTORS))
    w = R.tilt_weights(z, cap=0.05)
    assert w.sum() == pytest.approx(1.0)
    assert (w - 1 / 9).abs().max() <= 0.05 + 1e-12
    assert w.idxmax() == SECTORS[-1] and w.idxmin() == SECTORS[0]
    flat = R.tilt_weights(R.cross_z(pd.Series(1.0, index=SECTORS)))
    assert np.allclose(flat, 1 / 9)                 # no information, no tilt


def test_an_outlier_score_cannot_push_a_tilt_past_the_cap():
    z = R.cross_z(pd.Series([0, 0, 0, 0, 0, 0, 0, 0, 50.0], index=SECTORS))
    w = R.tilt_weights(z, cap=0.03)
    assert (w - 1 / 9).abs().max() <= 0.03 + 1e-12


# ── Simulator ─────────────────────────────────────────────────────────────────

def test_schedule_trades_the_day_after_the_last_session_of_the_month():
    days = pd.bdate_range("2021-01-01", "2021-04-15")
    sched = B.schedule(days)
    assert [s.strftime("%Y-%m-%d") for s, _ in sched] == ["2021-01-29", "2021-02-26", "2021-03-31"]
    assert [e.strftime("%Y-%m-%d") for _, e in sched] == ["2021-02-01", "2021-03-01", "2021-04-01"]
    assert all(s == e for s, e in B.schedule(days, exec_lag=0))


def test_signals_do_not_change_when_the_future_is_rewritten():
    inp = _inputs()
    t = inp.prices.index[900]
    t = inp.prices.index[inp.prices.index.to_period("M") == t.to_period("M")][-1]
    base = B.signals_at(inp, t, B.Params())

    future = inp.prices.copy()
    future.loc[future.index > t] *= 3.7
    target = inp.fed_target.copy()
    target.loc[target.index > t] = 9.0
    surveys = inp.surveys.copy()
    surveys.loc[t.to_period("M") + 1:] = 99.0
    pce = inp.core_pce.copy()
    pce.loc[t.to_period("M") - 1:] = 1.0
    bills = inp.tbill.copy()
    bills.loc[bills.index > t] = 50.0
    other = B.signals_at(B.Inputs(future, bills, surveys, pce, target), t, B.Params())

    for key in ("trend", "vol", "universe", "stance", "tbill", "phase", "g", "dg", "gap"):
        assert other[key] == base[key], key
    assert other["momentum"].equals(base["momentum"])


def test_weights_already_traded_survive_a_rewritten_future():
    inp = _inputs()
    cut = inp.prices.index[1000]
    base = B.run(inp)
    prices = inp.prices.copy()
    prices.loc[prices.index > cut] *= np.linspace(1, 4, (prices.index > cut).sum())[:, None]
    other = B.run(B.Inputs(prices, inp.tbill, inp.surveys, inp.core_pce, inp.fed_target))
    for name in ("T", "V", "TV", "M", "C", "P", "MC", "SYS"):
        a, b = base.weights[name], other.weights[name]
        # a trade on the day after `cut` was still decided at or before it
        keep = a.index[a.index <= cut]
        pd.testing.assert_frame_equal(a.loc[keep], b.loc[keep])


def test_sector_strategies_are_fully_invested_and_the_system_holds_cash_for_the_rest():
    result = B.run(_inputs())
    for name in ("EW", "M", "C", "P", "MC"):
        assert np.allclose(result.weights[name].sum(axis=1), 1.0), name
        assert (result.weights[name].sub(1 / len(SECTORS)).abs().max(axis=1) <= 0.05 + 1e-9).all(), name
    exposure = result.weights["TV"]["SPY"].reindex(result.weights["SYS"].index)
    assert np.allclose(result.weights["SYS"].sum(axis=1), exposure)
    assert ((exposure >= 0) & (exposure <= 1)).all()


def test_buy_and_hold_matches_the_price_and_cash_earns_the_bill():
    days = pd.bdate_range("2020-01-01", periods=300)
    prices = pd.DataFrame({"SPY": np.linspace(100, 160, 300)}, index=days)
    trade_days = pd.DatetimeIndex([e for _, e in B.schedule(days)])
    bill = pd.Series(3.65, index=trade_days)

    nav, per = B.simulate(prices, bill, pd.DataFrame({"SPY": 1.0}, index=trade_days))
    assert nav.iloc[-1] == pytest.approx(prices["SPY"][trade_days[-1]] / prices["SPY"][trade_days[0]])
    assert (per["exposure"] == 1.0).all()

    nav, per = B.simulate(prices, bill, pd.DataFrame({"SPY": 0.0}, index=trade_days))
    span = (trade_days[1] - trade_days[0]).days
    assert per["ret"].iloc[0] == pytest.approx(0.0365 * span / 365)
    assert per["ret"].iloc[0] == pytest.approx(per["cash_ret"].iloc[0])
    assert (per["exposure"] == 0.0).all() and (nav.diff().dropna() > 0).all()


def test_cost_is_charged_on_what_is_traded_and_nothing_else():
    days = pd.bdate_range("2020-01-01", periods=130)
    prices = pd.DataFrame({"A": 100.0, "B": 100.0}, index=days)      # flat: any change in NAV is cost
    trade_days = pd.DatetimeIndex([e for _, e in B.schedule(days)])[:4]
    weights = pd.DataFrame({"A": [1.0, 1.0, 0.0, 0.0], "B": [0.0, 0.0, 1.0, 1.0]}, index=trade_days)
    nav, per = B.simulate(prices, pd.Series(0.0, index=trade_days), weights, cost_bps=10)
    assert list(per["traded"]) == pytest.approx([1.0, 0.0, 2.0])      # entry, hold, full switch
    assert per["ret"].iloc[1] == pytest.approx(0.0)
    assert nav.iloc[-1] == pytest.approx((1 - 0.001) * (1 - 0.002))


def test_drifted_weights_are_what_the_next_trade_is_measured_against():
    days = pd.bdate_range("2020-01-01", periods=70)
    prices = pd.DataFrame({"A": 100.0, "B": 100.0}, index=days)
    trade_days = pd.DatetimeIndex([e for _, e in B.schedule(days)])[:3]
    prices.loc[prices.index > trade_days[0], "A"] = 300.0             # A triples in the first period
    weights = pd.DataFrame({"A": 0.5, "B": 0.5}, index=trade_days)
    _, per = B.simulate(prices, pd.Series(0.0, index=trade_days), weights, cost_bps=0)
    # drifted to 75 / 25, so going back to 50 / 50 trades 25 points each way
    assert per["traded"].iloc[1] == pytest.approx(0.5)


# ── Measures and verdicts ─────────────────────────────────────────────────────

def test_max_drawdown_and_sharpe_on_known_series():
    nav = pd.Series([1.0, 1.2, 0.9, 1.0, 1.5])
    assert B.max_drawdown(nav) == pytest.approx(0.9 / 1.2 - 1)
    excess = pd.Series([0.01, 0.03, -0.01, 0.02])
    assert B.sharpe(excess) == pytest.approx(excess.mean() / excess.std(ddof=1) * np.sqrt(12))


def test_information_coefficient_is_one_for_a_perfect_ranking_and_skips_flat_scores():
    days = pd.bdate_range("2020-01-01", periods=3)
    rets = pd.DataFrame([[0.01, 0.02, 0.03], [0.03, 0.02, 0.01], [0.01, 0.02, 0.03]],
                        index=days, columns=list("ABC"))
    scores = pd.DataFrame([[1, 2, 3], [1, 2, 3], [5, 5, 5]], index=days, columns=list("ABC"), dtype=float)
    ic = B.information_coefficient(scores, rets)
    assert list(ic) == pytest.approx([1.0, -1.0])
    assert B.long_short(scores, rets).iloc[0] == pytest.approx(0.02)


def test_bootstrap_separates_a_better_series_and_is_repeatable():
    rng = np.random.default_rng(3)
    common = rng.normal(0.005, 0.04, 360)
    a = pd.Series(common + 0.004 + rng.normal(0, 0.002, 360))
    b = pd.Series(common)
    first = B.bootstrap_delta_sharpe(a, b, runs=500)
    assert first["p_pos"] > 0.95 and first["lo"] < first["delta"] < first["hi"]
    assert B.bootstrap_delta_sharpe(a, b, runs=500) == first
    assert np.isnan(B.bootstrap_delta_sharpe(a.iloc[:10], b.iloc[:10])["delta"])


def test_phase_table_measures_the_favoured_sectors_against_the_rest():
    days = pd.bdate_range("2020-01-01", periods=4)
    rets = pd.DataFrame(0.0, index=days, columns=["XLE", "XLB", "XLK", "XLP"])
    rets[["XLE", "XLB"]] = 0.02
    table = B.phase_table(pd.Series("Overheat", index=days), rets)
    assert table.loc["Overheat", "months"] == 4
    assert table.loc["Overheat", "favoured_minus_rest"] == pytest.approx(0.02)
    assert table.loc["Recovery", "months"] == 0


def test_layer1_verdicts_follow_the_kill_list():
    spy, mix = {"sharpe": 0.5, "max_dd": -0.50}, {"sharpe": 0.5, "max_dd": -0.35}
    good = {"sharpe": 0.7, "max_dd": -0.20}
    assert B.verdict_layer1(good, spy, mix, good, spy, 0.95) == ("VALID", [])
    assert B.verdict_layer1(good, spy, mix, good, spy, 0.80) == ("WEAK", [])
    assert B.verdict_layer1(good, spy, mix, {"sharpe": 0.4}, spy, 0.95) == ("DECAYED", ["L1-K3"])
    assert B.verdict_layer1({"sharpe": 0.4, "max_dd": -0.20}, spy, mix, good, spy, 0.95) == ("DEAD", ["L1-K1"])
    assert B.verdict_layer1({"sharpe": 0.7, "max_dd": -0.40}, spy, mix, good, spy, 0.95) == ("DEAD", ["L1-K2"])


def test_layer2_verdicts_follow_the_kill_list():
    assert B.verdict_layer2({"mean": 0.05, "t": 3.0}, 0.004, [0.04, 0.05, 0.06]) == ("STRONG", [])
    assert B.verdict_layer2({"mean": 0.05, "t": 2.2}, 0.004, [0.04, 0.05, 0.06]) == ("VALID", [])
    assert B.verdict_layer2({"mean": 0.02, "t": 1.1}, 0.004, [0.04, -0.01, 0.06]) == ("WEAK", [])
    assert B.verdict_layer2({"mean": 0.02, "t": 3.0}, 0.004, [0.04, 0.05, -0.01]) == ("UNSTABLE", ["L2-K3"])
    assert B.verdict_layer2({"mean": -0.01, "t": -0.5}, 0.004, [0.0, 0.0, 0.0]) == ("DEAD", ["L2-K1"])
    assert B.verdict_layer2({"mean": 0.02, "t": 2.5}, -0.001, [0.04, 0.05, 0.06]) == ("DEAD", ["L2-K2"])
