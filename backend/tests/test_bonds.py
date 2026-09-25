"""BOND view — issuance classification, EDGAR paging/dedupe, event study, auction weeks."""
from datetime import date, timedelta

from routers import bonds


# ── classify ──────────────────────────────────────────────────────────────────

def test_bank_sic_wins_over_corporate_coregistrant():
    # A bank note guaranteed by an operating subsidiary is still a bank note
    assert bonds.classify(["6211", "7373"], ["MORGAN STANLEY", "X"]) == "BANK"


def test_abs_sov_fin_corp():
    assert bonds.classify(["6189"], ["CARMAX AUTO FUNDING LLC"]) == "ABS"
    assert bonds.classify(["8888"], ["REPUBLIC OF TURKEY"]) == "SOV"
    assert bonds.classify(["6798"], ["SOME REIT"]) == "FIN"
    assert bonds.classify(["5140"], ["SYSCO CORP"]) == "CORP"


def test_no_sic_falls_back_to_name():
    assert bonds.classify([], ["Morgan Stanley Finance LLC"]) == "BANK"
    assert bonds.classify([""], ["SARATOGA INVESTMENT CORP."]) == "CORP"


# ── _fetch_day: pagination + dedupe on accession ──────────────────────────────

class _Resp:
    status_code = 200

    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


class _Session:
    """Serves `pages` in order and records the `from` offsets it was asked for."""

    def __init__(self, pages, total):
        self.pages, self.total, self.offsets = pages, total, []

    def get(self, url, params=None, timeout=None):
        self.offsets.append(params["from"])
        hits = self.pages[len(self.offsets) - 1]
        return _Resp({"hits": {"total": {"value": self.total}, "hits": hits}})


def _hit(adsh, name, sic, form="424B5"):
    return {"_source": {
        "adsh": adsh, "display_names": [f"{name}  (CIK 0000000001)"], "sics": [sic],
        "ciks": ["0000000001"], "form": form, "file_date": "2026-09-24",
    }}


def test_fetch_day_pages_and_merges_documents_of_one_filing(monkeypatch):
    monkeypatch.setattr(bonds, "_REQ_GAP_S", 0)
    page1 = [_hit("A-1", "SYSCO CORP", "5140"), _hit("B-1", "MORGAN STANLEY", "6211", "424B2")]
    # Second document of A-1 names a subsidiary guarantor — same filing
    page2 = [_hit("A-1", "Sysco Albany, LLC", "5140"), _hit("C-1", "CARMAX AUTO FUNDING LLC", "6189")]
    s = _Session([page1, page2], total=4)

    out = {f["adsh"]: f for f in bonds._fetch_day(s, "2026-09-24")}

    assert s.offsets == [0, 2]
    assert set(out) == {"A-1", "B-1", "C-1"}
    assert out["A-1"]["category"] == "CORP" and out["A-1"]["issuer"] == "SYSCO CORP"
    assert out["B-1"]["category"] == "BANK"
    assert out["C-1"]["category"] == "ABS"


def test_fetch_day_stops_on_empty_page(monkeypatch):
    monkeypatch.setattr(bonds, "_REQ_GAP_S", 0)
    s = _Session([[]], total=50)  # total says more, page says none — must not loop
    assert bonds._fetch_day(s, "2026-09-24") == []
    assert s.offsets == [0]


# ── event study ───────────────────────────────────────────────────────────────

def _bdays(n):
    d, out = date(2026, 1, 5), []
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def test_event_study_detects_yield_jump_on_heavy_days():
    days = _bdays(120)
    heavy = set(days[10::10])          # every 10th day is a heavy-issuance day
    daily, hist, y = [], [], 4.0
    for d in days:
        n = 20 if d in heavy else 3
        daily.append({"date": d, "CORP": n, "FIN": 0, "ABS": 0, "SOV": 0, "BANK": 0, "ex_bank": n})
        y += 0.05 if d in heavy else 0.0   # +5bp on heavy days, flat otherwise
        hist.append({"date": d, "UST10Y": round(y, 4), "IG_OAS": 1.0})
    complete = {d: True for d in days}

    res = bonds.event_study(daily, complete, hist)

    assert res["ready"] is True
    assert res["threshold"] == 4          # ties at the p90 value (3) pushed it above
    row = next(r for r in res["rows"] if r["series"] == "UST10Y" and r["h"] == 0)
    assert row["event_mean_bp"] == 5.0
    assert row["other_mean_bp"] == 0.0
    assert row["diff_bp"] == 5.0


def test_event_study_waits_for_enough_days():
    days = _bdays(10)
    daily = [{"date": d, "ex_bank": 1} for d in days]
    res = bonds.event_study(daily, {d: True for d in days}, [])
    assert res["ready"] is False


def test_event_study_ignores_incomplete_days():
    days = _bdays(60)
    daily = [{"date": d, "CORP": 1, "FIN": 0, "ABS": 0, "ex_bank": 1} for d in days]
    res = bonds.event_study(daily, {d: False for d in days}, [])
    assert res["ready"] is False and res["n_days"] == 0


# ── Treasury weekly supply ────────────────────────────────────────────────────

def test_weekly_supply_splits_bills_from_coupons():
    auctions = [
        {"auction_date": "2026-09-22", "type": "Bill", "offering_bn": 90.0},
        {"auction_date": "2026-09-23", "type": "Note", "offering_bn": 70.0},
        {"auction_date": "2026-09-24", "type": "TIPS", "offering_bn": 20.0},
        {"auction_date": "2026-09-24", "type": "CMB", "offering_bn": 10.0},
        {"auction_date": "2026-09-29", "type": "Bond", "offering_bn": None},
    ]
    w = bonds._weekly_supply(auctions)
    assert w[0] == {"week": "2026-09-21", "bills_bn": 100.0, "coupons_bn": 90.0}
    assert w[1] == {"week": "2026-09-28", "bills_bn": 0.0, "coupons_bn": 0.0}


# ── EFTS retry ────────────────────────────────────────────────────────────────

class _Flaky:
    def __init__(self, codes):
        self.codes, self.calls = list(codes), 0

    def get(self, url, params=None, timeout=None):
        self.calls += 1
        code = self.codes.pop(0)
        r = _Resp({"hits": {"total": {"value": 0}, "hits": []}})
        r.status_code = code
        if code >= 400:
            import requests

            def boom():
                raise requests.HTTPError(str(code))
            r.raise_for_status = boom
        return r


def test_efts_get_retries_5xx_then_succeeds(monkeypatch):
    monkeypatch.setattr(bonds, "_RETRY_BACKOFF_S", 0)
    s = _Flaky([503, 500, 200])
    assert bonds._efts_get(s, {}).status_code == 200
    assert s.calls == 3


def test_efts_get_does_not_retry_4xx(monkeypatch):
    import pytest
    import requests

    monkeypatch.setattr(bonds, "_RETRY_BACKOFF_S", 0)
    s = _Flaky([403, 200])
    with pytest.raises(requests.HTTPError):
        bonds._efts_get(s, {})
    assert s.calls == 1
