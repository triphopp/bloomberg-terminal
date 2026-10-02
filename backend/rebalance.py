"""
Take-profit rebalance — "this winner has grown too big a slice of the book,
take some off", with rules that stop it from firing too often.

Target per holding (no target system needed):
    explicit `allocation_targets` row (scope = symbol) if the user set one,
    else the COST weight — the slice of the book the user chose to put in.
    A run-up inflates the market-value weight above it; that gap is the drift.
    (routers/portfolio_v2.get_allocation_detail computes both weights.)

A holding is a TRIM when ALL of these hold:
    gain      growth_pct ≥ min_gain_pct                  (default 20%)
    band      weight − target > band, where band = min(band_abs_pp, band_rel_pct% × target)
              — the 5/25 rule: 5 points OR 25% of its own target, whichever
              comes first (an explicit target's band_pct wins when set)
    timing    held ≥ min_hold_days since the first lot, ≥ min_gap_days since
              the last sell of that symbol, and not inside the earnings
              blackout (earn_before_days before → earn_after_days after a report)
    size      the trade is at least one board lot

How much: `rebal_to` = "half" (halfway back to target, default — fewer trades),
"band" (back to the edge of the band) or "target". Proceeds go to cash.

Statuses: TRIM (do it) · WAIT (would trim, timing blocks; `ready_on` says when)
· SMALL (under one lot) · WATCH (one condition met, or ≥ 60% of the band used
with the gain there) · OK · SKIP (options / unpriced — no share count).

Pure: no I/O. routers/risk.py GET /risk/rebalance does the I/O. Design source:
memory/plans/investment-policy-system.md §4 (this is its per-holding slice,
before sleeves exist).
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, fields
from datetime import date, timedelta
from typing import Any, Optional

REBAL_TO = ("half", "band", "target")
WATCH_FRACTION = 0.6


@dataclass
class Rules:
    min_gain_pct: float = 20.0
    band_abs_pp: float = 5.0
    band_rel_pct: float = 25.0
    rebal_to: str = "half"
    min_hold_days: int = 30
    min_gap_days: int = 30
    earn_before_days: int = 3
    earn_after_days: int = 5

    @classmethod
    def from_dict(cls, d: Optional[dict]) -> "Rules":
        r = cls()
        for f in fields(cls):
            if d and d.get(f.name) is not None:
                setattr(r, f.name, type(getattr(r, f.name))(d[f.name]))
        r.validate()
        return r

    def validate(self) -> None:
        if self.rebal_to not in REBAL_TO:
            raise ValueError(f"rebal_to must be one of {REBAL_TO}")
        for k in ("min_gain_pct", "band_abs_pp", "band_rel_pct"):
            if getattr(self, k) <= 0:
                raise ValueError(f"{k} must be > 0")
        for k in ("min_hold_days", "min_gap_days", "earn_before_days", "earn_after_days"):
            if getattr(self, k) < 0:
                raise ValueError(f"{k} must be ≥ 0")

    def as_dict(self) -> dict:
        return asdict(self)


def lot_size(row: dict) -> float:
    """Board lot: SET 100, crypto fractional (0), everything else 1 share."""
    sym = str(row.get("yf_symbol") or row.get("resolved_symbol") or row.get("symbol") or "").upper()
    if str(row.get("market") or "").upper() == "TH" or sym.endswith(".BK"):
        return 100
    if sym.endswith(("-USD", "-THB", "-USDT")) or str(row.get("market") or "").upper() == "CRYPTO":
        return 0
    return 1


def _round_shares(raw: float, lot: float, held: float) -> float:
    if raw <= 0:
        return 0.0
    if lot == 0:
        out = math.floor(raw * 1e7) / 1e7
    else:
        out = math.floor(raw / lot + 1e-9) * lot
    return min(out, held)


def _to_date(v: Any) -> Optional[date]:
    if v is None or v == "":
        return None
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def band_for(target_pct: float, rules: Rules, explicit_band: Optional[float] = None) -> float:
    if explicit_band and explicit_band > 0:
        return explicit_band
    return min(rules.band_abs_pp, rules.band_rel_pct / 100 * target_pct)


def _earnings_window(dates: list[date], today: date, rules: Rules) -> Optional[tuple[date, date]]:
    """The blackout window that contains today, if any."""
    for d in sorted(dates):
        lo = d - timedelta(days=rules.earn_before_days)
        hi = d + timedelta(days=rules.earn_after_days)
        if lo <= today <= hi:
            return lo, hi
    return None


def plan(
    symbols: list[dict],
    total_mv: float,
    rules: Rules,
    today: date,
    first_entry: Optional[dict[str, Any]] = None,
    last_sell: Optional[dict[str, Any]] = None,
    earnings: Optional[dict[str, list]] = None,
) -> dict:
    """`symbols` = allocation-detail symbol rows (weight_mv_pct, target_pct,
    target_source, band_pct, growth_pct, unrealized, market_value, volume,
    instrument, priced, …). Timing maps are keyed by the row's `symbol`.
    `earnings[symbol]` = report dates (None = unknown, not "none")."""
    first_entry = first_entry or {}
    last_sell = last_sell or {}
    earnings = earnings or {}
    rows = []
    for s in symbols:
        sym = s["symbol"]
        weight = float(s.get("weight_mv_pct") or 0)
        target = float(s.get("target_pct") or 0)
        explicit = s.get("target_source") == "explicit"
        band = band_for(target, rules, s.get("band_pct") if explicit else None)
        over = weight - target
        gain = s.get("growth_pct")
        mv = s.get("market_value")
        vol = float(s.get("volume") or 0)
        lot = lot_size(s)
        fe, ls = _to_date(first_entry.get(sym)), _to_date(last_sell.get(sym))
        held_days = (today - fe).days if fe else None
        row = {
            "symbol": sym, "yf_symbol": s.get("yf_symbol"), "sector": s.get("sector"),
            "account_id": s.get("account_id"), "weight_pct": round(weight, 2),
            "target_pct": round(target, 2), "target_source": s.get("target_source"),
            "band_pp": round(band, 2), "over_pp": round(over, 2),
            "growth_pct": gain, "unrealized": s.get("unrealized"), "market_value": mv,
            "volume": vol, "price": s.get("price"), "lot_size": lot,
            "first_entry": fe.isoformat() if fe else None, "held_days": held_days,
            "last_sell": ls.isoformat() if ls else None, "earnings_window": None,
            "band_used": round(over / band, 2) if band > 0 else None,
            "gain_used": round(gain / rules.min_gain_pct, 2) if gain is not None else None,
            "status": "OK", "reasons": [], "ready_on": None,
            "sell_shares": 0.0, "sell_value": 0.0, "est_realized": 0.0, "new_weight_pct": round(weight, 2),
        }
        rows.append(row)

        if s.get("instrument") == "option" or mv is None or not s.get("priced", True) or vol <= 0:
            row["status"] = "SKIP"
            row["reasons"].append("ออปชัน / ไม่มีราคา — ไม่คำนวณจำนวนหุ้น")
            continue

        band_hit = band > 0 and over > band
        gain_ok = gain is not None and gain >= rules.min_gain_pct
        if not (band_hit and gain_ok):
            near = gain_ok and band > 0 and over >= WATCH_FRACTION * band
            if band_hit:
                row["status"] = "WATCH"
                row["reasons"].append(
                    f"น้ำหนักเกินเป้า {over:+.1f} จุด แต่กำไร {gain if gain is not None else 0:.1f}% "
                    f"ยังไม่ถึง {rules.min_gain_pct:.0f}%")
            elif near:
                row["status"] = "WATCH"
                row["reasons"].append(
                    f"กำไร {gain:.1f}% แล้ว น้ำหนักเกินเป้า {over:+.1f}/{band:.1f} จุด — ใกล้ถึง band")
            continue

        # Size: back to target, halfway, or the band edge.
        new_w = {"target": target, "half": target + over / 2, "band": target + band}[rules.rebal_to]
        sell_value = (weight - new_w) / 100 * total_mv
        per_share = mv / vol
        shares = _round_shares(sell_value / per_share, lot, vol)
        row["sell_shares"] = shares
        row["sell_value"] = round(shares * per_share, 2)
        row["est_realized"] = round(float(s.get("unrealized") or 0) * shares / vol, 2)
        row["new_weight_pct"] = round(weight - row["sell_value"] / total_mv * 100, 2) if total_mv else weight
        row["reasons"].append(
            f"กำไร {gain:.1f}% · น้ำหนัก {weight:.1f}% เทียบเป้า {target:.1f}% "
            f"({'ที่ตั้งไว้' if explicit else 'ตามเงินที่ลงไป'}) เกิน {over:.1f} จุด > band {band:.1f}")

        waits: list[tuple[str, date]] = []
        if held_days is not None and held_days < rules.min_hold_days:
            waits.append((f"เพิ่งถือ {held_days} วัน (ขั้นต่ำ {rules.min_hold_days})",
                          fe + timedelta(days=rules.min_hold_days)))
        if ls and (today - ls).days < rules.min_gap_days:
            waits.append((f"เพิ่งขายเมื่อ {ls.isoformat()} (เว้น {rules.min_gap_days} วัน)",
                          ls + timedelta(days=rules.min_gap_days)))
        edates = earnings.get(sym)
        if edates:
            win = _earnings_window([d for d in (_to_date(x) for x in edates) if d], today, rules)
            if win:
                row["earnings_window"] = [win[0].isoformat(), win[1].isoformat()]
                waits.append((f"ช่วงประกาศงบ {win[0].isoformat()} – {win[1].isoformat()}",
                               win[1] + timedelta(days=1)))
        elif sym in earnings:
            row["reasons"].append("ไม่ทราบวันประกาศงบ — ตรวจเองก่อนขาย")

        if waits:
            row["status"] = "WAIT"
            row["reasons"] += [w[0] for w in waits]
            row["ready_on"] = max(w[1] for w in waits).isoformat()
        elif shares <= 0:
            row["status"] = "SMALL"
            row["reasons"].append("ขนาดที่ต้องขายเล็กกว่า 1 lot")
        else:
            row["status"] = "TRIM"

    order = {"TRIM": 0, "WAIT": 1, "SMALL": 2, "WATCH": 3, "OK": 4, "SKIP": 5}
    rows.sort(key=lambda r: (order[r["status"]], -(r["over_pp"] or 0)))
    trims = [r for r in rows if r["status"] == "TRIM"]
    return {
        "rules": rules.as_dict(),
        "as_of": today.isoformat(),
        "total_value": round(total_mv, 2),
        "rows": rows,
        "counts": {k: sum(1 for r in rows if r["status"] == k) for k in order},
        "sell_value": round(sum(r["sell_value"] for r in trims), 2),
        "est_realized": round(sum(r["est_realized"] for r in trims), 2),
        # Ready for WHAT-IF: symbol → shares to sell (split across accounts by the UI).
        "trades": [{"symbol": r["symbol"], "delta_shares": -r["sell_shares"]} for r in trims],
    }
