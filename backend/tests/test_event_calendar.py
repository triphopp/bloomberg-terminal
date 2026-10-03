"""
Macro event calendar behind TAIL's context panel.

Pins the two facts that were wrong before: a decision day is day 0 (not
"tomorrow"), and FRED outages degrade to FOMC-only instead of raising.
"""
from datetime import date

import pytest

import event_calendar as ec


@pytest.fixture(autouse=True)
def _fresh_cache(monkeypatch):
    monkeypatch.setattr(ec, "_cache", ec.TTLCache(ttl=60))


def _fake_fred(dates_by_release):
    def fetch(rid, start, end):
        return [d for d in dates_by_release.get(rid, []) if start <= ec._d(d) <= end]
    return fetch


def test_fomc_list_matches_fed_sep_meetings():
    # SEP meetings cross-checked against FRED release 326 on 2026-09-16.
    sep = [d for d, s in ec.FOMC_DECISIONS if s and d.startswith("2026")]
    assert sep == ["2026-03-18", "2026-06-17", "2026-09-16", "2026-12-09"]
    # Decision dates are the second day of the meeting: a Wednesday, except the
    # November 2024 meeting, moved to Wed–Thu around the election.
    thursday = {"2024-11-07"}
    assert all(
        ec._d(d).weekday() == (3 if d in thursday else 2) for d, _ in ec.FOMC_DECISIONS
    )


def test_decision_day_is_day_zero():
    nxt = ec.next_fomc(date(2026, 9, 16))
    assert nxt == {"date": "2026-09-16", "days_until": 0, "sep": True}
    assert ec.next_fomc(date(2026, 9, 17))["date"] == "2026-10-28"
    assert ec.next_fomc(date(2028, 1, 1)) is None


def test_business_days_skip_weekends():
    fri, mon = date(2026, 9, 18), date(2026, 9, 21)
    assert ec.business_days_between(fri, mon) == 1
    assert ec.business_days_between(mon, fri) == -1
    assert ec.business_days_between(fri, fri) == 0


def test_payload_window_and_ordering(monkeypatch):
    monkeypatch.setattr(ec, "_fetch_release_dates", _fake_fred({
        10: ["2026-10-14"], 50: ["2026-10-02", "2026-09-04"], 54: ["2026-09-30"], 53: ["2026-09-30"],
    }))
    p = ec.calendar_payload(date(2026, 9, 17))
    assert p["releases_ok"] is True
    # Day after the decision is still inside the ±1 business-day window.
    assert p["event_window"]["active"] is True
    assert [e["kind"] for e in p["event_window"]["events"]] == ["FOMC"]
    kinds = [(e["date"], e["kind"]) for e in p["upcoming"] if e["source"] != "rule"][:4]
    assert kinds == [("2026-09-30", "PCE"), ("2026-09-30", "GDP"), ("2026-10-02", "NFP"), ("2026-10-14", "CPI")]
    assert ("2026-09-04", "NFP") in [(e["date"], e["kind"]) for e in p["past"]]


def test_quiet_day_has_no_window(monkeypatch):
    monkeypatch.setattr(ec, "_fetch_release_dates", _fake_fred({}))
    p = ec.calendar_payload(date(2026, 9, 23))
    assert p["event_window"]["active"] is False


def test_fred_outage_degrades_to_fomc_only(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("FRED down")
    monkeypatch.setattr(ec, "_fetch_release_dates", boom)
    p = ec.calendar_payload(date(2026, 10, 27))
    assert p["releases_ok"] is False
    assert [e["kind"] for e in p["upcoming"] if e["source"] != "rule"][:1] == ["FOMC"]


def test_calendar_expiry_flags(monkeypatch):
    monkeypatch.setattr(ec, "_fetch_release_dates", _fake_fred({}))
    expiring = ec.calendar_payload(date(2027, 11, 1))
    assert (expiring["fomc_calendar_expiring"], expiring["fomc_calendar_stale"]) == (True, False)
    stale = ec.calendar_payload(date(2028, 1, 5))
    assert (stale["fomc_calendar_expiring"], stale["fomc_calendar_stale"]) == (False, True)
    assert stale["next_fomc"] is None


def test_rule_dates():
    # Third Friday; Thursday when it is Good Friday (2025-04-18).
    assert ec.monthly_opex(2026, 10) == date(2026, 10, 16)
    assert ec.monthly_opex(2025, 4) == date(2025, 4, 17)
    # 30 days before next month's expiry: a Wednesday, a Tuesday before the
    # Good Friday expiry (March 2025 VIX settled Tue 2025-03-18).
    assert ec.vix_settlement(2026, 10) == date(2026, 10, 21)
    assert ec.vix_settlement(2025, 3) == date(2025, 3, 18)
    # EIA: Wednesday, Thursday after a Mon–Wed federal holiday. Checked against
    # eia.gov's schedule: Columbus Day and Veterans Day 2025 → Thu 10-16, 11-13;
    # Juneteenth on a Thursday moves nothing.
    assert ec.eia_weekly(date(2026, 10, 7)) == date(2026, 10, 7)
    assert ec.eia_weekly(date(2025, 10, 15)) == date(2025, 10, 16)
    assert ec.eia_weekly(date(2025, 11, 12)) == date(2025, 11, 13)
    assert ec.eia_weekly(date(2025, 1, 1)) == date(2025, 1, 2)
    assert ec.eia_weekly(date(2025, 6, 18)) == date(2025, 6, 18)


def test_rule_events_in_payload(monkeypatch):
    monkeypatch.setattr(ec, "_fetch_release_dates", _fake_fred({}))
    ev = ec.rule_events(date(2026, 12, 28), date(2027, 1, 31))
    by = {}
    for e in ev:
        by.setdefault(e["kind"], []).append(e["date"])
    # New Year's Day is a holiday: ISM moves to the next business days.
    assert by["ISM"] == ["2027-01-04", "2027-01-06"]
    assert by["OPEX"] == ["2027-01-15"]
    assert by["MINUTES"] == ["2026-12-30"]  # 2026-12-09 decision + 3 weeks
    assert by["EIA"] == ["2026-12-30", "2027-01-06", "2027-01-13", "2027-01-21", "2027-01-27"]
    assert all(e["source"] == "rule" for e in ev)


def test_weekly_and_rule_events_do_not_open_the_window(monkeypatch):
    # Claims on the day, EIA the day before, expiry two days out — none of
    # them is a reason to discount a vol signal.
    monkeypatch.setattr(ec, "_fetch_release_dates", _fake_fred({180: ["2026-10-08"], 46: ["2026-10-08"]}))
    p = ec.calendar_payload(date(2026, 10, 8))
    assert {"CLAIMS", "PPI", "EIA"} <= {e["kind"] for e in p["upcoming"] + p["past"]}
    assert p["event_window"]["active"] is False


def test_regime_labels():
    from routers.tail_risk import assess_regime
    r = assess_regime({
        "gdp": {"value": 1.2}, "cpi": {"value": 3.4},
        "unemployment": {"value": 4.3}, "fed_rate": {"value": 4.33},
    })
    assert r["growth"] == {"state": "SLOWING", "tone": "watch"}
    assert r["inflation"] == {"state": "ELEVATED", "tone": "bad"}
    assert r["labor"] == {"state": "BALANCED", "tone": "good"}
    assert r["policy"] == {"state": "RESTRICTIVE", "tone": "bad"}
    assert assess_regime({})["growth"] == {"state": None, "tone": "unknown"}


def test_macro_context_marks_itself_uncounted(monkeypatch):
    import routers.tail_risk as tr
    import routers.macro as macro
    import oil_inventory
    monkeypatch.setattr(ec, "_fetch_release_dates", _fake_fred({}))
    monkeypatch.setattr(oil_inventory, "oil_payload", lambda: None)  # no EIA call from a test
    monkeypatch.setattr(macro, "get_macro", lambda: {
        "indicators": {"cpi": {"value": 2.9, "prev": 3.0, "date": "2026-08-01", "series": []}},
        "yield_curve": {"spread_10y_2y": -0.1, "spread_10y_3m": 0.2, "10y": 4.1},
        "fed": {"current_rate": 4.1, "stance": "CUTTING"},
    })
    out = tr._macro_context()
    assert out["counted_in_composite"] is False
    assert out["macro_ok"] is True
    assert out["yield_curve"]["inverted_10y_2y"] is True
    assert out["yield_curve"]["inverted_10y_3m"] is False
    assert out["fed"] == {"rate": 4.1, "stance": "CUTTING"}
    assert "series" not in out["indicators"]["cpi"]
    assert out["calendar"]["next_fomc"]["date"] >= "2026-01-28"
