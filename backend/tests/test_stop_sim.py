"""Stop-discipline simulator (no network)."""
import numpy as np
import pytest

import stop_sim as ss

COV = np.array([[0.01 ** 2]])          # one factor, 1% daily


def _h(**kw):
    base = dict(symbol="A", value=100.0, price=100.0, stop=92.0, factor="M", beta=1.0,
                resid_vol=0.01)
    base.update(kw)
    return ss.Holding(**base)


def test_bridge_hits_target_exactly():
    rng = np.random.default_rng(0)
    cov = np.array([[1e-4, 5e-5], [5e-5, 4e-4]])
    f = ss._factor_paths(rng, 50, 20, cov, -2.0)
    target = -2.0 * np.sqrt(np.diag(cov) * 20)
    assert np.allclose(f.sum(axis=1), target)


def test_no_stop_means_disciplined_equals_hold():
    out = ss.simulate([_h(stop=None)], COV, ["M"], horizon=10, n_paths=200)
    for sc in out["scenarios"]:
        assert sc["disciplined"]["p50"] == sc["hold"]["p50"]
        assert sc["stop_prob"]["A"] == 0


def test_stop_caps_loss_in_crash_and_hold_is_worse():
    out = ss.simulate([_h()], COV, ["M"], horizon=20, n_paths=2000, scenarios=(-2.0,))
    sc = out["scenarios"][0]
    # −2 SD over 20d at 1%/day ≈ −8.6% market; the 8% stop fires often.
    assert sc["stop_prob"]["A"] > 40
    assert sc["disciplined"]["final_p10"] > sc["hold"]["final_p10"]
    assert sc["disciplined"]["maxdd_p90"] > sc["hold"]["maxdd_p90"]


def test_holding_below_stop_today_is_sold_on_day_zero():
    out = ss.simulate([_h(price=90.0, stop=92.0)], COV, ["M"], cash=0, horizon=10,
                      n_paths=100, scenarios=(-2.0, 1.0))
    for sc in out["scenarios"]:
        assert sc["disciplined"]["p10"] == [100.0] * 11
        assert sc["stop_prob"]["A"] == 100
    assert out["holdings"][0]["below_stop_now"] is True


def test_cash_dampens_index_and_up_scenario_beats_down():
    out = ss.simulate([_h(stop=None)], COV, ["M"], cash=100.0, horizon=20, n_paths=500)
    by_k = {sc["k"]: sc for sc in out["scenarios"]}
    assert by_k[1.0]["hold"]["final_p50"] > by_k[0.0]["hold"]["final_p50"] > by_k[-2.0]["hold"]["final_p50"]
    # half the book in cash → about half the market move
    assert by_k[-2.0]["market_move_pct"]["M"] == pytest.approx(np.expm1(-2 * 0.01 * np.sqrt(20)) * 100, abs=0.01)
    assert by_k[-2.0]["hold"]["final_p50"] > by_k[-2.0]["market_move_pct"]["M"]


def test_gap_fills_at_close_not_stop():
    # One huge down day: price gaps far through the stop → fill worse than the stop.
    out = ss.simulate([_h(resid_vol=0.0001, stop=99.0)], np.array([[0.05 ** 2]]), ["M"],
                      horizon=1, n_paths=500, scenarios=(-2.0,))
    sc = out["scenarios"][0]
    assert sc["disciplined"]["final_p50"] < -1.0 - 5          # much worse than the −1% stop


# ── what-if: trades today, then optionally stops ─────────────────────────────

def test_selling_everything_today_is_flat_cash():
    out = ss.simulate([_h(stop=None)], COV, ["M"], horizon=10, n_paths=200,
                      scale=[0.0], follow_stops=False, scenarios=(-2.0, 1.0))
    for sc in out["scenarios"]:
        assert sc["disciplined"]["p10"] == [100.0] * 11      # all cash, no move
        assert sc["hold"]["final_p50"] != 0                   # "don't" still rides
    assert out["do_cash"] == pytest.approx(100.0)
    assert out["do_turnover"] == pytest.approx(100.0)


def test_half_trim_halves_the_move_and_scale_one_no_stops_equals_hold():
    half = ss.simulate([_h(stop=None)], COV, ["M"], horizon=20, n_paths=500,
                       scale=[0.5], follow_stops=False, scenarios=(-2.0,))["scenarios"][0]
    assert half["disciplined"]["final_p50"] == pytest.approx(half["hold"]["final_p50"] / 2, rel=0.15)
    same = ss.simulate([_h()], COV, ["M"], horizon=10, n_paths=200,
                       scale=[1.0], follow_stops=False)
    for sc in same["scenarios"]:
        assert sc["disciplined"]["p50"] == sc["hold"]["p50"]
        assert sc["stop_prob"]["A"] == 0


def test_buying_more_uses_cash_and_amplifies():
    out = ss.simulate([_h(stop=None)], COV, ["M"], cash=100.0, horizon=20, n_paths=500,
                      scale=[2.0], follow_stops=False, scenarios=(-2.0,))
    sc = out["scenarios"][0]
    assert out["do_cash"] == pytest.approx(0.0)
    assert sc["disciplined"]["final_p50"] < sc["hold"]["final_p50"]


def test_no_follow_stops_keeps_a_broken_stop_holding():
    out = ss.simulate([_h(price=90.0, stop=92.0)], COV, ["M"], horizon=10, n_paths=100,
                      follow_stops=False, scenarios=(-2.0,))
    sc = out["scenarios"][0]
    assert sc["stop_prob"]["A"] == 0
    assert sc["disciplined"]["p50"] == sc["hold"]["p50"]


def test_key_separates_same_symbol_in_two_accounts():
    hs = [_h(key="acc1|A"), _h(key="acc2|A", price=90.0, stop=92.0)]
    out = ss.simulate(hs, COV, ["M"], horizon=10, n_paths=100, scenarios=(0.0,))
    probs = out["scenarios"][0]["stop_prob"]
    assert set(probs) == {"acc1|A", "acc2|A"}
    assert probs["acc2|A"] == 100
