"""Daily sigma for PORT → POSITIONS — backend/port_sigma.py (no network)."""
import numpy as np
import pytest

import port_sigma as ps


def _lots(**values):
    return [{"yf_symbol": s, "account_id": "a", "sub_port": "", "value": v}
            for s, v in values.items()]


def test_ewma_path_is_out_of_sample():
    r = np.array([0.01] * 30 + [0.10])
    path, nxt = ps.ewma_path(r)
    assert path[-1] == pytest.approx(0.01 ** 2)          # the 10% day is not in its own forecast
    assert nxt == pytest.approx(0.94 * 0.01 ** 2 + 0.06 * 0.10 ** 2)


def test_sigma_follows_the_recent_level_not_the_year():
    rng = np.random.default_rng(0)
    r = rng.standard_normal(252) * 0.01
    r[-30:] *= 3
    R = r.reshape(-1, 1)
    out = ps.compute(_lots(X=100.0), ["X"], R, R)
    assert out["symbols"]["X"]["sigma_pct"] > 2.0        # a plain 252-day SD would say ~1.4
    assert out["total"]["sigma_pct"] == pytest.approx(out["symbols"]["X"]["sigma_pct"], rel=1e-6)


def test_group_sigma_is_not_the_sum_of_its_parts():
    rng = np.random.default_rng(1)
    R = rng.standard_normal((400, 2)) * 0.02             # independent
    out = ps.compute(_lots(A=50.0, B=50.0), ["A", "B"], R, R)
    a, b = out["symbols"]["A"]["sigma_pct"], out["symbols"]["B"]["sigma_pct"]
    assert out["total"]["sigma_pct"] < 0.8 * (a + b) / 2  # ≈ 1/√2 of the average
    assert out["total"]["sigma_amt"] == pytest.approx(out["total"]["sigma_pct"], abs=0.01)


def test_a_short_leg_takes_sigma_away():
    rng = np.random.default_rng(2)
    f = rng.standard_normal(300) * 0.02
    R = np.column_stack([f, f])
    out = ps.compute(_lots(A=100.0, B=-80.0), ["A", "B"], R, R)
    # net 20 on a gross of 180 → a ninth of the single-name sigma
    assert out["total"]["sigma_pct"] == pytest.approx(out["symbols"]["A"]["sigma_pct"] / 9, rel=0.02)
    flat = ps.compute(_lots(A=100.0, B=-100.0), ["A", "B"], R, R)
    assert flat["total"]["sigma_pct"] is None            # no sigma → no z-score, never a division by ~0


def test_fat_tails_put_var_above_the_normal_number():
    rng = np.random.default_rng(3)
    r = rng.standard_t(3, 500) * 0.01
    R = r.reshape(-1, 1)
    t = ps.compute(_lots(X=1000.0), ["X"], R, R)["total"]
    assert t["method"] == "filtered-historical"
    assert t["cvar_pct"] > t["var_pct"] > 0
    assert t["cvar_pct"] / t["var_pct"] > 2.0627 / 1.6449   # fatter than a normal tail
    assert t["var_amt"] == pytest.approx(t["var_pct"] * 10, rel=1e-3)


def test_short_history_is_blank_not_guessed():
    R = np.full((300, 2), np.nan)
    rng = np.random.default_rng(4)
    R[:, 0] = rng.standard_normal(300) * 0.01
    R[-30:, 1] = rng.standard_normal(30) * 0.05          # 30 bars < MIN_OBS
    out = ps.compute(_lots(OLD=90.0, NEW=10.0), ["OLD", "NEW"], R, R)
    assert out["symbols"]["NEW"]["sigma_pct"] is None
    assert out["symbols"]["OLD"]["sigma_pct"] is not None
    assert out["total"]["sigma_pct"] is not None         # the old name still carries the days before


def test_symbol_without_a_column_lowers_coverage():
    rng = np.random.default_rng(5)
    R = (rng.standard_normal(200) * 0.01).reshape(-1, 1)
    out = ps.compute(_lots(A=75.0, GONE=25.0), ["A"], R, R)
    assert out["total"]["coverage_pct"] == 75.0
    assert out["symbols"]["GONE"]["sigma_pct"] is None


def test_between_60_and_120_days_uses_the_normal_tail():
    rng = np.random.default_rng(6)
    R = (rng.standard_normal(90) * 0.01).reshape(-1, 1)
    t = ps.compute(_lots(X=1.0), ["X"], R, R)["total"]
    assert t["method"] == "normal"
    assert t["var_pct"] == pytest.approx(t["sigma_pct"] * 1.6449, rel=1e-3)


def test_one_tick_on_a_penny_stock_is_not_an_event():
    assert ps.set_tick(0.16) == 0.01 and ps.set_tick(12.0) == 0.10 and ps.set_tick(60.5) == 0.25
    rng = np.random.default_rng(7)
    R = (rng.standard_normal(250) * 0.04).reshape(-1, 1)
    out = ps.compute(_lots(**{"DCON.BK": 100.0}), ["DCON.BK"], R, R, prices={"DCON.BK": 0.16})
    row = out["symbols"]["DCON.BK"]
    assert row["coarse"] and row["tick_pct"] == 6.25
    assert row["sigma_eff_pct"] == 6.25 > row["sigma_pct"]
    liquid = ps.compute(_lots(**{"AOT.BK": 100.0}), ["AOT.BK"], R, R, prices={"AOT.BK": 58.25})
    assert not liquid["symbols"]["AOT.BK"]["coarse"]
    assert ps.tick_pct("INTC", 30.0) is None             # step unknown outside SET


def test_accounts_and_sub_ports_are_separate_baskets():
    rng = np.random.default_rng(8)
    R = rng.standard_normal((300, 2)) * [0.01, 0.04]
    lots = [
        {"yf_symbol": "A", "account_id": "fin", "sub_port": "1", "value": 100.0},
        {"yf_symbol": "B", "account_id": "fin", "sub_port": "2", "value": 100.0},
        {"yf_symbol": "B", "account_id": "dime", "sub_port": "", "value": 50.0},
    ]
    out = ps.compute(lots, ["A", "B"], R, R)
    assert set(out["accounts"]) == {"fin", "dime"}
    assert set(out["sub_ports"]) == {"fin::1", "fin::2", "dime::"}
    assert out["sub_ports"]["fin::1"]["sigma_pct"] == out["symbols"]["A"]["sigma_pct"]
    assert out["accounts"]["dime"]["sigma_pct"] == out["symbols"]["B"]["sigma_pct"]
    assert out["total"]["mv"] == 250.0
