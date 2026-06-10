"""
Country Equity Rotation Signal — 3-layer cross-sectional scoring.

Layer M — Momentum (12M-1M + 6M + 3M composite, cross-sectional z-score)
Layer Q — Macro Quality (GDP growth 3Y MA + Current Account, from World Bank)
Layer C — Carry (dividend yield, cross-sectional z-score)

References:
  Jegadeesh & Titman (1993) — Returns to Buying Winners
  Asness, Moskowitz & Pedersen (2013) — Value and Momentum Everywhere
  Brightman & Li (2016) — Sense and Nonsense of Country Rotation
  Koijen, Moskowitz, Pedersen & Vrugt (2018) — Carry
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from statistics import mean, stdev
from typing import Any

import numpy as np
import requests

from sources import market_data

# ── Universe ───────────────────────────────────────────────────────────────────

COUNTRY_UNIVERSE = [
    {"ticker": "SPY",  "country": "United States",   "region": "Americas", "type": "single"},
    {"ticker": "VGK",  "country": "Europe",           "region": "EMEA",     "type": "single"},
    {"ticker": "EWJ",  "country": "Japan",            "region": "Asia",     "type": "single"},
    {"ticker": "INDA", "country": "India",            "region": "Asia",     "type": "single"},
    {"ticker": "FXI",  "country": "China",            "region": "Asia",     "type": "single"},
    {"ticker": "EWZ",  "country": "Brazil",           "region": "Americas", "type": "single"},
    {"ticker": "EWC",  "country": "Canada",           "region": "Americas", "type": "single"},
    {"ticker": "EWT",  "country": "Taiwan",           "region": "Asia",     "type": "single"},
    {"ticker": "EWY",  "country": "South Korea",      "region": "Asia",     "type": "single"},
    {"ticker": "EWA",  "country": "Australia",        "region": "Asia",     "type": "single"},
    {"ticker": "THD",  "country": "Thailand",         "region": "Asia",     "type": "single"},
    {"ticker": "EFA",  "country": "Developed ex-US",  "region": "Global",  "type": "regional"},
    {"ticker": "EEM",  "country": "Emerging Markets", "region": "Global",  "type": "regional"},
    {"ticker": "AAXJ", "country": "Asia ex-Japan",    "region": "Asia",    "type": "regional"},
]

# World Bank country code mapping (regional ETFs have no WB code)
WB_COUNTRY_MAP = {
    "SPY": "US", "EWJ": "JP", "INDA": "IN", "FXI": "CN",
    "EWZ": "BR", "EWC": "CA", "EWT": "TW", "EWY": "KR",
    "EWA": "AU", "THD": "TH",
    # VGK, EFA, EEM, AAXJ — regional, no single WB code
}

# Layer weights
LAYER_WEIGHTS = {"M": 0.50, "Q": 0.30, "C": 0.20}

# World Bank API
WB_BASE = "https://api.worldbank.org/v2/country"
WB_GDP_GROWTH    = "NY.GDP.MKTP.KD.ZG"   # GDP growth (% YoY)
WB_CURRENT_ACCT  = "BN.CAB.XOKA.GD.ZS"   # Current account (% GDP)

# Classification thresholds
CLASS_THRESHOLDS = [
    (0.60,  "STRONG_OVERWEIGHT"),
    (0.25,  "OVERWEIGHT"),
    (-0.25, "NEUTRAL"),
    (-0.60, "UNDERWEIGHT"),
]


# ── Helper: cross-sectional z-score ────────────────────────────────────────────

def _cross_sectional_z(values: dict[str, float], clamp_window: float = 2.0) -> dict[str, float]:
    """Compute cross-sectional z-score for each ticker. Winsorize at ±clamp_window σ."""
    val_list = list(values.values())
    if len(val_list) < 2:
        return {t: 0.0 for t in values}
    mu = mean(val_list)
    sigma = stdev(val_list)
    if sigma < 1e-8:
        return {t: 0.0 for t in values}
    result = {}
    for ticker, v in values.items():
        z = (v - mu) / sigma
        result[ticker] = max(-clamp_window, min(clamp_window, z))
    return result


def _classify(score: float) -> str:
    for threshold, label in CLASS_THRESHOLDS:
        if score >= threshold:
            return label
    return "STRONG_UNDERWEIGHT"


# ── Layer M: Cross-Sectional Momentum ──────────────────────────────────────────

def compute_momentum() -> dict[str, dict]:
    """
    Compute momentum composite for each ETF.
    12M-1M (weight 0.50) + 6M (0.30) + 3M (0.20).
    Cross-sectional z-score vs universe.
    """
    momentum_raw: dict[str, float] = {}
    momentum_details: dict[str, dict] = {}

    for entry in COUNTRY_UNIVERSE:
        ticker = entry["ticker"]
        try:
            frame = market_data.get_history(ticker, period="2y", interval="1d")
            # get_history() now returns OHLCVFrame — extract .df
            df = frame.df if frame is not None else None
            if df is None or df.empty:
                momentum_details[ticker] = {"error": "no data"}
                continue

            closes = df["Close"].dropna().values
            if len(closes) < 252:
                momentum_details[ticker] = {"error": f"insufficient history ({len(closes)}d)"}
                continue

            # Monthly returns (approximate: 21 trading days per month)
            current = closes[-1]
            m1  = closes[-21]   if len(closes) > 21   else closes[0]
            m3  = closes[-63]   if len(closes) > 63   else closes[0]
            m6  = closes[-126]  if len(closes) > 126  else closes[0]
            m13 = closes[-273]  if len(closes) > 273  else closes[0]

            r_12m_1m = float(current / m1 - 1)   if m1 > 0  else 0.0
            r_6m     = float(current / m6 - 1)   if m6 > 0  else 0.0
            r_3m     = float(current / m3 - 1)   if m3 > 0  else 0.0

            composite = 0.50 * r_12m_1m + 0.30 * r_6m + 0.20 * r_3m
            momentum_raw[ticker] = composite
            momentum_details[ticker] = {
                "momentum_12m_1m": round(r_12m_1m, 6),
                "momentum_6m":     round(r_6m, 6),
                "momentum_3m":     round(r_3m, 6),
                "composite":       round(composite, 6),
            }
        except Exception as e:
            momentum_details[ticker] = {"error": str(e)}

    if not momentum_raw:
        return {}

    z_scores = _cross_sectional_z(momentum_raw)

    for ticker in momentum_details:
        if ticker in z_scores:
            momentum_details[ticker]["z_score"] = round(z_scores[ticker], 4)
        else:
            momentum_details[ticker]["z_score"] = 0.0

    return momentum_details


# ── Layer Q: Macro Quality (World Bank) ────────────────────────────────────────

def _fetch_wb_indicator(country_code: str, indicator_id: str) -> dict | None:
    """Fetch a World Bank indicator for one country."""
    try:
        url = f"{WB_BASE}/{country_code}/indicator/{indicator_id}"
        r = requests.get(url, params={"format": "json", "mrv": 5, "per_page": 5}, timeout=8)
        if not r.ok:
            return None
        payload = r.json()
        if not payload or len(payload) < 2 or not payload[1]:
            return None
        rows = sorted(payload[1], key=lambda x: x.get("date", ""), reverse=True)
        series = []
        latest = None
        for row in rows:
            v = row.get("value")
            if v is not None:
                entry = {"value": round(float(v), 3), "year": row["date"]}
                series.append(entry)
                if latest is None:
                    latest = entry
        if latest is None:
            return None
        return {"value": latest["value"], "year": latest["year"], "series": series}
    except Exception:
        return None


def compute_macro_quality() -> dict[str, dict]:
    """
    Compute macro quality per country.
    GDP growth 3Y moving average + current account balance.
    """
    macro_details: dict[str, dict] = {}
    macro_raw: dict[str, float] = {}

    def fetch_country(ticker: str, wb_code: str):
        gdp_data = _fetch_wb_indicator(wb_code, WB_GDP_GROWTH)
        ca_data  = _fetch_wb_indicator(wb_code, WB_CURRENT_ACCT)
        return ticker, gdp_data, ca_data

    # Fetch in parallel
    fetch_tasks = [(t, WB_COUNTRY_MAP[t]) for t in WB_COUNTRY_MAP]
    results = {}
    with ThreadPoolExecutor(max_workers=min(len(fetch_tasks), 8)) as pool:
        futures = {pool.submit(fetch_country, t, c): t for t, c in fetch_tasks}
        for fut in futures:
            ticker, gdp_data, ca_data = fut.result()
            results[ticker] = (gdp_data, ca_data)

    # Compute GDP 3Y MA
    gdp_3y_ma: dict[str, float] = {}
    ca_values: dict[str, float] = {}

    for ticker, (gdp_data, ca_data) in results.items():
        detail: dict = {}
        gdp_vals = []
        if gdp_data and gdp_data.get("series"):
            detail["gdp_growth_latest"] = gdp_data["value"]
            detail["gdp_year"] = gdp_data["year"]
            for pt in gdp_data["series"][:3]:
                gdp_vals.append(pt["value"])
            if gdp_vals:
                gdp_3y_ma[ticker] = mean(gdp_vals)
                detail["gdp_growth_3y_ma"] = round(gdp_3y_ma[ticker], 3)
        else:
            detail["gdp_growth_latest"] = None

        if ca_data:
            detail["current_account"] = ca_data["value"]
            detail["current_account_year"] = ca_data["year"]
            ca_values[ticker] = ca_data["value"]
        else:
            detail["current_account"] = None

        macro_details[ticker] = detail

    if not gdp_3y_ma:
        return {}

    # Cross-sectional z-scores
    gdp_z = _cross_sectional_z(gdp_3y_ma)
    ca_z = _cross_sectional_z(ca_values) if ca_values else {t: 0.0 for t in gdp_3y_ma}

    for ticker in macro_details:
        gz = gdp_z.get(ticker, 0.0)
        cz = ca_z.get(ticker, 0.0)
        raw_q = 0.60 * gz + 0.40 * cz
        macro_raw[ticker] = raw_q
        macro_details[ticker]["gdp_z"] = round(gz, 4)
        macro_details[ticker]["current_account_z"] = round(cz, 4)
        macro_details[ticker]["q_raw"] = round(raw_q, 4)

    # Second pass: cross-sectional z of raw_q
    q_z = _cross_sectional_z(macro_raw)
    for ticker in macro_details:
        macro_details[ticker]["z_score"] = round(q_z.get(ticker, 0.0), 4)

    return macro_details


# ── Layer C: Carry (Dividend Yield) ────────────────────────────────────────────

def compute_carry() -> dict[str, dict]:
    """Compute carry score from dividend yield per ETF. Cross-sectional z-score."""
    yields: dict[str, float] = {}
    carry_details: dict[str, dict] = {}

    def fetch_div_yield(entry: dict):
        ticker = entry["ticker"]
        try:
            info = market_data.get_info(ticker)
            div_yield = info.get("dividendYield")
            if div_yield is not None:
                val = float(div_yield)
                # yfinance returns decimal (0.0129) for some ETFs, percentage (1.29) for others.
                # Normalize: if > 0.5 it's already in percentage form → convert to decimal.
                if val > 0.5:
                    val = val / 100.0
                return ticker, val
        except Exception:
            pass
        # Fallback: trailing 12M dividend / current price
        try:
            frame = market_data.get_history(ticker, period="1y", interval="1d")
            # get_history() now returns OHLCVFrame — extract .df
            df = frame.df if frame is not None else None
            if df is not None and not df.empty:
                if "Dividends" in df.columns:
                    ttm_div = float(df["Dividends"].tail(252).sum())
                    price = float(df["Close"].iloc[-1])
                    if price > 0 and ttm_div > 0:
                        val = ttm_div / price
                        if val > 0.5:
                            val = val / 100.0
                        return ticker, val
        except Exception:
            pass
        return ticker, None

    with ThreadPoolExecutor(max_workers=len(COUNTRY_UNIVERSE)) as pool:
        future_results = pool.map(fetch_div_yield, COUNTRY_UNIVERSE)
        for ticker, val in future_results:
            if val is not None and val > 0:
                yields[ticker] = val
                carry_details[ticker] = {"dividend_yield": round(val, 6)}
            else:
                carry_details[ticker] = {"dividend_yield": None}

    if not yields:
        return carry_details

    # Cross-sectional z-score (higher yield = better)
    z_scores = _cross_sectional_z(yields)
    for ticker in carry_details:
        z = z_scores.get(ticker, 0.0)
        carry_details[ticker]["z_score"] = round(z, 4)

    return carry_details


# ── Composite Scoring ──────────────────────────────────────────────────────────

def compute_rotation_scores(
    momentum: dict[str, dict],
    macro: dict[str, dict],
    carry: dict[str, dict],
) -> list[dict]:
    """Combine 3 layers → ranked output with classification."""
    scored = []

    for entry in COUNTRY_UNIVERSE:
        ticker = entry["ticker"]
        m_z = momentum.get(ticker, {}).get("z_score", 0.0) if ticker in momentum else 0.0
        q_z = macro.get(ticker, {}).get("z_score", 0.0) if ticker in macro else 0.0
        c_z = carry.get(ticker, {}).get("z_score", 0.0) if ticker in carry else 0.0

        # Regional ETFs: no macro data → weight shifts to M + C
        if entry["type"] == "regional":
            rotation_score = 0.70 * m_z + 0.30 * c_z
        else:
            rotation_score = (
                LAYER_WEIGHTS["M"] * m_z +
                LAYER_WEIGHTS["Q"] * q_z +
                LAYER_WEIGHTS["C"] * c_z
            )

        scored.append({
            "ticker": ticker,
            "country": entry["country"],
            "region": entry["region"],
            "type": entry["type"],
            "rotation_score": round(rotation_score, 4),
            "classification": _classify(rotation_score),
            "layers": {
                "M": {
                    "score": round(m_z, 4),
                    "momentum_12m_1m": momentum.get(ticker, {}).get("momentum_12m_1m"),
                    "momentum_6m":     momentum.get(ticker, {}).get("momentum_6m"),
                    "momentum_3m":     momentum.get(ticker, {}).get("momentum_3m"),
                },
                "Q": {
                    "score": round(q_z, 4),
                    "gdp_growth_3y_ma": macro.get(ticker, {}).get("gdp_growth_3y_ma"),
                    "current_account":  macro.get(ticker, {}).get("current_account"),
                },
                "C": {
                    "score": round(c_z, 4),
                    "dividend_yield": carry.get(ticker, {}).get("dividend_yield"),
                },
            },
        })

    # Sort by rotation_score descending
    scored.sort(key=lambda x: x["rotation_score"], reverse=True)
    for i, item in enumerate(scored):
        item["rank"] = i + 1

    return scored
