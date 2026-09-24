"""Portfolio rotation map — where the book's capital sat, week by week.

For every week-end (W-FRI) since the first entry, sum the entry cost of each
lot still open at that date and bucket it by theme, sector or account. Stacked,
that shows capital rotating between buckets: a band that thickens is money
moving in, one that thins is money coming out.

Cost at entry FX, not market value — the chart tracks allocation decisions,
not price drift. A lot is open at week-end t when date_entry <= t and it has
no date_exit or date_exit > t. Lots marked W/L with no exit date have no known
close, so they are left out and counted in `excluded`.

The theme taxonomy is the one from research/graphs/portfolio-rotation-map
(2026-09-19): buckets along the AI build-out chain plus hedge/defensive.
Explicit symbols win; then Thai-market lots → TH LEGACY, crypto → CRYPTO,
everything else → OTHER.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Callable, Iterable, Optional

THEMES: dict[str, tuple[str, ...]] = {
    "MEMORY": ("MU", "SNDK", "SKHU"),
    "COMPUTE": ("AMD", "AVGO", "TSM", "INTC", "NBIS"),
    "PLATFORM": ("GOOGL", "GOOG", "MSFT", "ORCL", "NFLX"),
    "POWER": ("GRID", "SMR", "DELTA", "RKLB"),
    "DEFENSIVE": ("KO", "COST", "UNH", "ABBV", "BH"),
    "HEDGE": ("GC=F", "GLD", "IAU", "SGOV", "VT"),
    "CRYPTO": ("BTC-USD", "BTC", "ETH-USD"),
}
THEME_ORDER = ["TH LEGACY", "PLATFORM", "COMPUTE", "MEMORY", "POWER",
               "DEFENSIVE", "HEDGE", "CRYPTO", "OTHER"]
_SYMBOL_THEME = {s: t for t, syms in THEMES.items() for s in syms}

# A week whose total open cost falls this much is a book-wide cut, not a trim.
CUT_THRESHOLD = 0.20
# A flat opening run this long is placeholder-dated imports, not a book.
FLAT_TRIM_WEEKS = 8


def theme_of(trade: dict) -> str:
    sym = str(trade.get("symbol") or "").upper().removesuffix(".BK")
    if sym in _SYMBOL_THEME:
        return _SYMBOL_THEME[sym]
    market = str(trade.get("market") or "").upper()
    if market == "TH":
        return "TH LEGACY"
    if market == "CRYPTO":
        return "CRYPTO"
    return "OTHER"


def _day(v) -> Optional[date]:
    if not v:
        return None
    try:
        return datetime.strptime(str(v)[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _week_ends(start: date, end: date) -> list[date]:
    """Fridays from the one on/after `start` through the one on/after `end`,
    with the last capped at `end` so the current week reads as of today."""
    first = start + timedelta(days=(4 - start.weekday()) % 7)
    out = []
    d = first
    while d < end:
        out.append(d)
        d += timedelta(days=7)
    out.append(end)
    return out


def build_rotation(
    trades: Iterable[dict],
    key_of: Callable[[dict], str],
    cost_of: Callable[[dict], float],
    today: Optional[date] = None,
    order: Optional[list[str]] = None,
) -> dict:
    """Weekly open-cost per bucket. Pure — the router supplies FX via cost_of."""
    today = today or date.today()
    lots = []
    excluded = 0
    for t in trades:
        entry = _day(t.get("date_entry"))
        exit_ = _day(t.get("date_exit"))
        if entry is None or (exit_ is None and t.get("win_loss") in ("W", "L")):
            excluded += 1
            continue
        cost = cost_of(t)
        if cost <= 0:
            excluded += 1
            continue
        lots.append((entry, exit_, key_of(t), cost, str(t.get("symbol") or "").upper()))
    if not lots:
        return {"weeks": [], "series": [], "total": [], "markers": [], "excluded": excluded}

    weeks = _week_ends(min(e for e, *_ in lots), today)
    by_key: dict[str, list[float]] = defaultdict(lambda: [0.0] * len(weeks))
    open_syms: dict[str, set[str]] = defaultdict(set)
    for entry, exit_, key, cost, sym in lots:
        for i, w in enumerate(weeks):
            if entry <= w and (exit_ is None or exit_ > w):
                by_key[key][i] += cost
        if exit_ is None:
            open_syms[key].add(sym)

    total = [round(sum(v[i] for v in by_key.values()), 2) for i in range(len(weeks))]
    markers = _markers(weeks, total)

    # Placeholder entry dates (bulk imports dated 2025-01-01) leave a long flat
    # run before the first real trade. Start one week before the book first
    # moves so the chart spends its width on decisions, not on a flat line.
    # Only a long run counts — a few quiet weeks after the first buy are history.
    first_move = next((i for i in range(1, len(total)) if total[i] != total[0]), None)
    start = first_move - 1 if first_move is not None and first_move - 1 >= FLAT_TRIM_WEEKS else 0
    flat_since = weeks[0].isoformat() if start else None
    weeks = weeks[start:]
    total = total[start:]
    by_key = {k: v[start:] for k, v in by_key.items()}
    markers = [m for m in markers if m["date"] >= weeks[0].isoformat()]
    rank = {k: i for i, k in enumerate(order or [])}
    keys = sorted(by_key, key=lambda k: (rank.get(k, len(rank)), -by_key[k][-1], k))
    series = [
        {
            "key": k,
            "values": [round(v, 2) for v in by_key[k]],
            "latest": round(by_key[k][-1], 2),
            "peak": round(max(by_key[k]), 2),
            "open_symbols": sorted(open_syms.get(k, ())),
        }
        for k in keys
    ]
    return {
        "weeks": [w.isoformat() for w in weeks],
        "series": series,
        "total": total,
        "markers": markers,
        "excluded": excluded,
        "flat_since": flat_since,
    }


def _markers(weeks, total) -> list[dict]:
    """Book-wide cuts only. Per-bucket "first money in" labels were dropped
    (2026-09-25): on the sector view they piled up and covered the chart."""
    out: list[dict] = []
    for i in range(1, len(weeks)):
        prev, cur = total[i - 1], total[i]
        if prev > 0 and (prev - cur) / prev >= CUT_THRESHOLD:
            out.append({"date": weeks[i].isoformat(), "kind": "cut",
                        "label": f"ลดพอร์ต −{(prev - cur) / prev * 100:.0f}%"})
    return out
