"""A fund beside the personal book changes nothing in the personal book.

plans/fund-book.md, D5: a fund is its own book and is never part of "all".
The test reads every personal figure, adds a fund with its own accounts,
trades, cash, dividends and cash offsets, and reads them again — the two
readings must be equal. Then it reads the fund and checks it holds exactly
the fund's rows.

A new endpoint that takes `account_id` belongs in PROBES.
"""
import importlib
import inspect
import json

import pytest


def _call(fn, **override):
    """Call a route function the way FastAPI would with no query string:
    every `Query(...)` default replaced by the value it stands for."""
    kwargs = {}
    for name, p in inspect.signature(fn).parameters.items():
        if name in override:
            kwargs[name] = override[name]
        elif p.default is inspect.Parameter.empty:
            continue
        else:
            kwargs[name] = getattr(p.default, "default", p.default)
    return fn(**kwargs)


def _plain(value):
    return json.loads(json.dumps(value, default=str, sort_keys=True))


@pytest.fixture()
def book(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "isolation.db"))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema()
    db.init_alerts_schema(); db.init_sync_layer()
    import portfolio_currency
    importlib.reload(portfolio_currency)
    # No market: one fixed USD/THB for every date, so two readings are comparable.
    monkeypatch.setattr(portfolio_currency, "live_usd_thb", lambda: 35.0)
    monkeypatch.setattr(portfolio_currency, "_ensure_history_once", lambda conn=None: None)
    import portfolio_options
    importlib.reload(portfolio_options)
    import routers.portfolio_v2 as pv2
    importlib.reload(pv2)
    import routers.trade_history as th
    importlib.reload(th)
    import routers.risk as risk
    importlib.reload(risk)
    monkeypatch.setattr(pv2, "_get_thb_per_usd", lambda: 35.0)
    monkeypatch.setattr(pv2, "_batch_fetch_prices", lambda syms: {})
    monkeypatch.setattr(pv2, "capture_daily_greeks", lambda *a, **k: None, raising=False)
    with db.get_db() as conn:
        _account(conn, "finansia", "THB")
        _account(conn, "dime", "USD")
        _rows(conn, "finansia", "THB", "PTT", tag="p1")
        _rows(conn, "dime", "USD", "MU", tag="p2")
    import ledger
    importlib.reload(ledger)
    import routers.ledger as ledger_router
    importlib.reload(ledger_router)
    return {"db": db, "pv2": pv2, "th": th, "risk": risk, "ledger": ledger, "ledger_router": ledger_router}


def _account(conn, account_id, currency, fund_id=None):
    conn.execute("INSERT INTO portfolio_accounts (id, name, currency, fund_id) VALUES (?,?,?,?)",
                 (account_id, account_id.upper(), currency, fund_id))


def _rows(conn, account_id, currency, symbol, tag):
    """One of everything an account can own."""
    fx = 33.0 if currency == "USD" else 1.0
    market = "US" if currency == "USD" else "TH"
    conn.execute("INSERT INTO cash_ledger (id, account_id, date, investment, exchange_rate) VALUES (?,?,?,?,?)",
                 (f"cash-{tag}", account_id, "2026-01-01", 100000, fx))
    conn.execute(
        "INSERT INTO trades (id, account_id, symbol, resolved_symbol, market, currency, date_entry, "
        "price_entry, volume, amount, win_loss, exchange_rate) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (f"open-{tag}", account_id, symbol, symbol, market, currency, "2026-01-05", 30, 1000, 30000, "P", fx))
    conn.execute(
        "INSERT INTO trades (id, account_id, symbol, resolved_symbol, market, currency, date_entry, date_exit, "
        "price_entry, price_exit, volume, amount, pnl_amount, pnl_percent, win_loss, exchange_rate, "
        "exit_exchange_rate, acquisition_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (f"closed-{tag}", account_id, symbol, symbol, market, currency, "2026-01-06", "2026-02-06",
         10, 12, 500, 5000, 1000, 20, "W", fx, fx, "TRANSFER_IN"))
    conn.execute(
        "INSERT INTO dividends (id, account_id, asset, ex_date, pay_date, total_received, currency) "
        "VALUES (?,?,?,?,?,?,?)",
        (f"div-{tag}", account_id, symbol, "2026-03-01", "2026-03-15", 250, currency))
    conn.execute(
        "INSERT INTO cash_adjustments (id, account_id, date, amount, currency, note) VALUES (?,?,?,?,?,?)",
        (f"adj-{tag}", account_id, "2026-03-20", 40, currency, "reconcile"))
    conn.execute("INSERT INTO position_cost_overrides (account_id, symbol, avg_cost, reason) VALUES (?,?,?,?)",
                 (account_id, symbol, 29.5, "broker"))
    conn.execute("INSERT INTO ledger_wallet_rules (id, account_id, symbol_pattern, wallet) VALUES (?,?,?,?)",
                 (f"rule-{tag}", account_id, symbol, "MAIN"))


def _add_fund(db):
    with db.get_db() as conn:
        _account(conn, "kongsi-th", "THB", fund_id="kongsi")
        _account(conn, "kongsi-us", "USD", fund_id="kongsi")
        _rows(conn, "kongsi-th", "THB", "ADVANC", tag="f1")
        _rows(conn, "kongsi-us", "USD", "VT", tag="f2")


def _with_conn(mods, fn):
    with mods["db"].get_db() as conn:
        return fn(conn)


def _probes(mods):
    pv2, th, risk = mods["pv2"], mods["th"], mods["risk"]
    return {
        "accounts": lambda s: _call(pv2.list_accounts, account_id=s),
        "summary": lambda s: _call(pv2.get_summary, account_id=s),
        "trades": lambda s: _call(pv2.list_trades, account_id=s),
        "cash": lambda s: _call(pv2.list_cash, account_id=s),
        "cash_adjustments": lambda s: _call(pv2.list_cash_adjustments, account_id=s),
        "dividends": lambda s: _call(pv2.list_dividends, account_id=s),
        "takeover": lambda s: _call(pv2.get_takeover, account_id=s),
        "cost_overrides": lambda s: _call(pv2.get_cost_overrides, account_id=s),
        "audit_log": lambda s: _call(pv2.get_recent_audit_log, account_id=s),
        "audit_events": lambda s: _call(pv2.list_audit_events, account_id=s),
        "open_positions": lambda s: _call(pv2.get_open_positions, account_id=s),
        "returns": lambda s: _call(pv2.get_portfolio_returns, account_id=s),
        "nav_history": lambda s: _call(pv2.get_nav_history, account_id=s),
        "analytics": lambda s: _call(pv2.get_analytics, account_id=s),
        "allocation_history": lambda s: _call(pv2.get_allocation_history, account_id=s),
        "ledger_check": lambda s: _call(pv2.get_ledger_check, account_id=s),
        "ledger_statements": lambda s: _call(pv2.get_ledger_statements, account_id=s),
        "ledger_evidence": lambda s: _call(pv2.get_ledger_evidence, account_id=s),
        "history_coverage": lambda s: th.coverage(s),
        "history_trades": lambda s: th.list_lots(account_id=s),
        "history_stats": lambda s: th.lot_stats(account_id=s),
        "ledger_accounts": lambda s: [a["id"] for a in mods["ledger_router"].list_accounts(account_id=s)["accounts"]],
        "ledger_events": lambda s: _with_conn(mods, lambda c: mods["ledger"].events(c, s)),
        "ledger_balances": lambda s: _with_conn(mods, lambda c: mods["ledger"].balances(c, s)),
        "ledger_closes": lambda s: _with_conn(mods, lambda c: mods["ledger"].closes(c, s)),
        "ledger_rules": lambda s: _with_conn(mods, lambda c: mods["ledger"].wallet_rules(c, s)),
        "risk_positions": lambda s: [
            {k: p.get(k) for k in ("account_id", "symbol", "volume")}
            for p in risk._open_positions_priced(s)],
    }


# The time a result was produced — the only thing allowed to differ.
_VOLATILE = {"as_of", "generated_at"}


def _still(value):
    """A result without the clock readings it carries."""
    if isinstance(value, dict):
        return {k: _still(v) for k, v in value.items() if k not in _VOLATILE}
    if isinstance(value, list):
        return [_still(v) for v in value]
    return value


def _read(mods, scope):
    out = {}
    for name, probe in _probes(mods).items():
        out[name] = _plain(probe(scope))
    return out


def _symbols(value, found=None):
    """Every string in a result, for 'does the fund show up anywhere' checks."""
    found = set() if found is None else found
    if isinstance(value, dict):
        for v in value.values():
            _symbols(v, found)
    elif isinstance(value, list):
        for v in value:
            _symbols(v, found)
    elif isinstance(value, str):
        found.add(value)
    return found


@pytest.mark.parametrize("scope", ["all", None])
def test_the_personal_book_does_not_move_when_a_fund_is_added(book, scope):
    _read(book, scope)          # the first view of the day captures the NAV snapshot
    before = _read(book, scope)
    _add_fund(book["db"])
    after = _read(book, scope)
    for name in before:
        assert _still(after[name]) == _still(before[name]), f"{name}: the fund leaked into the personal book"


def test_nothing_of_the_fund_is_named_in_the_personal_book(book):
    _add_fund(book["db"])
    for name, value in _read(book, "all").items():
        leaked = _symbols(value) & {"kongsi-th", "kongsi-us", "ADVANC", "VT", "kongsi"}
        assert not leaked, f"{name} names {sorted(leaked)}"


def test_the_fund_scope_holds_the_fund_and_only_the_fund(book):
    _add_fund(book["db"])
    pv2 = book["pv2"]
    scope = "fund:kongsi"
    trades = _call(pv2.list_trades, account_id=scope)
    rows = trades["trades"] if isinstance(trades, dict) else trades
    assert sorted(r["id"] for r in rows) == ["closed-f1", "closed-f2", "open-f1", "open-f2"]
    assert sorted(r["id"] for r in _call(pv2.list_cash, account_id=scope)) == ["cash-f1", "cash-f2"]
    assert sorted(r["id"] for r in _call(pv2.list_cash_adjustments, account_id=scope)) == ["adj-f1", "adj-f2"]
    divs = _call(pv2.list_dividends, account_id=scope)
    divs = divs["dividends"] if isinstance(divs, dict) else divs
    assert sorted(r["id"] for r in divs) == ["div-f1", "div-f2"]
    for name, value in _read(book, scope).items():
        leaked = _symbols(value) & {"finansia", "dime", "PTT", "MU"}
        assert not leaked, f"{name} for the fund names {sorted(leaked)}"


def test_one_account_is_still_one_account(book):
    _add_fund(book["db"])
    pv2 = book["pv2"]
    rows = _call(pv2.list_cash, account_id="kongsi-th")
    assert [r["id"] for r in rows] == ["cash-f1"]
    rows = _call(pv2.list_cash, account_id="finansia")
    assert [r["id"] for r in rows] == ["cash-p1"]


def test_a_fund_that_does_not_exist_is_empty_not_everything(book):
    _add_fund(book["db"])
    assert _call(book["pv2"].list_cash, account_id="fund:nope") == []
