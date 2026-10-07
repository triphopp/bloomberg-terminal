"""Walk-forward simulator and scorecard for the allocation rules (alloc_rules.py).

Pure: no network, no files. research/sector_allocation/backtest.py loads the
data and writes the report; the timing, the measures and the verdict rules it
applies are the ones frozen in research/sector_allocation/PLAN.md.

Timing: a signal is read on the last trading day of a month from that day's
close and nothing later; the trade happens at the next trading day's close and
the weights are held, drifting, until the next trade.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace

import numpy as np
import pandas as pd

from . import alloc_rules as R

EQUITY = "SPY"
BOOTSTRAP_BLOCK = 12
BOOTSTRAP_RUNS = 5000
BOOTSTRAP_SEED = 20261007

#: t >= 2 across seven pre-registered tests lets ~0.35 through by chance;
#: STRONG is the Bonferroni line for seven.
T_VALID, T_STRONG = 2.0, 2.7
MIN_PHASE_MONTHS = 24

LAYER1 = ("T", "V", "TV")
LAYER2 = ("M", "C", "P", "MC")


@dataclass(frozen=True)
class Inputs:
    prices: pd.DataFrame      # daily adjusted closes: SPY + sector ETFs
    tbill: pd.Series          # daily 3M T-bill, percent a year
    surveys: pd.DataFrame     # monthly (PeriodIndex) regional Fed diffusion indices
    core_pce: pd.Series       # monthly (PeriodIndex) core PCE price index
    fed_target: pd.Series     # daily Fed funds target, percent


@dataclass(frozen=True)
class Params:
    trend_months: int = R.TREND_MONTHS
    vol_window: int = R.VOL_WINDOW
    mom_lookback: int = R.MOM_LOOKBACK
    mom_skip: int = R.MOM_SKIP
    growth_smooth: int = 1
    tilt_cap: float = R.TILT_CAP
    cost_bps: float = 5.0
    exec_lag: int = 1


@dataclass
class Run:
    params: Params
    signals: pd.DataFrame                      # one row per signal date
    weights: dict[str, pd.DataFrame]           # strategy -> exec date x asset (cash = the rest)
    scores: dict[str, pd.DataFrame]            # sector signal -> exec date x sector (raw score)
    nav: dict[str, pd.Series] = field(default_factory=dict)
    periods: dict[str, pd.DataFrame] = field(default_factory=dict)


# ── Schedule and signals ──────────────────────────────────────────────────────

def schedule(index: pd.DatetimeIndex, exec_lag: int = 1) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    """(signal day, trade day) for every month that has a trading day after it."""
    months = index.to_period("M")
    last_of_month = np.flatnonzero(months[:-1] != months[1:])
    return [(index[i], index[i + exec_lag]) for i in last_of_month if i + exec_lag < len(index)]


def signals_at(inp: Inputs, t: pd.Timestamp, p: Params) -> dict:
    """Every rule's reading at the close of day t, from data dated t or earlier."""
    px = inp.prices.loc[:t]
    monthly = R.month_end_closes(px)
    sectors = [s for s in R.SECTORS if s in px.columns]
    uni = R.universe(monthly[sectors], max(p.mom_lookback + 1, R.MOM_LOOKBACK + 1))
    cycle = R.phase_at(inp.surveys, inp.core_pce, t.to_period("M"), p.growth_smooth)
    bills = inp.tbill.loc[:t].dropna()
    return {
        "trend": R.trend_weight(monthly[EQUITY], p.trend_months),
        "vol": R.vol_weight(px[EQUITY], p.vol_window),
        "universe": uni,
        "momentum": R.momentum_scores(monthly[uni], p.mom_lookback, p.mom_skip),
        "stance": R.policy_stance(inp.fed_target.loc[:t]),
        "tbill": float(bills.iloc[-1]) if len(bills) else np.nan,
        **cycle,
    }


def _strategy_weights(sig: dict, p: Params) -> tuple[dict[str, pd.Series], dict[str, pd.Series]]:
    w: dict[str, pd.Series] = {}
    scores: dict[str, pd.Series] = {}
    trend, vol = sig["trend"], sig["vol"]
    w["SPY"] = pd.Series({EQUITY: 1.0})
    if trend is not None:
        w["T"] = pd.Series({EQUITY: trend})
    if vol is not None:
        w["V"] = pd.Series({EQUITY: vol})
    if trend is not None and vol is not None:
        w["TV"] = pd.Series({EQUITY: trend * vol})

    uni = sig["universe"]
    if not uni:
        return w, scores
    scores["M"] = sig["momentum"].reindex(uni)
    scores["C"] = R.cycle_scores(sig["phase"], uni)
    scores["P"] = R.policy_scores(sig["stance"], uni)
    z = {k: R.cross_z(v) for k, v in scores.items()}
    z["MC"] = R.combine(z["M"], z["C"])
    w["EW"] = R.tilt_weights(z["M"] * 0.0, p.tilt_cap)
    for name in LAYER2:
        w[name] = R.tilt_weights(z[name], p.tilt_cap)
    if "TV" in w:
        exposure = float(w["TV"].iloc[0])
        w["SYS"] = w["MC"] * exposure
        w["EW_TV"] = w["EW"] * exposure
    return w, scores


# ── Simulation ────────────────────────────────────────────────────────────────

def simulate(prices: pd.DataFrame, tbill_at_exec: pd.Series, weights: pd.DataFrame,
             cost_bps: float = 0.0) -> tuple[pd.Series, pd.DataFrame]:
    """Daily NAV and one row per holding period for a table of target weights.

    `weights` is trade day x asset; whatever a row leaves short of 1 is cash,
    earning the bill rate known on the signal day. Cost is charged on the risky
    assets bought and sold at each trade.
    """
    dates = list(weights.index)
    nav_parts: list[pd.Series] = []
    rows: list[dict] = []
    value = 1.0
    held = pd.Series(dtype=float)       # drifted risky weights carried into the next trade
    for k in range(len(dates) - 1):
        start, end = dates[k], dates[k + 1]
        target = weights.loc[start].dropna()
        target = target[target != 0]
        cash = 1.0 - float(target.sum())

        traded = float(target.sub(held, fill_value=0.0).abs().sum())
        value *= 1.0 - traded * cost_bps / 1e4

        window = prices.loc[start:end, list(target.index)]
        rel = window / window.iloc[0]
        days = (window.index - start).days.to_numpy()
        bill = float(np.nan_to_num(tbill_at_exec.get(start, 0.0)))
        cash_leg = cash * (1.0 + bill / 100.0 * days / 365.0)
        gross = rel.mul(target, axis=1).sum(axis=1).to_numpy() + cash_leg
        nav_parts.append(pd.Series(value * gross[1:], index=window.index[1:]))

        held = rel.iloc[-1] * target / gross[-1]
        rows.append({
            "start": start, "end": end,
            "ret": gross[-1] * (1.0 - traded * cost_bps / 1e4) - 1.0,
            "cash_ret": bill / 100.0 * days[-1] / 365.0,
            "exposure": 1.0 - cash, "traded": traded,
        })
        value *= gross[-1]
    nav = pd.concat([pd.Series([1.0], index=[dates[0]])] + nav_parts) if nav_parts else pd.Series(dtype=float)
    return nav, pd.DataFrame(rows).set_index("start") if rows else pd.DataFrame()


def run(inp: Inputs, p: Params = Params()) -> Run:
    """Read every rule on every signal day, then walk each strategy forward."""
    sig_rows: list[dict] = []
    w_rows: dict[str, dict] = {}
    s_rows: dict[str, dict] = {}
    for t, trade_day in schedule(inp.prices.index, p.exec_lag):
        sig = signals_at(inp, t, p)
        w, scores = _strategy_weights(sig, p)
        sig_rows.append({
            "signal": t, "exec": trade_day, "trend": sig["trend"], "vol": sig["vol"],
            "g": sig["g"], "dg": sig["dg"], "gap": sig["gap"], "phase": sig["phase"],
            "stance": sig["stance"], "tbill": sig["tbill"], "n_sectors": len(sig["universe"]),
        })
        for name, series in w.items():
            w_rows.setdefault(name, {})[trade_day] = series
        for name, series in scores.items():
            s_rows.setdefault(name, {})[trade_day] = series

    signals = pd.DataFrame(sig_rows).set_index("exec")
    out = Run(
        params=p, signals=signals,
        weights={k: pd.DataFrame(v).T.sort_index() for k, v in w_rows.items()},
        scores={k: pd.DataFrame(v).T.sort_index() for k, v in s_rows.items()},
    )
    for name, table in out.weights.items():
        out.nav[name], out.periods[name] = simulate(inp.prices, signals["tbill"], table, p.cost_bps)
    return out


def static_mix(inp: Inputs, result: Run, name: str, start: pd.Timestamp | None = None,
               end: pd.Timestamp | None = None) -> tuple[pd.Series, pd.DataFrame]:
    """SPY held at a fixed share equal to `name`'s average exposure over the window."""
    per = window(result.periods[name], start, end)
    share = float(per["exposure"].mean())
    table = pd.DataFrame({EQUITY: share}, index=result.weights[name].loc[per.index[0]:].index)
    return simulate(inp.prices, result.signals["tbill"], table, result.params.cost_bps)


def sector_returns(prices: pd.DataFrame, trade_days: pd.DatetimeIndex) -> pd.DataFrame:
    """Return of every column from each trade day to the next, indexed by the first."""
    at = prices.loc[trade_days]
    return (at.shift(-1) / at - 1.0).iloc[:-1]


# ── Measures ──────────────────────────────────────────────────────────────────

def window(frame: pd.DataFrame | pd.Series, start=None, end=None):
    """Rows whose holding period starts in [start, end)."""
    out = frame
    if start is not None:
        out = out[out.index >= pd.Timestamp(start)]
    if end is not None:
        out = out[out.index < pd.Timestamp(end)]
    return out


def sharpe(excess: pd.Series | np.ndarray) -> float:
    x = np.asarray(excess, dtype=float)
    sd = x.std(ddof=1) if len(x) > 1 else 0.0
    return float(x.mean() / sd * np.sqrt(12)) if sd > 0 else float("nan")


def max_drawdown(nav: pd.Series) -> float:
    if nav.empty:
        return float("nan")
    return float((nav / nav.cummax() - 1.0).min())


def metrics(nav: pd.Series, periods: pd.DataFrame, start=None, end=None) -> dict:
    per = window(periods, start, end)
    if per.empty:
        return {}
    path = nav.loc[per.index[0]:per["end"].iloc[-1]]
    years = (path.index[-1] - path.index[0]).days / 365.25
    growth = (1.0 + per["ret"]).cumprod()
    worst12 = float((growth / growth.shift(12) - 1.0).min()) if len(per) > 12 else float("nan")
    return {
        "start": str(path.index[0].date()), "end": str(path.index[-1].date()), "months": int(len(per)),
        "cagr": float((path.iloc[-1] / path.iloc[0]) ** (1.0 / years) - 1.0),
        "vol": float(per["ret"].std(ddof=1) * np.sqrt(12)),
        "sharpe": sharpe(per["ret"] - per["cash_ret"]),
        "max_dd": max_drawdown(path),
        "worst_12m": worst12,
        "exposure": float(per["exposure"].mean()),
        "turnover_yr": float(per["traded"].sum() / years),
    }


def bootstrap_delta_sharpe(excess_a: pd.Series, excess_b: pd.Series, block: int = BOOTSTRAP_BLOCK,
                           runs: int = BOOTSTRAP_RUNS, seed: int = BOOTSTRAP_SEED) -> dict:
    """Sharpe(a) - Sharpe(b) under a circular block bootstrap of the paired months."""
    pair = pd.concat([excess_a, excess_b], axis=1, join="inner").dropna().to_numpy()
    n = len(pair)
    if n < 2 * block:
        return {"delta": float("nan"), "lo": float("nan"), "hi": float("nan"), "p_pos": float("nan"), "n": n}
    rng = np.random.default_rng(seed)
    blocks = -(-n // block)
    starts = rng.integers(0, n, size=(runs, blocks))
    idx = ((starts[:, :, None] + np.arange(block)[None, None, :]) % n).reshape(runs, -1)[:, :n]
    sample = pair[idx]                                    # runs x n x 2
    sr = sample.mean(axis=1) / sample.std(axis=1, ddof=1) * np.sqrt(12)
    delta = sr[:, 0] - sr[:, 1]
    delta = delta[np.isfinite(delta)]
    return {
        "delta": sharpe(pair[:, 0]) - sharpe(pair[:, 1]),
        "lo": float(np.percentile(delta, 2.5)), "hi": float(np.percentile(delta, 97.5)),
        "p_pos": float((delta > 0).mean()), "n": n,
    }


def t_stat(x: pd.Series | np.ndarray) -> float:
    v = np.asarray(x, dtype=float)
    v = v[np.isfinite(v)]
    if len(v) < 3 or v.std(ddof=1) == 0:
        return float("nan")
    return float(v.mean() / (v.std(ddof=1) / np.sqrt(len(v))))


def information_coefficient(scores: pd.DataFrame, rets: pd.DataFrame) -> pd.Series:
    """Rank correlation of score and next-period return across sectors, per period."""
    out = {}
    for day in scores.index.intersection(rets.index):
        s = scores.loc[day].dropna()
        r = rets.loc[day].reindex(s.index).dropna()
        s = s.reindex(r.index)
        if len(s) < 3 or s.nunique() < 2 or r.nunique() < 2:
            continue
        out[day] = s.rank().corr(r.rank())
    return pd.Series(out, dtype=float)


def long_short(scores: pd.DataFrame, rets: pd.DataFrame, k: int = 3) -> pd.Series:
    """Next-period return of the best-scored sectors minus the worst-scored."""
    out = {}
    for day in scores.index.intersection(rets.index):
        s = scores.loc[day].dropna()
        r = rets.loc[day].reindex(s.index).dropna()
        s = s.reindex(r.index)
        if s.nunique() < 2:
            continue
        if s.nunique() <= 3:                 # a yes / no / against score, not a ranking
            top, bottom = s[s == s.max()].index, s[s == s.min()].index
        else:
            top, bottom = s.nlargest(k).index, s.nsmallest(k).index
        out[day] = r[top].mean() - r[bottom].mean()
    return pd.Series(out, dtype=float)


def ic_summary(ic: pd.Series) -> dict:
    if ic.empty:
        return {"mean": float("nan"), "t": float("nan"), "pos": float("nan"), "n": 0}
    return {"mean": float(ic.mean()), "t": t_stat(ic), "pos": float((ic > 0).mean()), "n": int(len(ic))}


def phase_table(phases: pd.Series, rets: pd.DataFrame) -> pd.DataFrame:
    """Mean monthly return of each sector over the sector average, by cycle phase."""
    rel = rets.sub(rets.mean(axis=1), axis=0)
    rows = []
    for phase in R.PHASES:
        days = phases.index[phases == phase].intersection(rel.index)
        block = rel.loc[days]
        favoured = [s for s in R.PHASE_FAVOURS[phase] if s in block.columns]
        rest = [s for s in block.columns if s not in favoured]
        spread = (block[favoured].mean(axis=1) - block[rest].mean(axis=1)).dropna()
        row = {"phase": phase, "months": int(len(days)),
               "favoured_minus_rest": float(spread.mean()) if len(spread) else float("nan"),
               "t": t_stat(spread)}
        for s in rel.columns:
            col = block[s].dropna()
            row[s] = float(col.mean()) if len(col) else float("nan")
        rows.append(row)
    return pd.DataFrame(rows).set_index("phase")


# ── Verdicts (PLAN.md section 5) ──────────────────────────────────────────────

def verdict_layer1(strategy: dict, spy: dict, mix: dict, post_strategy: dict, post_spy: dict,
                   p_pos: float) -> tuple[str, list[str]]:
    hits: list[str] = []
    if not strategy["sharpe"] > spy["sharpe"]:
        hits.append("L1-K1")
    if not strategy["max_dd"] > mix["max_dd"]:      # drawdowns are negative: shallower = greater
        hits.append("L1-K2")
    if hits:
        return "DEAD", hits
    if not post_strategy.get("sharpe", float("nan")) > post_spy.get("sharpe", float("nan")):
        return "DECAYED", ["L1-K3"]
    return ("VALID" if p_pos >= 0.90 else "WEAK"), []


def verdict_layer2(ic: dict, net_active: float, sub_ic: list[float]) -> tuple[str, list[str]]:
    hits: list[str] = []
    if not ic["mean"] > 0:
        hits.append("L2-K1")
    if not net_active > 0:
        hits.append("L2-K2")
    if hits:
        return "DEAD", hits
    known = [x for x in sub_ic if np.isfinite(x)]
    if sum(x > 0 for x in known) < 2 or not known[-1] > 0:
        return "UNSTABLE", ["L2-K3"]
    t = ic["t"]
    if t >= T_STRONG:
        return "STRONG", []
    return ("VALID" if t >= T_VALID else "WEAK"), []


def with_params(p: Params, **changes) -> Params:
    return replace(p, **changes)
