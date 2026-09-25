"""CFTC COT — release dating, row parsing (CFTC field typos), crowding stats, snapshot."""
from datetime import datetime, timezone

from routers import cot


# ── dating ────────────────────────────────────────────────────────────────────

def test_released_on_is_the_friday_after_tuesday():
    assert cot.released_on("2026-09-15") == "2026-09-18"
    assert cot.released_on("2026-09-15T00:00:00.000") == "2026-09-18"


def test_expected_as_of_waits_for_friday_1530_et():
    # Fri 2026-09-18 15:00 ET (19:00Z) — this week's report not out yet
    assert cot.expected_as_of(datetime(2026, 9, 18, 19, 0, tzinfo=timezone.utc)) == "2026-09-08"
    # Fri 15:31 ET — out
    assert cot.expected_as_of(datetime(2026, 9, 18, 19, 31, tzinfo=timezone.utc)) == "2026-09-15"
    # Mon / Thu after — still that Tuesday
    assert cot.expected_as_of(datetime(2026, 9, 21, 14, 0, tzinfo=timezone.utc)) == "2026-09-15"
    assert cot.expected_as_of(datetime(2026, 9, 24, 14, 0, tzinfo=timezone.utc)) == "2026-09-15"


# ── parse_row ─────────────────────────────────────────────────────────────────

def test_parse_tff_row():
    row = {"report_date_as_yyyy_mm_dd": "2026-09-15T00:00:00.000", "open_interest_all": "1000",
           "lev_money_positions_long": "100", "lev_money_positions_short": "400",
           "traders_lev_money_long_all": "20", "traders_lev_money_short_all": "50",
           "conc_gross_le_4_tdr_short": "17.9"}
    rep, groups = cot.parse_row("TFF", row)
    assert rep["report_date"] == "2026-09-15" and rep["oi"] == 1000 and rep["conc4_short"] == 17.9
    lev = next(g for g in groups if g["grp"] == "lev")
    assert (lev["long"], lev["short"], lev["traders_short"]) == (100, 400, 50)
    # groups whose fields are missing are skipped, not zero-filled
    assert {g["grp"] for g in groups} == {"lev"}


def test_parse_disaggregated_uses_cftc_typo_field():
    row = {"report_date_as_yyyy_mm_dd": "2026-09-15T00:00:00.000", "open_interest_all": "500",
           "swap_positions_long_all": "10", "swap__positions_short_all": "30"}
    _, groups = cot.parse_row("DIS", row)
    assert groups == [{"grp": "swap", "long": 10, "short": 30, "spread": None,
                       "traders_long": None, "traders_short": None}]


def test_parse_rejects_rows_without_oi():
    assert cot.parse_row("TFF", {"report_date_as_yyyy_mm_dd": "2026-09-15", "open_interest_all": "0"}) is None
    assert cot.parse_row("TFF", {"open_interest_all": "10"}) is None


# ── crowding ──────────────────────────────────────────────────────────────────

def test_crowding_extreme_low_reads_low_percentile():
    series = [-10.0] + [float(i % 5) for i in range(99)]   # newest first
    c = cot.crowding(series, 156)
    assert c["n"] == 100 and c["pct"] == 1.0 and c["z"] < -3


def test_crowding_needs_a_year():
    c = cot.crowding([1.0] * 30, 156)
    assert c == {"z": None, "pct": None, "n": 30}


def test_crowding_respects_window_and_skips_none():
    series = [5.0] + [None] * 3 + [0.0] * 60 + [100.0] * 100
    c = cot.crowding(series, 64)   # window stops before the 100s
    assert c["n"] == 61 and c["pct"] == 100.0


# ── summarize ─────────────────────────────────────────────────────────────────

def _rows(nets):
    return [{"date": f"2026-{i:04d}", "released": "", "oi": 1000.0,
             "conc4_long": None, "conc4_short": None, "conc8_long": None, "conc8_short": None,
             "groups": {"lev": {"long": 0.0, "short": -n, "net": n, "spread": None,
                                "traders_long": 1, "traders_short": 2}}}
            for i, n in enumerate(nets)]


def test_summarize_net_oi_delta_and_meta():
    s = cot.summarize("134741", _rows([-300.0, -250.0] + [0.0] * 60), 156)
    lev = s["groups"]["lev"]
    assert s["key"] == "SOFR3M" and s["focus"] == "lev"
    assert lev["net_oi"] == -30.0 and lev["d_net"] == -50.0
    assert lev["pct"] < 5 and lev["z"] < -2


def test_summarize_empty():
    assert cot.summarize("043602", [], 156) is None


# ── crowding flags ────────────────────────────────────────────────────────────

def _c(key, grp, z, pct):
    return {"key": key, "label": key, "as_of": "2026-09-15", "released": "2026-09-18",
            "groups": {grp: {"z": z, "pct": pct, "net_oi": -1.0}}}


def test_flags_fire_on_z_or_percentile_and_respect_side():
    flags = cot.crowding_flags([
        _c("SOFR3M", "lev", -1.9, 3.8),   # pct ≤ 5 → short crowding
        _c("VIX", "am", -1.93, 6.0),      # neither → no flag
        _c("UST10Y", "am", 2.1, 90.0),    # z ≥ 2 → duration long crowding
        _c("RTY", "lev", 2.5, 99.0),      # extreme, but the WRONG side for a short rule
    ])
    assert {(f["id"], f["contract"]) for f in flags} == {
        ("rates_short_crowding", "SOFR3M"), ("duration_long_crowding", "UST10Y")}


def test_flags_skip_missing_stats():
    assert cot.crowding_flags([_c("SOFR3M", "lev", None, None)]) == []
    assert cot.crowding_flags([]) == []


# ── basis trade ───────────────────────────────────────────────────────────────

def _wk(date, oi, **nets):
    return {"date": date, "oi": oi, "groups": {g: {"net": n} for g, n in nets.items()}}


def test_basis_series_dv01_weights_and_drops_partial_weeks():
    rows = {
        "042601": [_wk("2026-09-08", 100, lev=-100, am=100), _wk("2026-09-15", 100, lev=-200, am=100)],  # 2Y ×0.58
        "020601": [_wk("2026-09-15", 10, lev=-10, am=20)],                                             # Bond ×2.30
    }
    out = cot.basis_series(rows)
    assert [r["date"] for r in out] == ["2026-09-15"]          # 09-08 lacks the Bond → dropped
    r = out[0]
    assert r["lev"] == round(0.58 * -200 + 2.30 * -10)          # −139
    assert r["am"] == round(0.58 * 100 + 2.30 * 20)             # 104
    assert r["dealer"] == 0 and r["released"] == "2026-09-18"


# ── positioning factor ────────────────────────────────────────────────────────

def test_rolling_z_is_causal():
    vals = [0.0, 1.0] * 30 + [10.0]
    z = cot.rolling_z(vals, 156)
    assert z[:51] == [None] * 51          # fewer than a year of points
    assert z[-1] > 3                      # the jump is judged only against the past
    assert cot.rolling_z(vals[:-1], 156) == z[:-1]   # appending a point never rewrites history


def test_positioning_factor_recovers_common_driver_with_stable_sign():
    import math as m
    dates = [f"d{i:03d}" for i in range(80)]
    common = [m.sin(i / 5) for i in range(80)]
    z = {f"K{j}": {d: (1 if j % 2 else -1) * (j + 1) * c for d, c in zip(dates, common)} for j in range(8)}
    f = cot.positioning_factor(z)
    assert f["weeks"] == 80 and f["explained"] > 0.99
    assert f["loadings"]["K7"] > 0 and f["loadings"]["K6"] < 0   # largest |loading| (K7) positive


def test_positioning_factor_needs_enough_contracts():
    z = {f"K{j}": {"d1": 1.0} for j in range(3)}
    assert cot.positioning_factor(z)["series"] == []


# ── portfolio vs crowd ────────────────────────────────────────────────────────

def test_map_symbol_explicit_proxy_and_none():
    assert cot.map_symbol("GC=F", "US") == ("GOLD", False)
    assert cot.map_symbol("GOOGL", "US") == ("ES", True)       # US single stock → market-leg proxy
    assert cot.map_symbol("AOT.BK", "TH") is None
    assert cot.map_symbol("^VIX", None) == ("VIX", False)


def test_portfolio_crowding_relation_weights_and_inverse():
    contracts = [{"key": "GOLD", "label": "GOLD", "focus": "mm", "groups": {"mm": {"z": 2.2, "pct": 97}}},
                 {"key": "VIX", "label": "VIX", "focus": "lev", "groups": {"lev": {"z": -1, "pct": 20}}}]
    flags = [{"id": "commodity_long_crowding", "contract": "GOLD", "side": "long", "label": "x"},
             {"id": "short_vol_crowding", "contract": "VIX", "side": "short", "label": "y"}]
    positions = [
        {"symbol": "GC=F", "market": "US", "volume": 1, "market_value_base": 600},
        {"symbol": "SVXY", "market": "US", "volume": 10, "market_value_base": 200},   # long inverse = short VIX
        {"symbol": "AOT", "resolved_symbol": "AOT.BK", "market": "TH", "volume": 100, "market_value_base": 200},
    ]
    out = cot.portfolio_crowding(positions, contracts, flags)
    rows = {r["key"]: r for r in out["rows"]}
    assert rows["GOLD"]["weight_pct"] == 60.0 and rows["GOLD"]["flags"][0]["relation"] == "WITH_CROWD"
    assert rows["VIX"]["side"] == "short" and rows["VIX"]["flags"][0]["relation"] == "WITH_CROWD"
    assert out["with_crowd_weight_pct"] == 80.0 and out["unmapped_weight_pct"] == 20.0


def test_portfolio_crowding_skips_unpriced_positions():
    out = cot.portfolio_crowding(
        [{"symbol": "BTC-USD", "market": "CRYPTO", "volume": 0.001, "market_value_base": None},
         {"symbol": "GC=F", "market": "US", "volume": 1, "market_value_base": 100}], [], [])
    assert [r["key"] for r in out["rows"]] == ["GOLD"] and out["unpriced"] == ["BTC-USD"]
