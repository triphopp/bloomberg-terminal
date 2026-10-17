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
import re
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
_calls = [0]                        # HTTP requests sent to Google (for the pass report)


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
    _calls[0] += 1
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
    _calls[0] += 1
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
    body["extendedProperties"] = {"private": {"bt": "1", "bt_h": content_hash(body)}}
    return body


_HASHED = ("summary", "description", "start", "end", "colorId", "transparency", "status")


def content_hash(item: dict) -> str:
    """Hash of what a person sees. Taken from Google's copy too, so an event edited by hand
    in Google no longer matches (its bt_h, carried along untouched, would)."""
    seen = {k: item.get(k) for k in _HASHED if item.get(k) not in (None, "")}
    seen["start"] = {"date": (item.get("start") or {}).get("date")}
    seen["end"] = {"date": (item.get("end") or {}).get("date")}
    return hashlib.sha1(json.dumps(seen, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


def plan(events: list[dict], existing: list[dict], settings: dict,
         window: Optional[tuple[str, str]] = None) -> dict:
    """What to write: {"put": [(gid, body, known)], "delete": [gid]}. Pure — the tests hold it.

    `existing` is what Google holds ({id, status, date, extendedProperties}); `known` says the
    id exists there (cancelled included), so a put is an update, not an insert. Only events of
    ours are deleted, and with `window` only those dated inside it: a past event stays in
    Google as the record of that day after the feed has moved on."""
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
        h = ((cur.get("extendedProperties") or {}).get("private") or {}).get("bt_h")
        if cur.get("status") == "cancelled" or h != body["extendedProperties"]["private"]["bt_h"]:
            put.append((gid, body, True))
    for gid, cur in have.items():
        mine = ((cur.get("extendedProperties") or {}).get("private") or {}).get("bt") == "1"
        if not mine or gid in want or cur.get("status") == "cancelled":
            continue
        day = cur.get("date") or ((cur.get("start") or {}).get("date"))
        if window and day and not (window[0] <= day <= window[1]):
            continue
        delete.append(gid)
    return {"put": put, "delete": delete}


def fingerprint(events: list[dict], settings: dict) -> str:
    """One hash for everything that would go up. Equal to the last pass's = nothing to do."""
    parts = sorted(f"{event_id(e['id'])}:{event_body(e)['extendedProperties']['private']['bt_h']}"
                   for e in events if wanted(e, settings))
    return hashlib.sha1("|".join(parts).encode()).hexdigest()


# ── What Google holds, mirrored here ─────────────────────────────────────────
#
# mirror.json (beside the token, machine-local, rebuilt from Google whenever it is
# missing or doubtful): {calendar_id, sync_token, fp, checked_at, events: {gid: {h, d,
# s, m}}}. events.list with a syncToken returns only what changed since the last list
# — an empty page when nothing did — so knowing Google's side costs one small call,
# and a pass whose fingerprint matches the last one costs none at all until
# RECHECK_S has passed (an event edited or deleted by hand in Google is put back then,
# or at once on SYNC NOW).

RECHECK_S = 6 * 3600
BATCH_URL = "https://www.googleapis.com/batch/calendar/v3"
BATCH_MAX = 50              # Google's limit per batch for the Calendar API
_RETRY_ROUNDS = 3


def recheck_s() -> int:
    try:
        return max(0, int(os.getenv("GCAL_RECHECK_S", "") or RECHECK_S))
    except ValueError:
        return RECHECK_S


def _mirror_item(x: dict) -> dict:
    priv = (x.get("extendedProperties") or {}).get("private") or {}
    return {"h": content_hash(x), "d": (x.get("start") or {}).get("date"),
            "s": x.get("status") or "confirmed", "m": priv.get("bt") == "1"}


def _as_existing(events: dict[str, dict]) -> list[dict]:
    return [{"id": gid, "status": v["s"], "date": v["d"],
             "extendedProperties": {"private": {"bt": "1" if v["m"] else "", "bt_h": v["h"]}}}
            for gid, v in events.items()]


def _refresh_mirror(cid: str, mirror: dict) -> dict:
    """Bring the mirror level with Google: the changes since the last list, or everything."""
    if mirror.get("calendar_id") != cid:
        mirror = {"calendar_id": cid, "events": {}}
    token = mirror.get("sync_token")
    if not token:
        mirror["events"] = {}
    path = f"/calendars/{_q(cid)}/events"
    page = None
    while True:
        params: dict = {"maxResults": 2500, "showDeleted": "true"}
        if token:
            params["syncToken"] = token
        if page:
            params["pageToken"] = page
        try:
            data = _api("GET", path, params=params) or {}
        except GcalError as exc:
            if token and exc.status == 410:             # token too old: Google asks for a full list
                return _refresh_mirror(cid, {"calendar_id": cid, "events": {}})
            raise
        for x in data.get("items") or []:
            if x.get("id"):
                mirror["events"][x["id"]] = _mirror_item(x)
        page = data.get("nextPageToken")
        if not page:
            mirror["sync_token"] = data.get("nextSyncToken")
            return mirror


# ── Batch ────────────────────────────────────────────────────────────────────

def _batch_body(calls: list[tuple[str, str, Optional[dict]]], boundary: str) -> bytes:
    out = []
    for i, (method, path, body) in enumerate(calls):
        part = (f"--{boundary}\r\nContent-Type: application/http\r\nContent-ID: <item{i}>\r\n\r\n"
                f"{method} /calendar/v3{path} HTTP/1.1\r\n")
        if body is not None:
            part += "Content-Type: application/json; charset=UTF-8\r\n\r\n" + json.dumps(body, ensure_ascii=False)
        out.append(part + "\r\n")
    out.append(f"--{boundary}--\r\n")
    return "".join(out).encode("utf-8")


def _batch_parse(content_type: str, raw: bytes) -> dict[int, tuple[int, dict]]:
    """{item index: (status, json body)} from a multipart/mixed batch answer."""
    m = re.search(r'boundary="?([^";]+)"?', content_type or "")
    if not m:
        raise GcalError(424, "Google batch answer without a boundary")
    text = raw.decode("utf-8", "replace")
    out: dict[int, tuple[int, dict]] = {}
    for part in text.split("--" + m.group(1)):
        idx = re.search(r"Content-ID:\s*<response-item(\d+)>", part, re.I)
        status = re.search(r"HTTP/1\.1 (\d{3})", part)
        if not idx or not status:
            continue
        inner = part[status.start():]
        sep = re.search(r"\r?\n\r?\n", inner)
        body = inner[sep.end():].strip() if sep else ""
        try:
            data = json.loads(body) if body else {}
        except ValueError:
            data = {}
        out[int(idx.group(1))] = (int(status.group(1)), data if isinstance(data, dict) else {})
    return out


def _batch(calls: list[tuple[str, str, Optional[dict]]]) -> list[tuple[int, dict]]:
    """Run the calls BATCH_MAX to an HTTP request; returns (status, body) per call, in order.
    Each inner call still counts against the quota — a batch saves round trips, not quota."""
    results: list[tuple[int, dict]] = []
    for k in range(0, len(calls), BATCH_MAX):
        chunk = calls[k:k + BATCH_MAX]
        boundary = "bt_" + secrets.token_hex(8)
        _calls[0] += 1
        r = _session.request("POST", BATCH_URL, data=_batch_body(chunk, boundary), timeout=60,
                             headers={"Authorization": f"Bearer {_access_token()}",
                                      "Content-Type": f"multipart/mixed; boundary={boundary}"})
        if not r.ok:
            raise GcalError(424 if r.status_code >= 500 or r.status_code == 429 else r.status_code,
                            f"Google Calendar batch → {_why(r, _json(r))}")
        parsed = _batch_parse(r.headers.get("Content-Type", ""), r.content)
        results += [parsed.get(i, (0, {})) for i in range(len(chunk))]
    return results


def _rate_limited(status: int, body: dict) -> bool:
    if status == 429:
        return True
    reasons = [e.get("reason") for e in ((body.get("error") or {}).get("errors") or []) if isinstance(e, dict)]
    return status == 403 and any(r in ("rateLimitExceeded", "userRateLimitExceeded") for r in reasons)


def _write_all(cid: str, todo: dict, mirror: dict, counts: dict, errors: list[str]) -> None:
    """Every put and delete in as few requests as Google allows. An insert that meets an id
    Google already has (409) becomes an update, an update of an id it does not have (404) an
    insert, and calls Google throttled are sent again after a pause."""
    base = f"/calendars/{_q(cid)}/events"
    # (kind, gid, body): "ins" / "upd" / "del"
    pending = [("upd" if known else "ins", gid, body) for gid, body, known in todo["put"]]
    pending += [("del", gid, None) for gid in todo["delete"]]
    for round_ in range(_RETRY_ROUNDS + 1):
        if not pending:
            return
        if round_:
            time.sleep(1.5 * round_)
        calls = [("POST", base, {**body, "id": gid}) if kind == "ins"
                 else ("PUT", f"{base}/{gid}", body) if kind == "upd"
                 else ("DELETE", f"{base}/{gid}", None) for kind, gid, body in pending]
        nxt = []
        for (kind, gid, body), (status, resp) in zip(pending, _batch(calls)):
            if 200 <= status < 300 or (kind == "del" and status in (404, 410)):
                if kind == "del":
                    counts["deleted"] += 1
                    if gid in mirror["events"]:
                        mirror["events"][gid]["s"] = "cancelled"
                else:
                    counts["created" if kind == "ins" else "updated"] += 1
                    mirror["events"][gid] = {"h": body["extendedProperties"]["private"]["bt_h"],
                                             "d": body["start"]["date"], "s": "confirmed", "m": True}
            elif kind == "ins" and status == 409:
                nxt.append(("upd", gid, body))
            elif kind == "upd" and status == 404:
                nxt.append(("ins", gid, body))
            elif _rate_limited(status, resp) and round_ < _RETRY_ROUNDS:
                nxt.append((kind, gid, body))
            else:
                counts["failed"] += 1
                err = resp.get("error")
                errors.append(f"Google Calendar {kind} → {status} "
                              f"{err.get('message') if isinstance(err, dict) else err or ''}".strip())
        pending = nxt


def sync(events_fn=None, today: Optional[date] = None, force: bool = False) -> dict:
    """One pass. `events_fn(start, end)` defaults to calendar_feed.build()['events'].
    `force` asks Google even when nothing changed here (SYNC NOW)."""
    if not load_token():
        raise GcalError(409, "Google Calendar is not connected", "not_connected")
    if not _sync_lock.acquire(blocking=False):
        raise GcalError(409, "a sync is already running", "busy")
    started = time.time()
    counts = {"created": 0, "updated": 0, "deleted": 0, "unchanged": 0, "failed": 0}
    try:
        today = today or date.today()
        start, end = today - timedelta(days=BACK_DAYS), today + timedelta(days=ahead_days())
        window = (start.isoformat(), end.isoformat())
        if events_fn is None:
            import calendar_feed
            events_fn = lambda s, e: calendar_feed.build(s, e, today)["events"]  # noqa: E731
        events = events_fn(start, end)
        settings = get_settings()
        mine = sum(1 for e in events if wanted(e, settings))
        fp = fingerprint(events, settings)
        cid = (load_token() or {}).get("calendar_id") or ensure_calendar()
        mirror = _read("mirror.json") or {}
        base_state = {"events": mine, "window": list(window)}
        if (not force and mirror.get("calendar_id") == cid and mirror.get("fp") == fp
                and time.time() - float(mirror.get("checked_at") or 0) < recheck_s()):
            # Nothing changed here since a pass Google confirmed: no request at all.
            state = {**(_read("state.json") or {}), **base_state, "at": int(time.time()), "ok": True,
                     **counts, "unchanged": mine, "requests": 0, "skipped": True,
                     "elapsed_s": round(time.time() - started, 2), "error": None}
            _write("state.json", state)
            return state
        calls_before = _calls[0]
        mirror = _refresh_mirror(cid, mirror)
        todo = plan(events, _as_existing(mirror["events"]), settings, window)
        errors: list[str] = []
        _write_all(cid, todo, mirror, counts, errors)
        counts["unchanged"] = max(0, mine - counts["created"] - counts["updated"] - counts["failed"])
        mirror.update(fp=fp if not errors else None, checked_at=time.time())
        _write("mirror.json", mirror)
        state = {"at": int(time.time()), "ok": not errors, **base_state, **counts,
                 "requests": _calls[0] - calls_before, "skipped": False,
                 "error": errors[0] if errors else None, "elapsed_s": round(time.time() - started, 1)}
        _write("state.json", state)
        if counts["created"] or counts["updated"] or counts["deleted"]:
            logger.info("google calendar: +%d ~%d -%d (%d failed, %d requests)", counts["created"],
                        counts["updated"], counts["deleted"], counts["failed"], state["requests"])
        return state
    except GcalError as exc:
        if exc.code == "revoked" or exc.status == 404:
            _remove("mirror.json")                  # the calendar or the grant is gone: start over
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
