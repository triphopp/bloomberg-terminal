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

What each group IS — GICS for the US sectors, the fund for a theme, the SET's
own industry groups and sectors for Thailand — lives in sector_membership.py,
and the drill-down (/constituents) lists the members that definition names.
"""
from __future__ import annotations

import threading
import time
from typing import Any, Optional

import pandas as pd
import requests
import yfinance as yf
from fastapi import APIRouter, Query

import sector_membership as sm

router = APIRouter(prefix="/api/rotation", tags=["rotation"])

# ── Universe ──────────────────────────────────────────────────────────────────

# "Information Technology (XLK)" — the GICS sector's own name, then its SPDR.
SECTORS = [(f"{name} ({etf})", etf) for _, name, etf in sm.GICS_SECTORS]

# name → ETF proxy (labels audited against each fund 2026-10-23)
THEMES = [(label, etf) for label, etf, _ in sm.THEMES]

_DEFAULT_BENCH = "SPY"

# ── Thai market — the SET's own industry groups and sectors. Yahoo carries none
# of the SET's sector indices, so each group is a cap-weighted basket of its
# largest members (≥80% of the group's market cap, ≤10 names), benchmarked vs
# ^SET.BK. The drill-down lists every member.
TH_BENCH = "^SET.BK"
# Yahoo intermittently serves ^SET.BK with a single bar (2026-09-24: 1 row for
# period=9mo), which leaves every TH quadrant blank. TDEX.BK is the SET50 ETF
# in THB — the closest tradable stand-in, and it has full history.
TH_BENCH_FALLBACK = "TDEX.BK"

_cache: dict[str, tuple[float, Any]] = {}
_lock = threading.Lock()
_TTL = 900  # 15 min — rotation moves slowly
_HOLDINGS_TTL = 86400  # ETF holdings change slowly — 1 day
_HOLDINGS_FAIL_TTL = 1800  # a failed holdings fetch is not retried for 30 min
_EMPTY_TTL = 120  # an empty drill-down is kept 2 min so a dead group can't hammer Yahoo
#: A drill-down prices at most this many members (largest first); the rest are
#: listed with their weight and no returns.
PRICED_MAX = 100


def _th_groups() -> list[dict]:
    """Every SET industry group and sector with members, in the SET's order.

    {id, name, kind (industry|sector), industry, members, basket, coverage}
    """
    snap = sm.load_set_snapshot()
    out = []
    for ind, ind_name in sm.SET_INDUSTRIES.items():
        members = sm.set_members(ind, snap)
        if members:
            basket = sm.index_basket(members)
            out.append({"id": ind, "name": ind_name, "kind": "industry", "industry": ind,
                        "members": members, "basket": basket,
                        "coverage": sm.coverage_pct(basket, members)})
        for sec, (sec_ind, sec_name) in sm.SET_SECTORS.items():
            if sec_ind != ind:
                continue
            members = sm.set_members(sec, snap)
            if not members:
                continue  # MINE has no listed company today
            basket = sm.index_basket(members)
            out.append({"id": sec, "name": sec_name, "kind": "sector", "industry": ind,
                        "members": members, "basket": basket,
                        "coverage": sm.coverage_pct(basket, members)})
    return out


def _th_index(closes: pd.DataFrame, group: dict) -> Optional[pd.Series]:
    caps = {sm.th_yahoo(m["symbol"]): m["cap"] for m in group["basket"]}
    return sm.cap_weighted_index(closes, caps)


def _th_basket_symbols(groups: list[dict]) -> list[str]:
    return sorted({sm.th_yahoo(m["symbol"]) for g in groups for m in g["basket"]})


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


def _last(close: pd.Series) -> Optional[float]:
    s = close.dropna()
    return float(s.iloc[-1]) if len(s) else None


def _download_closes(symbols: list[str]) -> pd.DataFrame:
    raw = yf.download(
        sorted(set(symbols)), period="9mo", interval="1d",
        auto_adjust=True, progress=False, threads=4,  # was one thread per ticker; see tail_risk._yf_download
    )
    return raw["Close"] if isinstance(raw.columns, pd.MultiIndex) else raw


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
        "price": _last(close) if kind == "stock" else None,
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
        "definition": {
            "standard": "GICS sectors (Select Sector SPDRs) · themes = their ETF",
            "source": "https://www.ssga.com/us/en/intermediary/etfs/fund-finder",
            "membership_as_of": None,
            "method": "each row is its ETF's own price",
        },
    }


def _build_table_th() -> dict:
    groups = _th_groups()
    closes = _download_closes(_th_basket_symbols(groups) + [TH_BENCH, TH_BENCH_FALLBACK])
    bench_sym, bench = _th_bench(closes)
    if bench is None:
        return {"rows": [], "bench": TH_BENCH, "error": "benchmark data unavailable"}
    bench_m1 = _pct(bench, 21)
    rows = []
    for g in groups:
        row = _row_from_series(g["name"], g["id"], g["kind"], _th_index(closes, g), bench,
                               bench_m1, n_members=len(g["members"]))
        if row:
            row["industry"] = g["industry"]
            row["basket_n"] = len(g["basket"])
            row["coverage_pct"] = g["coverage"]
            rows.append(row)
    rows.sort(key=lambda r: r["m1"] if r["m1"] is not None else -999, reverse=True)
    snap = sm.load_set_snapshot()
    return {
        "rows": rows,
        "bench": bench_sym,
        "bench_m1": bench_m1,
        "as_of": str(closes.index[-1].date()) if len(closes.index) else None,
        "definition": {
            "standard": "SET industry groups / sectors",
            "source": snap["source"],
            "membership_as_of": snap["as_of"],
            "method": "cap-weighted basket of each group's largest members (≥80% of its market cap, "
                      "≤10 names); the SET's own sector indices are not on Yahoo",
        },
        # Every SET symbol → its SET sector, so a holding is placed by the
        # exchange's classification rather than by the label typed on its trade.
        "symbol_sector": {m["symbol"]: m["sector"] for m in snap["members"]},
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
# Sectors only: 11 SPDRs vs the US benchmark, or the SET's 8 industry groups vs
# SET (its 27 sectors stay on the table — 27 trails make the plot unreadable,
# as 26 more theme trails would on the US side).

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
        groups = [g for g in _th_groups() if g["kind"] == "industry"]
        closes = _download_closes(_th_basket_symbols(groups) + [TH_BENCH, TH_BENCH_FALLBACK])
        found, bench = _th_bench(closes)
        bench_sym = found or TH_BENCH
        universe = [(g["name"], g["id"], g["id"], _th_index(closes, g)) for g in groups]
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
# Every member the group's definition names, with its weight in the group, its
# name, and the same returns / quadrant the table ranks groups by:
#   US sector (SPDR) + KBE/XHB/XRT  every holding, State Street's daily file
#   other US themes                 Yahoo's top-10 holdings (coverage says so)
#   TH industry group / sector      the SET's composition (reference_data/)

def _cached(key: str, ttl: float):
    with _lock:
        hit = _cache.get(key)
    return hit[1] if hit and time.time() - hit[0] < ttl else None


def _ssga_holdings(etf: str) -> Optional[dict]:
    """State Street's full holdings for one fund, or None (negative-cached)."""
    key = f"ssga|{etf}"
    hit = _cached(key, _HOLDINGS_TTL)
    if hit is not None:
        return hit or None
    if _cached(f"ssga-fail|{etf}", _HOLDINGS_FAIL_TTL) is not None:
        return None
    url = sm.SSGA_URL.format(t=etf.lower())
    try:
        r = requests.get(url, timeout=20, headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
        parsed = sm.parse_ssga_holdings(r.content)
        if not parsed["rows"]:
            raise ValueError("no holdings in file")
        parsed["url"] = url
    except Exception:
        with _lock:
            _cache[f"ssga-fail|{etf}"] = (time.time(), True)
        return None
    with _lock:
        _cache[key] = (time.time(), parsed)
    return parsed


def _yahoo_top_holdings(etf: str) -> Optional[list[dict]]:
    """Yahoo's top-10 holdings [{ticker, name, weight%}], or None (negative-cached)."""
    key = f"yhold|{etf}"
    hit = _cached(key, _HOLDINGS_TTL)
    if hit is not None:
        return hit or None
    rows: list[dict] = []
    try:
        top = yf.Ticker(etf).funds_data.top_holdings
        for sym, rec in top.head(10).iterrows():
            s = str(sym).strip().upper()
            if not s:
                continue
            w = rec.get("Holding Percent")
            rows.append({"ticker": s, "name": str(rec.get("Name") or s).strip(),
                         "weight": round(float(w) * 100, 4) if pd.notna(w) else None})
    except Exception:
        rows = []
    with _lock:  # an empty list is the negative cache: retried after a day, not per click
        _cache[key] = (time.time() if rows else time.time() - (_HOLDINGS_TTL - _HOLDINGS_FAIL_TTL), rows)
    return rows or None


def _us_members(etf: str) -> tuple[list[dict], dict]:
    """(members [{symbol, yf_symbol, name, weight}], group meta) for a US row."""
    gics = sm.GICS_BY_ETF.get(etf)
    theme = sm.THEME_BY_ETF.get(etf)
    if gics:
        group = {"id": etf, "name": gics[1], "kind": "sector",
                 "definition": f"GICS {gics[0]} {gics[1]} — the S&P 500 members in that sector, "
                               f"as held by {etf} (Select Sector SPDR, capped market-cap weights)"}
    elif theme:
        group = {"id": etf, "name": theme[0], "kind": "theme",
                 "definition": f"Theme = what {etf} holds: {theme[1]}"}
    else:
        return [], {}
    held = _ssga_holdings(etf) if etf in sm.SSGA_FUNDS else None
    if held:
        members = [{"symbol": h["ticker"], "yf_symbol": sm.us_yahoo(h["ticker"]),
                    "name": h["name"], "weight": h["weight"]} for h in held["rows"]]
        group["source"] = {"label": "State Street daily holdings", "url": held["url"],
                           "as_of": held["as_of"], "coverage": "all",
                           "weight_basis": "% of fund"}
        return members, group
    top = _yahoo_top_holdings(etf)
    if not top:
        return [], group
    members = [{"symbol": h["ticker"], "yf_symbol": sm.us_yahoo(h["ticker"]),
                "name": h["name"], "weight": h["weight"]} for h in top]
    group["source"] = {"label": "Yahoo Finance top holdings (Morningstar)",
                       "url": f"https://finance.yahoo.com/quote/{etf}/holdings/",
                       "as_of": None, "coverage": "top10",
                       "weight_basis": "% of fund"}
    if etf in sm.SSGA_FUNDS:
        group["source"]["note"] = "State Street file unavailable — showing Yahoo's top 10"
    return members, group


def _th_members(group_id: str) -> tuple[list[dict], dict]:
    g = next((x for x in _th_groups() if x["id"] == group_id), None)
    if g is None:
        return [], {}
    snap = sm.load_set_snapshot()
    total = sum(m["cap"] for m in g["members"]) or None
    members = [{"symbol": m["symbol"], "yf_symbol": sm.th_yahoo(m["symbol"]), "name": m["name"],
                "sector": m["sector"],
                "weight": round(100 * m["cap"] / total, 4) if total else None,
                "market_cap": m["cap"] * 1e6 if m["cap"] > 0 else None,
                "in_basket": any(b["symbol"] == m["symbol"] for b in g["basket"])}
               for m in g["members"]]
    what = "industry group" if g["kind"] == "industry" else "sector"
    group = {"id": g["id"], "name": g["name"], "kind": g["kind"], "industry": g["industry"],
             "definition": f"SET {what} {g['id']} ({g['name']}) — every SET-listed company the "
                           f"exchange classifies there",
             "source": {"label": "SET sector composition", "url": snap["source"],
                        "as_of": snap["as_of"], "coverage": "all",
                        "weight_basis": "% of group market cap"},
             "basket": {"n": len(g["basket"]), "coverage_pct": g["coverage"]}}
    return members, group


def _build_constituents(mkt: str, group_id: str) -> dict:
    members, group = _th_members(group_id) if mkt == "TH" else _us_members(group_id.upper())
    if not group:
        return {"id": group_id, "market": mkt, "rows": [], "error": "unknown group"}
    if not members:
        return {"id": group_id, "market": mkt, "group": group, "rows": [],
                "error": "no constituents found"}
    members.sort(key=lambda m: -(m["weight"] or 0))
    priced = members[:PRICED_MAX]
    bench_sym = TH_BENCH if mkt == "TH" else _DEFAULT_BENCH
    extra = [TH_BENCH_FALLBACK] if mkt == "TH" else []
    closes = _download_closes([m["yf_symbol"] for m in priced] + [bench_sym] + extra)
    if mkt == "TH":
        found, th = _th_bench(closes)
        bench_sym = found or bench_sym
        bench = th if th is not None else pd.Series(dtype=float)
    else:
        bench = closes[bench_sym].dropna() if bench_sym in closes.columns else pd.Series(dtype=float)
    bench_m1 = _pct(bench, 21) if not bench.empty else None
    rows = []
    for i, m in enumerate(members):
        row = None
        if i < PRICED_MAX and m["yf_symbol"] in closes.columns:
            row = _row_from_series(m["name"], m["yf_symbol"], "stock",
                                   closes[m["yf_symbol"]].dropna(), bench, bench_m1)
        row = row or {"name": m["name"], "id": m["yf_symbol"], "kind": "stock", "n_members": None,
                      "price": None, "d1": None, "w1": None, "m1": None, "m3": None,
                      "m1_vs_bench": None, "quadrant": None, "mom_dir": None}
        row.update({"symbol": m["symbol"], "yf_symbol": m["yf_symbol"], "weight": m["weight"],
                    "market_cap": m.get("market_cap"), "sector": m.get("sector"),
                    "in_basket": m.get("in_basket"), "priced": row["m1"] is not None or row["d1"] is not None})
        rows.append(row)
    group["source"]["n_total"] = len(members)
    group["source"]["n_priced"] = sum(1 for r in rows if r["priced"])
    return {
        "id": group_id, "market": mkt, "bench": bench_sym, "bench_m1": bench_m1,
        "as_of": str(closes.index[-1].date()) if len(closes.index) else None,
        "currency": "THB" if mkt == "TH" else "USD",
        "group": group, "rows": rows,
    }


@router.get("/constituents")
def rotation_constituents(
    id: str = Query(..., min_length=1, max_length=40),
    market: str = Query("US", pattern="^(US|TH|us|th)$"),
):
    mkt = market.upper()
    gid = id.strip() if mkt == "TH" else id.strip().upper()
    cache_key = f"cons|{mkt}|{gid}"
    hit = _cached(cache_key, _TTL)
    if hit is not None:
        return hit
    val = _build_constituents(mkt, gid)
    with _lock:
        # Kept even when empty — for 2 min, not 15 — so a group whose source is
        # down does not re-fire Yahoo / State Street on every click.
        _cache[cache_key] = (time.time() if val["rows"] else time.time() - (_TTL - _EMPTY_TTL), val)
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


# ── Screen: one group's members ranked by four factors (sector_screen.py) ────

@router.get("/screen")
def rotation_screen(
    group: str = Query(..., min_length=1, max_length=60,
                       description="ROT group id (XLE, SMH, FINCIAL) or a word of its name"),
    market: str = Query("US", pattern="^(US|TH|us|th)$"),
    top: int = Query(15, ge=3, le=40, description="Largest members by weight"),
):
    import sector_screen

    mkt = market.upper()
    rows = (rotation_table(bench=_DEFAULT_BENCH, market=mkt).get("rows") or [])
    needle = group.strip().lower()
    found = [r for r in rows if str(r.get("id", "")).lower() == needle] or \
            [r for r in rows if needle in str(r.get("name", "")).lower()]
    if not found:
        return {"market": mkt, "group": None, "rows": [],
                "error": f"no {mkt} ROT group matches '{group.strip()}' — groups: "
                         + ", ".join(f"{r.get('id')} ({r.get('name')})" for r in rows)}
    out = sector_screen.build(mkt, found[0]["id"], top)
    if out.get("group"):
        out["group"] = {**out["group"], "name": found[0]["name"], "quadrant": found[0].get("quadrant")}
    return out
