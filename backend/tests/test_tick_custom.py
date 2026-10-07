"""GET /api/tick-custom — the rows a user adds to the TICK DATA board (no network)."""
import pytest

import market_snapshots as ms
import routers.market as market


def _quote(symbol: str, price: float, change: float = 0.0) -> dict:
    return {"symbol": symbol, "regularMarketPrice": price, "regularMarketChange": change,
            "regularMarketChangePercent": change / (price - change) * 100 if price != change else 0.0,
            "regularMarketVolume": 1000, "marketCap": 5e9}


@pytest.fixture()
def quotes(monkeypatch):
    """A fake batched quote: the symbols listed answer, everything else is unknown."""
    calls: list[list[str]] = []
    book = {"IXG": _quote("IXG", 126.02, -1.69), "EURUSD=X": _quote("EURUSD=X", 1.11957, -0.006683),
            "DOGE-USD": _quote("DOGE-USD", 0.08825, -0.00803)}

    def fetch(chunk):
        calls.append(list(chunk))
        return [book[s] for s in chunk if s in book]

    monkeypatch.setattr(ms, "_v7_fetch", fetch)
    # No YTD lookup and no per-symbol fallback: both would reach yfinance.
    monkeypatch.setattr(market, "compute_ytd", lambda symbol, price: 0.0)
    monkeypatch.setattr(market, "_fetch_one_slow", lambda cfg: None)
    market._custom_cache.clear()
    yield calls
    market._custom_cache.clear()


def test_rows_come_back_in_the_order_asked_with_misses_named(quotes):
    out = market.get_tick_custom("ixg, nosuch ,EURUSD=X")
    assert [r["id"] for r in out["items"]] == ["IXG", "EURUSD=X"]
    assert [r["symbol"] for r in out["items"]] == ["IXG", "EURUSD=X"]
    assert out["missing"] == ["NOSUCH"]


def test_prices_keep_their_decimals(quotes):
    by = {r["id"]: r for r in market.get_tick_custom("EURUSD=X,DOGE-USD,IXG")["items"]}
    assert by["EURUSD=X"]["value"] == 1.11957          # not 1.12
    assert by["DOGE-USD"]["value"] == 0.08825          # not 0.09
    assert by["EURUSD=X"]["change"] == -0.006683
    assert by["IXG"]["value"] == 126.02


def test_only_tickers_are_asked_for_and_duplicates_once(quotes):
    out = market.get_tick_custom("IXG,ixg,<script>,a b,../etc,IXG")
    assert [r["id"] for r in out["items"]] == ["IXG"] and out["missing"] == []
    assert all(set(chunk) <= {"IXG"} for chunk in quotes)


def test_nothing_usable_is_an_empty_answer_without_a_request(quotes):
    assert market.get_tick_custom(" , ;;")["items"] == []
    assert quotes == []


def test_a_typo_is_not_asked_again_on_the_next_poll(quotes):
    market.get_tick_custom("IXG,NOSUCH")
    asked = len(quotes)
    again = market.get_tick_custom("NOSUCH,IXG")       # same set, any order
    assert again["missing"] == ["NOSUCH"] and len(quotes) == asked


def test_the_list_is_capped(quotes):
    many = ",".join(f"S{i}" for i in range(200))
    out = market.get_tick_custom(many)
    assert len(out["missing"]) == market._CUSTOM_MAX
