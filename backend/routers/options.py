import json
import hashlib
import math
import uuid
from bisect import bisect_left, bisect_right
from datetime import date, datetime, timedelta
from typing import Any, Literal, Optional, Sequence

import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from analytics.svi import fit_raw_svi

from analytics.sd_bands import (
    BUCKET_PROBS,
    LEVEL_EXCEED_PROBS,
    SD_LEVELS,
    atm_iv_pair,
    bucket_of,
    bucket_probs_under,
    realized_vol_series,
    sd_band,
)
from cache import TTLCache
from analytics.option_payoff import build_payoff
from db import get_db, occ_symbol
from portfolio_options import _chain_rows
from greeks import compute_greeks, estimate_moments
from providers.base_options import OptionContract
from providers.yahoo_options import YahooOptionsProvider
from sources import market_data
from sources.errors import UpstreamRateLimited, recently_rate_limited

router = APIRouter()

_options_chain_cache = TTLCache(ttl=300, maxsize=100)
_options_surface_cache = TTLCache(ttl=600, maxsize=100)
_sd_bands_cache = TTLCache(ttl=600, maxsize=60)
_svi_fit_cache = TTLCache(ttl=300, maxsize=200)

# Swap provider here — nothing else changes
_provider = YahooOptionsProvider()

_spot_cache = TTLCache(ttl=60, maxsize=200)


def underlying_spot(symbol: str) -> Optional[float]:
    """Last price of the UNDERLYING, not of the option contract.

    `OptionMarketData.last_price` is the contract's own `lastPrice` (the
    premium) — feeding that to Black-Scholes as `spot` prices a $200-strike
    call as if the share traded at $5.80, which drives every delta to ~0.
    See reports/options-greeks-spot-risk-report.md.
    """
    sym = (symbol or "").strip().upper()
    if not sym:
        return None
    cached = _spot_cache.get(sym)
    if cached is not None:
        return cached
    try:
        info = market_data.get_fast_info(sym)
        price = getattr(info, "last_price", None) or getattr(info, "regular_market_price", None)
    except Exception:
        price = None
    if not price or price <= 0:
        return None
    price = float(price)
    _spot_cache.set(sym, price)
    return price


def clean_df(df: pd.DataFrame) -> list[dict]:
    """Process options DataFrame columns, fill NaN, round floats."""
    columns = [
        "contractSymbol", "strike", "lastPrice", "bid", "ask",
        "volume", "openInterest", "impliedVolatility", "inTheMoney",
        "change", "percentChange",
    ]
    df = df[[c for c in columns if c in df.columns]].copy()

    # Preserve source availability before legacy numeric zero-filling. Existing
    # consumers keep openInterest:number; the OI chart can distinguish missing/0.
    if "openInterest" in df.columns:
        oi = pd.to_numeric(df["openInterest"], errors="coerce")
        valid = oi.notna() & oi.ge(0) & oi.le(2 ** 53 - 1) & oi.mod(1).eq(0)
        df["openInterestAvailable"] = valid.astype(bool)
        df["openInterest"] = oi.where(valid, 0)
    else:
        df["openInterestAvailable"] = False

    float_cols = ["strike", "lastPrice", "bid", "ask", "impliedVolatility", "change", "percentChange"]
    int_cols = ["volume", "openInterest"]
    bool_cols = ["inTheMoney"]

    for col in float_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0).round(4)
    for col in int_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0).astype(int)
    for col in bool_cols:
        if col in df.columns:
            df[col] = df[col].fillna(False).astype(bool)

    return df.to_dict(orient="records")


# Declared ahead of the `/api/options/{symbol}` chain route on purpose: that
# route matches any single segment, so a literal path registered after it is
# never reached. Keep every literal one-segment GET above this line.
class PayoffLeg(BaseModel):
    underlying: str
    expiry: str
    strike: float
    option_type: str            # "call" | "put"
    quantity: float             # signed: negative is short
    entry_price: float
    multiplier: float = 100
    fees: float = 0


class PayoffIn(BaseModel):
    legs: list[PayoffLeg]
    spot: Optional[float] = None      # default: live price of the first leg's underlying
    points: int = 121
    range_pct: float = 0.35


@router.post("/api/options/payoff")
async def compute_payoff(body: PayoffIn):
    """Payoff geometry for a set of legs — hypothetical or already held.

    Implied vol is pulled from each leg's own chain row. A leg whose contract is
    not quoted comes back with no IV, which drops the T+0 line and POP for the
    whole set: drawing them from the legs that happen to be quoted would be a
    different position than the one on screen.
    """
    if not body.legs:
        raise HTTPException(400, "at least one leg is required")

    spot = body.spot or underlying_spot(body.legs[0].underlying)
    if not spot or spot <= 0:
        raise HTTPException(422, f"No spot price for {body.legs[0].underlying}")

    legs = [leg.model_dump() for leg in body.legs]
    ivs: list[Optional[float]] = []
    for leg in body.legs:
        row = _chain_rows(leg.underlying.strip().upper(), str(leg.expiry)[:10]).get(
            (leg.option_type.lower(), round(float(leg.strike), 4))
        )
        iv = row.get("iv") if row else None
        try:
            ivs.append(float(iv) if iv and float(iv) > 0 else None)
        except (TypeError, ValueError):
            ivs.append(None)

    result = build_payoff(
        legs, float(spot), ivs,
        points=max(21, min(int(body.points), 401)),
        range_pct=max(0.05, min(float(body.range_pct), 2.0)),
    )
    result["currency"] = "USD"
    result["underlyings"] = sorted({leg.underlying.strip().upper() for leg in body.legs})
    return result


@router.get("/api/options/trades")
async def list_option_trades(account_id: str | None = Query(None), limit: int = Query(200)):
    """Every execution, newest first, with the greeks captured at each one."""
    where, params = ["1=1"], []
    if account_id and account_id != "all":
        where.append("t.account_id = ?")
        params.append(account_id)
    params.append(max(1, limit))
    with get_db() as conn:
        rows = conn.execute(
            "SELECT t.*, c.underlying, c.expiry, c.strike, c.option_type, "
            "       c.multiplier, c.currency, c.occ_symbol, "
            "       g.spot, g.iv, g.delta, g.gamma, g.theta, g.vega, g.rho, "
            "       g.source AS greeks_source, "
            "       COALESCE(m.matched, 0) AS quantity_matched "
            "FROM option_trades t "
            "JOIN option_contracts c ON c.contract_id = t.contract_id "
            "LEFT JOIN option_trade_greeks g ON g.trade_id = t.trade_id "
            "LEFT JOIN (SELECT open_trade_id, SUM(quantity) matched "
            "           FROM option_trade_matches GROUP BY open_trade_id) m "
            "       ON m.open_trade_id = t.trade_id "
            f"WHERE {' AND '.join(where)} "
            "ORDER BY t.trade_date DESC, t.created_at DESC LIMIT ?",
            params,
        ).fetchall()
    return [dict(r) for r in rows]


class SviSampleIn(BaseModel):
    strike: float = Field(gt=0, le=1e12, allow_inf_nan=False)
    ivPercent: float = Field(gt=0, le=10000, allow_inf_nan=False)


class SviSeriesIn(BaseModel):
    name: Literal["call", "put", "otm"]
    points: list[SviSampleIn] = Field(max_length=2000)


class SviFitIn(BaseModel):
    referencePrice: float = Field(gt=0, le=1e12, allow_inf_nan=False)
    timeYears: float = Field(gt=0, le=10, allow_inf_nan=False)
    series: list[SviSeriesIn] = Field(min_length=1, max_length=2)


@router.post("/api/options/smile-fit")
def fit_options_smile(body: SviFitIn):
    """CPU-bound, threadpool endpoint: calibrate supplied observations, never fetch Yahoo."""
    payload = body.model_dump()
    if len({item.name for item in body.series}) != len(body.series):
        raise HTTPException(status_code=422, detail="Duplicate series names")
    key = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    return _svi_fit_cache.get_or_set(key, lambda: {
        "model": "raw_svi", "coordinate": "log(K/S)",
        "objective": "soft_l1_total_variance",
        "series": {
            item["name"]: fit_raw_svi(item["points"], body.referencePrice, body.timeYears)
            for item in payload["series"]
        },
    })


@router.get("/api/options/{symbol}")
def get_options_chain(symbol: str, expiry: str | None = Query(None)):
    """Get options chain with data freshness metadata."""
    symbol = symbol.upper()
    cache_key = f"chain:{symbol}:{expiry or 'default'}"

    cached = _options_chain_cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        ticker = market_data.get_ticker(symbol)
        expirations = ticker.options

        if not expirations:
            # An empty list means one of two very different things, and yfinance
            # does not say which: this symbol has no options, or the request was
            # throttled and answered with silence. Reporting the first when the
            # second is true tells the reader a liquid name has no chain.
            if recently_rate_limited():
                raise UpstreamRateLimited("Yahoo Finance", symbol)
            raise HTTPException(status_code=404, detail=f"No options available for {symbol}")

        target_expiry = expiry if expiry and expiry in expirations else expirations[0]

        chain = ticker.option_chain(target_expiry)
        spot = ticker.info.get("regularMarketPrice") or ticker.info.get("currentPrice") or 0

        calls = clean_df(chain.calls)
        puts = clean_df(chain.puts)

        call_oi = sum(c.get("openInterest", 0) for c in calls)
        put_oi = sum(p.get("openInterest", 0) for p in puts)
        call_volume = sum(c.get("volume", 0) for c in calls)
        put_volume = sum(p.get("volume", 0) for p in puts)
        pc_ratio = round(put_oi / call_oi, 4) if call_oi > 0 else 0.0

        iv_call, iv_put, iv_mid, atm_strike = atm_iv_pair(calls, puts, spot)
        # `ivCurrent` predates the put side and is call-only by definition —
        # existing callers read it as "ATM call IV", so it keeps that meaning
        # and the mid is exposed alongside rather than replacing it.
        iv_current = round(iv_call, 4) if iv_call is not None else 0.0

        # Accumulating the IV history is a side effect of normal chain use: the
        # provider has no IV history to back-fill from, so a series only exists
        # if snapshots are written as they pass through.
        _record_iv_snapshot(
            symbol, target_expiry, spot, atm_strike, iv_call, iv_put, iv_mid
        )

        freshness = _provider.make_freshness().__dict__

        data = {
            "symbol": symbol,
            "spot": spot,
            "expiry": target_expiry,
            "expirations": list(expirations),
            "calls": calls,
            "puts": puts,
            "ivCurrent": iv_current,
            "ivCall": round(iv_call, 4) if iv_call is not None else None,
            "ivPut": round(iv_put, 4) if iv_put is not None else None,
            "ivMid": round(iv_mid, 4) if iv_mid is not None else None,
            "atmStrike": atm_strike,
            "pcRatio": pc_ratio,
            "callOI": call_oi,
            "putOI": put_oi,
            "callVolume": call_volume,
            "putVolume": put_volume,
            "freshness": freshness,
        }

        _options_chain_cache.set(cache_key, data)
        return data

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch options chain: {str(e)}")


@router.get("/api/options/{symbol}/surface")
async def get_options_surface(symbol: str):
    """Get volatility surface data with freshness metadata."""
    symbol = symbol.upper()
    cache_key = f"surface:{symbol}"

    cached = _options_surface_cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        ticker = market_data.get_ticker(symbol)
        expirations = ticker.options

        if not expirations:
            # An empty list means one of two very different things, and yfinance
            # does not say which: this symbol has no options, or the request was
            # throttled and answered with silence. Reporting the first when the
            # second is true tells the reader a liquid name has no chain.
            if recently_rate_limited():
                raise UpstreamRateLimited("Yahoo Finance", symbol)
            raise HTTPException(status_code=404, detail=f"No options available for {symbol}")

        spot = ticker.info.get("regularMarketPrice") or ticker.info.get("currentPrice") or 0
        if spot <= 0:
            raise HTTPException(status_code=500, detail=f"Could not determine spot price for {symbol}")

        surface = []
        target_expirations = list(expirations[:10])

        for exp in target_expirations:
            try:
                chain = ticker.option_chain(exp)
            except Exception:
                continue

            for option_type, df in [("call", chain.calls), ("put", chain.puts)]:
                for _, row in df.iterrows():
                    strike = float(row.get("strike", 0))
                    iv = float(row.get("impliedVolatility", 0))
                    moneyness = round(((strike - spot) / spot) * 100, 4)

                    if abs(moneyness) <= 40 and iv > 0.01:
                        surface.append({
                            "expiry": exp,
                            "strike": round(strike, 4),
                            "moneyness": moneyness,
                            "iv": round(iv * 100, 4),
                            "type": option_type,
                        })

        data = {
            "symbol": symbol,
            "spot": spot,
            "surface": surface,
            "expirations": target_expirations,
            "freshness": _provider.make_freshness().__dict__,
        }

        _options_surface_cache.set(cache_key, data)
        return data

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch volatility surface: {str(e)}")


# ── IV snapshots + SD bands ───────────────────────────────────────────────────

def _dte(expiry: str) -> int:
    """Calendar days to expiry, floored at 0. -1 signals an unparseable date."""
    try:
        exp = datetime.strptime(expiry, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return -1
    return max((exp - date.today()).days, 0)


#: Expiries this close in are excluded from the σ-band snapshot. Near-dated ATM
#: options are dominated by pin risk and gamma, not by any view on 30-day vol:
#: measured live on 2026-08-17 the 0DTE ATM pair came out at 12.3% call / 15.8%
#: put on SPY and 19.5% / 59.7% on AMD, so the "mid" of the two was meaningless.
IV_SNAPSHOT_MIN_DTE = 7

#: Horizon the snapshot is meant to describe, so the term structure is sampled
#: near the tenor the heatmap projects over rather than at whatever expires next.
IV_SNAPSHOT_TARGET_DTE = 30

#: Sanity band for a stored ATM implied vol, as a decimal.
#:
#: A thin chain quotes options at (or near) intrinsic value because nothing is
#: actually bid — solving that back out produces an "implied vol" of a percent or
#: two, which is not a vol at all. Observed live: SK hynix's ADR came back at
#: 1.56% ATM against 111% realized, which drew a σ-band ±0.45% wide and lit the
#: tails as maximally cheap. That is a data artefact presented as a signal, so it
#: is refused at the door rather than filtered downstream.
#:
#: The floor sits well under any real equity or ETF 30-day vol (a quiet bond ETF
#: still prints ~10%); the ceiling is above even a squeezing meme name.
IV_SANITY_MIN = 0.03
IV_SANITY_MAX = 5.0


def pick_snapshot_expiry(
    expirations: Sequence[str],
    target_dte: int = IV_SNAPSHOT_TARGET_DTE,
    min_dte: int = IV_SNAPSHOT_MIN_DTE,
) -> Optional[str]:
    """The expiry whose DTE sits closest to `target_dte`, ignoring the front week.

    `expirations[0]` — the obvious choice — is wrong here: on any Friday (or an
    index with daily expiries) that is a 0DTE contract whose ATM IV says nothing
    about a 30-day move. Ties break toward the LONGER expiry, which is the calmer
    of the two.

    Falls back to the longest expiry available when everything is inside
    `min_dte`, and returns None only for an empty chain.
    """
    dated = [(e, _dte(e)) for e in expirations]
    dated = [(e, d) for e, d in dated if d >= 0]
    if not dated:
        return None

    eligible = [(e, d) for e, d in dated if d >= min_dte]
    if not eligible:
        return max(dated, key=lambda pair: pair[1])[0]

    return min(eligible, key=lambda pair: (abs(pair[1] - target_dte), -pair[1]))[0]


def _record_iv_snapshot(
    symbol: str,
    expiry: str,
    spot: float,
    atm_strike: Optional[float],
    iv_call: Optional[float],
    iv_put: Optional[float],
    iv_mid: Optional[float],
) -> bool:
    """Upsert today's ATM IV for (symbol, expiry). Never raises.

    Called from the chain endpoint, so a schema problem or a locked DB must not
    take the chain down with it — the snapshot is a side effect, not the answer.
    Re-fetching the same day overwrites: the later read is the fresher one.
    """
    if iv_mid is None or spot <= 0:
        return False
    if not (IV_SANITY_MIN <= iv_mid <= IV_SANITY_MAX):
        return False
    dte = _dte(expiry)
    if dte < 0:
        return False

    try:
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO iv_snapshots
                    (symbol, snapshot_date, expiry, dte, spot, atm_strike,
                     iv_call, iv_put, iv_mid, source)
                VALUES (?,?,?,?,?,?,?,?,?,'yfinance')
                ON CONFLICT(symbol, snapshot_date, expiry) DO UPDATE SET
                    dte        = excluded.dte,
                    spot       = excluded.spot,
                    atm_strike = excluded.atm_strike,
                    iv_call    = excluded.iv_call,
                    iv_put     = excluded.iv_put,
                    iv_mid     = excluded.iv_mid,
                    created_at = datetime('now')
                """,
                (
                    symbol.upper(),
                    date.today().isoformat(),
                    expiry,
                    dte,
                    float(spot),
                    float(atm_strike) if atm_strike else None,
                    float(iv_call) if iv_call is not None else None,
                    float(iv_put) if iv_put is not None else None,
                    float(iv_mid),
                ),
            )
        # The σ-band answer is derived from exactly the rows just changed, and its
        # key fans out over period/mode/horizon/windows — so every variant for this
        # symbol has to go. Without this, recording a snapshot stays invisible for
        # the full 600s TTL and the pane keeps insisting there is no IV history,
        # which is precisely the moment the user is looking at it.
        _sd_bands_cache.delete_prefix(f"sd:{symbol.upper()}:")
        return True
    except Exception:
        return False


def _risk_free_rate() -> float:
    """US short rate for the risk-neutral drift, with a static fallback.

    Imported lazily: routers.risk pulls in the whole risk stack, which this
    module has no other reason to load.
    """
    try:
        from routers.risk import _risk_free
        return float(_risk_free("USD")["rate"])
    except Exception:
        return 0.0425


def _finite_or_none(x: float) -> Optional[float]:
    """JSON has no infinity — the two open bucket edges serialise as null."""
    return None if math.isinf(x) or math.isnan(x) else round(x, 4)


def record_snapshot_now(
    symbol: str,
    expiry: str | None = None,
    target_dte: int = IV_SNAPSHOT_TARGET_DTE,
) -> dict[str, Any]:
    """Fetch and store today's ATM IV. Plain function, callable off the web path.

    Split out from the endpoint on purpose: FastAPI parameter defaults are
    `Query(...)` marker objects, which only become real values when the framework
    resolves them. The background recorder called the endpoint coroutine directly
    and got `Query` where it expected an int, so every scheduled snapshot died in
    `pick_snapshot_expiry` with "unsupported operand type(s) for -: 'int' and
    'Query'" — silently, since the caller logs failures per symbol.

    Raises HTTPException so both callers report the same statuses (404 no chain,
    422 nothing usable).
    """
    symbol = symbol.upper()
    try:
        ticker = market_data.get_ticker(symbol)
        expirations = ticker.options
        if not expirations:
            # An empty list means one of two very different things, and yfinance
            # does not say which: this symbol has no options, or the request was
            # throttled and answered with silence. Reporting the first when the
            # second is true tells the reader a liquid name has no chain.
            if recently_rate_limited():
                raise UpstreamRateLimited("Yahoo Finance", symbol)
            raise HTTPException(status_code=404, detail=f"No options available for {symbol}")

        target_expiry = (
            expiry
            if expiry and expiry in expirations
            else pick_snapshot_expiry(expirations, target_dte)
        )
        if not target_expiry:
            raise HTTPException(status_code=404, detail=f"No usable expiry for {symbol}")

        chain = ticker.option_chain(target_expiry)
        spot = ticker.info.get("regularMarketPrice") or ticker.info.get("currentPrice") or 0

        calls = clean_df(chain.calls)
        puts = clean_df(chain.puts)
        iv_call, iv_put, iv_mid, atm_strike = atm_iv_pair(calls, puts, spot)

        stored = _record_iv_snapshot(
            symbol, target_expiry, spot, atm_strike, iv_call, iv_put, iv_mid
        )
        if not stored:
            raise HTTPException(
                status_code=422,
                detail=f"No usable ATM implied vol for {symbol} {target_expiry}",
            )

        return {
            "symbol": symbol,
            "snapshotDate": date.today().isoformat(),
            "expiry": target_expiry,
            "dte": _dte(target_expiry),
            "spot": spot,
            "atmStrike": atm_strike,
            "ivCall": iv_call,
            "ivPut": iv_put,
            "ivMid": iv_mid,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to record IV snapshot: {str(e)}")


@router.post("/api/options/{symbol}/iv-snapshot")
async def record_iv_snapshot(
    symbol: str,
    expiry: str | None = Query(None),
    target_dte: int = Query(IV_SNAPSHOT_TARGET_DTE, ge=1, le=365, alias="targetDte"),
):
    """Record today's ATM IV for `symbol` explicitly (for a daily cron).

    Unlike the chain endpoint — which snapshots whatever expiry the user is
    looking at — this picks the expiry nearest `targetDte` and skips the front
    week (see `pick_snapshot_expiry`), so the stored series is a term-consistent
    ~30-day vol rather than whatever happens to expire next.
    """
    return record_snapshot_now(symbol, expiry, target_dte)


@router.get("/api/options/{symbol}/sd-bands")
async def get_sd_bands(
    symbol: str,
    period: str = Query("1y", description="Price history window (yfinance period)"),
    mode: str = Query("occupancy", description="occupancy | cheapness"),
    horizon_days: int = Query(30, ge=1, le=365, alias="horizonDays"),
    rv_window: int = Query(21, ge=5, le=252, alias="rvWindow"),
    occ_window: int = Query(63, ge=5, le=500, alias="occWindow"),
):
    """Black-Scholes lognormal sd bands from stored ATM IV, one column per day.

    The bands come from `σ_mid = (IV_call + IV_put)/2` under
    `ln(S_T/S_0) ~ N((r − q − σ²/2)T, σ²T)`, projected onto the five sd buckets
    (see analytics/sd_bands.py for why the rows are buckets and not points).

    Two things worth knowing about the numbers:

    - The sigma is the nearest-expiry ATM IV, applied over `horizonDays`
      regardless of that expiry's own DTE. That is a flat term-structure
      assumption; `dteAtSnapshot` is returned per column so the stretch is
      visible rather than hidden.
    - History depth is bounded by how long `iv_snapshots` has been accumulating,
      not by `period` — the provider has no IV history to back-fill from. A
      fresh install returns `snapshotCount: 1` and an empty `series`.

    `mode=occupancy` ends `horizonDays` before today (the newest columns have no
    terminal bar yet); `current` carries the still-open projection so the live
    forecast is available regardless.
    """
    symbol = symbol.upper()
    if mode not in ("occupancy", "cheapness"):
        raise HTTPException(status_code=400, detail="mode must be 'occupancy' or 'cheapness'")

    cache_key = f"sd:{symbol}:{period}:{mode}:{horizon_days}:{rv_window}:{occ_window}"
    cached = _sd_bands_cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        with get_db() as conn:
            snap_rows = conn.execute(
                """
                -- One row per day: the expiry whose DTE sits closest to the
                -- horizon being projected — NOT the nearest expiry. The nearest
                -- is often 0DTE, whose ATM IV is pin risk rather than a view on
                -- a 30-day move, and whose call/put gap can exceed 40 vol points.
                -- The front week is excluded outright for the same reason.
                --
                -- The bare columns come from the MIN(...) row (SQLite's documented
                -- min/max-aggregate behaviour), so `expiry`/`spot`/`iv_mid` all
                -- belong to the same contract as the `dte`.
                SELECT snapshot_date, expiry, dte, spot, iv_call, iv_put, iv_mid,
                       MIN(ABS(dte - ?)) AS dte_gap
                FROM iv_snapshots
                WHERE symbol = ? AND iv_mid BETWEEN ? AND ? AND dte >= ?
                GROUP BY snapshot_date
                ORDER BY snapshot_date
                """,
                (horizon_days, symbol, IV_SANITY_MIN, IV_SANITY_MAX, IV_SNAPSHOT_MIN_DTE),
            ).fetchall()
    except HTTPException:
        # Already a deliberate response — a 429 from the source layer means the
        # vendor is throttling us, and relabelling it below would report a
        # transient upstream limit as our own failure.
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read IV snapshots: {str(e)}")

    snapshots = [dict(r) for r in snap_rows]

    r_rate = _risk_free_rate()
    levels = list(SD_LEVELS)
    ref_probs = [round(p, 6) for p in BUCKET_PROBS]
    exceed_probs = [round(p, 6) for p in LEVEL_EXCEED_PROBS]

    base: dict[str, Any] = {
        "symbol": symbol,
        "mode": mode,
        "horizonDays": horizon_days,
        "rvWindow": rv_window,
        "occWindow": occ_window,
        "r": round(r_rate, 6),
        "levels": levels,
        "refProbs": ref_probs,
        "exceedProbs": exceed_probs,
        "snapshotCount": len(snapshots),
        "series": [],
        "current": None,
    }

    if not snapshots:
        # Distinguish "nothing recorded" from "everything recorded is unusable":
        # a chain opened on an expiry Friday stores a 0DTE row, which the query
        # above excludes, and reporting that as "no snapshots" would send the user
        # to do the one thing that already failed.
        try:
            with get_db() as conn:
                raw = conn.execute(
                    "SELECT COUNT(*) FROM iv_snapshots WHERE symbol = ? AND iv_mid > 0",
                    (symbol,),  # raw count, deliberately unfiltered
                ).fetchone()[0]
        except Exception:
            raw = 0

        base["rawSnapshotCount"] = raw
        base["note"] = (
            f"{raw} IV snapshot(s) recorded but all inside the front week "
            f"(<{IV_SNAPSHOT_MIN_DTE} DTE), which is excluded — near-dated ATM IV is "
            f"pin risk, not a {horizon_days}-day view. POST "
            f"/api/options/{symbol}/iv-snapshot records a ~{horizon_days}-day expiry."
            if raw
            else "No IV snapshots yet — open the options chain for this symbol, or POST "
            f"/api/options/{symbol}/iv-snapshot, to start accumulating history "
            "(one column per day)."
        )
        _sd_bands_cache.set(cache_key, base)
        return base

    # ── Price history ──
    try:
        frame = market_data.get_history(symbol, period=period, interval="1d")
        df = frame.df
    except HTTPException:
        # Already a deliberate response — a 429 from the source layer means the
        # vendor is throttling us, and relabelling it below would report a
        # transient upstream limit as our own failure.
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch price history: {str(e)}")

    if df is None or df.empty or "Close" not in df.columns:
        raise HTTPException(status_code=404, detail=f"No price history for {symbol}")

    closes_s = pd.to_numeric(df["Close"], errors="coerce").dropna()
    dates = [d.date() for d in pd.to_datetime(closes_s.index)]
    closes = [float(v) for v in closes_s.tolist()]
    idx_by_date = {d.isoformat(): i for i, d in enumerate(dates)}

    rv = realized_vol_series(closes, rv_window)

    def _bar_at_or_before(target: date) -> Optional[int]:
        """Last bar on or before `target` — the bar a snapshot is anchored to.

        Snapshot dates and trading days do not line up: holidays, and any
        recording made outside a session, produce a date with no bar of its own.
        """
        i = bisect_right(dates, target) - 1
        return i if i >= 0 else None

    def _bar_at_or_after(target: date) -> Optional[int]:
        """First bar on or after `target` — the terminal bar of a projection.

        `dates` is ascending, so this is a bisect; a linear scan per snapshot
        would make the whole endpoint quadratic in history length.
        """
        i = bisect_left(dates, target)
        return i if i < len(dates) else None

    series: list[dict[str, Any]] = []
    # occupancy: chronological bucket hits, for the rolling frequency. Anchors are
    # spaced a day apart while the horizon is ~30, so consecutive hits share most
    # of their path and are NOT independent draws — the frequency is a
    # description of the window, not a sample with 63 degrees of freedom.
    hits: list[int] = []
    # Terminal bar index → position in `series`. Two anchors whose horizons end
    # on a weekend or holiday resolve to the SAME first trading bar, and the
    # chart's anchor series requires strictly ascending unique times, so the
    # later (fresher) projection replaces the earlier one for that column.
    col_at: dict[int, int] = {}

    for snap in snapshots:
        snap_date_str = str(snap["snapshot_date"])
        try:
            snap_date = datetime.strptime(snap_date_str, "%Y-%m-%d").date()
        except ValueError:
            continue

        sigma_iv = float(snap["iv_mid"])
        # The LAST BAR ON OR BEFORE the snapshot date, not an exact date match.
        # A snapshot can legitimately land on a day with no bar — a market
        # holiday, or a recording made before the session opened — and demanding
        # an exact match threw the whole row away: no bar meant no realized vol,
        # and cheapness mode skips any row without it. That is how a US holiday
        # emptied the pane on a symbol that had a perfectly good IV reading.
        anchor_idx = _bar_at_or_before(snap_date)
        # Snapshot spot is the price at the moment IV was read; the bar close is
        # what the realized path is measured on. Anchoring on the close keeps
        # both ends of the return on one consistent series.
        anchor_spot = closes[anchor_idx] if anchor_idx is not None else float(snap["spot"])
        if anchor_spot <= 0:
            continue

        T = horizon_days / 365.0
        band = sd_band(anchor_spot, sigma_iv, T, r_rate)
        if band is None:
            continue

        prices = [round(p, 4) for p in band.levels]
        edges = [_finite_or_none(e) for e in band.edges]
        sigma_rv = rv[anchor_idx] if anchor_idx is not None else None

        # Stamp the column on the BAR it is anchored to, not on the raw snapshot
        # date. The chart matches columns to bars by date, so a snapshot taken on
        # a day with no bar (a holiday) would be silently dropped by the renderer
        # even after the backend had computed it perfectly.
        row_time = dates[anchor_idx].isoformat() if anchor_idx is not None else snap_date_str

        row: dict[str, Any] = {
            "time": row_time,
            "snapshotDate": snap_date_str,
            "spot": round(anchor_spot, 4),
            "sigmaIv": round(sigma_iv, 6),
            "sigmaRv": round(sigma_rv, 6) if sigma_rv else None,
            "dteAtSnapshot": int(snap["dte"]),
            "T": round(T, 6),
            "prices": prices,
            "edges": edges,
            "cells": None,
            "hitRow": None,
            "hitZ": None,
        }

        if mode == "cheapness":
            # Same price edges, re-scored under realized vol. Needs no terminal
            # bar, so this mode runs right up to the newest snapshot.
            if sigma_rv is None:
                continue
            rv_probs = bucket_probs_under(anchor_spot, sigma_rv, T, band.edges, r_rate)
            if rv_probs is None:
                continue
            row["cells"] = [round(rv_probs[k] - BUCKET_PROBS[k], 6) for k in range(len(levels))]
            row["rvProbs"] = [round(p, 6) for p in rv_probs]
            # Consecutive holidays anchor several snapshots to the SAME bar, and
            # the chart's anchor series rejects duplicate times outright. The
            # later snapshot wins, as it does in occupancy mode.
            key = anchor_idx if anchor_idx is not None else -1
            existing = col_at.get(key)
            if existing is None:
                col_at[key] = len(series)
                series.append(row)
            else:
                series[existing] = row
            continue

        # occupancy — where price actually landed `horizon_days` later.
        term_idx = _bar_at_or_after(snap_date + timedelta(days=horizon_days))
        if term_idx is None or (anchor_idx is not None and term_idx <= anchor_idx):
            continue

        terminal = closes[term_idx]
        hit = bucket_of(terminal, band.edges)
        if hit is None:
            continue

        hits.append(hit)
        recent = hits[-occ_window:]
        freq = [recent.count(k) / len(recent) for k in range(len(levels))]

        row["time"] = dates[term_idx].isoformat()
        row["anchorTime"] = snap_date_str
        row["terminal"] = round(terminal, 4)
        row["hitRow"] = hit
        row["hitZ"] = round((math.log(terminal / anchor_spot) - band.m) / band.s, 4)
        row["cells"] = [round(f, 6) for f in freq]
        row["sampleSize"] = len(recent)

        existing = col_at.get(term_idx)
        if existing is None:
            col_at[term_idx] = len(series)
            series.append(row)
        else:
            series[existing] = row

    # ── The still-open projection from the newest snapshot ──
    newest = snapshots[-1]
    newest_sigma = float(newest["iv_mid"])
    newest_date_str = str(newest["snapshot_date"])
    newest_idx = idx_by_date.get(newest_date_str)
    newest_spot = closes[newest_idx] if newest_idx is not None else float(newest["spot"])
    open_band = sd_band(newest_spot, newest_sigma, horizon_days / 365.0, r_rate)
    if open_band is not None:
        try:
            target = (
                datetime.strptime(newest_date_str, "%Y-%m-%d").date()
                + timedelta(days=horizon_days)
            ).isoformat()
        except ValueError:
            target = None
        base["current"] = {
            "time": newest_date_str,
            "targetDate": target,
            "spot": round(newest_spot, 4),
            "sigmaIv": round(newest_sigma, 6),
            "sigmaRv": round(rv[newest_idx], 6) if newest_idx is not None and rv[newest_idx] else None,
            "dteAtSnapshot": int(newest["dte"]),
            "T": round(horizon_days / 365.0, 6),
            "prices": [round(p, 4) for p in open_band.levels],
            "edges": [_finite_or_none(e) for e in open_band.edges],
        }

    base["series"] = series
    if not series:
        base["note"] = (
            f"{len(snapshots)} IV snapshot(s) stored, but none has a terminal bar "
            f"{horizon_days} calendar days later yet — the heatmap fills in as the "
            "history grows."
            if mode == "occupancy"
            else f"{len(snapshots)} IV snapshot(s) stored, but none has {rv_window} "
            "bars of realized vol to compare against yet."
        )

    _sd_bands_cache.set(cache_key, base)
    return base


# ── Option Positions CRUD (normalized schema, 2026-09-10) ────────────────────
# A position is not a row any more: it is an OPEN trade that closes have not
# fully consumed. So "add a position" writes a contract + one OPEN trade, and
# "close" writes a CLOSE trade plus the FIFO matches that say which lots it ate.
# Every lifecycle event is therefore a row someone can point at, and closing
# part of a lot needs no new concept.


class OptionPositionIn(BaseModel):
    account_id: str = "dime"
    underlying: str
    expiry: str
    strike: float
    option_type: str          # "call" | "put"
    quantity: int             # signed: negative opens a short
    entry_price: float
    entry_date: str
    fees: float = 0
    multiplier: float = 100
    currency: str = "USD"
    notes: str = ""


class OptionCloseIn(BaseModel):
    """Close some or all of one lot.

    `quantity` omitted (or 0) closes whatever the lot has left. `exit_price`
    omitted records a close whose price is genuinely unknown — it contributes
    nothing to realized P&L rather than being reported as break-even.
    """
    quantity: Optional[float] = None
    exit_price: Optional[float] = None
    exit_date: Optional[str] = None
    fees: float = 0
    close_reason: Optional[str] = None
    note: str = ""


def _upsert_contract(conn, underlying: str, expiry: str, strike: float,
                     option_type: str, multiplier: float, currency: str) -> str:
    """Contract id for these terms, creating the row the first time it is seen."""
    occ = occ_symbol(underlying, expiry, strike, option_type)
    row = conn.execute(
        "SELECT contract_id FROM option_contracts WHERE occ_symbol = ?", (occ,)
    ).fetchone()
    if row:
        return row["contract_id"]
    cid = str(uuid.uuid4())
    conn.execute(
        """INSERT INTO option_contracts
           (contract_id, occ_symbol, underlying, expiry, strike, option_type,
            multiplier, currency)
           VALUES (?,?,?,?,?,?,?,?)""",
        (cid, occ, underlying.strip().upper(), str(expiry)[:10], float(strike),
         option_type, float(multiplier) or 100.0, (currency or "USD").upper()),
    )
    return cid


async def _capture_trade_greeks(conn, trade_id: str, underlying: str, expiry: str,
                                strike: float, option_type: str) -> str:
    """Record the market state at the moment of a trade.

    This is the whole reason the table exists: spot and IV at an execution are
    not recoverable later — the chain only ever reports now. A failure here must
    not lose the trade, so it degrades to source='unavailable' with NULLs, which
    reads as "never captured" rather than as zeros.
    """
    spot = iv = None
    greeks: dict = {}
    try:
        market = await _provider.get_market_data(
            OptionContract(underlying=underlying.upper(), expiry=expiry,
                           strike=strike, option_type=option_type)
        )
        spot = underlying_spot(underlying)
        iv = market.implied_volatility if market else None
        if spot and iv and iv > 0:
            moments = estimate_moments(underlying)
            computed = compute_greeks(
                spot=spot, strike=strike, expiry=expiry, option_type=option_type,
                implied_vol=iv, skew=moments["skew"], kurt=moments["kurt"],
            )
            if "error" not in computed:
                greeks = computed
    except Exception:
        pass

    source = "live" if greeks else "unavailable"
    conn.execute(
        """INSERT INTO option_trade_greeks
           (trade_id, spot, iv, delta, gamma, theta, vega, rho, source)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(trade_id) DO UPDATE SET
               spot=excluded.spot, iv=excluded.iv, delta=excluded.delta,
               gamma=excluded.gamma, theta=excluded.theta, vega=excluded.vega,
               rho=excluded.rho, source=excluded.source""",
        (trade_id, spot, iv, greeks.get("delta"), greeks.get("gamma"),
         greeks.get("theta"), greeks.get("vega"), greeks.get("rho"), source),
    )
    return source


@router.get("/api/options/positions/list")
async def list_option_positions(account_id: str | None = Query(None), status: str = "open"):
    """Open lots (status='open') or realized matches (anything else)."""
    if status == "open":
        where, params = ["1=1"], []
        if account_id:
            where.append("account_id = ?")
            params.append(account_id)
        with get_db() as conn:
            rows = conn.execute(
                f"SELECT *, lot_id AS id FROM v_option_open_lots "
                f"WHERE {' AND '.join(where)} ORDER BY expiry, underlying",
                params,
            ).fetchall()
        return [dict(r) for r in rows]

    where, params = ["1=1"], []
    if account_id:
        where.append("account_id = ?")
        params.append(account_id)
    with get_db() as conn:
        rows = conn.execute(
            f"SELECT * FROM v_option_realized WHERE {' AND '.join(where)} "
            "ORDER BY exit_date DESC",
            params,
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("/api/options/positions")
async def add_option_position(body: OptionPositionIn):
    if body.option_type not in ("call", "put"):
        raise HTTPException(400, "option_type must be 'call' or 'put'")
    if body.quantity == 0:
        raise HTTPException(400, "quantity must not be zero")

    underlying = body.underlying.strip().upper()
    # Verify the contract exists upstream before writing anything.
    market_data_result = await _provider.get_market_data(
        OptionContract(underlying=underlying, expiry=body.expiry,
                       strike=body.strike, option_type=body.option_type)
    )

    trade_id = str(uuid.uuid4())
    with get_db() as conn:
        contract_id = _upsert_contract(
            conn, underlying, body.expiry, body.strike, body.option_type,
            body.multiplier, body.currency,
        )
        conn.execute(
            """INSERT INTO option_trades
               (trade_id, contract_id, account_id, trade_date, action, side,
                quantity, price, fees, note)
               VALUES (?,?,?,?, 'OPEN', ?, ?, ?, ?, ?)""",
            (trade_id, contract_id, body.account_id, str(body.entry_date)[:10],
             "BUY" if body.quantity > 0 else "SELL", abs(body.quantity),
             body.entry_price, body.fees, body.notes),
        )
        greeks_source = await _capture_trade_greeks(
            conn, trade_id, underlying, body.expiry, body.strike, body.option_type
        )

    return {
        "id": trade_id,
        "trade_id": trade_id,
        "contract_id": contract_id,
        "greeks_source": greeks_source,
        "provider_verified": market_data_result is not None,
        "freshness": market_data_result.freshness.__dict__ if market_data_result else None,
        "current_price": market_data_result.last_price if market_data_result else None,
    }


@router.get("/api/options/positions/{position_id}/quote")
async def get_position_quote(position_id: str):
    """Live market data for one open lot."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM v_option_open_lots WHERE lot_id = ?", (position_id,)
        ).fetchone()
    if not row:
        raise HTTPException(404, "Position not found")

    result = await _provider.get_market_data(
        OptionContract(underlying=row["underlying"], expiry=row["expiry"],
                       strike=row["strike"], option_type=row["option_type"])
    )
    if not result:
        raise HTTPException(404, "Contract not found in market data provider")

    return {
        "position_id": position_id,
        "last_price": result.last_price,
        "bid": result.bid,
        "ask": result.ask,
        "implied_volatility": result.implied_volatility,
        "volume": result.volume,
        "open_interest": result.open_interest,
        "in_the_money": result.in_the_money,
        "freshness": result.freshness.__dict__,
    }


@router.patch("/api/options/positions/{position_id}/close")
async def close_option_position(position_id: str, body: OptionCloseIn | None = None):
    """Close some or all of one lot: a CLOSE trade plus its FIFO matches.

    Closing more than the lot holds is refused rather than silently opening a
    short in the opposite direction.
    """
    body = body or OptionCloseIn()
    exit_date = (body.exit_date or date.today().isoformat())[:10]

    with get_db() as conn:
        lot = conn.execute(
            "SELECT * FROM v_option_open_lots WHERE lot_id = ?", (position_id,)
        ).fetchone()
        if not lot:
            raise HTTPException(404, "Open lot not found")
        lot = dict(lot)

        remaining = abs(float(lot["quantity"]))
        qty = abs(float(body.quantity)) if body.quantity else remaining
        if qty > remaining + 1e-9:
            raise HTTPException(
                400,
                f"Cannot close {qty:g} contracts — the lot has {remaining:g} left",
            )

        direction = int(lot["direction"])          # +1 long, -1 short
        mult = float(lot["multiplier"]) or 100.0
        entry_price = float(lot["entry_price"] or 0)

        reason = body.close_reason or ("TRADE" if body.exit_price is not None else "UNKNOWN")
        close_id = str(uuid.uuid4())
        conn.execute(
            """INSERT INTO option_trades
               (trade_id, contract_id, account_id, trade_date, action, side,
                quantity, price, fees, close_reason, note)
               VALUES (?,?,?,?, 'CLOSE', ?, ?, ?, ?, ?, ?)""",
            (close_id, lot["contract_id"], lot["account_id"], exit_date,
             "SELL" if direction > 0 else "BUY", qty, body.exit_price,
             body.fees, reason, body.note),
        )

        # Long: (exit - entry). Short: (entry - exit). `direction` carries both.
        realized = (
            direction * (float(body.exit_price) - entry_price) * qty * mult - float(body.fees or 0)
            if body.exit_price is not None else None
        )
        conn.execute(
            """INSERT INTO option_trade_matches
               (close_trade_id, open_trade_id, quantity, fees_alloc, realized_pnl)
               VALUES (?,?,?,?,?)""",
            (close_id, position_id, qty, float(body.fees or 0), realized),
        )
        await _capture_trade_greeks(
            conn, close_id, lot["underlying"], lot["expiry"],
            float(lot["strike"]), lot["option_type"],
        )

    return {
        "ok": True,
        "close_trade_id": close_id,
        "quantity_closed": qty,
        "quantity_remaining": remaining - qty,
        "exit_price": body.exit_price,
        "exit_date": exit_date,
        "realized_pnl": realized,
        "close_reason": reason,
    }


class OptionCloseFifoIn(OptionCloseIn):
    """Close across every open lot of one contract, oldest first."""
    account_id: str = "dime"
    underlying: str
    expiry: str
    strike: float
    option_type: str


@router.post("/api/options/close-fifo")
async def close_option_fifo(body: OptionCloseFifoIn):
    """Close N contracts of one option, consuming open lots oldest-first.

    Ordered by trade_date then created_at — two lots opened the same day must
    follow the order they were actually recorded in, not whatever order SQLite
    happens to return.
    """
    exit_date = (body.exit_date or date.today().isoformat())[:10]
    occ = occ_symbol(body.underlying, body.expiry, body.strike, body.option_type)

    with get_db() as conn:
        lots = [dict(r) for r in conn.execute(
            "SELECT v.* FROM v_option_open_lots v "
            "WHERE v.occ_symbol = ? AND v.account_id = ? "
            "ORDER BY v.entry_date, (SELECT created_at FROM option_trades t "
            "                        WHERE t.trade_id = v.lot_id)",
            (occ, body.account_id),
        ).fetchall()]
        if not lots:
            raise HTTPException(404, "No open lots for that contract")

        available = sum(abs(float(l["quantity"])) for l in lots)
        want = abs(float(body.quantity)) if body.quantity else available
        if want > available + 1e-9:
            raise HTTPException(
                400, f"Cannot close {want:g} contracts — only {available:g} are open"
            )

        direction = int(lots[0]["direction"])
        mult = float(lots[0]["multiplier"]) or 100.0
        close_id = str(uuid.uuid4())
        reason = body.close_reason or ("TRADE" if body.exit_price is not None else "UNKNOWN")
        conn.execute(
            """INSERT INTO option_trades
               (trade_id, contract_id, account_id, trade_date, action, side,
                quantity, price, fees, close_reason, note)
               VALUES (?,?,?,?, 'CLOSE', ?, ?, ?, ?, ?, ?)""",
            (close_id, lots[0]["contract_id"], body.account_id, exit_date,
             "SELL" if direction > 0 else "BUY", want, body.exit_price,
             body.fees, reason, body.note),
        )

        matches = []
        left = want
        total_fees = float(body.fees or 0)
        for lot in lots:
            if left <= 1e-9:
                break
            take = min(left, abs(float(lot["quantity"])))
            # Fees follow the quantity they belong to; charging the whole
            # commission to the first lot would distort its realized P&L.
            fee_alloc = total_fees * (take / want) if want else 0.0
            realized = (
                direction * (float(body.exit_price) - float(lot["entry_price"] or 0))
                * take * mult - fee_alloc
                if body.exit_price is not None else None
            )
            conn.execute(
                """INSERT INTO option_trade_matches
                   (close_trade_id, open_trade_id, quantity, fees_alloc, realized_pnl)
                   VALUES (?,?,?,?,?)""",
                (close_id, lot["lot_id"], take, round(fee_alloc, 6), realized),
            )
            matches.append({
                "open_trade_id": lot["lot_id"],
                "entry_date": lot["entry_date"],
                "entry_price": lot["entry_price"],
                "quantity": take,
                "realized_pnl": None if realized is None else round(realized, 2),
            })
            left -= take

        await _capture_trade_greeks(
            conn, close_id, body.underlying, body.expiry, body.strike, body.option_type
        )

    return {
        "ok": True,
        "close_trade_id": close_id,
        "quantity_closed": want,
        "matches": matches,
        "realized_pnl": (
            None if body.exit_price is None
            else round(sum(m["realized_pnl"] or 0 for m in matches), 2)
        ),
    }


@router.delete("/api/options/positions/{position_id}")
async def delete_option_position(position_id: str):
    """Delete an OPEN trade. Refused once closes have consumed part of it —
    deleting it would leave matches pointing at a lot that no longer exists."""
    with get_db() as conn:
        matched = conn.execute(
            "SELECT COUNT(*) c FROM option_trade_matches WHERE open_trade_id = ?",
            (position_id,),
        ).fetchone()["c"]
        if matched:
            raise HTTPException(
                409,
                "This lot has closes matched against it. Delete those close "
                "trades first, or the realized P&L they produced would lose its "
                "other half.",
            )
        conn.execute("DELETE FROM option_trades WHERE trade_id = ?", (position_id,))
    return {"ok": True}


class OptionTradeEditIn(BaseModel):
    """Correct a mis-entered trade.

    Trades are otherwise immutable — this is for fixing a typo, not for
    recording that something changed in the market. Every edit is written to
    `trade_audit_log`, and any match touching the trade is recomputed, because
    `realized_pnl` is materialized and would otherwise keep reporting a number
    derived from the wrong price.
    """
    trade_date: Optional[str] = None
    price: Optional[float] = None
    quantity: Optional[float] = None
    fees: Optional[float] = None
    note: Optional[str] = None
    close_reason: Optional[str] = None
    # Contract terms. Changing these moves the trade to a different instrument.
    underlying: Optional[str] = None
    expiry: Optional[str] = None
    strike: Optional[float] = None
    option_type: Optional[str] = None
    multiplier: Optional[float] = None
    currency: Optional[str] = None
    reason: str = ""
    clear_price: bool = False        # explicitly set price back to unknown


def _rematch_trade(conn, trade_id: str) -> int:
    """Recompute realized P&L for every match touching this trade.

    Fees are re-apportioned by matched quantity at the same time: a changed
    quantity moves the split, not just the price.
    """
    rows = [dict(r) for r in conn.execute(
        """SELECT mt.close_trade_id, mt.open_trade_id, mt.quantity,
                  ot.price AS open_price, ot.side AS open_side,
                  ct.price AS close_price, ct.fees AS close_fees,
                  ct.quantity AS close_quantity,
                  c.multiplier
           FROM option_trade_matches mt
           JOIN option_trades ot ON ot.trade_id = mt.open_trade_id
           JOIN option_trades ct ON ct.trade_id = mt.close_trade_id
           JOIN option_contracts c ON c.contract_id = ot.contract_id
           WHERE mt.open_trade_id = ? OR mt.close_trade_id = ?""",
        (trade_id, trade_id),
    ).fetchall()]

    for m in rows:
        mult = float(m["multiplier"] or 100)
        qty = float(m["quantity"] or 0)
        close_qty = float(m["close_quantity"] or 0)
        fee_alloc = (
            float(m["close_fees"] or 0) * (qty / close_qty) if close_qty else 0.0
        )
        direction = 1 if m["open_side"] == "BUY" else -1
        realized = (
            direction * (float(m["close_price"]) - float(m["open_price"] or 0)) * qty * mult
            - fee_alloc
            if m["close_price"] is not None else None
        )
        conn.execute(
            """UPDATE option_trade_matches
               SET realized_pnl = ?, fees_alloc = ?
               WHERE close_trade_id = ? AND open_trade_id = ?""",
            (realized, round(fee_alloc, 6), m["close_trade_id"], m["open_trade_id"]),
        )
    return len(rows)


def _audit_option_trade(conn, trade_id: str, action: str, old_row: dict,
                        new_values: dict, reason: str) -> None:
    """Reuse trade_audit_log — its `trade_id` is plain TEXT with no FK, so
    option and equity trades share the same immutable event stream."""
    changed = {
        k: {"old": old_row.get(k), "new": v}
        for k, v in new_values.items()
        if old_row.get(k) != v
    }
    conn.execute(
        """INSERT INTO trade_audit_log
               (event_id, trade_id, action, fields_changed, reason, snapshot)
           VALUES (?,?,?,?,?,?)""",
        (
            str(uuid.uuid4()),
            trade_id, action, json.dumps(changed, default=str), reason or "",
            json.dumps({k: old_row.get(k) for k in (
                "trade_date", "action", "side", "quantity", "price", "fees",
                "close_reason", "note", "underlying", "expiry", "strike",
                "option_type", "multiplier", "currency",
            )}, default=str),
        ),
    )


@router.patch("/api/options/trades/{trade_id}")
async def edit_option_trade(trade_id: str, body: OptionTradeEditIn):
    """Correct a mis-entered option trade, then re-match what it affects."""
    with get_db() as conn:
        row = conn.execute(
            """SELECT t.*, c.underlying, c.expiry, c.strike, c.option_type,
                      c.multiplier, c.currency, c.occ_symbol
               FROM option_trades t
               JOIN option_contracts c ON c.contract_id = t.contract_id
               WHERE t.trade_id = ?""",
            (trade_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "Trade not found")
        old = dict(row)

        matched = conn.execute(
            """SELECT COALESCE(SUM(quantity), 0) q FROM option_trade_matches
               WHERE open_trade_id = ? OR close_trade_id = ?""",
            (trade_id, trade_id),
        ).fetchone()["q"]

        # ── quantity ────────────────────────────────────────────────────────
        new_qty = float(body.quantity) if body.quantity is not None else float(old["quantity"])
        if new_qty <= 0:
            raise HTTPException(400, "quantity must be greater than zero")
        if new_qty + 1e-9 < float(matched):
            raise HTTPException(
                400,
                f"Cannot reduce this trade to {new_qty:g} — {float(matched):g} contracts are "
                "already matched against it. Delete or edit those matches first, or the "
                "realized P&L they produced would refer to size that no longer exists.",
            )

        # ── contract terms ──────────────────────────────────────────────────
        term_fields = ("underlying", "expiry", "strike", "option_type", "multiplier", "currency")
        wants_terms = {
            f: getattr(body, f) for f in term_fields if getattr(body, f) is not None
        }
        contract_id = old["contract_id"]
        contract_changed = False
        contract_siblings = 0

        if wants_terms:
            merged = {f: wants_terms.get(f, old[f]) for f in term_fields}
            identity_changed = any(
                str(merged[f]).upper() != str(old[f]).upper()
                for f in ("underlying", "expiry", "option_type")
            ) or float(merged["strike"]) != float(old["strike"])

            if identity_changed:
                if matched:
                    raise HTTPException(
                        409,
                        "This trade is matched to another. Moving it to a different contract "
                        "would pair a close on one instrument with an open on another — "
                        "delete the matching close first.",
                    )
                contract_id = _upsert_contract(
                    conn, str(merged["underlying"]), str(merged["expiry"]),
                    float(merged["strike"]), str(merged["option_type"]),
                    float(merged["multiplier"]), str(merged["currency"]),
                )
                contract_changed = True
            elif (
                float(merged["multiplier"]) != float(old["multiplier"])
                or str(merged["currency"]).upper() != str(old["currency"]).upper()
            ):
                # Contract size and currency belong to the INSTRUMENT, so this
                # edit reaches every trade on it — not just this one.
                contract_siblings = conn.execute(
                    "SELECT COUNT(*) c FROM option_trades WHERE contract_id = ? AND trade_id != ?",
                    (contract_id, trade_id),
                ).fetchone()["c"]
                conn.execute(
                    "UPDATE option_contracts SET multiplier = ?, currency = ? WHERE contract_id = ?",
                    (float(merged["multiplier"]), str(merged["currency"]).upper(), contract_id),
                )

        # ── the trade row itself ────────────────────────────────────────────
        new_price = (
            None if body.clear_price
            else (body.price if body.price is not None else old["price"])
        )
        new_reason = body.close_reason if body.close_reason is not None else old["close_reason"]
        if old["action"] == "CLOSE":
            # The DB CHECK enforces this too; failing here gives a usable message
            # instead of an IntegrityError.
            new_reason = new_reason or ("TRADE" if new_price is not None else "UNKNOWN")
            if new_price is None and new_reason != "UNKNOWN":
                raise HTTPException(
                    400,
                    "A close with no price must use close_reason='UNKNOWN' — an unknown price "
                    "is not the same as a zero one.",
                )
        elif new_price is None:
            raise HTTPException(400, "An OPEN trade must have a price")

        new_values = {
            "trade_date": (str(body.trade_date)[:10] if body.trade_date else old["trade_date"]),
            "price": new_price,
            "quantity": new_qty,
            "fees": float(body.fees) if body.fees is not None else float(old["fees"] or 0),
            "close_reason": new_reason,
            "note": body.note if body.note is not None else old["note"],
        }
        conn.execute(
            """UPDATE option_trades
               SET trade_date = ?, price = ?, quantity = ?, fees = ?,
                   close_reason = ?, note = ?, contract_id = ?
               WHERE trade_id = ?""",
            (*new_values.values(), contract_id, trade_id),
        )

        rematched = _rematch_trade(conn, trade_id)
        if contract_siblings:
            # Every sibling's realized P&L was computed with the old multiplier.
            for sib in conn.execute(
                "SELECT trade_id FROM option_trades WHERE contract_id = ?", (contract_id,)
            ).fetchall():
                rematched += _rematch_trade(conn, sib["trade_id"])

        audit_values = dict(new_values)
        audit_values.update(wants_terms)
        _audit_option_trade(conn, trade_id, "OPTION_EDIT", old, audit_values, body.reason)

    return {
        "ok": True,
        "trade_id": trade_id,
        "contract_changed": contract_changed,
        "matches_recomputed": rematched,
        "contract_siblings_affected": contract_siblings,
        "warning": (
            f"multiplier/currency belong to the contract — {contract_siblings} other trade(s) "
            "on it were revalued too"
        ) if contract_siblings else None,
    }


@router.get("/api/options/trades/{trade_id}/audit-log")
async def get_option_trade_audit_log(trade_id: str, limit: int = Query(50)):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM trade_audit_log WHERE trade_id = ? "
            "ORDER BY created_at DESC LIMIT ?",
            (trade_id, max(1, limit)),
        ).fetchall()
    return [dict(r) for r in rows]


@router.delete("/api/options/trades/{trade_id}")
async def delete_option_trade(trade_id: str):
    """Delete any trade. A CLOSE takes its matches with it (ON DELETE CASCADE),
    which reopens the quantity it had consumed."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT action FROM option_trades WHERE trade_id = ?", (trade_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "Trade not found")
        if row["action"] == "OPEN":
            matched = conn.execute(
                "SELECT COUNT(*) c FROM option_trade_matches WHERE open_trade_id = ?",
                (trade_id,),
            ).fetchone()["c"]
            if matched:
                raise HTTPException(409, "Delete the closes matched against this lot first")
        conn.execute("DELETE FROM option_trades WHERE trade_id = ?", (trade_id,))
    return {"ok": True, "action": row["action"]}


@router.post("/api/options/positions/seed-demo")
async def seed_demo_positions():
    """Insert demo lots for UI testing: long call, long put, near-expiry, short put."""
    from datetime import timedelta
    today = date.today()

    demo = [
        {"underlying": "AAPL", "expiry": str(today + timedelta(days=45)), "strike": 200.0,
         "option_type": "call", "quantity": 2, "entry_price": 5.80,
         "entry_date": str(today - timedelta(days=10)), "notes": "demo — earnings play"},
        {"underlying": "SPY", "expiry": str(today + timedelta(days=79)), "strike": 530.0,
         "option_type": "put", "quantity": 3, "entry_price": 4.20,
         "entry_date": str(today - timedelta(days=5)), "notes": "demo — portfolio hedge"},
        {"underlying": "NVDA", "expiry": str(today + timedelta(days=107)), "strike": 130.0,
         "option_type": "call", "quantity": 1, "entry_price": 9.50,
         "entry_date": str(today - timedelta(days=3)), "notes": "demo — AI momentum"},
        {"underlying": "TSLA", "expiry": str(today + timedelta(days=14)), "strike": 250.0,
         "option_type": "put", "quantity": 2, "entry_price": 3.10,
         "entry_date": str(today - timedelta(days=20)), "notes": "demo — near expiry warn"},
        {"underlying": "QQQ", "expiry": str(today + timedelta(days=4)), "strike": 480.0,
         "option_type": "call", "quantity": 1, "entry_price": 2.40,
         "entry_date": str(today - timedelta(days=30)), "notes": "demo — critical expiry"},
        {"underlying": "AAPL", "expiry": str(today + timedelta(days=45)), "strike": 185.0,
         "option_type": "put", "quantity": -2, "entry_price": 3.50,
         "entry_date": str(today - timedelta(days=7)), "notes": "demo — short put (cash-secured)"},
    ]

    inserted = []
    with get_db() as conn:
        for pos in demo:
            contract_id = _upsert_contract(
                conn, pos["underlying"], pos["expiry"], pos["strike"],
                pos["option_type"], 100, "USD",
            )
            tid = str(uuid.uuid4())
            conn.execute(
                """INSERT INTO option_trades
                   (trade_id, contract_id, account_id, trade_date, action, side,
                    quantity, price, note)
                   VALUES (?,?,?,?, 'OPEN', ?, ?, ?, ?)""",
                (tid, contract_id, "dime", pos["entry_date"],
                 "BUY" if pos["quantity"] > 0 else "SELL", abs(pos["quantity"]),
                 pos["entry_price"], pos["notes"]),
            )
            conn.execute(
                "INSERT INTO option_trade_greeks (trade_id, source) VALUES (?, 'unavailable')",
                (tid,),
            )
            inserted.append(tid)

    return {"inserted": len(inserted), "ids": inserted}


@router.delete("/api/options/positions/demo/clear")
async def clear_demo_positions():
    """Remove demo trades (note starts with 'demo') and any matches on them."""
    with get_db() as conn:
        conn.execute(
            "DELETE FROM option_trades WHERE trade_id IN "
            "(SELECT trade_id FROM option_trades WHERE note LIKE 'demo%')"
        )
        # Contracts left with no trades are dead weight in the instrument table.
        conn.execute(
            "DELETE FROM option_contracts WHERE contract_id NOT IN "
            "(SELECT DISTINCT contract_id FROM option_trades)"
        )
    return {"ok": True}


# ── Greeks ────────────────────────────────────────────────────────────────────

_greeks_cache = TTLCache(ttl=300, maxsize=200)


@router.get("/api/options/positions/{position_id}/greeks")
async def get_position_greeks(position_id: str):
    """Compute BS + GC-adjusted Greeks for one position."""
    cache_key = f"greeks2:{position_id}"
    cached = _greeks_cache.get(cache_key)
    if cached is not None:
        return cached

    with get_db() as conn:
        row = conn.execute(
            "SELECT *, lot_id AS id FROM v_option_open_lots WHERE lot_id = ?",
            (position_id,),
        ).fetchone()
    if not row:
        raise HTTPException(404, "Position not found")

    pos = dict(row)

    # Fetch spot + IV from provider
    contract = OptionContract(
        underlying=pos["underlying"],
        expiry=pos["expiry"],
        strike=pos["strike"],
        option_type=pos["option_type"],
    )
    market = await _provider.get_market_data(contract)
    if not market:
        raise HTTPException(404, "Market data not available for this contract")

    spot = underlying_spot(pos["underlying"])
    iv   = market.implied_volatility
    if not spot or not iv:
        raise HTTPException(422, "Insufficient market data (missing spot or IV)")

    # Historical moments for GC adjustment
    moments = estimate_moments(pos["underlying"])

    result = compute_greeks(
        spot=spot,
        strike=pos["strike"],
        expiry=pos["expiry"],
        option_type=pos["option_type"],
        implied_vol=iv,
        skew=moments["skew"],
        kurt=moments["kurt"],
    )

    result["position_id"]  = position_id
    result["underlying"]   = pos["underlying"]
    result["quantity"]     = pos["quantity"]
    result["entry_price"]  = pos["entry_price"]
    result["option_type"]  = pos["option_type"]
    result["freshness"]    = market.freshness.__dict__

    _greeks_cache.set(cache_key, result)
    return result


@router.get("/api/options/greeks/portfolio")
async def get_portfolio_greeks(
    account_id: str | None = Query(None),
    status: str = Query("open"),
):
    """
    Greeks for all open positions + portfolio-level aggregates:
    - per-position BS + Adj Greeks
    - net delta by underlying (equity-equivalent shares)
    - total daily theta bleed
    - max loss per position
    - expiry timeline
    """
    with get_db() as conn:
        if account_id:
            rows = conn.execute(
                "SELECT *, lot_id AS id FROM v_option_open_lots WHERE account_id = ?",
                (account_id,),
            ).fetchall()
        else:
            rows = conn.execute("SELECT *, lot_id AS id FROM v_option_open_lots").fetchall()

    positions = [dict(r) for r in rows]
    if not positions:
        return {
            "positions": [],
            "portfolio": {
                "net_delta_by_underlying": {},
                "total_theta_day": 0.0,
                "total_theta_adj_day": 0.0,
                "total_premium_at_risk": 0.0,
                "has_short_positions": False,
                "expiry_alerts": [],
            },
            "freshness": _provider.make_freshness().__dict__,
        }

    enriched = []
    net_delta: dict[str, float] = {}
    net_delta_adj: dict[str, float] = {}
    total_theta = 0.0
    total_theta_adj = 0.0
    total_premium_at_risk = 0.0
    has_short = False
    expiry_alerts = []

    for pos in positions:
        contract = OptionContract(
            underlying=pos["underlying"],
            expiry=pos["expiry"],
            strike=pos["strike"],
            option_type=pos["option_type"],
        )

        greeks_data: dict = {}
        try:
            cache_key = f"greeks2:{pos['id']}"
            cached = _greeks_cache.get(cache_key)
            if cached:
                greeks_data = cached
            else:
                market = await _provider.get_market_data(contract)
                spot = underlying_spot(pos["underlying"])
                if market and spot and market.implied_volatility:
                    moments = estimate_moments(pos["underlying"])
                    greeks_data = compute_greeks(
                        spot=spot,
                        strike=pos["strike"],
                        expiry=pos["expiry"],
                        option_type=pos["option_type"],
                        implied_vol=market.implied_volatility,
                        skew=moments["skew"],
                        kurt=moments["kurt"],
                    )
                    _greeks_cache.set(cache_key, greeks_data)
        except Exception:
            pass

        qty = pos["quantity"]
        sign = 1 if qty > 0 else -1
        contracts_abs = abs(qty)

        # Max loss
        if qty > 0:
            max_loss = pos["entry_price"] * contracts_abs * 100
        else:
            has_short = True
            if pos["option_type"] == "put":
                max_loss = pos["strike"] * contracts_abs * 100
            else:
                max_loss = float("inf")

        # Accumulate portfolio Greeks (scale to position size)
        if greeks_data and "error" not in greeks_data:
            delta_contribution     = greeks_data["delta"]     * qty * 100
            delta_adj_contribution = greeks_data["delta_adj"] * qty * 100
            theta_day              = greeks_data["theta"]      * qty * 100
            theta_adj_day          = greeks_data["theta_adj"]  * qty * 100

            underlying = pos["underlying"]
            net_delta[underlying]     = net_delta.get(underlying, 0.0) + delta_contribution
            net_delta_adj[underlying] = net_delta_adj.get(underlying, 0.0) + delta_adj_contribution
            total_theta     += theta_day
            total_theta_adj += theta_adj_day

        if qty > 0:
            total_premium_at_risk += pos["entry_price"] * contracts_abs * 100

        # Expiry alert
        days = greeks_data.get("days_to_exp", 0) if greeks_data else 0
        if days == 0:
            from greeks import _days_to_expiry
            days = round(_days_to_expiry(pos["expiry"]) * 365)

        alert_level = "critical" if days <= 7 else "warn" if days <= 21 else None
        if alert_level:
            expiry_alerts.append({
                "id":          pos["id"],
                "underlying":  pos["underlying"],
                "strike":      pos["strike"],
                "option_type": pos["option_type"],
                "expiry":      pos["expiry"],
                "days_to_exp": days,
                "level":       alert_level,
            })

        enriched.append({
            **pos,
            "max_loss": None if max_loss == float("inf") else max_loss,
            "unlimited_loss": max_loss == float("inf"),
            "greeks": greeks_data,
        })

    # Sort expiry alerts by days ascending
    expiry_alerts.sort(key=lambda x: x["days_to_exp"])

    return {
        "positions": enriched,
        "portfolio": {
            "net_delta_by_underlying": {
                k: {
                    "bs":  round(net_delta.get(k, 0), 2),
                    "adj": round(net_delta_adj.get(k, 0), 2),
                }
                for k in set(list(net_delta.keys()) + list(net_delta_adj.keys()))
            },
            "total_theta_day":     round(total_theta, 2),
            "total_theta_adj_day": round(total_theta_adj, 2),
            "total_premium_at_risk": round(total_premium_at_risk, 2),
            "has_short_positions": has_short,
            "expiry_alerts": expiry_alerts,
        },
        "freshness": _provider.make_freshness().__dict__,
    }
