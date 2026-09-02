"""
Thesis notes: the standing scenarios/risks/catalysts attached to a thesis.

A note is the mutable counterpart to a thesis_event — the tests here pin down
the two properties that distinguish it: it can be edited in place without
touching the append-only log, and resolving one (confirmed/dismissed) DOES
write a single event, because that is the thinking actually moving.
"""
import importlib
from datetime import date, timedelta

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


# Route functions are called directly (no HTTP layer), so every Query() default
# has to be passed explicitly — an unbound Query object reaches sqlite as a
# parameter otherwise.

def _thesis(mod, symbol="PLTR"):
    return mod.create_thesis(mod.ThesisIn(symbol=symbol, title="t"))["thesis"]


def _add(mod, thesis_id, **kw):
    kw.setdefault("title", "China export controls tighten")
    return mod.add_note(thesis_id, mod.NoteIn(**kw))["note"]


def _list(mod, thesis_id, include_deleted=False):
    return mod.list_notes(thesis_id, include_deleted)["notes"]


def _events(mod, thesis_id):
    return mod.list_events(thesis_id, 200)["events"]


def _theses(mod):
    return mod.list_theses(None, None, None, None, False)["theses"]


# ── Create ───────────────────────────────────────────────────────────────────

def test_add_note_defaults_and_event(env):
    t = _thesis(env)
    n = _add(env, t["id"], kind="risk")
    assert n["kind"] == "RISK"          # normalised to upper
    assert n["status"] == "open"
    assert n["pinned"] == 0
    assert n["deleted_at"] is None
    assert "NOTE_ADDED" in [e["event_type"] for e in _events(env, t["id"])]


def test_note_needs_some_text(env):
    t = _thesis(env)
    with pytest.raises(Exception):
        env.add_note(t["id"], env.NoteIn(title="   ", body=""))


def test_bad_kind_and_status_rejected(env):
    t = _thesis(env)
    with pytest.raises(Exception):
        env.add_note(t["id"], env.NoteIn(kind="RUMOUR", title="x"))
    with pytest.raises(Exception):
        env.add_note(t["id"], env.NoteIn(status="maybe", title="x"))
    with pytest.raises(Exception):
        env.add_note(t["id"], env.NoteIn(impact="sideways", title="x"))


def test_likelihood_and_severity_clamped(env):
    t = _thesis(env)
    n = _add(env, t["id"], likelihood=9, severity=0)
    assert n["likelihood"] == 5
    assert n["severity"] == 1


def test_note_on_missing_thesis_404s(env):
    with pytest.raises(Exception):
        env.add_note("no-such-id", env.NoteIn(title="x"))


# ── Edit ─────────────────────────────────────────────────────────────────────

def test_patch_edits_in_place_without_touching_the_log(env):
    t = _thesis(env)
    n = _add(env, t["id"])
    before = len(_events(env, t["id"]))
    out = env.patch_note(t["id"], n["id"], env.NotePatch(body="tightened again"))["note"]
    assert out["body"] == "tightened again"
    assert out["title"] == n["title"]
    # A body edit is not a change of mind — the timeline stays as it was.
    assert len(_events(env, t["id"])) == before


def test_resolving_a_note_writes_one_event(env):
    t = _thesis(env)
    n = _add(env, t["id"])
    env.patch_note(t["id"], n["id"], env.NotePatch(status="confirmed"))
    kinds = [e["event_type"] for e in _events(env, t["id"])]
    assert kinds.count("NOTE_RESOLVED") == 1
    # Re-sending the same status is a no-op, not a second entry.
    env.patch_note(t["id"], n["id"], env.NotePatch(status="confirmed"))
    kinds = [e["event_type"] for e in _events(env, t["id"])]
    assert kinds.count("NOTE_RESOLVED") == 1


def test_watching_status_is_not_a_resolution(env):
    t = _thesis(env)
    n = _add(env, t["id"])
    env.patch_note(t["id"], n["id"], env.NotePatch(status="watching"))
    assert "NOTE_RESOLVED" not in [e["event_type"] for e in _events(env, t["id"])]


def test_empty_string_clears_watch_date_and_impact(env):
    t = _thesis(env)
    n = _add(env, t["id"], watch_date="2026-09-30", impact="bear")
    out = env.patch_note(t["id"], n["id"], env.NotePatch(watch_date="", impact=""))["note"]
    assert out["watch_date"] is None
    assert out["impact"] is None


def test_patch_ignores_unknown_fields(env):
    """`thesis_id` is not in NOTE_EDITABLE — a note cannot be moved by a PATCH."""
    t = _thesis(env)
    n = _add(env, t["id"])
    out = env.patch_note(t["id"], n["id"], env.NotePatch(title="renamed"))["note"]
    assert out["thesis_id"] == t["id"]
    assert out["title"] == "renamed"


# ── Delete ───────────────────────────────────────────────────────────────────

def test_delete_is_soft_by_default(env):
    t = _thesis(env)
    n = _add(env, t["id"])
    env.delete_note(t["id"], n["id"], False)
    assert _list(env, t["id"]) == []
    assert len(_list(env, t["id"], include_deleted=True)) == 1


def test_purge_removes_the_row(env):
    t = _thesis(env)
    n = _add(env, t["id"])
    env.delete_note(t["id"], n["id"], True)
    assert _list(env, t["id"], include_deleted=True) == []


# ── Ordering / counts / due ──────────────────────────────────────────────────

def test_pinned_first_then_soonest_watch_date(env):
    t = _thesis(env)
    _add(env, t["id"], title="undated")
    _add(env, t["id"], title="later", watch_date="2027-01-01")
    _add(env, t["id"], title="sooner", watch_date="2026-01-01")
    _add(env, t["id"], title="pinned", pinned=True)
    assert [n["title"] for n in _list(env, t["id"])] == ["pinned", "sooner", "later", "undated"]


def test_open_note_count_excludes_resolved_and_deleted(env):
    t = _thesis(env)
    a = _add(env, t["id"], title="a")
    b = _add(env, t["id"], title="b")
    _add(env, t["id"], title="c")
    env.patch_note(t["id"], a["id"], env.NotePatch(status="dismissed"))
    env.delete_note(t["id"], b["id"], False)
    row = next(r for r in _theses(env) if r["id"] == t["id"])
    assert row["open_note_count"] == 1


def test_notes_due_window(env):
    t = _thesis(env)
    soon = (date.today() + timedelta(days=3)).isoformat()
    far = (date.today() + timedelta(days=90)).isoformat()
    _add(env, t["id"], title="soon", watch_date=soon)
    _add(env, t["id"], title="far", watch_date=far)
    _add(env, t["id"], title="undated")
    due = env.notes_due(14, False)["notes"]
    assert [n["title"] for n in due] == ["soon"]
    assert due[0]["symbol"] == "PLTR"       # joined to its thesis
    with_undated = env.notes_due(14, True)["notes"]
    assert {n["title"] for n in with_undated} == {"soon", "undated"}


def test_notes_due_skips_resolved_and_deleted_theses(env):
    t = _thesis(env)
    soon = (date.today() + timedelta(days=1)).isoformat()
    n = _add(env, t["id"], title="resolved", watch_date=soon)
    env.patch_note(t["id"], n["id"], env.NotePatch(status="confirmed"))
    assert env.notes_due(14, False)["notes"] == []

    t2 = _thesis(env, symbol="NVDA")
    _add(env, t2["id"], title="orphan", watch_date=soon)
    env.delete_thesis(t2["id"], False, "")
    assert env.notes_due(14, False)["notes"] == []


def test_detail_carries_notes(env):
    t = _thesis(env)
    _add(env, t["id"], title="scenario")
    assert [n["title"] for n in env.get_thesis(t["id"], 50)["notes"]] == ["scenario"]


# ── Sync ─────────────────────────────────────────────────────────────────────

def test_notes_table_is_synced(env):
    import sync.config as scfg
    assert "thesis_notes" in dict(scfg.SYNC_TABLES)
    assert dict(scfg.SYNC_TABLES)["thesis_notes"] == ["id"]


def test_updated_at_is_stamped_for_lww(env):
    """The sync trigger has to see the row change, or last-write-wins can never
    pick a winner and two devices stay diverged."""
    t = _thesis(env)
    n = _add(env, t["id"])
    out = env.patch_note(t["id"], n["id"], env.NotePatch(title="edited"))["note"]
    assert out["updated_at"] and out["updated_at"] >= n["updated_at"]
