"""
TAIL oil balance: the seasonal comparison and the energy read are pure, so they
are pinned here on synthetic weeks — no EIA call.
"""
import pandas as pd

import oil_inventory as oi


def _weekly(values_by_year, last="2026-09-25"):
    """A flat level per year, ending on `last` — newest year last."""
    end = pd.Timestamp(last)
    idx = pd.date_range(end=end, periods=52 * len(values_by_year), freq="7D")
    vals = [v for v in values_by_year for _ in range(52)]
    return pd.Series(vals, index=idx, dtype=float)


def _frame(crude, gasoline, distillate):
    return pd.DataFrame({"crude": _weekly(crude), "gasoline": _weekly(gasoline), "distillate": _weekly(distillate)})


def _price(now, year_ago, q_ago=None):
    idx = pd.date_range(end="2026-09-28", periods=60, freq="7D")
    v = [year_ago] * 60
    v[-14:] = [q_ago if q_ago is not None else now] * 14
    v[-1] = now
    return pd.Series(v, index=idx, dtype=float)


def test_seasonal_uses_same_week_of_previous_five_years():
    s = _weekly([400, 410, 420, 430, 440, 450])
    sea = oi.seasonal(s)
    assert (sea["avg"], sea["low"], sea["high"], sea["years"]) == (420.0, 400.0, 440.0, 5)
    assert oi.seasonal(_weekly([400, 410])) is None  # too little history to call it a norm


def test_snapshot_rows_and_cushion():
    df = _frame([420] * 5 + [399], [220] * 5 + [209], [120] * 5 + [114])
    df.iloc[-2, df.columns.get_loc("crude")] = 401.5
    snap = oi.snapshot(df, {"gasoline_retail": _price(3.3, 3.0)})
    crude = next(r for r in snap["rows"] if r["key"] == "crude")
    assert crude["chg_w"] == -2.5 and crude["vs_5y_pct"] == -5.0 and crude["yoy_pct"] == -5.0
    assert snap["week_ending"] == "2026-09-25"
    assert snap["cushion_vs_5y_pct"] == -5.0
    assert snap["prices"][0]["yoy_pct"] == 10.0


def test_energy_read_depends_on_inflation_state():
    df = _frame([420] * 6, [220] * 6, [120] * 6)
    rising = oi.snapshot(df, {"gasoline_retail": _price(3.6, 3.0)})
    calm = oi.read_energy(rising, "AT TARGET")
    hot = oi.read_energy(rising, "STICKY")
    assert (calm["state"], calm["tone"]) == ("PRICE PRESSURE", "watch")
    assert (hot["state"], hot["tone"]) == ("PRICE PRESSURE", "bad")
    assert hot["cpi_pp_est"] == 0.6 and hot["value"] == 20.0

    flat = oi.snapshot(df, {"gasoline_retail": _price(3.0, 3.0)})
    assert oi.read_energy(flat, "STICKY")["state"] == "NEUTRAL"

    tight = oi.snapshot(_frame([420] * 5 + [390], [220] * 5 + [205], [120] * 5 + [110]),
                        {"gasoline_retail": _price(3.0, 3.0)})
    assert oi.read_energy(tight, "AT TARGET")["state"] == "THIN CUSHION"

    cheap = oi.snapshot(df, {"gasoline_retail": _price(2.6, 3.0)})
    assert (oi.read_energy(cheap)["state"], oi.read_energy(cheap)["tone"]) == ("DISINFLATIONARY", "good")


def test_no_data_is_unknown_not_calm():
    r = oi.read_energy(None, "STICKY")
    assert (r["state"], r["tone"]) == (None, "unknown")
    assert oi.snapshot(None) is None


def test_failed_fetch_is_negative_cached(monkeypatch):
    calls = []

    def boom(today):
        calls.append(1)
        raise RuntimeError("EIA down")

    monkeypatch.setattr(oi, "_cache", oi.TTLCache(ttl=60))
    monkeypatch.setattr(oi, "_failed_at", 0.0)
    monkeypatch.setattr(oi, "_fetch_eia", boom)
    monkeypatch.setattr(oi.last_good, "recall", lambda *a, **k: (None, None))
    assert oi.weekly_frame() == (None, None)
    assert oi.weekly_frame() == (None, None)
    assert len(calls) == 1
