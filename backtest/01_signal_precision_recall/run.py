"""
Signal Precision/Recall Backtest Runner
========================================
Tests all 12 signal groups (19 signals) against SPY fat-tail events.

Usage:
  cd backtest
  python 01_signal_precision_recall/run.py

Output (in 01_signal_precision_recall/results/YYYY-MM-DD/):
  full_report.md      — comprehensive report by signal group
  signal_analysis.md  — per-signal deep-dive with pros/cons
  full_metrics.csv    — raw metrics (all periods, signals, levels)
  metrics_insample.csv / metrics_oos.csv / metrics_forward.csv
  forward_status.csv  — current signal state (last 10 trading days)

Periods:
  In-sample:  2015-01-01 → 2022-12-31  (covers COVID, 2018 corrections)
  OOS:        2023-01-01 → 2024-12-31  (SVB, Yen carry unwind)
  Forward:    2025-01-01 → today       (live validation)

Signal Groups (g1–g12):
  g1  VIX-based          — backwardation, spike, momentum
  g2  Credit Spreads     — HY/IG static + z-score
  g3  Financial Stress   — STL FSI, Chicago NFCI
  g4  Yield Curve        — 10Y-2Y, 10Y-3M inversions
  g5  Fear & Greed       — 5-component synthetic composite
  g6  Sector Regime      — 11-sector correlation convergence
  g7  Equity Technicals  — RSI oversold, price z-score
  g8  Allocation Layer A — SPY vs AGG relative z-score
  g9  Crisis Composite   — weighted RED score
  g10 Volume/Flow        — SPY volume z-score anomaly
  g11 Cross-Asset        — safe haven, correlation velocity
  g12 Composite Gate     — 3+ signals active simultaneously
"""
import os
import sys

# Backtest core modules live one level up
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datetime import date
import pandas as pd

from config import (
    IN_SAMPLE_START, IN_SAMPLE_END,
    OOS_START, OOS_END,
    FORWARD_START,
    CRASH_LEVELS, LOOKAHEAD_DAYS,
)
from fetcher import fetch_yf, fetch_fred, close
from signals import build_all
from engine import run_period, current_status

TODAY = date.today().isoformat()

RESULTS_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "results", TODAY,
)
os.makedirs(RESULTS_DIR, exist_ok=True)

SIGNAL_GROUPS = {
    "g1":  ("VIX-based",          "Volatility regime indicators"),
    "g2":  ("Credit Spreads",     "Spread vs threshold + z-score (crisis.py)"),
    "g3":  ("Financial Stress",   "STL FSI, Chicago NFCI (crisis.py)"),
    "g4":  ("Yield Curve",        "10Y-2Y, 10Y-3M inversions"),
    "g5":  ("Fear & Greed",       "Synthetic 5-component composite (fear_greed.py)"),
    "g6":  ("Sector Regime",      "11-sector rolling correlation convergence (regime.py)"),
    "g7":  ("Equity Technicals",  "RSI oversold, price z-score"),
    "g8":  ("Allocation Layer A", "SPY vs AGG 20d relative z-score (layer_a.py)"),
    "g9":  ("Crisis Composite",   "Weighted composite score RED (crisis.py /composite)"),
    "g10": ("Volume / Flow",      "SPY volume z-score anomaly"),
    "g11": ("Cross-Asset",        "Safe haven flight, correlation velocity"),
    "g12": ("Composite Gate",     "3+ signals active simultaneously"),
}

VERDICT_EMOJI = {
    "STRONG":    "STRONG",
    "USEFUL":    "USEFUL",
    "SENSITIVE": "SENSITIVE",
    "WEAK":      "WEAK",
    "MIXED":     "MIXED",
    "NO_EVENTS": "NO_EVENTS",
}


def _pct(v):
    return "n/a" if pd.isna(v) else f"{v*100:.0f}%"

def _f1(v):
    return "n/a" if pd.isna(v) else f"{v:.1f}"

def _edge(p, r):
    e = p - r
    return f"{'+' if e >= 0 else ''}{e*100:.0f}pp"

def _verdict(precision, random, recall, n_events):
    if n_events == 0:
        return "NO_EVENTS"
    edge = precision - random
    if precision >= 0.50 and recall >= 0.45:
        return "STRONG"
    if precision >= 0.35 and edge >= 0.15:
        return "USEFUL"
    if recall >= 0.55 and precision >= 0.20:
        return "SENSITIVE"
    if edge < 0.05:
        return "WEAK"
    return "MIXED"


def _metrics_table(df, level, look):
    sub = df[(df.level == level) & (df.lookahead == look)].copy()
    if sub.empty:
        return "_No data._\n"
    lines = [
        "| Signal | Fires | Precision | vs Rand | Recall | F1 | Lead(med) | Verdict |",
        "|--------|------:|----------:|--------:|-------:|---:|----------:|---------|",
    ]
    for _, r in sub.sort_values("signal").iterrows():
        v = _verdict(r.precision, r.random_precision, r.recall, r.n_events)
        lines.append(
            f"| `{r.signal}` | {r.n_signals} | {_pct(r.precision)} | "
            f"{_edge(r.precision, r.random_precision)} | "
            f"{_pct(r.recall)} | {_pct(r.f1)} | {_f1(r.lead_med)}d | {v} |"
        )
    return "\n".join(lines) + "\n"


def _build_report(is_m, oos_m, fwd_m, fwd_status):
    lines = [
        f"# Signal Precision/Recall Backtest Report",
        f"**Generated:** {TODAY}",
        f"**Scope:** 19 signals x 3 periods x 3 event levels x 3 lookahead windows",
        f"**Event:** SPY daily return <= threshold",
        f"**Signal timing:** signal fires at close T -> event at T+1..T+lookahead",
        "",
        "---",
        "",
        "## Signal Groups",
        "",
    ]
    for gkey, (gname, gdesc) in SIGNAL_GROUPS.items():
        lines.append(f"- **{gkey}**: **{gname}** -- {gdesc}")

    lines += ["", "---", "",
        "## How to Read",
        "",
        "- **Precision** = % of signal fires followed by fat tail within lookahead",
        "- **vs Rand** = edge over baseline (event_rate x window)",
        "- **Recall** = % of fat tails preceded by signal within window",
        "- **STRONG** = precision>=50% AND recall>=45%",
        "- **USEFUL** = precision>=35% AND edge>=15pp",
        "- **SENSITIVE** = recall>=55% but lower precision",
        "- **WEAK** = edge < 5pp (random noise)",
        "- **NO_EVENTS** = no events in this period at this threshold",
        "", "---", "",
    ]

    lines += ["## 1. In-Sample (2015-2022)", "_Covers: 2015 flash crash, 2018 vol spike, 2020 COVID_", ""]
    for level, tstr in [("L1", "SPY <= -1.5%"), ("L2", "SPY <= -3%"), ("L3", "SPY <= -5%")]:
        lines += [f"### 1.x {tstr} -- Lookahead 3 days", "", _metrics_table(is_m, level, 3)]
    lines += ["### In-Sample L1: 1-day lookahead", "", _metrics_table(is_m, "L1", 1),
              "### In-Sample L1: 5-day lookahead", "", _metrics_table(is_m, "L1", 5)]

    lines += ["---", "", "## 2. Out-of-Sample (2023-2024)",
              "_Covers: SVB Mar 2023, regional banking, Aug 2024 yen carry unwind_", ""]
    for level, tstr in [("L1", "SPY <= -1.5%"), ("L2", "SPY <= -3%")]:
        lines += [f"### 2.x {tstr} -- Lookahead 3 days", "", _metrics_table(oos_m, level, 3)]

    lines += ["---", "", "## 3. Forward Test (2025-Present)", "_Live validation on 2025-2026 data_", ""]
    for level, tstr in [("L1", "SPY <= -1.5%"), ("L2", "SPY <= -3%")]:
        lines += [f"### 3.x {tstr} -- Lookahead 3 days", "", _metrics_table(fwd_m, level, 3)]

    lines += ["---", "", "## 4. Verdict Summary (L1, 3-day)", "",
              "| Signal | In-sample | OOS | Forward | Consistent? |",
              "|--------|-----------|-----|---------|-------------|"]

    def _gv(m, sig):
        row = m[(m.signal == sig) & (m.level == "L1") & (m.lookahead == 3)]
        if row.empty: return "--"
        r = row.iloc[0]
        return _verdict(r.precision, r.random_precision, r.recall, r.n_events)

    all_sigs = sorted(set(is_m.signal) | set(oos_m.signal) | set(fwd_m.signal))
    for sig in all_sigs:
        iv, ov, fv = _gv(is_m, sig), _gv(oos_m, sig), _gv(fwd_m, sig)
        scores = [v for v in [iv, ov, fv] if v in ("STRONG", "USEFUL")]
        consistent = "YES" if len(scores) >= 2 else ("PARTIAL" if len(scores) == 1 else "NO")
        lines.append(f"| `{sig}` | {iv} | {ov} | {fv} | {consistent} |")

    if not fwd_status.empty:
        lines += ["", "---", "", "## 5. Current Signal Status (Last 10 Trading Days)", ""]
        cols = list(fwd_status.columns)
        lines += ["| Signal | " + " | ".join(c[-5:] for c in cols) + " |",
                  "|--------|" + "|".join("------" for _ in cols) + "|"]
        for sig, row in fwd_status.iterrows():
            vals = ["ON" if v else "off" for v in row]
            lines.append(f"| `{sig}` | " + " | ".join(vals) + " |")

    lines += ["", "---",
              f"_Generated by backtest/01_signal_precision_recall/run.py | {TODAY}_"]
    return "\n".join(lines)


def run_one_period(start, end, label):
    print(f"\n{'='*60}\nPeriod: {label} ({start} to {end})\n{'='*60}")
    yf_data   = fetch_yf(start, end)
    fred_data = fetch_fred(start, end)
    spy = close(yf_data, "SPY")
    if spy.empty:
        print(f"  ERROR: SPY empty -- skipping", file=sys.stderr)
        return pd.DataFrame(), pd.DataFrame()
    sigs = build_all(yf_data, fred_data)
    print(f"  Signals: {len(sigs.columns)} signals, {len(sigs)} trading days")
    metrics = run_period(sigs, spy, label)
    status  = current_status(sigs, n_days=10)
    return metrics, status


def main():
    print(f"\nSignal Precision/Recall Backtest | Date: {TODAY}")
    print(f"Output: {RESULTS_DIR}\n")

    is_m,  _      = run_one_period(IN_SAMPLE_START, IN_SAMPLE_END, "in-sample")
    oos_m, _      = run_one_period(OOS_START,        OOS_END,       "oos")
    fwd_m, fwd_st = run_one_period(FORWARD_START,    TODAY,         "forward")

    if is_m.empty and oos_m.empty and fwd_m.empty:
        print("ERROR: All periods failed.", file=sys.stderr)
        sys.exit(1)

    combined = pd.concat([is_m, oos_m, fwd_m], ignore_index=True)
    combined.to_csv(os.path.join(RESULTS_DIR, "full_metrics.csv"), index=False)
    is_m.to_csv(os.path.join(RESULTS_DIR, "metrics_insample.csv"),  index=False)
    oos_m.to_csv(os.path.join(RESULTS_DIR, "metrics_oos.csv"),      index=False)
    fwd_m.to_csv(os.path.join(RESULTS_DIR, "metrics_forward.csv"),  index=False)
    if not fwd_st.empty:
        fwd_st.to_csv(os.path.join(RESULTS_DIR, "forward_status.csv"))

    report = _build_report(
        is_m  if not is_m.empty  else pd.DataFrame(),
        oos_m if not oos_m.empty else pd.DataFrame(),
        fwd_m if not fwd_m.empty else pd.DataFrame(),
        fwd_st if not fwd_st.empty else pd.DataFrame(),
    )
    rpath = os.path.join(RESULTS_DIR, "full_report.md")
    with open(rpath, "w", encoding="utf-8") as f:
        f.write(report)
    print(f"\nSaved: {rpath}")


if __name__ == "__main__":
    main()
