"""Trade history for agents (routers/trade_history.py + the MCP tools over it).

What is tested is the promise the module makes: a model reading these results
cannot be handed something that looks like an answer and is not one. Exact
filters, an honest page count, sums done by the server over every matching
row, currencies kept apart, NULL kept NULL — and each figure checked against a
plain SQL query on the same database.
"""
import importlib
import json

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient


# id, account, symbol, resolved, ccy, entry, exit, avg cost, exit px, volume, pnl, flag, strategy, note
_LOTS = [
    ("aaaaaa11-tu-won", "finansia", "TU", "TU.BK", "THB", "2026-01-10", "2026-02-10", 10.0, 15.0, 100, 500.0, "W", "Breakout", "Finansia (6065151)\n[SOLD 2026-02-10] @ 15"),
    ("aaaaaa22-tune-lost", "finansia", "TUNE", "TUNE.BK", "THB", "2026-02-01", "2026-03-05", 5.0, 3.0, 100, -200.0, "L", "Swing", "Finansia (0153717)"),
    ("bbbbbb33-tu-open", "finansia", "TU", "TU.BK", "THB", "2026-03-01", None, 12.0, None, 50, None, "P", "", "Finansia (6065151)"),
    ("cccccc44-mu-won", "dime", "MU", "MU", "USD", "2026-02-20", "2026-03-15", 100.0, 110.05, 10, 100.5, "W", "Swing", "Dime"),
    ("cccccc55-mu-lost", "dime", "MU", "MU", "USD", "2026-03-20", "2026-04-02", 100.0, 95.975, 10, -40.25, "L", "Swing", "Dime"),
    # flagged L although the P&L is positive — the flag is what the app counts
    ("cccccc66-mu-odd", "dime", "MU", "MU", "USD", "2026-03-25", "2026-04-10", 100.0, 100.5, 10, 5.0, "L", "", "Dime"),
]


@pytest.fixture()
def th(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "trade_history.db"))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_db(); db.init_portfolio_v2(); db.init_thesis_schema()
    import portfolio_currency
    importlib.reload(portfolio_currency)
    import routers.trade_history as mod
    importlib.reload(mod)
    with db.get_db() as conn:
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('finansia','Finansia','THB')")
        conn.execute("INSERT INTO portfolio_accounts (id, name, currency) VALUES ('dime','Dime','USD')")
        for (tid, acc, sym, res, ccy, d_in, d_out, px_in, px_out, vol, pnl, flag, strat, note) in _LOTS:
            usd = ccy == "USD"
            conn.execute(
                "INSERT INTO trades (id, account_id, symbol, resolved_symbol, market, currency, "
                "date_entry, date_exit, price_entry, price_exit, volume, pnl_amount, win_loss, "
                "strategy_name, note, exchange_rate, exit_exchange_rate) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (tid, acc, sym, res, "US" if usd else "TH", ccy, d_in, d_out, px_in, px_out, vol,
                 pnl, flag, strat, note, 33.0 if usd else 1.0,
                 (34.0 if usd else 1.0) if d_out else None))
    return mod, db


def _sql(db, query, *params):
    with db.get_db() as conn:
        return [tuple(r) for r in conn.execute(query, params)]


def _ids(result):
    return [r["id"] for r in result["rows"]]


# ── filters are exact ────────────────────────────────────────────────────────

def test_symbol_matches_exactly_never_by_substring(th):
    mod, _ = th
    res = mod.list_lots(symbol="TU")
    assert sorted(_ids(res)) == ["aaaaaa11-tu-won", "bbbbbb33-tu-open"]   # no TUNE
    assert res["total_matching"] == 2 and res["complete"] is True
    assert sorted(_ids(mod.list_lots(symbol="tu.bk"))) == sorted(_ids(res))   # provider ticker, any case
    assert res["query"]["symbol"] == "TU"                                 # the filter is echoed back


def test_a_symbol_never_traded_says_so_and_offers_the_real_ones(th):
    mod, _ = th
    res = mod.list_lots(symbol="NVDA")
    assert res["total_matching"] == 0 and res["rows"] == [] and res["totals"] == []
    assert "No trade for NVDA has ever been recorded" in " ".join(res["notes"])
    near = " ".join(mod.list_lots(symbol="TUN")["notes"])
    assert "TUNE" in near and "TU" in near


def test_a_traded_symbol_excluded_by_other_filters_is_not_called_unknown(th):
    mod, _ = th
    notes = " ".join(mod.list_lots(symbol="TUNE", status="open")["notes"])
    assert "has trades in the book" in notes and "ever been recorded" not in notes


def test_dates_are_inclusive_and_say_which_date_they_matched(th):
    mod, _ = th
    march = dict(date_from="2026-03-01", date_to="2026-03-31")
    assert sorted(_ids(mod.list_lots(date_field="exit", **march))) == [
        "aaaaaa22-tune-lost", "cccccc44-mu-won"]
    assert sorted(_ids(mod.list_lots(date_field="entry", **march))) == [
        "bbbbbb33-tu-open", "cccccc55-mu-lost", "cccccc66-mu-odd"]
    both = mod.list_lots(date_field="any", **march)
    assert both["total_matching"] == 5 and "entry date OR its exit date" in both["notes"][0]
    one_day = mod.list_lots(date_from="2026-03-05", date_to="2026-03-05", date_field="exit")
    assert _ids(one_day) == ["aaaaaa22-tune-lost"]


@pytest.mark.parametrize("kwargs, text", [
    (dict(date_from="March 2026"), "YYYY-MM-DD"),
    (dict(date_from="2026-02-30"), "YYYY-MM-DD"),
    (dict(date_from="2026-04-01", date_to="2026-03-01"), "is after"),
    (dict(account_id="schwab"), "Accounts: dime, finansia"),
])
def test_a_filter_the_server_cannot_read_is_refused_not_guessed(th, kwargs, text):
    mod, _ = th
    with pytest.raises(HTTPException) as err:
        mod.list_lots(**kwargs)
    assert err.value.status_code == 422 and text in err.value.detail


def test_strategy_and_sub_port_filters(th):
    mod, _ = th
    assert mod.list_lots(strategy="swing")["total_matching"] == 3
    assert sorted(_ids(mod.list_lots(strategy="(none)"))) == ["bbbbbb33-tu-open", "cccccc66-mu-odd"]
    assert sorted(_ids(mod.list_lots(sub_port="6065151"))) == ["aaaaaa11-tu-won", "bbbbbb33-tu-open"]


# ── a page never passes for the whole list ───────────────────────────────────

def test_paging_reports_what_is_missing_and_totals_cover_everything(th):
    mod, db = th
    seen, offset = [], 0
    while offset is not None:
        page = mod.list_lots(limit=4, offset=offset, order="oldest")
        assert page["total_matching"] == 6
        assert page["complete"] is False                       # no single page is the whole list
        assert page["returned"] == len(page["rows"])
        assert page["totals"] == mod.list_lots(limit=500)["totals"]   # same on every page
        seen += _ids(page)
        offset = page["next_offset"]
    assert sorted(seen) == sorted(t[0] for t in _LOTS) and len(seen) == len(set(seen))
    assert "of 6" in " ".join(mod.list_lots(limit=4)["notes"])
    assert mod.list_lots(limit=500)["complete"] is True


def test_totals_equal_plain_sql_and_never_mix_currencies(th):
    mod, db = th
    totals = {t["currency"]: t for t in mod.list_lots()["totals"]}
    for ccy, lots, pnl in _sql(db, "SELECT currency, COUNT(*), SUM(pnl_amount) FROM trades GROUP BY 1"):
        assert totals[ccy]["lots"] == lots
        assert totals[ccy]["realized_pnl"] == pytest.approx(pnl)
    assert totals["THB"]["realized_pnl"] == 300.0 and totals["USD"]["realized_pnl"] == 65.25
    assert totals["THB"]["open_lots"] == 1 and totals["THB"]["open_cost"] == 600.0


def test_stored_values_pass_through_and_null_stays_null(th):
    mod, db = th
    rows = {r["id"]: r for r in mod.list_lots(detail="full")["rows"]}
    open_lot = rows["bbbbbb33-tu-open"]
    assert open_lot["status"] == "OPEN" and open_lot["result"] is None
    assert open_lot["pnl_amount"] is None and open_lot["price_exit"] is None and open_lot["date_exit"] is None
    assert open_lot["lot_price"] is None and open_lot["fee_entry"] is None     # not recorded ≠ 0
    for tid, px, vol, pnl in _sql(db, "SELECT id, price_entry, volume, pnl_amount FROM trades"):
        assert (rows[tid]["price_entry"], rows[tid]["volume"], rows[tid]["pnl_amount"]) == (px, vol, pnl)
    won = rows["aaaaaa11-tu-won"]
    assert (won["status"], won["result"], won["holding_days"], won["sub_port"]) == ("CLOSED", "W", 31, "6065151")
    assert (won["cost"], won["cost_source"]) == (1000.0, "price_entry × volume")
    brief = mod.list_lots()["rows"][0]
    assert "note" not in brief and set(brief) <= set(mod.FIELDS) | {"cost_source"}


# ── one lot ──────────────────────────────────────────────────────────────────

def test_one_lot_with_its_audit_trail(th):
    mod, db = th
    with db.get_db() as conn:
        conn.execute("INSERT INTO trade_audit_log (trade_id, action, fields_changed, reason) "
                     "VALUES ('cccccc44-mu-won', 'SELL_FULL', '{\"price_exit\": {\"old\": null, \"new\": 110.05}}', 'sold')")
    res = mod.one_lot("cccccc44-mu-won")
    assert res["trade"]["id"] == "cccccc44-mu-won" and res["trade"]["note"] == "Dime"
    assert res["audit_log"][0]["action"] == "SELL_FULL"
    assert res["audit_log"][0]["fields_changed"]["price_exit"]["new"] == 110.05
    assert res["broker_slips"] == [] and res["theses"] == []
    assert mod.one_lot("cccccc44")["trade"]["id"] == "cccccc44-mu-won"          # unique prefix


def test_an_unknown_or_ambiguous_id_is_an_error_not_a_near_match(th):
    mod, _ = th
    with pytest.raises(HTTPException) as missing:
        mod.one_lot("zzzzzzzz-not-a-trade")
    assert missing.value.status_code == 404
    with pytest.raises(HTTPException) as two:
        mod.one_lot("aaaaaa")                                                   # two ids start so
    assert two.value.status_code == 409 and "aaaaaa11-tu-won" in two.value.detail


# ── statistics are computed here, from every row ─────────────────────────────

def test_stats_per_currency(th):
    mod, db = th
    res = mod.lot_stats(include_options=False)
    usd = next(t for t in res["totals"] if t["currency"] == "USD")
    thb = next(t for t in res["totals"] if t["currency"] == "THB")
    assert (thb["closed_lots"], thb["wins"], thb["losses"], thb["realized_pnl"]) == (2, 1, 1, 300.0)
    assert thb["win_rate_pct"] == 50.0 and thb["avg_win"] == 500.0 and thb["avg_loss"] == -200.0
    assert thb["payoff"] == 2.5 and thb["expectancy_per_lot"] == 150.0
    assert thb["cost_closed"] == 1500.0 and thb["return_on_cost_pct"] == 20.0
    assert thb["best"]["id"] == "aaaaaa11-tu-won" and thb["worst"]["id"] == "aaaaaa22-tune-lost"
    # USD: wins by the stored flag (1 of 3), and the odd flag is reported, not hidden
    assert (usd["closed_lots"], usd["wins"], usd["losses"], usd["realized_pnl"]) == (3, 1, 2, 65.25)
    assert usd["flag_disagrees_with_sign"] == 1 and thb["flag_disagrees_with_sign"] == 0
    assert usd["entry_fees_recorded"] is None                # none recorded — not 0.00
    (sql_usd,), = _sql(db, "SELECT SUM(pnl_amount) FROM trades WHERE currency='USD' AND win_loss != 'P'")
    assert usd["realized_pnl"] == pytest.approx(sql_usd)
    assert res["combined"] is None                            # no conversion unless asked for
    assert "Open lots have no result" in res["scope"]


def test_stats_groups_and_dates_use_the_exit_date(th):
    mod, _ = th
    by_month = {(g["group"], g["currency"]): g for g in mod.lot_stats(group_by="month")["groups"]}
    assert set(by_month) == {("2026-02", "THB"), ("2026-03", "THB"), ("2026-03", "USD"), ("2026-04", "USD")}
    assert by_month[("2026-04", "USD")]["realized_pnl"] == -35.25
    by_symbol = {g["group"]: g for g in mod.lot_stats(group_by="symbol")["groups"]}
    assert by_symbol["TU"]["closed_lots"] == 1 and by_symbol["TUNE"]["realized_pnl"] == -200.0
    april = mod.lot_stats(date_from="2026-04-01", date_to="2026-04-30")
    assert [(t["currency"], t["closed_lots"], t["realized_pnl"]) for t in april["totals"]] == [("USD", 2, -35.25)]
    by_sub = {g["group"]: g["realized_pnl"] for g in mod.lot_stats(group_by="sub_port", account_id="finansia")["groups"]}
    assert by_sub == {"6065151": 500.0, "0153717": -200.0}


def test_stats_convert_only_on_request_and_say_so(th):
    mod, _ = th
    res = mod.lot_stats(base_currency="THB", include_options=False)
    assert res["combined"]["currency"] == "THB"
    assert res["combined"]["realized_pnl"] == pytest.approx(300.0 + 65.25 * 34.0)   # exit-date rate on the row
    assert (res["combined"]["closed_lots"], res["combined"]["wins"]) == (5, 2)
    assert "converted to THB" in " ".join(res["notes"])
    with pytest.raises(HTTPException) as err:
        mod.lot_stats(base_currency="EUR")
    assert err.value.status_code == 422


def test_stats_with_nothing_to_report_reports_nothing(th):
    mod, _ = th
    res = mod.lot_stats(symbol="NVDA")
    assert res["totals"] == [] and res["groups"] == []
    assert "ever been recorded" in " ".join(res["notes"]) and "do not estimate" in " ".join(res["notes"])
    only_open = mod.lot_stats(date_from="2027-01-01", date_to="2027-12-31")
    assert only_open["totals"] == []


def test_stats_agree_with_port_analytics(th, monkeypatch):
    """The figure an agent reads is the figure PORT → ANALYTICS shows."""
    mod, _ = th
    import routers.portfolio_v2 as pv2
    importlib.reload(pv2)
    monkeypatch.setattr(pv2, "_maybe_capture_nav", lambda *a, **k: None)
    monkeypatch.setattr(pv2, "capture_daily_greeks", lambda *a, **k: None)
    monkeypatch.setattr(pv2, "closed_option_positions", lambda *a, **k: [])
    monkeypatch.setattr(pv2, "open_option_positions", lambda *a, **k: [])
    ui = pv2.get_analytics(account_id=None, base_currency="THB")["trade_stats"]
    ours = mod.lot_stats(base_currency="THB", include_options=False)["combined"]
    assert (ours["closed_lots"], ours["wins"], ours["losses"]) == (ui["closed"], ui["wins"], ui["losses"])
    assert ours["realized_pnl"] == pytest.approx(ui["total_win"] + ui["total_loss"], abs=0.01)
    assert ours["win_rate_pct"] == ui["win_rate"]


# ── options ──────────────────────────────────────────────────────────────────

def _option_round_trip(db, pnl, close_price=0.5, n="1"):
    with db.get_db() as conn:
        conn.execute("INSERT OR IGNORE INTO option_contracts (contract_id, occ_symbol, underlying, expiry, strike, option_type) "
                     "VALUES ('k1', 'MU  260417C00120000', 'MU', '2026-04-17', 120, 'call')")
        conn.execute("INSERT INTO option_trades (trade_id, contract_id, account_id, trade_date, action, side, quantity, price) "
                     f"VALUES ('open{n}', 'k1', 'dime', '2026-03-02', 'OPEN', 'BUY', 2, 1.0)")
        conn.execute("INSERT INTO option_trades (trade_id, contract_id, account_id, trade_date, action, side, quantity, price, close_reason) "
                     f"VALUES ('close{n}', 'k1', 'dime', '2026-03-09', 'CLOSE', 'SELL', 2, ?, ?)",
                     (close_price, "TRADE" if close_price is not None else "UNKNOWN"))
        conn.execute("INSERT INTO option_trade_matches (close_trade_id, open_trade_id, quantity, realized_pnl) "
                     f"VALUES ('close{n}', 'open{n}', 2, ?)", (pnl,))


def test_option_round_trips_and_unknown_is_not_zero(th):
    mod, db = th
    _option_round_trip(db, -100.0)
    _option_round_trip(db, None, close_price=None, n="2")          # closed, price never recorded
    res = mod.option_history(underlying="mu")
    assert res["total_matching"] == 2 and res["complete"] is True
    assert res["totals"] == [{"currency": "USD", "round_trips": 2, "wins": 0, "losses": 1,
                              "realized_pnl": -100.0, "pnl_not_recorded": 1}]
    assert {r["realized_pnl"] for r in res["round_trips"]} == {-100.0, None}
    assert mod.option_history(underlying="TU")["total_matching"] == 0

    stats = mod.lot_stats(symbol="MU")                               # options folded in by default
    usd = stats["totals"][0]
    assert (usd["closed_lots"], usd["realized_pnl"]) == (4, -34.75)   # 3 lots + 1 round trip
    assert "no closing price recorded" in " ".join(stats["notes"])
    assert mod.lot_stats(symbol="MU", include_options=False)["totals"][0]["closed_lots"] == 3
    by_kind = {g["group"]: g["closed_lots"] for g in mod.lot_stats(symbol="MU", group_by="instrument")["groups"]}
    assert by_kind == {"stock": 3, "option": 1}
    assert "Options are left out" in " ".join(mod.lot_stats(strategy="Swing")["notes"])


# ── coverage ─────────────────────────────────────────────────────────────────

def test_coverage_lists_what_exists_and_what_the_fields_mean(th):
    mod, _ = th
    cov = mod.coverage()
    assert cov["book"]["lots"] == 6 and cov["book"]["open_lots"] == 1
    assert (cov["book"]["first_entry"], cov["book"]["last_exit"]) == ("2026-01-10", "2026-04-10")
    assert [(s["symbol"], s["lots"]) for s in cov["symbols"]] == [("MU", 3), ("TU", 2), ("TUNE", 1)]
    fin = next(a for a in cov["accounts"] if a["account_id"] == "finansia")
    assert fin["sub_ports"] == ["0153717", "6065151"] and fin["currencies_traded"] == ["THB"]
    assert "AVERAGE COST" in cov["fields"]["price_entry"]
    assert any("complete" in rule for rule in cov["rules"])
    assert cov["source"]["rows_in_table"] == 6


# ── over HTTP ────────────────────────────────────────────────────────────────

def test_http_surface(th):
    mod, _ = th
    app = FastAPI()
    app.include_router(mod.router)
    client = TestClient(app)
    ok = client.get("/api/v2/trade-history/trades", params={"symbol": "MU", "limit": 2})
    assert ok.status_code == 200 and ok.json()["total_matching"] == 3 and ok.json()["complete"] is False
    assert client.get("/api/v2/trade-history/trades", params={"status": "pending"}).status_code == 422
    assert client.get("/api/v2/trade-history/trades", params={"limit": 0}).status_code == 422
    assert client.get("/api/v2/trade-history/trades/nope-nope").status_code == 404
    assert client.get("/api/v2/trade-history/stats", params={"group_by": "weekday"}).status_code == 422
    assert client.get("/api/v2/trade-history/coverage").json()["book"]["lots"] == 6
    assert client.get("/api/v2/trade-history/options").json()["total_matching"] == 0
    for method in ("post", "put", "patch", "delete"):                 # nothing here writes
        assert getattr(client, method)("/api/v2/trade-history/trades").status_code == 405


# ── the MCP side: an oversized list is cut on a row boundary, and says so ────

def test_mcp_trims_whole_rows_and_keeps_the_envelope_honest():
    pytest.importorskip("mcp.server.mcpserver")
    import mcp_server
    rows = [{"id": f"lot-{i:04d}", "note": "x" * 300} for i in range(400)]
    data = {"query": {"offset": 100}, "total_matching": 900, "returned": 400, "complete": False,
            "next_offset": 500, "totals": [{"currency": "USD", "lots": 900}], "notes": [], "rows": rows}
    text = mcp_server._out_rows(data)
    assert len(text) <= mcp_server.MAX_CHARS
    out = json.loads(text)                                        # still valid JSON
    kept = out["returned"]
    assert 0 < kept < 400 and out["rows"] == rows[:kept]          # a prefix of whole rows
    assert out["complete"] is False and out["next_offset"] == 100 + kept
    assert out["totals"] == data["totals"] and f"offset={100 + kept}" in out["notes"][-1]
    small = {"query": {"offset": 0}, "complete": True, "rows": rows[:3], "notes": []}
    assert json.loads(mcp_server._out_rows(small)) == small       # untouched when it fits
