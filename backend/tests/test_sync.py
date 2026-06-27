"""
Cloud-sync tests: row-level LWW merge + tombstone (no-resurrect) + conflict capture.

Each test points PORTFOLIO_DB / SYNC_DIR at a temp dir, simulating two machines
(PC, MAC) writing to a shared cloud folder.
"""
import importlib
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
    """Reconfigure the running process to act as `name` with its own DB, and
    return freshly-imported db + sync modules bound to that env."""
    monkeypatch.setenv("SYNC_DEVICE_ID", name)
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / f"{name}.db"))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_sync_layer()
    import sync.config as scfg
    importlib.reload(scfg)
    import sync.manager as mgr
    importlib.reload(mgr)
    import sync as pkg
    importlib.reload(pkg)
    return db, pkg


def _add_trade(db, account_id, symbol, vol):
    tid = str(uuid.uuid4())
    with db.get_db() as c:
        c.execute(
            "INSERT INTO trades(id,account_id,symbol,date_entry,price_entry,volume) "
            "VALUES(?,?,?,?,?,?)",
            (tid, account_id, symbol, "2026-06-01", 10.0, vol),
        )
    return tid


def test_lww_and_tombstone(cloud, tmp_path, monkeypatch):
    # ── PC: seed account + PTT, push ────────────────────────────────────────
    db, sync = _device(monkeypatch, tmp_path, "PC")
    aid = str(uuid.uuid4())
    with db.get_db() as c:
        c.execute("INSERT INTO portfolio_accounts(id,name,country,currency) VALUES(?,?,?,?)",
                  (aid, "Finansia", "TH", "THB"))
    ptt = _add_trade(db, aid, "PTT.BK", 1000)
    assert sync.push()["status"] == "ok"

    # ── MAC: pull, edit PTT->2000, add KBANK, push ──────────────────────────
    db, sync = _device(monkeypatch, tmp_path, "MAC")
    assert sync.pull()["status"] == "ok"
    import time
    time.sleep(1.1)  # ensure a strictly-later updated_at
    with db.get_db() as c:
        c.execute("UPDATE trades SET volume=2000 WHERE id=?", (ptt,))
    _add_trade(db, aid, "KBANK.BK", 500)
    sync.push()

    # ── PC: pull MAC's changes — LWW picks 2000; then PC deletes KBANK ───────
    db, sync = _device(monkeypatch, tmp_path, "PC")
    sync.pull()
    with db.get_db() as c:
        vol = c.execute("SELECT volume FROM trades WHERE id=?", (ptt,)).fetchone()["volume"]
        assert vol == 2000.0, "LWW failed: newer MAC edit should win"
        time.sleep(1.1)
        c.execute("DELETE FROM trades WHERE symbol='KBANK.BK'")
    sync.push()

    # ── MAC: pull — KBANK must stay deleted (tombstone, no resurrect) ────────
    db, sync = _device(monkeypatch, tmp_path, "MAC")
    sync.pull()
    with db.get_db() as c:
        syms = [r["symbol"] for r in c.execute("SELECT symbol FROM trades").fetchall()]
    assert "KBANK.BK" not in syms, "tombstone failed: deleted row resurrected"
    assert "PTT.BK" in syms


def test_conflict_preserved(cloud, tmp_path, monkeypatch):
    # PC seeds + pushes
    db, sync = _device(monkeypatch, tmp_path, "PC")
    aid = str(uuid.uuid4())
    with db.get_db() as c:
        c.execute("INSERT INTO portfolio_accounts(id,name,country,currency) VALUES(?,?,?,?)",
                  (aid, "A", "TH", "THB"))
    tid = _add_trade(db, aid, "AOT.BK", 100)
    sync.push()

    # MAC pulls then both edit the SAME row differently (divergent) and push
    db, sync = _device(monkeypatch, tmp_path, "MAC")
    sync.pull()
    import time
    time.sleep(1.1)
    with db.get_db() as c:
        c.execute("UPDATE trades SET volume=999 WHERE id=?", (tid,))
    sync.push()

    db, sync = _device(monkeypatch, tmp_path, "PC")
    time.sleep(1.1)
    with db.get_db() as c:
        c.execute("UPDATE trades SET volume=111 WHERE id=?", (tid,))
    res = sync.pull()
    assert res["conflicts"] >= 1, "divergent edits should register a conflict"
    # loser version is written to conflicts/ — zero data loss
    assert list((cloud / "conflicts").glob("*.json")), "conflict file not written"
