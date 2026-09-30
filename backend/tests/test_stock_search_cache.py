"""Cost policy of /api/stock/search.

Every keystroke in global search used to cost 1–4 Yahoo calls (yf.Search,
the .BK probe, then two REST fallbacks that hit the same endpoint), with no
cache. These pin the cheaper order: cache → one yf.Search → one REST call.
"""
import pytest

import routers.stock as st


class _Hit:
    def __init__(self, symbol, name="X"):
        self.symbol, self.short_name, self.long_name = symbol, name, name
        self.exchange, self.quote_type = "NMS", "EQUITY"


class _Resp:
    def __init__(self, quotes=None, fail=False):
        self._quotes, self._fail = quotes or [], fail

    def raise_for_status(self):
        if self._fail:
            raise RuntimeError("503")

    def json(self):
        return {"finance": {"result": [{"quotes": self._quotes}]}}


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    for c in (st._search_cache, st._search_last_good, st._search_down, st._probe_cache):
        c.clear()
    calls = {"yf": [], "rest": 0}

    def fake_search(q, max_results=10):
        calls["yf"].append(q)
        if q.upper().endswith(".BK"):
            return [_Hit(q.upper(), f"{q[:-3].upper()}_THAI")] if q.upper() == "BH.BK" else []
        return [_Hit(q.upper())]

    monkeypatch.setattr(st.market_data, "search", fake_search)
    monkeypatch.setattr(st.requests, "get", lambda *a, **k: calls.__setitem__("rest", calls["rest"] + 1) or _Resp())
    yield calls


def test_repeat_and_case_variants_hit_the_cache(clean):
    st.stock_search("aapl")
    st.stock_search("AAPL")
    st.stock_search("  Aapl ")
    # one search + one .BK probe, once
    assert clean["yf"] == ["aapl", "AAPL.BK"]
    assert clean["rest"] == 0


def test_bk_probe_is_cached_per_ticker_and_inserted(clean):
    out = st.stock_search("bh")
    assert [r["symbol"] for r in out] == ["BH.BK", "BH"]  # Thai wins the clash
    assert out[0]["display_symbol"] == "BH" and out[0]["display_name"] == "THAI"
    st._search_cache.clear()
    st.stock_search("BH")
    assert clean["yf"].count("BH.BK") == 1


def test_confirmed_empty_is_cached(clean, monkeypatch):
    monkeypatch.setattr(st.market_data, "search", lambda q, max_results=10: clean["yf"].append(q) or [])
    assert st.stock_search("zzqq xx") == []
    assert st.stock_search("zzqq xx") == []
    assert clean["rest"] == 1  # one REST check, then cached as a real absence


def test_outage_is_not_cached_long_and_serves_last_good(clean, monkeypatch):
    st.stock_search("msft")
    st._search_cache.clear()  # pretend the 6h entry expired

    def boom(q, max_results=10):
        raise RuntimeError("down")

    monkeypatch.setattr(st.market_data, "search", boom)
    monkeypatch.setattr(st.requests, "get", lambda *a, **k: _Resp(fail=True))
    assert [r["symbol"] for r in st.stock_search("msft")][0] == "MSFT"
    assert st._search_cache.get("msft") is None
    assert st._search_down.get("msft") is True
    # new query during the outage: [] and no long-lived entry
    assert st.stock_search("nvda") == []
    assert st._search_cache.get("nvda") is None


def test_resolve_bare_thai_ticker(clean, monkeypatch):
    def fake(q, max_results=10):
        q = q.upper()
        if q == "CPALL":
            return [_Hit("CPALLX")]  # Yahoo relevance never returns the .BK line
        if q == "CPALL.BK":
            return [_Hit("CPALL.BK")]
        if q == "BH":
            return [_Hit("BH")]
        if q == "BH.BK":
            return [_Hit("BH.BK")]
        return []

    monkeypatch.setattr(st.market_data, "search", fake)
    assert st.resolve_symbol("cpall") == "CPALL.BK"
    assert st.resolve_symbol("BH") == "BH.BK"  # Thai beats a same-name US listing
    assert st.resolve_symbol("AAPL") == "AAPL"
    assert st.resolve_symbol("PTT.BK") == "PTT.BK"  # explicit suffix is left alone
    assert st.resolve_symbol("^GSPC") == "^GSPC"
    assert st.resolve_symbol("NOPE") == "NOPE"
