"""
Unit tests for the May-2026 fixes:
  - circuit_breaker.py (CircuitBreaker state transitions)
  - polymarket.py (_keyword_search_pool, _phrase_match)
  - central_banks.py (_fetch_all_rates with circuit breaker integration)

Run: cd backend && python -m pytest tests/test_fixes.py -v
"""
import time
import threading
import sys
from unittest.mock import patch, MagicMock

sys.path.insert(0, ".")

from circuit_breaker import CircuitBreaker

# ═══════════════════════════════════════════════════════════════════════════════
# CIRCUIT BREAKER TESTS
# ═══════════════════════════════════════════════════════════════════════════════


class TestCircuitBreakerCore:
    """Test CircuitBreaker class directly — no integration needed."""

    def test_initial_state_allows_all(self):
        cb = CircuitBreaker()
        assert cb.allow("ecb") is True
        assert cb.allow("boe") is True
        assert cb.allow("any_source") is True

    def test_single_failure_does_not_open(self):
        cb = CircuitBreaker(failure_threshold=3)
        cb.record_failure("ecb")
        assert cb.allow("ecb") is True
        assert cb.status("ecb") == "degraded"

    def test_threshold_opens_circuit(self):
        cb = CircuitBreaker(failure_threshold=3, cooldown_seconds=300)
        for _ in range(3):
            cb.record_failure("ecb")
        assert cb.allow("ecb") is False
        assert cb.status("ecb") == "open"

    def test_success_resets_counter(self):
        cb = CircuitBreaker(failure_threshold=3)
        cb.record_failure("ecb")  # 1
        cb.record_failure("ecb")  # 2
        cb.record_success("ecb")  # reset
        cb.record_failure("ecb")  # 1 again (not 3)
        assert cb.allow("ecb") is True
        assert cb.status("ecb") == "degraded"

    def test_cooldown_expiry_reopens(self):
        now = [1000.0]  # mutable clock

        def mock_time():
            return now[0]

        with patch("circuit_breaker.time.time", mock_time):
            cb = CircuitBreaker(failure_threshold=2, cooldown_seconds=300)

            # 2 failures → open
            cb.record_failure("ecb")
            cb.record_failure("ecb")
            assert cb.allow("ecb") is False
            assert cb.status("ecb") == "open"

            # Advance past cooldown
            now[0] = 1301.0  # 301 seconds later
            assert cb.allow("ecb") is True
            assert cb.status("ecb") == "degraded"  # still degraded (failures remain)

    def test_success_after_cooldown_clears_state(self):
        now = [1000.0]

        def mock_time():
            return now[0]

        with patch("circuit_breaker.time.time", mock_time):
            cb = CircuitBreaker(failure_threshold=2, cooldown_seconds=300)
            cb.record_failure("ecb")
            cb.record_failure("ecb")
            now[0] = 1301.0
            cb.record_success("ecb")
            assert cb.status("ecb") == "ok"

    def test_independent_sources(self):
        cb = CircuitBreaker(failure_threshold=2)
        # Kill ECB
        cb.record_failure("ecb")
        cb.record_failure("ecb")
        assert cb.allow("ecb") is False
        # BOE should be fine
        assert cb.allow("boe") is True
        cb.record_failure("boe")  # only 1 failure
        assert cb.allow("boe") is True

    def test_reset_clears_all(self):
        cb = CircuitBreaker(failure_threshold=2)
        cb.record_failure("ecb")
        cb.record_failure("ecb")
        cb.record_failure("boe")
        assert cb.allow("ecb") is False
        cb.reset()
        assert cb.allow("ecb") is True
        assert cb.allow("boe") is True
        assert cb.status("ecb") == "ok"
        assert cb.status("boe") == "ok"

    def test_unknown_source_status(self):
        cb = CircuitBreaker()
        assert cb.status("never_seen") == "ok"

    def test_failure_below_threshold_status_degraded(self):
        cb = CircuitBreaker(failure_threshold=5)
        cb.record_failure("x")
        cb.record_failure("x")
        assert cb.status("x") == "degraded"
        assert cb.allow("x") is True


class TestCircuitBreakerThreadSafety:
    """Verify thread safety under concurrent access."""

    def test_concurrent_failures_from_threads(self):
        cb = CircuitBreaker(failure_threshold=50, cooldown_seconds=300)
        errors = []

        def hammer(source):
            try:
                for _ in range(100):
                    if cb.allow(source):
                        cb.record_failure(source)
            except Exception as e:
                errors.append(str(e))

        threads = [threading.Thread(target=hammer, args=(f"s{i}",)) for i in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # No exceptions from concurrent access
        assert errors == []
        # Each source had 100 failures
        for i in range(10):
            assert cb.allow(f"s{i}") is False  # 50+ means breaker open

    def test_mixed_success_failure_threads(self):
        cb = CircuitBreaker(failure_threshold=5, cooldown_seconds=300)
        errors = []

        def succeeder():
            try:
                for _ in range(100):
                    cb.record_success("shared")
            except Exception as e:
                errors.append(str(e))

        def failer():
            try:
                for _ in range(100):
                    cb.record_failure("shared")
            except Exception as e:
                errors.append(str(e))

        threads = [threading.Thread(target=succeeder) for _ in range(5)] + [
            threading.Thread(target=failer) for _ in range(5)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == []
        # State should be internally consistent (no corrupted dict)
        assert cb.status("shared") in ("ok", "degraded", "open")

    def test_internal_state_consistency(self):
        """After mixed concurrent ops, each source has a coherent state dict."""
        cb = CircuitBreaker(failure_threshold=3, cooldown_seconds=300)

        def random_ops(source):
            for _ in range(50):
                cb.allow(source)
                cb.record_failure(source)
                cb.record_success(source)

        threads = [threading.Thread(target=random_ops, args=(f"src{i}",)) for i in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # Every source state dict should have valid keys
        with cb._lock:
            for src, state in cb._states.items():
                assert "failures" in state
                assert "cooldown_until" in state
                assert isinstance(state["failures"], int)
                assert isinstance(state["cooldown_until"], (int, float))
                assert state["failures"] >= 0


# ═══════════════════════════════════════════════════════════════════════════════
# POLYMARKET TESTS
# ═══════════════════════════════════════════════════════════════════════════════


class TestPhraseMatch:
    """Test _phrase_match — the keyword matching primitive."""

    @staticmethod
    def _import():
        from routers.polymarket import _phrase_match

        return _phrase_match

    def test_exact_match(self):
        pm = self._import()
        assert pm("fed rate cut tomorrow", ["fed rate cut"]) is True

    def test_case_insensitive(self):
        pm = self._import()
        assert pm("FED RATE CUT", ["fed rate cut"]) is True

    def test_partial_substring(self):
        pm = self._import()
        # "rate" is NOT in keywords — only multi-word phrases
        assert pm("interest rate decision", ["rate"]) is True

    def test_no_match(self):
        pm = self._import()
        assert pm("ECB rate decision", ["fed rate cut", "FOMC rate"]) is False

    def test_empty_text(self):
        pm = self._import()
        assert pm("", ["fed rate cut"]) is False

    def test_empty_keywords(self):
        pm = self._import()
        assert pm("some text", []) is False  # any([]) = False

    def test_keyword_in_description_but_not_question(self):
        pm = self._import()
        # Simulates concatenated question + description[:400]
        text = "ECB announcement " + "fed rate cut next month"
        assert pm(text, ["fed rate cut"]) is True

    def test_phrase_match_searches_entire_input(self):
        """_phrase_match searches the ENTIRE string it receives.
        The 400-char truncation is done by the CALLER, not by _phrase_match itself.
        """
        pm = self._import()
        # "fed rate cut" at very end of long string — still matched
        long = "x" * 500 + "fed rate cut"
        assert pm(long, ["fed rate cut"]) is True
        # No match when keyword absent
        assert pm("x" * 500, ["fed rate cut"]) is False

    def test_multiple_keywords_any_match(self):
        pm = self._import()
        assert pm("BOJ rate hike", ["ECB rate", "BOJ rate", "RBA rate"]) is True


class TestKeywordSearchPool:
    """Test _keyword_search_pool — the new function added to fix /search."""

    @staticmethod
    def _import():
        from routers.polymarket import _keyword_search_pool

        return _keyword_search_pool

    def _make_pool(self, markets):
        """Mock _refresh_market_pool to return given markets."""
        with patch("routers.polymarket._refresh_market_pool", return_value=markets):
            yield

    def _market(self, slug, question, volume=1000, description=""):
        return {
            "slug": slug,
            "question": question,
            "volume": volume,
            "description": description,
        }

    def test_empty_pool_returns_empty(self):
        ksp = self._import()
        with patch("routers.polymarket._refresh_market_pool", return_value=[]):
            result = ksp(["anything"], limit=20)
        assert result == []

    def test_no_match_returns_empty(self):
        ksp = self._import()
        pool = [self._market("s1", "ECB rate decision"), self._market("s2", "BOJ announcement")]
        with patch("routers.polymarket._refresh_market_pool", return_value=pool):
            result = ksp(["fed rate cut"], limit=20)
        assert result == []

    def test_single_match(self):
        ksp = self._import()
        pool = [
            self._market("s1", "random market"),
            self._market("s2", "Will there be a fed rate cut in June?"),
        ]
        with patch("routers.polymarket._refresh_market_pool", return_value=pool):
            result = ksp(["fed rate cut"], limit=20)
        assert len(result) == 1
        assert result[0]["slug"] == "s2"

    def test_sorted_by_volume_descending(self):
        ksp = self._import()
        pool = [
            self._market("low", "fed rate cut low", volume=100),
            self._market("high", "fed rate cut high", volume=10000),
            self._market("mid", "fed rate cut mid", volume=1000),
        ]
        with patch("routers.polymarket._refresh_market_pool", return_value=pool):
            result = ksp(["fed rate cut"], limit=20)
        volumes = [r["volume"] for r in result]
        assert volumes == [10000, 1000, 100]

    def test_respects_limit(self):
        ksp = self._import()
        pool = [self._market(f"s{i}", "fed rate cut", volume=1000 - i) for i in range(50)]
        with patch("routers.polymarket._refresh_market_pool", return_value=pool):
            result = ksp(["fed rate cut"], limit=5)
        assert len(result) == 5

    def test_deduplicates_by_slug(self):
        ksp = self._import()
        pool = [
            self._market("same", "fed rate cut A", volume=1000),
            self._market("same", "fed rate cut B", volume=500),  # duplicate slug
            self._market("diff", "fed rate cut C", volume=100),
        ]
        with patch("routers.polymarket._refresh_market_pool", return_value=pool):
            result = ksp(["fed rate cut"], limit=20)
        slugs = [r["slug"] for r in result]
        assert slugs == ["same", "diff"]  # "same" appears once, first occurrence kept

    def test_searches_description_too(self):
        ksp = self._import()
        pool = [
            self._market("s1", "Some question?", description="fed rate cut discussion", volume=1000),
        ]
        with patch("routers.polymarket._refresh_market_pool", return_value=pool):
            result = ksp(["fed rate cut"], limit=20)
        assert len(result) == 1
        assert result[0]["slug"] == "s1"


# ═══════════════════════════════════════════════════════════════════════════════
# CENTRAL BANKS TESTS
# ═══════════════════════════════════════════════════════════════════════════════


class TestFetchAllRates:
    """Test _fetch_all_rates with circuit breaker integration."""

    def _import(self):
        from routers.central_banks import _fetch_all_rates

        return _fetch_all_rates

    def _success_result(self, bank_name, value=2.0):
        return {"bank": bank_name, "name": "test", "value": value, "date": "2026-01-01", "series": []}

    def test_all_banks_succeed(self):
        """Golden path: all fetchers return data → all sources = ok."""
        fetch = self._import()
        with patch("routers.central_banks._RATE_FETCHERS", {
            "ecb": lambda: self._success_result("ecb", 2.0),
            "boe": lambda: self._success_result("boe", 3.75),
            "boc": lambda: self._success_result("boc", 2.25),
        }), patch("routers.central_banks.cb.allow", return_value=True), patch(
            "routers.central_banks.cb.success"
        ), patch(
            "routers.central_banks.cb.failure"
        ), patch(
            "routers.central_banks.cb.reset_all"
        ), patch.dict(
            "routers.central_banks.BANKS",
            {
                "ecb": {"flag": "EU", "country": "EU", "name": "ECB"},
                "boe": {"flag": "GB", "country": "GB", "name": "BoE"},
                "boc": {"flag": "CA", "country": "CA", "name": "BoC"},
            },
            clear=False,
        ):
            results, sources = fetch()
        assert len(results) == 3
        assert sources == {"ecb": "ok", "boe": "ok", "boc": "ok"}

    def test_circuit_breaker_skips_blocked(self):
        """When cb.allow returns False → source marked 'skipped', not called."""
        fetch = self._import()
        with patch("routers.central_banks._RATE_FETCHERS", {
            "ecb": lambda: self._success_result("ecb", 2.0),
            "boe": lambda: self._success_result("boe", 3.75),
        }), patch(
            "routers.central_banks.cb.allow", side_effect=lambda src: src != "ecb"
        ), patch(
            "routers.central_banks.cb.success"
        ), patch(
            "routers.central_banks.cb.failure"
        ), patch(
            "routers.central_banks.cb.reset_all"
        ), patch.dict(
            "routers.central_banks.BANKS",
            {
                "ecb": {"flag": "EU", "country": "EU", "name": "ECB"},
                "boe": {"flag": "GB", "country": "GB", "name": "BoE"},
            },
            clear=False,
        ):
            results, sources = fetch()
        assert len(results) == 1  # only boe
        assert results[0]["bank"] == "boe"
        assert sources == {"ecb": "skipped", "boe": "ok"}

    def test_failed_fetch_marks_error(self):
        """When fetcher returns None → source marked 'error'."""
        fetch = self._import()
        with patch("routers.central_banks._RATE_FETCHERS", {
            "ecb": lambda: None,  # API failure
            "boe": lambda: self._success_result("boe", 3.75),
        }), patch("routers.central_banks.cb.allow", return_value=True), patch(
            "routers.central_banks.cb.success"
        ), patch(
            "routers.central_banks.cb.failure"
        ), patch(
            "routers.central_banks.cb.reset_all"
        ), patch.dict(
            "routers.central_banks.BANKS",
            {
                "ecb": {"flag": "EU", "country": "EU", "name": "ECB"},
                "boe": {"flag": "GB", "country": "GB", "name": "BoE"},
            },
            clear=False,
        ):
            results, sources = fetch()
        assert len(results) == 1
        assert sources == {"ecb": "error", "boe": "ok"}

    def test_exception_marks_error(self):
        """When fetcher raises → source marked 'error', no crash."""
        fetch = self._import()

        def explode():
            raise ConnectionError("timeout")

        with patch("routers.central_banks._RATE_FETCHERS", {
            "ecb": explode,
            "boe": lambda: self._success_result("boe", 3.75),
        }), patch("routers.central_banks.cb.allow", return_value=True), patch(
            "routers.central_banks.cb.success"
        ), patch(
            "routers.central_banks.cb.failure"
        ), patch(
            "routers.central_banks.cb.reset_all"
        ), patch.dict(
            "routers.central_banks.BANKS",
            {
                "ecb": {"flag": "EU", "country": "EU", "name": "ECB"},
                "boe": {"flag": "GB", "country": "GB", "name": "BoE"},
            },
            clear=False,
        ):
            results, sources = fetch()
        assert len(results) == 1
        assert sources == {"ecb": "error", "boe": "ok"}

    def test_all_skipped_returns_empty(self):
        """When ALL banks blocked by circuit breaker → empty results, all skipped."""
        fetch = self._import()
        with patch("routers.central_banks._RATE_FETCHERS", {
            "ecb": lambda: self._success_result("ecb", 2.0),
            "boe": lambda: self._success_result("boe", 3.75),
        }), patch("routers.central_banks.cb.allow", return_value=False), patch(
            "routers.central_banks.cb.reset_all"
        ), patch.dict(
            "routers.central_banks.BANKS",
            {
                "ecb": {"flag": "EU", "country": "EU", "name": "ECB"},
                "boe": {"flag": "GB", "country": "GB", "name": "BoE"},
            },
            clear=False,
        ):
            results, sources = fetch()
        assert results == []
        assert sources == {"ecb": "skipped", "boe": "skipped"}

    def test_results_sorted_by_value_descending(self):
        """Rates should be sorted highest-first (existing behavior preserved)."""
        fetch = self._import()
        with patch("routers.central_banks._RATE_FETCHERS", {
            "low": lambda: self._success_result("low", 1.0),
            "high": lambda: self._success_result("high", 10.0),
            "mid": lambda: self._success_result("mid", 5.0),
        }), patch("routers.central_banks.cb.allow", return_value=True), patch(
            "routers.central_banks.cb.success"
        ), patch(
            "routers.central_banks.cb.failure"
        ), patch(
            "routers.central_banks.cb.reset_all"
        ), patch.dict(
            "routers.central_banks.BANKS",
            {
                "low": {"flag": "X", "country": "X", "name": "Low"},
                "high": {"flag": "X", "country": "X", "name": "High"},
                "mid": {"flag": "X", "country": "X", "name": "Mid"},
            },
            clear=False,
        ):
            results, sources = fetch()
        values = [r["value"] for r in results]
        assert values == [10.0, 5.0, 1.0]

    def test_sources_keys_match_rate_fetchers(self):
        """Every bank in _RATE_FETCHERS must appear in sources dict."""
        fetch = self._import()
        with patch("routers.central_banks._RATE_FETCHERS", {
            "a": lambda: self._success_result("a", 1.0),
            "b": lambda: self._success_result("b", 2.0),
            "c": lambda: None,
        }), patch("routers.central_banks.cb.allow", return_value=True), patch(
            "routers.central_banks.cb.success"
        ), patch(
            "routers.central_banks.cb.failure"
        ), patch(
            "routers.central_banks.cb.reset_all"
        ), patch.dict(
            "routers.central_banks.BANKS",
            {
                "a": {"flag": "X", "country": "X", "name": "A"},
                "b": {"flag": "X", "country": "X", "name": "B"},
                "c": {"flag": "X", "country": "X", "name": "C"},
            },
            clear=False,
        ):
            _results, sources = fetch()
        assert set(sources.keys()) == {"a", "b", "c"}
        assert sources["a"] == "ok"
        assert sources["b"] == "ok"
        assert sources["c"] == "error"


# ═══════════════════════════════════════════════════════════════════════════════
# INTEGRATION: CircuitBreaker → central_banks wiring
# ═══════════════════════════════════════════════════════════════════════════════


class TestCircuitBreakerIntegration:
    """Verify circuit_breaker module-level API matches what central_banks calls."""

    def test_module_api_exists(self):
        import circuit_breaker as cb

        assert callable(cb.allow)
        assert callable(cb.success)
        assert callable(cb.failure)
        assert callable(cb.status)
        assert callable(cb.reset_all)

    def test_allow_accepts_string(self):
        import circuit_breaker as cb

        cb.reset_all()
        result = cb.allow("any_bank_id")
        assert isinstance(result, bool)
        assert result is True

    def test_failure_then_allow_still_true(self):
        import circuit_breaker as cb

        cb.reset_all()
        cb.failure("test_bank")
        assert cb.allow("test_bank") is True
        assert cb.status("test_bank") == "degraded"

    def test_reset_all_clears_failures(self):
        import circuit_breaker as cb

        cb.reset_all()
        cb.failure("x")
        cb.failure("x")
        cb.failure("x")  # 3 = threshold (default)
        assert cb.allow("x") is False
        cb.reset_all()
        assert cb.allow("x") is True
