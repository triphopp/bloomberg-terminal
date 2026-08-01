"""
VWAP Band Reversion + Absorption backtest.

Implements STRATEGY.md exactly — read that first. Entry/exit rules, costs,
and acceptance criteria are pre-registered there; do not tune after seeing
results without noting it.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass

import numpy as np
import pandas as pd
import yfinance as yf

# ── Parameters (mirror STRATEGY.md; change there first) ─────────────────────

BAND_SD = 2.0
CLOSEPOS_LONG = 0.55
CLOSEPOS_SHORT = 0.45
VOL_MULT = 1.5
RANGE_MULT = 0.9          # STRICT variant only
CUMRVOL_MIN = 1.0
ATR_LEN = 14
STOP_ATR = 1.5
MED_WINDOW = 20
RVOL_SESSIONS = 10
COST_BPS_SIDE = 2.0
MAX_TRADES_PER_SIDE_PER_DAY = 2
ENTRY_START, ENTRY_END = "10:00", "15:00"
LAST_EXIT_BAR = "15:55"
BASELINE_RESAMPLES = 200

DEFAULT_SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN", "META",
                   "GOOGL", "TSLA", "AMD", "SPY", "QQQ"]


# ── Data & features ──────────────────────────────────────────────────────────

def load_bars(symbol: str) -> pd.DataFrame:
    df = yf.download(symbol, period="60d", interval="5m",
                     auto_adjust=False, progress=False, multi_level_index=False)
    if df.empty:
        return df
    df = df.tz_convert("America/New_York")
    df = df.between_time("09:30", "15:55")           # regular session bars only
    df = df[(df["Volume"] > 0) & df["Close"].notna()]
    df = df.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]]
    df["date"] = df.index.date
    df["tod"] = df.index.strftime("%H:%M")
    return df


def add_features(df: pd.DataFrame) -> pd.DataFrame:
    tp = (df["high"] + df["low"] + df["close"]) / 3

    # Session-anchored VWAP and volume-weighted sigma
    g = df.groupby("date", group_keys=False)
    cum_v = g["volume"].cumsum()
    cum_tpv = (tp * df["volume"]).groupby(df["date"]).cumsum()
    cum_tp2v = (tp * tp * df["volume"]).groupby(df["date"]).cumsum()
    df["vwap"] = cum_tpv / cum_v
    df["sigma"] = np.sqrt((cum_tp2v / cum_v - df["vwap"] ** 2).clip(lower=0))

    # Wilder ATR, continuous across sessions
    prev_close = df["close"].shift(1)
    tr = pd.concat([df["high"] - df["low"],
                    (df["high"] - prev_close).abs(),
                    (df["low"] - prev_close).abs()], axis=1).max(axis=1)
    df["atr"] = tr.ewm(alpha=1 / ATR_LEN, adjust=False).mean()

    # Rolling medians of the PRIOR window (shift so bar t is excluded)
    df["med_vol"] = df["volume"].rolling(MED_WINDOW).median().shift(1)
    rng = df["high"] - df["low"]
    df["range"] = rng
    df["med_range"] = rng.rolling(MED_WINDOW).median().shift(1)

    # cumRVOL: cumulative session volume vs mean at same time-of-day over
    # the prior RVOL_SESSIONS sessions (baseline shifted — no lookahead)
    pivot = df.pivot_table(index="date", columns="tod", values="volume", aggfunc="sum")
    cum_profile = pivot.fillna(0).cumsum(axis=1)
    baseline = cum_profile.rolling(RVOL_SESSIONS, min_periods=5).mean().shift(1)
    base_long = baseline.stack().rename("rvol_base")
    key = pd.MultiIndex.from_arrays([df["date"], df["tod"]])
    df["cum_rvol"] = (cum_v.values / base_long.reindex(key).values)

    df["close_pos"] = np.where(rng > 0, (df["close"] - df["low"]) / rng, 0.5)
    return df


# ── Signal generation ────────────────────────────────────────────────────────

def signal_mask(df: pd.DataFrame, side: str, strict: bool) -> pd.Series:
    lower = df["vwap"] - BAND_SD * df["sigma"]
    upper = df["vwap"] + BAND_SD * df["sigma"]

    if side == "long":
        loc = (df["low"] <= lower) & (df["close"] > lower)          # L1 + L2
        beh = df["close_pos"] >= CLOSEPOS_LONG                      # L3
    else:
        loc = (df["high"] >= upper) & (df["close"] < upper)
        beh = df["close_pos"] <= CLOSEPOS_SHORT

    effort = df["volume"] >= VOL_MULT * df["med_vol"]               # L4
    ctx = df["cum_rvol"] >= CUMRVOL_MIN                             # L5
    tod = (df["tod"] >= ENTRY_START) & (df["tod"] <= ENTRY_END)     # L6
    mask = loc & beh & effort & ctx & tod

    if strict:
        compressed = df["range"] <= RANGE_MULT * df["med_range"]
        mask &= compressed | compressed.shift(1, fill_value=False)

    return mask & df[["vwap", "sigma", "atr", "med_vol", "cum_rvol"]].notna().all(axis=1)


# ── Trade simulation ─────────────────────────────────────────────────────────

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
    def gross_bps(self) -> float:
        sign = 1 if self.side == "long" else -1
        return sign * (self.exit / self.entry - 1) * 1e4

    @property
    def net_bps(self) -> float:
        return self.gross_bps - 2 * COST_BPS_SIDE


def simulate(df: pd.DataFrame, signals: pd.Series, side: str, symbol: str) -> list[Trade]:
    trades: list[Trade] = []
    idx = df.index
    sig_positions = np.flatnonzero(signals.values)
    day_counts: dict = {}
    in_pos_until = -1
    sign = 1 if side == "long" else -1

    for t in sig_positions:
        if t + 1 >= len(df) or t <= in_pos_until:
            continue
        sig_bar = df.iloc[t]
        entry_bar = df.iloc[t + 1]
        if entry_bar["date"] != sig_bar["date"]:
            continue                                   # signal on last bar of day
        day = sig_bar["date"]
        if day_counts.get((day, side), 0) >= MAX_TRADES_PER_SIDE_PER_DAY:
            continue

        entry = entry_bar["open"]
        stop = entry - sign * STOP_ATR * sig_bar["atr"]

        exit_price = exit_reason = None
        exit_time = None
        u = t + 1
        while u < len(df) and df.iloc[u]["date"] == day:
            bar = df.iloc[u]
            # 1) stop first (conservative on same-bar conflicts)
            stopped = bar["low"] <= stop if side == "long" else bar["high"] >= stop
            if stopped:
                gap_through = bar["open"] < stop if side == "long" else bar["open"] > stop
                exit_price = bar["open"] if gap_through else stop
                exit_reason, exit_time = "stop", idx[u]
                break
            # 2) target: touch session VWAP
            hit = bar["high"] >= bar["vwap"] if side == "long" else bar["low"] <= bar["vwap"]
            if hit:
                gapped_in = bar["open"] >= bar["vwap"] if side == "long" else bar["open"] <= bar["vwap"]
                exit_price = bar["open"] if gapped_in else bar["vwap"]
                exit_reason, exit_time = "target", idx[u]
                break
            # 3) time stop
            if bar["tod"] >= LAST_EXIT_BAR:
                exit_price, exit_reason, exit_time = bar["close"], "time", idx[u]
                break
            u += 1
        if exit_price is None:                          # data ended mid-day
            bar = df.iloc[u - 1]
            exit_price, exit_reason, exit_time = bar["close"], "time", idx[u - 1]
            u -= 1

        trades.append(Trade(symbol, side, idx[t + 1], entry, exit_time, exit_price, exit_reason))
        day_counts[(day, side)] = day_counts.get((day, side), 0) + 1
        in_pos_until = u

    return trades


# ── Baseline: random entries through the same exit engine ────────────────────

def random_baseline(df: pd.DataFrame, n_trades: dict, symbol: str,
                    rng: np.random.Generator) -> list[float]:
    tod_ok = (df["tod"] >= ENTRY_START) & (df["tod"] <= ENTRY_END)
    eligible = np.flatnonzero((tod_ok & df["atr"].notna() & df["vwap"].notna()).values)
    expectancies = []
    for _ in range(BASELINE_RESAMPLES):
        all_bps = []
        for side, n in n_trades.items():
            if n == 0 or len(eligible) == 0:
                continue
            picks = rng.choice(eligible, size=min(n, len(eligible)), replace=False)
            fake = pd.Series(False, index=df.index)
            fake.iloc[picks] = True
            for tr in simulate(df, fake, side, symbol):
                all_bps.append(tr.net_bps)
        if all_bps:
            expectancies.append(float(np.mean(all_bps)))
    return expectancies


# ── Reporting ────────────────────────────────────────────────────────────────

def summarize(trades: list[Trade], label: str) -> None:
    if not trades:
        print(f"\n[{label}] no trades")
        return
    bps = np.array([t.net_bps for t in trades])
    wins, losses = bps[bps > 0], bps[bps <= 0]
    pf = wins.sum() / abs(losses.sum()) if losses.sum() != 0 else float("inf")
    streak = max_streak = 0
    for b in bps:
        streak = streak + 1 if b <= 0 else 0
        max_streak = max(max_streak, streak)
    reasons = pd.Series([t.exit_reason for t in trades]).value_counts().to_dict()
    print(f"\n[{label}] n={len(trades)}  win%={100 * len(wins) / len(bps):.1f}  "
          f"expectancy={bps.mean():+.1f}bps  PF={pf:.2f}  "
          f"avgW={wins.mean() if len(wins) else 0:+.1f}  avgL={losses.mean() if len(losses) else 0:+.1f}  "
          f"maxLossStreak={max_streak}  exits={reasons}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", nargs="+", default=DEFAULT_SYMBOLS)
    ap.add_argument("--no-baseline", action="store_true")
    args = ap.parse_args()

    rng = np.random.default_rng(42)
    all_trades: dict[str, list[Trade]] = {"BASE": [], "STRICT": []}
    null_expectancies: list[float] = []

    for symbol in args.symbols:
        df = load_bars(symbol)
        if df.empty or len(df) < 200:
            print(f"{symbol}: insufficient data, skipped")
            continue
        df = add_features(df)

        per_symbol_n = {}
        for variant, strict in (("BASE", False), ("STRICT", True)):
            for side in ("long", "short"):
                trades = simulate(df, signal_mask(df, side, strict), side, symbol)
                all_trades[variant].extend(trades)
                if variant == "BASE":
                    per_symbol_n[side] = len(trades)
        print(f"{symbol}: BASE long={per_symbol_n.get('long', 0)} "
              f"short={per_symbol_n.get('short', 0)}")

        if not args.no_baseline:
            null_expectancies.extend(random_baseline(df, per_symbol_n, symbol, rng))

    for variant in ("BASE", "STRICT"):
        summarize(all_trades[variant], f"POOLED {variant}")
        for side in ("long", "short"):
            summarize([t for t in all_trades[variant] if t.side == side],
                      f"{variant} {side}")

    if null_expectancies and all_trades["BASE"]:
        null_arr = np.array(null_expectancies)
        strat = float(np.mean([t.net_bps for t in all_trades["BASE"]]))
        pctile = 100 * (null_arr < strat).mean()
        print(f"\n[NULL] random-entry expectancy: mean={null_arr.mean():+.1f}bps "
              f"p95={np.percentile(null_arr, 95):+.1f}bps")
        print(f"[VERDICT] strategy expectancy {strat:+.1f}bps is at percentile "
              f"{pctile:.0f} of the null distribution "
              f"({'PASSES' if pctile > 95 else 'FAILS'} criterion #3)")

    pd.DataFrame([vars(t) | {"gross_bps": t.gross_bps, "net_bps": t.net_bps}
                  for t in all_trades["BASE"]]).to_csv("trades_base.csv", index=False)
    print("\ntrades_base.csv written")


if __name__ == "__main__":
    main()
