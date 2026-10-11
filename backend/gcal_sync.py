"""Google Calendar — the CAL view's events, pushed one way into the user's Google account.

Nothing new is stored in the database. Every event `calendar_feed.build()` lists
goes into one secondary calendar, "Bloomberg Terminal", that this app creates
in the user's account; the phone's Google Calendar then reminds without the
terminal being open. Nothing comes back: an event edited or deleted in Google
is put back on the next pass, because the terminal's own rows (thesis notes,
question dates, …) are the record, and the user writes those.

  id       the Google event id is a hash of the CAL id (Google lets the client
           choose it: base32hex, 5–1024 chars), so a second push of the same
           event is an update of the same row — no mapping table
  content  a hash of the body rides in `extendedProperties.private.bt_h`;
           an unchanged event costs nothing on the next pass
  gone     an event of ours (`bt=1`) in the window that the feed no longer
           lists is deleted; one that was deleted and comes back is revived
           (Google keeps a cancelled event's id — insert would answer 409)

Access is OAuth for an installed app (PKCE, loopback redirect to this backend)
with the narrowest scope that can do it, `calendar.app.created`: this app sees
the calendars it made and nothing else of the account. The refresh token is a
credential, so it lives outside the repository in the per-user app-data folder
(`GCAL_TOKEN_DIR` to move it, refused inside the repo), mode 600, never logged.

Two machines: each connects once. The calendar id is not a credential, so the
first machine leaves it in `<SYNC_DIR>/google-calendar/calendar.json` and the
second uses that calendar instead of making another. Both pushing is harmless —
same ids, same bodies — but a machine whose database has not caught up yet
deletes what the other just added until sync brings it level.

What goes up is the user's choice per category (settings.json beside the
token). PORT — option expiries, HOLD reviews — is off until switched on: it is
the book, and it would sit in Google.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import secrets
import threading
import time
import urllib.parse
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

import requests

import ask_sessions

logger = logging.getLogger(__name__)

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
API = "https://www.googleapis.com/calendar/v3"
DEFAULT_SCOPE = "https://www.googleapis.com/auth/calendar.app.created"

CALENDAR_NAME = "Bloomberg Terminal"
CATEGORIES = ("MACRO", "COMPANY", "THESIS", "PORT")
IMPACTS = ("high", "medium", "all")
DEFAULT_SETTINGS = {"categories": ["MACRO", "COMPANY", "THESIS"], "macro_impact": "medium"}

BACK_DAYS = 7               # a missed day stays visible for a week
DEFAULT_AHEAD_DAYS = 120
PENDING_LIFE_S = 10 * 60    # an unfinished sign-in is forgotten after this
_TIMEOUT = 20

# Google event colours (colorId), nearest to CAT_COLOR in the CAL view:
# tangerine · peacock · basil · grape.
COLOR = {"MACRO": "6", "COMPANY": "7", "THESIS": "10", "PORT": "3"}

_session = requests.Session()
_token_lock = threading.RLock()     # read-modify-write of token.json
_sync_lock = threading.Lock()       # one pass at a time
_pending: dict[str, dict] = {}      # OAuth state → verifier + redirect


class GcalError(Exception):
    def __init__(self, status: int, message: str, code: str = "upstream"):
        super().__init__(message)
        self.status = status
        self.code = code


# ── Configuration ────────────────────────────────────────────────────────────

def client_id() -> str:
    return os.getenv("GOOGLE_CALENDAR_CLIENT_ID", "").strip()


def client_secret() -> str:
    return os.getenv("GOOGLE_CALENDAR_CLIENT_SECRET", "").strip()


def configured() -> bool:
    return bool(client_id() and client_secret())


def scope() -> str:
    return os.getenv("GCAL_SCOPE", "").strip() or DEFAULT_SCOPE


def ahead_days() -> int:
    try:
        return max(7, min(int(os.getenv("GCAL_SYNC_DAYS", "") or DEFAULT_AHEAD_DAYS), 390))
    except ValueError:
        return DEFAULT_AHEAD_DAYS


def token_dir() -> Path:
    custom = os.getenv("GCAL_TOKEN_DIR", "").strip()
    path = Path(custom).expanduser() if custom else ask_sessions.local_dir().parent / "google-calendar"
    try:
        path.resolve().relative_to(ask_sessions.REPO_ROOT)
    except (ValueError, OSError):
        return path
    raise GcalError(424, "GCAL_TOKEN_DIR is inside the repository — a Google refresh token "
                         "must not be one `git add .` from a commit", "config")


def _read(name: str) -> Optional[dict]:
    try:
        data = json.loads((token_dir() / name).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError, GcalError):
        return None


def _write(name: str, data: dict, private: bool = False) -> None:
    path = token_dir() / name
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    if private:
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
    tmp.replace(path)


def _remove(name: str) -> None:
    try:
        (token_dir() / name).unlink()
    except (OSError, GcalError):
        pass


def load_token() -> Optional[dict]:
    t = _read("token.json")
    return t if t and t.get("refresh_token") else None


def get_settings() -> dict:
    s = {**DEFAULT_SETTINGS, **(_read("settings.json") or {})}
    return clean_settings(s)


def clean_settings(s: dict) -> dict:
    cats = [c for c in CATEGORIES if c in (s.get("categories") or [])]
    impact = s.get("macro_impact") if s.get("macro_impact") in IMPACTS else DEFAULT_SETTINGS["macro_impact"]
    return {"categories": cats, "macro_impact": impact}


def save_settings(s: dict) -> dict:
    s = clean_settings(s)
    _write("settings.json", s)
    return s


# ── Shared calendar id (Drive) ───────────────────────────────────────────────

def _shared_file() -> Optional[Path]:
    try:
        from sync import config as sync_config
        root = sync_config.sync_dir()
    except Exception:  # noqa: BLE001 — no sync configured is a normal state
        root = None
    if not root or not Path(root).is_dir():
        return None
    folder = Path(root) / "google-calendar"
    try:
        folder.resolve().relative_to(ask_sessions.REPO_ROOT)
        return None                                 # a "cloud folder" inside the repo: never
    except (ValueError, OSError):
        return folder / "calendar.json"


def shared_calendar_id() -> Optional[str]:
    path = _shared_file()
    if path is None:
        return None
    try:
        cid = json.loads(path.read_text(encoding="utf-8")).get("calendar_id")
        return cid if isinstance(cid, str) and cid else None
    except (OSError, ValueError, AttributeError):
        return None


def _publish_calendar_id(cid: str) -> None:
    path = _shared_file()
    if path is None:
        return
    try:
        from sync import config as sync_config
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"calendar_id": cid, "by": sync_config.device_id(),
                                    "at": int(time.time())}), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001 — Drive being away must not stop the connect
        logger.warning("google calendar id not shared: %s", exc.__class__.__name__)


# ── OAuth ────────────────────────────────────────────────────────────────────

def start_auth(redirect_uri: str) -> str:
    """The Google sign-in URL. The browser comes back to `redirect_uri` (this backend)."""
    if not configured():
        raise GcalError(424, "GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET are not set "
                             "in backend/.env", "config")
    now = time.time()
    for k in [k for k, v in _pending.items() if now - v["at"] > PENDING_LIFE_S]:
        _pending.pop(k, None)
    state = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    _pending[state] = {"verifier": verifier, "redirect": redirect_uri, "at": now}
    return AUTH_URL + "?" + urllib.parse.urlencode({
        "client_id": client_id(), "redirect_uri": redirect_uri, "response_type": "code",
        "scope": scope(), "access_type": "offline", "prompt": "consent", "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256",
    })


def finish_auth(state: str, code: str) -> dict:
    """Trade the code for tokens, then find or make the calendar."""
    pend = _pending.pop(state or "", None)
    if not pend or time.time() - pend["at"] > PENDING_LIFE_S:
        raise GcalError(400, "this sign-in link is old or was not started here — press CONNECT again",
                        "state")
    r = _session.post(TOKEN_URL, data={
        "code": code, "client_id": client_id(), "client_secret": client_secret(),
        "redirect_uri": pend["redirect"], "grant_type": "authorization_code",
        "code_verifier": pend["verifier"],
    }, timeout=_TIMEOUT)
    data = _json(r)
    if not r.ok or not data.get("refresh_token"):
        raise GcalError(424, f"Google refused the sign-in: {_why(r, data)}", "auth")
    with _token_lock:
        old = load_token() or {}
        token = {"refresh_token": data["refresh_token"], "access_token": data.get("access_token"),
                 "expires_at": time.time() + float(data.get("expires_in") or 0) - 60,
                 "scope": data.get("scope") or scope(), "calendar_id": old.get("calendar_id"),
                 "connected_at": int(time.time())}
        _write("token.json", token, private=True)
    cid = ensure_calendar()
    return {"connected": True, "calendar_id": cid}


def _access_token() -> str:
    with _token_lock:
        return _access_token_locked()


def _access_token_locked() -> str:
    token = load_token()
    if not token:
        raise GcalError(409, "Google Calendar is not connected", "not_connected")
    if token.get("access_token") and time.time() < float(token.get("expires_at") or 0):
        return token["access_token"]
    r = _session.post(TOKEN_URL, data={
        "client_id": client_id(), "client_secret": client_secret(),
        "refresh_token": token["refresh_token"], "grant_type": "refresh_token",
    }, timeout=_TIMEOUT)
    data = _json(r)
    if not r.ok or not data.get("access_token"):
        if data.get("error") == "invalid_grant":
            # Revoked, or a Testing-mode consent past its 7 days: a new CONNECT is the only way on.
            token["revoked_at"] = int(time.time())
            token.pop("access_token", None)
            _write("token.json", token, private=True)
            raise GcalError(401, "Google no longer accepts this connection — press CONNECT again "
                                 "(an OAuth app left in Testing expires it after 7 days)", "revoked")
        raise GcalError(424, f"Google token refresh failed: {_why(r, data)}")
    token.update(access_token=data["access_token"],
                 expires_at=time.time() + float(data.get("expires_in") or 3600) - 60)
    token.pop("revoked_at", None)
    _write("token.json", token, private=True)
    return token["access_token"]


def disconnect(delete_calendar: bool = False) -> dict:
    with _sync_lock, _token_lock:
        token = load_token()
        deleted = False
        if token:
            if delete_calendar and token.get("calendar_id"):
                try:
                    _api("DELETE", f"/calendars/{_q(token['calendar_id'])}")
                    deleted = True
                except GcalError as exc:
                    logger.warning("google calendar not deleted: %s", exc)
            try:
                _session.post(REVOKE_URL, params={"token": token["refresh_token"]}, timeout=_TIMEOUT)
            except requests.RequestException:
                pass                                # the local copy goes regardless
        _remove("token.json")
        _remove("state.json")
    return {"connected": False, "calendar_deleted": deleted}


# ── API ──────────────────────────────────────────────────────────────────────

def _q(s: str) -> str:
    return urllib.parse.quote(s, safe="")


def _json(r: requests.Response) -> dict:
    try:
        d = r.json()
        return d if isinstance(d, dict) else {}
    except ValueError:
        return {}


def _why(r: requests.Response, data: dict) -> str:
    err = data.get("error")
    if isinstance(err, dict):
        return f"{r.status_code} {err.get('message') or err.get('status') or ''}".strip()
    if err:
        return f"{r.status_code} {err} {data.get('error_description') or ''}".strip()
    return f"HTTP {r.status_code}"


def _api(method: str, path: str, params: Optional[dict] = None, body: Optional[dict] = None,
         ok_404: bool = False) -> Optional[dict]:
    r = _session.request(method, API + path, params=params, json=body, timeout=_TIMEOUT,
                         headers={"Authorization": f"Bearer {_access_token()}"})
    if r.status_code in (404, 410) and ok_404:      # 410 = deleted
        return None
    if r.status_code in (200, 201, 204):
        return _json(r) if r.content else {}
    raise GcalError(424 if r.status_code >= 500 or r.status_code == 429 else r.status_code,
                    f"Google Calendar {method} → {_why(r, _json(r))}")


def ensure_calendar() -> str:
    """This app's calendar: the one held here, else the one another machine made, else a new one."""
    token = load_token() or {}
    for cid in (token.get("calendar_id"), shared_calendar_id()):
        if cid and _api("GET", f"/calendars/{_q(cid)}", ok_404=True) is not None:
            break
    else:
        made = _api("POST", "/calendars", body={
            "summary": CALENDAR_NAME,
            "description": "Pushed by the Bloomberg Terminal CAL view (one way). Edits here are "
                           "overwritten — change the note or date in the terminal instead.",
            "timeZone": os.getenv("GCAL_TIMEZONE", "").strip() or "Asia/Bangkok",
        }) or {}
        cid = made.get("id")
        if not cid:
            raise GcalError(424, "Google did not return the new calendar's id")
        logger.info("google calendar created")
    with _token_lock:
        token = load_token() or token
        token["calendar_id"] = cid
        _write("token.json", token, private=True)
    _publish_calendar_id(cid)
    return cid


# ── What goes up ─────────────────────────────────────────────────────────────

def event_id(cal_id: str) -> str:
    """Google event id for a CAL id: hex digits are a subset of base32hex (a–v, 0–9)."""
    return "bt" + hashlib.sha1(cal_id.encode("utf-8")).hexdigest()


def wanted(e: dict, settings: dict) -> bool:
    if e["category"] not in settings["categories"]:
        return False
    if e["category"] == "MACRO":
        imp = settings["macro_impact"]
        if imp == "high" and e.get("impact") != "high":
            return False
        if imp == "medium" and e.get("impact") not in ("high", "medium"):
            return False
    return True


def event_body(e: dict) -> dict:
    """The Google event for a CAL event — an all-day event on its date."""
    title = e["title"]
    sym = e.get("symbol")
    summary = title if not sym or sym in title else f"{sym} · {title}"
    if e.get("estimated"):
        summary = "≈ " + summary
    if e.get("done"):
        summary = "✓ " + summary
    lines = [e["detail"]] if e.get("detail") else []
    meta = [e["category"], e["kind"]] + ([f"impact {e['impact']}"] if e.get("impact") else [])
    lines.append(" · ".join(meta))
    if e.get("estimated"):
        lines.append("≈ estimated date — not confirmed by the source yet")
    for t in e.get("theses") or []:
        lines.append(f"thesis: {t.get('symbol')} — {t.get('title')}")
    if e.get("source"):
        lines.append(f"source: {e['source']}")
    if e.get("source_url"):
        lines.append(e["source_url"])
    lines.append("— Bloomberg Terminal · CAL (key 6)")
    day = date.fromisoformat(e["date"][:10])
    body = {
        "summary": summary[:250],
        "description": "\n".join(lines)[:4000],
        "start": {"date": day.isoformat()},
        "end": {"date": (day + timedelta(days=1)).isoformat()},
        "colorId": COLOR.get(e["category"], "8"),
        "transparency": "transparent",          # a date to know, not a meeting: never "busy"
        "status": "confirmed",
    }
    h = hashlib.sha1(json.dumps(body, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]
    body["extendedProperties"] = {"private": {"bt": "1", "bt_h": h}}
    return body


def plan(events: list[dict], existing: list[dict], settings: dict) -> dict:
    """What to write: {"put": [(gid, body, revive)], "delete": [gid]}. Pure — the tests hold it."""
    want: dict[str, dict] = {}
    for e in events:
        if wanted(e, settings):
            want[event_id(e["id"])] = event_body(e)
    have = {x["id"]: x for x in existing if x.get("id")}
    put, delete = [], []
    for gid, body in want.items():
        cur = have.get(gid)
        if cur is None:
            put.append((gid, body, False))
            continue
        cancelled = cur.get("status") == "cancelled"
        h = ((cur.get("extendedProperties") or {}).get("private") or {}).get("bt_h")
        if cancelled or h != body["extendedProperties"]["private"]["bt_h"]:
            put.append((gid, body, cancelled))
    for gid, cur in have.items():
        mine = ((cur.get("extendedProperties") or {}).get("private") or {}).get("bt") == "1"
        if mine and gid not in want and cur.get("status") != "cancelled":
            delete.append(gid)
    return {"put": put, "delete": delete}


def _list_existing(cid: str, start: date, end: date) -> list[dict]:
    out, page = [], None
    while True:
        params = {"timeMin": f"{start.isoformat()}T00:00:00Z",
                  "timeMax": f"{(end + timedelta(days=2)).isoformat()}T00:00:00Z",
                  "showDeleted": "true", "maxResults": 2500, "singleEvents": "true"}
        if page:
            params["pageToken"] = page
        data = _api("GET", f"/calendars/{_q(cid)}/events", params=params) or {}
        out += data.get("items") or []
        page = data.get("nextPageToken")
        if not page:
            return out


def _put(cid: str, gid: str, body: dict, known: bool) -> str:
    base = f"/calendars/{_q(cid)}/events"
    if known and _api("PUT", f"{base}/{gid}", body=body, ok_404=True) is not None:
        return "updated"
    try:
        _api("POST", base, body={**body, "id": gid})
        return "created"
    except GcalError as exc:
        if exc.status != 409:                       # 409 = the id exists (deleted outside the window)
            raise
    _api("PUT", f"{base}/{gid}", body=body)
    return "updated"


def sync(events_fn=None, today: Optional[date] = None) -> dict:
    """One pass. `events_fn(start, end)` defaults to calendar_feed.build()['events']."""
    if not load_token():
        raise GcalError(409, "Google Calendar is not connected", "not_connected")
    if not _sync_lock.acquire(blocking=False):
        raise GcalError(409, "a sync is already running", "busy")
    started = time.time()
    counts = {"created": 0, "updated": 0, "deleted": 0, "unchanged": 0, "failed": 0}
    try:
        today = today or date.today()
        start, end = today - timedelta(days=BACK_DAYS), today + timedelta(days=ahead_days())
        if events_fn is None:
            import calendar_feed
            events_fn = lambda s, e: calendar_feed.build(s, e, today)["events"]  # noqa: E731
        events = events_fn(start, end)
        settings = get_settings()
        cid = (load_token() or {}).get("calendar_id") or ensure_calendar()
        existing = _list_existing(cid, start, end)
        todo = plan(events, existing, settings)
        known = {x["id"] for x in existing}
        errors: list[str] = []
        for gid, body, _revive in todo["put"]:
            try:
                counts[_put(cid, gid, body, gid in known)] += 1
            except GcalError as exc:
                counts["failed"] += 1
                errors.append(str(exc))
        for gid in todo["delete"]:
            try:
                _api("DELETE", f"/calendars/{_q(cid)}/events/{gid}", ok_404=True)
                counts["deleted"] += 1
            except GcalError as exc:
                counts["failed"] += 1
                errors.append(str(exc))
        mine = sum(1 for e in events if wanted(e, settings))
        counts["unchanged"] = max(0, mine - counts["created"] - counts["updated"] - counts["failed"])
        state = {"at": int(time.time()), "ok": not errors, "events": mine, **counts,
                 "error": errors[0] if errors else None, "elapsed_s": round(time.time() - started, 1),
                 "window": [start.isoformat(), end.isoformat()]}
        _write("state.json", state)
        if counts["created"] or counts["updated"] or counts["deleted"]:
            logger.info("google calendar: +%d ~%d -%d (%d failed)", counts["created"],
                        counts["updated"], counts["deleted"], counts["failed"])
        return state
    except GcalError as exc:
        _write("state.json", {"at": int(time.time()), "ok": False, "error": str(exc), **counts})
        raise
    finally:
        _sync_lock.release()


def run_if_connected() -> Optional[dict]:
    """For the calendar scheduler: a pass when connected, quiet otherwise. Never raises."""
    token = load_token()
    if not token or token.get("revoked_at") or not configured():
        return None
    try:
        return sync()
    except GcalError as exc:
        if exc.code != "busy":
            logger.warning("google calendar sync failed: %s", exc)
        return None
    except Exception as exc:  # noqa: BLE001 — a bad pass must not stop the reminders
        logger.exception("google calendar sync crashed: %s", exc)
        return None


def status() -> dict:
    """For the CAL panel. Never the token."""
    token = load_token()
    try:
        folder = str(token_dir())
    except GcalError as exc:
        folder, token = f"error: {exc}", None
    return {
        "configured": configured(),
        "connected": bool(token) and not (token or {}).get("revoked_at"),
        "revoked": bool((token or {}).get("revoked_at")),
        "calendar_id": (token or {}).get("calendar_id"),
        "shared_calendar": shared_calendar_id() is not None,
        "connected_at": (token or {}).get("connected_at"),
        "scope": (token or {}).get("scope") or scope(),
        "settings": get_settings(),
        "last_sync": _read("state.json"),
        "window_days": [BACK_DAYS, ahead_days()],
        "token_dir": folder,
    }
