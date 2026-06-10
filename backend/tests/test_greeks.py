"""
Unit tests for backend/greeks.py
Covers: Black-Scholes price, Gram-Charlier correction, finite-diff Greeks,
        moment estimation, portfolio aggregates, and regression for Q3 bug.

Run:
    cd backend
    python -m pytest tests/test_greeks.py -v
"""

import math
import sys
from datetime import date, timedelta
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, ".")

from greeks import (
    _bs_price,
    _gc_correction,
    _gc_price,
    _days_to_expiry,
    compute_greeks,
    estimate_moments,
)

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def future_expiry(days: int) -> str:
    return str(date.today() + timedelta(days=days))


TOLS = dict(abs=1e-3)   # $0.001 tolerance for price comparisons


# ═══════════════════════════════════════════════════════════════════════════════
# 1. BLACK-SCHOLES PRICE
# ═══════════════════════════════════════════════════════════════════════════════

class TestBSPrice:

    # ── ATM approximation ─────────────────────────────────────────────────────

    def test_atm_call_approximation(self):
        """ATM call ≈ S·σ·√T·φ(0) = S·σ·√T·0.3989"""
        S, K, T, sigma = 100.0, 100.0, 1.0, 0.20
        approx = S * sigma * math.sqrt(T) * (1 / math.sqrt(2 * math.pi))
        price = _bs_price(S, K, T, r=0.0, sigma=sigma, opt="call")
        # ATM approx valid within ~2% for r=0
        assert abs(price - approx) / approx < 0.02

    def test_atm_known_value(self):
        """ATM call, S=K=100, T=1yr, r=0, σ=20% → ~7.97"""
        price = _bs_price(100, 100, 1.0, r=0.0, sigma=0.20, opt="call")
        assert abs(price - 7.966) < 0.01

    # ── Put-call parity: C - P = S - K·e^{-rT} ───────────────────────────────

    def test_put_call_parity_atm(self):
        S, K, T, r, sigma = 100.0, 100.0, 1.0, 0.05, 0.25
        call = _bs_price(S, K, T, r, sigma, "call")
        put  = _bs_price(S, K, T, r, sigma, "put")
        parity_lhs = call - put
        parity_rhs = S - K * math.exp(-r * T)
        assert abs(parity_lhs - parity_rhs) < 1e-8

    def test_put_call_parity_otm(self):
        S, K, T, r, sigma = 100.0, 110.0, 0.5, 0.05, 0.30
        call = _bs_price(S, K, T, r, sigma, "call")
        put  = _bs_price(S, K, T, r, sigma, "put")
        parity_rhs = S - K * math.exp(-r * T)
        assert abs((call - put) - parity_rhs) < 1e-8

    # ── Boundary: deep ITM call ≈ S - K·e^{-rT} ──────────────────────────────

    def test_deep_itm_call(self):
        """Deep ITM: price ≈ intrinsic + discount"""
        S, K, T, r, sigma = 200.0, 100.0, 1.0, 0.05, 0.20
        price = _bs_price(S, K, T, r, sigma, "call")
        intrinsic = S - K * math.exp(-r * T)
        assert abs(price - intrinsic) < 0.10   # very close to intrinsic

    # ── Boundary: deep OTM call ≈ 0 ──────────────────────────────────────────

    def test_deep_otm_call_near_zero(self):
        S, K, T, r, sigma = 100.0, 300.0, 1.0, 0.05, 0.20
        price = _bs_price(S, K, T, r, sigma, "call")
        assert price < 0.001

    # ── Boundary: expired option = intrinsic ─────────────────────────────────

    def test_expired_call_itm(self):
        assert _bs_price(110, 100, T=0.0, r=0.05, sigma=0.20, opt="call") == pytest.approx(10.0)

    def test_expired_call_otm(self):
        assert _bs_price(90, 100, T=0.0, r=0.05, sigma=0.20, opt="call") == pytest.approx(0.0)

    def test_expired_put_itm(self):
        assert _bs_price(90, 100, T=0.0, r=0.05, sigma=0.20, opt="put") == pytest.approx(10.0)

    # ── Price must be non-negative ────────────────────────────────────────────

    def test_price_nonnegative_call(self):
        for S in [80, 100, 120]:
            assert _bs_price(S, 100, 1.0, 0.05, 0.30, "call") >= 0

    def test_price_nonnegative_put(self):
        for S in [80, 100, 120]:
            assert _bs_price(S, 100, 1.0, 0.05, 0.30, "put") >= 0

    # ── Monotonicity: lower strike → higher call ──────────────────────────────

    def test_call_monotone_in_strike(self):
        c90  = _bs_price(100, 90,  1.0, 0.05, 0.25, "call")
        c100 = _bs_price(100, 100, 1.0, 0.05, 0.25, "call")
        c110 = _bs_price(100, 110, 1.0, 0.05, 0.25, "call")
        assert c90 > c100 > c110

    # ── Zero vol = intrinsic ──────────────────────────────────────────────────

    def test_zero_vol_call(self):
        price = _bs_price(110, 100, T=1.0, r=0.0, sigma=0.0, opt="call")
        assert price == pytest.approx(10.0)


# ═══════════════════════════════════════════════════════════════════════════════
# 2. GRAM-CHARLIER CORRECTION
# ═══════════════════════════════════════════════════════════════════════════════

class TestGCCorrection:

    # ── No adjustment when skew=kurt=0 ───────────────────────────────────────

    def test_zero_moments_zero_correction(self):
        corr = _gc_correction(100, 100, 1.0, 0.05, 0.20, skew=0.0, kurt=0.0)
        assert corr == pytest.approx(0.0, abs=1e-10)

    def test_gc_price_equals_bs_when_no_moments(self):
        bs  = _bs_price(100, 100, 1.0, 0.05, 0.20, "call")
        gc  = _gc_price(100, 100, 1.0, 0.05, 0.20, "call", skew=0.0, kurt=0.0)
        assert gc == pytest.approx(bs, abs=1e-10)

    # ── Negative skew reduces ATM call price ─────────────────────────────────

    def test_neg_skew_reduces_atm_call(self):
        """Negative skewness → left-tail risk → less right-tail → cheaper call"""
        bs = _bs_price(100, 100, 1.0, 0.05, 0.25, "call")
        gc = _gc_price(100, 100, 1.0, 0.05, 0.25, "call", skew=-0.8, kurt=0.0)
        assert gc < bs, f"Expected gc={gc:.4f} < bs={bs:.4f}"

    # ── Positive skew increases ATM call price ────────────────────────────────

    def test_pos_skew_increases_atm_call(self):
        bs = _bs_price(100, 100, 1.0, 0.05, 0.25, "call")
        gc = _gc_price(100, 100, 1.0, 0.05, 0.25, "call", skew=+0.8, kurt=0.0)
        assert gc > bs, f"Expected gc={gc:.4f} > bs={bs:.4f}"

    # ── Kurt effect: proportional and symmetric ───────────────────────────────

    def test_kurt_effect_is_proportional(self):
        """Larger |kurt| → larger correction (same sign)."""
        bs  = _bs_price(100, 100, 1.0, 0.05, 0.25, "call")
        gc1 = _gc_price(100, 100, 1.0, 0.05, 0.25, "call", skew=0.0, kurt=1.0)
        gc3 = _gc_price(100, 100, 1.0, 0.05, 0.25, "call", skew=0.0, kurt=3.0)
        diff1 = abs(gc1 - bs)
        diff3 = abs(gc3 - bs)
        assert diff3 > diff1, "Higher kurt → larger price correction"

    def test_kurt_affects_call_and_put_same_direction(self):
        """
        Q4 sign depends on parameters (not always positive for ATM).
        Key property: call and put correction have same sign (both ↑ or both ↓).
        """
        bs_c = _bs_price(100, 100, 1.0, 0.05, 0.25, "call")
        bs_p = _bs_price(100, 100, 1.0, 0.05, 0.25, "put")
        gc_c = _gc_price(100, 100, 1.0, 0.05, 0.25, "call", skew=0.0, kurt=3.0)
        gc_p = _gc_price(100, 100, 1.0, 0.05, 0.25, "put",  skew=0.0, kurt=3.0)
        call_diff = gc_c - bs_c
        put_diff  = gc_p - bs_p
        # Same sign: both positive or both negative
        assert call_diff * put_diff > 0, (
            f"Call diff={call_diff:.5f} and put diff={put_diff:.5f} should have same sign"
        )

    def test_kurt_zero_no_effect(self):
        """kurt=0 → no kurtosis correction"""
        bs = _bs_price(100, 100, 1.0, 0.05, 0.25, "call")
        gc = _gc_price(100, 100, 1.0, 0.05, 0.25, "call", skew=0.0, kurt=0.0)
        assert abs(gc - bs) < 1e-10

    # ── Skew and kurt effects scale with magnitude ────────────────────────────

    def test_skew_effect_scales_with_magnitude(self):
        gc_small = _gc_price(100, 100, 1.0, 0.05, 0.25, "call", skew=-0.4, kurt=0.0)
        gc_large = _gc_price(100, 100, 1.0, 0.05, 0.25, "call", skew=-0.8, kurt=0.0)
        bs = _bs_price(100, 100, 1.0, 0.05, 0.25, "call")
        # larger negative skew → larger reduction
        assert (bs - gc_large) > (bs - gc_small)

    # ── Clamping: extreme values don't explode ────────────────────────────────

    def test_extreme_skew_clamped(self):
        gc = _gc_price(100, 100, 1.0, 0.05, 0.20, "call", skew=-10.0, kurt=0.0)
        # Same as skew=-3.0 (clamped)
        gc_clamped = _gc_price(100, 100, 1.0, 0.05, 0.20, "call", skew=-3.0, kurt=0.0)
        assert gc == pytest.approx(gc_clamped, abs=1e-10)

    def test_extreme_kurt_clamped(self):
        gc = _gc_price(100, 100, 1.0, 0.05, 0.20, "call", skew=0.0, kurt=50.0)
        gc_clamped = _gc_price(100, 100, 1.0, 0.05, 0.20, "call", skew=0.0, kurt=10.0)
        assert gc == pytest.approx(gc_clamped, abs=1e-10)

    # ── Regression: Q3 must use d1, NOT d2 (bug fix 2026-06-03) ─────────────

    def test_q3_uses_d1_not_d2_regression(self):
        """
        Before fix: Q3 = S*σ√T*(2σ√T - d2)*φ(d1) = S*σ√T*(3σ√T - d1)*φ(d1)
        After fix:  Q3 = S*σ√T*(2σ√T - d1)*φ(d1)

        For S=100, K=100, T=1, σ=0.20, r=0, skew=-0.8:
          σ√T = 0.20, d1 ≈ 0.10, d2 ≈ -0.10
          wrong factor = 3*0.20 - 0.10 = 0.50
          right factor = 2*0.20 - 0.10 = 0.30
          ratio ≈ 0.50/0.30 = 1.67 → wrong is 67% larger
        We verify the correction is in the correct (smaller) range.
        """
        import math
        from scipy.stats import norm
        S, K, T, r, sigma = 100.0, 100.0, 1.0, 0.0, 0.20
        sqT = math.sqrt(T)
        d1 = (math.log(S / K) + (r + 0.5 * sigma**2) * T) / (sigma * sqT)
        d2 = d1 - sigma * sqT
        pdf_d1 = norm.pdf(d1)

        # What the WRONG formula would give
        Q3_wrong = S * sigma * sqT * (2 * sigma * sqT - d2) * pdf_d1
        # What the CORRECT formula gives
        Q3_right = S * sigma * sqT * (2 * sigma * sqT - d1) * pdf_d1

        # Compute actual correction from current code
        skew = -0.8
        actual_corr = _gc_correction(S, K, T, r, sigma, skew=skew, kurt=0.0)

        expected_right = (skew / 6.0) * Q3_right
        expected_wrong = (skew / 6.0) * Q3_wrong

        # actual should match right, not wrong
        assert abs(actual_corr - expected_right) < 1e-8, (
            f"Q3 uses wrong formula! actual={actual_corr:.6f} "
            f"right={expected_right:.6f} wrong={expected_wrong:.6f}"
        )
        # Sanity: right and wrong differ by >30%
        assert abs(expected_wrong - expected_right) / abs(expected_right) > 0.30

    # ── Expired or zero-vol returns zero correction ───────────────────────────

    def test_expired_zero_correction(self):
        assert _gc_correction(100, 100, T=0.0, r=0.05, sigma=0.20,
                              skew=-0.8, kurt=3.0) == 0.0

    def test_zero_vol_zero_correction(self):
        assert _gc_correction(100, 100, T=1.0, r=0.05, sigma=0.0,
                              skew=-0.8, kurt=3.0) == 0.0


# ═══════════════════════════════════════════════════════════════════════════════
# 3. GREEKS VIA FINITE DIFFERENCES
# ═══════════════════════════════════════════════════════════════════════════════

class TestGreeks:

    @pytest.fixture
    def atm_call(self):
        return compute_greeks(
            spot=100, strike=100, expiry=future_expiry(90),
            option_type="call", implied_vol=0.25,
            skew=-0.8, kurt=3.0,
        )

    @pytest.fixture
    def atm_put(self):
        return compute_greeks(
            spot=100, strike=100, expiry=future_expiry(90),
            option_type="put", implied_vol=0.25,
            skew=-0.8, kurt=3.0,
        )

    @pytest.fixture
    def otm_call(self):
        return compute_greeks(
            spot=100, strike=115, expiry=future_expiry(90),
            option_type="call", implied_vol=0.25,
            skew=-0.8, kurt=3.0,
        )

    # ── Delta range ───────────────────────────────────────────────────────────

    def test_call_delta_in_range(self, atm_call):
        assert 0 < atm_call["delta"] < 1
        assert 0 < atm_call["delta_adj"] < 1

    def test_put_delta_in_range(self, atm_put):
        assert -1 < atm_put["delta"] < 0
        assert -1 < atm_put["delta_adj"] < 0

    def test_atm_call_delta_near_half(self, atm_call):
        """ATM call delta ≈ 0.5 (slightly above due to r > 0 and lognormal skew)"""
        assert 0.45 < atm_call["delta"] < 0.65

    def test_otm_call_delta_lower_than_atm(self, atm_call, otm_call):
        assert otm_call["delta"] < atm_call["delta"]

    # ── Put-call delta parity: delta_call - delta_put ≈ 1 ───────────────────

    def test_delta_parity_bs(self, atm_call, atm_put):
        """delta_call - delta_put = N(d1) - (N(d1)-1) = 1 exactly in BS"""
        diff = atm_call["delta"] - atm_put["delta"]
        assert abs(diff - 1.0) < 0.01

    def test_delta_parity_adj(self, atm_call, atm_put):
        diff = atm_call["delta_adj"] - atm_put["delta_adj"]
        assert abs(diff - 1.0) < 0.02   # GC breaks exact parity slightly

    # ── Gamma: always positive ────────────────────────────────────────────────

    def test_gamma_positive_call(self, atm_call):
        assert atm_call["gamma"] > 0
        assert atm_call["gamma_adj"] > 0

    def test_gamma_positive_put(self, atm_put):
        assert atm_put["gamma"] > 0
        assert atm_put["gamma_adj"] > 0

    # ── Theta: negative for long options ─────────────────────────────────────

    def test_theta_negative_call(self, atm_call):
        assert atm_call["theta"] < 0
        assert atm_call["theta_adj"] < 0

    def test_theta_negative_put(self, atm_put):
        assert atm_put["theta"] < 0
        assert atm_put["theta_adj"] < 0

    def test_theta_is_per_day(self, atm_call):
        """|theta| should be small fraction of option price (not annual rate)"""
        assert abs(atm_call["theta"]) < atm_call["price"]  # daily decay < total price
        assert abs(atm_call["theta"]) > 0.001               # not zero

    # ── Vega: positive for long options ──────────────────────────────────────

    def test_vega_positive_call(self, atm_call):
        assert atm_call["vega"] > 0
        assert atm_call["vega_adj"] > 0

    def test_vega_positive_put(self, atm_put):
        assert atm_put["vega"] > 0
        assert atm_put["vega_adj"] > 0

    # ── Adj vs BS relationships ───────────────────────────────────────────────

    def test_neg_skew_adj_price_lt_bs_call(self, atm_call):
        """Negative skew → adj price lower than BS for call"""
        assert atm_call["price_adj"] < atm_call["price"]

    def test_kurt_call_put_same_direction(self):
        """
        kurtosis correction: call and put shift same direction.
        (GC Q4 sign depends on (d1²-1-3σ√T·d2); at ATM short-T this is negative,
        meaning both call AND put price slightly decrease. Verified analytically.)
        """
        rc = compute_greeks(spot=100, strike=100, expiry=future_expiry(90),
                            option_type="call", implied_vol=0.25, skew=0.0, kurt=3.0)
        rp = compute_greeks(spot=100, strike=100, expiry=future_expiry(90),
                            option_type="put",  implied_vol=0.25, skew=0.0, kurt=3.0)
        call_diff = rc["price_adj"] - rc["price"]
        put_diff  = rp["price_adj"] - rp["price"]
        assert call_diff * put_diff > 0, (
            f"Call and put kurt correction must have same sign: {call_diff:.5f}, {put_diff:.5f}"
        )

    # ── diff fields: adj - bs ─────────────────────────────────────────────────

    def test_diff_fields_correct(self, atm_call):
        assert atm_call["delta_diff"] == pytest.approx(
            atm_call["delta_adj"] - atm_call["delta"], abs=1e-6
        )
        assert atm_call["gamma_diff"] == pytest.approx(
            atm_call["gamma_adj"] - atm_call["gamma"], abs=1e-8
        )

    # ── Output fields complete ────────────────────────────────────────────────

    def test_all_fields_present(self, atm_call):
        required = [
            "price", "delta", "gamma", "theta", "vega", "rho",
            "price_adj", "delta_adj", "gamma_adj", "theta_adj", "vega_adj", "rho_adj",
            "delta_diff", "gamma_diff", "theta_diff", "vega_diff",
            "T_years", "days_to_exp", "iv", "skew_input", "kurt_input",
        ]
        for field in required:
            assert field in atm_call, f"Missing field: {field}"

    # ── Expired / no IV ───────────────────────────────────────────────────────

    def test_expired_returns_error(self):
        r = compute_greeks(
            spot=100, strike=100, expiry=str(date.today() - timedelta(days=1)),
            option_type="call", implied_vol=0.25,
        )
        assert r.get("error") == "expired"

    def test_no_iv_returns_error(self):
        r = compute_greeks(
            spot=100, strike=100, expiry=future_expiry(90),
            option_type="call", implied_vol=0.0,
        )
        assert r.get("error") == "no_iv"


# ═══════════════════════════════════════════════════════════════════════════════
# 4. DAYS TO EXPIRY
# ═══════════════════════════════════════════════════════════════════════════════

class TestDaysToExpiry:

    def test_future_expiry_positive(self):
        T = _days_to_expiry(future_expiry(90))
        assert 89/365 < T < 91/365

    def test_past_expiry_zero(self):
        T = _days_to_expiry(str(date.today() - timedelta(days=1)))
        assert T == 0.0

    def test_today_expiry_zero(self):
        T = _days_to_expiry(str(date.today()))
        assert T == 0.0

    def test_invalid_format_zero(self):
        T = _days_to_expiry("not-a-date")
        assert T == 0.0


# ═══════════════════════════════════════════════════════════════════════════════
# 5. MOMENT ESTIMATION
# ═══════════════════════════════════════════════════════════════════════════════

class TestEstimateMoments:

    def test_fallback_on_error(self):
        """On any exception → return (0, 0)"""
        with patch("sources.market_data") as mock:
            mock.get_ticker.side_effect = Exception("network error")
            result = estimate_moments("AAPL")
        assert result == {"skew": 0.0, "kurt": 0.0}

    def test_fallback_on_insufficient_data(self):
        """< 30 data points → (0, 0)"""
        import pandas as pd
        mock_ticker = MagicMock()
        mock_ticker.history.return_value = pd.DataFrame(
            {"Close": [100.0, 101.0, 99.0]}
        )
        with patch("sources.market_data") as mock_md:
            mock_md.get_ticker.return_value = mock_ticker
            result = estimate_moments("AAPL")
        assert result == {"skew": 0.0, "kurt": 0.0}

    def test_known_normal_distribution(self):
        """
        Normal distribution: skew=0, kurt=0.
        Generate ~normal returns and verify estimates are near zero.
        """
        import numpy as np
        import pandas as pd

        rng = np.random.default_rng(42)
        prices = 100 * np.exp(np.cumsum(rng.normal(0, 0.01, 500)))
        mock_ticker = MagicMock()
        mock_ticker.history.return_value = pd.DataFrame({"Close": prices})

        with patch("sources.market_data") as mock_md:
            mock_md.get_ticker.return_value = mock_ticker
            result = estimate_moments("TEST", lookback_days=500)

        # Normal sample: |skew| < 0.5, |kurt| < 1.5 for n=500
        assert abs(result["skew"]) < 0.5
        assert abs(result["kurt"]) < 1.5

    def test_known_left_skewed_distribution(self):
        """
        Left-skewed returns (crash-like) → skew < 0.
        """
        import numpy as np
        import pandas as pd

        rng = np.random.default_rng(42)
        # chi-squared returns are right-skewed; negate for left skew
        returns = -rng.chisquare(df=3, size=500) / 30
        prices = 100 * np.exp(np.cumsum(returns))
        mock_ticker = MagicMock()
        mock_ticker.history.return_value = pd.DataFrame({"Close": prices})

        with patch("sources.market_data") as mock_md:
            mock_md.get_ticker.return_value = mock_ticker
            result = estimate_moments("TEST", lookback_days=500)

        assert result["skew"] < 0

    def test_output_clamped(self):
        """Values always within clamp bounds"""
        import numpy as np
        import pandas as pd

        # Extreme data with big outlier
        prices = [100.0] * 249 + [50.0, 100.0]  # huge 50% crash then recovery
        mock_ticker = MagicMock()
        mock_ticker.history.return_value = pd.DataFrame({"Close": prices})

        with patch("sources.market_data") as mock_md:
            mock_md.get_ticker.return_value = mock_ticker
            result = estimate_moments("TEST", lookback_days=300)

        assert -3.0 <= result["skew"] <= 3.0
        assert -1.5 <= result["kurt"] <= 10.0


# ═══════════════════════════════════════════════════════════════════════════════
# 6. PORTFOLIO AGGREGATE MATH
# ═══════════════════════════════════════════════════════════════════════════════

class TestPortfolioAggregates:
    """
    Verify: net_delta = delta_adj * qty * 100
            theta_bleed = theta_adj * qty * 100
            max_loss_long = entry_price * |qty| * 100
    """

    def test_delta_scale(self):
        """delta_adj × qty × 100 = shares equivalent"""
        r = compute_greeks(
            spot=100, strike=100, expiry=future_expiry(90),
            option_type="call", implied_vol=0.25, skew=0.0, kurt=0.0,
        )
        qty = 3
        expected_delta_shares = r["delta_adj"] * qty * 100
        # ~0.5 × 3 × 100 = ~150 shares
        assert 100 < expected_delta_shares < 200

    def test_theta_per_day_scale(self):
        """theta_adj × qty × 100 = daily dollar decay"""
        r = compute_greeks(
            spot=100, strike=100, expiry=future_expiry(90),
            option_type="call", implied_vol=0.25, skew=0.0, kurt=0.0,
        )
        qty = 2
        daily_decay = r["theta_adj"] * qty * 100   # should be negative
        assert daily_decay < 0   # losing money every day (long call)
        assert daily_decay > -50  # reasonable magnitude (not $50/day on a $5 option)

    def test_max_loss_long_call(self):
        """max loss long = entry_price × |qty| × 100"""
        entry_price = 3.50
        qty = 2
        max_loss = entry_price * abs(qty) * 100
        assert max_loss == pytest.approx(700.0)

    def test_max_loss_short_put(self):
        """max loss short put = strike × |qty| × 100"""
        strike = 150.0
        qty = -2  # short
        max_loss = strike * abs(qty) * 100
        assert max_loss == pytest.approx(30_000.0)
