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

# ── Thai market — no liquid theme ETFs on Yahoo, so sector groups are
# equal-weight baskets of liquid representatives, benchmarked vs ^SET.BK.
TH_BENCH = "^SET.BK"
TH_GROUPS: list[tuple[str, list[str]]] = [
    ("Banking",        ["KBANK.BK", "BBL.BK", "SCB.BK", "KTB.BK", "TTB.BK"]),
    ("Energy & Util",  ["PTT.BK", "PTTEP.BK", "GULF.BK", "TOP.BK", "BGRIM.BK"]),
    ("Petrochem",      ["PTTGC.BK", "IVL.BK", "SCGP.BK"]),
    ("ICT",            ["ADVANC.BK", "TRUE.BK", "INTUCH.BK"]),
    ("Commerce",       ["CPALL.BK", "CPAXT.BK", "CRC.BK", "HMPRO.BK", "BJC.BK"]),
    ("Food & Bev",     ["CPF.BK", "TU.BK", "MINT.BK", "OSP.BK", "CBG.BK"]),
    ("Healthcare",     ["BDMS.BK", "BH.BK", "BCH.BK", "CHG.BK"]),
    ("Property",       ["LH.BK", "AP.BK", "SPALI.BK", "SIRI.BK"]),
    ("Transport",      ["AOT.BK", "BEM.BK", "BTS.BK"]),
    ("Electronics",    ["DELTA.BK", "HANA.BK", "KCE.BK"]),
    ("Finance (non-bank)", ["MTC.BK", "SAWAD.BK", "TIDLOR.BK", "KTC.BK"]),
    ("Tourism",        ["AWC.BK", "CENTEL.BK", "ERW.BK"]),
    ("Construction Mat", ["SCC.BK", "TPIPL.BK", "TASCO.BK"]),
]

_cache: dict[str, tuple[float, Any]] = {}
_lock = threading.Lock()
_TTL = 900  # 15 min — rotation moves slowly
_HOLDINGS_TTL = 86400  # ETF top-holdings change slowly — 1 day


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


def _download_closes(symbols: list[str]) -> pd.DataFrame:
    raw = yf.download(
        sorted(set(symbols)), period="9mo", interval="1d",
        auto_adjust=True, progress=False, threads=True,
    )
    return raw["Close"] if isinstance(raw.columns, pd.MultiIndex) else raw


def _ew_index(closes: pd.DataFrame, members: list[str]) -> Optional[pd.Series]:
    """Equal-weight basket index: each member rebased to 1.0, then averaged."""
    cols = [m for m in members if m in closes.columns]
    if not cols:
        return None
    sub = closes[cols].dropna(how="all")
    rebased = []
    for c in cols:
        s = sub[c].dropna()
        if len(s) < 10 or s.iloc[0] <= 0:
            continue
        rebased.append(s / s.iloc[0])
    if not rebased:
        return None
    return pd.concat(rebased, axis=1).mean(axis=1).dropna()


def _row_from_series(name: str, row_id: str, kind: str, close: pd.Series,
                     bench: pd.Series, bench_m1: Optional[float],
                     n_members: Optional[int] = None) -> Optional[dict]:
    if close is None or close.empty:
        return None
    m1 = _pct(close, 21)
    quad, mom_dir = _rrg_state(close, bench)
    return {
        "name": name,
        "id": row_id,
        "symbol": row_id,
        "kind": kind,
        "n_members": n_members,
        "d1": _pct(close, 1),
        "w1": _pct(close, 5),
        "m1": m1,
        "m3": _pct(close, 63),
        "m1_vs_bench": round(m1 - bench_m1, 2) if m1 is not None and bench_m1 is not None else None,
        "quadrant": quad,
        "mom_dir": mom_dir,
    }


def _build_table_us(bench_sym: str) -> dict:
    universe = [(n, s, "theme") for n, s in THEMES] + \
               [(n, s, "sector") for n, s in SECTORS]
    closes = _download_closes([s for _, s, _ in universe] + [bench_sym])
    if bench_sym not in closes.columns:
        return {"rows": [], "bench": bench_sym, "error": "benchmark data unavailable"}
    bench = closes[bench_sym].dropna()
    bench_m1 = _pct(bench, 21)
    rows = []
    for name, sym, kind in universe:
        if sym not in closes.columns:
            continue
        row = _row_from_series(name, sym, kind, closes[sym].dropna(), bench, bench_m1)
        if row:
            rows.append(row)
    rows.sort(key=lambda r: r["m1"] if r["m1"] is not None else -999, reverse=True)
    return {
        "rows": rows,
        "bench": bench_sym,
        "bench_m1": bench_m1,
        "as_of": str(closes.index[-1].date()) if len(closes.index) else None,
    }


def _build_table_th() -> dict:
    all_members = [m for _, members in TH_GROUPS for m in members]
    closes = _download_closes(all_members + [TH_BENCH])
    if TH_BENCH not in closes.columns:
        return {"rows": [], "bench": TH_BENCH, "error": "benchmark data unavailable"}
    bench = closes[TH_BENCH].dropna()
    bench_m1 = _pct(bench, 21)
    rows = []
    for name, members in TH_GROUPS:
        ew = _ew_index(closes, members)
        row = _row_from_series(name, name, "sector", ew, bench, bench_m1,
                               n_members=len([m for m in members if m in closes.columns]))
        if row:
            rows.append(row)
    rows.sort(key=lambda r: r["m1"] if r["m1"] is not None else -999, reverse=True)
    return {
        "rows": rows,
        "bench": TH_BENCH,
        "bench_m1": bench_m1,
        "as_of": str(closes.index[-1].date()) if len(closes.index) else None,
    }


@router.get("/table")
def rotation_table(
    bench: str = Query(_DEFAULT_BENCH, min_length=1, max_length=10),
    market: str = Query("US", pattern="^(US|TH|us|th)$"),
):
    mkt = market.upper()
    bench_sym = TH_BENCH if mkt == "TH" else bench.strip().upper()
    key = f"table|{mkt}|{bench_sym}"
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < _TTL:
            return hit[1]
    val = _build_table_th() if mkt == "TH" else _build_table_us(bench_sym)
    val["market"] = mkt
    with _lock:
        if val.get("rows"):  # don't pin an empty result for 15 min
            _cache[key] = (now, val)
    return val


# ── Constituents drill-down ───────────────────────────────────────────────────
# US themes/sectors: top-10 holdings of the proxy ETF (yfinance funds_data).
# TH groups: the basket members themselves.

def _etf_top_holdings(etf: str) -> list[str]:
    key = f"holdings|{etf}"
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < _HOLDINGS_TTL:
            return hit[1]
    syms: list[str] = []
    try:
        top = yf.Ticker(etf).funds_data.top_holdings
        syms = [str(s).strip().upper() for s in list(top.index)[:10] if str(s).strip()]
    except Exception:
        syms = []
    with _lock:
        if syms:
            _cache[key] = (now, syms)
    return syms


@router.get("/constituents")
def rotation_constituents(
    id: str = Query(..., min_length=1, max_length=40),
    market: str = Query("US", pattern="^(US|TH|us|th)$"),
):
    mkt = market.upper()
    cache_key = f"cons|{mkt}|{id}"
    now = time.time()
    with _lock:
        hit = _cache.get(cache_key)
        if hit and now - hit[0] < _TTL:
            return hit[1]

    if mkt == "TH":
        members = next((m for n, m in TH_GROUPS if n == id), [])
        bench_sym = TH_BENCH
    else:
        members = _etf_top_holdings(id.upper())
        bench_sym = _DEFAULT_BENCH
    if not members:
        return {"id": id, "market": mkt, "rows": [], "error": "no constituents found"}

    closes = _download_closes(members + [bench_sym])
    bench = closes[bench_sym].dropna() if bench_sym in closes.columns else pd.Series(dtype=float)
    bench_m1 = _pct(bench, 21) if not bench.empty else None
    rows = []
    for sym in members:
        if sym not in closes.columns:
            continue
        row = _row_from_series(sym, sym, "stock", closes[sym].dropna(), bench, bench_m1)
        if row:
            rows.append(row)
    rows.sort(key=lambda r: r["m1"] if r["m1"] is not None else -999, reverse=True)
    val = {"id": id, "market": mkt, "bench": bench_sym, "rows": rows}
    with _lock:
        if rows:
            _cache[cache_key] = (now, val)
    return val
