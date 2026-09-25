"""Average-cost accounting across sells (no network).

A sell is priced off the AVCO of every open lot, so the shares left behind must
carry that same average. Before the fix the remaining lot kept its own
price_entry and the position's ENTRY jumped the moment a cheap lot was sold —
the SNDK case: 1616.2403 became 1648.8074 after a partial sale.
"""
import importlib
import uuid

import pytest

db = None
portfolio_v2 = None


@pytest.fixture()
def dbfile(tmp_path, monkeypatch):
    global db, portfolio_v2
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "sell.db"))
    import config
    importlib.reload(config)
    import db as db_mod
    importlib.reload(db_mod)
    db = db_mod
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema()
    db.init_alerts_schema(); db.init_sync_layer(); db.init_audit_layer()
    import portfolio_currency
    importlib.reload(portfolio_currency)
    import routers.portfolio_v2 as mod
    importlib.reload(mod)
    portfolio_v2 = mod
    with db.get_db() as conn:
        conn.execute(
            "INSERT INTO portfolio_accounts (id, name, broker, country, currency, account_type) "
            "VALUES ('dime','DIME','','US','USD','equity')"
        )
    return mod


def _lot(conn, symbol, price, volume, date="2026-09-11"):
    tid = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO trades (id, account_id, symbol, resolved_symbol, market, sector, "
        "date_entry, price_entry, volume, win_loss, currency) "
        "VALUES (?, 'dime', ?, ?, 'US', 'Information Technology', ?, ?, ?, 'P', 'USD')",
        (tid, symbol, symbol, date, price, volume),
    )
    return tid


def _open_lots(symbol="SNDK"):
    with db.get_db() as conn:
        return [
            dict(r)
            for r in conn.execute(
                "SELECT id, price_entry, volume FROM trades "
                "WHERE symbol = ? AND win_loss = 'P' ORDER BY rowid",
                (symbol,),
            ).fetchall()
        ]


def test_partial_sell_keeps_remaining_lots_on_the_pooled_average(dbfile):
    """The SNDK numbers, exactly: three lots, sell 4 units, remainder stays at AVCO."""
    with db.get_db() as conn:
        a = _lot(conn, "SNDK", 1648.8074, 6.0552718)
        _lot(conn, "SNDK", 1528.65, 1.0450004)
        _lot(conn, "SNDK", 1538.69, 1.3626053)

    expected_avco = (
        1648.8074 * 6.0552718 + 1528.65 * 1.0450004 + 1538.69 * 1.3626053
    ) / (6.0552718 + 1.0450004 + 1.3626053)
    assert expected_avco == pytest.approx(1616.2403, abs=1e-4)

    out = portfolio_v2.sell_position(
        portfolio_v2.SellIn(
            trade_id=a, sell_volume=1.5923943, sell_price=1752.61, sell_date="2026-09-21"
        )
    )
    assert out["action"] == "partial_sell"
    assert out["avg_cost"] == pytest.approx(expected_avco, abs=1e-4)

    # Every lot still open — the reduced one and its untouched siblings — now
    # carries the pooled average, so the position's ENTRY column does not move.
    for lot in _open_lots():
        assert lot["price_entry"] == pytest.approx(expected_avco, abs=1e-4)


def test_selling_lot_by_lot_does_not_drift_the_average(dbfile):
    """SellModal fills a multi-lot sale one lot at a time; each call must land on
    the same average the first one used."""
    with db.get_db() as conn:
        a = _lot(conn, "SNDK", 1648.8074, 6.0552718)
        b = _lot(conn, "SNDK", 1528.65, 1.0450004)
        c = _lot(conn, "SNDK", 1538.69, 1.3626053)

    expected_avco = (
        1648.8074 * 6.0552718 + 1528.65 * 1.0450004 + 1538.69 * 1.3626053
    ) / (6.0552718 + 1.0450004 + 1.3626053)

    portfolio_v2.sell_position(
        portfolio_v2.SellIn(
            trade_id=a, sell_volume=1.5923943, sell_price=1752.61, sell_date="2026-09-21"
        )
    )
    for lot_id in (b, c):
        portfolio_v2.sell_position(
            portfolio_v2.SellIn(
                trade_id=lot_id, sell_volume=0, sell_price=1752.61, sell_date="2026-09-21"
            )
        )

    remaining = _open_lots()
    assert len(remaining) == 1
    assert remaining[0]["price_entry"] == pytest.approx(expected_avco, abs=1e-4)
    assert remaining[0]["volume"] == pytest.approx(6.0552718 - 1.5923943, abs=1e-6)

    # Realized rows are booked at the same average, so realized + unrealized
    # split the pool instead of double counting it.
    with db.get_db() as conn:
        closed = conn.execute(
            "SELECT price_entry, volume FROM trades WHERE symbol = 'SNDK' AND win_loss != 'P'"
        ).fetchall()
    assert len(closed) == 3
    for row in closed:
        assert row["price_entry"] == pytest.approx(expected_avco, abs=1e-4)

    sold_cost = sum(r["price_entry"] * r["volume"] for r in closed)
    open_cost = remaining[0]["price_entry"] * remaining[0]["volume"]
    original_pool = 1648.8074 * 6.0552718 + 1528.65 * 1.0450004 + 1538.69 * 1.3626053
    assert sold_cost + open_cost == pytest.approx(original_pool, abs=0.01)


def test_cost_override_beats_the_lot_math_and_is_what_lots_rebase_to(dbfile):
    with db.get_db() as conn:
        a = _lot(conn, "SNDK", 1700.0, 4.0)
        conn.execute(
            "INSERT INTO position_cost_overrides (account_id, symbol, avg_cost, reason, updated_at) "
            "VALUES ('dime','SNDK',1600.0,'broker statement','2026-09-21')"
        )

    out = portfolio_v2.sell_position(
        portfolio_v2.SellIn(
            trade_id=a, sell_volume=1.0, sell_price=1800.0, sell_date="2026-09-21",
            commission=0,  # fees are covered in test_trade_fees.py
        )
    )
    assert out["avg_cost"] == pytest.approx(1600.0)
    assert out["pnl_amount"] == pytest.approx(200.0)
    assert _open_lots()[0]["price_entry"] == pytest.approx(1600.0)
