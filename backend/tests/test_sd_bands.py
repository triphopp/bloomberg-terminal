"""
Unit tests for backend/analytics/sd_bands.py

Run:
    cd backend
    python -m pytest tests/test_sd_bands.py -v
"""

import math
import sys

import pytest

sys.path.insert(0, ".")

from analytics.sd_bands import (
    BUCKET_PROBS,
    SD_LEVELS,
    Z_EDGES,
    atm_iv_pair,
    bucket_of,
    bucket_probs_under,
    realized_vol_series,
    sd_band,
)


# ── Bucket geometry ───────────────────────────────────────────────────────────

def test_bucket_probs_sum_to_one():
    assert sum(BUCKET_PROBS) == pytest.approx(1.0, abs=1e-12)


def test_bucket_probs_known_values():
    # Φ(-1.5)=0.066807, Φ(-0.5)=0.308538
    assert BUCKET_PROBS[0] == pytest.approx(0.066807, abs=1e-5)   # ≤ −1.5σ
    assert BUCKET_PROBS[1] == pytest.approx(0.241730, abs=1e-5)   # −1.5 … −0.5
    assert BUCKET_PROBS[2] == pytest.approx(0.382925, abs=1e-5)   # −0.5 … +0.5
    assert BUCKET_PROBS[3] == pytest.approx(0.241730, abs=1e-5)
    assert BUCKET_PROBS[4] == pytest.approx(0.066807, abs=1e-5)


def test_bucket_probs_symmetric():
    assert BUCKET_PROBS[0] == pytest.approx(BUCKET_PROBS[4])
    assert BUCKET_PROBS[1] == pytest.approx(BUCKET_PROBS[3])


def test_levels_and_edges_line_up():
    assert len(SD_LEVELS) == 5
    assert len(Z_EDGES) == 6
    assert len(BUCKET_PROBS) == 5


# ── Band geometry ─────────────────────────────────────────────────────────────

def test_sd_band_row_zero_is_lognormal_median():
    """Row 0 = S_0·e^{(r−q−σ²/2)T}, strictly BELOW the forward S_0·e^{(r−q)T}."""
    spot, sigma, T, r = 100.0, 0.20, 0.25, 0.05
    band = sd_band(spot, sigma, T, r)
    assert band is not None

    expected_median = spot * math.exp((r - 0.5 * sigma**2) * T)
    forward = spot * math.exp(r * T)

    assert band.levels[2] == pytest.approx(expected_median)
    assert band.levels[2] < forward
    # The gap is exactly the Ito term.
    assert forward / band.levels[2] == pytest.approx(math.exp(0.5 * sigma**2 * T))


def test_sd_band_levels_monotonic_and_geometric():
    band = sd_band(100.0, 0.30, 0.5, 0.04)
    assert band is not None
    assert band.levels == tuple(sorted(band.levels))
    # Lognormal → equal ratios between consecutive sd levels, not equal gaps.
    ratios = [band.levels[i + 1] / band.levels[i] for i in range(4)]
    for ratio in ratios[1:]:
        assert ratio == pytest.approx(ratios[0])
    assert ratios[0] == pytest.approx(math.exp(band.s))


def test_sd_band_edges_are_open_ended():
    band = sd_band(100.0, 0.25, 0.25)
    assert band is not None
    assert band.edges[0] == -math.inf
    assert band.edges[-1] == math.inf
    finite = band.edges[1:-1]
    assert list(finite) == sorted(finite)


def test_sd_band_wider_sigma_wider_band():
    narrow = sd_band(100.0, 0.15, 0.25)
    wide = sd_band(100.0, 0.45, 0.25)
    assert narrow is not None and wide is not None
    assert wide.levels[4] > narrow.levels[4]
    assert wide.levels[0] < narrow.levels[0]


@pytest.mark.parametrize(
    "spot,sigma,T",
    [(0, 0.2, 0.25), (-1, 0.2, 0.25), (100, 0, 0.25), (100, -0.2, 0.25), (100, 0.2, 0), (100, 0.2, -1)],
)
def test_sd_band_rejects_degenerate_inputs(spot, sigma, T):
    assert sd_band(spot, sigma, T) is None


# ── Bucket assignment ─────────────────────────────────────────────────────────

def test_bucket_of_finds_each_row():
    band = sd_band(100.0, 0.25, 0.25)
    assert band is not None
    for i, level_price in enumerate(band.levels):
        assert bucket_of(level_price, band.edges) == i


def test_bucket_of_boundary_assigns_upward():
    band = sd_band(100.0, 0.25, 0.25)
    assert band is not None
    # Landing exactly on the −1.5σ edge belongs to the −1 row, not the −2 row.
    assert bucket_of(band.edges[1], band.edges) == 1


def test_bucket_of_extremes_land_in_open_buckets():
    band = sd_band(100.0, 0.25, 0.25)
    assert band is not None
    assert bucket_of(0.01, band.edges) == 0
    assert bucket_of(1e9, band.edges) == 4


def test_bucket_of_rejects_bad_input():
    band = sd_band(100.0, 0.25, 0.25)
    assert band is not None
    assert bucket_of(0, band.edges) is None
    assert bucket_of(-5, band.edges) is None
    assert bucket_of(100, band.edges[:3]) is None


# ── Cross-sigma probabilities (cheapness mode) ────────────────────────────────

def test_same_sigma_reproduces_constant_bucket_probs():
    """Scoring the IV edges under the IV distribution must return the constants —
    this is the invariant that proves the two code paths agree."""
    spot, sigma, T, r = 100.0, 0.28, 0.35, 0.045
    band = sd_band(spot, sigma, T, r)
    assert band is not None

    probs = bucket_probs_under(spot, sigma, T, band.edges, r)
    assert probs is not None
    for got, want in zip(probs, BUCKET_PROBS):
        assert got == pytest.approx(want, abs=1e-9)


def test_lower_realized_vol_thins_the_tails():
    """The whole point of cheapness mode: RV < IV → tail mass below the IV
    constant (IV overpricing the tail), centre mass above it."""
    spot, T, r = 100.0, 0.25, 0.04
    band = sd_band(spot, 0.30, T, r)   # IV-derived edges
    assert band is not None

    probs = bucket_probs_under(spot, 0.18, T, band.edges, r)   # scored under RV
    assert probs is not None

    assert probs[0] < BUCKET_PROBS[0]
    assert probs[4] < BUCKET_PROBS[4]
    assert probs[2] > BUCKET_PROBS[2]
    assert sum(probs) == pytest.approx(1.0, abs=1e-9)


def test_higher_realized_vol_fattens_the_tails():
    spot, T, r = 100.0, 0.25, 0.04
    band = sd_band(spot, 0.20, T, r)
    assert band is not None

    probs = bucket_probs_under(spot, 0.40, T, band.edges, r)
    assert probs is not None
    assert probs[0] > BUCKET_PROBS[0]
    assert probs[4] > BUCKET_PROBS[4]
    assert probs[2] < BUCKET_PROBS[2]


def test_bucket_probs_under_rejects_bad_input():
    band = sd_band(100.0, 0.25, 0.25)
    assert band is not None
    assert bucket_probs_under(0, 0.2, 0.25, band.edges) is None
    assert bucket_probs_under(100, 0, 0.25, band.edges) is None
    assert bucket_probs_under(100, 0.2, 0, band.edges) is None
    assert bucket_probs_under(100, 0.2, 0.25, band.edges[:4]) is None


# ── ATM IV extraction ─────────────────────────────────────────────────────────

def _chain(strikes_ivs):
    return [{"strike": k, "impliedVolatility": iv} for k, iv in strikes_ivs]


def test_atm_iv_pair_averages_the_two_sides():
    calls = _chain([(99, 0.20), (100, 0.20), (101, 0.20)])
    puts = _chain([(99, 0.30), (100, 0.30), (101, 0.30)])
    iv_c, iv_p, iv_mid, strike = atm_iv_pair(calls, puts, 100.0)
    assert iv_c == pytest.approx(0.20)
    assert iv_p == pytest.approx(0.30)
    assert iv_mid == pytest.approx(0.25)
    assert strike == pytest.approx(100.0)


def test_atm_iv_pair_ignores_far_strikes():
    """A 40%-away wing must not enter the ATM median."""
    calls = _chain([(100, 0.20), (140, 0.90)])
    puts = _chain([(100, 0.22), (60, 0.95)])
    iv_c, iv_p, iv_mid, _ = atm_iv_pair(calls, puts, 100.0)
    assert iv_c == pytest.approx(0.20)
    assert iv_p == pytest.approx(0.22)
    assert iv_mid == pytest.approx(0.21)


def test_atm_iv_pair_uses_median_not_mean():
    # One junk strike inside the window would move a mean, not the median.
    calls = _chain([(99, 0.20), (100, 0.21), (101, 0.22), (100.5, 3.00)])
    iv_c, _, _, _ = atm_iv_pair(calls, [], 100.0)
    assert iv_c == pytest.approx(0.215)


def test_atm_iv_pair_drops_zero_ivs():
    calls = _chain([(100, 0.0), (100.5, 0.24)])
    iv_c, _, _, _ = atm_iv_pair(calls, [], 100.0)
    assert iv_c == pytest.approx(0.24)


def test_atm_iv_pair_one_sided_chain_still_returns_mid():
    calls = _chain([(100, 0.26)])
    iv_c, iv_p, iv_mid, _ = atm_iv_pair(calls, [], 100.0)
    assert iv_c == pytest.approx(0.26)
    assert iv_p is None
    assert iv_mid == pytest.approx(0.26)


def test_atm_iv_pair_empty_chain():
    assert atm_iv_pair([], [], 100.0) == (None, None, None, None)


def test_atm_iv_pair_rejects_bad_spot():
    calls = _chain([(100, 0.2)])
    assert atm_iv_pair(calls, [], 0) == (None, None, None, None)


# ── Realized vol ──────────────────────────────────────────────────────────────

def test_realized_vol_series_alignment_and_warmup():
    closes = [100.0 * (1.001 ** i) for i in range(40)]
    rv = realized_vol_series(closes, 21)
    assert len(rv) == len(closes)
    assert all(v is None for v in rv[:21])
    # A perfectly constant compounding path has zero return variance, so no
    # estimate is emitted rather than a misleading 0.0.
    assert rv[30] is None


def test_realized_vol_series_scales_with_noise():
    import random

    random.seed(7)
    calm = [100.0]
    wild = [100.0]
    for _ in range(200):
        calm.append(calm[-1] * math.exp(random.gauss(0, 0.005)))
        wild.append(wild[-1] * math.exp(random.gauss(0, 0.020)))

    rv_calm = realized_vol_series(calm, 21)[-1]
    rv_wild = realized_vol_series(wild, 21)[-1]
    assert rv_calm is not None and rv_wild is not None
    # 0.005 daily → ≈8% annualised, 0.020 → ≈32%.
    assert rv_calm == pytest.approx(0.005 * math.sqrt(252), rel=0.4)
    assert rv_wild > rv_calm * 2


def test_realized_vol_series_too_short():
    assert realized_vol_series([100, 101, 102], 21) == [None, None, None]
    assert realized_vol_series([], 21) == []
    assert realized_vol_series([100, 101], 1) == [None, None]


# ── Cross-checks against closed-form Black-Scholes ────────────────────────────
#
# The band is derived by hand from the lognormal, so these tie it back to the
# textbook formulas rather than to the derivation that produced it.

def test_level_exceed_probs_equal_the_black_scholes_n_d2():
    """P(S_T >= K) under the risk-neutral measure IS N(d2). Any drift or spread
    error would show up here as a mismatch at every level at once."""
    from scipy.stats import norm

    from analytics.sd_bands import LEVEL_EXCEED_PROBS

    S, sigma, T, r = 478.40, 0.54575, 30 / 365, 0.0386
    band = sd_band(S, sigma, T, r)
    assert band is not None

    for price, ours in zip(band.levels, LEVEL_EXCEED_PROBS):
        d2 = (math.log(S / price) + (r - 0.5 * sigma**2) * T) / (sigma * math.sqrt(T))
        assert float(norm.cdf(d2)) == pytest.approx(ours, abs=1e-12)


def test_the_band_is_a_martingale_in_the_forward():
    """E[S_T] must be the forward. The MEDIAN sits below it by exp(sigma^2*T/2) —
    that gap is the whole reason row 0 is not the spot price."""
    S, sigma, T, r = 100.0, 0.60, 0.25, 0.05
    band = sd_band(S, sigma, T, r)
    assert band is not None

    forward = S * math.exp(r * T)
    assert forward / band.levels[2] == pytest.approx(math.exp(0.5 * sigma**2 * T))
    assert band.levels[2] < forward


def test_bucket_edges_and_level_prices_interleave():
    """Every level must sit strictly inside its own bucket — an off-by-one in the
    z-edges would put a level on, or past, a boundary."""
    band = sd_band(250.0, 0.35, 45 / 365, 0.04)
    assert band is not None
    for i, price in enumerate(band.levels):
        assert band.edges[i] < price < band.edges[i + 1]


def test_bucket_probabilities_match_monte_carlo():
    """Independent numerical check of the analytic partition."""
    import numpy as np

    S, sigma, T, r = 478.40, 0.54575, 30 / 365, 0.0386
    band = sd_band(S, sigma, T, r)
    assert band is not None

    rng = np.random.default_rng(7)
    n = 400_000
    st = S * np.exp((r - 0.5 * sigma**2) * T + sigma * math.sqrt(T) * rng.standard_normal(n))

    for i, expected in enumerate(BUCKET_PROBS):
        share = float(np.mean((st >= band.edges[i]) & (st < band.edges[i + 1])))
        se = math.sqrt(expected * (1 - expected) / n)
        assert abs(share - expected) < 5 * se, f"bucket {i}: {share} vs {expected}"


def test_cross_sigma_probs_match_monte_carlo():
    """The cheapness path scores IV-derived edges under realized vol — the case
    a closed form is least obvious, so it gets the numerical check too."""
    import numpy as np

    S, iv, rv, T, r = 478.40, 0.54575, 0.853236, 30 / 365, 0.0386
    band = sd_band(S, iv, T, r)
    assert band is not None
    ours = bucket_probs_under(S, rv, T, band.edges, r)
    assert ours is not None

    rng = np.random.default_rng(11)
    n = 400_000
    st = S * np.exp((r - 0.5 * rv**2) * T + rv * math.sqrt(T) * rng.standard_normal(n))

    for i, expected in enumerate(ours):
        share = float(np.mean((st >= band.edges[i]) & (st < band.edges[i + 1])))
        se = math.sqrt(max(expected, 1e-9) * (1 - expected) / n)
        assert abs(share - expected) < 5 * se, f"bucket {i}: {share} vs {expected}"
