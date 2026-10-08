"""
Anti-thesis (routers/antithesis.py).

What the feature promises, and so what these guard: a belief nobody attacked is
not safe, an objection is cheap to raise and takes evidence to dismiss, a claim
under attack is not reworded in place, an agent's verdict waits for the user,
and nothing here touches the thesis itself.
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
    db.init_questions_schema(); db.init_antithesis_schema()
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
    import routers.antithesis as antithesis
    importlib.reload(antithesis)

    app = FastAPI()
    app.include_router(theses.router)
    app.include_router(zettel.router)
    app.include_router(questions.router)
    app.include_router(antithesis.router)
    return TestClient(app)


A = "/api/v2/antithesis"
AGENT = {"X-Thesis-Actor": "agent:claude"}
SOON = (date.today() + timedelta(days=30)).isoformat()
PAST = (date.today() - timedelta(days=2)).isoformat()
ANGLES = ("FACT", "CAUSE", "LOGIC", "TIME", "PRICE")


def _thesis(client, symbol="MU"):
    return client.post("/api/v2/theses", json={"symbol": symbol, "title": "tight to 2028"}).json()["thesis"]


def _claim(client, thesis, statement="HBM demand outgrows supply through 2027", headers=None, **extra):
    r = client.post(A, headers=headers or {}, json={
        "statement": statement, "thesis_id": thesis["id"],
        "negation": "HBM supply catches up before 2027", **extra})
    assert r.status_code == 200, r.text
    return r.json()["claim"]


def _object(client, c, argument="Samsung passes qualification and floods HBM", angle="FACT",
            headers=None, **extra):
    r = client.post(f"{A}/{c['id']}/objections", headers=headers or {}, json={
        "argument": argument, "angle": angle,
        "would_see": "Samsung HBM revenue named in a customer filing", **extra})
    assert r.status_code == 200, r.text
    return next(o for o in r.json()["claim"]["objections"] if o["id"] == r.json()["objection_id"])


def _zettel(client, title="Samsung failed HBM qualification again", with_source=True):
    body = {"title": title, "kind": "EVIDENCE" if with_source else "CLAIM"}
    if with_source:
        body["sources"] = [{"url": "https://sec.gov/x", "publisher": "SEC",
                            "quote": "has not completed qualification", "reliability": "primary"}]
    r = client.post("/api/v2/zettel", json=body)
    assert r.status_code == 200, r.text
    return r.json()["zettel"]


def _rebut(client, o, z, headers=None):
    return client.post(f"{A}/objections/{o['id']}/verdicts", headers=headers or {}, json={
        "result": "REBUTTED", "reasoning": "the filing says qualification is not done",
        "evidence": [z["ref"]]})


def _get(client, c):
    return client.get(f"{A}/{c['id']}").json()["claim"]


def _board(client, thesis):
    return client.get(A, params={"thesis_id": thesis["id"]}).json()


# ── A belief nobody attacked is not safe ─────────────────────────────────────

def test_a_new_claim_is_untested_and_says_what_is_missing(client):
    t = _thesis(client)
    r = client.post(A, json={"statement": "DRAM pricing holds", "thesis_id": t["id"], "stake": "key"})
    assert r.status_code == 200, r.text
    c = r.json()["claim"]
    assert c["ref"] == "C-0001" and c["symbol"] == "MU" and c["stake"] == "KEY"
    assert c["state"]["status"] == "UNTESTED" and c["state"]["round"] == 1
    assert c["state"]["gaps"] == ["negation", "angles"]
    assert c["state"]["untried"] == list(ANGLES)
    b = _board(client, t)
    assert b["summary"]["verdict"] == "OPEN"
    assert b["counts"]["untested"] == 1 and b["counts"]["key_open"] == 1 and b["counts"]["open"] == 1


def test_a_claim_needs_its_sentence_a_thesis_and_is_not_written_twice(client):
    t = _thesis(client)
    assert client.post(A, json={"statement": "x"}).status_code == 422
    assert client.post(A, json={"thesis_id": t["id"]}).status_code == 422
    assert client.post(A, json={"statement": "x", "thesis_id": t["id"], "stake": "MAYBE"}).status_code == 422
    same = client.post(A, json={"statement": "x", "thesis_id": t["id"], "negation": " X "})
    assert same.status_code == 422                      # the negation is the claim again
    _claim(client, t)
    again = client.post(A, json={"statement": "hbm  demand outgrows supply through 2027",
                                 "thesis_id": t["id"]})
    assert again.status_code == 409 and "C-0001" in again.json()["detail"]


def test_an_objection_takes_only_its_argument_and_contests_the_claim(client):
    t = _thesis(client)
    c = _claim(client, t)
    r = client.post(f"{A}/{c['id']}/objections", json={"argument": "capex is up 40% at all three"})
    assert r.status_code == 200, r.text
    d = r.json()["claim"]
    assert d["state"]["status"] == "CONTESTED"
    assert d["objections"][0]["ref"] == "A-0001" and d["objections"][0]["angle"] == "OTHER"
    assert d["objections"][0]["state"]["status"] == "OPEN"
    assert "would_see" in d["state"]["gaps"]            # not yet something that can be checked
    client.patch(f"{A}/objections/A-0001", json={"would_see": "bit supply growth above 60%",
                                                 "angle": "time"})
    d = _get(client, c)
    assert "would_see" not in d["state"]["gaps"] and d["state"]["angles"]["TIME"] == "open"


def test_an_objection_with_no_argument_a_bad_angle_or_raised_twice_is_refused(client):
    t = _thesis(client)
    c = _claim(client, t)
    assert client.post(f"{A}/{c['id']}/objections", json={"argument": " "}).status_code == 422
    assert client.post(f"{A}/{c['id']}/objections",
                       json={"argument": "x", "angle": "VIBES"}).status_code == 422
    _object(client, c)
    again = client.post(f"{A}/{c['id']}/objections",
                        json={"argument": "samsung passes  qualification and floods HBM"})
    assert again.status_code == 409 and "A-0001" in again.json()["detail"]


# ── Dismissing an objection takes evidence ───────────────────────────────────

def test_a_rebuttal_without_checkable_evidence_is_refused(client):
    t = _thesis(client)
    o = _object(client, _claim(client, t))
    bare = client.post(f"{A}/objections/{o['id']}/verdicts",
                       json={"result": "REBUTTED", "reasoning": "it will not happen"})
    assert bare.status_code == 422
    assert any("evidence" in m for m in bare.json()["detail"]["missing"])
    opinion = _zettel(client, "I doubt Samsung", with_source=False)
    weak = _rebut(client, o, opinion)
    assert weak.status_code == 422 and "url" in weak.json()["detail"]["missing"][0]
    missing = client.post(f"{A}/objections/{o['id']}/verdicts", json={
        "result": "REBUTTED", "reasoning": "x", "evidence": ["Z-9999"]})
    assert missing.status_code == 422


def test_evidence_in_an_open_conflict_cannot_rebut(client):
    t = _thesis(client)
    o = _object(client, _claim(client, t))
    z, other = _zettel(client), _zettel(client, "Samsung passed qualification in Q3")
    link = client.post("/api/v2/zettel/edges", json={
        "src_id": z["id"], "dst_id": other["id"], "rel": "CONTRADICTS", "note": "which is it"})
    assert link.status_code == 200, link.text
    r = _rebut(client, o, z)
    assert r.status_code == 422 and "open conflict" in r.json()["detail"]["missing"][0]


def test_a_claim_stands_once_every_objection_is_rebutted_and_settles_when_every_angle_is_tried(client):
    t = _thesis(client)
    c = _claim(client, t, stake="KEY")
    o = _object(client, c)
    assert _rebut(client, o, _zettel(client)).status_code == 200
    d = _get(client, c)
    assert d["state"]["status"] == "STANDS" and not d["state"]["settled"]
    assert d["state"]["angles"]["FACT"] == "rebutted"
    assert d["objections"][0]["verdict"]["evidence"][0]["ref"] == "Z-0001"
    assert _board(client, t)["summary"]["verdict"] == "STANDING"
    for angle in ANGLES[1:]:
        r = client.post(f"{A}/{c['id']}/sweeps",
                        json={"angle": angle, "searched": "10-K risk factors, last two calls"})
        assert r.status_code == 200, r.text
    d = _get(client, c)
    assert d["state"]["settled"] and d["state"]["gaps"] == [] and len(d["sweeps"]) == 4
    b = _board(client, t)
    assert b["summary"]["verdict"] == "SETTLED" and b["counts"]["settled"] == 1
    # Settled lasts until the next objection.
    _object(client, c, "hyperscaler capex guidance was cut", angle="TIME")
    assert _get(client, c)["state"]["status"] == "CONTESTED"
    assert _board(client, t)["summary"]["verdict"] == "OPEN"


def test_an_angle_is_not_called_clean_without_saying_where_it_was_searched(client):
    t = _thesis(client)
    c = _claim(client, t)
    assert client.post(f"{A}/{c['id']}/sweeps", json={"angle": "LOGIC"}).status_code == 422
    assert client.post(f"{A}/{c['id']}/sweeps",
                       json={"angle": "OTHER", "searched": "everywhere"}).status_code == 422
    _object(client, c, angle="FACT")
    taken = client.post(f"{A}/{c['id']}/sweeps", json={"angle": "FACT", "searched": "filings"})
    assert taken.status_code == 409 and "A-0001" in taken.json()["detail"]


def test_undecided_needs_where_it_was_searched_and_a_day_to_look_again(client):
    t = _thesis(client)
    c = _claim(client, t)
    o = _object(client, c)
    url = f"{A}/objections/{o['id']}/verdicts"
    assert client.post(url, json={"result": "UNDECIDED", "reasoning": "no data yet"}).status_code == 422
    ok = client.post(url, json={"result": "UNDECIDED", "reasoning": "no data yet",
                                "searched": "Samsung Q2 call", "next_check": PAST})
    assert ok.status_code == 200, ok.text
    d = ok.json()["claim"]
    assert d["state"]["status"] == "CONTESTED" and d["objections"][0]["state"]["due"]
    assert client.get(f"{A}/counts").json()["due"] == 1
    # A later verdict replaces the standing one and keeps the old.
    assert _rebut(client, o, _zettel(client)).status_code == 200
    d = _get(client, c)
    assert d["objections"][0]["verdict"]["result"] == "REBUTTED"
    assert [h["result"] for h in d["objections"][0]["history"]] == ["UNDECIDED"]


# ── A conceded objection changes the claim, not the wording in place ─────────

def test_conceding_with_a_revision_writes_a_new_claim_that_starts_untested(client):
    t = _thesis(client)
    c = _claim(client, t, stake="KEY")
    o = _object(client, c)
    url = f"{A}/objections/{o['id']}/verdicts"
    assert client.post(url, json={"result": "CONCEDED", "reasoning": "it did pass"}).status_code == 422
    same = client.post(url, json={"result": "CONCEDED", "reasoning": "it did pass",
                                  "consequence": "REVISE", "revised_statement": c["statement"]})
    assert same.status_code == 422
    r = client.post(url, json={
        "result": "CONCEDED", "reasoning": "Samsung did pass at one customer",
        "consequence": "REVISE", "revised_statement": "HBM stays tight through 2026",
        "revised_negation": "HBM is in surplus during 2026"})
    assert r.status_code == 200, r.text
    new = r.json()["revised_to"]
    assert new["ref"] == "C-0002" and new["stake"] == "KEY" and new["revises"]["ref"] == "C-0001"
    assert new["state"]["status"] == "UNTESTED" and new["state"]["round"] == 2
    assert new["objections"] == []                      # nothing was argued against these words
    old = _get(client, c)
    assert old["state"]["status"] == "REVISED" and old["revised_by"]["ref"] == "C-0002"
    assert client.post(f"{A}/{c['id']}/objections", json={"argument": "more"}).status_code == 409
    b = _board(client, t)
    assert b["counts"]["revised"] == 1 and b["counts"]["untested"] == 1 and b["counts"]["open"] == 1
    assert [x["ref"] for x in client.get(A, params={"thesis_id": t["id"], "include_closed": False})
            .json()["claims"]] == ["C-0002"]


def test_a_key_claim_that_falls_is_flagged_and_the_thesis_is_left_alone(client):
    t = _thesis(client)
    c = _claim(client, t, stake="KEY")
    o = _object(client, c)
    r = client.post(f"{A}/objections/{o['id']}/verdicts", json={
        "result": "CONCEDED", "reasoning": "supply is already ahead", "consequence": "FALLS"})
    assert r.status_code == 200, r.text
    assert r.json()["claim"]["state"]["status"] == "FALLEN"
    b = _board(client, t)
    assert b["summary"]["verdict"] == "KEY_FALLEN" and b["counts"]["key_fallen"] == 1
    assert b["counts"]["alert"] == 1
    after = client.get(f"/api/v2/theses/{t['id']}").json()
    assert after["thesis"]["status"] == t["status"] and after["thesis"]["body"] == t["body"]
    assert "ANTI_FALLEN" in [e["event_type"] for e in after["events"]]
    # Retiring it — the user's answer to a fallen claim — clears the flag.
    assert client.post(f"{A}/{c['id']}/retire", json={"reason": ""}).status_code == 422
    assert client.post(f"{A}/{c['id']}/retire", json={"reason": "thesis rewritten"}).status_code == 200
    assert _board(client, t)["summary"]["verdict"] == "EMPTY"


def test_a_claim_is_reworded_only_while_nothing_was_argued_against_it(client):
    t = _thesis(client)
    c = _claim(client, t)
    assert client.patch(f"{A}/{c['id']}", json={"statement": "HBM demand outgrows supply"}).status_code == 200
    _object(client, c)
    locked = client.patch(f"{A}/{c['id']}", json={"statement": "HBM is fine"})
    assert locked.status_code == 409 and "revise" in locked.json()["detail"].lower()
    assert client.patch(f"{A}/{c['id']}", json={"negation": "supply is ahead by 2026"}).status_code == 200
    assert client.post(f"{A}/{c['id']}/revise", json={"statement": "HBM is fine"}).status_code == 422
    r = client.post(f"{A}/{c['id']}/revise",
                    json={"statement": "HBM is tight in 2026 only", "reason": "horizon was too long"})
    assert r.status_code == 200 and r.json()["claim"]["revises"]["ref"] == "C-0001"
    assert client.post(f"{A}/{c['id']}/revise",
                       json={"statement": "again", "reason": "x"}).status_code == 409


# ── The user closes ──────────────────────────────────────────────────────────

def test_an_agents_verdict_is_a_proposal_until_the_user_accepts_it(client):
    t = _thesis(client)
    c = _claim(client, t)
    o = _object(client, c, headers=AGENT)
    r = _rebut(client, o, _zettel(client), headers=AGENT)
    assert r.status_code == 200 and r.json()["proposal"] is True
    d = r.json()["claim"]
    assert d["state"]["status"] == "CONTESTED"
    assert d["objections"][0]["state"]["status"] == "PENDING"
    assert d["objections"][0]["verdict"] is None and d["objections"][0]["proposal"]["actor"] == "agent:claude"
    assert client.get(f"{A}/counts").json()["pending"] == 1
    vid = r.json()["verdict_id"]
    assert client.post(f"{A}/verdicts/{vid}/review", headers=AGENT,
                       json={"decision": "ACCEPTED"}).status_code == 403
    assert client.post(f"{A}/verdicts/{vid}/review", json={"decision": "REJECTED"}).status_code == 422
    no = client.post(f"{A}/verdicts/{vid}/review",
                     json={"decision": "REJECTED", "note": "that filing is a year old"})
    assert no.status_code == 200
    d = no.json()["claim"]
    assert d["objections"][0]["state"]["status"] == "OPEN"
    assert d["objections"][0]["history"][0]["review"]["result"] == "REJECTED"
    again = _rebut(client, o, _zettel(client, "Samsung Q3 call: still in qualification"), headers=AGENT)
    yes = client.post(f"{A}/verdicts/{again.json()['verdict_id']}/review", json={"decision": "ACCEPTED"})
    assert yes.status_code == 200 and yes.json()["claim"]["state"]["status"] == "STANDS"
    assert client.post(f"{A}/verdicts/{again.json()['verdict_id']}/review",
                       json={"decision": "ACCEPTED"}).status_code == 409


def test_an_agents_concession_rewrites_the_claim_only_once_accepted(client):
    t = _thesis(client)
    c = _claim(client, t)
    o = _object(client, c)
    r = client.post(f"{A}/objections/{o['id']}/verdicts", headers=AGENT, json={
        "result": "CONCEDED", "reasoning": "it passed", "consequence": "REVISE",
        "revised_statement": "HBM stays tight through 2026"})
    assert r.status_code == 200 and "revised_to" not in r.json()
    assert len(_board(client, t)["claims"]) == 1
    yes = client.post(f"{A}/verdicts/{r.json()['verdict_id']}/review", json={"decision": "ACCEPTED"})
    assert yes.status_code == 200 and yes.json()["revised_to"]["ref"] == "C-0002"
    assert yes.json()["claim"]["state"]["status"] == "REVISED"


def test_what_only_the_user_may_do(client):
    t = _thesis(client)
    c = _claim(client, t)
    o = _object(client, c, headers=AGENT)
    for method, url, body in (
        ("post", f"{A}/objections/{o['id']}/withdraw", {"reason": "noise"}),
        ("post", f"{A}/{c['id']}/revise", {"statement": "softer", "reason": "easier"}),
        ("post", f"{A}/{c['id']}/retire", {"reason": "inconvenient"}),
        ("patch", f"{A}/{c['id']}", {"stake": "KEY"}),
        ("delete", f"{A}/{c['id']}", None),
    ):
        r = client.request(method, url, headers=AGENT, json=body)
        assert r.status_code == 403, (url, r.text)
    assert client.post(f"{A}/objections/{o['id']}/withdraw", json={"reason": ""}).status_code == 422
    gone = client.post(f"{A}/objections/{o['id']}/withdraw", json={"reason": "duplicate of A-0003"})
    assert gone.status_code == 200 and gone.json()["claim"]["state"]["status"] == "UNTESTED"
    # An agent rewords what an agent wrote, not what the user wrote.
    assert client.patch(f"{A}/{c['id']}", headers=AGENT, json={"basis": "MU FQ3 call"}).status_code == 200
    mine = _claim(client, t, "DRAM contract prices rise in 2H", headers=AGENT)
    assert client.patch(f"{A}/{mine['id']}", headers=AGENT,
                        json={"statement": "DRAM contract prices rise in 2H26"}).status_code == 200
    other = _claim(client, t, "NAND follows DRAM")
    assert client.patch(f"{A}/{other['id']}", headers=AGENT,
                        json={"statement": "NAND leads"}).status_code == 403


# ── Threads, questions, the queue, the import ────────────────────────────────

def test_a_rebuttal_can_be_challenged_again(client):
    t = _thesis(client)
    c = _claim(client, t)
    o = _object(client, c)
    _rebut(client, o, _zettel(client))
    r = client.post(f"{A}/{c['id']}/objections", json={
        "argument": "the filing predates the August requalification", "angle": "FACT",
        "parent": o["ref"]})
    assert r.status_code == 200, r.text
    d = r.json()["claim"]
    assert d["state"]["status"] == "CONTESTED" and d["objections"][1]["parent_id"] == o["id"]
    other = _claim(client, t, "DRAM pricing holds")
    assert client.post(f"{A}/{other['id']}/objections",
                       json={"argument": "x", "parent": o["ref"]}).status_code == 422


def test_an_objection_goes_to_the_questions_once_and_stays_open_here(client):
    t = _thesis(client)
    c = _claim(client, t)
    o = _object(client, c)
    r = client.post(f"{A}/objections/{o['id']}/question")
    assert r.status_code == 200, r.text
    q = r.json()["claim"]["objections"][0]["question"]
    assert q["ref"] == "Q-0001" and q["status"] == "OPEN" and o["argument"] in q["title"]
    assert r.json()["claim"]["objections"][0]["state"]["status"] == "OPEN"
    again = client.post(f"{A}/objections/{o['id']}/question").json()
    assert again["claim"]["objections"][0]["question"]["id"] == q["id"]
    assert len(client.get("/api/v2/questions", params={"thesis_id": t["id"]}).json()["questions"]) == 1


def test_the_queue_lists_unanswered_objections_then_claims_never_attacked(client):
    t = _thesis(client)
    support = _claim(client, t, "NAND follows DRAM")
    key = _claim(client, t, stake="KEY")
    o = _object(client, key)
    q = client.get(f"{A}/queue", params={"thesis_id": t["id"]}).json()
    assert [x["objection_ref"] for x in q["objections"]] == [o["ref"]]
    assert q["objections"][0]["would_see"] and q["objections"][0]["negation"]
    assert [x["claim_ref"] for x in q["claims"]] == [key["ref"], support["ref"]]   # contested key first
    assert q["claims"][1]["untried"] == list(ANGLES) and "FACT" in q["angles"]


def test_a_whole_step_back_goes_in_together_or_not_at_all(client):
    t = _thesis(client)
    good = {"statement": "HBM demand outgrows supply", "negation": "supply catches up", "stake": "KEY",
            "objections": [{"argument": "Samsung qualifies", "angle": "FACT", "would_see": "a filing"}],
            "none_found": [{"angle": "LOGIC", "searched": "walked the chain demand → price → margin"}]}
    bad = client.post(f"{A}/import", json={"thesis_id": t["id"], "claims": [
        good, {"statement": "DRAM holds", "objections": [{"argument": "x", "angle": "NOPE"}]}]})
    assert bad.status_code == 422 and bad.json()["detail"]["item"] == 2
    assert _board(client, t)["claims"] == []
    ok = client.post(f"{A}/import", headers=AGENT, json={"thesis_id": t["id"], "claims": [good]})
    assert ok.status_code == 200, ok.text
    assert ok.json()["created"] == ["C-0001"] and ok.json()["summary"]["verdict"] == "OPEN"
    c = _board(client, t)["claims"][0]
    assert c["actor"] == "agent:claude" and c["state"]["angles"] == {
        "FACT": "open", "CAUSE": "untried", "LOGIC": "none_found", "TIME": "untried", "PRICE": "untried"}


def test_counts_are_per_thesis_and_a_deleted_claim_leaves_them(client):
    a, b = _thesis(client, "MU"), _thesis(client, "NVDA")
    c = _claim(client, a)
    _claim(client, b, "CUDA lock-in holds")
    n = client.get(f"{A}/counts").json()
    assert n["untested"] == 2 and n["by_thesis"][a["id"]]["verdict"] == "OPEN"
    assert client.delete(f"{A}/{c['id']}").status_code == 200
    n = client.get(f"{A}/counts").json()
    assert n["untested"] == 1 and a["id"] not in n["by_thesis"]
    assert client.get(f"{A}/{c['id']}").status_code == 404


def test_antithesis_tables_are_synced():
    from sync.config import TABLE_PK
    from sync.gate import is_synced_write
    for t in ("anti_claims", "anti_objections", "anti_verdicts"):
        assert TABLE_PK[t] == ["id"]
    assert is_synced_write("/api/v2/antithesis/x/objections")
