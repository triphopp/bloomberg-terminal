"""
Sanity tests for backend/alerts/operands.py — the indicator subset used by
/api/alerts/scan (rsi/ema/sma/macd/rvol/stochastic + the Bollinger family). Cross-checks
against the already-trusted routers/watchlist_signals.py math and the
frontend's chart/indicators/bollinger*.ts formulas, so a rule's reading
matches what the WATCHLIST panel and chart already show for the same symbol.
Run: cd backend && python -m pytest tests/test_alerts_operands.py -v
"""
import numpy as np
import pandas as pd
import pytest

from alerts.eval import Bars
from alerts.operands import make_resolver
from routers.watchlist_signals import _rsi as watchlist_rsi


def make_bars(close, volume=None, high=None, low=None) -> Bars:
    close = np.asarray(close, dtype=float)
    n = len(close)
    vol = np.asarray(volume if volume is not None else np.ones(n) * 1000, dtype=float)
    hi = np.asarray(high, dtype=float) if high is not None else close
    lo = np.asarray(low, dtype=float) if low is not None else close
    return Bars(open=close, high=hi, low=lo, close=close, volume=vol)


def test_rsi_last_value_matches_watchlist_signals_reference():
    np.random.seed(0)
    close = 100 + np.cumsum(np.random.randn(60))
    bars = make_bars(close)
    resolve = make_resolver(bars)
    series = resolve("rsi", {"period": 14}, "rsi")
    reference = watchlist_rsi(pd.Series(close))  # rounds to 2dp; round ours the same way to compare
    assert round(float(series[-1]), 2) == reference


def test_rsi_warmup_is_nan():
    bars = make_bars(np.arange(1, 30, dtype=float))
    resolve = make_resolver(bars)
    series = resolve("rsi", {"period": 14}, "rsi")
    assert np.all(np.isnan(series[:14]))
    assert not np.isnan(series[14])


def test_ema_matches_pandas_ewm_directly():
    close = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
    bars = make_bars(close)
    resolve = make_resolver(bars)
    series = resolve("ema", {"period": 3}, "value")
    expected = pd.Series(close).ewm(span=3, adjust=False).mean().to_numpy()
    np.testing.assert_allclose(series, expected)


def test_macd_hist_is_zero_for_a_flat_series():
    bars = make_bars([100.0] * 40)
    resolve = make_resolver(bars)
    series = resolve("macd", {"fast": 12, "slow": 26, "signal": 9}, "hist")
    np.testing.assert_allclose(series[-5:], 0.0, atol=1e-9)


def test_rvol_spike_is_detected_and_excludes_todays_bar_from_its_own_baseline():
    volume = [1000.0] * 25 + [5000.0]  # a spike on the last bar
    bars = make_bars([100.0] * 26, volume=volume)
    resolve = make_resolver(bars)
    series = resolve("rvol", {"lookback": 20}, "rvol")
    assert series[-1] == 5.0  # 5000 / 1000 baseline, unpolluted by the spike itself


def test_bollinger_bands_use_population_std_not_sample_std():
    """The frontend computes variance as sum((v-mean)**2)/period (population,
    ddof=0) — pandas' default .std() is ddof=1 (sample) and would silently
    disagree by a few percent if we didn't pin ddof=0 explicitly."""
    np.random.seed(1)
    close = 100 + np.cumsum(np.random.randn(60))
    bars = make_bars(close)
    resolve = make_resolver(bars)
    period, std_dev = 20, 2.0

    upper = resolve("bollinger", {"period": period, "stdDev": std_dev}, "upper")
    middle = resolve("bollinger", {"period": period, "stdDev": std_dev}, "middle")
    lower = resolve("bollinger", {"period": period, "stdDev": std_dev}, "lower")

    window = close[-period:]
    mean = window.mean()
    population_std = np.sqrt(np.mean((window - mean) ** 2))
    assert middle[-1] == pytest.approx(mean)
    assert upper[-1] == pytest.approx(mean + std_dev * population_std)
    assert lower[-1] == pytest.approx(mean - std_dev * population_std)

    sample_std = window.std(ddof=1)  # what pandas' default would have given
    assert upper[-1] != pytest.approx(mean + std_dev * sample_std)


def test_bollinger_b_is_0_at_lower_band_and_1_at_upper_band():
    params = {"period": 20, "stdDev": 2}
    b_low = make_resolver(make_bars([100.0] * 19 + [90.0]))("bollinger-b", params, "b")
    b_high = make_resolver(make_bars([100.0] * 19 + [110.0]))("bollinger-b", params, "b")
    assert b_low[-1] < 0.3  # a low close pulls %B toward/below 0
    assert b_high[-1] > 0.7  # a high close pulls %B toward/above 1


def test_bollinger_b_is_nan_not_a_fabricated_value_when_bandwidth_is_zero():
    bars = make_bars([100.0] * 25)  # perfectly flat -> zero std -> zero bandwidth
    resolve = make_resolver(bars)
    b = resolve("bollinger-b", {"period": 20, "stdDev": 2}, "b")
    assert np.isnan(b[-1])


def test_bb_width_shrinks_during_a_squeeze_and_grows_during_expansion():
    np.random.seed(2)
    quiet = 100 + np.cumsum(np.random.randn(40) * 0.05)  # low-vol
    loud = quiet[-1] + np.cumsum(np.random.randn(40) * 2.0)  # high-vol, continuing from quiet's last price
    close = np.concatenate([quiet, loud])
    bars = make_bars(close)
    resolve = make_resolver(bars)
    width = resolve("bb-width", {"period": 20, "stdDev": 2}, "width")
    assert width[39] < width[-1]  # end of the quiet regime vs. end of the loud regime


def test_sma_matches_plain_rolling_mean():
    close = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
    bars = make_bars(close)
    resolve = make_resolver(bars)
    series = resolve("sma", {"period": 3}, "value")
    expected = pd.Series(close).rolling(3).mean().to_numpy()
    np.testing.assert_allclose(series, expected)


def test_stochastic_k_is_100_at_the_window_high_and_0_at_the_window_low():
    # window of 5: low steadily falling then a sharp rally to a new high
    close = [10, 9, 8, 7, 6, 20]
    bars = make_bars(close, high=[c + 0.5 for c in close], low=[c - 0.5 for c in close])
    resolve = make_resolver(bars)
    k = resolve("stochastic", {"kPeriod": 5, "dPeriod": 3, "smooth": 1}, "k")
    # smooth=1 means %K is unsmoothed -> last bar's close (20+0.5 high) is the
    # window's high, so %K should be at/near 100
    assert k[-1] > 95


def test_stochastic_flat_range_reads_as_50_not_a_divide_by_zero_error():
    bars = make_bars([100.0] * 20, high=[100.0] * 20, low=[100.0] * 20)
    resolve = make_resolver(bars)
    k = resolve("stochastic", {"kPeriod": 5, "dPeriod": 3, "smooth": 1}, "k")
    assert k[-1] == 50.0


def test_stochastic_d_is_the_sma_of_k():
    np.random.seed(3)
    close = 100 + np.cumsum(np.random.randn(50))
    high = close + np.abs(np.random.randn(50))
    low = close - np.abs(np.random.randn(50))
    bars = make_bars(close, high=high, low=low)
    resolve = make_resolver(bars)
    k = resolve("stochastic", {"kPeriod": 14, "dPeriod": 3, "smooth": 3}, "k")
    d = resolve("stochastic", {"kPeriod": 14, "dPeriod": 3, "smooth": 3}, "d")
    expected_d = pd.Series(k).rolling(3).mean().to_numpy()
    np.testing.assert_allclose(d[-10:], expected_d[-10:])


def test_unknown_indicator_raises():
    bars = make_bars([1.0, 2.0, 3.0])
    resolve = make_resolver(bars)
    try:
        resolve("vwap", {}, "value")
        assert False, "expected ValueError"
    except ValueError as e:
        assert "vwap" in str(e)
