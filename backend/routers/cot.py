"""
CFTC Commitments of Traders — who actually holds the futures.

TAIL's FLOW / POSITIONING dimension only had price proxies (RSI, volume,
Fear & Greed). COT is the positions themselves: weekly, per trader category,
free from CFTC's Socrata API with no key.

Datasets (verified 2026-09-25):
  TFF  gpe5-46if  Traders in Financial Futures, futures-only — rates, equity
                  index, VIX, FX, BTC. Groups: dealer · am (asset manager) ·
                  lev (leveraged funds) · other · nonrept
  DIS  72hh-3qpy  Disaggregated, futures-only — commodities. Groups: prod
                  (producer/merchant) · swap · mm (managed money) · other · nonrept

Futures-only on purpose: the combined reports delta-adjust options, and mixing
the two in one series would make a jump that is not a position change.

Timing: positions are as of TUESDAY, released FRIDAY 15:30 ET (later around
holidays). Anything that tests a signal must date it by release, not as-of —
`released` is carried on every row for that reason.

Keyed on `cftc_contract_market_code`, never the market name: CFTC renamed most
markets on 2022-02-01 ("3-MONTH SOFR" → "SOFR-3M") and the code survived.

Storage is long-form (one row per report × group), not the raw payload — the
Disaggregated rows carry ~190 fields and 20 years of them is tens of MB for
the dozen numbers used here. It is a cache of a public source: not synced.

Endpoints:
  GET /api/cot/snapshot?window=156  — per contract: OI, net per group, net/OI,
                                      z + percentile over `window` weeks, Δ1w,
                                      trader counts, top-4/8 concentration
  GET /api/cot/history?code=&weeks= — weekly series for one contract
  GET /api/cot/basis?window=&weeks= — UST basis trade: AM / lev / dealer net across
                                      tenors in 10Y-note equivalents (DV01-weighted)
  GET /api/cot/factor?window=&weeks= — PC1 of every contract's rolling positioning z
                                      (display only — not an HMM input)
  GET /api/cot/portfolio?account_id= — open positions mapped to contracts × crowding flags
  GET /api/cot/status               — backfill / refresh state
"""
from __future__ import annotations

import math
import threading
import time
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import requests
from fastapi import APIRouter, HTTPException, Query

from db import get_db

router = APIRouter()

_BASE = "https://publicreporting.cftc.gov/resource/{ds}.json"
_DATASETS = {"TFF": "gpe5-46if", "DIS": "72hh-3qpy"}
_ET = ZoneInfo("America/New_York")

_TIMEOUT_S = 30
_REFRESH_EVERY_S = 6 * 3600     # nothing new expected more than once a week
_FAIL_COOLDOWN_S = 15 * 60      # negative cache: a down CFTC is not re-hit per request
_MIN_OBS = 52                   # below a year of history a z-score is noise

# ── Contracts ─────────────────────────────────────────────────────────────────
# `focus` is the group whose positioning the UI leads with: leveraged funds for
# financial futures, managed money for commodities. `dv01` is an APPROXIMATE
# 10Y-note-equivalent ratio per contract (CTD-dependent, drifts with yields) —
# good enough to add tenors for a crowding read, not for hedging.

CONTRACTS: dict[str, dict] = {
    "042601": {"key": "UST2Y",  "label": "UST 2Y",       "ds": "TFF", "cls": "rates",  "focus": "lev", "yahoo": "ZT=F",    "dv01": 0.58},
    "044601": {"key": "UST5Y",  "label": "UST 5Y",       "ds": "TFF", "cls": "rates",  "focus": "lev", "yahoo": "ZF=F",    "dv01": 0.68},
    "043602": {"key": "UST10Y", "label": "UST 10Y",      "ds": "TFF", "cls": "rates",  "focus": "lev", "yahoo": "ZN=F",    "dv01": 1.00},
    "043607": {"key": "UXY",    "label": "ULTRA 10Y",    "ds": "TFF", "cls": "rates",  "focus": "lev", "yahoo": "TN=F",    "dv01": 1.45},
    "020601": {"key": "USB",    "label": "UST BOND",     "ds": "TFF", "cls": "rates",  "focus": "lev", "yahoo": "ZB=F",    "dv01": 2.30},
    "020604": {"key": "ULTRA",  "label": "ULTRA BOND",   "ds": "TFF", "cls": "rates",  "focus": "lev", "yahoo": "UB=F",    "dv01": 3.50},
    "134741": {"key": "SOFR3M", "label": "SOFR 3M",      "ds": "TFF", "cls": "rates",  "focus": "lev", "yahoo": "SR3=F",   "dv01": None},
    "13874A": {"key": "ES",     "label": "E-MINI S&P",   "ds": "TFF", "cls": "equity", "focus": "lev", "yahoo": "ES=F",    "dv01": None},
    "209742": {"key": "NQ",     "label": "NASDAQ MINI",  "ds": "TFF", "cls": "equity", "focus": "lev", "yahoo": "NQ=F",    "dv01": None},
    "239742": {"key": "RTY",    "label": "RUSSELL MINI", "ds": "TFF", "cls": "equity", "focus": "lev", "yahoo": "RTY=F",   "dv01": None},
    "1170E1": {"key": "VIX",    "label": "VIX",          "ds": "TFF", "cls": "vol",    "focus": "lev", "yahoo": "^VIX",    "dv01": None},
    "097741": {"key": "JPY",    "label": "JPY",          "ds": "TFF", "cls": "fx",     "focus": "lev", "yahoo": "JPY=X",   "dv01": None},
    "099741": {"key": "EUR",    "label": "EUR",          "ds": "TFF", "cls": "fx",     "focus": "lev", "yahoo": "EURUSD=X", "dv01": None},
    "133741": {"key": "BTC",    "label": "BITCOIN",      "ds": "TFF", "cls": "crypto", "focus": "lev", "yahoo": "BTC-USD", "dv01": None},
    "067651": {"key": "WTI",    "label": "WTI CRUDE",    "ds": "DIS", "cls": "commod", "focus": "mm",  "yahoo": "CL=F",    "dv01": None},
    "088691": {"key": "GOLD",   "label": "GOLD",         "ds": "DIS", "cls": "commod", "focus": "mm",  "yahoo": "GC=F",    "dv01": None},
    "085692": {"key": "COPPER", "label": "COPPER",       "ds": "DIS", "cls": "commod", "focus": "mm",  "yahoo": "HG=F",    "dv01": None},
}

# group → (long, short, spread, traders_long, traders_short) field names.
# Field names are CFTC's, typos included (`swap__positions_short_all`).
_FIELDS: dict[str, dict[str, tuple[str, str, str | None, str | None, str | None]]] = {
    "TFF": {
        "dealer":  ("dealer_positions_long_all", "dealer_positions_short_all", "dealer_positions_spread_all",
                    "traders_dealer_long_all", "traders_dealer_short_all"),
        "am":      ("asset_mgr_positions_long", "asset_mgr_positions_short", "asset_mgr_positions_spread",
                    "traders_asset_mgr_long_all", "traders_asset_mgr_short_all"),
        "lev":     ("lev_money_positions_long", "lev_money_positions_short", "lev_money_positions_spread",
                    "traders_lev_money_long_all", "traders_lev_money_short_all"),
        "other":   ("other_rept_positions_long", "other_rept_positions_short", "other_rept_positions_spread",
                    "traders_other_rept_long_all", "traders_other_rept_short"),
        "nonrept": ("nonrept_positions_long_all", "nonrept_positions_short_all", None, None, None),
    },
    "DIS": {
        "prod":    ("prod_merc_positions_long", "prod_merc_positions_short", None,
                    "traders_prod_merc_long_all", "traders_prod_merc_short_all"),
        "swap":    ("swap_positions_long_all", "swap__positions_short_all", "swap__positions_spread_all",
                    "traders_swap_long_all", "traders_swap_short_all"),
        "mm":      ("m_money_positions_long_all", "m_money_positions_short_all", "m_money_positions_spread",
                    "traders_m_money_long_all", "traders_m_money_short_all"),
        "other":   ("other_rept_positions_long", "other_rept_positions_short", "other_rept_positions_spread",
                    "traders_other_rept_long_all", "traders_other_rept_short"),
        "nonrept": ("nonrept_positions_long_all", "nonrept_positions_short_all", None, None, None),
    },
}

_CONC = ("conc_gross_le_4_tdr_long", "conc_gross_le_4_tdr_short",
         "conc_gross_le_8_tdr_long", "conc_gross_le_8_tdr_short")


# ── Pure helpers (tested) ─────────────────────────────────────────────────────

def _num(v) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def released_on(as_of: str) -> str:
    """Scheduled release date for a Tuesday as-of: the Friday after.

    Holidays push some releases to Monday; this is the scheduled date, which is
    the earliest anyone could have acted — a lower bound, never early.
    """
    d = date.fromisoformat(as_of[:10])
    return (d + timedelta(days=(4 - d.weekday()) % 7 or 7)).isoformat()


def expected_as_of(now: datetime | None = None) -> str:
    """The latest as-of Tuesday whose Friday-15:30-ET release has passed."""
    now = (now or datetime.now(timezone.utc)).astimezone(_ET)
    d = now.date()
    friday = d - timedelta(days=(d.weekday() - 4) % 7)
    if friday == d and (now.hour, now.minute) < (15, 30):
        friday -= timedelta(days=7)
    return (friday - timedelta(days=3)).isoformat()


def parse_row(ds: str, row: dict) -> tuple[dict, list[dict]] | None:
    """One Socrata row → (report, [group rows]). None if unusable."""
    as_of = str(row.get("report_date_as_yyyy_mm_dd") or "")[:10]
    oi = _num(row.get("open_interest_all"))
    if len(as_of) != 10 or not oi:
        return None
    report = {"report_date": as_of, "oi": oi,
              "conc4_long": _num(row.get(_CONC[0])), "conc4_short": _num(row.get(_CONC[1])),
              "conc8_long": _num(row.get(_CONC[2])), "conc8_short": _num(row.get(_CONC[3]))}
    groups = []
    for grp, (fl, fs, fsp, ftl, fts) in _FIELDS[ds].items():
        lo, sh = _num(row.get(fl)), _num(row.get(fs))
        if lo is None or sh is None:
            continue
        groups.append({"grp": grp, "long": lo, "short": sh,
                       "spread": _num(row.get(fsp)) if fsp else None,
                       "traders_long": _num(row.get(ftl)) if ftl else None,
                       "traders_short": _num(row.get(fts)) if fts else None})
    return report, groups


def crowding(series: list[float], window: int) -> dict:
    """z and percentile of the NEWEST value (series[0]) within `window` obs.

    Percentile counts values ≤ current, so the extreme low reads ~0 and the
    extreme high 100. Below `_MIN_OBS` observations both are None.
    """
    xs = [v for v in series[:window] if v is not None]
    if len(xs) < _MIN_OBS or series[0] is None:
        return {"z": None, "pct": None, "n": len(xs)}
    mu = sum(xs) / len(xs)
    sd = math.sqrt(sum((v - mu) ** 2 for v in xs) / len(xs))
    return {"z": round((xs[0] - mu) / sd, 2) if sd > 0 else 0.0,
            "pct": round(100 * sum(v <= xs[0] for v in xs) / len(xs), 1),
            "n": len(xs)}


# ── Fetch + store ─────────────────────────────────────────────────────────────

def _fetch(ds: str, code: str, since: str | None) -> list[dict]:
    where = f"cftc_contract_market_code='{code}'"
    if since:
        where += f" AND report_date_as_yyyy_mm_dd > '{since}T00:00:00.000'"
    r = requests.get(_BASE.format(ds=_DATASETS[ds]),
                     params={"$where": where, "$order": "report_date_as_yyyy_mm_dd", "$limit": 50000},
                     timeout=_TIMEOUT_S)
    r.raise_for_status()
    return r.json()


def _store(ds: str, code: str, rows: list[dict]) -> int:
    n = 0
    with get_db() as conn:
        for row in rows:
            parsed = parse_row(ds, row)
            if not parsed:
                continue
            rep, groups = parsed
            conn.execute(
                "INSERT OR REPLACE INTO cot_reports (dataset, code, report_date, oi, conc4_long, conc4_short,"
                " conc8_long, conc8_short, fetched_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))",
                (ds, code, rep["report_date"], rep["oi"], rep["conc4_long"], rep["conc4_short"],
                 rep["conc8_long"], rep["conc8_short"]))
            for g in groups:
                conn.execute(
                    "INSERT OR REPLACE INTO cot_positions (dataset, code, report_date, grp, long, short, spread,"
                    " traders_long, traders_short) VALUES (?,?,?,?,?,?,?,?,?)",
                    (ds, code, rep["report_date"], g["grp"], g["long"], g["short"], g["spread"],
                     g["traders_long"], g["traders_short"]))
            n += 1
    return n


def _latest_dates() -> dict[str, str]:
    with get_db() as conn:
        return {r[0]: r[1] for r in conn.execute(
            "SELECT code, MAX(report_date) FROM cot_reports GROUP BY code")}


class _Refresher:
    """Background pull: full history for a new contract, incremental after.

    Endpoints never wait on CFTC — they serve what is stored and call ensure().
    A pull runs at most every 6h unless the stored data is behind the latest
    released week; three consecutive failures park the source for 15 minutes.
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.thread: threading.Thread | None = None
        self.last_ok = 0.0
        self.cooldown_until = 0.0
        self.last_error: str | None = None
        self.rows_last_run = 0

    def running(self) -> bool:
        return self.thread is not None and self.thread.is_alive()

    def stale_codes(self) -> list[str]:
        latest, want = _latest_dates(), expected_as_of()
        return [c for c in CONTRACTS if latest.get(c, "") < want]

    def ensure(self) -> None:
        with self.lock:
            now = time.time()
            if self.running() or now < self.cooldown_until:
                return
            stale = self.stale_codes()
            if not stale:
                return
            stored = _latest_dates()
            if all(c in stored for c in stale) and now - self.last_ok < _REFRESH_EVERY_S:
                # Behind only because CFTC is late (holiday week): wait the 6h
                # out. A contract with no rows at all is never made to wait.
                return
            self.thread = threading.Thread(target=self._run, args=(stale,), name="cot-refresh", daemon=True)
            self.thread.start()

    def _run(self, codes: list[str]) -> None:
        latest = _latest_dates()
        failures, total = 0, 0
        for code in codes:
            meta = CONTRACTS[code]
            try:
                total += _store(meta["ds"], code, _fetch(meta["ds"], code, latest.get(code)))
                failures = 0
                self.last_error = None
            except Exception as exc:
                failures += 1
                self.last_error = f"{meta['key']}: {type(exc).__name__}"
                if failures >= 3:
                    self.cooldown_until = time.time() + _FAIL_COOLDOWN_S
                    self.rows_last_run = total
                    return
        self.rows_last_run = total
        self.last_ok = time.time()


_refresher = _Refresher()


# ── Read ──────────────────────────────────────────────────────────────────────

def _load(code: str, weeks: int) -> list[dict]:
    """Newest-first weekly rows for one contract: {date, oi, conc…, groups{grp: …}}."""
    with get_db() as conn:
        reps = conn.execute(
            "SELECT report_date, oi, conc4_long, conc4_short, conc8_long, conc8_short FROM cot_reports"
            " WHERE code = ? ORDER BY report_date DESC LIMIT ?", (code, weeks)).fetchall()
        if not reps:
            return []
        oldest = reps[-1]["report_date"]
        pos = conn.execute(
            "SELECT report_date, grp, long, short, spread, traders_long, traders_short FROM cot_positions"
            " WHERE code = ? AND report_date >= ?", (code, oldest)).fetchall()
    by_date: dict[str, dict] = {}
    for p in pos:
        by_date.setdefault(p["report_date"], {})[p["grp"]] = {
            "long": p["long"], "short": p["short"], "net": p["long"] - p["short"], "spread": p["spread"],
            "traders_long": p["traders_long"], "traders_short": p["traders_short"]}
    return [{"date": r["report_date"], "released": released_on(r["report_date"]), "oi": r["oi"],
             "conc4_long": r["conc4_long"], "conc4_short": r["conc4_short"],
             "conc8_long": r["conc8_long"], "conc8_short": r["conc8_short"],
             "groups": by_date.get(r["report_date"], {})} for r in reps]


def summarize(code: str, rows: list[dict], window: int) -> dict | None:
    """Snapshot for one contract from newest-first rows (pure — tested)."""
    if not rows:
        return None
    meta = CONTRACTS[code]
    cur = rows[0]
    prev = rows[1] if len(rows) > 1 else None
    groups = {}
    for grp in _FIELDS[meta["ds"]]:
        g = cur["groups"].get(grp)
        if not g:
            continue
        net_oi = [(r["groups"][grp]["net"] / r["oi"]) if grp in r["groups"] and r["oi"] else None
                  for r in rows]
        pg = prev["groups"].get(grp) if prev else None
        groups[grp] = {
            "long": g["long"], "short": g["short"], "net": g["net"],
            "net_oi": round(100 * g["net"] / cur["oi"], 2),
            "d_net": (g["net"] - pg["net"]) if pg else None,
            "traders_long": g["traders_long"], "traders_short": g["traders_short"],
            **crowding(net_oi, window),
        }
    return {
        "code": code, "key": meta["key"], "label": meta["label"], "dataset": meta["ds"],
        "class": meta["cls"], "focus": meta["focus"], "yahoo": meta["yahoo"], "dv01": meta["dv01"],
        "as_of": cur["date"], "released": cur["released"], "oi": cur["oi"],
        "d_oi": (cur["oi"] - prev["oi"]) if prev else None,
        "conc4_long": cur["conc4_long"], "conc4_short": cur["conc4_short"],
        "conc8_long": cur["conc8_long"], "conc8_short": cur["conc8_short"],
        "groups": groups,
    }


# ── Crowding flags ────────────────────────────────────────────────────────────
# Named conditions, not market events: a crowded book is the fuel for a move,
# not the move itself — it can sit crowded for months. So these never set a
# floor under TAIL's risk level. Thresholds are on net/OI over the window:
# |z| ≥ 2 or percentile ≤ 5 / ≥ 95. Backtest 2026-09-25 (backtest-idea/06_cot_crowding):
# WEAK against SPY tail days — some flag is lit most weeks. Context only.
#
# (id, label, [contract keys], group, side, why). side "short" = crowded net
# short (low pct / negative z), "long" = crowded net long.

Z_EXTREME = 2.0
PCT_LOW, PCT_HIGH = 5.0, 95.0

FLAG_RULES: list[tuple[str, str, list[str], str, str, str]] = [
    ("rates_short_crowding", "Rates Short Crowding", ["SOFR3M"], "lev", "short",
     "Funds heavily short SOFR futures = betting on fewer cuts; a dovish surprise forces covering"),
    ("duration_long_crowding", "Duration Long Crowding", ["UST10Y", "UXY", "USB", "ULTRA"], "am", "long",
     "Asset managers unusually long duration; a hawkish/inflation surprise hits a one-sided book"),
    ("short_vol_crowding", "Short-Vol Crowding", ["VIX"], "am", "short",
     "Asset managers net short VIX futures at an extreme — the Volmageddon setup"),
    ("short_vol_crowding_lev", "Short-Vol Crowding (Funds)", ["VIX"], "lev", "short",
     "Leveraged funds net short VIX futures at an extreme"),
    ("carry_unwind_risk", "Yen Carry Crowding", ["JPY"], "lev", "short",
     "Funds net short yen at an extreme = carry trade crowded; a yen rally forces an unwind (Aug 2024)"),
    ("smallcap_squeeze_risk", "Small-Cap Short Crowding", ["RTY"], "lev", "short",
     "Funds heavily short Russell futures; a risk-on turn can squeeze"),
    ("equity_long_crowding", "Equity Long Crowding", ["ES", "NQ"], "am", "long",
     "Asset managers at the top of their equity-futures range — little buying left"),
    ("commodity_long_crowding", "Commodity Long Crowding", ["WTI", "GOLD", "COPPER"], "mm", "long",
     "Managed money at an extreme long in the commodity"),
    ("commodity_short_crowding", "Commodity Short Crowding", ["WTI", "GOLD", "COPPER"], "mm", "short",
     "Managed money at an extreme short in the commodity"),
]


def _extreme(g: dict, side: str) -> bool:
    z, pct = g.get("z"), g.get("pct")
    if z is None or pct is None:
        return False
    if side == "short":
        return z <= -Z_EXTREME or pct <= PCT_LOW
    return z >= Z_EXTREME or pct >= PCT_HIGH


def crowding_flags(contracts: list[dict]) -> list[dict]:
    """Every rule that fires, one entry per (rule, contract). Pure — tested."""
    by_key = {c["key"]: c for c in contracts}
    out = []
    for fid, label, keys, grp, side, why in FLAG_RULES:
        for k in keys:
            c = by_key.get(k)
            g = (c or {}).get("groups", {}).get(grp)
            if not g or not _extreme(g, side):
                continue
            out.append({"id": fid, "label": label, "contract": k, "contract_label": c["label"],
                        "group": grp, "side": side, "z": g["z"], "pct": g["pct"],
                        "net_oi": g["net_oi"], "as_of": c["as_of"], "released": c["released"],
                        "why": why})
    return out


def build_snapshot(window: int = 156) -> dict:
    contracts = [s for s in (summarize(c, _load(c, window), window) for c in CONTRACTS) if s]
    as_of = max((c["as_of"] for c in contracts), default=None)
    return {"window": window, "as_of": as_of, "released": released_on(as_of) if as_of else None,
            "contracts": contracts, "flags": crowding_flags(contracts), "status": _status()}


# ── Treasury basis trade (BOND view) ──────────────────────────────────────────
# Cash-futures basis: asset managers hold duration LONG in futures, leveraged
# funds sell those futures and buy the cash bond on repo. Summing positions
# across tenors needs DV01 weights — a 2Y contract carries ~1/4 the rate risk of
# a Bond contract — so every net is converted to 10Y-note equivalents.

BASIS_TENORS = [c for c, m in CONTRACTS.items() if m["dv01"]]


def basis_series(rows_by_code: dict[str, list[dict]]) -> list[dict]:
    """Oldest-first weekly 10Y-eq nets per group, only on weeks where EVERY tenor
    reported — a tenor dropping in or out would read as a position change.
    Pure — tested."""
    by_date: dict[str, dict[str, dict]] = {}
    for code, rows in rows_by_code.items():
        for r in rows:
            by_date.setdefault(r["date"], {})[code] = r
    out = []
    for d in sorted(by_date):
        per = by_date[d]
        if any(c not in per for c in rows_by_code):
            continue
        row = {"date": d, "released": released_on(d)}
        for grp in ("am", "lev", "dealer"):
            row[grp] = round(sum(CONTRACTS[c]["dv01"] * per[c]["groups"].get(grp, {}).get("net", 0.0)
                                 for c in rows_by_code))
        row["oi"] = round(sum(CONTRACTS[c]["dv01"] * per[c]["oi"] for c in rows_by_code))
        out.append(row)
    return out


def build_basis(window: int = 156, weeks: int = 260) -> dict:
    rows_by_code = {c: _load(c, max(window, weeks)) for c in BASIS_TENORS}
    rows_by_code = {c: r for c, r in rows_by_code.items() if r}
    series = basis_series(rows_by_code)
    newest_first = list(reversed(series))
    stats = {}
    for grp in ("am", "lev", "dealer"):
        cur = newest_first[0][grp] if newest_first else None
        prev = newest_first[1][grp] if len(newest_first) > 1 else None
        stats[grp] = {"net": cur, "d_net": (cur - prev) if cur is not None and prev is not None else None,
                      **crowding([r[grp] / r["oi"] if r["oi"] else None for r in newest_first], window)}
    tenors = [s for s in (summarize(c, rows_by_code[c], window) for c in rows_by_code) if s]
    for t in tenors:
        t["dv01_net"] = {g: round(t["dv01"] * v["net"]) for g, v in t["groups"].items()}
    return {"window": window, "as_of": series[-1]["date"] if series else None,
            "released": series[-1]["released"] if series else None,
            "unit": "10Y-note equivalent contracts (approx DV01 weights)",
            "stats": stats, "series": series[-weeks:], "tenors": tenors, "status": _status()}


# ── Positioning factor (MKT REGIME → COT) ─────────────────────────────────────
# One number for "how is the whole futures book leaning": PC1 of the causal
# rolling z of each contract's focus-group net/OI. Display only — it is not fed
# into the regime HMM, whose calibration it would change without a backtest.

def rolling_z(values: list[float | None], window: int) -> list[float | None]:
    """Oldest-first causal z: each point against the `window` points ending at it."""
    out: list[float | None] = []
    for i in range(len(values)):
        xs = [v for v in values[max(0, i - window + 1): i + 1] if v is not None]
        if values[i] is None or len(xs) < _MIN_OBS:
            out.append(None)
            continue
        mu = sum(xs) / len(xs)
        sd = math.sqrt(sum((v - mu) ** 2 for v in xs) / len(xs))
        out.append((values[i] - mu) / sd if sd > 0 else 0.0)
    return out


def positioning_factor(z_by_key: dict[str, dict[str, float | None]], min_contracts: int = 8) -> dict:
    """PC1 over weeks where every included contract has a z. Pure — tested.

    `z_by_key` = {contract key: {date: z}}. Contracts missing from too many
    weeks are dropped rather than shrinking the sample to their history.
    Sign: the largest-|loading| contract loads positive, so the factor's
    direction does not flip between refreshes.
    """
    import numpy as np

    dates = sorted({d for zs in z_by_key.values() for d in zs})
    if not dates:
        return {"series": [], "loadings": {}, "explained": None, "weeks": 0}
    recent = dates[-260:]
    keys = [k for k, zs in z_by_key.items()
            if sum(zs.get(d) is not None for d in recent) >= 0.9 * len(recent)]
    rows = [d for d in dates if all(z_by_key[k].get(d) is not None for k in keys)]
    if len(keys) < min_contracts or len(rows) < _MIN_OBS:
        return {"series": [], "loadings": {}, "explained": None, "weeks": len(rows)}
    X = np.array([[z_by_key[k][d] for k in keys] for d in rows], dtype=float)
    Xc = X - X.mean(axis=0)
    _, s, vt = np.linalg.svd(Xc, full_matrices=False)
    w = vt[0]
    if w[np.argmax(np.abs(w))] < 0:
        w = -w
    pc = Xc @ w
    explained = float(s[0] ** 2 / (s ** 2).sum())
    return {"series": [{"date": d, "value": round(float(v), 3)} for d, v in zip(rows, pc)],
            "loadings": {k: round(float(x), 3) for k, x in zip(keys, w)},
            "explained": round(explained, 3), "weeks": len(rows)}


_factor_cache: dict[tuple, dict] = {}


def build_factor(window: int = 156, weeks: int = 520) -> dict:
    # ~1s of pure-Python rolling z; the inputs only change once a week.
    key = (window, weeks, tuple(sorted(_latest_dates().items())))
    if key in _factor_cache:
        return {**_factor_cache[key], "status": _status()}
    z_by_key: dict[str, dict[str, float | None]] = {}
    for code, meta in CONTRACTS.items():
        rows = list(reversed(_load(code, weeks + window)))
        if not rows:
            continue
        g = meta["focus"]
        vals = [(r["groups"][g]["net"] / r["oi"]) if g in r["groups"] and r["oi"] else None for r in rows]
        z_by_key[meta["key"]] = dict(zip([r["date"] for r in rows], rolling_z(vals, window)))
    f = positioning_factor(z_by_key)
    f["series"] = f["series"][-weeks:]
    f.update({"window": window, "group": "focus (lev funds / managed money) net/OI",
              "as_of": f["series"][-1]["date"] if f["series"] else None})
    _factor_cache.clear()
    _factor_cache[key] = f
    return {**f, "status": _status()}


# ── Portfolio vs crowd (PORT → RISK) ──────────────────────────────────────────
# Which of the book's exposures sit on the same side as a crowded futures
# positioning. Mapping is explicit for futures/ETFs/crypto and a PROXY for US
# single stocks (→ E-mini S&P: the market leg of their risk, nothing about the
# name itself). Thai/other listings have no CFTC contract and are left out.
# Keep SYMBOL_MAP in step with COT_KEY_BY_SYMBOL in hooks/useCot.ts.

SYMBOL_MAP: dict[str, str] = {
    "ES=F": "ES", "^GSPC": "ES", "SPY": "ES", "VOO": "ES", "IVV": "ES",
    "NQ=F": "NQ", "^NDX": "NQ", "QQQ": "NQ",
    "RTY=F": "RTY", "^RUT": "RTY", "IWM": "RTY",
    "^VIX": "VIX", "VX=F": "VIX", "VXX": "VIX", "UVXY": "VIX", "SVXY": "VIX",
    "JPY=X": "JPY", "6J=F": "JPY", "FXY": "JPY",
    "EURUSD=X": "EUR", "6E=F": "EUR", "FXE": "EUR",
    "BTC-USD": "BTC", "BTC=F": "BTC", "IBIT": "BTC",
    "CL=F": "WTI", "USO": "WTI",
    "GC=F": "GOLD", "GLD": "GOLD", "IAU": "GOLD",
    "HG=F": "COPPER", "CPER": "COPPER",
    "ZT=F": "UST2Y", "SHY": "UST2Y", "ZF=F": "UST5Y", "IEI": "UST5Y",
    "ZN=F": "UST10Y", "IEF": "UST10Y", "TN=F": "UXY",
    "ZB=F": "USB", "TLT": "USB", "UB=F": "ULTRA",
}
# Inverse / short-vol products: holding them LONG is a short position in the contract.
_INVERSE = {"SVXY"}


def map_symbol(symbol: str, market: str | None) -> tuple[str, bool] | None:
    """symbol → (contract key, is_proxy). None when no CFTC contract applies."""
    s = (symbol or "").upper()
    if s in SYMBOL_MAP:
        return SYMBOL_MAP[s], False
    if (market or "").upper() == "US" and "=" not in s and "^" not in s and "." not in s:
        return "ES", True
    return None


def portfolio_crowding(positions: list[dict], contracts: list[dict], flags: list[dict]) -> dict:
    """Pure — tested. positions: {symbol, market, volume, market_value_base}."""
    by_key = {c["key"]: c for c in contracts}
    total = sum(abs(p.get("market_value_base") or 0) for p in positions) or 0.0
    expo: dict[str, dict] = {}
    unmapped = 0.0
    unpriced: list[str] = []
    for p in positions:
        if p.get("market_value_base") is None:
            # No live price this pull: unknown size, and 0 would read as a side.
            unpriced.append(p.get("symbol"))
            continue
        mv = float(p["market_value_base"])
        m = map_symbol(p.get("resolved_symbol") or p.get("symbol"), p.get("market"))
        if not m:
            unmapped += abs(mv)
            continue
        key, proxy = m
        short_lot = float(p.get("volume") or 0) < 0
        inverse = (p.get("resolved_symbol") or p.get("symbol") or "").upper() in _INVERSE
        sign = -1 if short_lot != inverse else 1   # a short lot of an inverse product is long
        e = expo.setdefault(key, {"key": key, "exposure": 0.0, "symbols": set(), "proxy": False})
        e["exposure"] += sign * abs(mv)
        e["symbols"].add(p.get("symbol"))
        e["proxy"] = e["proxy"] or proxy
    rows = []
    for key, e in expo.items():
        if not e["exposure"]:
            continue
        c = by_key.get(key)
        side = "long" if e["exposure"] > 0 else "short"
        rel = []
        for f in (x for x in flags if x["contract"] == key):
            rel.append({**f, "relation": "WITH_CROWD" if f["side"] == side else "AGAINST_CROWD"})
        focus = (c or {}).get("groups", {}).get((c or {}).get("focus"), {})
        rows.append({
            "key": key, "label": (c or {}).get("label", key), "side": side,
            "exposure": round(e["exposure"], 2),
            "weight_pct": round(100 * abs(e["exposure"]) / total, 2) if total else None,
            "symbols": sorted(s for s in e["symbols"] if s), "proxy": e["proxy"],
            "focus": (c or {}).get("focus"), "focus_z": focus.get("z"), "focus_pct": focus.get("pct"),
            "flags": rel,
        })
    rows.sort(key=lambda r: -(r["weight_pct"] or 0))
    with_crowd = [r for r in rows if any(f["relation"] == "WITH_CROWD" for f in r["flags"])]
    return {
        "rows": rows,
        "with_crowd_weight_pct": round(sum(r["weight_pct"] or 0 for r in with_crowd), 2),
        "mapped_weight_pct": round(100 * (total - unmapped) / total, 2) if total else None,
        "unmapped_weight_pct": round(100 * unmapped / total, 2) if total else None,
        "unpriced": sorted({s for s in unpriced if s}),
    }


def _status() -> dict:
    return {"running": _refresher.running(), "last_error": _refresher.last_error,
            "cooldown": _refresher.cooldown_until > time.time(),
            "rows_last_run": _refresher.rows_last_run, "expected_as_of": expected_as_of(),
            "stored": len(_latest_dates()), "contracts": len(CONTRACTS)}


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/api/cot/snapshot")
def cot_snapshot(window: int = Query(156, ge=_MIN_OBS, le=1040)):
    _refresher.ensure()
    return build_snapshot(window)


@router.get("/api/cot/history")
def cot_history(code: str, weeks: int = Query(156, ge=1, le=1200)):
    if code not in CONTRACTS:
        # Also accept the short key (ES, UST10Y …) — the UI knows those.
        code = next((c for c, m in CONTRACTS.items() if m["key"] == code.upper()), code)
    if code not in CONTRACTS:
        raise HTTPException(404, f"Unknown COT contract {code}")
    _refresher.ensure()
    meta = CONTRACTS[code]
    return {"code": code, "key": meta["key"], "label": meta["label"], "dataset": meta["ds"],
            "focus": meta["focus"], "rows": list(reversed(_load(code, weeks))), "status": _status()}


@router.get("/api/cot/basis")
def cot_basis(window: int = Query(156, ge=_MIN_OBS, le=1040), weeks: int = Query(260, ge=4, le=1040)):
    _refresher.ensure()
    return build_basis(window, weeks)


@router.get("/api/cot/factor")
def cot_factor(window: int = Query(156, ge=_MIN_OBS, le=520), weeks: int = Query(260, ge=_MIN_OBS, le=1040)):
    _refresher.ensure()
    return build_factor(window, weeks)


@router.get("/api/cot/portfolio")
def cot_portfolio(account_id: str | None = Query(None), base_currency: str = Query("THB")):
    """Open positions × crowding flags. Reads live prices through portfolio_v2."""
    from routers.portfolio_v2 import _open_positions_enriched

    _refresher.ensure()
    snap = build_snapshot()
    positions = _open_positions_enriched(account_id, base_currency).get("positions", [])
    return {"as_of": snap["as_of"], "released": snap["released"], "base_currency": base_currency,
            **portfolio_crowding(positions, snap["contracts"], snap["flags"]), "status": snap["status"]}


@router.get("/api/cot/status")
def cot_status():
    _refresher.ensure()
    return _status()
