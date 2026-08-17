"""Tests for the CBOE volatility-index loader and the tri-state signal frame.

The bug these guard against: v1 read the last non-NaN value off a feed that had
stopped updating a month earlier and compared it against a current one, which
manufactured a VIX term-structure inversion that never happened. Freshness is
therefore the thing under test, not just parsing.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import vol_indices  # noqa: E402
from vol_indices import (  # noqa: E402
    MAX_STALE_DAYS,
    IndexHealth,
    VolFrame,
    _parse_cboe_csv,
    load_vol_indices,
)


# ── CSV parsing ───────────────────────────────────────────────────────────────


def test_parse_ohlc_csv_takes_close():
    text = "DATE,OPEN,HIGH,LOW,CLOSE\n08/13/2026,14.6,14.7,14.1,14.63\n08/14/2026,14.2,14.7,14.1,14.25\n"
    s = _parse_cboe_csv(text, "VIX")
    assert list(s.values) == [14.63, 14.25]
    assert s.index[-1] == pd.Timestamp("2026-08-14")


def test_parse_two_column_csv():
    text = "DATE,VVIX\n08/13/2026,89.42\n08/14/2026,87.48\n"
    s = _parse_cboe_csv(text, "VVIX")
    assert float(s.iloc[-1]) == 87.48


def test_parse_drops_unparseable_rows():
    text = "DATE,SKEW\n08/13/2026,138.0\nnot-a-date,999\n08/14/2026,n/a\n"
    s = _parse_cboe_csv(text, "SKEW")
    assert len(s) == 1
    assert float(s.iloc[0]) == 138.0


def test_parse_empty_csv_returns_empty_series():
    assert _parse_cboe_csv("DATE,VIX\n", "VIX").empty


# ── Freshness ─────────────────────────────────────────────────────────────────


def _series(last: str, days: int = 90, value: float = 20.0) -> pd.Series:
    idx = pd.bdate_range(end=pd.Timestamp(last), periods=days)
    return pd.Series([value] * days, index=idx)


def test_stale_series_is_marked_unusable(monkeypatch):
    """The exact v1 failure: VIX current, VIX9D a month behind."""
    fresh = _series("2026-08-14", value=14.25)
    stale = _series("2026-07-17", value=16.85)

    def fake_load(name):
        return ({"VIX": fresh, "VIX9D": stale}[name], "cboe")

    monkeypatch.setattr(vol_indices, "_load_one", fake_load)
    vf = load_vol_indices(("VIX", "VIX9D"))

    assert vf.usable("VIX")
    assert not vf.usable("VIX9D")
    assert "stale" in vf.health["VIX9D"].reason
    # And crucially the stale value is not readable at all.
    assert vf.value("VIX9D") is None
    assert vf.value("VIX") == 14.25


def test_weekend_gap_is_not_stale(monkeypatch):
    fresh = _series("2026-08-14")
    friday_only = _series("2026-08-13")

    monkeypatch.setattr(
        vol_indices, "_load_one", lambda n: ({"VIX": fresh, "VVIX": friday_only}[n], "cboe")
    )
    vf = load_vol_indices(("VIX", "VVIX"))
    assert vf.usable("VVIX")
    assert vf.health["VVIX"].stale_days <= MAX_STALE_DAYS


def test_missing_series_reports_no_data(monkeypatch):
    monkeypatch.setattr(
        vol_indices,
        "_load_one",
        lambda n: ((_series("2026-08-14"), "cboe") if n == "VIX" else (pd.Series(dtype=float), "none")),
    )
    vf = load_vol_indices(("VIX", "OVX"))
    assert vf.health["OVX"].reason == "no data"
    assert vf.value("OVX") is None
    assert "OVX" in vf.health_payload()["degraded"]
    assert vf.health_payload()["ok"] is False


# ── Statistics ────────────────────────────────────────────────────────────────


def test_zscore_and_percentile():
    idx = pd.bdate_range(end="2026-08-14", periods=100)
    s = pd.Series(list(range(100)), index=idx, dtype=float)
    vf = VolFrame(
        series={"VIX": s},
        health={"VIX": IndexHealth("VIX", True, "cboe", "2026-08-14", 0)},
        reference_date="2026-08-14",
    )
    assert vf.value("VIX") == 99.0
    assert vf.change_1d("VIX") == 1.0
    assert vf.zscore("VIX", 63) > 1.5          # top of a rising ramp
    assert vf.percentile("VIX", 100) == 100.0  # highest print in the window


def test_accessors_return_none_when_unusable():
    vf = VolFrame(
        series={"VIX": _series("2026-07-17")},
        health={"VIX": IndexHealth("VIX", False, "cboe", "2026-07-17", 28, "stale 28d behind VIX")},
    )
    assert vf.value("VIX") is None
    assert vf.zscore("VIX") is None
    assert vf.percentile("VIX") is None
    assert vf.change_1d("VIX") is None


# ── Signal frame: tri-state, and one code path for now/history ───────────────


def test_stale_term_structure_yields_unknown_not_off(monkeypatch):
    from routers import tail_risk

    fresh = _series("2026-08-14", value=14.25)
    vf = VolFrame(
        series={"VIX": fresh, "VIX9D": _series("2026-07-17", value=16.85)},
        health={
            "VIX": IndexHealth("VIX", True, "cboe", "2026-08-14", 0),
            "VIX9D": IndexHealth("VIX9D", False, "cboe", "2026-07-17", 28, "stale 28d behind VIX"),
            "VIX3M": IndexHealth("VIX3M", False, "cboe", None, None, "no data"),
        },
        reference_date="2026-08-14",
    )
    frame, missing = tail_risk._vol_signal_frame(vf)
    assert "vix_term_inversion" not in frame.columns
    assert "vix_term_inversion" in missing
    assert "stale" in missing["vix_term_inversion"]


def test_current_value_is_last_row_of_history_frame(monkeypatch):
    """Header and chart cannot diverge if they read the same frame."""
    from routers import tail_risk

    idx = pd.bdate_range(end="2026-08-14", periods=120)
    # A VIX series that ends in a spike well above its own 20d mean.
    vals = [15.0] * 119 + [45.0]
    vf = VolFrame(
        series={"VIX": pd.Series(vals, index=idx)},
        health={"VIX": IndexHealth("VIX", True, "cboe", "2026-08-14", 0)},
        reference_date="2026-08-14",
    )
    frame, _ = tail_risk._vol_signal_frame(vf)
    assert bool(frame["vix_level"].iloc[-1]) is True
    assert tail_risk._last_bool(frame["vix_level"]) is True


def test_last_bool_is_tri_state():
    from routers import tail_risk

    assert tail_risk._last_bool(pd.Series([True])) is True
    assert tail_risk._last_bool(pd.Series([False])) is False
    assert tail_risk._last_bool(pd.Series(dtype=float)) is None
    assert tail_risk._last_bool(None) is None


def test_wilder_rsi_matches_known_bounds():
    from routers import tail_risk

    idx = pd.bdate_range(end="2026-08-14", periods=60)
    rising = pd.Series([100 + i for i in range(60)], index=idx, dtype=float)
    rsi = tail_risk._wilder_rsi(rising, 14).dropna()
    assert float(rsi.iloc[-1]) == pytest.approx(100.0, abs=0.01)

    falling = pd.Series([200 - i for i in range(60)], index=idx, dtype=float)
    rsi_down = tail_risk._wilder_rsi(falling, 14).dropna()
    assert float(rsi_down.iloc[-1]) == pytest.approx(0.0, abs=0.01)


def test_flow_frame_reports_short_history_instead_of_false():
    from routers import tail_risk

    idx = pd.bdate_range(end="2026-08-14", periods=40)
    market = pd.DataFrame(
        {"spy": range(40), "agg": range(40), "spy_vol": range(40)}, index=idx, dtype=float
    )
    frame, missing = tail_risk._flow_signal_frame(market)
    # 40 bars is not enough for either the 63d volume z or the 252d Layer-A z.
    assert "volume_surge" in missing
    assert "layer_a_bearish" in missing
    assert "need 252" in missing["layer_a_bearish"]
    assert "volume_surge" not in frame.columns
