"""Turn a symbol's raw provider classification into the sector the portfolio uses.

Yahoo speaks one vocabulary ("Financial Services", "Consumer Defensive"), the
Thai account speaks SET codes (BANK, COMM, ENERG) and the US account speaks
GICS labels ("Financials", "Consumer Staples"). None of the three line up by
string matching — "Healthcare" does not contain "Health Care", and "Consumer
Defensive" matches "Consumer Discretionary" on its first word, which is the
wrong answer, not a near miss. So the translation is an explicit table.

Two steps, in order:
  1. asset class from quoteType + the symbol's shape — an ETF or a coin has no
     sector at all, and guessing one from its holdings is worse than saying ETF.
  2. sector, industry first and sector second, because the industry is what
     separates BANK from INSUR and PETRO from ENERG.
"""
from __future__ import annotations

import re

# ── Asset class ──────────────────────────────────────────────────────────────

_QUOTE_TYPE_TO_CLASS = {
    "EQUITY": "equity",
    "ETF": "etf",
    "MUTUALFUND": "fund",
    "CRYPTOCURRENCY": "crypto",
    "CURRENCY": "fx",
    "INDEX": "index",
    "FUTURE": "future",
    "OPTION": "option",
}

# Thai instruments Yahoo reports as plain equities but the SET does not:
# NVDR (XXX-R), warrants (XXX-W1), foreign board (XXX-F), derivative warrants
# (BBL13C2512A — issuer digits, C/P, then the expiry).
_TH_WARRANT = re.compile(r"-W\d*$", re.I)
_TH_DW = re.compile(r"^[A-Z]{2,6}\d{2}[CP]\d{4}[A-Z]?$", re.I)
_TH_NVDR = re.compile(r"-R$", re.I)


def asset_class(symbol: str, quote_type: str | None, name: str = "") -> str:
    sym = str(symbol or "").upper().strip()
    base = sym.split(".")[0]
    if _TH_DW.match(base):
        return "dw"
    if _TH_WARRANT.search(base):
        return "warrant"
    qt = str(quote_type or "").upper()
    if qt in _QUOTE_TYPE_TO_CLASS:
        cls = _QUOTE_TYPE_TO_CLASS[qt]
        # Yahoo files Thai property/infrastructure funds as equities; the name
        # is the only thing that separates them from ordinary listings.
        if cls == "equity" and sym.endswith(".BK") and re.search(
            r"\b(property fund|infrastructure fund|reit|leasehold)\b", name or "", re.I
        ):
            return "fund"
        return cls
    if "-USD" in sym or "-USDT" in sym or "-THB" in sym:
        return "crypto"
    return "equity"


# ── Yahoo sector → US (GICS) label ───────────────────────────────────────────

YAHOO_TO_US: dict[str, str] = {
    "Technology": "Information Technology",
    "Financial Services": "Financials",
    "Consumer Cyclical": "Consumer Discretionary",
    "Consumer Defensive": "Consumer Staples",
    "Healthcare": "Health Care",
    "Basic Materials": "Materials",
    "Communication Services": "Communication Services",
    "Industrials": "Industrials",
    "Energy": "Energy",
    "Real Estate": "Real Estate",
    "Utilities": "Utilities",
    # Already-GICS inputs pass through unchanged.
    "Information Technology": "Information Technology",
    "Financials": "Financials",
    "Consumer Discretionary": "Consumer Discretionary",
    "Consumer Staples": "Consumer Staples",
    "Health Care": "Health Care",
    "Materials": "Materials",
}

# ── Yahoo industry → SET sector code ─────────────────────────────────────────
# Industry wins wherever it is decisive; the sector table below catches the rest.
# Matching is on a lowercase substring, so "Banks - Regional" hits "bank".

_INDUSTRY_TO_SET: list[tuple[str, str]] = [
    # Financials
    ("bank", "BANK"),
    ("insurance", "INSUR"),
    ("credit services", "FIN"),
    ("capital markets", "FIN"),
    ("asset management", "FIN"),
    ("financial data", "FIN"),
    ("financial conglomerates", "FIN"),
    ("mortgage", "FIN"),
    # Energy & utilities — the SET files utilities under ENERG
    ("oil & gas refining", "PETRO"),
    ("oil & gas", "ENERG"),
    ("coal", "ENERG"),
    ("uranium", "ENERG"),
    ("solar", "ENERG"),
    ("utilities", "ENERG"),
    # Materials
    ("chemicals", "PETRO"),
    ("steel", "STEEL"),
    ("aluminum", "STEEL"),
    ("copper", "MINE"),
    ("gold", "MINE"),
    ("silver", "MINE"),
    ("industrial metals", "MINE"),
    ("other precious metals", "MINE"),
    ("paper", "PAPER"),
    ("lumber", "PAPER"),
    ("packaging", "PACK"),
    ("building materials", "CONMAT"),
    ("agricultural inputs", "AGRI"),
    # Property & construction
    ("engineering & construction", "CONS"),
    ("infrastructure operations", "CONS"),
    ("residential construction", "CONS"),
    ("reit", "PFUND"),
    ("real estate", "PROP"),
    # Technology & telecom
    ("semiconductor", "ETRON"),
    ("electronic component", "ETRON"),
    ("electronics & computer distribution", "ETRON"),
    ("computer hardware", "ETRON"),
    ("consumer electronics", "ETRON"),
    ("scientific & technical instruments", "ETRON"),
    ("software", "ICT"),
    ("information technology services", "ICT"),
    ("communication equipment", "ICT"),
    ("telecom", "ICT"),
    # Media
    ("broadcasting", "MEDIA"),
    ("entertainment", "MEDIA"),
    ("publishing", "MEDIA"),
    ("advertising", "MEDIA"),
    ("electronic gaming", "MEDIA"),
    ("internet content", "MEDIA"),
    # Consumer
    ("auto", "AUTO"),
    ("apparel", "FASHION"),
    ("footwear", "FASHION"),
    ("textile", "FASHION"),
    ("luxury goods", "FASHION"),
    ("furnishings", "HOME"),
    ("home improvement", "HOME"),
    ("household & personal products", "PERSON"),
    ("personal services", "PERSON"),
    ("restaurants", "TOURISM"),
    ("lodging", "TOURISM"),
    ("resorts & casinos", "TOURISM"),
    ("travel services", "TOURISM"),
    ("airports", "TRANS"),
    ("beverages", "FOOD"),
    ("packaged foods", "FOOD"),
    ("farm products", "FOOD"),
    ("confectioners", "FOOD"),
    ("food distribution", "FOOD"),
    ("grocery stores", "COMM"),
    ("discount stores", "COMM"),
    ("department stores", "COMM"),
    ("specialty retail", "COMM"),
    ("apparel retail", "COMM"),
    ("internet retail", "COMM"),
    ("industrial distribution", "COMM"),
    # Healthcare
    ("medical", "HELTH"),
    ("healthcare", "HELTH"),
    ("health information", "HELTH"),
    ("drug manufacturers", "HELTH"),
    ("pharmaceutical", "HELTH"),
    ("biotechnology", "HELTH"),
    ("diagnostics", "HELTH"),
    # Transport & professional services
    ("airlines", "TRANS"),
    ("trucking", "TRANS"),
    ("railroads", "TRANS"),
    ("marine shipping", "TRANS"),
    ("integrated freight", "TRANS"),
    ("consulting services", "PROF"),
    ("staffing", "PROF"),
    ("specialty business services", "PROF"),
    ("security & protection", "PROF"),
    ("rental & leasing", "PROF"),
    ("waste management", "PROF"),
    ("education", "PROF"),
    # A conglomerate spans several SET sectors by definition; PROF would be a
    # guess dressed up as an answer.
    ("conglomerates", "Other"),
]

_SECTOR_TO_SET: dict[str, str] = {
    "Energy": "ENERG",
    "Utilities": "ENERG",
    "Basic Materials": "PETRO",
    "Materials": "PETRO",
    "Financial Services": "FIN",
    "Financials": "FIN",
    "Real Estate": "PROP",
    "Technology": "ICT",
    "Information Technology": "ICT",
    "Communication Services": "ICT",
    "Healthcare": "HELTH",
    "Health Care": "HELTH",
    "Consumer Cyclical": "COMM",
    "Consumer Discretionary": "COMM",
    "Consumer Defensive": "FOOD",
    "Consumer Staples": "FOOD",
    # Industrials covers AUTO, PAPER, PACK and STEEL on the SET, so the sector
    # alone decides nothing — only the industry rules above do.
    "Industrials": "Other",
}

# What a non-equity is, in each vocabulary.
_CLASS_SECTOR = {
    "etf": ("ETF", "ETF"),
    "fund": ("PFUND", "ETF"),
    "crypto": ("CRYPTO", "Crypto"),
    "dw": ("DW", "Other"),
    "warrant": ("WARRANT", "Other"),
    "fx": ("Other", "Other"),
    "index": ("Other", "Other"),
    "future": ("Other", "Other"),
    "option": ("Other", "Other"),
}


def classify(
    symbol: str,
    quote_type: str | None = None,
    sector: str | None = None,
    industry: str | None = None,
    name: str = "",
) -> dict:
    """Return the asset class plus the sector in both the SET and the GICS lists.

    Every field is always present; unknown resolves to "Other" rather than None
    so the caller never has to decide what a missing sector means.
    """
    cls = asset_class(symbol, quote_type, name)
    if cls in _CLASS_SECTOR:
        set_sector, us_sector = _CLASS_SECTOR[cls]
        return {
            "asset_class": cls, "quote_type": quote_type,
            "sector_raw": sector, "industry_raw": industry,
            "set_sector": set_sector, "us_sector": us_sector,
        }

    ind = str(industry or "").lower()
    set_sector = next((code for key, code in _INDUSTRY_TO_SET if key in ind), None)
    if set_sector is None:
        set_sector = _SECTOR_TO_SET.get(str(sector or "").strip(), "Other")
    us_sector = YAHOO_TO_US.get(str(sector or "").strip(), "Other")

    return {
        "asset_class": cls, "quote_type": quote_type,
        "sector_raw": sector, "industry_raw": industry,
        "set_sector": set_sector, "us_sector": us_sector,
    }
