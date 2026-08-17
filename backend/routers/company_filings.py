"""
Company filings — SEC EDGAR as the source for financials and forward guidance.

Three things the terminal could not get from yfinance:

* **Guidance** — the "Business Outlook" table a company files as EX-99.1 to the
  8-K item 2.02 that announces earnings. That table *is* next quarter's forecast,
  straight from the issuer.
* **CEO's own words** — the quoted paragraph in the same press release, plus the
  forward-looking language in the latest 10-Q/10-K MD&A.
* **As-reported numbers** — XBRL company facts, tagged by period and form, which
  beat yfinance's normalised statements for anything that must tie to a filing.

Everything here is free and keyless; EDGAR only requires a contact-style
User-Agent (a parenthesised comment in the UA string gets a 403) and stays under
10 requests/second.

US listings only — EDGAR has no coverage of .BK/.KS lines. Those go through
`routers/sec_v2.py` (api.sec.or.th, needs a key).

Endpoints:
    GET /api/company/filings/{symbol}
    GET /api/company/outlook/{symbol}
    GET /api/company/xbrl/{symbol}
"""
from __future__ import annotations

import html
import re

import requests
from fastapi import APIRouter, HTTPException, Query

from cache import TTLCache

router = APIRouter()

_SESSION = requests.Session()
_SESSION.headers.update({
    # Plain "app contact-email" — EDGAR 403s browser-style agents and anything
    # carrying a parenthesised comment.
    "User-Agent": "BloombergTerminal/1.0 admin@localhost.com",
    "Accept-Encoding": "gzip, deflate",
})
_TIMEOUT = 25

_cik_cache = TTLCache(ttl=86_400, maxsize=4)        # ticker → CIK map
_filings_cache = TTLCache(ttl=6 * 3600, maxsize=300)
_outlook_cache = TTLCache(ttl=6 * 3600, maxsize=300)
_xbrl_cache = TTLCache(ttl=86_400, maxsize=300)

_US_TICKER = re.compile(r"^[A-Z][A-Z\-]{0,5}$")

# ── HTML → text ───────────────────────────────────────────────────────────────

def _to_text(raw: str) -> str:
    body = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", raw)
    body = re.sub(r"(?i)</(p|div|tr|br|h\d)>", " \n", body)
    body = re.sub(r"<[^>]+>", " ", body)
    body = html.unescape(body)
    body = body.replace(" ", " ").replace("’", "'")
    body = re.sub(r"[ \t]+", " ", body)
    return re.sub(r"\n\s*\n+", "\n", body).strip()


# ── CIK lookup ────────────────────────────────────────────────────────────────

def _cik_map() -> dict[str, str]:
    cached = _cik_cache.get("map")
    if cached is not None:
        return cached
    try:
        res = _SESSION.get("https://www.sec.gov/files/company_tickers.json", timeout=_TIMEOUT)
        res.raise_for_status()
        data = res.json()
    except Exception as exc:
        print(f"[company] cik map: {exc}")
        return {}
    mapping = {
        str(row["ticker"]).upper(): str(row["cik_str"]).zfill(10)
        for row in data.values()
        if row.get("ticker")
    }
    _cik_cache.set("map", mapping)
    return mapping


def _cik_for(symbol: str) -> str | None:
    return _cik_map().get(symbol.upper())


# ── Filing index ──────────────────────────────────────────────────────────────

def _recent_filings(cik: str, limit: int = 40) -> list[dict]:
    cached = _filings_cache.get(cik)
    if cached is None:
        try:
            res = _SESSION.get(
                f"https://data.sec.gov/submissions/CIK{cik}.json",
                headers={"Host": "data.sec.gov"},
                timeout=_TIMEOUT,
            )
            res.raise_for_status()
            recent = res.json()["filings"]["recent"]
        except Exception as exc:
            print(f"[company] submissions {cik}: {exc}")
            return []

        no_zero = cik.lstrip("0")
        rows: list[dict] = []
        for i, form in enumerate(recent.get("form", [])):
            accession = recent["accessionNumber"][i]
            folder = accession.replace("-", "")
            doc = recent["primaryDocument"][i]
            rows.append({
                "form": form,
                "filed": recent["filingDate"][i],
                "period": (recent.get("reportDate") or [""] * (i + 1))[i],
                "items": (recent.get("items") or [""] * (i + 1))[i],
                "accession": accession,
                "folder": folder,
                "document": doc,
                "url": f"https://www.sec.gov/Archives/edgar/data/{no_zero}/{folder}/{doc}",
                "index_url": (
                    f"https://www.sec.gov/Archives/edgar/data/{no_zero}/{folder}/"
                    f"{accession}-index.html"
                ),
            })
        cached = rows
        _filings_cache.set(cik, rows)
    return cached[:limit]


def _fetch_doc(url: str) -> str:
    try:
        res = _SESSION.get(url, timeout=_TIMEOUT)
        if not res.ok:
            return ""
        return _to_text(res.text)
    except Exception as exc:
        print(f"[company] doc {url}: {exc}")
        return ""


# Filenames that are never the press release: cover page assets, XBRL viewer
# fragments, the filing index itself.
_NOT_RELEASE = re.compile(r"(index|FilingSummary|MetaLinks|^R\d+\.htm|Show\.js|report\.css)", re.I)
# Issuers name the release anything: ex991, q1fy27pr.htm, a2026q3ex991-pressrelease.htm.
_RELEASE_HINT = re.compile(r"(ex.?99|press.?release|earnings|[-_a-z0-9]*pr\.htm|commentary)", re.I)


def _release_candidates(cik: str, folder: str, cover_doc: str = "") -> list[str]:
    """Documents in an 8-K folder that could be the earnings release, best guess first."""
    no_zero = cik.lstrip("0")
    base = f"https://www.sec.gov/Archives/edgar/data/{no_zero}/{folder}"
    try:
        res = _SESSION.get(f"{base}/index.json", timeout=_TIMEOUT)
        if not res.ok:
            return []
        items = res.json().get("directory", {}).get("item", [])
    except Exception as exc:
        print(f"[company] index {folder}: {exc}")
        return []

    names = [
        i.get("name", "")
        for i in items
        if i.get("name", "").lower().endswith((".htm", ".html", ".txt"))
        and not _NOT_RELEASE.search(i.get("name", ""))
        and i.get("name", "") != cover_doc
    ]
    hinted = [n for n in names if _RELEASE_HINT.search(n)]
    rest = [n for n in names if n not in hinted]
    return [f"{base}/{n}" for n in (hinted + rest)][:3]


def _release_score(text: str) -> int:
    """How much this document looks like an earnings release with an outlook in it."""
    score = 0
    for pattern, weight in (
        (r"business outlook|financial outlook|outlook for (?:the )?(?:first|second|third|fourth)", 4),
        (rf"said\s+[A-Z][\w.\- ]{{2,40}},[^.]{{0,80}}{_CEO_TITLES}", 3),
        (r"guidance", 2),
        (r"gross margin", 1),
        (r"revenue", 1),
    ):
        if re.search(pattern, text, re.I):
            score += weight
    return score


# ── Extraction ────────────────────────────────────────────────────────────────

_CEO_TITLES = r"(?:chief executive officer|CEO)"

def _ceo_quotes(text: str, limit: int = 3) -> list[dict]:
    """Quoted paragraphs attributed to the CEO — both orders of quote/attribution."""
    quotes: list[dict] = []
    seen: set[str] = set()

    patterns = [
        # "…quote…," said Jane Doe, Chairman and CEO of Acme.
        rf'["“]([^"”]{{40,900}})["”][,\s]*(?:said|added|commented)\s+([A-Z][\w.\- ]{{2,40}}),?\s*'
        rf'([^.]{{0,80}}?{_CEO_TITLES}[^.]{{0,60}})',
        # Jane Doe, CEO of Acme, said, "…quote…"
        rf'([A-Z][\w.\- ]{{2,40}}),\s*([^.]{{0,80}}?{_CEO_TITLES}[^.]{{0,60}}),?\s*'
        rf'(?:said|added|commented)[,:]?\s*["“]([^"”]{{40,900}})["”]',
    ]

    for idx, pattern in enumerate(patterns):
        for match in re.finditer(pattern, text, re.I):
            if idx == 0:
                quote, speaker, title = match.group(1), match.group(2), match.group(3)
            else:
                speaker, title, quote = match.group(1), match.group(2), match.group(3)
            key = quote[:60]
            if key in seen:
                continue
            seen.add(key)
            quotes.append({
                "speaker": speaker.strip(),
                "title": re.sub(r"\s+", " ", title).strip(" ,"),
                "quote": re.sub(r"\s+", " ", quote).strip(),
            })
            if len(quotes) >= limit:
                return quotes
    return quotes


# Strict headings first. A loose "outlook for Q4" also appears inside the CEO's
# quote, and anchoring there lands on the *reported* quarter's table instead of
# the forecast one.
_GUIDANCE_HEADINGS = [
    re.compile(r"(business outlook|financial outlook)", re.I),
    re.compile(r"(guidance for (?:the )?(?:first|second|third|fourth) quarter|"
               r"outlook for (?:the )?(?:first|second|third|fourth) quarter|"
               r"(?:first|second|third|fourth) quarter (?:of )?(?:fiscal )?\d{4} (?:guidance|outlook))", re.I),
    re.compile(r"\boutlook\b", re.I),
]

_METRIC_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("revenue", re.compile(r"revenue[^$%]{0,40}?(\$[\d.,]+\s*(?:billion|million|B|M)?(?:\s*[±\+\-]\s*\$?[\d.,]+\s*(?:billion|million|B|M)?)?)", re.I)),
    ("gross_margin", re.compile(r"gross margin[^%]{0,40}?((?:approximately\s*)?[\d.]+\s*%(?:\s*[±\+\-]\s*[\d.]+\s*%)?)", re.I)),
    ("operating_expenses", re.compile(r"operating expense[s]?[^$]{0,40}?(\$[\d.,]+\s*(?:billion|million|B|M)?)", re.I)),
    ("eps", re.compile(r"(?:diluted )?(?:earnings per share|EPS)[^$]{0,60}?(\$[\d.,]+(?:\s*[±\+\-]\s*\$?[\d.,]+)?)", re.I)),
    ("operating_margin", re.compile(r"operating margin[^%]{0,40}?((?:approximately\s*)?[\d.]+\s*%)", re.I)),
]


def _metrics_in(window: str) -> dict[str, str]:
    metrics: dict[str, str] = {}
    for name, pattern in _METRIC_PATTERNS:
        hit = pattern.search(window)
        if hit:
            metrics[name] = re.sub(r"\s+", " ", hit.group(1)).strip()
    return metrics


def _guidance(text: str) -> dict:
    """The forward numbers, pulled out of the outlook block of a press release."""
    for heading in _GUIDANCE_HEADINGS:
        best: dict = {}
        for match in heading.finditer(text):
            # Guidance arrives as an HTML table, so every cell landed on its own
            # line — flatten first or "Revenue\n$50.0 billion" never matches.
            window = re.sub(r"\s+", " ", text[match.start() : match.start() + 2_500])
            metrics = _metrics_in(window)
            if len(metrics) > len(best.get("metrics", {})):
                best = {
                    "heading": re.sub(r"\s+", " ", match.group(1)).strip(),
                    "metrics": metrics,
                    "excerpt": window[:700].strip(),
                }
        if best.get("metrics"):
            return best
    return {}


_FORWARD_CUE = re.compile(
    r"\b(we expect|we anticipate|we believe|we plan|we intend|we are targeting|"
    r"we will continue|guidance|outlook|in fiscal \d{4}|going forward)\b",
    re.I,
)


def _forward_statements(text: str, limit: int = 8) -> list[str]:
    """Forward-looking sentences from MD&A — the CEO's plan in the company's own words.

    The boilerplate "Forward-Looking Statements" safe-harbour paragraph is skipped:
    it's a legal disclaimer, not a view on the business.
    """
    body = re.sub(r"\s+", " ", text)
    sentences = re.split(r"(?<=[.!?])\s+", body)
    out: list[str] = []
    seen: set[str] = set()
    for sentence in sentences:
        if not (60 <= len(sentence) <= 420):
            continue
        if not _FORWARD_CUE.search(sentence):
            continue
        low = sentence.lower()
        if "forward-looking statement" in low or "safe harbor" in low or "risk factors" in low:
            continue
        if "actual results" in low and "differ materially" in low:
            continue
        # "guidance" in an MD&A usually means an accounting pronouncement, not an
        # outlook — those sentences say nothing about how the business will trade.
        if re.search(r"\b(asu|fasb|accounting standard|new guidance|this guidance|"
                     r"notes to consolidated|topic \d)", low):
            continue
        key = sentence[:60].lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(sentence.strip())
        if len(out) >= limit:
            break
    return out


# ── XBRL ──────────────────────────────────────────────────────────────────────

# First tag that a filer actually uses wins — issuers differ on revenue tagging.
_CONCEPTS: dict[str, list[str]] = {
    "revenue": [
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "Revenues",
        "SalesRevenueNet",
        "RevenueFromContractWithCustomerIncludingAssessedTax",
    ],
    "gross_profit": ["GrossProfit"],
    "operating_income": ["OperatingIncomeLoss"],
    "net_income": ["NetIncomeLoss"],
    "eps_diluted": ["EarningsPerShareDiluted"],
    "rnd": ["ResearchAndDevelopmentExpense"],
    "operating_cash_flow": ["NetCashProvidedByUsedInOperatingActivities"],
    "capex": ["PaymentsToAcquirePropertyPlantAndEquipment"],
}


def _concept_series(cik: str, tag: str) -> list[dict]:
    try:
        res = _SESSION.get(
            f"https://data.sec.gov/api/xbrl/companyconcept/CIK{cik}/us-gaap/{tag}.json",
            headers={"Host": "data.sec.gov"},
            timeout=_TIMEOUT,
        )
        if not res.ok:
            return []
        units = res.json().get("units", {})
    except Exception:
        return []

    values = units.get("USD") or units.get("USD/shares") or []
    rows: list[dict] = []
    for entry in values:
        if not entry.get("end") or entry.get("val") is None:
            continue
        rows.append({
            "start": entry.get("start", ""),
            "end": entry["end"],
            "val": entry["val"],
            "form": entry.get("form", ""),
            "fy": entry.get("fy"),
            "fp": entry.get("fp"),
            "filed": entry.get("filed", ""),
        })
    return rows


def _period_months(row: dict) -> int | None:
    """Length of the reporting window, so a quarter isn't confused with a YTD figure."""
    if not row.get("start"):
        return None
    try:
        import datetime as _dt

        start = _dt.date.fromisoformat(row["start"])
        end = _dt.date.fromisoformat(row["end"])
        return round((end - start).days / 30.4)
    except Exception:
        return None


# ── Endpoints ─────────────────────────────────────────────────────────────────

def _require_cik(symbol: str) -> str:
    sym = symbol.upper()
    if not _US_TICKER.match(sym):
        raise HTTPException(
            status_code=404,
            detail=f"{sym} is not a US listing — EDGAR has no filings for it "
                   f"(Thai issuers: use /api/sec/... instead)",
        )
    cik = _cik_for(sym)
    if not cik:
        raise HTTPException(status_code=404, detail=f"No EDGAR CIK for {sym}")
    return cik


@router.get("/api/company/filings/{symbol}")
def company_filings(
    symbol: str,
    forms: str = Query(default="10-K,10-Q,8-K", description="Comma-separated form types, or 'all'"),
    limit: int = Query(default=20, ge=1, le=100),
):
    """Recent EDGAR filings, newest first."""
    cik = _require_cik(symbol)
    rows = _recent_filings(cik, limit=200)
    if forms != "all":
        wanted = {f.strip().upper() for f in forms.split(",") if f.strip()}
        rows = [r for r in rows if r["form"].upper() in wanted]
    return {"symbol": symbol.upper(), "cik": cik, "filings": rows[:limit]}


@router.get("/api/company/outlook/{symbol}")
def company_outlook(symbol: str):
    """Forward guidance + the CEO's own words, from the latest earnings 8-K and MD&A."""
    cik = _require_cik(symbol)
    sym = symbol.upper()
    cached = _outlook_cache.get(sym)
    if cached is not None:
        return cached

    rows = _recent_filings(cik, limit=200)

    # 1 — latest earnings 8-K (item 2.02 = results of operations)
    release: dict = {}
    for row in rows:
        if row["form"].upper() != "8-K":
            continue
        if "2.02" not in (row["items"] or ""):
            continue

        # Pick whichever exhibit in the folder actually reads like the release —
        # filers name it anything from ex991.htm to q1fy27pr.htm.
        best_url, best_text, best_score = "", "", 0
        for url in _release_candidates(cik, row["folder"], row["document"]):
            text = _fetch_doc(url)
            if not text:
                continue
            score = _release_score(text)
            if score > best_score:
                best_url, best_text, best_score = url, text, score
            if score >= 8:
                break
        if not best_text:
            continue

        release = {
            "filed": row["filed"],
            "period": row["period"],
            "url": best_url,
            "index_url": row["index_url"],
            "guidance": _guidance(best_text),
            "ceo_quotes": _ceo_quotes(best_text),
        }
        break

    # 2 — latest periodic report for MD&A forward-looking language
    mdna: dict = {}
    for row in rows:
        if row["form"].upper() not in ("10-Q", "10-K"):
            continue
        text = _fetch_doc(row["url"])
        if not text:
            continue
        mdna = {
            "form": row["form"],
            "filed": row["filed"],
            "period": row["period"],
            "url": row["url"],
            "statements": _forward_statements(text),
        }
        break

    data = {
        "symbol": sym,
        "cik": cik,
        "release": release,
        "mdna": mdna,
        "has_guidance": bool(release.get("guidance", {}).get("metrics")),
    }
    _outlook_cache.set(sym, data)
    return data


@router.get("/api/company/xbrl/{symbol}")
def company_xbrl(
    symbol: str,
    period: str = Query(default="quarterly", pattern="^(quarterly|annual)$"),
    limit: int = Query(default=12, ge=1, le=40),
):
    """As-reported figures from XBRL company facts, tagged by period and form."""
    cik = _require_cik(symbol)
    sym = symbol.upper()
    cache_key = f"{sym}:{period}:{limit}"
    cached = _xbrl_cache.get(cache_key)
    if cached is not None:
        return cached

    want_months = (2, 4) if period == "quarterly" else (11, 13)
    series: dict[str, list[dict]] = {}
    tags_used: dict[str, str] = {}

    for metric, tags in _CONCEPTS.items():
        for tag in tags:
            rows = _concept_series(cik, tag)
            if not rows:
                continue
            if metric == "eps_diluted":
                # Per-share values carry no start date on some filers; keep them all.
                kept = rows
            else:
                kept = [
                    r
                    for r in rows
                    if (months := _period_months(r)) is not None
                    and want_months[0] <= months <= want_months[1]
                ]
            if not kept:
                continue
            # One row per period end — the latest filing restates the earliest ones.
            by_end: dict[str, dict] = {}
            for row in sorted(kept, key=lambda r: (r["end"], r.get("filed", ""))):
                by_end[row["end"]] = row
            series[metric] = sorted(by_end.values(), key=lambda r: r["end"], reverse=True)[:limit]
            tags_used[metric] = tag
            break

    # Margins are derived, not filed — compute them where both legs line up.
    revenue_by_end = {r["end"]: r["val"] for r in series.get("revenue", [])}
    for derived, source in (("gross_margin", "gross_profit"), ("operating_margin", "operating_income")):
        rows = series.get(source, [])
        out: list[dict] = []
        for row in rows:
            rev = revenue_by_end.get(row["end"])
            if not rev:
                continue
            out.append({
                "end": row["end"],
                "start": row.get("start", ""),
                "val": round(row["val"] / rev * 100, 2),
                "form": row.get("form", ""),
                "fy": row.get("fy"),
                "fp": row.get("fp"),
            })
        if out:
            series[derived] = out

    data = {
        "symbol": sym,
        "cik": cik,
        "period": period,
        "tags": tags_used,
        "series": series,
    }
    _xbrl_cache.set(cache_key, data)
    return data
