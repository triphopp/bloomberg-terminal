"""
Auto dividend: an ex-date that passed while we held the stock is booked by
itself; a stock not held on that day gets nothing. Pins who is entitled, that a
hand-booked (or split per-subaccount) dividend is never doubled, that a pass
never re-books or overwrites, and that a row the user deleted stays deleted.
"""
import importlib
from datetime import date
from types import SimpleNamespace

import pytest

TODAY = date(2026, 11, 25)


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "auto.db"))
    monkeypatch.setenv("DIVIDEND_AUTO_LOOKBACK_DAYS", "60")
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema()
    db.init_alerts_schema(); db.init_sync_layer(); db.init_audit_layer()
    import routers.portfolio_v2  # noqa: F401 — _trade_yf_symbol
    import dividend_auto
    importlib.reload(dividend_auto)
    market = {
        # held all along → booked
        "PTT.BK": [SimpleNamespace(ex_date="2026-11-10", amount=1.4),
                   SimpleNamespace(ex_date="2026-05-01", amount=1.2)],   # older than lookback
        # bought ON the ex-date → not entitled
        "KBANK.BK": [SimpleNamespace(ex_date="2026-11-12", amount=4.0)],
        # sold ON the ex-date → still entitled
        "MSFT": [SimpleNamespace(ex_date="2026-11-18", amount=0.91)],
        # sold the day before → not held
        "AAPL": [SimpleNamespace(ex_date="2026-11-10", amount=0.26)],
        # already booked by hand as two subaccount rows, XD typed a day off
        "OR.BK": [SimpleNamespace(ex_date="2026-11-03", amount=0.3)],
        # declared, not yet ex → nothing yet
        "SCB.BK": [SimpleNamespace(ex_date="2026-12-05", amount=10.0)],
    }
    with db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('fin','Fin','THB')")
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('dime','Dime','USD')")

        def lot(i, acct, sym, rs, mkt, ccy, de, vol, dx=None):
            conn.execute(
                """INSERT INTO trades (id, account_id, symbol, resolved_symbol, market, date_entry,
                       date_exit, price_entry, volume, currency, win_loss)
                   VALUES (?,?,?,?,?,?,?,10,?,?,?)""",
                (i, acct, sym, rs, mkt, de, dx, vol, ccy, "W" if dx else "P"))

        lot("p1", "fin", "PTT", "PTT.BK", "TH", "THB", "2026-01-05", 1000)
        lot("p2", "fin", "PTT", "PTT.BK", "TH", "THB", "2026-11-20", 500)    # after XD
        lot("k", "fin", "KBANK", "KBANK.BK", "TH", "THB", "2026-11-12", 100)
        lot("m", "dime", "MSFT", "MSFT", "US", "USD", "2026-01-02", 3.149, "2026-11-18")
        lot("a", "dime", "AAPL", "AAPL", "US", "USD", "2026-01-02", 5, "2026-11-09")
        lot("o", "fin", "OR", "OR.BK", "TH", "THB", "2026-01-05", 14400)
        lot("s", "fin", "SCB", "SCB.BK", "TH", "THB", "2026-01-05", 100)
        for i, tot in (("h1", 2250.0), ("h2", 2070.0)):
            conn.execute(
                "INSERT INTO dividends (id, account_id, asset, ex_date, pay_date, amount_per_unit, "
                "total_received, currency) VALUES (?, 'fin', 'OR', '2026-11-04', '2026-11-24', 0.3, ?, 'THB')",
                (i, tot))
    run = lambda **kw: dividend_auto.run_once(  # noqa: E731
        TODAY, market=lambda s: market.get(s, []), pay_date=lambda s, xd: None, **kw)
    return dividend_auto, db, run


def _rows(db):
    with db.get_db() as conn:
        return {r["asset"]: dict(r) for r in conn.execute(
            "SELECT * FROM dividends WHERE id LIKE 'auto-div-%'").fetchall()}


def test_books_only_what_was_held_on_the_ex_date(env):
    auto, db, run = env
    out = run()
    rows = _rows(db)
    assert set(rows) == {"PTT", "MSFT"}
    # 1000 held on XD; the lot bought after XD earns nothing
    assert rows["PTT"]["total_received"] == pytest.approx(1400.0)
    assert rows["PTT"]["ex_date"] == "2026-11-10" and rows["PTT"]["currency"] == "THB"
    assert rows["PTT"]["pay_date"] == "2026-11-10"   # no declared pay date → XD placeholder
    # sold ON the ex-date keeps the dividend; USD stays USD, gross
    assert rows["MSFT"]["total_received"] == pytest.approx(3.149 * 0.91, abs=1e-4)
    assert rows["MSFT"]["currency"] == "USD"
    reasons = {(s["asset"], s["reason"]) for s in out["skipped"]}
    assert ("KBANK", "not_held") in reasons
    assert ("AAPL", "not_held") in reasons
    assert ("OR", "already_booked") in reasons


def test_not_yet_ex_and_older_than_lookback_are_left_alone(env):
    auto, db, run = env
    run()
    with db.get_db() as conn:
        assert not conn.execute("SELECT 1 FROM dividends WHERE asset = 'SCB'").fetchone()
        assert not conn.execute(
            "SELECT 1 FROM dividends WHERE asset = 'PTT' AND ex_date = '2026-05-01'").fetchone()


def test_a_second_pass_books_nothing_and_keeps_user_edits(env):
    auto, db, run = env
    run()
    with db.get_db() as conn:
        conn.execute("UPDATE dividends SET total_received = 1260, pay_date = '2026-12-01' "
                     "WHERE asset = 'PTT' AND id LIKE 'auto-div-%'")
    assert run()["booked"] == []
    row = _rows(db)["PTT"]
    assert row["total_received"] == 1260 and row["pay_date"] == "2026-12-01"


def test_a_deleted_auto_row_is_not_booked_again(env):
    auto, db, run = env
    run()
    with db.get_db() as conn:
        conn.execute("DELETE FROM dividends WHERE asset = 'MSFT' AND id LIKE 'auto-div-%'")
    out = run()
    assert out["booked"] == []
    assert ("MSFT", "deleted_by_user") in {(s["asset"], s["reason"]) for s in out["skipped"]}
    assert "MSFT" not in _rows(db)


def test_dry_run_writes_nothing(env):
    auto, db, run = env
    out = run(dry_run=True)
    assert {r["asset"] for r in out["to_book"]} == {"PTT", "MSFT"}
    assert _rows(db) == {}


def test_declared_pay_date_is_used_when_yahoo_names_this_ex_date(env, monkeypatch):
    auto, db, _ = env
    market = {"PTT.BK": [SimpleNamespace(ex_date="2026-11-10", amount=1.4)]}
    out = auto.run_once(TODAY, market=lambda s: market.get(s, []),
                        pay_date=lambda s, xd: "2026-12-02" if s == "PTT.BK" else None)
    assert out["booked"][0]["pay_date"] == "2026-12-02"
    assert _rows(db)["PTT"]["pay_date"] == "2026-12-02"


def test_id_is_deterministic_per_account_asset_exdate(env):
    auto, _, _ = env
    a = auto.auto_id("fin", "ptt", "2026-11-10")
    assert a == auto.auto_id("fin", "PTT", "2026-11-10T00:00:00")
    assert a != auto.auto_id("dime", "PTT", "2026-11-10")
    assert auto.is_auto(a) and not auto.is_auto("3f2c-uuid")


def test_suggestions_treat_an_xd_a_day_off_as_already_booked(env, monkeypatch):
    # OR was booked by hand with XD 2026-11-04; Yahoo says 2026-11-03.
    import routers.portfolio_v2 as mod
    monkeypatch.setattr(mod.market_data, "get_dividends", lambda s: {
        "OR.BK": [SimpleNamespace(ex_date="2026-11-03", amount=0.3),
                  SimpleNamespace(ex_date="2026-05-20", amount=0.3)],
    }.get(s, []))
    out = mod.get_dividend_suggestions(account_id="fin")["suggestions"]
    assert [(s["asset"], s["ex_date"]) for s in out if s["asset"] == "OR"] == [("OR", "2026-05-20")]
