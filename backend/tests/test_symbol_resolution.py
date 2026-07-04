"""
Unit tests for the symbol resolver (plans/port-redesign.md Step 1/4, F06).

Pure-logic tests — no network, no DB. The yfinance search path is exercised
manually (see plan file verify notes); these lock the deterministic pieces:
market classification, account market defaults, and the read-path preference
for persisted resolved_symbol over the legacy account-id heuristic.

Run: cd backend && python -m pytest tests/test_symbol_resolution.py -v
"""
import sys

sys.path.insert(0, ".")

from routers.portfolio_v2 import (
    _account_markets,
    _classify_market,
    _get_yf_symbol,
    _trade_yf_symbol,
)


class TestClassifyMarket:
    def test_bk_suffix_is_thai(self):
        assert _classify_market("PTT.BK") == "TH"
        assert _classify_market("tu.bk") == "TH"

    def test_bare_ticker_is_us(self):
        assert _classify_market("AAPL") == "US"
        assert _classify_market("TU") == "US"

    def test_crypto_pairs(self):
        assert _classify_market("BTC-USD") == "CRYPTO"
        assert _classify_market("SOL-THB") == "CRYPTO"
        assert _classify_market("ETH-USDT") == "CRYPTO"

    def test_crypto_by_quote_type(self):
        assert _classify_market("BTC-USD", "CRYPTOCURRENCY") == "CRYPTO"

    def test_unsupported_exchange_suffix(self):
        assert _classify_market("0005.HK") is None
        assert _classify_market("005930.KS") is None


class TestAccountMarkets:
    def test_explicit_markets_column_wins(self):
        assert _account_markets({"markets": '["US","TH"]', "account_type": "equity"}) == ["US", "TH"]
        assert _account_markets({"markets": '["TH"]', "account_type": "equity"}) == ["TH"]

    def test_default_equity_is_us_th(self):
        assert _account_markets({"markets": None, "account_type": "equity"}) == ["US", "TH"]
        assert _account_markets({"account_type": "equity"}) == ["US", "TH"]

    def test_default_crypto(self):
        assert _account_markets({"markets": None, "account_type": "crypto"}) == ["CRYPTO"]

    def test_malformed_json_falls_back(self):
        assert _account_markets({"markets": "not json", "account_type": "equity"}) == ["US", "TH"]

    def test_empty_list_falls_back(self):
        assert _account_markets({"markets": "[]", "account_type": "equity"}) == ["US", "TH"]


class TestTradeYfSymbol:
    def test_prefers_persisted_resolved_symbol(self):
        row = {"resolved_symbol": "PTT.BK", "symbol": "PTT", "account_id": "any_new_account"}
        assert _trade_yf_symbol(row) == "PTT.BK"

    def test_resolved_symbol_normalised_upper(self):
        row = {"resolved_symbol": " tu.bk ", "symbol": "TU", "account_id": "dime"}
        assert _trade_yf_symbol(row) == "TU.BK"

    def test_falls_back_to_legacy_heuristic(self):
        row = {"resolved_symbol": None, "symbol": "PTT", "account_id": "finansia"}
        assert _trade_yf_symbol(row) == "PTT.BK"

    def test_f06_scenario_new_account_with_resolution(self):
        # The F06 bug: new custom account fell through to bare symbol.
        # With a persisted resolution the account id no longer matters.
        row = {"resolved_symbol": "PTT.BK", "symbol": "PTT", "account_id": "kasikorn"}
        assert _trade_yf_symbol(row) == "PTT.BK"


class TestLegacyGetYfSymbol:
    """Lock legacy behavior — backfill script depends on it staying stable."""

    def test_finansia_gets_bk(self):
        assert _get_yf_symbol("PTT", "finansia") == "PTT.BK"

    def test_innovestx_crypto_translation(self):
        assert _get_yf_symbol("BTCTHB", "innovestx") == "BTC-THB"
        assert _get_yf_symbol("BTC-USD", "innovestx") == "BTC-USD"

    def test_dime_passthrough(self):
        assert _get_yf_symbol("AAPL", "dime") == "AAPL"

    def test_options_skipped(self):
        assert _get_yf_symbol("PUT_INTC", "dime") is None
        assert _get_yf_symbol("CALL_NVDA", "dime") is None
