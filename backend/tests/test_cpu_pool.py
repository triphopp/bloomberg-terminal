"""cpu_pool (process pool for GIL-holding work) + the jobs moved onto it.

Does not use pytest's `tmp_path`: this box denies access to the system temp root.
"""

import os
import shutil
import sys
import tempfile
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path

import pytest

sys.path.insert(0, ".")

import cpu_pool


def test_runs_in_another_process():
    if cpu_pool.WORKERS == 0:
        pytest.skip("pool disabled by CPU_POOL_WORKERS=0")
    assert cpu_pool.run(os.getpid) != os.getpid()


def test_exceptions_propagate_like_inline():
    if cpu_pool.WORKERS == 0:
        pytest.skip("pool disabled by CPU_POOL_WORKERS=0")
    with pytest.raises(ValueError):
        cpu_pool.run(int, "not a number")


def test_workers_zero_runs_inline(monkeypatch):
    monkeypatch.setattr(cpu_pool, "WORKERS", 0)
    assert cpu_pool.run(os.getpid) == os.getpid()


def test_broken_pool_is_rebuilt_and_the_job_runs_inline(monkeypatch):
    class Broken:
        def submit(self, *a, **k):
            raise BrokenProcessPool("worker died")

        def shutdown(self, **k):
            pass

    monkeypatch.setattr(cpu_pool, "WORKERS", 2)
    monkeypatch.setattr(cpu_pool, "_pool", Broken())
    assert cpu_pool.run(os.getpid) == os.getpid()
    assert cpu_pool._pool is None  # dropped: the next call builds a fresh pool


def test_fetch_acm_parses_through_the_pool(monkeypatch):
    import routers.bonds as bonds

    calls = []

    class Resp:
        content = b"xls-bytes"

        def raise_for_status(self):
            pass

    monkeypatch.setattr(bonds.requests, "get", lambda *a, **k: Resp())
    monkeypatch.setattr(cpu_pool, "run", lambda fn, *args, **kw: calls.append((fn.__name__, args)) or {"ACMTP10": {}})
    assert bonds._fetch_acm() == {"ACMTP10": {}}
    assert calls == [("parse_acm_xls", (b"xls-bytes", bonds._DECOMP_START))]


@pytest.fixture()
def pm_db(monkeypatch):
    root = Path(__file__).parent / "_tmp"
    root.mkdir(exist_ok=True)
    scratch = Path(tempfile.mkdtemp(dir=root))
    try:
        import config
        import db

        monkeypatch.setattr(config, "DB_PATH", scratch / "test.db", raising=False)
        monkeypatch.setattr(db, "DB_PATH", scratch / "test.db", raising=False)
        import routers.polymarket as pm

        pm._init_polymarket_tables()
        yield db, pm
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def test_register_slugs_upserts_in_one_batch(pm_db):
    db, pm = pm_db
    markets = [
        {"slug": "a", "question": "A?", "conditionId": "c1", "volume": "10"},
        {"slug": "b", "question": None, "volume": 5},
        {"question": "no slug — skipped"},
    ]
    assert pm._register_slugs("fed", markets) == 2
    assert pm._register_slugs("fed", [{"slug": "a", "question": "A2?", "volume": 99}]) == 1
    with db.get_db() as conn:
        rows = conn.execute(
            "SELECT slug, question, volume FROM pm_slug_registry WHERE signal_type='fed' ORDER BY slug"
        ).fetchall()
    assert [tuple(r) for r in rows] == [("a", "A2?", 99.0), ("b", "", 5.0)]
