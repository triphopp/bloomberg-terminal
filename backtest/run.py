"""
Full project signal backtest runner.

Usage:
  cd backtest
  python run.py

Output:
  results/full_report_YYYY-MM-DD.md   — comprehensive report by signal group
  results/full_metrics_YYYY-MM-DD.csv — raw metrics (all periods, signals, levels)
  results/forward_status.csv          — current signal status (last 10 days)
"""
import os
import sys
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
from engine  import run_period, current_status

RESULTS_DIR = os.path.join(os.path.dirname(__file__), "results")
os.makedirs(RESULTS_DIR, exist_ok=True)

TODAY = date.today().isoformat()

# Signal group metadata
SIGNAL_GROUPS = {
    "g1": ("VIX-based",          "Volatility regime indicators"),
    "g2": ("Credit Spreads",     "Spread vs threshold + z-score (crisis.py)"),
    "g3": ("Financial Stress",   "STL FSI, Chicago NFCI (crisis.py)"),
    "g4": ("Yield Curve",        "10Y-2Y, 10Y-3M inversions"),
    "g5": ("Fear & Greed",       "Synthetic 5-component composite (fear_greed.py)"),
    "g6": ("Sector Regime",      "11-sector rolling correlation convergence (regime.py)"),
    "g7": ("Equity Technicals",  "RSI oversold, price z-score"),
    "g8": ("Allocation Layer A", "SPY vs AGG 20d relative z-score (layer_a.py)"),
    "g9": ("Crisis Composite",   "Weighted composite score RED (crisis.py /composite)"),
    "g10":("Volume / Flow",      "SPY volume z-score anomaly"),
    "g11":("Cross-Asset",        "Safe haven flight, correlation velocity"),
    "g12":("Composite Gate",     "3+ signals active simultaneously"),
}

VERDICT_EMOJI = {
    "STRONG":    "✅",
    "USEFUL":    "🟡",
    "SENSITIVE": "🟡",
    "WEAK":      "❌",
    "MIXED":     "⚠️",
    "NO_EVENTS": "—",
}


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _pct(v: float) -> str:
    return "n/a" if pd.isna(v) else f"{v*100:.0f}%"

def _f1(v: float) -> str:
    return "n/a" if pd.isna(v) else f"{v:.1f}"

def _edge(p: float, r: float) -> str:
    e = p - r
    return f"{'+' if e >= 0 else ''}{e*100:.0f}pp"

def _verdict(precision: float, random: float, recall: float, n_events: int) -> str:
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


def _group_of(sig: str) -> str:
    for g in SIGNAL_GROUPS:
        if sig.startswith(g + "_") or sig == g:
            return g
    return "other"


# ─── Report builder ───────────────────────────────────────────────────────────

def _metrics_table(df: pd.DataFrame, level: str, look: int, signals_filter=None) -> str:
    sub = df[(df.level == level) & (df.lookahead == look)].copy()
    if signals_filter:
        sub = sub[sub.signal.isin(signals_filter)]
    if sub.empty:
        return "_No data._\n"

    lines = [
        "| Signal | Fires | Precision | vs Rand | Recall | F1 | Lead(med) | Verdict |",
        "|--------|------:|----------:|--------:|-------:|---:|----------:|---------|",
    ]
    for _, r in sub.sort_values("signal").iterrows():
        v = _verdict(r.precision, r.random_precision, r.recall, r.n_events)
        emoji = VERDICT_EMOJI.get(v, "?")
        lines.append(
            f"| `{r.signal}` | {r.n_signals} | {_pct(r.precision)} | "
            f"{_edge(r.precision, r.random_precision)} | "
            f"{_pct(r.recall)} | {_pct(r.f1)} | {_f1(r.lead_med)}d | {emoji} {v} |"
        )
    return "\n".join(lines) + "\n"


def _build_report(
    is_m: pd.DataFrame,
    oos_m: pd.DataFrame,
    fwd_m: pd.DataFrame,
    fwd_status: pd.DataFrame,
) -> str:
    lines = [
        f"# Full Project Signal Backtest Report",
        f"**Generated:** {TODAY}  ",
        f"**Scope:** All detection mechanisms in bloomberg-terminal project  ",
        f"**Event:** SPY daily return ≤ threshold  ",
        f"**Signal evaluation:** signal fires at T, event at T+1..T+lookahead  ",
        "",
        "---",
        "",
        "## Signal Groups Tested",
        "",
    ]
    for gkey, (gname, gdesc) in SIGNAL_GROUPS.items():
        lines.append(f"- **{gkey}**: **{gname}** — {gdesc}")

    lines += [
        "",
        "---",
        "",
        "## How to Read",
        "",
        "- **Precision** = % of signal fires followed by fat tail within lookahead",
        "- **vs Rand** = edge over baseline (event_rate × window) — the real test",
        "- **Recall** = % of fat tails preceded by signal within window",
        "- **STRONG** = precision≥50% AND recall≥45%",
        "- **USEFUL** = precision≥35% AND edge≥15pp",
        "- **SENSITIVE** = recall≥55% but precision lower (noisy but catches events)",
        "- **WEAK** = edge < 5pp (random noise)",
        "- **NO_EVENTS** = no events in this period at this threshold",
        "",
        "---",
        "",
    ]

    # ── In-Sample ──
    lines += [
        "## 1. In-Sample (2015–2022)",
        "_Includes: 2015 China flash crash, 2018 vol spike, 2018 Q4 correction, 2020 COVID_",
        "",
    ]

    for level, threshold_str in [("L1", "SPY ≤ -1.5%"), ("L2", "SPY ≤ -3%"), ("L3", "SPY ≤ -5%")]:
        lines += [
            f"### 1.x {threshold_str} — Lookahead 3 days",
            "",
            _metrics_table(is_m, level, 3),
        ]

    # Best lookaheads for L1
    lines += [
        "### In-Sample L1: Lookahead 1 / 5 days comparison",
        "",
        "**1-day lookahead:**",
        _metrics_table(is_m, "L1", 1),
        "**5-day lookahead:**",
        _metrics_table(is_m, "L1", 5),
    ]

    # ── OOS ──
    lines += [
        "---",
        "",
        "## 2. Out-of-Sample (2023–2024)",
        "_Includes: SVB Mar 2023, regional banking stress, Aug 2024 yen carry unwind_",
        "_Note: 2023-2024 was a bull market — L2/L3 events rare or absent_",
        "",
    ]

    for level, threshold_str in [("L1", "SPY ≤ -1.5%"), ("L2", "SPY ≤ -3%")]:
        lines += [
            f"### 2.x {threshold_str} — Lookahead 3 days",
            "",
            _metrics_table(oos_m, level, 3),
        ]

    # ── Forward ──
    lines += [
        "---",
        "",
        "## 3. Forward Test (2025–Present)",
        "_Live signals computed on actual 2025-2026 data_",
        "",
    ]

    for level, threshold_str in [("L1", "SPY ≤ -1.5%"), ("L2", "SPY ≤ -3%")]:
        lines += [
            f"### 3.x {threshold_str} — Lookahead 3 days",
            "",
            _metrics_table(fwd_m, level, 3),
        ]

    # ── Verdict summary ──
    lines += [
        "---",
        "",
        "## 4. Signal Verdict Summary (L1, 3-day, across all periods)",
        "",
        "| Signal | In-sample | OOS | Forward | Consistent? |",
        "|--------|-----------|-----|---------|-------------|",
    ]

    all_sigs = sorted(set(is_m.signal.unique()) | set(oos_m.signal.unique()) | set(fwd_m.signal.unique()))

    def _get_verdict(m: pd.DataFrame, sig: str, level: str = "L1", look: int = 3) -> str:
        row = m[(m.signal == sig) & (m.level == level) & (m.lookahead == look)]
        if row.empty: return "—"
        r = row.iloc[0]
        v = _verdict(r.precision, r.random_precision, r.recall, r.n_events)
        return VERDICT_EMOJI.get(v, "?") + " " + v

    for sig in all_sigs:
        is_v  = _get_verdict(is_m,  sig)
        oos_v = _get_verdict(oos_m, sig)
        fwd_v = _get_verdict(fwd_m, sig)
        # Consistent = STRONG or USEFUL in at least 2 periods
        scores = [v for v in [is_v, oos_v, fwd_v] if "STRONG" in v or "USEFUL" in v]
        consistent = "✅ YES" if len(scores) >= 2 else ("🟡 PARTIAL" if len(scores) == 1 else "❌ NO")
        lines.append(f"| `{sig}` | {is_v} | {oos_v} | {fwd_v} | {consistent} |")

    # ── Current status ──
    lines += [
        "",
        "---",
        "",
        "## 5. Current Signal Status (Last 10 Trading Days)",
        "",
    ]

    if not fwd_status.empty:
        cols = list(fwd_status.columns)
        lines += [
            "| Signal | " + " | ".join(c[-5:] for c in cols) + " |",
            "|--------|" + "|".join("------" for _ in cols) + "|",
        ]
        for sig, row in fwd_status.iterrows():
            vals = ["🔴" if v else "⬛" for v in row]
            lines.append(f"| `{sig}` | " + " | ".join(vals) + " |")
    else:
        lines.append("_No forward data._")

    # ── Conclusions ──
    lines += [
        "",
        "---",
        "",
        "## 6. Conclusions",
        "",
        "### Build in frontend (validated across 2+ periods):",
        "Signals that show STRONG or USEFUL in both in-sample AND forward test.",
        "",
        "### Use with caution (monitor only):",
        "Signals that are SENSITIVE (high recall, low precision) — show as 'elevated risk'.",
        "",
        "### Do NOT build (random noise):",
        "Signals that are WEAK in both periods — remove from system or recalibrate threshold.",
        "",
        "> **Key insight:** No signal is a 'crash predictor'. These are probability elevation tools.",
        "> Show precision/recall stats in the UI so users know the accuracy before acting.",
        "",
        "---",
        f"_Report by `backtest/run.py` | Bloomberg Terminal | {TODAY}_",
    ]

    return "\n".join(lines)


# ─── Runner ───────────────────────────────────────────────────────────────────

def run_one_period(start: str, end: str, label: str):
    print(f"\n{'='*60}\nPeriod: {label} ({start} to {end})\n{'='*60}")

    print("  Fetching yfinance (this includes 11 sector ETFs + F&G components)...")
    yf_data = fetch_yf(start, end)
    print("  Fetching FRED data...")
    fred_data = fetch_fred(start, end)

    spy = close(yf_data, "SPY")
    if spy.empty:
        print("  ERROR: SPY empty — skipping", file=sys.stderr)
        return pd.DataFrame(), pd.DataFrame()

    print("  Computing all signals...")
    sigs = build_all(yf_data, fred_data)
    print(f"  Signals computed: {len(sigs.columns)} signals, {len(sigs)} trading days")

    # Print signal base rates
    rates = (sigs.mean() * 100).round(1)
    for sig, rate in rates.items():
        print(f"    {sig:<35} active {rate:5.1f}% of days")

    print("  Running backtest engine...")
    metrics = run_period(sigs, spy, label)

    # Quick L1 L2 summary
    for lvl in ["L1", "L2"]:
        sub = metrics[(metrics.level == lvl) & (metrics.lookahead == 3)]
        evs = sub.n_events.iloc[0] if not sub.empty else 0
        print(f"\n  {lvl} events (3d lookahead): {evs}")
        for _, r in sub.iterrows():
            v = _verdict(r.precision, r.random_precision, r.recall, r.n_events)
            print(f"    {r.signal:<35} prec={_pct(r.precision)} rec={_pct(r.recall)} {v}")

    status = current_status(sigs, n_days=10)
    return metrics, status


def main():
    print(f"\nBloomberg Terminal — Full Signal Backtest\nDate: {TODAY}")

    is_m,  _      = run_one_period(IN_SAMPLE_START, IN_SAMPLE_END, "in-sample")
    oos_m, _      = run_one_period(OOS_START,        OOS_END,       "oos")
    fwd_m, fwd_st = run_one_period(FORWARD_START,    TODAY,         "forward")

    if is_m.empty and oos_m.empty and fwd_m.empty:
        print("ERROR: All periods failed.", file=sys.stderr)
        sys.exit(1)

    # Save combined CSV
    combined = pd.concat([is_m, oos_m, fwd_m], ignore_index=True)
    csv_path = os.path.join(RESULTS_DIR, f"full_metrics_{TODAY}.csv")
    combined.to_csv(csv_path, index=False)
    print(f"\nSaved: {csv_path}")

    if not fwd_st.empty:
        fwd_st.to_csv(os.path.join(RESULTS_DIR, "forward_status.csv"))
        print(f"Saved: {RESULTS_DIR}/forward_status.csv")

    report = _build_report(
        is_m  if not is_m.empty  else pd.DataFrame(),
        oos_m if not oos_m.empty else pd.DataFrame(),
        fwd_m if not fwd_m.empty else pd.DataFrame(),
        fwd_st,
    )
    rpath = os.path.join(RESULTS_DIR, f"full_report_{TODAY}.md")
    with open(rpath, "w", encoding="utf-8") as f:
        f.write(report)
    print(f"Saved: {rpath}")
    print(f"\nDone. Open {rpath} for full results.")


if __name__ == "__main__":
    main()
