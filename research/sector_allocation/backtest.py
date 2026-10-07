"""
Sector allocation walk-forward study.

Implements PLAN.md exactly — read that first. Rules, timing, measures and the
kill-list are pre-registered there; do not tune after seeing results without
noting it in RESULTS.md.

    python research/sector_allocation/backtest.py            # cached data (fetched if missing)
    python research/sector_allocation/backtest.py --refresh  # fetch again

The rules live in backend/analytics/alloc_rules.py and the simulator in
backend/analytics/alloc_backtest.py; this file only loads data and writes
out/report.md, out/summary.json and the CSVs beside them.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "backend"))

from analytics import alloc_backtest as B  # noqa: E402
from analytics import alloc_rules as R  # noqa: E402

DATA, OUT = HERE / "data", HERE / "out"

TICKERS = [B.EQUITY, *R.SECTORS]
SURVEYS = {"philly": "GACDFSA066MSFRBPHI", "empire": "GACDISA066MSFRBNY", "dallas": "BACTSAMFRBDAL"}
FRED_SERIES = ["DTB3", "PCEPILFE", "DFEDTAR", "DFEDTARU", "USREC", *SURVEYS.values()]

SUBPERIODS = [("2000-01-01", "2010-01-01"), ("2010-01-01", "2020-01-01"), ("2020-01-01", None)]
PUBLISHED = {"T": "2007-01-01", "V": "2017-01-01", "TV": "2017-01-01"}


# ── Data ──────────────────────────────────────────────────────────────────────

def _fetch_prices() -> pd.DataFrame:
    import yfinance as yf

    raw = yf.download(TICKERS, period="max", interval="1d", auto_adjust=True, progress=False, threads=4)
    return raw["Close"][TICKERS].dropna(how="all")


def _fetch_fred(series_id: str) -> pd.Series:
    import requests
    from config import FRED_API_KEY, FRED_JSON_URL

    if not FRED_API_KEY:
        raise SystemExit("FRED_API_KEY is not set in backend/.env")
    r = requests.get(
        FRED_JSON_URL,
        params={"series_id": series_id, "api_key": FRED_API_KEY, "file_type": "json",
                "sort_order": "asc", "observation_start": "1968-01-01"},
        headers={"User-Agent": "Mozilla/5.0"}, timeout=30,
    )
    if not r.ok:                                  # never print the URL: it carries the key
        raise SystemExit(f"FRED {series_id}: HTTP {r.status_code}")
    rows = {o["date"]: float(o["value"]) for o in r.json().get("observations", [])
            if o.get("value") not in (".", "", None)}
    return pd.Series(rows, name=series_id)


def load(refresh: bool = False) -> tuple[B.Inputs, pd.Series, dict]:
    DATA.mkdir(exist_ok=True)
    meta_path = DATA / "meta.json"
    missing = not (DATA / "prices.csv").exists() or any(
        not (DATA / f"fred_{s}.csv").exists() for s in FRED_SERIES)
    if refresh or missing:
        print("fetching prices (Yahoo) and macro series (FRED)…")
        _fetch_prices().to_csv(DATA / "prices.csv")
        for sid in FRED_SERIES:
            _fetch_fred(sid).to_csv(DATA / f"fred_{sid}.csv", header=True)
        meta_path.write_text(json.dumps({"fetched_at": datetime.now(timezone.utc).isoformat()}))

    prices = pd.read_csv(DATA / "prices.csv", index_col=0, parse_dates=True).sort_index()
    prices = prices[prices[B.EQUITY].notna()]

    def fred(sid: str) -> pd.Series:
        s = pd.read_csv(DATA / f"fred_{sid}.csv", index_col=0, parse_dates=True).iloc[:, 0]
        return s.sort_index()

    def monthly(s: pd.Series) -> pd.Series:
        return s.set_axis(s.index.to_period("M"))

    surveys = pd.DataFrame({name: monthly(fred(sid)) for name, sid in SURVEYS.items()}).sort_index()
    target = pd.concat([fred("DFEDTAR"), fred("DFEDTARU")]).sort_index()
    inputs = B.Inputs(prices=prices, tbill=fred("DTB3"), surveys=surveys,
                      core_pce=monthly(fred("PCEPILFE")), fed_target=target)
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    meta["prices_through"] = str(prices.index[-1].date())
    return inputs, monthly(fred("USREC")), meta


# ── Scorecards ────────────────────────────────────────────────────────────────

def _excess(per: pd.DataFrame) -> pd.Series:
    return per["ret"] - per["cash_ret"]


def layer1(inp: B.Inputs, res: B.Run) -> dict:
    start = res.weights["TV"].index[0]
    spy = B.metrics(res.nav["SPY"], res.periods["SPY"], start)
    out: dict = {"window_start": str(start.date()), "SPY": spy, "rules": {}}
    for name in B.LAYER1:
        m = B.metrics(res.nav[name], res.periods[name], start)
        mix_nav, mix_per = B.static_mix(inp, res, name, start)
        mix = B.metrics(mix_nav, mix_per, start)
        vs_spy = B.bootstrap_delta_sharpe(_excess(B.window(res.periods[name], start)),
                                          _excess(B.window(res.periods["SPY"], start)))
        vs_mix = B.bootstrap_delta_sharpe(_excess(B.window(res.periods[name], start)),
                                          _excess(B.window(mix_per, start)))
        pub = PUBLISHED[name]
        post = B.metrics(res.nav[name], res.periods[name], pub)
        post_spy = B.metrics(res.nav["SPY"], res.periods["SPY"], pub)
        verdict, hits = B.verdict_layer1(m, spy, mix, post, post_spy, vs_spy["p_pos"])
        subs = [{"from": a, "to": b,
                 "rule": B.metrics(res.nav[name], res.periods[name], a, b),
                 "spy": B.metrics(res.nav["SPY"], res.periods["SPY"], a, b)}
                for a, b in [(str(start.date()), "2000-01-01"), *SUBPERIODS]]
        out["rules"][name] = {"metrics": m, "mix": mix, "vs_spy": vs_spy, "vs_mix": vs_mix,
                              "published": pub, "post": post, "post_spy": post_spy,
                              "subperiods": subs, "verdict": verdict, "kills": hits}
    return out


def _active(per: pd.DataFrame, base: pd.DataFrame, start=None, end=None) -> dict:
    diff = (B.window(per, start, end)["ret"] - B.window(base, start, end)["ret"]).dropna()
    te = float(diff.std(ddof=1) * np.sqrt(12)) if len(diff) > 1 else float("nan")
    ann = float(diff.mean() * 12)
    return {"active": ann, "te": te, "ir": ann / te if te else float("nan"), "t": B.t_stat(diff),
            "months": int(len(diff))}


def layer2(inp: B.Inputs, res: B.Run, rets: pd.DataFrame) -> dict:
    start = res.weights["M"].index[0]
    out: dict = {"window_start": str(start.date()),
                 "EW": B.metrics(res.nav["EW"], res.periods["EW"], start),
                 "SPY": B.metrics(res.nav["SPY"], res.periods["SPY"], start), "signals": {}}
    z = {k: res.scores[k].apply(R.cross_z, axis=1) for k in ("M", "C", "P")}
    scores = {**res.scores, "MC": (z["M"] + z["C"]) / 2}
    for name in B.LAYER2:
        ic = B.information_coefficient(scores[name], rets)
        ls = B.long_short(scores[name], rets)
        active = _active(res.periods[name], res.periods["EW"], start)
        sub_ic = [float(B.window(ic, a, b).mean()) for a, b in SUBPERIODS]
        verdict, hits = B.verdict_layer2(B.ic_summary(ic), active["active"], sub_ic)
        out["signals"][name] = {
            "metrics": B.metrics(res.nav[name], res.periods[name], start),
            "active": active, "ic": B.ic_summary(ic), "sub_ic": sub_ic,
            "sub_active": [_active(res.periods[name], res.periods["EW"], a, b)["active"] for a, b in SUBPERIODS],
            "long_short": {"mean_month": float(ls.mean()), "t": B.t_stat(ls), "n": int(len(ls))},
            "vs_ew": B.bootstrap_delta_sharpe(_excess(B.window(res.periods[name], start)),
                                              _excess(B.window(res.periods["EW"], start))),
            "verdict": verdict, "kills": hits,
        }
        out.setdefault("_ic", {})[name] = ic
    return out


def system(inp: B.Inputs, res: B.Run) -> dict:
    start = res.weights["SYS"].index[0]
    mix_nav, mix_per = B.static_mix(inp, res, "SYS", start)
    rows = {"SYS": (res.nav["SYS"], res.periods["SYS"]), "EW_TV": (res.nav["EW_TV"], res.periods["EW_TV"]),
            "TV": (res.nav["TV"], res.periods["TV"]), "MIX(SYS)": (mix_nav, mix_per),
            "SPY": (res.nav["SPY"], res.periods["SPY"])}
    out = {"window_start": str(start.date()),
           "rows": {k: B.metrics(nav, per, start) for k, (nav, per) in rows.items()}}
    sys_ex = _excess(B.window(res.periods["SYS"], start))
    out["vs_spy"] = B.bootstrap_delta_sharpe(sys_ex, _excess(B.window(res.periods["SPY"], start)))
    out["vs_mix"] = B.bootstrap_delta_sharpe(sys_ex, _excess(B.window(mix_per, start)))
    out["vs_ew_tv"] = B.bootstrap_delta_sharpe(sys_ex, _excess(B.window(res.periods["EW_TV"], start)))
    return out


def phases(res: B.Run, rets: pd.DataFrame, usrec: pd.Series) -> tuple[pd.DataFrame, dict]:
    start = res.weights["M"].index[0]
    sig = B.window(res.signals, start).iloc[:-1]
    table = B.phase_table(sig["phase"], rets)
    table["status"] = np.where(table["months"] < B.MIN_PHASE_MONTHS, "INSUFFICIENT", "ok")
    rec = usrec.reindex(sig["signal"].dt.to_period("M")).to_numpy()
    table["nber_recession_share"] = [float(np.nanmean(rec[(sig["phase"] == p).to_numpy()]))
                                     if (sig["phase"] == p).any() else float("nan") for p in table.index]
    known = sig["phase"].dropna()
    info = {"months": int(len(sig)), "unknown": int(sig["phase"].isna().sum()),
            "switches": int((known != known.shift()).sum() - 1),
            "switches_per_year": float(((known != known.shift()).sum() - 1) / (len(known) / 12))}
    return table, info


def tilt_sizes(inp: B.Inputs, base: B.Params) -> list[dict]:
    rows = []
    for cap in (0.02, 0.03, 0.05, 0.08):
        res = B.run(inp, B.with_params(base, tilt_cap=cap))
        start = res.weights["M"].index[0]
        for name in ("M", "MC"):
            a = _active(res.periods[name], res.periods["EW"], start)
            m = B.metrics(res.nav[name], res.periods[name], start)
            rows.append({"cap": cap, "signal": name, **a, "turnover_yr": m["turnover_yr"],
                         "max_dd": m["max_dd"]})
    return rows


def sensitivity(inp: B.Inputs, base: B.Params) -> list[dict]:
    variants = {
        "base": {}, "SMA 8m": {"trend_months": 8}, "SMA 12m": {"trend_months": 12},
        "vol 63d": {"vol_window": 63}, "mom 6-1": {"mom_lookback": 6}, "mom 12-0": {"mom_skip": 0},
        "growth 3m avg": {"growth_smooth": 3}, "cost 0bp": {"cost_bps": 0.0},
        "cost 10bp": {"cost_bps": 10.0}, "cost 20bp": {"cost_bps": 20.0}, "same-day trade": {"exec_lag": 0},
    }
    rows = []
    for label, change in variants.items():
        res = B.run(inp, B.with_params(base, **change))
        l1, l2 = res.weights["TV"].index[0], res.weights["M"].index[0]
        rets = B.sector_returns(inp.prices[list(R.SECTORS)], res.weights["M"].index)
        rets = rets.where(res.scores["M"].reindex(rets.index).notna())
        z = {k: res.scores[k].apply(R.cross_z, axis=1) for k in ("M", "C")}
        row = {"variant": label}
        for name in ("SPY", *B.LAYER1):
            m = B.metrics(res.nav[name], res.periods[name], l1)
            row[f"sharpe_{name}"], row[f"dd_{name}"] = m["sharpe"], m["max_dd"]
        for name, sc in (("M", res.scores["M"]), ("C", res.scores["C"]), ("MC", (z["M"] + z["C"]) / 2)):
            row[f"ic_{name}"] = float(B.information_coefficient(sc, rets).mean())
            row[f"active_{name}"] = _active(res.periods[name], res.periods["EW"], l2)["active"]
        rows.append(row)
    return rows


def latest(res: B.Run) -> dict:
    """The reading on the last signal day — what the rules say now."""
    sig = res.signals.iloc[-1]
    day = res.signals.index[-1]
    out = {"signal_day": str(sig["signal"].date()), "trade_day": str(day.date()),
           "trend": sig["trend"], "vol_weight": sig["vol"], "equity_share_TV": float(sig["trend"] * sig["vol"]),
           "g": sig["g"], "dg": sig["dg"], "inflation_gap": sig["gap"], "phase": sig["phase"],
           "fed": sig["stance"], "tbill": sig["tbill"]}
    for name in ("M", "MC", "SYS"):
        out[f"weights_{name}"] = {k: round(float(v), 4) for k, v in res.weights[name].loc[day].dropna().items()}
    out["momentum"] = {k: round(float(v), 4) for k, v in
                       res.scores["M"].loc[day].dropna().sort_values(ascending=False).items()}
    return out


# ── Report ────────────────────────────────────────────────────────────────────

def pct(x, d=1):
    return "—" if x is None or not np.isfinite(x) else f"{x * 100:.{d}f}%"


def num(x, d=2):
    return "—" if x is None or not np.isfinite(x) else f"{x:.{d}f}"


def _table(head: list[str], rows: list[list[str]]) -> str:
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    lines += ["| " + " | ".join(r) + " |" for r in rows]
    return "\n".join(lines)


def _mrow(label: str, m: dict) -> list[str]:
    return [label, pct(m["cagr"]), pct(m["vol"]), num(m["sharpe"]), pct(m["max_dd"]),
            pct(m["worst_12m"]), pct(m["exposure"], 0), num(m["turnover_yr"])]


M_HEAD = ["", "CAGR", "Vol", "Sharpe", "Max DD", "Worst 12m", "Exposure", "Traded/yr"]


def report(s: dict, phase_tbl: pd.DataFrame) -> str:
    l1, l2, sy = s["layer1"], s["layer2"], s["system"]
    parts = [f"# Sector allocation — run output\n\nData through {s['meta']['prices_through']} · "
             f"fetched {s['meta'].get('fetched_at', '?')[:10]} · cost {s['params']['cost_bps']:.0f} bps a side · "
             f"trade {s['params']['exec_lag']} day after the signal\n"]

    parts.append(f"## Layer 1 — SPY against cash ({l1['window_start']} →)\n")
    rows = [_mrow("SPY", l1["SPY"])]
    for name, r in l1["rules"].items():
        rows += [_mrow(name, r["metrics"]), _mrow(f"MIX({name})", r["mix"])]
    parts.append(_table(M_HEAD, rows))
    rows = [[name, num(r["vs_spy"]["delta"]), f"{num(r['vs_spy']['lo'])} … {num(r['vs_spy']['hi'])}",
             num(r["vs_spy"]["p_pos"]), num(r["vs_mix"]["delta"]), num(r["vs_mix"]["p_pos"]),
             f"{num(r['post']['sharpe'])} vs {num(r['post_spy']['sharpe'])} (≥ {r['published'][:4]})",
             r["verdict"] + (" " + ",".join(r["kills"]) if r["kills"] else "")]
            for name, r in l1["rules"].items()]
    parts.append("\n" + _table(["Rule", "ΔSharpe vs SPY", "95% CI", "P(Δ>0)", "ΔSharpe vs MIX", "P(Δ>0)",
                                "Post-publication Sharpe", "Verdict"], rows))
    rows = []
    for name, r in l1["rules"].items():
        for sp in r["subperiods"]:
            if sp["rule"]:
                rows.append([name, f"{sp['from'][:4]}–{(sp['to'] or 'now')[:4]}", num(sp["rule"]["sharpe"]),
                             num(sp["spy"]["sharpe"]), pct(sp["rule"]["max_dd"]), pct(sp["spy"]["max_dd"])])
    parts.append("\n" + _table(["Rule", "Period", "Sharpe", "SPY Sharpe", "Max DD", "SPY Max DD"], rows))

    parts.append(f"\n## Layer 2 — sector selection, fully invested ({l2['window_start']} →)\n")
    rows = [_mrow("SPY", l2["SPY"]), _mrow("EW", l2["EW"])]
    rows += [_mrow(name, r["metrics"]) for name, r in l2["signals"].items()]
    parts.append(_table(M_HEAD, rows))
    rows = [[name, num(r["ic"]["mean"], 3), num(r["ic"]["t"]), pct(r["ic"]["pos"], 0), str(r["ic"]["n"]),
             " / ".join(num(x, 3) for x in r["sub_ic"]),
             f"{pct(r['long_short']['mean_month'], 2)} (t {num(r['long_short']['t'])})",
             f"{pct(r['active']['active'], 2)} (t {num(r['active']['t'])})", pct(r["active"]["te"], 2),
             num(r["active"]["ir"]), r["verdict"] + (" " + ",".join(r["kills"]) if r["kills"] else "")]
            for name, r in l2["signals"].items()]
    parts.append("\n" + _table(["Signal", "IC", "t", "IC > 0", "n", "IC 00s / 10s / 20s", "Best − worst / month",
                                "Active vs EW / yr (5pp tilt, net)", "TE", "IR", "Verdict"], rows))

    parts.append("\n## Cycle phases\n")
    pi = s["phase_info"]
    parts.append(f"{pi['months']} months · {pi['unknown']} unknown · {pi['switches']} phase changes "
                 f"({pi['switches_per_year']:.1f} a year)\n")
    sectors = [c for c in phase_tbl.columns if c in R.SECTORS]
    rows = [[p, str(int(r["months"])), r["status"], pct(r["nber_recession_share"], 0),
             pct(r["favoured_minus_rest"], 2), num(r["t"]),
             *[("**" if sct in R.PHASE_FAVOURS[p] else "") + pct(r[sct], 2) +
               ("**" if sct in R.PHASE_FAVOURS[p] else "") for sct in sectors]]
            for p, r in phase_tbl.iterrows()]
    parts.append(_table(["Phase", "Months", "Sample", "In NBER recession", "Favoured − rest / month", "t",
                         *sectors], rows))
    parts.append("\nSector columns: mean monthly return over the equal-weight sector average; bold = the "
                 "sectors the pre-registered table favours in that phase.")

    parts.append(f"\n## System — MC sectors × TV exposure ({sy['window_start']} →)\n")
    parts.append(_table(M_HEAD, [_mrow(k, m) for k, m in sy["rows"].items()]))
    rows = [[k, num(sy[k]["delta"]), f"{num(sy[k]['lo'])} … {num(sy[k]['hi'])}", num(sy[k]["p_pos"])]
            for k in ("vs_spy", "vs_mix", "vs_ew_tv")]
    parts.append("\n" + _table(["SYS ΔSharpe", "Δ", "95% CI", "P(Δ>0)"], rows))

    parts.append("\n## Tilt size — the trade-off, not a recommendation\n")
    rows = [[r["signal"], f"{r['cap'] * 100:.0f}pp", pct(r["active"], 2), num(r["t"]), pct(r["te"], 2),
             num(r["ir"]), num(r["turnover_yr"]), pct(r["max_dd"])] for r in s["tilt_sizes"]]
    parts.append(_table(["Signal", "Cap", "Active vs EW / yr", "t", "TE", "IR", "Traded/yr", "Max DD"], rows))

    parts.append("\n## Sensitivity — reported, never used to choose a value\n")
    rows = [[r["variant"], num(r["sharpe_SPY"]), num(r["sharpe_T"]), num(r["sharpe_V"]), num(r["sharpe_TV"]),
             pct(r["dd_TV"]), num(r["ic_M"], 3), num(r["ic_C"], 3), num(r["ic_MC"], 3),
             pct(r["active_M"], 2), pct(r["active_C"], 2), pct(r["active_MC"], 2)] for r in s["sensitivity"]]
    parts.append(_table(["Variant", "Sharpe SPY", "T", "V", "TV", "TV Max DD", "IC M", "IC C", "IC MC",
                         "Active M", "Active C", "Active MC"], rows))

    now = s["latest"]
    parts.append(f"\n## Reading on {now['signal_day']}\n")
    parts.append(_table(["Trend", "Vol weight", "Equity share (TV)", "g", "dg", "Inflation gap", "Phase", "Fed",
                         "T-bill"],
                        [[num(now["trend"], 0), num(now["vol_weight"]), pct(now["equity_share_TV"], 0),
                          num(now["g"]), num(now["dg"]), num(now["inflation_gap"]), str(now["phase"]),
                          str(now["fed"]), num(now["tbill"])]]))
    rows = [[k, pct(v, 1), pct(now["weights_M"].get(k), 1), pct(now["weights_MC"].get(k), 1)]
            for k, v in now["momentum"].items()]
    parts.append("\n" + _table(["Sector", "12-1 momentum", "Weight M", "Weight MC"], rows))
    return "\n".join(parts) + "\n"


def _clean(obj):
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items() if not str(k).startswith("_")}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    if isinstance(obj, (float, np.floating)):
        return None if not np.isfinite(obj) else round(float(obj), 6)
    if isinstance(obj, (np.integer,)):
        return int(obj)
    return obj


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--refresh", action="store_true", help="fetch prices and macro series again")
    ap.add_argument("--quick", action="store_true", help="skip the tilt-size and sensitivity reruns")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")      # Windows consoles default to cp1252

    inp, usrec, meta = load(args.refresh)
    base = B.Params()
    res = B.run(inp, base)
    rets = B.sector_returns(inp.prices[list(R.SECTORS)], res.weights["M"].index)
    rets = rets.where(res.scores["M"].reindex(rets.index).notna())    # only sectors in the universe

    phase_tbl, phase_info = phases(res, rets, usrec)
    l2 = layer2(inp, res, rets)
    summary = {
        "meta": meta, "params": base.__dict__,
        "layer1": layer1(inp, res), "layer2": l2, "system": system(inp, res),
        "phase_info": phase_info,
        "tilt_sizes": [] if args.quick else tilt_sizes(inp, base),
        "sensitivity": [] if args.quick else sensitivity(inp, base),
        "latest": latest(res),
    }

    OUT.mkdir(exist_ok=True)
    (OUT / "summary.json").write_text(json.dumps(_clean(summary), indent=2), encoding="utf-8")
    (OUT / "report.md").write_text(report(summary, phase_tbl), encoding="utf-8")
    phase_tbl.to_csv(OUT / "phase_table.csv")
    res.signals.to_csv(OUT / "signals.csv")
    pd.DataFrame({k: v["ret"] for k, v in res.periods.items()}).to_csv(OUT / "period_returns.csv")
    pd.DataFrame(l2["_ic"]).to_csv(OUT / "ic.csv")
    res.weights["SYS"].to_csv(OUT / "weights_SYS.csv")
    print((OUT / "report.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
