"""routers/risk.py _fetch_close_frame vs yf.download's global-state race.

yf.download() resets yfinance's module-global result dicts on every call, so a
concurrent download elsewhere can hand us a frame with none of our columns.
Such a frame must be retried and never cached (2026-09-27: SPY line vanished
from ANALYTICS INDEX for as long as the bad frame stayed cached).
"""
import pandas as pd
import pytest

from routers import risk


def _frame(cols, n=5):
    idx = pd.date_range("2026-09-01", periods=n, freq="D")
    close = pd.DataFrame({c: range(100, 100 + n) for c in cols}, index=idx)
    return pd.concat({"Close": close}, axis=1)  # yf.download's (Price, Ticker) columns


@pytest.fixture(autouse=True)
def _fresh_cache(monkeypatch):
    monkeypatch.setattr(risk, "_returns_cache", risk.TTLCache(ttl=300, maxsize=100))
    monkeypatch.setattr(risk.time, "sleep", lambda s: None)


def _script(monkeypatch, *frames):
    calls = []

    def fake_download(symbols, **kw):
        calls.append(list(symbols))
        return frames[min(len(calls), len(frames)) - 1]

    monkeypatch.setattr(risk.yf, "download", fake_download)
    return calls


def test_wiped_frame_is_retried(monkeypatch):
    calls = _script(monkeypatch, _frame(["DX=F"]).iloc[:, :0], _frame(["SPY"]))
    out = risk._fetch_close_frame(["SPY"], 274)
    assert list(out.columns) == ["SPY"] and len(calls) == 2


def test_wiped_frame_twice_is_not_cached(monkeypatch):
    calls = _script(monkeypatch, pd.DataFrame(), pd.DataFrame(), _frame(["SPY"]))
    assert risk._fetch_close_frame(["SPY"], 274).empty
    out = risk._fetch_close_frame(["SPY"], 274)  # next request fetches again
    assert list(out.columns) == ["SPY"] and len(calls) == 3


def test_good_frame_cached_once(monkeypatch):
    calls = _script(monkeypatch, _frame(["SPY"]))
    risk._fetch_close_frame(["SPY"], 274)
    risk._fetch_close_frame(["SPY"], 274)
    assert len(calls) == 1


def test_partial_frame_kept_without_retry(monkeypatch):
    """A holding with no Yahoo data must not make every call download twice."""
    calls = _script(monkeypatch, _frame(["SPY"]))
    out = risk._fetch_close_frame(["SPY", "DEAD.BK"], 252)
    risk._fetch_close_frame(["SPY", "DEAD.BK"], 252)
    assert list(out.columns) == ["SPY"] and len(calls) == 1
