"""
Sector Confluence Engine — combine BC + MOM + VAL + F into ranked signal.

Features:
  - Weighted sum with volatility brake (VIX > 35)
  - Conflict detection (MOM vs VAL, BC vs MOM)
  - 5-tier classification (STRONG_OW through STRONG_UW)
  - Versioned output payload

References:
  Moreira & Muir (2017) — Volatility-Managed Portfolios (brake)
  Ilmanen & Kizer (2012) — The Death of Diversification (weights)
"""
from __future__ import annotations

import threading
import time
from datetime import datetime
from typing import Any

import numpy as np

from sources import market_data

from .sector_bc import SECTOR_ETFS, SECTOR_NAMES, compute_bc, clear_bc_cache
from .sector_mom import compute_momentum, clear_momentum_cache
from .sector_val import compute_valuation, clear_valuation_cache
from .sector_factor import compute_factor, clear_factor_cache

# ── Weights ────────────────────────────────────────────────────────────────────

W_NORMAL: dict[str, float] = {"BC": 0.30, "MOM": 0.35, "VAL": 0.20, "F": 0.15}
W_CRISIS: dict[str, float] = {"BC": 0.35, "MOM": 0.15, "VAL": 0.30, "F": 0.20}

# ── Cache ──────────────────────────────────────────────────────────────────────

_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()
CACHE_TTL = 300  # 5 min — wraps per-layer caches


# ── Helpers ────────────────────────────────────────────────────────────────────

def _get_vix() -> float | None:
    """Fetch current VIX level."""
    try:
        detail = market_data.get_info("^VIX")
        return detail.regular_market_price
    except Exception:
        return None


def _classify(score: float) -> str:
    if score >= 0.60:
        return "STRONG_OVERWEIGHT"
    if score >= 0.25:
        return "OVERWEIGHT"
    if score >= -0.25:
        return "NEUTRAL"
    if score >= -0.60:
        return "UNDERWEIGHT"
    return "STRONG_UNDERWEIGHT"


# ── Main computation ───────────────────────────────────────────────────────────

def compute_sector_signal() -> dict[str, Any]:
    """Full sector ranking with layer decomposition."""
    now = time.time()
    with _cache_lock:
        if "signal" in _cache:
            ts, val = _cache["signal"]
            if now - ts < CACHE_TTL:
                return val

    # Compute all 4 layers (each has its own cache)
    bc  = compute_bc()
    mom = compute_momentum()
    val = compute_valuation()
    fac = compute_factor()

    # ── Volatility brake ──────────────────────────────────────────────────
    vix = _get_vix()
    brake_active = vix is not None and vix > 35
    weights = W_CRISIS if brake_active else W_NORMAL

    # ── Weighted sum ──────────────────────────────────────────────────────
    scores: dict[str, float] = {}
    for s in SECTOR_ETFS:
        bc_z  = bc.get("sectors", {}).get(s, {}).get("z_score", 0.0)
        mom_z = mom.get(s, {}).get("z_score", 0.0)
        val_z = val.get(s, {}).get("z_score", 0.0)
        fac_z = fac.get("sectors", {}).get(s, {}).get("z_score", 0.0)

        scores[s] = round(
            weights["BC"]  * bc_z
            + weights["MOM"] * mom_z
            + weights["VAL"] * val_z
            + weights["F"]   * fac_z,
            4,
        )

    # ── Rank ──────────────────────────────────────────────────────────────
    ranked = sorted(SECTOR_ETFS, key=lambda s: scores[s], reverse=True)

    # ── Conflict detection ────────────────────────────────────────────────
    top_mom_ticker = max(SECTOR_ETFS,
                         key=lambda s: mom.get(s, {}).get("z_score", 0.0))
    top_val_ticker = max(SECTOR_ETFS,
                         key=lambda s: val.get(s, {}).get("z_score", 0.0))
    mom_val_conflict = (
        top_mom_ticker != top_val_ticker
        and scores[top_mom_ticker] > 0.3
        and scores[top_val_ticker] > 0.3
    )

    bc_mom_conflicts: list[str] = []
    for s in SECTOR_ETFS:
        bc_z  = bc.get("sectors", {}).get(s, {}).get("z_score", 0.0)
        mom_z = mom.get(s, {}).get("z_score", 0.0)
        if (np.sign(bc_z) != np.sign(mom_z)
                and abs(bc_z) > 0.3
                and abs(mom_z) > 0.3):
            bc_mom_conflicts.append(s)

    # ── Build output ──────────────────────────────────────────────────────
    result: dict[str, Any] = {
        "version": "1.0",
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "cycle_phase": bc.get("phase_label", "UNKNOWN"),
        "cycle_score": bc.get("cycle_score", 0.0),
        "cycle_probabilities": bc.get("probabilities", {}),
        "vix": round(vix, 1) if vix is not None else None,
        "volatility_brake_active": brake_active,
        "weights_used": weights,
        "sectors": [
            {
                "ticker":         s,
                "name":           SECTOR_NAMES.get(s, s),
                "rank":           ranked.index(s) + 1,
                "sector_score":   scores[s],
                "classification": _classify(scores[s]),
                "layers": {
                    "BC":  bc.get("sectors", {}).get(s, {}),
                    "MOM": mom.get(s, {}),
                    "VAL": val.get(s, {}),
                    "F":   fac.get("sectors", {}).get(s, {}),
                },
            }
            for s in ranked
        ],
        "macro_factors": fac.get("factors", {}),
        "conflicts": {
            "mom_val_divergence": mom_val_conflict,
            "top_momentum_sector": top_mom_ticker,
            "top_valuation_sector": top_val_ticker,
            "bc_mom_conflicts": bc_mom_conflicts,
        },
    }

    with _cache_lock:
        _cache["signal"] = (now, result)
    return result


def clear_confluence_cache() -> None:
    """Clear confluence cache + all underlying layer caches."""
    with _cache_lock:
        _cache.clear()
    clear_bc_cache()
    clear_momentum_cache()
    clear_valuation_cache()
    clear_factor_cache()
