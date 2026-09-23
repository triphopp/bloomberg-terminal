"""Network-free regression and scale tests for shared watchlist I/O."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from collections import Counter
import sqlite3
import threading
import time

import numpy as np
import pandas as pd
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from fastapi import FastAPI

from market_requests import MarketRequests, collect
import market_snapshots as snapshots
import routers.watchlist_signals as signals
import routers.stock as stock
import routers.pins as pins
import routers.polymarket_stock as pm


@pytest.fixture
def coordinator(monkeypatch):
    service = MarketRequests(workers=4)
    monkeypatch.setattr(snapshots, 'market_requests', service)
    monkeypatch.setattr(pm, 'market_requests', service)
    signals._cache.clear()
    stock._stock_cache.clear()
    pm._events_cache.clear()
    pm._miss_cache.clear()
    yield service
    service.close()


def bars():
    close = np.linspace(70, 110, 520) + np.sin(np.arange(520))
    return pd.DataFrame({'Open': close, 'High': close + 2, 'Low': close - 2,
        'Close': close, 'Volume': np.full(520, 100000)},
        index=pd.date_range('2024-01-01', periods=520, freq='B'))


def test_singleflight_success_failure_and_warm_cache(coordinator):
    started, release = threading.Event(), threading.Event()
    calls = []
    def load():
        calls.append(1); started.set(); release.wait(2)
        return {'price': 12}
    first = coordinator.submit('yf', ('quote', 'A'), load, ttl=60)
    assert started.wait(1)
    joined = [coordinator.submit('yf', ('quote', 'A'), load, ttl=60) for _ in range(8)]
    assert all(f is first for f in joined)
    release.set()
    assert first.result(2) == {'price': 12}
    assert coordinator.get('yf', ('quote', 'A'), load, ttl=60) == {'price': 12}
    assert len(calls) == 1

    def fail():
        raise HTTPException(502, 'outage', headers={'Retry-After': '5'})
    failed = coordinator.submit('yf', ('quote', 'B'), fail, ttl=60)
    with pytest.raises(HTTPException) as err:
        failed.result(2)
    assert err.value.status_code == 502
    with pytest.raises(HTTPException):
        coordinator.get('yf', ('quote', 'B'), fail, ttl=60)
    assert coordinator.stats()['failed'] == 1


def test_cooldown_blocks_other_symbols_and_preserves_retry_after(coordinator):
    calls = []
    def fail():
        calls.append(1)
        raise HTTPException(429, 'limited', headers={'Retry-After': '17'})
    with pytest.raises(HTTPException):
        coordinator.get('yfinance', ('A',), fail, ttl=60)
    for sym in ('B', 'C', 'D'):
        with pytest.raises(HTTPException) as err:
            coordinator.get('yfinance', (sym,), fail, ttl=60)
        assert err.value.status_code == 429
        assert 15 <= int(err.value.headers['Retry-After']) <= 17
    assert len(calls) == 1
    assert coordinator.get('gamma', ('A',), lambda: 7, ttl=60) == 7


def test_bounded_queue_and_timeout_does_not_start_duplicate_work():
    service = MarketRequests(workers=2, max_pending=3)
    release = threading.Event()
    active, peak = 0, 0
    lock = threading.Lock()
    def load():
        nonlocal active, peak
        with lock:
            active += 1; peak = max(peak, active)
        release.wait(2)
        with lock: active -= 1
        return 42
    try:
        pending = {str(i): service.submit('yf', (i,), load, ttl=60) for i in range(3)}
        values, statuses = collect(pending, timeout=0.01)
        assert not values and all(s['status'] == 'pending' for s in statuses.values())
        assert service.submit('yf', (0,), load, ttl=60) is pending['0']
        with pytest.raises(HTTPException) as err:
            service.get('yf', (4,), load, ttl=60)
        assert err.value.status_code == 503
        release.set()
        assert [f.result(2) for f in pending.values()] == [42]*3
        assert peak == 2
    finally:
        release.set(); service.close()


def test_quote_chart_and_overlapping_lists_share_requests(coordinator, monkeypatch):
    calls = Counter()
    def quote(sym):
        calls[sym] += 1
        time.sleep(.002)
        return {'symbol': sym, 'regularMarketPrice': 123, 'preMarketPrice': 124}
    monkeypatch.setattr(snapshots, '_load_quote', quote)
    with ThreadPoolExecutor(3) as pool:
        a = pool.submit(signals.get_watchlist_quotes, 'A,B,C')
        b = pool.submit(signals.get_watchlist_quotes, 'B,C,D')
        chart = pool.submit(stock.stock_quote, 'b')
        assert a.result()['count'] == 3
        assert b.result()['count'] == 3
        assert chart.result()['preMarketPrice'] == 124
    assert calls == Counter(A=1, B=1, C=1, D=1)
    assert signals.get_watchlist_quotes('D,C,B,A')['count'] == 4
    assert sum(calls.values()) == 4


@pytest.mark.parametrize('count', [50, 200, 500, 1000])
def test_all_symbols_have_signals_and_reuse_bars(coordinator, monkeypatch, count):
    frame, calls = bars(), Counter()
    class Ticker:
        def __init__(self, symbol): self.symbol = symbol
        def history(self, **kwargs):
            calls[self.symbol] += 1
            assert kwargs['auto_adjust'] is True
            assert kwargs['period'] == '2y'
            return frame
    monkeypatch.setattr(snapshots.market_data, 'get_ticker', Ticker)
    symbols = [f'TEST{i:04}' for i in range(count)]
    found = {}
    for start in range(0, count, 60):
        batch = signals.get_watchlist_signals(','.join(symbols[start:start+60]))
        assert len(batch['statuses']) == batch['requestedCount']
        assert not batch['errors']
        found.update(batch['signals'])
    assert set(found) == set(symbols)
    # Changing list membership, order or group must not reload old symbols.
    signals.get_watchlist_signals(','.join(reversed(symbols[:50])))
    alert_frames = signals._download(symbols[:50])
    assert len(alert_frames) == 50
    assert calls == Counter({s: 1 for s in symbols})


def test_large_single_request_is_explicitly_rejected_not_silently_sliced():
    with pytest.raises(HTTPException) as err:
        signals.get_watchlist_signals(','.join(f'S{i}' for i in range(61)))
    assert err.value.status_code == 422
    assert 'split' in err.value.detail


def test_failed_symbol_has_status_without_poisoning_siblings(coordinator, monkeypatch):
    def quote(sym):
        if sym == 'BAD': raise HTTPException(404, 'unknown')
        return {'regularMarketPrice': 5}
    monkeypatch.setattr(snapshots, '_load_quote', quote)
    result = signals.get_watchlist_quotes('OK,BAD')
    assert result['quotes'] == {'OK': {'regularMarketPrice': 5}}
    assert result['statuses']['BAD']['httpStatus'] == 404
    assert result['requestedCount'] == 2


def test_history_period_alias_and_chart_sparkline_coalescing(coordinator, monkeypatch):
    calls = []
    class Ticker:
        def history(self, **kwargs):
            calls.append(kwargs)
            return bars()
    monkeypatch.setattr(snapshots.market_data, 'get_ticker', lambda s: Ticker())
    a = stock.stock_history('A', '3mo', '1d')
    b = stock.stock_history('A', '3m', '1d')
    spark = signals.get_watchlist_sparklines('A')
    assert a == b and spark['sparklines']['A'] == [v['close'] for v in a['quotes']]
    assert len(calls) == 1 and calls[0]['period'] == '3mo'
    stock.stock_history('A', '1y', '1d')
    assert len(calls) == 2  # incompatible lookback must not share a cache key


def test_pins_tag_read_is_constant_queries(monkeypatch):
    conn = sqlite3.connect(':memory:'); conn.row_factory = sqlite3.Row
    conn.executescript('CREATE TABLE pinned_assets(id TEXT, added_at TEXT, sort_order INTEGER DEFAULT 0); CREATE TABLE pinned_asset_tags(asset_id TEXT, tag_id TEXT);')
    conn.executemany('INSERT INTO pinned_assets(id, added_at) VALUES (?, ?)', [(str(i), '2026-09-23') for i in range(1000)])
    conn.executemany('INSERT INTO pinned_asset_tags VALUES (?, ?)', [(str(i), 'tag') for i in range(1000)])
    statements = []; conn.set_trace_callback(statements.append)
    @contextmanager
    def db(): yield conn
    monkeypatch.setattr(pins, 'get_db', db)
    try:
        result = pins.list_assets()
        assert len(result) == 1000 and all(r['tags'] == ['tag'] for r in result)
        assert len([s for s in statements if s.startswith('SELECT')]) == 2
    finally: conn.close()


def test_polymarket_outage_is_not_cached_as_no_market(coordinator, monkeypatch):
    class Response:
        ok = False; status_code = 503; headers = {}
    monkeypatch.setattr(pm._SESSION, 'get', lambda *a, **k: Response())
    with pytest.raises(HTTPException) as err:
        pm._stock_markets('AAPL')
    assert err.value.status_code == 502
    assert pm._miss_cache.get('AAPL') is None


def test_no_markets_does_not_fetch_spot(coordinator, monkeypatch):
    monkeypatch.setattr(pm, '_search_events', lambda *a: [])
    monkeypatch.setattr(pm, '_spot', lambda s: pytest.fail('Unneeded price fetch'))
    assert pm._stock_markets('NOMARKET')['events'] == []
    assert pm._stock_markets('NOMARKET')['events'] == []


def test_batch_api_response_contract(coordinator, monkeypatch):
    monkeypatch.setattr(snapshots, '_load_quote', lambda s: {'symbol': s, 'regularMarketPrice': 5})
    app = FastAPI(); app.include_router(signals.router)
    with TestClient(app) as client:
        res = client.get('/api/watchlist/quotes', params={'symbols':'a,A,b'})
        assert res.status_code == 200
        assert res.json()['requestedCount'] == 2
        assert set(res.json()['statuses']) == {'A', 'B'}


def test_portfolio_provider_and_rich_quote_share_leaf_io(coordinator, monkeypatch):
    from sources.yfinance_source import YFinanceSource
    from types import SimpleNamespace
    source = YFinanceSource()
    calls = Counter()
    class Ticker:
        @property
        def info(self):
            calls['info'] += 1
            time.sleep(.01)
            return {'regularMarketPrice': 100, 'regularMarketPreviousClose': 98,
                    'regularMarketChange': 2, 'shortName': 'Test'}
        @property
        def fast_info(self):
            calls['fast'] += 1
            time.sleep(.01)
            return SimpleNamespace(last_price=100, previous_close=97, regular_market_previous_close=98)
    monkeypatch.setattr(snapshots.market_data, 'get_ticker', lambda s: Ticker())
    with ThreadPoolExecutor(4) as pool:
        quote = pool.submit(stock.stock_quote, 'A')
        fast = pool.submit(source.get_fast_info, 'A')
        info = pool.submit(source.get_info, 'A')
        batch = pool.submit(source.download_quotes, ['A'])
        assert quote.result()['regularMarketPreviousClose'] == 98
        assert fast.result().last_price == 100
        assert info.result().regular_market_price == 100
        assert batch.result().quotes['A'].last_price == 100
    assert calls == Counter(info=1, fast=1)


def test_quote_can_use_fast_info_when_info_temporarily_unavailable(coordinator, monkeypatch):
    from types import SimpleNamespace
    class Ticker:
        @property
        def info(self): raise RuntimeError('temporary failure')
        fast_info = SimpleNamespace(last_price=100, previous_close=98)
    monkeypatch.setattr(snapshots.market_data, 'get_ticker', lambda s: Ticker())
    result = stock.stock_quote('FASTONLY')
    assert result['regularMarketPrice'] == 100
    assert result['regularMarketTime'] is None  # never invent a trade timestamp


def test_shared_alert_history_skips_unknown_symbol_without_dropping_valid_ones(coordinator, monkeypatch):
    class Ticker:
        def __init__(self, sym): self.sym = sym
        def history(self, **kwargs): return pd.DataFrame() if self.sym == 'BAD' else bars()
    monkeypatch.setattr(snapshots.market_data, 'get_ticker', Ticker)
    assert set(signals._download(['OK', 'BAD'])) == {'OK'}
