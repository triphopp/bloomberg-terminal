"""
Read marks: unread is derived from "when was it seen" against "when did it last
change", only the user marks, and what the user writes is already read.
"""
import importlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "r.db"))
    monkeypatch.setenv("SYNC_DEVICE_ID", "PC")
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema(); db.init_zettel_schema()
    db.init_questions_schema()
    db.init_alerts_schema(); db.init_sync_layer(); db.init_audit_layer()
    db.init_oplog_layer()
    import routers.reads as reads
    importlib.reload(reads)
    import routers.theses as theses
    importlib.reload(theses)
    import routers.zettel as zettel
    importlib.reload(zettel)

    app = FastAPI()
    app.include_router(theses.router)
    app.include_router(zettel.router)
    app.include_router(reads.router)
    return TestClient(app)


R = "/api/v2/reads"
T = "/api/v2/theses"
AGENT = {"X-Thesis-Actor": "agent:claude"}


def _unread(client, **params):
    return client.get(f"{R}/unread", params=params).json()


def _keys(payload):
    return {(i["type"], i["id"]) for i in payload["items"]}


def test_what_the_user_writes_is_read_and_what_an_agent_writes_is_not(client):
    mine = client.post(T, json={"symbol": "V"}).json()["thesis"]
    theirs = client.post(T, json={"symbol": "MU"}, headers=AGENT).json()["thesis"]
    assert _keys(_unread(client)) == {("thesis", theirs["id"])}
    assert mine["id"] not in _unread(client)["by_thesis"]


def test_an_edit_after_reading_brings_it_back(client):
    t = client.post(T, json={"symbol": "MU"}, headers=AGENT).json()["thesis"]
    assert client.post(R, json={"items": [{"type": "thesis", "id": t["id"]}]}).status_code == 200
    assert _unread(client)["items"] == []
    client.patch(f"{T}/{t['id']}", json={"title": "shortage to 2028", "note": "x"}, headers=AGENT)
    assert _keys(_unread(client)) == {("thesis", t["id"])}
    # the user's own edit reads it again
    client.patch(f"{T}/{t['id']}", json={"title": "shortage", "note": "y"})
    assert _unread(client)["items"] == []


def test_an_agent_cannot_mark(client):
    t = client.post(T, json={"symbol": "MU"}, headers=AGENT).json()["thesis"]
    r = client.post(R, json={"items": [{"type": "thesis", "id": t["id"]}]}, headers=AGENT)
    assert r.status_code == 403
    assert client.post(f"{R}/unmark", json={"items": []}, headers=AGENT).status_code == 403


def test_mark_everything_under_one_thesis_and_take_one_back(client):
    t = client.post(T, json={"symbol": "MU"}, headers=AGENT).json()["thesis"]
    other = client.post(T, json={"symbol": "V"}, headers=AGENT).json()["thesis"]
    n = client.post(f"{T}/{t['id']}/notes", json={"kind": "RISK", "title": "capex"},
                    headers=AGENT).json()["note"]
    assert _unread(client)["by_thesis"][t["id"]] == {
        "total": 2, "thesis": 1, "note": 1, "zettel": 0, "answer": 0, "graph": 0, "reading": 0}
    assert client.post(R, json={"thesis_id": t["id"]}).json()["marked"] == 2
    assert _keys(_unread(client)) == {("thesis", other["id"])}
    client.post(f"{R}/unmark", json={"items": [{"type": "note", "id": n["id"]}]})
    assert ("note", n["id"]) in _keys(_unread(client, thesis_id=t["id"]))


def test_an_unknown_type_is_refused(client):
    assert client.post(R, json={"items": [{"type": "trade", "id": "x"}]}).status_code == 422
