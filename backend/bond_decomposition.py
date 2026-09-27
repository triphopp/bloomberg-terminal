"""
10Y Treasury yield taken apart — which piece is moving it?

One number, three pieces, each driven by something different:

  EXPECTED REAL   the short real rate the market expects the Fed to hold for
                  10 years (r* + the policy path)   ← Fed, growth, r*
  BREAKEVEN       expected inflation + inflation risk premium (TIPS)
                                                    ← Fed credibility
  TERM PREMIUM    pay for locking money up for 10 years
                                                    ← deficits, supply, foreign demand

Two lenses measure it, and they must not be added together:

  MARKET  nominal = TIPS real yield + breakeven                 (FRED DFII10, T10YIE)
  MODEL   nominal = risk-neutral expected short rate + TP       (NY Fed ACM)

The TIPS real yield already carries a real term premium and the breakeven
carries the inflation risk premium, which ACM books inside TP. real + BE + TP
therefore overshoots the yield by roughly TP — the "hidden 65bp" that is only
counted twice. The three-piece view here is ACM expected − breakeven, BE, TP:
an approximation (BE and TP overlap by the inflation risk premium), labelled so.

Why the driver matters: the same +30bp means three different things.
  REAL  growth + a firm Fed — the least harmful rise; bonds get attractive
  TP    fear about the fiscal/supply side — hits stocks, credit, EM together
  BE    inflation coming back and the Fed doubted — stagflation, 2022-style

Everything below is pure (series in, dict out) so it can be tested offline.
"""
from __future__ import annotations

from datetime import date, timedelta

# ── Tripwires ─────────────────────────────────────────────────────────────────
# Levels the market commentary watches. The TP and BE record lines are computed
# from the data (10y / 20y highs); these two are judgment levels, kept here so
# they are visible and easy to change.
BE_WARN = 2.50          # breakeven leaving its ~2.3% range = the Fed's grip loosening
NOMINAL_ALARM = 5.50    # where strategists expect bonds to pull money out of stocks/credit

QUIET_BP = 10.0         # |Δ10Y| below this over a window → no driver named

WINDOWS = (1, 5, 20, 60)

DRIVERS = {
    "REAL": {
        "label": "REAL RATE",
        "case": "growth + firm Fed",
        "read": "ดอกเบี้ยแท้จริงนำ — เศรษฐกิจแข็ง/Fed เข้ม. กรณีเจ็บน้อยสุด: หุ้นโดนกด P/E แต่พื้นฐานไม่พัง, บอนด์น่าสนใจขึ้น",
        "severity": 1,
    },
    "TP": {
        "label": "TERM PREMIUM",
        "case": "fiscal / supply fear",
        "read": "Term premium นำ — ตลาดเรียกค่าเสี่ยงถือยาว (หนี้/อุปทาน/ต่างชาติซื้อน้อย). Yield ขึ้นเพราะกลัว ไม่ใช่เพราะโต: หุ้น หุ้นกู้ EM โดนพร้อมกัน",
        "severity": 2,
    },
    "BE": {
        "label": "BREAKEVEN",
        "case": "inflation / Fed doubted",
        "read": "Breakeven นำ — เงินเฟ้อกลับมาและตลาดเริ่มไม่เชื่อ Fed. กรณีแย่สุด (stagflation): หุ้นและบอนด์ร่วงพร้อมกันแบบ 2022",
        "severity": 3,
    },
}


Series = dict[str, float]  # "YYYY-MM-DD" → value in %


def _pts(s: Series) -> list[tuple[str, float]]:
    return sorted(s.items())


def _join(*series: Series) -> list[tuple[str, tuple[float, ...]]]:
    """Dates present in every series, oldest first."""
    if not series:
        return []
    common = set(series[0]).intersection(*series[1:])
    return [(d, tuple(s[d] for s in series)) for d in sorted(common)]


def _r(v: float | None, n: int = 4) -> float | None:
    return None if v is None else round(v, n)


def _bp(v: float | None) -> float | None:
    return None if v is None else round(v * 100, 1)


# ── Long-run context ──────────────────────────────────────────────────────────

def long_run(s: Series, years: int, today: date | None = None) -> dict | None:
    """avg / min / max (with dates) / percentile of the latest value over N years."""
    today = today or date.today()
    start = (today - timedelta(days=round(365.25 * years))).isoformat()
    pts = [(d, v) for d, v in _pts(s) if d >= start]
    if len(pts) < 20:
        return None
    vals = [v for _, v in pts]
    last = vals[-1]
    lo = min(pts, key=lambda p: p[1])
    hi = max(pts, key=lambda p: p[1])
    return {
        "years": years,
        "since": pts[0][0],
        "avg": _r(sum(vals) / len(vals)),
        "min": _r(lo[1]), "minDate": lo[0],
        "max": _r(hi[1]), "maxDate": hi[0],
        "pctile": round(100.0 * sum(1 for v in vals if v <= last) / len(vals)),
    }


def value_ago(s: Series, years: int, today: date | None = None) -> dict | None:
    """The observation nearest on/before `years` ago — "5 years ago it was …"."""
    today = today or date.today()
    target = (today - timedelta(days=round(365.25 * years))).isoformat()
    prior = [(d, v) for d, v in _pts(s) if d <= target]
    return {"date": prior[-1][0], "value": _r(prior[-1][1])} if prior else None


# ── Attribution: which piece moved ────────────────────────────────────────────

def _delta(pts: list[tuple[str, tuple[float, ...]]], n: int) -> tuple[str, list[float]] | None:
    if len(pts) <= n:
        return None
    d0, a = pts[-1 - n]
    _, b = pts[-1]
    return d0, [y - x for x, y in zip(a, b)]


def classify_driver(d_real: float, d_be: float, d_tp: float, d_total: float) -> str | None:
    """The piece that contributed most IN THE DIRECTION of the total move (bp).

    A piece moving against the total is not the driver however large it is —
    a yield up 30bp with TP −10bp was driven by something else.
    """
    if abs(d_total) < QUIET_BP:
        return None
    sign = 1 if d_total > 0 else -1
    parts = {"REAL": d_real * sign, "BE": d_be * sign, "TP": d_tp * sign}
    key, val = max(parts.items(), key=lambda kv: kv[1])
    return key if val > 0 else None


def attribution(nominal: Series, real: Series, be: Series,
                expected: Series, tp: Series) -> list[dict]:
    """Per window: the market split (Δreal vs ΔBE), the model split (Δexpected vs
    ΔTP) and the three-piece split that names the driver.

    Each lens is measured on its own dates — ACM runs a day or two behind FRED,
    and mixing a Tuesday yield with a Monday TP would invent a move.
    """
    market = _join(nominal, real, be)
    model = _join(expected, tp)
    three = _join(expected, tp, be)
    rows = []
    for n in WINDOWS:
        row: dict = {"days": n}
        m = _delta(market, n)
        if m:
            since, (dn, dr, db) = m
            row.update({
                "since": since,
                "dNominal_bp": _bp(dn), "dReal_bp": _bp(dr), "dBE_bp": _bp(db),
                # share of the explained move that came from real rates; None when
                # the two pieces offset each other (a share of ~0 is meaningless)
                "realShare": (round(100 * dr / (dr + db)) if abs(dr + db) >= 0.02
                              and dr * db >= 0 else None),
            })
        k = _delta(model, n)
        if k:
            _, (de, dt) = k
            row.update({"dExpected_bp": _bp(de), "dTP_bp": _bp(dt)})
        t = _delta(three, n)
        if t:
            since3, (de, dt, db) = t
            d_real = de - db
            d_total = de + dt
            row.update({
                "modelSince": since3,
                "dExpReal_bp": _bp(d_real),
                "dModel_bp": _bp(d_total),
                "driver": classify_driver(d_real * 100, db * 100, dt * 100, d_total * 100),
            })
        rows.append(row)
    return rows


# ── Tripwires ─────────────────────────────────────────────────────────────────

def _prior_high(s: Series, years: int, exclude_last: int, today: date | None) -> dict | None:
    """Highest value over `years`, ignoring the latest `exclude_last` points —
    otherwise a new high is always "at the high" and never "through" it."""
    today = today or date.today()
    start = (today - timedelta(days=round(365.25 * years))).isoformat()
    pts = [(d, v) for d, v in _pts(s) if d >= start]
    if len(pts) <= exclude_last + 20:
        return None
    d, v = max(pts[:-exclude_last] if exclude_last else pts, key=lambda p: p[1])
    return {"value": _r(v), "date": d}


def _wire(wid: str, label: str, piece: str, value: float | None, level: float | None,
          level_note: str, *, warn: float | None = None, record: bool = False) -> dict:
    """record=True: the level is a past high, so only going THROUGH it counts."""
    if value is None or level is None:
        return {"id": wid, "label": label, "piece": piece, "value": _r(value),
                "level": _r(level), "levelNote": level_note, "status": "NA", "gap_bp": None}
    gap = level - value
    if value > level or (not record and value >= level):
        status = "BREACH"
    elif warn is not None and value >= warn:
        status = "WATCH"
    else:
        status = "OK"
    return {"id": wid, "label": label, "piece": piece, "value": _r(value), "level": _r(level),
            "levelNote": level_note, "warn": _r(warn), "status": status, "gap_bp": _bp(gap)}


def tripwires(nominal: Series, be: Series, tp: Series, today: date | None = None) -> dict:
    """The three numbers that would change the story.

    1. TP through its prior 10y high  → the fiscal/supply piece takes over
    2. BE above 2.5% heading for its 20y high → inflation piece wakes up
    3. 10Y at 5.5% → bonds start pulling money out of risk assets
    1 and 2 together = the "debt/inflation" camp is right; the read flips.
    """
    tp_now = _pts(tp)[-1][1] if tp else None
    be_now = _pts(be)[-1][1] if be else None
    nom_now = _pts(nominal)[-1][1] if nominal else None

    tp_hi = _prior_high(tp, 10, 20, today)
    be_hi = _prior_high(be, 20, 20, today)

    w_tp = _wire("TP_HIGH", "TERM PREMIUM vs 10Y HIGH", "TP", tp_now,
                 tp_hi and tp_hi["value"],
                 f"10y high {tp_hi['date']}" if tp_hi else "no 10y history", record=True)
    w_tp["warn"] = None
    if tp_hi and tp_now is not None and w_tp["status"] == "OK" and tp_hi["value"] - tp_now <= 0.10:
        w_tp["status"] = "WATCH"   # within 10bp of the high

    w_be = _wire("BE_RANGE", "BREAKEVEN 10Y", "BE", be_now, be_hi and be_hi["value"],
                 f"20y high {be_hi['date']} · watch ≥ {BE_WARN:.2f}%" if be_hi else "no 20y history",
                 warn=BE_WARN, record=True)

    w_nom = _wire("NOM_ALARM", "UST 10Y", "ALL", nom_now, NOMINAL_ALARM,
                  "strategist level: bonds pull money from stocks/credit",
                  warn=NOMINAL_ALARM - 0.25)
    # How far TP alone could carry the yield: its room to the prior high
    if tp_hi and tp_now is not None and w_nom["gap_bp"] is not None:
        w_nom["tpRoom_bp"] = _bp(max(tp_hi["value"] - tp_now, 0))

    flip = w_tp["status"] == "BREACH" and w_be["status"] == "BREACH"
    return {
        "wires": [w_tp, w_be, w_nom],
        "flip": flip,
        "flipNote": ("TP และ BE ทะลุพร้อมกัน — เรื่องหนี้/เงินเฟ้อกลายเป็นตัวขับเคลื่อนหลัก มุมมอง 'yield ขึ้นเพราะเศรษฐกิจแข็ง' ใช้ไม่ได้แล้ว"
                     if flip else None),
    }


# ── Snapshot ──────────────────────────────────────────────────────────────────

def snapshot(nominal: Series, real: Series, be: Series,
             model_yield: Series, expected: Series, tp: Series) -> dict:
    """Latest level of each lens and the three-piece stack.

    Each lens uses its own latest common date and says which date that is.
    """
    out: dict = {}
    m = _join(nominal, real, be)
    if m:
        d, (n, r, b) = m[-1]
        out["market"] = {
            "asOf": d, "nominal": _r(n), "real": _r(r), "breakeven": _r(b),
            "residual_bp": _bp(n - r - b),
        }
    k = _join(model_yield, expected, tp)
    if k:
        d, (y, e, t) = k[-1]
        out["model"] = {"asOf": d, "fitted": _r(y), "expected": _r(e), "termPremium": _r(t),
                        "residual_bp": _bp(y - e - t)}
    t3 = _join(expected, tp, be)
    if t3:
        d, (e, t, b) = t3[-1]
        total = e + t
        er = e - b
        out["pieces"] = {
            "asOf": d,
            "expReal": _r(er), "breakeven": _r(b), "termPremium": _r(t), "total": _r(total),
            # shares of the model yield; can be negative (2020–21 real rates)
            "share": {
                "expReal": round(100 * er / total) if total else None,
                "breakeven": round(100 * b / total) if total else None,
                "termPremium": round(100 * t / total) if total else None,
            },
        }
    if "market" in out and "model" in out:
        mk = out["market"]
        # The mistake to show: stacking TP on top of the TIPS split
        stacked = mk["real"] + mk["breakeven"] + out["model"]["termPremium"]
        out["doubleCount"] = {
            "stacked": _r(stacked),
            "nominal": mk["nominal"],
            "overshoot_bp": _bp(stacked - mk["nominal"]),
        }
    return out


def history(nominal: Series, expected: Series, tp: Series, be: Series,
            real: Series, days: int = 520) -> list[dict]:
    """Daily rows for the stacked chart — the three pieces plus both yields."""
    dates = sorted(set(nominal) | set(expected))[-days:]
    rows = []
    for d in dates:
        e, t, b = expected.get(d), tp.get(d), be.get(d)
        rows.append({
            "date": d,
            "nominal": nominal.get(d),
            "real": real.get(d),
            "expReal": _r(e - b) if e is not None and b is not None else None,
            "breakeven": b if e is not None else None,
            "termPremium": t,
            "expected": e,
        })
    return rows


def build(nominal: Series, real: Series, be: Series, model_yield: Series,
          expected: Series, tp: Series, today: date | None = None) -> dict:
    today = today or date.today()
    att = attribution(nominal, real, be, expected, tp)
    lead = next((r for r in att if r["days"] == 20), None)
    driver = lead.get("driver") if lead else None
    context = {}
    for key, s in (("nominal", nominal), ("real", real), ("breakeven", be), ("termPremium", tp)):
        context[key] = {
            "y20": long_run(s, 20, today),
            "y10": long_run(s, 10, today),
            "ago5": value_ago(s, 5, today),
            "ago10": value_ago(s, 10, today),
            "ago20": value_ago(s, 20, today),
        }
    return {
        "snapshot": snapshot(nominal, real, be, model_yield, expected, tp),
        "attribution": att,
        "driver": ({"window": 20, "key": driver, **DRIVERS[driver]} if driver else
                   {"window": 20, "key": None, "label": "QUIET",
                    "case": f"|Δ10Y| < {QUIET_BP:.0f}bp or pieces offset",
                    "read": "20 วันที่ผ่านมา yield ไม่ได้ขยับพอจะชี้ตัวขับเคลื่อน", "severity": 0}),
        "tripwires": tripwires(nominal, be, tp, today),
        "context": context,
        "history": history(nominal, expected, tp, be, real),
    }
