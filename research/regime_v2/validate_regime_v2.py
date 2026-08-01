"""
Regime v2 — multivariate HMM (6 features) + hysteresis, walk-forward validated.

Implements PLAN.md exactly. Causal labeling (prefix Viterbi), purge & embargo,
one-shot. Compare against the v1 corr-only baseline recorded in
../regime_validation/RESULTS.md.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import yfinance as yf

SECTORS = ["XLK", "XLF", "XLV", "XLE", "XLI", "XLY", "XLP", "XLU", "XLB"]
LABELS = ["DIVERGENT", "TRENDING", "RISK-OFF", "CRISIS"]

CORR_WINDOW = 63
VOL_WINDOW = 21
CREDIT_WINDOW = 63
DMA = 200

N_STATES = 4
HYSTERESIS = 5            # consecutive days required to switch label
VITERBI_CONTEXT = 252     # causal labeling window

INITIAL_TRAIN = 1512      # ~6y
PURGE = 63
EMBARGO = 21
TEST_BLOCK = 126

VOL_HORIZON = 21
GATE_COST_BPS_SIDE = 1.0
N_PERMUTATIONS = 1000
RISK_ON = {0, 1}

# v1 baseline (recorded results — K0 comparison)
V1 = {"t1_p": 0.299, "dd_red": 38.0, "cagr_kept": 27.0, "med_run": 8.0}


def build_features() -> tuple[pd.DataFrame, pd.Series]:
    tickers = SECTORS + ["SPY", "^VIX", "HYG", "IEF"]
    raw = yf.download(tickers, start="2004-01-01", auto_adjust=True,
                      progress=False)["Close"]
    spy_ret = raw["SPY"].pct_change()

    sec = raw[SECTORS].pct_change().dropna()
    mask = np.triu(np.ones((len(SECTORS), len(SECTORS)), dtype=bool), k=1)
    corr = {}
    vals = sec.values
    for i in range(CORR_WINDOW, len(sec)):
        c = np.corrcoef(vals[i - CORR_WINDOW:i].T)
        corr[sec.index[i]] = float(np.abs(c[mask]).mean())

    f = pd.DataFrame(index=raw.index)
    f["corr"] = pd.Series(corr)
    f["rvol"] = spy_ret.rolling(VOL_WINDOW).std() * np.sqrt(252)
    f["vix"] = raw["^VIX"]
    f["credit"] = (raw["HYG"] / raw["IEF"]).pct_change(CREDIT_WINDOW)
    above = raw[SECTORS] > raw[SECTORS].rolling(DMA).mean()
    f["breadth"] = above.mean(axis=1)
    f["trend"] = raw["SPY"] / raw["SPY"].rolling(DMA).mean() - 1
    f = f.dropna()
    return f, spy_ret.reindex(f.index).fillna(0.0)


def order_states(model) -> np.ndarray:
    """Map raw HMM states -> risk order (ascending mean of rvol dim = col 1)."""
    order = np.argsort(model.means_[:, 1])
    inv = np.empty(N_STATES, dtype=int)
    inv[order] = np.arange(N_STATES)
    return inv


def main() -> None:
    from hmmlearn.hmm import GaussianHMM

    F, spy = build_features()
    print(f"features: {len(F)} sessions ({F.index[0].date()} → {F.index[-1].date()})")

    labels_raw = pd.Series(index=F.index, dtype=float)
    fold = 0
    train_end = INITIAL_TRAIN
    while train_end + PURGE + EMBARGO < len(F):
        test_lo = train_end + PURGE + EMBARGO
        test_hi = min(test_lo + TEST_BLOCK, len(F))

        mu = F.values[:train_end].mean(axis=0)
        sd = F.values[:train_end].std(axis=0)
        X = (F.values - mu) / sd

        model = GaussianHMM(n_components=N_STATES, covariance_type="full",
                            n_iter=500, random_state=42, tol=1e-4)
        model.fit(X[:train_end])
        inv = order_states(model)

        for t in range(test_lo, test_hi):
            lo = max(0, t - VITERBI_CONTEXT + 1)
            seq = model.predict(X[lo:t + 1])
            labels_raw.iloc[t] = inv[seq[-1]]

        fold += 1
        train_end += TEST_BLOCK

    oos_raw = labels_raw.dropna().astype(int)

    # Hysteresis: switch only after K consecutive days of the new state
    smoothed, cur, streak, cand = [], int(oos_raw.iloc[0]), 0, None
    for s in oos_raw.values:
        if s == cur:
            cand, streak = None, 0
        elif s == cand:
            streak += 1
            if streak >= HYSTERESIS:
                cur, cand, streak = s, None, 0
        else:
            cand, streak = s, 1
        smoothed.append(cur)
    oos = pd.Series(smoothed, index=oos_raw.index)

    print(f"folds: {fold}, OOS: {len(oos)} sessions "
          f"({oos.index[0].date()} → {oos.index[-1].date()})")
    dist = oos.value_counts(normalize=True).sort_index()
    print("regime distribution:",
          {LABELS[k]: f"{100 * v:.0f}%" for k, v in dist.items()})

    ann = np.sqrt(252)
    trailing = spy.rolling(VOL_HORIZON).std() * ann
    forward = trailing.shift(-VOL_HORIZON)

    # ── T1 ──
    samples = []
    for t in range(0, len(oos) - VOL_HORIZON, VOL_HORIZON):
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
    print(f"\n[T1] n={n1}  partial ρ={rho:+.3f}  perm-p={pval:.3f}  (v1: p={V1['t1_p']})")

    # ── T2 ──
    pos = oos.map(lambda s: 1.0 if s in RISK_ON else 0.0).shift(1).fillna(0.0)
    spy_oos = spy.reindex(oos.index)
    strat = pos * spy_oos - pos.diff().abs().fillna(0.0) * (GATE_COST_BPS_SIDE / 1e4)

    def perf(r: pd.Series) -> dict:
        eq = (1 + r).cumprod()
        yrs = len(r) / 252
        return {"cagr": 100 * (eq.iloc[-1] ** (1 / yrs) - 1),
                "sharpe": r.mean() / r.std() * ann if r.std() > 0 else 0.0,
                "mdd": 100 * ((eq - eq.cummax()) / eq.cummax()).min()}

    g, b = perf(strat), perf(spy_oos)
    dd_red = 100 * (1 - g["mdd"] / b["mdd"])
    kept = 100 * g["cagr"] / b["cagr"] if b["cagr"] > 0 else float("nan")
    print(f"[T2] gate: CAGR={g['cagr']:+.1f}% Sharpe={g['sharpe']:.2f} MaxDD={g['mdd']:.1f}%")
    print(f"     B&H : CAGR={b['cagr']:+.1f}% Sharpe={b['sharpe']:.2f} MaxDD={b['mdd']:.1f}%")
    print(f"     DD reduction={dd_red:.0f}% (v1 {V1['dd_red']:.0f}%)  "
          f"CAGR kept={kept:.0f}% (v1 {V1['cagr_kept']:.0f}%)  "
          f"in market={100 * pos.mean():.0f}%")

    # ── T3 ──
    runs, cur2, run = [], None, 0
    for s in oos.values:
        if s == cur2:
            run += 1
        else:
            if cur2 is not None:
                runs.append(run)
            cur2, run = s, 1
    runs.append(run)
    med_run = float(np.median(runs))
    sw_yr = (len(runs) - 1) / (len(oos) / 252)
    print(f"[T3] median run={med_run:.0f}  switches/yr={sw_yr:.1f}  (v1: 8 / 9.5)")

    print("\n[DESCRIPTIVE] detection near known events:")
    for name, start, end in [("COVID crash", "2020-02-19", "2020-04-30"),
                             ("2022 bear", "2022-01-03", "2022-06-30"),
                             ("2025 tariff crash", "2025-03-31", "2025-05-31")]:
        seg = oos[(oos.index >= start) & (oos.index <= end)]
        hit = seg[seg >= 2]
        print(f"  {name}: RISK-OFF+ {hit.index[0].date() if len(hit) else 'never'}")

    print("\n── KILL-LIST ──")
    checks = [
        ("T1", f"n={n1}≥150, ρ={rho:+.3f}>0, p={pval:.3f}<0.05",
         n1 >= 150 and rho > 0 and pval < 0.05),
        ("T2a", f"DD reduction {dd_red:.0f}% ≥ 25%", dd_red >= 25),
        ("T2b", f"CAGR kept {kept:.0f}% ≥ 60%", kept >= 60),
        ("T3", f"median run {med_run:.0f} ≥ 10, {sw_yr:.1f} ≤ 12/yr",
         med_run >= 10 and sw_yr <= 12),
        ("K0", f"beats v1 on its failures: p {pval:.3f}<{V1['t1_p']}, "
               f"kept {kept:.0f}%>{V1['cagr_kept']:.0f}%, run {med_run:.0f}>{V1['med_run']:.0f}",
         pval < V1["t1_p"] and kept > V1["cagr_kept"] and med_run > V1["med_run"]),
    ]
    res = {}
    for code, desc, ok in checks:
        res[code] = ok
        print(f"  {code}: {desc}  →  {'PASS' if ok else 'KILL'}")
    if all(res.values()):
        verdict = "FULLY USABLE"
    elif res["T2a"] and res["T3"] and res["K0"]:
        verdict = "USABLE AS RISK DIAL (improved over v1)"
    else:
        verdict = "DEAD"
    print(f"\n[VERDICT] {verdict}")

    pd.DataFrame({"label": oos.map(lambda s: LABELS[s])}).to_csv("oos_labels_v2.csv")
    print("oos_labels_v2.csv written")


if __name__ == "__main__":
    main()
