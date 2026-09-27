"""BOND decomposition — driver attribution, lens snapshot, double-count, tripwires."""
from datetime import date, timedelta

import bond_decomposition as bd

TODAY = date(2026, 9, 26)


def _days(n: int) -> list[str]:
    return [(TODAY - timedelta(days=n - i)).isoformat() for i in range(n)]


def _series(dates: list[str], start: float, end: float) -> dict[str, float]:
    n = len(dates) - 1
    return {d: start + (end - start) * i / n for i, d in enumerate(dates)}


def _flat(dates, v):
    return {d: v for d in dates}


# ── classify_driver ──────────────────────────────────────────────────────────

def test_driver_is_largest_piece_in_direction_of_move():
    assert bd.classify_driver(40, 2, -2, 40) == "REAL"
    assert bd.classify_driver(5, 3, 30, 38) == "TP"
    assert bd.classify_driver(2, 25, 5, 32) == "BE"


def test_piece_against_the_move_is_never_the_driver():
    # Yield down 30: TP rose 20 (against), real fell 45 → REAL drove the fall
    assert bd.classify_driver(-45, -5, 20, -30) == "REAL"


def test_quiet_below_threshold():
    assert bd.classify_driver(5, 1, 1, 7) is None


# ── build on synthetic series ────────────────────────────────────────────────

def _case(real_end=2.85, be_end=2.33, tp_end=0.65):
    ds = _days(120)
    real = _series(ds, 1.35, real_end)      # ≈ +25bp per 20 days
    be = _series(ds, 2.30, be_end)
    tp = _series(ds, 0.60, tp_end)
    nominal = {d: real[d] + be[d] for d in ds}
    # ACM-style: fitted yield = expected + TP, expected ≈ nominal − TP
    expected = {d: nominal[d] - tp[d] for d in ds}
    model_y = {d: expected[d] + tp[d] for d in ds}
    return nominal, real, be, model_y, expected, tp


def test_real_led_selloff_names_real():
    out = bd.build(*_case(), today=TODAY)
    assert out["driver"]["key"] == "REAL"
    a20 = next(r for r in out["attribution"] if r["days"] == 20)
    assert a20["realShare"] >= 90


def test_tp_led_selloff_names_tp():
    ds = _days(400)
    real = _flat(ds, 2.5)
    be = _flat(ds, 2.3)
    tp = {d: 0.2 + 6.0 * i / 399 for i, d in enumerate(ds)}  # ≈ +30bp/20d
    expected = {d: real[d] + be[d] for d in ds}
    model_y = {d: expected[d] + tp[d] for d in ds}
    nominal = model_y
    out = bd.build(nominal, real, be, model_y, expected, tp, today=TODAY)
    assert out["driver"]["key"] == "TP"


def test_snapshot_lenses_and_double_count():
    snap = bd.build(*_case(), today=TODAY)["snapshot"]
    assert abs(snap["market"]["residual_bp"]) < 0.5
    assert abs(snap["model"]["residual_bp"]) < 0.5
    p = snap["pieces"]
    assert abs(p["expReal"] + p["breakeven"] + p["termPremium"] - p["total"]) < 1e-3
    # real + BE + TP overshoots the yield by exactly TP
    assert abs(snap["doubleCount"]["overshoot_bp"] - 65.0) < 0.5


def test_lens_dates_are_not_mixed():
    # ACM a day behind FRED: the model lens must report its own date
    nominal, real, be, model_y, expected, tp = _case()
    last = max(expected)
    for s in (model_y, expected, tp):
        s.pop(last)
    snap = bd.snapshot(nominal, real, be, model_y, expected, tp)
    assert snap["market"]["asOf"] == last
    assert snap["model"]["asOf"] < last


# ── tripwires ────────────────────────────────────────────────────────────────

def test_tp_through_prior_high_is_breach_and_flip_needs_both():
    ds = _days(3000)
    tp = _flat(ds, 0.3)
    tp[ds[1000]] = 0.895                        # the old high
    for d in ds[-5:]:
        tp[d] = 0.95                            # new high in the last week
    be = _flat(ds, 2.3)
    be[ds[500]] = 3.04                          # BE's 20y high, far above today
    nominal = _flat(ds, 5.17)
    t = bd.tripwires(nominal, be, tp, TODAY)
    w = {x["id"]: x for x in t["wires"]}
    assert w["TP_HIGH"]["status"] == "BREACH"   # prior high excludes the last 20 points
    assert w["TP_HIGH"]["level"] == 0.895
    assert w["BE_RANGE"]["status"] == "OK"
    assert t["flip"] is False

    for d in ds[-3:]:
        be[d] = 3.10
    t = bd.tripwires(nominal, be, tp, TODAY)
    assert t["flip"] is True


def test_be_watch_between_warn_and_high():
    ds = _days(3000)
    be = _flat(ds, 2.2)
    be[ds[400]] = 3.04
    be[ds[-1]] = 2.6
    t = bd.tripwires(_flat(ds, 5.0), be, _flat(ds, 0.3), TODAY)
    w = {x["id"]: x for x in t["wires"]}
    assert w["BE_RANGE"]["status"] == "WATCH"
    assert w["NOM_ALARM"]["gap_bp"] == 50.0


def test_long_run_stats():
    ds = _days(800)
    s = _series(ds, 1.0, 3.0)
    lr = bd.long_run(s, 20, TODAY)
    assert lr["min"] == 1.0 and lr["max"] == 3.0 and lr["pctile"] == 100
