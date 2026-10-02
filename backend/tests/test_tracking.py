"""
Thesis tracking (routers/tracking.py).

What the feature promises, and so what these guard: a tracked number says where
it is read, a forecast is written before the result and never after, the
numbers decide the verdict, a miss stays on the board until someone explains
it, and a kill line cannot be moved quietly.
"""
import importlib
from datetime import date, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "t.db"))
    monkeypatch.setenv("SYNC_DEVICE_ID", "PC")
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema(); db.init_zettel_schema()
    db.init_questions_schema(); db.init_tracking_schema(); db.init_series_schema()
    db.init_alerts_schema(); db.init_sync_layer(); db.init_audit_layer()
    # Under the op-log capture triggers, same as test_questions: that is where a
    # second write to a row still pending flush would 500.
    db.init_oplog_layer()
    import routers.theses as theses
    importlib.reload(theses)
    import routers.zettel as zettel
    importlib.reload(zettel)
    import routers.questions as questions
    importlib.reload(questions)
    import routers.tracking as tracking
    importlib.reload(tracking)

    app = FastAPI()
    app.include_router(theses.router)
    app.include_router(zettel.router)
    app.include_router(questions.router)
    app.include_router(tracking.router)
    return TestClient(app)


T = "/api/v2/tracking"
Q = "/api/v2/questions"
AGENT = {"X-Thesis-Actor": "agent:claude"}
SOON = (date.today() + timedelta(days=30)).isoformat()
PAST = (date.today() - timedelta(days=2)).isoformat()
TODAY = date.today().isoformat()

SOURCE = {"source_name": "Micron 10-Q", "source_url": "https://investors.micron.com/sec-filings",
          "source_locator": "Balance sheet → Inventories; income statement → Cost of goods sold",
          "source_tool": "MCP get_stock_data(MU, balance_sheet)"}
EVIDENCE = {"source_url": "https://sec.gov/mu-10q", "quote": "Inventories 8,355"}


def _thesis(client, symbol="MU"):
    return client.post("/api/v2/theses", json={"symbol": symbol, "title": "tight to 2028"}).json()["thesis"]


def _metric(client, thesis, title="Inventory days (DIO)", **extra):
    r = client.post(T, json={"title": title, "thesis_id": thesis["id"], "unit": "days",
                             **SOURCE, **extra})
    assert r.status_code == 200, r.text
    return r.json()["metric"]


def _expect(client, m, period="FQ1 FY27", due=SOON, **extra):
    body = {"period": period, "expected": "falls to about 120 days", "low": 115, "high": 125,
            "basis": "management guided inventory down", "due_date": due, **extra}
    r = client.post(f"{T}/{m['id']}/expectations", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _read(client, m, value, headers=None, **extra):
    return client.post(f"{T}/{m['id']}/readings", headers=headers or {},
                       json={"value": value, "as_of": TODAY, **EVIDENCE, **extra})


def _state(client, m):
    return client.get(f"{T}/{m['id']}").json()["state"]


def _zettel(client, title="MU 10-Q FQ1 FY27: inventories"):
    r = client.post("/api/v2/zettel", json={
        "title": title, "kind": "EVIDENCE",
        "sources": [{"url": "https://sec.gov/mu", "publisher": "SEC", "quote": "Inventories 8,355",
                     "reliability": "primary"}]})
    assert r.status_code == 200, r.text
    return r.json()["zettel"]


# ── A metric says where its number is read ───────────────────────────────────

def test_a_metric_is_captured_with_a_title_and_reports_what_is_missing(client):
    t = _thesis(client)
    r = client.post(T, json={"title": "DRAM contract price QoQ", "thesis_id": t["id"],
                             "role": "KILLER"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["metric"]["ref"] == "K-0001" and d["metric"]["symbol"] == "MU"
    assert d["state"]["status"] == "SETUP"
    assert d["state"]["gaps"] == ["source", "kill_rule", "expectation"]
    assert client.get(f"{T}/counts").json()["setup"] == 1


def test_a_source_needs_who_publishes_it_and_how_to_get_there(client):
    t = _thesis(client)
    named = client.post(T, json={"title": "GM", "thesis_id": t["id"],
                                 "source_name": "Micron press release"}).json()
    assert "source" in named["state"]["gaps"]              # a name alone is not a place to go
    m = _metric(client, t)
    assert "source" not in _state(client, m)["gaps"]


def test_a_metric_belonging_to_no_thesis_or_tracked_twice_is_refused(client):
    assert client.post(T, json={"title": "DIO"}).status_code == 422
    t = _thesis(client)
    _metric(client, t)
    again = client.post(T, json={"title": "inventory  days (dio)", "thesis_id": t["id"]})
    assert again.status_code == 409 and "K-0001" in again.json()["detail"]


def test_a_kill_line_is_a_number_with_its_words(client):
    t = _thesis(client)
    half = client.post(T, json={"title": "DIO", "thesis_id": t["id"], "kill_op": ">"})
    assert half.status_code == 422
    assert any("go together" in x for x in half.json()["detail"]["missing"])
    bare = client.post(T, json={"title": "DIO", "thesis_id": t["id"], "kill_op": ">",
                                "kill_value": 140})
    assert any("kill_rule" in x for x in bare.json()["detail"]["missing"])


# ── A forecast: before the result, with a reason and a date ──────────────────

def test_a_forecast_without_reason_or_date_is_refused_with_everything_missing(client):
    m = _metric(client, _thesis(client))
    r = client.post(f"{T}/{m['id']}/expectations", json={"expected": "lower"})
    assert r.status_code == 422
    missing = " | ".join(r.json()["detail"]["missing"])
    assert "period" in missing and "basis" in missing and "date" in missing
    assert _state(client, m)["next"] is None


def test_a_forecast_waits_then_comes_due(client):
    t = _thesis(client)
    m = _metric(client, t)
    s = _expect(client, m)["state"]
    assert s["status"] == "WAITING" and s["next"]["days_until"] == 30 and not s["due"]

    late = _metric(client, t, title="Receivables (DSO)")
    s2 = _expect(client, late, due=PAST)["state"]
    assert s2["status"] == "DUE" and s2["next"]["due"]
    c = client.get(f"{T}/counts").json()
    assert (c["due"], c["waiting"], c["alert"]) == (1, 1, 1)
    assert c["by_thesis"][t["id"]]["due"] == 1


def test_a_forecast_tied_to_the_calendar_moves_with_it(client):
    m = _metric(client, _thesis(client))
    d = client.post(f"{Q}/calendar", json={"title": "Micron FQ1 FY27 earnings", "date": SOON,
                                           "source": "estimated from last year"}).json()["date"]
    s = _expect(client, m, due=None, date=d["ref"])["state"]
    assert s["next"]["date"] == SOON and s["next"]["date_status"] == "ESTIMATED"
    client.patch(f"{Q}/calendar/{d['id']}", json={
        "date": PAST, "status": "CONFIRMED", "source_url": "https://investors.micron.com/x",
        "reason": "Micron announced"})
    s = _state(client, m)
    assert s["status"] == "DUE" and s["next"]["date"] == PAST and s["next"]["date_status"] == "CONFIRMED"
    # The calendar lists the metric under that date before and after it is read.
    assert [(w["date_id"], w["reading"]) for w in s["waits"]] == [(d["id"], None)]
    w = _read(client, m, 120).json()["state"]["waits"][0]
    assert w["date_id"] == d["id"] and w["reading"]["verdict"] == "IN_LINE"


def test_a_forecast_can_put_its_event_on_the_calendar_and_a_bad_date_writes_nothing(client):
    m = _metric(client, _thesis(client))
    bad = client.post(f"{T}/{m['id']}/expectations", json={
        "period": "FQ1 FY27", "expected": "lower", "basis": "guided",
        "new_date": {"title": "Micron FQ1 FY27 earnings", "date": SOON, "status": "CONFIRMED",
                     "source": "IR"}})
    assert bad.status_code == 422                          # CONFIRMED without the announcement
    assert client.get(f"{Q}/calendar").json()["dates"] == []
    assert _state(client, m)["next"] is None

    ok = client.post(f"{T}/{m['id']}/expectations", json={
        "period": "FQ1 FY27", "expected": "lower", "basis": "guided", "release_time": "16:05 ET",
        "new_date": {"title": "Micron FQ1 FY27 earnings", "date": SOON, "kind": "EARNINGS",
                     "source": "estimated from last year"}})
    assert ok.status_code == 200, ok.text
    cal = client.get(f"{Q}/calendar").json()["dates"]
    assert [(c["title"], c["symbol"]) for c in cal] == [("Micron FQ1 FY27 earnings", "MU")]
    assert ok.json()["state"]["next"]["date_ref"] == cal[0]["ref"]
    assert ok.json()["periods"][0]["expectation"]["release_time"] == "16:05 ET"


def test_a_revised_forecast_stands_and_the_old_one_is_kept(client):
    m = _metric(client, _thesis(client))
    _expect(client, m)
    d = _expect(client, m, expected="about 110 days", low=105, high=115)
    assert len(d["periods"]) == 1
    p = d["periods"][0]
    assert p["expectation"]["expected"] == "about 110 days"
    assert [x["expected"] for x in p["revisions"]] == ["falls to about 120 days"]


def test_a_forecast_is_not_set_after_the_result(client):
    m = _metric(client, _thesis(client))
    _expect(client, m)
    assert _read(client, m, 120).status_code == 200
    r = client.post(f"{T}/{m['id']}/expectations", json={
        "period": "fq1 fy27", "expected": "110", "basis": "hindsight", "due_date": SOON})
    assert r.status_code == 409 and "already has its number" in r.json()["detail"]


# ── A reading: evidence, and the numbers decide ──────────────────────────────

def test_a_reading_without_evidence_or_date_is_refused(client):
    m = _metric(client, _thesis(client))
    _expect(client, m)
    r = client.post(f"{T}/{m['id']}/readings", json={"value": 120})
    assert r.status_code == 422
    missing = " | ".join(r.json()["detail"]["missing"])
    assert "as_of" in missing and "evidence" in missing
    assert _state(client, m)["last"] is None


def test_a_number_inside_the_band_is_in_line_and_asks_for_the_next_forecast(client):
    m = _metric(client, _thesis(client))
    _expect(client, m)
    d = _read(client, m, 121.5).json()
    r = d["periods"][0]["reading"]
    assert (r["verdict"], r["kill"], r["value_text"]) == ("IN_LINE", False, "121.5 days")
    assert d["opened_question"] is None
    assert d["state"]["status"] == "SETUP" and d["state"]["gaps"] == ["expectation"]


def test_the_numbers_decide_the_verdict_not_the_caller(client):
    m = _metric(client, _thesis(client))
    _expect(client, m)
    r = _read(client, m, 131, verdict="IN_LINE")
    assert r.status_code == 422
    assert any("that is ABOVE, not IN_LINE" in x for x in r.json()["detail"]["missing"])
    assert _read(client, m, 131).json()["periods"][0]["reading"]["verdict"] == "ABOVE"

    t2 = _thesis(client, "SNDK")
    low = _metric(client, t2)
    _expect(client, low)
    assert _read(client, low, 100).json()["periods"][0]["reading"]["verdict"] == "BELOW"


def test_a_forecast_in_words_needs_someone_to_say_whether_it_held(client):
    m = _metric(client, _thesis(client), title="CXMT ships DDR5 outside China")
    _expect(client, m, low=None, high=None, expected="no volume shipments")
    r = client.post(f"{T}/{m['id']}/readings", json={
        "value_text": "HP confirmed a CXMT-based SKU", "as_of": TODAY, **EVIDENCE})
    assert r.status_code == 422 and any("verdict" in x for x in r.json()["detail"]["missing"])
    ok = client.post(f"{T}/{m['id']}/readings", json={
        "value_text": "HP confirmed a CXMT-based SKU", "as_of": TODAY, "verdict": "OFF",
        **EVIDENCE})
    assert ok.status_code == 200 and ok.json()["periods"][0]["reading"]["verdict"] == "OFF"


def test_a_reading_can_cite_a_zettel_instead_of_a_link(client):
    m = _metric(client, _thesis(client))
    _expect(client, m)
    z = _zettel(client)
    r = client.post(f"{T}/{m['id']}/readings", headers=AGENT,
                    json={"value": 120, "as_of": TODAY, "zettel": z["ref"]})
    assert r.status_code == 200, r.text
    reading = r.json()["periods"][0]["reading"]
    assert reading["zettel"]["ref"] == z["ref"] and reading["actor"] == "agent:claude"
    missing = client.post(f"{T}/{m['id']}/readings",
                          json={"value": 120, "as_of": TODAY, "zettel": "Z-9999"})
    assert missing.status_code == 422


def test_a_number_with_no_forecast_is_recorded_unscored(client):
    m = _metric(client, _thesis(client))
    nowhere = _read(client, m, 127)
    assert nowhere.status_code == 422                      # no forecast and no period named
    d = _read(client, m, 127, period="FQ4 FY26").json()
    assert d["periods"][0]["reading"]["verdict"] == "UNSCORED" and d["opened_question"] is None


# ── A miss is not closed by recording it ─────────────────────────────────────

def test_a_miss_opens_a_question_and_stays_off_until_it_is_explained(client):
    t = _thesis(client)
    m = _metric(client, t)
    _expect(client, m)
    d = _read(client, m, 138, note="finished goods up").json()
    q = d["opened_question"]
    assert q["status"] == "OPEN" and d["state"]["status"] == "OFF" and d["state"]["unexplained"] == 1
    assert d["state"]["last"]["explained"] is False
    assert client.get(f"{T}/counts").json()["off"] == 1

    full = client.get(f"{Q}/{q['id']}").json()
    assert full["question"]["thesis_id"] == t["id"]
    assert "138 days" in full["question"]["title"] and "falls to about 120 days" in full["question"]["title"]
    assert "management guided inventory down" in full["question"]["thought"]
    assert [x["ref"] for x in client.get(f"{Q}/queue").json()["queue"]] == [q["ref"]]

    z = _zettel(client, "MU call: built HBM4 inventory ahead of ramp")
    client.post(f"{Q}/{q['id']}/answers", json={
        "level": "CONFIRMED", "basis": "EVENT", "answer": "Strategic HBM4 build",
        "as_of": TODAY, "evidence": [z["ref"]]})
    s = _state(client, m)
    assert s["status"] == "SETUP" and s["unexplained"] == 0 and s["last"]["explained"] is True
    assert s["last"]["verdict"] == "ABOVE"                 # explained, not erased


def test_a_dropped_why_question_lets_the_miss_go(client):
    m = _metric(client, _thesis(client))
    _expect(client, m)
    q = _read(client, m, 138).json()["opened_question"]
    client.post(f"{Q}/{q['id']}/drop", json={"reason": "one-off, immaterial"})
    assert _state(client, m)["unexplained"] == 0


def test_the_why_question_hangs_under_the_question_the_metric_informs(client):
    t = _thesis(client)
    root = client.post(Q, json={"title": "Hold memory through 2027?", "thesis_id": t["id"],
                                "is_root": True}).json()["question"]
    m = _metric(client, t, question=root["ref"])
    assert client.get(f"{T}/{m['id']}").json()["question"]["ref"] == root["ref"]
    _expect(client, m)
    q = _read(client, m, 138).json()["opened_question"]
    assert [p["ref"] for p in client.get(f"{Q}/{q['id']}").json()["parents"]] == [root["ref"]]


def test_a_corrected_number_stands_and_keeps_the_same_question(client):
    m = _metric(client, _thesis(client))
    _expect(client, m)
    q1 = _read(client, m, 138).json()["opened_question"]
    assert _read(client, m, 136).status_code == 422        # no open forecast: name the period
    d = _read(client, m, 136, note="restated", period="FQ1 FY27").json()
    p = d["periods"][0]
    assert p["reading"]["value"] == 136 and [c["value"] for c in p["corrections"]] == [138]
    assert d["opened_question"]["id"] == q1["id"]
    assert client.get(f"{Q}/counts").json()["pending"] == 1


# ── Kill lines ───────────────────────────────────────────────────────────────

KILL = {"role": "KILLER", "kill_rule": "DIO > 140 days with finished goods rising",
        "kill_op": ">", "kill_value": 140}


def test_crossing_the_kill_line_is_shown_logged_and_leaves_the_thesis_alone(client):
    t = _thesis(client)
    m = _metric(client, t, **KILL)
    _expect(client, m)
    wrong = _read(client, m, 150, kill=False)
    assert wrong.status_code == 422 and any("past it" in x for x in wrong.json()["detail"]["missing"])
    d = _read(client, m, 150).json()
    assert d["periods"][0]["reading"]["kill"] is True and d["state"]["status"] == "KILL"
    assert d["opened_question"] is not None
    assert client.get(f"{T}/counts").json()["kill"] == 1
    got = client.get(f"/api/v2/theses/{t['id']}").json()
    assert "KILLER_HIT" in [e["event_type"] for e in got["events"]]
    assert got["thesis"]["status"] == "draft"              # the user decides, not the tracker


def test_a_number_short_of_the_line_does_not_kill(client):
    m = _metric(client, _thesis(client), **KILL)
    _expect(client, m)
    d = _read(client, m, 139).json()
    assert d["periods"][0]["reading"]["kill"] is False and d["state"]["status"] == "OFF"


def test_a_kill_rule_in_words_only_is_crossed_by_saying_so(client):
    m = _metric(client, _thesis(client), title="CXMT share", role="KILLER",
                kill_rule="CXMT ships to OEMs outside China in volume")
    _expect(client, m, low=None, high=None, expected="none")
    d = client.post(f"{T}/{m['id']}/readings", json={
        "value_text": "Acer and HP both shipping", "as_of": TODAY, "verdict": "OFF", "kill": True,
        **EVIDENCE}).json()
    assert d["state"]["status"] == "KILL"
    plain = _metric(client, _thesis(client, "SNDK"), title="NAND price")
    r = client.post(f"{T}/{plain['id']}/readings", json={
        "value_text": "down", "as_of": TODAY, "period": "Q4", "kill": True, **EVIDENCE})
    assert r.status_code == 422                            # nothing to cross


def test_a_kill_line_does_not_move_quietly(client):
    t = _thesis(client)
    m = _metric(client, t, **KILL)
    agent = client.patch(f"{T}/{m['id']}", headers=AGENT, json={"kill_value": 160, "reason": "x"})
    assert agent.status_code == 403
    silent = client.patch(f"{T}/{m['id']}", json={"kill_value": 160})
    assert silent.status_code == 422 and any("reason" in x for x in silent.json()["detail"]["missing"])
    ok = client.patch(f"{T}/{m['id']}", json={"kill_value": 160, "reason": "HBM needs more WIP"})
    assert ok.status_code == 200 and ok.json()["metric"]["kill_value"] == 160
    events = client.get(f"/api/v2/theses/{t['id']}/events").json()["events"]
    moved = next(e for e in events if e["event_type"] == "METRIC_RULE_CHANGED")
    assert moved["payload"]["changes"]["kill_value"] == {"from": 140.0, "to": 160.0}


def test_filling_in_a_kill_line_that_was_empty_needs_no_reason(client):
    m = _metric(client, _thesis(client), role="KILLER")
    r = client.patch(f"{T}/{m['id']}", headers=AGENT, json={
        "kill_rule": "DIO > 140 days", "kill_op": ">", "kill_value": 140})
    assert r.status_code == 200, r.text
    assert "kill_rule" not in r.json()["state"]["gaps"]
    assert client.patch(f"{T}/{m['id']}", headers=AGENT,
                        json={"source_tool": "MCP get_filings(MU, 10-Q)"}).status_code == 200


# ── The rest ─────────────────────────────────────────────────────────────────

def test_only_the_user_retires_a_metric_and_it_leaves_the_counts(client):
    m = _metric(client, _thesis(client))
    _expect(client, m, due=PAST)
    assert client.post(f"{T}/{m['id']}/retire", headers=AGENT, json={"reason": "x"}).status_code == 403
    assert client.post(f"{T}/{m['id']}/retire", json={}).status_code == 422
    d = client.post(f"{T}/{m['id']}/retire", json={"reason": "sold the position"}).json()
    assert d["state"]["status"] == "RETIRED" and d["state"]["due"] is False
    c = client.get(f"{T}/counts").json()
    assert (c["alert"], c["retired"]) == (0, 1)
    refused = client.post(f"{T}/{m['id']}/expectations", json={
        "period": "FQ2", "expected": "x", "basis": "y", "due_date": SOON})
    assert refused.status_code == 400
    assert client.post(f"{T}/{m['id']}/reopen").json()["state"]["status"] == "DUE"


def test_due_lists_what_to_read_now_and_soon_with_where_to_read_it(client):
    t = _thesis(client)
    now = _metric(client, t, title="DIO")
    _expect(client, now, due=PAST)
    soon = _metric(client, t, title="Gross margin")
    _expect(client, soon, due=(date.today() + timedelta(days=5)).isoformat())
    far = _metric(client, t, title="Capex")
    _expect(client, far, due=(date.today() + timedelta(days=90)).isoformat())
    rows = client.get(f"{T}/due?days=14").json()["metrics"]
    assert [r["title"] for r in rows] == ["DIO", "Gross margin"]
    assert rows[0]["source_url"] == SOURCE["source_url"] and rows[0]["source_locator"]
    assert [r["title"] for r in client.get(T).json()["metrics"]] == ["DIO", "Gross margin", "Capex"]


def test_a_metric_and_its_first_forecast_go_in_together_or_not_at_all(client):
    t = _thesis(client)
    bad = client.post(T, json={"title": "DIO", "thesis_id": t["id"],
                               "expectation": {"period": "FQ1", "expected": "lower"}})
    assert bad.status_code == 422
    assert client.get(T).json()["metrics"] == []
    ok = client.post(T, json={"title": "DIO", "thesis_id": t["id"], **SOURCE, "expectation": {
        "period": "FQ1", "expected": "lower", "basis": "guided", "due_date": SOON}})
    assert ok.status_code == 200 and ok.json()["state"]["status"] == "WAITING"


def test_a_bound_series_shows_its_latest_points_and_an_unknown_one_is_refused(client):
    import db
    t = _thesis(client)
    assert client.post(T, json={"title": "DDR4 contract", "thesis_id": t["id"],
                                "series_id": "dx.nope"}).status_code == 422
    with db.get_db() as conn:
        conn.execute("INSERT INTO series_meta (id, group_key, label, unit, source, source_url) "
                     "VALUES ('dx.c', 'memory', 'DDR4 8Gb', 'USD', 'dramexchange', 'https://dx')")
        conn.execute("INSERT INTO series_points (series_id, date, value) VALUES "
                     "('dx.c', '2026-07-31', 24.0), ('dx.c', '2026-06-30', 21.5)")
    m = _metric(client, t, title="DDR4 contract", series_id="dx.c")
    s = client.get(f"{T}/{m['id']}").json()["series"]
    assert s["label"] == "DDR4 8Gb" and [p["value"] for p in s["points"]] == [24.0, 21.5]


def test_tracking_tables_are_synced():
    from sync.config import TABLE_PK
    from sync.gate import is_synced_write
    for t in ("track_metrics", "track_expectations", "track_readings"):
        assert TABLE_PK[t] == ["id"]
    assert is_synced_write("/api/v2/tracking/x/readings")
