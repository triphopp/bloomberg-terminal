"""Currency-as-first-class regression tests (no network)."""
import sqlite3

import db
from portfolio_currency import (
    backfill_currency_columns,
    convert_amount,
    fx_rate,
    infer_instrument_currency,
    realized_economic_pnl_in_report,
    realized_pnl_in_report,
    trade_currency,
)
from routers import portfolio_v2


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    return conn


def test_inference_uses_market_and_crypto_quote():
    assert infer_instrument_currency("TH", "BH.BK", "BH") == "THB"
    assert infer_instrument_currency("US", "MSFT", "MSFT") == "USD"
    assert infer_instrument_currency("CRYPTO", "BTC-USD", "BTC") == "USD"
    assert infer_instrument_currency("CRYPTO", "ETH-USDT", "ETH") == "USDT"


def test_stored_trade_currency_is_authoritative():
    row = {"currency": "THB", "market": "US", "resolved_symbol": "MSFT"}
    assert trade_currency(row) == "THB"


def test_explicit_rate_conversion():
    assert convert_amount(10, "USD", "THB", stored_thb_rate=32.5) == 325
    assert convert_amount(325, "THB", "USD", stored_thb_rate=32.5) == 10


def test_realized_pnl_uses_exit_fx_without_principal_fx_attribution():
    row = {
        "currency": "USD",
        "date_entry": "2026-01-02",
        "date_exit": "2026-02-02",
        "price_entry": 10,
        "volume": 10,
        "pnl_amount": 10,
        "exchange_rate": 30,
        "exit_exchange_rate": 35,
    }
    # Trading P&L is 10 USD × exit FX 35 = 350 THB. The 500 THB FX gain
    # on the 100 USD principal is intentionally not part of REALIZED P&L.
    assert realized_pnl_in_report(row, "THB") == 350
    assert realized_pnl_in_report(row, "USD") == 10


def test_economic_realized_pnl_includes_principal_fx_attribution():
    row = {
        "currency": "USD",
        "date_entry": "2026-01-02",
        "date_exit": "2026-02-02",
        "price_entry": 10,
        "volume": 10,
        "pnl_amount": 10,
        "exchange_rate": 30,
        "exit_exchange_rate": 35,
    }
    # Exit value 110 USD × 35 minus entry cost 100 USD × 30 = 850 THB.
    assert realized_economic_pnl_in_report(row, "THB") == 850
    assert realized_economic_pnl_in_report(row, "USD") == 10


def test_dated_fx_uses_nearest_prior_trading_day():
    conn = _conn()
    conn.execute(
        "CREATE TABLE fx_rates(date TEXT, base TEXT, quote TEXT, rate REAL, "
        "source TEXT, updated_at TEXT, PRIMARY KEY(date,base,quote))"
    )
    conn.execute(
        "INSERT INTO fx_rates(date,base,quote,rate) VALUES ('2026-01-02','USD','THB',32.25)"
    )
    assert fx_rate("USD", "THB", "2026-01-04", conn=conn) == 32.25


def test_currency_backfill_corrects_trade_and_seeds_dividend():
    conn = _conn()
    conn.executescript(
        """
        CREATE TABLE portfolio_accounts(id TEXT PRIMARY KEY, currency TEXT);
        CREATE TABLE trades(
            id TEXT PRIMARY KEY, account_id TEXT, symbol TEXT, resolved_symbol TEXT,
            market TEXT, currency TEXT, date_entry TEXT
        );
        CREATE TABLE dividends(
            id TEXT PRIMARY KEY, account_id TEXT, asset TEXT, currency TEXT
        );
        INSERT INTO portfolio_accounts VALUES ('dime','USD');
        INSERT INTO trades VALUES ('t1','dime','BH','BH.BK','TH','USD','2026-07-14');
        INSERT INTO dividends VALUES ('d1','dime','BH',NULL);
        """
    )
    changed = backfill_currency_columns(conn)
    assert changed == {"trades": 1, "dividends": 1}
    assert conn.execute("SELECT currency FROM trades").fetchone()[0] == "THB"
    assert conn.execute("SELECT currency FROM dividends").fetchone()[0] == "THB"


def test_create_and_partial_sell_persist_instrument_and_exit_fx(tmp_path, monkeypatch):
    """Exercise the real INSERT/SELECT SQL, including the partial-sell clone."""
    test_db = tmp_path / "portfolio-multicurrency.db"
    monkeypatch.setattr(db, "DB_PATH", test_db)
    db.init_portfolio_v2()
    portfolio_v2.create_account(
        portfolio_v2.AccountIn(
            id="dime", name="Dime", currency="USD", country="US"
        )
    )

    created = portfolio_v2.create_trade(
        portfolio_v2.TradeIn(
            account_id="dime",
            symbol="BH",
            resolved_symbol="BH.BK",
            market="TH",
            date_entry="2026-07-01",
            price_entry=160,
            volume=10,
        )
    )
    assert created["currency"] == "THB"
    assert created["exchange_rate"] == 1

    sold = portfolio_v2.sell_position(
        portfolio_v2.SellIn(
            trade_id=created["id"],
            sell_volume=4,
            sell_price=170,
            sell_date="2026-07-14",
        )
    )
    assert sold["action"] == "partial_sell"

    with db.get_db() as conn:
        rows = conn.execute(
            "SELECT win_loss, volume, currency, exchange_rate, exit_exchange_rate "
            "FROM trades WHERE symbol = 'BH' ORDER BY win_loss"
        ).fetchall()
    assert len(rows) == 2
    closed = next(row for row in rows if row["win_loss"] != "P")
    opened = next(row for row in rows if row["win_loss"] == "P")
    assert closed["currency"] == "THB"
    assert closed["exchange_rate"] == 1
    assert closed["exit_exchange_rate"] == 1
    assert closed["volume"] == 4
    assert opened["volume"] == 6

    dividend = portfolio_v2.add_dividend(
        portfolio_v2.DividendIn(
            account_id="dime",
            asset="BH",
            pay_date="2026-07-14",
            total_received=500,
            currency="USD",  # stale account/form default must not beat the trade
        )
    )
    assert dividend["currency"] == "THB"
