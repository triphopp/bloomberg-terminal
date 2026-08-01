"""
Walk-forward validation of the app's HMM-calibrated CORR regime detector.

Replicates backend/analytics/regime_calibration.py exactly (63d rolling mean
|corr| -> 4-state GaussianHMM -> threshold cuts at state-mean midpoints), but
refit walk-forward so every OOS label uses only past data. See PLAN.md for
the pre-registered tests and kill criteria.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import yfinance as yf

SECTORS = ["XLK", "XLF", "XLV", "XLE", "XLI", "XLY", "XLP", "XLU", "XLB"]
WINDOW = 63
N_STATES = 4
LABELS = ["DIVERGENT", "TRENDING", "RISK-OFF", "CRISIS"]

INITIAL_TRAIN = 2016      # ~8y of score history
PURGE = 63                # score rolling-window overlap
EMBARGO = 21              # T1 label horizon
TEST_BLOCK = 126

VOL_HORIZON = 21          # T1 forward/trailing vol window (sessions)
GATE_COST_BPS_SIDE = 1.0  # T2 switch cost
N_PERMUTATIONS = 1000

RISK_ON = {0, 1}          # DIVERGENT, TRENDING


def build_scores() -> tuple[pd.Series, pd.Series]:
    """Rolling 63d mean |corr| across sector returns, plus SPY daily returns."""
    raw = yf.download(SECTORS + ["SPY"], start="2000-01-01", auto_adjust=True,
                      progress=False)["Close"]
    rets = raw.pct_change().dropna()
    sec = rets[SECTORS]
    spy = rets["SPY"]

    scores = {}
    vals = sec.values
    mask = np.triu(np.ones((len(SECTORS), len(SECTORS)), dtype=bool), k=1)
    for i in range(WINDOW, len(sec)):
        corr = np.corrcoef(vals[i - WINDOW:i].T)
        scores[sec.index[i]] = float(np.abs(corr[mask]).mean())
    return pd.Series(scores), spy


def fit_cuts(train_scores: np.ndarray) -> np.ndarray:
    """Train HMM exactly as the app does; return the 3 threshold cuts."""
    from hmmlearn.hmm import GaussianHMM
    model = GaussianHMM(n_components=N_STATES, covariance_type="full",
                        n_iter=500, random_state=42, tol=1e-4)
    model.fit(train_scores.reshape(-1, 1))
    means = np.sort(model.means_.flatten())
    return (means[:-1] + means[1:]) / 2  # midpoints, as in train_mrs_model()


def main() -> None:
    scores, spy = build_scores()
    print(f"score series: {len(scores)} sessions "
          f"({scores.index[0].date()} → {scores.index[-1].date()})")

    # ── Walk-forward OOS labeling ──
    labels = pd.Series(index=scores.index, dtype=float)
    fold = 0
    train_end = INITIAL_TRAIN
    while train_end + PURGE + EMBARGO < len(scores):
        test_lo = train_end + PURGE + EMBARGO
        test_hi = min(test_lo + TEST_BLOCK, len(scores))
        cuts = fit_cuts(scores.values[:train_end])
        seg = scores.iloc[test_lo:test_hi]
        labels.iloc[test_lo:test_hi] = np.searchsorted(cuts, seg.values)
        fold += 1
        train_end += TEST_BLOCK
    oos = labels.dropna().astype(int)
    print(f"folds: {fold}, OOS: {len(oos)} sessions "
          f"({oos.index[0].date()} → {oos.index[-1].date()})")
    dist = oos.value_counts(normalize=True).sort_index()
    print("regime distribution:",
          {LABELS[k]: f"{100 * v:.0f}%" for k, v in dist.items()})

    spy = spy.reindex(scores.index).fillna(0.0)

    # ── T1: incremental vol prediction ──
    ann = np.sqrt(252)
    trailing = spy.rolling(VOL_HORIZON).std() * ann
    forward = (spy.rolling(VOL_HORIZON).std() * ann).shift(-VOL_HORIZON)
    samples = []
    for t in range(0, len(oos) - VOL_HORIZON, VOL_HORIZON):  # non-overlapping
        ts = oos.index[t]
        if not (np.isnan(trailing.get(ts, np.nan)) or np.isnan(forward.get(ts, np.nan))):
            samples.append((oos.iloc[t], trailing[ts], forward[ts]))
    S = np.array(samples)
    n1 = len(S)

    def partial_spearman(regime, trail, fwd):
        r = pd.Series(regime).rank().values
        tr = pd.Series(trail).rank().values
        fw = pd.Series(fwd).rank().values
        res_r = r - np.polyval(np.polyfit(tr, r, 1), tr)
        res_f = fw - np.polyval(np.polyfit(tr, fw, 1), tr)
        denom = res_r.std() * res_f.std()
        return float((res_r * res_f).mean() / denom) if denom > 0 else 0.0

    rho = partial_spearman(S[:, 0], S[:, 1], S[:, 2])
    rng = np.random.default_rng(42)
    perm = np.array([
        partial_spearman(np.roll(S[:, 0], rng.integers(1, n1)), S[:, 1], S[:, 2])
        for _ in range(N_PERMUTATIONS)
    ])
    pval = float((perm >= rho).mean())
    print(f"\n[T1] n={n1}  partial Spearman(regime, fwd vol | trailing vol) "
          f"= {rho:+.3f}  perm-p={pval:.3f}")

    # ── T2: risk gate on SPY ──
    pos = oos.map(lambda s: 1.0 if s in RISK_ON else 0.0).shift(1).fillna(0.0)
    spy_oos = spy.reindex(oos.index)
    switch_cost = pos.diff().abs().fillna(0.0) * (GATE_COST_BPS_SIDE / 1e4)
    strat = pos * spy_oos - switch_cost

    def perf(r: pd.Series) -> dict:
        eq = (1 + r).cumprod()
        yrs = len(r) / 252
        cagr = eq.iloc[-1] ** (1 / yrs) - 1
        sharpe = r.mean() / r.std() * ann if r.std() > 0 else 0.0
        mdd = ((eq - eq.cummax()) / eq.cummax()).min()
        return {"cagr": 100 * cagr, "sharpe": sharpe, "mdd": 100 * mdd}

    g, b = perf(strat), perf(spy_oos)
    dd_reduction = 100 * (1 - g["mdd"] / b["mdd"])
    cagr_kept = 100 * g["cagr"] / b["cagr"] if b["cagr"] > 0 else float("nan")
    print(f"[T2] gate : CAGR={g['cagr']:+.1f}%  Sharpe={g['sharpe']:.2f}  MaxDD={g['mdd']:.1f}%")
    print(f"     B&H  : CAGR={b['cagr']:+.1f}%  Sharpe={b['sharpe']:.2f}  MaxDD={b['mdd']:.1f}%")
    print(f"     DD reduction={dd_reduction:.0f}%  CAGR kept={cagr_kept:.0f}%  "
          f"time in market={100 * pos.mean():.0f}%")

    # ── T3: label stability ──
    runs = []
    cur, run = None, 0
    for s in oos.values:
        if s == cur:
            run += 1
        else:
            if cur is not None:
                runs.append(run)
            cur, run = s, 1
    runs.append(run)
    med_run = float(np.median(runs))
    switches_yr = (len(runs) - 1) / (len(oos) / 252)
    print(f"[T3] median run={med_run:.0f} sessions  switches/yr={switches_yr:.1f}")

    # ── Descriptive: crisis detection lag ──
    print("\n[DESCRIPTIVE] first RISK-OFF/CRISIS entry near known events:")
    for name, start, end in [("COVID crash", "2020-02-19", "2020-04-30"),
                             ("2022 bear", "2022-01-03", "2022-06-30"),
                             ("2025 tariff crash", "2025-03-31", "2025-05-31")]:
        seg = oos[(oos.index >= start) & (oos.index <= end)]
        hit = seg[seg >= 2]
        crisis = seg[seg == 3]
        print(f"  {name}: RISK-OFF+ {hit.index[0].date() if len(hit) else 'never'}"
              f" | CRISIS {crisis.index[0].date() if len(crisis) else 'never'}")

    # ── Kill-list verdict ──
    print("\n── KILL-LIST ──")
    checks = [
        ("T1", f"n={n1} ≥ 150, ρ={rho:+.3f} > 0, p={pval:.3f} < 0.05",
         n1 >= 150 and rho > 0 and pval < 0.05),
        ("T2a", f"MaxDD reduction {dd_reduction:.0f}% ≥ 25%", dd_reduction >= 25),
        ("T2b", f"CAGR kept {cagr_kept:.0f}% ≥ 60%", cagr_kept >= 60),
        ("T3", f"median run {med_run:.0f} ≥ 10, switches/yr {switches_yr:.1f} ≤ 12",
         med_run >= 10 and switches_yr <= 12),
    ]
    results = {}
    for code, desc, ok in checks:
        results[code] = ok
        print(f"  {code}: {desc}  →  {'PASS' if ok else 'KILL'}")
    usable = results["T1"] and results["T3"] and results["T2a"]
    full = usable and results["T2b"]
    print(f"\n[VERDICT] {'FULLY USABLE (risk dial + gate)' if full else 'USABLE as risk dial only' if usable else 'NOT VALIDATED'}")

    pd.DataFrame({"label": oos.map(lambda s: LABELS[s])}).to_csv("oos_labels.csv")
    print("oos_labels.csv written")


if __name__ == "__main__":
    main()
