"""Google Calendar push (gcal_sync.py) against a fake Google.

What is held: the Google id is a pure function of the CAL id and valid for
Google; a second pass over the same events sends no request, SYNC NOW one small
list; writes go 50 to a batch, throttled ones again, a 409 becomes an update;
a past event stays in Google; a changed event is
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
    def __init__(self, status=200, body=None, raw=None, content_type="application/json"):
        self.status_code = status
        self._body = body
        self.content = raw if raw is not None else (b"" if body is None else json.dumps(body).encode())
        self.headers = {"Content-Type": content_type}
        self.ok = status < 400

    def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


class FakeGoogle:
    """Calendars and events in dicts; enough of the v3 API — sync tokens and batch
    included — and of the token endpoint."""

    def __init__(self):
        self.calendars: dict[str, dict] = {}
        self.events: dict[str, dict[str, dict]] = {}
        self.calls: list[tuple[str, str]] = []      # every HTTP request (a batch is one)
        self.inner: list[tuple[str, str]] = []      # every API call, batched or not
        self.refresh_error = None
        self.throttle = 0                           # the next N calls answer 403 rateLimitExceeded
        self.next_cal = 1
        self.seq = 0

    # token endpoint
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

    def request(self, method, url, params=None, json=None, data=None, timeout=None, headers=None):
        assert headers["Authorization"].startswith("Bearer at-")
        if url == gc.BATCH_URL:
            self.calls.append(("BATCH", url))
            return self._batch(headers["Content-Type"], data)
        path = urllib.parse.unquote(url[len(gc.API):])
        self.calls.append((method, path))
        status, body = self._one(method, path, params or {}, json)
        return Reply(status, body)

    def _batch(self, content_type, data):
        boundary = re.search(r"boundary=(\S+)", content_type).group(1)
        parts = [p for p in data.decode().split("--" + boundary) if "Content-ID" in p]
        assert 0 < len(parts) <= gc.BATCH_MAX
        out = []
        for p in parts:
            i = re.search(r"<item(\d+)>", p).group(1)
            line = re.search(r"(GET|POST|PUT|DELETE) /calendar/v3(\S+) HTTP/1.1", p)
            js = p.split("charset=UTF-8\r\n\r\n", 1)
            body = __import__("json").loads(js[1]) if len(js) == 2 else None
            status, resp = self._one(line.group(1), urllib.parse.unquote(line.group(2)), {}, body)
            out.append(f"--resp\r\nContent-Type: application/http\r\nContent-ID: <response-item{i}>\r\n\r\n"
                       f"HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n\r\n"
                       f"{__import__('json').dumps(resp) if resp is not None else ''}\r\n")
        out.append("--resp--")
        return Reply(200, raw="".join(out).encode(), content_type="multipart/mixed; boundary=resp")

    def _stamp(self, e):
        self.seq += 1
        e["_v"] = self.seq
        return e

    def _one(self, method, path, params, json):
        self.inner.append((method, path))
        if self.throttle and method != "GET":
            self.throttle -= 1
            return 403, {"error": {"errors": [{"reason": "rateLimitExceeded"}], "message": "Rate Limit"}}
        if method == "POST" and path == "/calendars":
            cid = f"cal{self.next_cal}@group.calendar.google.com"
            self.next_cal += 1
            self.calendars[cid] = dict(json)
            self.events[cid] = {}
            return 200, {"id": cid, **json}
        m = re.fullmatch(r"/calendars/([^/]+)(?:/events(?:/([^/]+))?)?", path)
        cid, rest = m.group(1), path[len("/calendars/") + len(m.group(1)):]
        if cid not in self.calendars:
            return 404, {"error": {"message": "Not Found"}}
        evs = self.events[cid]
        gid = m.group(2)
        if rest == "" and method == "GET":
            return 200, self.calendars[cid]
        if rest == "" and method == "DELETE":
            del self.calendars[cid]
            return 204, None
        if rest == "/events" and method == "GET":
            since = int(params.get("syncToken") or 0)
            items = [{k: v for k, v in e.items() if k != "_v"} for e in evs.values() if e["_v"] > since]
            return 200, {"items": items, "nextSyncToken": str(self.seq)}
        if rest == "/events" and method == "POST":
            if json["id"] in evs:
                return 409, {"error": {"message": "duplicate"}}
            evs[json["id"]] = self._stamp(dict(json))
            return 200, evs[json["id"]]
        if method == "PUT":
            if gid not in evs:
                return 404, {"error": {"message": "Not Found"}}
            evs[gid] = self._stamp({**json, "id": gid})
            return 200, evs[gid]
        if method == "DELETE":
            if gid not in evs or evs[gid]["status"] == "cancelled":
                return 410 if gid in evs else 404, {"error": {"message": "gone"}}
            evs[gid]["status"] = "cancelled"
            self._stamp(evs[gid])
            return 204, None
        raise AssertionError(f"unexpected {method} {path}")

    def edit_by_hand(self, cid, gid, **changes):
        self.events[cid][gid].update(changes)
        self._stamp(self.events[cid][gid])

    def live(self, cid):
        return {k: v for k, v in self.events[cid].items() if v["status"] != "cancelled"}

    def writes(self):
        return [c for c in self.inner if c[0] != "GET"]


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

    # Nothing changed here: the pass sends no request at all.
    sent = len(google.calls)
    r = gc.sync(feed, TODAY)
    assert r["skipped"] and r["requests"] == 0 and r["unchanged"] == 2
    assert len(google.calls) == sent

    # SYNC NOW asks Google anyway — one small list, no write.
    r = gc.sync(feed, TODAY, force=True)
    assert (r["created"], r["updated"], r["deleted"], r["unchanged"]) == (0, 0, 0, 2)
    assert len(google.calls) == sent + 1

    events[0] = ev("note:1", title="Check margin — moved")
    del events[1]
    r = gc.sync(feed, TODAY)
    assert (r["created"], r["updated"], r["deleted"]) == (0, 1, 1)
    assert r["requests"] == 2                                            # list + one batch
    assert google.live(cid)[gc.event_id("note:1")]["summary"] == "MU · Check margin — moved"

    google.edit_by_hand(cid, gc.event_id("note:1"), status="cancelled")  # deleted by hand in Google
    assert gc.sync(feed, TODAY)["skipped"]                               # not looked at yet …
    r = gc.sync(feed, TODAY, force=True)                                 # … SYNC NOW puts it back
    assert r["updated"] == 1 and gc.event_id("note:1") in google.live(cid)


def test_google_is_looked_at_again_after_recheck(google, monkeypatch):
    cid = connect()["calendar_id"]
    events = [ev("note:1")]
    gc.sync(lambda s, e: events, TODAY)
    google.edit_by_hand(cid, gc.event_id("note:1"), summary="changed in Google")
    m = gc._read("mirror.json")
    m["checked_at"] -= gc.RECHECK_S + 1
    gc._write("mirror.json", m)
    r = gc.sync(lambda s, e: events, TODAY)
    assert not r["skipped"]
    assert google.live(cid)[gc.event_id("note:1")]["summary"] == "MU · Check margin"


def test_many_events_go_in_batches(google):
    cid = connect()["calendar_id"]
    events = [ev(f"note:{i}", title=f"n{i}") for i in range(121)]
    before = len(google.calls)
    r = gc.sync(lambda s, e: events, TODAY)
    assert r["created"] == 121 and r["failed"] == 0 and len(google.live(cid)) == 121
    batches = [c for c in google.calls[before:] if c[0] == "BATCH"]
    assert len(batches) == 3                                             # 50 + 50 + 21
    assert r["requests"] == 1 + 3                                        # the list + the batches


def test_throttled_calls_are_sent_again(google, monkeypatch):
    monkeypatch.setattr(gc.time, "sleep", lambda s: None)
    cid = connect()["calendar_id"]
    google.throttle = 3
    r = gc.sync(lambda s, e: [ev(f"note:{i}") for i in range(5)], TODAY)
    assert r["created"] == 5 and r["failed"] == 0 and len(google.live(cid)) == 5


def test_an_id_google_already_has_becomes_an_update(google):
    cid = connect()["calendar_id"]
    gid = gc.event_id("note:1")
    google.events[cid][gid] = google._stamp({**gc.event_body(ev("note:1", title="old")), "id": gid,
                                             "status": "cancelled"})
    gc._remove("mirror.json")
    m = {"calendar_id": cid, "events": {}, "sync_token": str(google.seq)}   # mirror blind to it
    gc._write("mirror.json", m)
    r = gc.sync(lambda s, e: [ev("note:1")], TODAY)
    assert r["updated"] == 1 and r["failed"] == 0
    assert google.live(cid)[gid]["summary"] == "MU · Check margin"


def test_a_past_event_stays_in_google(google):
    cid = connect()["calendar_id"]
    gc.sync(lambda s, e: [ev("note:old", day="2026-10-05")], TODAY)
    later = date(2026, 10, 25)                       # the event is now before the window
    r = gc.sync(lambda s, e: [], later)
    assert r["deleted"] == 0 and gc.event_id("note:old") in google.live(cid)


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
