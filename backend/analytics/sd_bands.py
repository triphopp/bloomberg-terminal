"""
Black-Scholes lognormal SD bands — the math behind the IV SD Heatmap pane.

Under BS the terminal log-return is normal:

    ln(S_T / S_0) ~ N(m, s²)     m = (r − q − σ²/2)·T     s = σ·√T

so the price at a given z is `S_0 · exp(m + z·s)`. Sigma is the average of the
ATM call and put implied vols, `σ_mid = (IV_call + IV_put)/2`.

Two things the naive reading of "probability at ±1σ, ±2σ" gets wrong, and which
this module is built around:

1. A continuous distribution puts zero probability on any single point, so the
   five rows are BUCKETS in z-space, centred on the sd level and half a sigma
   wide either side (the outer two are open-ended). They partition the real line,
   so they sum to exactly 1.

2. Those bucket probabilities are constants — 6.68 / 24.17 / 38.29 / 24.17 /
   6.68 percent — independent of σ, S_0, T and r. IV moves the *prices* of the
   bucket edges, never the probability mass inside them. A heatmap coloured by
   bucket probability would therefore be the same five shades on every bar, so
   the two `cells` modes below encode something that actually varies:

   - occupancy: where price ACTUALLY landed, relative to the band that was
     projected `horizon` bars earlier. Backward-looking, so no look-ahead and
     the right edge is live.
   - cheapness: the same price edges re-scored under realized vol,
     `P_rv(bucket) − P_iv(bucket)`. Negative in the tails means IV is pricing
     more tail mass than realized vol delivers — a positive variance premium.

`m` uses the risk-neutral drift, so row 0 is the lognormal MEDIAN, which sits
below the forward by a factor `exp(σ²T/2)`. That is intentional (see the plan),
but it means row 0 is not the same thing as the futures/forward price — nor the
spot, nor the mode. For a lognormal the three centres always order as
`mode < median < mean`, and at high vol they are far apart: AMD at 54.6% IV over
30 days gives mode 462.62, median 474.08, spot 478.40, forward 479.92.

── Known limitations of the INPUTS ──────────────────────────────────────────

The formulas are exact (see tests/test_sd_bands.py, which ties them to N(d2) and
to Monte Carlo). What is approximate is what gets fed in:

1. **One ATM sigma for the whole band — the material one.** Real chains smile:
   measured on AMD 2026-09-18, ATM was 54.6% while the strikes nearest ±2σ quoted
   ~60%. Using ATM everywhere therefore draws the tails about 3% too NARROW, i.e.
   this understates tail risk rather than overstating it. Fixing it properly means
   storing the smile, not a single number, and solving each level against its own
   IV — worth doing, not done.
2. **q is hardcoded to 0.** For a 30-day horizon a 1% dividend yield moves the
   band under 0.1%, an order below the smile error. It would matter at a 1-year
   horizon — and much sooner on a hard-to-borrow name: SNDK's chain implied a
   carry of −10.5% annualised on 2026-08-18 (forward 1.23% above spot over 31
   days), which split its call IV from its put IV by 8 points.

   That split is also why `σ_mid = (IV_call + IV_put)/2` is a better estimator
   than it looks. Yahoo quotes IV against SPOT with q=0, so an unmodelled carry
   pushes call IV up and put IV down by roughly the same amount, and averaging
   the two cancels most of it: on that SNDK chain σ_mid came to 84.8% against a
   true forward-implied 86.0% — a 1.4% residual on a name whose carry was off by
   10 points. Solving against the parity-implied forward (Black-76) would remove
   the rest.
3. **Tenor mismatch.** Sigma comes from the expiry nearest 30 DTE (32 days in the
   example) but T is exactly `horizonDays/365`. That is a flat term-structure
   assumption worth ~1%; `dteAtSnapshot` is returned per row so the stretch is
   visible rather than hidden.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional, Sequence

import numpy as np
from scipy.stats import norm

# ── Bucket geometry ───────────────────────────────────────────────────────────

#: Row labels, most bearish first, so index 0 is the bottom row of the pane.
SD_LEVELS: tuple[int, ...] = (-2, -1, 0, 1, 2)

#: Bucket boundaries in z. Six edges → five buckets, each centred on an sd
#: level and ±0.5σ wide; the outermost two are open-ended.
Z_EDGES: tuple[float, ...] = (-math.inf, -1.5, -0.5, 0.5, 1.5, math.inf)

#: P(z in bucket) under the standard normal — constant, hence never used as a
#: colour. Exported because the pane prints it as the reference row label.
BUCKET_PROBS: tuple[float, ...] = tuple(
    float(norm.cdf(Z_EDGES[i + 1]) - norm.cdf(Z_EDGES[i])) for i in range(len(SD_LEVELS))
)

#: P(S_T >= the price AT each sd level) = 1 - Phi(k).
#:
#: A different question from BUCKET_PROBS and the one traders usually mean by
#: "the odds at +1σ": bucket prob is the chance of FINISHING inside that band,
#: while this is the chance of finishing at or above that line — 15.9% at +1σ,
#: 2.3% at +2σ. Also constant in z, so like the buckets it is a reference the
#: colours are read against, never a colour itself.
LEVEL_EXCEED_PROBS: tuple[float, ...] = tuple(
    float(1.0 - norm.cdf(k)) for k in SD_LEVELS
)

TRADING_DAYS = 252


# ── ATM implied vol ───────────────────────────────────────────────────────────

def atm_iv_pair(
    calls: Sequence[dict],
    puts: Sequence[dict],
    spot: float,
    band: float = 0.03,
) -> tuple[Optional[float], Optional[float], Optional[float], Optional[float]]:
    """Median call IV, median put IV, their mean, and the nearest strike.

    Contracts within `band` of spot count as at-the-money. The median (not the
    mean) across that window is used per side: a single stale or zero-bid strike
    inside a 3% window is common and would drag a mean noticeably.

    Returns `(iv_call, iv_put, iv_mid, atm_strike)`; any element is None when
    that side has no usable quote. `iv_mid` falls back to whichever side exists
    so a one-sided chain still produces a band.
    """
    if spot <= 0:
        return None, None, None, None

    def _side(rows: Sequence[dict]) -> list[float]:
        return [
            float(r["impliedVolatility"])
            for r in rows
            if float(r.get("strike") or 0) > 0
            and abs(float(r["strike"]) - spot) / spot <= band
            and float(r.get("impliedVolatility") or 0) > 0.01
        ]

    call_ivs = _side(calls)
    put_ivs = _side(puts)

    iv_call = float(np.median(call_ivs)) if call_ivs else None
    iv_put = float(np.median(put_ivs)) if put_ivs else None

    present = [v for v in (iv_call, iv_put) if v is not None]
    iv_mid = float(sum(present) / len(present)) if present else None

    strikes = [
        float(r["strike"])
        for r in list(calls) + list(puts)
        if float(r.get("strike") or 0) > 0
    ]
    atm_strike = min(strikes, key=lambda k: abs(k - spot)) if strikes else None

    return iv_call, iv_put, iv_mid, atm_strike


# ── Band geometry ─────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class SdBand:
    """One bar's projected distribution, expressed in price space."""

    spot: float
    sigma: float
    T: float
    #: Drift of ln(S_T/S_0) over T — the risk-neutral median offset.
    m: float
    #: Std dev of ln(S_T/S_0) over T.
    s: float
    #: Price at each sd level (row centre), aligned with SD_LEVELS.
    levels: tuple[float, ...]
    #: Price at each bucket boundary. 6 entries; the outer two are ±inf.
    edges: tuple[float, ...]


def sd_band(spot: float, sigma: float, T: float, r: float = 0.0, q: float = 0.0) -> Optional[SdBand]:
    """Project the five sd levels and their bucket edges into price space."""
    if spot <= 0 or sigma <= 0 or T <= 0:
        return None

    m = (r - q - 0.5 * sigma * sigma) * T
    s = sigma * math.sqrt(T)

    levels = tuple(spot * math.exp(m + k * s) for k in SD_LEVELS)
    edges = tuple(
        -math.inf if z == -math.inf else (math.inf if z == math.inf else spot * math.exp(m + z * s))
        for z in Z_EDGES
    )
    return SdBand(spot=spot, sigma=sigma, T=T, m=m, s=s, levels=levels, edges=edges)


def bucket_of(price: float, edges: Sequence[float]) -> Optional[int]:
    """Index into SD_LEVELS of the bucket `price` falls in, or None if unusable.

    Edges are treated as half-open `[lo, hi)` so a price landing exactly on a
    boundary is assigned upward, and every finite price lands in exactly one
    bucket (the outer buckets are open-ended).
    """
    if price <= 0 or len(edges) != len(SD_LEVELS) + 1:
        return None
    for i in range(len(SD_LEVELS)):
        if edges[i] <= price < edges[i + 1]:
            return i
    return None


def bucket_probs_under(
    spot: float,
    sigma: float,
    T: float,
    edges: Sequence[float],
    r: float = 0.0,
    q: float = 0.0,
) -> Optional[tuple[float, ...]]:
    """Probability mass in each bucket when the EDGES come from one sigma and
    the distribution from another.

    This is what makes the `cheapness` mode vary: hold the IV-derived price
    edges fixed, then ask how much mass realized vol puts between them. Same
    edges under a smaller sigma → less tail mass, so the tail cells go negative
    once the IV probabilities are subtracted.
    """
    if spot <= 0 or sigma <= 0 or T <= 0 or len(edges) != len(SD_LEVELS) + 1:
        return None

    m = (r - q - 0.5 * sigma * sigma) * T
    s = sigma * math.sqrt(T)

    def _cdf(price: float) -> float:
        if price == -math.inf or price <= 0:
            return 0.0
        if price == math.inf:
            return 1.0
        return float(norm.cdf((math.log(price / spot) - m) / s))

    cdfs = [_cdf(e) for e in edges]
    return tuple(cdfs[i + 1] - cdfs[i] for i in range(len(SD_LEVELS)))


# ── Realized vol ──────────────────────────────────────────────────────────────

def realized_vol_series(closes: Sequence[float], window: int) -> list[Optional[float]]:
    """Annualised close-to-close realized vol, one value per input close.

    Aligned with `closes` (index i uses the trailing `window` returns ending at
    i), so it can be zipped against the price series directly. Entries before
    the window is full are None rather than a partial estimate.
    """
    n = len(closes)
    out: list[Optional[float]] = [None] * n
    if window < 2 or n < window + 1:
        return out

    arr = np.asarray(closes, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        logret = np.diff(np.log(arr))

    for i in range(window, n):
        seg = logret[i - window : i]
        seg = seg[np.isfinite(seg)]
        if len(seg) < 2:
            continue
        sd = float(np.std(seg, ddof=1))
        # `> 0` is not enough: a flat or perfectly compounding window leaves
        # float noise around 1e-15, which is not a vol estimate but would still
        # pass sd_band()'s sigma>0 check and collapse the band onto the median.
        if sd * math.sqrt(TRADING_DAYS) > 1e-6:
            out[i] = sd * math.sqrt(TRADING_DAYS)
    return out
