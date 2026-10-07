"""Factor exposure model (factor_exposure.py) — no network, no DB."""
import numpy as np
import pandas as pd
import pytest

import factor_exposure as fx


def _data(n=400, seed=7, lag=0):
    """Two factors, three assets with known betas. `lag` = days asset C answers late."""
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2025-01-01", periods=n)
    f = pd.DataFrame({"MKT_US": rng.normal(0, 0.010, n), "GOLD": rng.normal(0, 0.008, n)}, index=idx)
    mkt_c = f["MKT_US"].shift(lag).fillna(0.0) if lag else f["MKT_US"]
    a = pd.DataFrame({
        "A": 1.2 * f["MKT_US"] + rng.normal(0, 0.004, n),
        "B": 0.5 * f["MKT_US"] + 0.8 * f["GOLD"] + rng.normal(0, 0.004, n),
        "C": 0.9 * mkt_c + rng.normal(0, 0.004, n),
    }, index=idx)
    return a, f


def _beta(out, key):
    return next(r for r in out["factors"] if r["key"] == key)


def test_recovers_known_betas_and_book_beta_is_weighted_sum_of_holdings():
    a, f = _data()
    w = {"A": 0.5, "B": 0.3, "C": 0.1}
    out = fx.analyze(a, w, f, nav=1_000_000, horizon=1)
    assert _beta(out, "MKT_US")["beta"] == pytest.approx(0.5 * 1.2 + 0.3 * 0.5 + 0.1 * 0.9, abs=0.05)
    assert _beta(out, "GOLD")["beta"] == pytest.approx(0.3 * 0.8, abs=0.05)
    assert _beta(out, "MKT_US")["significant"] is True
    for key in ("MKT_US", "GOLD"):
        by_asset = sum(w[r["yf_symbol"]] * r["betas"][key] for r in out["assets"])
        assert _beta(out, key)["beta"] == pytest.approx(by_asset, abs=2e-3)   # rounding only


def test_risk_shares_plus_specific_make_the_whole():
    a, f = _data()
    out = fx.analyze(a, {"A": 0.4, "B": 0.4, "C": 0.2}, f, horizon=5)
    explained = sum(r["risk_share_pct"] for r in out["factors"])
    assert explained == pytest.approx(out["r_squared"] * 100, abs=0.3)
    assert explained + out["specific_pct"] == pytest.approx(100, abs=0.3)
    assert out["factors"][0]["key"] == "MKT_US"          # biggest share first


def test_five_day_window_sees_a_holding_that_answers_a_day_late():
    a, f = _data(lag=1)
    daily = fx.analyze(a[["C"]], {"C": 1.0}, f, horizon=1)
    weekly = fx.analyze(a[["C"]], {"C": 1.0}, f, horizon=5)
    assert abs(_beta(daily, "MKT_US")["beta"]) < 0.2     # same-day beta misses it
    assert _beta(weekly, "MKT_US")["beta"] > 0.6         # 4 of 5 days overlap → ~0.72


def test_impact_is_beta_times_one_month_sd_times_nav():
    a, f = _data()
    out = fx.analyze(a, {"A": 1.0}, f, nav=2_000_000, horizon=1)
    row = _beta(out, "MKT_US")
    sd_1m = f["MKT_US"].std() * np.sqrt(21)
    assert row["sd_1m_pct"] == pytest.approx(sd_1m * 100, abs=0.01)
    assert row["impact_1sd_amount"] == pytest.approx(row["beta"] * sd_1m * 2_000_000, rel=1e-3)
    assert row["top"][0]["symbol"] == "A"


def test_short_history_is_an_error_not_a_number():
    a, f = _data(n=40)
    out = fx.analyze(a, {"A": 1.0}, f, horizon=5)
    assert out["error"] == "not enough history" and out["factors"] == []


def test_home_market_factors_only_for_markets_the_book_holds():
    keys = lambda syms: {f.key for f in fx.factor_set(syms)}
    assert "MKT_TH" not in keys(["AAPL"]) and "CRYPTO" not in keys(["AAPL"])
    assert "MKT_TH" in keys(["AOT.BK", "AAPL"])
    assert "CRYPTO" in keys(["BTC-USD"])
    assert {"MKT_US", "USDTHB", "RATES"} <= keys(["AAPL"])


def test_spread_factor_is_long_minus_short_and_a_missing_leg_drops_it():
    idx = pd.bdate_range("2026-01-01", periods=3)
    legs = pd.DataFrame({"SPY": [0.01, 0.0, -0.01], "IWM": [0.03, 0.0, 0.01]}, index=idx)
    fset = [f for f in fx.FACTORS if f.key in ("MKT_US", "SIZE", "GOLD")]
    frame, missing = fx.factor_returns(legs, fset)
    assert list(frame["SIZE"].round(4)) == [0.02, 0.0, 0.02]
    assert missing == ["GOLD"] and "GOLD" not in frame.columns
    assert fx.tickers(fset) == ["SPY", "IWM", "GLD"]
