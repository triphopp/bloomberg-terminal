"""Provider classification -> the sector lists the ENTRY form offers (no network).

The cases that matter are the ones a substring match gets wrong: "Healthcare"
never contains "Health Care", and "Consumer Defensive" matches "Consumer
Discretionary" on its first word — the opposite sector.
"""
import pytest

from sector_map import asset_class, classify


@pytest.mark.parametrize(
    "symbol,sector,industry,set_sector,us_sector",
    [
        # Thai listings — the case that had no working mapping at all
        ("PTT.BK", "Energy", "Oil & Gas Integrated", "ENERG", "Energy"),
        ("SCB.BK", "Financial Services", "Banks - Regional", "BANK", "Financials"),
        ("ADVANC.BK", "Communication Services", "Telecom Services", "ICT", "Communication Services"),
        ("CPALL.BK", "Consumer Defensive", "Grocery Stores", "COMM", "Consumer Staples"),
        ("CPF.BK", "Consumer Defensive", "Farm Products", "FOOD", "Consumer Staples"),
        ("BH.BK", "Healthcare", "Medical Care Facilities", "HELTH", "Health Care"),
        ("BLA.BK", "Financial Services", "Insurance - Life", "INSUR", "Financials"),
        ("SCC.BK", "Industrials", "Building Materials", "CONMAT", "Industrials"),
        ("AOT.BK", "Industrials", "Airports & Air Services", "TRANS", "Industrials"),
        # US listings
        ("AAPL", "Technology", "Consumer Electronics", "ETRON", "Information Technology"),
        ("MSFT", "Technology", "Software - Infrastructure", "ICT", "Information Technology"),
        ("PG", "Consumer Defensive", "Household & Personal Products", "PERSON", "Consumer Staples"),
        ("TSLA", "Consumer Cyclical", "Auto Manufacturers", "AUTO", "Consumer Discretionary"),
        ("LIN", "Basic Materials", "Specialty Chemicals", "PETRO", "Materials"),
        ("NEE", "Utilities", "Utilities - Regulated Electric", "ENERG", "Utilities"),
        ("AMT", "Real Estate", "REIT - Specialty", "PFUND", "Real Estate"),
        ("META", "Communication Services", "Internet Content & Information", "MEDIA",
         "Communication Services"),
    ],
)
def test_equity_lands_in_both_vocabularies(symbol, sector, industry, set_sector, us_sector):
    out = classify(symbol, "EQUITY", sector, industry)
    assert out["asset_class"] == "equity"
    assert out["set_sector"] == set_sector
    assert out["us_sector"] == us_sector


def test_consumer_defensive_is_not_consumer_discretionary():
    """The exact bug the old first-word match had."""
    assert classify("KO", "EQUITY", "Consumer Defensive", "Beverages - Non-Alcoholic")[
        "us_sector"
    ] == "Consumer Staples"


def test_non_equities_get_their_class_not_a_guessed_sector():
    assert classify("BTC-USD", "CRYPTOCURRENCY")["set_sector"] == "CRYPTO"
    assert classify("BTC-USD", "CRYPTOCURRENCY")["us_sector"] == "Crypto"
    assert classify("SPY", "ETF")["set_sector"] == "ETF"
    assert classify("SPY", "ETF")["us_sector"] == "ETF"


def test_thai_derivative_warrants_and_warrants_are_read_off_the_symbol():
    # Yahoo calls these equities; the SET does not.
    assert asset_class("BBL13C2512A", "EQUITY") == "dw"
    assert asset_class("PTT-W1", "EQUITY") == "warrant"
    assert classify("PTT-W1", "EQUITY", "Energy", "Oil & Gas")["set_sector"] == "WARRANT"


def test_thai_property_fund_is_a_fund_despite_the_equity_quote_type():
    out = classify("CPNREIT.BK", "EQUITY", "Real Estate", "REIT - Retail",
                   name="CPN Retail Growth Leasehold REIT")
    assert out["asset_class"] == "fund"
    assert out["set_sector"] == "PFUND"


def test_unknown_classification_says_other_rather_than_nothing():
    out = classify("WEIRD.BK", "EQUITY", None, None)
    assert out["set_sector"] == "Other"
    assert out["us_sector"] == "Other"
    assert out["asset_class"] == "equity"


def test_a_conglomerate_is_not_forced_into_one_set_sector():
    assert classify("SCC.BK", "EQUITY", "Industrials", "Conglomerates")["set_sector"] == "Other"


@pytest.mark.parametrize(
    "name,category,kind",
    [
        ("ProShares UltraPro QQQ", None, "leveraged"),
        ("ProShares UltraPro Short QQQ", None, "inverse"),
        ("ProShares UltraShort QQQ", None, "inverse"),
        ("Direxion Daily Semiconductor Bull 3X Shares", None, "leveraged"),
        ("Direxion Daily Semiconductor Bear 3X Shares", None, "inverse"),
        ("ProShares Short S&P500", None, "inverse"),
        ("T-Rex 2X Long MSTR Daily Target ETF", None, "leveraged"),
        ("Defiance Daily Target 2X Short MSTR ETF", None, "inverse"),
        # Short-duration bond funds are not bets against anything
        ("iShares Short Treasury Bond ETF", None, None),
        ("JPMorgan Ultra-Short Income ETF", None, None),
        ("Invesco Ultra Short Duration ETF", None, None),
        ("Vanguard Short-Term Bond ETF", None, None),
        ("SPDR S&P 500 ETF Trust", None, None),
        # Yahoo's fund category decides when present
        ("Some Fund", "Trading--Leveraged Equity", "leveraged"),
        ("Some Fund", "Trading--Inverse Debt", "inverse"),
    ],
)
def test_etf_kind(name, category, kind):
    from sector_map import etf_kind
    assert etf_kind(category, name) == kind


def test_leveraged_and_inverse_etfs_get_their_own_us_sector():
    assert classify("TQQQ", "ETF", name="ProShares UltraPro QQQ")["us_sector"] == "ETF - Leveraged"
    out = classify("SQQQ", "ETF", name="ProShares UltraPro Short QQQ")
    assert out["us_sector"] == "ETF - Inverse" and out["set_sector"] == "ETF"
    assert classify("SPY", "ETF", name="SPDR S&P 500 ETF Trust")["us_sector"] == "ETF"


@pytest.mark.parametrize("label,gics", [
    ("ENERG", "Energy"), ("Energy", "Energy"), ("TECH", "Information Technology"),
    ("Technology", "Information Technology"), ("Communication Services", "Communication Services"),
    ("CONS", "Industrials"), ("Consumer Defensive", "Consumer Staples"), ("FOOD", "Consumer Staples"),
    ("", "Unclassified"), (None, "Unclassified"), ("energ", "Energy"), ("Something", "Something"),
])
def test_to_gics(label, gics):
    from sector_map import to_gics
    assert to_gics(label) == gics


# ── fit_sector: a stored sector stays in its account's list ──────────────────

from sector_map import SET_SECTORS, US_SECTORS, fit_sector, sector_vocab  # noqa: E402


def test_sector_vocab_per_account():
    assert sector_vocab("dime", "USD") is US_SECTORS
    assert sector_vocab("finansia", "THB") is SET_SECTORS
    assert sector_vocab("someusd", "USD") is US_SECTORS
    assert sector_vocab("other", "THB") is SET_SECTORS


def test_fit_sector_keeps_a_label_that_fits():
    assert fit_sector("Information Technology", US_SECTORS) == "Information Technology"
    assert fit_sector("ETRON", SET_SECTORS) == "ETRON"
    assert fit_sector("", US_SECTORS) == ""


def test_fit_sector_uses_the_classification_in_the_accounts_list():
    # SNDK filed as the SET code on Dime: the classification decides
    cls = {"set_sector": "ETRON", "us_sector": "Information Technology"}
    assert fit_sector("ETRON", US_SECTORS, cls) == "Information Technology"
    # a GICS label on a Thai account goes back to the SET code
    assert fit_sector("Industrials", SET_SECTORS, {"set_sector": "TRANS", "us_sector": "Industrials"}) == "TRANS"


def test_fit_sector_falls_back_to_gics_then_blank():
    assert fit_sector("TECH", US_SECTORS) == "Information Technology"
    assert fit_sector("BOND", US_SECTORS) == "Fixed Income"
    assert fit_sector("INDU", SET_SECTORS) == ""   # no SET code is a guess
