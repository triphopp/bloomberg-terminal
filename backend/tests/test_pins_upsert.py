"""One symbol = one pin: PUT /api/pins/by-symbol, dedupe migration, unique index.

Isolated temp DB per test (no network, no real portfolio.db).
"""
import importlib
import sqlite3

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "pins.db"))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db()
    db.init_sync_layer()
    import routers.pins as pins
    importlib.reload(pins)
    app = FastAPI()
    app.include_router(pins.router)
    client = TestClient(app)
    return client, db, tmp_path / "pins.db"


def _raw(path):
    c = sqlite3.connect(str(path))
    c.row_factory = sqlite3.Row
    return c


def _group(client, gid, name="G", order=0):
    r = client.post("/api/pins/groups", json={"id": gid, "name": name, "sort_order": order})
    assert r.status_code == 201


def _count(path, symbol=None):
    c = _raw(path)
    try:
        if symbol:
            return c.execute("SELECT COUNT(*) FROM pinned_assets WHERE symbol=?", (symbol,)).fetchone()[0]
        return c.execute("SELECT COUNT(*) FROM pinned_assets").fetchone()[0]
    finally:
        c.close()


def test_create_uses_deterministic_id_and_normalises_symbol(env):
    client, _, path = env
    _group(client, "a", "A")
    r = client.put("/api/pins/by-symbol/%20aapl%20", json={"group_id": "a", "comment": "hi", "buy_target": 150})
    assert r.status_code == 200
    j = r.json()
    assert j["action"] == "created"
    assert j["pin"]["id"] == "pin:AAPL" and j["pin"]["symbol"] == "AAPL"
    assert j["pin"]["group_id"] == "a" and j["pin"]["buy_target"] == 150 and j["pin"]["tags"] == []
    assert j["group"]["id"] == "a"


def test_move_keeps_one_row_and_preserves_fields(env):
    client, _, path = env
    _group(client, "a", "A", 0)
    _group(client, "b", "B", 1)
    client.put("/api/pins/by-symbol/AAPL", json={
        "group_id": "a", "comment": "keep me", "buy_target": 100, "sell_target": 200, "price_at_pin": 123.4})
    pid = client.get("/api/pins/assets").json()[0]["id"]
    client.post(f"/api/pins/tags", json={"id": "t1", "name": "core"})
    client.post(f"/api/pins/assets/{pid}/tags/t1")

    r = client.put("/api/pins/by-symbol/aapl", json={"group_id": "b"})
    j = r.json()
    assert j["action"] == "moved" and j["pin"]["id"] == pid and j["group"]["id"] == "b"
    assert _count(path, "AAPL") == 1
    p = j["pin"]
    assert (p["group_id"], p["comment"], p["buy_target"], p["sell_target"], p["price_at_pin"]) == ("b", "keep me", 100, 200, 123.4)
    assert p["tags"] == ["t1"]

    again = client.put("/api/pins/by-symbol/AAPL", json={"group_id": "b"}).json()
    assert again["action"] == "unchanged" and _count(path) == 1


def test_explicit_null_clears_target_but_omitted_keeps_it(env):
    client, _, _ = env
    _group(client, "a")
    client.put("/api/pins/by-symbol/MSFT", json={"group_id": "a", "buy_target": 1, "sell_target": 2})
    r = client.put("/api/pins/by-symbol/MSFT", json={"group_id": "a", "buy_target": None}).json()
    assert r["pin"]["buy_target"] is None and r["pin"]["sell_target"] == 2 and r["action"] == "updated"


def test_new_group_and_pin_in_one_call(env):
    client, _, path = env
    _group(client, "a", "A")
    r = client.put("/api/pins/by-symbol/NVDA", json={"new_group": {"name": "AI", "color": "#123456"}})
    j = r.json()
    assert j["action"] == "created" and j["group"]["name"] == "AI" and j["group"]["color"] == "#123456"
    assert j["pin"]["group_id"] == j["group"]["id"]
    assert len(client.get("/api/pins/groups").json()) == 2
    # moving an existing pin into a brand-new group
    m = client.put("/api/pins/by-symbol/NVDA", json={"new_group": {"name": "Chips"}}).json()
    assert m["action"] == "moved" and m["group"]["name"] == "Chips" and _count(path, "NVDA") == 1
    # same name again reuses the group instead of duplicating it
    n = client.put("/api/pins/by-symbol/AMD", json={"new_group": {"name": " chips "}}).json()
    assert n["group"]["id"] == m["group"]["id"]
    assert len(client.get("/api/pins/groups").json()) == 3


def test_both_or_blank_destination_is_rejected(env):
    client, _, _ = env
    _group(client, "a")
    assert client.put("/api/pins/by-symbol/X", json={"group_id": "a", "new_group": {"name": "n"}}).status_code == 422
    assert client.put("/api/pins/by-symbol/X", json={"new_group": {"name": "  "}}).status_code == 422
    assert client.put("/api/pins/by-symbol/X", json={"group_id": "nope"}).status_code == 404


def test_rolls_back_new_group_when_pin_write_fails(env):
    client, _, path = env
    _group(client, "a", "A")
    c = _raw(path)
    c.execute("CREATE TRIGGER boom BEFORE INSERT ON pinned_assets BEGIN SELECT RAISE(ABORT, 'disk full'); END")
    c.commit(); c.close()
    r = client.put("/api/pins/by-symbol/TSLA", json={"new_group": {"name": "Ghost"}})
    assert r.status_code == 500
    names = [g["name"] for g in client.get("/api/pins/groups").json()]
    assert names == ["A"], "the group insert must roll back with the failed pin insert"
    assert _count(path) == 0


def test_default_group_fallback_when_no_groups(env):
    client, _, path = env
    assert client.get("/api/pins/groups").json() == []
    j = client.put("/api/pins/by-symbol/SPY", json={}).json()
    assert j["action"] == "created" and j["group"]["id"] == "watchlist" and j["group"]["name"] == "Watchlist"
    # stale group id + no groups at all also falls back
    c = _raw(path); c.execute("DELETE FROM pinned_assets"); c.execute("DELETE FROM pin_groups"); c.commit(); c.close()
    j2 = client.put("/api/pins/by-symbol/QQQ", json={"group_id": "gone"}).json()
    assert j2["group"]["id"] == "watchlist"
    # with groups present and no destination, a new pin lands in the first group
    j3 = client.put("/api/pins/by-symbol/IWM", json={}).json()
    assert j3["group"]["id"] == "watchlist" and len(client.get("/api/pins/groups").json()) == 1


def test_post_and_import_cannot_create_duplicates(env):
    client, _, path = env
    _group(client, "a", "A")
    _group(client, "b", "B", 1)
    client.put("/api/pins/by-symbol/AAPL", json={"group_id": "a"})
    r = client.post("/api/pins/assets", json={"id": "x1", "symbol": "aapl", "group_id": "b"})
    assert r.status_code == 409
    imp = client.post("/api/pins/import", json={
        "groups": [], "assets": [
            {"id": "x2", "symbol": "AAPL", "group_id": "b"},
            {"id": "x3", "symbol": "GOOG", "group_id": "b"},
            {"id": "x4", "symbol": "goog", "group_id": "a"},
        ]}).json()
    assert imp["assets"] == 1 and imp["skipped"] == 2
    assert _count(path) == 2 and _count(path, "AAPL") == 1 and _count(path, "GOOG") == 1
    # re-importing the same row (same id) is still an idempotent REPLACE
    client.post("/api/pins/import", json={"groups": [], "assets": [{"id": "x3", "symbol": "GOOG", "group_id": "a"}]})
    assert _count(path, "GOOG") == 1


def test_unique_index_enforced(env):
    _, _, path = env
    c = _raw(path)
    c.execute("INSERT INTO pin_groups(id,name) VALUES('a','A')")
    c.execute("INSERT INTO pinned_assets(id,symbol,group_id) VALUES('1','AAPL','a')")
    with pytest.raises(sqlite3.IntegrityError):
        c.execute("INSERT INTO pinned_assets(id,symbol,group_id) VALUES('2','AAPL','a')")
    idx = {r[1] for r in c.execute("PRAGMA index_list(pinned_assets)")}
    assert {"ux_pa_symbol", "idx_pa_group_sort"} <= idx
    c.close()


def test_dedupe_migration_merges_and_is_idempotent(env):
    _, db, path = env
    c = _raw(path)
    c.execute("DROP INDEX ux_pa_symbol")
    c.execute("INSERT INTO pin_groups(id,name) VALUES('a','A'),('b','B')")
    c.execute("INSERT INTO pin_tags(id,name) VALUES('t1','one'),('t2','two')")
    ins = ("INSERT INTO pinned_assets(id,symbol,group_id,comment,buy_target,price_at_pin,updated_at) "
           "VALUES(?,?,?,?,?,?,?)")
    c.execute(ins, ("old", "AAPL", "a", "", None, None, "2026-01-01"))            # least info
    c.execute(ins, ("rich", "AAPL", "b", "my note", 100, None, "2026-02-01"))     # most info -> survives
    c.execute(ins, ("mid", "aapl ", "a", "", None, 55.0, "2026-03-01"))           # case/space variant
    c.execute(ins, ("solo", "MSFT", "a", "", None, None, "2026-01-01"))
    c.execute("INSERT INTO pinned_asset_tags(asset_id,tag_id) VALUES('old','t1'),('mid','t2'),('rich','t1')")
    c.commit()

    removed = db.dedupe_pinned_assets(c)
    c.commit()
    assert removed == 2
    rows = {r["symbol"]: r for r in c.execute("SELECT * FROM pinned_assets")}
    assert set(rows) == {"AAPL", "MSFT"}
    keep = rows["AAPL"]
    assert keep["id"] == "rich" and keep["group_id"] == "b" and keep["comment"] == "my note"
    assert keep["price_at_pin"] == 55.0, "missing field filled from a discarded duplicate"
    tags = {r[0] for r in c.execute("SELECT tag_id FROM pinned_asset_tags WHERE asset_id='rich'")}
    assert tags == {"t1", "t2"}
    assert c.execute("SELECT COUNT(*) FROM pinned_asset_tags WHERE asset_id IN ('old','mid')").fetchone()[0] == 0
    assert db.dedupe_pinned_assets(c) == 0  # idempotent
    c.close()


def test_dedupe_deletes_are_not_captured_for_sync(env):
    """Each device dedupes its own copy; a captured delete would remove the
    survivor another device chose."""
    _, db, path = env
    c = _raw(path)
    c.execute("DROP INDEX ux_pa_symbol")
    c.execute("INSERT INTO pin_groups(id,name) VALUES('a','A')")
    c.execute("INSERT INTO pinned_assets(id,symbol,group_id,comment) VALUES('p1','X','a','n'),('p2','X','a','')")
    c.commit()
    before = c.execute("SELECT COUNT(*) FROM sync_tombstones").fetchone()[0]
    assert db.dedupe_pinned_assets(c) == 1
    c.commit()
    assert c.execute("SELECT COUNT(*) FROM sync_tombstones").fetchone()[0] == before
    assert c.execute("SELECT active FROM _sync_guard").fetchone()[0] == 0
    c.close()


# ── op-log interaction ───────────────────────────────────────────────────────

@pytest.fixture()
def pair(tmp_path, monkeypatch):
    import db
    from sync import oplog

    def make(name):
        monkeypatch.setattr(db, "DB_PATH", tmp_path / name)
        db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema()
        db.init_alerts_schema(); db.init_sync_layer(); db.init_audit_layer()
        db.init_oplog_layer()
        c = db.connect(tmp_path / name)
        c.execute("PRAGMA foreign_keys = ON")
        return c

    a, b = make("a.db"), make("b.db")
    root = tmp_path / "cloud" / "oplog"
    root.mkdir(parents=True)
    yield a, b, root, oplog
    a.close(); b.close()


def _pin(c, pid, symbol, gid="g"):
    c.execute("INSERT OR IGNORE INTO pin_groups(id,name) VALUES(?,?)", (gid, "G"))
    c.execute("INSERT INTO pinned_assets(id,symbol,group_id) VALUES(?,?,?)", (pid, symbol, gid))
    c.commit()


def _rounds(a, b, root, oplog):
    for _ in range(2):
        oplog.sync_once(a, "A", root)
        oplog.sync_once(b, "B", root)


def _open(c):
    return c.execute("SELECT COUNT(*) FROM sync_conflicts WHERE resolved_at IS NULL").fetchone()[0]


def test_same_symbol_pinned_on_two_devices_converges_with_deterministic_id(pair):
    a, b, root, oplog = pair
    _pin(a, "pin:AAPL", "AAPL")
    _pin(b, "pin:AAPL", "AAPL")
    _rounds(a, b, root, oplog)
    for c in (a, b):
        assert c.execute("SELECT COUNT(*) FROM pinned_assets WHERE symbol='AAPL'").fetchone()[0] == 1
    assert not [r for c in (a, b) for r in c.execute("SELECT reason FROM sync_conflicts") if r['reason'].startswith('apply failed')]
    assert dict(a.execute("SELECT * FROM pinned_assets").fetchone())["id"] == "pin:AAPL"


def test_random_id_collision_is_a_recorded_conflict_not_a_crash(pair):
    """Legacy rows (random ids) for one symbol on two devices: the unique index
    makes the peer's insert fail; oplog records it and both DBs keep exactly one pin."""
    a, b, root, oplog = pair
    _pin(a, "1111", "MSFT")
    _pin(b, "2222", "MSFT")
    _rounds(a, b, root, oplog)
    for c in (a, b):
        assert c.execute("SELECT COUNT(*) FROM pinned_assets WHERE symbol='MSFT'").fetchone()[0] == 1
    reasons = [r["reason"] for c in (a, b) for r in c.execute("SELECT reason FROM sync_conflicts")]
    assert any(r.startswith("apply failed") for r in reasons)
