"""
Stale-backend detection: a router edited after the server started is reported
by name, so a missing route reads as "restart me" and not as a coding bug.
"""
import os
import time

import pytest

import dev_status


@pytest.fixture()
def tree(tmp_path, monkeypatch):
    (tmp_path / "routers").mkdir()
    (tmp_path / "tests").mkdir()
    (tmp_path / "main.py").write_text("x = 1\n")
    (tmp_path / "routers" / "cash.py").write_text("y = 1\n")
    (tmp_path / "tests" / "test_x.py").write_text("")
    monkeypatch.setattr(dev_status, "ROOT", tmp_path)
    monkeypatch.setattr(dev_status, "_SNAPSHOT", dev_status._scan())
    monkeypatch.delenv("BT_BACKEND_RELOAD", raising=False)
    monkeypatch.delenv("BT_SUPERVISOR", raising=False)
    monkeypatch.setattr(dev_status.sys, "argv", ["uvicorn", "main:app"])
    return tmp_path


def _age(path, seconds):
    t = time.time() - seconds
    os.utime(path, (t, t))


def test_fresh_server_is_not_stale(tree):
    s = dev_status.status()
    assert s["stale"] is False and s["changed"] == []


def test_edited_router_is_named(tree):
    p = tree / "routers" / "cash.py"
    p.write_text("y = 2\n")
    _age(p, -1)  # mtime strictly after the snapshot
    (tree / "routers" / "new.py").write_text("")
    s = dev_status.status()
    assert s["stale"] is True
    assert {(c["file"], c["change"]) for c in s["changed"]} == {
        ("routers/cash.py", "modified"), ("routers/new.py", "added")}


def test_tests_and_scripts_do_not_count(tree):
    p = tree / "tests" / "test_x.py"
    p.write_text("assert 1\n")
    _age(p, -1)
    assert dev_status.status()["stale"] is False


def test_reload_mode_waits_for_the_reloader(tree, monkeypatch):
    monkeypatch.setenv("BT_BACKEND_RELOAD", "1")
    p = tree / "routers" / "cash.py"
    p.write_text("y = 3\n")
    _age(p, -1)  # just saved: the reloader is about to pick it up
    assert dev_status.status()["stale"] is False
    _age(p, 30)  # saved half a minute ago and still not reloaded → really stale
    monkeypatch.setattr(dev_status, "_SNAPSHOT", {k: 0.0 for k in dev_status._SNAPSHOT})
    assert dev_status.status()["stale"] is True


def test_restart_modes(tree, monkeypatch):
    assert dev_status.request_restart() is None  # started by hand: cannot
    monkeypatch.setenv("BT_BACKEND_RELOAD", "1")
    before = os.stat(tree / "main.py").st_mtime
    _age(tree / "main.py", 60)
    assert dev_status.request_restart() == "reload"
    assert os.stat(tree / "main.py").st_mtime > before - 1  # touched → reloader fires
