"""
Layer C — Structural Position (FRED Z.1 Flow of Funds).

Household equity share = corporate equities & mutual fund shares /
                         total financial assets.
Z-score vs 1990-present distribution. Contrarian signal.

References:
  Shiller (1981) — Do Stock Prices Move Too Much?
  Campbell & Shiller (1988) — The Dividend-Price Ratio
  Federal Reserve Z.1 Financial Accounts of the United States
"""
import csv
import io
from statistics import mean, stdev
from typing import Any

import requests

from config import FRED_API_KEY, FRED_JSON_URL, FRED_CSV_URL

# Z.1 Flow of Funds — Household sector
# FL153064476.Q = Corporate Equities + Mutual Fund Shares held by Households & Nonprofits
# FL152090005.Q = Total Financial Assets of Households & Nonprofits
# Note: FRED series IDs use "BOGZ1" prefix in older docs; current API uses "FL" prefix.
# We try both prefixes.
FRED_EQUITY_HOLDINGS = "FL153064476.Q"   # or BOGZ1FL153064476Q
FRED_TOTAL_ASSETS     = "FL152090005.Q"   # or BOGZ1FL152090005Q

# Fallback series IDs with older prefix
_FALLBACK_SERIES = {
    FRED_EQUITY_HOLDINGS: "BOGZ1FL153064476Q",
    FRED_TOTAL_ASSETS:     "BOGZ1FL152090005Q",
}

# How stale can the data be before we set score = 0 (in months)
MAX_STALENESS_MONTHS = 6


def _fetch_fred_series(series_id: str) -> list[dict]:
    """Fetch a FRED series. JSON API first, CSV fallback. Returns newest-first."""
    if FRED_API_KEY:
        try:
            r = requests.get(
                FRED_JSON_URL,
                params={"series_id": series_id, "api_key": FRED_API_KEY,
                        "file_type": "json", "sort_order": "desc", "limit": 200},
                timeout=10,
                headers={"User-Agent": "Mozilla/5.0"},
            )
            if r.ok:
                rows = []
                for obs in r.json().get("observations", []):
                    v = obs.get("value", ".")
                    if v in (".", ""):
                        continue
                    try:
                        rows.append({"date": obs["date"], "raw": float(v)})
                    except ValueError:
                        continue
                if rows:
                    return rows
        except Exception:
            pass

    # CSV fallback
    try:
        r = requests.get(f"{FRED_CSV_URL}?id={series_id}", timeout=10,
                         headers={"User-Agent": "Mozilla/5.0"})
        if r.ok:
            rows = []
            reader = csv.reader(io.StringIO(r.text))
            next(reader)  # skip header
            for row in reader:
                if len(row) < 2 or row[1].strip() in (".", ""):
                    continue
                try:
                    rows.append({"date": row[0], "raw": float(row[1])})
                except ValueError:
                    continue
            rows.sort(key=lambda x: x["date"], reverse=True)
            return rows
    except Exception:
        pass

    return []


def compute_layer_c() -> dict:
    """
    Compute Layer C structural score from FRED Z.1 Flow of Funds.

    Returns:
        {
            "score": int {-1, 0, +1},
            "z_score": float,
            "equity_share": float,
            "mu_C": float, "sigma_C": float,
            "latest_quarter": str,
            "freshness": str,
        }
    """
    # Fetch equity holdings series
    eq_rows = _fetch_fred_series(FRED_EQUITY_HOLDINGS)
    if not eq_rows:
        # Try fallback series ID
        eq_rows = _fetch_fred_series(_FALLBACK_SERIES[FRED_EQUITY_HOLDINGS])

    # Fetch total assets series
    ta_rows = _fetch_fred_series(FRED_TOTAL_ASSETS)
    if not ta_rows:
        ta_rows = _fetch_fred_series(_FALLBACK_SERIES[FRED_TOTAL_ASSETS])

    if not eq_rows or not ta_rows:
        return {"score": 0, "z_score": 0.0, "equity_share": 0.0,
                "mu_C": 0.0, "sigma_C": 0.0, "latest_quarter": "",
                "freshness": "unavailable",
                "error": "FRED data unavailable for Z.1 series"}

    # Build date-indexed dicts for alignment
    eq_map: dict[str, float] = {}
    for r in eq_rows:
        eq_map[r["date"]] = r["raw"]

    ta_map: dict[str, float] = {}
    for r in ta_rows:
        ta_map[r["date"]] = r["raw"]

    # Compute equity_share for each quarter where both series have data
    shares: list[dict] = []
    for date in sorted(eq_map.keys()):
        if date in ta_map and ta_map[date] > 0:
            shares.append({
                "date": date,
                "value": eq_map[date] / ta_map[date],
            })

    if not shares:
        return {"score": 0, "z_score": 0.0, "equity_share": 0.0,
                "mu_C": 0.0, "sigma_C": 0.0, "latest_quarter": "",
                "freshness": "no_overlapping_data",
                "error": "no overlapping equity/total-asset data points"}

    # Latest value
    latest = shares[-1]
    latest_date = latest["date"]
    equity_share = latest["value"]

    # Check staleness
    from datetime import datetime, timedelta
    try:
        # FRED dates are YYYY-MM-DD; quarter-end is e.g. 2025-12-31
        latest_dt = datetime.strptime(latest_date, "%Y-%m-%d")
        months_ago = (datetime.utcnow() - latest_dt).days / 30.44
        if months_ago > MAX_STALENESS_MONTHS:
            return {"score": 0, "z_score": 0.0, "equity_share": round(equity_share, 6),
                    "mu_C": 0.0, "sigma_C": 0.0, "latest_quarter": latest_date,
                    "freshness": f"stale ({months_ago:.0f}mo)",
                    "error": f"data stale: {months_ago:.0f} months since last observation"}
    except ValueError:
        months_ago = 999

    # Compute historical mean/std from all observations
    values = [s["value"] for s in shares]
    if len(values) < 4:
        return {"score": 0, "z_score": 0.0, "equity_share": round(equity_share, 6),
                "mu_C": 0.0, "sigma_C": 0.0, "latest_quarter": latest_date,
                "freshness": f"Q{latest_date}",
                "error": "insufficient history (< 4 quarters)"}

    mu_C = mean(values)
    sigma_C = stdev(values)

    if sigma_C < 1e-8:
        z_C = 0.0
    else:
        z_C = float((equity_share - mu_C) / sigma_C)

    # Score: contrarian — high equity share = overextended = bearish
    if z_C > 0.75:
        score = -1
    elif z_C < -0.75:
        score = 1
    else:
        score = 0

    # Freshness label
    try:
        dt = datetime.strptime(latest_date, "%Y-%m-%d")
        freshness = f"Q{(dt.month - 1) // 3 + 1}-{dt.year}"
    except Exception:
        freshness = latest_date

    return {
        "score": score,
        "z_score": round(z_C, 6),
        "equity_share": round(equity_share, 6),
        "mu_C": round(mu_C, 6),
        "sigma_C": round(sigma_C, 6),
        "latest_quarter": latest_date,
        "freshness": freshness,
    }
