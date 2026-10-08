"""Webull depth (webull_client.py + routers/webull.py).

No test here reaches Webull. What is held: the signature is the documented
string, signed the documented way; a token never leaves the process or lands in
the repository; a token is never requested unless someone asked; and every
refusal reaches the panel as a reason, cached so a poll cannot hammer upstream.
"""
import base64
import hashlib
import hmac
import importlib
import json
import urllib.parse

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

KEY, SECRET, HOST = "k" * 32, "s" * 32, "th-api.uat.webullbroker.com"
TOKEN = "ccb071f764864b65a1fb48484e940a56"      # the example value in Webull's docs


class Reply:
    def __init__(self, status=200, body=None, text=None):
        self.status_code, self._body = status, body
        self.text = text if text is not None else json.dumps(body)
        self.ok = status < 400

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


@pytest.fixture()
def wb(tmp_path, monkeypatch):
    monkeypatch.setenv("WEBULL_APP_KEY", KEY)
    monkeypatch.setenv("WEBULL_APP_SECRET", SECRET)
    monkeypatch.setenv("WEBULL_API_HOST", HOST)
    monkeypatch.setenv("WEBULL_TOKEN_DIR", str(tmp_path / "tok"))
    import config
    importlib.reload(config)
    import webull_client
    importlib.reload(webull_client)
    import routers.webull as router
    importlib.reload(router)

    sent = []
    replies = []

    def request(method, url, params=None, data=None, headers=None, timeout=None):
        sent.append({"method": method, "url": url, "params": params, "data": data, "headers": headers})
        return replies.pop(0) if replies else Reply(500, None, "no reply queued")

    monkeypatch.setattr(webull_client._session, "request", request)
    app = FastAPI()
    app.include_router(router.router)
    yield type("Ctx", (), {"client": TestClient(app), "wb": webull_client, "router": router,
                           "sent": sent, "replies": replies, "dir": tmp_path / "tok"})
    monkeypatch.undo()
    importlib.reload(config)


def _book(n=3, orders=True):
    def level(px):
        out = {"price": f"{px:.2f}", "size": "5"}
        if orders:
            out["order"] = [{"mpid": "NSDQ", "size": "3"}, {"mpid": "ARCA", "size": "2"}]
        return out
    return {"symbol": "AAPL", "instrument_id": "913256135", "quote_time": "1640688000000",
            "bids": [level(100 - i * 0.01) for i in range(n)],
            "asks": [level(100.05 + i * 0.01) for i in range(n)]}


FAR = 4102444800000        # 2100-01-01, in ms: a token nowhere near its end


def _ready(ctx, status="NORMAL", expires_at=FAR):
    ctx.wb._save_token({"token": TOKEN, "expires_at": expires_at, "status": status})


# ── Signature ────────────────────────────────────────────────────────────────

def test_signature_is_the_documented_string(wb):
    ts, nonce = "2022-01-04T03:55:31Z", "48ef5afed43d4d91ae514aaeafbc29ba"
    body = '{"k1":123,"k2":"this is the api request body","k3":true,"k4":{"foo":[1,2]}}'
    query = {"q1": "yyy", "a3": "xxx", "a1": "webull", "a2": "123"}
    # Written out from the worked example in the docs, not by calling the code under test.
    str1 = ("a1=webull&a2=123&a3=xxx&host=api.webull.com.sg&q1=yyy"
            f"&x-app-key={KEY}&x-signature-algorithm=HMAC-SHA256"
            f"&x-signature-nonce={nonce}&x-signature-version=1.0&x-timestamp={ts}")
    str3 = f"/trade/place_order&{str1}&{hashlib.sha256(body.encode()).hexdigest().upper()}"
    want = base64.b64encode(hmac.new(f"{SECRET}&".encode(), urllib.parse.quote(str3, safe="").encode(),
                                     hashlib.sha256).digest()).decode()
    assert wb.wb.sign("/trade/place_order", query, body, KEY, SECRET, "api.webull.com.sg", ts, nonce) == want
    # No body → no trailing hash, and the result differs.
    assert wb.wb.sign("/trade/place_order", query, None, KEY, SECRET, "api.webull.com.sg", ts, nonce) != want


def test_request_carries_the_key_and_never_the_secret(wb):
    _ready(wb)
    wb.replies.append(Reply(200, _book()))
    assert wb.client.get("/api/webull/depth?symbol=AAPL").status_code == 200
    call = wb.sent[0]
    assert call["url"] == f"https://{HOST}/market-data/stocks/depths/list"
    assert call["params"] == {"symbol": "AAPL", "category": "US_STOCK", "depth": "10",
                              "overnight_required": "false"}
    h = call["headers"]
    assert h["x-app-key"] == KEY and h["x-access-token"] == TOKEN and h["x-version"] == "v3"
    assert h["x-signature-algorithm"] == "HMAC-SHA256"
    assert SECRET not in json.dumps(call)
    assert h["x-signature"] == wb.wb.sign("/market-data/stocks/depths/list", call["params"], None,
                                          KEY, SECRET, HOST, h["x-timestamp"], h["x-signature-nonce"])


# ── Token ────────────────────────────────────────────────────────────────────

def test_no_token_is_requested_until_asked(wb):
    r = wb.client.get("/api/webull/depth?symbol=AAPL")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "token_missing"
    assert wb.sent == []                       # nothing went out — no SMS by surprise


def test_token_lifecycle_and_the_token_never_leaves(wb):
    wb.replies.append(Reply(200, {"token": TOKEN, "expires_at": 1755486723000, "status": "PENDING"}))
    r = wb.client.post("/api/webull/token")
    assert r.status_code == 200 and r.json()["token"]["status"] == "PENDING"
    assert TOKEN not in r.text
    assert wb.sent[0]["data"] == "{}"          # first request: no old token to hand back
    assert TOKEN not in wb.client.get("/api/webull/status").text

    # Pending and just checked: the panel is told to wait, upstream is left alone.
    r = wb.client.get("/api/webull/depth?symbol=AAPL")
    assert r.json()["detail"]["code"] == "token_pending" and len(wb.sent) == 1

    wb.replies.append(Reply(200, {"token": TOKEN, "expires_at": 1755486723000, "status": "NORMAL"}))
    r = wb.client.post("/api/webull/token/check")
    assert r.json()["token"]["status"] == "NORMAL"
    assert json.loads(wb.sent[1]["data"]) == {"token": TOKEN}

    files = list(wb.dir.glob("token-*.json"))
    assert len(files) == 1 and json.loads(files[0].read_text())["token"] == TOKEN


@pytest.mark.parametrize("held", ["EXPIRED", "INVALID", "PENDING"])
def test_a_dead_token_is_not_handed_back(wb, held):
    _ready(wb, held)
    wb.replies.append(Reply(200, {"token": "f" * 32, "expires_at": 1, "status": "PENDING"}))
    assert wb.client.post("/api/webull/token").json()["token"]["status"] == "PENDING"
    assert wb.sent[0]["data"] == "{}"          # a fresh request, or no SMS is ever sent again
    assert wb.wb.load_token()["token"] == "f" * 32


def test_a_working_token_is_handed_back(wb):
    _ready(wb, "NORMAL")
    wb.replies.append(Reply(200, {"token": TOKEN, "expires_at": 1, "status": "NORMAL"}))
    wb.client.post("/api/webull/token")
    assert json.loads(wb.sent[0]["data"]) == {"token": TOKEN}


def test_a_token_issued_dead_is_an_error_not_a_silent_200(wb):
    wb.replies.append(Reply(200, {"token": TOKEN, "expires_at": 1, "status": "EXPIRED"}))
    r = wb.client.post("/api/webull/token")
    assert r.status_code == 424 and "EXPIRED" in r.json()["detail"]["message"]


def test_token_dir_inside_the_repo_is_refused(wb, monkeypatch):
    monkeypatch.setenv("WEBULL_TOKEN_DIR", str(wb.wb.ask_sessions.REPO_ROOT / "backend" / "tok"))
    with pytest.raises(wb.wb.WebullError):
        wb.wb.token_dir()
    assert wb.wb.load_token() is None


def test_refused_token_asks_for_a_new_one(wb):
    _ready(wb)
    wb.replies.append(Reply(401, {"error_code": "UNAUTHORIZED", "message": f"bad token {TOKEN}"}))
    r = wb.client.get("/api/webull/depth?symbol=AAPL")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "token_missing"
    assert TOKEN not in r.text                 # what upstream echoed is masked
    assert wb.wb.load_token()["status"] == "INVALID"


# ── Depth ────────────────────────────────────────────────────────────────────

def test_depth_is_shaped_sorted_and_counted(wb):
    _ready(wb)
    book = _book(3)
    book["bids"].reverse()                     # upstream order is not relied on
    wb.replies.append(Reply(200, book))
    d = wb.client.get("/api/webull/depth?symbol=aapl&depth=5").json()
    assert [l["price"] for l in d["bids"]] == [100.0, 99.99, 99.98]
    assert [l["price"] for l in d["asks"]] == [100.05, 100.06, 100.07]
    assert d["bids"][0] == {"price": 100.0, "size": 5.0, "count": 2}
    assert d["levels"] == 3 and d["depth_requested"] == 5 and d["has_counts"] is True
    assert d["quote_time"] == "2021-12-28T10:40:00+00:00"
    assert d["source"]["environment"] == "test"


def test_level_one_answer_says_so(wb):
    _ready(wb)
    wb.replies.append(Reply(200, _book(1, orders=False)))
    d = wb.client.get("/api/webull/depth?symbol=AAPL&depth=10").json()
    assert d["levels"] == 1 and d["has_counts"] is False and d["bids"][0]["count"] is None


def test_etf_falls_through_to_the_etf_category_and_remembers(wb):
    _ready(wb)
    wb.replies += [Reply(417, {"error_code": "INVALID_SYMBOL", "message": "not a stock"}),
                   Reply(200, {**_book(2), "symbol": "SPY"})]
    assert wb.client.get("/api/webull/depth?symbol=SPY").json()["category"] == "US_ETF"
    assert [c["params"]["category"] for c in wb.sent] == ["US_STOCK", "US_ETF"]
    wb.router._cache.clear()
    wb.replies.append(Reply(200, {**_book(2), "symbol": "SPY"}))
    wb.client.get("/api/webull/depth?symbol=SPY")
    assert wb.sent[-1]["params"]["category"] == "US_ETF" and len(wb.sent) == 3


@pytest.mark.parametrize("symbol", ["^DJI", "ES=F", "JPY=X", "BTC-USD", "PTT.BK", "VOD.L"])
def test_symbols_outside_the_feed_never_go_upstream(wb, symbol):
    _ready(wb)
    r = wb.client.get("/api/webull/depth", params={"symbol": symbol})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "unsupported"
    assert wb.sent == []


def test_refusals_are_cached_successes_briefly(wb):
    _ready(wb)
    wb.replies.append(Reply(403, {"error_code": "FORBIDDEN", "message": "no market data permission"}))
    for _ in range(3):
        r = wb.client.get("/api/webull/depth?symbol=AAPL")
        assert r.status_code == 403 and r.json()["detail"]["code"] == "subscription"
    assert len(wb.sent) == 1                   # without the negative cache: three

    wb.replies.append(Reply(200, _book()))
    for _ in range(3):
        assert wb.client.get("/api/webull/depth?symbol=MSFT").status_code == 200
    assert len(wb.sent) == 2


def test_upstream_failures_answer_below_500_with_the_reason(wb):
    _ready(wb)
    wb.replies += [Reply(500, None, "boom"), Reply(500, None, "boom")]
    r = wb.client.get("/api/webull/depth?symbol=AAPL")
    assert r.status_code == 424 and "500" in r.json()["detail"]["message"]


def test_missing_keys_say_which(wb, monkeypatch):
    monkeypatch.setattr(wb.wb.config, "WEBULL_APP_SECRET", "")
    assert wb.client.get("/api/webull/status").json()["configured"] is False
    r = wb.client.post("/api/webull/token")
    assert r.status_code == 424 and "WEBULL_APP_SECRET" in r.json()["detail"]["message"]
    assert "WEBULL_APP_KEY" not in r.json()["detail"]["message"]


def test_throttled_status_check_keeps_the_token_pending(wb, monkeypatch):
    _ready(wb, "PENDING")
    monkeypatch.setattr(wb.wb, "_PENDING_CHECK_S", -1)      # due at once
    wb.replies.append(Reply(429, {"error_code": "TOO_MANY_REQUESTS", "message": "slow down"}))
    r = wb.client.get("/api/webull/depth?symbol=AAPL")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "token_pending"
    monkeypatch.setattr(wb.wb, "_PENDING_CHECK_S", 10)
    wb.client.get("/api/webull/depth?symbol=AAPL")
    assert len(wb.sent) == 1                   # the failed check counts as a check


def test_level_one_entitlement_is_learned_not_shown_as_an_error(wb):
    _ready(wb)
    refusal = Reply(417, {"error_code": "ILLEGAL_PARAMETER", "message": "depth not more than 1"})
    wb.replies += [refusal, Reply(200, _book(1, orders=False))]
    d = wb.client.get("/api/webull/depth?symbol=AAPL&depth=10").json()
    assert d["levels"] == 1 and d["depth_requested"] == 10
    assert [c["params"]["depth"] for c in wb.sent] == ["10", "1"]
    assert [c["params"]["category"] for c in wb.sent] == ["US_STOCK", "US_STOCK"]
    # The next symbol asks for one level straight away.
    wb.replies.append(Reply(200, {**_book(1, orders=False), "symbol": "MSFT"}))
    wb.client.get("/api/webull/depth?symbol=MSFT&depth=20")
    assert wb.sent[-1]["params"]["depth"] == "1" and len(wb.sent) == 3
    # The overnight session has its own entitlement.
    wb.replies.append(Reply(200, _book(5)))
    wb.client.get("/api/webull/depth?symbol=AAPL&depth=5&overnight=true")
    assert wb.sent[-1]["params"]["depth"] == "5"


# ── A token ends ─────────────────────────────────────────────────────────────

def test_a_token_past_its_date_is_not_sent_and_the_panel_is_told(wb):
    import time
    _ready(wb, expires_at=int(time.time() * 1000) - 1000)
    r = wb.client.get("/api/webull/depth?symbol=AAPL")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "token_missing"
    assert "expired" in r.json()["detail"]["message"]
    assert wb.sent == []                                     # nothing sent with a dead token
    assert wb.wb.load_token()["status"] == "EXPIRED"
    assert wb.client.get("/api/webull/status").json()["token"]["status"] == "EXPIRED"


def test_status_says_how_long_the_token_has_left(wb):
    import time
    _ready(wb, expires_at=int((time.time() + 2 * 86400) * 1000))
    left = wb.client.get("/api/webull/status").json()["token"]["expires_in_s"]
    assert 2 * 86400 - 60 < left <= 2 * 86400
    assert wb.sent == []                                     # checked a moment ago: no call


def test_an_old_status_is_read_again_and_an_ended_token_is_recorded(wb, monkeypatch):
    _ready(wb)
    record = wb.wb.load_token()
    record["checked_at"] -= 7 * 3600
    wb.wb._token_file().write_text(json.dumps(record))
    wb.replies.append(Reply(200, {"token": TOKEN, "expires_at": 0, "status": "INVALID"}))
    assert wb.client.get("/api/webull/status").json()["token"]["status"] == "INVALID"
    assert wb.sent[0]["url"].endswith("/auth/tokens/check")
    r = wb.client.get("/api/webull/depth?symbol=AAPL")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "token_missing" and len(wb.sent) == 1


def test_trades_name_an_ended_token_the_same_way(wb):
    _ready(wb)
    wb.replies.append(Reply(401, {"error_code": "INVALID_TOKEN", "message": "Header x-access-token is missing or invalid."}))
    r = wb.client.get("/api/webull/ticks?symbol=AAPL&count=5")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "token_missing"
    assert wb.wb.load_token()["status"] == "INVALID"
    # Not cached: the moment a new token is confirmed the tape must work.
    _ready(wb)
    wb.replies.append(Reply(200, {"symbol": "AAPL", "result": [
        {"time": "1791474273985", "price": "109.17", "volume": "119", "side": "B", "trading_session": "RTH"}]}))
    r = wb.client.get("/api/webull/ticks?symbol=AAPL&count=5")
    assert r.status_code == 200 and r.json()["trades"] == [
        {"t": 1791474273985, "price": 109.17, "size": 119.0, "side": "B", "session": "RTH"}]


def test_the_entitlement_end_date_is_counted_down_and_a_bad_one_is_named(wb, monkeypatch):
    from datetime import date, timedelta
    monkeypatch.setattr(wb.wb.config, "WEBULL_SUBSCRIPTION_ENDS", "")
    assert wb.client.get("/api/webull/status").json()["subscription"] is None      # not written down
    soon = (date.today() + timedelta(days=9)).isoformat()
    monkeypatch.setattr(wb.wb.config, "WEBULL_SUBSCRIPTION_ENDS", soon)
    assert wb.client.get("/api/webull/status").json()["subscription"] == {"ends": soon, "days_left": 9, "error": None}
    monkeypatch.setattr(wb.wb.config, "WEBULL_SUBSCRIPTION_ENDS", "10/08/2027")
    sub = wb.client.get("/api/webull/status").json()["subscription"]
    assert sub["days_left"] is None and "YYYY-MM-DD" in sub["error"]                # not guessed at


def test_a_refusal_after_the_end_date_says_the_date(wb, monkeypatch):
    from datetime import date, timedelta
    gone = (date.today() - timedelta(days=1)).isoformat()
    monkeypatch.setattr(wb.wb.config, "WEBULL_SUBSCRIPTION_ENDS", gone)
    _ready(wb)
    wb.replies.append(Reply(403, {"error_code": "MARKET_DATA_NOT_SUBSCRIBED", "message": "no permission"}))
    r = wb.client.get("/api/webull/depth?symbol=AAPL")
    assert r.status_code == 403 and gone in r.json()["detail"]["message"]


# ── Verification lock (417 VERIFY_FAILURE_EXCEED_LIMIT) ─────────────────────

_LOCKED = Reply(417, {"error_code": "VERIFY_FAILURE_EXCEED_LIMIT",
                      "message": "Your verification have failed 5 times in total, please stop "
                                 "your program and retry login."})


def test_a_verification_lock_stops_every_call_to_webull(wb):
    wb.replies.append(_LOCKED)
    r = wb.client.post("/api/webull/token")
    assert r.status_code == 423 and r.json()["detail"]["code"] == "verify_locked"
    assert len(wb.sent) == 1
    # Neither button, nor the panel's own polling of a pending token, reaches Webull now.
    _ready(wb, "PENDING")
    assert wb.client.post("/api/webull/token").status_code == 423
    assert wb.client.post("/api/webull/token/check").status_code == 423
    d = wb.client.get("/api/webull/depth?symbol=AAPL")
    assert d.status_code == 409 and d.json()["detail"]["code"] == "verify_locked"
    assert len(wb.sent) == 1
    lock = wb.client.get("/api/webull/status").json()["verify_lock"]
    assert lock and lock["until"] - lock["since"] == wb.wb._VERIFY_LOCK_S
    assert TOKEN not in json.dumps(lock)


def test_the_lock_lifts_after_its_time_and_a_good_token_clears_it(wb, monkeypatch):
    wb.replies.append(_LOCKED)
    wb.client.post("/api/webull/token")
    monkeypatch.setattr(wb.wb, "_VERIFY_LOCK_S", 0)          # the hour has passed
    assert wb.client.get("/api/webull/status").json()["verify_lock"] is None
    wb.replies.append(Reply(200, {"token": TOKEN, "expires_at": FAR, "status": "PENDING"}))
    assert wb.client.post("/api/webull/token").status_code == 200
    assert not wb.wb._lock_file().exists()


def test_another_417_is_not_taken_for_the_lock(wb):
    wb.replies.append(Reply(417, {"error_code": "PARAM_ERROR", "message": "bad"}))
    r = wb.client.post("/api/webull/token")
    assert r.status_code == 417 and r.json()["detail"]["code"] == "upstream"
    assert wb.client.get("/api/webull/status").json()["verify_lock"] is None
