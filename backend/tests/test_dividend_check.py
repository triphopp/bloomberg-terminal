"""
Dividend units: a baht figure labelled USD (Dime shows US dividends in baht)
was stored as USD and multiplied by USD/THB again — JEPQ $17.77/unit when the
fund paid $0.44. These pin the check and the currency rule that let it happen.
"""
import importlib
from types import SimpleNamespace

import pytest
from fastapi import HTTPException


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "div.db"))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema()
    db.init_alerts_schema(); db.init_sync_layer()
    import portfolio_currency
    importlib.reload(portfolio_currency)
    monkeypatch.setattr(portfolio_currency, "fx_rate",
                        lambda a, b, date=None, conn=None: 1.0 if a == b else (32.3 if a == "USD" else 1 / 32.3))
    import dividend_check
    importlib.reload(dividend_check)
    # market data: JEPQ paid $0.444 ex 2025-08-01; PTT paid ฿1.40 ex 2026-03-01
    market = {
        "JEPQ": [SimpleNamespace(ex_date="2025-08-01", amount=0.444)],
        "PTT.BK": [SimpleNamespace(ex_date="2026-03-01", amount=1.40)],
    }
    monkeypatch.setattr(dividend_check, "_market_dividends", lambda s: market.get(s, []))
    import routers.portfolio_v2 as mod
    importlib.reload(mod)
    with db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('dime','Dime','USD')")
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('fin','Fin','THB')")
        conn.execute(
            """INSERT INTO trades (id, account_id, symbol, resolved_symbol, market, date_entry,
                   price_entry, volume, currency, win_loss)
               VALUES ('j', 'dime', 'JEPQ', 'JEPQ', 'US', '2025-07-01', 55, 72.7, 'USD', 'P')""")
        conn.execute(
            """INSERT INTO trades (id, account_id, symbol, resolved_symbol, market, date_entry,
                   price_entry, volume, currency, win_loss)
               VALUES ('p', 'fin', 'PTT', 'PTT.BK', 'TH', '2026-01-05', 33, 1000, 'THB', 'P')""")
    return mod, db, dividend_check


def _check(mod, **kw):
    base = dict(account_id="dime", asset="JEPQ", ex_date="2025-08-01", pay_date="2025-08-05")
    return mod.check_dividend(mod.DividendIn(**{**base, **kw}))


def test_baht_labelled_usd_is_an_error_with_a_fix(env):
    mod, _, _ = env
    r = _check(mod, amount_per_unit=17.77, total_received=1292.4, currency="USD")
    issue = r["issues"][0]
    assert issue["code"] == "looks_thb_as_usd" and issue["level"] == "error"
    assert issue["fix"]["amount_per_unit"] == pytest.approx(17.77 / 32.3, rel=1e-4)
    assert issue["alt_fix"]["currency"] == "THB"


def test_correct_usd_entry_passes(env):
    mod, _, _ = env
    # 72.7 units × $0.444 = $32.28 gross; $27.44 after 15% US withholding
    r = _check(mod, amount_per_unit=0.444, total_received=27.44, currency="USD")
    assert r["issues"] == []
    assert r["held_units"] == pytest.approx(72.7)


def test_same_baht_numbers_labelled_thb_pass_scale_check(env):
    """Dime shows baht: typing that baht with THB selected is right, and kept."""
    mod, _, _ = env
    r = _check(mod, amount_per_unit=14.34, total_received=886.0, currency="THB")
    assert r["entered_currency"] == "THB"
    assert not [i for i in r["issues"] if i["level"] == "error"]


def test_usd_labelled_thb_on_a_thai_stock(env):
    mod, _, _ = env
    r = _check(mod, account_id="fin", asset="PTT", ex_date="2026-03-01", pay_date="2026-03-20",
               amount_per_unit=0.0433, total_received=43.3, currency="THB")
    assert r["issues"][0]["code"] == "looks_usd_as_thb"


def test_total_far_from_units_held_warns(env):
    mod, _, _ = env
    r = _check(mod, amount_per_unit=0.444, total_received=900, currency="USD")
    assert any(i["code"] == "total_vs_holding" and i["level"] == "warn" for i in r["issues"])


def test_not_held_on_ex_date_warns(env):
    mod, _, _ = env
    r = _check(mod, ex_date="2025-06-02", pay_date="2025-06-05", amount_per_unit=0.44,
               total_received=30, currency="USD")
    assert any(i["code"] == "not_held" for i in r["issues"])


def test_recorded_subaccount_dividends_cover_entire_holding(env):
    _, db, checker = env
    with db.get_db() as conn:
        conn.execute("""INSERT INTO trades(id,account_id,symbol,resolved_symbol,market,date_entry,
                     price_entry,volume,currency,win_loss,note) VALUES
                     ('o1','fin','OR','OR.BK','TH','2026-01-01',20,4500,'THB','P','Fin (1)'),
                     ('o2','fin','OR','OR.BK','TH','2026-01-01',20,6900,'THB','P','Fin (7)')""")
        conn.execute("""INSERT INTO dividends(id,account_id,asset,ex_date,pay_date,
                     amount_per_unit,total_received,currency) VALUES
                     ('d1','fin','OR','2026-02-23','2026-04-29',0.3,1350,'THB'),
                     ('d2','fin','OR','2026-02-23','2026-04-29',0.3,2070,'THB')""")
        args = dict(account_id='fin', asset='OR', ex_date='2026-02-23', pay_date='2026-04-29',
                    amount_per_unit=0.3, total_received=1350, currency='THB',
                    market=lambda _: [], dividend_id='d1')
        assert checker.check(conn, **args)['issues'] == []
        conn.execute("DELETE FROM dividends WHERE id='d2'")
        assert any(i['code'] == 'matches_one_lot' for i in checker.check(conn, **args)['issues'])


def test_save_is_blocked_then_forced(env):
    mod, db, _ = env
    body = dict(account_id="dime", asset="JEPQ", ex_date="2025-08-01", pay_date="2025-08-05",
                amount_per_unit=17.77, total_received=1292.4, currency="USD")
    with pytest.raises(HTTPException) as e:
        mod.add_dividend(mod.DividendIn(**body))
    assert e.value.status_code == 422
    assert e.value.detail["check"]["issues"][0]["code"] == "looks_thb_as_usd"
    saved = mod.add_dividend(mod.DividendIn(**body, force=True))
    assert saved["currency"] == "USD"


def test_explicit_thb_for_a_us_stock_is_kept(env):
    """The old rule (a matching trade always wins) turned this into USD."""
    mod, db, _ = env
    saved = mod.add_dividend(mod.DividendIn(
        account_id="dime", asset="JEPQ", ex_date="2025-08-01", pay_date="2025-08-05",
        amount_per_unit=14.34, total_received=886.0, currency="THB"))
    assert saved["currency"] == "THB"
    # …and an edit keeps it too (this is how the 07-14 fix was undone on 07-28)
    mod.update_dividend(saved["id"], mod.DividendIn(
        account_id="dime", asset="JEPQ", ex_date="2025-08-01", pay_date="2025-08-05",
        amount_per_unit=14.34, total_received=886.0, currency="THB"))
    with db.get_db() as conn:
        assert conn.execute("SELECT currency FROM dividends WHERE id = ?",
                            (saved["id"],)).fetchone()[0] == "THB"
