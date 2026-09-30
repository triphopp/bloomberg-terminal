"""MARGIN router + PAPER integration: book building, settings, order checks,
option premium in paper cash, and the scheduler's transition rule."""
import asyncio
import importlib

import pytest


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "margin.db"))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema()
    db.init_margin_schema(); db.init_alerts_schema(); db.init_sync_layer()
    import portfolio_currency
    importlib.reload(portfolio_currency)
    import routers.portfolio_v2 as pv2
    importlib.reload(pv2)
    monkeypatch.setattr(pv2, "_get_thb_per_usd", lambda: 35.0)
    monkeypatch.setattr(pv2, "open_option_positions", lambda *a, **k: [])
    monkeypatch.setattr(pv2, "closed_option_positions", lambda *a, **k: [])
    monkeypatch.setattr(pv2, "_batch_fetch_prices",
                        lambda syms: {s: {"price": 120.0, "prev_close": 120.0} for s in syms})
    import routers.paper_trading as paper
    importlib.reload(paper)
    monkeypatch.setattr(paper, "_get_price", lambda s: 100.0)
    monkeypatch.setattr(paper, "_batch_prices", lambda syms: {s: 100.0 for s in syms})
    import routers.margin as mr
    importlib.reload(mr)
    with db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('ib', 'IB', 'THB')")
        # 100k in, 150k of PTT bought → derived cash −50k (a margin loan).
        conn.execute("INSERT INTO cash_ledger (id, account_id, date, investment) "
                     "VALUES ('c1', 'ib', '2026-01-01', 100000)")
        conn.execute(
            """INSERT INTO trades (id, account_id, symbol, date_entry, price_entry, volume,
                                   amount, currency, win_loss, market)
               VALUES ('t1', 'ib', 'PTT', '2026-01-02', 150, 1000, 150000, 'THB', 'P', 'TH')""")
        conn.execute("INSERT INTO paper_accounts (id, name, currency, initial_balance) "
                     "VALUES ('pp', 'PAPER1', 'USD', 10000)")
    return mr, paper, db


def test_disabled_account_reports_nothing(env):
    mr, _, _ = env
    s = mr.status("port", "ib")
    assert s["enabled"] is False
    assert mr.overview()["accounts"] == []


def test_port_status_on_margin(env):
    mr, _, db = env
    out = mr.put_settings(mr.MarginSettingsIn(scope="port", account_id="ib"))
    assert out["enabled"] is True
    with db.get_db() as conn:
        assert conn.execute("SELECT account_type FROM portfolio_accounts WHERE id='ib'").fetchone()[0] == "margin"
    s = mr.status("port", "ib")
    # cash −50k, PTT 1000 @ 120 → NLV 70k, MM 30k, EL 40k
    assert s["cash"] == pytest.approx(-50_000)
    assert s["nlv"] == pytest.approx(70_000)
    assert s["maint_margin"] == pytest.approx(30_000)
    assert s["excess_liquidity"] == pytest.approx(40_000)
    assert s["level"] == "SAFE"
    assert s["cash_is_estimate"] is True
    # −50k + .75·120k·(1−d) = 0 → d = 4/9
    assert s["drop_to_call"] == pytest.approx(4 / 9, abs=1e-4)
    assert s["assets"][0]["key"] in ("PTT", "PTT.BK")
    ov = mr.overview()
    assert ov["worst"] == "SAFE" and ov["accounts"][0]["name"] == "IB"


def test_override_and_thresholds_validate(env):
    mr, _, _ = env
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        mr.put_settings(mr.MarginSettingsIn(scope="port", account_id="ib", overrides={"PTT.BK": 1.5}))
    with pytest.raises(HTTPException):
        mr.put_settings(mr.MarginSettingsIn(scope="port", account_id="ib",
                                            thresholds={"WATCH": 0.05, "WARNING": 0.10}))
    mr.put_settings(mr.MarginSettingsIn(scope="port", account_id="ib"))
    key = mr.status("port", "ib")["assets"][0]["key"]
    mr.put_settings(mr.MarginSettingsIn(scope="port", account_id="ib", overrides={key.lower(): 0.6}))
    s = mr.status("port", "ib")
    # MM 60% of 120k = 72k > ELV 70k → liquidation
    assert s["maint_margin"] == pytest.approx(72_000)
    assert s["level"] == "LIQUIDATION"


def test_paper_cash_account_still_limited_to_cash(env):
    _, paper, _ = env
    from fastapi import HTTPException
    body = paper.OrderCreate(account_id="pp", symbol="AAA", side="buy", quantity=150)
    with pytest.raises(HTTPException) as e:
        asyncio.run(paper.place_order(body))
    assert "Insufficient cash" in e.value.detail


def test_paper_margin_buying_power(env):
    mr, paper, _ = env
    from fastapi import HTTPException
    mr.put_settings(mr.MarginSettingsIn(scope="paper", account_id="pp"))
    # 150 × ~100 = 15k on 10k equity → IM 7.5k ≤ ELV ≈ 10k: accepted.
    r = asyncio.run(paper.place_order(paper.OrderCreate(account_id="pp", symbol="AAA", side="buy", quantity=150)))
    assert r["status"] == "filled"
    s = mr.status("paper", "pp")
    assert s["cash"] < 0 and s["loan"] > 0
    # Another 100 → 25k of stock on ~10k equity: IM 12.5k > ELV → rejected.
    with pytest.raises(HTTPException) as e:
        asyncio.run(paper.place_order(paper.OrderCreate(account_id="pp", symbol="AAA", side="buy", quantity=100)))
    assert "Insufficient margin" in e.value.detail


def test_paper_option_premium_reaches_cash(env):
    _, paper, db = env
    with db.get_db() as conn:
        # sold 1 put @ 2.00, bought back @ 0.50, 1.30 commission → +148.70
        conn.execute(
            """INSERT INTO paper_option_positions (id, account_id, underlying, expiry, strike, option_type,
                   quantity, entry_price, entry_date, exit_price, exit_date, status, commission)
               VALUES ('o1', 'pp', 'XYZ', '2026-01-16', 100, 'put', -1, 2.0, '2026-01-02', 0.5,
                       '2026-01-10', 'closed', 1.3)""")
        # open long call @ 3.00, 0.65 commission → −300.65
        conn.execute(
            """INSERT INTO paper_option_positions (id, account_id, underlying, expiry, strike, option_type,
                   quantity, entry_price, entry_date, status, commission)
               VALUES ('o2', 'pp', 'XYZ', '2027-01-15', 110, 'call', 1, 3.0, '2026-01-02', 'open', 0.65)""")
        assert paper._get_cash(conn, "pp") == pytest.approx(10_000 + 148.70 - 300.65)


def test_scheduler_fires_on_worsening_only():
    import margin_scheduler as ms
    acc = lambda lv: {"scope": "port", "account_id": "ib", "name": "IB", "level": lv}  # noqa: E731
    state, ev = ms.transitions({}, [acc("SAFE")])
    assert ev == [] and state == {"port:ib": "SAFE"}
    state, ev = ms.transitions(state, [acc("WARNING")])
    assert [e["level"] for e in ev] == ["WARNING"]
    state, ev = ms.transitions(state, [acc("WATCH")])
    assert ev == [] and state["port:ib"] == "WATCH"
    # first sight of a bad book is said out loud
    _, ev = ms.transitions({}, [acc("DANGER")])
    assert [e["level"] for e in ev] == ["DANGER"]


def test_settings_save_twice_with_oplog_triggers(env):
    """An UPSERT here failed with UNIQUE(sync_pending) once the op-log capture
    triggers were installed and the row was still pending flush."""
    mr, _, db = env
    from sync import oplog
    with db.get_db() as conn:
        oplog.install(conn)
    mr.put_settings(mr.MarginSettingsIn(scope="paper", account_id="pp"))
    out = mr.put_settings(mr.MarginSettingsIn(scope="paper", account_id="pp", overrides={"AMD": 0.5}))
    assert out["overrides"] == {"AMD": 0.5}
