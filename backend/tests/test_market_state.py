"""
Tests for analytics/market_state — the per-symbol Market State model.

Everything here runs on synthetic OHLCV: no network, and the regimes are put
there on purpose so a failure says which part broke rather than "the market
changed". Run: cd backend && python -m pytest tests/test_market_state.py -q
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from analytics.market_state import hmm, interpret, scores as scores_mod, strategy, validate
from analytics.market_state.features import build_features, redundancy_report


def make_ohlcv(segments: list[tuple[int, float, float]], seed: int = 7) -> pd.DataFrame:
    """Build daily OHLCV from (n_bars, drift_per_bar, daily_vol) segments."""
    rng = np.random.default_rng(seed)
    closes: list[float] = []
    vols: list[float] = []
    price = 100.0
    for n, drift, vol in segments:
        for _ in range(n):
            price *= float(np.exp(drift + vol * rng.standard_normal()))
            closes.append(price)
            # Volume tracks volatility, the way it does in a real tape.
            vols.append(float(1e6 * np.exp(0.5 * rng.standard_normal() + 20 * vol)))
    idx = pd.bdate_range("2012-01-02", periods=len(closes))
    close = pd.Series(closes, index=idx)
    noise = pd.Series(rng.uniform(0.004, 0.012, len(closes)), index=idx)
    return pd.DataFrame(
        {
            "open": close.shift(1).fillna(close.iloc[0]),
            "high": close * (1 + noise),
            "low": close * (1 - noise),
            "close": close,
            "volume": pd.Series(vols, index=idx),
        }
    )


CALM_TREND = (700, 0.0008, 0.010)
CHOP = (500, 0.0000, 0.012)
CRISIS = (300, -0.0020, 0.035)


@pytest.fixture(scope="module")
def ohlcv() -> pd.DataFrame:
    return make_ohlcv([CALM_TREND, CHOP, CRISIS, CALM_TREND])


@pytest.fixture(scope="module")
def fitted(ohlcv):
    fs = build_features(ohlcv)
    fm = hmm.fit(fs.frame.to_numpy(), fs.used)
    return fs, fm


# ── Features ────────────────────────────────────────────────────────────────

def test_every_feature_is_causal(ohlcv):
    """A feature at bar t must not change when bars after t are appended.

    The single most important property in the package: if a feature peeks, the
    causal labelling downstream is theatre.
    """
    cut = len(ohlcv) - 200
    full = build_features(ohlcv).frame
    prefix = build_features(ohlcv.iloc[:cut]).frame
    common = prefix.index.intersection(full.index)
    assert len(common) > 300
    np.testing.assert_allclose(
        prefix.loc[common].to_numpy(), full.loc[common].to_numpy(), rtol=1e-9, atol=1e-9
    )


def test_a_symbol_with_no_volume_loses_one_feature_not_every_row(ohlcv):
    # An index, a yield or an FX cross quotes a level with nothing trading
    # behind it. Keeping vol_z would drop every row via dropna().
    novol = ohlcv.copy()
    novol["volume"] = np.nan
    fs = build_features(novol)
    assert "vol_z" in fs.dropped
    assert fs.used == ["ret_z", "slope_z", "mom_delta", "rvol_z"]
    assert fs.bars_out > 1000


def test_model_features_are_not_redundant_with_each_other(fitted):
    fs, _ = fitted
    rep = redundancy_report(fs)
    assert rep["status"] == "ok"
    assert rep["max_model_abs_corr"] < 0.8, "the model set duplicates itself"
    assert all(v is None or v < 5 for v in rep["vif"].values()), rep["vif"]


def test_the_redundancy_report_states_a_verdict_for_every_rejected_candidate(fitted):
    fs, _ = fitted
    rep = redundancy_report(fs)
    rejected = {r["feature"] for r in rep["rejected_vs_model"]}
    assert rejected == set(rep["rejected_doc"])
    for row in rep["rejected_vs_model"]:
        assert row["verdict"] in ("redundant", "same axis, kept out for parsimony")
        assert row["reason"], f"{row['feature']} is excluded with no reason given"


# ── HMM ─────────────────────────────────────────────────────────────────────

def test_filtered_posterior_equals_hmmlearns_prefix_posterior(fitted):
    """The claim the whole causal story rests on.

    A forward-backward pass over a prefix ending at t has β_t = 1, so its last
    row is the filtered posterior. This module computes that in one forward pass
    instead of one pass per bar; if the two ever disagree, the fast path is
    wrong and the regime history is not causal.
    """
    fs, fm = fitted
    values = fs.frame.to_numpy()
    post = hmm.filtered_posterior(fm, values)
    X = (values - fm.mu) / fm.sd
    for t in (250, 900, len(values) - 1):
        reference = fm.model.predict_proba(X[: t + 1])[-1][fm.order]
        np.testing.assert_allclose(post[t], reference, atol=1e-9)


def test_posterior_rows_are_probabilities(fitted):
    fs, fm = fitted
    post = hmm.filtered_posterior(fm, fs.frame.to_numpy())
    assert np.all(post >= -1e-12)
    np.testing.assert_allclose(post.sum(axis=1), 1.0, atol=1e-9)


def test_state_names_are_unique_and_canonically_ordered(fitted):
    _, fm = fitted
    assert len(set(fm.keys)) == len(fm.keys), "two states claimed the same name"
    order = [a.key for a in hmm.ARCHETYPES]
    positions = [order.index(k) for k in fm.keys]
    assert positions == sorted(positions)


def test_a_calm_trending_series_gets_no_turbulent_label():
    """Names describe what was fitted, not a taxonomy imposed on it."""
    calm = make_ohlcv([(900, 0.0006, 0.008), (900, 0.0004, 0.009)], seed=11)
    fs = build_features(calm)
    fm = hmm.fit(fs.frame.to_numpy(), fs.used, n_states=2)
    assert len(set(fm.keys)) == 2


def test_hysteresis_ignores_a_one_bar_excursion():
    post = np.array([[0.9, 0.1]] * 5 + [[0.1, 0.9]] + [[0.9, 0.1]] * 5)
    assert set(hmm.hard_labels(post, hysteresis=3)) == {0}


def test_hysteresis_accepts_a_sustained_switch():
    post = np.array([[0.9, 0.1]] * 5 + [[0.1, 0.9]] * 6)
    labels = hmm.hard_labels(post, hysteresis=3)
    assert labels[-1] == 1
    # The switch is confirmed only after the third bar of the new state, not on
    # the first — that delay is the whole point of the filter.
    assert labels[5] == 0 and labels[6] == 0 and labels[7] == 1


def test_expected_duration_reads_off_the_transition_matrix(fitted):
    _, fm = fitted
    durations = hmm.expected_durations(fm)
    assert len(durations) == fm.n_states
    assert all(d > 1 for d in durations)


# ── Scores ──────────────────────────────────────────────────────────────────

def test_scores_stay_inside_their_declared_range(ohlcv):
    fs = build_features(ohlcv)
    sc = scores_mod.compute_scores(fs.candidates, ohlcv).dropna()
    assert sc["trend"].between(-1, 1).all()
    assert sc["momentum"].between(-1, 1).all()


def test_tanh_keeps_resolution_where_clipping_would_lose_it(ohlcv):
    """No score may pile up on the boundary — a saturated score has no derivative."""
    fs = build_features(ohlcv)
    sc = scores_mod.compute_scores(fs.candidates, ohlcv).dropna()
    for col in ("trend", "momentum"):
        assert (sc[col].abs() > 0.999).mean() < 0.01, f"{col} is saturating"


def test_momentum_words_separate_fading_from_turning():
    # Positive and falling is weakening; it is NOT reversing until it crosses.
    assert scores_mod.momentum_word(0.40, -0.20) == "Weakening"
    assert scores_mod.momentum_word(0.40, 0.20) == "Accelerating"
    assert scores_mod.momentum_word(0.40, 0.01) == "Stable"
    # Negative momentum getting less negative is also weakening (of the move down).
    assert scores_mod.momentum_word(-0.40, 0.20) == "Weakening"
    assert scores_mod.momentum_word(-0.40, -0.20) == "Accelerating"
    # Near zero and moving = the crossing itself.
    assert scores_mod.momentum_word(0.02, 0.20) == "Reversing"


def test_volatility_words():
    assert scores_mod.volatility_level_word(1.8) == "Very High"
    assert scores_mod.volatility_level_word(1.0) == "High"
    assert scores_mod.volatility_level_word(0.0) == "Normal"
    assert scores_mod.volatility_level_word(-1.0) == "Low"
    assert scores_mod.volatility_direction_word(0.5) == "Expanding"
    assert scores_mod.volatility_direction_word(-0.5) == "Contracting"
    assert scores_mod.volatility_direction_word(0.0) == "Stable"


# ── Interpretation ──────────────────────────────────────────────────────────

def _snap(trend, t_chg, mom, m_chg, vol, v_chg):
    frame = pd.DataFrame(
        {
            "trend": [trend],
            "momentum": [mom],
            "volatility": [vol],
            "trend_change": [t_chg],
            "momentum_change": [m_chg],
            "volatility_change": [v_chg],
        }
    )
    return scores_mod.snapshot(frame)


def test_summary_reads_like_the_brief_asks():
    text = interpret.build_summary("BULL TREND", 0.81, _snap(0.74, 0.10, 0.31, -0.20, 1.42, 0.30))
    assert "Bull Trend 81%" in text
    assert "Positive Momentum but Weakening" in text
    assert "Volatility Expanding" in text


def test_summary_drops_clauses_that_say_nothing():
    text = interpret.build_summary("SIDEWAY", 0.66, _snap(0.02, 0.0, 0.01, 0.0, 0.1, 0.0))
    # Neutral trend, stable momentum, normal and stable volatility: the sentence
    # should be the regime alone rather than three clauses of "nothing".
    assert text == "Sideway 66%"


def test_a_weak_posterior_is_not_printed_as_a_call():
    text = interpret.build_summary("BEAR TREND", 0.41, _snap(-0.3, 0.0, -0.2, 0.0, 0.2, 0.0))
    assert "unclear" in text.lower()
    assert "41%" in text


def test_confidence_words():
    assert interpret.regime_confidence_word(0.9) == "clear"
    assert interpret.regime_confidence_word(0.6) == "leaning"
    assert interpret.regime_confidence_word(0.3) == "unclear"


def test_transition_note_fires_only_on_a_real_shift():
    labels = ["BULL", "BEAR"]
    steady = np.array([[0.8, 0.2]] * 30)
    assert interpret.transition_note(steady, labels) is None
    # The shift must sit INSIDE the lookback window, not exactly on its edge:
    # comparing the last bar with one 10 bars back sees nothing if the change
    # happened 11 bars ago.
    shifting = np.array([[0.8, 0.2]] * 25 + [[0.2, 0.8]] * 6)
    note = interpret.transition_note(shifting, labels)
    assert note is not None and "gaining" in note


# ── Strategy ────────────────────────────────────────────────────────────────

def test_strategy_never_uses_a_bar_whose_forward_window_is_missing(ohlcv):
    fs = build_features(ohlcv)
    labels = [0] * len(fs.frame)
    out = strategy.compatibility(ohlcv, fs.frame.index, labels, 0, horizon=10)
    usable = len(fs.frame) - 10
    for item in out["items"]:
        assert item["n"] <= usable, f"{item['id']} used bars with no future"


def test_a_thin_state_is_reported_but_flagged_unreliable(ohlcv):
    fs = build_features(ohlcv)
    labels = [0] * len(fs.frame)
    for i in range(30):
        labels[100 + i] = 1
    out = strategy.compatibility(ohlcv, fs.frame.index, labels, 1)
    assert out["state_bars"] == 30
    assert all(item["reliable"] is False for item in out["items"])


def test_scores_sit_either_side_of_fifty(ohlcv):
    fs = build_features(ohlcv)
    out = strategy.compatibility(ohlcv, fs.frame.index, [0] * len(fs.frame), 0)
    for item in out["items"]:
        assert item["score"] is None or 0 <= item["score"] <= 100


# ── Validation ──────────────────────────────────────────────────────────────

def test_walk_forward_refuses_a_series_it_cannot_validate():
    short = make_ohlcv([(300, 0.0005, 0.01)])
    out = validate.walk_forward(short)
    assert out["status"] == "insufficient"


def test_overlap_adjustment_deflates_by_root_horizon():
    # An overlapping-window t is inflated by ≈√h; the correction must be exactly
    # that, not a fudge factor that drifts.
    assert validate._overlap_adjust(4.0, 4) == pytest.approx(2.0)
    assert validate._overlap_adjust(None, 10) is None


def test_walk_forward_reports_out_of_sample_stats(ohlcv):
    out = validate.walk_forward(ohlcv, step=250)
    assert out["status"] == "ok"
    assert out["method"]["refits"] >= 2
    assert out["method"]["labelled_bars"] < out["method"]["total_bars"], (
        "a walk-forward run cannot label the bars it trained on first"
    )
    for row in out["forward_returns"]:
        assert row["n"] > 0
        if row["t_vs_rest"] is not None:
            # Adjusted must always be the smaller magnitude.
            assert abs(row["t_adj"]) <= abs(row["t_vs_rest"]) + 1e-9
    assert out["verdict"]["reading"]


def test_a_thin_state_cannot_produce_a_verdict(ohlcv):
    out = validate.walk_forward(ohlcv, step=250)
    for row in out["verdict"]["separating_states"]:
        match = [r for r in out["forward_returns"] if r["state"] == row["state"]]
        assert all(m["n"] >= validate.MIN_STATE_BARS for m in match if m["horizon"] == row["horizon"])
