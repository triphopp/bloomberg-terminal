"""TRADE GUARD override endpoints against an isolated DB (no network)."""
import importlib

import pytest


@pytest.fixture()
def risk(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "t.db"))
    monkeypatch.setenv("SYNC_DEVICE_ID", "PC")
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_guard_schema(); db.init_alerts_schema(); db.init_sync_layer()
    import routers.risk as mod
    importlib.reload(mod)
    return mod


def _hold(mod, codes=("STOP_HIT",), reason="earnings next week"):
    return mod.create_guard_override(mod.GuardOverrideIn(
        account_id="dime", yf_symbol="goog", first_entry="2026-05-06T00:00:00",
        symbol="GOOG", codes=list(codes), reason=reason,
    ))


def test_create_replaces_previous_hold_and_delete_undoes(risk):
    first = _hold(risk)
    second = _hold(risk, codes=("STOP_HIT", "TIME"), reason="thesis intact")
    active = risk._guard_overrides(None)
    assert [o["id"] for o in active] == [second["id"]]
    assert active[0]["codes"] == ["STOP_HIT", "TIME"]
    assert active[0]["yf_symbol"] == "GOOG" and active[0]["first_entry"] == "2026-05-06"
    history = risk._guard_overrides(None, active_only=False)
    assert {o["id"] for o in history} == {first["id"], second["id"]}

    assert risk.delete_guard_override(second["id"])["deleted"] == 1
    assert risk._guard_overrides(None) == []


def test_create_requires_codes(risk):
    assert _hold(risk, codes=())["ok"] is False


def test_create_requires_reason_and_stores_review_date(risk):
    assert _hold(risk, reason="  ")["error"] == "reason required"
    out = risk.create_guard_override(risk.GuardOverrideIn(
        account_id="a", yf_symbol="goog", first_entry="2026-09-01", symbol="GOOG",
        codes=["STOP_HIT"], reason="earnings", review_days=7, floor_price=150.0))
    from datetime import date, timedelta
    assert out["review_on"] == (date.today() + timedelta(days=7)).isoformat()
    row = risk._guard_overrides(None)[0]
    assert row["review_on"] == out["review_on"] and row["floor_price"] == 150.0
    bad = risk.GuardOverrideIn(account_id="a", yf_symbol="g", first_entry="2026-09-01",
                               codes=["STOP_HIT"], reason="x", review_days=0)
    assert risk.create_guard_override(bad)["ok"] is False


def _lot(conn, tid, sl=None, acct="finansia", sym="AOT", wl="P"):
    conn.execute(
        "INSERT INTO trades (id, account_id, symbol, resolved_symbol, price_entry, volume, "
        "date_entry, win_loss, price_stoploss, currency) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (tid, acct, sym, f"{sym}.BK", 65.0, 100, "2026-08-17", wl, sl, "THB"),
    )


def test_apply_stops_writes_only_missing_atr_stops(risk, monkeypatch, tmp_path):
    import db
    with db.get_db() as conn:
        conn.execute("INSERT OR IGNORE INTO portfolio_accounts (id, name, currency) VALUES ('finansia','F','THB')")
        _lot(conn, "a1")                    # no stop → written
        _lot(conn, "a2", sl=60.0)           # manual stop → kept
        _lot(conn, "a3", wl="W")            # closed → untouched
        _lot(conn, "b1", sym="DMT")         # DEFAULT source → skipped
        conn.commit()
    snap = {"positions": [
        {"symbol": "AOT", "account_id": "finansia", "yf_symbol": "AOT.BK", "stop_source": "ATR",
         "stop": 61.75, "stop_distance_pct": 5.0, "price": 62.5, "flags": []},
        {"symbol": "DMT", "account_id": "finansia", "yf_symbol": "DMT.BK", "stop_source": "DEFAULT",
         "stop": 10.0, "stop_distance_pct": 8.0, "price": 12.1, "flags": []},
    ]}
    monkeypatch.setattr(risk, "_guard_snapshot", lambda a, b: snap)
    monkeypatch.setattr(risk, "_backup_db", lambda tag: str(tmp_path / "bak"))

    dry = risk.apply_guard_stops(risk.GuardApplyStopsIn())
    assert dry["dry_run"] and dry["lots"] == 1 and dry["plan"][0]["lot_ids"] == ["a1"]
    assert dry["skipped"][0]["symbol"] == "DMT"

    real = risk.apply_guard_stops(risk.GuardApplyStopsIn(dry_run=False))
    assert real["lots"] == 1 and real["backup"]
    with db.get_db() as conn:
        got = dict(conn.execute("SELECT id, price_stoploss FROM trades").fetchall())
    assert got == {"a1": 61.75, "a2": 60.0, "a3": None, "b1": None}


def test_evaluate_var_forecasts_scores_next_day_only(risk):
    import json

    import numpy as np
    import pandas as pd

    idx = pd.to_datetime(["2026-09-01", "2026-09-02", "2026-09-03"])
    rets = pd.DataFrame({"A.BK": np.log1p([0.00, -0.03, 0.01]),
                         "B": np.log1p([0.00, 0.01, np.nan])}, index=idx)
    f = lambda d, var: {"forecast_date": d, "confidence": 0.95, "var_hist_pct": var,
                        "cvar_pct": 3.0, "var_cf_pct": var, "ensemble_pct": 3.0,
                        "holdings": json.dumps({"A.BK": {"w": 0.5}, "B": {"w": 0.5}})}
    out = risk._evaluate_var_forecasts([f("2026-09-01", 0.5), f("2026-09-02", 0.5), f("2026-09-03", 0.5)], rets)
    rows = {r["forecast_date"]: r for r in out["rows"]}
    # 09-01 is judged on 09-02: 0.5×−3% + 0.5×+1% = −1% → exception vs 0.5%, not vs cvar 3%
    assert rows["2026-09-01"]["return_date"] == "2026-09-02"
    assert rows["2026-09-01"]["realized_pct"] == pytest.approx(-1.0)
    assert rows["2026-09-01"]["hist_exception"] and not rows["2026-09-01"]["cvar_exception"]
    # 09-02 → 09-03: B has no return → A alone +1%
    assert rows["2026-09-02"]["realized_pct"] == pytest.approx(1.0)
    assert rows["2026-09-02"]["coverage_pct"] == 50.0
    assert out["pending"] == 1                    # 09-03 has no later day yet
    assert out["summary"]["hist"]["signal"] == "INSUFFICIENT_DATA"


def test_rolling_oos_backtest_is_not_tautological(risk):
    import numpy as np

    rng = np.random.default_rng(1)
    calm_then_wild = np.r_[rng.normal(0, 0.005, 150), rng.normal(0, 0.03, 100)]
    exc, n, rate, signal = risk._var_backtest_oos(calm_then_wild, 0.95, window=100)
    assert n == 150 and signal == "RED"          # a vol jump must be caught
    steady = rng.normal(0, 0.01, 400)
    assert risk._var_backtest_oos(steady, 0.95, window=126)[3] in ("GREEN", "YELLOW")


def test_compute_risk_nav_basis_cash_short_and_options(risk, monkeypatch):
    import numpy as np
    import pandas as pd

    rng = np.random.default_rng(3)
    idx = pd.bdate_range("2025-09-01", periods=252)
    m = rng.normal(0, 0.01, 252)
    df = pd.DataFrame({"AAA": m + rng.normal(0, 0.002, 252), "BBB": m + rng.normal(0, 0.002, 252)}, index=idx)
    monkeypatch.setattr(risk, "_aligned_returns", lambda syms, *a, **k: (df[[s for s in syms if s in df]], []))

    def pos(sym, vol):
        return {"symbol": sym, "resolved_symbol": sym, "account_id": "x", "currency": "THB",
                "current_price": 100.0, "price_entry": 100.0, "volume": vol}

    base = risk._compute_portfolio_risk([pos("AAA", 10)], 252, 0.95, "THB")
    diluted = risk._compute_portfolio_risk([pos("AAA", 10)], 252, 0.95, "THB", cash_base=1000.0)
    hedged = risk._compute_portfolio_risk([pos("AAA", 10), pos("BBB", -10)], 252, 0.95, "THB", cash_base=1000.0)
    with_opt = risk._compute_portfolio_risk([pos("AAA", 10)], 252, 0.95, "THB", cash_base=1000.0,
                                           extra_exposure={"BBB": (1000.0, "THB", "BBB (options Δ)")})

    assert diluted["nav_value"] == 2000 and diluted["cash_value"] == 1000
    assert diluted["var_historical_pct"] == pytest.approx(base["var_historical_pct"] / 2, rel=0.02)
    assert hedged["short_value"] == -1000 and hedged["net_exposure_pct"] == 0
    # NAV = +1000 long −1000 short +1000 cash = 1000 → weights ±1; the shared
    # factor cancels and only the two residuals (0.2%/day each) remain.
    assert hedged["nav_value"] == 1000
    assert hedged["var_historical_pct"] < diluted["var_historical_pct"] / 1.5
    assert with_opt["option_delta_value"] == 1000
    # +1000 delta on a correlated name: NAV 3000, risky share 2/3 vs 1/2 → ≈ ×4/3
    assert with_opt["nav_value"] == 3000
    assert with_opt["var_historical_pct"] == pytest.approx(diluted["var_historical_pct"] * 4 / 3, rel=0.1)
