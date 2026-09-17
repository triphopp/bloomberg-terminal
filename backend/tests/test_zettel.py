"""
Zettelkasten knowledge base.

The point of the feature is that disagreement survives: a contradiction must stay
visible until someone writes down how it was settled, the losing note must stay
readable, and nothing an agent wrote may look like the user wrote it. These tests
guard those properties, not the CRUD.
"""
import importlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "z.db"))
    monkeypatch.setenv("SYNC_DEVICE_ID", "PC")
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema(); db.init_zettel_schema()
    db.init_alerts_schema(); db.init_sync_layer()
    import sync.config as scfg
    importlib.reload(scfg)
    import routers.theses as theses
    importlib.reload(theses)
    import routers.zettel as zettel
    importlib.reload(zettel)

    app = FastAPI()
    app.include_router(theses.router)
    app.include_router(zettel.router)
    c = TestClient(app)
    c.zettel = zettel  # module handle for the few direct-call assertions
    return c


Z = "/api/v2/zettel"
AGENT = {"X-Thesis-Actor": "agent:claude"}


def _thesis(client, symbol="SNDK"):
    return client.post("/api/v2/theses", json={"symbol": symbol, "title": "NAND"}).json()["thesis"]


def _new(client, title, headers=None, **kw):
    body = {"title": title, **kw}
    r = client.post(Z, json=body, headers=headers or {})
    assert r.status_code == 200, r.text
    return r.json()["zettel"]


# ── Identity ─────────────────────────────────────────────────────────────────

def test_ref_is_sequential_and_human_readable(client):
    a = _new(client, "NAND supply tightens through 2027")
    b = _new(client, "HBF ships in volume in 2027")
    assert a["ref"] == "Z-0001"
    assert b["ref"] == "Z-0002"


def test_lookup_works_by_ref_or_uuid(client):
    z = _new(client, "CXMT yield above 90 percent")
    by_uuid = client.get(f"{Z}/{z['id']}").json()["zettel"]
    by_ref = client.get(f"{Z}/{z['ref']}").json()["zettel"]
    assert by_uuid["id"] == by_ref["id"] == z["id"]


def test_duplicate_title_is_refused_with_the_existing_id(client):
    z = _new(client, "CXMT yield above 90 percent")
    r = client.post(Z, json={"title": "  cxmt YIELD above 90 PERCENT "})
    assert r.status_code == 409
    # The caller has to be able to act on the answer, so the id is in the message.
    assert z["ref"] in r.json()["detail"] and z["id"] in r.json()["detail"]


def test_evidence_without_a_source_is_refused(client):
    r = client.post(Z, json={"title": "Revenue grew 40 percent", "kind": "EVIDENCE"})
    assert r.status_code == 400
    ok = client.post(Z, json={
        "title": "Revenue grew 40 percent", "kind": "EVIDENCE",
        "sources": [{"url": "https://sec.gov/x", "publisher": "SEC", "reliability": "primary"}],
    })
    assert ok.status_code == 200


# ── Reuse across theses ──────────────────────────────────────────────────────

def test_one_zettel_serves_several_theses(client):
    t1, t2 = _thesis(client, "SNDK"), _thesis(client, "MU")
    z = _new(client, "NAND contract prices rose 20 percent QoQ", thesis_id=t1["id"])
    client.post(f"{Z}/{z['id']}/refs", json={"target_type": "thesis", "target_id": t2["id"]})

    for t in (t1, t2):
        rows = client.get(Z, params={"thesis_id": t["id"]}).json()["zettel"]
        assert [r["id"] for r in rows] == [z["id"]]
    # …and the link shows up in both timelines, not just the one it was born on.
    ev2 = client.get(f"/api/v2/theses/{t2['id']}/events").json()["events"]
    assert any(e["event_type"] == "ZETTEL_LINKED" for e in ev2)


def test_creating_against_a_thesis_writes_its_timeline(client):
    t = _thesis(client)
    _new(client, "Hyperscaler capex guide raised", thesis_id=t["id"])
    kinds = [e["event_type"] for e in client.get(f"/api/v2/theses/{t['id']}/events").json()["events"]]
    assert "ZETTEL_ADDED" in kinds


# ── Contradiction: the feature's reason to exist ─────────────────────────────

def test_contradiction_stays_open_until_a_resolution_is_written(client):
    t = _thesis(client)
    a = _new(client, "China still struggles with NAND yield", thesis_id=t["id"])
    b = _new(client, "CXMT reaches 90 percent DDR5 yield", thesis_id=t["id"])
    edge = client.post(f"{Z}/edges", json={
        "src_id": b["id"], "dst_id": a["id"], "rel": "CONTRADICTS", "note": "newer reporting",
    }).json()["edge"]

    assert client.get(f"{Z}/conflicts").json()["open_count"] == 1
    # An empty resolution is not a resolution.
    assert client.patch(f"{Z}/edges/{edge['id']}", json={"resolution": "  "}).status_code == 400
    assert client.get(f"{Z}/conflicts").json()["open_count"] == 1

    client.patch(f"{Z}/edges/{edge['id']}", json={
        "resolution": "TrendForce confirmed; the earlier note predates the ramp",
        "superseded_id": a["id"],
    })
    assert client.get(f"{Z}/conflicts").json()["open_count"] == 0
    resolved = client.get(f"{Z}/conflicts", params={"include_resolved": True}).json()["conflicts"]
    assert resolved[0]["resolution"].startswith("TrendForce confirmed")


def test_superseded_note_stays_readable(client):
    a = _new(client, "China still struggles with NAND yield")
    b = _new(client, "CXMT reaches 90 percent DDR5 yield")
    client.post(f"{Z}/edges", json={"src_id": b["id"], "dst_id": a["id"], "rel": "SUPERSEDES"})
    old = client.get(f"{Z}/{a['id']}").json()
    assert old["zettel"]["status"] == "superseded"
    assert old["zettel"]["deleted_at"] is None
    assert old["zettel"]["title"]  # the text itself is untouched


def test_resolved_conflict_cannot_be_deleted(client):
    a, b = _new(client, "claim A"), _new(client, "claim B")
    edge = client.post(f"{Z}/edges", json={
        "src_id": a["id"], "dst_id": b["id"], "rel": "CONTRADICTS",
    }).json()["edge"]
    assert client.delete(f"{Z}/edges/{edge['id']}").status_code == 200  # unresolved: a mis-draw

    edge2 = client.post(f"{Z}/edges", json={
        "src_id": a["id"], "dst_id": b["id"], "rel": "CONTRADICTS",
    }).json()["edge"]
    client.patch(f"{Z}/edges/{edge2['id']}", json={"resolution": "both true at different dates"})
    assert client.delete(f"{Z}/edges/{edge2['id']}").status_code == 400


def test_soft_delete_keeps_the_edges(client):
    a, b = _new(client, "claim A"), _new(client, "claim B")
    client.post(f"{Z}/edges", json={"src_id": a["id"], "dst_id": b["id"], "rel": "CONTRADICTS"})
    client.delete(f"{Z}/{a['id']}")
    # "what did this once contradict" must still be answerable
    assert client.get(f"{Z}/{b['id']}/backlinks").json()["in"]


def test_self_link_and_duplicate_edge_are_refused(client):
    a, b = _new(client, "claim A"), _new(client, "claim B")
    assert client.post(f"{Z}/edges", json={
        "src_id": a["id"], "dst_id": a["id"], "rel": "SUPPORTS"}).status_code == 400
    first = client.post(f"{Z}/edges", json={
        "src_id": a["id"], "dst_id": b["id"], "rel": "SUPPORTS"}).json()
    second = client.post(f"{Z}/edges", json={
        "src_id": a["id"], "dst_id": b["id"], "rel": "SUPPORTS"}).json()
    assert first["created"] is True and second["created"] is False
    assert first["edge"]["id"] == second["edge"]["id"]


# ── Sources ──────────────────────────────────────────────────────────────────

def test_claims_resting_on_one_source_are_findable(client):
    url = "https://www.trendforce.com/news/2026/09/15/cxmt-ddr5"
    src = {"url": url, "publisher": "TrendForce", "reliability": "secondary"}
    _new(client, "CXMT yield at 90 percent", kind="EVIDENCE", sources=[src])
    _new(client, "Supply glut arrives in 2027", kind="EVIDENCE", sources=[src])
    hits = client.get(f"{Z}/sources/by-url", params={"url": "trendforce.com"}).json()["zettel"]
    assert len(hits) == 2


# ── Search ───────────────────────────────────────────────────────────────────

def test_search_matches_inside_thai_text(client):
    """unicode61 indexes a Thai clause as one token — a mid-clause word would be
    unfindable. The schema uses a trigram tokenizer for exactly this."""
    _new(client, "CXMT ดัน DDR5 yield ทะลุ 90 เปอร์เซ็นต์", body="ซัพพลายขยายเร็วกว่าคาด")
    hits = client.get(f"{Z}/search", params={"q": "ทะลุ"}).json()["zettel"]
    assert len(hits) == 1
    body_hit = client.get(f"{Z}/search", params={"q": "ซัพพลาย"}).json()["zettel"]
    assert len(body_hit) == 1


def test_malformed_search_falls_back_instead_of_500(client):
    _new(client, "quoted \"claim\" here")
    r = client.get(f"{Z}/search", params={"q": '"unbalanced'})
    assert r.status_code == 200


# ── Attribution ──────────────────────────────────────────────────────────────

def test_agent_writes_are_attributed(client):
    t = _thesis(client)
    z = _new(client, "Agent found NAND pricing data", headers=AGENT, thesis_id=t["id"])
    assert z["actor"] == "agent:claude"
    user_z = _new(client, "My own note")
    assert user_z["actor"] == "user"
    ev = client.get(f"/api/v2/theses/{t['id']}/events").json()["events"]
    added = next(e for e in ev if e["event_type"] == "ZETTEL_ADDED")
    assert added["payload"]["actor"] == "agent:claude"


# ── Graph ────────────────────────────────────────────────────────────────────

def test_graph_walks_outward_by_depth(client):
    t = _thesis(client)
    a = _new(client, "root claim", thesis_id=t["id"])
    b = _new(client, "one hop")
    c = _new(client, "two hops")
    client.post(f"{Z}/edges", json={"src_id": b["id"], "dst_id": a["id"], "rel": "SUPPORTS"})
    client.post(f"{Z}/edges", json={"src_id": c["id"], "dst_id": b["id"], "rel": "SUPPORTS"})

    d1 = client.get(f"{Z}/graph", params={"root_id": a["id"], "depth": 1}).json()
    assert {n["id"] for n in d1["nodes"]} == {a["id"], b["id"]}
    d2 = client.get(f"{Z}/graph", params={"root_id": a["id"], "depth": 2}).json()
    assert {n["id"] for n in d2["nodes"]} == {a["id"], b["id"], c["id"]}


# ── Post-merge housekeeping ─────────────────────────────────────────────────

def test_ref_collisions_are_renamed_oldest_first(client):
    """Two offline devices mint Z-0002 independently; after a merge the older row
    keeps the label. A UNIQUE index would have aborted the whole import instead."""
    import db
    a = _new(client, "local note")
    b = _new(client, "note that arrived from the other device")
    with db.get_db() as conn:
        conn.execute("UPDATE zettel SET ref = 'Z-0002', created_at = '2026-01-01' WHERE id = ?",
                     (a["id"],))
        conn.execute("UPDATE zettel SET ref = 'Z-0002', created_at = '2026-02-01' WHERE id = ?",
                     (b["id"],))
    out = client.post(f"{Z}/resolve-ref-collisions").json()
    assert out["count"] == 1
    assert client.get(f"{Z}/{a['id']}").json()["zettel"]["ref"] == "Z-0002"
    assert client.get(f"{Z}/{b['id']}").json()["zettel"]["ref"] != "Z-0002"


def test_zettel_tables_are_synced(client):
    from sync.config import SYNC_TABLES
    names = {t for t, _ in SYNC_TABLES}
    assert {"zettel", "zettel_edges", "zettel_sources", "zettel_refs"} <= names
    # The FTS index is derived: syncing it would ship one device's index to another.
    assert "zettel_fts" not in names


def test_conflict_is_logged_once_per_thesis(client):
    """Both sides usually hang off the same thesis — logging per side would double
    every CONFLICT entry in its timeline."""
    t = _thesis(client)
    a = _new(client, "side A", thesis_id=t["id"])
    b = _new(client, "side B", thesis_id=t["id"])
    edge = client.post(f"{Z}/edges", json={
        "src_id": b["id"], "dst_id": a["id"], "rel": "CONTRADICTS"}).json()["edge"]
    client.patch(f"{Z}/edges/{edge['id']}", json={"resolution": "A measured a different quarter"})

    kinds = [e["event_type"] for e in client.get(f"/api/v2/theses/{t['id']}/events").json()["events"]]
    assert kinds.count("CONFLICT_OPENED") == 1
    assert kinds.count("CONFLICT_RESOLVED") == 1


# ── Obsidian export ─────────────────────────────────────────────────────────

def test_export_writes_linked_markdown(client, tmp_path, monkeypatch):
    vault = tmp_path / "wiki"
    monkeypatch.setenv("OBSIDIAN_WIKI_DIR", str(vault))
    import importlib, config, routers.zettel as zmod
    importlib.reload(config)
    monkeypatch.setattr(zmod, "OBSIDIAN_WIKI_DIR", config.OBSIDIAN_WIKI_DIR)

    a = _new(client, "China still struggles with NAND yield")
    b = _new(client, "CXMT ดัน DDR5 yield ทะลุ 90%", kind="EVIDENCE", tags="nand, cxmt",
             sources=[{"url": "https://trendforce.com/x", "publisher": "TrendForce",
                       "quote": "~90% yield", "reliability": "secondary"}])
    client.post(f"{Z}/edges", json={"src_id": b["id"], "dst_id": a["id"],
                                    "rel": "CONTRADICTS", "note": "newer reporting"})

    out = client.post(f"{Z}/export-md").json()
    assert out["written"] == 2 and out["open_conflicts"] == 1

    zdir = vault / "zettel"
    note = next(p for p in zdir.glob("Z-0002-*.md"))
    text = note.read_text(encoding="utf-8")
    assert "ref: Z-0002" in text and "tags: [nand, cxmt]" in text
    assert "> ~90% yield" in text
    # The wikilink is what makes Obsidian's graph draw the argument.
    assert "CONTRADICTS [[Z-0001-" in text
    # …and the other side gets the backlink, so the graph is not one-directional.
    other = next(p for p in zdir.glob("Z-0001-*.md")).read_text(encoding="utf-8")
    assert "← CONTRADICTS from [[Z-0002-" in other
    index = (zdir / "INDEX.md").read_text(encoding="utf-8")
    assert "Open conflicts" in index and "[[Z-0002-" in index


def test_export_reports_stale_files(client, tmp_path, monkeypatch):
    """A note renamed in the DB leaves its old file behind; the vault's graph
    would keep showing it, so the caller is told which files to clear."""
    vault = tmp_path / "wiki2"
    monkeypatch.setenv("OBSIDIAN_WIKI_DIR", str(vault))
    import importlib, config, routers.zettel as zmod
    importlib.reload(config)
    monkeypatch.setattr(zmod, "OBSIDIAN_WIKI_DIR", config.OBSIDIAN_WIKI_DIR)

    z = _new(client, "first title")
    client.post(f"{Z}/export-md")
    client.patch(f"{Z}/{z['id']}", json={"title": "second title", "reason": "clearer"})
    out = client.post(f"{Z}/export-md").json()
    assert any(f.startswith("Z-0001-first") for f in out["stale"])


def test_editing_a_note_keeps_search_working(client):
    """Regression: the sync layer's own AFTER UPDATE trigger re-stamps updated_at,
    which used to fire the FTS trigger a second time with stale content and left
    the index corrupt ("database disk image is malformed")."""
    z = _new(client, "yield holds at 60 percent")
    r = client.patch(f"{Z}/{z['id']}", json={"title": "yield jumps to 90 percent",
                                             "reason": "new reporting"})
    assert r.status_code == 200, r.text
    assert client.get(f"{Z}/search", params={"q": "jumps"}).json()["zettel"]
    assert not client.get(f"{Z}/search", params={"q": "holds"}).json()["zettel"]
    # A field that is not indexed must not disturb the index either.
    client.patch(f"{Z}/{z['id']}", json={"confidence": 4, "reason": "more sure"})
    assert client.get(f"{Z}/search", params={"q": "jumps"}).json()["zettel"]
