"""Webull token shared through the Drive folder (webull_client.py, "Shared copy").

Two machines are two token folders over one cloud folder. What is held: one
confirmation serves both — the second machine takes the token and sends no
request; the copy in the cloud is sealed (no token, no secret in it) and a file
under another secret or changed by hand is ignored; a machine never overwrites
a newer token with its older one; a code that has lapsed is not taken; and
WEBULL_TOKEN_SHARE=off writes nothing.
"""
import importlib
import json
import time

import pytest

from test_webull import FAR, KEY, SECRET, HOST, TOKEN, Reply

NEW = "0123456789abcdef0123456789abcdef"     # the next token, made on the other machine
SOON = int((time.time() + 3600) * 1000)      # an hour from now, in ms


@pytest.fixture()
def two(tmp_path, monkeypatch):
    monkeypatch.setenv("WEBULL_APP_KEY", KEY)
    monkeypatch.setenv("WEBULL_APP_SECRET", SECRET)
    monkeypatch.setenv("WEBULL_API_HOST", HOST)
    monkeypatch.setenv("SYNC_DIR", str(tmp_path / "drive"))
    monkeypatch.delenv("WEBULL_TOKEN_SHARE", raising=False)
    (tmp_path / "drive").mkdir()
    import config
    importlib.reload(config)
    import webull_client
    importlib.reload(webull_client)

    sent, replies = [], []

    def request(method, url, params=None, data=None, headers=None, timeout=None):
        sent.append({"url": url, "data": data, "headers": headers})
        return replies.pop(0) if replies else Reply(500, None, "no reply queued")

    monkeypatch.setattr(webull_client._session, "request", request)

    def on(name):
        """Be this machine from now on: its own token folder, its own name."""
        monkeypatch.setenv("WEBULL_TOKEN_DIR", str(tmp_path / name))
        monkeypatch.setenv("SYNC_DEVICE_ID", name)
        webull_client._shared.update(at=0.0, mtime=None, error=None)

    on("MAC")
    yield type("Ctx", (), {"wb": webull_client, "sent": sent, "replies": replies, "on": staticmethod(on),
                           "drive": tmp_path / "drive" / "webull", "config": config})
    monkeypatch.undo()
    importlib.reload(config)


def _shared_text(ctx):
    files = list(ctx.drive.glob("token-*.enc"))
    assert len(files) == 1
    return files[0].read_text(encoding="utf-8")


def test_one_confirmation_serves_both_machines(two):
    two.replies.append(Reply(200, {"token": TOKEN, "expires_at": FAR, "status": "PENDING"}))
    assert two.wb.create_token()["status"] == "PENDING"
    two.replies.append(Reply(200, {"token": TOKEN, "expires_at": FAR, "status": "NORMAL"}))
    assert two.wb.check_token()["status"] == "NORMAL"          # the code entered in the app
    assert len(two.sent) == 2

    two.on("PC")                                                 # nothing on this machine yet
    assert two.wb.load_token() is None
    assert two.wb.active_token() == TOKEN
    assert len(two.sent) == 2                                    # taken, not requested: no SMS
    assert two.wb.public_token(two.wb.load_token())["from"] == "MAC"


def test_the_cloud_copy_is_sealed(two):
    two.replies.append(Reply(200, {"token": TOKEN, "expires_at": FAR, "status": "NORMAL"}))
    two.wb.create_token()
    text = _shared_text(two)
    assert TOKEN not in text and SECRET not in text and KEY not in text
    assert json.loads(text)["alg"] == "AES-256-GCM"
    assert two.wb.read_shared()["token"] == TOKEN


def test_a_request_on_the_second_machine_takes_the_waiting_token(two):
    # The Mac asked and the code is on its way; pressing REQUEST on the PC must not text another.
    two.replies.append(Reply(200, {"token": TOKEN, "expires_at": FAR, "status": "PENDING"}))
    two.wb.create_token()
    two.on("PC")
    record = two.wb.create_token()
    assert record["token"] == TOKEN and record["status"] == "PENDING"
    assert len(two.sent) == 1


def test_an_expired_token_gives_way_to_the_other_machines_new_one(two):
    two.on("PC")
    two.wb._save_token({"token": TOKEN, "expires_at": int((time.time() - 60) * 1000), "status": "NORMAL"})
    two.on("MAC")
    two.replies.append(Reply(200, {"token": NEW, "expires_at": FAR, "status": "NORMAL"}))
    two.wb.create_token()

    two.on("PC")
    assert two.wb.active_token() == NEW
    assert two.wb.load_token()["status"] == "NORMAL"
    assert len(two.sent) == 1


def test_a_refused_token_gives_way_too(two):
    two.on("PC")
    two.wb._save_token({"token": TOKEN, "expires_at": SOON, "status": "NORMAL"})
    two.on("MAC")
    two.wb._save_token({"token": NEW, "expires_at": FAR, "status": "NORMAL"})
    two.wb._publish(two.wb.load_token())

    two.on("PC")
    two.wb._shared["at"] = time.time()                           # not looked yet this turn
    two.wb._shared["mtime"] = (two.drive / next(two.drive.glob("*.enc")).name).stat().st_mtime
    assert two.wb.load_token()["token"] == TOKEN
    after = two.wb.mark_token("INVALID", "401", TOKEN)           # Webull said no to the old one
    assert after["token"] == NEW and after["status"] == "NORMAL"


def test_a_later_token_wins_even_before_the_old_one_ends(two):
    two.on("PC")
    two.wb._save_token({"token": TOKEN, "expires_at": SOON, "status": "NORMAL"})
    two.on("MAC")
    two.wb._save_token({"token": NEW, "expires_at": FAR, "status": "NORMAL"})
    two.wb._publish(two.wb.load_token())
    two.on("PC")
    assert two.wb.active_token() == NEW


def test_an_older_token_never_overwrites_a_newer_one(two):
    two.wb._save_token({"token": NEW, "expires_at": FAR, "status": "NORMAL"})
    two.wb._publish(two.wb.load_token())
    two.on("PC")
    # The PC's 6-hourly check confirms its old token still works — that must not undo the Mac's.
    two.wb._publish({"token": TOKEN, "expires_at": SOON, "status": "NORMAL"})
    assert two.wb.read_shared()["token"] == NEW


def test_a_marked_token_is_only_the_one_refused(two):
    two.wb._save_token({"token": NEW, "expires_at": FAR, "status": "NORMAL"})
    two.wb.mark_token("INVALID", "401 for the token before", TOKEN)
    assert two.wb.load_token()["status"] == "NORMAL"


def test_a_lapsed_code_is_not_taken(two):
    two.wb._save_token({"token": TOKEN, "expires_at": FAR, "status": "PENDING",
                        "issued_at": int(time.time()) - 6 * 60})
    two.wb._publish(two.wb.load_token())
    two.on("PC")
    assert two.wb._look_shared(force=True) is None


def test_another_secret_cannot_open_it(two, monkeypatch):
    two.replies.append(Reply(200, {"token": TOKEN, "expires_at": FAR, "status": "NORMAL"}))
    two.wb.create_token()
    two.on("PC")
    monkeypatch.setattr(two.config, "WEBULL_APP_SECRET", "x" * 32)
    assert two.wb._look_shared(force=True) is None
    assert "WEBULL_APP_SECRET" in two.wb.shared_status()["error"]


def test_a_changed_file_is_ignored(two):
    two.replies.append(Reply(200, {"token": TOKEN, "expires_at": FAR, "status": "NORMAL"}))
    two.wb.create_token()
    path = next(two.drive.glob("*.enc"))
    box = json.loads(path.read_text(encoding="utf-8"))
    box["data"] = box["data"][:-6] + ("AAAAAA" if not box["data"].endswith("AAAAAA") else "BBBBBB")
    path.write_text(json.dumps(box), encoding="utf-8")
    assert two.wb.read_shared() is None


def test_share_off_writes_nothing(two, monkeypatch):
    monkeypatch.setenv("WEBULL_TOKEN_SHARE", "off")
    two.replies.append(Reply(200, {"token": TOKEN, "expires_at": FAR, "status": "NORMAL"}))
    two.wb.create_token()
    assert not two.drive.exists()
    assert two.wb.shared_status()["on"] is False


def test_no_cloud_folder_is_the_old_behaviour(two, monkeypatch):
    monkeypatch.setenv("SYNC_DIR", "")
    monkeypatch.setenv("SYNC_AUTODETECT", "false")
    two.replies.append(Reply(200, {"token": TOKEN, "expires_at": FAR, "status": "NORMAL"}))
    assert two.wb.create_token()["status"] == "NORMAL"
    assert two.wb.active_token() == TOKEN and not two.drive.exists()
