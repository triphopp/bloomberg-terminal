"""
Shared configuration — constants, env vars, static data.
"""
import os
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

# ── Index configuration ───────────────────────────────────────────────────────
INDICES = [
    # Americas
    {"region": "americas",    "id": "DOW JONES",    "symbol": "^DJI",       "num": "11)"},
    {"region": "americas",    "id": "S&P 500",       "symbol": "^GSPC",     "num": "12)"},
    {"region": "americas",    "id": "NASDAQ",        "symbol": "^IXIC",     "num": "13)"},
    {"region": "americas",    "id": "S&P/TSX Comp",  "symbol": "^GSPTSE",   "num": "14)"},
    {"region": "americas",    "id": "S&P/BMV IPC",   "symbol": "^MXX",      "num": "15)"},
    {"region": "americas",    "id": "IBOVESPA",      "symbol": "^BVSP",     "num": "16)"},
    # EMEA
    {"region": "emea",        "id": "Euro Stoxx 50", "symbol": "^STOXX50E", "num": "21)"},
    {"region": "emea",        "id": "FTSE 100",      "symbol": "^FTSE",     "num": "22)"},
    {"region": "emea",        "id": "CAC 40",        "symbol": "^FCHI",     "num": "23)"},
    {"region": "emea",        "id": "DAX",           "symbol": "^GDAXI",    "num": "24)"},
    {"region": "emea",        "id": "IBEX 35",       "symbol": "^IBEX",     "num": "25)"},
    {"region": "emea",        "id": "FTSE MIB",      "symbol": "FTSEMIB.MI","num": "26)"},
    {"region": "emea",        "id": "OMX STKH30",   "symbol": "^OMX",      "num": "27)"},
    {"region": "emea",        "id": "SWISS MKT",    "symbol": "^SSMI",     "num": "28)"},
    # Asia Pacific
    {"region": "asiaPacific", "id": "NIKKEI",        "symbol": "^N225",     "num": "31)"},
    {"region": "asiaPacific", "id": "HANG SENG",     "symbol": "^HSI",      "num": "32)"},
    {"region": "asiaPacific", "id": "CSI 300",       "symbol": "000300.SS", "num": "33)"},
    {"region": "asiaPacific", "id": "S&P/ASX 200",   "symbol": "^AXJO",     "num": "34)"},
    {"region": "asiaPacific", "id": "SET Index",     "symbol": "^SET.BK",   "num": "35)"},
    {"region": "asiaPacific", "id": "KOSPI",         "symbol": "^KS11",     "num": "36)"},
]

# ── Heatmap groups ────────────────────────────────────────��───────────────────
HEATMAP_GROUPS: dict[str, list[dict]] = {
    "sectors": [
        {"id": "Technology",      "symbol": "XLK"},
        {"id": "Financials",      "symbol": "XLF"},
        {"id": "Energy",          "symbol": "XLE"},
        {"id": "Healthcare",      "symbol": "XLV"},
        {"id": "Industrials",     "symbol": "XLI"},
        {"id": "Consumer Disc",   "symbol": "XLY"},
        {"id": "Consumer Stpls",  "symbol": "XLP"},
        {"id": "Materials",       "symbol": "XLB"},
        {"id": "Utilities",       "symbol": "XLU"},
        {"id": "Real Estate",     "symbol": "XLRE"},
        {"id": "Communication",   "symbol": "XLC"},
    ],
    "commodities": [
        {"id": "Gold",            "symbol": "GC=F"},
        {"id": "Silver",          "symbol": "SI=F"},
        {"id": "WTI Crude",       "symbol": "CL=F"},
        {"id": "Brent Crude",     "symbol": "BZ=F"},
        {"id": "Natural Gas",     "symbol": "NG=F"},
        {"id": "Copper",          "symbol": "HG=F"},
        {"id": "Corn",            "symbol": "ZC=F"},
        {"id": "Wheat",           "symbol": "ZW=F"},
    ],
    "bonds": [
        {"id": "US 10Y Yield",    "symbol": "^TNX"},
        {"id": "US 3M Yield",     "symbol": "^IRX"},
        {"id": "20Y+ Bond ETF",   "symbol": "TLT"},
        {"id": "7-10Y Bond ETF",  "symbol": "IEF"},
        {"id": "Total Bond",      "symbol": "BND"},
    ],
    "indicators": [
        {"id": "VIX",             "symbol": "^VIX"},
        {"id": "Dollar Index",    "symbol": "DX=F"},
        {"id": "US 10Y",          "symbol": "^TNX"},
        {"id": "Gold",            "symbol": "GC=F"},
        {"id": "WTI Oil",         "symbol": "CL=F"},
    ],
}

# ── International Sector Stocks ──────────────────────────────────────────────
# Representative large-cap stocks grouped by sector for each country/region.
# Used by /api/heatmap/intl-sectors endpoint for nested treemap display.

INTL_SECTOR_STOCKS: dict[str, list[dict]] = {
    "th": [
        # Banks
        {"symbol": "SCB.BK",    "id": "SCB",    "sector": "Banks"},
        {"symbol": "KBANK.BK",  "id": "KBANK",  "sector": "Banks"},
        {"symbol": "BBL.BK",    "id": "BBL",    "sector": "Banks"},
        {"symbol": "KTB.BK",    "id": "KTB",    "sector": "Banks"},
        {"symbol": "TTB.BK",    "id": "TTB",    "sector": "Banks"},
        # Energy
        {"symbol": "PTT.BK",    "id": "PTT",    "sector": "Energy"},
        {"symbol": "PTTEP.BK",  "id": "PTTEP",  "sector": "Energy"},
        {"symbol": "GULF.BK",   "id": "GULF",   "sector": "Energy"},
        {"symbol": "GPSC.BK",   "id": "GPSC",   "sector": "Energy"},
        # Telecom
        {"symbol": "ADVANC.BK", "id": "ADVANC", "sector": "Telecom"},
        {"symbol": "TRUE.BK",   "id": "TRUE",   "sector": "Telecom"},
        {"symbol": "INTUCH.BK", "id": "INTUCH", "sector": "Telecom"},
        # Food & Beverage
        {"symbol": "CPF.BK",    "id": "CPF",    "sector": "Food"},
        {"symbol": "TU.BK",     "id": "TU",     "sector": "Food"},
        {"symbol": "MINT.BK",   "id": "MINT",   "sector": "Food"},
        # Property & REIT
        {"symbol": "CPN.BK",    "id": "CPN",    "sector": "Property"},
        {"symbol": "LH.BK",     "id": "LH",     "sector": "Property"},
        {"symbol": "AP.BK",     "id": "AP",     "sector": "Property"},
        # Healthcare
        {"symbol": "BDMS.BK",   "id": "BDMS",   "sector": "Healthcare"},
        {"symbol": "BH.BK",     "id": "BH",     "sector": "Healthcare"},
        # Industrial & Materials
        {"symbol": "SCC.BK",    "id": "SCC",    "sector": "Industrial"},
        {"symbol": "IVL.BK",    "id": "IVL",    "sector": "Industrial"},
        {"symbol": "SCGP.BK",   "id": "SCGP",   "sector": "Industrial"},
        # Commerce
        {"symbol": "CPALL.BK",  "id": "CPALL",  "sector": "Commerce"},
        {"symbol": "HMPRO.BK",  "id": "HMPRO",  "sector": "Commerce"},
        {"symbol": "CRC.BK",    "id": "CRC",    "sector": "Commerce"},
    ],
    "cn": [
        # Tech (US ADRs + HK)
        {"symbol": "BABA",      "id": "BABA",    "sector": "Tech"},
        {"symbol": "PDD",       "id": "PDD",     "sector": "Tech"},
        {"symbol": "JD",        "id": "JD",      "sector": "Tech"},
        {"symbol": "BIDU",      "id": "BIDU",    "sector": "Tech"},
        {"symbol": "0700.HK",   "id": "TENCENT", "sector": "Tech"},
        # Finance (HK-listed)
        {"symbol": "1398.HK",   "id": "ICBC",    "sector": "Finance"},
        {"symbol": "0939.HK",   "id": "CCB",     "sector": "Finance"},
        {"symbol": "3988.HK",   "id": "BOC",     "sector": "Finance"},
        {"symbol": "3968.HK",   "id": "CMB",     "sector": "Finance"},
        # Energy
        {"symbol": "0857.HK",   "id": "PETROCH", "sector": "Energy"},
        {"symbol": "0883.HK",   "id": "CNOOC",   "sector": "Energy"},
        {"symbol": "0386.HK",   "id": "SINOPEC", "sector": "Energy"},
        # EV & Auto
        {"symbol": "1211.HK",   "id": "BYD",     "sector": "EV & Auto"},
        {"symbol": "NIO",       "id": "NIO",     "sector": "EV & Auto"},
        {"symbol": "LI",        "id": "LI AUTO", "sector": "EV & Auto"},
        {"symbol": "XPEV",      "id": "XPENG",   "sector": "EV & Auto"},
        # Consumer
        {"symbol": "9633.HK",   "id": "NONGFU",  "sector": "Consumer"},
        {"symbol": "YUMC",      "id": "YUM CN",  "sector": "Consumer"},
        {"symbol": "TCOM",      "id": "TRIP.COM", "sector": "Consumer"},
    ],
    "kr": [
        # Tech & Semiconductor
        {"symbol": "005930.KS", "id": "SAMSUNG",  "sector": "Tech"},
        {"symbol": "000660.KS", "id": "SK HYNIX", "sector": "Tech"},
        {"symbol": "035420.KS", "id": "NAVER",    "sector": "Tech"},
        {"symbol": "035720.KS", "id": "KAKAO",    "sector": "Tech"},
        # Auto
        {"symbol": "005380.KS", "id": "HYUNDAI",  "sector": "Auto"},
        {"symbol": "000270.KS", "id": "KIA",      "sector": "Auto"},
        # Finance
        {"symbol": "105560.KS", "id": "KB FIN",   "sector": "Finance"},
        {"symbol": "055550.KS", "id": "SHINHAN",  "sector": "Finance"},
        # Battery & Chem
        {"symbol": "006400.KS", "id": "SDI",      "sector": "Battery"},
        {"symbol": "373220.KS", "id": "LG ENERGY","sector": "Battery"},
        {"symbol": "051910.KS", "id": "LG CHEM",  "sector": "Battery"},
        # Steel & Industrial
        {"symbol": "005490.KS", "id": "POSCO",    "sector": "Industrial"},
        # Bio
        {"symbol": "068270.KS", "id": "CELLTRN",  "sector": "Bio"},
        {"symbol": "207940.KS", "id": "SAM BIO",  "sector": "Bio"},
    ],
    "eu": [
        # Tech
        {"symbol": "SAP.DE",    "id": "SAP",      "sector": "Tech"},
        {"symbol": "ASML.AS",   "id": "ASML",     "sector": "Tech"},
        # Luxury & Consumer
        {"symbol": "MC.PA",     "id": "LVMH",     "sector": "Luxury"},
        {"symbol": "OR.PA",     "id": "L'OREAL",  "sector": "Luxury"},
        {"symbol": "CDI.PA",    "id": "DIOR",     "sector": "Luxury"},
        # Finance
        {"symbol": "BNP.PA",    "id": "BNP",      "sector": "Finance"},
        {"symbol": "SAN.MC",    "id": "SANTANDER","sector": "Finance"},
        {"symbol": "ING.AS",    "id": "ING",      "sector": "Finance"},
        # Energy
        {"symbol": "SHEL.L",    "id": "SHELL",    "sector": "Energy"},
        {"symbol": "TTE.PA",    "id": "TOTAL",    "sector": "Energy"},
        # Healthcare
        {"symbol": "ROG.SW",    "id": "ROCHE",    "sector": "Healthcare"},
        {"symbol": "NOVN.SW",   "id": "NOVARTIS", "sector": "Healthcare"},
        {"symbol": "AZN.L",     "id": "AZENECA",  "sector": "Healthcare"},
        # Auto
        {"symbol": "VOW3.DE",   "id": "VW",       "sector": "Auto"},
        {"symbol": "BMW.DE",    "id": "BMW",      "sector": "Auto"},
        {"symbol": "MBG.DE",    "id": "MERCEDES", "sector": "Auto"},
        # Industrial
        {"symbol": "SIE.DE",    "id": "SIEMENS",  "sector": "Industrial"},
        {"symbol": "AIR.PA",    "id": "AIRBUS",   "sector": "Industrial"},
        # Consumer Staples
        {"symbol": "NESN.SW",   "id": "NESTLE",   "sector": "Staples"},
        {"symbol": "DGE.L",     "id": "DIAGEO",   "sector": "Staples"},
    ],
}

# ── Index → ETF proxy map (for market cap sizing) ────────────────────────────
INDEX_ETF_MAP: dict[str, str] = {
    "^DJI":       "DIA",
    "^GSPC":      "SPY",
    "^IXIC":      "QQQ",
    "^GSPTSE":    "EWC",
    "^MXX":       "EWW",
    "^BVSP":      "EWZ",
    "^STOXX50E":  "FEZ",
    "^FTSE":      "EWU",
    "^FCHI":      "EWQ",
    "^GDAXI":     "EWG",
    "^IBEX":      "EWP",
    "FTSEMIB.MI": "EWI",
    "^OMX":       "EWD",
    "^SSMI":      "EWL",
    "^N225":      "EWJ",
    "^HSI":       "EWH",
    "000300.SS":  "FXI",
    "^AXJO":      "EWA",
    "^SET.BK":    "THD",
    "^KS11":      "EWY",
}

# ── Cache TTLs ────────────────────────────────────────────────────────────────
CACHE_TTL = 60
STOCK_CACHE_TTL = 300
MAX_HISTORY_CACHE_TTL = 43200  # 12 hours — for max/5y periods (historical data never changes)
FB_CACHE_TTL = 300
YTD_CACHE_TTL = 3600
ETF_SIZE_CACHE_TTL = 3600
MEM_CACHE_TTL = 300  # 5 minutes — used by bot, central_banks, crisis, macro, sovereign, polymarket

# ── Quote provider registry (live-quote path) ───────────────────────────────────
# Default active price vendor + whether to auto-fail-over to the next healthy
# provider when the active one errors / returns empty. Override via env.
QUOTE_PROVIDER_DEFAULT = os.getenv("QUOTE_PROVIDER_DEFAULT", "yfinance")
QUOTE_AUTO_FAILOVER = os.getenv("QUOTE_AUTO_FAILOVER", "true").lower() == "true"

# ── HTTP defaults ──────────────────────────────────────────────────────────────
DEFAULT_HTTP_TIMEOUT = 15  # seconds — shared by central_banks, bot, polymarket

# ── External API base URLs ─────────────────────────────────────────────────────
CENTRAL_BANK_URLS: dict[str, str] = {
    "ecb":        "https://data-api.ecb.europa.eu/service",
    "boe":        "https://www.bankofengland.co.uk/boeapps/database",
    "boc":        "https://www.bankofcanada.ca/valet",
    "norges":     "https://data.norges-bank.no/api",
    "bundesbank": "https://api.statistiken.bundesbank.de/rest",
    "snb":        "https://data.snb.ch/api",
    "boj":        "https://www.stat-search.boj.or.jp/api",
    "sarb":       "https://custom.resbank.co.za/SarbWebApi/WebIndicators",
    "cbr":        "https://www.cbr.ru/scripts",
    "rba":        "https://www.rba.gov.au/statistics/cash-rate/",
    "eurostat":   "https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1",
    "bde":        "https://www.bde.es/webbe/en/estadisticas",
    "oenb":       "https://www.oenb.at/isaweb",
}
POLYMARKET_GAMMA_BASE = "https://gamma-api.polymarket.com"
BINANCE_BASE_URL = "https://api.binance.com"
ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query"
FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"
FRED_JSON_URL = "https://api.stlouisfed.org/fred/series/observations"
WORLD_BANK_URL = "https://api.worldbank.org/v2/country"
YAHOO_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search"

# ── CORS ───────────────────────────────────────────────────────────────────────
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")

# ── Claude API ─────────────────────────────────────────────────────────────────
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-opus-4-5")
CLAUDE_MAX_TOKENS = int(os.getenv("CLAUDE_MAX_TOKENS", "4096"))

# ── Polymarket ─────────────────────────────────────────────────────────────────
GAMMA_POOL_MAX = 3000
GAMMA_PAGE_SIZE = 100

# ── Environment variables ─────────────────────────────────────────────────────
FACEBOOK_TOKEN = os.getenv("FACEBOOK_ACCESS_TOKEN", "")
RSSHUB_URL = os.getenv("RSSHUB_URL", "https://rsshub.app")

CLIPPINGS_DIR = Path(os.getenv("CLIPPINGS_DIR", "./data/clippings"))
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")

THESES_DIR = Path(os.getenv("THESES_DIR", "./data/theses"))
SOURCES_DIR = Path(os.getenv("SOURCES_DIR", "./data/sources"))
OBSIDIAN_WIKI_DIR = Path(os.getenv("OBSIDIAN_WIKI_DIR", "./data/wiki"))

CLAUDE_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ALPHA_VANTAGE_KEY = os.getenv("ALPHA_VANTAGE_API_KEY", "")
FRED_API_KEY = os.getenv("FRED_API_KEY", "")
BINANCE_API_KEY = os.getenv("BINANCE_API_KEY", "")

BOT_API_TOKEN   = os.getenv("BOT_API_TOKEN", "")     # Bond Auction
BOT_IR_TOKEN    = os.getenv("BOT_IR_TOKEN",  "")     # Interest Rates
BOT_FX_TOKEN    = os.getenv("BOT_FX_TOKEN",  "")     # Exchange Rates
BOT_STATS_TOKEN = os.getenv("BOT_STATS_TOKEN", "")   # Statistics (CategoryList)
BOT_BASE_URL    = "https://gateway.api.bot.or.th"

DB_PATH = Path(os.getenv("PORTFOLIO_DB", "portfolio.db"))

# ── SEC Thailand (sec.or.th) ──────────────────────────────────────────────────
# Each product subscription has its own key. Store Primary key only.
# Secondary key is for manual rotation — keep it in a password manager, not here.
# Get keys at: https://developer.sec.or.th -> My Applications -> each product.
SEC_BASE_URL = os.getenv("SEC_BASE_URL", "https://api.sec.or.th")

# Old portal keys (legacy paths — expire 2026-06-30, Bond v1 already dead)
SEC_KEYS: dict[str, str] = {
    "common":         os.getenv("SEC_COMMON_PRIMARY", ""),
    "bond":           os.getenv("SEC_BOND_PRIMARY", ""),
    "fund_factsheet": os.getenv("SEC_FUND_FACTSHEET_PRIMARY", ""),
    "fund_daily":     os.getenv("SEC_FUND_DAILY_PRIMARY", ""),
    "digital_asset":  os.getenv("SEC_DIGITAL_ASSET_PRIMARY", ""),
    "one_report":     os.getenv("SEC_ONE_REPORT_PRIMARY", ""),
}

# New portal keys (secopendata.sec.or.th) — v2 paths, same gateway.
# SEC2_API_KEY = single key for all products (Option A).
# Per-product keys override the single key if both are set (Option B).
_SEC2_SINGLE = os.getenv("SEC2_API_KEY", "")

def _sec2_key(product_env: str) -> str:
    """Return per-product key if set, else fall back to single key."""
    return os.getenv(product_env, "") or _SEC2_SINGLE

SEC2_KEYS: dict[str, str] = {
    "fund":          _sec2_key("SEC2_FUND_PRIMARY"),
    "bond":          _sec2_key("SEC2_BOND_PRIMARY"),
    "digital_asset": _sec2_key("SEC2_DIGITAL_ASSET_PRIMARY"),
    "one_report":    _sec2_key("SEC2_ONE_REPORT_PRIMARY"),
    "common":        _sec2_key("SEC2_COMMON_PRIMARY"),
}

# ── FX pairs ───────��──────────────────────────��───────────────────────────────
FX_PAIRS = [
    {"id": "EUR/USD", "symbol": "EURUSD=X"},
    {"id": "GBP/USD", "symbol": "GBPUSD=X"},
    {"id": "USD/JPY", "symbol": "JPY=X"},
    {"id": "USD/CHF", "symbol": "CHF=X"},
    {"id": "AUD/USD", "symbol": "AUDUSD=X"},
    {"id": "USD/CAD", "symbol": "CAD=X"},
    {"id": "NZD/USD", "symbol": "NZDUSD=X"},
    {"id": "EUR/GBP", "symbol": "EURGBP=X"},
    {"id": "EUR/JPY", "symbol": "EURJPY=X"},
    {"id": "GBP/JPY", "symbol": "GBPJPY=X"},
    {"id": "USD/CNY", "symbol": "CNY=X"},
    {"id": "USD/THB", "symbol": "THB=X"},
    {"id": "USD/SGD", "symbol": "SGD=X"},
    {"id": "USD/HKD", "symbol": "HKD=X"},
    {"id": "USD/KRW", "symbol": "KRW=X"},
    {"id": "USD/INR", "symbol": "INR=X"},
    {"id": "USD/MXN", "symbol": "MXN=X"},
    {"id": "USD/BRL", "symbol": "BRL=X"},
    {"id": "USD/ZAR", "symbol": "ZAR=X"},
    {"id": "USD/TRY", "symbol": "TRY=X"},
]

# ── Crypto list ────────────────────────────────────���──────────────────────────
CRYPTO_LIST = [
    {"id": "BTC",  "symbol": "BTC-USD",  "name": "Bitcoin"},
    {"id": "ETH",  "symbol": "ETH-USD",  "name": "Ethereum"},
    {"id": "BNB",  "symbol": "BNB-USD",  "name": "BNB"},
    {"id": "SOL",  "symbol": "SOL-USD",  "name": "Solana"},
    {"id": "XRP",  "symbol": "XRP-USD",  "name": "XRP"},
    {"id": "ADA",  "symbol": "ADA-USD",  "name": "Cardano"},
    {"id": "DOGE", "symbol": "DOGE-USD", "name": "Dogecoin"},
    {"id": "AVAX", "symbol": "AVAX-USD", "name": "Avalanche"},
    {"id": "DOT",  "symbol": "DOT-USD",  "name": "Polkadot"},
    {"id": "LINK", "symbol": "LINK-USD", "name": "Chainlink"},
    {"id": "MATIC","symbol": "MATIC-USD","name": "Polygon"},
    {"id": "UNI",  "symbol": "UNI-USD",  "name": "Uniswap"},
    {"id": "ATOM", "symbol": "ATOM-USD", "name": "Cosmos"},
    {"id": "LTC",  "symbol": "LTC-USD",  "name": "Litecoin"},
    {"id": "NEAR", "symbol": "NEAR-USD", "name": "NEAR Protocol"},
    {"id": "SUI",  "symbol": "SUI20947-USD", "name": "Sui"},
    {"id": "APT",  "symbol": "APT21794-USD", "name": "Aptos"},
    {"id": "ARB",  "symbol": "ARB11841-USD", "name": "Arbitrum"},
    {"id": "OP",   "symbol": "OP-USD",   "name": "Optimism"},
    {"id": "PEPE", "symbol": "PEPE24478-USD","name": "Pepe"},
]

# ── History period maps ──────���────────────────────────────────────────────────
PERIOD_TO_YF: dict[str, str] = {
    "1d":  "1d",
    "5d":  "5d",
    "1w":  "5d",
    "1m":  "1mo",
    "3m":  "3mo",
    "ytd": "ytd",
    "1y":  "1y",
    "5y":  "5y",
    "max": "max",
}

HISTORY_PERIOD_MAP: dict[str, tuple[str, str]] = {
    "1d":  ("1d",  "5m"),
    "5d":  ("5d",  "1h"),
    "1w":  ("5d",  "1d"),
    "1m":  ("1mo", "1d"),
    "3m":  ("3mo", "1d"),
    "ytd": ("ytd", "1d"),
    "1y":  ("1y",  "1d"),
    "5y":  ("5y",  "1wk"),
    "max": ("max", "1wk"),
}

VALID_INTERVALS = {"5m", "15m", "30m", "1h", "2h", "4h", "1d", "1wk"}
