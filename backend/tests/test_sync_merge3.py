"""
Three-way merge: stale peers are not conflicts, disjoint field edits both
survive, same-field edits still conflict, and derived tables are rebuilt from
fills instead of merged as running totals.

Shares the two-machine harness of test_sync.py.
"""
import importlib
import time
import uuid

import pytest


@pytest.fixture()
def cloud(tmp_path, monkeypatch):
    cloud_dir = tmp_path / "cloud"
    cloud_dir.mkdir()
    monkeypatch.setenv("SYNC_ENABLED", "true")
    monkeypatch.setenv("SYNC_DIR", str(cloud_dir))
    return cloud_dir


def _device(monkeypatch, tmp_path, name):
    monkeypatch.setenv("SYNC_DEVICE_ID", name)
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / f"{name}.db"))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_alerts_schema(); db.init_sync_layer()
    import sync.config as scfg
    importlib.reload(scfg)
    import sync.manager as mgr
    importlib.reload(mgr)
    import sync as pkg
    importlib.reload(pkg)
    return db, pkg


def _seed(db, aid):
    with db.get_db() as c:
        c.execute("INSERT INTO portfolio_accounts(id,name,country,currency) VALUES(?,?,?,?)",
                  (aid, "A", "TH", "THB"))


def _add_trade(db, aid, symbol, vol, note=""):
    tid = str(uuid.uuid4())
    with db.get_db() as c:
        c.execute(
            "INSERT INTO trades(id,account_id,symbol,date_entry,price_entry,volume,note) "
            "VALUES(?,?,?,?,?,?,?)",
            (tid, aid, symbol, "2026-06-01", 10.0, vol, note),
        )
    return tid


# ── the false-conflict case that motivated the base ──────────────────────────
def test_stale_peer_is_not_a_conflict(cloud, tmp_path, monkeypatch):
    """A device that has been offline for a week holds old copies of every row.
    Under 2-way LWW each of those rows reported as a conflict on every merge —
    they differ, and nothing said which side had actually changed."""
    aid = str(uuid.uuid4())

    db, sync = _device(monkeypatch, tmp_path, "MAC")
    _seed(db, aid)
    tid = _add_trade(db, aid, "PTT.BK", 1000)
    sync.push()

    # PC pulls (base recorded), then edits while MAC stays offline and stale
    db, sync = _device(monkeypatch, tmp_path, "PC")
    assert sync.pull()["status"] == "ok"
    time.sleep(0.05)
    with db.get_db() as c:
        c.execute("UPDATE trades SET volume=2000 WHERE id=?", (tid,))
    sync.push()

    # MAC's snapshot on the cloud is untouched, so this merge sees local(new)
    # vs remote(stale-but-equal-to-base) → local wins, silently.
    res = sync.pull()
    assert res["conflicts"] == 0, f"stale peer reported as conflict: {res}"
    with db.get_db() as c:
        assert c.execute("SELECT volume FROM trades WHERE id=?", (tid,)).fetchone()["volume"] == 2000


def test_repeated_pull_does_not_revert(cloud, tmp_path, monkeypatch):
    """The restart bug: pull once, get the right answer; pull again (or reopen
    the app, which pulls on startup) and a peer that never changed drags the
    old value back.

    Cause was one shared ancestor. After the first merge the base holds the
    MERGED value while the offline peer still holds the old one, so the peer
    reads as "changed" and local — now equal to the base — reads as
    "unchanged", handing the stale value the win on every subsequent pull.
    """
    aid = str(uuid.uuid4())

    db, sync = _device(monkeypatch, tmp_path, "MAC")
    _seed(db, aid)
    tid = _add_trade(db, aid, "COST.BK", 1000)
    sync.push()                                   # MAC's snapshot freezes here

    db, sync = _device(monkeypatch, tmp_path, "PC")
    sync.pull()
    time.sleep(0.05)
    with db.get_db() as c:                        # PC closes the trade
        c.execute("UPDATE trades SET volume=2000 WHERE id=?", (tid,))
    sync.push()

    for attempt in range(1, 4):                   # restart, restart, restart
        sync.pull()
        with db.get_db() as c:
            vol = c.execute("SELECT volume FROM trades WHERE id=?", (tid,)).fetchone()["volume"]
        assert vol == 2000, f"pull #{attempt} reverted to the stale peer's value ({vol})"


def test_disjoint_field_edits_both_survive(cloud, tmp_path, monkeypatch):
    """Row-level LWW threw away every field of the losing row. Field-level
    merge keeps each side's own edit — from the second time the two devices
    meet, since the first meeting is what records the peer's ancestor."""
    aid = str(uuid.uuid4())

    db, sync = _device(monkeypatch, tmp_path, "PC")
    _seed(db, aid)
    tid = _add_trade(db, aid, "AOT.BK", 100, note="orig")
    sync.push()

    db, sync = _device(monkeypatch, tmp_path, "MAC")
    sync.pull()
    sync.push()

    db, sync = _device(monkeypatch, tmp_path, "PC")
    sync.pull()                                  # first contact: records MAC's ancestor

    db, sync = _device(monkeypatch, tmp_path, "MAC")
    time.sleep(0.05)
    with db.get_db() as c:                       # MAC edits note only
        c.execute("UPDATE trades SET note='from mac' WHERE id=?", (tid,))
    sync.push()

    db, sync = _device(monkeypatch, tmp_path, "PC")
    time.sleep(0.05)
    with db.get_db() as c:                       # PC edits volume only
        c.execute("UPDATE trades SET volume=555 WHERE id=?", (tid,))
    res = sync.pull()

    with db.get_db() as c:
        row = c.execute("SELECT volume, note FROM trades WHERE id=?", (tid,)).fetchone()
    assert row["volume"] == 555, "PC's own field was overwritten"
    assert row["note"] == "from mac", "peer's field edit was dropped"
    assert res["conflicts"] == 0, "different fields are not a conflict"


def test_same_field_edit_still_conflicts(cloud, tmp_path, monkeypatch):
    aid = str(uuid.uuid4())

    db, sync = _device(monkeypatch, tmp_path, "PC")
    _seed(db, aid)
    tid = _add_trade(db, aid, "SCB.BK", 100)
    sync.push()

    db, sync = _device(monkeypatch, tmp_path, "MAC")
    sync.pull()
    time.sleep(0.05)
    with db.get_db() as c:
        c.execute("UPDATE trades SET volume=999 WHERE id=?", (tid,))
    sync.push()

    db, sync = _device(monkeypatch, tmp_path, "PC")
    time.sleep(0.05)
    with db.get_db() as c:
        c.execute("UPDATE trades SET volume=111 WHERE id=?", (tid,))
    res = sync.pull()
    assert res["conflicts"] >= 1, "same-field divergence must still be reported"
    assert list((cloud / "conflicts").glob("*.json")), "loser not preserved"


def test_millisecond_stamps(cloud, tmp_path, monkeypatch):
    """Two edits inside the same second must be orderable, or LWW has nothing
    to compare and the two devices can pick different winners."""
    aid = str(uuid.uuid4())
    db, _ = _device(monkeypatch, tmp_path, "PC")
    _seed(db, aid)
    tid = _add_trade(db, aid, "BBL.BK", 10)
    with db.get_db() as c:
        first = c.execute("SELECT updated_at FROM trades WHERE id=?", (tid,)).fetchone()[0]
        c.execute("UPDATE trades SET volume=20 WHERE id=?", (tid,))
        second = c.execute("SELECT updated_at FROM trades WHERE id=?", (tid,)).fetchone()[0]
    assert "." in first, f"stamp is not sub-second: {first}"
    assert second > first, f"same-second edits not orderable: {first} vs {second}"
    # sorts correctly against the pre-migration second-resolution format
    assert second > first.split(".")[0]


def test_merge_tie_break_is_device_independent():
    """Equal timestamps must resolve to the same value on both machines."""
    from sync.merge import merge_snapshots

    a = {"id": "1", "symbol": "X", "volume": 10, "updated_at": "2026-08-11 02:00:00.500"}
    b = {"id": "1", "symbol": "X", "volume": 20, "updated_at": "2026-08-11 02:00:00.500"}
    base = {"tables": {"trades": [{"id": "1", "symbol": "X", "volume": 1,
                                   "updated_at": "2026-08-10 00:00:00.000"}]}}

    pc, _, _ = merge_snapshots([{"tables": {"trades": [a]}}, {"tables": {"trades": [b]}}], base)
    mac, _, _ = merge_snapshots([{"tables": {"trades": [b]}}, {"tables": {"trades": [a]}}], base)
    assert pc["trades"][0]["volume"] == mac["trades"][0]["volume"], "devices diverge on a tie"


# ── derived tables ───────────────────────────────────────────────────────────
def test_paper_positions_rebuilt_not_merged(cloud, tmp_path, monkeypatch):
    """Both devices' fills must show up in the position book. Merging the
    running total instead would keep one device's quantity and drop the other's
    fills even though both fill rows survived."""
    import sync.config as scfg

    db, sync = _device(monkeypatch, tmp_path, "PC")
    assert "paper_positions" not in dict(scfg.SYNC_TABLES), \
        "paper_positions is a running aggregate — it must not be on the wire"

    acc = str(uuid.uuid4())
    with db.get_db() as c:
        c.execute("INSERT INTO paper_accounts(id,name,initial_balance) VALUES(?,?,?)",
                  (acc, "paper", 100000))
    _paper_buy(db, acc, "AAPL", 100, 10.0, "2026-08-01T00:00:00")
    sync.push()

    db, sync = _device(monkeypatch, tmp_path, "MAC")
    sync.pull()
    _paper_buy(db, acc, "AAPL", 50, 12.0, "2026-08-02T00:00:00")
    sync.push()

    db, sync = _device(monkeypatch, tmp_path, "PC")
    _paper_buy(db, acc, "AAPL", 30, 14.0, "2026-08-03T00:00:00")
    sync.pull()

    with db.get_db() as c:
        pos = c.execute("SELECT quantity, avg_cost FROM paper_positions "
                        "WHERE account_id=? AND symbol='AAPL'", (acc,)).fetchone()
    assert pos["quantity"] == 180, f"fills lost: expected 100+50+30, got {pos['quantity']}"
    # weighted average of all three fills, not just the winning device's
    assert round(pos["avg_cost"], 4) == round((100 * 10 + 50 * 12 + 30 * 14) / 180, 4)


def _paper_buy(db, account_id, symbol, qty, price, when):
    oid, fid = uuid.uuid4().hex[:12], uuid.uuid4().hex[:12]
    with db.get_db() as c:
        c.execute(
            "INSERT INTO paper_orders(id,account_id,symbol,side,order_type,quantity,"
            "status,filled_qty,filled_price,created_at,filled_at) "
            "VALUES(?,?,?,'buy','market',?, 'filled',?,?,?,?)",
            (oid, account_id, symbol, qty, qty, price, when, when),
        )
        c.execute("INSERT INTO paper_fills(id,order_id,quantity,price,commission,filled_at) "
                  "VALUES(?,?,?,?,0,?)", (fid, oid, qty, price, when))
        # mirror _execute_fill's incremental update so the pre-merge state is
        # what the app would really have
        row = c.execute("SELECT * FROM paper_positions WHERE account_id=? AND symbol=?",
                        (account_id, symbol)).fetchone()
        if row:
            nq = row["quantity"] + qty
            na = ((row["quantity"] * row["avg_cost"]) + (qty * price)) / nq
            c.execute("UPDATE paper_positions SET quantity=?, avg_cost=? WHERE id=?",
                      (round(nq, 8), round(na, 6), row["id"]))
        else:
            c.execute("INSERT INTO paper_positions(id,account_id,symbol,quantity,avg_cost) "
                      "VALUES(?,?,?,?,?)", (uuid.uuid4().hex[:12], account_id, symbol, qty, price))
