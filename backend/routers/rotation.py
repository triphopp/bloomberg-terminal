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
# Yahoo intermittently serves ^SET.BK with a single bar (2026-09-24: 1 row for
# period=9mo), which leaves every TH quadrant blank. TDEX.BK is the SET50 ETF
# in THB — the closest tradable stand-in, and it has full history.
TH_BENCH_FALLBACK = "TDEX.BK"
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

def _rrg_frame(close: pd.Series, bench: pd.Series) -> Optional[pd.DataFrame]:
    """Weekly RS-Ratio / RS-Mom, oldest first. None when history is too short.

    The table's quadrant and the map's trail both read this, so a sector can
    never sit in one quadrant on the table and another on the map.
    """
    try:
        df = pd.concat([close, bench], axis=1, keys=["c", "b"]).dropna()
        if len(df) < 70:  # need ~14 weeks of dailies
            return None
        weekly = df.resample("W-FRI").last()
        # Label each week by its last real session, not the bin's Friday — a
        # Thursday print would otherwise be dated tomorrow.
        weekly.index = df.index.to_series().resample("W-FRI").last()
        weekly = weekly.dropna()
        rs = weekly["c"] / weekly["b"]
        ratio = 100 * rs / rs.rolling(8).mean()
        mom = 100 * ratio / ratio.rolling(4).mean()
        out = pd.DataFrame({"ratio": ratio, "mom": mom}).dropna()
        return out if not out.empty else None
    except Exception:
        return None


def _quadrant(ratio: float, mom: float) -> str:
    if ratio >= 100 and mom >= 100:
        return "Leading"
    if ratio < 100 and mom >= 100:
        return "Improving"
    if ratio >= 100:
        return "Weakening"
    return "Lagging"


def _rrg_state(close: pd.Series, bench: pd.Series) -> tuple[Optional[str], Optional[str]]:
    """Returns (quadrant_label, momentum_direction up|down) or (None, None)."""
    frame = _rrg_frame(close, bench)
    if frame is None:
        return None, None
    ratio_now = float(frame["ratio"].iloc[-1])
    mom_now = float(frame["mom"].iloc[-1])
    prev = float(frame["mom"].iloc[-2]) if len(frame) >= 2 else mom_now
    return _quadrant(ratio_now, mom_now), ("up" if mom_now >= prev else "down")


def _rrg_trail(close: pd.Series, bench: pd.Series, tail: int) -> list[dict]:
    """Last `tail` weekly (RS-Ratio, RS-Mom) points, oldest first."""
    frame = _rrg_frame(close, bench)
    if frame is None:
        return []
    return [
        {"date": str(ts.date()), "ratio": round(float(r), 3), "mom": round(float(m), 3)}
        for ts, r, m in zip(frame.index[-tail:], frame["ratio"].iloc[-tail:], frame["mom"].iloc[-tail:])
    ]


def _th_bench(closes: pd.DataFrame) -> tuple[Optional[str], Optional[pd.Series]]:
    """^SET.BK when its history is usable, else the SET50 ETF."""
    for sym in (TH_BENCH, TH_BENCH_FALLBACK):
        if sym in closes.columns:
            s = closes[sym].dropna()
            if len(s) >= 70:
                return sym, s
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
        auto_adjust=True, progress=False, threads=4,  # was one thread per ticker; see tail_risk._yf_download
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
    closes = _download_closes(all_members + [TH_BENCH, TH_BENCH_FALLBACK])
    bench_sym, bench = _th_bench(closes)
    if bench is None:
        return {"rows": [], "bench": TH_BENCH, "error": "benchmark data unavailable"}
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
        "bench": bench_sym,
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


# ── Rotation map (RRG plot) ───────────────────────────────────────────────────
# Sectors only: 11 SPDRs vs the US benchmark, or the TH equal-weight groups vs
# SET. Themes stay on the table — 26 more trails make the plot unreadable.

def _map_entry(name: str, row_id: str, symbol: str, close: Optional[pd.Series],
               bench: pd.Series, tail: int) -> Optional[dict]:
    if close is None or close.empty:
        return None
    points = _rrg_trail(close, bench, tail)
    if not points:
        return None
    last = points[-1]
    return {
        "id": row_id,
        "name": name,
        "symbol": symbol,
        "quadrant": _quadrant(last["ratio"], last["mom"]),
        "points": points,
    }


def _build_map(market: str, bench_sym: str, tail: int) -> dict:
    if market == "TH":
        closes = _download_closes(
            [m for _, ms in TH_GROUPS for m in ms] + [TH_BENCH, TH_BENCH_FALLBACK]
        )
        found, bench = _th_bench(closes)
        bench_sym = found or TH_BENCH
        universe = [(n, n, n, _ew_index(closes, ms)) for n, ms in TH_GROUPS]
    else:
        closes = _download_closes([s for _, s in SECTORS] + [bench_sym])
        bench = closes[bench_sym].dropna() if bench_sym in closes.columns else None
        universe = [
            (n, s, s, closes[s].dropna() if s in closes.columns else None) for n, s in SECTORS
        ]
    if bench is None or bench.empty:
        return {"rows": [], "bench": bench_sym, "market": market,
                "error": "benchmark data unavailable"}
    rows = [e for e in (_map_entry(n, i, s, c, bench, tail) for n, i, s, c in universe) if e]
    return {
        "rows": rows,
        "expected": len(universe),
        "bench": bench_sym,
        "market": market,
        "tail": tail,
        "as_of": str(closes.index[-1].date()) if len(closes.index) else None,
        "method": "RS = close / bench (weekly, W-FRI); RS-Ratio = 100·RS/SMA8(RS); "
                  "RS-Mom = 100·RS-Ratio/SMA4(RS-Ratio). JdK-style approximation, not the licensed RRG.",
    }


@router.get("/map")
def rotation_map(
    bench: str = Query(_DEFAULT_BENCH, min_length=1, max_length=10),
    market: str = Query("US", pattern="^(US|TH|us|th)$"),
    tail: int = Query(8, ge=2, le=20),
):
    mkt = market.upper()
    bench_sym = TH_BENCH if mkt == "TH" else bench.strip().upper()
    key = f"map|{mkt}|{bench_sym}|{tail}"
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < _TTL:
            return hit[1]
    val = _build_map(mkt, bench_sym, tail)
    with _lock:
        if val.get("rows"):  # don't pin an empty result for 15 min
            # A sector missing from one Yahoo batch is usually transient: keep
            # the partial map for 2 min instead of 15, but still cache it so a
            # dead ticker can't re-fire the download on every request.
            full = len(val["rows"]) >= val.get("expected", 0)
            _cache[key] = (now if full else now - (_TTL - 120), val)
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

    extra = [TH_BENCH_FALLBACK] if mkt == "TH" else []
    closes = _download_closes(members + [bench_sym] + extra)
    if mkt == "TH":
        found, th = _th_bench(closes)
        bench_sym = found or bench_sym
        bench = th if th is not None else pd.Series(dtype=float)
    else:
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


# ── Sector tilt — where the turnover is going, and the AUM record behind it ───
# The honest name for this is ROTATION, not FLOW. Every buy is a sale, so a
# share of dollar volume says where the market's attention is concentrated, not
# that money entered a sector on net. Real flow is creation/redemption, which
# needs the AUM series this app records for itself (backend/etf_aum.py) — the
# panel reports it as soon as two days exist and says how young the record is
# until then.
#
# Everything is a SHARE OF THE COMPLEX, never a raw number: XLK is ~$121bn
# against XLB's ~$9bn, so absolute dollar volume would show the same three
# funds every day. And every share is z-scored against its own trailing year,
# because "+20bp" means something different for a fund that normally holds 25%
# of the complex than for one that holds 3%.

#: Defensive = the four sectors people buy to stay invested while de-risking.
#: Cyclical = the ones that need the expansion to continue. XLE is in NEITHER:
#: it trades on crude, which can rise in exactly the risk-off tape that sends
#: money into XLU, and folding it into either bucket would make the tilt read
#: the oil price as sentiment.
DEFENSIVE = ("XLP", "XLU", "XLV", "XLRE")
CYCLICAL = ("XLK", "XLY", "XLI", "XLF", "XLB", "XLC")
UNALIGNED = ("XLE",)

_SECTOR_NAME = {sym: name.split(" (")[0] for name, sym in SECTORS}
SECTOR_ETFS_ORDER = tuple(sym for _, sym in SECTORS)

#: A tilt smaller than this is noise in the turnover data rather than a move.
TILT_BAND_BP = 10.0


def _download_ohlcv(symbols: list[str], period: str = "2y") -> tuple[pd.DataFrame, pd.DataFrame]:
    """(closes, volumes) for the symbols, aligned on one index."""
    raw = yf.download(
        sorted(set(symbols)), period=period, interval="1d",
        auto_adjust=True, progress=False, threads=4,  # was one thread per ticker; see tail_risk._yf_download
    )
    if isinstance(raw.columns, pd.MultiIndex):
        return raw["Close"], raw["Volume"]
    return raw[["Close"]], raw[["Volume"]]


def _z_last(series: pd.Series, lookback: int = 252) -> Optional[float]:
    s = series.dropna().iloc[-lookback:]
    if len(s) < 60:
        return None
    mean = float(s.mean())
    sd = float(s.std())
    # A share that never moved has an sd of ~1e-17 rather than 0 — the mean and
    # the values do not cancel exactly in floating point — and dividing by that
    # turns a flat series into a confident ±1σ reading. The floor is relative to
    # the level being scored, because these are fractions of 1, not prices.
    if not (sd > max(abs(mean), 1e-12) * 1e-9):
        return None
    return round((float(s.iloc[-1]) - mean) / sd, 2)


def _window_delta_bp(series: pd.Series, window: int) -> Optional[float]:
    """Change in a share between this window and the one before it, in bp."""
    s = series.dropna()
    if len(s) < window + 1:
        return None
    return round((float(s.iloc[-1]) - float(s.iloc[-1 - window])) * 10_000, 1)


def _delta_z(series: pd.Series, window: int) -> Optional[float]:
    """z of the CHANGE, not of the level.

    The level of a sector's turnover share is nearly constant — XLK is always
    around a tenth of the complex — so z-scoring it answers "is this sector big
    today", which nobody asked. The question the panel poses is "is this much
    movement unusual", and that is the distribution of the same window's change
    over the trailing year.
    """
    return _z_last(series.diff(window))


def _build_tilt(window: int) -> dict:
    syms = list(SECTOR_ETFS_ORDER)
    closes, volumes = _download_ohlcv(syms + [_DEFAULT_BENCH])
    have = [s for s in syms if s in closes.columns and s in volumes.columns]
    if len(have) < 6 or _DEFAULT_BENCH not in closes.columns:
        return {"rows": [], "error": "sector data unavailable"}

    dollar_vol = (closes[have] * volumes[have]).dropna(how="all")
    total = dollar_vol.sum(axis=1)
    share = dollar_vol.div(total.where(total > 0), axis=0)
    share_w = share.rolling(window).mean()

    bench = closes[_DEFAULT_BENCH].dropna()
    bench_ret = None
    if len(bench) > window:
        bench_ret = float(bench.iloc[-1]) / float(bench.iloc[-1 - window]) - 1

    rows = []
    for sym in have:
        bucket = (
            "defensive" if sym in DEFENSIVE
            else "cyclical" if sym in CYCLICAL
            else "unaligned"
        )
        c = closes[sym].dropna()
        rel_bp = None
        if bench_ret is not None and len(c) > window:
            own = float(c.iloc[-1]) / float(c.iloc[-1 - window]) - 1
            rel_bp = round((own - bench_ret) * 10_000, 0)
        quad, mom_dir = _rrg_state(c, bench)
        rows.append({
            "symbol": sym,
            "name": _SECTOR_NAME.get(sym, sym),
            "bucket": bucket,
            "share_pct": round(float(share_w[sym].dropna().iloc[-1]) * 100, 2)
            if not share_w[sym].dropna().empty else None,
            "delta_bp": _window_delta_bp(share_w[sym], window),
            "z": _delta_z(share_w[sym], window),
            "rel_return_bp": rel_bp,
            "quadrant": quad,
            "mom_dir": mom_dir,
        })
    rows.sort(key=lambda r: r["delta_bp"] if r["delta_bp"] is not None else -1e9, reverse=True)

    # The tilt is one series, not a sum of two numbers: defensive share minus
    # cyclical share, rolled and z-scored like any other. Built that way it has
    # its own history, so "+34bp" can be read against how far this book's tape
    # normally swings rather than against zero.
    def_cols = [s for s in have if s in DEFENSIVE]
    cyc_cols = [s for s in have if s in CYCLICAL]
    tilt_bp = tilt_z = None
    if def_cols and cyc_cols:
        tilt_series = (share[def_cols].sum(axis=1) - share[cyc_cols].sum(axis=1)).rolling(window).mean()
        tilt_bp = _window_delta_bp(tilt_series, window)
        tilt_z = _delta_z(tilt_series, window)
    if tilt_bp is None:
        state, tone = None, "unknown"
    elif tilt_bp > TILT_BAND_BP:
        state, tone = "DEFENSIVE", "bad"
    elif tilt_bp < -TILT_BAND_BP:
        state, tone = "CYCLICAL", "good"
    else:
        state, tone = "BALANCED", "watch"

    quads = {"Leading": 0, "Improving": 0, "Weakening": 0, "Lagging": 0}
    for r in rows:
        if r["quadrant"] in quads:
            quads[r["quadrant"]] += 1
    above = sum(1 for r in rows if (r["rel_return_bp"] or 0) > 0)

    # The AUM leg. Reading it also records today's row, which is the only way
    # the series ever gets longer — see etf_aum.capture_async.
    aum: dict = {"available": False}
    try:
        import etf_aum
        etf_aum.capture_async()
        aum = etf_aum.flows(window=window)
        aum["coverage"] = etf_aum.coverage()
    except Exception:
        aum = {"available": False, "error": "aum record unavailable"}

    return {
        "as_of": str(closes.index[-1].date()) if len(closes.index) else None,
        "window_days": window,
        "bench": _DEFAULT_BENCH,
        "basis": "turnover_share",
        "basis_note": "ส่วนแบ่งมูลค่าซื้อขายของทั้งกลุ่ม ไม่ใช่เงินเข้าออกกองจริง",
        "tilt": {
            "state": state, "tone": tone, "bp": tilt_bp, "z": tilt_z,
            "band_bp": TILT_BAND_BP,
            "rule": f"defensive share − cyclical share, เฉลี่ย {window} วัน, "
                    f"เทียบกับหน้าต่างก่อนหน้า; |Δ| < {TILT_BAND_BP}bp = balanced",
            "defensive": list(def_cols), "cyclical": list(cyc_cols),
            "unaligned": [s for s in have if s in UNALIGNED],
        },
        "rows": rows,
        "quadrants": quads,
        "breadth": {"above_bench": above, "total": len(rows)},
        "aum": aum,
        "counted_in_composite": False,
        "validated": False,
    }


@router.get("/tilt")
def rotation_tilt(window: int = Query(20, ge=5, le=90)):
    """US sector rotation: share of complex turnover, z-scored, plus the tilt."""
    key = f"tilt|{window}"
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < _TTL:
            return hit[1]
    val = _build_tilt(window)
    with _lock:
        if val.get("rows"):
            _cache[key] = (now, val)
    return val
