"""
Sector screen — the members of one ROT group ranked by four standard factors,
measured against each other inside the group (sector-neutral), with the market's
state (CNN Fear & Greed, VIX, MOVE) choosing which pre-set weights apply.

    momentum   12-1 month return (Jegadeesh & Titman 1993)
    quality    ROE, ROA, gross margin, low debt/equity (Novy-Marx 2013; Asness et al. QMJ)
    value      earnings yield, EBITDA/EV, book/price (Fama & French 1992)
    low_vol    1-year daily volatility, lower is better (Frazzini & Pedersen BAB)

Each raw number becomes a percentile among the group's members (0 = worst,
100 = best); a factor is the mean of its parts that exist; the score is the
weighted mean of the factors a stock has, and `coverage` says how many that was.

The market's state does NOT rank stocks — it is the same number for all of them.
It picks the weights (`WEIGHTS`), set on RULES_SET and not tuned to results:
stress cuts momentum (it crashes after declines in high volatility — Daniel &
Moskowitz 2016) and leans on quality and low volatility. Factor timing has weaker
evidence than the factors themselves; the response says so. What does differ by
stock is how it moves with VIX and MOVE (`beta_vix`, `beta_move`: daily return on
the index's daily % change, one year) — flagged, never removed.

A screen, not advice: the rows are an ordering by the rules above.
"""
from __future__ import annotations

import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Optional

import numpy as np
import pandas as pd
import yfinance as yf

RULES_SET = "2026-10-23"

WEIGHTS: dict[str, dict[str, float]] = {
    "normal": {"momentum": 0.25, "quality": 0.25, "value": 0.25, "low_vol": 0.25},
    "stress": {"momentum": 0.15, "quality": 0.35, "value": 0.20, "low_vol": 0.30},
    "greed":  {"momentum": 0.20, "quality": 0.30, "value": 0.30, "low_vol": 0.20},
}

#: Pre-set regime rule. VIX / MOVE by their own 1-year percentile; F&G on its 0–100 scale.
STRESS_PCT = 80
GREED_FG, FEAR_FG = 75, 25
CALM_VIX_PCT = 30
RULE_TEXT = (f"stress if VIX or MOVE ≥ p{STRESS_PCT} of the last year, or F&G ≤ {FEAR_FG}; "
             f"greed if F&G ≥ {GREED_FG} and VIX ≤ p{CALM_VIX_PCT}; else normal")

#: A factor is only ranked when this many members have it.
MIN_RANKED = 3
#: A row needs this many factors to be in the top list.
MIN_COVERAGE = 3
#: |beta| percentile within the group above which a stress-day sensitivity is flagged.
SENSITIVE_PCT = 80

_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()
_TTL = 1800


# ── Pure parts (tested without network) ──────────────────────────────────────

def pct_rank(values: dict[str, Optional[float]], higher_is_better: bool = True) -> dict[str, Optional[float]]:
    """Percentile (0–100) of each value among the ones that exist; ties share the mean rank."""
    have = {k: v for k, v in values.items() if v is not None and math.isfinite(v)}
    out: dict[str, Optional[float]] = {k: None for k in values}
    if len(have) < MIN_RANKED:
        return out
    s = pd.Series(have)
    r = s.rank(method="average", ascending=higher_is_better)
    n = len(s)
    for k, v in r.items():
        out[k] = round((v - 1) / (n - 1) * 100, 1)
    return out


def regime(vix_pct: Optional[float], move_pct: Optional[float], fg: Optional[float]) -> str:
    if (vix_pct is not None and vix_pct >= STRESS_PCT) or (move_pct is not None and move_pct >= STRESS_PCT) \
            or (fg is not None and fg <= FEAR_FG):
        return "stress"
    if fg is not None and fg >= GREED_FG and (vix_pct is None or vix_pct <= CALM_VIX_PCT):
        return "greed"
    return "normal"


def series_pct(s: pd.Series) -> Optional[float]:
    """Where the last value sits in the series (0–100)."""
    s = s.dropna()
    if len(s) < 20:
        return None
    return round(float((s < s.iloc[-1]).mean() * 100), 1)


def momentum_12_1(close: pd.Series) -> Optional[float]:
    c = close.dropna()
    if len(c) < 252:
        return None
    return float(c.iloc[-22] / c.iloc[-252] - 1)


def vol_1y(close: pd.Series) -> Optional[float]:
    r = close.dropna().pct_change(fill_method=None).dropna().iloc[-252:]
    return float(r.std() * math.sqrt(252)) if len(r) >= 120 else None


def beta(close: pd.Series, index: pd.Series) -> Optional[float]:
    """Daily stock return on the index's daily % change, last year."""
    df = pd.concat([close.pct_change(fill_method=None), index.pct_change(fill_method=None)], axis=1, keys=["s", "i"]).dropna().iloc[-252:]
    if len(df) < 120 or df["i"].var() == 0:
        return None
    return float(np.cov(df["s"], df["i"])[0, 1] / df["i"].var())


def _inv(x: Optional[float]) -> Optional[float]:
    return 1 / x if isinstance(x, (int, float)) and x > 0 else None


def fundamentals_raw(ratios: dict) -> dict[str, Optional[float]]:
    p, lev, val = ratios.get("profitability") or {}, ratios.get("leverage") or {}, ratios.get("valuation") or {}
    pe = val.get("trailingPE") or val.get("forwardPE")
    return {
        "roe": p.get("returnOnEquity"),
        "roa": p.get("returnOnAssets"),
        "gross_margin": p.get("grossMargins"),
        "debt_to_equity": lev.get("debtToEquity"),
        "earnings_yield": _inv(pe),
        "ebitda_to_ev": _inv(val.get("enterpriseToEbitda")),
        "book_to_price": _inv(val.get("priceToBook")),
    }


#: factor → [(raw field, higher is better)]
PARTS = {
    "momentum": [("mom_12_1", True)],
    "quality": [("roe", True), ("roa", True), ("gross_margin", True), ("debt_to_equity", False)],
    "value": [("earnings_yield", True), ("ebitda_to_ev", True), ("book_to_price", True)],
    "low_vol": [("vol_1y", False)],
}


#: Groups of lenders and insurers: gross margin and debt/equity describe a bank's
#: funding, not its quality, so quality is ROE and ROA alone there.
FINANCIAL_GROUPS = frozenset({"XLF", "KBE", "FINX", "FINCIAL", "BANK", "FIN", "INSUR"})
FINANCIAL_QUALITY = [("roe", True), ("roa", True)]


def score(raw: dict[str, dict[str, Optional[float]]], weights: dict[str, float],
          financial: bool = False) -> dict[str, dict]:
    """raw: symbol → raw fields. Returns symbol → {factors, score, coverage}."""
    syms = list(raw)
    parts_by = {**PARTS, "quality": FINANCIAL_QUALITY} if financial else PARTS
    part_pct: dict[str, dict[str, Optional[float]]] = {}
    for parts in parts_by.values():
        for field, up in parts:
            part_pct[field] = pct_rank({s: raw[s].get(field) for s in syms}, up)
    out = {}
    for s in syms:
        factors = {}
        for f, parts in parts_by.items():
            vals = [part_pct[field][s] for field, _ in parts if part_pct[field][s] is not None]
            factors[f] = round(sum(vals) / len(vals), 1) if vals else None
        have = {f: v for f, v in factors.items() if v is not None}
        wsum = sum(weights[f] for f in have)
        total = round(sum(weights[f] * v for f, v in have.items()) / wsum, 1) if wsum else None
        out[s] = {"factors": factors, "score": total, "coverage": len(have)}
    return out


# ── Data ─────────────────────────────────────────────────────────────────────

def _closes(symbols: list[str]) -> pd.DataFrame:
    raw = yf.download(sorted(set(symbols)), period="14mo", interval="1d",
                      auto_adjust=True, progress=False, threads=4)
    return raw["Close"] if isinstance(raw.columns, pd.MultiIndex) else raw


def _yahoo(symbol: str, market: str) -> str:
    return f"{symbol}.BK" if market == "TH" and not symbol.endswith(".BK") else symbol


def market_state(closes: pd.DataFrame) -> dict:
    from routers import fear_greed

    try:
        fg = fear_greed.get_current()
    except Exception as exc:  # the screen still runs on VIX / MOVE
        fg = {"error": str(exc)}
    out: dict[str, Any] = {"fear_greed": fg.get("value"), "fear_greed_label": fg.get("label"),
                           "fear_greed_source": fg.get("source")}
    for key, sym in (("vix", "^VIX"), ("move", "^MOVE")):
        s = closes[sym].dropna() if sym in closes.columns else pd.Series(dtype=float)
        out[key] = round(float(s.iloc[-1]), 2) if len(s) else None
        out[f"{key}_pct_1y"] = series_pct(s.iloc[-252:]) if len(s) else None
    out["state"] = regime(out["vix_pct_1y"], out["move_pct_1y"], out["fear_greed"])
    out["weights"] = WEIGHTS[out["state"]]
    out["rule"] = RULE_TEXT
    out["rules_set"] = RULES_SET
    return out


def build(market: str, group: str, top: int = 15) -> dict:
    from routers import rotation, stock

    mkt = market.upper()
    key = f"{mkt}|{group}|{top}"
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < _TTL:
            return hit[1]

    cons = rotation.rotation_constituents(id=group, market=mkt)
    members = sorted(cons.get("rows") or [], key=lambda m: -(m.get("weight") or 0))[:top]
    if not members:
        return {"market": mkt, "group": group, "rows": [], "error": cons.get("error") or "no members"}
    ysyms = {m["symbol"]: _yahoo(m["symbol"], mkt) for m in members}
    closes = _closes(list(ysyms.values()) + ["^VIX", "^MOVE"])
    state = market_state(closes)

    def ratios(sym):
        try:
            return sym, stock.stock_ratios(ysyms[sym])
        except Exception:
            return sym, {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        fund = dict(pool.map(ratios, ysyms))

    vix = closes["^VIX"] if "^VIX" in closes.columns else pd.Series(dtype=float)
    move = closes["^MOVE"] if "^MOVE" in closes.columns else pd.Series(dtype=float)
    raw: dict[str, dict] = {}
    betas: dict[str, dict] = {}
    for m in members:
        s = m["symbol"]
        c = closes[ysyms[s]] if ysyms[s] in closes.columns else pd.Series(dtype=float)
        raw[s] = {"mom_12_1": momentum_12_1(c), "vol_1y": vol_1y(c), **fundamentals_raw(fund.get(s) or {})}
        betas[s] = {"beta_vix": beta(c, vix) if len(vix) else None,
                    "beta_move": beta(c, move) if len(move) else None}

    financial = group.upper() in FINANCIAL_GROUPS
    scored = score(raw, state["weights"], financial)
    # Sensitivity flags: the most negative betas in the group (falls hardest when the index jumps).
    flags: dict[str, list[str]] = {s: [] for s in raw}
    for b, label in (("beta_vix", "falls most when VIX jumps"), ("beta_move", "falls most when MOVE jumps")):
        worst = pct_rank({s: (-betas[s][b] if betas[s][b] is not None else None) for s in raw})
        for s, p in worst.items():
            if p is not None and p >= SENSITIVE_PCT and betas[s][b] < 0:
                flags[s].append(label)

    rows = []
    for m in members:
        s = m["symbol"]
        rows.append({
            "symbol": s, "name": m.get("name"), "weight": m.get("weight"), "quadrant": m.get("quadrant"),
            **scored[s], "raw": {k: (round(v, 4) if isinstance(v, float) else v) for k, v in raw[s].items()},
            "beta_vix": round(betas[s]["beta_vix"], 3) if betas[s]["beta_vix"] is not None else None,
            "beta_move": round(betas[s]["beta_move"], 3) if betas[s]["beta_move"] is not None else None,
            "flags": flags[s] + ([f"only {scored[s]['coverage']} of 4 factors"]
                                 if scored[s]["coverage"] < MIN_COVERAGE else []),
        })
    rows.sort(key=lambda r: (r["coverage"] >= MIN_COVERAGE, r["score"] if r["score"] is not None else -1),
              reverse=True)
    result = {
        "market": mkt,
        "group": {"id": group, "name": ((cons.get("group") or {}).get("name"))},
        "as_of": str(closes.index[-1].date()) if len(closes.index) else None,
        "market_state": state,
        "rows": rows,
        "top3": [r["symbol"] for r in rows if r["coverage"] >= MIN_COVERAGE][:3],
        "members_total": len(cons.get("rows") or []),
        "notes": ([] if not financial else ["quality = ROE and ROA only for a group of lenders / insurers"])
                 + ([] if mkt != "TH" else ["SET closes before the US session opens: same-day betas to VIX "
                                            "and MOVE understate a Thai stock's sensitivity"]),
        "method": "Percentiles inside the group (0 = worst, 100 = best). momentum = 12-1 month return; "
                  "quality = ROE, ROA, gross margin, low debt/equity; value = earnings yield, EBITDA/EV, "
                  "book/price; low_vol = 1-year daily volatility. score = weighted mean of the factors a "
                  "stock has; the weights are the set for the market's state (rule in market_state.rule, "
                  f"set {RULES_SET}, not tuned to results). beta_vix / beta_move = daily return on the "
                  "index's daily % change over a year; a flag marks the group's most negative. Factor "
                  "evidence is for diversified portfolios, not three names, and timing the weights by "
                  "regime has weaker evidence than the factors. A screen, not a recommendation.",
    }
    with _lock:
        _cache[key] = (now, result)
    return result
