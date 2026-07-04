"""
Theme / Sector Rotation — momentum table vs benchmark (default SPY).

GET /api/rotation/table?bench=SPY

One row per theme (ETF proxy) or SPDR sector: returns over 1D/1W/1M/3M,
1M relative to the benchmark, and an RRG-style quadrant classification
(Leading / Improving / Weakening / Lagging) computed from weekly relative
strength — plus the momentum direction so the table carries the useful part
of a Relative Rotation Graph without the plot.

Theme exposure uses liquid ETF proxies (not equal-weight baskets) — cheap,
one batch download, good-enough approximation for rotation monitoring.
"""
from __future__ import annotations

import threading
import time
from typing import Any, Optional

import pandas as pd
import yfinance as yf
from fastapi import APIRouter, Query

router = APIRouter(prefix="/api/rotation", tags=["rotation"])

# ── Universe ──────────────────────────────────────────────────────────────────

SECTORS = [
    ("Technology (XLK)",     "XLK"),
    ("Financials (XLF)",     "XLF"),
    ("Health Care (XLV)",    "XLV"),
    ("Energy (XLE)",         "XLE"),
    ("Industrials (XLI)",    "XLI"),
    ("Cons Discret (XLY)",   "XLY"),
    ("Cons Staples (XLP)",   "XLP"),
    ("Real Estate (XLRE)",   "XLRE"),
    ("Utilities (XLU)",      "XLU"),
    ("Materials (XLB)",      "XLB"),
    ("Comm Svcs (XLC)",      "XLC"),
]

# name → ETF proxy
THEMES = [
    ("Genomics",           "ARKG"),
    ("Biotech",            "IBB"),
    ("Pharma",             "PPH"),
    ("Fintech & Payments", "FINX"),
    ("Travel & Airlines",  "JETS"),
    ("Homebuilders",       "XHB"),
    ("Defense",            "ITA"),
    ("Cybersecurity",      "CIBR"),
    ("Banks & Brokers",    "KBE"),
    ("Semiconductors",     "SMH"),
    ("Software",           "IGV"),
    ("AI & Robotics",      "BOTZ"),
    ("Cloud",              "SKYY"),
    ("Quantum",            "QTUM"),
    ("Solar",              "TAN"),
    ("Space",              "ARKX"),
    ("Gold Miners",        "GDX"),
    ("Nuclear & Uranium",  "URA"),
    ("China Tech",         "KWEB"),
    ("Crypto-linked",      "BITQ"),
    ("Mag 7",              "MAGS"),
    ("Oil Services",       "OIH"),
    ("Retail",             "XRT"),
    ("Innovation (ARKK)",  "ARKK"),
]

_DEFAULT_BENCH = "SPY"

_cache: dict[str, tuple[float, Any]] = {}
_lock = threading.Lock()
_TTL = 900  # 15 min — rotation moves slowly


# ── RRG quadrant from weekly relative strength ────────────────────────────────
# JdK-style approximation:
#   RS       = close / bench_close          (daily → resampled W-FRI)
#   RS-Ratio = 100 * RS / SMA(RS, 8w)
#   RS-Mom   = 100 * RS-Ratio / SMA(RS-Ratio, 4w)
# Quadrant: ratio≥100 & mom≥100 Leading · ratio<100 & mom≥100 Improving
#           ratio≥100 & mom<100 Weakening · both<100 Lagging

def _rrg_state(close: pd.Series, bench: pd.Series) -> tuple[Optional[str], Optional[str]]:
    """Returns (quadrant_label, momentum_direction up|down) or (None, None)."""
    try:
        df = pd.concat([close, bench], axis=1, keys=["c", "b"]).dropna()
        if len(df) < 70:  # need ~14 weeks of dailies
            return None, None
        weekly = df.resample("W-FRI").last().dropna()
        rs = weekly["c"] / weekly["b"]
        ratio = 100 * rs / rs.rolling(8).mean()
        mom = 100 * ratio / ratio.rolling(4).mean()
        ratio_now = float(ratio.iloc[-1])
        mom_now = float(mom.iloc[-1])
        if pd.isna(ratio_now) or pd.isna(mom_now):
            return None, None
        if ratio_now >= 100 and mom_now >= 100:
            quad = "Leading"
        elif ratio_now < 100 and mom_now >= 100:
            quad = "Improving"
        elif ratio_now >= 100:
            quad = "Weakening"
        else:
            quad = "Lagging"
        prev = mom.iloc[-2] if len(mom) >= 2 and not pd.isna(mom.iloc[-2]) else mom_now
        return quad, ("up" if mom_now >= float(prev) else "down")
    except Exception:
        return None, None


def _pct(close: pd.Series, days: int) -> Optional[float]:
    try:
        if len(close) <= days:
            return None
        prev = float(close.iloc[-1 - days])
        last = float(close.iloc[-1])
        if prev <= 0:
            return None
        return round((last / prev - 1) * 100, 2)
    except Exception:
        return None


def _build_table(bench_sym: str) -> dict:
    universe = [(n, s, "theme") for n, s in THEMES] + \
               [(n, s, "sector") for n, s in SECTORS]
    symbols = sorted({s for _, s, _ in universe} | {bench_sym})
    raw = yf.download(
        symbols, period="9mo", interval="1d",
        auto_adjust=True, progress=False, threads=True,
    )
    closes = raw["Close"] if isinstance(raw.columns, pd.MultiIndex) else raw
    if bench_sym not in closes.columns:
        return {"rows": [], "bench": bench_sym, "error": "benchmark data unavailable"}
    bench = closes[bench_sym].dropna()
    bench_m1 = _pct(bench, 21)

    rows = []
    for name, sym, kind in universe:
        if sym not in closes.columns:
            continue
        close = closes[sym].dropna()
        if close.empty:
            continue
        m1 = _pct(close, 21)
        quad, mom_dir = _rrg_state(close, bench)
        rows.append({
            "name": name,
            "symbol": sym,
            "kind": kind,
            "d1": _pct(close, 1),
            "w1": _pct(close, 5),
            "m1": m1,
            "m3": _pct(close, 63),
            "m1_vs_bench": round(m1 - bench_m1, 2) if m1 is not None and bench_m1 is not None else None,
            "quadrant": quad,
            "mom_dir": mom_dir,
        })
    rows.sort(key=lambda r: r["m1"] if r["m1"] is not None else -999, reverse=True)
    return {
        "rows": rows,
        "bench": bench_sym,
        "bench_m1": bench_m1,
        "as_of": str(closes.index[-1].date()) if len(closes.index) else None,
    }


@router.get("/table")
def rotation_table(bench: str = Query(_DEFAULT_BENCH, min_length=1, max_length=10)):
    bench_sym = bench.strip().upper()
    key = f"table|{bench_sym}"
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < _TTL:
            return hit[1]
    val = _build_table(bench_sym)
    with _lock:
        if val.get("rows"):  # don't pin an empty result for 15 min
            _cache[key] = (now, val)
    return val
