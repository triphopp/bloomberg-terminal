# ============================================================
# Backtest Configuration — Full Project Signal Suite
# ============================================================

# --- Periods ---
IN_SAMPLE_START  = "2015-01-01"
IN_SAMPLE_END    = "2022-12-31"
OOS_START        = "2023-01-01"
OOS_END          = "2024-12-31"
FORWARD_START    = "2025-01-01"

# --- Fat Tail Event Thresholds (SPY daily return) ---
CRASH_LEVELS = {
    "L1": -0.015,   # -1.5% moderate stress
    "L2": -0.030,   # -3.0% significant stress
    "L3": -0.050,   # -5.0% crisis
}

# --- Backtest Engine ---
LOOKAHEAD_DAYS = [1, 3, 5]

# ═══════════════════════════════════════════════════════
# GROUP 1 — VIX-based
# ═══════════════════════════════════════════════════════
VIX_ZSCORE_WINDOW    = 20
VIX_ZSCORE_THRESHOLD = 1.5
VIX_MOMENTUM_DAYS    = 5
VIX_MOMENTUM_PCT     = 0.20   # 20% 5-day rise

# ═══════════════════════════════════════════════════════
# GROUP 2 — Credit Spreads (mirrors crisis.py thresholds)
# ═══════════════════════════════════════════════════════
HY_THRESHOLD   = 5.0    # HY OAS > 5% → signal (crisis.py threshold)
IG_THRESHOLD   = 2.0    # IG OAS > 2%
EM_HY_THRESHOLD= 6.0    # EM HY OAS > 6%
TED_THRESHOLD  = 1.0    # TED spread > 1%
HY_ZSCORE_WINDOW     = 252
HY_ZSCORE_THRESHOLD  = 1.5   # rolling z-score alternative to static threshold

# ═══════════════════════════════════════════════════════
# GROUP 3 — Financial Stress Indices (FSI > 0 = stress)
# ═══════════════════════════════════════════════════════
STL_FSI_THRESHOLD = 0.0
NFCI_THRESHOLD    = 0.0

# ═══════════════════════════════════════════════════════
# GROUP 4 — Yield Curve
# ═══════════════════════════════════════════════════════
YC_INVERSION_THRESHOLD = 0.0   # < 0 = inverted

# ═══════════════════════════════════════════════════════
# GROUP 5 — Fear & Greed Synthetic (matches fear_greed.py)
# ═══════════════════════════════════════════════════════
FG_EXTREME_FEAR  = 25    # F&G < 25 → extreme fear
FG_FEAR_ZONE     = 45    # F&G < 45 → fear zone
FG_ROLLING_WINDOW = 504  # 2-year percentile window

# ═══════════════════════════════════════════════════════
# GROUP 6 — Sector Regime (mirrors regime.py)
# ═══════════════════════════════════════════════════════
SECTOR_CORR_WINDOW      = 20    # rolling correlation window
SECTOR_CONVERGENT_THRESH= 0.65  # avg pairwise correlation > threshold

# ═══════════════════════════════════════════════════════
# GROUP 7 — Equity Technicals
# ═══════════════════════════════════════════════════════
RSI_OVERSOLD_THRESHOLD  = 35    # SPY RSI < 35
RSI_PERIOD              = 14
PRICE_ZSCORE_WINDOW     = 20
PRICE_ZSCORE_THRESHOLD  = -2.0  # price < -2σ below 20d mean

# ═══════════════════════════════════════════════════════
# GROUP 8 — Allocation Layer A (matches layer_a.py logic)
# ═══════════════════════════════════════════════════════
LAYER_A_LOOKBACK    = 20    # 20d relative return
LAYER_A_Z_WINDOW    = 252   # rolling z-score window
LAYER_A_BEARISH     = -0.5  # z-score < -0.5 → bearish (score = -1)

# ═══════════════════════════════════════════════════════
# GROUP 9 — Crisis Composite (matches crisis.py weights)
# ═══════════════════════════════════════════════════════
# Weighted composite: CAPE 30%, HY 25%, VIX 20%, YC 15%, TED 10%
# Backtest uses only available yfinance/FRED: HY, VIX, YC (skip CAPE/TED in rolling)
CRISIS_COMPOSITE_RED = 45   # score > 45 → RED (was 66 — GFC-only, never fired)

# ═══════════════════════════════════════════════════════
# GROUP 10 — Volume & Flow
# ═══════════════════════════════════════════════════════
VOLUME_WINDOW          = 63
VOLUME_ZSCORE_THRESH   = 2.0

# ═══════════════════════════════════════════════════════
# GROUP 11 — Cross-Asset (original signals)
# ═══════════════════════════════════════════════════════
CORR_WINDOW             = 20
CORR_VELOCITY_DAYS      = 5
CORR_VELOCITY_THRESH    = 0.10

# --- Composite: N signals active ---
COMPOSITE_MIN_SIGNALS = 3

# ═══════════════════════════════════════════════════════
# Tickers
# ═══════════════════════════════════════════════════════
YF_TICKERS = {
    # Core market
    "SPY":   "SPY",
    "QQQ":   "QQQ",
    "AGG":   "AGG",
    "RSP":   "RSP",
    # Volatility
    "VIX":   "^VIX",
    "VIX9D": "^VIX9D",
    "VIX3M": "^VIX3M",
    # Bonds / rates
    "TLT":   "TLT",
    "IEF":   "IEF",
    "HYG":   "HYG",
    "LQD":   "LQD",
    "TNX":   "^TNX",   # 10Y yield
    "IRX":   "^IRX",   # 13-week T-bill
    # FX / safe haven
    "GLD":   "GLD",
    "UUP":   "UUP",
    # Sector ETFs (for regime)
    "XLK":   "XLK",
    "XLF":   "XLF",
    "XLV":   "XLV",
    "XLE":   "XLE",
    "XLI":   "XLI",
    "XLY":   "XLY",
    "XLP":   "XLP",
    "XLRE":  "XLRE",
    "XLU":   "XLU",
    "XLB":   "XLB",
    "XLC":   "XLC",
}

FRED_SERIES = {
    "HY_SPREAD":   "BAMLH0A0HYM2",    # US HY OAS
    "IG_SPREAD":   "BAMLC0A0CM",      # US IG OAS
    "EM_HY":       "BAMLHE00EHY0D",   # EM HY OAS
    "STL_FSI":     "STLFSI4",         # St. Louis Stress Index (weekly)
    "NFCI":        "NFCI",            # Chicago Financial Conditions (weekly)
    "YC_10Y2Y":    "T10Y2Y",          # 10Y-2Y spread (daily)
    "YC_10Y3M":    "T10Y3M",          # 10Y-3M spread (daily)
    "SOFR":        "SOFR",
    "EFFR":        "EFFR",
}

SECTOR_ETFS = ["XLK", "XLF", "XLV", "XLE", "XLI", "XLY", "XLP", "XLRE", "XLU", "XLB", "XLC"]
