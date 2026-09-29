"""Offline tests for routers/fiscal_ai.py — HTTP is mocked, no budget spent."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import config
from routers import fiscal_ai


class _Resp:
    def __init__(self, status=200, body=None, text=""):
        self.status_code, self._body, self.text = status, body or {}, text
        self.ok = status < 400

    def json(self):
        return self._body


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(fiscal_ai, "_USAGE_FILE", tmp_path / "usage.json")
    monkeypatch.setattr(fiscal_ai, "_cache", fiscal_ai.TTLCache(ttl=60))
    monkeypatch.setattr(fiscal_ai, "_fail", fiscal_ai.TTLCache(ttl=60))
    monkeypatch.setattr(config, "FISCAL_AI_API_KEY", "test-key-123")
    monkeypatch.setattr(config, "FISCAL_AI_DAILY_LIMIT", 2)
    calls = []

    def fake_get(url, params=None, timeout=None, headers=None):
        calls.append({"url": url, "params": params, "headers": headers})
        if params.get("ticker") == "NOPE":
            return _Resp(403, text="company not in free plan test-key-123")
        return _Resp(200, {"ok": True})

    monkeypatch.setattr(fiscal_ai._session, "get", fake_get)
    app = FastAPI()
    app.include_router(fiscal_ai.router)
    return TestClient(app), calls


def test_key_in_header_never_in_url(client):
    c, calls = client
    r = c.get("/api/fiscal/segments-kpis/v?period=quarterly")
    assert r.status_code == 200
    body = r.json()
    assert body["data"] == {"ok": True}
    assert body["source"]["endpoint"] == "/v2/company/segments-and-kpis"
    assert body["source"]["calls_used_today"] == 1
    call = calls[0]
    assert call["url"] == "https://api.fiscal.ai/v2/company/segments-and-kpis"
    assert call["params"] == {"ticker": "V", "periodType": "quarterly"}
    assert call["headers"]["X-Api-Key"] == "test-key-123"
    assert "apiKey" not in call["params"]


def test_cache_does_not_spend_budget(client):
    c, calls = client
    c.get("/api/fiscal/profile/V")
    c.get("/api/fiscal/profile/V")
    assert len(calls) == 1
    assert c.get("/api/fiscal/status").json()["calls_used"] == 1


def test_budget_exhausted(client):
    c, _ = client
    assert c.get("/api/fiscal/profile/V").status_code == 200
    assert c.get("/api/fiscal/profile/MA").status_code == 200
    r = c.get("/api/fiscal/profile/AAPL")
    assert r.status_code == 429 and "budget" in r.json()["detail"]


def test_upstream_error_redacts_key(client):
    c, _ = client
    r = c.get("/api/fiscal/profile/NOPE")
    assert r.status_code == 403
    assert "test-key-123" not in r.json()["detail"]


def test_validation(client, monkeypatch):
    c, calls = client
    assert c.get("/api/fiscal/bogus/V").status_code == 400
    assert c.get("/api/fiscal/income/V?period=weekly").status_code == 400
    assert c.get("/api/fiscal/transcript/V/Q3-26").status_code == 400
    assert c.get("/api/fiscal/profile/NYSE_V").status_code == 200
    assert calls[-1]["params"] == {"companyKey": "NYSE_V"}
    monkeypatch.setattr(config, "FISCAL_AI_API_KEY", "")
    r = c.get("/api/fiscal/profile/MA")
    assert r.status_code == 424 and "FISCAL_AI_API_KEY" in r.json()["detail"]
