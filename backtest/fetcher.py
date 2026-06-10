"""
Data fetcher: yfinance + FRED (direct HTTP, no fredapi package needed).
"""
import os
import sys
import time
import requests
import pandas as pd
import yfinance as yf
from dotenv import load_dotenv
from config import YF_TICKERS, FRED_SERIES

load_dotenv(os.path.join(os.path.dirname(__file__), "..", "backend", ".env"))
FRED_KEY = os.getenv("FRED_API_KEY", "")


# ─── yfinance ────────────────────────────────────────────────────────────────

def fetch_yf(start: str, end: str) -> dict[str, pd.DataFrame]:
    """Download OHLCV for all configured tickers. Returns dict name→DataFrame."""
    data: dict[str, pd.DataFrame] = {}
    for name, ticker in YF_TICKERS.items():
        try:
            df = yf.download(
                ticker, start=start, end=end,
                auto_adjust=True, progress=False,
            )
            if df.empty:
                print(f"  [warn] {ticker} returned empty", file=sys.stderr)
                continue
            # yfinance ≥1.0 may return MultiIndex columns when downloading single ticker
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.get_level_values(0)
            data[name] = df
        except Exception as exc:
            print(f"  [warn] {ticker} failed: {exc}", file=sys.stderr)
    return data


# ─── FRED ─────────────────────────────────────────────────────────────────────

_FRED_URL = "https://api.stlouisfed.org/fred/series/observations"

def fetch_fred(start: str, end: str) -> dict[str, pd.Series]:
    """Fetch configured FRED series. Returns dict name→Series (float, daily index)."""
    if not FRED_KEY:
        print("  [warn] FRED_API_KEY missing — FRED signals disabled", file=sys.stderr)
        return {}

    result: dict[str, pd.Series] = {}
    for name, series_id in FRED_SERIES.items():
        try:
            # Don't force frequency — weekly series (NFCI, STLFSI4) reject frequency=d
            # Let FRED return native frequency; caller forward-fills to daily index
            r = requests.get(_FRED_URL, params={
                "series_id": series_id,
                "api_key": FRED_KEY,
                "observation_start": start,
                "observation_end": end,
                "file_type": "json",
            }, timeout=15)
            r.raise_for_status()
            obs = r.json().get("observations", [])
            s = pd.Series(
                {pd.Timestamp(o["date"]): float(o["value"])
                 for o in obs if o["value"] != "."},
                name=name,
            )
            result[name] = s
            time.sleep(0.3)  # polite rate limit
        except Exception as exc:
            print(f"  [warn] FRED {series_id} failed: {exc}", file=sys.stderr)
    return result


# ─── Helpers ──────────────────────────────────────────────────────────────────

def close(data: dict, name: str) -> pd.Series:
    """Extract Close series from yf DataFrame, or return empty Series."""
    df = data.get(name)
    if df is None or df.empty:
        return pd.Series(dtype=float, name=name)
    col = "Close" if "Close" in df.columns else df.columns[3]
    return df[col].rename(name)


def volume(data: dict, name: str) -> pd.Series:
    df = data.get(name)
    if df is None or df.empty:
        return pd.Series(dtype=float, name=name)
    return df["Volume"].rename(f"{name}_vol")


def align(*series: pd.Series) -> pd.DataFrame:
    """Align multiple series on a common daily date index (forward-fill max 3 days)."""
    df = pd.concat(series, axis=1)
    df = df.ffill(limit=3)
    return df.dropna(how="all")
