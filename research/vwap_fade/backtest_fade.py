"""
FADE study — continuation trades against the VWAP-reversion signal.

Implements PLAN.md exactly: IS/OOS split with purge & embargo, closed 3x3
parameter grid on IS only, one-shot OOS with frozen params, random-entry null
on OOS, and the pre-registered kill-list. Read PLAN.md before touching this.

Self-contained on purpose: research scripts stay frozen with the study they
belong to, so a later refactor of another study can't silently change this one.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass

import numpy as np
import pandas as pd
import yfinance as yf

# ── Signal parameters — FROZEN copies from vwap_reversion (do not tune) ─────

BAND_SD = 2.0
CLOSEPOS_LONG = 0.55      # old long signal → we fade it SHORT
CLOSEPOS_SHORT = 0.45     # old short signal → we fade it LONG
VOL_MULT = 1.5
CUMRVOL_MIN = 1.0
ATR_LEN = 14
MED_WINDOW = 20
RVOL_SESSIONS = 10
ENTRY_START, ENTRY_END = "10:00", "15:00"
LAST_EXIT_BAR = "15:55"
MAX_TRADES_PER_SIDE_PER_DAY = 2
COST_BPS_SIDE = 2.0

# ── Study design (PLAN.md §1, §4, §5) ────────────────────────────────────────

IS_FRACTION = 0.60
PURGE_SESSIONS = 1
EMBARGO_SESSIONS = 3
GRID_S = [1.0, 1.5, 2.0]  # stop multiple of ATR
GRID_T = [1.0, 1.5, 2.0]  # target multiple of ATR
MIN_IS_TRADES = 60        # K1
MIN_OOS_TRADES = 30       # K3
DECAY_FLOOR = 0.40        # K5
MIN_OOS_PF = 1.10         # K7
BASELINE_RESAMPLES = 200

DEFAULT_SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN", "META",
                   "GOOGL", "TSLA", "AMD", "SPY", "QQQ"]


# ── Data & features (identical construction to vwap_reversion) ───────────────

def load_bars(symbol: str) -> pd.DataFrame:
    df = yf.download(symbol, period="60d", interval="5m",
                     auto_adjust=False, progress=False, multi_level_index=False)
    if df.empty:
        return df
    df = df.tz_convert("America/New_York").between_time("09:30", "15:55")
    df = df[(df["Volume"] > 0) & df["Close"].notna()]
    df = df.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]]
    df["date"] = df.index.date
    df["tod"] = df.index.strftime("%H:%M")
    return df


def add_features(df: pd.DataFrame) -> pd.DataFrame:
    tp = (df["high"] + df["low"] + df["close"]) / 3
    cum_v = df.groupby("date", group_keys=False)["volume"].cumsum()
    cum_tpv = (tp * df["volume"]).groupby(df["date"]).cumsum()
    cum_tp2v = (tp * tp * df["volume"]).groupby(df["date"]).cumsum()
    df["vwap"] = cum_tpv / cum_v
    df["sigma"] = np.sqrt((cum_tp2v / cum_v - df["vwap"] ** 2).clip(lower=0))

    prev_close = df["close"].shift(1)
    tr = pd.concat([df["high"] - df["low"],
                    (df["high"] - prev_close).abs(),
                    (df["low"] - prev_close).abs()], axis=1).max(axis=1)
    df["atr"] = tr.ewm(alpha=1 / ATR_LEN, adjust=False).mean()

    df["med_vol"] = df["volume"].rolling(MED_WINDOW).median().shift(1)
    rng = df["high"] - df["low"]

    pivot = df.pivot_table(index="date", columns="tod", values="volume", aggfunc="sum")
    baseline = pivot.fillna(0).cumsum(axis=1).rolling(RVOL_SESSIONS, min_periods=5).mean().shift(1)
    key = pd.MultiIndex.from_arrays([df["date"], df["tod"]])
    df["cum_rvol"] = cum_v.values / baseline.stack().reindex(key).values

    df["close_pos"] = np.where(rng > 0, (df["close"] - df["low"]) / rng, 0.5)
    return df


def fade_signal_mask(df: pd.DataFrame, fade_side: str) -> pd.Series:
    """fade_side='short' fades the old LONG signal; 'long' fades the old SHORT."""
    lower = df["vwap"] - BAND_SD * df["sigma"]
    upper = df["vwap"] + BAND_SD * df["sigma"]
    if fade_side == "short":
        loc = (df["low"] <= lower) & (df["close"] > lower)
        beh = df["close_pos"] >= CLOSEPOS_LONG
    else:
        loc = (df["high"] >= upper) & (df["close"] < upper)
        beh = df["close_pos"] <= CLOSEPOS_SHORT
    mask = (loc & beh
            & (df["volume"] >= VOL_MULT * df["med_vol"])
            & (df["cum_rvol"] >= CUMRVOL_MIN)
            & (df["tod"] >= ENTRY_START) & (df["tod"] <= ENTRY_END))
    return mask & df[["vwap", "sigma", "atr", "med_vol", "cum_rvol"]].notna().all(axis=1)


# ── Simulation with symmetric ATR bracket ────────────────────────────────────

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
             stop_mult: float, tgt_mult: float) -> list[Trade]:
    trades: list[Trade] = []
    idx = df.index
    day_counts: dict = {}
    in_pos_until = -1
    sign = 1 if side == "long" else -1

    for t in np.flatnonzero(signals.values):
        if t + 1 >= len(df) or t <= in_pos_until:
            continue
        sig_bar, entry_bar = df.iloc[t], df.iloc[t + 1]
        if entry_bar["date"] != sig_bar["date"]:
            continue
        day = sig_bar["date"]
        if day_counts.get((day, side), 0) >= MAX_TRADES_PER_SIDE_PER_DAY:
            continue

        entry = entry_bar["open"]
        stop = entry - sign * stop_mult * sig_bar["atr"]
        target = entry + sign * tgt_mult * sig_bar["atr"]

        exit_price = exit_reason = exit_time = None
        u = t + 1
        while u < len(df) and df.iloc[u]["date"] == day:
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
            if bar["tod"] >= LAST_EXIT_BAR:
                exit_price, exit_reason, exit_time = bar["close"], "time", idx[u]
                break
            u += 1
        if exit_price is None:
            bar = df.iloc[u - 1]
            exit_price, exit_reason, exit_time = bar["close"], "time", idx[u - 1]
            u -= 1

        trades.append(Trade(symbol, side, idx[t + 1], entry, exit_time, exit_price, exit_reason))
        day_counts[(day, side)] = day_counts.get((day, side), 0) + 1
        in_pos_until = u
    return trades


# ── IS / OOS split with purge & embargo (PLAN.md §1) ─────────────────────────

def split_sessions(df: pd.DataFrame) -> tuple[set, set]:
    dates = sorted(df["date"].unique())
    is_end = int(len(dates) * IS_FRACTION)
    oos_start = is_end + PURGE_SESSIONS + EMBARGO_SESSIONS
    return set(dates[:is_end]), set(dates[oos_start:])


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
    ap.add_argument("--symbols", nargs="+", default=DEFAULT_SYMBOLS)
    ap.add_argument("--is-only", action="store_true")
    # Kill-list threshold overrides (v2 amendments live in PLAN_V2.md)
    ap.add_argument("--min-is", type=int, default=MIN_IS_TRADES)
    ap.add_argument("--min-oos", type=int, default=MIN_OOS_TRADES)
    ap.add_argument("--null-pct", type=float, default=95.0)
    ap.add_argument("--min-pf", type=float, default=MIN_OOS_PF)
    args = ap.parse_args()
    rng = np.random.default_rng(42)

    frames = {}
    for symbol in args.symbols:
        df = load_bars(symbol)
        if df.empty or len(df) < 200:
            print(f"{symbol}: insufficient data, skipped")
            continue
        frames[symbol] = add_features(df)

    # ── Phase 1: IS grid search ──
    grid_results = {}
    for S in GRID_S:
        for T in GRID_T:
            trades = []
            for symbol, df in frames.items():
                is_dates, _ = split_sessions(df)
                sub = df[df["date"].isin(is_dates)]
                for side in ("short", "long"):
                    trades += simulate(sub, fade_signal_mask(sub, side), side, symbol, S, T)
            grid_results[(S, T)] = stats(trades)

    print("── IS grid (net expectancy bps / n trades) ──")
    for (S, T), st in sorted(grid_results.items()):
        print(f"  S={S:.1f} T={T:.1f}: exp={st['exp']:+7.1f}  n={st['n']:3d}  "
              f"win%={st['win']:.0f}  PF={st['pf']:.2f}")

    eligible = {k: v for k, v in grid_results.items() if v["n"] >= args.min_is}
    if not eligible:
        print(f"\n[KILL K1] no grid point reaches {args.min_is} IS trades — study dead")
        return
    best_key = max(eligible, key=lambda k: (eligible[k]["exp"], eligible[k]["n"]))
    best = eligible[best_key]
    if best["exp"] <= 0:
        print(f"\n[KILL K2] best IS expectancy {best['exp']:+.1f}bps ≤ 0 — "
              f"hypothesis dead in-sample, OOS not run")
        return
    S, T = best_key
    print(f"\n[FROZEN] S={S} T={T}  (IS: exp={best['exp']:+.1f}bps n={best['n']} PF={best['pf']:.2f})")
    if args.is_only:
        print("(--is-only: stopping before OOS)")
        return

    # ── Phase 2: one-shot OOS with frozen params ──
    oos_trades: list[Trade] = []
    per_symbol_n = {}
    for symbol, df in frames.items():
        _, oos_dates = split_sessions(df)
        sub = df[df["date"].isin(oos_dates)]
        counts = {}
        for side in ("short", "long"):
            tr = simulate(sub, fade_signal_mask(sub, side), side, symbol, S, T)
            oos_trades += tr
            counts[side] = len(tr)
        per_symbol_n[symbol] = counts

    oos = stats(oos_trades)
    print(f"\n── OOS (one-shot) ──  n={oos['n']}  exp={oos['exp']:+.1f}bps  "
          f"win%={oos['win']:.0f}  PF={oos['pf']:.2f}")

    # ── Phase 3: OOS random-entry null ──
    null_exp = []
    for _ in range(BASELINE_RESAMPLES):
        bps = []
        for symbol, df in frames.items():
            _, oos_dates = split_sessions(df)
            sub = df[df["date"].isin(oos_dates)]
            tod_ok = ((sub["tod"] >= ENTRY_START) & (sub["tod"] <= ENTRY_END)
                      & sub["atr"].notna())
            elig = np.flatnonzero(tod_ok.values)
            for side, n in per_symbol_n[symbol].items():
                if n == 0 or len(elig) == 0:
                    continue
                fake = pd.Series(False, index=sub.index)
                fake.iloc[rng.choice(elig, size=min(n, len(elig)), replace=False)] = True
                bps += [t.net_bps for t in simulate(sub, fake, side, symbol, S, T)]
        if bps:
            null_exp.append(float(np.mean(bps)))
    null_arr = np.array(null_exp)
    p95 = float(np.percentile(null_arr, args.null_pct)) if len(null_arr) else float("nan")

    # ── Phase 4: kill-list verdict ──
    print("\n── KILL-LIST ──")
    checks = [
        ("K3", f"OOS n={oos['n']} ≥ {args.min_oos}", oos["n"] >= args.min_oos),
        ("K4", f"OOS exp {oos['exp']:+.1f} > 0", oos["exp"] > 0),
        ("K5", f"OOS exp ≥ {DECAY_FLOOR:.0%} of IS ({DECAY_FLOOR * best['exp']:+.1f})",
         oos["exp"] >= DECAY_FLOOR * best["exp"]),
        ("K6", f"OOS exp {oos['exp']:+.1f} > null p{args.null_pct:g} {p95:+.1f}", oos["exp"] > p95),
        ("K7", f"OOS PF {oos['pf']:.2f} ≥ {args.min_pf}", oos["pf"] >= args.min_pf),
    ]
    alive = True
    for code, desc, ok in checks:
        print(f"  {code}: {desc}  →  {'PASS' if ok else 'KILL'}")
        alive &= ok
    print(f"\n[VERDICT] {'SURVIVES — worth testing on new data/regimes' if alive else 'DEAD'}")

    pd.DataFrame([vars(t) | {"net_bps": t.net_bps} for t in oos_trades]).to_csv(
        "trades_oos.csv", index=False)
    print("trades_oos.csv written")


if __name__ == "__main__":
    main()
