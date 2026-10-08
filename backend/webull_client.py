"""Webull OpenAPI (Thailand) — request signing, the access token, one signed call.

Three things identify a request, and they are not the same thing:

  app key      which application is calling          header `x-app-key`
  app secret   signs the request on this machine     never sent
  access token the account owner approved this app   header `x-access-token`

The token is not issued on the website. `create_token()` asks for one; in
production it comes back PENDING and Webull texts a code to the phone bound to
the account, which the owner enters in the Webull app within 5 minutes
(Menu → Messages → OpenAPI Notifications). It then reads NORMAL and is reused.
The test host hands out NORMAL tokens with no verification.

A token ends. Its `expires_at` is 15 days after it was made and did not move
with use (checked 2026-10-08 after 80 minutes of calls), so about every two
weeks the owner confirms a new one. Nothing here lets that pass quietly:
`active_token()` stops sending a token past its date, a refusal from Webull
(401 INVALID_TOKEN on every endpoint) is written down by `mark_token()` and
logged, and `public_token()` says how long is left so the panel can warn first.

Signature (docs: authentication/signature; the SDK's
default_signature_composer.py is the reference — the per-endpoint samples in
the docs still say HMAC-SHA1, which is the retired scheme):

  str1 = query params + signing headers, sorted by name, joined k=v with &
  str3 = path & str1 [& UPPER(SHA256(body))]
  signature = base64(HMAC-SHA256(secret + "&", urlencode(str3)))

The token is a credential, so it is kept outside the repository, beside the
other per-machine app data. Nothing here logs a key, a secret, a token or a URL.

One confirmation serves every machine. The token belongs to the app key, not
to the computer, so a machine that gets one also leaves an encrypted copy in
the Google Drive folder the portfolio syncs through (`<SYNC_DIR>/webull/`), and
the others take it from there: no second SMS, no copying files by hand. The
copy is AES-256-GCM under a key derived from the app secret — every machine
already holds that secret in backend/.env, Drive never does, and the token is
useless without it anyway. A machine adopts the shared token only when it is
newer than its own (later `expires_at`) and still usable, and a request for a
new token first looks there, so a token confirmed on the Mac is picked up on
the PC instead of texting another code. `WEBULL_TOKEN_SHARE=off` keeps a
machine to itself.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import threading
import time
import urllib.parse
import uuid
from datetime import datetime, timezone
from pathlib import Path

import requests

import ask_sessions
import config
import upstream_health
from sync import config as sync_config

logger = logging.getLogger(__name__)

ALGORITHM = "HMAC-SHA256"
SIGN_VERSION = "1.0"
API_VERSION = "v3"
TEST_HOST = "th-api.uat.webullbroker.com"
PROD_HOST = "api.webull.co.th"

_PENDING_CHECK_S = 10       # how often a PENDING token's status is re-read while the panel waits
_PENDING_LIFE_S = 5 * 60    # the SMS code is good for 5 minutes; a PENDING token older than that is dead
_SHARED_LOOK_S = 5          # how often the shared copy's file date is looked at (a stat, no read)

_session = requests.Session()
_lock = threading.Lock()


class WebullError(Exception):
    """A refusal worth showing: `status` is the HTTP status to answer with.

    Never 5xx — main.py replaces every 5xx detail with "Internal server error",
    and the reason is the whole point. An upstream failure answers 424."""

    def __init__(self, status: int, message: str, code: str = "upstream"):
        super().__init__(message)
        self.status = status
        self.code = code


# ── Settings ─────────────────────────────────────────────────────────────────

def host() -> str:
    return config.WEBULL_API_HOST


def environment() -> str:
    return {PROD_HOST: "production", TEST_HOST: "test"}.get(host(), "custom")


def configured() -> bool:
    return bool(config.WEBULL_APP_KEY and config.WEBULL_APP_SECRET)


def _require_keys() -> None:
    if not configured():
        missing = [n for n, v in (("WEBULL_APP_KEY", config.WEBULL_APP_KEY),
                                  ("WEBULL_APP_SECRET", config.WEBULL_APP_SECRET)) if not v]
        raise WebullError(424, f"{' and '.join(missing)} not set in backend/.env — "
                               "add them, then restart the backend", "keys")


# ── Signature ────────────────────────────────────────────────────────────────

def sign(path: str, query: dict, body: str | None, app_key: str, app_secret: str,
         api_host: str, timestamp: str, nonce: str) -> str:
    params = {str(k): str(v) for k, v in query.items()}
    params.update({
        "x-app-key": app_key,
        "x-timestamp": timestamp,
        "x-signature-algorithm": ALGORITHM,
        "x-signature-version": SIGN_VERSION,
        "x-signature-nonce": nonce,
        "host": api_host,
    })
    to_sign = path + "&" + "&".join(f"{k}={params[k]}" for k in sorted(params))
    if body:
        to_sign += "&" + hashlib.sha256(body.encode("utf-8")).hexdigest().upper()
    digest = hmac.new(f"{app_secret}&".encode("utf-8"),
                      urllib.parse.quote(to_sign, safe="").encode("utf-8"), hashlib.sha256).digest()
    return base64.b64encode(digest).decode("ascii")


def call(method: str, path: str, query: dict | None = None, body: dict | None = None,
         token: str | None = None, timeout: float = 10) -> requests.Response:
    """One signed request. Raises WebullError only when the host cannot be reached."""
    _require_keys()
    query = {k: v for k, v in (query or {}).items() if v is not None}
    # The exact bytes that were hashed must be the bytes that are sent.
    body_string = json.dumps(body, separators=(",", ":")) if body is not None else None
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    nonce = uuid.uuid4().hex
    headers = {
        "Accept": "application/json",
        "x-app-key": config.WEBULL_APP_KEY,
        "x-timestamp": timestamp,
        "x-signature-algorithm": ALGORITHM,
        "x-signature-version": SIGN_VERSION,
        "x-signature-nonce": nonce,
        "x-version": API_VERSION,
        "x-signature": sign(path, query, body_string, config.WEBULL_APP_KEY,
                            config.WEBULL_APP_SECRET, host(), timestamp, nonce),
    }
    if token:
        headers["x-access-token"] = token
    if body_string is not None:
        headers["Content-Type"] = "application/json"
    try:
        return _session.request(method, f"https://{host()}{path}", params=query,
                                data=body_string, headers=headers, timeout=timeout)
    except requests.RequestException as exc:
        raise WebullError(424, f"Webull unreachable: {exc.__class__.__name__}") from exc


def explain(r: requests.Response) -> str:
    """The upstream's own reason, with nothing of ours in it."""
    try:
        data = r.json()
        text = data.get("message") or data.get("msg") or data.get("error_code") or ""
        code = data.get("error_code") or data.get("code") or ""
        text = f"{code}: {text}" if code and code not in text else text
    except (ValueError, AttributeError):
        text = r.text
    text = str(text)[:240]
    for secret in (config.WEBULL_APP_KEY, config.WEBULL_APP_SECRET, (load_token() or {}).get("token")):
        if secret:
            text = text.replace(secret, "***")
    return text or f"HTTP {r.status_code}"


# ── Token ────────────────────────────────────────────────────────────────────

def token_dir() -> Path:
    custom = os.getenv("WEBULL_TOKEN_DIR", "").strip()
    path = Path(custom).expanduser() if custom else ask_sessions.local_dir().parent / "webull"
    try:
        path.resolve().relative_to(ask_sessions.REPO_ROOT)
    except (ValueError, OSError):
        return path
    raise WebullError(424, "WEBULL_TOKEN_DIR is inside the repository — an access token "
                           "must not be one `git add .` from a commit", "keys")


def _tag() -> str:
    # One file per host and key: a test token is no use in production, nor is another app's.
    return hashlib.sha256(f"{host()}|{config.WEBULL_APP_KEY}".encode()).hexdigest()[:12]


def _token_file() -> Path:
    return token_dir() / f"token-{_tag()}.json"


def load_token() -> dict | None:
    try:
        data = json.loads(_token_file().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) and data.get("token") else None
    except (OSError, ValueError, WebullError):
        return None


def _save_token(data: dict) -> dict:
    record = {"token": data.get("token"), "expires_at": data.get("expires_at"),
              "status": data.get("status"), "checked_at": int(time.time())}
    # issued_at: when the code was texted (a PENDING token dies 5 minutes later).
    # by: the machine a shared token came from — a name, never a secret.
    record.update({k: data[k] for k in ("issued_at", "by") if data.get(k)})
    path = _token_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(record), encoding="utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    tmp.replace(path)
    return record


def expires_in(record: dict | None) -> float | None:
    """Seconds until the token's own expiry date; None when it carries none."""
    at = (record or {}).get("expires_at")
    try:
        return float(at) / 1000 - time.time() if at else None
    except (TypeError, ValueError):
        return None


def public_token(record: dict | None) -> dict | None:
    """What may leave this process: never the token itself."""
    if not record:
        return None
    left = expires_in(record)
    return {"status": record.get("status"), "expires_at": record.get("expires_at"),
            "expires_in_s": round(left) if left is not None else None,
            "checked_at": record.get("checked_at"), "from": record.get("by")}


# ── Shared copy (Google Drive) ───────────────────────────────────────────────

_shared = {"at": 0.0, "mtime": None, "error": None}


def shared_dir() -> Path | None:
    """`webull/` inside the cloud folder, when this machine has that folder and sharing is on."""
    if os.getenv("WEBULL_TOKEN_SHARE", "").strip().lower() in ("off", "false", "0", "no"):
        return None
    try:
        root = sync_config.sync_dir()
    except Exception:
        root = None
    if not root or not root.is_dir():
        return None
    folder = root / "webull"
    try:
        folder.resolve().relative_to(ask_sessions.REPO_ROOT)
    except (ValueError, OSError):
        return folder
    return None                                     # a "cloud folder" inside the repo: never


def _shared_file() -> Path | None:
    folder = shared_dir()
    return folder / f"token-{_tag()}.enc" if folder else None


def _shared_key() -> bytes:
    # From the app secret: every machine has it, Drive never does — no second secret to carry.
    return hmac.new(config.WEBULL_APP_SECRET.encode("utf-8"),
                    f"bloomberg-terminal|webull-shared-token|v1|{_tag()}".encode("utf-8"),
                    hashlib.sha256).digest()


def _seal(record: dict) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce = os.urandom(12)
    data = AESGCM(_shared_key()).encrypt(nonce, json.dumps(record).encode("utf-8"), _tag().encode())
    return json.dumps({"v": 1, "alg": "AES-256-GCM", "nonce": base64.b64encode(nonce).decode("ascii"),
                       "data": base64.b64encode(data).decode("ascii")})


def _unseal(text: str) -> dict | None:
    """The record — or None for a file sealed under another secret, or changed (GCM checks both)."""
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    try:
        box = json.loads(text)
        plain = AESGCM(_shared_key()).decrypt(base64.b64decode(box["nonce"]),
                                              base64.b64decode(box["data"]), _tag().encode())
        record = json.loads(plain)
    except (InvalidTag, ValueError, KeyError, TypeError):
        return None
    return record if isinstance(record, dict) and record.get("token") else None


def read_shared() -> dict | None:
    path = _shared_file()
    if path is None:
        return None
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    return _unseal(text)


def _share_error(exc: Exception) -> str:
    if isinstance(exc, ImportError):
        return "cryptography is not installed — pip install -r requirements.txt"
    return f"shared token folder: {exc.__class__.__name__}"


def _usable(record: dict | None) -> bool:
    """Worth sending (NORMAL, before its date) or worth waiting for (PENDING, code still live)."""
    status = (record or {}).get("status")
    if status == "NORMAL":
        left = expires_in(record)
        return left is None or left > 0
    if status == "PENDING":
        since = record.get("issued_at") or record.get("written_at") or 0
        return time.time() - since < _PENDING_LIFE_S
    return False


def _better(shared: dict | None, local: dict | None) -> bool:
    """Should this machine drop what it holds for the shared token?"""
    if not _usable(shared):
        return False
    if not local:
        return True
    if shared["token"] != local.get("token"):
        # A later expiry = made later: the newest token wins, whichever machine got it.
        return not _usable(local) or (shared.get("expires_at") or 0) > (local.get("expires_at") or 0)
    if shared.get("status") == local.get("status"):
        return False
    if local.get("status") == "PENDING":
        return True                                 # the code was entered for the other machine
    # Same token, ended here but working there: believe whichever was learned last.
    return (shared.get("written_at") or 0) > (local.get("checked_at") or 0)


def _publish(record: dict) -> None:
    """Leave the token for the other machines. Never raises: Drive being away must not stop this one."""
    if record.get("status") not in ("NORMAL", "PENDING"):
        return
    path = _shared_file()
    if path is None:
        return
    try:
        current = read_shared()
        if current and current.get("token") != record.get("token") and _better(current, record):
            return                                  # a newer one is already there: never overwrite it
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(_seal({**record, "by": sync_config.device_id(), "written_at": time.time()}),
                       encoding="utf-8")
        tmp.replace(path)
        _shared.update(mtime=path.stat().st_mtime, error=None)     # our own write is not news
    except Exception as exc:
        _shared["error"] = _share_error(exc)
        logger.warning("webull shared token not written: %s", exc.__class__.__name__)


def _look_shared(force: bool = False) -> dict | None:
    """Take the other machine's token when it is better than ours; returns what is stored now.

    A stat every few seconds, a read only when the file changed. Never raises,
    never calls Webull, never takes `_lock` (create_token holds it while calling)."""
    local = load_token()
    now = time.time()
    if not force and now - _shared["at"] < _SHARED_LOOK_S:
        return local
    _shared["at"] = now
    path = _shared_file()
    if path is None:
        return local
    try:
        mtime = path.stat().st_mtime
        if not force and mtime == _shared["mtime"]:
            return local
        shared = read_shared()
    except FileNotFoundError:
        return local
    except Exception as exc:
        _shared["error"] = _share_error(exc)
        return local
    _shared.update(mtime=mtime, error=None if shared else
                   "the shared token cannot be opened — is WEBULL_APP_SECRET the same on every machine?")
    if not _better(shared, local):
        return local
    logger.info("webull access token taken from %s", shared.get("by") or "another machine")
    return _save_token(shared)


def shared_status() -> dict:
    """For /api/webull/status: is the token shared, and is anything wrong. Never the token."""
    folder = shared_dir()
    return {"on": folder is not None, "folder": str(folder) if folder else None, "error": _shared["error"]}


def _token_call(path: str, body: dict, **extra) -> dict:
    r = call("POST", path, body=body)
    if not r.ok:
        raise WebullError(r.status_code if r.status_code < 500 else 424,
                          f"Webull {path} → {r.status_code}: {explain(r)}")
    data = r.json()
    if not data.get("token"):
        raise WebullError(424, f"Webull {path} returned no token")
    old = load_token() or {}
    if old.get("token") == data.get("token"):      # the same token re-read: keep where it came from
        extra = {k: old[k] for k in ("issued_at", "by") if k in old}
    record = _save_token({**data, **extra})
    _publish(record)
    return record


def create_token() -> dict:
    """Ask for a token. In production this texts a code to the account's phone —
    unless another machine already got one, which is then taken instead."""
    with _lock:
        before = load_token()
        old = _look_shared(force=True)
        if _usable(old) and (old or {}).get("token") != (before or {}).get("token"):
            return old                              # confirmed (or awaiting its code) elsewhere: no SMS
        # A working token is handed back, so the server can answer "still good" with no
        # new SMS. Any other one must NOT be: given an expired token, Webull returns that
        # same token, still EXPIRED, and sends nothing (2026-10-08 — every press after the
        # first missed code did nothing, with a 200 each time).
        reuse = old and old.get("status") == "NORMAL"
        record = _token_call("/auth/tokens/create", {"token": old["token"]} if reuse else {},
                             issued_at=int(time.time()))
        if record.get("status") not in ("PENDING", "NORMAL"):
            raise WebullError(424, f"Webull issued a token that is already {record.get('status')} — "
                                   "wait a few minutes and request again")
        return record


def check_token() -> dict | None:
    with _lock:
        old = load_token()
        return _token_call("/auth/tokens/check", {"token": old["token"]}) if old else None


def active_token() -> str:
    """The token to send, or a WebullError that says what the owner has to do."""
    record = _look_shared()
    if (record and record.get("status") == "PENDING"
            and time.time() - (record.get("checked_at") or 0) > _PENDING_CHECK_S):
        try:
            record = check_token()      # the owner may have just confirmed in the app
        except WebullError:
            # Webull throttles /auth/tokens/check (429 seen 2026-10-08 at one call / 3 s).
            # Still pending as far as we know: wait a full interval before asking again.
            with _lock:
                record = _save_token(record)
    status = (record or {}).get("status")
    left = expires_in(record)
    if status == "NORMAL" and left is not None and left <= 0:
        # Do not send a token known to be dead — the other machine may have the next one.
        record = mark_token("EXPIRED", "past its expiry date", record["token"])
        status = (record or {}).get("status")
    if status == "NORMAL":
        return record["token"]
    if status == "PENDING":
        raise WebullError(409, "Token awaiting verification — open the Webull app → Menu → Messages → "
                               "OpenAPI Notifications and enter the SMS code (5 minutes)", "token_pending")
    if status in ("EXPIRED", "INVALID"):
        raise WebullError(409, "The Webull access token has expired (a token lasts 15 days) — request a "
                               "new one and confirm the SMS code in the Webull app", "token_missing")
    raise WebullError(409, "No active Webull access token — request one", "token_missing")


def refresh_token_status(max_age_s: float = 6 * 3600) -> dict | None:
    """Re-read a working token's status from Webull when what is stored is old —
    so a token ended on Webull's side is known before a panel trips over it.
    Never raises, never requests a token."""
    record = _look_shared()
    if (not record or record.get("status") != "NORMAL"
            or time.time() - (record.get("checked_at") or 0) < max_age_s):
        return record
    try:
        fresh = check_token()
    except WebullError:
        with _lock:
            return _save_token(record)                     # asked: wait a full interval
    if fresh and fresh.get("status") != "NORMAL":
        logger.warning("webull access token is %s on Webull's side", fresh.get("status"))
        upstream_health.record(host(), "auth", target="token")
    return fresh


def mark_token(status: str, why: str = "refused by Webull", token: str | None = None) -> dict | None:
    """The token is dead: remember that, so the panel asks for a new one — and
    write it where problems are looked for (backend log, logs/upstream.jsonl).

    `token` = the one that was refused; when the stored one is already another
    (taken from the other machine while the request was out), that one is left
    alone. Returns what is stored afterwards — maybe the other machine's token."""
    with _lock:
        old = load_token()
        marked = bool(old and old.get("status") != status and (not token or old.get("token") == token))
        if marked:
            _save_token({**old, "status": status})
    if marked:
        logger.warning("webull access token marked %s: %s", status, why)
        upstream_health.record(host(), "auth", target="token")
    return _look_shared(force=marked)
