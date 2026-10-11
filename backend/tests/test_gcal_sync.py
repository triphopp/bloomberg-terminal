"""Google Calendar push (gcal_sync.py) against a fake Google.

What is held: the Google id is a pure function of the CAL id and valid for
Google; a second pass over the same events writes nothing; a changed event is
updated, a vanished one deleted, one deleted in Google put back; only events of
ours are ever deleted; the categories and the macro impact the user chose are
the ones that go up (PORT off by default); a second machine uses the calendar
the first one made; the sign-in refuses a state it did not start; a revoked
grant says so; the token never leaves the token file; and the token folder can
never be inside the repository.
"""
import json
import re
import time
import urllib.parse
from datetime import date

import pytest

import gcal_sync as gc

TODAY = date(2026, 10, 11)


class Reply:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body
        self.content = b"" if body is None else json.dumps(body).encode()
        self.ok = status < 400

    def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


class FakeGoogle:
    """Calendars and events in dicts; enough of the v3 API and the token endpoint."""

    def __init__(self):
        self.calendars: dict[str, dict] = {}
        self.events: dict[str, dict[str, dict]] = {}
        self.calls: list[tuple[str, str]] = []
        self.refresh_error = None
        self.next_cal = 1

    def post(self, url, data=None, params=None, timeout=None):
        self.calls.append(("POST", url))
        if url == gc.TOKEN_URL:
            if data.get("grant_type") == "refresh_token" and self.refresh_error:
                return Reply(400, {"error": self.refresh_error})
            body = {"access_token": "at-" + str(len(self.calls)), "expires_in": 3600}
            if data.get("grant_type") == "authorization_code":
                body["refresh_token"] = "rt-secret"
                body["scope"] = gc.DEFAULT_SCOPE
            return Reply(200, body)
        return Reply(200, {})

    def request(self, method, url, params=None, json=None, timeout=None, headers=None):
        assert headers["Authorization"].startswith("Bearer at-")
        path = urllib.parse.unquote(url[len(gc.API):])
        self.calls.append((method, path))
        if method == "POST" and path == "/calendars":
            cid = f"cal{self.next_cal}@group.calendar.google.com"
            self.next_cal += 1
            self.calendars[cid] = dict(json)
            self.events[cid] = {}
            return Reply(200, {"id": cid, **json})
        m = re.fullmatch(r"/calendars/([^/]+)(?:/events(?:/([^/]+))?)?", path)
        cid, rest = m.group(1), path[len("/calendars/") + len(m.group(1)):]
        if cid not in self.calendars:
            return Reply(404, {"error": {"message": "Not Found"}})
        evs = self.events[cid]
        gid = m.group(2)
        if rest == "" and method == "GET":
            return Reply(200, self.calendars[cid])
        if rest == "" and method == "DELETE":
            del self.calendars[cid]
            return Reply(204)
        if rest == "/events" and method == "GET":
            items = [e for e in evs.values() if params.get("showDeleted") == "true" or e["status"] != "cancelled"]
            return Reply(200, {"items": items})
        if rest == "/events" and method == "POST":
            if json["id"] in evs:
                return Reply(409, {"error": {"message": "duplicate"}})
            evs[json["id"]] = dict(json)
            return Reply(200, evs[json["id"]])
        if method == "PUT":
            if gid not in evs:
                return Reply(404, {"error": {"message": "Not Found"}})
            evs[gid] = {**json, "id": gid}
            return Reply(200, evs[gid])
        if method == "DELETE":
            if gid not in evs:
                return Reply(404, {"error": {"message": "Not Found"}})
            evs[gid]["status"] = "cancelled"
            return Reply(204)
        raise AssertionError(f"unexpected {method} {path}")

    def live(self, cid):
        return {k: v for k, v in self.events[cid].items() if v["status"] != "cancelled"}


def ev(eid, day="2026-10-20", category="THESIS", kind="NOTE", title="Check margin", **kw):
    base = {"id": eid, "date": day, "category": category, "kind": kind, "title": title,
            "symbol": kw.pop("symbol", "MU"), "impact": None, "estimated": False, "source": "",
            "source_url": "", "detail": "", "done": False, "due": False, "theses": [], "ref": None,
            "tag": None}
    base.update(kw)
    return base


@pytest.fixture()
def google(tmp_path, monkeypatch):
    monkeypatch.setenv("GOOGLE_CALENDAR_CLIENT_ID", "cid.apps.googleusercontent.com")
    monkeypatch.setenv("GOOGLE_CALENDAR_CLIENT_SECRET", "csecret")
    monkeypatch.setenv("GCAL_TOKEN_DIR", str(tmp_path / "mac"))
    monkeypatch.setenv("SYNC_DIR", str(tmp_path / "drive"))
    (tmp_path / "drive").mkdir()
    fake = FakeGoogle()
    monkeypatch.setattr(gc, "_session", fake)
    gc._pending.clear()
    return fake


def connect():
    url = gc.start_auth("http://localhost:9317/api/gcal/callback")
    state = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["state"][0]
    return gc.finish_auth(state, "the-code")


# ── pure parts ───────────────────────────────────────────────────────────────

def test_event_id_is_stable_and_valid_for_google():
    a, b = gc.event_id("note:42"), gc.event_id("note:42")
    assert a == b and a != gc.event_id("note:43")
    assert re.fullmatch(r"[a-v0-9]{5,1024}", a)


def test_body_is_an_all_day_free_event_with_the_hash():
    body = gc.event_body(ev("co:EARN:MU:2026-10-20", category="COMPANY", kind="EARN",
                            title="Earnings", estimated=True))
    assert body["start"] == {"date": "2026-10-20"} and body["end"] == {"date": "2026-10-21"}
    assert body["summary"] == "≈ MU · Earnings"
    assert body["transparency"] == "transparent"
    assert body["extendedProperties"]["private"]["bt"] == "1"
    assert gc.event_body(ev("x"))["extendedProperties"] == gc.event_body(ev("x"))["extendedProperties"]
    assert gc.event_body(ev("x"))["extendedProperties"] != gc.event_body(ev("x", title="Other"))["extendedProperties"]


def test_settings_choose_what_goes_up():
    d = gc.clean_settings(gc.DEFAULT_SETTINGS)
    assert "PORT" not in d["categories"]
    assert not gc.wanted(ev("opt", category="PORT", kind="EXPIRY"), d)
    macro = lambda imp: ev("m" + str(imp), category="MACRO", kind="CPI", impact=imp)  # noqa: E731
    assert gc.wanted(macro("high"), d) and gc.wanted(macro("medium"), d) and not gc.wanted(macro("low"), d)
    high = gc.clean_settings({"categories": ["MACRO"], "macro_impact": "high"})
    assert not gc.wanted(macro("medium"), high)
    assert gc.clean_settings({"categories": ["NOPE", "PORT"], "macro_impact": "x"}) == {
        "categories": ["PORT"], "macro_impact": "medium"}


def test_plan_deletes_only_our_own_events():
    s = gc.clean_settings(gc.DEFAULT_SETTINGS)
    theirs = {"id": "someoneelse", "status": "confirmed", "extendedProperties": {}}
    stale = {"id": gc.event_id("gone"), "status": "confirmed",
             "extendedProperties": {"private": {"bt": "1", "bt_h": "x"}}}
    p = gc.plan([], [theirs, stale], s)
    assert p["delete"] == [gc.event_id("gone")]


def test_token_dir_inside_repo_is_refused(monkeypatch):
    monkeypatch.setenv("GCAL_TOKEN_DIR", str(gc.ask_sessions.REPO_ROOT / "backend" / "x"))
    with pytest.raises(gc.GcalError):
        gc.token_dir()
    assert gc.load_token() is None


# ── against the fake Google ──────────────────────────────────────────────────

def test_connect_makes_one_calendar_and_shares_its_id(google, tmp_path):
    out = connect()
    cid = out["calendar_id"]
    assert list(google.calendars) == [cid]
    assert json.loads((tmp_path / "drive" / "google-calendar" / "calendar.json").read_text())["calendar_id"] == cid
    tok = (tmp_path / "mac" / "token.json").read_text()
    assert "rt-secret" in tok
    st = gc.status()
    assert st["connected"] and st["calendar_id"] == cid
    assert "rt-secret" not in json.dumps(st) and "at-" not in json.dumps(st)


def test_second_machine_uses_the_same_calendar(google, tmp_path, monkeypatch):
    first = connect()["calendar_id"]
    monkeypatch.setenv("GCAL_TOKEN_DIR", str(tmp_path / "pc"))
    second = connect()["calendar_id"]
    assert second == first and len(google.calendars) == 1


def test_state_not_started_here_is_refused(google):
    with pytest.raises(gc.GcalError) as e:
        gc.finish_auth("forged", "code")
    assert e.value.code == "state"


def test_sync_creates_then_nothing_then_updates_deletes_revives(google):
    cid = connect()["calendar_id"]
    events = [ev("note:1"), ev("note:2", title="Second"),
              ev("opt:MU:2026-10-17", category="PORT", kind="EXPIRY")]
    feed = lambda s, e: events  # noqa: E731

    r = gc.sync(feed, TODAY)
    assert (r["created"], r["updated"], r["deleted"]) == (2, 0, 0)       # PORT stays off Google
    assert set(google.live(cid)) == {gc.event_id("note:1"), gc.event_id("note:2")}

    writes = len([c for c in google.calls if c[0] in ("POST", "PUT", "DELETE")])
    r = gc.sync(feed, TODAY)
    assert (r["created"], r["updated"], r["deleted"], r["unchanged"]) == (0, 0, 0, 2)
    assert len([c for c in google.calls if c[0] in ("POST", "PUT", "DELETE")]) == writes

    events[0] = ev("note:1", title="Check margin — moved")
    del events[1]
    r = gc.sync(feed, TODAY)
    assert (r["created"], r["updated"], r["deleted"]) == (0, 1, 1)
    assert google.live(cid)[gc.event_id("note:1")]["summary"] == "MU · Check margin — moved"

    google.events[cid][gc.event_id("note:1")]["status"] = "cancelled"   # deleted by hand in Google
    r = gc.sync(feed, TODAY)
    assert r["updated"] == 1 and gc.event_id("note:1") in google.live(cid)


def test_unticking_a_category_removes_it(google):
    cid = connect()["calendar_id"]
    events = [ev("note:1"), ev("co:EARN:MU:2026-10-20", category="COMPANY", kind="EARN", title="Earnings")]
    gc.sync(lambda s, e: events, TODAY)
    assert len(google.live(cid)) == 2
    gc.save_settings({"categories": ["THESIS"], "macro_impact": "medium"})
    r = gc.sync(lambda s, e: events, TODAY)
    assert r["deleted"] == 1 and list(google.live(cid)) == [gc.event_id("note:1")]


def test_calendar_deleted_in_google_is_made_again(google):
    cid = connect()["calendar_id"]
    del google.calendars[cid]
    new = gc.ensure_calendar()
    assert new != cid and new in google.calendars


def test_revoked_grant_says_connect_again(google):
    connect()
    tok = gc.load_token()
    tok["expires_at"] = time.time() - 10
    gc._write("token.json", tok, private=True)
    google.refresh_error = "invalid_grant"
    with pytest.raises(gc.GcalError) as e:
        gc.sync(lambda s, e: [], TODAY)
    assert e.value.code == "revoked"
    assert gc.status()["revoked"] and not gc.status()["connected"]
    assert gc.run_if_connected() is None            # the scheduler stays quiet until a new CONNECT


def test_not_connected_is_quiet_for_the_scheduler(google):
    assert gc.run_if_connected() is None
    with pytest.raises(gc.GcalError):
        gc.sync(lambda s, e: [], TODAY)


def test_disconnect_forgets_the_token(google):
    cid = connect()["calendar_id"]
    out = gc.disconnect(delete_calendar=True)
    assert out == {"connected": False, "calendar_deleted": True}
    assert gc.load_token() is None and cid not in google.calendars


# ── the routes ───────────────────────────────────────────────────────────────

def _client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from routers import gcal as routes
    app = FastAPI()
    app.include_router(routes.router)
    return TestClient(app)


def test_callback_page_after_sign_in(google, monkeypatch):
    monkeypatch.setattr(gc, "run_if_connected", lambda: None)     # no first pass on a thread here
    c = _client()
    url = c.post("/api/gcal/connect").json()["auth_url"]
    state = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["state"][0]
    r = c.get(f"/api/gcal/callback?state={state}&code=the-code")
    assert r.status_code == 200 and "gcal:ok" in r.text and "rt-secret" not in r.text
    assert gc.status()["connected"]


def test_callback_page_when_refused(google):
    c = _client()
    r = c.get("/api/gcal/callback?error=access_denied")
    assert r.status_code == 400 and "gcal:error" in r.text and "access_denied" in r.text
    r = c.get("/api/gcal/callback?state=forged&code=x")
    assert r.status_code == 400


def test_status_route_never_has_the_token(google):
    connect()
    body = _client().get("/api/gcal/status").text
    assert "rt-secret" not in body and "at-" not in body
