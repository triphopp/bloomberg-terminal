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
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema()
    db.init_alerts_schema(); db.init_sync_layer()
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


def _add_alert_rule(db, name: str, enabled: int = 1) -> str:
    rid = str(uuid.uuid4())
    with db.get_db() as c:
        c.execute(
            "INSERT INTO alert_rules "
            "(id, name, enabled, scope_json, timeframe, expr_json, trigger, "
            " cooldown_bars, notify_json, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))",
            (rid, name, enabled, '{"type":"watchlist"}', "1d",
             '{"op":"cmp","left":{"src":"price","field":"close"},"cmp":"gt","right":{"src":"const","value":1}}',
             "edge", 1, '["ticker"]'),
        )
    return rid


def test_alert_rules_sync_but_state_and_events_stay_local(cloud, tmp_path, monkeypatch):
    """alert_rules (the definitions) syncs like pinned_assets does. alert_rule_state
    and alert_events are deliberately excluded from SYNC_TABLES (sync/config.py) —
    each device should end up with its own independent, un-synced copies."""
    import time

    # PC creates a rule + local scan state/event, pushes
    db, sync = _device(monkeypatch, tmp_path, "PC")
    rid = _add_alert_rule(db, "AMD RVOL Spike")
    with db.get_db() as c:
        c.execute(
            "INSERT INTO alert_rule_state (rule_id, symbol, last_state) VALUES (?, 'AMD', 'true')",
            (rid,),
        )
        c.execute(
            "INSERT INTO alert_events (rule_id, symbol, fired_at, bar_time, snapshot_json) "
            "VALUES (?, 'AMD', datetime('now'), '2026-01-01', '{}')",
            (rid,),
        )
    assert sync.push()["status"] == "ok"

    # MAC pulls: gets the rule DEFINITION, but no state/events (never pushed anywhere)
    db, sync = _device(monkeypatch, tmp_path, "MAC")
    assert sync.pull()["status"] == "ok"
    with db.get_db() as c:
        rules = c.execute("SELECT id, name, enabled FROM alert_rules").fetchall()
        state_rows = c.execute("SELECT * FROM alert_rule_state").fetchall()
        event_rows = c.execute("SELECT * FROM alert_events").fetchall()
    assert [r["name"] for r in rules] == ["AMD RVOL Spike"], "rule definition should have synced"
    assert state_rows == [], "scan state must NOT sync — each device regenerates its own"
    assert event_rows == [], "fired-event history must NOT sync — excluded from SYNC_TABLES"

    # MAC disables the rule, pushes; PC pulls and should see it disabled (LWW)
    time.sleep(1.1)
    with db.get_db() as c:
        c.execute("UPDATE alert_rules SET enabled = 0, updated_at = datetime('now') WHERE id = ?", (rid,))
    sync.push()

    db, sync = _device(monkeypatch, tmp_path, "PC")
    sync.pull()
    with db.get_db() as c:
        enabled = c.execute("SELECT enabled FROM alert_rules WHERE id = ?", (rid,)).fetchone()["enabled"]
    assert enabled == 0, "LWW should carry MAC's disable across to PC"
