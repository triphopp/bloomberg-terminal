"""
Thesis questions (routers/questions.py).

What the feature promises, and so what these guard: a question that moves
nothing is refused, an answer without checkable evidence is refused, an agent
cannot close a question, and the badge number only goes down for the reasons
the user was told it would.
"""
import importlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "q.db"))
    monkeypatch.setenv("SYNC_DEVICE_ID", "PC")
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema(); db.init_zettel_schema()
    db.init_questions_schema()
    db.init_alerts_schema(); db.init_sync_layer(); db.init_audit_layer()
    # With the capture triggers on: a second write to a row still pending flush
    # is where an UPSERT 500s (gotchas.md), so every test runs under them.
    db.init_oplog_layer()
    import routers.theses as theses
    importlib.reload(theses)
    import routers.zettel as zettel
    importlib.reload(zettel)
    import routers.questions as questions
    importlib.reload(questions)

    app = FastAPI()
    app.include_router(theses.router)
    app.include_router(zettel.router)
    app.include_router(questions.router)
    return TestClient(app)


Q = "/api/v2/questions"
AGENT = {"X-Thesis-Actor": "agent:claude"}


def _thesis(client, symbol="INTC"):
    return client.post("/api/v2/theses", json={"symbol": symbol, "title": "1:1"}).json()["thesis"]


def _evidence(client, title, reliability="primary", quote="Server volume increased 9%"):
    r = client.post("/api/v2/zettel", json={
        "title": title, "kind": "EVIDENCE",
        "sources": [{"url": f"https://sec.gov/{abs(hash(title))}", "publisher": "SEC",
                     "quote": quote, "reliability": reliability}],
    })
    assert r.status_code == 200, r.text
    return r.json()["zettel"]


def _root(client, thesis):
    r = client.post(Q, json={"title": "Does Intel gain more than AMD from 1:1?",
                             "thought": "Vendors say CPU:GPU heads to 1:1",
                             "thesis_id": thesis["id"], "is_root": True})
    assert r.status_code == 200, r.text
    return r.json()["question"]


def _child(client, parent, title="Is the CPU shortage demand or supply?", headers=None):
    r = client.post(Q, headers=headers or {}, json={
        "title": title, "thought": "Every server already has a CPU",
        "parents": [{"parent": parent["ref"], "if_a": "shortage is not evidence of 1:1",
                     "if_b": "shortage supports 1:1"}],
    })
    assert r.status_code == 200, r.text
    return r.json()["question"]


ASSUMPTION = {"statement": "ASP falls once volume rises", "metric": "server ASP and volume YoY",
              "source_hint": "Intel 10-Q Q3/26", "check_by": "2026-10-22",
              "falsifier": "volume up and ASP still up"}


def _inferred(client, q, z, headers=AGENT):
    return client.post(f"{Q}/{q['id']}/answers", headers=headers, json={
        "level": "INFERRED", "answer": "Mostly supply", "evidence": [z["ref"]],
        "assumptions": [ASSUMPTION],
    })


def _status(client, q):
    return client.get(f"{Q}/{q['id']}").json()["state"]


# ── A question has to earn its place ─────────────────────────────────────────

def test_a_question_is_captured_with_only_its_text_and_reports_what_is_missing(client):
    t = _thesis(client)
    r = client.post(Q, json={"title": "What is 18A yield?", "thesis_id": t["id"]})
    assert r.status_code == 200, r.text
    q = r.json()["question"]
    assert q["gaps"] == ["parent", "thought"]
    assert r.json()["state"]["status"] == "OPEN"
    assert client.get(f"{Q}/counts").json()["pending"] == 1     # it is on the badge at once
    assert [x["ref"] for x in client.get(f"{Q}/queue").json()["queue"]] == [q["ref"]]


def test_a_captured_question_is_placed_later(client):
    t = _thesis(client)
    root = _root(client, t)
    q = client.post(Q, json={"title": "What is 18A yield?", "thesis_id": t["id"]}).json()["question"]
    placed = client.post(f"{Q}/{q['id']}/parents", json={"parent": root["ref"]}).json()
    assert placed["question"]["gaps"] == ["effect", "thought"]
    edge = placed["parents"][0]["edge_id"]
    same = client.patch(f"{Q}/edges/{edge}", json={"if_a": "no change", "if_b": "No  Change"})
    assert same.status_code == 422
    done = client.patch(f"{Q}/edges/{edge}", json={"if_a": "supply grows", "if_b": "stays tight"})
    client.patch(f"{Q}/{q['id']}", json={"thought": "Company only says ahead of target"})
    assert done.status_code == 200
    assert client.get(f"{Q}/{q['id']}").json()["question"]["gaps"] == []


def test_a_question_belonging_nowhere_is_refused(client):
    r = client.post(Q, json={"title": "What is 18A yield?"})
    assert r.status_code == 422 and "belongs" in r.json()["detail"]


def test_a_question_whose_answer_moves_nothing_is_refused(client):
    root = _root(client, _thesis(client))
    r = client.post(Q, json={"title": "What is 18A yield?", "thought": "Not disclosed",
                             "parents": [{"parent": root["ref"], "if_a": "no change",
                                          "if_b": "No  Change"}]})
    assert r.status_code == 422
    assert "reduces no uncertainty" in r.json()["detail"]


def test_one_root_per_thesis_and_children_inherit_it(client):
    t = _thesis(client)
    root = _root(client, t)
    again = client.post(Q, json={"title": "Another root?", "thought": "x",
                                 "thesis_id": t["id"], "is_root": True})
    assert again.status_code == 409 and root["ref"] in again.json()["detail"]
    child = _child(client, root)
    assert child["thesis_id"] == t["id"] and child["symbol"] == "INTC"
    assert child["ref"] == "Q-0002"


def test_asking_the_same_question_twice_points_at_the_first(client):
    root = _root(client, _thesis(client))
    c = _child(client, root)
    r = client.post(Q, json={"title": "is the CPU shortage  demand or supply?", "thought": "x",
                             "parents": [{"parent": root["id"], "if_a": "a", "if_b": "b"}]})
    assert r.status_code == 409 and c["ref"] in r.json()["detail"]


def test_two_branches_meet_at_one_question_and_loops_are_refused(client):
    root = _root(client, _thesis(client))
    q1 = _child(client, root, "Will 1:1 happen?")
    q2 = _child(client, root, "Can Intel ship?")
    q12 = _child(client, q1, "Demand or supply?")
    r = client.post(f"{Q}/{q12['id']}/parents", json={
        "parent": q2["ref"], "if_a": "question becomes price", "if_b": "question stays volume"})
    assert r.status_code == 200
    assert {p["ref"] for p in r.json()["parents"]} == {q1["ref"], q2["ref"]}
    loop = client.post(f"{Q}/{q1['id']}/parents", json={
        "parent": q12["ref"], "if_a": "a", "if_b": "b"})
    assert loop.status_code == 400 and "loop" in loop.json()["detail"]
    # The convergence point is waited on by more questions above it → sorts first.
    rows = {r["ref"]: r for r in client.get(Q).json()["questions"]}
    assert rows[q12["ref"]]["blocks"] == 3 and rows[q1["ref"]]["blocks"] == 1


# ── No answer without evidence ───────────────────────────────────────────────

def test_a_refused_answer_lists_everything_missing(client):
    root = _root(client, _thesis(client))
    r = client.post(f"{Q}/{root['id']}/answers", headers=AGENT, json={"level": "INFERRED"})
    assert r.status_code == 422
    d = r.json()["detail"]
    assert d["code"] == "ANSWER_REFUSED"
    joined = " ".join(d["missing"])
    assert "answer:" in joined and "evidence:" in joined and "assumptions:" in joined


def test_an_inference_needs_a_testable_assumption(client):
    root = _root(client, _thesis(client))
    z = _evidence(client, "Intel server volume +9% while ASP +48%")
    r = client.post(f"{Q}/{root['id']}/answers", headers=AGENT, json={
        "level": "INFERRED", "answer": "Mostly supply", "evidence": [z["ref"]],
        "assumptions": [{"statement": "ASP falls once volume rises"}],
    })
    assert r.status_code == 422
    missing = " ".join(r.json()["detail"]["missing"])
    for field in ("metric", "source_hint", "falsifier", "check_by"):
        assert field in missing
    assert _inferred(client, root, z).status_code == 200


def test_evidence_must_carry_a_url_and_the_quoted_sentence(client):
    root = _root(client, _thesis(client))
    weak = _evidence(client, "Someone said CPUs are short", quote="")
    r = _inferred(client, root, weak)
    assert r.status_code == 422
    assert "quoted sentence" in " ".join(r.json()["detail"]["missing"])


def test_a_number_is_only_confirmed_by_a_primary_source(client):
    root = _root(client, _thesis(client))
    news = _evidence(client, "Mercury: AMD 34.5% unit share", reliability="secondary")
    body = {"level": "CONFIRMED", "basis": "NUMBER", "answer": "34.5%", "value": "34.5",
            "unit": "%", "as_of": "2026-06-27", "evidence": [news["ref"]]}
    r = client.post(f"{Q}/{root['id']}/answers", headers=AGENT, json=body)
    assert r.status_code == 422 and "PRIMARY" in " ".join(r.json()["detail"]["missing"])
    filing = _evidence(client, "Intel 10-Q: server volume +9%")
    ok = client.post(f"{Q}/{root['id']}/answers", headers=AGENT,
                     json={**body, "evidence": [filing["ref"]]})
    assert ok.status_code == 200


def _signal(z, origin, diagnostic=True, result="FOUND"):
    return {"expectation": "CPU units grow faster than GPU units", "result": result,
            "finding": "seen", "supports": "1:1", "diagnostic": diagnostic, "origin": origin,
            "zettel": z["ref"]}


def test_circumstantial_confirmation_needs_independent_diagnostic_signals(client):
    root = _root(client, _thesis(client))
    a = _evidence(client, "AMD says ratio heads to 1:1", reliability="secondary")
    b = _evidence(client, "Arm says 120M cores per GW", reliability="secondary")
    c = _evidence(client, "ODM rack spec lists 2 CPUs per GPU tray", reliability="secondary")
    base = {"level": "CONFIRMED", "basis": "CIRCUMSTANTIAL", "answer": "Ratio is rising",
            "alternatives": ["ratio is rising", "CPUs are simply short"]}

    # Two vendors are one origin; a signal both explanations predict is not diagnostic.
    same_origin = client.post(f"{Q}/{root['id']}/answers", headers=AGENT, json={
        **base, "signals": [_signal(a, "CPU vendors"), _signal(b, "cpu  vendors")]})
    assert same_origin.status_code == 422
    not_diag = client.post(f"{Q}/{root['id']}/answers", headers=AGENT, json={
        **base, "signals": [_signal(a, "CPU vendors"), _signal(c, "ODM", diagnostic=False)]})
    assert not_diag.status_code == 422
    one_story = client.post(f"{Q}/{root['id']}/answers", headers=AGENT, json={
        **base, "alternatives": ["ratio is rising"],
        "signals": [_signal(a, "CPU vendors"), _signal(c, "ODM")]})
    assert "competing explanations" in " ".join(one_story.json()["detail"]["missing"])
    contrary = client.post(f"{Q}/{root['id']}/answers", headers=AGENT, json={
        **base, "signals": [_signal(a, "CPU vendors"), _signal(c, "ODM"),
                            _signal(b, "Arm", result="CONTRARY")]})
    assert "CONTRARY" in " ".join(contrary.json()["detail"]["missing"])

    ok = client.post(f"{Q}/{root['id']}/answers", headers=AGENT, json={
        **base, "signals": [_signal(a, "CPU vendors"), _signal(c, "ODM")]})
    assert ok.status_code == 200, ok.text


def test_evidence_in_an_open_conflict_cannot_confirm(client):
    root = _root(client, _thesis(client))
    a = _evidence(client, "Rack spec A shows 1:1", reliability="secondary")
    b = _evidence(client, "Rack spec B shows 1:1", reliability="secondary")
    c = _evidence(client, "Rack spec A actually shows 1:4", reliability="secondary")
    client.post("/api/v2/zettel/edges", json={"src_id": c["id"], "dst_id": a["id"],
                                              "rel": "CONTRADICTS"})
    r = client.post(f"{Q}/{root['id']}/answers", headers=AGENT, json={
        "level": "CONFIRMED", "basis": "CIRCUMSTANTIAL", "answer": "1:1",
        "alternatives": ["1:1", "1:4"],
        "signals": [_signal(a, "ODM A"), _signal(b, "ODM B")]})
    assert r.status_code == 422 and "open conflict" in " ".join(r.json()["detail"]["missing"])


def test_not_found_only_counts_if_someone_looked(client):
    root = _root(client, _thesis(client))
    z = _evidence(client, "Intel 10-Q: demand exceeded supply")
    sig = {"expectation": "A hyperscaler publishes its CPU:GPU ratio", "result": "NOT_FOUND"}
    body = {"level": "INFERRED", "answer": "No direct figure", "evidence": [z["ref"]],
            "assumptions": [ASSUMPTION]}
    r = client.post(f"{Q}/{root['id']}/answers", headers=AGENT, json={**body, "signals": [sig]})
    assert r.status_code == 422 and "searched_where" in " ".join(r.json()["detail"]["missing"])
    ok = client.post(f"{Q}/{root['id']}/answers", headers=AGENT, json={
        **body, "signals": [{**sig, "searched_where": "MSFT/GOOG/AMZN/META 10-Q + calls Q2/26"}]})
    assert ok.status_code == 200
    kept = ok.json()["answers"][0]["signals"][0]
    assert kept["result"] == "NOT_FOUND" and kept["searched_where"]


def test_unclear_needs_where_it_looked_and_when_to_look_again(client):
    root = _root(client, _thesis(client))
    r = client.post(f"{Q}/{root['id']}/answers", headers=AGENT,
                    json={"level": "UNANSWERABLE", "answer": "Not disclosed"})
    assert r.status_code == 422
    ok = client.post(f"{Q}/{root['id']}/answers", headers=AGENT, json={
        "level": "UNANSWERABLE", "answer": "Not disclosed",
        "searched": "Intel 10-Q, release, prepared remarks Q2/26", "next_check": "2026-10-22"})
    assert ok.status_code == 200


# ── The user closes questions; the badge follows ─────────────────────────────

def test_an_agent_answer_stays_pending_until_the_user_accepts_it(client):
    root = _root(client, _thesis(client))
    z = _evidence(client, "Intel server volume +9% while ASP +48%")
    assert _status(client, root)["status"] == "OPEN"
    a = _inferred(client, root, z).json()
    assert a["state"]["status"] == "OPEN" and a["state"]["reason"] == "awaiting_review"
    aid = a["state"]["proposed_answer_id"]

    denied = client.post(f"{Q}/answers/{aid}/review", headers=AGENT, json={"decision": "ACCEPTED"})
    assert denied.status_code == 403
    assert client.get(f"{Q}/counts").json()["pending"] == 1

    ok = client.post(f"{Q}/answers/{aid}/review", json={"decision": "ACCEPTED"})
    s = ok.json()["state"]
    assert s["status"] == "WATCH" and s["reason"] == "assumptions_untested"
    c = client.get(f"{Q}/counts").json()
    assert (c["pending"], c["watch"]) == (0, 1)


def test_rejecting_needs_a_reason_and_reopens_the_question(client):
    root = _root(client, _thesis(client))
    z = _evidence(client, "Intel server volume +9% while ASP +48%")
    aid = _inferred(client, root, z).json()["state"]["proposed_answer_id"]
    assert client.post(f"{Q}/answers/{aid}/review", json={"decision": "REJECTED"}).status_code == 422
    r = client.post(f"{Q}/answers/{aid}/review",
                    json={"decision": "REJECTED", "note": "ASP is mix, not pricing"})
    assert r.json()["state"]["reason"] == "unanswered"


def test_the_users_own_answer_needs_no_second_signature(client):
    root = _root(client, _thesis(client))
    z = _evidence(client, "Intel server volume +9% while ASP +48%")
    r = _inferred(client, root, z, headers={})
    assert r.json()["state"]["status"] == "WATCH"


def test_a_broken_assumption_reopens_and_a_held_one_clears(client):
    t = _thesis(client)
    root = _root(client, t)
    z = _evidence(client, "Intel server volume +9% while ASP +48%")
    full = _inferred(client, root, z, headers={}).json()
    sid = full["answers"][0]["assumptions"][0]["id"]

    no_source = client.post(f"{Q}/assumptions/{sid}/check", json={"result": "HELD", "note": "ok"})
    assert no_source.status_code == 422

    q3 = _evidence(client, "Intel Q3/26 10-Q: server volume +25%, ASP +30%")
    broken = client.post(f"{Q}/assumptions/{sid}/check", headers=AGENT, json={
        "result": "BROKEN", "note": "volume +25% and ASP still +30%", "zettel": q3["ref"]})
    assert broken.json()["state"] == {**broken.json()["state"], "status": "OPEN",
                                      "reason": "assumption_broken"}
    # A later reading supersedes the earlier one for the same assumption.
    held = client.post(f"{Q}/assumptions/{sid}/check", json={
        "result": "HELD", "note": "restated: ASP -5%", "zettel": q3["ref"]})
    assert held.json()["state"]["status"] == "CLEAR"
    assert client.get(f"{Q}/counts").json()["pending"] == 0
    kinds = [e["event_type"] for e in
             client.get(f"/api/v2/theses/{t['id']}").json()["events"]]
    assert {"QUESTION_ADDED", "QUESTION_ANSWERED", "ASSUMPTION_CHECKED"} <= set(kinds)


def test_a_new_agent_proposal_on_a_closed_question_asks_for_the_user_again(client):
    root = _root(client, _thesis(client))
    filing = _evidence(client, "Intel 10-Q: server volume +9%")
    body = {"level": "CONFIRMED", "basis": "EVENT", "answer": "Announced", "as_of": "2026-07-23",
            "evidence": [filing["ref"]]}
    assert client.post(f"{Q}/{root['id']}/answers", json=body).json()["state"]["status"] == "CLEAR"
    again = client.post(f"{Q}/{root['id']}/answers", headers=AGENT, json=body).json()["state"]
    assert again["status"] == "OPEN" and again["reason"] == "awaiting_review"


def test_only_the_user_drops_and_dropped_leaves_the_counts(client):
    root = _root(client, _thesis(client))
    c = _child(client, root)
    assert client.post(f"{Q}/{c['id']}/drop", headers=AGENT, json={"reason": "x"}).status_code == 403
    assert client.post(f"{Q}/{c['id']}/drop", json={"reason": ""}).status_code == 422
    assert client.post(f"{Q}/{c['id']}/drop", json={"reason": "no longer matters"}).status_code == 200
    counts = client.get(f"{Q}/counts").json()
    assert counts["pending"] == 1 and counts["dropped"] == 1
    assert client.post(f"{Q}/{c['id']}/reopen").json()["state"]["status"] == "OPEN"


# ── Queue, claim, tree ───────────────────────────────────────────────────────

def test_queue_hides_what_waits_on_the_user_and_what_another_agent_took(client):
    root = _root(client, _thesis(client))
    c1 = _child(client, root, "Will 1:1 happen?")
    c2 = _child(client, root, "Can Intel ship?")
    z = _evidence(client, "Intel server volume +9% while ASP +48%")
    _inferred(client, c1, z)                                   # now waits on the user
    other = {"X-Thesis-Actor": "agent:codex"}
    assert client.post(f"{Q}/{c2['id']}/claim", headers=other).status_code == 200
    assert client.post(f"{Q}/{c2['id']}/claim", headers=AGENT).status_code == 409

    mine = [r["ref"] for r in client.get(f"{Q}/queue", headers=AGENT).json()["queue"]]
    assert mine == [root["ref"]]
    theirs = [r["ref"] for r in client.get(f"{Q}/queue", headers=other).json()["queue"]]
    assert theirs == [c2["ref"], root["ref"]]      # deeper question blocks more above it
    item = client.get(f"{Q}/queue", headers=other).json()["queue"][0]
    assert item["parents"][0]["if_a"]              # the agent is told why it matters

    # Submitting an answer releases the claim.
    _inferred(client, c2, z, headers=other)
    assert client.get(f"{Q}/{c2['id']}").json()["question"]["claimed_by"] is None


def test_a_watched_question_comes_due_on_its_check_date(client):
    root = _root(client, _thesis(client))
    z = _evidence(client, "Intel server volume +9% while ASP +48%")
    r = client.post(f"{Q}/{root['id']}/answers", json={
        "level": "INFERRED", "answer": "Mostly supply", "evidence": [z["ref"]],
        "assumptions": [{**ASSUMPTION, "check_by": "2020-01-01"}]})
    assert r.json()["state"]["status"] == "WATCH" and r.json()["state"]["due"] is True
    assert [q["ref"] for q in client.get(f"{Q}/queue").json()["queue"]] == [root["ref"]]


def test_tree_rolls_up_clear_leaves(client):
    t = _thesis(client)
    root = _root(client, t)
    c1 = _child(client, root, "Will 1:1 happen?")
    _child(client, root, "Can Intel ship?")
    filing = _evidence(client, "Intel 10-Q: server volume +9%")
    client.post(f"{Q}/{c1['id']}/answers", json={
        "level": "CONFIRMED", "basis": "EVENT", "answer": "Announced", "as_of": "2026-07-23",
        "evidence": [filing["ref"]]})
    tree = client.get(f"{Q}/tree", params={"thesis_id": t["id"]}).json()
    assert tree["leaves"] == {"total": 2, "clear": 1}
    assert len(tree["nodes"]) == 3 and len(tree["edges"]) == 2
    assert tree["counts"]["pending"] == 2


def test_editing_twice_before_a_sync_flush_does_not_500(client):
    root = _root(client, _thesis(client))
    for n in (2, 3):
        r = client.patch(f"{Q}/{root['id']}", json={"priority": n})
        assert r.status_code == 200 and r.json()["question"]["priority"] == n


def test_question_tables_are_synced():
    from sync.config import TABLE_PK
    for t in ("questions", "question_edges", "question_answers", "question_signals",
              "question_assumptions", "question_checks"):
        assert TABLE_PK[t] == ["id"]


# ── Importing a whole tree ───────────────────────────────────────────────────

def _tree(z):
    return [
        {"key": "root", "title": "Does Intel gain more than AMD?", "thought": "1:1 talk",
         "is_root": True},
        {"key": "q1", "title": "Will 1:1 happen?", "thought": "vendors say so",
         "parents": [{"parent": "root", "if_a": "root falls", "if_b": "root stands"}]},
        {"key": "q12", "title": "Demand or supply?", "thought": "why only now",
         "parents": [{"parent": "q1", "if_a": "not evidence", "if_b": "evidence"},
                     {"parent": "root", "if_a": "price fades", "if_b": "price holds"}],
         "answer": {"level": "INFERRED", "answer": "Mostly supply", "evidence": [z["ref"]],
                    "assumptions": [ASSUMPTION]}},
    ]


def test_a_tree_is_imported_in_one_go_with_keys_as_parents(client):
    t = _thesis(client)
    z = _evidence(client, "Intel server volume +9% while ASP +48%")
    r = client.post(f"{Q}/import", headers=AGENT, json={"thesis_id": t["id"], "questions": _tree(z)})
    assert r.status_code == 200, r.text
    made = {c["key"]: c for c in r.json()["created"]}
    assert [made[k]["ref"] for k in ("root", "q1", "q12")] == ["Q-0001", "Q-0002", "Q-0003"]
    q12 = client.get(f"{Q}/{made['q12']['id']}").json()
    assert {p["ref"] for p in q12["parents"]} == {"Q-0001", "Q-0002"}
    assert q12["state"]["reason"] == "awaiting_review"      # an agent's answer is still a proposal
    # A later import can hang new questions under ones that already exist.
    more = client.post(f"{Q}/import", json={"questions": [
        {"title": "Can Intel ship?", "thought": "10-Q says constrained",
         "parents": [{"parent": "Q-0001", "if_a": "benefit leaks", "if_b": "benefit kept"}]}]})
    assert more.status_code == 200 and more.json()["created"][0]["ref"] == "Q-0004"


def test_one_bad_item_refuses_the_whole_import(client):
    t = _thesis(client)
    z = _evidence(client, "Intel server volume +9% while ASP +48%")
    tree = _tree(z)
    tree[2]["answer"]["assumptions"] = []                     # an inference with nothing to test
    r = client.post(f"{Q}/import", headers=AGENT, json={"thesis_id": t["id"], "questions": tree})
    assert r.status_code == 422
    d = r.json()["detail"]
    assert d["code"] == "IMPORT_REFUSED" and d["key"] == "q12" and d["written"] == 0
    assert "assumptions" in " ".join(d["reason"]["missing"])
    assert client.get(Q).json()["questions"] == []            # nothing half-written
    kinds = [e["event_type"] for e in client.get(f"/api/v2/theses/{t['id']}").json()["events"]]
    assert "QUESTION_ADDED" not in kinds


# ── Calendar: a date is a claim too ──────────────────────────────────────────

CAL = f"{Q}/calendar"


def test_a_date_says_where_it_came_from_and_confirmed_needs_the_announcement(client):
    r = client.post(CAL, json={"title": "Intel Q3/26 earnings", "date": "2026-10-22"})
    assert r.status_code == 422 and "source:" in " ".join(r.json()["detail"]["missing"])
    r = client.post(CAL, json={"title": "Intel Q3/26 earnings", "date": "2026-10-22",
                               "status": "CONFIRMED", "source": "Intel IR"})
    assert "source_url" in " ".join(r.json()["detail"]["missing"])
    ok = client.post(CAL, json={"title": "Intel Q3/26 earnings", "date": "2026-10-22",
                                "source": "Yahoo calendar; Intel has not announced",
                                "kind": "EARNINGS", "symbol": "intc"})
    assert ok.status_code == 200, ok.text
    d = ok.json()["date"]
    assert (d["ref"], d["status"], d["symbol"]) == ("D-0001", "ESTIMATED", "INTC")
    again = client.post(CAL, json={"title": "intel q3/26  earnings", "date": "2026-10-23",
                                   "source": "x"})
    assert again.status_code == 409 and "D-0001" in again.json()["detail"]


def test_one_date_serves_several_questions_and_makes_them_due_when_it_arrives(client):
    root = _root(client, _thesis(client))
    c1 = _child(client, root, "Demand or supply?")
    c2 = _child(client, root, "When does supply arrive?")
    made = client.post(CAL, json={
        "title": "Intel Q3/26 10-Q", "date": "2099-10-23", "kind": "FILING",
        "source": "estimated: Q2 release 23 Jul, 10-Q filed 24 Jul",
        "questions": [{"question": c1["ref"], "reads": "server volume + ASP"},
                      {"question": c2["ref"], "reads": "server volume YoY"}]})
    assert made.status_code == 200, made.text
    d = made.json()["date"]
    assert [q["ref"] for q in d["questions"]] == [c1["ref"], c2["ref"]] and d["due"] is False
    assert client.get(f"{Q}/{c1['id']}").json()["dates"][0]["reads"] == "server volume + ASP"
    assert _status(client, c1)["due"] is False

    # The date arrives (moved into the past): a move needs a reason and is kept.
    no_reason = client.patch(f"{CAL}/{d['ref']}", json={"date": "2020-01-01"})
    assert no_reason.status_code == 422
    moved = client.patch(f"{CAL}/{d['ref']}", json={"date": "2020-01-01",
                                                    "reason": "test: pretend it was filed"})
    m = moved.json()["date"]
    assert m["due"] is True and m["changes"][0]["old_date"] == "2099-10-23"
    assert _status(client, c1)["due"] is True and _status(client, c2)["due"] is True
    cal = client.get(CAL).json()
    assert cal["due"] == 1 and cal["estimated"] == 1

    # Someone looked after the date: that question stops being due, the other does not.
    z = _evidence(client, "Intel 10-Q Q3/26: server volume +25%")
    client.post(f"{Q}/{c1['id']}/answers", json={
        "level": "CONFIRMED", "basis": "EVENT", "answer": "Filed", "as_of": "2026-10-23",
        "evidence": [z["ref"]]})
    assert _status(client, c1)["due"] is False and _status(client, c2)["due"] is True


def test_confirming_a_date_needs_the_link_and_a_reason(client):
    d = client.post(CAL, json={"title": "AMD Q3/26 earnings", "date": "2026-11-03",
                               "source": "MarketBeat"}).json()["date"]
    r = client.patch(f"{CAL}/{d['id']}", json={"status": "CONFIRMED", "reason": "AMD announced"})
    assert r.status_code == 422
    ok = client.patch(f"{CAL}/{d['id']}", json={
        "status": "CONFIRMED", "source_url": "https://ir.amd.com/x", "reason": "AMD announced"})
    assert ok.status_code == 200 and ok.json()["date"]["status"] == "CONFIRMED"
    assert ok.json()["date"]["changes"][0]["new_status"] == "CONFIRMED"


def test_calendar_tables_are_synced():
    from sync.config import TABLE_PK
    for t in ("question_dates", "question_date_links", "question_date_changes"):
        assert TABLE_PK[t] == ["id"]


# ── The cached book must never serve a stale badge ───────────────────────────

def test_the_book_is_loaded_once_while_nothing_changes_and_again_after_any_write(client, monkeypatch):
    import routers.questions as questions
    loads = []
    real = questions._load
    monkeypatch.setattr(questions, "_load", lambda *a, **k: (loads.append(a[1:]), real(*a, **k))[1])
    root = _root(client, _thesis(client))

    for _ in range(3):
        assert client.get(f"{Q}/counts").json()["pending"] == 1
        client.get(f"{Q}/queue")
        client.get(f"{Q}/calendar")
    assert len(loads) == 1                       # nine reads, one load

    _child(client, root)                          # a write through the API
    assert client.get(f"{Q}/counts").json()["pending"] == 2
    assert len(loads) == 2


def test_a_change_that_arrives_with_an_older_timestamp_is_still_seen(client):
    """A sync pull applies a peer's row with the PEER's updated_at, which can be
    older than the newest local one — MAX(updated_at) alone would miss it."""
    import db
    root = _root(client, _thesis(client))
    _child(client, root)
    assert client.get(f"{Q}/counts").json()["pending"] == 2
    with db.get_db() as conn:
        conn.execute("UPDATE _sync_guard SET active = 1")        # as the op-log apply does
        conn.execute("UPDATE questions SET dropped_at = '2020-01-01', drop_reason = 'peer', "
                     "updated_at = '2020-01-01 00:00:00.000' WHERE id = ?", (root["id"],))
        conn.execute("UPDATE _sync_guard SET active = 0")
    c = client.get(f"{Q}/counts").json()
    assert (c["pending"], c["dropped"]) == (1, 1)


def test_claim_and_release_inside_one_second_are_both_seen(client):
    root = _root(client, _thesis(client))
    other = {"X-Thesis-Actor": "agent:codex"}
    assert [q["ref"] for q in client.get(f"{Q}/queue", headers=AGENT).json()["queue"]] == [root["ref"]]
    client.post(f"{Q}/{root['id']}/claim", headers=other)
    assert client.get(f"{Q}/queue", headers=AGENT).json()["queue"] == []
    client.post(f"{Q}/{root['id']}/release", headers=other)
    assert [q["ref"] for q in client.get(f"{Q}/queue", headers=AGENT).json()["queue"]] == [root["ref"]]
