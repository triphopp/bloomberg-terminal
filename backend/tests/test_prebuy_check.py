"""prebuy_check.py — the rules behind MKT → STRUCTURE → CHECK.

Holds the promises the panel makes: a lagging sector is a conflict, missing data
is never shown as tier A, the tier only counts (no weighting), and the TRADE
GUARD multiplier caps the size without counting as a conflict of the symbol.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import prebuy_check as pc  # noqa: E402

ROT_LEAD = {"sector": "Utilities (XLU)", "group_id": "XLU", "quadrant": "Leading", "mom_dir": "up",
            "m1_vs_bench": 4.0, "bench": "SPY"}
TREND_UP = {"close": 110.0, "sma50": 100.0, "sma200": 90.0, "sma50_prev": 98.0}
EARN_FAR = {"applicable": True, "next": {"date": "2026-11-20", "days_until": 28, "estimated": False,
                                         "title": "Earnings"}, "pending": False, "failed": False}
MACRO_QUIET = [{"date": "2026-11-05", "days_until": 13, "title": "CPI"}]
BOOK_OK = {"held": False, "weight_pct": 0.0, "weight_after_pct": 3.0, "sector": "Utilities",
           "sector_pct": 5.0, "sector_after_pct": 8.0, "guard_multiplier": 1.0}
THESIS_FULL = {"theses": [{"id": "t1", "title": "Grid capex", "status": "active"}],
               "kill_lines": 1, "holding_rules": True}


def facts(**over):
    base = {"rotation": ROT_LEAD, "trend": TREND_UP, "earnings": EARN_FAR, "macro": MACRO_QUIET,
            "book": BOOK_OK, "thesis": THESIS_FULL,
            "guard": {"light": "GREEN", "size_multiplier": 1.0, "why": []}}
    base.update(over)
    return base


def states(out):
    return {c["id"]: c["state"] for c in out["checks"]}


def test_clean_symbol_is_tier_a_full_size():
    out = pc.evaluate(facts())
    assert out["tier"] == "A"
    assert out["counts"]["conflict"] == 0
    assert out["size_multiplier"] == 1.0


def test_lagging_sector_is_a_conflict_weakening_is_not():
    lag = pc.evaluate(facts(rotation={**ROT_LEAD, "quadrant": "Lagging"}))
    assert states(lag)["rotation"] == pc.CONFLICT
    assert lag["tier"] == "B"
    weak = pc.evaluate(facts(rotation={**ROT_LEAD, "quadrant": "Weakening"}))
    assert states(weak)["rotation"] == pc.PASS


def test_two_conflicts_is_tier_c_zero_size():
    out = pc.evaluate(facts(rotation={**ROT_LEAD, "quadrant": "Lagging"},
                            trend={"close": 80.0, "sma50": 100.0, "sma200": 90.0, "sma50_prev": 101.0}))
    assert out["tier"] == "C"
    assert out["size_multiplier"] == 0.0
    # conflicts are listed first
    assert [c["state"] for c in out["checks"][:2]] == [pc.CONFLICT, pc.CONFLICT]


def test_trend_rules():
    below_200 = pc.check_trend({"close": 95.0, "sma50": 90.0, "sma200": 100.0, "sma50_prev": 89.0})
    assert below_200["state"] == pc.CONFLICT
    below_falling_50 = pc.check_trend({"close": 95.0, "sma50": 100.0, "sma200": 80.0, "sma50_prev": 101.0})
    assert below_falling_50["state"] == pc.CONFLICT
    below_rising_50 = pc.check_trend({"close": 95.0, "sma50": 100.0, "sma200": 80.0, "sma50_prev": 99.0})
    assert below_rising_50["state"] == pc.PASS
    short_history = pc.check_trend({"close": 95.0, "sma50": None, "sma200": None, "sma50_prev": None})
    assert short_history["state"] == pc.OPEN


def test_earnings_inside_the_window_is_a_conflict():
    near = {**EARN_FAR, "next": {**EARN_FAR["next"], "days_until": pc.RULES["earnings_days"]}}
    assert pc.check_earnings(near)["state"] == pc.CONFLICT
    after = {**EARN_FAR, "next": {**EARN_FAR["next"], "days_until": pc.RULES["earnings_days"] + 1}}
    assert pc.check_earnings(after)["state"] == pc.PASS


def test_earnings_unknown_is_never_pass():
    pending = {"applicable": True, "next": None, "pending": True, "failed": False}
    assert pc.check_earnings(pending)["state"] == pc.PENDING
    failed = {"applicable": True, "next": None, "pending": False, "failed": True}
    assert pc.check_earnings(failed)["state"] == pc.OPEN


def test_macro_within_days_is_a_conflict():
    out = pc.check_macro([{"date": "2026-10-26", "days_until": 3, "title": "FOMC decision"}])
    assert out["state"] == pc.CONFLICT
    assert pc.check_macro([{"date": "2026-10-28", "days_until": 5, "title": "FOMC decision"}])["state"] == pc.PASS


def test_pending_without_conflict_has_no_tier():
    out = pc.evaluate(facts(trend=None))
    assert out["tier"] is None
    assert out["size_multiplier"] is None


def test_pending_does_not_hide_a_conflict():
    out = pc.evaluate(facts(trend=None, rotation={**ROT_LEAD, "quadrant": "Lagging"}))
    assert out["tier"] == "B"


def test_open_questions_alone_reach_tier_b():
    out = pc.evaluate(facts(thesis={"theses": [{"id": "t1", "title": "x", "status": "draft"}],
                                    "kill_lines": 0, "holding_rules": False}))
    assert states(out)["kill"] == pc.OPEN and states(out)["rules"] == pc.OPEN
    assert out["tier"] == "B"
    one_open = pc.evaluate(facts(thesis={"theses": []}))
    assert one_open["tier"] == "A"


def test_book_caps():
    over = pc.check_book({**BOOK_OK, "weight_after_pct": 10.5, "sector_after_pct": 26.0})
    assert [c["state"] for c in over] == [pc.CONFLICT, pc.CONFLICT]
    at_cap = pc.check_book({**BOOK_OK, "weight_after_pct": 10.0, "sector_after_pct": 25.0})
    assert [c["state"] for c in at_cap] == [pc.PASS, pc.PASS]


def test_guard_caps_size_but_is_not_a_conflict():
    out = pc.evaluate(facts(guard={"light": "RED", "size_multiplier": 0.5, "why": ["DD"]}))
    assert out["tier"] == "A"
    assert out["counts"]["conflict"] == 0
    assert out["size_multiplier"] == 0.5


def test_etf_without_earnings_skips_the_check():
    out = pc.evaluate(facts(earnings={"applicable": False}))
    assert "earnings" not in states(out)
