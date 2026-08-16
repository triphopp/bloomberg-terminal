"""
CAPM β/α and the return-alignment engine behind it.

Every test here exists because the previous implementation got it wrong on real
data (`memory/reports/capm-beta-alpha-risk-report.md`):
  * a 19-bar new listing truncated the whole book to 23 observations
  * series were paired by ROW POSITION, so BTC (365 bars/yr) regressed against
    SPY (251) over a different eight months and returned a NEGATIVE beta
  * position values were converted to the report currency but returns were not

The regressions are checked against synthetic series with a beta known by
construction — the only way to catch a pairing bug, since a misaligned
regression still returns a plausible-looking number.
"""
import importlib

import numpy as np
import pandas as pd
import pytest


@pytest.fixture()
def risk(monkeypatch, tmp_path):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "capm.db"))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2()
    import routers.risk as mod
    importlib.reload(mod)
    return mod


def _bdays(n, end="2026-08-14"):
    return pd.bdate_range(end=end, periods=n)


def _series(index, values):
    return pd.Series(values, index=index)


def _prices(index, rets, start=100.0):
    return _series(index, start * np.exp(np.cumsum(rets)))


# ── The regression itself ────────────────────────────────────────────────────

def test_beta_recovers_known_value(risk):
    rng = np.random.default_rng(7)
    idx = _bdays(252)
    bench = rng.normal(0.0004, 0.01, 252)
    port = 1.5 * bench + rng.normal(0, 0.001, 252)      # beta = 1.5 by construction
    out = risk._regress_capm(_series(idx, port), _series(idx, bench), 0.02, 252)
    assert out["beta"] == pytest.approx(1.5, abs=0.05)
    assert out["r_squared"] > 0.95
    assert out["n_days"] == 252


def test_regression_joins_on_date_not_row_position(risk):
    """The BTC bug: a 7-day-a-week series against a 5-day benchmark.

    Same underlying process, so beta is 1.0. Pairing by row position walks the
    two series apart by ~2 days a week and destroys it.
    """
    rng = np.random.default_rng(11)
    cal = pd.date_range(end="2026-08-14", periods=360, freq="D")   # every day
    bench_daily = _series(cal, rng.normal(0, 0.01, 360))
    bdays = cal[cal.dayofweek < 5]
    bench = bench_daily.reindex(bdays)                              # weekdays only
    port = bench_daily + rng.normal(0, 0.0005, 360)                 # 7-day series

    joined = risk._regress_capm(port, bench, 0.02, 252)
    assert joined["beta"] == pytest.approx(1.0, abs=0.05)

    # positional pairing (what the old code did) on the same data
    n = min(len(port), len(bench))
    y, x = port.to_numpy()[-n:], bench.to_numpy()[-n:]
    b_positional = np.cov(y, x, bias=True)[0, 1] / x.var()
    assert abs(b_positional - 1.0) > 0.5     # nowhere near the true beta


def test_short_window_is_refused_not_reported(risk):
    """23 observations answered a 252-day request and printed alpha −178%/yr."""
    idx = _bdays(23)
    rng = np.random.default_rng(3)
    x = rng.normal(0, 0.01, 23)
    out = risk._regress_capm(_series(idx, 1.2 * x), _series(idx, x), 0.02, 252)
    assert out["beta"] is None
    assert out["n_days"] == 23
    # the 1M button must still work
    assert risk._min_regression_days(21) == 20
    assert risk._min_regression_days(252) == 151


def test_non_series_input_is_rejected(risk):
    """Bare arrays carry no dates, so they cannot be joined — refuse them."""
    a = np.random.default_rng(1).normal(0, 0.01, 252)
    assert risk._regress_capm(a, a, 0.02, 252)["beta"] is None


# ── Alignment engine ─────────────────────────────────────────────────────────

def _patch_closes(risk, monkeypatch, frame):
    monkeypatch.setattr(risk, "_fetch_close_frame", lambda syms, days=252: frame[
        [c for c in frame.columns if c in syms]
    ])


def test_new_listing_is_dropped_not_allowed_to_truncate(risk, monkeypatch):
    """SKHU had 19 bars and cut a 15-holding book down to 23 days."""
    rng = np.random.default_rng(2)
    idx = _bdays(252)
    frame = pd.DataFrame({
        "AAA": _prices(idx, rng.normal(0, 0.01, 252)),
        "BBB": _prices(idx, rng.normal(0, 0.01, 252)),
    })
    frame["NEW"] = np.nan
    frame.loc[frame.index[-19:], "NEW"] = _prices(idx[-19:], rng.normal(0, 0.01, 19)).values
    _patch_closes(risk, monkeypatch, frame)

    rets, excluded = risk._aligned_returns(["AAA", "BBB", "NEW"], 252)
    assert list(rets.columns) == ["AAA", "BBB"]
    assert len(rets) > 200                       # the survivors keep their history
    assert excluded[0]["symbol"] == "NEW"
    assert excluded[0]["reason"] == "insufficient history"
    assert excluded[0]["bars"] == 19


def test_closed_market_day_is_a_flat_day_not_a_shift(risk, monkeypatch):
    """A holiday in one market must not slide that market's whole history."""
    rng = np.random.default_rng(4)
    idx = _bdays(252)
    a = _prices(idx, rng.normal(0, 0.01, 252))
    b = a.copy()
    holidays = idx[[50, 120, 200]]
    b.loc[holidays] = np.nan                     # market B shut on those days
    _patch_closes(risk, monkeypatch, pd.DataFrame({"A": a, "B": b}))

    rets, _ = risk._aligned_returns(["A", "B"], 252)
    # identical underlying path → still perfectly correlated after alignment
    assert rets["A"].corr(rets["B"]) > 0.98
    assert rets.index.equals(rets.dropna().index)


def test_fx_translation_adds_the_currency_move(risk, monkeypatch):
    """A USD asset flat in USD is NOT flat for a THB investor."""
    idx = _bdays(120)
    flat = pd.Series(100.0, index=idx)                       # 0% in USD
    fx = pd.Series(np.linspace(30.0, 33.0, 120), index=idx)  # THB per USD, rising
    frame = pd.DataFrame({"US": flat, "THB=X": fx})
    _patch_closes(risk, monkeypatch, frame)

    native, _ = risk._aligned_returns(["US"], 120)
    assert abs(native["US"].sum()) < 1e-9

    translated, _ = risk._aligned_returns(
        ["US"], 120, ccy_map={"US": "USD"}, base_currency="THB"
    )
    assert translated["US"].sum() == pytest.approx(np.log(33.0 / 30.0), abs=1e-6)


def test_base_currency_asset_is_left_alone(risk, monkeypatch):
    idx = _bdays(120)
    rng = np.random.default_rng(6)
    frame = pd.DataFrame({
        "TH.BK": _prices(idx, rng.normal(0, 0.01, 120)),
        "THB=X": pd.Series(np.linspace(30.0, 33.0, 120), index=idx),
    })
    _patch_closes(risk, monkeypatch, frame)
    native, _ = risk._aligned_returns(["TH.BK"], 120)
    translated, _ = risk._aligned_returns(
        ["TH.BK"], 120, ccy_map={"TH.BK": "THB"}, base_currency="THB"
    )
    assert np.allclose(native["TH.BK"].values, translated["TH.BK"].values)


def test_crypto_weekends_do_not_define_the_equity_calendar(risk, monkeypatch):
    rng = np.random.default_rng(8)
    bidx = _bdays(252)
    cidx = pd.date_range(end="2026-08-14", periods=365, freq="D")
    frame = pd.concat([
        _prices(bidx, rng.normal(0, 0.01, 252)).rename("EQ"),
        _prices(cidx, rng.normal(0, 0.03, 365)).rename("BTC-USD"),
    ], axis=1)
    _patch_closes(risk, monkeypatch, frame)
    rets, _ = risk._aligned_returns(["EQ", "BTC-USD"], 252)
    assert (rets.index.dayofweek < 5).all()      # no weekend rows


# ── FX helper ────────────────────────────────────────────────────────────────

def test_fx_close_inverts_and_crosses(risk, monkeypatch):
    idx = _bdays(60)
    frame = pd.DataFrame({
        "THB=X": pd.Series(33.0, index=idx),
        "JPY=X": pd.Series(150.0, index=idx),
    })
    _patch_closes(risk, monkeypatch, frame)
    assert risk._fx_close("USD", "USD", 60) is None
    assert risk._fx_close("USD", "THB", 60).iloc[-1] == pytest.approx(33.0)
    assert risk._fx_close("THB", "USD", 60).iloc[-1] == pytest.approx(1 / 33.0)
    assert risk._fx_close("JPY", "THB", 60).iloc[-1] == pytest.approx(33.0 / 150.0)


def test_benchmark_currency_by_suffix(risk):
    assert risk._benchmark_currency("SPY") == "USD"
    assert risk._benchmark_currency("^SET.BK") == "THB"
    assert risk._benchmark_currency("1306.T") == "JPY"


# ── Portfolio return must weight SIMPLE returns, not log returns ────────────

def test_portfolio_return_weights_simple_returns(risk):
    """Log returns add across time, not across assets. Weighting logs directly
    understated the annualized figure by 53pp on the real book."""
    r = np.array([[np.log(2.0), 0.0], [0.0, 0.0]])       # asset A doubles on day 1
    w = np.array([0.5, 0.5])
    wrong = r @ w                                        # 0.3466 → +41% "portfolio"
    right = np.log1p(np.expm1(r) @ w)                    # 50/50 of (+100%, 0%) = +50%
    assert float(np.expm1(right[0])) == pytest.approx(0.5)
    assert float(np.expm1(wrong[0])) == pytest.approx(0.4142, abs=1e-3)
    assert right[0] > wrong[0]


# ── Alpha must be stated in the same units as the return it sits next to ────

# ── The alpha: RET − [rf + β(IDX − rf)] on numbers a human can re-add ──────
#
# The previous version rebuilt daily weights from the trade log and regressed
# them. That reported +96%/yr alpha for an account whose actual return was
# 3.3%/yr — because 20 of 79 lots carry bulk-import placeholder dates whose
# recorded price is up to 487% away from the market on that day. The identity
# below touches no dates at all.

def _alpha(ret_pct, beta, idx_pct, rf_pct):
    return round(ret_pct - (rf_pct + beta * (idx_pct - rf_pct)), 2)


def test_alpha_identity_holds(risk):
    """Levered book that merely tracked the index has NEGATIVE alpha."""
    # β 2.0, index +18%, rf 1% → owed 1 + 2×17 = 35%. Made 20% → −15%.
    assert _alpha(20.0, 2.0, 18.0, 1.0) == -15.0
    # β 1.0 → alpha is just the lead over the index
    assert _alpha(25.0, 1.0, 18.0, 1.0) == 7.0
    # a defensive book in a crash: owed 1 + 0.2×(−31) = −5.2, lost 5.0 → +0.2
    assert _alpha(-5.0, 0.2, -30.0, 1.0) == pytest.approx(0.2, abs=0.01)


def test_index_return_is_measured_over_the_same_span(risk, monkeypatch):
    """An index number from a different window is not a comparison."""
    idx = _bdays(400, end="2026-08-14")
    prices = pd.Series(np.linspace(100.0, 200.0, 400), index=idx)   # steady doubling
    _patch_closes(risk, monkeypatch, pd.DataFrame({"SPY": prices}))

    full = risk._index_return("SPY", str(idx[0].date()), "USD")
    half = risk._index_return("SPY", str(idx[200].date()), "USD")
    assert full["cumulative_pct"] > half["cumulative_pct"]
    assert full["days"] > half["days"]
    assert full["from"] == str(idx[0].date())
    # annualization is consistent with the cumulative move and the span
    grown = 1 + full["cumulative_pct"] / 100
    assert full["annual_pct"] == pytest.approx(
        ((grown ** (365 / full["days"])) - 1) * 100, abs=0.05
    )


def test_index_return_needs_a_start_date(risk, monkeypatch):
    idx = _bdays(100)
    _patch_closes(risk, monkeypatch, pd.DataFrame({"SPY": pd.Series(100.0, index=idx)}))
    assert risk._index_return("SPY", None, "USD") is None


def test_index_return_is_translated_to_the_report_currency(risk, monkeypatch):
    """A flat USD index is not flat for a THB investor."""
    idx = _bdays(200)
    frame = pd.DataFrame({
        "SPY": pd.Series(100.0, index=idx),
        "THB=X": pd.Series(np.linspace(30.0, 33.0, 200), index=idx),
    })
    _patch_closes(risk, monkeypatch, frame)
    assert risk._index_return("SPY", str(idx[0].date()), "USD")["cumulative_pct"] == 0.0
    thb = risk._index_return("SPY", str(idx[0].date()), "THB")
    assert thb["cumulative_pct"] == pytest.approx(10.0, abs=0.1)   # 33/30 − 1


# ── Risk-free rate ──────────────────────────────────────────────────────────
#
# rf has to be quoted in the currency the returns are in, and at the horizon of
# the return interval. A US Treasury yield against a THB return series books the
# THB–USD rate differential as negative alpha; a 10y yield against daily returns
# charges the book for duration it does not hold.

def test_rf_is_currency_matched(risk, monkeypatch):
    risk._rf_cache.clear()
    monkeypatch.setattr(
        "routers.bot.get_policy_rate", lambda: {"rate": 1.75, "effective_datetime": "2026-06-24"}
    )
    monkeypatch.setattr(
        "routers.global_yields._fred_fetch",
        lambda series, limit=10, obs_start=None: [{"date": "2026-08-13", "value": 4.25}],
    )
    thb = risk._risk_free("THB")
    assert thb["rate"] == pytest.approx(0.0175)
    assert thb["currency"] == "THB"
    assert "BOT" in thb["source"]

    risk._rf_cache.clear()
    usd = risk._risk_free("USD")
    assert usd["rate"] == pytest.approx(0.0425)
    assert usd["series"] == "DGS3MO"
    assert usd["as_of"] == "2026-08-13"


def test_rf_falls_back_without_hiding_it(risk, monkeypatch):
    """A silent default is worse than a stated one — the source says so."""
    risk._rf_cache.clear()
    def boom(*a, **k):
        raise RuntimeError("provider down")
    monkeypatch.setattr("routers.bot.get_policy_rate", boom)
    out = risk._risk_free("THB")
    assert out["rate"] == pytest.approx(risk.RF_FALLBACK["THB"])
    assert "fallback" in out["source"]
    assert out["series"] is None


def test_rf_moves_the_hurdle_in_the_right_direction(risk):
    """β < 1: a higher risk-free rate raises the hurdle, so alpha falls.
    β > 1: the same rise LOWERS the hurdle, because the equity premium it is
    multiplied by shrinks. Coefficient on rf is (1 − β) — easy to get backwards.
    """
    assert _alpha(20.0, 0.5, 18.0, 5.0) < _alpha(20.0, 0.5, 18.0, 0.0)
    assert _alpha(20.0, 2.0, 18.0, 5.0) > _alpha(20.0, 2.0, 18.0, 0.0)
