"""Portfolio rotation map — weekly open-lot cost by bucket (pure, no DB)."""

from __future__ import annotations

from datetime import date

import portfolio_rotation as pr


def _t(symbol, entry, exit_=None, amount=100.0, market="US", win_loss=None, sector="X"):
    return {"symbol": symbol, "date_entry": entry, "date_exit": exit_, "amount": amount,
            "market": market, "win_loss": win_loss, "sector": sector}


def _build(trades, today=date(2026, 3, 6)):
    return pr.build_rotation(trades, pr.theme_of, lambda t: t["amount"], today=today,
                             order=pr.THEME_ORDER)


def test_theme_mapping_order_of_precedence():
    assert pr.theme_of({"symbol": "SNDK", "market": "US"}) == "MEMORY"
    assert pr.theme_of({"symbol": "DELTA", "market": "TH"}) == "POWER"  # symbol beats market
    assert pr.theme_of({"symbol": "AOT", "market": "TH"}) == "TH LEGACY"
    assert pr.theme_of({"symbol": "SOL-USD", "market": "CRYPTO"}) == "CRYPTO"
    assert pr.theme_of({"symbol": "ZZZZ", "market": "US"}) == "OTHER"


def test_lot_counts_only_while_open():
    out = _build([_t("MU", "2026-01-05", "2026-01-21", amount=500)])
    mem = next(s for s in out["series"] if s["key"] == "MEMORY")
    by_week = dict(zip(out["weeks"], mem["values"]))
    assert by_week["2026-01-09"] == 500
    assert by_week["2026-01-16"] == 500
    assert by_week["2026-01-23"] == 0  # sold on the 21st
    assert mem["latest"] == 0 and mem["peak"] == 500


def test_last_week_is_today_and_total_is_sum():
    out = _build([_t("MU", "2026-01-05", amount=200), _t("GOOGL", "2026-01-05", amount=300)],
                 today=date(2026, 3, 4))
    assert out["weeks"][-1] == "2026-03-04"
    assert out["total"][-1] == 500
    assert [s["key"] for s in out["series"]] == ["PLATFORM", "MEMORY"]  # THEME_ORDER


def test_closed_without_exit_date_is_excluded():
    out = _build([_t("MU", "2026-01-05", win_loss="W"), _t("MU", "2026-01-05")])
    assert out["excluded"] == 1
    assert out["total"][-1] == 100


def test_markers_are_cuts_only():
    trades = [_t("INTC", "2026-01-02", "2026-02-10", amount=1000),
              _t("GOOGL", "2026-01-02", amount=200),
              _t("SNDK", "2026-02-18", amount=400)]
    out = _build(trades)
    assert [(m["kind"], m["label"]) for m in out["markers"]] == [("cut", "ลดพอร์ต −83%")]


def test_open_symbols_list_only_unclosed_lots():
    out = _build([_t("MU", "2026-01-05", "2026-01-20"), _t("SNDK", "2026-01-05")])
    mem = next(s for s in out["series"] if s["key"] == "MEMORY")
    assert mem["open_symbols"] == ["SNDK"]


def test_empty_book():
    out = _build([])
    assert out["weeks"] == [] and out["series"] == []


def test_leading_flat_run_is_trimmed():
    trades = [_t("AOT", "2025-01-01", market="TH", amount=1000),
              _t("MU", "2026-02-10", amount=100)]
    out = _build(trades)
    assert out["flat_since"] == "2025-01-03"
    assert out["weeks"][0] == "2026-02-06"  # one week before the first move
    assert out["total"][:2] == [1000, 1100]
