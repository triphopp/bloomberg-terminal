"""Calibration behavior and API contracts, with no live market or database access."""
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from analytics import svi
from cache import TTLCache
from routers import options


def sample_slice(time=0.5, spot=100):
    k = np.linspace(-0.3, 0.3, 41)
    # Independent generation from the published Raw SVI formula.
    x = k - 0.03
    w = 0.02 + 0.09 * (-0.4 * x + np.sqrt(x * x + 0.15 ** 2))
    return [{"strike": float(spot * np.exp(v)), "ivPercent": float(100 * np.sqrt(t / time))}
            for v, t in zip(k, w)]


def evaluate(result, strikes):
    return 100 * np.sqrt(svi.raw_svi(np.log(np.array(strikes) / result["referencePrice"]),
                                   **result["parameters"]) / result["timeYears"])


def test_recovers_known_smile_in_percent_units():
    samples = sample_slice()
    fit = svi.fit_raw_svi(samples, 100, 0.5)
    assert fit["status"] == "ok"
    assert fit["rmseIvPct"] < 1e-5
    assert fit["usedPoints"] == 41
    assert fit["parameters"] == pytest.approx(
        {"a": 0.02, "b": 0.09, "rho": -0.4, "m": 0.03, "sigma": 0.15}, abs=1e-5)
    assert evaluate(fit, [r["strike"] for r in samples]) == pytest.approx(
        [r["ivPercent"] for r in samples], abs=1e-5)


def test_time_and_reference_do_not_change_fitted_iv():
    samples = sample_slice()
    baseline = svi.fit_raw_svi(samples, 100, 0.5)
    shifted = svi.fit_raw_svi(samples, 120, 1.5)
    strikes = [r["strike"] for r in samples]
    assert shifted["status"] == "ok"
    assert evaluate(shifted, strikes) == pytest.approx(evaluate(baseline, strikes), abs=1e-5)
    assert shifted["parameters"]["a"] == pytest.approx(3 * baseline["parameters"]["a"], abs=1e-5)
    assert shifted["parameters"]["m"] == pytest.approx(0.03 - np.log(1.2), abs=1e-5)


def test_noisy_quotes_with_one_outlier_keep_core_shape_and_positive_variance():
    samples = sample_slice()
    truth = np.array([r["ivPercent"] for r in samples])
    noise = np.random.default_rng(27).normal(0, 0.15, len(samples))
    for i, row in enumerate(samples):
        row["ivPercent"] += float(noise[i])
    samples[20]["ivPercent"] += 25
    fit = svi.fit_raw_svi(samples, 100, 0.5)
    assert fit["status"] == "ok"
    predicted = evaluate(fit, [r["strike"] for r in samples])
    assert np.sqrt(np.mean((predicted - truth) ** 2)) < 0.5
    assert fit["rmseIvPct"] > 2  # Displayed error must not hide the bad quote.
    assert np.all(svi.raw_svi(np.linspace(-20, 20, 1000), **fit["parameters"]) > 0)


def test_flat_smile_is_valid_without_artificial_curvature():
    samples = [{"strike": k, "ivPercent": 30} for k in range(70, 135, 5)]
    fit = svi.fit_raw_svi(samples, 100, 0.25)
    assert fit["status"] == "ok"
    assert fit["parameters"]["b"] == 0
    assert fit["rmseIvPct"] < 1e-10


@pytest.mark.parametrize("samples,spot,time,reason", [
    (sample_slice()[:7], 100, 0.5, "8 distinct"),
    ([{"strike": 100, "ivPercent": 30}] * 20, 100, 0.5, "1 available"),
    ([{"strike": 100 + n / 10, "ivPercent": 30} for n in range(10)], 100, 0.5, "too narrow"),
    (sample_slice(), 0, 0.5, "Positive reference"),
    (sample_slice(), 100, 0, "Positive reference"),
])
def test_unavailable_inputs_do_not_manufacture_parameters(samples, spot, time, reason):
    fit = svi.fit_raw_svi(samples, spot, time)
    assert fit["status"] == "unavailable"
    assert fit["parameters"] is None
    assert reason in fit["reason"]


def test_invalid_points_and_duplicates_do_not_inflate_sample_count():
    samples = sample_slice()
    dirty = samples + samples + [
        {"strike": -1, "ivPercent": 30}, {"strike": 100, "ivPercent": float("nan")},
        {"strike": 100, "ivPercent": 0.001}, {"strike": float("inf"), "ivPercent": 30}]
    fit = svi.fit_raw_svi(dirty, 100, 0.5)
    assert fit["usedPoints"] == 41
    assert fit["rmseIvPct"] < 1e-5


def test_optimizer_failure_is_reported_and_never_painted_as_fit(monkeypatch):
    monkeypatch.setattr(svi, "least_squares", lambda *a, **kw: SimpleNamespace(success=False))
    result = svi.fit_raw_svi(sample_slice(), 100, 0.5)
    assert result["status"] == "unavailable"
    assert "did not converge" in result["reason"]
    assert result["parameters"] is None


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(options, "_svi_fit_cache", TTLCache(ttl=300, maxsize=10))
    monkeypatch.setattr(options, "_options_chain_cache", TTLCache(ttl=300, maxsize=10))
    monkeypatch.setattr(options.market_data, "get_ticker",
                        lambda symbol: pytest.fail("Fit must not access Yahoo"))
    app = FastAPI()
    app.include_router(options.router)
    with TestClient(app) as client:
        yield client


def body():
    return {"referencePrice": 100, "timeYears": 0.5,
            "series": [{"name": "otm", "points": sample_slice()}]}


def test_fit_endpoint_and_cache_use_supplied_observations_only(client, monkeypatch):
    first = client.post("/api/options/smile-fit", json=body())
    assert first.status_code == 200
    result = first.json()
    assert result["coordinate"] == "log(K/S)"
    assert result["series"]["otm"]["rmseIvPct"] < 1e-5
    monkeypatch.setattr(options, "fit_raw_svi", lambda *a: pytest.fail("Expected cached fit"))
    assert client.post("/api/options/smile-fit", json=body()).json() == result


@pytest.mark.parametrize("override", [
    {"timeYears": 0}, {"referencePrice": -1}, {"timeYears": 11}, {"series": []},
    {"series": [{"name": "otm", "points": sample_slice()}] * 2},
    {"series": [{"name": "unknown", "points": []}]},
    {"series": [{"name": "otm", "points": [{"strike": 100, "ivPercent": 30}] * 2001}]},
    {"series": [{"name": "otm", "points": [{"strike": 0, "ivPercent": 30}]}]},
])
def test_endpoint_rejects_invalid_or_unbounded_requests(client, override):
    assert client.post("/api/options/smile-fit", json={**body(), **override}).status_code == 422


def test_chain_still_serves_explicit_expiry_after_threadpool_change(client, monkeypatch):
    expirations = ["2026-10-16", "2026-12-18"]
    quote = {"strike": 100, "impliedVolatility": 0.3, "bid": 1, "ask": 2}
    def chain(expiry):
        assert expiry == expirations[1]
        return SimpleNamespace(calls=pd.DataFrame([quote]), puts=pd.DataFrame([quote]))
    monkeypatch.setattr(options.market_data, "get_ticker", lambda symbol: SimpleNamespace(
        options=expirations, info={"regularMarketPrice": 102}, option_chain=chain))
    monkeypatch.setattr(options, "_record_iv_snapshot", lambda *args: None)
    response = client.get("/api/options/TEST?expiry=2026-12-18")
    assert response.status_code == 200
    result = response.json()
    assert (result["symbol"], result["expiry"], result["spot"]) == ("TEST", expirations[1], 102)
    assert result["expirations"] == expirations
    assert result["calls"][0]["impliedVolatility"] == 0.3
    assert result["freshness"]["source"]
