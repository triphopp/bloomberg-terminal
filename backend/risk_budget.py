"""
Risk budget — how much of the book's risk each bucket may use, against how much
it does use.

Money weight is not risk weight: a 10% holding that is volatile and moves with
the rest of the book can be 30% of the book's risk. A budget is the share of
TOTAL risk the user allows a bucket; this module measures the share in use and
says how far a bucket has to shrink (or may grow) to sit on its budget.

Risk in use = Euler contribution to volatility:
    RC_i = w_i · (Σw)_i / σ_p ,   Σ RC_i = σ_p
so the shares add to 100% with nothing left over. A holding that moves against
the book has a negative share — it is the hedge.

Buckets (`scope`): "symbol" · "sector" · "thesis" (holdings with no thesis fall
in NONE_KEY). A budget is a percent of total risk per bucket key; they need not
add to 100 — the remainder is `unallocated_pct` — but may not exceed it.

Status per bucket, with `band_pp` points of tolerance:
    OVER   in use − budget > band      → `trim_value`: sell this much, to cash
    UNDER  budget − in use > band      → `add_value`: room for this much more
    OK     inside the band
    UNSET  holdings, no budget         EMPTY  budget, no holdings

`trim_value` is solved, not pro-rated: shrinking one bucket lowers the book's
volatility too, so its share falls more slowly than its size. Each bucket is
solved with the others held where they are — do them one at a time.

`vol_cap_pct` is the budget for the whole book (annual volatility). Over it,
`derisk_pct` is the fraction of every risky holding to move to cash.

Nothing here trades and nothing sets a budget: only the user does
(PUT /risk/budget). Pure: no I/O. routers/risk.py does the I/O. Same weights
and covariance as the RISK tab's risk contribution column.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Optional

import numpy as np

SCOPES = ("symbol", "sector", "thesis")
# Targets can also be kept per ACCOUNT (the book seen as its sub-portfolios).
# Only the balance plan reads them (risk_balance.py / GET /risk/balance); the
# budget table above is not built per account, so `plan` keeps to SCOPES.
TARGET_SCOPES = SCOPES + ("account",)
NONE_KEY = "_none"
SCALE_MAX = 20.0
_STATUS_ORDER = {"OVER": 0, "UNDER": 1, "OK": 2, "UNSET": 3, "EMPTY": 4}


@dataclass
class Budget:
    vol_cap_pct: Optional[float] = None
    band_pp: float = 2.0
    symbol: dict[str, float] = field(default_factory=dict)
    sector: dict[str, float] = field(default_factory=dict)
    thesis: dict[str, float] = field(default_factory=dict)
    account: dict[str, float] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Optional[dict]) -> "Budget":
        d = d or {}
        b = cls()
        if d.get("vol_cap_pct") is not None:
            b.vol_cap_pct = float(d["vol_cap_pct"])
        if d.get("band_pp") is not None:
            b.band_pp = float(d["band_pp"])
        for scope in TARGET_SCOPES:
            raw = d.get(scope) or {}
            if not isinstance(raw, dict):
                raise ValueError(f"{scope} must be an object of key → percent")
            setattr(b, scope, {str(k): float(v) for k, v in raw.items() if v is not None})
        b.validate()
        return b

    def validate(self) -> None:
        if self.vol_cap_pct is not None and not self.vol_cap_pct > 0:
            raise ValueError("vol_cap_pct must be > 0")
        if not 0 <= self.band_pp <= 50:
            raise ValueError("band_pp must be between 0 and 50")
        for scope in TARGET_SCOPES:
            pcts = self.of(scope)
            if any(not (0 <= v <= 100) or not math.isfinite(v) for v in pcts.values()):
                raise ValueError(f"{scope} budgets must be between 0 and 100")
            total = sum(pcts.values())
            if total > 100 + 1e-6:
                raise ValueError(f"{scope} budgets add up to {total:.1f}% — more than 100%")

    def of(self, scope: str) -> dict[str, float]:
        return getattr(self, scope)

    def as_dict(self) -> dict:
        return {"vol_cap_pct": self.vol_cap_pct, "band_pp": self.band_pp,
                **{s: dict(self.of(s)) for s in TARGET_SCOPES}}


def contributions(w: np.ndarray, cov: np.ndarray) -> tuple[np.ndarray, float]:
    """(risk contribution per holding, book volatility) — same units as √cov."""
    sigma = float(np.sqrt(max(float(w @ cov @ w), 0.0)))
    if sigma <= 0:
        return np.zeros_like(w, dtype=float), 0.0
    return w * (cov @ w) / sigma, sigma


def share_of(w: np.ndarray, cov: np.ndarray, idx: list[int]) -> float:
    """Fraction of book variance carried by the holdings at `idx`."""
    var = float(w @ cov @ w)
    return float((w[idx] * (cov @ w)[idx]).sum() / var) if var > 0 else 0.0


def scale_for_share(w: np.ndarray, cov: np.ndarray, idx: list[int], target: float) -> Optional[float]:
    """Multiple k of the bucket's size at which it carries `target` of book risk,
    the other holdings unchanged. None when no size gets there (it is the whole
    book, or the target is out of reach)."""
    if not 0 < target < 1:
        return None

    def gap(k: float) -> float:
        v = w.astype(float).copy()
        v[idx] = v[idx] * k
        return share_of(v, cov, idx) - target

    lo, hi = 0.0, 1.0
    if gap(1.0) < 0:                       # under budget: look above the current size
        lo = 1.0
        while hi < SCALE_MAX and gap(hi) < 0:
            hi = min(hi * 2.0, SCALE_MAX)
        if gap(hi) < 0:
            return None
    elif gap(1e-9) >= 0:                   # still over at (almost) nothing: no root
        return None
    for _ in range(60):
        mid = (lo + hi) / 2.0
        if gap(mid) < 0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


def _status(used: float, budget: Optional[float], band: float) -> str:
    if budget is None:
        return "UNSET"
    if used - budget > band:
        return "OVER"
    if budget - used > band:
        return "UNDER"
    return "OK"


def plan(items: list[dict[str, Any]], cov: np.ndarray, budget: Budget, scope: str,
         nav: float = 0.0) -> dict:
    """`items`: one per row of `cov`, each {symbol, weight, value, key, label}
    (+ optional `meta` copied to its bucket). `weight` is the NAV weight."""
    if scope not in SCOPES:
        raise ValueError(f"scope must be one of {SCOPES}")
    w = np.array([float(it["weight"]) for it in items], dtype=float)
    rc, sigma = contributions(w, cov)
    share = rc / sigma * 100.0 if sigma > 0 else np.zeros_like(w)
    vol_annual = sigma * math.sqrt(252) * 100.0
    budgets = budget.of(scope)
    band = budget.band_pp

    buckets: dict[str, dict] = {}
    for i, it in enumerate(items):
        b = buckets.setdefault(str(it["key"]), {"label": it.get("label") or it["key"],
                                                "idx": [], "meta": it.get("meta") or {}})
        b["idx"].append(i)

    rows = []
    for key, b in buckets.items():
        idx = b["idx"]
        used = float(share[idx].sum())
        value = float(sum(items[i]["value"] for i in idx))
        bud = budgets.get(key)
        status = _status(used, bud, band)
        row = {
            "key": key, "label": b["label"], **b["meta"],
            "n": len(idx),
            "weight_pct": round(float(w[idx].sum()) * 100, 2),
            "value": round(value, 2),
            "risk_pct": round(used, 2),
            "risk_vol_pp": round(float(rc[idx].sum()) * math.sqrt(252) * 100, 2),
            "budget_pct": bud,
            "over_pp": round(used - bud, 2) if bud is not None else None,
            "status": status,
            "trim_pct": None, "trim_value": None, "add_value": None,
            "members": sorted(
                ({"symbol": items[i]["symbol"], "weight_pct": round(float(w[i]) * 100, 2),
                  "risk_pct": round(float(share[i]), 2), "value": round(float(items[i]["value"]), 2)}
                 for i in idx),
                key=lambda m: -m["risk_pct"],
            ),
        }
        if status in ("OVER", "UNDER") and value > 0 and len(buckets) > 1:
            k = scale_for_share(w, cov, idx, bud / 100.0)
            if k is not None and status == "OVER" and k < 1:
                row["trim_pct"] = round((1 - k) * 100, 1)
                row["trim_value"] = round((1 - k) * value, 2)
            elif k is not None and status == "UNDER" and k > 1:
                row["add_value"] = round((k - 1) * value, 2)
        rows.append(row)

    for key, bud in budgets.items():
        if key not in buckets and bud > 0:
            rows.append({
                "key": key, "label": key, "n": 0, "weight_pct": 0.0, "value": 0.0,
                "risk_pct": 0.0, "risk_vol_pp": 0.0, "budget_pct": bud, "over_pp": -bud,
                "status": "EMPTY", "trim_pct": None, "trim_value": None, "add_value": None,
                "members": [],
            })

    rows.sort(key=lambda r: (_STATUS_ORDER[r["status"]], -(r["over_pp"] or 0.0), -r["risk_pct"]))
    counts = {s: sum(r["status"] == s for r in rows) for s in _STATUS_ORDER}
    budget_total = float(sum(budgets.values()))

    cap = budget.vol_cap_pct
    vol = {"used_pct": round(vol_annual, 2), "cap_pct": cap, "status": "UNSET",
           "derisk_pct": None, "derisk_value": None}
    if cap is not None:
        vol["status"] = "OVER" if vol_annual > cap else "OK"
        if vol_annual > cap > 0:
            cut = 1.0 - cap / vol_annual
            vol["derisk_pct"] = round(cut * 100, 1)
            vol["derisk_value"] = round(cut * float(sum(abs(float(it["value"])) for it in items)), 2)

    return {
        "scope": scope,
        "nav": round(float(nav), 2),
        "band_pp": band,
        "vol": vol,
        "budget_total_pct": round(budget_total, 2),
        "unallocated_pct": round(100.0 - budget_total, 2),
        "rows": rows,
        "counts": counts,
    }
