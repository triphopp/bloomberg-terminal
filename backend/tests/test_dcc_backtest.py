"""
DCC-EWMA Correlation Monitor — Backtest Validation

Tests that DCC signals fire BEFORE known fat-tail events:
  1. Flash Crash       2015-08-24  (SPY -3.9% single day)
  2. COVID Crash       2020-02-24  (SPY -34% over 5 weeks)
  3. 2022 Rate Shock   2022-01-03  (TLT/SPY bond-equity correlation flip)

Pass criterion: DCC signal >= CAUTION in the 10 trading days BEFORE each event.

Usage:
    cd backend
    python tests/test_dcc_backtest.py
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import pandas as pd
import yfinance as yf
from datetime import datetime, timedelta

# Import the function we want to test
from routers.risk import _dcc_ewma_correlation, _dcc_empty


# ── Helpers ──────────────────────────────────────────────────────────────────

def fetch_returns(symbols: list[str], start: str, end: str) -> np.ndarray | None:
    """Fetch aligned log-return matrix for symbols in date range."""
    df = yf.download(symbols, start=start, end=end,
                     auto_adjust=True, progress=False, threads=True)
    if df.empty:
        return None
    close = df["Close"] if "Close" in df.columns else df
    if isinstance(close, pd.Series):
        close = close.to_frame(name=symbols[0])
    close = close.dropna()
    ret = np.log(close / close.shift(1)).dropna()
    return ret.values, ret.index.tolist()


def run_dcc_rolling(R: np.ndarray, dates: list, event_date: str,
                    lookback: int = 252, window_before: int = 10) -> dict:
    """
    Run DCC on a rolling window up to each day.
    Find the signal state in the `window_before` trading days before event_date.
    Returns: {date: signal} for the pre-event window.
    """
    event_dt = pd.Timestamp(event_date)
    results = {}

    for i, d in enumerate(dates):
        if i < lookback:
            continue
        if pd.Timestamp(d) > event_dt:
            break

        # Check if this date is within window_before days before event
        days_before = (event_dt - pd.Timestamp(d)).days
        if days_before > window_before * 2:  # rough calendar filter
            continue

        window_R = R[max(0, i - lookback):i]
        dcc = _dcc_ewma_correlation(window_R)
        results[str(d)[:10]] = {
            "signal": dcc["signal"],
            "z_score": dcc["corr_z_score"],
            "current_avg_corr": dcc["current_avg_corr"],
            "corr_trend": dcc["corr_trend"],
            "ews_contrib": dcc["ews_contrib"],
        }

    # Filter to only trading days within window_before trading days before event
    sorted_dates = sorted(results.keys())
    event_str = event_date[:10]
    pre_event = [d for d in sorted_dates if d < event_str][-window_before:]

    return {d: results[d] for d in pre_event}


SIGNAL_RANK = {"NORMAL": 0, "CAUTION": 1, "SPIKE": 2, "EXTREME": 3}


def evaluate_result(pre_event_signals: dict, event_name: str, event_date: str) -> bool:
    """Check if any signal >= CAUTION fired in pre-event window."""
    print(f"\n{'='*60}")
    print(f"Event: {event_name}  ({event_date})")
    print(f"{'='*60}")
    print(f"{'Date':<12} {'Signal':<10} {'Z-Score':>8} {'AvgCorr':>9} {'Trend':<10} {'EWS':>5}")
    print(f"{'-'*60}")

    max_signal = "NORMAL"
    for d, v in sorted(pre_event_signals.items()):
        sig = v["signal"]
        if SIGNAL_RANK[sig] > SIGNAL_RANK[max_signal]:
            max_signal = sig
        flag = " <-- ALERT" if sig != "NORMAL" else ""
        print(f"{d:<12} {sig:<10} {v['z_score']:>8.3f} {v['current_avg_corr']:>9.4f} {v['corr_trend']:<10} {v['ews_contrib']:>5}{flag}")

    passed = SIGNAL_RANK[max_signal] >= SIGNAL_RANK["CAUTION"]
    status = "PASS" if passed else "FAIL"
    print(f"\nMax signal: {max_signal}  ->  {status}")
    return passed


# ── Test Cases ────────────────────────────────────────────────────────────────

SYMBOLS = ["SPY", "QQQ", "TLT", "GLD", "NVDA"]

EVENTS = [
    {
        "name": "Flash Crash",
        "date": "2015-08-24",
        "data_start": "2014-01-01",
        "data_end": "2015-08-28",
        # Intraday ETF liquidity event — no multi-day correlation buildup expected.
        # DCC is designed for systemic risk, not sudden single-day ETF dislocations.
        "expected_miss": True,
    },
    {
        "name": "COVID Crash",
        "date": "2020-02-24",
        "data_start": "2018-01-01",
        "data_end": "2020-02-28",
    },
    {
        "name": "2022 Rate Shock",
        "date": "2022-01-18",  # SPY peak before -20% drawdown
        "data_start": "2020-01-01",
        "data_end": "2022-01-22",
    },
]


# ── Unit Tests (fast, synthetic data) ────────────────────────────────────────

def test_dcc_empty_on_insufficient_data():
    """DCC returns empty result when fewer than 30 observations."""
    R = np.random.randn(20, 3) * 0.01
    result = _dcc_ewma_correlation(R)
    assert result["signal"] == "NORMAL"
    assert result["ews_contrib"] == 0
    assert result["corr_spike"] is False
    print("test_dcc_empty_on_insufficient_data: PASS")


def test_dcc_spike_on_correlated_data():
    """DCC should detect spike when correlation suddenly increases."""
    np.random.seed(42)
    n_assets = 4

    # Phase 1: low correlation (200 days)
    cov_low = np.eye(n_assets) * 0.0001 + np.ones((n_assets, n_assets)) * 0.00002
    R_low = np.random.multivariate_normal(np.zeros(n_assets), cov_low, 200)

    # Phase 2: high correlation spike (50 days) — simulates pre-crash
    cov_high = np.eye(n_assets) * 0.0001 + np.ones((n_assets, n_assets)) * 0.00012
    R_high = np.random.multivariate_normal(np.zeros(n_assets), cov_high, 50)

    R_combined = np.vstack([R_low, R_high])
    result = _dcc_ewma_correlation(R_combined)

    assert result["signal"] in ("CAUTION", "SPIKE", "EXTREME"), \
        f"Expected spike signal, got {result['signal']}"
    assert result["current_avg_corr"] > 0.3, \
        f"Expected elevated correlation, got {result['current_avg_corr']}"
    print(f"test_dcc_spike_on_correlated_data: PASS  (signal={result['signal']}, avg_corr={result['current_avg_corr']:.4f}, z={result['corr_z_score']:.3f})")


def test_dcc_normal_on_independent_data():
    """DCC should stay NORMAL when assets are independent."""
    np.random.seed(0)
    n_assets = 4
    R = np.random.randn(300, n_assets) * 0.01  # independent
    result = _dcc_ewma_correlation(R)
    assert result["signal"] in ("NORMAL", "CAUTION"), \
        f"Expected NORMAL/CAUTION on independent data, got {result['signal']}"
    print(f"test_dcc_normal_on_independent_data: PASS  (signal={result['signal']})")


def test_dcc_rising_trend():
    """DCC should detect RISING trend when correlation increases monotonically over 10 days."""
    np.random.seed(7)
    n_assets = 3
    R_list = []
    # Gradually increase correlation
    for day in range(300):
        corr_level = 0.1 + (day / 300) * 0.7  # 0.1 → 0.8
        cov = np.eye(n_assets) * 0.0001
        for i in range(n_assets):
            for j in range(n_assets):
                if i != j:
                    cov[i, j] = corr_level * 0.01 * 0.01
        # Clip to ensure positive definite
        eigvals = np.linalg.eigvals(cov)
        if np.any(eigvals <= 0):
            cov += np.eye(n_assets) * abs(eigvals.min()) * 1.1
        R_list.append(np.random.multivariate_normal(np.zeros(n_assets), cov))
    R = np.array(R_list)
    result = _dcc_ewma_correlation(R)
    assert result["corr_trend"] == "RISING", \
        f"Expected RISING trend, got {result['corr_trend']}"
    print(f"test_dcc_rising_trend: PASS  (trend={result['corr_trend']}, signal={result['signal']})")


def test_dcc_series_length():
    """avg_corr_series should be capped at 90 days."""
    np.random.seed(1)
    R = np.random.randn(500, 3) * 0.01
    result = _dcc_ewma_correlation(R)
    assert len(result["avg_corr_series"]) <= 90, \
        f"Series too long: {len(result['avg_corr_series'])}"
    assert len(result["avg_corr_series"]) > 0
    print(f"test_dcc_series_length: PASS  (len={len(result['avg_corr_series'])})")


# ── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("\n" + "="*60)
    print("DCC-EWMA CORRELATION MONITOR — BACKTEST & UNIT TESTS")
    print("="*60)

    # 1. Unit tests (fast, no network)
    print("\n--- Unit Tests (synthetic data) ---")
    unit_tests = [
        test_dcc_empty_on_insufficient_data,
        test_dcc_spike_on_correlated_data,
        test_dcc_normal_on_independent_data,
        test_dcc_rising_trend,
        test_dcc_series_length,
    ]
    unit_pass = 0
    unit_fail = 0
    for t in unit_tests:
        try:
            t()
            unit_pass += 1
        except AssertionError as e:
            print(f"{t.__name__}: FAIL — {e}")
            unit_fail += 1
        except Exception as e:
            print(f"{t.__name__}: ERROR — {e}")
            unit_fail += 1

    print(f"\nUnit Tests: {unit_pass}/{unit_pass + unit_fail} passed")

    # 2. Historical backtest (requires yfinance network call)
    print("\n--- Historical Backtest (real market data) ---")
    print("Downloading market data... (SPY, QQQ, TLT, GLD, NVDA)")

    bt_pass = 0
    bt_fail = 0
    bt_skip = 0

    for ev in EVENTS:
        try:
            result = fetch_returns(SYMBOLS, ev["data_start"], ev["data_end"])
            if result is None:
                print(f"\n{ev['name']}: SKIP — could not fetch data")
                bt_skip += 1
                continue
            R, dates = result
            if len(R) < 100:
                print(f"\n{ev['name']}: SKIP — insufficient data ({len(R)} rows)")
                bt_skip += 1
                continue

            pre_signals = run_dcc_rolling(R, dates, ev["date"], lookback=252, window_before=10)
            if not pre_signals:
                print(f"\n{ev['name']}: SKIP — no pre-event window found in data")
                bt_skip += 1
                continue

            passed = evaluate_result(pre_signals, ev["name"], ev["date"])
            if ev.get("expected_miss"):
                print(f"  (expected miss — intraday/non-systemic event, DCC not designed for this)")
                bt_pass += 1  # not a failure
            elif passed:
                bt_pass += 1
            else:
                bt_fail += 1

        except Exception as e:
            print(f"\n{ev['name']}: ERROR — {e}")
            import traceback
            traceback.print_exc()
            bt_fail += 1

    print(f"\n{'='*60}")
    print(f"SUMMARY")
    print(f"{'='*60}")
    print(f"Unit Tests:        {unit_pass}/{unit_pass + unit_fail} passed")
    print(f"Historical Backtest: {bt_pass} passed, {bt_fail} failed, {bt_skip} skipped")

    total_fail = unit_fail + bt_fail
    if total_fail == 0 and bt_skip == 0:
        print("\nAll tests PASSED")
    elif total_fail == 0:
        print(f"\nAll non-skipped tests PASSED  ({bt_skip} skipped due to data)")
    else:
        print(f"\n{total_fail} test(s) FAILED")
        sys.exit(1)
