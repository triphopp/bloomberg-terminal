"""
Trade guard — zero-math risk rules for a fast-turnover book.

PORT → RISK used to measure risk only as statistics of the CURRENT basket
(VaR / CVaR over 252 days). A book whose median closed trade lasts 14 days
needs rules that live at the TRADE level instead: every position gets a stop
without the user typing one, a time stop, a size cap and a sector cap, and the
whole book gets one traffic light.

Rules (all constants below — the numbers are starting defaults, not research):
    stop      manual `price_stoploss` if set; else entry × (1 − 2×ATR14% at the
              entry date), the distance clamped to 5–12%; no history → 8%.
              The stop is anchored to the ENTRY, so it never drifts with today's
              volatility.
    STOP_HIT  price ≤ stop                                              → RED
    NEAR_STOP price within the last third of the entry→stop distance    → YELLOW
    TIME      held ≥ 28 days and up < +2% (a short trade turning into a
              long hold); strategies in LONG_HORIZON_STRATEGIES exempt  → YELLOW
    OVERWEIGHT one symbol > 10% of the invested book                   → YELLOW
    SECTOR    one sector > 25% of the invested book                     → YELLOW
    DAY_LOSS  book down ≥ 2% since the previous close                   → RED
    DD_HALF   REAL NAV index ≤ −5% from its 1y peak → half size          → YELLOW
    DD_STOP   ≤ −10% → no new trades (size ×0)                           → RED
    STREAK    ≥ 4 consecutive losing closes → half size                  → YELLOW

HOLD (`overrides`) records "hold anyway" with a reason for one holding period;
its codes stay on the row but the action drops to INFO and leaves the light —
until its review date (default HOLD_REVIEW_DAYS after it was made) or until
price breaks its floor (the UI proposes one more R below where price is when
the HOLD is made; a hold saved without a floor has only its review date). Then
the codes come back at full level: a hold is a decision to re-check, not a
permanent mute.

Missing data never reads as safe: a holding without a live price, an entry or
with a short volume becomes a DATA action (YELLOW), and an unknown NAV drawdown
halves the size.

Also here: S/M/L pre-trade sizing (`size_buckets`, 3/6/10% of NAV × the size
multiplier), the R-multiple after-trade report (`trade_report`) and the flag
transitions the notifier turns into alert events (`transitions`).

Weights are of the INVESTED market value (cash excluded) — the same base the
VaR panel uses; sizing uses invested + cash. Long positions only: a short lot
is reported in `skipped`.

Pure functions; `routers/risk.py` (/risk/guard*) and `guard_scheduler.py` do the I/O.
"""
from __future__ import annotations

from datetime import date
from typing import Any, Iterable, Optional

import pandas as pd

from sector_map import to_gics

ATR_PERIOD = 14
STOP_ATR_MULT = 2.0
STOP_MIN_PCT = 0.05
STOP_MAX_PCT = 0.12
STOP_DEFAULT_PCT = 0.08
NEAR_STOP_FRACTION = 1 / 3
TIME_STOP_DAYS = 28
TIME_STOP_MIN_GAIN = 0.02
MAX_WEIGHT = 0.10
MAX_SECTOR = 0.25
DAY_LOSS_LIMIT = 0.02
DD_HALF = 0.05          # NAV drawdown from peak -> new trades at half size
DD_STOP = 0.10          # -> no new trades
LOSS_STREAK = 4         # consecutive losing closes -> half size
HOLD_REVIEW_DAYS = 14   # a HOLD without an explicit review date expires after this
SIZE_BUCKETS = {"S": 0.03, "M": 0.06, "L": 0.10}

LONG_HORIZON_STRATEGIES = {"value", "core", "dividend", "long term", "long-term", "income"}
UNCLASSIFIED = "Unclassified"

RULES = {
    "stop_atr_mult": STOP_ATR_MULT,
    "stop_min_pct": STOP_MIN_PCT * 100,
    "stop_max_pct": STOP_MAX_PCT * 100,
    "stop_default_pct": STOP_DEFAULT_PCT * 100,
    "near_stop_fraction": round(NEAR_STOP_FRACTION, 4),
    "time_stop_days": TIME_STOP_DAYS,
    "time_stop_min_gain_pct": TIME_STOP_MIN_GAIN * 100,
    "max_weight_pct": MAX_WEIGHT * 100,
    "max_sector_pct": MAX_SECTOR * 100,
    "day_loss_limit_pct": DAY_LOSS_LIMIT * 100,
    "dd_half_pct": DD_HALF * 100,
    "dd_stop_pct": DD_STOP * 100,
    "loss_streak": LOSS_STREAK,
    "hold_review_days": HOLD_REVIEW_DAYS,
    "size_buckets_pct": {k: v * 100 for k, v in SIZE_BUCKETS.items()},
}


def fmt_px(x: float) -> str:
    """House price format: ≥2 decimals, up to 4 below 1."""
    if abs(x) >= 1:
        return f"{x:,.2f}"
    s = f"{x:.4f}"
    while s.endswith("0") and len(s.split(".")[1]) > 2:
        s = s[:-1]
    return s


def atr_pct_asof(frame: Optional[pd.DataFrame], asof: Optional[str]) -> Optional[float]:
    """ATR(14) as a FRACTION of the close, measured on the last bar ≤ `asof`.

    The stop is set once at entry, so it uses the volatility the trade was
    entered into. An entry older than the history (or no date) falls back to the
    latest bar rather than to nothing.
    """
    if frame is None or frame.empty or not {"High", "Low", "Close"} <= set(frame.columns):
        return None
    df = frame[["High", "Low", "Close"]].dropna()
    if asof:
        try:
            cut = pd.Timestamp(asof[:10])
            idx = df.index.tz_localize(None) if getattr(df.index, "tz", None) is not None else df.index
            upto = df[idx <= cut]
            if len(upto) >= ATR_PERIOD + 1:
                df = upto
        except (ValueError, TypeError):
            pass
    if len(df) < ATR_PERIOD + 1:
        return None
    close = df["Close"].astype(float)
    prev = close.shift(1)
    tr = pd.concat(
        [df["High"].astype(float) - df["Low"].astype(float),
         (df["High"].astype(float) - prev).abs(),
         (df["Low"].astype(float) - prev).abs()],
        axis=1,
    ).max(axis=1)
    atr = float(tr.ewm(alpha=1 / ATR_PERIOD, adjust=False).mean().iloc[-1])
    last = float(close.iloc[-1])
    return atr / last if last > 0 else None


def auto_stop(entry: float, atr_frac: Optional[float]) -> tuple[float, float, str]:
    """(stop price, distance as a fraction of entry, source)."""
    if atr_frac is None or atr_frac <= 0:
        dist, src = STOP_DEFAULT_PCT, "DEFAULT"
    else:
        dist, src = min(max(STOP_ATR_MULT * atr_frac, STOP_MIN_PCT), STOP_MAX_PCT), "ATR"
    return entry * (1 - dist), dist, src


def _days_between(start: Optional[str], today: date) -> Optional[int]:
    if not start:
        return None
    try:
        return (today - date.fromisoformat(start[:10])).days
    except ValueError:
        return None


def _is_long_horizon(strategy: Optional[str]) -> bool:
    s = (strategy or "").strip().lower()
    return bool(s) and any(k in s for k in LONG_HORIZON_STRATEGIES)


def aggregate_lots(lots: Iterable[dict]) -> list[dict]:
    """Open lots → one row per (account, yf_symbol).

    Lot dicts need: account_id, symbol, yf_symbol, price_entry, volume,
    date_entry, sector, strategy_name, price_stoploss, currency.
    Entry = volume-weighted; held-since = the FIRST lot (averaging down does not
    reset the clock); manual stop = the highest one set on any lot; sector =
    the GICS name (sector_map.to_gics) carrying most of the volume; strategy
    from the first lot that names one.
    """
    groups: dict[tuple[str, str], dict] = {}
    for lot in sorted(lots, key=lambda r: str(r.get("date_entry") or "")):
        key = (str(lot.get("account_id") or ""), str(lot["yf_symbol"]))
        vol = float(lot.get("volume") or 0)
        px = float(lot.get("price_entry") or 0)
        g = groups.setdefault(key, {
            "account_id": key[0], "symbol": lot.get("symbol"), "yf_symbol": key[1],
            "currency": lot.get("currency"), "volume": 0.0, "_cost": 0.0,
            "first_entry": lot.get("date_entry"), "sector": None, "strategy": None,
            "manual_stop": None, "_sectors": {},
        })
        g["volume"] += vol
        g["_cost"] += px * vol
        if (lot.get("sector") or "").strip():
            sec = to_gics(lot["sector"])
            g["_sectors"][sec] = g["_sectors"].get(sec, 0.0) + abs(vol)
        if not g["strategy"] and (lot.get("strategy_name") or "").strip():
            g["strategy"] = lot["strategy_name"].strip()
        sl = lot.get("price_stoploss")
        if sl is not None and float(sl) > 0:
            g["manual_stop"] = max(float(sl), g["manual_stop"] or 0.0)
    out = []
    for g in groups.values():
        vol = g["volume"]
        g["entry_price"] = g.pop("_cost") / vol if vol else 0.0
        secs = g.pop("_sectors")
        # Lots of one holding were tagged at different times with different
        # spellings (GOOGL: TECH ×1, Communication Services ×4) — the label
        # carried by most of the volume wins, in GICS vocabulary.
        g["sector"] = max(secs, key=secs.get) if secs else None
        out.append(g)
    return out


def _action(level: str, code: str, symbol: Optional[str], text: str,
            key: Optional[dict] = None) -> dict:
    a = {"level": level, "code": code, "symbol": symbol, "text": text}
    if key:
        a.update(key)
    return a


def override_key(account_id: Any, yf_symbol: Any, first_entry: Any) -> tuple[str, str, str]:
    """An override belongs to ONE holding period: selling out and buying the
    same symbol again starts a new first_entry, so an old 'hold' never
    silences a new trade."""
    return (str(account_id or ""), str(yf_symbol or "").upper(), str(first_entry or "")[:10])


def hold_floor(entry: float, stop: float, price: Optional[float] = None) -> float:
    """Proposed HOLD floor: one more R below the stop, or below today's price
    when that is already under the stop (R = entry − stop; a stop at or above
    the entry — a trailing stop — uses 5% of the stop as its R). Holding a
    position that is already deep under its stop must not be born broken."""
    r = entry - stop if entry > stop else stop * STOP_MIN_PCT
    base = min(stop, price) if price and price > 0 else stop
    return max(base - r, 0.0)


def hold_status(ov: Optional[dict], price: float, entry: float, stop: float,
                today: date) -> Optional[dict]:
    """The override with its effective review date / floor and whether it still
    holds. `active` False = expired ("REVIEW") or broken ("FLOOR")."""
    if not ov:
        return None
    review = str(ov.get("review_on") or "")[:10]
    if not review and ov.get("created_at"):
        try:
            made = date.fromisoformat(str(ov["created_at"])[:10])
            review = date.fromordinal(made.toordinal() + HOLD_REVIEW_DAYS).isoformat()
        except ValueError:
            review = ""
    raw = ov.get("floor_price")
    floor = float(raw) if raw not in (None, "") and float(raw) > 0 else None
    ended = None
    if review and today.isoformat() >= review:
        ended = "REVIEW"
    elif floor is not None and price <= floor:
        ended = "FLOOR"
    return {**ov, "review_on": review or None,
            "floor_price": round(floor, 6) if floor is not None else None,
            "active": ended is None, "ended": ended}


def size_multiplier(nav_drawdown_pct: Optional[float], streak: int,
                    dd_unknown: bool = False) -> tuple[float, list[str]]:
    """Fraction of the normal S/M/L size allowed right now, and why."""
    if nav_drawdown_pct is not None and nav_drawdown_pct <= -DD_STOP * 100:
        return 0.0, [f"DD {nav_drawdown_pct:.1f}% ≤ −{DD_STOP * 100:.0f}%"]
    why: list[str] = []
    mult = 1.0
    if dd_unknown:
        # Fail closed: a drawdown we cannot measure is not a drawdown of zero.
        mult = 0.5
        why.append("NAV drawdown ไม่ทราบ")
    if nav_drawdown_pct is not None and nav_drawdown_pct <= -DD_HALF * 100:
        mult = 0.5
        why.append(f"DD {nav_drawdown_pct:.1f}% ≤ −{DD_HALF * 100:.0f}%")
    if streak >= LOSS_STREAK:
        mult = 0.5
        why.append(f"เสียติดกัน {streak} ไม้")
    return mult, why


def loss_streak(closed: Iterable[dict]) -> int:
    """Consecutive losing closed trades, newest exit first."""
    rows = sorted(
        (c for c in closed if c.get("date_exit") and float(c.get("price_entry") or 0) > 0
         and float(c.get("price_exit") or 0) > 0),
        key=lambda c: str(c["date_exit"]), reverse=True,
    )
    n = 0
    for c in rows:
        if float(c["price_exit"]) < float(c["price_entry"]):
            n += 1
        else:
            break
    return n


def evaluate(
    positions: list[dict],
    atr_by_symbol: dict[str, Optional[float]],
    today: Optional[date] = None,
    overrides: Optional[dict[tuple[str, str, str], dict]] = None,
    nav_drawdown_pct: Optional[float] = None,
    streak: int = 0,
    cash_value: Optional[float] = None,
    nav_drawdown_unknown: bool = False,
) -> dict[str, Any]:
    """Apply the rules to aggregated long positions.

    Each position (from `aggregate_lots`, enriched by the caller) also needs:
    price, prev_close (native currency, may be None) and fx (base units per
    native unit, 1.0 for the base currency).

    `overrides` maps `override_key(...)` → {id, codes, reason, created_at}: a
    "hold anyway" the user recorded. Its codes stay flagged on the row but the
    action drops to INFO and no longer colours the light — while `hold_status`
    says it is active (before its review date, price above its floor).
    `nav_drawdown_unknown` = the caller tried and could not measure the drawdown.
    """
    today = today or date.today()
    overrides = overrides or {}
    rows: list[dict] = []
    skipped: list[dict] = []
    for p in positions:
        vol = float(p.get("volume") or 0)
        entry = float(p.get("entry_price") or 0)
        price = p.get("price")
        if vol <= 0:
            skipped.append({"symbol": p.get("symbol"), "reason": "short / zero volume",
                            "account_id": p.get("account_id")})
            continue
        if entry <= 0:
            skipped.append({"symbol": p.get("symbol"), "reason": "no entry price",
                            "account_id": p.get("account_id")})
            continue
        if not price or float(price) <= 0:
            skipped.append({"symbol": p.get("symbol"), "reason": "no live price",
                            "account_id": p.get("account_id")})
            continue
        price = float(price)
        fx = float(p.get("fx") or 1.0)
        atr = atr_by_symbol.get(p["yf_symbol"])
        if p.get("manual_stop"):
            stop = float(p["manual_stop"])
            dist, src = (entry - stop) / entry, "MANUAL"
        else:
            stop, dist, src = auto_stop(entry, atr)
        prev = p.get("prev_close")
        ov = overrides.get(override_key(p.get("account_id"), p["yf_symbol"], p.get("first_entry")))
        rows.append({
            "account_id": p.get("account_id"),
            "symbol": p.get("symbol"),
            "yf_symbol": p["yf_symbol"],
            "currency": p.get("currency"),
            "sector": p.get("sector") or UNCLASSIFIED,
            "strategy": p.get("strategy"),
            "long_horizon": _is_long_horizon(p.get("strategy")),
            "volume": vol,
            "entry_price": entry,
            "price": price,
            "stop": stop,
            "stop_distance_pct": dist * 100,
            "stop_source": src,
            "atr_pct": atr * 100 if atr is not None else None,
            "return_pct": (price / entry - 1) * 100,
            "to_stop_pct": (price / stop - 1) * 100 if stop > 0 else None,
            "days_held": _days_between(p.get("first_entry"), today),
            "first_entry": p.get("first_entry"),
            "market_value": price * vol * fx,
            "prev_value": float(prev) * vol * fx if prev else None,
            # Open risk: what is lost from here if the stop fills exactly.
            "risk_to_stop": max(price - stop, 0.0) * vol * fx,
            "hold_floor_default": round(hold_floor(entry, stop, price), 6),
            "override": hold_status(ov, price, entry, stop, today),
        })

    total = sum(r["market_value"] for r in rows)
    actions: list[dict] = []
    sectors: dict[str, float] = {}
    for r in rows:
        r["weight_pct"] = r["market_value"] / total * 100 if total else 0.0
        sectors[r["sector"]] = sectors.get(r["sector"], 0.0) + r["weight_pct"]
        flags: list[str] = []
        sym = r["symbol"]
        key = {"account_id": r["account_id"], "yf_symbol": r["yf_symbol"],
               "first_entry": r["first_entry"]}
        ov = r["override"]
        held = set(ov.get("codes") or []) if ov and ov["active"] else set()
        # An expired / broken HOLD says why its codes are loud again.
        ended = ""
        if ov and not ov["active"]:
            ended = (f" · HOLD หมดอายุ {ov['review_on']}" if ov["ended"] == "REVIEW"
                     else f" · หลุด floor ของ HOLD {fmt_px(ov['floor_price'])}")

        def push(level: str, code: str, text: str) -> None:
            if code in held:
                reason = ov.get("reason") or "ไม่ระบุเหตุผล"
                actions.append(_action(
                    "INFO", code, sym, f"{sym} ถือต่อ ({code.replace('_', ' ')}) — {reason}",
                    {**key, "override_id": ov.get("id")},
                ))
            else:
                if ended and code in set(ov.get("codes") or []):
                    text += ended
                actions.append(_action(level, code, sym, text, key))

        days = r["days_held"]
        stale = (days is not None and days >= TIME_STOP_DAYS and not r["long_horizon"]
                 and r["return_pct"] < TIME_STOP_MIN_GAIN * 100)
        # One price action per symbol: a stop already hit says everything the
        # time stop would, and a near stop carries the age in its own line.
        if r["price"] <= r["stop"]:
            flags.append("STOP_HIT")
            push("RED", "STOP_HIT",
                 f"{sym} หลุด stop {fmt_px(r['stop'])} (ราคา {fmt_px(r['price'])}, "
                 f"{r['return_pct']:+.1f}% จากทุน) → ขาย หรือกด HOLD พร้อมเหตุผลถ้าตั้งใจถือต่อ")
        elif r["entry_price"] > r["stop"] and \
                (r["price"] - r["stop"]) <= NEAR_STOP_FRACTION * (r["entry_price"] - r["stop"]):
            flags.append("NEAR_STOP")
            age = f" · ถือมา {days} วัน {r['return_pct']:+.1f}%" if stale else ""
            push("YELLOW", "NEAR_STOP",
                 f"{sym} ใกล้ stop {fmt_px(r['stop'])} (ห่าง {r['to_stop_pct']:.1f}%){age} → เตรียมแผนออก")
        if stale:
            flags.append("TIME")
        if stale and not {"STOP_HIT", "NEAR_STOP"} & set(flags):
            push("YELLOW", "TIME",
                 f"{sym} ถือ {days} วัน ยังไม่ไปไหน ({r['return_pct']:+.1f}%) → รีวิว: ขาย, กด HOLD "
                 f"หรือระบุ strategy เป็น Value/Core ถ้าตั้งใจถือยาว")
        if r["weight_pct"] > MAX_WEIGHT * 100:
            flags.append("OVERWEIGHT")
            push("YELLOW", "OVERWEIGHT",
                 f"{sym} หนัก {r['weight_pct']:.1f}% ของพอร์ต (เพดาน {MAX_WEIGHT * 100:.0f}%) → ลดขนาด")
        r["flags"] = flags

    sector_rows = sorted(
        ({"sector": k, "weight_pct": v,
          "breach": k not in (UNCLASSIFIED, "Other") and v > MAX_SECTOR * 100}
         for k, v in sectors.items()),
        key=lambda s: -s["weight_pct"],
    )
    for s in sector_rows:
        if s["breach"]:
            actions.append(_action(
                "YELLOW", "SECTOR", None,
                f"กลุ่ม {s['sector']} รวม {s['weight_pct']:.1f}% (เพดาน {MAX_SECTOR * 100:.0f}%) "
                f"→ อย่าเพิ่มตัวในกลุ่มนี้",
                {"sector": s["sector"], "weight_pct": round(s["weight_pct"], 2)},
            ))

    priced_prev = [r for r in rows if r["prev_value"]]
    prev_total = sum(r["prev_value"] for r in priced_prev)
    day_pnl_pct = (
        (sum(r["market_value"] for r in priced_prev) - prev_total) / prev_total * 100
        if prev_total else None
    )
    book: list[dict] = []
    if day_pnl_pct is not None and day_pnl_pct <= -DAY_LOSS_LIMIT * 100:
        book.append(_action(
            "RED", "DAY_LOSS", None,
            f"วันนี้พอร์ตลง {day_pnl_pct:.2f}% (เพดาน −{DAY_LOSS_LIMIT * 100:.0f}%) → หยุดเปิดไม้ใหม่วันนี้",
        ))
    if nav_drawdown_pct is not None and nav_drawdown_pct <= -DD_STOP * 100:
        book.append(_action(
            "RED", "DD_STOP", None,
            f"NAV ลงจากจุดสูงสุด {nav_drawdown_pct:.1f}% (เพดาน −{DD_STOP * 100:.0f}%) "
            f"→ หยุดเปิดไม้ใหม่ รีวิวทั้งพอร์ตก่อน",
        ))
    elif nav_drawdown_pct is not None and nav_drawdown_pct <= -DD_HALF * 100:
        book.append(_action(
            "YELLOW", "DD_HALF", None,
            f"NAV ลงจากจุดสูงสุด {nav_drawdown_pct:.1f}% (เกิน −{DD_HALF * 100:.0f}%) → ไม้ใหม่ใช้ครึ่งไซซ์",
        ))
    if streak >= LOSS_STREAK:
        book.append(_action(
            "YELLOW", "STREAK", None,
            f"เสียติดกัน {streak} ไม้ล่าสุด → ไม้ใหม่ใช้ครึ่งไซซ์จนกว่าจะชนะ 1 ไม้",
        ))
    # Fail closed: what the guard could not check is something to look at.
    for s_ in skipped:
        what = {"no live price": "ไม่มีราคาล่าสุด — ตรวจ stop ไม่ได้",
                "no entry price": "ไม่มีราคาทุน — ตรวจ stop ไม่ได้",
                "short / zero volume": "short / volume 0 — guard ไม่ตรวจ"}[s_["reason"]]
        book.append(_action("YELLOW", "DATA", s_["symbol"], f"{s_['symbol']} {what}",
                            {"account_id": s_.get("account_id")}))
    if nav_drawdown_unknown:
        book.append(_action("YELLOW", "DATA", None,
                            "NAV drawdown คำนวณไม่ได้ → ไม้ใหม่ใช้ครึ่งไซซ์จนกว่าจะรู้ค่า"))
    actions = book + actions

    live = [a for a in actions if a["level"] != "INFO"]
    light = ("RED" if any(a["level"] == "RED" for a in live)
             else "YELLOW" if live else "GREEN")
    order = {"RED": 0, "YELLOW": 1, "INFO": 2}
    actions.sort(key=lambda a: order[a["level"]])
    heat = sum(r["risk_to_stop"] for r in rows)
    mult, mult_why = size_multiplier(nav_drawdown_pct, streak, nav_drawdown_unknown)

    for r in rows:
        for k in ("entry_price", "price", "stop"):
            r[k] = round(r[k], 6)
        for k in ("stop_distance_pct", "return_pct", "weight_pct", "market_value",
                  "risk_to_stop"):
            r[k] = round(r[k], 2)
        for k in ("atr_pct", "to_stop_pct", "prev_value"):
            if r[k] is not None:
                r[k] = round(r[k], 2)
    rows.sort(key=lambda r: (not r["flags"], r["to_stop_pct"] if r["to_stop_pct"] is not None else 1e9))

    nav = total + cash_value if cash_value is not None else None
    return {
        "light": light,
        "actions": actions,
        "positions": rows,
        "sectors": [{**s, "weight_pct": round(s["weight_pct"], 2)} for s in sector_rows],
        "invested_value": round(total, 2),
        "cash_value": round(cash_value, 2) if cash_value is not None else None,
        "nav_value": round(nav, 2) if nav is not None else None,
        "day_pnl_pct": round(day_pnl_pct, 2) if day_pnl_pct is not None else None,
        "nav_drawdown_pct": round(nav_drawdown_pct, 2) if nav_drawdown_pct is not None else None,
        "loss_streak": streak,
        "size_multiplier": mult,
        "size_multiplier_why": mult_why,
        "heat_value": round(heat, 2),
        "heat_pct": round(heat / total * 100, 2) if total else None,
        "counts": {
            code: sum(code in r["flags"] for r in rows)
            for code in ("STOP_HIT", "NEAR_STOP", "TIME", "OVERWEIGHT")
        } | {"manual_stops": sum(r["stop_source"] == "MANUAL" for r in rows),
             "overrides": sum(1 for r in rows if r["override"] and r["override"]["active"]),
             "positions": len(rows)},
        "skipped": skipped,
        "rules": RULES,
        "as_of": today.isoformat(),
    }


# ── Pre-trade sizing (S / M / L) ─────────────────────────────────────────────

def size_buckets(
    nav_base: float, price: float, fx: float, atr_frac: Optional[float],
    multiplier: float = 1.0, manual_stop: Optional[float] = None, lot: float = 0.0,
) -> dict[str, Any]:
    """Volume for each bucket so the user never divides anything.

    `fx` = base units per one unit of the instrument's currency. Risk per trade
    = notional × stop distance — with M (6%) and an 8% stop that is ~0.5% NAV,
    which is the whole point of fixing the buckets. `lot` > 0 floors the
    volume to whole lots (SET board lot = 100) and re-derives the money from it.
    """
    if manual_stop and 0 < manual_stop < price:
        stop, dist, src = manual_stop, (price - manual_stop) / price, "MANUAL"
    else:
        stop, dist, src = auto_stop(price, atr_frac)
    out: dict[str, Any] = {}
    for name, pct in SIZE_BUCKETS.items():
        notional_base = nav_base * pct * multiplier
        vol = notional_base / (price * fx) if price > 0 and fx > 0 else 0.0
        if lot > 0:
            vol = (vol // lot) * lot
            notional_base = vol * price * fx
        out[name] = {
            "pct_nav": pct * 100,
            "notional_base": round(notional_base, 2),
            "volume": vol,
            "risk_base": round(notional_base * dist, 2),
            "risk_pct_nav": round(notional_base * dist / nav_base * 100, 3) if nav_base else None,
        }
    return {
        "buckets": out,
        "stop": round(stop, 6),
        "stop_distance_pct": round(dist * 100, 2),
        "stop_source": src,
        "atr_pct": round(atr_frac * 100, 2) if atr_frac is not None else None,
        "multiplier": multiplier,
        "lot": lot or None,
    }


# ── After-trade report (R-multiples, rule adherence) ─────────────────────────

def _r_stats(trades: list[dict]) -> dict[str, Any]:
    n = len(trades)
    if not n:
        return {"n": 0, "win_pct": None, "avg_return_pct": None, "expectancy_r": None,
                "avg_win_r": None, "avg_loss_r": None}
    wins = [t for t in trades if t["return_pct"] > 0]
    losses = [t for t in trades if t["return_pct"] <= 0]
    return {
        "n": n,
        "win_pct": round(len(wins) / n * 100, 1),
        "avg_return_pct": round(sum(t["return_pct"] for t in trades) / n, 2),
        "expectancy_r": round(sum(t["r"] for t in trades) / n, 2),
        "avg_win_r": round(sum(t["r"] for t in wins) / len(wins), 2) if wins else None,
        "avg_loss_r": round(sum(t["r"] for t in losses) / len(losses), 2) if losses else None,
    }


def _was_overridden(c: dict, overridden: set[tuple[str, str, str]]) -> bool:
    acct, sym = str(c.get("account_id") or ""), str(c["yf_symbol"]).upper()
    start, end = str(c.get("date_entry") or "")[:10], str(c.get("date_exit") or "")[:10]
    return any(k[0] == acct and k[1] == sym and start <= k[2] <= end for k in overridden)


def trade_report(
    closed: Iterable[dict],
    atr_by_symbol: dict[str, Optional[float]],
    overridden: Optional[set[tuple[str, str, str]]] = None,
    frames: Optional[dict[str, pd.DataFrame]] = None,
) -> dict[str, Any]:
    """R-multiple journal of closed trades, and what the rules would have done.

    Closed lot dicts need: account_id, symbol, yf_symbol, price_entry,
    price_exit, date_entry, date_exit, price_stoploss, strategy_name.
    `overridden` holds override_key()s; a closed lot whose holding period
    contains one is counted as "held past a guard flag".

    1R = the stop distance the guard would have set at entry (manual S/L if one
    was recorded, else 2×ATR at the entry date). A rule BREAK is a loss past
    1.5R (the stop was not respected) or a loser held ≥ TIME_STOP_DAYS.
    `capped_expectancy_r` re-runs expectancy with every break cut at −1R — an
    upper bound: it assumes the stop filled and ignores winners the stop would
    have shaken out.

    `frames` (raw daily OHLC per yf symbol) makes it FAIR: each trade is
    replayed bar by bar (`replay_with_stop`) — MAE/MFE, the return it would
    have had with the guard's stop, including the winners the stop would have
    cut and gaps through the stop — plus a sweep of other stop distances
    (`counterfactual`, `sweep`).
    """
    frames = frames or {}
    overridden = overridden or set()
    trades: list[dict] = []
    for c in closed:
        entry, exit_ = float(c.get("price_entry") or 0), float(c.get("price_exit") or 0)
        if entry <= 0 or exit_ <= 0 or not c.get("date_exit"):
            continue
        sl = float(c.get("price_stoploss") or 0)
        if 0 < sl < entry:
            dist, src = (entry - sl) / entry, "MANUAL"
        else:
            _, dist, src = auto_stop(entry, atr_by_symbol.get(c["yf_symbol"]))
        ret = exit_ / entry - 1
        days = _days_between(str(c.get("date_entry") or ""), _parse_day(c["date_exit"]))
        r = ret / dist
        breaks = []
        if r < -1.5:
            breaks.append("LOSS_PAST_STOP")
        if ret < 0 and days is not None and days >= TIME_STOP_DAYS \
                and not _is_long_horizon(c.get("strategy_name")):
            breaks.append("HELD_LOSER")
        frame = frames.get(c["yf_symbol"])
        mismatch = frame is not None and not entry_consistent(frame, c.get("date_entry"), entry)
        bars = None if mismatch else trade_bars(frame, c.get("date_entry"), c.get("date_exit"))
        mae = mfe = cf = None
        cf_stopped = False
        if bars is not None:
            mae = (float(bars["Low"].min()) / entry - 1) * 100
            mfe = (float(bars["High"].max()) / entry - 1) * 100
            cf_ret, cf_stopped = replay_with_stop(bars, entry, exit_, dist)
            cf = cf_ret * 100
        trades.append({
            "account_id": c.get("account_id"), "symbol": c.get("symbol"),
            "strategy": (c.get("strategy_name") or "").strip() or None,
            "date_entry": str(c.get("date_entry") or "")[:10], "date_exit": str(c["date_exit"])[:10],
            "days_held": days, "return_pct": round(ret * 100, 2),
            "stop_distance_pct": round(dist * 100, 2), "stop_source": src,
            "r": round(r, 2), "breaks": breaks,
            "overridden": _was_overridden(c, overridden) if overridden else False,
            "mae_pct": round(mae, 2) if mae is not None else None,
            "mfe_pct": round(mfe, 2) if mfe is not None else None,
            "cf_return_pct": round(cf, 2) if cf is not None else None,
            "cf_stopped": cf_stopped,
            "entry_mismatch": mismatch,
            "_bars": bars, "_entry": entry, "_exit": exit_,
            "_atr": atr_by_symbol.get(c["yf_symbol"]),
        })

    followed = [t for t in trades if not t["breaks"]]
    broke = [t for t in trades if t["breaks"]]
    capped = [{**t, "r": max(t["r"], -1.0) if t["breaks"] else t["r"]} for t in trades]

    months: dict[str, list[dict]] = {}
    strategies: dict[str, list[dict]] = {}
    for t in trades:
        months.setdefault(t["date_exit"][:7], []).append(t)
        strategies.setdefault(t["strategy"] or "(none)", []).append(t)

    return {
        "summary": _r_stats(trades),
        "followed": _r_stats(followed),
        "broke": _r_stats(broke),
        "overridden": _r_stats([t for t in trades if t["overridden"]]),
        "capped_expectancy_r": _r_stats(capped)["expectancy_r"],
        "break_counts": {
            b: sum(b in t["breaks"] for t in trades) for b in ("LOSS_PAST_STOP", "HELD_LOSER")
        },
        "manual_stop_pct": round(
            sum(t["stop_source"] == "MANUAL" for t in trades) / len(trades) * 100, 1
        ) if trades else None,
        "monthly": [
            {"month": m, **_r_stats(ts), "breaks": sum(bool(t["breaks"]) for t in ts)}
            for m, ts in sorted(months.items(), reverse=True)
        ],
        "by_strategy": sorted(
            ({"strategy": k, **_r_stats(ts), "breaks": sum(bool(t["breaks"]) for t in ts)}
             for k, ts in strategies.items()),
            key=lambda s: -s["n"],
        ),
        "worst": [_public(t) for t in sorted(trades, key=lambda t: t["r"])[:10]],
        "counterfactual": _counterfactual(trades),
        "sweep": _sweep(trades),
    }


def _parse_day(value: Any) -> date:
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return date.today()


# ── Notifications (flag transitions) ─────────────────────────────────────────

# Codes worth interrupting for. OVERWEIGHT / SECTOR move with every price tick
# around the cap and would toast all day; they stay on the card only.
NOTIFY_CODES = ("STOP_HIT", "NEAR_STOP", "TIME")
NOTIFY_BOOK_CODES = ("DAY_LOSS", "DD_STOP", "DD_HALF", "STREAK")
# Codes that fire EVERY scan while they stand, not only when they appear: the
# alert_events UNIQUE(rule_id, symbol, bar_time = day) turns that into one
# reminder per day until the user sells or records a HOLD. A stop broken last
# week is still broken today; firing once and falling silent is how DCON sat
# 35% under its stop with nobody asked about it (2026-09-30).
REMIND_DAILY_CODES = ("STOP_HIT",)
REMIND_DAILY_BOOK_CODES = ("DD_STOP",)
BOOK_KEY = "book|all"

GUARD_EVENT_LABELS = {
    "STOP_HIT": "หลุด stop",
    "NEAR_STOP": "ใกล้ stop",
    "TIME": "ถือนานไม่ไปไหน",
    "DAY_LOSS": "พอร์ตลงเกินเพดานรายวัน",
    "DD_STOP": "NAV drawdown ≥10% — หยุดเปิดไม้",
    "DD_HALF": "NAV drawdown ≥5% — ครึ่งไซซ์",
    "STREAK": "เสียติดกัน — ครึ่งไซซ์",
}


def position_state_key(row: dict) -> str:
    return "|".join(override_key(row.get("account_id"), row.get("yf_symbol"), row.get("first_entry")))


def transitions(
    prev: dict[str, set[str]], snapshot: dict[str, Any],
) -> tuple[dict[str, set[str]], list[dict]]:
    """(new state, events to fire): a code fires when it APPEARS on a holding;
    REMIND_DAILY codes fire on every call while they stand (the caller caps
    them at one per day).

    Codes under an ACTIVE override are excluded — the user already decided. An
    expired or broken HOLD no longer excludes them. A key that disappears
    (position closed) drops out of the state, so re-entering the same symbol
    later fires again.
    """
    state: dict[str, set[str]] = {}
    events: list[dict] = []
    for r in snapshot.get("positions", []):
        ov = r.get("override") or {}
        held = set(ov.get("codes") or []) if ov.get("active", True) else set()
        now = {f for f in r.get("flags", []) if f in NOTIFY_CODES and f not in held}
        key = position_state_key(r)
        state[key] = now
        fire = (now - prev.get(key, set())) | (now & set(REMIND_DAILY_CODES))
        for code in sorted(fire):
            events.append({
                "code": code, "symbol": r.get("symbol"), "key": key,
                # Labelled on the client (components/bloomberg/alerts/guard-alert.ts).
                "snapshot": {"price": r.get("price"), "stop": r.get("stop"),
                             "return_pct": r.get("return_pct"),
                             "to_stop_pct": r.get("to_stop_pct"),
                             "days_held": r.get("days_held"),
                             "hold_ended": 1 if ov and not ov.get("active", True) else None},
            })
    book_now = {a["code"] for a in snapshot.get("actions", [])
                if a.get("code") in NOTIFY_BOOK_CODES and a.get("level") != "INFO"}
    state[BOOK_KEY] = book_now
    book_fire = (book_now - prev.get(BOOK_KEY, set())) | (book_now & set(REMIND_DAILY_BOOK_CODES))
    for code in sorted(book_fire):
        events.append({
            "code": code, "symbol": "PORT", "key": BOOK_KEY,
            "snapshot": {"day_pnl_pct": snapshot.get("day_pnl_pct"),
                         "nav_drawdown_pct": snapshot.get("nav_drawdown_pct"),
                         "loss_streak": snapshot.get("loss_streak")},
        })
    return state, events


# ── Bar-by-bar replay (MAE / MFE / "had we followed the stop") ───────────────

SWEEP_PCT = (3.0, 5.0, 7.0, 8.0, 10.0, 12.0, 15.0, 20.0)
SWEEP_ATR = (1.0, 1.5, 2.0, 2.5, 3.0, 4.0)


def trade_bars(frame: Optional[pd.DataFrame], date_in: Any, date_out: Any) -> Optional[pd.DataFrame]:
    """Raw daily OHLC strictly AFTER the entry day through the exit day.

    The entry day itself is left out: the fill time inside that bar is unknown,
    so its low may have printed before the trade existed.
    """
    if frame is None or frame.empty or not {"Open", "High", "Low", "Close"} <= set(frame.columns):
        return None
    try:
        a, b = pd.Timestamp(str(date_in)[:10]), pd.Timestamp(str(date_out)[:10])
    except (ValueError, TypeError):
        return None
    df = frame[["Open", "High", "Low", "Close"]].dropna()
    idx = df.index.tz_localize(None) if getattr(df.index, "tz", None) is not None else df.index
    if len(idx) == 0 or idx[0] > a:          # history does not reach the entry
        return None
    out = df[(idx > a) & (idx <= b)]
    return out if len(out) else None


ENTRY_TOLERANCE = 0.10


def entry_consistent(frame: pd.DataFrame, date_in: Any, entry: float) -> bool:
    """Was `entry` tradeable on the entry day (within ±10% of that bar's range)?

    A lot whose price_entry carries the AVERAGE cost of an earlier holding but
    the date of a later buy (SMR 2026-02-02 at 45.46 while the stock traded
    ~17) cannot be replayed from its date — the loss happened before it.
    Missing entry-day bar → True (nothing to contradict it).
    """
    if frame is None or frame.empty or not {"High", "Low"} <= set(frame.columns):
        return True
    try:
        a = pd.Timestamp(str(date_in)[:10])
    except (ValueError, TypeError):
        return True
    df = frame[["High", "Low"]].dropna()
    idx = df.index.tz_localize(None) if getattr(df.index, "tz", None) is not None else df.index
    upto = df[idx <= a]
    if not len(upto):
        return True
    hi, lo = float(upto["High"].iloc[-1]), float(upto["Low"].iloc[-1])
    return lo * (1 - ENTRY_TOLERANCE) <= entry <= hi * (1 + ENTRY_TOLERANCE)


def replay_with_stop(bars: pd.DataFrame, entry: float, exit_price: float,
                     dist: float) -> tuple[float, bool]:
    """(return, stopped): walk the bars; the first bar that OPENS at/below the
    stop fills at its open (a gap), the first whose LOW reaches it fills at the
    stop. Never touched → the trade's real exit."""
    stop = entry * (1 - dist)
    for o, lo in zip(bars["Open"].to_numpy(float), bars["Low"].to_numpy(float)):
        if o <= stop:
            return o / entry - 1, True
        if lo <= stop:
            return stop / entry - 1, True
    return exit_price / entry - 1, False


def _public(t: dict) -> dict:
    return {k: v for k, v in t.items() if not k.startswith("_")}


def _cf_stats(pairs: list[tuple[float, float, bool]]) -> dict[str, Any]:
    """pairs = (actual_ret, stop_ret, stopped) in %."""
    n = len(pairs)
    if not n:
        return {"n": 0}
    act = [a for a, _, _ in pairs]
    stp = [b for _, b, _ in pairs]
    cut = sum(1 for a, b, st in pairs if st and a > 0)
    saved = sum(1 for a, b, st in pairs if st and b > a)
    return {
        "n": n,
        "actual_avg_pct": round(sum(act) / n, 2),
        "stop_avg_pct": round(sum(stp) / n, 2),
        "actual_sum_pct": round(sum(act), 1),
        "stop_sum_pct": round(sum(stp), 1),
        "actual_win_pct": round(sum(a > 0 for a in act) / n * 100, 1),
        "stop_win_pct": round(sum(b > 0 for b in stp) / n * 100, 1),
        "actual_worst_pct": round(min(act), 2),
        "stop_worst_pct": round(min(stp), 2),
        "stopped_pct": round(sum(st for _, _, st in pairs) / n * 100, 1),
        "winners_cut": cut,          # would have been stopped out of a trade that ended green
        "losses_saved": saved,       # stop exit better than the real exit
    }


def _counterfactual(trades: list[dict]) -> dict[str, Any]:
    pairs = [(t["return_pct"], t["cf_return_pct"], t["cf_stopped"])
             for t in trades if t.get("cf_return_pct") is not None]
    out = _cf_stats(pairs)
    out["coverage_pct"] = round(len(pairs) / len(trades) * 100, 1) if trades else 0.0
    out["entry_mismatch"] = [
        {"symbol": t["symbol"], "date_entry": t["date_entry"], "return_pct": t["return_pct"]}
        for t in trades if t.get("entry_mismatch")
    ]
    return out


def _sweep(trades: list[dict]) -> list[dict]:
    """Same replay at other stop distances: fixed % and ATR multiples (no clamp)."""
    usable = [t for t in trades if t.get("_bars") is not None]
    rows = []
    for pct in SWEEP_PCT:
        pairs = []
        for t in usable:
            r, st = replay_with_stop(t["_bars"], t["_entry"], t["_exit"], pct / 100)
            pairs.append((t["return_pct"], r * 100, st))
        rows.append({"kind": "pct", "value": pct, **_cf_stats(pairs)})
    for mult in SWEEP_ATR:
        pairs = []
        for t in usable:
            if not t.get("_atr"):
                continue
            r, st = replay_with_stop(t["_bars"], t["_entry"], t["_exit"], mult * t["_atr"])
            pairs.append((t["return_pct"], r * 100, st))
        rows.append({"kind": "atr", "value": mult, **_cf_stats(pairs)})
    return rows
