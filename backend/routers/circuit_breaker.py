"""
Layer 4 — Circuit Breaker simulator.
Individual stock halt tiers, market-wide index halt levels,
and countercyclical margin requirement calculations.
"""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Query

router = APIRouter()


# ── Individual Stock Halt (4A) ────────────────────────────────────────────────

def _stock_halt_tier(pct_change: float) -> dict:
    abs_pct = abs(pct_change)
    direction = "DOWN" if pct_change < 0 else "UP"
    if abs_pct >= 20:
        return {"tier": 3, "halt_duration_min": None, "halt_label": "SESSION HALT",
                "trigger_reason": f"{direction} {abs_pct:.1f}% ≥ ±20% threshold"}
    if abs_pct >= 10:
        return {"tier": 2, "halt_duration_min": 10, "halt_label": "10-MIN HALT",
                "trigger_reason": f"{direction} {abs_pct:.1f}% ≥ ±10% threshold"}
    if abs_pct >= 5:
        return {"tier": 1, "halt_duration_min": 5, "halt_label": "5-MIN HALT",
                "trigger_reason": f"{direction} {abs_pct:.1f}% ≥ ±5% threshold"}
    return {"tier": 0, "halt_duration_min": 0, "halt_label": "NO HALT",
            "trigger_reason": f"Move {abs_pct:.1f}% within ±5% normal range"}


@router.get("/api/circuit-breaker/check")
def circuit_breaker_check(
    symbol:      str   = Query(...),
    price:       float = Query(...),
    prior_close: float = Query(...),
):
    """Individual stock price-halt check."""
    if prior_close <= 0:
        return {"error": "prior_close must be > 0"}
    pct_change = (price - prior_close) / prior_close * 100
    halt = _stock_halt_tier(pct_change)
    return {
        "symbol":          symbol.upper(),
        "price":           price,
        "prior_close":     prior_close,
        "pct_change":      round(pct_change, 2),
        **halt,
        "as_of":           datetime.utcnow().isoformat() + "Z",
    }


# ── Market-Wide Index Halt (4B) ───────────────────────────────────────────────

def _market_halt_level(drop_pct: float, time_str: Optional[str]) -> dict:
    """
    drop_pct: negative means market dropped (e.g. -8.0 for 8% drop).
    time_str: "HH:MM" 24h format (market local time). Used to check L3 block.
    """
    abs_drop = abs(drop_pct) if drop_pct < 0 else drop_pct

    # Parse time for L3 block check (L3 blocked in last 35 min of session)
    session_close_min = 16 * 60  # 16:00 default
    current_min = None
    if time_str:
        try:
            h, m = map(int, time_str.split(":"))
            current_min = h * 60 + m
        except Exception:
            pass

    level3_blocked = False
    if current_min is not None:
        level3_blocked = current_min >= (session_close_min - 35)

    if abs_drop >= 20:
        if level3_blocked:
            return {
                "level": "L3_BLOCKED",
                "halt_duration_min": None,
                "halt_label": "L3 BLOCKED (too close to close)",
                "trigger_reason": f"Index −{abs_drop:.1f}% triggers L3, but blocked (< 35 min to session close)",
                "level3_blocked": True,
            }
        return {
            "level": "L3",
            "halt_duration_min": None,
            "halt_label": "SESSION HALT",
            "trigger_reason": f"Index −{abs_drop:.1f}% ≥ 20% — Level 3 halt",
            "level3_blocked": level3_blocked,
        }
    if abs_drop >= 13:
        return {
            "level": "L2",
            "halt_duration_min": 15,
            "halt_label": "15-MIN HALT",
            "trigger_reason": f"Index −{abs_drop:.1f}% ≥ 13% — Level 2 halt",
            "level3_blocked": level3_blocked,
        }
    if abs_drop >= 7:
        return {
            "level": "L1",
            "halt_duration_min": 15,
            "halt_label": "15-MIN HALT",
            "trigger_reason": f"Index −{abs_drop:.1f}% ≥ 7% — Level 1 halt",
            "level3_blocked": level3_blocked,
        }
    return {
        "level": "NONE",
        "halt_duration_min": 0,
        "halt_label": "NO HALT",
        "trigger_reason": f"Index move −{abs_drop:.1f}% below all halt thresholds (L1: 7%, L2: 13%, L3: 20%)",
        "level3_blocked": level3_blocked,
    }


@router.get("/api/circuit-breaker/market")
def circuit_breaker_market(
    index_value: float          = Query(...),
    prior_close: float          = Query(...),
    time:        Optional[str]  = Query(None, description="Current time HH:MM (24h)"),
):
    """Market-wide index circuit breaker check."""
    if prior_close <= 0:
        return {"error": "prior_close must be > 0"}
    drop_pct = (index_value - prior_close) / prior_close * 100
    halt = _market_halt_level(drop_pct, time)
    return {
        "index_value": index_value,
        "prior_close": prior_close,
        "drop_pct":    round(drop_pct, 2),
        **halt,
        "as_of":       datetime.utcnow().isoformat() + "Z",
    }


# ── Countercyclical Margin Requirement (4C) ───────────────────────────────────

def _margin_calculation(cape: Optional[float], vix: Optional[float]) -> dict:
    base_margin = 0.25

    if cape is None:
        multiplier = 1.0
        cape_label = "N/A"
    elif cape < 25:
        multiplier = 1.0
        cape_label = "NORMAL"
    elif cape < 30:
        multiplier = 1.25
        cape_label = "ELEVATED"
    elif cape < 40:
        multiplier = 1.5
        cape_label = "HIGH"
    else:
        multiplier = 2.0
        cape_label = "EXTREME"

    if vix is None:
        addon = 0.0
        vix_label = "N/A"
    elif vix > 40:
        addon = 0.10
        vix_label = "EXTREME"
    elif vix > 30:
        addon = 0.05
        vix_label = "ELEVATED"
    else:
        addon = 0.0
        vix_label = "NORMAL"

    required = min((base_margin * multiplier) + addon, 0.75)
    pct_above_base = round((required / base_margin - 1) * 100, 0)

    level_label = "NORMAL" if required <= 0.25 else \
                  "ELEVATED" if required <= 0.375 else \
                  "HIGH" if required <= 0.50 else "EXTREME"

    return {
        "base_margin_pct":     round(base_margin * 100, 1),
        "required_margin_pct": round(required * 100, 1),
        "multiplier":          multiplier,
        "addon_pct":           round(addon * 100, 1),
        "cape_regime":         cape_label,
        "vix_regime":          vix_label,
        "level":               level_label,
        "pct_above_base":      pct_above_base,
        "rationale": (
            f"Base {base_margin*100:.0f}% × {multiplier}× (CAPE {cape_label})"
            f" + {addon*100:.0f}% (VIX {vix_label})"
            f" = {required*100:.1f}%"
        ),
    }


@router.get("/api/circuit-breaker/margin")
def circuit_breaker_margin(
    cape: Optional[float] = Query(None, description="Shiller CAPE ratio"),
    vix:  Optional[float] = Query(None, description="VIX level"),
):
    """
    Countercyclical margin requirement.
    If cape/vix not provided, fetches live values from the crisis composite cache.
    """
    # Auto-fetch from crisis cache if not supplied
    if cape is None or vix is None:
        try:
            from routers.crisis import _load_credit_cache
            cache = _load_credit_cache()
            if cape is None and cache.get("cape"):
                cape = cache["cape"].get("v")
            if vix is None and cache.get("vix"):
                vix = cache["vix"].get("v")
        except Exception:
            pass

    margin = _margin_calculation(cape, vix)
    return {
        "cape": cape,
        "vix":  vix,
        **margin,
        "as_of": datetime.utcnow().isoformat() + "Z",
    }
