"""Rotation news — tone words, relevance filter, CONFIRMS / DIVERGES, endpoint shape.

No network: the ROT table and the pulls are stubbed.
"""

from __future__ import annotations

import pytest

import headline_tone
from routers import news_rotation as nr


@pytest.mark.parametrize("title,tone", [
    ("Sector Update: Tech Stocks Fall Late Afternoon", "NEG"),
    ("Sector Update: Healthcare Stocks Gain Late Afternoon", "POS"),
    ("Bangkok Bank profit drops 31% on rate cuts", "NEG"),
    ("InnovestX cuts target to THB 60.00 for CP ALL stock", "NEG"),
    ("CLSA upgrades Airports of Thailand stock", "POS"),
    ("12 Industrials Stocks Moving In Thursday's After-Market Session", "NEU"),
    # "lower rates" is not bad news for a homebuilder: the word is not counted
    ("D.R. Horton Shares Climb as Lower Rates Lift Homebuilders", "POS"),
    ("Alexandria Real Estate stock underperforming the market", "NEG"),
    # one up-word, one down-word: no tone
    ("Bloom Energy shares fall despite beating Q3 estimates", "NEU"),
    # word boundaries: "rose" in "Rosemont", "fall" in "Fallon" are not moves
    ("Rosemont names Fallon as chief executive", "NEU"),
])
def test_tone(title, tone):
    assert headline_tone.tone_of(title) == tone


def test_us_sector_relevance():
    m = nr._matcher("US", {"id": "XLK", "name": "Information Technology (XLK)"})
    assert nr._relevant("US", "Chip stocks slide on export curbs", m)
    assert nr._relevant("US", "XLK hits record", m)
    assert not nr._relevant("US", "Kraft Heinz beats estimates", m)
    # another market's wrap and quote pages are dropped
    assert not nr._relevant("US", "ASX Midday Sector Update: Tech Stocks Advance", m)
    assert not nr._relevant("US", "Apple Inc. (AAPL) Stock Price, News, Quote & History", m)


def test_us_theme_relevance_uses_its_label():
    m = nr._matcher("US", {"id": "CIBR", "name": "Cybersecurity"})
    assert nr._relevant("US", "AI has flipped the story on cybersecurity stocks", m)
    assert not nr._relevant("US", "Oil prices rise", m)


def test_th_relevance_uses_member_names(monkeypatch):
    monkeypatch.setattr(nr, "_th_basket", lambda gid: [
        {"symbol": "CPN", "name": "CENTRAL PATTANA PCL"},
        {"symbol": "KBANK", "name": "KASIKORNBANK PCL"},
    ])
    m = nr._matcher("TH", {"id": "X", "name": "X"})
    assert nr._relevant("TH", "UOB Kay Hian keeps Buy rating for Central Pattana stock", m)
    assert nr._relevant("TH", "KBANK nine-month profit", m)
    # a single common word of a name is not enough
    assert not nr._relevant("TH", "Central gets spooky with Halloween events", m)


@pytest.mark.parametrize("quad,pos,neg,read", [
    ("Leading", 3, 0, "CONFIRMS"),
    ("Improving", 0, 3, "DIVERGES"),
    ("Lagging", 0, 4, "CONFIRMS"),
    ("Weakening", 4, 1, "DIVERGES"),
    ("Leading", 1, 1, None),     # too few toned headlines
    ("Leading", 2, 2, None),     # flat
    (None, 5, 0, None),          # no quadrant
])
def test_read(quad, pos, neg, read):
    items = [{"tone": "POS"}] * pos + [{"tone": "NEG"}] * neg + [{"tone": "NEU"}] * 3
    assert nr._read(quad, nr._tone(items)) == read


def test_endpoint_groups_follow_rot(monkeypatch):
    rows = [
        {"id": "XLE", "name": "Energy (XLE)", "kind": "sector", "quadrant": "Leading", "m1": 3.0},
        {"id": "XLK", "name": "Information Technology (XLK)", "kind": "sector", "quadrant": "Lagging"},
        {"id": "SMH", "name": "Semiconductors", "kind": "theme", "quadrant": "Lagging"},
    ]
    monkeypatch.setattr(nr.rotation, "rotation_table",
                        lambda bench, market: {"rows": rows, "bench": "SPY", "as_of": "2026-10-22"})
    feed = {
        "XLE": ["Energy stocks surge", "Oil jumps", "Refiners rally"],
        "XLK": ["Tech stocks rise", "Chipmakers gain", "Software rebounds"],
    }

    def fake_queries(market, row):
        return [("stub", lambda: [{"title": t, "url": f"https://x/{row['id']}/{i}", "source": "S",
                                   "published_at": "2026-10-22T10:00:00Z"}
                                  for i, t in enumerate(feed.get(row["id"], []))])]

    monkeypatch.setattr(nr, "_queries", fake_queries)
    monkeypatch.setattr(nr, "_store", {})
    d = nr.rotation_news(market="US", kind="sector", fresh=0, wait=None, group="", headlines=12)
    assert [g["id"] for g in d["groups"]] == ["XLE", "XLK"]  # themes left out
    assert d["pending"] == 0
    xle, xlk = d["groups"]
    assert xle["tone"] == {"n": 3, "pos": 3, "neg": 0, "neu": 0, "net": 1.0}
    assert xle["read"] == "CONFIRMS"
    assert xlk["read"] == "DIVERGES"  # lagging price, upbeat words
    assert "not a signal" in d["method"]


def _stub_endpoint(monkeypatch, rows, feed):
    monkeypatch.setattr(nr.rotation, "rotation_table",
                        lambda bench, market: {"rows": rows, "bench": "SPY", "as_of": "2026-10-22"})

    def fake_queries(market, row):
        return [("stub", lambda: [{"title": t, "url": f"https://x/{row['id']}/{i}", "source": "S",
                                   "published_at": "2026-10-22T10:00:00Z"}
                                  for i, t in enumerate(feed.get(row["id"], []))])]

    monkeypatch.setattr(nr, "_queries", fake_queries)
    monkeypatch.setattr(nr, "_store", {})


def test_group_filter_and_headline_cap(monkeypatch):
    rows = [
        {"id": "XLE", "name": "Energy (XLE)", "kind": "sector", "quadrant": "Leading"},
        {"id": "KBE", "name": "Banks", "kind": "theme", "quadrant": "Leading"},
    ]
    _stub_endpoint(monkeypatch, rows, {"KBE": ["Banks rally", "Bank stocks jump", "Banks gain", "Banks slide"]})
    # by a word of the name, across kinds; tone counted over all, list capped
    d = nr.rotation_news(market="US", kind="", fresh=0, wait=None, group="banks", headlines=2)
    assert [g["id"] for g in d["groups"]] == ["KBE"]
    assert d["groups"][0]["tone"]["n"] == 4 and len(d["groups"][0]["headlines"]) == 2
    # by id
    d = nr.rotation_news(market="US", kind="", fresh=0, wait=None, group="xle", headlines=0)
    assert [g["id"] for g in d["groups"]] == ["XLE"] and d["groups"][0]["headlines"] == []
    # no match: says which groups exist
    d = nr.rotation_news(market="US", kind="", fresh=0, wait=None, group="crypto", headlines=3)
    assert d["groups"] == [] and "XLE (Energy (XLE))" in d["error"]


# ── Members ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("sym,name,title,hit", [
    ("XOM", "EXXONMOBIL HOLDINGS CORP", "ExxonMobil stock and oil majors", True),
    ("CVX", "CHEVRON CORP", "What is CVX eyeing in Iraq", True),
    # "Williams" of Williams Companies is not "Williams-Sonoma"
    ("WMB", "WILLIAMS COMPANIES INC", "Is Williams-Sonoma stock's winning streak skill?", False),
    ("WMB", "WILLIAMS COMPANIES INC", "Williams Cos stock little changed", True),
    # a generic first word needs the second one too
    ("BAY", "BANK OF AYUDHYA PCL", "Bank stocks fall across Asia", False),
    ("BBL", "BANGKOK BANK PCL", "Bangkok Bank PCL's dividend analysis", True),
    ("BBL", "BANGKOK BANK PCL", "Bangkok traffic eases", False),
    # the ticker counts only as a capitalised word
    ("KTB", "KRUNG THAI BANK PCL", "ktb lowercase is not the ticker", False),
])
def test_stock_pattern(sym, name, title, hit):
    assert bool(nr._stock_pattern(sym, name).search(title)) is hit


def test_member_articles_need_the_name_not_just_the_tag():
    # the WATCHLIST merge tags a shared link with every symbol whose feed carried it
    arts = [
        {"title": "Corn fades back lower on Thursday", "symbols": ["SCB.BK", "BBL.BK"]},
        {"title": "Bangkok Bank profit drops 31%", "symbols": ["SCB.BK", "BBL.BK"]},
    ]
    assert [a["title"] for a in nr._member_articles(arts, "BBL.BK", "BANGKOK BANK PCL")] == \
        ["Bangkok Bank profit drops 31%"]
    assert nr._member_articles(arts, "SCB.BK", "SCB X PCL") == []


def test_rollup_weights_and_breadth():
    def m(w, pos, neg, neu):
        return {"weight": w, "tone": nr._tone([{"tone": "POS"}] * pos + [{"tone": "NEG"}] * neg
                                             + [{"tone": "NEU"}] * neu)}
    members = [m(30, 2, 0, 2), m(10, 0, 2, 2), m(5, 0, 0, 0)]
    r = nr._rollup(members, "Leading")
    # (30×0.5 + 10×-0.5) / 40
    assert r["weighted_net"] == 0.25 and r["weight_covered"] == 40 and r["weight_listed"] == 45
    assert r["breadth"] == {"positive": 1, "negative": 1, "flat": 0, "no_news": 1}
    assert r["read"] == "CONFIRMS"
    assert nr._rollup(members, "Lagging")["read"] == "DIVERGES"
    assert nr._rollup([m(10, 0, 0, 3)], "Leading")["read"] is None   # flat
    assert nr._rollup([m(10, 0, 0, 0)], "Leading")["weighted_net"] is None


def test_members_endpoint(monkeypatch):
    monkeypatch.setattr(nr.rotation, "rotation_table", lambda bench, market: {
        "rows": [{"id": "FINCIAL", "name": "Financials", "kind": "industry", "quadrant": "Improving"}]})
    monkeypatch.setattr(nr.rotation, "rotation_constituents", lambda id, market: {
        "bench": "TDEX.BK", "group": {"source": {"weight_basis": "% of group market cap"}},
        "rows": [{"symbol": "KBANK", "name": "KASIKORNBANK PCL", "weight": 15.0, "quadrant": "Improving"},
                 {"symbol": "KTB", "name": "KRUNG THAI BANK PCL", "weight": 17.0, "quadrant": "Leading"}]})
    seen = {}

    def fake_news(**kw):
        seen.update(kw)
        return {"as_of": "2026-10-23T00:00:00Z", "pending": 0, "articles": [
            {"title": "Kasikornbank profit jumps", "url": "u1", "symbols": ["KBANK.BK"]},
            {"title": "Krung Thai Bank shares fall", "url": "u2", "symbols": ["KTB.BK"]},
            {"title": "Kasikornbank shares rally", "url": "u3", "symbols": ["KBANK.BK"]},
        ]}

    monkeypatch.setattr(nr.news_watchlist, "watchlist_news", fake_news)
    d = nr.rotation_member_news(market="TH", group="financials", top=10, headlines=1, fresh=0, wait=None)
    assert seen["symbols"] == "KTB.BK,KBANK.BK" and seen["polymarket"] == 0   # largest first, .BK
    assert [x["symbol"] for x in d["members"]] == ["KTB", "KBANK"]
    ktb, kbank = d["members"]
    assert ktb["tone"]["net"] == -1.0 and kbank["tone"] == {"n": 2, "pos": 2, "neg": 0, "neu": 0, "net": 1.0}
    assert len(kbank["headlines"]) == 1
    assert d["group"]["id"] == "FINCIAL" and d["weight_basis"] == "% of group market cap"
    assert d["rollup"]["weighted_net"] == round((17 * -1 + 15 * 1) / 32, 3)
    miss = nr.rotation_member_news(market="TH", group="zzz", top=10, headlines=1, fresh=0, wait=None)
    assert miss["members"] == [] and "FINCIAL (Financials)" in miss["error"]
