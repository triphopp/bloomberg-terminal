"""Where the US economy stands in the business cycle — read off official
indicators, each by the definition its publisher gives.

Nothing here is a model of ours. Every reading is a published series held
against a published line, and the payload carries the wording and the source so
the screen can show both:

  NBER recession dates          a significant decline in activity, spread across the economy, lasting
                                more than a few months; announced 4-21 months late (NBER dating FAQ)
  Sahm rule                     3-month average U3 >= 0.50pp above its low of the previous 12 months
                                (FRED SAHMREALTIME notes)
  Smoothed recession prob.      3 straight months above 80% = recession started; 3 straight below 20% =
                                new expansion (Chauvet & Piger 2008; jeremypiger.com/recession_probs_faq)
  CFNAI-MA3 / Diffusion         contractions associated with MA3 below -0.70 and Diffusion below -0.35;
                                MA3 above +0.70 (+1.00) more than two years into an expansion = increasing
                                (substantial) likelihood of sustained increasing inflation (Chicago Fed)
  GDP-based recession index     above 67% = entered recession; then below 33% = over (FRED JHGDPBRINDX notes)
  Yield-curve probit            P(recession in month t+12) = N(-0.6045 - 0.7374 x spread), spread = monthly
                                average 10Y constant maturity minus 3M bill on a bond-equivalent basis
                                (Estrella & Trubin 2006, NY Fed Current Issues 12-5)
  OECD CLI                      above / below 100 and rising / falling -> expansion, downturn, slowdown,
                                recovery; leads the GDP gap's turning points by 6-9 months (OECD 2020)
  Output and unemployment gap   real GDP against CBO potential; U3 against CBO's noncyclical rate
  Inflation goal                2 percent, annual change in the PCE price index (FOMC Statement on
                                Longer-Run Goals, reaffirmed 2026-01-27)
  Policy rate                   against the FOMC's own longer-run median (SEP) and against Taylor (1993):
                                r = p + .5y + .5(p - 2) + 2
  NFCI                          positive = financial conditions tighter than average (Chicago Fed)

There is deliberately no composite score and no invented phase: the NBER names
two states, the OECD four, and nothing else on this page is called a phase.
The track record of each recession rule is counted from the same history and
reported beside it — with the months a reading takes to be published, because
a rule that is right about March is only useful from the day March is printed.

Pure: series in, payload out. routers/cycle.py does the fetching.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd

SAHM_LINE = 0.50
CP_START, CP_END, CP_RUN = 80.0, 20.0, 3
CFNAI_MA3_CONTRACTION = -0.70
CFNAI_DIFFUSION_CONTRACTION = -0.35
CFNAI_INFLATION, CFNAI_INFLATION_SUBSTANTIAL = 0.70, 1.00
CFNAI_INFLATION_MIN_MONTHS = 24
HAMILTON_START, HAMILTON_END = 67.0, 33.0
PROBIT_ALPHA, PROBIT_BETA = -0.6045, -0.7374
INFLATION_GOAL = 2.0
CLI_TREND = 100.0

#: Months between the month a reading describes and the day it can be read.
PUBLISHED_AFTER = {"sahm": 1, "chauvet_piger": 2, "cfnai_ma3": 1, "hamilton": 4, "yield_curve": 0}
#: A rule that fires within this many months before a recession starts is counted as catching it.
COINCIDENT_WINDOW = 6
LEADING_WINDOW = 24
#: Two runs of a rule no further apart than this are one signal.
MERGE_GAP = 3
MARKET_HORIZON = 12

RECESSION_RULES = ("sahm", "chauvet_piger", "cfnai_ma3", "hamilton")

FRED_SERIES = (
    "USREC", "SAHMREALTIME", "RECPROUSM156N", "CFNAIMA3", "CFNAIDIFF", "JHGDPBRINDX",
    "GS10", "TB3MS", "USALOLITOAASTSAM", "GDPC1", "GDPPOT", "GDPDEF", "UNRATE", "NROU",
    "PCEPI", "PCEPILFE", "DFEDTARU", "DFEDTARL", "FEDTARMDLR", "NFCI", "ANFCI",
)


def _url(series_id: str) -> str:
    return f"https://fred.stlouisfed.org/series/{series_id}"


# ── Series helpers ────────────────────────────────────────────────────────────

def monthly(s: pd.Series | None) -> pd.Series:
    if s is None or len(s) == 0:
        return pd.Series(dtype=float)
    s = s.dropna().sort_index()
    return s.set_axis(s.index.to_period("M"))


def quarterly(s: pd.Series | None) -> pd.Series:
    if s is None or len(s) == 0:
        return pd.Series(dtype=float)
    s = s.dropna().sort_index()
    return s.set_axis(s.index.to_period("Q"))


def bond_equivalent(discount: pd.Series) -> pd.Series:
    """3-month bill, discount basis -> bond-equivalent yield (Estrella & Trubin, note 4)."""
    return 100.0 * (365.0 * discount / 100.0) / (360.0 - 91.0 * discount / 100.0)


def recession_probability(spread: pd.Series | float):
    """Probability of an NBER recession twelve months ahead from the term spread."""
    z = PROBIT_ALPHA + PROBIT_BETA * spread
    cdf = lambda x: 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))  # noqa: E731
    return z.map(cdf) if isinstance(z, pd.Series) else cdf(z)


def hysteresis(values: pd.Series, start_above: float, end_below: float, run: int = 1) -> pd.Series:
    """On after `run` readings above `start_above`; off after `run` below `end_below`."""
    on, above, below, out = False, 0, 0, []
    for v in values.to_numpy():
        above = above + 1 if v > start_above else 0
        below = below + 1 if v < end_below else 0
        if not on and above >= run:
            on = True
        elif on and below >= run:
            on = False
        out.append(on)
    return pd.Series(out, index=values.index, dtype=bool)


def runs(on: pd.Series) -> list[tuple[pd.Period, pd.Period]]:
    """[first, last] period of every unbroken stretch where `on` is true."""
    out, start, prev = [], None, None
    for period, flag in on.items():
        if flag and start is None:
            start = period
        if not flag and start is not None:
            out.append((start, prev))
            start = None
        prev = period
    if start is not None:
        out.append((start, prev))
    return out


def merge_runs(spans: list[tuple[pd.Period, pd.Period]], gap: int) -> list[tuple[pd.Period, pd.Period]]:
    out: list[tuple[pd.Period, pd.Period]] = []
    for start, end in spans:
        if out and (start - out[-1][1]).n <= gap:
            out[-1] = (out[-1][0], end)
        else:
            out.append((start, end))
    return out


def since(on: pd.Series) -> pd.Period | None:
    """First period of the stretch the latest reading belongs to."""
    if on.empty:
        return None
    flips = on.ne(on.shift())
    return flips[flips].index[-1]


# ── Track record ──────────────────────────────────────────────────────────────

def track_record(on: pd.Series, recession: pd.Series, window: int, merge_gap: int = MERGE_GAP) -> dict:
    """How a rule's past signals line up with NBER recessions, in the months they describe.

    A signal catches a recession when the recession is under way at the signal
    or starts within `window` months after it; with none it is a false signal,
    unless `window` months have not passed yet. `lead` is recession start minus
    signal month: positive = the rule fired first. A recession counts against
    the rule only if the rule had `window` months of history before it, and a
    signal already on when the series begins has no start date, so it is left out.
    """
    on = on[on.index >= recession.index[0]]
    first, last = on.index[0], on.index[-1]
    slumps = runs(recession[(recession.index >= first) & (recession.index <= last)] > 0)
    judged = [s for s in slumps if (s[0] - first).n >= window]
    episodes = [e for e in merge_runs(runs(on), merge_gap) if e[0] != first]
    caught: dict[pd.Period, int] = {}
    false_signals: list[str] = []
    undecided = 0
    for start, _end in episodes:
        match = next((s for s in slumps if s[1] >= start and s[0] <= start + window), None)
        if match is None:
            if (last - start).n > window:
                false_signals.append(str(start))
            else:
                undecided += 1          # the window has not run out yet
        elif match[0] not in caught:
            caught[match[0]] = (match[0] - start).n
    leads = [caught[s[0]] for s in judged if s[0] in caught]
    return {
        "from": str(first), "to": str(last), "window": window, "merge_gap": merge_gap,
        "signals": len(episodes), "false": len(false_signals), "false_dates": false_signals,
        "undecided": undecided,
        "recessions": len(judged), "caught": len(leads), "missed": len(judged) - len(leads),
        "missed_dates": [str(s[0]) for s in judged if s[0] not in caught],
        "median_lead": float(np.median(leads)) if leads else None, "leads": leads,
        "onsets": [str(s) for s, _ in episodes],
    }


def market_after(onsets: list[str], sp500: pd.Series, published_after: int,
                 horizon: int = MARKET_HORIZON) -> dict | None:
    """S&P 500 over the `horizon` months after each signal could first be read (month-end closes)."""
    if sp500 is None or sp500.empty:
        return None

    def path(start: pd.Period) -> tuple[float, float] | None:
        if start not in sp500.index or start + horizon not in sp500.index:
            return None
        leg = sp500.loc[start:start + horizon] / sp500.loc[start]
        return float(leg.iloc[-1] - 1.0), float(leg.min() - 1.0)

    rows = [path(pd.Period(o, "M") + published_after) for o in onsets]
    rows = [r for r in rows if r is not None]
    if not rows:
        return None
    first = pd.Period(onsets[0], "M")
    every = [path(p) for p in sp500.index[sp500.index >= first]]
    every = [r for r in every if r is not None]
    fwd, low = [r[0] for r in rows], [r[1] for r in rows]
    return {
        "n": len(rows), "horizon": horizon, "published_after": published_after,
        "median_return": float(np.median(fwd)), "worst_return": float(min(fwd)),
        "best_return": float(max(fwd)), "up_share": float(np.mean([f > 0 for f in fwd])),
        "median_low": float(np.median(low)), "worst_low": float(min(low)),
        "all_months_median_return": float(np.median([r[0] for r in every])) if every else None,
        "all_months_median_low": float(np.median([r[1] for r in every])) if every else None,
    }


# ── Indicators ────────────────────────────────────────────────────────────────

def _missing(ind_id: str, label: str, series: str, rule: str, source: str) -> dict:
    return {"id": ind_id, "label": label, "state": None, "tone": "unknown", "value": None,
            "detail": "NO DATA", "rule": rule, "source": source, "url": _url(series), "series": series}


def _rule_indicator(ind_id: str, label: str, series: str, values: pd.Series, on: pd.Series, *, unit: str,
                    line: str, rule: str, source: str, revised: bool, recession: pd.Series,
                    sp500: pd.Series | None, monthly_on: pd.Series | None = None,
                    window: int = COINCIDENT_WINDOW,
                    on_label: str = "RECESSION SIGNAL", off_label: str = "NO SIGNAL") -> dict:
    lag = PUBLISHED_AFTER.get(ind_id, 0)
    flag = bool(on.iloc[-1])
    out = {
        "id": ind_id, "label": label, "series": series, "url": _url(series),
        "value": float(values.iloc[-1]), "unit": unit, "as_of": str(values.index[-1]),
        "state": on_label if flag else off_label, "on": flag, "tone": "bad" if flag else "good",
        "since": str(since(on)), "line": line, "rule": rule, "source": source,
        "revised": revised, "published_after_months": lag,
        "history": [{"date": str(p), "value": round(float(v), 3)} for p, v in values.iloc[-36:].items()],
    }
    if not recession.empty:
        record = track_record(monthly_on if monthly_on is not None else on, recession, window)
        out["track"] = record
        out["market"] = market_after(record["onsets"], sp500, lag) if sp500 is not None else None
    return out


def _quarter_to_months(on: pd.Series) -> pd.Series:
    """A quarterly flag as a monthly one, dated at each quarter's last month onward."""
    rows = {}
    for quarter, flag in on.items():
        last = quarter.asfreq("M", how="end")
        for step in range(3):
            rows[last + step] = bool(flag)
    return pd.Series(rows, dtype=bool).sort_index()


def build(series: dict[str, pd.Series], sp500: pd.Series | None = None,
          trend: dict | None = None) -> dict[str, Any]:
    """The whole reading from whatever series arrived; a missing one costs only its own row."""
    get = series.get
    rec = monthly(get("USREC"))
    sp = sp500 if sp500 is not None and not sp500.empty else None
    missing = [sid for sid in FRED_SERIES if get(sid) is None or len(get(sid)) == 0]

    # ── Is a recession under way? ────────────────────────────────────────────
    now: list[dict] = []
    months_in_expansion = None
    if rec.empty:
        now.append(_missing("nber", "NBER", "USREC", "peak to trough = recession", "NBER Business Cycle Dating Committee"))
    else:
        in_recession = bool(rec.iloc[-1] > 0)
        slumps = runs(rec > 0)
        if not in_recession and slumps:
            months_in_expansion = (rec.index[-1] - slumps[-1][1]).n
        now.append({
            "id": "nber", "label": "NBER", "series": "USREC", "url": "https://www.nber.org/research/business-cycle-dating",
            "value": float(rec.iloc[-1]), "unit": "", "as_of": str(rec.index[-1]), "on": in_recession,
            "state": "RECESSION" if in_recession else "NO RECESSION DECLARED",
            "tone": "bad" if in_recession else "good", "since": str(since(rec > 0)),
            "line": "peak → trough",
            "rule": "A recession is a significant decline in economic activity that is spread across the economy "
                    "and lasts more than a few months; the months from peak to trough.",
            "source": "NBER Business Cycle Dating Committee",
            "detail": (f"last trough {slumps[-1][1]}" if slumps else "") +
                      (f" · {months_in_expansion} months since" if months_in_expansion is not None else ""),
            "caveat": "NBER announces a turning point 4–21 months after it happens, so this row reads 0 "
                      "through the first months of every recession.",
            "official": True,
        })

    sahm = monthly(get("SAHMREALTIME"))
    if sahm.empty:
        now.append(_missing("sahm", "SAHM RULE", "SAHMREALTIME", f"≥ {SAHM_LINE:.2f}pp", "Sahm (2019) · FRED"))
    else:
        now.append(_rule_indicator(
            "sahm", "SAHM RULE", "SAHMREALTIME", sahm, sahm >= SAHM_LINE, unit="pp", line=f"≥ {SAHM_LINE:.2f}",
            rule="Signals the start of a recession when the three-month moving average of the unemployment rate (U3) "
                 "rises by 0.50 percentage points or more relative to the minimum of the three-month averages from "
                 "the previous 12 months.",
            source="Sahm (2019) · FRED real-time series", revised=False, recession=rec, sp500=sp))

    cp = monthly(get("RECPROUSM156N"))
    if cp.empty:
        now.append(_missing("chauvet_piger", "RECESSION PROBABILITY", "RECPROUSM156N", "3 months > 80%", "Chauvet & Piger (2008)"))
    else:
        now.append(_rule_indicator(
            "chauvet_piger", "RECESSION PROBABILITY", "RECPROUSM156N", cp, hysteresis(cp, CP_START, CP_END, CP_RUN),
            unit="%", line=f"3 months > {CP_START:.0f}%",
            rule="Three consecutive months of smoothed probabilities above 80% has been a reliable signal of the start "
                 "of a new recession; three consecutive months below 20%, of the start of a new expansion. From a "
                 "dynamic-factor Markov-switching model of payrolls, industrial production, real income ex transfers "
                 "and real manufacturing and trade sales.",
            source="Chauvet & Piger (2008) · FRED", revised=True, recession=rec, sp500=sp))

    ma3, diff = monthly(get("CFNAIMA3")), monthly(get("CFNAIDIFF"))
    if ma3.empty:
        now.append(_missing("cfnai_ma3", "CFNAI-MA3", "CFNAIMA3", f"< {CFNAI_MA3_CONTRACTION:.2f}", "Chicago Fed"))
    else:
        row = _rule_indicator(
            "cfnai_ma3", "CFNAI-MA3", "CFNAIMA3", ma3, ma3 < CFNAI_MA3_CONTRACTION, unit="", line=f"< {CFNAI_MA3_CONTRACTION:.2f}",
            rule="Periods of economic contraction have historically been associated with values of the CFNAI-MA3 below "
                 "−0.70. The index is a weighted average of 85 monthly indicators; zero = growth at its historical trend.",
            source="Federal Reserve Bank of Chicago", revised=True, recession=rec, sp500=sp,
            on_label="CONTRACTION RANGE", off_label="EXPANSION RANGE")
        if not diff.empty:
            row["companion"] = {
                "label": "Diffusion", "series": "CFNAIDIFF", "value": float(diff.iloc[-1]), "as_of": str(diff.index[-1]),
                "line": f"< {CFNAI_DIFFUSION_CONTRACTION:.2f}", "on": bool(diff.iloc[-1] < CFNAI_DIFFUSION_CONTRACTION)}
        now.append(row)

    ham = quarterly(get("JHGDPBRINDX"))
    if ham.empty:
        now.append(_missing("hamilton", "GDP-BASED INDEX", "JHGDPBRINDX", f"> {HAMILTON_START:.0f}%", "Hamilton · FRED"))
    else:
        ham_on = hysteresis(ham, HAMILTON_START, HAMILTON_END)
        now.append(_rule_indicator(
            "hamilton", "GDP-BASED INDEX", "JHGDPBRINDX", ham, ham_on, unit="%", line=f"> {HAMILTON_START:.0f}%",
            rule="If the index rises above 67% that is a historically reliable indicator that the economy has entered "
                 "a recession; once passed, a fall below 33% indicates the recession is over. Calculated for the "
                 "quarter before the latest GDP release and never revised.",
            source="Chauvet & Hamilton · FRED", revised=False, recession=rec, sp500=sp,
            monthly_on=_quarter_to_months(ham_on)))

    # ── Is one coming? ───────────────────────────────────────────────────────
    ahead: list[dict] = []
    gs10, bill = monthly(get("GS10")), monthly(get("TB3MS"))
    if gs10.empty or bill.empty:
        ahead.append(_missing("yield_curve", "YIELD CURVE 10Y−3M", "GS10", "monthly average < 0", "Estrella & Trubin (2006)"))
    else:
        spread = (gs10 - bond_equivalent(bill)).dropna()
        prob = recession_probability(spread) * 100.0
        row = _rule_indicator(
            "yield_curve", "YIELD CURVE 10Y−3M", "GS10", spread, spread < 0, unit="pp", line="monthly average < 0",
            rule="Spread = monthly average 10-year constant-maturity Treasury minus the 3-month bill on a "
                 "bond-equivalent basis. Probability of recession twelve months ahead = N(−0.6045 − 0.7374 × spread). "
                 "The monthly-average spread turned negative before each recession from 1968 to 2006.",
            source="Estrella & Trubin (2006), NY Fed Current Issues 12-5", revised=False, recession=rec, sp500=sp,
            window=LEADING_WINDOW, on_label="INVERTED", off_label="NOT INVERTED")
        row["url"] = "https://www.newyorkfed.org/research/capital_markets/ycfaq"
        row["probability_12m"] = float(prob.iloc[-1])
        row["probability_history"] = [{"date": str(p), "value": round(float(v), 1)} for p, v in prob.iloc[-36:].items()]
        row["caveat"] = ("Coefficients are the 1959–2005 estimates printed in the paper; the NY Fed's own page "
                         "re-estimates them, so its figure can differ by a few points.")
        ahead.append(row)

    cli = monthly(get("USALOLITOAASTSAM"))
    if len(cli) < 2:
        ahead.append(_missing("oecd_cli", "OECD CLI", "USALOLITOAASTSAM", "level vs 100, direction", "OECD"))
    else:
        level, change = float(cli.iloc[-1]), float(cli.iloc[-1] - cli.iloc[-2])
        above, rising = level > CLI_TREND, change > 0
        phase = ("EXPANSION" if rising else "DOWNTURN") if above else ("RECOVERY" if rising else "SLOWDOWN")
        phases = pd.Series(np.where(cli > CLI_TREND, np.where(cli.diff() > 0, "EXPANSION", "DOWNTURN"),
                                    np.where(cli.diff() > 0, "RECOVERY", "SLOWDOWN")), index=cli.index).iloc[1:]
        ahead.append({
            "id": "oecd_cli", "label": "OECD CLI", "series": "USALOLITOAASTSAM", "url": _url("USALOLITOAASTSAM"),
            "value": level, "unit": "", "as_of": str(cli.index[-1]), "state": phase,
            "tone": {"EXPANSION": "good", "RECOVERY": "good", "DOWNTURN": "watch", "SLOWDOWN": "bad"}[phase],
            "since": str(since(phases)), "line": "100 = trend",
            "detail": f"{'above' if above else 'below'} 100 · {change:+.2f} m/m",
            "rule": "Expansion = above 100 and rising; downturn = above 100 and falling; slowdown = below 100 and "
                    "falling; recovery = below 100 and rising. Designed to anticipate turning points in the GDP gap "
                    "six to nine months ahead; the level is not a measure of how far GDP is from trend.",
            "source": "OECD, Interpreting OECD Composite Leading Indicators (2020)", "revised": True,
            "history": [{"date": str(p), "value": round(float(v), 3)} for p, v in cli.iloc[-36:].items()],
        })

    # ── Slack ────────────────────────────────────────────────────────────────
    slack: list[dict] = []
    gdp, potential = quarterly(get("GDPC1")), quarterly(get("GDPPOT"))
    output_gap = None
    if gdp.empty or potential.empty or gdp.index[-1] not in potential.index:
        slack.append(_missing("output_gap", "OUTPUT GAP", "GDPPOT", "real GDP vs CBO potential", "CBO · BEA"))
    else:
        gaps = ((gdp / potential.reindex(gdp.index) - 1.0) * 100.0).dropna()
        output_gap = float(gaps.iloc[-1])
        slack.append({
            "id": "output_gap", "label": "OUTPUT GAP", "series": "GDPPOT", "url": _url("GDPPOT"),
            "value": output_gap, "unit": "%", "as_of": str(gaps.index[-1]),
            "state": "ABOVE POTENTIAL" if output_gap > 0 else "BELOW POTENTIAL",
            "tone": "watch" if output_gap > 0 else "neutral", "since": str(since(gaps > 0)), "line": "0 = potential",
            "rule": "Real GDP as a percent of CBO's real potential GDP, minus 100. Potential GDP is CBO's estimate of "
                    "the output the economy would produce with a high rate of use of its capital and labor resources.",
            "source": "Congressional Budget Office · BEA", "revised": True,
            "history": [{"date": str(p), "value": round(float(v), 2)} for p, v in gaps.iloc[-20:].items()],
        })

    unrate, natural = monthly(get("UNRATE")), quarterly(get("NROU"))
    if unrate.empty or natural.empty or unrate.index[-1].asfreq("Q") not in natural.index:
        slack.append(_missing("unemployment_gap", "UNEMPLOYMENT GAP", "NROU", "U3 vs CBO noncyclical rate", "CBO · BLS"))
    else:
        nat = natural.reindex(unrate.index.asfreq("Q")).set_axis(unrate.index)
        ugap = (unrate - nat).dropna()
        value = float(ugap.iloc[-1])
        slack.append({
            "id": "unemployment_gap", "label": "UNEMPLOYMENT GAP", "series": "NROU", "url": _url("NROU"),
            "value": value, "unit": "pp", "as_of": str(ugap.index[-1]),
            "state": "ABOVE NONCYCLICAL RATE" if value > 0 else "BELOW NONCYCLICAL RATE",
            "tone": "neutral", "since": str(since(ugap > 0)), "line": "0 = noncyclical rate",
            "detail": f"U3 {float(unrate.iloc[-1]):.1f}% · noncyclical {float(nat.iloc[-1]):.2f}%",
            "rule": "Unemployment rate (U3) minus CBO's noncyclical rate of unemployment — the rate arising from all "
                    "sources except fluctuations in aggregate demand.",
            "source": "Congressional Budget Office · BLS", "revised": True,
            "history": [{"date": str(p), "value": round(float(v), 2)} for p, v in ugap.iloc[-36:].items()],
        })

    if not ma3.empty:
        latest = float(ma3.iloc[-1])
        old_enough = months_in_expansion is not None and months_in_expansion > CFNAI_INFLATION_MIN_MONTHS
        level = ("SUBSTANTIAL" if latest > CFNAI_INFLATION_SUBSTANTIAL else
                 "INCREASING" if latest > CFNAI_INFLATION else None) if old_enough else None
        slack.append({
            "id": "cfnai_inflation", "label": "CFNAI-MA3 INFLATION LINE", "series": "CFNAIMA3", "url": _url("CFNAIMA3"),
            "value": latest, "unit": "", "as_of": str(ma3.index[-1]), "on": level is not None,
            "state": f"{level} LIKELIHOOD" if level else "BELOW LINE",
            "tone": "watch" if level else "good", "line": f"> +{CFNAI_INFLATION:.2f}",
            "detail": (f"{months_in_expansion} months into the expansion" if months_in_expansion is not None
                       else "months into expansion unknown"),
            "rule": "An increasing likelihood of a period of sustained increasing inflation has historically been "
                    "associated with values of the CFNAI-MA3 above +0.70 more than two years into an economic "
                    "expansion; a substantial likelihood, above +1.00.",
            "source": "Federal Reserve Bank of Chicago", "revised": True,
        })

    # ── Inflation against the goal ───────────────────────────────────────────
    prices: list[dict] = []
    pce, core = monthly(get("PCEPI")), monthly(get("PCEPILFE"))
    inflation_gap = None
    if len(pce) < 13:
        prices.append(_missing("pce", "PCE INFLATION", "PCEPI", "2% annual change", "FOMC"))
    else:
        yoy = ((pce / pce.shift(12) - 1.0) * 100.0).dropna()
        inflation_gap = float(yoy.iloc[-1] - INFLATION_GOAL)
        core_yoy = ((core / core.shift(12) - 1.0) * 100.0).dropna() if len(core) >= 13 else pd.Series(dtype=float)
        prices.append({
            "id": "pce", "label": "PCE INFLATION", "series": "PCEPI", "url": _url("PCEPI"),
            "value": float(yoy.iloc[-1]), "unit": "%", "as_of": str(yoy.index[-1]),
            "state": "ABOVE GOAL" if inflation_gap > 0 else "BELOW GOAL",
            "tone": "watch" if inflation_gap > 0 else "good", "since": str(since(yoy > INFLATION_GOAL)),
            "line": f"{INFLATION_GOAL:.0f}%",
            "detail": f"{inflation_gap:+.2f}pp vs goal" + (f" · core {float(core_yoy.iloc[-1]):.2f}%" if len(core_yoy) else ""),
            "rule": "Inflation at the rate of 2 percent, as measured by the annual change in the price index for "
                    "personal consumption expenditures, is most consistent over the longer run with the Federal "
                    "Reserve's statutory mandate. The goal is stated on the headline index; core is shown for "
                    "reference only.",
            "source": "FOMC Statement on Longer-Run Goals and Monetary Policy Strategy (reaffirmed 2026-01-27)",
            "revised": True,
            "history": [{"date": str(p), "value": round(float(v), 2)} for p, v in yoy.iloc[-36:].items()],
        })

    # ── Policy ───────────────────────────────────────────────────────────────
    policy: list[dict] = []
    upper, lower, longer = get("DFEDTARU"), get("DFEDTARL"), get("FEDTARMDLR")
    midpoint = None
    if upper is None or lower is None or not len(upper) or not len(lower):
        policy.append(_missing("policy_rate", "POLICY RATE", "DFEDTARU", "target vs longer-run median", "FOMC"))
    else:
        midpoint = float((upper.dropna().iloc[-1] + lower.dropna().iloc[-1]) / 2.0)
        if longer is None or not len(longer):
            policy.append(_missing("policy_rate", "POLICY RATE", "FEDTARMDLR", "target vs longer-run median", "FOMC SEP"))
        else:
            longer = longer.dropna().sort_index()
            lr = float(longer.iloc[-1])
            policy.append({
                "id": "policy_rate", "label": "POLICY RATE vs LONGER RUN", "series": "FEDTARMDLR", "url": _url("FEDTARMDLR"),
                "value": midpoint - lr, "unit": "pp", "as_of": str(upper.dropna().index[-1].date()),
                "state": "ABOVE LONGER-RUN" if midpoint > lr else "AT OR BELOW LONGER-RUN",
                "tone": "watch" if midpoint > lr else "neutral", "line": "0 = longer-run median",
                "detail": f"target midpoint {midpoint:.3f}% · longer-run median {lr:.2f}% (SEP {longer.index[-1].date()})",
                "rule": "Midpoint of the federal funds target range minus the median longer-run federal funds rate in "
                        "the FOMC's Summary of Economic Projections — the rate participants expect the economy to "
                        "converge to in the absence of further shocks. The FOMC does not publish a line that defines "
                        "'restrictive'; this is its own longer-run estimate, nothing more.",
                "source": "FOMC Summary of Economic Projections", "revised": False,
            })

    deflator = quarterly(get("GDPDEF"))
    if midpoint is None or output_gap is None or len(deflator) < 5 or deflator.index[-1] != gdp.index[-1]:
        policy.append(_missing("taylor", "TAYLOR (1993) RULE", "GDPDEF", "r = p + .5y + .5(p − 2) + 2", "Taylor (1993)"))
    else:
        p = float((deflator.iloc[-1] / deflator.iloc[-5] - 1.0) * 100.0)
        prescribed = p + 0.5 * output_gap + 0.5 * (p - 2.0) + 2.0
        policy.append({
            "id": "taylor", "label": "TAYLOR (1993) RULE", "series": "GDPDEF", "url": _url("GDPDEF"),
            "value": midpoint - prescribed, "unit": "pp", "as_of": str(deflator.index[-1]),
            "state": "POLICY ABOVE RULE" if midpoint > prescribed else "POLICY BELOW RULE",
            "tone": "neutral", "line": "0 = rule",
            "detail": f"rule {prescribed:.2f}% · target midpoint {midpoint:.3f}% · p {p:.2f}% · y {output_gap:+.2f}%",
            "rule": "r = p + .5y + .5(p − 2) + 2, where p is the rate of inflation over the previous four quarters "
                    "(GDP deflator) and y is the percent deviation of real GDP from trend. Here y is the CBO output "
                    "gap — Taylor used a 2.2% linear trend.",
            "source": "Taylor (1993), Discretion versus Policy Rules in Practice", "revised": True,
        })

    # ── Financial conditions ─────────────────────────────────────────────────
    finance: list[dict] = []
    for ind_id, sid, label, extra in (
        ("nfci", "NFCI", "NFCI", ""),
        ("anfci", "ANFCI", "ADJUSTED NFCI", " Adjusted = with the part explained by economic activity and inflation removed."),
    ):
        raw = get(sid)
        if raw is None or not len(raw):
            finance.append(_missing(ind_id, label, sid, "> 0 = tighter than average", "Chicago Fed"))
            continue
        raw = raw.dropna().sort_index()
        value = float(raw.iloc[-1])
        finance.append({
            "id": ind_id, "label": label, "series": sid, "url": _url(sid), "value": value, "unit": "",
            "as_of": str(raw.index[-1].date()), "state": "TIGHTER THAN AVERAGE" if value > 0 else "LOOSER THAN AVERAGE",
            "tone": "bad" if value > 0 else "good", "since": str(since(raw > 0).date()), "line": "0 = average",
            "rule": "Positive values of the NFCI indicate financial conditions that are tighter than average, "
                    "negative values looser than average." + extra,
            "source": "Federal Reserve Bank of Chicago", "revised": True,
            "history": [{"date": str(p.date()), "value": round(float(v), 3)} for p, v in raw.iloc[-52:].items()],
        })

    groups = [
        {"id": "recession_now", "label": "RECESSION NOW", "question": "Has a recession started?", "indicators": now},
        {"id": "recession_ahead", "label": "RECESSION AHEAD", "question": "Is one signalled for the next year?", "indicators": ahead},
        {"id": "slack", "label": "SLACK", "question": "Is the economy above or below its capacity?", "indicators": slack},
        {"id": "inflation", "label": "INFLATION", "question": "Where is inflation against the Fed's goal?", "indicators": prices},
        {"id": "policy", "label": "POLICY", "question": "Where is the policy rate against its reference points?", "indicators": policy},
        {"id": "financial", "label": "FINANCIAL CONDITIONS", "question": "Are financial conditions tight or loose?", "indicators": finance},
    ]
    if trend:
        groups.append({"id": "market", "label": "MARKET TREND", "question": "Tested in this repo, not an official definition",
                       "indicators": [trend]})

    by_id = {i["id"]: i for g in groups for i in g["indicators"]}
    rules = [by_id[r] for r in RECESSION_RULES if r in by_id]
    known = [r for r in rules if r["state"] is not None]
    on_rules = [r for r in known if r.get("on")]
    nber = by_id.get("nber", {})
    headline = {
        "nber": nber.get("state"), "nber_as_of": nber.get("as_of"),
        "months_in_expansion": months_in_expansion,
        "recession_rules_on": len(on_rules), "recession_rules_known": len(known),
        "recession_rules": [{"id": r["id"], "label": r["label"], "on": bool(r.get("on"))} for r in known],
        "curve": by_id.get("yield_curve", {}).get("state"),
        "probability_12m": by_id.get("yield_curve", {}).get("probability_12m"),
        "cli_phase": by_id.get("oecd_cli", {}).get("state"),
        "output_gap": output_gap, "inflation_gap": inflation_gap,
        "policy": by_id.get("policy_rate", {}).get("state"),
        "financial": by_id.get("nfci", {}).get("state"),
    }
    return {"headline": headline, "groups": groups, "implications": implications(by_id, headline),
            "missing": missing, "composite": None,
            "note": "ตัวชี้วัดทางการ อ่านตามนิยามของผู้เผยแพร่ ไม่มีคะแนนรวม ไม่มี phase ที่ตั้งเอง"}


# ── What the reading means for the book ───────────────────────────────────────

def _pct(x: float | None, digits: int = 0) -> str:
    return "—" if x is None else f"{x * 100:+.{digits}f}%"


def _record_line(ind: dict) -> str:
    t, m = ind.get("track") or {}, ind.get("market")
    parts = []
    if t:
        parts.append(f"ตั้งแต่ {t['from'][:4]}: recession {t['recessions']} รอบ จับได้ {t['caught']} พลาด {t['missed']}"
                     f" · สัญญาณผิด {t['false']}" + (f" ({', '.join(t['false_dates'])})" if t["false_dates"] else ""))
        if t.get("median_lead") is not None:
            lead = t["median_lead"]
            parts.append(f"median {'ก่อน' if lead > 0 else 'หลัง'} recession เริ่ม {abs(lead):.0f} เดือน")
    if ind.get("published_after_months"):
        parts.append(f"ตัวเลขออกช้า {ind['published_after_months']} เดือน")
    if m:
        parts.append(f"S&P 500 อีก {m['horizon']} เดือนหลังรู้สัญญาณ: median {_pct(m['median_return'])} "
                     f"(ทุกเดือน {_pct(m['all_months_median_return'])}), จุดต่ำสุดระหว่างทาง median {_pct(m['median_low'])}"
                     f" แย่สุด {_pct(m['worst_low'])}, n={m['n']}")
    return " · ".join(parts)


def implications(by_id: dict[str, dict], headline: dict) -> list[dict]:
    """What follows from the readings — each line tied to a definition, a count from history, or a test."""
    out: list[dict] = []

    def add(kind: str, text: str, basis: str) -> None:
        out.append({"kind": kind, "text": text, "basis": basis})

    on = [by_id[r] for r in RECESSION_RULES if by_id.get(r, {}).get("on")]
    known = headline["recession_rules_known"]
    if known and not on:
        add("know", f"กฎ recession แบบ real-time ติด 0/{known} — ตามนิยามของแต่ละกฎ ยังไม่มีสัญญาณว่า recession เริ่มแล้ว "
                    "(กฎเหล่านี้บอกว่า 'เริ่มแล้ว' ไม่ได้บอกว่า 'กำลังจะมา')", "definition")
    for ind in on:
        add("know", f"{ind['label']} ติดตั้งแต่ {ind['since']} — ตามนิยามคือ recession เริ่มแล้ว. {_record_line(ind)}",
            "track record")
    if len(on) >= 2:
        add("do", f"กฎ recession ติด {len(on)}/{known} พร้อมกัน: ทบทวน kill line ของ thesis ที่รายได้ขึ้นกับวัฏจักร "
                  "(PORT → TOOLS → TRACK) และดูผลกระทบใน PORT → RISK ก่อนเพิ่มความเสี่ยง", "definition")

    curve = by_id.get("yield_curve") or {}
    if curve.get("state") is not None:
        prob = curve.get("probability_12m")
        if curve.get("on"):
            add("know", f"Yield curve กลับหัวตั้งแต่ {curve['since']} (ค่าเฉลี่ยรายเดือน) · ความน่าจะเป็น recession ใน 12 "
                        f"เดือน {prob:.0f}%. {_record_line(curve)}", "track record")
            market = curve.get("market")
            if market and market["median_return"] > 0:
                add("dont", f"อย่าใช้การกลับหัวของ curve เป็นจังหวะขายทันที — เป็นสัญญาณล่วงหน้า 12 เดือน และ S&P 500 ใน 12 "
                            f"เดือนหลังกลับหัวเป็นบวก {market['up_share'] * 100:.0f}% ของครั้ง (n={market['n']})",
                    "track record")
        else:
            add("know", f"Yield curve ไม่กลับหัว (ตั้งแต่ {curve['since']}) · ความน่าจะเป็น recession ใน 12 เดือนจาก probit "
                        f"{prob:.0f}%. {_record_line(curve)}", "track record")

    pce, taylor, rate = by_id.get("pce") or {}, by_id.get("taylor") or {}, by_id.get("policy_rate") or {}
    if pce.get("value") is not None:
        text = f"เงินเฟ้อ PCE {pce['value']:.2f}% เทียบเป้า FOMC 2% ({pce['value'] - INFLATION_GOAL:+.2f}pp)"
        if rate.get("value") is not None:
            text += f" · อัตรานโยบาย{'สูงกว่า' if rate['value'] > 0 else 'ไม่สูงกว่า'}ค่าระยะยาวของ FOMC {abs(rate['value']):.2f}pp"
        if taylor.get("value") is not None:
            text += f" · {'สูงกว่า' if taylor['value'] > 0 else 'ต่ำกว่า'}กฎ Taylor (1993) {abs(taylor['value']):.2f}pp"
        add("know", text, "definition")

    flag = by_id.get("cfnai_inflation") or {}
    if flag.get("on"):
        add("know", f"CFNAI-MA3 {flag['value']:+.2f} เกินเส้น +0.70 ขณะ expansion เกิน 2 ปี — Chicago Fed ระบุว่าสัมพันธ์กับโอกาส"
                    "ที่เงินเฟ้อจะเร่งขึ้นต่อเนื่อง", "definition")

    gap = headline.get("output_gap")
    if gap is not None:
        add("know", f"GDP จริง{'สูงกว่า' if gap > 0 else 'ต่ำกว่า'}ศักยภาพของ CBO {abs(gap):.2f}% — "
                    f"{'ไม่มี slack เหลือ' if gap > 0 else 'ยังมี slack'}ตามนิยามของ output gap", "definition")

    trend = by_id.get("trend_10m") or {}
    if trend.get("state") is not None:
        add("know", f"Trend 10 เดือนของ SPY: {trend['state']} — ผลทดสอบ 1994–2026 = WEAK: max drawdown −26% เทียบ −55% "
                    "ของการถือยาว แลก CAGR −1.2pp; Sharpe แยกจากโชคไม่ได้ จึงไม่ใช่กฎที่พิสูจน์แล้ว", "backtest")

    add("dont", "อย่าเลือก sector ตาม phase ของ cycle — ทดสอบบน SPDR sector 2000–2026 แล้ว: IC −0.010 (DEAD); "
                "momentum 12-1 IC 0.005 (แยกจากศูนย์ไม่ได้). ไม่มีหลักฐานรองรับการเอียงน้ำหนัก sector", "backtest")
    add("dont", "อย่ารอ NBER — ประกาศจุดเริ่ม recession ช้า 4–21 เดือน แถว NBER บนจอนี้เป็นค่าย้อนหลัง", "definition")
    add("dont", "อย่ารวมแถวเหล่านี้เป็นคะแนนเดียว — แต่ละตัววัดคนละอย่าง ออกคนละเวลา และ 3 ใน 4 กฎ recession ใช้ข้อมูล"
                "ชุดใกล้กัน (การจ้างงาน การผลิต รายได้) จึงมักติดพร้อมกัน", "definition")
    return out
