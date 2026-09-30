"""db.get_db() connection pool.

Every new connection re-parses the whole schema (~230 KB, 396 triggers) on its
first statement: 2.3 ms alone, 33-97 ms each when 3-8 threads open at once
(measured 2026-09-30). get_db() therefore reuses idle connections — these tests
pin the semantics that reuse must not change.
"""
import sqlite3
import threading

import pytest

import db


@pytest.fixture
def book(tmp_path, monkeypatch):
    target = tmp_path / "book.db"
    monkeypatch.setattr(db, "DB_PATH", target)
    db.close_pool()
    c = db.connect()
    c.execute("CREATE TABLE t (a INTEGER)")
    c.execute("CREATE TABLE ledger_dirty (id INTEGER PRIMARY KEY, account_id TEXT)")
    c.commit()
    c.close()
    yield target
    db.close_pool()


def test_sequential_calls_reuse_one_connection(book):
    with db.get_db() as a:
        first = id(a)
    with db.get_db() as b:
        assert id(b) == first
        assert b.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert isinstance(b.execute("SELECT 1 AS x").fetchone(), sqlite3.Row)


def test_nested_get_db_gets_its_own_connection(book):
    with db.get_db() as outer:
        outer.execute("INSERT INTO t VALUES (1)")
        with db.get_db() as inner:
            assert inner is not outer
            # inner commit must not commit the outer's pending write
        assert outer.in_transaction
    with db.get_db() as c:
        assert c.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 1


def test_exception_rolls_back_and_connection_is_clean_for_next_caller(book):
    with pytest.raises(RuntimeError):
        with db.get_db() as c:
            c.execute("INSERT INTO t VALUES (9)")
            raise RuntimeError("boom")
    with db.get_db() as c:
        assert not c.in_transaction
        assert c.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 0


def test_new_db_path_never_reuses_old_connection(book, tmp_path, monkeypatch):
    with db.get_db() as c:
        c.execute("INSERT INTO t VALUES (1)")
    other = tmp_path / "other.db"
    monkeypatch.setattr(db, "DB_PATH", other)
    c2 = db.connect()
    c2.execute("CREATE TABLE t (a INTEGER)")
    c2.commit()
    c2.close()
    with db.get_db() as c:
        assert c.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 0


def test_recreated_file_at_same_path_gets_a_fresh_connection(book):
    with db.get_db() as c:
        c.execute("INSERT INTO t VALUES (1)")
    db.close_pool()
    with db.get_db():
        pass                                   # leaves one pooled connection
    for suffix in ("", "-wal", "-shm"):
        p = book.with_name(book.name + suffix)
        if p.exists():
            p.unlink()
    c = db.connect()
    c.execute("CREATE TABLE t (a INTEGER)")
    c.commit()
    c.close()
    with db.get_db() as c:
        assert c.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 0


def test_ledger_flush_only_when_this_block_wrote(book, monkeypatch):
    import ledger
    calls = []
    monkeypatch.setattr(ledger, "flush_dirty", lambda conn, mark: calls.append(mark) or [])
    with db.get_db() as c:
        c.execute("INSERT INTO t VALUES (1)")
    assert len(calls) == 1
    with db.get_db() as c:                     # same connection, total_changes already > 0
        c.execute("SELECT * FROM t").fetchall()
    assert len(calls) == 1


def test_pool_is_bounded_and_can_be_disabled(book, monkeypatch):
    monkeypatch.setattr(db, "_POOL_MAX", 2)
    barrier = threading.Barrier(4)
    def use():
        with db.get_db():
            barrier.wait(5)
    ts = [threading.Thread(target=use) for _ in range(4)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert len(db._pool) == 2

    db.close_pool()
    monkeypatch.setattr(db, "_POOL_MAX", 0)
    with db.get_db() as c:
        pass
    assert db._pool == []
    with pytest.raises(sqlite3.ProgrammingError):
        c.execute("SELECT 1")                  # closed, as before pooling


def test_connection_from_another_thread_is_usable(book):
    with db.get_db():
        pass
    err = []
    def other():
        try:
            with db.get_db() as c:
                c.execute("SELECT COUNT(*) FROM t").fetchone()
        except Exception as e:   # pragma: no cover
            err.append(e)
    t = threading.Thread(target=other)
    t.start()
    t.join()
    assert not err
