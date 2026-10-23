"""Display symbol / name — the same cases as lib/__tests__/symbol-display.test.ts."""

import pytest

import symbol_names as sn


@pytest.mark.parametrize("symbol, shown", [
    ("^MOVE", "MOVE"),
    ("^VIX", "VIX"),
    ("BH.BK", "BH"),
    ("^SET.BK", "SET"),
    ("AAPL", "AAPL"),
    ("BTC-USD", "BTC-USD"),
    ("ES=F", "ES=F"),
    ("", ""),
])
def test_display_symbol(symbol, shown):
    assert sn.display_symbol(symbol) == shown


@pytest.mark.parametrize("symbol, name, shown", [
    ("BH.BK", "BH_BUMRUNGRAD HOSPITAL", "BUMRUNGRAD HOSPITAL"),
    ("PTT.BK", "PTT_PTT PUBLIC COMPANY", "PTT PUBLIC COMPANY"),
    ("^MOVE", "Northern Trust iBoxx 5-Year Tar", "ICE BofA MOVE Index"),
    ("^VIX", "CBOE Volatility Index", "CBOE Volatility Index"),
    ("AAPL", "Apple Inc.", "Apple Inc."),
    ("AAPL", None, ""),
])
def test_display_name(symbol, name, shown):
    assert sn.display_name(symbol, name) == shown


def test_fix_name_only_touches_known_mislabels():
    assert sn.fix_name("^move", "Northern Trust iBoxx 5-Year Tar") == "ICE BofA MOVE Index"
    assert sn.fix_name("BH.BK", "BH_BUMRUNGRAD HOSPITAL") == "BH_BUMRUNGRAD HOSPITAL"
