"""
Pre-buy CHECK — what we can measure that disagrees with buying a symbol now.

MKT → STRUCTURE → CHECK and the chip on the chart header read this through
`routers/prebuy_check.py`, which gathers the facts; everything here is pure.

Each check lands in one state:

    CONFLICT   a measured fact that argues against buying now
    OPEN       a question the user has not answered yet (no thesis, no kill line …)
    PASS       measured, and it does not argue against
    PENDING    the data is still loading

No weighted score on purpose: averaging a lagging sector against a calm VIX is
exactly how a conflict gets bought anyway. The tier counts what is wrong —

    C  two or more conflicts
    B  one conflict, or two or more open questions
    A  neither
    None  no conflict yet but something is still PENDING (fail-closed: missing
          data is never shown as A)

— and the tier only sizes the trade (A ×1 · B ×0.5 · C ×0), capped by the
TRADE GUARD multiplier, which is book-wide and therefore not a conflict of the
symbol. It never says buy, sell or hold (house rule).

Thresholds live in RULES and are echoed in the response so the panel can show
what was applied. plans/pre-buy-check.md.
"""
from __future__ import annotations

from typing import Any, Optional

CONFLICT, OPEN, PASS, PENDING = "CONFLICT", "OPEN", "PASS", "PENDING"

RULES: dict[str, Any] = {
    "earnings_days": 5,          # earnings this many calendar days ahead or fewer
    "macro_days": 3,             # a high-impact macro release this close
    "sma_long": 200,
    "sma_short": 50,
    "sma_slope_bars": 10,        # SMA50 "falling" = lower than 10 bars ago
    "max_weight_pct": 10.0,      # TRADE GUARD's own caps (trade_guard.MAX_WEIGHT / MAX_SECTOR)
    "max_sector_pct": 25.0,
    "buy_bucket": "S",           # the after-buy weights assume the smallest guard size
    "conflict_quadrants": ["Lagging"],
    "tier_size": {"A": 1.0, "B": 0.5, "C": 0.0},
}

GROUPS = ("TIMING", "EVENTS", "BOOK", "THESIS")


def _check(cid: str, group: str, state: str, title: str, detail: str = "",
           view: Optional[str] = None, **extra) -> dict:
    return {"id": cid, "group": group, "state": state, "title": title, "detail": detail,
            "view": view, **extra}


# ── Individual checks — each takes the facts it needs, None = not loaded yet ──

def check_rotation(rot: Optional[dict]) -> dict:
    """`rot` = {sector, group_id, quadrant, mom_dir, m1_vs_bench, market} or
    {"unknown": reason} or None while loading."""
    if rot is None:
        return _check("rotation", "TIMING", PENDING, "Sector rotation", "loading ROT", view="ROT")
    if rot.get("unknown"):
        return _check("rotation", "TIMING", OPEN, "Sector unknown", rot["unknown"], view="ROT")
    q = rot.get("quadrant")
    name = rot.get("sector") or rot.get("group_id") or "?"
    bits = []
    if rot.get("m1_vs_bench") is not None:
        bits.append(f"1M {rot['m1_vs_bench']:+.1f} vs {rot.get('bench') or 'bench'}")
    if rot.get("mom_dir"):
        bits.append(f"momentum {rot['mom_dir']}")
    if rot.get("approx"):
        bits.append(rot["approx"])
    detail = " · ".join(bits)
    if q is None:
        return _check("rotation", "TIMING", OPEN, f"{name}: no quadrant", detail or "too little history",
                      view="ROT", group_id=rot.get("group_id"))
    state = CONFLICT if q in RULES["conflict_quadrants"] else PASS
    return _check("rotation", "TIMING", state, f"Sector {q.lower()} ({name})", detail, view="ROT",
                  group_id=rot.get("group_id"), quadrant=q)


def check_trend(tr: Optional[dict]) -> dict:
    """`tr` = {close, sma50, sma200, sma50_prev} (any may be None) or None."""
    if tr is None:
        return _check("trend", "TIMING", PENDING, "Trend", "loading price history", view="chart")
    close, s50, s200, s50p = tr.get("close"), tr.get("sma50"), tr.get("sma200"), tr.get("sma50_prev")
    if close is None or s50 is None:
        return _check("trend", "TIMING", OPEN, "Trend", "too little history for the 50-day average",
                      view="chart")
    d50 = (close / s50 - 1) * 100
    parts = [f"{d50:+.1f}% vs 50D"]
    below_long = False
    if s200 is not None:
        d200 = (close / s200 - 1) * 100
        parts.append(f"{d200:+.1f}% vs 200D")
        below_long = close < s200
    falling = s50p is not None and s50 < s50p
    if falling:
        parts.append("50D falling")
    detail = " · ".join(parts)
    if below_long:
        return _check("trend", "TIMING", CONFLICT, "Below its 200-day average", detail, view="chart")
    if close < s50 and falling:
        return _check("trend", "TIMING", CONFLICT, "Below a falling 50-day average", detail, view="chart")
    if close >= s50:
        title = "Above its 50D and 200D" if s200 is not None else "Above its 50D"
    else:
        title = "Under a rising 50D, above its 200D" if s200 is not None else "Under a rising 50D"
    if s200 is None:
        detail += " · no 200D yet"
    return _check("trend", "TIMING", PASS, title, detail, view="chart")


def check_earnings(earn: Optional[dict]) -> Optional[dict]:
    """`earn` = {applicable, next: {date, days_until, estimated, title} | None,
    pending: bool, failed: bool}; None while loading. Returns None when the
    instrument has no earnings (an ETF)."""
    if earn is None:
        return _check("earnings", "EVENTS", PENDING, "Earnings date", "loading", view="CAL")
    if not earn.get("applicable", True):
        return None
    nxt = earn.get("next")
    if nxt is None:
        if earn.get("pending"):
            return _check("earnings", "EVENTS", PENDING, "Earnings date", "asking Yahoo", view="CAL")
        if earn.get("failed"):
            return _check("earnings", "EVENTS", OPEN, "Earnings date unknown",
                          "Yahoo did not answer — check the company's IR page", view="CAL")
        window = earn.get("window_days")
        return _check("earnings", "EVENTS", PASS, "No earnings date ahead",
                      f"none in the next {window} days" if window else "none announced", view="CAL")
    days = nxt["days_until"]
    est = " (estimated)" if nxt.get("estimated") else ""
    detail = f"{nxt['date']}{est}"
    if days <= RULES["earnings_days"]:
        when = "today" if days == 0 else f"in {days} day{'s' if days != 1 else ''}"
        return _check("earnings", "EVENTS", CONFLICT, f"Earnings {when}", detail, view="CAL",
                      date=nxt["date"])
    return _check("earnings", "EVENTS", PASS, f"No earnings in {RULES['earnings_days']} days",
                  f"next {detail} ({days} days)", view="CAL", date=nxt["date"])


def check_macro(macro: Optional[list[dict]]) -> dict:
    """`macro` = upcoming high-impact releases [{date, days_until, title}] or None."""
    if macro is None:
        return _check("macro", "EVENTS", PENDING, "Macro calendar", "loading", view="CAL")
    near = [e for e in macro if 0 <= e["days_until"] <= RULES["macro_days"]]
    if near:
        e = near[0]
        when = "today" if e["days_until"] == 0 else f"in {e['days_until']} day{'s' if e['days_until'] != 1 else ''}"
        more = f" · +{len(near) - 1} more" if len(near) > 1 else ""
        return _check("macro", "EVENTS", CONFLICT, f"{e['title']} {when}", f"{e['date']} · high impact{more}",
                      view="CAL", date=e["date"])
    nxt = next((e for e in macro if e["days_until"] >= 0), None)
    detail = f"next: {nxt['title']} {nxt['date']} ({nxt['days_until']} days)" if nxt else "none in the window"
    return _check("macro", "EVENTS", PASS, f"No high-impact macro in {RULES['macro_days']} days", detail,
                  view="CAL")


def check_book(book: Optional[dict]) -> list[dict]:
    """`book` = {weight_pct, weight_after_pct, sector, sector_pct, sector_after_pct,
    bucket_notional, held: bool} or {"unknown": reason} or None."""
    if book is None:
        return [_check("weight", "BOOK", PENDING, "Weight after buy", "loading TRADE GUARD", view="RISK")]
    if book.get("unknown"):
        return [_check("weight", "BOOK", OPEN, "Weight after buy", book["unknown"], view="RISK")]
    out = []
    w, wa = book.get("weight_pct") or 0.0, book.get("weight_after_pct")
    cap = RULES["max_weight_pct"]
    now = f"now {w:.1f}%" if book.get("held") else "not held"
    if wa is None:
        out.append(_check("weight", "BOOK", OPEN, "Weight after buy", f"{now} · no size-S amount", view="RISK"))
    else:
        state = CONFLICT if wa > cap else PASS
        title = f"Weight {wa:.1f}% after buy" + (f" — over the {cap:.0f}% cap" if state == CONFLICT else "")
        mult = book.get("guard_multiplier")
        size = f"size {RULES['buy_bucket']}" + (f" ×{mult:g} (guard)" if mult is not None and mult != 1 else "")
        out.append(_check("weight", "BOOK", state, title, f"{now} · {size}", view="RISK"))
    sec, sa = book.get("sector"), book.get("sector_after_pct")
    if sec and sa is not None:
        scap = RULES["max_sector_pct"]
        state = CONFLICT if sa > scap else PASS
        title = f"{sec} {sa:.1f}% after buy" + (f" — over the {scap:.0f}% cap" if state == CONFLICT else "")
        out.append(_check("sector", "BOOK", state, title, f"now {book.get('sector_pct') or 0:.1f}%",
                          view="RISK"))
    return out


def check_thesis(th: Optional[dict]) -> list[dict]:
    """`th` = {theses: [{id, title, status}], kill_lines: int, holding_rules: bool}
    or None while loading."""
    if th is None:
        return [_check("thesis", "THESIS", PENDING, "Thesis", "loading", view="THESES")]
    theses = th.get("theses") or []
    if not theses:
        return [_check("thesis", "THESIS", OPEN, "No thesis", "nothing written on why to own it",
                       view="THESES")]
    t = theses[0]
    more = f" · +{len(theses) - 1} more" if len(theses) > 1 else ""
    out = [_check("thesis", "THESIS", PASS, "Thesis written", f"{t['title']}{more}", view="THESES",
                  thesis_id=t["id"])]
    if th.get("kill_lines", 0) > 0:
        out.append(_check("kill", "THESIS", PASS, "Kill line set",
                          f"{th['kill_lines']} tracked number{'s' if th['kill_lines'] != 1 else ''} with a kill line",
                          view="TRACK", thesis_id=t["id"]))
    else:
        out.append(_check("kill", "THESIS", OPEN, "No kill line",
                          "no tracked number says when the thesis is wrong", view="TRACK", thesis_id=t["id"]))
    if th.get("holding_rules"):
        out.append(_check("rules", "THESIS", PASS, "Holding rules written", "", view="THESES",
                          thesis_id=t["id"]))
    else:
        out.append(_check("rules", "THESIS", OPEN, "No holding rules",
                          "no note on stop meaning, caps and when to add", view="THESES", thesis_id=t["id"]))
    return out


# ── Tier ─────────────────────────────────────────────────────────────────────

def tier_of(checks: list[dict]) -> Optional[str]:
    n_conf = sum(c["state"] == CONFLICT for c in checks)
    n_open = sum(c["state"] == OPEN for c in checks)
    if n_conf >= 2:
        return "C"
    if n_conf == 1:
        return "B"
    if any(c["state"] == PENDING for c in checks):
        return None
    if n_open >= 2:
        return "B"
    return "A"


def evaluate(facts: dict) -> dict:
    """Facts → checks, counts, tier and size. `facts` keys: rotation, trend,
    earnings, macro, book, thesis, guard ({light, size_multiplier, why})."""
    checks: list[dict] = [check_rotation(facts.get("rotation")), check_trend(facts.get("trend"))]
    earn = check_earnings(facts.get("earnings"))
    if earn:
        checks.append(earn)
    checks.append(check_macro(facts.get("macro")))
    checks += check_book(facts.get("book"))
    checks += check_thesis(facts.get("thesis"))

    order = {CONFLICT: 0, OPEN: 1, PENDING: 2, PASS: 3}
    checks.sort(key=lambda c: (order[c["state"]], GROUPS.index(c["group"])))
    counts = {s.lower(): sum(c["state"] == s for c in checks) for s in (CONFLICT, OPEN, PASS, PENDING)}
    tier = tier_of(checks)

    guard = facts.get("guard") or None
    tier_size = RULES["tier_size"].get(tier) if tier else None
    guard_mult = guard.get("size_multiplier") if guard else None
    if tier_size is None:
        size = None
    elif guard_mult is None:
        size = tier_size
    else:
        size = min(tier_size, float(guard_mult))
    return {
        "tier": tier,
        "counts": counts,
        "size_multiplier": size,
        "tier_size": tier_size,
        "guard": guard,
        "checks": checks,
        "rules": RULES,
    }
