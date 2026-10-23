"""ROT group definitions + the constituents drill-down.

The mapping tests pin what the 2026-10-23 audit found against the published
definitions (GICS, the funds' own names, the SET's composition), so a group can
not quietly drift back to a guess. The endpoint tests run without network:
prices, State Street's file and Yahoo's holdings are stubbed.
"""
from __future__ import annotations

import io

import numpy as np
import pandas as pd
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import sector_membership as sm
from routers import rotation

# ── US: GICS + themes ────────────────────────────────────────────────────────


def test_us_sectors_are_the_eleven_gics_sectors_with_their_spdr():
    gics = {
        "10": ("Energy", "XLE"), "15": ("Materials", "XLB"), "20": ("Industrials", "XLI"),
        "25": ("Consumer Discretionary", "XLY"), "30": ("Consumer Staples", "XLP"),
        "35": ("Health Care", "XLV"), "40": ("Financials", "XLF"),
        "45": ("Information Technology", "XLK"), "50": ("Communication Services", "XLC"),
        "55": ("Utilities", "XLU"), "60": ("Real Estate", "XLRE"),
    }
    assert {c: (n, e) for c, n, e in sm.GICS_SECTORS} == gics
    # the table's label is the GICS name, not an abbreviation of it
    assert dict((s, n) for n, s in rotation.SECTORS)["XLK"] == "Information Technology (XLK)"
    assert set(rotation.SECTOR_ETFS_ORDER) == {e for _, e in gics.values()}


@pytest.mark.parametrize("etf,label", [
    ("KBE", "Banks"),                  # was "Banks & Brokers" — S&P Banks Select Industry holds no brokers
    ("JETS", "Airlines"),              # was "Travel & Airlines" — no hotels, cruise lines or booking sites
    ("ITA", "Aerospace & Defense"),    # was "Defense" — the index is aerospace and defense
    ("KWEB", "China Internet"),        # was "China Tech" — CSI China Internet, not hardware/semis
    ("ARKX", "Space & Defense"),       # the fund renamed itself ARK Space & Defense Innovation
])
def test_theme_labels_say_what_the_fund_holds(etf, label):
    assert sm.THEME_BY_ETF[etf][0] == label
    assert dict((s, n) for n, s in rotation.THEMES)[etf] == label


def test_every_group_is_one_etf_and_no_etf_is_two_groups():
    etfs = [e for _, _, e in sm.GICS_SECTORS] + [e for _, e, _ in sm.THEMES]
    assert len(etfs) == len(set(etfs))


def test_issuer_ticker_to_yahoo():
    assert sm.us_yahoo("BRK.B") == "BRK-B"
    assert sm.us_yahoo(" nvda ") == "NVDA"
    assert sm.th_yahoo("PF&REIT") == "PF&REIT.BK"
    assert sm.th_yahoo("q-con") == "Q-CON.BK"


# ── TH: the SET's classification ─────────────────────────────────────────────


@pytest.fixture(scope="module")
def snap():
    return sm.load_set_snapshot()


def test_set_snapshot_is_dated_sourced_and_complete(snap):
    assert snap["as_of"] == "2026-10-21"
    assert snap["source"].startswith("https://www.set.or.th/")
    syms = [m["symbol"] for m in snap["members"]]
    assert len(syms) == 700 and len(set(syms)) == 700
    assert {m["sector"] for m in snap["members"]} == set(sm.SET_SECTORS) - {"MINE"}
    assert {m["industry"] for m in snap["members"]} == set(sm.SET_INDUSTRIES)


def test_every_sector_sits_in_one_of_the_eight_industry_groups():
    assert len(sm.SET_INDUSTRIES) == 8 and len(sm.SET_SECTORS) == 28
    assert {ind for ind, _ in sm.SET_SECTORS.values()} == set(sm.SET_INDUSTRIES)


@pytest.mark.parametrize("symbol,sector", [
    ("SCGP", "PKG"),       # was in the hand-made "Petrochem" basket
    ("MINT", "TOURISM"),   # was in "Food & Bev"
    ("AWC", "PROP"),       # was in "Tourism"
    ("TASCO", "CONMAT"),
    ("BJC", "COMM"),
    ("SCB", "BANK"),
    ("GULF", "ENERG"),
    ("DELTA", "ETRON"),
])
def test_audited_classifications(snap, symbol, sector):
    assert next(m["sector"] for m in snap["members"] if m["symbol"] == symbol) == sector


def test_delisted_names_are_gone(snap):
    # INTUCH merged into GULF (Gulf Development) in 2025 and left the board
    assert not any(m["symbol"] == "INTUCH" for m in snap["members"])


def test_a_drifted_row_is_an_error(tmp_path):
    bad = tmp_path / "set.tsv"
    bad.write_text("# as_of: 2026-10-21\nBANK|INDUS|KBANK|1|KASIKORNBANK PCL\n", encoding="utf-8")
    with pytest.raises(ValueError, match="KBANK"):
        sm.load_set_snapshot(bad)


def test_industry_members_are_the_union_of_its_sectors(snap):
    fin = {m["symbol"] for m in sm.set_members("FINCIAL", snap)}
    parts = set()
    for s in ("BANK", "FIN", "INSUR"):
        parts |= {m["symbol"] for m in sm.set_members(s, snap)}
    assert fin == parts


def _m(sym, cap):
    return {"symbol": sym, "cap": float(cap)}


def test_basket_reaches_coverage_then_stops():
    members = [_m("A", 50), _m("B", 30), _m("C", 10), _m("D", 5), _m("E", 5)]
    assert [m["symbol"] for m in sm.index_basket(members)] == ["A", "B", "C"]   # 90% ≥ 80%, and min 3
    assert [m["symbol"] for m in sm.index_basket(members, min_n=1)] == ["A", "B"]


def test_basket_is_capped_and_skips_untraded():
    members = [_m(f"S{i}", 1) for i in range(30)] + [_m("ZERO", 0)]
    out = sm.index_basket(members, max_n=10)
    assert len(out) == 10 and all(m["symbol"] != "ZERO" for m in out)
    assert sm.coverage_pct(out, members) == pytest.approx(33.3, abs=0.1)


def test_cap_weighted_index_moves_by_market_value():
    idx = pd.bdate_range("2026-01-02", periods=3)
    closes = pd.DataFrame({"BIG": [100.0, 110.0, 110.0], "SMALL": [10.0, 10.0, 5.0]}, index=idx)
    # caps at the last close: BIG 900 (shares 9 → 900/990/990), SMALL 100 (shares 20 → 200/200/100)
    level = sm.cap_weighted_index(closes, {"BIG": 990.0, "SMALL": 100.0})
    total = 9 * closes["BIG"] + 20 * closes["SMALL"]
    assert list(level.round(10)) == list((total / total.iloc[0]).round(10))


def test_a_late_joiner_does_not_jump_the_level():
    idx = pd.bdate_range("2026-01-02", periods=4)
    closes = pd.DataFrame({"OLD": [100.0, 100.0, 100.0, 100.0],
                           "IPO": [np.nan, np.nan, 50.0, 50.0]}, index=idx)
    level = sm.cap_weighted_index(closes, {"OLD": 100.0, "IPO": 1000.0})
    assert list(level) == [1.0, 1.0, 1.0, 1.0]


# ── State Street holdings file ───────────────────────────────────────────────


def _ssga_xlsx(rows) -> bytes:
    pre = [
        ["Fund Name:", "State Street Technology Select Sector SPDR ETF"] + [None] * 6,
        ["Ticker Symbol:", "XLK"] + [None] * 6,
        ["Holdings:", "As of 21-Oct-2026"] + [None] * 6,
        [None] * 8,
        ["Name", "Ticker", "Identifier", "SEDOL", "Weight", "Sector", "Shares Held", "Local Currency"],
    ]
    tail = [[None] * 8, ["Distributor: State Street ..."] + [None] * 7]
    buf = io.BytesIO()
    pd.DataFrame(pre + rows + tail).to_excel(buf, header=False, index=False)
    return buf.getvalue()


def test_parse_ssga_keeps_stocks_and_drops_cash_and_futures():
    content = _ssga_xlsx([
        ["NVIDIA CORP", "NVDA", "67066G104", "2379504", 15.578144, "-", 87212999, "USD"],
        ["BERKSHIRE HATHAWAY INC CL B", "BRK.B", "084670702", "2073390", 3.1, "-", 1, "USD"],
        ["SSI US GOV MONEY MARKET CLASS", "-", None, None, 0.07, "-", 1, "USD"],
        ["US DOLLAR", "-", None, None, 0.01, "-", 1, "USD"],
        ["XAF FINANCIAL     DEC26", "IXAZ6", None, None, 0.2, "-", 1, "USD"],
    ])
    out = sm.parse_ssga_holdings(content)
    assert out["ticker"] == "XLK" and out["as_of"] == "2026-10-21"
    assert [(r["ticker"], r["weight"]) for r in out["rows"]] == [("NVDA", 15.5781), ("BRK.B", 3.1)]


def test_parse_ssga_without_header_raises():
    buf = io.BytesIO()
    pd.DataFrame([["nothing here"]]).to_excel(buf, header=False, index=False)
    with pytest.raises(ValueError):
        sm.parse_ssga_holdings(buf.getvalue())


# ── Endpoint ─────────────────────────────────────────────────────────────────


def _series(drift: float, seed: int, n: int = 200) -> pd.Series:
    idx = pd.bdate_range("2026-01-02", periods=n)
    rng = np.random.default_rng(seed)
    return pd.Series(100 * np.exp(np.cumsum(drift + rng.normal(0, 0.002, n))), index=idx)


def _fake_closes(symbols):
    return pd.DataFrame({s: _series(0.0003 * (i % 7 - 3), seed=i) for i, s in enumerate(symbols)})


@pytest.fixture
def client(monkeypatch):
    rotation._cache.clear()
    calls: list[list[str]] = []

    def dl(symbols):
        calls.append(list(symbols))
        return _fake_closes(sorted(set(symbols)))

    monkeypatch.setattr(rotation, "_download_closes", dl)
    app = FastAPI()
    app.include_router(rotation.router)
    c = TestClient(app)
    c.downloads = calls
    yield c
    rotation._cache.clear()


def test_us_sector_lists_every_holding_from_state_street(client, monkeypatch):
    held = {"as_of": "2026-10-21", "url": "https://www.ssga.com/x.xlsx", "rows": [
        {"ticker": "AAPL", "name": "APPLE INC", "weight": 14.5},
        {"ticker": "NVDA", "name": "NVIDIA CORP", "weight": 15.5},
        {"ticker": "BRK.B", "name": "BERKSHIRE", "weight": 1.0},
    ]}
    monkeypatch.setattr(rotation, "_ssga_holdings", lambda etf: held if etf == "XLK" else None)
    body = client.get("/api/rotation/constituents", params={"id": "xlk", "market": "US"}).json()
    assert body["group"]["name"] == "Information Technology"
    assert "GICS 45" in body["group"]["definition"]
    src = body["group"]["source"]
    assert src["coverage"] == "all" and src["as_of"] == "2026-10-21" and src["n_total"] == 3
    assert [r["symbol"] for r in body["rows"]] == ["NVDA", "AAPL", "BRK.B"]   # by weight
    assert body["rows"][2]["yf_symbol"] == "BRK-B"
    r0 = body["rows"][0]
    assert r0["name"] == "NVIDIA CORP" and r0["weight"] == 15.5 and r0["priced"]
    assert {"d1", "w1", "m1", "m3", "m1_vs_bench", "quadrant", "price"} <= r0.keys()


def test_us_sector_falls_back_to_yahoo_top10_and_says_so(client, monkeypatch):
    monkeypatch.setattr(rotation, "_ssga_holdings", lambda etf: None)
    monkeypatch.setattr(rotation, "_yahoo_top_holdings",
                        lambda etf: [{"ticker": "XOM", "name": "Exxon Mobil", "weight": 22.0}])
    body = client.get("/api/rotation/constituents", params={"id": "XLE"}).json()
    src = body["group"]["source"]
    assert src["coverage"] == "top10" and "unavailable" in src["note"]


def test_theme_uses_yahoo_top10(client, monkeypatch):
    monkeypatch.setattr(rotation, "_ssga_holdings", lambda etf: pytest.fail("ARKK is not State Street's"))
    monkeypatch.setattr(rotation, "_yahoo_top_holdings",
                        lambda etf: [{"ticker": "TSLA", "name": "Tesla Inc", "weight": 9.1}])
    body = client.get("/api/rotation/constituents", params={"id": "ARKK"}).json()
    assert body["group"]["kind"] == "theme" and body["group"]["source"]["coverage"] == "top10"
    assert body["rows"][0]["name"] == "Tesla Inc"


def test_th_sector_lists_every_official_member_with_cap_weights(client, snap):
    body = client.get("/api/rotation/constituents", params={"id": "PF&REIT", "market": "TH"}).json()
    official = sm.set_members("PF&REIT", snap)
    assert [r["symbol"] for r in body["rows"]] == [m["symbol"] for m in official]
    assert sum(r["weight"] for r in body["rows"]) == pytest.approx(100, abs=0.01)
    assert body["group"]["source"]["as_of"] == "2026-10-21"
    assert body["rows"][0]["market_cap"] == official[0]["cap"] * 1e6
    assert body["rows"][0]["yf_symbol"] == official[0]["symbol"] + ".BK"
    assert sum(1 for r in body["rows"] if r["in_basket"]) == body["group"]["basket"]["n"]


def test_th_industry_rows_carry_their_sector(client):
    body = client.get("/api/rotation/constituents", params={"id": "FINCIAL", "market": "TH"}).json()
    assert body["group"]["kind"] == "industry"
    assert {r["sector"] for r in body["rows"]} == {"BANK", "FIN", "INSUR"}


def test_only_the_largest_members_are_priced(client, monkeypatch):
    monkeypatch.setattr(rotation, "PRICED_MAX", 5)
    body = client.get("/api/rotation/constituents", params={"id": "PROP", "market": "TH"}).json()
    assert len(body["rows"]) == 60
    assert [r["priced"] for r in body["rows"]][:6] == [True] * 5 + [False]
    assert body["group"]["source"]["n_priced"] == 5
    assert len(client.downloads[-1]) == 5 + 2   # 5 members + ^SET.BK + TDEX.BK


def test_unknown_group_is_an_error_and_is_not_refetched(client):
    first = client.get("/api/rotation/constituents", params={"id": "NOPE", "market": "TH"}).json()
    assert first["rows"] == [] and first["error"] == "unknown group"
    client.get("/api/rotation/constituents", params={"id": "NOPE", "market": "TH"})
    assert client.downloads == []


def test_failed_state_street_fetch_is_negative_cached(monkeypatch):
    rotation._cache.clear()
    hits = []

    def boom(*a, **k):
        hits.append(1)
        raise OSError("down")

    monkeypatch.setattr(rotation.requests, "get", boom)
    assert rotation._ssga_holdings("XLK") is None
    assert rotation._ssga_holdings("XLK") is None
    assert len(hits) == 1
    rotation._cache.clear()


def test_th_table_is_the_set_classification(client, snap):
    body = client.get("/api/rotation/table", params={"market": "TH"}).json()
    by_id = {r["id"]: r for r in body["rows"]}
    assert {r["id"] for r in body["rows"] if r["kind"] == "industry"} == set(sm.SET_INDUSTRIES)
    assert {r["id"] for r in body["rows"] if r["kind"] == "sector"} == set(sm.SET_SECTORS) - {"MINE"}
    assert by_id["BANK"]["name"] == "Banking" and by_id["BANK"]["industry"] == "FINCIAL"
    assert by_id["BANK"]["n_members"] == len(sm.set_members("BANK", snap))
    assert 80 <= by_id["BANK"]["coverage_pct"] <= 100
    assert body["definition"]["membership_as_of"] == "2026-10-21"
    # a holding is placed by the SET's sector, whatever its trade was labelled
    assert len(body["symbol_sector"]) == 700
    assert body["symbol_sector"]["TASCO"] == "CONMAT" and body["symbol_sector"]["AJ"] == "PKG"


def test_th_map_is_the_eight_industry_groups(monkeypatch):
    monkeypatch.setattr(rotation, "_download_closes", lambda s: _fake_closes(sorted(set(s))))
    out = rotation._build_map("TH", "^SET.BK", tail=4)
    assert [r["id"] for r in out["rows"]] == list(sm.SET_INDUSTRIES)
