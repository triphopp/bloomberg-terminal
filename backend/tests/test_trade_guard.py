"""Trade guard rules (no network): stops, time stop, caps, traffic light."""
from datetime import date

import numpy as np
import pandas as pd
import pytest

import trade_guard as tg

TODAY = date(2026, 9, 28)


def _pos(symbol="AAA", entry=100.0, price=100.0, volume=10, first="2026-09-20",
         sector="Tech", strategy=None, manual_stop=None, prev=None, fx=1.0):
    return {"account_id": "a", "symbol": symbol, "yf_symbol": symbol, "currency": "USD",
            "volume": volume, "entry_price": entry, "price": price, "prev_close": prev,
            "first_entry": first, "sector": sector, "strategy": strategy,
            "manual_stop": manual_stop, "fx": fx}


def _book(*positions, atr=None):
    return tg.evaluate(list(positions), atr or {}, today=TODAY)


def test_auto_stop_clamps_atr_distance():
    assert tg.auto_stop(100, 0.01) == pytest.approx((95, 0.05, "ATR"))    # 2% → floor 5%
    assert tg.auto_stop(100, 0.04) == pytest.approx((92, 0.08, "ATR"))
    assert tg.auto_stop(100, 0.20) == pytest.approx((88, 0.12, "ATR"))    # 40% → cap 12%
    assert tg.auto_stop(100, None) == pytest.approx((92, 0.08, "DEFAULT"))


def test_manual_stop_wins_over_atr():
    out = _book(_pos(manual_stop=97, price=96), atr={"AAA": 0.05})
    row = out["positions"][0]
    assert row["stop_source"] == "MANUAL" and row["stop"] == 97
    assert "STOP_HIT" in row["flags"] and out["light"] == "RED"


def test_near_stop_is_last_third_of_distance():
    # default stop 92: distance 8, last third starts at 94.67
    near = _book(_pos(price=94.5), _pos("BBB", price=95.5, sector="X"))
    flags = {r["symbol"]: r["flags"] for r in near["positions"]}
    assert "NEAR_STOP" in flags["AAA"] and "NEAR_STOP" not in flags["BBB"]


def test_time_stop_only_for_flat_trades_and_not_long_horizon():
    out = _book(
        _pos("OLD", first="2026-08-01", price=101),                    # 58d, +1% → TIME
        _pos("WIN", first="2026-08-01", price=130, sector="S2"),      # winner → no
        _pos("VAL", first="2026-08-01", price=99, strategy="Value", sector="S3"),
        _pos("NEW", first="2026-09-20", price=99, sector="S4"),       # 8 days → no
    )
    flags = {r["symbol"]: r["flags"] for r in out["positions"]}
    assert "TIME" in flags["OLD"]
    assert "TIME" not in flags["WIN"] + flags["VAL"] + flags["NEW"]


def test_overweight_and_sector_caps():
    big = _pos("BIG", volume=50, sector="Tech")
    small = [_pos(f"S{i}", volume=10, sector=f"Sec{i}") for i in range(6)]
    out = _book(big, *small)
    row = next(r for r in out["positions"] if r["symbol"] == "BIG")
    assert "OVERWEIGHT" in row["flags"]              # 500 / 1100 = 45%
    assert any(a["code"] == "SECTOR" for a in out["actions"])
    assert out["light"] == "YELLOW"


def test_unclassified_sector_never_breaches():
    out = _book(_pos(sector=None), _pos("B", sector=None))
    assert not any(a["code"] == "SECTOR" for a in out["actions"])


def test_day_loss_turns_light_red():
    rows = [_pos(f"S{i}", price=97, prev=100, sector=f"s{i}", first="2026-09-27")
            for i in range(10)]
    out = _book(*rows)
    assert out["day_pnl_pct"] == pytest.approx(-3.0)
    assert out["light"] == "RED" and out["actions"][0]["code"] == "DAY_LOSS"


def test_green_when_nothing_fires():
    rows = [_pos(f"S{i}", price=103, prev=102, sector=f"s{i}") for i in range(10)]
    out = _book(*rows)
    assert out["light"] == "GREEN" and out["actions"] == []
    # heat = Σ (price − stop) × vol = (103 − 92) × 10 × 10
    assert out["heat_value"] == pytest.approx(1100)


def test_skips_unpriced_and_short():
    out = _book(_pos(price=None), _pos("SH", volume=-5))
    assert {s["reason"] for s in out["skipped"]} == {"no live price", "short / zero volume"}
    assert out["positions"] == []


def test_fx_converts_weights_to_base():
    thb = _pos("TH", price=100, volume=10, fx=1.0, sector="a")        # 1,000
    usd = _pos("US", price=100, volume=10, fx=35.0, sector="b")       # 35,000
    out = _book(thb, usd)
    w = {r["symbol"]: r["weight_pct"] for r in out["positions"]}
    assert w["US"] == pytest.approx(97.22, abs=0.01)


def test_aggregate_lots_weights_entry_keeps_first_date_and_highest_stop():
    lots = [
        {"account_id": "a", "symbol": "X", "yf_symbol": "X.BK", "price_entry": 10,
         "volume": 100, "date_entry": "2026-02-08", "sector": "", "strategy_name": "",
         "price_stoploss": 9, "currency": "THB"},
        {"account_id": "a", "symbol": "X", "yf_symbol": "X.BK", "price_entry": 20,
         "volume": 100, "date_entry": "2026-07-01", "sector": "ENERG",
         "strategy_name": "Swing", "price_stoploss": 17, "currency": "THB"},
    ]
    [g] = tg.aggregate_lots(lots)
    assert g["entry_price"] == 15 and g["volume"] == 200
    assert g["first_entry"] == "2026-02-08"
    assert g["manual_stop"] == 17 and g["sector"] == "Energy" and g["strategy"] == "Swing"


def test_atr_asof_uses_bars_up_to_entry():
    idx = pd.bdate_range("2026-01-01", periods=80)
    close = np.r_[np.full(40, 100.0), np.full(40, 100.0)]
    rng = np.r_[np.full(40, 1.0), np.full(40, 10.0)]          # calm, then wild
    df = pd.DataFrame({"High": close + rng / 2, "Low": close - rng / 2, "Close": close}, index=idx)
    calm = tg.atr_pct_asof(df, idx[39].strftime("%Y-%m-%d"))
    wild = tg.atr_pct_asof(df, None)
    assert calm == pytest.approx(0.01, rel=0.05)
    assert wild > 0.05
    assert tg.atr_pct_asof(df.iloc[:10], None) is None


@pytest.mark.parametrize("x,s", [(1234.5, "1,234.50"), (0.23, "0.23"), (0.12345, "0.1235"), (0.5, "0.50")])
def test_fmt_px(x, s):
    assert tg.fmt_px(x) == s


def test_stop_hit_suppresses_time_action_but_keeps_flag():
    out = _book(_pos(first="2026-06-01", price=90))
    assert out["positions"][0]["flags"] == ["STOP_HIT", "TIME", "OVERWEIGHT"]
    assert [a["code"] for a in out["actions"]] == ["STOP_HIT", "OVERWEIGHT", "SECTOR"]


def test_near_stop_carries_age_instead_of_second_time_line():
    rows = [_pos("N", first="2026-08-01", price=94), *[_pos(f"S{i}", sector=f"s{i}", price=103) for i in range(10)]]
    out = _book(*rows)
    mine = [a for a in out["actions"] if a["symbol"] == "N"]
    assert [a["code"] for a in mine] == ["NEAR_STOP"]
    assert "58 วัน" in mine[0]["text"]
    assert next(r for r in out["positions"] if r["symbol"] == "N")["flags"] == ["NEAR_STOP", "TIME"]


# ── Overrides / book-level breakers ──────────────────────────────────────────

def test_override_downgrades_action_to_info_and_clears_light():
    rows = [_pos("HIT", price=90, first="2026-09-20"),
            *[_pos(f"S{i}", sector=f"s{i}", price=103) for i in range(10)]]
    ov = {tg.override_key("a", "HIT", "2026-09-20"): {"id": "x", "codes": ["STOP_HIT"], "reason": "earnings"}}
    out = tg.evaluate(rows, {}, today=TODAY, overrides=ov)
    hit = [a for a in out["actions"] if a["symbol"] == "HIT"]
    assert hit[0]["level"] == "INFO" and "earnings" in hit[0]["text"]
    assert hit[0]["override_id"] == "x"
    assert out["light"] == "GREEN"
    assert "STOP_HIT" in next(r for r in out["positions"] if r["symbol"] == "HIT")["flags"]


def test_override_is_scoped_to_holding_period():
    ov = {tg.override_key("a", "AAA", "2026-01-01"): {"id": "old", "codes": ["STOP_HIT"]}}
    out = tg.evaluate([_pos(price=90, first="2026-09-20")], {}, today=TODAY, overrides=ov)
    assert out["light"] == "RED"


@pytest.mark.parametrize("dd,streak,mult,light", [
    (-2.0, 0, 1.0, None), (-6.0, 0, 0.5, "YELLOW"), (-11.0, 0, 0.0, "RED"), (-1.0, 4, 0.5, "YELLOW"),
])
def test_drawdown_and_streak_breakers(dd, streak, mult, light):
    rows = [_pos(f"S{i}", sector=f"s{i}", price=103) for i in range(10)]
    out = tg.evaluate(rows, {}, today=TODAY, nav_drawdown_pct=dd, streak=streak)
    assert out["size_multiplier"] == mult
    assert out["light"] == (light or "GREEN")


def test_loss_streak_counts_from_newest_exit():
    closed = [
        {"date_exit": "2026-09-01", "price_entry": 10, "price_exit": 12},
        {"date_exit": "2026-09-10", "price_entry": 10, "price_exit": 9},
        {"date_exit": "2026-09-20", "price_entry": 10, "price_exit": 8},
    ]
    assert tg.loss_streak(closed) == 2


def test_nav_includes_cash():
    out = tg.evaluate([_pos(price=100, volume=10)], {}, today=TODAY, cash_value=500)
    assert out["nav_value"] == 1500


# ── Sizing ───────────────────────────────────────────────────────────────────

def test_size_buckets_volume_and_risk():
    out = tg.size_buckets(nav_base=1_000_000, price=100, fx=35, atr_frac=0.04)
    m = out["buckets"]["M"]
    assert m["notional_base"] == 60_000
    assert m["volume"] == pytest.approx(60_000 / 3500)
    assert out["stop_distance_pct"] == 8 and m["risk_pct_nav"] == pytest.approx(0.48)


def test_size_buckets_respects_multiplier_and_manual_stop():
    out = tg.size_buckets(1_000_000, 100, 1, None, multiplier=0.5, manual_stop=95)
    assert out["stop_source"] == "MANUAL" and out["stop_distance_pct"] == 5
    assert out["buckets"]["L"]["notional_base"] == 50_000


# ── Report ───────────────────────────────────────────────────────────────────

def _closed(sym, entry, exit_, d_in, d_out, strategy="Swing", sl=None, acct="a"):
    return {"account_id": acct, "symbol": sym, "yf_symbol": sym, "price_entry": entry,
            "price_exit": exit_, "date_entry": d_in, "date_exit": d_out,
            "price_stoploss": sl, "strategy_name": strategy}


def test_report_r_multiples_breaks_and_capped_expectancy():
    closed = [
        _closed("W", 100, 108, "2026-09-01", "2026-09-05"),      # +8% / 8% = +1R
        _closed("L", 100, 96, "2026-09-01", "2026-09-05"),       # −0.5R
        _closed("BAG", 100, 60, "2026-05-01", "2026-09-01"),     # −5R, held 123d
    ]
    rep = tg.trade_report(closed, {})
    assert rep["summary"]["n"] == 3
    worst = rep["worst"][0]
    assert worst["symbol"] == "BAG" and worst["r"] == -5.0
    assert set(worst["breaks"]) == {"LOSS_PAST_STOP", "HELD_LOSER"}
    assert rep["followed"]["n"] == 2 and rep["broke"]["n"] == 1
    assert rep["summary"]["expectancy_r"] == pytest.approx((1 - 0.5 - 5) / 3, abs=0.01)
    assert rep["capped_expectancy_r"] == pytest.approx((1 - 0.5 - 1) / 3, abs=0.01)
    assert rep["monthly"][0]["month"] == "2026-09"


def test_report_uses_manual_stop_and_flags_overridden():
    closed = [_closed("X", 100, 97, "2026-09-01", "2026-09-10", sl=98)]
    rep = tg.trade_report(closed, {}, overridden={tg.override_key("a", "X", "2026-09-01")})
    t = rep["worst"][0]
    assert t["stop_source"] == "MANUAL" and t["r"] == -1.5 and t["overridden"]
    assert rep["overridden"]["n"] == 1


# ── Notifications ────────────────────────────────────────────────────────────

def test_transitions_fire_on_appearance_only():
    # entry 100, stop 92 → NEAR_STOP inside 92..94.67
    snap = _book(_pos(price=94, first="2026-09-20"))
    state, events = tg.transitions({}, snap)
    assert [e["code"] for e in events] == ["NEAR_STOP"]
    _, again = tg.transitions(state, snap)
    assert again == []


def test_stop_hit_reminds_every_call_while_it_stands():
    snap = _book(_pos(price=90, first="2026-09-20"))
    state, events = tg.transitions({}, snap)
    assert [e["code"] for e in events] == ["STOP_HIT"]
    _, again = tg.transitions(state, snap)
    assert [e["code"] for e in again] == ["STOP_HIT"]
    assert again[0]["snapshot"]["to_stop_pct"] < 0


def test_hold_expires_on_review_date():
    ov = {tg.override_key("a", "AAA", "2026-09-20"): {
        "id": "x", "codes": ["STOP_HIT"], "reason": "r", "review_on": "2026-09-28"}}
    out = tg.evaluate([_pos(price=90, first="2026-09-20")], {}, today=TODAY, overrides=ov)
    assert out["light"] == "RED"
    hit = next(a for a in out["actions"] if a["code"] == "STOP_HIT")
    assert hit["level"] == "RED" and "HOLD หมดอายุ" in hit["text"]
    assert out["positions"][0]["override"]["ended"] == "REVIEW"
    _, events = tg.transitions({}, out)
    assert [e["code"] for e in events] == ["STOP_HIT"] and events[0]["snapshot"]["hold_ended"] == 1


def test_hold_review_defaults_from_created_at():
    ov = {tg.override_key("a", "AAA", "2026-09-20"): {
        "id": "x", "codes": ["STOP_HIT"], "reason": "r", "created_at": "2026-09-01 10:00:00"}}
    out = tg.evaluate([_pos(price=90, first="2026-09-20")], {}, today=TODAY, overrides=ov)
    assert out["positions"][0]["override"]["review_on"] == "2026-09-15"
    assert out["light"] == "RED"


def test_hold_breaks_below_its_floor():
    ov = {tg.override_key("a", "AAA", "2026-09-20"): {
        "id": "x", "codes": ["STOP_HIT"], "reason": "r", "floor_price": 84}}
    held = tg.evaluate([_pos(price=85, first="2026-09-20")], {}, today=TODAY, overrides=ov)
    assert next(a for a in held["actions"] if a["code"] == "STOP_HIT")["level"] == "INFO"
    broken = tg.evaluate([_pos(price=84, first="2026-09-20")], {}, today=TODAY, overrides=ov)
    assert broken["light"] == "RED"
    assert broken["positions"][0]["override"]["ended"] == "FLOOR"
    assert "floor" in next(a for a in broken["actions"] if a["code"] == "STOP_HIT")["text"]


def test_hold_without_floor_only_expires_by_date():
    ov = {tg.override_key("a", "AAA", "2026-09-20"): {"id": "x", "codes": ["STOP_HIT"], "reason": "r"}}
    out = tg.evaluate([_pos(price=10, first="2026-09-20")], {}, today=TODAY, overrides=ov)
    assert out["positions"][0]["override"]["active"] is True


def test_proposed_floor_is_one_r_below_stop_or_below_price():
    assert tg.hold_floor(100, 92) == 84                 # R 8 below the stop
    assert tg.hold_floor(100, 92, price=70) == 62       # already under: R 8 below price
    assert tg.hold_floor(100, 110) == pytest.approx(104.5)  # trailing stop: 5% of stop


def test_missing_data_is_a_yellow_action_not_green():
    out = _book(_pos(price=None), _pos("SH", volume=-5))
    assert out["light"] == "YELLOW"
    assert sorted(a["symbol"] for a in out["actions"] if a["code"] == "DATA") == ["AAA", "SH"]


def test_unknown_nav_drawdown_halves_size():
    rows = [_pos(f"S{i}", sector=f"s{i}", price=103) for i in range(10)]
    out = tg.evaluate(rows, {}, today=TODAY, nav_drawdown_unknown=True)
    assert out["size_multiplier"] == 0.5
    assert out["light"] == "YELLOW" and out["actions"][0]["code"] == "DATA"


def test_transitions_skip_overridden_codes():
    ov = {tg.override_key("a", "AAA", "2026-09-20"): {"id": "x", "codes": ["STOP_HIT"]}}
    snap = tg.evaluate([_pos(price=90, first="2026-09-20")], {}, today=TODAY, overrides=ov)
    _, events = tg.transitions({}, snap)
    assert all(e["code"] != "STOP_HIT" for e in events)


def test_scheduler_apply_seeds_silently_then_writes_events():
    import sqlite3
    from datetime import datetime, timezone

    import guard_scheduler
    from alerts.schema import create_alert_tables

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    create_alert_tables(conn)
    conn.execute("CREATE TABLE guard_state (key TEXT PRIMARY KEY, flags TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL)")
    now = datetime(2026, 9, 28, 3, 0, tzinfo=timezone.utc)

    calm = _book(_pos(price=103, first="2026-09-20"))
    assert guard_scheduler.apply(conn, calm, now) == []          # seed
    hit = _book(_pos(price=90, first="2026-09-20"))
    written = guard_scheduler.apply(conn, hit, now)
    assert [e["code"] for e in written] == ["STOP_HIT"]
    row = conn.execute("SELECT rule_id, symbol, bar_time FROM alert_events").fetchone()
    assert tuple(row) == ("guard:STOP_HIT", "AAA", "2026-09-28")
    assert guard_scheduler.apply(conn, hit, now) == []            # same day → capped
    tomorrow = datetime(2026, 9, 29, 3, 0, tzinfo=timezone.utc)
    assert [e["code"] for e in guard_scheduler.apply(conn, hit, tomorrow)] == ["STOP_HIT"]


def test_scheduler_status_states(monkeypatch):
    from datetime import datetime, timedelta, timezone

    import guard_scheduler as gs

    now = datetime(2026, 9, 30, 3, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(gs, "_started", True)
    monkeypatch.setattr(gs, "_status", {**gs._status, "interval": 900, "started_at": now - timedelta(seconds=60),
                                        "last_ok_at": None, "last_error": None})
    assert gs.status(now)["state"] == "STARTING"
    gs._status["started_at"] = now - timedelta(hours=2)
    assert gs.status(now)["state"] == "STALE"
    gs._status["last_ok_at"] = now - timedelta(minutes=5)
    assert gs.status(now)["state"] == "OK"
    gs._status["last_error"] = "HTTPError: 429"
    assert gs.status(now)["state"] == "ERROR"
    monkeypatch.setattr(gs, "_started", False)
    assert gs.status(now)["state"] == "OFF"


def test_size_buckets_floor_to_board_lot():
    out = tg.size_buckets(1_000_000, 62.5, 1, 0.02, lot=100)
    m = out["buckets"]["M"]
    assert m["volume"] == 900                      # 60,000 / 62.5 = 960 → 900
    assert m["notional_base"] == 56_250
    assert m["risk_pct_nav"] == pytest.approx(56_250 * 0.05 / 1_000_000 * 100, abs=1e-3)


def test_aggregate_sector_is_volume_majority_in_gics():
    lots = [
        {"account_id": "d", "symbol": "GOOGL", "yf_symbol": "GOOGL", "price_entry": 100, "volume": 2,
         "date_entry": "2026-05-06", "sector": "TECH", "strategy_name": "", "price_stoploss": None},
        {"account_id": "d", "symbol": "GOOGL", "yf_symbol": "GOOGL", "price_entry": 100, "volume": 9,
         "date_entry": "2026-08-28", "sector": "Communication Services", "strategy_name": "", "price_stoploss": None},
    ]
    assert tg.aggregate_lots(lots)[0]["sector"] == "Communication Services"


def test_sector_cap_adds_up_across_spellings():
    rows = [_pos("PTT", sector="Energy", volume=15), _pos("OR", sector="Energy", volume=15),
            *[_pos(f"S{i}", sector=f"x{i}") for i in range(7)]]
    out = _book(*rows)
    assert any(a["code"] == "SECTOR" and "Energy" in a["text"] for a in out["actions"])


# ── MAE/MFE replay ───────────────────────────────────────────────────────────

def _frame(rows, start="2026-09-01"):
    idx = pd.bdate_range(start, periods=len(rows))
    return pd.DataFrame(rows, columns=["Open", "High", "Low", "Close"], index=idx)


def test_replay_stop_touch_gap_and_untouched():
    f = _frame([[100, 101, 99, 100], [99, 100, 91, 95], [95, 96, 94, 95]])   # day 2 low 91 < 92
    bars = tg.trade_bars(f, "2026-09-01", "2026-09-03")
    assert list(bars["Low"]) == [91, 94]                  # entry day excluded
    assert tg.replay_with_stop(bars, 100, 95, 0.08) == (pytest.approx(-0.08), True)
    gap = _frame([[100, 101, 99, 100], [85, 86, 80, 82]])
    assert tg.replay_with_stop(tg.trade_bars(gap, "2026-09-01", "2026-09-02"), 100, 82, 0.08) == (
        pytest.approx(-0.15), True)                       # opened below the stop → open fill
    calm = _frame([[100, 101, 99, 100], [100, 110, 97, 108]])
    assert tg.replay_with_stop(tg.trade_bars(calm, "2026-09-01", "2026-09-02"), 100, 108, 0.08) == (
        pytest.approx(0.08), False)


def test_trade_bars_none_when_history_starts_after_entry():
    assert tg.trade_bars(_frame([[1, 1, 1, 1]] * 3, start="2026-09-10"), "2026-09-01", "2026-09-12") is None


def test_report_counterfactual_counts_winners_cut_and_sweep():
    # Winner that dipped 10% first, then ran to +20%; loser that bled to −30%.
    win = _frame([[100, 100, 100, 100], [99, 100, 90, 95], [95, 121, 95, 120]])
    lose = _frame([[100, 100, 100, 100], [98, 99, 93, 95], [95, 95, 70, 70]], start="2026-08-03")
    closed = [_closed("WIN", 100, 120, "2026-09-01", "2026-09-03"),
              _closed("LOSE", 100, 70, "2026-08-03", "2026-08-05")]
    rep = tg.trade_report(closed, {}, frames={"WIN": win, "LOSE": lose})
    cf = rep["counterfactual"]
    assert cf["n"] == 2 and cf["coverage_pct"] == 100
    assert cf["winners_cut"] == 1 and cf["losses_saved"] == 1
    assert cf["actual_avg_pct"] == pytest.approx(-5.0) and cf["stop_avg_pct"] == pytest.approx(-8.0)
    w = next(t for t in rep["worst"] if t["symbol"] == "WIN")
    assert w["mae_pct"] == -10 and w["mfe_pct"] == 21 and "_bars" not in w
    wide = next(r for r in rep["sweep"] if r["kind"] == "pct" and r["value"] == 12)
    assert wide["winners_cut"] == 0 and wide["stop_avg_pct"] == pytest.approx((20 - 12) / 2)


def test_avco_carried_lot_is_flagged_not_replayed():
    f = _frame([[17, 17.4, 16.4, 16.5], [17, 18, 16.3, 17.9]], start="2026-02-02")
    closed = [_closed("SMR", 45.46, 18.68, "2026-02-02", "2026-02-03")]
    rep = tg.trade_report(closed, {}, frames={"SMR": f})
    assert rep["counterfactual"]["n"] == 0
    assert rep["counterfactual"]["entry_mismatch"][0]["symbol"] == "SMR"
    assert rep["worst"][0]["entry_mismatch"] and rep["worst"][0]["cf_return_pct"] is None


# ── risk-budget sizing ────────────────────────────────────────────────────────

def _dime_fees(side, qty, price):
    import broker_fees
    return broker_fees.estimate("DIME_US", side, qty, price)["total"]


def test_volume_for_risk_without_fees_is_risk_over_distance():
    # ฿20,000 at a 10-dollar stop distance, 33.5 THB/USD → 59.70 shares
    vol = tg.volume_for_risk(20_000, 120, 110, 33.5)
    assert vol == pytest.approx(20_000 / (10 * 33.5), abs=1e-6)
    loss, fees = tg.loss_at_stop(vol, 120, 110, 33.5)
    assert loss <= 20_000 and fees == 0


def test_volume_for_risk_with_fees_never_exceeds_budget():
    vol = tg.volume_for_risk(20_000, 1739.89, 1530.63, 33.5, _dime_fees)
    loss, fees = tg.loss_at_stop(vol, 1739.89, 1530.63, 33.5, _dime_fees)
    assert fees > 0
    assert loss <= 20_000
    assert loss > 20_000 * 0.995          # spends the budget, not a fraction of it
    assert vol < tg.volume_for_risk(20_000, 1739.89, 1530.63, 33.5)  # fees cost shares


def test_volume_floors_to_board_lot():
    vol = tg.volume_for_risk(20_000, 62.5, 58.0, 1, lot=100)
    assert vol == 4400  # 20,000 / 4.5 = 4,444 → 4,400
    assert tg.volume_for_risk(100, 62.5, 58.0, 1, lot=100) == 0


def test_stop_for_risk_inverts_volume_for_risk():
    stop = tg.stop_for_risk(20_000, 50, 120, 33.5, _dime_fees)
    loss, _ = tg.loss_at_stop(50, 120, stop, 33.5, _dime_fees)
    assert loss == pytest.approx(20_000, rel=1e-6)
    # fees alone above the budget → no stop exists
    assert tg.stop_for_risk(1, 50, 120, 33.5, _dime_fees) is None


def test_risk_size_ladder_tags_noise_and_cap():
    out = tg.risk_size(20_000, 100, 33.5, 0.04, nav_base=1_000_000)
    labels = [r["label"] for r in out["rows"]]
    assert labels == ["1×ATR", "1.5×ATR", "2×ATR", "3×ATR", "4×ATR"]
    first, last = out["rows"][0], out["rows"][-1]
    assert first["noise"] == "TIGHT" and last["noise"] == "OK"
    assert first["volume"] > last["volume"]         # wider stop → smaller position
    for r in out["rows"]:
        assert r["loss_base"] <= 20_000
    # 1×ATR: 20,000 / (4 × 33.5) = 149 shares ≈ ฿500k = 50% NAV → over the 10% cap
    assert first["over_weight_cap"] is True


def test_risk_size_without_atr_uses_pct_ladder_and_manual_stop():
    out = tg.risk_size(10_000, 100, 1, None, manual_stop=93)
    assert [r["label"] for r in out["rows"]] == ["5%", "STOP", "8%", "12%", "20%"]
    assert all(r["atr_mult"] is None and r["noise"] is None for r in out["rows"])


def test_risk_size_notional_plan_gives_the_implied_stop():
    out = tg.risk_size(20_000, 120, 33.5, 0.03, nav_base=1_000_000, notional_base=200_000)
    plan = out["notional_plan"]
    # ฿200,000 / (120 × 33.5) = 49.75 shares; ฿20,000 loss → 10% below entry
    assert plan["stop_distance_pct"] == pytest.approx(10.0, abs=0.01)
    assert plan["atr_mult"] == pytest.approx(3.33, abs=0.01)
    assert plan["noise"] == "OK"
