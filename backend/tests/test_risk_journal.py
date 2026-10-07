"""Risk decision journal + REBALANCE HOLD against an isolated DB (no network)."""
import importlib
from datetime import date, timedelta

import pytest

import rebalance as rb

TODAY = date(2026, 10, 7)


def _row(symbol="AAA", weight=20.0, target=10.0, growth=50.0, mv=200.0, vol=10.0):
    return {"symbol": symbol, "weight_mv_pct": weight, "target_pct": target,
            "target_source": "cost_weight", "band_pct": 0, "growth_pct": growth,
            "unrealized": mv - mv / (1 + growth / 100), "market_value": mv, "volume": vol,
            "price": mv / vol, "instrument": "equity", "priced": True, "yf_symbol": symbol}


def _plan(rows):
    return rb.plan(rows, 1000.0, rb.Rules(), TODAY,
                   first_entry={r["symbol"]: "2026-01-01" for r in rows})


# ── rebalance.apply_holds (pure) ─────────────────────────────────────────────

def test_live_hold_takes_a_trim_off_the_plan_but_keeps_its_numbers():
    out = _plan([_row("AAA"), _row("BBB")])
    assert out["counts"]["TRIM"] == 2
    sell_one = out["rows"][0]["sell_value"]
    hold = {"AAA": {"id": "h1", "reason": "earnings next week",
                    "review_on": (TODAY + timedelta(days=7)).isoformat(), "created_at": "2026-10-07"}}
    out = rb.apply_holds(out, hold, TODAY)
    by = {r["symbol"]: r for r in out["rows"]}
    assert by["AAA"]["status"] == "HOLD" and by["AAA"]["hold"]["reason"] == "earnings next week"
    assert by["AAA"]["sell_value"] == sell_one          # what was declined stays visible
    assert by["BBB"]["status"] == "TRIM" and by["BBB"]["hold"] is None
    assert out["counts"]["TRIM"] == 1 and out["counts"]["HOLD"] == 1
    assert out["sell_value"] == by["BBB"]["sell_value"]
    assert [t["symbol"] for t in out["trades"]] == ["BBB"]


def test_hold_past_its_review_date_is_a_trim_again_and_says_so():
    hold = {"AAA": {"id": "h1", "reason": "wait", "review_on": (TODAY - timedelta(days=1)).isoformat()}}
    out = rb.apply_holds(_plan([_row("AAA")]), hold, TODAY)
    r = out["rows"][0]
    assert r["status"] == "TRIM" and r["hold"] is None and r["hold_ended"]["id"] == "h1"


def test_hold_on_a_row_that_is_not_a_trim_changes_nothing():
    hold = {"AAA": {"id": "h1", "reason": "x", "review_on": (TODAY + timedelta(days=5)).isoformat()}}
    out = rb.apply_holds(_plan([_row("AAA", weight=11.0)]), hold, TODAY)
    assert out["rows"][0]["status"] == "OK" and out["rows"][0]["hold"] is None


def test_held_rows_do_not_alert():
    from datetime import datetime, timezone

    from guard_scheduler import rebalance_events

    hold = {"AAA": {"id": "h1", "reason": "x", "review_on": (TODAY + timedelta(days=5)).isoformat()}}
    out = rb.apply_holds(_plan([_row("AAA"), _row("BBB")]), hold, TODAY)
    events = rebalance_events(out, datetime(2026, 10, 7, tzinfo=timezone.utc))
    assert [e["symbol"] for e in events] == ["BBB"]


# ── endpoints ────────────────────────────────────────────────────────────────

@pytest.fixture()
def risk(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "t.db"))
    monkeypatch.setenv("SYNC_DEVICE_ID", "PC")
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_guard_schema(); db.init_alerts_schema(); db.init_sync_layer()
    import routers.risk as mod
    importlib.reload(mod)
    return mod


def _post(mod, **kw):
    body = dict(kind="REBALANCE", decision="HOLD", reason="รองบ Q3", symbol="aaa", account_id="dime")
    body.update(kw)
    return mod.post_risk_decision(mod.RiskDecisionIn(**body))


def test_rebalance_hold_is_stored_with_reason_snapshot_and_review_date(risk):
    out = _post(risk, review_days=10, snapshot={"weight_pct": 22.5, "target_pct": 10, "skip": None})
    assert out["ok"] and out["review_on"] == (date.today() + timedelta(days=10)).isoformat()
    rows = risk.get_risk_decisions(None, None, None, 50)["decisions"]
    assert len(rows) == 1
    r = rows[0]
    assert (r["kind"], r["decision"], r["symbol"], r["reason"]) == ("REBALANCE", "HOLD", "AAA", "รองบ Q3")
    assert r["snapshot"] == {"weight_pct": 22.5, "target_pct": 10} and r["active"] is True

    import db
    import risk_journal
    with db.get_db() as conn:
        assert set(risk_journal.rebalance_holds(conn)) == {"AAA"}


def test_reason_is_required_and_kinds_are_checked(risk):
    from fastapi import HTTPException

    for bad in (dict(reason="   "), dict(kind="NOPE"), dict(decision="MAYBE"), dict(symbol=""),
                dict(review_days=0), dict(kind="STOP")):
        with pytest.raises(HTTPException) as e:
            _post(risk, **bad)
        assert e.value.status_code == 400
    assert risk.get_risk_decisions(None, None, None, 50)["decisions"] == []


def test_new_hold_replaces_the_live_one_and_ending_keeps_the_row(risk):
    from fastapi import HTTPException

    first = _post(risk)
    second = _post(risk, reason="ยังเชื่อ thesis")
    rows = {r["id"]: r for r in risk.get_risk_decisions(None, None, None, 50)["decisions"]}
    assert rows[first["id"]]["active"] is False and rows[first["id"]]["cleared_at"]
    assert rows[second["id"]]["active"] is True

    assert risk.end_risk_decision(second["id"])["ok"]
    rows = risk.get_risk_decisions(None, None, None, 50)["decisions"]
    assert len(rows) == 2 and not any(r["active"] for r in rows)       # ended, never deleted
    with pytest.raises(HTTPException):
        risk.end_risk_decision(second["id"])                           # already ended
    with pytest.raises(HTTPException):
        risk.end_risk_decision("missing")


def test_note_needs_no_symbol_and_filters_work(risk):
    _post(risk)
    _post(risk, kind="OTHER", decision="NOTE", symbol=None, account_id=None, reason="ลดขนาดพอร์ตทั้งเดือน")
    out = risk.get_risk_decisions(None, None, None, 50)
    assert out["counts"] == {"REBALANCE": 1, "OTHER": 1} and out["active_holds"] == 1
    assert len(risk.get_risk_decisions(None, "OTHER", None, 50)["decisions"]) == 1
    assert len(risk.get_risk_decisions(None, None, "AAA", 50)["decisions"]) == 1
    # A book-wide note shows in every account's view; another account's hold does not.
    assert len(risk.get_risk_decisions("finansia", None, None, 50)["decisions"]) == 1


def test_guard_hold_is_mirrored_and_its_undo_removes_the_mirror(risk):
    from fastapi import HTTPException

    hold = risk.create_guard_override(risk.GuardOverrideIn(
        account_id="dime", yf_symbol="goog", first_entry="2026-05-06", symbol="GOOG",
        codes=["STOP_HIT"], reason="earnings next week", floor_price=150.0))
    rows = risk.get_risk_decisions(None, "STOP", None, 50)["decisions"]
    assert len(rows) == 1
    r = rows[0]
    assert (r["decision"], r["symbol"], r["ref_id"], r["source"]) == ("HOLD", "GOOG", hold["id"], "guard")
    assert r["snapshot"]["floor_price"] == 150.0 and r["review_on"] == hold["review_on"]
    with pytest.raises(HTTPException):
        risk.end_risk_decision(r["id"])                # guard owns its holds
    risk.delete_guard_override(hold["id"])
    assert risk.get_risk_decisions(None, "STOP", None, 50)["decisions"] == []
