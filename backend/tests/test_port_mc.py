"""Portfolio Monte Carlo — backend/port_mc.py + the /risk/monte-carlo inputs (no network)."""
import numpy as np
import pandas as pd
import pytest

import port_mc as mc


def _fat(seed: int, T: int = 750, m: int = 3, skew: bool = True) -> np.ndarray:
    """Standardized residual days with fat tails (t3) and, optionally, a right skew."""
    rng = np.random.default_rng(seed)
    z = rng.standard_t(3, size=(T, m))
    if skew:
        z = np.where(z > 0, z * 1.6, z)
    return (z - z.mean(0)) / z.std(0)


LR = np.array([0.02, 0.03, 0.05]) ** 2


# ── garch_filter ─────────────────────────────────────────────────────────────

def test_filter_standardizes_and_keeps_missing_days():
    rng = np.random.default_rng(0)
    R = rng.standard_normal((500, 2)) * [0.01, 0.03]
    R[:200, 1] = np.nan                                  # listed 200 days late
    Z, s2, lr = mc.garch_filter(R)
    assert np.isnan(Z[:200, 1]).all() and not np.isnan(Z[200:, 1]).any()
    assert np.allclose(np.nanmean(Z, axis=0), 0, atol=1e-9)
    assert np.allclose(np.nanstd(Z, axis=0), 1, atol=1e-9)
    assert np.allclose(np.sqrt(lr), [0.01, 0.03], rtol=0.1)
    assert np.allclose(np.sqrt(s2 / lr), 1, atol=0.35)   # steady vol → tomorrow ≈ average


def test_filter_sees_a_volatile_last_month():
    rng = np.random.default_rng(1)
    R = rng.standard_normal((500, 1)) * 0.01
    R[-20:] *= 4
    _, s2, lr = mc.garch_filter(R)
    assert s2[0] > 3 * lr[0]


# ── backfill ─────────────────────────────────────────────────────────────────

def test_backfill_ties_a_new_listing_to_its_market():
    rng = np.random.default_rng(2)
    f = rng.standard_normal(750)
    young = 0.7 * f + np.sqrt(1 - 0.49) * rng.standard_normal(750)
    Z = np.column_stack([rng.standard_normal(750), young])
    Z[:450, 1] = np.nan
    out, filled = mc.backfill(Z, np.column_stack([np.full(750, np.nan), f]))
    assert filled.tolist() == [0, 450]
    assert not np.isnan(out).any()
    assert np.array_equal(out[:, 0], Z[:, 0])            # complete columns are left alone
    assert np.corrcoef(out[:450, 1], f[:450])[0, 1] == pytest.approx(0.7, abs=0.1)
    assert out[:, 1].mean() == pytest.approx(0, abs=1e-9)
    assert out[:, 1].std() == pytest.approx(1, abs=1e-9)


def test_backfill_without_a_market_reuses_own_days():
    Z = np.column_stack([np.linspace(-2, 2, 300), np.linspace(-1, 1, 300)])
    Z[:250, 1] = np.nan                                  # 50 own days: below MIN_OVERLAP is fine too
    out, filled = mc.backfill(Z, None)
    assert filled[1] == 250 and not np.isnan(out).any()
    with pytest.raises(ValueError):
        mc.backfill(np.full((10, 1), np.nan), None)


# ── simulate ─────────────────────────────────────────────────────────────────

def test_zero_drift_is_a_martingale_even_with_fat_skewed_tails():
    Z = _fat(3)
    out = mc.simulate([400.0, 300.0, 200.0], 1000.0, Z, LR * 2, LR, horizon=63, n_paths=40_000)
    sd = (out["final"]["p75"] - out["final"]["p25"]) / 1.35          # rough σ of the outcome, %
    assert abs(out["final"]["mean"]) < 4 * sd / np.sqrt(40_000) + 0.05
    assert out["final"]["p50"] < 0                                    # volatility drag


def test_drift_moves_the_mean_by_the_invested_share():
    Z = _fat(4)
    out = mc.simulate([500.0, 0.0, 0.0], 1000.0, Z, LR, LR, horizon=252, n_paths=40_000,
                      drift_daily=1.10 ** (1 / 252) - 1)
    assert out["final"]["mean"] == pytest.approx(5.0, abs=0.5)        # +10% on half the book


def test_matches_the_normal_formula_when_the_days_are_normal():
    rng = np.random.default_rng(5)
    Z = rng.standard_normal((5000, 1))
    Z = (Z - Z.mean()) / Z.std()
    lr = np.array([0.01 ** 2])
    # α/β only move variance around its long-run level; the horizon σ stays σ√H.
    out = mc.simulate([1.0], 1.0, Z, lr, lr, horizon=21, n_paths=40_000)
    assert out["var95_pct"] == pytest.approx(1.645 * np.sqrt(21), rel=0.06)
    assert out["cvar95_pct"] > out["var95_pct"] and out["var99_pct"] > out["var95_pct"]


def test_cash_dilutes_and_a_short_mirrors_a_long():
    Z = _fat(6)
    full = mc.simulate([1000.0, 0, 0], 1000.0, Z, LR, LR, horizon=21, n_paths=5000)
    half = mc.simulate([500.0, 0, 0], 1000.0, Z, LR, LR, horizon=21, n_paths=5000)
    short = mc.simulate([-1000.0, 0, 0], 1000.0, Z, LR, LR, horizon=21, n_paths=5000)
    assert half["var95_pct"] == pytest.approx(full["var95_pct"] / 2, rel=1e-6)
    assert short["var95_pct"] == pytest.approx(full["final"]["p95"], abs=2e-3)
    assert short["final"]["p5"] == pytest.approx(-full["final"]["p95"], abs=2e-3)


def test_todays_volatility_regime_widens_the_range():
    Z = _fat(7)
    calm = mc.simulate([1000.0, 0, 0], 1000.0, Z, LR, LR, horizon=21, n_paths=10_000)
    hot = mc.simulate([1000.0, 0, 0], 1000.0, Z, LR * 4, LR, horizon=21, n_paths=10_000)
    assert hot["var95_pct"] > 1.3 * calm["var95_pct"]
    assert hot["max_dd"]["p95"] < calm["max_dd"]["p95"]


def test_same_seed_same_answer_on_any_thread_count(monkeypatch):
    Z = _fat(8)
    args = ([400.0, 300.0, 200.0], 1000.0, Z, LR, LR)
    a = mc.simulate(*args, horizon=30, n_paths=7000)
    monkeypatch.setattr(mc, "MAX_THREADS", 1)
    b = mc.simulate(*args, horizon=30, n_paths=7000)
    assert a == b
    assert mc.simulate(*args, horizon=30, n_paths=7000, seed=8) != a


def test_tail_shares_add_up_to_the_expected_shortfall():
    Z = _fat(9)
    expo = np.array([400.0, 300.0, 200.0])
    groups = {"a": np.array([400.0, 100.0, 0.0]), "b": np.array([0.0, 200.0, 200.0])}
    out = mc.simulate(expo, 1000.0, Z, LR, LR, horizon=63, n_paths=10_000, groups=groups)
    assert sum(a["tail_contrib_pct"] for a in out["assets"]) == pytest.approx(-out["cvar95_pct"], abs=0.02)
    assert sum(a["tail_share_pct"] for a in out["assets"]) == pytest.approx(100, abs=0.3)
    assert sum(g["tail_contrib_pct"] for g in out["groups"]) == pytest.approx(-out["cvar95_pct"], abs=0.02)
    # the 5%-a-day holding carries more of the tail than its weight
    assert out["assets"][2]["tail_share_pct"] > 200 / 900 * 100


def test_shape_of_the_result():
    Z = _fat(10)
    out = mc.simulate([500.0, 300.0, 100.0], 1000.0, Z, LR, LR, horizon=252, n_paths=3000)
    days = out["days"]
    assert days[0] == 0 and days[-1] == 252 and len(days) <= mc.MAX_POINTS + 1
    b = out["bands"]
    assert all(len(b[k]) == len(days) for k in b) and all(b[k][0] == 100 for k in b)
    assert all(b["p5"][i] <= b["p25"][i] <= b["p50"][i] <= b["p75"][i] <= b["p95"][i]
               for i in range(len(days)))
    assert len(out["sample_paths"]) == mc.SAMPLE_PATHS and len(out["sample_paths"][0]) == len(days)
    probs = [x["prob_pct"] for x in out["loss_prob"]]
    assert probs == sorted(probs, reverse=True) and probs[0] == pytest.approx(out["p_loss"], abs=0.01)
    assert out["max_dd"]["p95"] <= out["max_dd"]["p50"] <= 0
    assert sum(out["hist"]["pct"]) == pytest.approx(100, abs=0.1)
    assert len(out["hist"]["edges"]) == len(out["hist"]["pct"]) + 1
    assert set(out["se"]) == {"var95_pct", "cvar95_pct", "var99_pct", "cvar99_pct", "p_loss", "p50"}


def test_reported_sampling_error_shrinks_with_paths():
    Z = _fat(11)
    few = mc.simulate([900.0, 0, 0], 1000.0, Z, LR, LR, horizon=21, n_paths=2000)
    many = mc.simulate([900.0, 0, 0], 1000.0, Z, LR, LR, horizon=21, n_paths=40_000)
    assert many["se"]["var95_pct"] < few["se"]["var95_pct"] / 2


def test_an_outlier_day_cannot_snowball():
    Z = _fat(12)
    Z[0] = [25.0, -25.0, 25.0]                            # a 25-sigma day in the window
    out = mc.simulate([400.0, 300.0, 200.0], 1000.0, Z, LR, LR, horizon=252, n_paths=5000)
    flat = np.array(out["sample_paths"])
    assert np.isfinite(flat).all()
    assert all(np.isfinite(v) for v in out["final"].values())
    assert out["final"]["p1"] >= -90.01                   # NAV cannot fall below cash + nothing


# ── /risk/monte-carlo inputs ─────────────────────────────────────────────────

def _prices(days: int, cols: dict[str, tuple[float, int]], seed: int = 0) -> pd.DataFrame:
    """{symbol: (daily σ, bars)} → close frame on a business-day index."""
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range(end="2026-09-30", periods=days)
    market = rng.standard_normal(days) * 0.01
    out = {}
    for sym, (vol, bars) in cols.items():
        r = 0.8 * market * (vol / 0.01) + rng.standard_normal(days) * vol * 0.6
        px = 100 * np.exp(np.cumsum(r))
        px[: days - bars] = np.nan
        out[sym] = px
    return pd.DataFrame(out, index=idx)


@pytest.fixture
def risk_book(monkeypatch):
    from routers import risk

    monkeypatch.setattr(risk, "_mc_cache", risk.TTLCache(ttl=600, maxsize=64))
    positions = [
        {"symbol": "OLD", "resolved_symbol": "OLD", "account_id": "dime", "volume": 10,
         "current_price": 100.0, "currency": "THB"},
        {"symbol": "NEW", "resolved_symbol": "NEW", "account_id": "dime", "volume": 5,
         "current_price": 100.0, "currency": "THB"},
        {"symbol": "TH", "resolved_symbol": "TH.BK", "account_id": "finansia", "volume": 20,
         "current_price": 50.0, "currency": "THB"},
    ]
    monkeypatch.setattr(
        risk, "_open_positions_priced",
        lambda acc: [p for p in positions if acc in (None, "all") or p["account_id"] == acc])
    monkeypatch.setattr(risk, "_risk_extras", lambda acc, base, summ=None: (500.0, {}))
    monkeypatch.setattr(risk, "_mc_book_stamp", lambda acc: f"{acc}:{len(positions)}")
    import routers.portfolio_v2 as pv2
    monkeypatch.setattr(pv2, "get_summary", lambda base_currency="THB": {})
    frame = _prices(800, {"OLD": (0.02, 800), "NEW": (0.03, 150), "TH.BK": (0.01, 800),
                          "^GSPC": (0.01, 800), "TDEX.BK": (0.008, 800)})
    calls: list[list[str]] = []

    def fake_frame(symbols, days=252):
        calls.append(list(symbols))
        got = [s for s in symbols if s in frame.columns]
        if len(calls) == 1:                               # the joint download loses OLD
            got = [s for s in got if s != "OLD"]
        return frame[got]

    monkeypatch.setattr(risk, "_fetch_close_frame", fake_frame)
    return risk, calls


def test_inputs_recover_a_lost_symbol_and_backfill_a_new_listing(risk_book):
    risk, calls = risk_book
    inp = risk._mc_inputs(None, "THB")
    assert calls[1] == ["OLD"]                            # asked again on its own
    assert inp["symbols"] == ["OLD", "NEW", "TH.BK"] and inp["excluded"] == []
    assert inp["nav"] == pytest.approx(1000 + 500 + 1000 + 500)
    assert inp["window_days"] == risk.MC_WINDOW_DAYS      # NEW's 150 bars did not cut the window
    assert inp["history_days"][1] == 149 and inp["filled"][1] == risk.MC_WINDOW_DAYS - 149
    assert not np.isnan(inp["Z"]).any()
    assert set(inp["groups"]) == {"dime", "finansia"}
    assert inp["groups"]["dime"].tolist() == [1000.0, 500.0, 0.0]


def test_endpoint_scopes_to_one_account(risk_book):
    risk, _ = risk_book
    kw = dict(horizon=21, n_paths=2000, vol="current", drift_annual_pct=0.0,
              base_currency="THB", fresh=False)
    book = risk.get_monte_carlo(account_id=None, **kw)
    dime = risk.get_monte_carlo(account_id="dime", **kw)
    assert {h["symbol"] for h in book["holdings"]} == {"OLD", "NEW", "TH"}
    assert {h["symbol"] for h in dime["holdings"]} == {"OLD", "NEW"}
    assert dime["account_id"] == "dime" and dime["groups"] == []
    assert dime["nav"] == pytest.approx(2000.0)
    assert sum(h["weight_pct"] for h in dime["holdings"]) == pytest.approx(75.0, abs=0.01)
    assert dime["var95_pct"] > book["var95_pct"]          # fewer names, more volatile ones
    assert risk.get_monte_carlo(account_id="dime", **kw) is dime      # served from cache
    new = next(h for h in dime["holdings"] if h["symbol"] == "NEW")
    assert new["filled_days"] > 0 and new["factor"] == "S&P 500"


def test_a_trade_is_in_the_next_run_without_waiting_for_the_cache(risk_book, monkeypatch):
    risk, _ = risk_book
    kw = dict(horizon=21, n_paths=2000, vol="current", drift_annual_pct=0.0,
              base_currency="THB", fresh=False)
    before = risk.get_monte_carlo(account_id="dime", **kw)
    assert risk.get_monte_carlo(account_id="dime", **kw) is before    # same book → cached
    # NEW is sold: the open lots change, and so does the book stamp
    monkeypatch.setattr(risk, "_mc_book_stamp", lambda acc: "after-the-sell")
    held = risk._open_positions_priced
    monkeypatch.setattr(risk, "_open_positions_priced",
                        lambda acc: [p for p in held(acc) if p["symbol"] != "NEW"])
    after = risk.get_monte_carlo(account_id="dime", **kw)
    assert [h["symbol"] for h in after["holdings"]] == ["OLD"]
    assert after["nav"] == pytest.approx(1500.0)


def test_book_stamp_follows_the_open_lots(tmp_path, monkeypatch):
    import sqlite3
    from contextlib import contextmanager

    from routers import risk

    db = sqlite3.connect(tmp_path / "t.db")
    db.execute("CREATE TABLE trades (account_id, symbol, volume, win_loss)")
    db.executemany("INSERT INTO trades VALUES (?, ?, ?, ?)",
                   [("dime", "INTC", 10, "P"), ("dime", "MU", 5, "P"), ("finansia", "AOT", 100, "P")])

    @contextmanager
    def fake_db():
        yield db

    monkeypatch.setattr(risk, "get_db", fake_db)
    all0, dime0, fin0 = (risk._mc_book_stamp(a) for a in (None, "dime", "finansia"))
    assert risk._mc_book_stamp(None) == all0                          # stable while nothing trades
    db.execute("UPDATE trades SET win_loss = 'W' WHERE symbol = 'MU'")    # MU sold
    assert risk._mc_book_stamp(None) != all0 and risk._mc_book_stamp("dime") != dime0
    assert risk._mc_book_stamp("finansia") == fin0                    # another account's trade
    db.execute("INSERT INTO trades VALUES ('finansia', 'AOT', 50, 'P')")  # bought more AOT
    assert risk._mc_book_stamp("finansia") != fin0


def test_endpoint_with_no_positions(risk_book, monkeypatch):
    risk, _ = risk_book
    monkeypatch.setattr(risk, "_open_positions_priced", lambda acc: [])
    out = risk.get_monte_carlo(account_id="other", horizon=21, n_paths=2000, vol="current",
                               drift_annual_pct=0.0, base_currency="THB", fresh=False)
    assert out["holdings"] == [] and out["note"] == "no open positions"
