"""ASK conversations kept as files (backend/ask_sessions.py)."""
import json

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import ask_sessions

SID = "20261006-163200-a1b2c3"
PIC = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="


@pytest.fixture(autouse=True)
def _no_machine_settings(tmp_path, monkeypatch):
    """Not this machine's backend/.env: what it says outranks the environment the tests set."""
    env = tmp_path / "empty.env"
    env.write_text("", encoding="utf-8")
    monkeypatch.setattr(ask_sessions, "_ENV_FILE", env)


@pytest.fixture
def store(tmp_path, monkeypatch):
    """Conversations in a temp folder; no cloud folder on this "machine"."""
    monkeypatch.setenv("ASK_SESSIONS_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("ASK_SESSIONS_STORE", "auto")
    monkeypatch.setattr(ask_sessions.sync_config, "sync_dir", lambda: None)
    return tmp_path / "sessions"


def _conversation():
    return [
        {"role": "user", "content": "what is this", "at": 1_791_278_000_000, "images": [PIC], "junk": "x"},
        {"role": "assistant", "content": "a chart", "private": True, "tools": [{"label": "SCREEN", "detail": ""}]},
        {"role": "user", "content": "and now?"},
        {"role": "assistant", "content": "", "pending": True},          # still streaming: not kept
    ]


def test_a_conversation_comes_back_as_it_was_saved(store):
    meta = ask_sessions.save(SID, _conversation(), page="bonds", model="deepseek-chat")
    assert meta["title"] == "what is this" and meta["questions"] == 2 and meta["private"] is True

    on_disk = json.loads((store / "2026-10" / f"{SID}.json").read_text(encoding="utf-8"))
    assert "base64" not in json.dumps(on_disk)                     # the picture is a file beside it
    assert (store / "2026-10" / f"{SID}.0-0.jpg").read_bytes().startswith(b"\xff\xd8")
    assert "junk" not in on_disk["messages"][0] and len(on_disk["messages"]) == 3

    back = ask_sessions.load(SID)
    assert back["messages"][0]["images"] == [PIC]
    assert back["messages"][1] == {"role": "assistant", "content": "a chart", "private": True,
                                   "tools": [{"label": "SCREEN", "detail": ""}]}
    assert back["page"] == "bonds" and back["model"] == "deepseek-chat"


def test_saving_again_keeps_when_it_started(store):
    first = ask_sessions.save(SID, _conversation())
    again = ask_sessions.save(SID, _conversation()[:2] + [{"role": "user", "content": "more"},
                                                          {"role": "assistant", "content": "yes"}])
    assert again["created_at"] == first["created_at"] and again["questions"] == 2


def test_a_picture_that_is_gone_is_counted_not_fatal(store):
    ask_sessions.save(SID, _conversation())
    (store / "2026-10" / f"{SID}.0-0.jpg").unlink()
    first = ask_sessions.load(SID)["messages"][0]
    assert "images" not in first and first["lostImages"] == 1


def test_the_list_is_newest_first_and_skips_what_is_not_ours(store):
    older, newer = "20260930-090000-000001", "20261006-170000-000002"
    for sid in (older, SID, newer):
        ask_sessions.save(sid, [{"role": "user", "content": sid}, {"role": "assistant", "content": "a"}])
    (store / "2026-10" / f"{SID} (1).json").write_text("{}", encoding="utf-8")     # a cloud conflict copy
    (store / "2026-10" / "notes.json").write_text("{}", encoding="utf-8")
    (store / "2026-10" / f"{newer}.json.tmp").write_text("{", encoding="utf-8")
    assert [s["id"] for s in ask_sessions.list_sessions()] == [newer, SID, older]
    assert [s["id"] for s in ask_sessions.list_sessions(limit=1)] == [newer]


def test_delete_moves_the_files_aside(store):
    ask_sessions.save(SID, _conversation())
    out = ask_sessions.remove(SID)
    assert out["files"] == 2
    assert (store / "_deleted" / f"{SID}.json").exists() and (store / "_deleted" / f"{SID}.0-0.jpg").exists()
    assert ask_sessions.list_sessions() == []
    with pytest.raises(HTTPException) as gone:
        ask_sessions.load(SID)
    assert gone.value.status_code == 404


@pytest.mark.parametrize("bad", ["../../etc/passwd", "20261006-163200-A1B2C3", "config", "", "20261006-163200-a1b2c3.json"])
def test_an_id_is_a_timestamp_and_six_hex_digits_nothing_else(store, bad):
    with pytest.raises(HTTPException) as refused:
        ask_sessions.save(bad, _conversation())
    assert refused.value.status_code == 422


def test_nothing_to_save_is_refused(store):
    with pytest.raises(HTTPException):
        ask_sessions.save(SID, [{"role": "assistant", "content": "orphan"}])


# ── Where ────────────────────────────────────────────────────────────────────

def test_where_conversations_go(tmp_path, monkeypatch):
    monkeypatch.setenv("ASK_SESSIONS_DIR", "")
    cloud = tmp_path / "My Drive" / "Investment Portfolio"
    cloud.mkdir(parents=True)

    monkeypatch.setattr(ask_sessions.sync_config, "sync_dir", lambda: cloud)
    for choice, store in (("auto", "drive"), ("drive", "drive"), ("local", "local"), ("off", "off")):
        monkeypatch.setenv("ASK_SESSIONS_STORE", choice)
        cfg = ask_sessions.resolve()
        assert cfg["store"] == store, choice
    monkeypatch.setenv("ASK_SESSIONS_STORE", "auto")
    assert ask_sessions.resolve()["dir"] == str(cloud / "ask-sessions")

    # No cloud folder on this machine: auto is local, and asking for drive says why it is not.
    monkeypatch.setattr(ask_sessions.sync_config, "sync_dir", lambda: None)
    assert ask_sessions.resolve()["store"] == "local"
    monkeypatch.setenv("ASK_SESSIONS_STORE", "drive")
    cfg = ask_sessions.resolve()
    assert cfg["store"] == "local" and "Google Drive" in cfg["reason"]
    assert cfg["dir"] == str(ask_sessions.local_dir())


def test_never_inside_the_repository(monkeypatch):
    inside = ask_sessions.REPO_ROOT / "memory" / "ask-sessions"
    monkeypatch.setenv("ASK_SESSIONS_DIR", str(inside))
    cfg = ask_sessions.resolve()
    assert cfg["dir"] is None and "repository" in cfg["reason"]
    with pytest.raises(HTTPException) as refused:
        ask_sessions.save(SID, _conversation())
    assert refused.value.status_code == 409
    assert not ask_sessions._inside_repo(ask_sessions.local_dir())


def test_the_setting_is_written_to_env_and_a_repo_folder_is_refused(tmp_path, monkeypatch):
    from routers import news_ai

    env = tmp_path / ".env"
    env.write_text("FRED_API_KEY=keep-me\n", encoding="utf-8")
    monkeypatch.setattr(news_ai, "_ENV_FILE", env)
    monkeypatch.setattr(ask_sessions, "_ENV_FILE", env)
    monkeypatch.setattr(ask_sessions.sync_config, "sync_dir", lambda: None)
    for name in ("ASK_SESSIONS_DIR", "ASK_SESSIONS_STORE"):
        monkeypatch.setenv(name, "x")       # registered, so teardown restores it
        monkeypatch.delenv(name)

    assert ask_sessions.configure("off", None)["store"] == "off"
    assert "ASK_SESSIONS_STORE=off" in env.read_text(encoding="utf-8") and "FRED_API_KEY=keep-me" in env.read_text(encoding="utf-8")

    chosen = tmp_path / "my sessions"
    cfg = ask_sessions.configure(None, str(chosen))
    assert cfg["store"] == "custom" and cfg["dir"] == str(chosen) and chosen.is_dir()

    assert ask_sessions.configure("local", None)["store"] == "local"       # a store clears the explicit folder
    for bad_dir in (str(ask_sessions.REPO_ROOT / "logs" / "ask"), "relative/folder"):
        with pytest.raises(HTTPException):
            ask_sessions.configure(None, bad_dir)
    with pytest.raises(HTTPException):
        ask_sessions.configure("everywhere", None)


def test_the_routes(store):
    app = FastAPI()
    app.include_router(ask_sessions.router)
    client = TestClient(app)

    assert client.get("/api/news/ask/sessions").json()["sessions"] == []
    put = client.put(f"/api/news/ask/sessions/{SID}", json={"messages": _conversation(), "page": "news"})
    assert put.status_code == 200 and put.json()["questions"] == 2
    listed = client.get("/api/news/ask/sessions").json()
    assert listed["store"] == "custom" and [s["id"] for s in listed["sessions"]] == [SID]
    assert client.get(f"/api/news/ask/sessions/{SID}").json()["messages"][0]["images"] == [PIC]
    assert client.get("/api/news/ask/sessions/config").json()["dir"] == str(store)
    assert client.get("/api/news/ask/sessions/nope").status_code == 422
    assert client.delete(f"/api/news/ask/sessions/{SID}").status_code == 200
    assert client.get(f"/api/news/ask/sessions/{SID}").status_code == 404

def test_saving_the_same_conversation_again_does_not_touch_the_file(store, monkeypatch):
    first = ask_sessions.save(SID, _conversation())
    path = store / "2026-10" / f"{SID}.json"
    before = path.read_bytes()
    monkeypatch.setattr(ask_sessions.sync_config, "device_id", lambda: "other-machine")
    monkeypatch.setattr(ask_sessions, "_now", lambda: "2030-01-01T00:00:00+07:00")
    again = ask_sessions.save(SID, _conversation())
    assert again == first and path.read_bytes() == before


def test_the_env_file_outranks_what_the_process_started_with(tmp_path, monkeypatch):
    """A change made by the setup script must reach a backend that is already running."""
    env = tmp_path / "live.env"
    monkeypatch.setattr(ask_sessions, "_ENV_FILE", env)
    monkeypatch.setattr(ask_sessions.sync_config, "sync_dir", lambda: None)
    monkeypatch.setenv("ASK_SESSIONS_STORE", "off")          # what the process loaded at start
    monkeypatch.setenv("ASK_SESSIONS_DIR", "")
    env.write_text("", encoding="utf-8")
    assert ask_sessions.resolve()["store"] == "off"          # nothing in the file: the environment
    env.write_text("ASK_SESSIONS_STORE=local\n", encoding="utf-8")
    assert ask_sessions.resolve()["store"] == "local"        # the file was edited: it wins
    env.write_text("ASK_SESSIONS_STORE=\n", encoding="utf-8")
    assert ask_sessions.resolve()["choice"] == "auto"        # cleared in the file is cleared


# ── Read by ASK (search_sessions / read_session) ─────────────────────────────

OTHER = "20261001-090000-0000aa"


def _qa(question, answer, at=1_791_278_000_000):
    return [{"role": "user", "content": question, "at": at}, {"role": "assistant", "content": answer}]


def test_search_finds_every_word_newest_first_and_marks_the_current_one(store):
    ask_sessions.save(OTHER, _qa("NVDA margins?", "Gross margin 75.0% (10-Q, 2026-08-27)"))
    ask_sessions.save(SID, _qa("NVDA now", "nothing on margins here, see https://evil.example/x"))
    found = ask_sessions.search("nvda margin", 30, current=SID)
    assert [s["id"] for s in found["sessions"]][0] in (SID, OTHER) and len(found["sessions"]) == 2
    mine = next(s for s in found["sessions"] if s["id"] == SID)
    assert mine["current"] is True
    other = next(s for s in found["sessions"] if s["id"] == OTHER)
    assert other["matches"][0]["asked"] and "NVDA" in other["matches"][0]["text"]
    assert ask_sessions.search("tesla", 30)["sessions"] == []
    latest = ask_sessions.search("", 30)["sessions"]
    assert {s["id"] for s in latest} == {SID, OTHER} and "matches" not in latest[0]


def test_search_keeps_to_the_days_asked_for(store):
    ask_sessions.save(OTHER, _qa("old one", "a"))
    path = store / "2026-10" / f"{OTHER}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["updated_at"] = "2020-01-01T00:00:00+07:00"
    path.write_text(json.dumps(data), encoding="utf-8")
    assert ask_sessions.search("", 30)["sessions"] == []
    assert ask_sessions.search("", 365 * 10)["sessions"][0]["id"] == OTHER


def test_a_transcript_has_when_each_question_was_asked_and_says_where_to_continue(store):
    messages = []
    for n in range(1, 7):
        messages += _qa(f"question {n}", "x" * 3_000, at=1_791_278_000_000 + n * 60_000)
    messages.append({"role": "user", "content": "never answered"})
    ask_sessions.save(SID, messages)

    first = ask_sessions.transcript(SID, 1, 8_000)
    assert first["exchanges"] == 7 and first["items"][0]["n"] == 1
    assert first["items"][0]["asked"].startswith("2026-")
    assert "images" not in json.dumps(first) and first["continue_from"] == len(first["items"]) + 1
    rest = ask_sessions.transcript(SID, first["continue_from"], 100_000)
    assert rest["items"][-1] == {"n": 7, "asked": None, "question": "never answered", "answer": None}
    assert rest["continue_from"] is None
    with pytest.raises(HTTPException):
        ask_sessions.transcript("20261001-000000-ffffff", 1, 8_000)
    with pytest.raises(HTTPException):
        ask_sessions.transcript("../../etc", 1, 8_000)


def test_a_long_answer_is_cut_in_a_transcript(store):
    ask_sessions.save(SID, _qa("q", "y" * 9_000))
    answer = ask_sessions.transcript(SID, 1, 30_000)["items"][0]["answer"]
    assert len(answer) < 4_100 and answer.endswith("[answer cut here]")


def test_stamp_reads_the_browser_clock_and_ignores_rubbish():
    assert ask_sessions.stamp(1_791_278_000_000)[:4] == "2026"
    assert ask_sessions.stamp(None) is None and ask_sessions.stamp("x") is None


def test_a_pin_survives_the_next_save_and_keeps_an_old_conversation_listed(store, monkeypatch):
    ask_sessions.save(OTHER, _qa("old but pinned", "a"))
    before = ask_sessions.load(OTHER)["updated_at"]
    assert ask_sessions.pin(OTHER, True)["pinned"] is True
    assert ask_sessions.load(OTHER)["updated_at"] == before          # a pin is not an addition
    ask_sessions.save(OTHER, _qa("old but pinned", "a") + _qa("more", "b"))
    assert ask_sessions.load(OTHER)["pinned"] is True

    ask_sessions.save(SID, _qa("newer", "b"))
    assert [s["id"] for s in ask_sessions.list_sessions(limit=1)] == [SID, OTHER]
    assert ask_sessions.pin(OTHER, False)["pinned"] is False
    assert [s["id"] for s in ask_sessions.list_sessions(limit=1)] == [SID]

    app = FastAPI()
    app.include_router(ask_sessions.router)
    r = TestClient(app).patch(f"/api/news/ask/sessions/{SID}", json={"pinned": True})
    assert r.status_code == 200 and r.json()["pinned"] is True


def test_delete_goes_to_the_trash_and_comes_back_with_its_pictures(store):
    ask_sessions.save(SID, _conversation())
    ask_sessions.remove(SID)
    assert ask_sessions.list_sessions() == []
    trash = ask_sessions.list_trash()
    assert [t["id"] for t in trash] == [SID] and trash[0]["deleted_at"]

    back = ask_sessions.restore(SID)
    assert back["id"] == SID and ask_sessions.list_trash() == []
    assert ask_sessions.load(SID)["messages"][0]["images"] == [PIC]
    ask_sessions.save(SID, _conversation())        # a restored conversation saves as before


def test_only_the_trash_can_be_erased(store):
    ask_sessions.save(SID, _conversation())
    with pytest.raises(HTTPException) as no:
        ask_sessions.purge(SID)                     # still in the list: refused
    assert no.value.status_code == 404 and ask_sessions.load(SID)
    ask_sessions.remove(SID)
    assert ask_sessions.purge(SID)["files"] == 2    # the JSON and its picture
    assert ask_sessions.list_trash() == [] and not list((store / ask_sessions.TRASH).iterdir())
    with pytest.raises(HTTPException):
        ask_sessions.restore(SID)
    with pytest.raises(HTTPException):
        ask_sessions.purge("../2026-10/x")


def test_restore_never_overwrites_a_conversation_in_the_list(store):
    ask_sessions.save(SID, _conversation())
    ask_sessions.remove(SID)
    ask_sessions.save(SID, _qa("same id, new", "a"))
    with pytest.raises(HTTPException) as clash:
        ask_sessions.restore(SID)
    assert clash.value.status_code == 409


def test_the_trash_routes(store):
    app = FastAPI()
    app.include_router(ask_sessions.router)
    http = TestClient(app)
    ask_sessions.save(SID, _conversation())
    assert http.delete(f"/api/news/ask/sessions/{SID}").status_code == 200
    assert [s["id"] for s in http.get("/api/news/ask/sessions/trash").json()["sessions"]] == [SID]
    assert http.post(f"/api/news/ask/sessions/trash/{SID}/restore").status_code == 200
    http.delete(f"/api/news/ask/sessions/{SID}")
    assert http.delete(f"/api/news/ask/sessions/trash/{SID}").json()["files"] == 2
