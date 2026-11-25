"""
The one calendar (calendar_feed.py, routers/calendar_feed.py, calendar_scheduler.py).

What it promises, and so what these guard: every dated thing arrives in one
list tied to the thesis it belongs to; a request never waits on Yahoo and a
symbol that failed is not hammered; a reminder is written once, links to its
thesis, and is cleared when its day is over.
"""
import importlib
import time
from datetime import date, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from persist_cache import PersistentStore

TODAY = date.today()


def _iso(days: int) -> str:
    return (TODAY + timedelta(days=days)).isoformat()


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "cal.db"))
    monkeypatch.setenv("SYNC_DEVICE_ID", "PC")
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema(); db.init_guard_schema()
    db.init_zettel_schema(); db.init_questions_schema(); db.init_tracking_schema()
    db.init_series_schema(); db.init_alerts_schema(); db.init_sync_layer(); db.init_audit_layer()
    db.init_oplog_layer()
    import routers.theses as theses
    importlib.reload(theses)
    import routers.zettel as zettel
    importlib.reload(zettel)
    import routers.questions as questions
    importlib.reload(questions)
    import routers.tracking as tracking
    importlib.reload(tracking)
    import routers.alert_rules as alert_rules
    importlib.reload(alert_rules)
    import calendar_feed as feed
    importlib.reload(feed)
    import routers.calendar_feed as cal_router
    importlib.reload(cal_router)
    import calendar_scheduler as sched
    importlib.reload(sched)

    # Never the machine's real cache file, never FRED, never Yahoo.
    monkeypatch.setattr(feed, "_store", PersistentStore(None, max_age=feed.KEEP_S))
    monkeypatch.setattr(feed, "_inflight", set())
    monkeypatch.setattr(feed, "_queue", type(feed._queue)())
    monkeypatch.setattr(feed, "_active", 0)
    fred = feed.fred_release_dates
    monkeypatch.setattr(fred, "_store", PersistentStore(None, max_age=fred.KEEP_S))
    monkeypatch.setattr(fred, "_vstore", PersistentStore(None, max_age=fred.KEEP_S))
    monkeypatch.setattr(fred, "_inflight", set())
    monkeypatch.setattr(fred, "_queue", type(fred._queue)())
    monkeypatch.setattr(fred, "_active", 0)
    fred_calls: list[tuple[int, int]] = []
    real_fetch = fred._fetch

    def fake_fred(rid, year):
        fred_calls.append((rid, year))
        return []

    monkeypatch.setattr(fred, "_fetch", fake_fred)
    monkeypatch.setattr(fred, "_fetch_obs", lambda series, year: fred_calls.append((series, year)) or [])
    calls: list[str] = []

    def fake_fetch(symbol):
        calls.append(symbol)
        return {"earnings": [], "dividends": [], "upcoming_dividends": [], "splits": [], "errors": {}}

    monkeypatch.setattr(feed, "_fetch_company", fake_fetch)

    app = FastAPI()
    for r in (theses, zettel, questions, tracking, alert_rules, cal_router):
        app.include_router(r.router)

    class Env:
        pass

    e = Env()
    e.client, e.feed, e.sched, e.db, e.calls, e.monkeypatch = TestClient(app), feed, sched, db, calls, monkeypatch
    e.fred, e.fred_calls, e.fred_real_fetch = fred, fred_calls, real_fetch
    yield e
    _drain(feed)


def _drain(feed, timeout=10.0):
    """Let the background company and FRED pulls finish."""
    deadline = time.time() + timeout
    while not (feed.idle() and feed.fred_release_dates.idle()):
        assert time.time() < deadline, "background pulls did not finish"
        time.sleep(0.005)


def _thesis(env, symbol="NVDA", **kw):
    r = env.client.post("/api/v2/theses", json={"symbol": symbol, "title": f"{symbol} thesis", **kw})
    assert r.status_code == 200, r.text
    return r.json()["thesis"]


def _note(env, thesis, title, day, **kw):
    r = env.client.post(f"/api/v2/theses/{thesis['id']}/notes",
                        json={"kind": "CATALYST", "title": title, "watch_date": day, **kw})
    assert r.status_code == 200, r.text
    return r.json()["note"]


def _get(env, start=-3, end=40, **params):
    r = env.client.get("/api/calendar", params={"start": _iso(start), "end": _iso(end), **params})
    assert r.status_code == 200, r.text
    return r.json()


def _by_id(payload):
    return {e["id"]: e for e in payload["events"]}


# ── Macro ────────────────────────────────────────────────────────────────────

def _fred_dates(env, by_release: dict[int, list[str]]):
    """FRED answers with these dates (per release id, any year)."""
    def fetch(rid, year):
        env.fred_calls.append((rid, year))
        return [d for d in by_release.get(rid, []) if d.startswith(str(year))]
    env.monkeypatch.setattr(env.fred, "_fetch", fetch)


def test_macro_events_carry_source_and_whether_the_date_is_only_a_rule(env):
    _fred_dates(env, {10: ["2026-10-14"], 53: ["2026-10-29"]})
    env.feed.macro_events(date(2026, 10, 1), date(2026, 10, 31))
    _drain(env.feed)
    events, src = env.feed.macro_events(date(2026, 10, 1), date(2026, 10, 31))
    by = {e["id"]: e for e in events}

    fomc = by["macro:FOMC:2026-10-28"]
    assert (fomc["category"], fomc["impact"], fomc["estimated"]) == ("MACRO", "high", False)
    assert fomc["source"] == "federalreserve.gov" and fomc["source_url"]
    cpi = by["macro:CPI:2026-10-14"]
    assert (cpi["source"], cpi["impact"], cpi["estimated"]) == ("FRED", "high", False)
    gdp = by["macro:GDP:2026-10-29"]
    assert "rid=53" in gdp["source_url"] and "GDPC1" in gdp["detail"]
    opex = by["macro:OPEX:2026-10-16"]
    assert opex["estimated"] is True and opex["source"] == "rule"
    # A whole year per FRED call, each release once: moving the grid by a month hits the store.
    assert sorted(c for c in env.fred_calls if isinstance(c[0], int)) == sorted(
        (rid, 2026) for rid in env.fred.RELEASES)
    assert src["releases_ok"] is True and src["pending"] == [] and src["fomc_missing"] is False


def test_the_request_never_waits_on_fred(env):
    import threading
    gate = threading.Event()

    def slow(rid, year):
        gate.wait(5)
        return ["2026-11-25"] if rid == 53 else []

    env.monkeypatch.setattr(env.fred, "_fetch", slow)
    t0 = time.time()
    events, src = env.feed.macro_events(date(2026, 11, 1), date(2026, 11, 30))
    assert time.time() - t0 < 1
    assert len(src["pending"]) == len(env.fred.RELEASES) and src["releases_ok"] is True
    assert any(e["kind"] == "OPEX" for e in events)  # rule dates are there at once
    gate.set()
    _drain(env.feed)
    events, src = env.feed.macro_events(date(2026, 11, 1), date(2026, 11, 30))
    assert "macro:GDP:2026-11-25" in {e["id"] for e in events} and src["pending"] == []


def test_every_fred_release_on_cal_is_consistent(env):
    fred = env.fred
    assert not set(fred.RELEASES) & set(fred.SKIPPED)
    # TAIL's market-moving releases are all on CAL, under the same kind.
    for rid, (kind, _label) in fred.ec.FRED_RELEASES.items():
        assert fred.RELEASES[rid].kind == kind
    kinds = [r.kind for r in fred.RELEASES.values()]
    assert len(kinds) == len(set(kinds)), "two releases under one kind would share event ids"
    for r in fred.RELEASES.values():
        assert r.impact in ("high", "medium", "low")
    reads = {s for r in fred.RELEASES.values() for s in r.series}
    assert {"GDPC1", "PCEPI", "CPIAUCSL", "PAYEMS", "NFCI", "STLFSI4", "MORTGAGE30US",
            "UMCSENT", "SAHMREALTIME", "CFNAI"} <= reads


def test_weekly_fred_prints_are_low_and_never_a_reminder(env):
    _fred_dates(env, {190: [TODAY.isoformat()], 10: [TODAY.isoformat()]})
    env.feed.build(TODAY, TODAY + timedelta(days=3), TODAY)
    _drain(env.feed)
    p = env.feed.build(TODAY, TODAY + timedelta(days=3), TODAY, fetch=False)
    by = {e["kind"]: e for e in p["events"] if e["date"] == TODAY.isoformat()}
    assert by["MORTGAGE"]["impact"] == "low" and by["CPI"]["impact"] == "high"
    kinds = {a["snapshot"]["kind"] for a in env.feed.alertable(p["events"], TODAY)}
    assert "CPI" in kinds and "MORTGAGE" not in kinds


def test_a_release_turned_daily_is_refused(env):
    env.monkeypatch.setattr(env.fred.ec, "_fetch_release_dates",
                            lambda rid, s, e: [f"2026-01-{d:02d}" for d in range(1, 32)] * 3)
    with pytest.raises(RuntimeError):
        env.fred_real_fetch(22, 2026)


def test_fred_down_keeps_the_last_good_dates_and_does_not_ask_again_at_once(env):
    _fred_dates(env, {53: ["2026-11-25"]})
    env.feed.macro_events(date(2026, 11, 1), date(2026, 11, 30))
    _drain(env.feed)
    env.fred_calls.clear()

    def down(rid, year):
        env.fred_calls.append((rid, year))
        raise ValueError("Expecting value: line 1 column 1 (char 0)")  # FRED's maintenance page

    env.monkeypatch.setattr(env.fred, "_fetch", down)
    env.feed.macro_events(date(2026, 11, 1), date(2026, 11, 30), force=True)
    _drain(env.feed)
    events, src = env.feed.macro_events(date(2026, 11, 1), date(2026, 11, 30))
    _drain(env.feed)
    assert "macro:GDP:2026-11-25" in {e["id"] for e in events}
    assert src["releases_ok"] is True and src["failed"]["53:2026"] == "ValueError"
    # Asked once by the forced refresh, not again by the next request (negative cache).
    assert len([c for c in env.fred_calls if isinstance(c[0], int)]) == len(env.fred.RELEASES)


def test_fred_down_from_cold_leaves_fomc_and_rule_dates_standing(env):
    def down(rid, year):
        raise ConnectionError("no route")

    env.monkeypatch.setattr(env.fred, "_fetch", down)
    env.feed.build(date(2026, 10, 1), date(2026, 10, 31), date(2026, 10, 8))
    _drain(env.feed)
    p = env.feed.build(date(2026, 10, 1), date(2026, 10, 31), date(2026, 10, 8), fetch=False)
    assert p["sources"]["macro"]["releases_ok"] is False
    assert "macro:FOMC:2026-10-28" in _by_id(p)


def test_a_window_past_the_fomc_list_says_so(env):
    last = date.fromisoformat(env.feed.ec.FOMC_CALENDAR_THROUGH)
    _, src = env.feed.macro_events(last, last + timedelta(days=40))
    assert src["fomc_missing"] is True


# ── What a FRED release printed ──────────────────────────────────────────────

# A191RL1Q225SBEA as FRED returns it with a realtime window (2026-11-25):
# Q3 2026 advance 3.4 on 10-29, second estimate 4.3 on 11-25.
_GDP_ROWS = [
    ("2026-04-01", "2026-07-30", "2026-09-29", 1.5), ("2026-04-01", "2026-09-30", "9999-12-31", 2.2),
    ("2026-07-01", "2026-10-29", "2026-11-24", 3.4), ("2026-07-01", "2026-11-25", "9999-12-31", 4.3),
]


def test_a_release_day_reads_the_vintage_in_force_that_day(env):
    vals = env.fred.vintage_values(_GDP_ROWS, "direct", 2026)
    assert vals["2026-10-29"] == [3.4, 2.2, "Q3 2026"]   # the advance, not today's revision
    assert vals["2026-11-25"] == [4.3, 2.2, "Q3 2026"]


def test_transforms_match_tail(env):
    rows = [(f"2025-{m:02d}-01", "2025-01-01", "9999-12-31", 100.0 + m) for m in range(1, 13)]
    rows += [("2026-01-01", "2026-02-11", "9999-12-31", 110.0)]
    yoy = env.fred.vintage_values(rows, "yoy_pct", 2026)["2026-02-11"]
    assert yoy[0] == pytest.approx((110 / 101 - 1) * 100) and yoy[2] == "Jan 2026"
    diff = env.fred.vintage_values(rows, "mom_diff", 2026)["2026-02-11"]
    assert diff[:2] == [pytest.approx(-2.0), pytest.approx(1.0)]
    # The index a year earlier was never collected (CPI Oct 2025): no y/y, not a wrong one.
    gap = [r if r[0] != "2025-01-01" else (r[0], r[1], r[2], None) for r in rows]
    assert env.fred.vintage_values(gap, "yoy_pct", 2026)["2026-02-11"][0] is None


def _fred_obs(env, by_series: dict[str, list]):
    def fetch(series, year):
        env.fred_calls.append((series, year))
        return by_series.get(series, [])
    env.monkeypatch.setattr(env.fred, "_fetch_obs", fetch)


def test_a_release_that_has_come_carries_what_it_printed(env):
    _fred_dates(env, {53: ["2026-10-29", "2026-11-25", "2026-12-23"]})
    _fred_obs(env, {"A191RL1Q225SBEA": _GDP_ROWS})
    today = date(2026, 11, 25)
    env.feed.build(date(2026, 10, 1), date(2026, 12, 31), today)
    _drain(env.feed)
    env.feed.build(date(2026, 10, 1), date(2026, 12, 31), today)   # values are asked once dates are held
    _drain(env.feed)
    p = env.feed.build(date(2026, 10, 1), date(2026, 12, 31), today, fetch=False)
    by = _by_id(p)
    gdp = by["macro:GDP:2026-11-25"]
    assert gdp["actual"] == [{"series": "A191RL1Q225SBEA", "label": "Real GDP q/q saar", "value": 4.3,
                              "text": "4.30%", "prev_text": "2.20%", "period": "Q3 2026"}]
    assert gdp["detail"].startswith("Real GDP q/q saar 4.30% (Q3 2026, prev 2.20%) · FRED release 53")
    assert by["macro:GDP:2026-10-29"]["actual"][0]["text"] == "3.40%"
    assert by["macro:GDP:2026-12-23"]["actual"] is None          # its day has not come
    assert by["macro:FOMC:2026-10-28"]["actual"] is None          # not a FRED release


def test_a_print_not_on_fred_yet_is_asked_again_soon_but_not_at_once(env):
    _fred_dates(env, {53: ["2026-11-25"]})
    _fred_obs(env, {"A191RL1Q225SBEA": _GDP_ROWS[:3]})               # FRED has not picked 11-25 up
    today = date(2026, 11, 25)
    for _ in range(2):
        env.feed.macro_events(date(2026, 11, 1), date(2026, 11, 30), today=today)
        _drain(env.feed)
    events, _ = env.feed.macro_events(date(2026, 11, 1), date(2026, 11, 30), today=today, fetch=False)
    assert {e["id"]: e for e in events}["macro:GDP:2026-11-25"]["actual"] == []
    asked = [c for c in env.fred_calls if c[0] == "A191RL1Q225SBEA"]
    assert asked == [("A191RL1Q225SBEA", 2026)]
    # RETRY_S later the awaited series alone is asked again.
    key = env.fred._vkey("A191RL1Q225SBEA", 2026)
    entry = env.fred._vstore.get(key)
    env.fred._vstore.put(key, {**entry, "tried": entry["tried"] - env.fred.RETRY_S - 1})
    _fred_obs(env, {"A191RL1Q225SBEA": _GDP_ROWS})
    env.feed.macro_events(date(2026, 11, 1), date(2026, 11, 30), today=today)
    _drain(env.feed)
    events, _ = env.feed.macro_events(date(2026, 11, 1), date(2026, 11, 30), today=today, fetch=False)
    assert {e["id"]: e for e in events}["macro:GDP:2026-11-25"]["actual"][0]["text"] == "4.30%"
    assert [c for c in env.fred_calls if c[0] == "A191RL1Q225SBEA"] == [("A191RL1Q225SBEA", 2026)] * 2


def test_values_are_never_asked_for_a_year_still_to_come(env):
    today = date(2026, 12, 20)
    env.feed.macro_events(date(2026, 12, 1), date(2027, 1, 31), today=today)
    _drain(env.feed)
    env.feed.macro_events(date(2026, 12, 1), date(2027, 1, 31), today=today)
    _drain(env.feed)
    assert not [c for c in env.fred_calls if isinstance(c[0], str) and c[1] == 2027]


def test_every_headline_belongs_to_a_release_on_cal(env):
    for rid, heads in env.fred.HEADLINES.items():
        assert rid in env.fred.RELEASES
        for h in heads:
            assert h.xform in ("direct", "yoy_pct", "mom_pct", "mom_diff")
            h.fmt.format(1.0)
    series = [h.series for hs in env.fred.HEADLINES.values() for h in hs]
    assert len(series) == len(set(series)), "one series, one transform: the store is keyed by series"


# ── Theses ───────────────────────────────────────────────────────────────────

def test_a_dated_note_is_an_event_of_its_thesis(env):
    t = _thesis(env)
    n = _note(env, t, "Q3 earnings — watch DC margin", _iso(5), body="gross margin above 74%")
    e = _by_id(_get(env))[f"note:{n['id']}"]
    assert (e["category"], e["kind"], e["tag"], e["date"]) == ("THESIS", "NOTE", "CATALYST", _iso(5))
    assert e["theses"] == [{"id": t["id"], "symbol": "NVDA", "title": "NVDA thesis",
                            "status": t["status"], "via": "note"}]
    assert e["ref"]["type"] == "note" and e["ref"]["thesis_id"] == t["id"]
    assert e["days_until"] == 5 and e["done"] is False


def test_a_resolved_note_stays_on_its_day_but_is_done(env):
    t = _thesis(env)
    n = _note(env, t, "Guidance raised?", _iso(2))
    env.client.patch(f"/api/v2/theses/{t['id']}/notes/{n['id']}", json={"status": "confirmed"})
    assert _by_id(_get(env))[f"note:{n['id']}"]["done"] is True


def test_notes_without_a_date_or_of_a_deleted_thesis_are_not_events(env):
    t = _thesis(env)
    env.client.post(f"/api/v2/theses/{t['id']}/notes", json={"title": "undated"})
    gone = _thesis(env, "INTC")
    _note(env, gone, "orphan", _iso(3))
    env.client.delete(f"/api/v2/theses/{gone['id']}")
    assert [e for e in _get(env)["events"] if e["category"] == "THESIS"] == []


def test_a_question_date_links_to_the_thesis_of_its_question(env):
    t = _thesis(env, "INTC")
    q = env.client.post("/api/v2/questions", json={
        "title": "Does Intel gain share?", "thought": "x", "thesis_id": t["id"], "is_root": True,
    }).json()["question"]
    d = env.client.post("/api/v2/questions/calendar", json={
        "title": "Intel Q3/26 10-Q", "date": _iso(10), "source": "estimated from last year",
        "kind": "FILING", "symbol": "INTC",
        "questions": [{"question": q["ref"], "reads": "DCAI revenue"}],
    }).json()["date"]
    e = _by_id(_get(env))[f"qdate:{d['id']}"]
    assert (e["kind"], e["tag"], e["estimated"]) == ("QDATE", "FILING", True)
    assert [x["id"] for x in e["theses"]] == [t["id"]] and e["theses"][0]["via"] == "question"
    assert (e["ref"]["questions"][0]["id"], e["ref"]["questions"][0]["reads"]) == (q["id"], "DCAI revenue")
    assert e["detail"] == ""  # the question is a link in `ref`, not prose repeated here


def test_a_date_with_no_question_still_finds_its_thesis_by_symbol(env):
    t = _thesis(env, "MU")
    d = env.client.post("/api/v2/questions/calendar", json={
        "title": "Micron investor day", "date": _iso(7), "source": "me", "kind": "EVENT", "symbol": "MU",
    }).json()["date"]
    e = _by_id(_get(env))[f"qdate:{d['id']}"]
    assert e["theses"] == [{"id": t["id"], "symbol": "MU", "title": "MU thesis",
                            "status": t["status"], "via": "symbol"}]


# ── Company dates ────────────────────────────────────────────────────────────

def _company_fetch(env, **by_symbol):
    def fetch(symbol):
        env.calls.append(symbol)
        got = by_symbol.get(symbol.replace(".", "_"))
        if isinstance(got, Exception):
            raise got
        return got or {"earnings": [], "dividends": [], "upcoming_dividends": [], "splits": [], "errors": {}}

    env.monkeypatch.setattr(env.feed, "_fetch_company", fetch)


def test_company_dates_load_behind_the_request_and_link_by_symbol(env):
    t = _thesis(env, "NVDA")
    _company_fetch(env, NVDA={
        "earnings": [{"date": f"{_iso(6)} 16:00", "epsEstimate": 1.25, "reportedEPS": None,
                      "surprise": None, "eventType": "Earnings", "estimated": True,
                      "windowEnd": _iso(9), "source": "yahoo_calendar"},
                     {"date": f"{_iso(-2)} 16:00", "epsEstimate": 0.5, "reportedEPS": 0.6,
                      "surprise": 20.0, "eventType": "Earnings"}],
        "dividends": [], "splits": [],
        "upcoming_dividends": [{"date": _iso(12), "payDate": _iso(30), "dividend": 0.01, "estimated": True}],
        "errors": {},
    })
    first = _get(env)
    # The answer came back without waiting on the pull — and says what it is waiting on.
    assert first["sources"]["company"]["symbols"] == 1
    _drain(env.feed)

    p = _get(env)
    by = _by_id(p)
    assert p["sources"]["company"] == {**p["sources"]["company"], "pending": [], "failed": {}, "loaded": 1}
    up = by[f"co:EARNINGS:NVDA:{_iso(6)}"]
    assert up["estimated"] is True and up["done"] is False
    assert "EPS est 1.25" in up["detail"] and _iso(9) in up["detail"]
    assert up["theses"][0] == {"id": t["id"], "symbol": "NVDA", "title": "NVDA thesis",
                               "status": t["status"], "via": "symbol"}
    past = by[f"co:EARNINGS:NVDA:{_iso(-2)}"]
    assert past["done"] is True and past["detail"] == "EPS 0.60 vs est 0.50 (+20.0%)"
    div = by[f"co:DIVIDEND:NVDA:{_iso(12)}"]
    assert "0.01 per share" in div["detail"] and f"pays {_iso(30)}" in div["detail"]
    assert env.calls == ["NVDA"]  # the second request reused the pull


def test_a_failed_symbol_is_not_asked_again_and_keeps_its_last_good_dates(env):
    _thesis(env, "NVDA")
    good = {"earnings": [{"date": _iso(6), "epsEstimate": None, "reportedEPS": None,
                          "surprise": None, "eventType": "Earnings"}],
            "dividends": [], "upcoming_dividends": [], "splits": [], "errors": {}}
    _company_fetch(env, NVDA=good)
    _get(env)
    _drain(env.feed)

    # Hours later Yahoo throttles: both halves fail.
    entry = env.feed._store.get("NVDA")
    env.feed._store.put("NVDA", {**entry, "tried": entry["tried"] - env.feed.FRESH_S - 1})
    _company_fetch(env, NVDA={"earnings": [], "dividends": [], "upcoming_dividends": [], "splits": [],
                              "errors": {"earnings": "HTTP 429", "dividends": "HTTP 429"}})
    _get(env)
    _drain(env.feed)
    p = _get(env)
    _drain(env.feed)
    assert f"co:EARNINGS:NVDA:{_iso(6)}" in _by_id(p)                      # last good still shown
    assert p["sources"]["company"]["failed"] == {"NVDA": {"earnings": "HTTP 429", "dividends": "HTTP 429"}}
    assert env.calls == ["NVDA", "NVDA"]                                   # … and not asked a third time


def test_the_universe_is_theses_and_holdings_by_the_symbol_the_book_trades(env):
    _thesis(env, "AOT")                                   # written the short way
    _thesis(env, "PORTFOLIO", kind="process")             # not an instrument
    _thesis(env, "ORCL", status="closed")                 # over
    with env.db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('a', 'A', 'THB')")
        for sym, res, market, wl in (("AOT", "AOT.BK", "TH", "L"), ("GULF", "GULF.BK", "TH", "P"),
                                     ("BTC-USD", "BTC-USD", "CRYPTO", "P")):
            conn.execute(
                "INSERT INTO trades (id, account_id, symbol, resolved_symbol, market, date_entry, "
                "price_entry, volume, win_loss) VALUES (?, 'a', ?, ?, ?, '2026-01-05', 10, 100, ?)",
                (f"t-{sym}", sym, res, market, wl))
        conn.commit()
        _, by_symbol = env.feed.load_theses(conn)
        u = env.feed.company_universe(conn, by_symbol)
    assert u == {"AOT.BK": {"symbol": "AOT.BK", "display": "AOT", "held": False},
                 "GULF.BK": {"symbol": "GULF.BK", "display": "GULF", "held": True}}


# ── The book's own dates ─────────────────────────────────────────────────────

def test_option_expiry_and_hold_review_are_on_the_calendar(env):
    t = _thesis(env, "NVDA")
    with env.db.get_db() as conn:
        conn.execute("INSERT INTO option_contracts (contract_id, occ_symbol, underlying, expiry, strike, "
                     "option_type) VALUES ('c1', 'NVDA_C', 'NVDA', ?, 150, 'call')", (_iso(9),))
        conn.execute("INSERT INTO option_trades (trade_id, contract_id, account_id, trade_date, action, "
                     "side, quantity, price) VALUES ('o1', 'c1', 'a', '2026-01-05', 'OPEN', 'BUY', 2, 3.5)")
        conn.execute("INSERT INTO risk_decisions (id, kind, decision, symbol, reason, review_on, created_at) "
                     "VALUES ('h1', 'STOP', 'HOLD', 'NVDA', 'waiting for earnings', ?, '2026-01-05')",
                     (_iso(4),))
        conn.commit()
    by = _by_id(_get(env))
    exp = by[f"opt:NVDA:{_iso(9)}"]
    assert (exp["category"], exp["kind"], exp["detail"]) == ("PORT", "EXPIRY", "C150 ×2")
    assert exp["theses"][0]["id"] == t["id"]
    hold = by["hold:h1"]
    assert (hold["kind"], hold["date"], hold["detail"]) == ("REVIEW", _iso(4), "waiting for earnings")


# ── Reminders ────────────────────────────────────────────────────────────────

def _ev(feed, eid, day, category="THESIS", kind="NOTE", **kw):
    return feed._event(eid, day.isoformat(), category, kind, kw.pop("title", eid), **kw)


def test_alertable_is_today_and_the_next_business_day_only(env):
    feed = env.feed
    fri = date(2026, 10, 9)
    thesis = [{"id": "T1", "symbol": "NVDA", "title": "t", "status": "active", "via": "note"}]
    events = [
        _ev(feed, "note:today", fri, theses=thesis, ref={"type": "note", "id": "n1", "thesis_id": "T1"}),
        _ev(feed, "note:monday", date(2026, 10, 12), theses=thesis),
        _ev(feed, "note:tuesday", date(2026, 10, 13), theses=thesis),
        _ev(feed, "note:yesterday", date(2026, 10, 8), theses=thesis),
        _ev(feed, "note:resolved", fri, theses=thesis, done=True),
        _ev(feed, "macro:FOMC", fri, "MACRO", "FOMC", impact="high"),
        _ev(feed, "macro:CLAIMS", fri, "MACRO", "CLAIMS", impact="low"),
        _ev(feed, "co:EARNINGS", fri, "COMPANY", "EARNINGS", symbol="MU"),
    ]
    got = {a["snapshot"]["event_id"]: a for a in feed.alertable(events, fri)}
    assert set(got) == {"note:today", "note:monday", "macro:FOMC", "co:EARNINGS"}
    a = got["note:today"]
    assert (a["rule_id"], a["symbol"]) == ("cal:NOTE", "NVDA")
    assert a["snapshot"]["thesis_id"] == "T1" and a["snapshot"]["note_id"] == "n1"
    assert a["bar_time"].startswith("2026-10-09#")
    assert got["macro:FOMC"]["symbol"] == "MACRO" and "thesis_id" not in got["macro:FOMC"]["snapshot"]


def test_a_reminder_is_written_once_names_its_thesis_and_is_cleared_after_its_day(env):
    t = _thesis(env)
    n = _note(env, t, "Earnings call", _iso(0))
    payload = env.feed.build(TODAY, TODAY + timedelta(days=5), TODAY, fetch=False)
    with env.db.get_db() as conn:
        assert len(env.sched.apply(conn, payload["events"], TODAY)) >= 1
        assert env.sched.apply(conn, payload["events"], TODAY) == []          # same scan again: nothing new

    events = env.client.get("/api/alerts/events", params={"acked": "false"}).json()
    mine = [e for e in events if e["snapshot"].get("note_id") == n["id"]]
    assert len(mine) == 1
    e = mine[0]
    assert (e["ruleId"], e["symbol"], e["ruleName"]) == ("cal:NOTE", "NVDA", "CALENDAR · NOTE")
    assert e["snapshot"]["thesis_id"] == t["id"] and e["snapshot"]["date"] == _iso(0)
    assert e["notify"] == ["ticker", "toast"]                                  # belongs to a thesis

    with env.db.get_db() as conn:                                              # the next morning
        env.sched.apply(conn, [], TODAY + timedelta(days=1))
    left = env.client.get("/api/alerts/events", params={"acked": "false"}).json()
    assert [x for x in left if x["ruleId"].startswith("cal:")] == []


def test_a_macro_reminder_stays_on_the_strip(env):
    with env.db.get_db() as conn:
        env.sched.apply(conn, [_ev(env.feed, "macro:FOMC:x", TODAY, "MACRO", "FOMC",
                                   title="FOMC decision", impact="high")], TODAY)
    e = env.client.get("/api/alerts/events").json()[0]
    assert (e["ruleId"], e["symbol"], e["notify"]) == ("cal:FOMC", "MACRO", ["ticker"])


# ── The route ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("params", [
    {"start": "tomorrow"},
    {"start": "2026-10-10", "end": "2026-10-01"},
    {"start": "2026-01-01", "end": "2028-01-01"},
])
def test_a_bad_window_is_refused_not_answered_empty(env, params):
    assert env.client.get("/api/calendar", params=params).status_code == 422


def test_events_come_soonest_first_with_the_theses_to_pick_from(env):
    t = _thesis(env)
    _note(env, t, "later", _iso(9))
    _note(env, t, "sooner", _iso(1))
    p = _get(env, start=0, end=10)
    mine = [e["title"] for e in p["events"] if e["category"] == "THESIS"]
    assert mine == ["sooner", "later"]
    assert p["theses"] == [{"id": t["id"], "symbol": "NVDA", "title": "NVDA thesis", "status": t["status"]}]
    assert [e["date"] for e in p["events"]] == sorted(e["date"] for e in p["events"])


def test_a_fetch_that_blows_up_is_still_recorded_so_it_is_not_asked_at_once(env):
    _thesis(env, "NVDA")
    _company_fetch(env, NVDA=RuntimeError("yahoo changed its page"))
    for _ in range(3):
        _get(env)
        _drain(env.feed)
    assert env.calls == ["NVDA"]
    assert env.feed._store.get("NVDA")["errors"] == {"earnings": "RuntimeError", "dividends": "RuntimeError"}


def test_what_the_calendar_form_sends_is_accepted_by_the_routes_that_own_it(env):
    """AddEventForm.tsx posts these two bodies; each must land on its day."""
    t = _thesis(env)
    r = env.client.post(f"/api/v2/theses/{t['id']}/notes", json={
        "kind": "CATALYST", "title": "FOMC decision", "body": "rate path sets the multiple",
        "impact": None, "watch_date": _iso(3), "status": "open"})
    assert r.status_code == 200, r.text
    r2 = env.client.post("/api/v2/questions/calendar", json={
        "title": "TSMC monthly sales", "date": _iso(4), "status": "ESTIMATED",
        "source": "บันทึกเอง", "source_url": "", "symbol": None, "kind": "EVENT", "note": ""})
    assert r2.status_code == 200, r2.text
    by = _by_id(_get(env))
    assert by[f"note:{r.json()['note']['id']}"]["date"] == _iso(3)
    assert by[f"qdate:{r2.json()['date']['id']}"]["date"] == _iso(4)
    # "confirmed" without the announcement link is refused, and says why.
    r3 = env.client.post("/api/v2/questions/calendar", json={
        "title": "Investor day", "date": _iso(5), "status": "CONFIRMED", "source": "IR page",
        "source_url": "", "symbol": None, "kind": "EVENT", "note": ""})
    assert r3.status_code == 422 and r3.json()["detail"]["missing"]


def test_ask_reads_the_calendar_nearest_first_not_its_far_end(env):
    import ask_pages

    t = _thesis(env)
    for i in range(1, 46):
        _note(env, t, f"day {i}", _iso(i))
    _note(env, t, "last week", _iso(-5))
    path, params, shape = ask_pages.lookup("calendar", "events")
    assert (path, params) == ("/api/calendar", {})
    out = shape(_get(env, start=-7, end=45), 5)
    mine = [e for e in out["events"] if e["category"] == "THESIS"]
    titles = [e["title"] for e in mine]
    assert titles[:3] == ["day 1", "day 2", "day 3"] and "last week" not in titles
    assert len(out["events"]) == 20 and mine[0]["theses"] == ["NVDA"]
    assert "earlier ones left out" in out["_note"]


def test_a_reminder_outlives_a_restart(env):
    """Start-up acknowledges events whose rule was deleted. A reminder has no
    rule by design — swept with them it would be gone after every reload."""
    t = _thesis(env)
    n = _note(env, t, "Earnings call", _iso(0))
    payload = env.feed.build(TODAY, TODAY + timedelta(days=5), TODAY, fetch=False)
    with env.db.get_db() as conn:
        env.sched.apply(conn, payload["events"], TODAY)
        conn.execute("INSERT INTO alert_events (rule_id, symbol, fired_at, bar_time, snapshot_json) "
                     "VALUES ('deleted-rule', 'X', '2026-01-01', '2026-01-01', '{}')")
        conn.commit()
    env.db.init_alerts_schema()                       # what every start-up runs
    left = env.client.get("/api/alerts/events", params={"acked": "false"}).json()
    assert [e["snapshot"].get("note_id") for e in left] == [n["id"]]


# ── A question waits on a calendar event ─────────────────────────────────────

def _question(env, thesis, title="Does data-center revenue keep growing?"):
    r = env.client.post("/api/v2/questions", json={"title": title, "thesis_id": thesis["id"]})
    assert r.status_code == 200, r.text
    return r.json()["question"]


def _link(env, event_id, q, reads="data-center revenue", status=200):
    r = env.client.post("/api/calendar/questions",
                        json={"event_id": event_id, "question": q["ref"], "reads": reads})
    assert r.status_code == status, r.text
    return r.json()


def test_a_company_date_becomes_one_question_date_that_every_question_reuses(env):
    t = _thesis(env, "NVDA")
    _company_fetch(env, NVDA={
        "earnings": [{"date": f"{_iso(6)} 16:00", "epsEstimate": 1.25, "reportedEPS": None,
                      "surprise": None, "eventType": "Earnings", "estimated": True,
                      "source": "yahoo_calendar"}],
        "dividends": [], "splits": [], "upcoming_dividends": [], "errors": {},
    })
    _get(env)
    _drain(env.feed)
    eid = f"co:EARNINGS:NVDA:{_iso(6)}"
    q1, q2 = _question(env, t), _question(env, t, "Do gross margins hold above 70%?")

    d = _link(env, eid, q1)["date"]
    assert (d["kind"], d["symbol"], d["date"][:10]) == ("EARNINGS", "NVDA", _iso(6))
    # Yahoo's day is not the company's announcement: estimated, and it says where it came from.
    assert d["status"] == "ESTIMATED" and d["source"].startswith("terminal calendar:")
    assert eid in d["note"]
    again = _link(env, eid, q2, reads="gross margin")["date"]
    assert again["id"] == d["id"] and {q["ref"] for q in again["questions"]} == {q1["ref"], q2["ref"]}
    _link(env, eid, q1, status=409)   # already waiting on it

    # On the calendar the questions now hang on that day.
    qdate = _by_id(_get(env))[f"qdate:{d['id']}"]
    assert {q["ref"] for q in qdate["ref"]["questions"]} == {q1["ref"], q2["ref"]}


def test_a_macro_release_links_confirmed_only_with_the_publishers_link(env):
    t = _thesis(env, "TLT")
    q = _question(env, t, "Does core inflation keep falling?")
    day = env.feed.ec.fomc_events(TODAY, TODAY + timedelta(days=200))[0]["date"][:10]
    d = _link(env, f"macro:FOMC:{day}", q, reads="the statement on balance-sheet runoff")["date"]
    assert (d["status"], d["kind"]) == ("CONFIRMED", "EVENT") and d["source_url"]
    assert d["questions"][0]["reads"].startswith("the statement")


def test_the_question_turns_due_when_the_day_comes(env):
    t = _thesis(env, "TLT")
    q = _question(env, t, "Did the Fed signal a cut?")
    past = env.feed.ec.fomc_events(TODAY - timedelta(days=120), TODAY - timedelta(days=1))[-1]["date"][:10]
    _link(env, f"macro:FOMC:{past}", q, reads="the dot plot median")
    queued = env.client.get("/api/v2/questions/queue").json()["queue"]
    assert q["ref"] in {r["ref"] for r in queued}
    got = env.client.get(f"/api/v2/questions/{q['ref']}").json()
    assert got["state"]["due"] is True


def test_only_events_that_can_answer_a_question_are_linked(env):
    t = _thesis(env)
    q = _question(env, t)
    note = _note(env, t, "AI capex readout", _iso(3))
    _link(env, f"note:{note['id']}:{_iso(3)}", q, status=404)  # not a calendar id
    bad = env.client.post("/api/calendar/questions", json={"event_id": "nonsense", "question": q["ref"]})
    assert bad.status_code == 422
    missing = env.client.post("/api/calendar/questions",
                              json={"event_id": f"macro:CPI:{_iso(2)}", "question": q["ref"]})
    assert missing.status_code == 404


def test_mcp_get_calendar_filters_and_keeps_what_an_agent_needs(monkeypatch):
    import json
    import mcp_server

    def ev(eid, cat, kind, **kw):
        return {"id": eid, "date": "2026-11-12", "days_until": 20, "category": cat, "kind": kind,
                "title": kind, "symbol": None, "impact": None, "estimated": False, "source": "",
                "source_url": "", "detail": "", "done": False, "due": False, "theses": [],
                "ref": None, "tag": None, **kw}

    payload = {"as_of": "2026-10-23", "start": "2026-10-16", "end": "2026-12-07", "events": [
        ev("macro:CPI:2026-11-12", "MACRO", "CPI", impact="high", source="FRED"),
        ev("macro:JOLTS:2026-11-12", "MACRO", "JOLTS", impact="medium"),
        ev("co:EARNINGS:NVDA:2026-11-19", "COMPANY", "EARNINGS", symbol="NVDA", estimated=True,
           theses=[{"id": "t1"}]),
        ev("co:DIVIDEND:NVDA:2026-09-01", "COMPANY", "DIVIDEND", symbol="NVDA", done=True,
           theses=[{"id": "t1"}]),
        ev("qdate:d1", "THESIS", "QDATE", theses=[{"id": "t1"}],
           ref={"type": "question_date", "ref": "D-0001",
                "questions": [{"ref": "Q-0001", "title": "q", "status": "OPEN", "reads": "rev", "id": "x"}]}),
    ], "sources": {"macro": {"ok": True, "fomc_through": "2026-12-09"},
                   "company": {"ok": True, "pending": ["AAPL"]}, "notes": {"ok": False, "error": "X"}}}
    monkeypatch.setattr(mcp_server, "_call", lambda *a, **k: payload)

    out = json.loads(mcp_server.get_calendar())
    assert [e["id"] for e in out["events"]] == ["macro:CPI:2026-11-12", "macro:JOLTS:2026-11-12",
                                                "co:EARNINGS:NVDA:2026-11-19", "qdate:d1"]  # done left out
    assert out["pending"] == ["AAPL"] and "notes" in out["sources_failed"]
    q = out["events"][-1]
    assert q["questions"] == [{"ref": "Q-0001", "title": "q", "status": "OPEN", "reads": "rev"}]
    assert out["events"][2]["theses"] == ["t1"] and out["events"][2]["estimated"] is True
    hi = json.loads(mcp_server.get_calendar(min_impact="high"))
    assert "macro:JOLTS:2026-11-12" not in {e["id"] for e in hi["events"]}
    t1 = json.loads(mcp_server.get_calendar(thesis_id="t1", include_done=True))
    assert {e["kind"] for e in t1["events"]} == {"EARNINGS", "DIVIDEND", "QDATE"}
