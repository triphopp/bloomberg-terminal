from dataclasses import replace

import pytest

from ledger_backfill import Event
from ledger_engine import LedgerError, replay


def event(id, day, type, qty, price, fee=0, vat=0, tax=0, time=None):
    gross = qty * price
    return Event(id, "acc", day, type, -gross-fee-vat if type == "BUY" else gross-fee-vat-tax,
                 "THB", symbol="PTT", qty=qty, price=price, gross=gross, fee=fee,
                 vat=vat, tax=tax, trade_time=time)


@pytest.mark.parametrize("method", ["AVCO", "FIFO"])
def test_cost_and_cash_conserved_over_complete_cycle(method):
    events = [event("a", "2026-01-05", "BUY", 100, 10, 5),
              event("b", "2026-02-10", "BUY", 200, 12, 10),
              event("c", "2026-03-15", "SELL", 150, 15, 8),
              event("d", "2026-04-20", "BUY", 50, 9, 3),
              event("e", "2026-05-25", "SELL", 200, 11, 7)]
    rows = replay(events, method)
    assert rows[-1]["bal_qty"] == rows[-1]["bal_cost"] == 0
    assert sum(r["cost_in"] for r in rows) == pytest.approx(sum(r["cost_out"] for r in rows))
    assert sum(r["realized"] or 0 for r in rows) == pytest.approx(567)
    assert sum(e.net_cash for e in events) == pytest.approx(567)
    if method == "AVCO":
        assert [r["realized"] for r in rows if r["realized"] is not None] == pytest.approx([534.5, 32.5])
    else:
        assert [a["buy_event_id"] for a in rows[2]["allocations"]] == ["a", "b"]
        assert [a["qty"] for a in rows[2]["allocations"]] == [100, 50]


@pytest.mark.parametrize("method", ["AVCO", "FIFO"])
def test_sndk_real_cycle(method):
    events = [event("a", "2026-09-11", "BUY", 6.0552718, 1648.8074, time="10:00"),
              event("b", "2026-09-11", "BUY", 1.0450004, 1528.65, time="11:00"),
              event("c", "2026-09-16", "BUY", 1.3626053, 1538.69),
              event("d", "2026-09-21", "SELL", 4, 1752.61),
              event("e", "2026-09-24", "SELL", 4.4628775, 1756.96)]
    rows = replay(events, method)
    expected = [545.479, 628.011] if method == "AVCO" else [415.2104, 758.28]
    assert [rows[3]["realized"], rows[4]["realized"]] == pytest.approx(expected, abs=0.02)
    assert rows[-1]["bal_cost"] == 0
    assert rows[3]["avg"] == pytest.approx(1616.2403 if method == "AVCO" else 1587.05, abs=0.01)


def test_fifo_partial_same_day_then_new_cycle():
    events = [event("a", "2026-01-01", "BUY", 10, 10),
              event("b", "2026-01-02", "SELL", 4, 20, time="09:00"),
              event("c", "2026-01-02", "BUY", 4, 30, time="10:00"),
              event("d", "2026-01-03", "SELL", 10, 40),
              event("e", "2026-01-04", "BUY", 1, 99)]
    rows = replay(list(reversed(events)), "FIFO")
    assert rows[1]["cost_out"] == 40
    assert rows[3]["cost_out"] == 180
    assert rows[4]["avg"] == 99


@pytest.mark.parametrize("method", ["AVCO", "FIFO"])
def test_fractional_full_close_allocates_all_cost_and_fees(method):
    rows = replay([event("a", "2026-01-01", "BUY", 1/3, 10, 0.1, 0.007),
                   event("b", "2026-01-02", "SELL", 1/3, 12, 0.2, 0.014, 0.03)], method)
    assert rows[-1]["bal_cost"] == 0
    assert rows[-1]["realized"] == pytest.approx(4 - 0.2 - 0.014 - 0.03 - (10/3 + 0.107))
    assert sum(a["cost"] for a in rows[-1]["allocations"]) == pytest.approx(rows[-1]["cost_out"])


@pytest.mark.parametrize("method", ["AVCO", "FIFO"])
def test_no_fabricated_profit_when_buy_is_missing(method):
    with pytest.raises(LedgerError, match="exceeds"):
        replay([event("s", "2026-01-01", "SELL", 1, 100)], method)


@pytest.mark.parametrize("change", [{"qty": -1}, {"qty": float("nan")}, {"fee": -1}])
def test_invalid_numbers_rejected(change):
    with pytest.raises(LedgerError):
        replay([replace(event("a", "2026-01-01", "BUY", 1, 10), **change)])


def test_mixed_currency_and_duplicate_ids_rejected():
    e = event("a", "2026-01-01", "BUY", 1, 10)
    with pytest.raises(LedgerError, match="Duplicate"):
        replay([e, e])
    with pytest.raises(LedgerError, match="one account"):
        replay([e, replace(e, id="b", currency="USD")])
