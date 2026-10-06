"""Op-log sync (sync/oplog.py): two devices, one shared folder, both edit.

Each test builds two real portfolio DBs with the production schema and moves
ops between them through a temp "cloud" folder — the same path Drive gives.
"""
import json
import time
import uuid

import pytest

import db
from sync import oplog


def _make_db(path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", path)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema()
    db.init_alerts_schema(); db.init_sync_layer(); db.init_audit_layer()
    db.init_oplog_layer()
    return _conn(path)


def _conn(path):
    c = db.connect(path)
    c.execute("PRAGMA foreign_keys = ON")  # as the app's get_db() does
    return c


@pytest.fixture()
def pair(tmp_path, monkeypatch):
    a = _make_db(tmp_path / "a.db", monkeypatch)
    root = tmp_path / "cloud" / "oplog"
    root.mkdir(parents=True)
    aid = "acct-1"
    with _w(a):  # pre-op-log data, then B starts as a copy of A (adopt_db_copy)
        a.execute("UPDATE _sync_guard SET active=1")
        a.execute("INSERT INTO portfolio_accounts(id,name,currency) VALUES(?,?,?)", (aid, "Acct", "THB"))
        a.execute("UPDATE _sync_guard SET active=0")
    b = _conn(tmp_path / "b.db")
    a.backup(b)
    yield a, b, root, aid
    a.close(); b.close()


class _w:
    """commit-on-exit helper for a raw connection"""
    def __init__(self, c): self.c = c
    def __enter__(self): return self.c
    def __exit__(self, et, *_):
        (self.c.commit if et is None else self.c.rollback)()


def _trade(c, aid, symbol="PTT.BK", vol=100.0, price=10.0):
    tid = str(uuid.uuid4())
    with _w(c):
        c.execute("INSERT INTO trades(id,account_id,symbol,date_entry,price_entry,volume) VALUES(?,?,?,?,?,?)",
                  (tid, aid, symbol, "2026-09-27", price, vol))
    return tid


def _set(c, tid, **kv):
    with _w(c):
        sets = ", ".join(f"{k}=?" for k in kv)
        c.execute(f"UPDATE trades SET {sets} WHERE id=?", (*kv.values(), tid))


def _row(c, tid):
    r = c.execute("SELECT * FROM trades WHERE id=?", (tid,)).fetchone()
    return dict(r) if r else None


def _round(a, b, root):
    """Both devices sync twice — enough for every op to reach everyone."""
    for _ in range(2):
        oplog.sync_once(a, "A", root)
        oplog.sync_once(b, "B", root)


def _open(c):
    return c.execute("SELECT COUNT(*) FROM sync_conflicts WHERE resolved_at IS NULL").fetchone()[0]


def test_insert_on_one_device_reaches_the_other(pair):
    a, b, root, aid = pair
    tid = _trade(a, aid, vol=100)
    _round(a, b, root)
    assert _row(b, tid) == _row(a, tid)
    assert oplog.fingerprint(a) == oplog.fingerprint(b)
    assert _open(a) == _open(b) == 0


def test_both_devices_edit_in_turn_without_conflict(pair):
    a, b, root, aid = pair
    tid = _trade(a, aid, vol=100)
    _round(a, b, root)
    _set(b, tid, volume=200)          # B edits after seeing A's insert
    _round(a, b, root)
    _set(a, tid, note="checked")      # A edits after seeing B's edit
    _round(a, b, root)
    assert _row(a, tid)["volume"] == 200 and _row(a, tid)["note"] == "checked"
    assert _row(a, tid) == _row(b, tid)
    assert _open(a) == _open(b) == 0


def test_concurrent_edits_converge_and_are_flagged_on_both(pair):
    a, b, root, aid = pair
    tid = _trade(a, aid, vol=100)
    _round(a, b, root)
    _set(a, tid, volume=111)          # both offline, same row
    oplog.flush(a, "A")
    time.sleep(0.01)
    _set(b, tid, volume=222)          # B edits later → B's op wins everywhere
    oplog.flush(b, "B")
    _round(a, b, root)
    assert _row(a, tid)["volume"] == _row(b, tid)["volume"] == 222
    assert _row(a, tid) == _row(b, tid)
    ca, cb = oplog.conflicts(a), oplog.conflicts(b)
    assert len(ca) == len(cb) == 1 and ca[0]["id"] == cb[0]["id"]
    assert ca[0]["other_row"]["volume"] == 111  # the losing edit is kept for review


def test_resolving_on_one_device_restores_the_loser_everywhere(pair):
    a, b, root, aid = pair
    tid = _trade(a, aid, vol=100)
    _round(a, b, root)
    _set(a, tid, volume=111); oplog.flush(a, "A")
    time.sleep(0.01)
    _set(b, tid, volume=222); oplog.flush(b, "B")
    _round(a, b, root)
    cid = oplog.conflicts(a)[0]["id"]
    oplog.resolve(a, "A", cid, "other")   # the user wants A's 111 back
    _round(a, b, root)
    assert _row(a, tid)["volume"] == _row(b, tid)["volume"] == 111
    assert _open(a) == _open(b) == 0


def test_delete_travels_and_does_not_come_back(pair):
    a, b, root, aid = pair
    tid = _trade(a, aid)
    _round(a, b, root)
    with _w(b):
        b.execute("DELETE FROM trades WHERE id=?", (tid,))
    _round(a, b, root)
    assert _row(a, tid) is None and _row(b, tid) is None
    _round(a, b, root)
    assert _row(a, tid) is None


def test_applying_peer_ops_does_not_echo_them_back(pair):
    a, b, root, aid = pair
    _trade(a, aid)
    _round(a, b, root)
    assert b.execute("SELECT COUNT(*) FROM sync_oplog WHERE device='B'").fetchone()[0] == 0
    assert b.execute("SELECT COUNT(*) FROM sync_pending").fetchone()[0] == 0


def test_replay_is_idempotent(pair):
    a, b, root, aid = pair
    tid = _trade(a, aid)
    _round(a, b, root)
    b.execute("DELETE FROM sync_peer_seq")  # forget progress → re-read everything
    b.commit()
    got = oplog.pull(b, "B", root)
    assert got["applied"] == 0 and got["dup"] >= 1
    assert _row(a, tid) == _row(b, tid)


def test_missing_parent_is_waited_for(pair, tmp_path, monkeypatch):
    """B's edit of A's row can reach C before A's own insert does (Drive
    uploads files independently). C must not treat that as a conflict."""
    a, b, root, aid = pair
    c = _make_db(tmp_path / "c.db", monkeypatch)
    with _w(c):
        c.execute("UPDATE _sync_guard SET active=1")
        c.execute("INSERT INTO portfolio_accounts(id,name,currency) VALUES(?,?,?)", (aid, "Acct", "THB"))
        c.execute("UPDATE _sync_guard SET active=0")
    tid = _trade(a, aid, vol=100)
    oplog.sync_once(a, "A", root)
    oplog.sync_once(b, "B", root)
    _set(b, tid, volume=300)
    oplog.sync_once(b, "B", root)
    hidden = list((root / "A").glob("*.jsonl"))
    for f in hidden:
        f.rename(f.with_suffix(".hold"))
    got = oplog.pull(c, "C", root)
    assert got["deferred"] >= 1 and _row(c, tid) is None
    for f in hidden:
        f.with_suffix(".hold").rename(f)
    oplog.pull(c, "C", root)
    assert _row(c, tid)["volume"] == 300 and _open(c) == 0
    c.close()


def test_status_reports_divergence_when_same_ops_give_different_data(pair):
    a, b, root, aid = pair
    _trade(a, aid)
    _round(a, b, root)
    assert all(p["state"] == "in_sync" for p in oplog.status(a, "A", root)["peers"])
    with _w(b):  # a write that bypasses capture — what a broken merge would do
        b.execute("UPDATE _sync_guard SET active=1")
        b.execute("UPDATE trades SET volume=999")
        b.execute("UPDATE _sync_guard SET active=0")
    oplog.publish_state(b, "B", root)
    st = oplog.status(a, "A", root)
    assert st["diverged"] and st["peers"][0]["state"] == "DIVERGED"


def test_exported_files_are_never_rewritten(pair):
    a, b, root, aid = pair
    _trade(a, aid)
    oplog.sync_once(a, "A", root)
    first = {f.name: f.read_text(encoding="utf-8") for f in (root / "A").glob("*.jsonl")}
    _trade(a, aid, symbol="SCB.BK")
    oplog.sync_once(a, "A", root)
    now = {f.name: f.read_text(encoding="utf-8") for f in (root / "A").glob("*.jsonl")}
    assert all(now[n] == t for n, t in first.items()) and len(now) == len(first) + 1
    ops = [json.loads(l) for f in sorted((root / "A").glob("*.jsonl")) for l in f.read_text().splitlines()]
    assert [o["seq"] for o in ops] == list(range(1, len(ops) + 1))


def test_device_id_lives_beside_the_db_not_inside_it(tmp_path, monkeypatch):
    monkeypatch.delenv("OPLOG_DEVICE_ID", raising=False)
    p = tmp_path / "x.db"
    first = oplog.device_id(p)
    assert first == oplog.device_id(p)
    assert (tmp_path / ".oplog_device_x").read_text() == first
    assert oplog.device_id(tmp_path / "y.db") != first


def test_foreign_key_chain_arrives_in_order(pair):
    """An option trade references its contract; the peer must receive the
    contract first even though both land in one batch."""
    a, b, root, aid = pair
    with _w(a):
        a.execute("INSERT INTO option_contracts(contract_id,occ_symbol,underlying,expiry,strike,option_type) "
                  "VALUES('c1','INTC  260424C00070000','INTC','2026-04-24',70,'call')")
        a.execute("INSERT INTO option_trades(trade_id,contract_id,account_id,trade_date,action,side,quantity,price) "
                  "VALUES('t1','c1',?,'2026-04-08','OPEN','BUY',10,1.1)", (aid,))
    _round(a, b, root)
    assert b.execute("SELECT contract_id FROM option_trades WHERE trade_id='t1'").fetchone()[0] == "c1"
    assert _open(b) == 0


def test_composite_key_rows_and_cascade_delete(pair):
    a, b, root, aid = pair
    with _w(a):
        a.execute("INSERT INTO pin_groups(id,name) VALUES('g1','G')")
        a.execute("INSERT INTO pinned_assets(id,symbol,group_id) VALUES('p1','NVDA','g1')")
        a.execute("INSERT INTO pin_tags(id,name) VALUES('t1','ai')")
        a.execute("INSERT INTO pinned_asset_tags(asset_id,tag_id) VALUES('p1','t1')")
    _round(a, b, root)
    assert b.execute("SELECT COUNT(*) FROM pinned_asset_tags WHERE asset_id='p1' AND tag_id='t1'").fetchone()[0] == 1
    with _w(b):
        b.execute("DELETE FROM pinned_assets WHERE id='p1'")  # cascades the tag link
    _round(a, b, root)
    for c in (a, b):
        assert c.execute("SELECT COUNT(*) FROM pinned_assets WHERE id='p1'").fetchone()[0] == 0
        assert c.execute("SELECT COUNT(*) FROM pinned_asset_tags WHERE asset_id='p1'").fetchone()[0] == 0
    assert _open(a) == _open(b) == 0


def _iv(c, iv, created_at, snap="2026-10-02", sym="IXG"):
    with _w(c):
        c.execute("INSERT INTO iv_snapshots (symbol, snapshot_date, expiry, dte, spot, atm_strike,"
                  " iv_call, iv_put, iv_mid, source, created_at) VALUES (?,?,'2026-10-16',14,100,100,?,?,?,'yfinance',?)"
                  " ON CONFLICT(symbol, snapshot_date, expiry) DO UPDATE SET iv_mid=excluded.iv_mid,"
                  " iv_call=excluded.iv_call, iv_put=excluded.iv_put, created_at=excluded.created_at",
                  (sym, snap, iv, iv, iv, created_at))


def _iv_mid(c, sym="IXG"):
    return c.execute("SELECT iv_mid FROM iv_snapshots WHERE symbol=?", (sym,)).fetchone()[0]


def test_two_readings_of_one_iv_key_merge_without_a_conflict(pair):
    """2026-10-06: two machines read one chain at different times → 61 conflicts.
    Now the reading taken after that session's close wins on both, silently."""
    a, b, root, _ = pair
    _iv(a, 0.8906, "2026-10-02 20:32:00")   # Fri 16:32 ET — after the close
    _iv(b, 0.7522, "2026-10-02 17:06:00")   # Fri 13:06 ET — mid-session, but B's op is newer
    _round(a, b, root)
    assert _iv_mid(a) == _iv_mid(b) == 0.8906
    assert _open(a) == _open(b) == 0


def test_between_two_post_close_readings_the_later_one_wins_everywhere(pair):
    a, b, root, _ = pair
    _iv(a, 0.50, "2026-10-03 10:48:00", sym="SPY")   # Saturday — later
    _iv(b, 0.40, "2026-10-02 20:10:00", sym="SPY")   # Friday after close
    _round(a, b, root)
    assert _iv_mid(a, "SPY") == _iv_mid(b, "SPY") == 0.50
    assert _open(a) == _open(b) == 0


def test_an_edited_row_in_another_table_still_opens_a_conflict(pair):
    """The reading rule is for iv_snapshots only — a user edit keeps its review."""
    a, b, root, aid = pair
    tid = _trade(a, aid, vol=100)
    _round(a, b, root)
    _set(a, tid, volume=200)
    _set(b, tid, volume=300)
    _round(a, b, root)
    assert _open(a) == _open(b) == 1
