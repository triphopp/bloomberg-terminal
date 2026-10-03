"""
US petroleum balance from the EIA Weekly Petroleum Status Report, and what it
says about the energy leg of inflation.

Source: EIA API v2, route `petroleum/sum/sndw` — the one route that carries
stocks, production, refinery utilisation and product supplied together, so the
whole history is ONE call. The key goes in the `X-Api-Key` header (never the
URL). Without `EIA_API_KEY` the public `DEMO_KEY` is used: it works, but EIA
caps it at 10 calls an hour per address, which is why a pull is kept 6 hours, a
failure is negative-cached, and the last good frame is served in between.

Retail gasoline / diesel and WTI come from FRED (GASREGW, GASDESW, DCOILWTICO —
EIA's own numbers, republished) because FRED is already keyed and retried.

`read_energy` is context, like the rest of MACRO READ: a rule over today's
numbers with no backtest behind it. It never touches the composite.
"""
from __future__ import annotations

import os
import time
from datetime import date, timedelta
from typing import Optional

import pandas as pd
import requests

import last_good
from cache import TTLCache

EIA_URL = "https://api.eia.gov/v2/petroleum/sum/sndw/data/"

#: EIA series id → (key, label, unit shown). Stocks arrive in thousand barrels.
SERIES: dict[str, tuple[str, str, str]] = {
    "WCESTUS1": ("crude", "CRUDE ex-SPR", "mb"),
    "WGTSTUS1": ("gasoline", "GASOLINE", "mb"),
    "WDISTUS1": ("distillate", "DISTILLATE", "mb"),
    "W_EPC0_SAX_YCUOK_MBBL": ("cushing", "CUSHING", "mb"),
    "WCSSTUS1": ("spr", "SPR", "mb"),
    "WCRFPUS2": ("production", "CRUDE OUTPUT", "kb/d"),
    "WPULEUS3": ("refinery_util", "REFINERY UTIL", "%"),
    "WGFUPUS2": ("gasoline_demand", "GASOLINE DEMAND", "kb/d"),
    "WDIUPUS2": ("distillate_demand", "DISTILLATE DEMAND", "kb/d"),
}
STOCK_KEYS = ("crude", "gasoline", "distillate", "cushing", "spr")
#: The three stocks a price shock has to get through. SPR is policy, Cushing is
#: already inside crude.
CUSHION_KEYS = ("crude", "gasoline", "distillate")

FRED_PRICES = {"gasoline_retail": ("GASREGW", 60), "diesel_retail": ("GASDESW", 60), "wti": ("DCOILWTICO", 270)}

HISTORY_YEARS = 6          # 5 seasonal comparisons + the current year
SEASONAL_YEARS = 5

#: Stocks this far from their 5-year seasonal average count as tight / ample (%).
CUSHION_BAND_PCT = 5.0
#: Retail gasoline move that counts as a price impulse (%), YoY or over 13 weeks.
PRICE_IMPULSE_PCT = 10.0
#: Gasoline's share of the CPI basket, roughly — BLS relative importance has sat
#: near 3% in recent years. Used only for the "≈ pp of headline CPI" arithmetic.
GASOLINE_CPI_WEIGHT = 0.03

_cache = TTLCache(ttl=6 * 3600)
_FAIL_TTL = 15 * 60
_failed_at = 0.0
_LG_KEY = "oil_eia_weekly"


def _api_key() -> tuple[str, bool]:
    k = os.getenv("EIA_API_KEY", "").strip()
    return (k, False) if k else ("DEMO_KEY", True)


def _fetch_eia(today: date) -> Optional[pd.DataFrame]:
    key, _demo = _api_key()
    start = today - timedelta(days=366 * HISTORY_YEARS)
    params = [("frequency", "weekly"), ("data[0]", "value"), ("start", start.isoformat()),
              ("length", "5000")] + [("facets[series][]", s) for s in SERIES]
    r = requests.get(EIA_URL, params=params, headers={"X-Api-Key": key}, timeout=30)
    r.raise_for_status()
    rows = (r.json().get("response") or {}).get("data") or []
    recs = []
    for x in rows:
        meta = SERIES.get(x.get("series"))
        try:
            v = float(x.get("value"))
        except (TypeError, ValueError):
            continue
        if meta:
            recs.append((x["period"], meta[0], v))
    if not recs:
        return None
    df = pd.DataFrame(recs, columns=["period", "key", "value"])
    wide = df.pivot_table(index="period", columns="key", values="value", aggfunc="last")
    wide.index = pd.to_datetime(wide.index)
    wide = wide.sort_index()
    for k in STOCK_KEYS:
        if k in wide:
            wide[k] = wide[k] / 1000.0  # thousand → million barrels
    return wide


def weekly_frame(today: Optional[date] = None) -> tuple[Optional[pd.DataFrame], Optional[float]]:
    """(frame, stale_age_seconds). stale_age is None when the pull is fresh."""
    global _failed_at
    today = today or date.today()
    hit = _cache.get("weekly")
    if hit is not None:
        return hit, None
    if time.time() - _failed_at >= _FAIL_TTL:
        try:
            df = _fetch_eia(today)
        except Exception as exc:
            # Type only — never the exception text, which can carry the request.
            print(f"[oil_inventory] EIA fetch failed: {type(exc).__name__}")
            df = None
        if df is not None and not df.empty:
            _cache.set("weekly", df)
            last_good.remember(_LG_KEY, df)
            return df, None
        _failed_at = time.time()
    return last_good.recall(_LG_KEY, "TAIL oil balance (EIA weekly)", "EIA")


def _fred_prices() -> dict[str, pd.Series]:
    hit = _cache.get("prices", ttl=3600)
    if hit is not None:
        return hit
    if _cache.get("prices_failed", ttl=_FAIL_TTL):
        return {}
    from routers.global_yields import _fred_fetch

    out: dict[str, pd.Series] = {}
    for k, (sid, n) in FRED_PRICES.items():
        try:
            obs = _fred_fetch(sid, limit=n)
            if obs:
                out[k] = pd.Series([o["value"] for o in obs], index=pd.to_datetime([o["date"] for o in obs]))
        except Exception as exc:
            print(f"[oil_inventory] FRED {sid} failed: {type(exc).__name__}")
    # A good pull is kept an hour; an empty one is negative-cached 15 min so a
    # FRED outage is not re-fired on every request.
    _cache.set("prices" if out else "prices_failed", out or True)
    return out


# ── Pure computation ──────────────────────────────────────────────────────────

def _at(s: pd.Series, when: pd.Timestamp, tol_days: int = 4) -> Optional[float]:
    """Value of the observation nearest `when`, or None if none within tolerance."""
    if s.empty:
        return None
    i = s.index.get_indexer([when], method="nearest")[0]
    if i < 0 or abs((s.index[i] - when).days) > tol_days:
        return None
    return float(s.iloc[i])


def seasonal(s: pd.Series) -> Optional[dict]:
    """The same week in each of the previous five years: mean, low, high."""
    s = s.dropna()
    if s.empty:
        return None
    last = s.index[-1]
    vals = [v for k in range(1, SEASONAL_YEARS + 1)
            if (v := _at(s, last - pd.Timedelta(weeks=52 * k))) is not None]
    if len(vals) < 3:
        return None
    return {"avg": sum(vals) / len(vals), "low": min(vals), "high": max(vals), "years": len(vals)}


def _pct(a: Optional[float], b: Optional[float]) -> Optional[float]:
    return None if a is None or b in (None, 0) else round((a / b - 1.0) * 100.0, 2)


def _row(key: str, label: str, unit: str, s: pd.Series, with_seasonal: bool) -> dict:
    s = s.dropna()
    v = float(s.iloc[-1])
    prev = float(s.iloc[-2]) if len(s) > 1 else None
    yago = _at(s, s.index[-1] - pd.Timedelta(weeks=52))
    row = {
        "key": key, "label": label, "unit": unit, "value": round(v, 3),
        "date": s.index[-1].strftime("%Y-%m-%d"),
        "chg_w": None if prev is None else round(v - prev, 3),
        "yoy_pct": _pct(v, yago),
        "vs_5y_pct": None, "low_5y": None, "high_5y": None,
    }
    if with_seasonal and (sea := seasonal(s)):
        row.update(vs_5y_pct=_pct(v, sea["avg"]), low_5y=round(sea["low"], 3), high_5y=round(sea["high"], 3))
    return row


def _price_row(key: str, label: str, s: pd.Series, weeks13_obs: int) -> dict:
    s = s.dropna()
    v = float(s.iloc[-1])
    return {
        "key": key, "label": label, "unit": "$/gal" if "retail" in key else "$/bbl",
        "value": round(v, 3), "date": s.index[-1].strftime("%Y-%m-%d"),
        "yoy_pct": _pct(v, _at(s, s.index[-1] - pd.Timedelta(days=364), tol_days=6)),
        "chg_13w_pct": _pct(v, float(s.iloc[-1 - weeks13_obs])) if len(s) > weeks13_obs else None,
    }


def snapshot(df: Optional[pd.DataFrame], prices: Optional[dict[str, pd.Series]] = None) -> Optional[dict]:
    """Latest week against last week, last year and the 5-year seasonal range."""
    if df is None or df.empty:
        return None
    rows = []
    for _sid, (key, label, unit) in SERIES.items():
        if key in df and df[key].notna().any():
            rows.append(_row(key, label, unit, df[key], with_seasonal=key != "spr"))
    by = {r["key"]: r for r in rows}

    # One number for the cushion: crude + gasoline + distillate against the sum
    # of their own seasonal averages.
    now = avg = 0.0
    used = []
    for k in CUSHION_KEYS:
        r = by.get(k)
        if r and r["vs_5y_pct"] is not None:
            now += r["value"]
            avg += r["value"] / (1 + r["vs_5y_pct"] / 100.0)
            used.append(k)
    cushion = _pct(now, avg) if len(used) == len(CUSHION_KEYS) else None

    price_rows = []
    labels = {"gasoline_retail": "RETAIL GASOLINE", "diesel_retail": "RETAIL DIESEL", "wti": "WTI"}
    for k, s in (prices or {}).items():
        if s is not None and not s.dropna().empty:
            price_rows.append(_price_row(k, labels.get(k, k), s, 63 if k == "wti" else 13))

    as_of = max(r["date"] for r in rows) if rows else None
    return {"week_ending": as_of, "rows": rows, "prices": price_rows, "cushion_vs_5y_pct": cushion}


def read_energy(snap: Optional[dict], inflation_state: Optional[str] = None) -> dict:
    """The energy axis of MACRO READ: retail gasoline as the price impulse into
    headline CPI, stocks against their seasonal norm as the cushion behind it,
    and the inflation axis as what that impulse lands on."""
    rule = (f"retail gasoline ±{PRICE_IMPULSE_PCT:.0f}% YoY or over 13w = impulse; "
            f"crude+gasoline+distillate stocks ±{CUSHION_BAND_PCT:.0f}% vs 5y seasonal avg = tight/ample; "
            f"worse when inflation is STICKY/REFLATION. CPI effect ≈ YoY × {GASOLINE_CPI_WEIGHT:.0%} basket weight")
    base = {"id": "energy", "label": "ENERGY → CPI", "unit": "%", "rule": rule, "source": "EIA weekly + FRED"}
    if not snap:
        return {**base, "state": None, "tone": "unknown", "value": None, "detail": "no EIA data"}

    gas = next((p for p in snap.get("prices", []) if p["key"] == "gasoline_retail"), None)
    yoy = gas["yoy_pct"] if gas else None
    q13 = gas["chg_13w_pct"] if gas else None
    cushion = snap.get("cushion_vs_5y_pct")
    if yoy is None and cushion is None:
        return {**base, "state": None, "tone": "unknown", "value": None, "detail": "no EIA data"}

    hot = inflation_state in ("STICKY", "REFLATION")
    tight = cushion is not None and cushion <= -CUSHION_BAND_PCT
    ample = cushion is not None and cushion >= CUSHION_BAND_PCT
    rising = (yoy is not None and yoy >= PRICE_IMPULSE_PCT) or (q13 is not None and q13 >= PRICE_IMPULSE_PCT)
    falling = yoy is not None and yoy <= -PRICE_IMPULSE_PCT and not (q13 is not None and q13 > 0)

    if rising:
        state, tone = "PRICE PRESSURE", ("bad" if hot or tight else "watch")
    elif tight:
        state, tone = "THIN CUSHION", ("bad" if hot and q13 is not None and q13 > 0 else "watch")
    elif falling:
        state, tone = "DISINFLATIONARY", "good"
    else:
        state, tone = ("AMPLE" if ample else "NEUTRAL"), "good"

    cpi_pp = None if yoy is None else round(yoy * GASOLINE_CPI_WEIGHT, 2)
    bits = []
    if yoy is not None:
        bits.append(f"gasoline {yoy:+.1f}% YoY (≈{cpi_pp:+.2f}pp CPI)")
    if q13 is not None:
        bits.append(f"13w {q13:+.1f}%")
    if cushion is not None:
        bits.append(f"stocks {cushion:+.1f}% vs 5y")
    if inflation_state and tone != "good":
        bits.append(f"inflation {inflation_state}")
    return {
        **base, "state": state, "tone": tone, "value": yoy, "detail": " · ".join(bits),
        "cpi_pp_est": cpi_pp, "cushion_vs_5y_pct": cushion, "gasoline_13w_pct": q13,
        "inflation_state": inflation_state,
    }


def oil_payload(today: Optional[date] = None) -> Optional[dict]:
    """Everything the TAIL oil panel shows. None when EIA has never answered."""
    from event_calendar import eia_weekly

    today = today or date.today()
    df, stale_age = weekly_frame(today)
    snap = snapshot(df, _fred_prices())
    if snap is None:
        return None
    wed = today + timedelta(days=(2 - today.weekday()) % 7)
    nxt = eia_weekly(wed)
    if nxt < today:
        nxt = eia_weekly(wed + timedelta(days=7))
    last = eia_weekly(wed - timedelta(days=7)) if eia_weekly(wed) > today else eia_weekly(wed)
    # NEW for two days after the report, and only once the week it covers is in.
    covered = snap["week_ending"] and (last - date.fromisoformat(snap["week_ending"])).days <= 7
    _key, demo = _api_key()
    return {
        **snap,
        "released": last.isoformat(),
        "new": bool(covered and (today - last).days <= 2),
        "pending": not covered,
        "next_release": nxt.isoformat(),
        "stale_age_s": None if stale_age is None else round(stale_age),
        "demo_key": demo,
        "source": "EIA Weekly Petroleum Status Report (api.eia.gov) · prices FRED",
        "counted_in_composite": False,
    }
