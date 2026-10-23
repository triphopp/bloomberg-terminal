"""Who belongs to each ROT group — by the group's own published definition.

ROT ranks groups; this module says what a group IS, so a drill-down lists the
stocks the definition names rather than a guess at them. Three kinds of group,
three authorities:

  US sectors  GICS (MSCI / S&P). Each row is the Select Sector SPDR that tracks
              its S&P Select Sector index = the S&P 500 members in that GICS
              sector. Members + weights come from the fund's own daily holdings
              file (State Street), not from Yahoo.
  US themes   No classification standard exists — a theme IS its ETF. Members
              are the fund's holdings: State Street's file where the fund is
              theirs, else Yahoo's top-10 (labelled as top 10, never as "all").
  TH          The Stock Exchange of Thailand's own industry groups (8) and
              sectors (28). Membership is the SET's published composition,
              snapshotted in reference_data/set_sectors.tsv (the SET site
              refuses scripts, so the file is refreshed by hand).

Never fill a membership from Yahoo's `sector` field: Yahoo uses Morningstar's
sectors ("Consumer Cyclical", "Financial Services"), which are neither GICS nor
SET — the heatmap's grouping is Yahoo's and must not be reused here.
"""
from __future__ import annotations

import io
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

import pandas as pd

# ── US: GICS sectors → the SPDR that tracks each ─────────────────────────────
# (GICS code, GICS sector name, ETF). Names are GICS's own (2023 structure).
GICS_SECTORS: list[tuple[str, str, str]] = [
    ("45", "Information Technology", "XLK"),
    ("40", "Financials", "XLF"),
    ("35", "Health Care", "XLV"),
    ("10", "Energy", "XLE"),
    ("20", "Industrials", "XLI"),
    ("25", "Consumer Discretionary", "XLY"),
    ("30", "Consumer Staples", "XLP"),
    ("60", "Real Estate", "XLRE"),
    ("55", "Utilities", "XLU"),
    ("15", "Materials", "XLB"),
    ("50", "Communication Services", "XLC"),
]
GICS_BY_ETF = {etf: (code, name) for code, name, etf in GICS_SECTORS}

# ── US: themes — label, ETF, what the fund itself says it holds ──────────────
# The label must not promise more than the fund holds (audit 2026-10-23,
# memory/reference/rotation-groups.md).
THEMES: list[tuple[str, str, str]] = [
    ("Genomics",               "ARKG", "ARK Genomic Revolution ETF (active)"),
    ("Biotech",                "IBB",  "iShares Biotechnology ETF"),
    ("Pharma",                 "PPH",  "VanEck Pharmaceutical ETF — MVIS US Listed Pharmaceutical 25"),
    ("Fintech & Payments",     "FINX", "Global X FinTech ETF — Indxx Global FinTech Thematic"),
    ("Airlines",               "JETS", "U.S. Global Jets ETF — airline-focused index"),
    ("Homebuilders",           "XHB",  "SPDR S&P Homebuilders ETF — S&P Homebuilders Select Industry "
                                       "(also building products, furnishings, home-improvement retail)"),
    ("Aerospace & Defense",    "ITA",  "iShares U.S. Aerospace & Defense ETF — DJ US Select Aerospace & Defense"),
    ("Cybersecurity",          "CIBR", "First Trust NASDAQ Cybersecurity ETF"),
    ("Banks",                  "KBE",  "SPDR S&P Bank ETF — S&P Banks Select Industry (no brokers)"),
    ("Semiconductors",         "SMH",  "VanEck Semiconductor ETF — MVIS US Listed Semiconductor 25"),
    ("Software",               "IGV",  "iShares Expanded Tech-Software Sector ETF"),
    ("AI & Robotics",          "BOTZ", "Global X Robotics & Artificial Intelligence ETF"),
    ("Cloud",                  "SKYY", "First Trust Cloud Computing ETF"),
    ("Quantum",                "QTUM", "Defiance Quantum ETF — quantum computing & machine learning"),
    ("Solar",                  "TAN",  "Invesco Solar ETF — MAC Global Solar Energy"),
    ("Space & Defense",        "ARKX", "ARK Space & Defense Innovation ETF (active)"),
    ("Gold Miners",            "GDX",  "VanEck Gold Miners ETF — NYSE Arca Gold Miners"),
    ("Nuclear & Uranium",      "URA",  "Global X Uranium ETF — Solactive Global Uranium & Nuclear Components"),
    ("China Internet",         "KWEB", "KraneShares CSI China Internet ETF"),
    ("Crypto-linked",          "BITQ", "Bitwise Crypto Industry Innovators ETF"),
    ("Mag 7",                  "MAGS", "Roundhill Magnificent Seven ETF (equal-weight, active)"),
    ("Oil Services",           "OIH",  "VanEck Oil Services ETF — MVIS US Listed Oil Services 25"),
    ("Retail",                 "XRT",  "SPDR S&P Retail ETF — S&P Retail Select Industry"),
    ("Innovation (ARKK)",      "ARKK", "ARK Innovation ETF (active)"),
]
THEME_BY_ETF = {etf: (label, fund) for label, etf, fund in THEMES}

#: State Street publishes every holding of these funds daily; the rest of the
#: themes only have Yahoo's top 10.
SSGA_FUNDS = frozenset(etf for _, _, etf in GICS_SECTORS) | {"KBE", "XHB", "XRT"}
SSGA_URL = "https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-{t}.xlsx"


def us_yahoo(ticker: str) -> str:
    """Issuer ticker → Yahoo symbol: BRK.B → BRK-B."""
    return ticker.strip().upper().replace(".", "-").replace("/", "-")


_MONTH_CONTRACT = re.compile(r"\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2}\b")


def parse_ssga_holdings(content: bytes) -> dict:
    """State Street's daily holdings .xlsx → {fund, ticker, as_of, rows}.

    Layout (checked 2026-10-23 on XLK/XLF/KBE): a 4-line preamble (Fund Name,
    Ticker Symbol, "As of 21-Oct-2026"), then a header row Name | Ticker |
    Identifier | SEDOL | Weight | Sector | Shares Held | Local Currency, the
    holdings, a blank row, then disclaimers. Cash, the money-market sweep and
    index futures are not members and are dropped.
    """
    df = pd.read_excel(io.BytesIO(content), header=None, dtype=object)
    fund = ticker = as_of = None
    header_at = None
    for i in range(min(len(df), 20)):
        a = str(df.iat[i, 0] or "").strip()
        b = df.iat[i, 1] if df.shape[1] > 1 else None
        if a.startswith("Fund Name"):
            fund = str(b or "").strip() or None
        elif a.startswith("Ticker Symbol"):
            ticker = str(b or "").strip() or None
        elif a.startswith("Holdings"):
            m = re.search(r"(\d{1,2}-[A-Za-z]{3}-\d{4})", str(b or ""))
            if m:
                as_of = datetime.strptime(m.group(1), "%d-%b-%Y").date().isoformat()
        elif a == "Name" and str(b or "").strip() == "Ticker":
            header_at = i
            break
    if header_at is None:
        raise ValueError("holdings header row not found")
    cols = [str(c or "").strip() for c in df.iloc[header_at]]
    idx = {c: k for k, c in enumerate(cols)}
    rows = []
    for i in range(header_at + 1, len(df)):
        name = df.iat[i, idx["Name"]]
        if name is None or (isinstance(name, float) and pd.isna(name)) or not str(name).strip():
            break  # the blank row before the disclaimers
        name = " ".join(str(name).split())
        tick = str(df.iat[i, idx["Ticker"]] or "").strip()
        try:
            weight = float(df.iat[i, idx["Weight"]])
        except (TypeError, ValueError):
            continue
        if not tick or tick == "-" or weight <= 0 or _MONTH_CONTRACT.search(name.upper()):
            continue
        rows.append({"ticker": tick.upper(), "name": name, "weight": round(weight, 4)})
    return {"fund": fund, "ticker": ticker, "as_of": as_of, "rows": rows}


# ── Thailand: the SET's own classification ───────────────────────────────────
SET_INDUSTRIES: dict[str, str] = {
    "AGRO": "Agro & Food Industry",
    "CONSUMP": "Consumer Products",
    "FINCIAL": "Financials",
    "INDUS": "Industrials",
    "PROPCON": "Property & Construction",
    "RESOURC": "Resources",
    "SERVICE": "Services",
    "TECH": "Technology",
}
#: Sector code → (industry code, the SET's English sector name), in SET order.
SET_SECTORS: dict[str, tuple[str, str]] = {
    "AGRI": ("AGRO", "Agribusiness"),
    "FOOD": ("AGRO", "Food & Beverage"),
    "FASHION": ("CONSUMP", "Fashion"),
    "HOME": ("CONSUMP", "Home & Office Products"),
    "PERSON": ("CONSUMP", "Personal Products & Pharmaceuticals"),
    "BANK": ("FINCIAL", "Banking"),
    "FIN": ("FINCIAL", "Finance & Securities"),
    "INSUR": ("FINCIAL", "Insurance"),
    "AUTO": ("INDUS", "Automotive"),
    "IMM": ("INDUS", "Industrial Materials & Machinery"),
    "PAPER": ("INDUS", "Paper & Printing Materials"),
    "PETRO": ("INDUS", "Petrochemicals & Chemicals"),
    "PKG": ("INDUS", "Packaging"),
    "STEEL": ("INDUS", "Steel and Metal Products"),
    "CONMAT": ("PROPCON", "Construction Materials"),
    "CONS": ("PROPCON", "Construction Services"),
    "PF&REIT": ("PROPCON", "Property Fund & REITs"),
    "PROP": ("PROPCON", "Property Development"),
    "ENERG": ("RESOURC", "Energy & Utilities"),
    "MINE": ("RESOURC", "Mining"),
    "COMM": ("SERVICE", "Commerce"),
    "HELTH": ("SERVICE", "Health Care Services"),
    "MEDIA": ("SERVICE", "Media & Publishing"),
    "PROF": ("SERVICE", "Professional Services"),
    "TOURISM": ("SERVICE", "Tourism & Leisure"),
    "TRANS": ("SERVICE", "Transportation & Logistics"),
    "ETRON": ("TECH", "Electronic Components"),
    "ICT": ("TECH", "Information & Communication Technology"),
}
SET_SOURCE_URL = "https://www.set.or.th/en/market/index/set/overview"
SET_FILE = Path(__file__).parent / "reference_data" / "set_sectors.tsv"


def th_yahoo(symbol: str) -> str:
    """SET symbol → Yahoo symbol (checked 2026-10-23: L&E.BK, Q-CON.BK, 2S.BK resolve)."""
    return f"{symbol.strip().upper()}.BK"


_set_cache: dict[str, dict] = {}


def load_set_snapshot(path: Path = SET_FILE) -> dict:
    """The SET membership file → {as_of, source, members: [{symbol, name, sector, industry, cap}]}.

    Read once per process. A row whose sector or industry disagrees with
    SET_SECTORS is an error, not a warning: it means the file and the table
    have drifted apart and every group built from them would be wrong.
    """
    key = str(path)
    if key in _set_cache:
        return _set_cache[key]
    as_of = None
    members = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        if line.startswith("#"):
            m = re.match(r"#\s*as_of:\s*(\d{4}-\d{2}-\d{2})", line)
            if m:
                as_of = m.group(1)
            continue
        sector, industry, symbol, cap, name = line.split("|", 4)
        if sector not in SET_SECTORS or SET_SECTORS[sector][0] != industry:
            raise ValueError(f"set_sectors.tsv: {symbol} has sector {sector}/{industry}, "
                             "which SET_SECTORS does not list")
        members.append({"symbol": symbol, "name": name, "sector": sector,
                        "industry": industry, "cap": float(cap)})
    snap = {"as_of": as_of, "source": SET_SOURCE_URL, "members": members}
    _set_cache[key] = snap
    return snap


def set_members(group: str, snap: Optional[dict] = None) -> list[dict]:
    """Members of a SET sector code (BANK) or industry code (FINCIAL), largest first."""
    snap = snap or load_set_snapshot()
    field = "industry" if group in SET_INDUSTRIES else "sector"
    out = [m for m in snap["members"] if m[field] == group]
    return sorted(out, key=lambda m: -m["cap"])


def index_basket(members: list[dict], coverage: float = 0.8, max_n: int = 10,
                 min_n: int = 3) -> list[dict]:
    """The largest members that together reach `coverage` of the group's cap.

    The group's own index is not on Yahoo, so ROT tracks the biggest names that
    make up most of it. Stops at `max_n`; takes at least `min_n` when the group
    has that many; never takes a member with no market cap (no trade that day).
    """
    ranked = sorted((m for m in members if m["cap"] > 0), key=lambda m: -m["cap"])
    total = sum(m["cap"] for m in ranked)
    out, acc = [], 0.0
    for m in ranked:
        if len(out) >= max_n:
            break
        if total and acc >= coverage * total and len(out) >= min_n:
            break
        out.append(m)
        acc += m["cap"]
    return out


def coverage_pct(basket: list[dict], members: list[dict]) -> Optional[float]:
    total = sum(m["cap"] for m in members if m["cap"] > 0)
    if not total:
        return None
    return round(100 * sum(m["cap"] for m in basket) / total, 1)


def cap_weighted_index(closes: pd.DataFrame, caps: dict[str, float]) -> Optional[pd.Series]:
    """Chain-linked, market-cap-weighted index of `caps`' columns (level 1.0 at the start).

    Shares are held constant (cap ÷ last close), so each day's weight is that
    member's market value the day before — the way a cap-weighted index moves
    between rebalances. A member that starts trading mid-window joins on its
    first day instead of jumping the level.
    """
    cols = [c for c in caps if c in closes.columns]
    if not cols:
        return None
    px = closes[cols].ffill()
    last = px.iloc[-1]
    shares = pd.Series({c: caps[c] / last[c] for c in cols if pd.notna(last[c]) and last[c] > 0})
    if shares.empty:
        return None
    px = px[shares.index]
    prev_mv = px.shift(1) * shares
    ret = px.pct_change(fill_method=None)
    num = (prev_mv * ret).sum(axis=1, min_count=1)
    den = prev_mv.where(ret.notna()).sum(axis=1, min_count=1)
    daily = (num / den).fillna(0.0)
    started = px.notna().any(axis=1)
    level = (1.0 + daily[started]).cumprod()
    return level if len(level) else None
