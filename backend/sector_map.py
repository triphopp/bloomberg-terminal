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


# ── ETF kind: leveraged / inverse ────────────────────────────────────────────
# A 3x or a -1x fund is a different risk from a plain index ETF, so the US list
# files them apart. Yahoo's fund category ("Trading--Leveraged Equity",
# "Trading--Inverse Debt") is decisive when present; the fund name is the
# fallback. The name rules are narrow on purpose: "Short-Term Treasury" and
# "Ultra-Short Income" are plain bond funds, not bets against anything.

ETF_LEVERAGED = "ETF - Leveraged"
ETF_INVERSE = "ETF - Inverse"

_INVERSE_NAME = re.compile(
    r"\binverse\b|\bbear\b|\bultrashort\b|\bultrapro short\b|\bproshares short\b"
    r"|-\s?\d+(?:\.\d+)?x\b|\b\d+(?:\.\d+)?x\s+short\b",
    re.I,
)
_LEVERAGED_NAME = re.compile(
    r"\bleveraged\b|\bbull\b|\bultra(?:pro)?\b(?![-\s]short)|\b\d+(?:\.\d+)?x\b",
    re.I,
)


def etf_kind(category: str | None = None, name: str = "") -> str | None:
    """"inverse", "leveraged" or None. Inverse wins: a -3x fund is both."""
    cat = str(category or "").lower()
    if "inverse" in cat:
        return "inverse"
    if "leveraged" in cat:
        return "leveraged"
    nm = str(name or "")
    if _INVERSE_NAME.search(nm):
        return "inverse"
    if _LEVERAGED_NAME.search(nm):
        return "leveraged"
    return None


def classify(
    symbol: str,
    quote_type: str | None = None,
    sector: str | None = None,
    industry: str | None = None,
    name: str = "",
    category: str | None = None,
) -> dict:
    """Return the asset class plus the sector in both the SET and the GICS lists.

    Every field is always present; unknown resolves to "Other" rather than None
    so the caller never has to decide what a missing sector means.
    """
    cls = asset_class(symbol, quote_type, name)
    if cls in _CLASS_SECTOR:
        set_sector, us_sector = _CLASS_SECTOR[cls]
        kind = etf_kind(category, name) if cls == "etf" else None
        if kind:
            us_sector = ETF_INVERSE if kind == "inverse" else ETF_LEVERAGED
        return {
            "asset_class": cls, "quote_type": quote_type,
            "sector_raw": sector, "industry_raw": industry,
            "set_sector": set_sector, "us_sector": us_sector,
            "etf_kind": kind,
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
        "etf_kind": None,
    }


# ── One vocabulary for risk caps (GICS-11 names) ─────────────────────────────
# Trade rows carry whatever the ENTRY form offered at the time: SET industry
# codes (ENERG, TRANS), Yahoo sector names (Technology, Consumer Defensive), GICS
# names (Consumer Staples) and free labels (TECH). A sector cap that groups by
# the raw string never sees "ENERG" and "Energy" as one exposure. to_gics() maps
# every spelling onto the 11 GICS sector names so a cap can add them up.
# Lossy by design (SET ENERG holds utilities too; CONS is construction, TASCO
# is really construction materials) — good enough to catch concentration.
_TO_GICS: dict[str, str] = {
    # SET industry / sector codes
    "AGRI": "Consumer Staples", "FOOD": "Consumer Staples", "PERSON": "Consumer Staples",
    "FASHION": "Consumer Discretionary", "HOME": "Consumer Discretionary",
    "TOURISM": "Consumer Discretionary", "MEDIA": "Communication Services",
    "COMM": "Consumer Discretionary", "AUTO": "Consumer Discretionary",
    "BANK": "Financials", "FIN": "Financials", "INSUR": "Financials",
    "PETRO": "Materials", "CHEM": "Materials", "STEEL": "Materials", "CONMAT": "Materials",
    "PKG": "Materials", "PAPER": "Materials", "MINE": "Materials",
    "IMM": "Industrials", "CONS": "Industrials", "TRANS": "Industrials", "PROF": "Industrials",
    "PROP": "Real Estate", "PF&REIT": "Real Estate",
    "ENERG": "Energy", "HELTH": "Health Care",
    "ETRON": "Information Technology", "ICT": "Communication Services",
    # Yahoo sector names
    "Technology": "Information Technology", "Financial Services": "Financials",
    "Healthcare": "Health Care", "Consumer Cyclical": "Consumer Discretionary",
    "Consumer Defensive": "Consumer Staples", "Basic Materials": "Materials",
    # Free labels seen in the book
    "TECH": "Information Technology", "Crypto": "Crypto", "CRYPTO": "Crypto",
}
GICS_SECTORS = (
    "Energy", "Materials", "Industrials", "Consumer Discretionary", "Consumer Staples",
    "Health Care", "Financials", "Information Technology", "Communication Services",
    "Utilities", "Real Estate",
)


def to_gics(label: str | None) -> str:
    """Any sector spelling → a GICS-11 name, 'Crypto', or the label unchanged
    ('Unclassified' when blank). Case-insensitive on the known spellings."""
    s = str(label or "").strip()
    if not s:
        return "Unclassified"
    if s in GICS_SECTORS:
        return s
    if s in _TO_GICS:
        return _TO_GICS[s]
    up = {k.upper(): v for k, v in _TO_GICS.items()}
    return up.get(s.upper(), next((g for g in GICS_SECTORS if g.upper() == s.upper()), s))


# ── Per-account vocabulary: keep a stored sector in the account's own list ──
# The ENTRY form offers the SET list on a THB account and the US list on a USD
# one. A label from the OTHER list (SNDK filed as the SET code ETRON on Dime —
# the form looked the sector up before the account switch landed) is invisible
# in the form's picker and splits one exposure into two in every breakdown.
# Mirrors components/bloomberg/views/portfolio/constants.ts — keep them equal.

SET_SECTORS = (
    "AGRI", "FOOD", "FASHION", "HOME", "PERSON", "MEDIA", "COMM", "HELTH", "TOURISM",
    "BANK", "FIN", "INSUR", "AUTO", "ENERG", "PETRO", "MINE", "PACK", "PAPER", "STEEL",
    "HARDW", "CONS", "CONMAT", "PFUND", "PROP", "ICT", "ETRON", "TRANS", "PROF",
    "ETF", "DW", "WARRANT", "BOND", "CRYPTO", "Other",
)
US_SECTORS = (*GICS_SECTORS, "ETF", ETF_LEVERAGED, ETF_INVERSE, "Fixed Income", "Crypto", "Other")
CRYPTO_ACCOUNT_SECTORS = ("CRYPTO", "ETF", "Other")
_VOCAB_BY_ACCOUNT = {"finansia": SET_SECTORS, "dime": US_SECTORS,
                     "innovestx": CRYPTO_ACCOUNT_SECTORS}


def sector_vocab(account_id: str | None, account_currency: str | None) -> tuple[str, ...]:
    """The list the ENTRY form offers for this account (same rule as the form)."""
    if account_id in _VOCAB_BY_ACCOUNT:
        return _VOCAB_BY_ACCOUNT[str(account_id)]
    return US_SECTORS if (account_currency or "").upper() == "USD" else SET_SECTORS


def fit_sector(label: str | None, vocab: tuple[str, ...],
               classified: dict | None = None) -> str:
    """`label` if the account's list has it; else the provider classification
    in that list (`classify()` output); else, on the US list, the GICS name of
    the label (TECH → Information Technology); else "" — blank is honest, a
    label from the other list is not."""
    s = str(label or "").strip()
    if not s or s in vocab:
        return s
    for key in ("set_sector", "us_sector"):
        cand = (classified or {}).get(key)
        if cand and cand in vocab and cand != "Other":
            return cand
    if vocab is US_SECTORS:
        g = to_gics(s)
        if g in vocab:
            return g
        if s.upper() in ("BOND", "FIXED INCOME"):
            return "Fixed Income"
    return ""
