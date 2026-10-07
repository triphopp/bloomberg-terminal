"""Business-cycle readings (cycle.py) and their router's fetch guard — no network."""
import math

import numpy as np
import pandas as pd
import pytest

import cycle


def _m(values, start="2000-01"):
    return pd.Series(list(values), index=pd.period_range(start, periods=len(values), freq="M"), dtype=float)


def _dated(values, start="2000-01-01", freq="MS"):
    return pd.Series(list(values), index=pd.date_range(start, periods=len(values), freq=freq), dtype=float)


# ── Published arithmetic ──────────────────────────────────────────────────────

def test_bond_equivalent_is_the_estrella_trubin_conversion():
    out = cycle.bond_equivalent(pd.Series([5.0]))
    assert out.iloc[0] == pytest.approx(100 * (365 * 0.05) / (360 - 91 * 0.05))
    assert out.iloc[0] > 5.0


def test_recession_probability_uses_the_published_coefficients():
    cdf = lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2)))  # noqa: E731
    assert cycle.recession_probability(0.0) == pytest.approx(cdf(-0.6045))
    assert cycle.recession_probability(-1.0) == pytest.approx(cdf(-0.6045 + 0.7374))
    spreads = pd.Series([3.0, 0.0, -2.0])
    probs = cycle.recession_probability(spreads)
    assert probs.is_monotonic_increasing and probs.iloc[0] < 0.01 < 0.5 < probs.iloc[2]


def test_recession_probability_rule_needs_three_months_each_way():
    values = _m([10, 85, 90, 10, 85, 90, 95, 70, 15, 10, 30, 15, 10, 5])
    on = cycle.hysteresis(values, cycle.CP_START, cycle.CP_END, cycle.CP_RUN)
    assert not on.iloc[:6].any()                 # two months above 80 is not a signal
    assert on.iloc[6]                            # the third is
    assert on.iloc[7:13].all()                   # 15, 10 then 30 breaks the run below 20
    assert not on.iloc[13]                       # 15, 10, 5 ends it


def test_gdp_index_turns_on_above_67_and_off_only_below_33():
    values = pd.Series([10, 70, 50, 40, 30, 20], index=pd.period_range("2008Q1", periods=6, freq="Q"), dtype=float)
    assert list(cycle.hysteresis(values, cycle.HAMILTON_START, cycle.HAMILTON_END)) == [False, True, True, True, False, False]


def test_runs_merge_and_since():
    on = _m([0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1]) > 0
    spans = cycle.runs(on)
    assert [(str(a), str(b)) for a, b in spans] == [("2000-02", "2000-03"), ("2000-06", "2000-06"), ("2000-12", "2001-01")]
    merged = cycle.merge_runs(spans, gap=3)
    assert [(str(a), str(b)) for a, b in merged] == [("2000-02", "2000-06"), ("2000-12", "2001-01")]
    assert str(cycle.since(on)) == "2000-12"


# ── Track record ──────────────────────────────────────────────────────────────

def _flags(n, spans, start="2000-01"):
    s = _m([0] * n, start)
    for a, b in spans:
        s.loc[a:b] = 1
    return s


def test_track_record_counts_caught_missed_false_and_lead():
    recession = _flags(240, [("2003-01", "2003-08"), ("2008-01", "2009-06"), ("2015-01", "2015-06")])
    on = _flags(240, [("2002-10", "2003-05"),      # three months before the first recession
                      ("2005-03", "2005-04"),      # nothing follows: false
                      ("2008-04", "2009-01")]) > 0  # three months into the second; the third is never signalled
    record = cycle.track_record(on, recession, window=6)
    assert (record["recessions"], record["caught"], record["missed"]) == (3, 2, 1)
    assert record["missed_dates"] == ["2015-01"]
    assert record["false_dates"] == ["2005-03"]
    assert record["leads"] == [3, -3] and record["median_lead"] == 0.0
    assert record["signals"] == 3 and record["undecided"] == 0


def test_a_signal_whose_window_has_not_run_out_is_not_called_false():
    recession = _flags(60, [])
    on = _flags(60, [("2004-09", "2004-10")]) > 0      # series ends 2004-12
    record = cycle.track_record(on, recession, window=6)
    assert (record["false"], record["undecided"]) == (0, 1)


def test_a_signal_already_on_at_the_start_and_an_early_recession_are_left_out():
    recession = _flags(120, [("2000-03", "2000-09"), ("2006-01", "2006-06")])
    on = _flags(120, [("2000-01", "2000-10"), ("2006-02", "2006-08")]) > 0
    record = cycle.track_record(on, recession, window=6)
    assert record["signals"] == 1                    # the one running when the series begins has no start date
    assert (record["recessions"], record["caught"], record["leads"]) == (1, 1, [-1])


def test_two_inversions_catch_two_recessions():
    recession = _flags(200, [("2004-01", "2004-06"), ("2005-08", "2006-10")])
    on = _flags(200, [("2002-11", "2004-04"), ("2004-10", "2005-09")]) > 0
    record = cycle.track_record(on, recession, window=24)
    assert (record["caught"], record["missed"], record["false"]) == (2, 0, 0)
    assert record["leads"] == [14, 10]


def test_market_after_starts_the_clock_when_the_reading_is_published():
    sp = _m(np.arange(100.0, 160.0), "2000-01")       # +1 a month
    out = cycle.market_after(["2000-03"], sp, published_after=2, horizon=12)
    start = sp[pd.Period("2000-05", "M")]
    assert out["n"] == 1 and out["published_after"] == 2
    assert out["median_return"] == pytest.approx(sp[pd.Period("2001-05", "M")] / start - 1)
    assert out["median_low"] == pytest.approx(0.0)    # never below the starting level
    assert cycle.market_after(["2004-10"], sp, 0) is None      # twelve months have not passed
    assert cycle.market_after(["2000-03"], pd.Series(dtype=float), 0) is None


# ── The reading ───────────────────────────────────────────────────────────────

def _series(sahm=0.1, cli=(100.2, 100.4), pce_yoy=0.03, gdp=20400.0, potential=20000.0):
    months = 400
    rec = np.zeros(months)
    rec[100:110] = 1
    rec[250:268] = 1
    idx = np.arange(months)
    quarters = months // 3
    return {
        "USREC": _dated(rec, "1990-01-01"),
        "SAHMREALTIME": _dated(np.where((idx >= 102) & (idx < 115) | (idx >= 253) & (idx < 275), 0.9, 0.1).tolist()[:-1] + [sahm], "1990-01-01"),
        "RECPROUSM156N": _dated(np.where((idx >= 252) & (idx < 268), 95.0, 2.0), "1990-01-01"),
        "CFNAIMA3": _dated(np.where(rec > 0, -1.5, 0.1), "1990-01-01"),
        "CFNAIDIFF": _dated(np.where(rec > 0, -0.6, 0.05), "1990-01-01"),
        "JHGDPBRINDX": _dated(np.where((np.arange(quarters) >= 84) & (np.arange(quarters) < 89), 90.0, 5.0), "1990-01-01", "QS"),
        "GS10": _dated(np.full(months, 4.5), "1990-01-01"),
        "TB3MS": _dated(np.where((idx >= 230) & (idx < 245), 5.5, 3.0), "1990-01-01"),
        "USALOLITOAASTSAM": _dated([100.0] * (months - 2) + list(cli), "1990-01-01"),
        "GDPC1": _dated([potential] * (quarters - 1) + [gdp], "1990-01-01", "QS"),
        "GDPPOT": _dated([potential] * (quarters + 8), "1990-01-01", "QS"),
        "GDPDEF": _dated(100 * 1.0075 ** np.arange(quarters), "1990-01-01", "QS"),
        "UNRATE": _dated(np.full(months, 4.0), "1990-01-01"),
        "NROU": _dated(np.full(quarters + 8, 4.4), "1990-01-01", "QS"),
        "PCEPI": _dated(100 * (1 + pce_yoy) ** (idx / 12), "1990-01-01"),
        "PCEPILFE": _dated(100 * 1.025 ** (idx / 12), "1990-01-01"),
        "DFEDTARU": _dated([4.0, 4.0], "2023-04-01", "D"),
        "DFEDTARL": _dated([3.75, 3.75], "2023-04-01", "D"),
        "FEDTARMDLR": _dated([3.0, 3.2], "2023-01-01", "QS"),
        "NFCI": _dated([-0.4, 0.2, 0.3], "2023-03-10", "W-FRI"),
        "ANFCI": _dated([-0.4, -0.2, -0.3], "2023-03-10", "W-FRI"),
    }


def _by_id(payload):
    return {i["id"]: i for g in payload["groups"] for i in g["indicators"]}


def test_build_reads_each_indicator_against_its_published_line():
    out = cycle.build(_series())
    ind = _by_id(out)
    assert out["missing"] == [] and out["composite"] is None

    assert ind["nber"]["state"] == "NO RECESSION DECLARED" and ind["nber"]["since"] == "2012-05"
    assert ind["sahm"]["state"] == "NO SIGNAL" and ind["sahm"]["line"] == "≥ 0.50"
    assert ind["cfnai_ma3"]["state"] == "EXPANSION RANGE"
    assert ind["cfnai_ma3"]["companion"]["on"] is False
    assert ind["chauvet_piger"]["track"]["caught"] == 1 and ind["chauvet_piger"]["track"]["missed"] == 1
    assert ind["hamilton"]["as_of"].endswith("Q4") or "Q" in ind["hamilton"]["as_of"]

    curve = ind["yield_curve"]
    spread = 4.5 - cycle.bond_equivalent(pd.Series([3.0])).iloc[0]
    assert curve["value"] == pytest.approx(spread) and curve["state"] == "NOT INVERTED"
    assert curve["probability_12m"] == pytest.approx(cycle.recession_probability(spread) * 100)
    assert curve["track"]["leads"] == [20]            # inverted 2009-03, recession 2010-11

    assert ind["oecd_cli"]["state"] == "EXPANSION"
    assert ind["output_gap"]["value"] == pytest.approx(2.0) and ind["output_gap"]["state"] == "ABOVE POTENTIAL"
    assert ind["unemployment_gap"]["value"] == pytest.approx(-0.4)
    assert ind["pce"]["value"] == pytest.approx(3.0) and ind["pce"]["state"] == "ABOVE GOAL"
    assert ind["policy_rate"]["value"] == pytest.approx(3.875 - 3.2)
    assert ind["nfci"]["state"] == "TIGHTER THAN AVERAGE" and ind["anfci"]["state"] == "LOOSER THAN AVERAGE"

    p = (1.0075 ** 4 - 1) * 100
    rule = p + 0.5 * 2.0 + 0.5 * (p - 2) + 2
    assert ind["taylor"]["value"] == pytest.approx(3.875 - rule)
    assert ind["taylor"]["state"] == "POLICY BELOW RULE"

    head = out["headline"]
    assert (head["recession_rules_on"], head["recession_rules_known"]) == (0, 4)
    assert head["months_in_expansion"] == 132 and head["cli_phase"] == "EXPANSION"


@pytest.mark.parametrize("cli, phase", [
    ((100.2, 100.4), "EXPANSION"), ((100.4, 100.2), "DOWNTURN"),
    ((99.8, 99.6), "SLOWDOWN"), ((99.6, 99.8), "RECOVERY"),
])
def test_oecd_phase_is_level_against_100_and_direction(cli, phase):
    assert _by_id(cycle.build(_series(cli=cli)))["oecd_cli"]["state"] == phase


def test_sahm_rule_fires_at_half_a_point_and_is_counted_in_the_headline():
    out = cycle.build(_series(sahm=0.50))
    sahm = _by_id(out)["sahm"]
    assert sahm["on"] and sahm["state"] == "RECESSION SIGNAL"
    assert out["headline"]["recession_rules_on"] == 1
    assert not _by_id(cycle.build(_series(sahm=0.49)))["sahm"]["on"]
    assert any(i["kind"] == "know" and "SAHM RULE" in i["text"] for i in out["implications"])


def test_the_cfnai_inflation_line_needs_two_years_of_expansion():
    series = _series()
    series["CFNAIMA3"].iloc[-1] = 0.9
    assert _by_id(cycle.build(series))["cfnai_inflation"]["state"] == "INCREASING LIKELIHOOD"
    series["CFNAIMA3"].iloc[-1] = 1.2
    assert _by_id(cycle.build(series))["cfnai_inflation"]["state"] == "SUBSTANTIAL LIKELIHOOD"
    series["USREC"].iloc[-20:-10] = 1                # trough ten months ago
    assert _by_id(cycle.build(series))["cfnai_inflation"]["state"] == "BELOW LINE"


def test_a_missing_series_costs_only_its_own_row():
    series = _series()
    del series["SAHMREALTIME"], series["GDPPOT"]
    out = cycle.build(series)
    ind = _by_id(out)
    assert set(out["missing"]) == {"SAHMREALTIME", "GDPPOT"}
    assert ind["sahm"]["state"] is None and ind["output_gap"]["state"] is None and ind["taylor"]["state"] is None
    assert ind["pce"]["state"] == "ABOVE GOAL"
    assert out["headline"]["recession_rules_known"] == 3


def test_implications_always_carry_the_tested_donts_and_never_a_sector_call():
    out = cycle.build(_series())
    kinds = [i["kind"] for i in out["implications"]]
    assert kinds.count("dont") >= 3 and "do" not in kinds
    assert all(i["basis"] in ("definition", "track record", "backtest") for i in out["implications"])
    text = " ".join(i["text"] for i in out["implications"])
    assert "XL" not in text.replace("SPDR", "")       # no sector ticker is ever recommended


def test_two_recession_rules_at_once_ask_for_a_review():
    series = _series(sahm=0.9)
    series["CFNAIMA3"].iloc[-1] = -1.0
    out = cycle.build(series)
    assert out["headline"]["recession_rules_on"] == 2
    assert any(i["kind"] == "do" for i in out["implications"])


# ── Router guard ──────────────────────────────────────────────────────────────

def test_trend_ignores_the_running_month():
    from routers import cycle as router

    days = pd.bdate_range("2024-01-01", "2026-10-06")
    spy = pd.Series(np.linspace(100, 200, len(days)), index=days)
    spy.loc["2026-10-01":] = 1.0                      # a crash in the month that has not ended
    trend = router._trend(spy, pd.Period("2026-10", "M"))
    assert trend["as_of"] == "2026-09" and trend["on"] and trend["state"] == "ABOVE AVERAGE"
    assert router._trend(spy.iloc[:100], pd.Period("2024-06", "M")) is None


def test_a_failed_pull_is_not_retried_until_the_wait_is_over(monkeypatch, tmp_path):
    from routers import cycle as router
    import last_good

    last_good.reset()
    monkeypatch.setattr(last_good, "DIR", tmp_path)       # `remember` writes the frame to disk
    router._cache.clear()
    router._failed_at.clear()
    calls = []

    def fail():
        calls.append(1)
        return None

    for _ in range(3):
        assert router._pull("cycle_test", fail, 60, "test", "FRED") == (None, None)
    assert len(calls) == 1

    router._failed_at["cycle_test"] -= router._RETRY_AFTER + 1
    good = pd.DataFrame({"X": [1.0]})
    frame, age = router._pull("cycle_test", lambda: good, 60, "test", "FRED")
    assert frame.equals(good) and age is None
