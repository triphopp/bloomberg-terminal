"""Allocation rules — how much equity against cash, and which sectors to lean into.

Pure: history in, a number out, no I/O. Every rule reads only the rows it is
handed (or the months at and before ``asof``), so handing it history up to day t
returns the answer as it stood on day t. That is what lets the backtest and the
live reading share one implementation.

The rules, their parameters and the papers they come from are frozen in
research/sector_allocation/PLAN.md — change them there first, and say so in
RESULTS.md. None of the numbers below was fitted to this data.

  trend    Faber (2007) — A Quantitative Approach to Tactical Asset Allocation
  vol      Moreira & Muir (2017) — Volatility-Managed Portfolios
  momentum Moskowitz & Grinblatt (1999) — Do Industries Explain Momentum?
  policy   Conover, Jensen, Johnson & Mercer (2008) — Sector Rotation and Monetary Conditions
  cycle    growth level x growth direction, inflation splitting the upswing
"""
from __future__ import annotations

import numpy as np
import pandas as pd

SECTORS = ("XLK", "XLF", "XLV", "XLI", "XLY", "XLP", "XLE", "XLB", "XLU", "XLRE", "XLC")

TREND_MONTHS = 10
VOL_WINDOW = 21
VOL_REF_MIN = 252
MOM_LOOKBACK = 12
MOM_SKIP = 1

#: A regional survey is divided by its own trailing sd, as the TAIL ISM proxy does.
SURVEY_SD_WINDOW = 120
SURVEY_SD_MIN = 24
GROWTH_TREND_MONTHS = 3

#: Core PCE for month m-1 prints in the last days of month m and sometimes slips
#: into the next one, so a month-end reading may only count on m-2.
PCE_LAG_MONTHS = 2
INFLATION_TARGET = 2.0
#: Same line TAIL MACRO READ draws between "at target" and "sticky".
INFLATION_GAP = 0.4

TILT_CAP = 0.05
Z_CLIP = 2.0

PHASES = ("Recovery", "Expansion", "Overheat", "Slowdown", "Contraction")

PHASE_FAVOURS: dict[str, tuple[str, ...]] = {
    "Recovery": ("XLY", "XLF", "XLI"),
    "Expansion": ("XLK", "XLI", "XLC"),
    "Overheat": ("XLE", "XLB"),
    "Slowdown": ("XLV", "XLP", "XLU"),
    "Contraction": ("XLP", "XLV"),
}

CYCLICAL = ("XLY", "XLF", "XLI", "XLB", "XLK")
DEFENSIVE = ("XLE", "XLU", "XLP", "XLV")


def month_end_closes(daily: pd.DataFrame | pd.Series) -> pd.DataFrame | pd.Series:
    """Last close of each calendar month, indexed by month."""
    return daily.groupby(daily.index.to_period("M")).last()


# ── Equity against cash ───────────────────────────────────────────────────────

def trend_weight(monthly_close: pd.Series, months: int = TREND_MONTHS) -> float | None:
    """1 while the month-end close is above its own average of the last `months`."""
    closes = monthly_close.dropna()
    if len(closes) < months:
        return None
    return 1.0 if closes.iloc[-1] > closes.iloc[-months:].mean() else 0.0


def vol_weight(daily_close: pd.Series, window: int = VOL_WINDOW,
               ref_min: int = VOL_REF_MIN) -> float | None:
    """Long-run volatility over the last month's, capped at 1 — no leverage."""
    r = np.log(daily_close.dropna()).diff().dropna()
    if len(r) < max(ref_min, window):
        return None
    recent = float(r.iloc[-window:].std(ddof=1))
    if recent <= 0:
        return 1.0
    return float(min(1.0, r.std(ddof=1) / recent))


# ── Sector scores ─────────────────────────────────────────────────────────────

def universe(monthly_closes: pd.DataFrame, months: int = MOM_LOOKBACK + 1) -> list[str]:
    """Sectors with an unbroken run of the last `months` month-end closes."""
    if len(monthly_closes) < months:
        return []
    tail = monthly_closes.iloc[-months:]
    return [c for c in monthly_closes.columns if tail[c].notna().all()]


def momentum_scores(monthly_closes: pd.DataFrame, lookback: int = MOM_LOOKBACK,
                    skip: int = MOM_SKIP) -> pd.Series:
    """Return over the `lookback` months before the last `skip`. Last row = signal month."""
    if len(monthly_closes) < lookback + 1:
        return pd.Series(dtype=float)
    recent = monthly_closes.iloc[-1 - skip]
    base = monthly_closes.iloc[-1 - lookback]
    return (recent / base - 1.0).dropna()


def growth_composite(surveys: pd.DataFrame, smooth: int = 1) -> pd.Series:
    """Regional Fed diffusion indices, each over its own trailing sd, then averaged.

    0 stays neutral — the surveys are not demeaned. The sd looks back only, so a
    month's value never depends on a later one.
    """
    sd = surveys.rolling(SURVEY_SD_WINDOW, min_periods=SURVEY_SD_MIN).std(ddof=1)
    g = (surveys / sd.where(sd > 0)).mean(axis=1, skipna=True)
    if smooth > 1:
        g = g.rolling(smooth, min_periods=smooth).mean()
    return g.dropna()


def cycle_phase(g: float | None, dg: float | None, gap: float | None) -> str | None:
    """Growth level and direction pick the quadrant; inflation splits the upswing."""
    if g is None or dg is None or np.isnan(g) or np.isnan(dg):
        return None
    if g < 0:
        return "Recovery" if dg > 0 else "Contraction"
    if dg < 0:
        return "Slowdown"
    if gap is None or np.isnan(gap):
        return None
    return "Overheat" if gap > INFLATION_GAP else "Expansion"


def phase_at(surveys: pd.DataFrame, core_pce: pd.Series, asof: pd.Period,
             smooth: int = 1) -> dict:
    """The cycle reading at the end of month `asof`, from what had printed by then."""
    g_all = growth_composite(surveys.loc[:asof], smooth)
    g = float(g_all.get(asof, np.nan))
    dg = g - float(g_all.get(asof - GROWTH_TREND_MONTHS, np.nan))
    m = asof - PCE_LAG_MONTHS
    now, year_ago = core_pce.get(m), core_pce.get(m - 12)
    gap = np.nan
    if now is not None and year_ago is not None and year_ago > 0:
        gap = (float(now) / float(year_ago) - 1.0) * 100.0 - INFLATION_TARGET
    return {"g": g, "dg": dg, "gap": gap, "phase": cycle_phase(g, dg, gap)}


def cycle_scores(phase: str | None, sectors: list[str]) -> pd.Series:
    favoured = PHASE_FAVOURS.get(phase or "", ())
    return pd.Series({s: 1.0 if s in favoured else 0.0 for s in sectors}, dtype=float)


def policy_stance(target: pd.Series) -> str | None:
    """Direction of the last change in the Fed funds target."""
    moves = target.dropna().diff()
    moves = moves[moves != 0].dropna()
    if moves.empty:
        return None
    return "EASING" if moves.iloc[-1] < 0 else "TIGHTENING"


def policy_scores(stance: str | None, sectors: list[str]) -> pd.Series:
    sign = {"EASING": 1.0, "TIGHTENING": -1.0}.get(stance or "", 0.0)
    return pd.Series(
        {s: sign if s in CYCLICAL else -sign if s in DEFENSIVE else 0.0 for s in sectors},
        dtype=float,
    )


# ── Scores to weights ─────────────────────────────────────────────────────────

def cross_z(scores: pd.Series) -> pd.Series:
    """Z-score across sectors; all zero when the scores do not tell them apart."""
    if len(scores) < 2:
        return scores * 0.0
    sd = float(scores.std(ddof=1))
    if not np.isfinite(sd) or sd < 1e-12:
        return scores * 0.0
    return (scores - scores.mean()) / sd


def combine(*zs: pd.Series) -> pd.Series:
    """Plain average of z-scores that share the same sectors."""
    return pd.concat(zs, axis=1).mean(axis=1)


def tilt_weights(z: pd.Series, cap: float = TILT_CAP) -> pd.Series:
    """Equal weight plus a tilt of at most `cap` either way; sums to 1."""
    n = len(z)
    if n == 0:
        return z
    zc = z.clip(-Z_CLIP, Z_CLIP)
    zc = zc - zc.mean()
    w = 1.0 / n + cap * zc / max(Z_CLIP, float(zc.abs().max()))
    w = w.clip(lower=0.0)
    return w / w.sum()
