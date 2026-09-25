"""
BOND view — price of bonds next to the supply of them.

The question this page exists to answer: when yields rise, is new corporate
debt part of the reason? That needs two things on one screen that no other
view puts together:

  PRICE   Treasury yields, term premium, real yield, IG/HY spreads, BBB yield
          (FRED daily). A corporate yield is Treasury + spread, so the two are
          kept apart — supply pressure shows up in the spread, hedging flow and
          term premium show up in the Treasury leg.
  SUPPLY  - corporate prospectuses per day (SEC EDGAR full-text search)
          - Treasury auctions, recent and announced (fiscaldata, no key)
          - slow stock measures: Z.1 nonfinancial corporate debt securities,
            C&I bank loans, SLOOS tightening (FRED, monthly/quarterly)

Issuance proxy (verified 2026-09-25): EFTS query `"aggregate principal amount"`
on forms 424B2/424B5 for one day returns every matching DOCUMENT with its
accession number (`adsh`) and the registrants' SIC codes. One deal is one
accession, but it is listed once per co-registrant (Sysco's notes came with 60
guarantor subsidiaries), so rows are keyed on `adsh`. SIC separates the noise:
banks' structured notes (6021/6022/6029/6211 …) are ~80% of 424B2 volume and
are not "corporate issuance" in the sense the question means. It is a COUNT of
deals, not dollars — no free source publishes daily $ volume.

Endpoints:
  GET /api/bonds/overview   — KPIs + aligned 2y daily history
  GET /api/bonds/supply     — Treasury auctions + weekly coupon supply + slow series
  GET /api/bonds/issuance   — daily deal counts, recent deals, event study, backfill status
"""
from __future__ import annotations

import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta

import requests
from fastapi import APIRouter

from cache import TTLCache
from config import FRED_API_KEY
from db import get_db
from routers.global_yields import _fred_fetch

router = APIRouter()
_cache = TTLCache(ttl=24 * 3600, maxsize=16)


def _cget(key: str):
    """TTLCache has one TTL per cache; a partial pull here needs a shorter one."""
    entry = _cache.get(key)
    if entry and time.time() - entry["at"] < entry["ttl"]:
        return entry["data"]
    return None


def _cset(key: str, data, ttl: int) -> None:
    _cache.set(key, {"data": data, "at": time.time(), "ttl": ttl})

# ── FRED series ───────────────────────────────────────────────────────────────

# (key, fred_id, label, unit, group). `unit` "%" → changes shown in bp.
_DAILY: list[tuple[str, str, str, str, str]] = [
    ("UST2Y",  "DGS2",           "UST 2Y",            "%", "treasury"),
    ("UST10Y", "DGS10",          "UST 10Y",           "%", "treasury"),
    ("UST30Y", "DGS30",          "UST 30Y",           "%", "treasury"),
    ("TP10",   "THREEFFTP10",    "10Y TERM PREMIUM",  "%", "treasury"),
    ("REAL10", "DFII10",         "10Y REAL (TIPS)",   "%", "treasury"),
    ("IG_OAS", "BAMLC0A0CM",     "IG OAS",            "%", "credit"),
    ("HY_OAS", "BAMLH0A0HYM2",   "HY OAS",            "%", "credit"),
    ("BBB_Y",  "BAMLC0A4CBBBEY", "BBB YIELD",         "%", "credit"),
    ("AAA_Y",  "DAAA",           "MOODY'S Aaa",       "%", "credit"),
    ("BAA_Y",  "DBAA",           "MOODY'S Baa",       "%", "credit"),
]

# Derived: (key, label, a, b) → a − b
_DERIVED: list[tuple[str, str, str, str]] = [
    ("CURVE_2S10S", "2s10s",      "UST10Y", "UST2Y"),
    ("BAA_AAA",     "Baa − Aaa",  "BAA_Y",  "AAA_Y"),
]

_HISTORY_DAYS = 800   # ~2y of business days, plus pad for the 1y percentile


def _pctile(values: list[float], x: float) -> float | None:
    if len(values) < 20:
        return None
    return round(100.0 * sum(1 for v in values if v <= x) / len(values), 0)


def _build_overview() -> dict:
    if not FRED_API_KEY:
        return {"ok": False, "detail": "FRED_API_KEY not configured", "kpis": [], "history": []}

    start = (date.today() - timedelta(days=_HISTORY_DAYS)).isoformat()
    raw: dict[str, dict[str, float]] = {}
    errors: list[str] = []

    def _one(key: str, sid: str):
        return key, _fred_fetch(sid, limit=1000, obs_start=start)

    # FRED is capped at 3 in-flight app-wide (fred-timeout-hardening)
    with ThreadPoolExecutor(max_workers=3) as pool:
        futs = [pool.submit(_one, k, sid) for k, sid, *_ in _DAILY]
        for (k, sid, *_), fut in zip(_DAILY, futs):
            try:
                _, obs = fut.result()
                raw[k] = {o["date"]: o["value"] for o in obs}
            except Exception as exc:  # one dead series must not blank the page
                errors.append(f"{sid}: {type(exc).__name__}")
                raw[k] = {}

    for key, _label, a, b in _DERIVED:
        raw[key] = {d: round(v - raw[b][d], 4) for d, v in raw[a].items() if d in raw[b]}

    dates = sorted(set().union(*(s.keys() for s in raw.values())))
    history = [{"date": d, **{k: raw[k].get(d) for k in raw}} for d in dates]

    meta = [(k, sid, lbl, unit, grp) for k, sid, lbl, unit, grp in _DAILY]
    meta += [(k, None, lbl, "%", "derived") for k, lbl, *_ in _DERIVED]

    one_year_ago = (date.today() - timedelta(days=365)).isoformat()
    kpis = []
    for key, sid, label, unit, group in meta:
        pts = sorted(raw[key].items())
        if not pts:
            kpis.append({"id": key, "label": label, "fred_id": sid, "group": group,
                         "value": None, "asOf": None})
            continue
        last_d, last_v = pts[-1]

        def _chg(n: int) -> float | None:
            return round((last_v - pts[-1 - n][1]) * 100, 1) if len(pts) > n else None

        kpis.append({
            "id": key, "label": label, "fred_id": sid, "group": group, "unit": unit,
            "value": last_v, "asOf": last_d,
            "chg1d_bp": _chg(1), "chg5d_bp": _chg(5), "chg20d_bp": _chg(20),
            "pctile_1y": _pctile([v for d, v in pts if d >= one_year_ago], last_v),
        })

    return {
        "ok": True,
        "asOf": max((k["asOf"] for k in kpis if k.get("asOf")), default=None),
        "kpis": kpis,
        "history": history,
        "errors": errors,
        "source": "FRED (H.15, ICE BofA, Moody's, Kim-Wright term premium)",
    }


def get_overview() -> dict:
    cached = _cget("overview")
    if cached is not None:
        return cached
    data = _build_overview()
    # A partial pull is kept 10 min, not an hour, so one flaky series recovers
    _cset("overview", data, 600 if data.get("errors") else 3600)
    return data


@router.get("/api/bonds/overview")
def bonds_overview():
    return get_overview()


# ── Supply: Treasury auctions + slow stock series ─────────────────────────────

_AUCTIONS_URL = (
    "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query"
)
_AUCTION_FIELDS = ",".join([
    "auction_date", "issue_date", "security_type", "security_term", "reopening",
    "offering_amt", "total_accepted", "comp_accepted", "high_yield", "high_investment_rate",
    "bid_to_cover_ratio",
    "primary_dealer_accepted", "indirect_bidder_accepted", "direct_bidder_accepted",
    "inflation_index_security", "floating_rate", "cash_management_bill_cmb",
])


def _num(v) -> float | None:
    if v in (None, "", "null"):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _fetch_auctions(since: str) -> list[dict]:
    r = requests.get(_AUCTIONS_URL, params={
        "fields": _AUCTION_FIELDS,
        "filter": f"auction_date:gte:{since}",
        "sort": "auction_date",
        "page[size]": 1000,
    }, timeout=20)
    r.raise_for_status()
    out = []
    today = date.today().isoformat()
    for a in r.json().get("data", []):
        kind = a.get("security_type") or ""
        if a.get("inflation_index_security") == "Yes":
            kind = "TIPS"
        elif a.get("floating_rate") == "Yes":
            kind = "FRN"
        elif a.get("cash_management_bill_cmb") == "Yes":
            kind = "CMB"
        comp = _num(a.get("comp_accepted"))
        dealer = _num(a.get("primary_dealer_accepted"))
        indirect = _num(a.get("indirect_bidder_accepted"))
        # Bills clear on a discount rate; their bond-equivalent yield is the
        # "investment rate", which is what compares with a coupon's high yield
        hy = _num(a.get("high_yield"))
        if hy is None:
            hy = _num(a.get("high_investment_rate"))
        accepted = _num(a.get("total_accepted"))
        out.append({
            "auction_date": a["auction_date"],
            "issue_date": a.get("issue_date"),
            "type": kind,
            "term": a.get("security_term"),
            "reopening": a.get("reopening") == "Yes",
            "offering_bn": round(_num(a.get("offering_amt")) / 1e9, 1) if _num(a.get("offering_amt")) else None,
            "accepted_bn": round(accepted / 1e9, 1) if accepted else None,
            "high_yield": hy,
            "bid_to_cover": _num(a.get("bid_to_cover_ratio")),
            "dealer_pct": round(100 * dealer / comp, 1) if dealer is not None and comp else None,
            "indirect_pct": round(100 * indirect / comp, 1) if indirect is not None and comp else None,
            # Announced but not yet held: no result fields yet
            "upcoming": accepted is None and a["auction_date"] >= today,
        })
    return out


def _weekly_supply(auctions: list[dict]) -> list[dict]:
    """Offering $bn per ISO week, bills vs coupons (Note/Bond/TIPS/FRN).

    Bills roll over every few weeks, so their gross size says little about net
    duration supply — coupons are what the term-premium story is about.
    """
    weeks: dict[str, dict] = {}
    for a in auctions:
        d = date.fromisoformat(a["auction_date"])
        monday = (d - timedelta(days=d.weekday())).isoformat()
        w = weeks.setdefault(monday, {"week": monday, "bills_bn": 0.0, "coupons_bn": 0.0})
        amt = a["offering_bn"] or 0.0
        if a["type"] in ("Bill", "CMB"):
            w["bills_bn"] += amt
        else:
            w["coupons_bn"] += amt
    return [
        {**w, "bills_bn": round(w["bills_bn"], 1), "coupons_bn": round(w["coupons_bn"], 1)}
        for _, w in sorted(weeks.items())
    ]


# (key, fred_id, label, unit, transform)
_SLOW: list[tuple[str, str, str, str, str]] = [
    ("NFC_DEBT_SEC", "NCBDBIQ027S", "Nonfin corp debt securities (Z.1)", "$bn", "q"),
    ("CI_LOANS",     "BUSLOANS",    "C&I loans, all banks",              "$bn", "m"),
    ("SLOOS_CI",     "DRTSCILM",    "Banks tightening C&I (SLOOS)",      "% net", "q"),
    ("FED_DEBT",     "GFDEBTN",     "Federal debt, total public",        "$bn", "q"),
]


def _slow_series() -> tuple[list[dict], list[str]]:
    start = (date.today() - timedelta(days=365 * 6)).isoformat()
    out, errors = [], []
    for key, sid, label, unit, freq in _SLOW:
        try:
            obs = _fred_fetch(sid, limit=100, obs_start=start)
        except Exception as exc:
            errors.append(f"{sid}: {type(exc).__name__}")
            continue
        vals = [(o["date"], o["value"]) for o in obs]
        # Z.1 and federal debt are published in $ millions
        if sid in ("NCBDBIQ027S", "GFDEBTN"):
            vals = [(d, round(v / 1000, 1)) for d, v in vals]
        yoy_lag = 4 if freq == "q" else 12
        points = []
        for i, (d, v) in enumerate(vals):
            prev = vals[i - 1][1] if i >= 1 else None
            base = vals[i - yoy_lag][1] if i >= yoy_lag else None
            points.append({
                "date": d, "value": v,
                "chg_pct": round(100 * (v / prev - 1), 2) if prev and unit == "$bn" else None,
                "yoy_pct": round(100 * (v / base - 1), 2) if base and unit == "$bn" else None,
            })
        out.append({"id": key, "fred_id": sid, "label": label, "unit": unit,
                    "freq": freq, "points": points})
    return out, errors


def _build_supply() -> dict:
    today = date.today()
    errors: list[str] = []
    try:
        auctions = _fetch_auctions((today - timedelta(days=190)).isoformat())
    except Exception as exc:
        auctions = []
        errors.append(f"fiscaldata: {type(exc).__name__}")
    slow, slow_err = _slow_series() if FRED_API_KEY else ([], ["FRED_API_KEY not configured"])
    errors += slow_err

    upcoming = [a for a in auctions if a["upcoming"]]
    recent = [a for a in auctions if not a["upcoming"]][-40:][::-1]
    return {
        "ok": True,
        "auctions": {"upcoming": upcoming, "recent": recent},
        "weekly": _weekly_supply(auctions),
        "slow": slow,
        "errors": errors,
        "source": "Treasury fiscaldata auctions_query · FRED (Z.1, H.8, SLOOS)",
    }


@router.get("/api/bonds/supply")
def bonds_supply():
    cached = _cget("supply")
    if cached is not None:
        return cached
    data = _build_supply()
    _cset("supply", data, 600 if data["errors"] else 6 * 3600)
    return data


# ── Issuance proxy: SEC EDGAR full-text search ────────────────────────────────

_EFTS_URL = "https://efts.sec.gov/LATEST/search-index"
# SEC wants "Company contact@domain" and 403s a parenthesised comment
_SEC_HEADERS = {"User-Agent": "BloombergTerminal/1.0 admin@localhost.com"}
_EFTS_QUERY = '"aggregate principal amount"'
_EFTS_FORMS = "424B2,424B5"

#: banks / broker-dealers / thrifts — their 424B2s are structured notes
_BANK_SIC = {"6021", "6022", "6029", "6035", "6036", "6211", "6199"}
_ABS_SIC = {"6189"}
_SOV_SIC = {"8888"}

BACKFILL_DAYS = 365
_REQ_GAP_S = 0.25          # ≤ 4 req/s, SEC's ceiling is 10
_FAIL_COOLDOWN_S = 600     # after repeated failures, wait before trying again
_RETRY_BACKOFF_S = 1.5


def classify(sics: list[str], names: list[str]) -> str:
    """BANK | ABS | SOV | FIN | CORP for one filing.

    A filing is judged by ANY of its registrants: a bank's note guaranteed by
    its finance subsidiary is still a bank note. With no SIC at all (some
    finance vehicles have none) the name decides between BANK and CORP.
    """
    s = {x for x in sics if x}
    if s & _BANK_SIC:
        return "BANK"
    if s & _ABS_SIC:
        return "ABS"
    if s & _SOV_SIC:
        return "SOV"
    if not s:
        joined = " ".join(names).upper()
        if any(w in joined for w in ("BANK", "FINANCE LLC", "GLOBAL MARKETS", "SECURITIES")):
            return "BANK"
        return "CORP"
    if any(x.startswith("6") for x in s):
        return "FIN"
    return "CORP"


def _clean_name(display: str) -> str:
    # "Kyndryl Holdings, Inc.  (KD)  (CIK 0001867072)" → "Kyndryl Holdings, Inc."
    return display.split("  (")[0].strip()


def _efts_get(session, params: dict, attempts: int = 3):
    """EFTS answers a steady trickle of 5xx under load (2026-09-25: 6 in two
    minutes of backfill) that succeed on a second try — retry those and
    connection drops; a 4xx is a real answer and is raised at once."""
    for i in range(attempts):
        try:
            r = session.get(_EFTS_URL, params=params, timeout=20)
            if r.status_code < 500:
                r.raise_for_status()
                return r
            err: Exception = requests.HTTPError(f"{r.status_code}", response=r)
        except (requests.ConnectionError, requests.Timeout) as exc:
            err = exc
        if i < attempts - 1:
            time.sleep(_RETRY_BACKOFF_S * (i + 1))
    raise err


def _fetch_day(session: requests.Session, day: str) -> list[dict]:
    """Every matching filing for one day, deduped on accession number."""
    filings: dict[str, dict] = {}
    offset = 0
    while True:
        r = _efts_get(session, {
            "q": _EFTS_QUERY, "forms": _EFTS_FORMS, "dateRange": "custom",
            "startdt": day, "enddt": day, "from": offset,
        })
        body = r.json()
        hits = body.get("hits", {}).get("hits", [])
        total = body.get("hits", {}).get("total", {}).get("value", 0)
        for h in hits:
            src = h.get("_source", {})
            adsh = src.get("adsh")
            if not adsh:
                continue
            names = [_clean_name(n) for n in src.get("display_names") or []]
            sics = src.get("sics") or []
            prev = filings.get(adsh)
            if prev:
                # Another document of the same filing — merge registrants
                prev["_sics"] |= set(sics)
                prev["_names"] |= set(names)
                continue
            ciks = src.get("ciks") or [""]
            filings[adsh] = {
                "adsh": adsh,
                "file_date": src.get("file_date") or day,
                "form": src.get("form") or src.get("file_type") or "",
                "issuer": names[0] if names else "",
                "cik": ciks[0].lstrip("0"),
                "_sics": set(sics),
                "_names": set(names),
            }
        offset += len(hits)
        if not hits or offset >= total:
            break
        time.sleep(_REQ_GAP_S)

    out = []
    for f in filings.values():
        sics, names = sorted(f.pop("_sics")), sorted(f.pop("_names"))
        f["sic"] = ",".join(sics)
        f["category"] = classify(sics, names)
        out.append(f)
    return out


def _store_day(day: str, filings: list[dict], complete: bool) -> None:
    with get_db() as conn:
        conn.executemany(
            """INSERT OR REPLACE INTO bond_issuance_filings
               (adsh, file_date, form, issuer, cik, sic, category)
               VALUES (:adsh, :file_date, :form, :issuer, :cik, :sic, :category)""",
            filings,
        )
        conn.execute(
            """INSERT OR REPLACE INTO bond_issuance_days (date, filings, complete, fetched_at)
               VALUES (?, ?, ?, datetime('now'))""",
            (day, len(filings), 1 if complete else 0),
        )


def _business_days(start: date, end: date) -> list[str]:
    out, d = [], start
    while d <= end:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


class _Backfill:
    """One background thread walking the days not yet stored, newest first.

    Newest first so the chart is useful within a minute of first open; the
    year behind it fills in over the next few minutes (~1–3 requests a day).
    A day is `complete` once it is two days old — EDGAR keeps disseminating a
    day's filings into the evening, so today and yesterday are re-read.
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.thread: threading.Thread | None = None
        self.last_error: str | None = None
        self.cooldown_until = 0.0
        self.done_this_run = 0

    def pending(self) -> list[str]:
        today = date.today()
        days = _business_days(today - timedelta(days=BACKFILL_DAYS), today)
        with get_db() as conn:
            done = {r[0] for r in conn.execute(
                "SELECT date FROM bond_issuance_days WHERE complete = 1")}
            fresh = {r[0] for r in conn.execute(
                "SELECT date FROM bond_issuance_days WHERE complete = 0 "
                "AND fetched_at >= datetime('now', '-30 minutes')")}
        return [d for d in reversed(days) if d not in done and d not in fresh]

    def running(self) -> bool:
        return self.thread is not None and self.thread.is_alive()

    def ensure(self) -> None:
        with self.lock:
            if self.running() or time.time() < self.cooldown_until:
                return
            if not self.pending():
                return
            self.thread = threading.Thread(target=self._run, name="bond-issuance-backfill",
                                           daemon=True)
            self.thread.start()

    def _run(self) -> None:
        session = requests.Session()
        session.headers.update(_SEC_HEADERS)
        cutoff = (date.today() - timedelta(days=2)).isoformat()
        failures = 0
        self.done_this_run = 0
        for day in self.pending():
            try:
                filings = _fetch_day(session, day)
                _store_day(day, filings, complete=day <= cutoff)
                failures = 0
                self.done_this_run += 1
                self.last_error = None
            except Exception as exc:
                failures += 1
                self.last_error = f"{day}: {type(exc).__name__}"
                if failures >= 3:
                    # Negative-cache the whole source: no hammering a down SEC
                    self.cooldown_until = time.time() + _FAIL_COOLDOWN_S
                    return
            time.sleep(_REQ_GAP_S)


_backfill = _Backfill()


def _load_daily() -> tuple[list[dict], dict[str, bool]]:
    with get_db() as conn:
        days = {r["date"]: bool(r["complete"]) for r in conn.execute(
            "SELECT date, complete FROM bond_issuance_days")}
        # A multi-tranche deal files one prospectus per tranche (Sysco: four on
        # 2026-09-24), so a "deal" is one issuer on one day, not one filing
        rows = conn.execute(
            "SELECT file_date, category, COUNT(DISTINCT issuer) AS n FROM bond_issuance_filings "
            "GROUP BY file_date, category").fetchall()
    per: dict[str, dict] = {d: {"date": d, "CORP": 0, "FIN": 0, "ABS": 0, "SOV": 0, "BANK": 0}
                            for d in days}
    for r in rows:
        if r["file_date"] in per:
            per[r["file_date"]][r["category"]] = r["n"]
    daily = sorted(per.values(), key=lambda x: x["date"])
    for d in daily:
        d["ex_bank"] = d["CORP"] + d["FIN"]
    return daily, days


def _weekly_issuance(daily: list[dict], hist: list[dict]) -> list[dict]:
    """Deals per ISO week next to the week's closing 10Y and IG OAS."""
    close: dict[str, dict] = {}
    for h in hist:
        d = date.fromisoformat(h["date"])
        monday = (d - timedelta(days=d.weekday())).isoformat()
        c = close.setdefault(monday, {})
        if h.get("UST10Y") is not None:
            c["UST10Y"] = h["UST10Y"]
        if h.get("IG_OAS") is not None:
            c["IG_OAS"] = h["IG_OAS"]
    weeks: dict[str, dict] = {}
    for d in daily:
        dd = date.fromisoformat(d["date"])
        monday = (dd - timedelta(days=dd.weekday())).isoformat()
        w = weeks.setdefault(monday, {"week": monday, "CORP": 0, "FIN": 0, "ABS": 0, "days": 0})
        w["CORP"] += d["CORP"]
        w["FIN"] += d["FIN"]
        w["ABS"] += d["ABS"]
        w["days"] += 1
    out = []
    for monday, w in sorted(weeks.items()):
        c = close.get(monday, {})
        out.append({**w, "UST10Y": c.get("UST10Y"), "IG_OAS": c.get("IG_OAS")})
    return out


def _welch(a: list[float], b: list[float]) -> float | None:
    if len(a) < 3 or len(b) < 3:
        return None
    ma, mb = sum(a) / len(a), sum(b) / len(b)
    va = sum((x - ma) ** 2 for x in a) / (len(a) - 1)
    vb = sum((x - mb) ** 2 for x in b) / (len(b) - 1)
    se = math.sqrt(va / len(a) + vb / len(b))
    return round((ma - mb) / se, 2) if se > 0 else None


def _pearson(x: list[float], y: list[float]) -> float | None:
    n = len(x)
    if n < 8:
        return None
    mx, my = sum(x) / n, sum(y) / n
    sxy = sum((a - mx) * (b - my) for a, b in zip(x, y))
    sx = math.sqrt(sum((a - mx) ** 2 for a in x))
    sy = math.sqrt(sum((b - my) ** 2 for b in y))
    return round(sxy / (sx * sy), 3) if sx > 0 and sy > 0 else None


def event_study(daily: list[dict], complete: dict[str, bool], hist: list[dict],
                horizons: tuple[int, ...] = (0, 1, 3)) -> dict:
    """Heavy-issuance days (top decile of ex-bank deals) vs every other day.

    Change is measured from the close BEFORE the day (t−1) to the close of
    t+h, so a deal priced on day t whose rate-lock was put on that morning is
    inside the window. Only days fully stored (`complete`) enter the sample.
    """
    counts = {d["date"]: d["ex_bank"] for d in daily if complete.get(d["date"])}
    series = {k: [(h["date"], h[k]) for h in hist if h.get(k) is not None]
              for k in ("UST10Y", "IG_OAS")}
    if len(counts) < 40:
        return {"ready": False, "n_days": len(counts),
                "note": "ต้องมีข้อมูลครบอย่างน้อย 40 วันทำการก่อน — backfill ยังไม่ถึง"}

    ordered = sorted(counts.values())
    threshold = max(ordered[int(0.9 * (len(ordered) - 1))], 1)
    # Deal counts are small integers, so ties at the 90th-percentile value can
    # sweep most of the sample into "heavy". Then heavy means strictly above it.
    if sum(1 for n in ordered if n >= threshold) > 0.2 * len(ordered):
        threshold += 1

    rows = []
    n_event = n_other = 0
    for key, pts in series.items():
        idx = {d: i for i, (d, _) in enumerate(pts)}
        for h in horizons:
            ev, ot = [], []
            for d, n in counts.items():
                i = idx.get(d)
                if i is None or i < 1 or i + h >= len(pts):
                    continue
                chg = (pts[i + h][1] - pts[i - 1][1]) * 100
                (ev if n >= threshold else ot).append(chg)
            if key == "UST10Y" and h == 0:
                n_event, n_other = len(ev), len(ot)
            me = sum(ev) / len(ev) if ev else None
            mo = sum(ot) / len(ot) if ot else None
            rows.append({
                "series": key, "h": h,
                "event_mean_bp": round(me, 2) if me is not None else None,
                "other_mean_bp": round(mo, 2) if mo is not None else None,
                "diff_bp": round(me - mo, 2) if me is not None and mo is not None else None,
                "t": _welch(ev, ot),
                "n_event": len(ev), "n_other": len(ot),
            })

    weekly = [w for w in _weekly_issuance([d for d in daily if complete.get(d["date"])], hist)
              if w["days"] >= 4]
    corr = {}
    for key in ("UST10Y", "IG_OAS"):
        xs, ys = [], []
        for prev, cur in zip(weekly, weekly[1:]):
            if cur.get(key) is not None and prev.get(key) is not None:
                xs.append(cur["CORP"] + cur["FIN"])
                ys.append((cur[key] - prev[key]) * 100)
        corr[key] = {"r": _pearson(xs, ys), "n": len(xs)}

    return {
        "ready": True,
        "threshold": threshold,
        "n_days": len(counts),
        "n_event": n_event,
        "n_other": n_other,
        "rows": rows,
        "weekly_corr": corr,
        "note": ("|t| ≥ 2 ≈ มีนัยสำคัญ. ระวัง causality กลับทาง: บริษัทมักเร่งออกหุ้นกู้ตอน yield/spread "
                 "ต่ำ (ช่วง 'หน้าต่างเปิด') ผลจึงอาจเป็นลบได้แม้ supply กดราคาจริง"),
    }


@router.get("/api/bonds/issuance")
def bonds_issuance():
    _backfill.ensure()
    cached = _cget("issuance")
    if cached is not None and not _backfill.running():
        return cached

    daily, complete = _load_daily()
    hist = get_overview().get("history", [])
    with get_db() as conn:
        # One row per deal (issuer × day); `filings` counts its tranches
        recent = [dict(r) for r in conn.execute(
            "SELECT MAX(adsh) AS adsh, file_date, MAX(form) AS form, issuer, MAX(cik) AS cik, "
            "MAX(sic) AS sic, MAX(category) AS category, COUNT(*) AS filings "
            "FROM bond_issuance_filings WHERE category IN ('CORP', 'FIN') "
            "GROUP BY file_date, issuer ORDER BY file_date DESC, issuer LIMIT 60")]
    for r in recent:
        folder = r["adsh"].replace("-", "")
        r["url"] = f"https://www.sec.gov/Archives/edgar/data/{r['cik']}/{folder}/" if r["cik"] else None

    pending = len(_backfill.pending())
    data = {
        "ok": True,
        "daily": daily,
        "weekly": _weekly_issuance(daily, hist),
        "recent": recent,
        "event_study": event_study(daily, complete, hist),
        "backfill": {
            "days_total": len(_business_days(date.today() - timedelta(days=BACKFILL_DAYS), date.today())),
            "days_stored": sum(1 for v in complete.values() if v),
            "pending": pending,
            "running": _backfill.running(),
            "last_error": _backfill.last_error,
        },
        "method": {
            "query": _EFTS_QUERY,
            "forms": _EFTS_FORMS.split(","),
            "unit": "deals = distinct issuers per day (not $ amount)",
            "caveat": "424B5 also carries some small-cap equity/convertible prospectuses that cite a principal amount",
            "excluded": "BANK = SIC 6021/6022/6029/6035/6036/6199/6211 (structured notes)",
        },
        "source": "SEC EDGAR full-text search",
    }
    # While the backfill runs the numbers move every few seconds — short TTL
    _cset("issuance", data, 30 if _backfill.running() else 1800)
    return data


@router.delete("/api/bonds/cache")
def clear_bonds_cache():
    _cache.clear()
    return {"ok": True}
