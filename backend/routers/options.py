import uuid
from typing import Any

import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from cache import TTLCache
from db import get_db
from greeks import compute_greeks, estimate_moments
from providers.base_options import OptionContract
from providers.yahoo_options import YahooOptionsProvider
from sources import market_data

router = APIRouter()

_options_chain_cache = TTLCache(ttl=300, maxsize=100)
_options_surface_cache = TTLCache(ttl=600, maxsize=100)

# Swap provider here — nothing else changes
_provider = YahooOptionsProvider()


def clean_df(df: pd.DataFrame) -> list[dict]:
    """Process options DataFrame columns, fill NaN, round floats."""
    columns = [
        "contractSymbol", "strike", "lastPrice", "bid", "ask",
        "volume", "openInterest", "impliedVolatility", "inTheMoney",
        "change", "percentChange",
    ]
    df = df[[c for c in columns if c in df.columns]].copy()

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


@router.get("/api/options/{symbol}")
async def get_options_chain(symbol: str, expiry: str | None = Query(None)):
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

        if spot > 0:
            atm_calls = [
                c["impliedVolatility"] for c in calls
                if abs(c.get("strike", 0) - spot) / spot <= 0.03
                and c.get("impliedVolatility", 0) > 0
            ]
            iv_current = round(float(pd.Series(atm_calls).median()), 4) if atm_calls else 0.0
        else:
            iv_current = 0.0

        freshness = _provider.make_freshness().__dict__

        data = {
            "symbol": symbol,
            "spot": spot,
            "expiry": target_expiry,
            "expirations": list(expirations),
            "calls": calls,
            "puts": puts,
            "ivCurrent": iv_current,
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


# ── Option Positions CRUD ─────────────────────────────────────────────────────

class OptionPositionIn(BaseModel):
    account_id: str = "dime"
    underlying: str
    expiry: str
    strike: float
    option_type: str   # "call" | "put"
    quantity: int
    entry_price: float
    entry_date: str
    notes: str = ""


@router.get("/api/options/positions/list")
async def list_option_positions(account_id: str | None = Query(None), status: str = "open"):
    with get_db() as conn:
        if account_id:
            rows = conn.execute(
                "SELECT * FROM option_positions WHERE account_id=? AND status=? ORDER BY expiry, underlying",
                (account_id, status),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM option_positions WHERE status=? ORDER BY expiry, underlying",
                (status,),
            ).fetchall()
    return [dict(r) for r in rows]


@router.post("/api/options/positions")
async def add_option_position(body: OptionPositionIn):
    if body.option_type not in ("call", "put"):
        raise HTTPException(400, "option_type must be 'call' or 'put'")

    # Verify contract exists in provider before saving
    contract = OptionContract(
        underlying=body.underlying.upper(),
        expiry=body.expiry,
        strike=body.strike,
        option_type=body.option_type,
    )
    market_data_result = await _provider.get_market_data(contract)

    pos_id = str(uuid.uuid4())
    with get_db() as conn:
        conn.execute(
            """INSERT INTO option_positions
               (id, account_id, underlying, expiry, strike, option_type,
                quantity, entry_price, entry_date, notes)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (pos_id, body.account_id, body.underlying.upper(), body.expiry,
             body.strike, body.option_type, body.quantity,
             body.entry_price, body.entry_date, body.notes),
        )

    return {
        "id": pos_id,
        "provider_verified": market_data_result is not None,
        "freshness": market_data_result.freshness.__dict__ if market_data_result else None,
        "current_price": market_data_result.last_price if market_data_result else None,
    }


@router.get("/api/options/positions/{position_id}/quote")
async def get_position_quote(position_id: str):
    """Fetch live market data for a saved position."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM option_positions WHERE id=?", (position_id,)
        ).fetchone()
    if not row:
        raise HTTPException(404, "Position not found")

    contract = OptionContract(
        underlying=row["underlying"],
        expiry=row["expiry"],
        strike=row["strike"],
        option_type=row["option_type"],
    )
    result = await _provider.get_market_data(contract)
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
async def close_option_position(position_id: str):
    with get_db() as conn:
        conn.execute(
            "UPDATE option_positions SET status='closed' WHERE id=?", (position_id,)
        )
    return {"ok": True}


@router.delete("/api/options/positions/{position_id}")
async def delete_option_position(position_id: str):
    with get_db() as conn:
        conn.execute("DELETE FROM option_positions WHERE id=?", (position_id,))
    return {"ok": True}


@router.post("/api/options/positions/seed-demo")
async def seed_demo_positions():
    """
    Insert realistic demo option positions for UI testing.
    Mix: long call, long put, near-expiry (alert), short put.
    Clears existing demo positions first (account_id='dime', status='open').
    """
    from datetime import date, timedelta
    today = date.today()

    demo = [
        # Long call — moderately ITM
        {
            "underlying": "AAPL", "expiry": str(today + timedelta(days=45)),
            "strike": 200.0, "option_type": "call",
            "quantity": 2, "entry_price": 5.80,
            "entry_date": str(today - timedelta(days=10)),
            "notes": "demo — earnings play",
        },
        # Long put — SPY hedge
        {
            "underlying": "SPY", "expiry": str(today + timedelta(days=79)),
            "strike": 530.0, "option_type": "put",
            "quantity": 3, "entry_price": 4.20,
            "entry_date": str(today - timedelta(days=5)),
            "notes": "demo — portfolio hedge",
        },
        # Long call NVDA — momentum
        {
            "underlying": "NVDA", "expiry": str(today + timedelta(days=107)),
            "strike": 130.0, "option_type": "call",
            "quantity": 1, "entry_price": 9.50,
            "entry_date": str(today - timedelta(days=3)),
            "notes": "demo — AI momentum",
        },
        # Near-expiry warn (≤21d) — triggers alert
        {
            "underlying": "TSLA", "expiry": str(today + timedelta(days=14)),
            "strike": 250.0, "option_type": "put",
            "quantity": 2, "entry_price": 3.10,
            "entry_date": str(today - timedelta(days=20)),
            "notes": "demo — near expiry warn",
        },
        # Critical expiry (≤7d) — triggers red alert
        {
            "underlying": "QQQ", "expiry": str(today + timedelta(days=4)),
            "strike": 480.0, "option_type": "call",
            "quantity": 1, "entry_price": 2.40,
            "entry_date": str(today - timedelta(days=30)),
            "notes": "demo — critical expiry",
        },
        # Short put — limited but large loss, triggers short warning
        {
            "underlying": "AAPL", "expiry": str(today + timedelta(days=45)),
            "strike": 185.0, "option_type": "put",
            "quantity": -2, "entry_price": 3.50,
            "entry_date": str(today - timedelta(days=7)),
            "notes": "demo — short put (cash-secured)",
        },
    ]

    inserted = []
    with get_db() as conn:
        for pos in demo:
            pid = str(uuid.uuid4())
            conn.execute(
                """INSERT INTO option_positions
                   (id, account_id, underlying, expiry, strike, option_type,
                    quantity, entry_price, entry_date, notes)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (pid, "dime", pos["underlying"], pos["expiry"], pos["strike"],
                 pos["option_type"], pos["quantity"], pos["entry_price"],
                 pos["entry_date"], pos["notes"]),
            )
            inserted.append(pid)

    return {"inserted": len(inserted), "ids": inserted}


@router.delete("/api/options/positions/demo/clear")
async def clear_demo_positions():
    """Remove all demo positions (notes contain 'demo')."""
    with get_db() as conn:
        conn.execute("DELETE FROM option_positions WHERE notes LIKE 'demo%'")
    return {"ok": True}


# ── Greeks ────────────────────────────────────────────────────────────────────

_greeks_cache = TTLCache(ttl=300, maxsize=200)


@router.get("/api/options/positions/{position_id}/greeks")
async def get_position_greeks(position_id: str):
    """Compute BS + GC-adjusted Greeks for one position."""
    cache_key = f"greeks:{position_id}"
    cached = _greeks_cache.get(cache_key)
    if cached is not None:
        return cached

    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM option_positions WHERE id=?", (position_id,)
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

    spot = market.last_price or market.ask or market.bid
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
                "SELECT * FROM option_positions WHERE account_id=? AND status=?",
                (account_id, status),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM option_positions WHERE status=?", (status,)
            ).fetchall()

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
            cache_key = f"greeks:{pos['id']}"
            cached = _greeks_cache.get(cache_key)
            if cached:
                greeks_data = cached
            else:
                market = await _provider.get_market_data(contract)
                if market and market.last_price and market.implied_volatility:
                    moments = estimate_moments(pos["underlying"])
                    greeks_data = compute_greeks(
                        spot=market.last_price,
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
