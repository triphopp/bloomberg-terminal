"""
Margin maintenance — IBKR Reg T model for one account (PORT or PAPER).

Pure: no DB, no network. `routers/margin.py` builds a `Book` (cash + stock
lines + option lines, every amount already in the ACCOUNT currency) and this
module answers the questions IBKR's account window answers:

    NLV  Net Liquidation      = cash + stock MV + option MV        (signed)
    ELV  Equity w/ Loan Value = cash + stock MV                    US options carry
                                                                   no loan value
    IM   Initial margin       = Σ stock initial + Σ short-option requirement
    MM   Maintenance margin   = Σ stock maint   + Σ short-option requirement
    AF   Available Funds      = ELV − IM   (< 0: no new positions)
    EL   Excess Liquidity     = ELV − MM   (< 0: IBKR liquidates, no call first)
    Cushion                   = EL / NLV

Stock rates (FINRA 4210 / Reg T, IBKR's floor): long maint 25%, initial 50%.
Short maint ≥ $5: max($5/sh, 30%) · < $5: max($2.50/sh, 100%) — per-share
floors only for USD-priced lines. A per-symbol override replaces the maint
rate (IBKR raises concentrated / volatile / leveraged-ETF names; the statement
shows the real figure).

Short options (CBOE rule-based, what IBKR uses in a Reg T account):
  1. covered call (long shares) / covered put (short shares) → 0
  2. vertical spread vs a long option, same type, expiry ≥ short → max loss
  3. naked call  max(prem + p·S − OTM, prem + 10%·S)
     naked put   max(prem + p·S − OTM, prem + 10%·K)      p = 20%, 15% broad index
Long options: 0 requirement, but excluded from ELV — paid in full, as at IBKR.

Distance to liquidation: price shock search. Stock prices scale; an option's
time value is held constant and its intrinsic value re-priced at the shocked
spot (so short puts get worse as the market falls). Not modelled: SMA / the
end-of-day Reg T check, portfolio margin (TIMS), margin interest.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

LEVELS = ("SAFE", "WATCH", "WARNING", "DANGER", "LIQUIDATION")
LEVEL_RANK = {lv: i for i, lv in enumerate(LEVELS)}

# Account cushion floors (EL / NLV) for each level. LIQUIDATION = EL < 0.
DEFAULT_THRESHOLDS = {"WATCH": 0.20, "WARNING": 0.10, "DANGER": 0.05}
# Per-asset: how far THIS underlying alone must move before EL < 0.
ASSET_THRESHOLDS = {"WATCH": 0.35, "WARNING": 0.20, "DANGER": 0.10}

BROAD_INDEX = {"SPX", "^SPX", "^GSPC", "XSP", "NDX", "^NDX", "RUT", "^RUT", "DJX", "OEX", "XEO", "SPY", "QQQ", "IWM", "DIA"}


@dataclass
class Settings:
    maint_long: float = 0.25
    maint_short: float = 0.30
    initial: float = 0.50
    overrides: dict[str, float] = field(default_factory=dict)  # SYMBOL → maint rate
    thresholds: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_THRESHOLDS))


@dataclass
class StockLine:
    key: str            # underlying key, upper-case, matches OptionLine.underlying
    symbol: str         # display
    qty: float          # signed shares
    price: float        # per share, account currency
    usd: bool = True    # per-share $ floors apply
    ref: Optional[str] = None


@dataclass
class OptionLine:
    underlying: str
    symbol: str
    option_type: str    # "call" | "put"
    strike: float       # account currency
    expiry: str
    qty: float          # signed contracts
    mult: float
    mark: float         # per share, account currency
    spot: Optional[float]  # account currency
    ref: Optional[str] = None


@dataclass
class Book:
    cash: float
    stocks: list[StockLine]
    options: list[OptionLine]


# ── pricing under a shock ───────────────────────────────────────────────────

def _intrinsic(opt_type: str, strike: float, spot: Optional[float]) -> float:
    if not spot:
        return 0.0
    return max(spot - strike, 0.0) if opt_type == "call" else max(strike - spot, 0.0)


def _shocked(book: Book, shocks: dict[str, float]) -> Book:
    """Book with each underlying in `shocks` moved by that fraction (−0.1 = −10%).
    Key "*" moves everything."""
    if not shocks:
        return book
    every = shocks.get("*")

    def f(key: str) -> float:
        s = shocks.get(key, every)
        return 1.0 + s if s is not None else 1.0

    stocks = [StockLine(s.key, s.symbol, s.qty, s.price * f(s.key), s.usd, s.ref) for s in book.stocks]
    options = []
    for o in book.options:
        k = f(o.underlying)
        if k == 1.0 or not o.spot:
            options.append(o)
            continue
        new_spot = o.spot * k
        tv = max(0.0, o.mark - _intrinsic(o.option_type, o.strike, o.spot))
        mark = _intrinsic(o.option_type, o.strike, new_spot) + tv
        options.append(OptionLine(o.underlying, o.symbol, o.option_type, o.strike, o.expiry,
                                  o.qty, o.mult, mark, new_spot, o.ref))
    return Book(book.cash, stocks, options)


# ── requirements ────────────────────────────────────────────────────────────

def stock_rates(line: StockLine, st: Settings) -> tuple[float, float, str]:
    """(maint $ per share, initial $ per share, source)."""
    px = abs(line.price)
    override = st.overrides.get(line.key) or st.overrides.get(line.symbol.upper())
    if line.qty >= 0:
        if override is not None:
            m = min(max(override, 0.0), 1.0)
            return m * px, max(st.initial, m) * px, "OVERRIDE"
        return st.maint_long * px, st.initial * px, "REG_T"
    if override is not None:
        m = max(override, 0.0)
        return m * px, max(st.initial, m) * px, "OVERRIDE"
    if line.usd:
        if px >= 5:
            m = max(5.0, st.maint_short * px)
        else:
            m = max(2.5, px)
    else:
        m = st.maint_short * px
    return m, max(st.initial * px, m), "FINRA_4210"


def _naked(o: OptionLine, contracts: float) -> float:
    s = o.spot
    if not s:
        # No spot: charge the worst case the contract can reach that we can
        # still name — a put's strike, a call's premium + strike (flagged).
        per = o.strike if o.option_type == "put" else o.mark + o.strike
        return per * o.mult * contracts
    pct = 0.15 if o.underlying.upper() in BROAD_INDEX else 0.20
    if o.option_type == "call":
        otm = max(o.strike - s, 0.0)
        per = max(o.mark + pct * s - otm, o.mark + 0.10 * s)
    else:
        otm = max(s - o.strike, 0.0)
        per = max(o.mark + pct * s - otm, o.mark + 0.10 * o.strike)
    return per * o.mult * contracts


def option_requirements(book: Book) -> dict[int, dict]:
    """Requirement per option line index: {req, method, covered, spread, naked}."""
    out = {i: {"req": 0.0, "method": "LONG" if o.qty > 0 else "", "covered": 0.0, "spread": 0.0, "naked": 0.0}
           for i, o in enumerate(book.options)}
    shares: dict[str, float] = {}
    for s in book.stocks:
        shares[s.key] = shares.get(s.key, 0.0) + s.qty
    longs_left = {i: o.qty for i, o in enumerate(book.options) if o.qty > 0}

    shorts = [i for i, o in enumerate(book.options) if o.qty < 0]
    # Closest to the money first — the ones that would cost most naked get
    # the cover.
    shorts.sort(key=lambda i: -_naked(book.options[i], 1))
    for i in shorts:
        o = book.options[i]
        left = -o.qty
        methods = []
        # 1. cover by stock
        have = shares.get(o.underlying, 0.0)
        if o.option_type == "call" and have > 0:
            n = min(left, have // o.mult if o.mult else 0)
            if n > 0:
                shares[o.underlying] = have - n * o.mult
                out[i]["covered"] = n
                left -= n
                methods.append("COVERED")
        elif o.option_type == "put" and have < 0:
            n = min(left, (-have) // o.mult if o.mult else 0)
            if n > 0:
                shares[o.underlying] = have + n * o.mult
                out[i]["covered"] = n
                left -= n
                methods.append("COVERED")
        # 2. vertical spread against a long option
        while left > 0:
            best, best_cost = None, None
            for j, q in longs_left.items():
                lo = book.options[j]
                if q <= 0 or lo.underlying != o.underlying or lo.option_type != o.option_type:
                    continue
                if lo.mult != o.mult or lo.expiry < o.expiry:
                    continue
                gap = (lo.strike - o.strike) if o.option_type == "call" else (o.strike - lo.strike)
                cost = max(gap, 0.0) * o.mult
                if best_cost is None or cost < best_cost:
                    best, best_cost = j, cost
            if best is None or best_cost >= _naked(o, 1):
                break
            n = min(left, longs_left[best])
            longs_left[best] -= n
            out[i]["spread"] += n
            out[i]["req"] += best_cost * n
            left -= n
            if "SPREAD" not in methods:
                methods.append("SPREAD")
        # 3. naked
        if left > 0:
            out[i]["naked"] = left
            out[i]["req"] += _naked(o, left)
            methods.append("NAKED" if o.spot else "NAKED_NO_SPOT")
        out[i]["method"] = "+".join(methods)
    return out


# ── evaluation ──────────────────────────────────────────────────────────────

def level_for(cushion: Optional[float], el: float, thresholds: dict[str, float]) -> str:
    if el < 0:
        return "LIQUIDATION"
    if cushion is None:
        return "SAFE"
    if cushion < thresholds.get("DANGER", 0.05):
        return "DANGER"
    if cushion < thresholds.get("WARNING", 0.10):
        return "WARNING"
    if cushion < thresholds.get("WATCH", 0.20):
        return "WATCH"
    return "SAFE"


def evaluate(book: Book, st: Settings, detail: bool = True) -> dict:
    stock_mv = sum(s.qty * s.price for s in book.stocks)
    opt_mv = sum(o.qty * o.mark * o.mult for o in book.options)
    nlv = book.cash + stock_mv + opt_mv
    elv = book.cash + stock_mv

    mm = im = 0.0
    lines = []
    for s in book.stocks:
        m_ps, i_ps, src = stock_rates(s, st)
        m, i = m_ps * abs(s.qty), i_ps * abs(s.qty)
        mm += m
        im += i
        if detail:
            lines.append({"kind": "stock", "key": s.key, "symbol": s.symbol, "ref": s.ref,
                          "qty": s.qty, "price": s.price, "mv": s.qty * s.price,
                          "maint": m, "initial": i,
                          "maint_rate": (m_ps / abs(s.price)) if s.price else None,
                          "rate_source": src})
    reqs = option_requirements(book)
    for idx, o in enumerate(book.options):
        r = reqs[idx]["req"]
        mm += r
        im += r
        if detail:
            lines.append({"kind": "option", "key": o.underlying, "symbol": o.symbol, "ref": o.ref,
                          "qty": o.qty, "price": o.mark, "mv": o.qty * o.mark * o.mult,
                          "maint": r, "initial": r, "maint_rate": None,
                          "rate_source": reqs[idx]["method"],
                          "covered": reqs[idx]["covered"], "spread": reqs[idx]["spread"],
                          "naked": reqs[idx]["naked"]})
    el = elv - mm
    af = elv - im
    cushion = (el / nlv) if nlv > 0 else None
    level = level_for(cushion, el, st.thresholds) if nlv > 0 else ("LIQUIDATION" if (mm > 0 or book.cash < 0) else "SAFE")
    long_mv = sum(s.qty * s.price for s in book.stocks if s.qty > 0)
    short_mv = -sum(s.qty * s.price for s in book.stocks if s.qty < 0)
    out = {
        "nlv": nlv, "elv": elv, "stock_mv": stock_mv, "option_mv": opt_mv, "cash": book.cash,
        "loan": max(-book.cash, 0.0), "maint_margin": mm, "initial_margin": im,
        "excess_liquidity": el, "available_funds": af, "cushion": cushion,
        "gross_leverage": ((long_mv + short_mv) / nlv) if nlv > 0 else None,
        "level": level, "restricted": af < 0,
        "uses_margin": book.cash < 0 or short_mv > 0 or any(o.qty < 0 for o in book.options),
    }
    if detail:
        out["lines"] = lines
    return out


def _el(book: Book, st: Settings, shocks: dict[str, float]) -> float:
    r = evaluate(_shocked(book, shocks), st, detail=False)
    return r["excess_liquidity"]


def distance_to_call(book: Book, st: Settings, key: str = "*", direction: int = -1,
                     limit: float = 0.99, step: float = 0.01) -> Optional[float]:
    """Smallest move (as a positive fraction) of `key` ("*" = every underlying)
    in `direction` that takes EL below zero. 0.0 if already below; None if no
    move up to `limit` does it."""
    if _el(book, st, {}) < 0:
        return 0.0
    prev = 0.0
    x = step
    while x <= limit + 1e-12:
        if _el(book, st, {key: direction * x}) < 0:
            lo, hi = prev, x
            for _ in range(20):
                mid = (lo + hi) / 2
                if _el(book, st, {key: direction * mid}) < 0:
                    hi = mid
                else:
                    lo = mid
            return hi
        prev = x
        x += step
    return None


def asset_level(dist: Optional[float]) -> str:
    if dist is None:
        return "SAFE"
    if dist <= 0:
        return "LIQUIDATION"
    if dist < ASSET_THRESHOLDS["DANGER"]:
        return "DANGER"
    if dist < ASSET_THRESHOLDS["WARNING"]:
        return "WARNING"
    if dist < ASSET_THRESHOLDS["WATCH"]:
        return "WATCH"
    return "SAFE"


def analyse(book: Book, st: Settings) -> dict:
    """Full status: evaluate() + distances + per-underlying roll-up."""
    res = evaluate(book, st)
    has_up_risk = any(s.qty < 0 for s in book.stocks) or any(
        o.qty < 0 and o.option_type == "call" for o in book.options)
    res["drop_to_call"] = distance_to_call(book, st, "*", -1)
    res["rise_to_call"] = distance_to_call(book, st, "*", +1, limit=3.0, step=0.02) if has_up_risk else None

    mm = res["maint_margin"]
    assets: dict[str, dict] = {}
    for ln in res["lines"]:
        a = assets.setdefault(ln["key"], {"key": ln["key"], "mv": 0.0, "maint": 0.0, "initial": 0.0,
                                          "symbols": []})
        a["mv"] += ln["mv"]
        a["maint"] += ln["maint"]
        a["initial"] += ln["initial"]
        a["symbols"].append(ln["symbol"])
    for key, a in assets.items():
        down = distance_to_call(book, st, key, -1)
        up_risk = any(s.key == key and s.qty < 0 for s in book.stocks) or any(
            o.underlying == key and o.qty < 0 and o.option_type == "call" for o in book.options)
        up = distance_to_call(book, st, key, +1, limit=3.0, step=0.02) if up_risk else None
        a["drop_to_call"] = down
        a["rise_to_call"] = up
        worst = min([d for d in (down, up) if d is not None], default=None)
        a["level"] = asset_level(worst)
        a["mm_share"] = (a["maint"] / mm) if mm > 0 else 0.0
    res["assets"] = sorted(assets.values(), key=lambda a: (-LEVEL_RANK[a["level"]], -a["maint"]))
    for ln in res["lines"]:
        a = assets[ln["key"]]
        ln["level"] = a["level"]
        ln["drop_to_call"] = a["drop_to_call"]
    return res


def with_trade(book: Book, *, stock: Optional[StockLine] = None, option: Optional[OptionLine] = None,
               cash_delta: float = 0.0) -> Book:
    """Pro-forma book after a fill — for pre-trade checks."""
    stocks = list(book.stocks)
    options = list(book.options)
    if stock is not None:
        for i, s in enumerate(stocks):
            if s.key == stock.key:
                stocks[i] = StockLine(s.key, s.symbol, s.qty + stock.qty, stock.price, s.usd, s.ref)
                break
        else:
            stocks.append(stock)
    if option is not None:
        options.append(option)
    return Book(book.cash + cash_delta, stocks, options)
