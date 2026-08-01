"""
Daily band-rejection reversal — walk-forward backtest with purge & embargo.

Implements PLAN.md exactly. One-shot: run once, record the verdict in
RESULTS.md whether it lives or dies. Self-contained by design.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass

import numpy as np
import pandas as pd
import yfinance as yf

# ── Signal (frozen per PLAN.md §2) ───────────────────────────────────────────

BAND_SD = 2.0
CLOSEPOS_LONG = 0.55
CLOSEPOS_SHORT = 0.45
VOL_MULT = 1.5
VWAP_WINDOW = 20
ATR_LEN = 14
MED_WINDOW = 20

# ── Exits & costs (PLAN.md §3) ───────────────────────────────────────────────

HOLD_DAYS = 10
COST_BPS_SIDE = 3.0
GRID_S = [1.0, 1.5, 2.0]
GRID_T = [1.0, 1.5, 2.0]

# ── Walk-forward design (PLAN.md §4) ─────────────────────────────────────────

TRAIN_SESSIONS = 504
PURGE_SESSIONS = 10
EMBARGO_SESSIONS = 5
TEST_SESSIONS = 126
MIN_TRAIN_TRADES = 100

# ── Kill-list (PLAN.md §6) ───────────────────────────────────────────────────

MIN_FOLDS = 10           # K1
MIN_OOS_TRADES = 300     # K2
MIN_OOS_PF = 1.15        # K5
BASELINE_RESAMPLES = 200

SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AMD",
           "SPY", "QQQ", "JPM", "BAC", "GS", "MS", "V", "MA", "XOM", "CVX",
           "COP", "UNH", "LLY", "JNJ", "PFE", "MRK", "WMT", "COST", "HD",
           "DIS", "NKE", "MCD", "CRM", "ORCL", "ADBE", "AVGO", "QCOM", "MU",
           "INTC", "NFLX", "IWM", "XLF"]


# ── Data & features ──────────────────────────────────────────────────────────

def load_daily(symbol: str) -> pd.DataFrame:
    df = yf.download(symbol, period="10y", interval="1d",
                     auto_adjust=True, progress=False, multi_level_index=False)
    if df.empty:
        return df
    df = df[(df["Volume"] > 0) & df["Close"].notna()]
    df = df.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]]

    tp = (df["high"] + df["low"] + df["close"]) / 3
    tpv = (tp * df["volume"]).rolling(VWAP_WINDOW).sum()
    tp2v = (tp * tp * df["volume"]).rolling(VWAP_WINDOW).sum()
    v = df["volume"].rolling(VWAP_WINDOW).sum()
    df["vwap"] = tpv / v
    df["sigma"] = np.sqrt((tp2v / v - df["vwap"] ** 2).clip(lower=0))

    prev_close = df["close"].shift(1)
    tr = pd.concat([df["high"] - df["low"],
                    (df["high"] - prev_close).abs(),
                    (df["low"] - prev_close).abs()], axis=1).max(axis=1)
    df["atr"] = tr.ewm(alpha=1 / ATR_LEN, adjust=False).mean()

    df["med_vol"] = df["volume"].rolling(MED_WINDOW).median().shift(1)
    rng = df["high"] - df["low"]
    df["close_pos"] = np.where(rng > 0, (df["close"] - df["low"]) / rng, 0.5)
    return df


def signal_mask(df: pd.DataFrame, side: str) -> pd.Series:
    lower = df["vwap"] - BAND_SD * df["sigma"]
    upper = df["vwap"] + BAND_SD * df["sigma"]
    if side == "long":
        m = (df["low"] <= lower) & (df["close"] > lower) & (df["close_pos"] >= CLOSEPOS_LONG)
    else:
        m = (df["high"] >= upper) & (df["close"] < upper) & (df["close_pos"] <= CLOSEPOS_SHORT)
    m &= df["volume"] >= VOL_MULT * df["med_vol"]
    return m & df[["vwap", "sigma", "atr", "med_vol"]].notna().all(axis=1)


# ── Simulation ───────────────────────────────────────────────────────────────

@dataclass
class Trade:
    symbol: str
    side: str
    entry_time: pd.Timestamp
    entry: float
    exit_time: pd.Timestamp
    exit: float
    exit_reason: str

    @property
    def net_bps(self) -> float:
        sign = 1 if self.side == "long" else -1
        return sign * (self.exit / self.entry - 1) * 1e4 - 2 * COST_BPS_SIDE


def simulate(df: pd.DataFrame, signals: pd.Series, side: str, symbol: str,
             S: float, T: float) -> list[Trade]:
    """Bracket exits over daily bars; positions never overlap per symbol."""
    trades: list[Trade] = []
    idx = df.index
    in_pos_until = -1
    sign = 1 if side == "long" else -1

    for t in np.flatnonzero(signals.values):
        if t + 1 >= len(df) or t <= in_pos_until:
            continue
        sig_bar = df.iloc[t]
        entry = df.iloc[t + 1]["open"]
        stop = entry - sign * S * sig_bar["atr"]
        target = entry + sign * T * sig_bar["atr"]

        exit_price = exit_reason = exit_time = None
        last_u = min(t + HOLD_DAYS, len(df) - 1)
        for u in range(t + 1, last_u + 1):
            bar = df.iloc[u]
            stopped = bar["low"] <= stop if side == "long" else bar["high"] >= stop
            if stopped:
                gap = bar["open"] < stop if side == "long" else bar["open"] > stop
                exit_price = bar["open"] if gap else stop
                exit_reason, exit_time = "stop", idx[u]
                break
            hit = bar["high"] >= target if side == "long" else bar["low"] <= target
            if hit:
                gap = bar["open"] >= target if side == "long" else bar["open"] <= target
                exit_price = bar["open"] if gap else target
                exit_reason, exit_time = "target", idx[u]
                break
        if exit_price is None:
            bar = df.iloc[last_u]
            exit_price, exit_reason, exit_time, u = bar["close"], "time", idx[last_u], last_u

        trades.append(Trade(symbol, side, idx[t + 1], entry, exit_time, exit_price, exit_reason))
        in_pos_until = u
    return trades


def run_universe(frames: dict, date_lo, date_hi, S: float, T: float) -> list[Trade]:
    """Signals restricted to [date_lo, date_hi); exits may run past date_hi
    only within HOLD_DAYS (train/test gap ≥ purge covers this by design)."""
    trades = []
    for symbol, df in frames.items():
        window = (df.index >= date_lo) & (df.index < date_hi)
        for side in ("long", "short"):
            sig = signal_mask(df, side) & window
            trades += simulate(df, sig, side, symbol, S, T)
    return trades


# ── Metrics ──────────────────────────────────────────────────────────────────

def stats(trades: list[Trade]) -> dict:
    if not trades:
        return {"n": 0, "exp": 0.0, "pf": 0.0, "win": 0.0}
    bps = np.array([t.net_bps for t in trades])
    wins, losses = bps[bps > 0], bps[bps <= 0]
    pf = wins.sum() / abs(losses.sum()) if losses.sum() != 0 else float("inf")
    return {"n": len(bps), "exp": float(bps.mean()), "pf": float(pf),
            "win": 100 * len(wins) / len(bps)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-baseline", action="store_true")
    args = ap.parse_args()
    rng = np.random.default_rng(42)

    frames = {}
    for symbol in SYMBOLS:
        df = load_daily(symbol)
        if len(df) < TRAIN_SESSIONS + TEST_SESSIONS:
            print(f"{symbol}: only {len(df)} sessions, skipped")
            continue
        frames[symbol] = df
    print(f"universe loaded: {len(frames)} symbols")

    # Master calendar = union of all trading dates
    calendar = sorted(set().union(*[set(df.index) for df in frames.values()]))
    gap = PURGE_SESSIONS + EMBARGO_SESSIONS

    oos_trades: list[Trade] = []
    fold_rows = []
    fold_null_meta = []  # (test_lo, test_hi, S, T, per-symbol-side counts)

    fold = 0
    start = 0
    while start + TRAIN_SESSIONS + gap + TEST_SESSIONS <= len(calendar):
        train_lo, train_hi = calendar[start], calendar[start + TRAIN_SESSIONS]
        test_lo = calendar[start + TRAIN_SESSIONS + gap]
        test_hi = calendar[start + TRAIN_SESSIONS + gap + TEST_SESSIONS - 1] + pd.Timedelta(days=1)
        fold += 1

        # Grid on train
        best_key, best_exp, best_n = None, -1e9, 0
        for S in GRID_S:
            for T in GRID_T:
                st = stats(run_universe(frames, train_lo, train_hi, S, T))
                if st["n"] >= MIN_TRAIN_TRADES and (st["exp"], st["n"]) > (best_exp, best_n):
                    best_key, best_exp, best_n = (S, T), st["exp"], st["n"]
        if best_key is None:
            fold_rows.append({"fold": fold, "status": "skipped (train n < 100)"})
            start += TEST_SESSIONS
            continue

        S, T = best_key
        test_trades = run_universe(frames, test_lo, test_hi, S, T)
        st = stats(test_trades)
        oos_trades += test_trades
        fold_rows.append({"fold": fold, "train_exp": best_exp, "S": S, "T": T,
                          "test_n": st["n"], "test_exp": st["exp"], "test_pf": st["pf"]})
        counts = {}
        for tr in test_trades:
            counts[(tr.symbol, tr.side)] = counts.get((tr.symbol, tr.side), 0) + 1
        fold_null_meta.append((test_lo, test_hi, S, T, counts))
        print(f"fold {fold:2d}: {str(test_lo.date())}→ S={S} T={T}  "
              f"train_exp={best_exp:+6.1f}  test: n={st['n']:3d} exp={st['exp']:+6.1f} pf={st['pf']:.2f}")
        start += TEST_SESSIONS

    valid_folds = [r for r in fold_rows if "test_n" in r]
    oos = stats(oos_trades)
    pos_folds = sum(1 for r in valid_folds if r["test_exp"] > 0)
    long_st = stats([t for t in oos_trades if t.side == "long"])
    short_st = stats([t for t in oos_trades if t.side == "short"])

    print(f"\n── POOLED OOS ──  n={oos['n']}  exp={oos['exp']:+.1f}bps  "
          f"win%={oos['win']:.0f}  PF={oos['pf']:.2f}")
    print(f"  long:  n={long_st['n']}  exp={long_st['exp']:+.1f}  PF={long_st['pf']:.2f}")
    print(f"  short: n={short_st['n']}  exp={short_st['exp']:+.1f}  PF={short_st['pf']:.2f}")
    print(f"  folds positive: {pos_folds}/{len(valid_folds)}")

    # Null baseline: random entries per fold, same counts/params/exits
    p95 = float("nan")
    if not args.no_baseline and oos_trades:
        null_exp = []
        for _ in range(BASELINE_RESAMPLES):
            bps = []
            for test_lo, test_hi, S, T, counts in fold_null_meta:
                for (symbol, side), n in counts.items():
                    df = frames[symbol]
                    elig = np.flatnonzero(((df.index >= test_lo) & (df.index < test_hi)
                                           & df["atr"].notna()).values)
                    if len(elig) == 0:
                        continue
                    fake = pd.Series(False, index=df.index)
                    fake.iloc[rng.choice(elig, size=min(n, len(elig)), replace=False)] = True
                    bps += [t.net_bps for t in simulate(df, fake, side, symbol, S, T)]
            if bps:
                null_exp.append(float(np.mean(bps)))
        null_arr = np.array(null_exp)
        p95 = float(np.percentile(null_arr, 95))
        print(f"\n[NULL] mean={null_arr.mean():+.1f}bps  p95={p95:+.1f}bps")

    print("\n── KILL-LIST ──")
    checks = [
        ("K1", f"valid folds {len(valid_folds)} ≥ {MIN_FOLDS}", len(valid_folds) >= MIN_FOLDS),
        ("K2", f"OOS n {oos['n']} ≥ {MIN_OOS_TRADES}", oos["n"] >= MIN_OOS_TRADES),
        ("K3", f"OOS exp {oos['exp']:+.1f} > 0", oos["exp"] > 0),
        ("K4", f"OOS exp {oos['exp']:+.1f} > null p95 {p95:+.1f}",
         oos["exp"] > p95 if not np.isnan(p95) else False),
        ("K5", f"OOS PF {oos['pf']:.2f} ≥ {MIN_OOS_PF}", oos["pf"] >= MIN_OOS_PF),
        ("K6", f"positive folds {pos_folds}/{len(valid_folds)} > 50%",
         pos_folds > len(valid_folds) / 2 if valid_folds else False),
    ]
    alive = True
    for code, desc, ok in checks:
        print(f"  {code}: {desc}  →  {'PASS' if ok else 'KILL'}")
        alive &= ok
    print(f"\n[VERDICT] {'SURVIVES — next: point-in-time universe + slippage model' if alive else 'DEAD'}")

    pd.DataFrame([vars(t) | {"net_bps": t.net_bps} for t in oos_trades]).to_csv(
        "trades_oos.csv", index=False)
    pd.DataFrame(fold_rows).to_csv("folds.csv", index=False)
    print("trades_oos.csv, folds.csv written")


if __name__ == "__main__":
    main()
