"""Market event classifier (tail_events) + the MOVE alignment fix.

The day these guard: 2026-09-23. MOVE +17.5%, 10Y +15bp through 5%, TLT -1.6%,
SPY -0.7%, VIX asleep - and TAIL read NORMAL on every dimension. Two separate
failures: the vol frame dropped MOVE's newest bar (VIX calendar), and nothing
anywhere scored the size of a *move*.
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import tail_events as te  # noqa: E402
from vol_indices import IndexHealth, VolFrame  # noqa: E402

N = 320


def _walk(seed: int, start: float, sd: float, log: bool) -> np.ndarray:
    rng = np.random.default_rng(seed)
    steps = rng.normal(0, sd, N)
    return start * np.exp(np.cumsum(steps)) if log else start + np.cumsum(steps)


def _panel() -> pd.DataFrame:
    """A quiet year: every input wanders inside its normal range."""
    idx = pd.bdate_range(end="2026-09-23", periods=N)
    return pd.DataFrame(
        {
            "SPY": _walk(1, 700, 0.008, True),
            "TLT": _walk(2, 85, 0.006, True),
            "GLD": _walk(3, 390, 0.009, True),
            "DXY": _walk(4, 100, 0.003, True),
            "MOVE": _walk(5, 85, 0.03, True),
            "VIX": _walk(6, 15, 0.04, True),
            "UST5Y": _walk(7, 4.6, 0.045, False),
            "UST10Y": _walk(8, 4.8, 0.045, False),
            "UST30Y": _walk(9, 5.1, 0.04, False),
            "SKEW": 145 + np.random.default_rng(10).normal(0, 2, N),
        },
        index=idx,
    )


def _shock(panel: pd.DataFrame) -> pd.DataFrame:
    """Overwrite the last session with the 2026-09-23 moves."""
    p = panel.copy()
    last, prev = p.index[-1], p.index[-2]
    p.loc[last, "MOVE"] = p.loc[prev, "MOVE"] * 1.175
    p.loc[last, "UST10Y"] = p.loc[prev, "UST10Y"] + 0.151
    p.loc[last, "UST5Y"] = p.loc[prev, "UST5Y"] + 0.163
    p.loc[last, "UST30Y"] = p.loc[prev, "UST30Y"] + 0.105
    p.loc[last, "TLT"] = p.loc[prev, "TLT"] * (1 - 0.016)
    p.loc[last, "SPY"] = p.loc[prev, "SPY"] * (1 - 0.0072)
    p.loc[last, "GLD"] = p.loc[prev, "GLD"] * (1 - 0.018)
    p.loc[last, "DXY"] = p.loc[prev, "DXY"] * 1.0066
    p.loc[last, "VIX"] = p.loc[prev, "VIX"] * 1.02
    return p


def _ids(out: dict) -> dict[str, dict]:
    return {e["id"]: e for e in out["events"]}


# ── Quiet market stays quiet ──────────────────────────────────────────────────


def test_quiet_panel_raises_no_rates_or_cross_asset_event():
    ids = _ids(te.run(_panel(), log_sessions=0))
    assert "rates_vol_shock" not in ids
    assert "treasury_selloff" not in ids
    assert "joint_drawdown" not in ids


def test_skew_at_its_usual_level_is_not_tail_hedging():
    """SKEW 145 was the 1-year median in 2026-09; the old '> 145' rule lit daily."""
    p = _panel()
    p.iloc[-1, p.columns.get_loc("SKEW")] = 146.0   # above 145, inside its own range
    assert "tail_hedging" not in _ids(te.run(p, log_sessions=0))


# ── The 2026-09-23 session ────────────────────────────────────────────────────


def test_rates_shock_day_is_named_and_raises_composite():
    out = te.run(_shock(_panel()), log_sessions=0)
    ids = _ids(out)
    assert out["asof"] == "2026-09-23"
    assert "rates_vol_shock" in ids
    assert "treasury_selloff" in ids
    # 5Y +16bp vs 30Y +10.5bp -> the belly led: flattening, not steepening.
    assert ids["treasury_selloff"]["name"] == "Treasury Selloff — Bear Flattening"
    assert "joint_drawdown" in ids
    # VIX barely moved: the event must say the stress is confined to rates.
    assert "VIX ไม่ยืนยัน" in ids["rates_vol_shock"]["summary"]
    floor, rule = te.event_floor_from_dicts(out["events"])
    assert floor in ("CAUTION", "ELEVATED", "HIGH"), rule


def test_evidence_lists_trigger_and_checked_context():
    ev = _ids(te.run(_shock(_panel()), log_sessions=0))["rates_vol_shock"]["evidence"]
    roles = {(e["key"], e["role"]) for e in ev}
    assert ("MOVE", "trigger") in roles
    assert ("VIX", "context") in roles      # checked, did not confirm - still shown


def test_event_log_reports_the_shock_day():
    out = te.run(_shock(_panel()), log_sessions=5)
    assert out["log"] and out["log"][0]["date"] == "2026-09-23"


# ── Change maths ──────────────────────────────────────────────────────────────


def test_change_is_measured_against_last_observed_bar_not_filled_gap():
    """Yahoo had no MOVE bar on 2026-09-22. The 09-23 change must be 09-21 -> 09-23,
    and 09-22 itself must have no reading rather than a zero move."""
    p = _shock(_panel())
    gap = p.index[-2]
    p.loc[gap, "MOVE"] = np.nan
    prep = te.prepare(p)
    assert "MOVE" not in te.readings_at(prep, gap)
    r = te.readings_at(prep, p.index[-1])["MOVE"]
    expected = np.log(p["MOVE"].iloc[-1] / p["MOVE"].iloc[-3]) * 100
    assert r.chg1 == pytest.approx(expected)


def test_flat_series_has_no_z_rather_than_a_fake_sigma():
    c = pd.Series([1.0] * 201)
    assert te._z_of_change(c.diff()).dropna().empty


def test_grade_tiers():
    assert te.grade(1.9, 5) is None
    assert te.grade(2.1, 0) == "WATCH"
    assert te.grade(2.1, 2) == "ACTIVE"
    assert te.grade(3.2, 0) == "ACTIVE"
    assert te.grade(3.2, 2) == "SEVERE"
    assert te.grade(-4.5, 0) == "SEVERE"


def test_event_floor_counts_channels_not_events():
    def e(ch, sev):
        return {"id": ch + sev, "name": "", "channel": ch, "severity": sev, "score": 3}

    floor = lambda evs: te.event_floor_from_dicts(evs)[0]  # noqa: E731
    assert floor([]) == "NORMAL"
    assert floor([e("rates", "WATCH")]) == "NORMAL"
    # Two SEVERE rates events are one channel.
    assert floor([e("rates", "SEVERE"), e("rates", "SEVERE")]) == "CAUTION"
    assert floor([e("rates", "SEVERE"), e("cross_asset", "ACTIVE")]) == "ELEVATED"
    assert floor([e("rates", "SEVERE"), e("credit", "SEVERE"), e("fx", "SEVERE")]) == "HIGH"
    assert te.max_level("NORMAL", "CAUTION") == "CAUTION"
    assert te.max_level("HIGH", "CAUTION") == "HIGH"


def test_catalyst_window():
    cats = [("2026-09-16", "FOMC")]
    assert te.catalyst_for(date(2026, 9, 17), cats) == "FOMC 09-16"
    assert te.catalyst_for(date(2026, 9, 23), cats) is None


# ── Real yields ───────────────────────────────────────────────────────────────


def _reading(key, chg, d="2026-09-23", value=1.0, z=0.0):
    return te.Reading(key=key, value=value, chg1=chg, chg5=chg, z1=z, z5=z, lz63=None, date=d)


def test_decompose_refuses_legs_from_different_sessions():
    """2026-09-23: DFII10 was still 09-22's +1bp while the nominal 10Y moved
    +15bp — pairing them called a real-rate day an inflation scare."""
    F = {
        "UST10Y": _reading("UST10Y", 15.1),
        "BE10": _reading("BE10", 2.0),
        "REAL10": _reading("REAL10", 1.0, d="2026-09-22"),
    }
    assert te.decompose(F, "10") == (None, None)
    F["REAL10"] = _reading("REAL10", 13.1)
    assert te.decompose(F, "10") == (13.1, 2.0)


def test_real_yield_extension_anchors_on_common_date():
    from routers import tail_risk

    idx = pd.to_datetime(["2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23"])
    cols = {
        "REAL10": pd.Series([2.68, 2.62, 2.63], index=idx[:3]),
        # Yahoo has no nominal bar on 09-22.
        "UST10Y": pd.Series([4.95, 4.963, 5.114], index=idx[[0, 1, 3]]),
        "BE10": pd.Series([2.33, 2.34, 2.33, 2.35], index=idx),
    }
    last = tail_risk._extend_real_yield(cols, "REAL10", "UST10Y", "BE10")
    assert last == "2026-09-22"
    est = cols["REAL10"].iloc[-1]
    # anchor 09-21: 2.62 + (5.114 − 4.963) − (2.35 − 2.34)
    assert est == pytest.approx(2.62 + 0.151 - 0.01)
    assert cols["REAL10"].index[-1] == pd.Timestamp("2026-09-23")


# ── Energy: crack spreads + futures rolls ─────────────────────────────────────


def test_crack_spread_formulas():
    from routers import tail_risk

    idx = pd.to_datetime(["2026-09-23"])
    cols = {
        "CRUDE": pd.Series([92.16], index=idx), "HO": pd.Series([4.776], index=idx),
        "RB": pd.Series([3.587], index=idx), "BRENT": pd.Series([103.08], index=idx),
    }
    tail_risk._energy_spreads(cols)
    assert cols["DIESEL_CRACK"].iloc[0] == pytest.approx(4.776 * 42 - 92.16)
    assert cols["GAS_CRACK"].iloc[0] == pytest.approx(3.587 * 42 - 92.16)
    assert cols["CRACK_321"].iloc[0] == pytest.approx((2 * 3.587 * 42 + 4.776 * 42 - 3 * 92.16) / 3)
    assert cols["BRENT_WTI"].iloc[0] == pytest.approx(103.08 - 92.16)


def test_wti_roll_calendar():
    rolls = te.wti_roll_dates(range(2026, 2027))
    # Oct contract: 25 Sep 2026 is a Friday → last trade Tue 22 Sep → roll Wed 23 Sep.
    assert pd.Timestamp("2026-09-23") in rolls
    assert pd.Timestamp("2026-09-01") in te.month_start_roll_dates(range(2026, 2027))


def test_roll_day_change_is_masked_not_scored():
    """The CL=F contract switch on 2026-09-23 printed a +$6 Brent–WTI jump."""
    idx = pd.bdate_range(end="2026-09-30", periods=N)
    rng = np.random.default_rng(3)
    spread = pd.Series(4 + np.cumsum(rng.normal(0, 0.2, N)), index=idx)
    spread[pd.Timestamp("2026-09-23"):] += 6.0          # the roll gap
    prep = te.prepare(pd.DataFrame({"BRENT_WTI": spread}))
    on_roll = te.readings_at(prep, pd.Timestamp("2026-09-23"))["BRENT_WTI"]
    assert on_roll.chg1 is None and on_roll.z1 is None
    assert on_roll.chg5 is None                          # 5d window spans it too
    spans = te.readings_at(prep, pd.Timestamp("2026-09-29"))["BRENT_WTI"]
    assert spans.chg1 is not None and spans.chg5 is None  # 09-22 → 09-29 crosses the gap
    clean = te.readings_at(prep, pd.Timestamp("2026-09-30"))["BRENT_WTI"]
    assert clean.chg5 is not None                          # 09-23 → 09-30 is post-roll only


# ── Yahoo throttle: last-good fallback ───────────────────────────────────────


@pytest.fixture
def fresh_tail_risk(monkeypatch, tmp_path):
    from routers import tail_risk

    import last_good

    monkeypatch.setattr(last_good, "DIR", tmp_path)
    last_good.reset()
    for k in ("history", "tail"):
        tail_risk._xa_cache._store.pop(k, None)
    return tail_risk


def test_failed_pull_serves_last_good_panel_with_age(fresh_tail_risk, monkeypatch):
    """2026-09-24 19:57: Yahoo returned empty for every ticker; TAIL showed
    'EVENT CLASSIFIER NO DATA' instead of the panel it had minutes earlier."""
    tr = fresh_tail_risk
    good = _panel()
    monkeypatch.setattr(tr, "_download_panel", lambda period: good)
    panel, stale = tr._fetch_cross_asset()
    assert stale is None and panel is not None

    for k in ("history", "tail"):
        tr._xa_cache._store.pop(k, None)
    monkeypatch.setattr(tr, "_download_panel", lambda period: None)
    panel, stale = tr._fetch_cross_asset()
    assert panel is not None and stale is not None and stale >= 0


def test_last_good_survives_backend_restart(fresh_tail_risk, monkeypatch):
    tr = fresh_tail_risk
    tr._remember("xa_panel", _panel())
    import last_good

    last_good.reset()                                   # simulate a restart
    val, age = tr._recall("xa_panel")
    assert val is not None and len(val) == N


def test_tail_refresh_overlays_history_per_column(fresh_tail_risk, monkeypatch):
    """A ticker missing from the 5-day refresh keeps its history."""
    tr = fresh_tail_risk
    hist = _panel()
    tail = hist.tail(5)[["SPY"]] * 1.01                 # only SPY came back

    monkeypatch.setattr(tr, "_download_panel", lambda period: hist if period == "2y" else tail)
    panel, _ = tr._fetch_cross_asset()
    assert panel["SPY"].iloc[-1] == pytest.approx(hist["SPY"].iloc[-1] * 1.01)
    assert panel["MOVE"].iloc[-1] == pytest.approx(hist["MOVE"].iloc[-1])


# ── Vol frame alignment (the bug that hid the MOVE bar) ───────────────────────


def test_move_bar_newer_than_vix_is_not_dropped():
    from routers import tail_risk

    vix_idx = pd.bdate_range(end="2026-09-22", periods=120)
    move_idx = vix_idx[:-1].append(pd.DatetimeIndex(["2026-09-23"]))  # no 09-22 bar
    move_vals = [80.0 + (i % 3) for i in range(119)] + [95.45]
    vf = VolFrame(
        series={
            "VIX": pd.Series(15.0 + (np.arange(120) % 2), index=vix_idx),
            "MOVE": pd.Series(move_vals, index=move_idx),
        },
        health={
            "VIX": IndexHealth("VIX", True, "cboe", "2026-09-22", 0),
            "MOVE": IndexHealth("MOVE", True, "yfinance", "2026-09-23", 0),
        },
        reference_date="2026-09-22",
    )
    frame, _ = tail_risk._vol_signal_frame(vf)
    assert frame.index[-1] == pd.Timestamp("2026-09-23")
    assert bool(frame["move_spike"].iloc[-1]) is True
