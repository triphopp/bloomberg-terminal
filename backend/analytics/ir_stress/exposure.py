"""
Firm-level rate exposure: debt stack, maturity ladder, effective coupon.

Two sources, deliberately split by what each is good for:
  - yfinance balance sheet / income statement for the current debt, cash, interest
    expense and EBIT. Five annual columns, restated, no filing date — fine live,
    useless for a backtest.
  - SEC XBRL for the maturity ladder, which yfinance does not carry at all.

The ladder is the part that breaks. Probed across 43 S&P names on 2026-08-31,
only 24 had a ladder summing to >=70% of total debt: issuers stop using a tag and
the API keeps serving the last year they did (Realty Income's newest
`NextTwelveMonths` fact is dated 2017), or they file only some buckets. So the
completeness ratio is computed and gated rather than trusted, and every field carries
its source.

Floating share is not recoverable here. `DebtInstrumentBasisSpreadOnVariableRate1`
404s on AT&T, a company with $155B of debt, so callers get a bound over
phi in [0, 1] instead of a point estimate.
"""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from cache import TTLCache

_cache = TTLCache(ttl=21600, maxsize=256)  # 6h: filings move quarterly at most
_TIMEOUT = 20

_LADDER_TAGS: list[tuple[str, list[str]]] = [
    ("y1", ["LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths",
            "LongTermDebtMaturitiesRepaymentsOfPrincipalInNextRollingTwelveMonths"]),
    ("y2", ["LongTermDebtMaturitiesRepaymentsOfPrincipalInYearTwo",
            "LongTermDebtMaturitiesRepaymentsOfPrincipalInRollingYearTwo"]),
    ("y3", ["LongTermDebtMaturitiesRepaymentsOfPrincipalInYearThree",
            "LongTermDebtMaturitiesRepaymentsOfPrincipalInRollingYearThree"]),
    ("y4", ["LongTermDebtMaturitiesRepaymentsOfPrincipalInYearFour",
            "LongTermDebtMaturitiesRepaymentsOfPrincipalInRollingYearFour"]),
    ("y5", ["LongTermDebtMaturitiesRepaymentsOfPrincipalInYearFive",
            "LongTermDebtMaturitiesRepaymentsOfPrincipalInRollingYearFive"]),
    ("beyond", ["LongTermDebtMaturitiesRepaymentsOfPrincipalAfterYearFive",
                "LongTermDebtMaturitiesRepaymentsOfPrincipalAfterRollingYearFive"]),
]

LADDER_COMPLETENESS_GATE = 0.70

# Deposit rates do not follow the policy rate one-for-one, and part of a
# corporate cash pile sits in operating accounts paying nothing.
CASH_PASSTHROUGH = 0.70


def _sec_get(url: str) -> dict | None:
    """One EDGAR call through the session that already gets past the UA check.

    `company_filings` owns that session: a parenthesised comment in the
    User-Agent string earns a 403, which is easy to reintroduce by writing a
    second one here.
    """
    from routers.company_filings import _SESSION

    try:
        r = _SESSION.get(url, headers={"Host": "data.sec.gov"}, timeout=_TIMEOUT)
        time.sleep(0.11)  # SEC asks for <=10 req/s
        if not r.ok:
            return None
        return r.json()
    except Exception as exc:  # noqa: BLE001
        print(f"[ir_stress.exposure] {url}: {exc}")
        return None


def _cik_for(symbol: str) -> str | None:
    from routers.company_filings import _cik_for as _lookup

    return _lookup(symbol)


def _latest_instant(cik: str, tags: list[str]) -> dict | None:
    """Newest point-in-time fact across a tag waterfall.

    Picks by (end, filed) so a restatement of the same period wins over the
    original, and returns which tag supplied it — an issuer that migrated tags
    mid-history is otherwise invisible.
    """
    for tag in tags:
        payload = _sec_get(
            f"https://data.sec.gov/api/xbrl/companyconcept/CIK{cik}/us-gaap/{tag}.json"
        )
        if not payload:
            continue
        rows = payload.get("units", {}).get("USD", [])
        # A balance-sheet item has no start date; a flow does. Ladder buckets and
        # debt balances are the former.
        instants = [r for r in rows if not r.get("start")] or rows
        if not instants:
            continue
        best = max(instants, key=lambda r: (r["end"], r.get("filed", "")))
        return {
            "value": float(best["val"]),
            "end": best["end"],
            "filed": best.get("filed"),
            "tag": tag,
            "form": best.get("form"),
        }
    return None


def _safe(df: Any, row: str, col: int = 0) -> float | None:
    try:
        v = df.loc[row].iloc[col]
        return float(v) if v == v else None  # NaN check without importing numpy
    except Exception:  # noqa: BLE001
        return None


def get_exposure(symbol: str) -> dict:
    """Debt stack, ladder and effective coupon for one US-listed issuer."""
    sym = symbol.upper()
    cached = _cache.get(f"exposure:{sym}")
    if cached is not None:
        return cached

    from routers import market as _market  # local: avoids an import cycle at boot

    ticker = _market.market_data.get_ticker(sym)
    bs = ticker.balance_sheet
    inc = ticker.income_stmt

    # An ADR ticker looks American, passes every symbol check and can even carry an
    # SEC registrant number, but yfinance hands back the statements in the issuer's
    # own currency. SK hynix read as dollars reports operating profit of 51 trillion.
    # `financialCurrency` says so directly, but `info` is the flakiest call yfinance
    # makes and returns nothing once Yahoo starts rate-limiting, so the magnitude of
    # the statements is the fallback — that one cannot be rate-limited away.
    try:
        reporting_ccy = (ticker.info or {}).get("financialCurrency")
    except Exception:  # noqa: BLE001
        reporting_ccy = None

    debt = _safe(bs, "Total Debt")
    debt_prev = _safe(bs, "Total Debt", 1)
    cash = _safe(bs, "Cash And Cash Equivalents") or 0.0
    current_debt = _safe(bs, "Current Debt")
    lt_debt = _safe(bs, "Long Term Debt")
    leases = _safe(bs, "Capital Lease Obligations")

    interest = _safe(inc, "Interest Expense")
    ebit = _safe(inc, "EBIT")
    tax = _safe(inc, "Tax Provision")
    pretax = _safe(inc, "Pretax Income")

    # Marginal tax rate drives the after-tax cost of the interest shock. The
    # effective rate is a poor proxy but the only one available per issuer, and a
    # loss-making year makes it meaningless, so it is floored at zero and capped.
    tax_rate = None
    if tax is not None and pretax and pretax > 0:
        tax_rate = max(0.0, min(0.35, tax / pretax))

    # ── Maturity ladder from EDGAR ────────────────────────────────────────────
    cik = _cik_for(sym)
    ladder: dict[str, dict | None] = {}
    if cik:
        # Six buckets, each possibly two tags, each a round trip to EDGAR with a
        # rate-limit pause: serially that is most of the time a cold call takes.
        # SEC allows ten requests a second, so four at once stays well inside it.
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = pool.map(lambda bt: (bt[0], _latest_instant(cik, bt[1])), _LADDER_TAGS)
            ladder = dict(results)

    ladder_values = [v["value"] for v in ladder.values() if v]
    ladder_total = sum(ladder_values) if ladder_values else None
    # How much of the debt stack the filed maturity buckets actually account for.
    # Called completeness and not coverage on purpose: this same screen shows
    # interest coverage, and the two mean opposite kinds of thing — one is a
    # data-quality ratio, the other is the firm's ability to pay its interest.
    completeness = (ladder_total / debt) if (ladder_total and debt) else None
    ladder_as_of = max((v["end"] for v in ladder.values() if v), default=None)

    # An issuer that stopped filing the tag years ago still returns a value; the
    # only signal that it is stale is the fact's own period end.
    stale = bool(ladder_as_of and ladder_as_of < "2024-01-01")

    wall_12m = ladder.get("y1", {}).get("value") if ladder.get("y1") else None
    wall_3y = sum(
        ladder[b]["value"] for b in ("y1", "y2", "y3") if ladder.get(b)
    ) or None

    # ── Effective coupon ──────────────────────────────────────────────────────
    r_eff = None
    if interest and debt and debt_prev and (debt + debt_prev) > 0:
        r_eff = interest / ((debt + debt_prev) / 2)

    from analytics.ir_stress import curve as _curve

    crv = _curve.get_curve()
    refi_rate = crv.get("refi_rate")
    refi_gap = (refi_rate - r_eff) if (refi_rate is not None and r_eff is not None) else None

    # No company has ever earned a trillion dollars of operating profit in a year;
    # the largest on record is under two hundred billion. Past this line the figure
    # is a currency, not a business.
    implausible_usd = 1e12
    magnitude_is_foreign = bool(
        (ebit is not None and abs(ebit) > implausible_usd)
        or (interest is not None and abs(interest) > implausible_usd)
    )
    usd_reported = (reporting_ccy == "USD") if reporting_ccy else not magnitude_is_foreign

    data = {
        "symbol": sym,
        "cik": cik,
        "reporting_currency": reporting_ccy,
        "usd_reported": usd_reported,
        "currency_check": "financialCurrency" if reporting_ccy else "statement magnitude",
        "debt": {
            "total": debt,
            "current": current_debt,
            "long_term": lt_debt,
            "capital_leases": leases,
            "cash": cash,
            "net_debt": (debt - cash) if debt is not None else None,
            "source": "yfinance balance_sheet",
        },
        "income": {
            "interest_expense": interest,
            "ebit": ebit,
            "icr": (ebit / interest) if (ebit and interest and interest > 0) else None,
            "tax_rate": tax_rate,
            "source": "yfinance income_stmt",
        },
        "ladder": {
            bucket: (
                {"value": v["value"], "tag": v["tag"], "end": v["end"], "filed": v["filed"]}
                if v
                else None
            )
            for bucket, v in ladder.items()
        },
        "ladder_total": ladder_total,
        "ladder_completeness": completeness,
        "ladder_as_of": ladder_as_of,
        "ladder_stale": stale,
        "ladder_usable": bool(completeness and completeness >= LADDER_COMPLETENESS_GATE and not stale),
        "wall_12m": wall_12m,
        "wall_3y": wall_3y,
        "cost": {
            "r_eff": r_eff,
            "market_refi_rate": refi_rate,
            "refi_gap": refi_gap,
            "refi_gap_bp": round(refi_gap * 10000, 1) if refi_gap is not None else None,
            # Even with no shock at all, rolling the 12-month wall at today's
            # market rate costs this much more per year than the old coupon.
            "wall_12m_repricing_cost": (
                wall_12m * refi_gap if (wall_12m and refi_gap and refi_gap > 0) else None
            ),
        },
        "floating_share": {
            "value": None,
            "source": "unavailable",
            "note": (
                "XBRL variable-rate tags are absent for most issuers and hedges are "
                "never in the concept API. Results are bounded over phi in [0,1] and "
                "are pre-hedge."
            ),
        },
        "confidence": _confidence(
            completeness, stale, interest, ebit, usd_reported, cik, debt,
            usable=bool(completeness and completeness >= LADDER_COMPLETENESS_GATE and not stale),
        ),
    }
    _cache.set(f"exposure:{sym}", data)
    return data


def _confidence(completeness, stale, interest, ebit, usd_reported, cik, debt, usable: bool) -> dict:
    """What the caller is allowed to conclude, and why."""
    missing = []
    if not cik:
        missing.append("no_edgar_cik")
    if not usd_reported:
        missing.append("statements_not_in_usd")
    if debt is None:
        missing.append("total_debt")
    if interest is None or interest == 0:
        missing.append("interest_expense")
    if ebit is None:
        missing.append("ebit")
    if completeness is None:
        missing.append("maturity_ladder")
    elif completeness < LADDER_COMPLETENESS_GATE:
        missing.append(f"ladder_covers_only_{completeness:.0%}_of_debt")
    if stale:
        missing.append("ladder_stale")

    # The bound only needs total debt, cash, interest and EBIT — it survives a
    # broken ladder, which is why it is the tier that ships first.
    # No CIK means no SEC registrant behind the ticker, which in practice means a
    # foreign listing whose statements yfinance reports in its own currency. The
    # currency field says so too, but only while Yahoo is answering — `info` comes
    # back empty under rate limiting, and an absent CIK cannot be rate-limited away.
    bound_ok = (
        bool(cik)
        and debt is not None
        and interest not in (None, 0)
        and ebit is not None
        and usd_reported
    )
    return {
        "level": "high" if (bound_ok and not missing) else ("medium" if bound_ok else "low"),
        "bounded_assessment_available": bound_ok,
        "refi_term_available": usable,
        "missing": missing,
        "always_missing": ["hedges_swaps", "issuer_credit_spread", "fixed_floating_split"],
    }
