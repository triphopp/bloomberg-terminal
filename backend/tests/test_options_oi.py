"""Keep OI missingness while preserving legacy numeric chain consumers."""
import json

import pandas as pd

from routers.options import clean_df


def test_oi_zero_is_reported_and_missing_or_invalid_is_marked_unavailable():
    values = [0, 1200, None, float("nan"), float("inf"), -3, 1.5, "42", "bad", 2 ** 54]
    result = clean_df(pd.DataFrame({"strike": [100] * len(values), "openInterest": values}))
    assert [row["openInterestAvailable"] for row in result] == [
        True, True, False, False, False, False, False, True, False, False]
    assert [row["openInterest"] for row in result] == [0, 1200, 0, 0, 0, 0, 0, 42, 0, 0]
    json.dumps(result, allow_nan=False)


def test_absent_oi_column_and_empty_chain_do_not_fabricate_observations():
    assert clean_df(pd.DataFrame({"strike": [100]})) == [
        {"strike": 100, "openInterestAvailable": False}]
    assert clean_df(pd.DataFrame()) == []


def test_existing_quote_fields_and_dataframe_are_preserved():
    source = pd.DataFrame([{"strike": 100, "openInterest": 7, "volume": 12,
                            "impliedVolatility": 0.234567, "bid": 1.234567, "ask": 2,
                            "contractSymbol": "TESTC100"}])
    before = source.copy(deep=True)
    row = clean_df(source)[0]
    assert row["volume"] == 12
    assert row["impliedVolatility"] == 0.2346
    assert row["bid"] == 1.2346
    assert row["openInterest"] == 7
    assert row["contractSymbol"] == "TESTC100"
    pd.testing.assert_frame_equal(source, before)
