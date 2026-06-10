"""
Confluence Engine — combine A, B, C layer scores into an allocation signal.

Equal-weight sum (baseline) + weighted version.
Regime detection + conflict detection.
"""
from typing import Any


# Layer weights based on reliability (Ilmanen & Kizer 2012):
# Structural > Flow > Sentiment
WEIGHTS = {"C": 0.40, "B": 0.35, "A": 0.25}

# Regime thresholds for weighted score (range -1.0 to +1.0)
REGIME_THRESHOLDS = {
    "STRONG_RISK_ON":  0.67,
    "MILD_RISK_ON":    0.33,
    "NEUTRAL":         0.0,
    "MILD_RISK_OFF":  -0.33,
    "STRONG_RISK_OFF": -0.67,
}


def _detect_conflict(a_score: int, b_score: int, c_score: int) -> bool:
    """Conflict = at least one layer positive AND at least one negative."""
    scores = [a_score, b_score, c_score]
    return max(scores) > 0 and min(scores) < 0


def _detect_regime(weighted_score: float) -> str:
    if weighted_score >= REGIME_THRESHOLDS["STRONG_RISK_ON"]:
        return "STRONG_RISK_ON"
    if weighted_score >= REGIME_THRESHOLDS["MILD_RISK_ON"]:
        return "MILD_RISK_ON"
    if weighted_score >= REGIME_THRESHOLDS["NEUTRAL"]:
        return "NEUTRAL"
    if weighted_score >= REGIME_THRESHOLDS["MILD_RISK_OFF"]:
        return "MILD_RISK_OFF"
    return "STRONG_RISK_OFF"


def compute_confluence(
    layer_a: dict[str, Any],
    layer_b: dict[str, Any],
    layer_c: dict[str, Any],
) -> dict[str, Any]:
    """
    Combine A, B, C scores into a confluence signal.

    Returns a dict with equal score, weighted score, regime, conflict flag,
    and full layer details suitable for storage and API response.
    """
    a_score = layer_a.get("score", 0)
    b_score = layer_b.get("score", 0)
    c_score = layer_c.get("score", 0)

    equal_score = a_score + b_score + c_score  # range -3 to +3
    weighted_score = (
        WEIGHTS["A"] * a_score +
        WEIGHTS["B"] * b_score +
        WEIGHTS["C"] * c_score
    )  # range -1.0 to +1.0

    conflict = _detect_conflict(a_score, b_score, c_score)
    regime = _detect_regime(weighted_score)

    # If conflicting, override to NEUTRAL (do not act)
    if conflict:
        regime = "NEUTRAL"

    # Recommendation
    if weighted_score >= 0.67:
        recommendation = "Increase equity allocation by 5-10%"
    elif weighted_score >= 0.33:
        recommendation = "Maintain or slightly increase equity"
    elif weighted_score >= -0.33:
        recommendation = "No change — neutral signal"
    elif weighted_score >= -0.67:
        recommendation = "Reduce equity by 5%"
    else:
        recommendation = "Reduce equity by 10-15%"

    if conflict:
        recommendation = "CONFLICT — do not act, wait for alignment"

    return {
        "equal_score": equal_score,
        "weighted_score": round(weighted_score, 6),
        "regime": regime,
        "conflict": conflict,
        "recommendation": recommendation,
        "layers": {
            "A": {
                "score": a_score,
                "z_score": layer_a.get("z_score", 0.0),
                "r_rel_20d": layer_a.get("r_rel_20d", 0.0),
                "r_equity_20d": layer_a.get("r_equity_20d", 0.0),
                "r_bond_20d": layer_a.get("r_bond_20d", 0.0),
                "realized_vol": layer_a.get("realized_vol"),
                "freshness": "realtime",
            },
            "B": {
                "score": b_score,
                "z_score": layer_b.get("z_score", 0.0),
                "flow_ratio": layer_b.get("flow_ratio", 0.0),
                "equity_flow_20d": layer_b.get("equity_flow_20d", 0.0),
                "bond_flow_20d": layer_b.get("bond_flow_20d", 0.0),
                "method": layer_b.get("method", "price_adjusted_aum"),
                "freshness": "1d",
            },
            "C": {
                "score": c_score,
                "z_score": layer_c.get("z_score", 0.0),
                "equity_share": layer_c.get("equity_share", 0.0),
                "mu_C": layer_c.get("mu_C", 0.0),
                "sigma_C": layer_c.get("sigma_C", 0.0),
                "freshness": layer_c.get("freshness", "unknown"),
            },
        },
    }
