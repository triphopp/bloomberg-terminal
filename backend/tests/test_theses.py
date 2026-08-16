"""
Thesis system: CRUD, the append-only event log, soft delete, markdown import,
and the cloud-sync round trip.

The event log is the point of the feature — an edit that does not leave a
readable trace of what changed is the failure mode these tests guard.
"""
import importlib
import uuid

import pytest


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """A fresh DB with the thesis schema + sync triggers installed."""
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "t.db"))
    monkeypatch.setenv("THESES_DIR", str(tmp_path / "theses"))
    monkeypatch.setenv("SYNC_DEVICE_ID", "PC")
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema()
    db.init_alerts_schema(); db.init_sync_layer()
    import sync.config as scfg
    importlib.reload(scfg)
    import routers.theses as mod
    importlib.reload(mod)
    return mod


# The route functions are called directly (no HTTP layer), so every Query()
# default has to be passed explicitly — an unbound Query object reaches sqlite
# as a parameter otherwise.

def _list(mod, **kw):
    return mod.list_theses(
        kw.get("symbol"), kw.get("category"), kw.get("status"),
        kw.get("account_id"), kw.get("include_deleted", False),
    )["theses"]


def _events(mod, thesis_id):
    return mod.list_events(thesis_id, 200)["events"]


def _detail(mod, thesis_id):
    return mod.get_thesis(thesis_id, 50)


def _new(mod, **kw):
    body = mod.ThesisIn(symbol=kw.pop("symbol", "PLTR"), **kw)
    return mod.create_thesis(body)["thesis"]


# ── CRUD ─────────────────────────────────────────────────────────────────────

def test_create_logs_created_event(env):
    t = _new(env, title="AI inference land grab")
    assert t["status"] == "draft"
    assert t["symbol"] == "PLTR"
    events = _events(env, t["id"])
    assert [e["event_type"] for e in events] == ["CREATED"]


def test_symbol_is_uppercased(env):
    assert _new(env, symbol="  pltr ")["symbol"] == "PLTR"


def test_invalid_status_rejected(env):
    with pytest.raises(Exception):
        env.create_thesis(env.ThesisIn(symbol="X", status="banana"))


# ── The event log ────────────────────────────────────────────────────────────

def test_edit_records_only_changed_fields(env):
    t = _new(env, title="old", conviction=3)
    env.patch_thesis(t["id"], env.ThesisPatch(title="new", conviction=3, note="sharpened it"))
    ev = _events(env, t["id"])[0]
    assert ev["event_type"] == "EDITED"
    assert ev["note"] == "sharpened it"
    # conviction was resubmitted unchanged — it must not appear as a "change"
    assert set(ev["payload"]) == {"title"}
    assert ev["payload"]["title"] == {"from": "old", "to": "new"}


def test_status_flip_is_labelled(env):
    t = _new(env)
    env.patch_thesis(t["id"], env.ThesisPatch(status="active"))
    assert _events(env, t["id"])[0]["event_type"] == "STATUS_CHANGED"
    env.patch_thesis(t["id"], env.ThesisPatch(status="invalidated", note="guidance cut"))
    assert _events(env, t["id"])[0]["event_type"] == "INVALIDATED"


def test_target_change_is_labelled(env):
    t = _new(env, target_price=20.0)
    env.patch_thesis(t["id"], env.ThesisPatch(target_price=35.0))
    assert _events(env, t["id"])[0]["event_type"] == "TARGET_CHANGED"


def test_note_only_patch_logs_without_touching_head(env):
    t = _new(env, title="keep")
    out = env.patch_thesis(t["id"], env.ThesisPatch(note="quarterly re-read, still holds"))
    assert out["changed"] == []
    assert out["thesis"]["title"] == "keep"
    assert _events(env, t["id"])[0]["event_type"] == "NOTE"


def test_history_survives_edits(env):
    t = _new(env, title="v1")
    for title in ("v2", "v3", "v4"):
        env.patch_thesis(t["id"], env.ThesisPatch(title=title))
    kinds = [e["event_type"] for e in _events(env, t["id"])]
    assert kinds == ["EDITED", "EDITED", "EDITED", "CREATED"]


def test_manual_event_can_be_backdated(env):
    t = _new(env)
    env.add_event(t["id"], env.EventIn(note="read the 10-K", occurred_at="2024-01-05T00:00:00"))
    ev = _events(env, t["id"])[-1]   # oldest first at the tail
    assert ev["occurred_at"] == "2024-01-05T00:00:00"


def test_only_manual_notes_are_deletable(env):
    t = _new(env)
    created = _events(env, t["id"])[0]
    with pytest.raises(Exception):
        env.delete_event(t["id"], created["id"])
    note = env.add_event(t["id"], env.EventIn(note="typo"))["event"]
    env.delete_event(t["id"], note["id"])
    assert all(e["id"] != note["id"] for e in _events(env, t["id"]))


# ── Delete semantics ─────────────────────────────────────────────────────────

def test_soft_delete_hides_but_keeps_history(env):
    t = _new(env)
    env.delete_thesis(t["id"], purge=False, note="wrong ticker")
    assert _list(env) == []
    assert len(_list(env, include_deleted=True)) == 1
    assert _events(env, t["id"])[0]["event_type"] == "DELETED"
    env.restore_thesis(t["id"])
    assert len(_list(env)) == 1


def test_soft_delete_writes_no_tombstone_but_purge_does(env):
    """A soft delete must stay reversible on the OTHER machine too — a tombstone
    would make the merge erase it there permanently."""
    import db
    t = _new(env)
    env.delete_thesis(t["id"], purge=False, note="")
    with db.get_db() as c:
        tombs = c.execute(
            "SELECT * FROM sync_tombstones WHERE table_name = 'theses'"
        ).fetchall()
    assert tombs == []

    env.delete_thesis(t["id"], purge=True, note="")
    with db.get_db() as c:
        tombs = c.execute(
            "SELECT row_id FROM sync_tombstones WHERE table_name = 'theses'"
        ).fetchall()
    assert [r["row_id"] for r in tombs] == [t["id"]]


# ── Trade links ──────────────────────────────────────────────────────────────

def test_link_trade_and_summary(env):
    import db
    trade_id = str(uuid.uuid4())
    with db.get_db() as c:
        c.execute(
            "INSERT INTO portfolio_accounts(id,name) VALUES('acc','ACC')"
        )
        c.execute(
            "INSERT INTO trades(id,account_id,symbol,date_entry,price_entry,volume) "
            "VALUES(?,?,?,?,?,?)",
            (trade_id, "acc", "PLTR", "2026-01-02", 20.0, 100),
        )
    t = _new(env)
    env.link_trade(t["id"], env.LinkIn(trade_id=trade_id, role="entry"))
    detail = _detail(env, t["id"])
    assert [link["trade_id"] for link in detail["links"]] == [trade_id]
    assert env.theses_summary()["by_symbol"]["PLTR"]["count"] == 1

    env.unlink_trade(t["id"], trade_id)
    assert _detail(env, t["id"])["links"] == []


def test_link_to_missing_trade_rejected(env):
    t = _new(env)
    with pytest.raises(Exception):
        env.link_trade(t["id"], env.LinkIn(trade_id="nope"))


# ── Markdown import / export ─────────────────────────────────────────────────

def _write_md(mod, name, text):
    mod.THESES_DIR.mkdir(parents=True, exist_ok=True)
    (mod.THESES_DIR / name).write_text(text, encoding="utf-8")


def test_import_md_parses_frontmatter_and_is_idempotent(env):
    _write_md(env, "PLTR-ai-thesis.md", (
        "---\n"
        "title: AI inference land grab\n"
        "status: active\n"
        "confidence: high\n"
        "target: 45\n"
        "---\n\n"
        "## Claim\nOwns the workflow layer.\n"
    ))
    out = env.import_markdown(False)
    assert out["imported_count"] == 1
    t = _list(env)[0]
    assert t["symbol"] == "PLTR"
    assert t["title"] == "AI inference land grab"
    assert t["conviction"] == 4          # "high" → 4
    assert t["target_price"] == 45.0
    assert "Owns the workflow layer." in t["body"]

    again = env.import_markdown(False)
    assert again["imported_count"] == 0   # keyed on source_file, no duplicate
    assert len(_list(env)) == 1


def test_import_md_unknown_status_falls_back_to_active(env):
    _write_md(env, "NVDA-x.md", "---\nstatus: cooking\n---\nbody\n")
    env.import_markdown(False)
    assert _list(env)[0]["status"] == "active"


def test_export_md_round_trips(env):
    t = _new(env, title="Round trip", body="## Claim\nStill cheap.")
    env.patch_thesis(t["id"], env.ThesisPatch(status="active"))
    out = env.export_markdown(t["id"])
    text = (env.THESES_DIR / out["file"]).read_text(encoding="utf-8")
    assert "title: Round trip" in text
    assert "status: active" in text
    assert "Still cheap." in text
    # export stamps source_file so the next export overwrites the same note
    assert _detail(env, t["id"])["thesis"]["source_file"] == out["file"]


# ── Cloud sync ───────────────────────────────────────────────────────────────

def test_theses_are_in_the_sync_table_list():
    import sync.config as scfg
    names = dict(scfg.SYNC_TABLES)
    assert names["theses"] == ["id"]
    assert names["thesis_events"] == ["id"]
    assert names["thesis_links"] == ["thesis_id", "trade_id"]
    assert names["allocation_targets"] == ["account_id", "scope", "key"]


def test_thesis_gets_updated_at_stamp_for_lww(env):
    import db
    t = _new(env)
    env.patch_thesis(t["id"], env.ThesisPatch(title="edited"))
    with db.get_db() as c:
        row = c.execute("SELECT updated_at FROM theses WHERE id = ?", (t["id"],)).fetchone()
    assert row["updated_at"]   # trigger fired; merge has something to compare
