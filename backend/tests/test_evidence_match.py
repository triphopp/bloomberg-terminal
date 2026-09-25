"""Broker fills vs the reconstructed book: every fill and book row lands in one
bucket, the Thai display time maps to the New York trade date, and nothing is
written. Shapes mirror the Dime 2026-04..06 screenshots."""
import importlib
import uuid

import pytest


@pytest.fixture()
def book(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "portfolio.db"))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_sync_layer(); db.init_audit_layer()
    import ledger_backfill
    importlib.reload(ledger_backfill)
    import evidence_match
    importlib.reload(evidence_match)
    with db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts(id,name,currency) VALUES ('dime','Dime','USD')")
    return db, evidence_match


def _trade(db, sym, entry, price, vol, exit_date=None, exit_price=None):
    with db.get_db() as conn:
        conn.execute(
            """INSERT INTO trades(id,account_id,symbol,date_entry,date_exit,price_entry,price_exit,
                                  volume,currency,win_loss,market,pnl_amount)
               VALUES (?,?,?,?,?,?,?,?,'USD',?,'US',?)""",
            (str(uuid.uuid4()), "dime", sym, entry, exit_date, price, exit_price, vol,
             "P" if exit_date is None else "W",
             None if exit_price is None else (exit_price - price) * vol))


def _fill(db, sym, side, local, qty, price, amount=None):
    with db.get_db() as conn:
        conn.execute(
            """INSERT INTO broker_executions(id,account_id,broker,symbol,side,executed_at_local,
                   display_timezone,quantity,unit_price,instrument_ccy,order_amount,order_ccy,
                   source_image,source_sha256)
               VALUES (?,?,?,?,?,?,'UNKNOWN',?,?,'USD',?,?,'img.png',?)""",
            (str(uuid.uuid4()), "dime", "Dime", sym, side, local, str(qty), str(price),
             None if amount is None else str(amount), None if amount is None else "USD", "0" * 64))


def _run(db, em):
    with db.get_db() as conn:
        before = conn.total_changes
        result = em.run(conn)
        assert conn.total_changes == before  # read-only
    return result


def test_thai_display_time_maps_to_new_york_trade_date(book):
    _, em = book
    assert em.us_trade_date("2026-04-28T00:22:24") == "2026-04-27"  # after midnight in Bangkok
    assert em.us_trade_date("2026-04-22T20:41:51") == "2026-04-22"  # US open, same day
    assert em.us_trade_date("2026-12-01T21:40:00") == "2026-12-01"  # EST, winter


def test_matched_consolidated_and_fee_gap(book):
    db, em = book
    # three buys merged into one lot at their VWAP; the sale is one row
    _fill(db, "GRID", "BUY", "2026-04-27T23:12:00", 3.9199786, 187.2, 735.00)
    _fill(db, "GRID", "BUY", "2026-05-05T20:43:33", 3.1392246, 191.13, 600.00)
    _fill(db, "GRID", "BUY", "2026-05-06T20:39:36", 17.8163511, 196.4488, 3500.00)
    _fill(db, "GRID", "SELL", "2026-06-22T22:48:12", 24.8755543, 196.2960)
    _trade(db, "GRID", "2026-05-06", 194.3201, 24.8755543, "2026-06-22", 196.2960)
    r = _run(db, em)
    assert r["counts"] == {"CONSOLIDATED": 1, "MATCHED": 1}
    s = r["symbols"][0]
    assert s["qty_match"] and s["verified"]
    assert s["fee_gap"] == pytest.approx(1.18, abs=0.01)  # only the first buy paid 0.16 %
    assert s["cash_gap_ex_fees"] == pytest.approx(0, abs=0.05)


def test_round_trip_missing_from_book_is_reported_with_its_cash(book):
    db, em = book
    _fill(db, "ASTS", "BUY", "2026-04-28T00:22:50", 53.5668706, 76.79, 4120.00)
    _fill(db, "ASTS", "SELL", "2026-04-29T20:45:35", 53.5668706, 68.6301)
    r = _run(db, em)
    assert r["counts"] == {"MISSING_IN_DB": 2}
    s = r["symbols"][0]
    assert s["broker_cash"] == pytest.approx(-443.70, abs=0.01)
    assert s["cash_gap_ex_fees"] == pytest.approx(437.10, abs=0.01)  # book holds the loss as cash
    assert not s["verified"]


def test_book_kept_only_the_unsold_remainder(book):
    db, em = book
    _fill(db, "NFLX", "BUY", "2026-04-22T20:41:51", 106.7405249, 93.5350, 10000)
    _fill(db, "NFLX", "BUY", "2026-04-22T20:44:22", 26.6866300, 93.5297, 2500)
    _fill(db, "NFLX", "SELL", "2026-05-06T20:35:18", 70, 86.9003)
    _fill(db, "NFLX", "SELL", "2026-05-06T20:38:48", 40, 87.34)
    _trade(db, "NFLX", "2026-04-22", 93.5338, 23.427155)
    r = _run(db, em)
    assert r["counts"] == {"NETTED": 1}
    row = r["rows"][0]
    assert row["fill_qty"] == pytest.approx(23.4271549, abs=1e-6)
    assert row["missing_realized"] == pytest.approx(-712.11, abs=0.01)
    assert r["symbols"][0]["qty_match"]


def test_book_rows_inside_and_outside_the_evidence_window(book):
    db, em = book
    _fill(db, "SGOV", "BUY", "2026-05-06T22:09:37", 46.7207904, 100.4364, 4700)
    _trade(db, "SGOV", "2026-05-06", 100.4364, 46.7207904)
    _trade(db, "SGOV", "2026-05-06", 100.5, 10)       # same day, no screenshot
    _trade(db, "SGOV", "2026-08-01", 100.8, 5)        # after the screenshots end
    r = _run(db, em)
    assert r["counts"] == {"MATCHED": 1, "NO_EVIDENCE": 1, "OUT_OF_COVERAGE": 1}
    assert not r["symbols"][0]["verified"]


def test_no_evidence_table_rows_gives_empty_report(book):
    db, em = book
    _trade(db, "COST", "2026-09-25", 914.0352, 3.4953472)
    r = _run(db, em)
    assert r["fills"] == 0 and r["symbols"] == [] and r["rows"] == []


def test_evidence_image_is_served_only_while_its_hash_matches(book, tmp_path):
    import hashlib
    from fastapi import HTTPException
    import routers.portfolio_v2 as mod
    importlib.reload(mod)
    db, _ = book
    folder = tmp_path / "backups" / "evidence"
    folder.mkdir(parents=True)
    image = folder / "img.png"
    image.write_bytes(b"broker activity screen")
    _fill(db, "GRID", "BUY", "2026-05-05T20:43:33", 3.1392246, 191.13, 600)
    with db.get_db() as conn:
        fid = conn.execute("SELECT id FROM broker_executions").fetchone()[0]
        conn.execute("UPDATE broker_executions SET source_sha256=?",
                     (hashlib.sha256(image.read_bytes()).hexdigest(),))
    assert str(mod.get_ledger_evidence_image(fid).path) == str(image)
    image.write_bytes(b"edited afterwards")
    with pytest.raises(HTTPException) as exc:
        mod.get_ledger_evidence_image(fid)
    assert exc.value.status_code == 404
    assert mod.get_ledger_evidence(account_id="all")["fills"] == 1
