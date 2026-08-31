"""
Rate curve + scenario definitions for the IR stress framework.

The curve is the *only* legitimate input to a stress run. A policy action is not
a scenario: measured 2021-2026, beta(dDGS10 on dDFF) = +0.013 and the 10Y fell in
4 of the 11 months the funds rate rose, because the curve prices hikes in advance.
Callers therefore pass a curve shock; a "Fed +25bp" request has to be translated
into one of the shapes below first, and the translation is an assumption the UI
must show.

Scenario shapes come from what actually happened, not from round numbers:
`hist_1994` flattens (short end up more than long) because that is what 1994 did,
and a +250bp parallel move is filed separately as `stylized_par_250` so nobody
reads it as a replay.
"""
from __future__ import annotations

import requests

from cache import TTLCache
from config import FRED_API_KEY

_cache = TTLCache(ttl=3600, maxsize=16)
_UA = "Mozilla/5.0 (compatible; BloombergTerminal/1.0)"
_FRED = "https://api.stlouisfed.org/fred/series/observations"

# Constant-maturity Treasury, the same 11 tenors the TICK DATA board shows.
TENORS: list[tuple[str, str, float]] = [
    ("1M", "DGS1MO", 1 / 12),
    ("3M", "DGS3MO", 0.25),
    ("6M", "DGS6MO", 0.5),
    ("1Y", "DGS1", 1.0),
    ("2Y", "DGS2", 2.0),
    ("3Y", "DGS3", 3.0),
    ("5Y", "DGS5", 5.0),
    ("7Y", "DGS7", 7.0),
    ("10Y", "DGS10", 10.0),
    ("20Y", "DGS20", 20.0),
    ("30Y", "DGS30", 30.0),
]

# Moody's Baa minus the 10Y stands in for a corporate spread. The ICE BofA OAS
# series on FRED only reach back ~3 years (licensing), so they cannot anchor any
# historical work — see plans/cirst-validation-harness.md §0.4.
_SPREAD_PROXY = ("DBAA", "DGS10")


def _latest(series_id: str) -> float | None:
    """Most recent non-missing observation, as a decimal rate."""
    cached = _cache.get(f"fred:{series_id}")
    if cached is not None:
        return cached
    try:
        r = requests.get(
            _FRED,
            params={
                "series_id": series_id,
                "api_key": FRED_API_KEY,
                "file_type": "json",
                "sort_order": "desc",
                "limit": 10,
            },
            headers={"User-Agent": _UA},
            timeout=15,
        )
        r.raise_for_status()
        for o in r.json().get("observations", []):
            v = o.get("value", "")
            if v and v != ".":
                val = float(v) / 100
                _cache.set(f"fred:{series_id}", val)
                return val
    except Exception as exc:  # noqa: BLE001 - a missing tenor must not kill the run
        print(f"[ir_stress.curve] {series_id}: {exc}")
    return None


def get_curve() -> dict:
    """Current UST curve plus the corporate refinancing rate derived from it."""
    cached = _cache.get("curve")
    if cached is not None:
        return cached

    points: dict[str, float] = {}
    for label, sid, _years in TENORS:
        v = _latest(sid)
        if v is not None:
            points[label] = v

    baa = _latest(_SPREAD_PROXY[0])
    ten = points.get("10Y")
    spread = (baa - ten) if (baa is not None and ten is not None) else None

    # Five years is the maturity a corporate refinancing actually clears at, far
    # more often than the 10Y the headlines quote.
    five = points.get("5Y")
    refi = (five + spread) if (five is not None and spread is not None) else None

    data = {
        "points": points,
        "baa": baa,
        "spread_proxy": spread,
        "refi_rate": refi,
        "spread_source": "FRED DBAA - DGS10 (index level, not issuer)",
    }
    _cache.set("curve", data)
    return data


# ── Scenarios ────────────────────────────────────────────────────────────────
#
# `shifts` is in decimal rate units keyed by tenor label; a missing tenor is
# interpolated linearly between the two nearest specified points.

SCENARIOS: dict[str, dict] = {
    # A single policy meeting moves the curve in these sizes far more often than in
    # round hundreds, and for a heavily indebted issuer 25bp is already money.
    "par_+10": {"label": "+10bp", "kind": "parallel", "bp": 10, "band": "meeting"},
    "par_+15": {"label": "+15bp", "kind": "parallel", "bp": 15, "band": "meeting"},
    "par_+20": {"label": "+20bp", "kind": "parallel", "bp": 20, "band": "meeting"},
    "par_+25": {"label": "+25bp", "kind": "parallel", "bp": 25, "band": "meeting"},
    "par_+50": {"label": "+50bp", "kind": "parallel", "bp": 50, "band": "meeting"},
    "par_-25": {"label": "-25bp", "kind": "parallel", "bp": -25, "band": "meeting"},

    "par_+100": {"label": "+100bp", "kind": "parallel", "bp": 100, "band": "cycle"},
    "par_+200": {"label": "+200bp", "kind": "parallel", "bp": 200, "band": "cycle"},
    "par_+300": {"label": "+300bp", "kind": "parallel", "bp": 300, "band": "cycle"},
    "par_-100": {"label": "-100bp", "kind": "parallel", "bp": -100, "band": "cycle"},
    "par_-200": {"label": "-200bp", "kind": "parallel", "bp": -200, "band": "cycle"},

    "bear_steep": {
        "label": "Bear steepener",
        "kind": "shape",
        "band": "shape",
        "shifts": {"2Y": 50, "10Y": 150, "30Y": 175},
    },
    "bull_flat": {
        "label": "Bull flattener",
        "kind": "shape",
        "band": "shape",
        "shifts": {"2Y": -50, "10Y": -100, "30Y": -125},
    },
    "twist": {
        "label": "Twist",
        "kind": "shape",
        "band": "shape",
        "shifts": {"2Y": 100, "10Y": 25, "30Y": -50},
    },
    "hist_2022": {
        "label": "2022 hiking cycle",
        "kind": "shape",
        "band": "history",
        "driver": "inflation",
        # Measured from FRED, 2021-10-31 -> 2022-10-31. Every tenor, because a
        # replay driven off one point would miss that the curve inverted.
        "shifts": {"1M": 367, "3M": 417, "6M": 450, "1Y": 451, "2Y": 403,
                   "3Y": 370, "5Y": 309, "7Y": 274, "10Y": 255, "20Y": 246,
                   "30Y": 229},
    },
    "hist_1994": {
        "label": "1994 tightening",
        "kind": "shape",
        "band": "history",
        "driver": "growth",
        # Measured from FRED, 1993-10-31 -> 1994-10-31.
        "shifts": {"3M": 210, "6M": 244, "1Y": 271, "2Y": 285, "3Y": 280,
                   "5Y": 265, "7Y": 246, "10Y": 238, "20Y": 197, "30Y": 201},
    },
    "stylized_par_250": {
        "label": "+250bp severe",
        "kind": "parallel",
        "bp": 250,
        "band": "history",
        "hypothetical": True,
    },
    "stylized_par_400": {
        "label": "+400bp",
        "kind": "parallel",
        "bp": 400,
        "band": "history",
        "hypothetical": True,
    },
}

# Groups the UI lays out as column bands. "parallel" is dropped from the labels:
# every shock here moves the whole curve unless its name says otherwise, so the
# word carried no information and cost a third of each column heading.
BANDS: list[tuple[str, str]] = [
    ("meeting", "ONE POLICY MEETING"),
    ("cycle", "A FULL CYCLE"),
    ("shape", "THE CURVE CHANGES SHAPE"),
    ("history", "WHAT ACTUALLY HAPPENED"),
]

# The largest 12-month move in DGS10 since 1962 is +398bp (Sep-80 to Sep-81).
# Anything at or beyond that is outside the historical record entirely.
MAX_OBSERVED_12M_BP = 398


def _interp(shifts_bp: dict[str, float], tenor_years: float) -> float:
    """Linear interpolation across the specified tenors, flat outside the ends."""
    known = sorted(
        (yrs, shifts_bp[label])
        for label, _sid, yrs in TENORS
        if label in shifts_bp
    )
    if not known:
        return 0.0
    if tenor_years <= known[0][0]:
        return known[0][1]
    if tenor_years >= known[-1][0]:
        return known[-1][1]
    for (y0, v0), (y1, v1) in zip(known, known[1:]):
        if y0 <= tenor_years <= y1:
            w = (tenor_years - y0) / (y1 - y0) if y1 > y0 else 0.0
            return v0 + w * (v1 - v0)
    return known[-1][1]


def scenario_shifts(scenario_id: str) -> dict[str, float]:
    """Per-tenor shift in decimal rate units for one scenario."""
    sc = SCENARIOS.get(scenario_id)
    if sc is None:
        raise KeyError(scenario_id)

    if sc["kind"] == "parallel":
        return {label: sc["bp"] / 10000 for label, _sid, _y in TENORS}

    return {
        label: _interp(sc["shifts"], yrs) / 10000
        for label, _sid, yrs in TENORS
    }


def headline_bp(scenario_id: str) -> float:
    """The 10Y move, used wherever a scenario needs one number to stand for it."""
    return scenario_shifts(scenario_id).get("10Y", 0.0) * 10000


def describe(scenario_id: str) -> dict:
    sc = SCENARIOS[scenario_id]
    bp = headline_bp(scenario_id)
    return {
        "id": scenario_id,
        "label": sc["label"],
        "band": sc.get("band", "cycle"),
        "driver": sc.get("driver"),
        "headline_bp": round(bp, 1),
        "hypothetical": bool(sc.get("hypothetical")),
        # Beyond ±200bp a per-name rate beta stops transferring: fitted ex-2022 it
        # missed 2022 by 18.6pp on average and flipped sign on MSFT/AAPL/SPG.
        "price_channel_extrapolable": abs(bp) <= 200,
        "beyond_historical_record": abs(bp) >= MAX_OBSERVED_12M_BP,
    }
