"""Payoff geometry for a set of option legs.

Three different kinds of number come out of here, and conflating them is the
main way a payoff screen misleads:

* **Payoff at expiry** is ARITHMETIC. `max(S−K,0)` and a subtraction — no model,
  no volatility, no assumptions. It is exact, and it is what breakeven, max
  profit and max loss are defined on.
* **Value today (T+0)** is a MODEL. Black-Scholes at the current implied vol,
  priced through `greeks.py` so the curve and the greeks in the positions table
  can never come from two different formulas.
* **Probability of profit** is a MODEL ESTIMATE resting on more assumptions
  still: lognormal terminal price, today's IV held constant, risk-neutral drift.
  It is not a forecast and must never be presented as one.

Sign convention matches the rest of PORT: `quantity` is signed, shorts are
negative, nothing is `abs()`-ed. Every formula below works for both directions
without a branch, which is precisely why it is worth keeping the sign.
"""

from __future__ import annotations

import math
from typing import Iterable, Mapping, Optional, Sequence

from greeks import _RISK_FREE_RATE, _bs_price, _days_to_expiry

# Below this the numbers are noise rather than signal.
_EPS = 1e-9


def _f(v, default: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _leg_size(leg: Mapping) -> float:
    """Signed contracts × multiplier — the factor every per-share figure scales by."""
    mult = _f(leg.get("multiplier"), 100.0) or 100.0
    return _f(leg.get("quantity")) * mult


def intrinsic(option_type: str, strike: float, spot: float) -> float:
    return max(spot - strike, 0.0) if str(option_type).lower() == "call" else max(strike - spot, 0.0)


def payoff_at_expiry(legs: Sequence[Mapping], spot: float) -> float:
    """P&L if the underlying finishes at `spot`. Exact, no model."""
    total = 0.0
    for leg in legs:
        total += (
            intrinsic(leg.get("option_type", "call"), _f(leg.get("strike")), spot)
            - _f(leg.get("entry_price"))
        ) * _leg_size(leg)
        total -= _f(leg.get("fees"))
    return total


def value_today(
    legs: Sequence[Mapping],
    spot: float,
    ivs: Sequence[Optional[float]],
    r: float = _RISK_FREE_RATE,
) -> Optional[float]:
    """Mark-to-model P&L if the underlying were at `spot` RIGHT NOW.

    Returns None when any leg lacks an implied vol — a partial curve drawn from
    the legs that happen to have one would be a different position than the one
    on screen.
    """
    total = 0.0
    for leg, iv in zip(legs, ivs):
        expiry = str(leg.get("expiry") or "")[:10]
        T = _days_to_expiry(expiry)
        strike = _f(leg.get("strike"))
        opt = str(leg.get("option_type", "call")).lower()
        if T <= 0:
            # Past expiry there is no time value left to model; the option is
            # worth exactly its intrinsic value.
            price = intrinsic(opt, strike, spot)
        else:
            if iv is None or _f(iv) <= 0:
                return None
            price = _bs_price(spot, strike, T, r, _f(iv), opt)
        total += (price - _f(leg.get("entry_price"))) * _leg_size(leg)
        total -= _f(leg.get("fees"))
    return total


# ── shape of the payoff at the extremes ─────────────────────────────────────

def _slope_up(legs: Sequence[Mapping]) -> float:
    """d(payoff)/dS as S → ∞. Only calls still have exposure up there."""
    return sum(
        _leg_size(leg)
        for leg in legs
        if str(leg.get("option_type", "call")).lower() == "call"
    )


def bounds(legs: Sequence[Mapping]) -> dict:
    """Max profit and max loss, honest about the unbounded cases.

    Taking max/min over a sampled grid would report a long call's "max profit"
    as whatever happened to be at the right-hand edge — a number that says more
    about the chart's width than about the position. The tails are analytic:

    * S → ∞ : payoff is linear with slope = Σ(size) over the CALL legs.
      Positive slope means profit is unbounded; negative means loss is.
    * S → 0 : always finite. Calls expire worthless, puts pay their full strike.
    """
    up = _slope_up(legs)
    at_zero = payoff_at_expiry(legs, 0.0)

    # Kinks only occur at strikes; between them the payoff is linear, so the
    # extremes of the bounded side are at a strike, at zero, or in the tail.
    candidates = [0.0] + sorted({_f(leg.get("strike")) for leg in legs})
    values = [(s, payoff_at_expiry(legs, s)) for s in candidates]

    if up > _EPS:
        max_profit = {"value": None, "unbounded": True, "at": None,
                      "note": "net long calls — profit rises without limit as the underlying rises"}
        loss_at, loss_val = min(values, key=lambda kv: kv[1])
        max_loss = {"value": round(loss_val, 2), "unbounded": False, "at": round(loss_at, 4)}
    elif up < -_EPS:
        prof_at, prof_val = max(values, key=lambda kv: kv[1])
        max_profit = {"value": round(prof_val, 2), "unbounded": False, "at": round(prof_at, 4)}
        max_loss = {"value": None, "unbounded": True, "at": None,
                    "note": "net short calls — loss grows without limit as the underlying rises"}
    else:
        # Call exposure nets out; the payoff flattens on the right, so the far
        # tail is just another candidate point.
        far = max(candidates) * 3 + 1.0
        values.append((far, payoff_at_expiry(legs, far)))
        prof_at, prof_val = max(values, key=lambda kv: kv[1])
        loss_at, loss_val = min(values, key=lambda kv: kv[1])
        max_profit = {"value": round(prof_val, 2), "unbounded": False, "at": round(prof_at, 4)}
        max_loss = {"value": round(loss_val, 2), "unbounded": False, "at": round(loss_at, 4)}

    max_profit["at_zero"] = round(at_zero, 2)
    return {"max_profit": max_profit, "max_loss": max_loss, "slope_up": up}


# ── breakevens ──────────────────────────────────────────────────────────────

def find_breakevens(legs: Sequence[Mapping], lo: float, hi: float, steps: int = 2000) -> list[float]:
    """Every price where the expiry payoff crosses zero, found by scanning.

    `K ± premium` is only the answer for a single leg. Combine lots and there
    can be two crossings, or none, and the closed form quietly stops applying.
    Scanning for sign changes then bisecting works for any number of legs.
    """
    lo = max(lo, 0.0)
    if hi <= lo:
        return []
    out: list[float] = []
    step = (hi - lo) / steps
    prev_s = lo
    prev_v = payoff_at_expiry(legs, prev_s)
    for i in range(1, steps + 1):
        s = lo + i * step
        v = payoff_at_expiry(legs, s)
        if abs(v) < _EPS:
            out.append(s)
        elif prev_v * v < 0:
            a, b, fa = prev_s, s, prev_v
            for _ in range(60):
                mid = (a + b) / 2
                fm = payoff_at_expiry(legs, mid)
                if fa * fm <= 0:
                    b = mid
                else:
                    a, fa = mid, fm
            out.append((a + b) / 2)
        prev_s, prev_v = s, v

    # Collapse near-duplicates from a flat segment sitting on zero.
    dedup: list[float] = []
    for x in sorted(out):
        if not dedup or abs(x - dedup[-1]) > max(hi - lo, 1.0) * 1e-4:
            dedup.append(x)
    return dedup


# ── probability of profit ───────────────────────────────────────────────────

def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _lognormal_cdf(x: float, spot: float, sigma: float, T: float, r: float) -> float:
    """P(S_T ≤ x) under a risk-neutral lognormal."""
    if x <= 0:
        return 0.0
    if T <= 0 or sigma <= 0:
        return 1.0 if spot <= x else 0.0
    d = (math.log(x / spot) - (r - 0.5 * sigma * sigma) * T) / (sigma * math.sqrt(T))
    return _norm_cdf(d)


def probability_of_profit(
    legs: Sequence[Mapping],
    spot: float,
    sigma: Optional[float],
    T: float,
    r: float = _RISK_FREE_RATE,
    breakevens: Optional[Sequence[float]] = None,
) -> Optional[float]:
    """P(payoff at expiry > 0), integrating the lognormal over profitable ranges.

    A MODEL ESTIMATE: it assumes the terminal price is lognormal, that today's
    implied vol is the right vol and stays put, and a risk-neutral drift. Real
    outcomes are fat-tailed and the drift is not risk-neutral. Treat as a rough
    ordering device, never as odds.
    """
    if sigma is None or sigma <= 0 or T <= 0 or spot <= 0:
        return None

    bes = list(breakevens if breakevens is not None else find_breakevens(legs, 0.0, spot * 5))
    edges = [0.0] + bes + [float("inf")]
    total = 0.0
    for a, b in zip(edges, edges[1:]):
        probe = (a + b) / 2 if b != float("inf") else max(a * 1.5, a + spot)
        if payoff_at_expiry(legs, probe) <= 0:
            continue
        lo_p = _lognormal_cdf(a, spot, sigma, T, r) if a > 0 else 0.0
        hi_p = 1.0 if b == float("inf") else _lognormal_cdf(b, spot, sigma, T, r)
        total += max(hi_p - lo_p, 0.0)
    return min(max(total, 0.0), 1.0)


# ── the whole picture ───────────────────────────────────────────────────────

def build_payoff(
    legs: Sequence[Mapping],
    spot: float,
    ivs: Sequence[Optional[float]],
    *,
    points: int = 121,
    range_pct: float = 0.35,
    r: float = _RISK_FREE_RATE,
) -> dict:
    """Curve plus every headline number, in the legs' own currency."""
    legs = list(legs)
    if not legs or spot <= 0:
        return {"curve": [], "breakevens": [], "error": "no legs or no spot price"}

    lo = max(spot * (1 - range_pct), 0.01)
    hi = spot * (1 + range_pct)
    # Strikes outside the window would hide the kink that defines the shape.
    strikes = [_f(leg.get("strike")) for leg in legs]
    lo = min([lo] + [k * 0.92 for k in strikes if k > 0])
    hi = max([hi] + [k * 1.08 for k in strikes if k > 0])

    step = (hi - lo) / max(points - 1, 1)
    curve = []
    for i in range(points):
        s = lo + i * step
        t0 = value_today(legs, s, ivs, r)
        curve.append({
            "s": round(s, 4),
            "expiry": round(payoff_at_expiry(legs, s), 2),
            "t0": None if t0 is None else round(t0, 2),
        })

    # Search wider than the drawn window: a breakeven can sit outside it.
    bes = find_breakevens(legs, 0.0, max(hi * 2, spot * 3))
    b = bounds(legs)

    # Portfolio IV/T for POP: the nearest expiry and a size-weighted vol. Crude
    # for a genuine multi-expiry book, and labelled as such.
    dtes = [_days_to_expiry(str(leg.get("expiry") or "")[:10]) for leg in legs]
    T = min([t for t in dtes if t > 0], default=0.0)
    usable = [(_f(iv), abs(_leg_size(leg))) for leg, iv in zip(legs, ivs) if iv]
    sigma = (
        sum(v * w for v, w in usable) / sum(w for _, w in usable)
        if usable and sum(w for _, w in usable) > 0 else None
    )

    now_t0 = value_today(legs, spot, ivs, r)
    return {
        "spot": round(spot, 4),
        "range": {"min": round(lo, 4), "max": round(hi, 4)},
        "curve": curve,
        "breakevens": [
            {"price": round(x, 4), "move_pct": round((x / spot - 1) * 100, 2)} for x in bes
        ],
        "max_profit": b["max_profit"],
        "max_loss": b["max_loss"],
        "current": {
            "pnl_if_expired_now": round(payoff_at_expiry(legs, spot), 2),
            "pnl_today": None if now_t0 is None else round(now_t0, 2),
        },
        "pop": probability_of_profit(legs, spot, sigma, T, r, bes),
        "dte_days": round(T * 365) if T > 0 else 0,
        "iv_used": round(sigma, 6) if sigma else None,
        "legs_missing_iv": [
            i for i, iv in enumerate(ivs)
            if not iv and _days_to_expiry(str(legs[i].get("expiry") or "")[:10]) > 0
        ],
        "model_note": (
            "The expiry line is arithmetic. The T+0 line is Black-Scholes at the current implied "
            "vol, and POP additionally assumes a lognormal terminal price with that vol held "
            "constant and a risk-neutral drift — a rough ordering device, not odds."
        ),
    }
