"""Canonical valuation for option lots inside PORT.

`option_positions` used to be a silo: no portfolio endpoint joined it, so NAV,
allocation, returns and analytics all answered as if the options did not exist,
and the only P&L anywhere was computed in the browser at a hardcoded ×100 in
USD. This module is the single place that turns an option row into money, so
`/summary`, `/open-positions`, `/allocation-detail`, `/returns` and `/analytics`
all agree on the same basis.

Two numbers come out of every open lot, and they are not interchangeable:

* **market value** — `mark × quantity × multiplier`. This is what the position
  is worth and what belongs in NAV and unrealized P&L.
* **delta notional** — `delta × quantity × multiplier × spot`. This is what the
  position is *exposed to* and what belongs in allocation and sector weights.
  Three SPY calls costing $1,200 of premium can carry $150k of exposure;
  weighting a book by premium hides that entirely.

Sign convention throughout: `quantity` is signed, shorts are negative, and
nothing is `abs()`-ed. A short lot therefore has a negative cost (the credit
received) and a negative market value (the liability) — which is what makes
`market_value - cost` come out as the correct unrealized P&L on both sides.

**Dollar greeks.** `greeks.py` guarantees theta is per calendar day, vega is per
1pp of IV, and gamma is per $1 of spot, so scaling to position size is the only
step needed:

    delta_exp = Δ × qty × mult × S            USD moved per 100% move in spot
    gamma_exp = Γ × qty × mult × S² × 0.01    dollar delta gained per 1% move
    theta_exp = Θ × qty × mult                USD bled per calendar day
    vega_exp  = ν × qty × mult                USD per 1pp of IV

`gamma_exp` is the desk convention, not a derivative: the true d(dollar delta)/dS
also carries a `Δ × qty × mult` term. Label it as "dollar delta per 1% move",
never as "gamma".

A lot with no IV gets `None` for every greek — NOT zero. Portfolio aggregates
must skip those and report how many were skipped, or the exposure silently reads
lower than it is.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Iterable, Mapping, Optional

from cache import TTLCache
from db import get_db
from greeks import compute_greeks
from portfolio_currency import convert_amount, normalize_currency, report_currency
from sources import market_data

logger = logging.getLogger(__name__)

DEFAULT_MULTIPLIER = 100.0
DEFAULT_CURRENCY = "USD"

# One entry per (underlying, expiry) — the previous per-position provider call
# meant one full `option_chain()` download per lot, which is the same request
# repeated for every strike on the same expiry.
_chain_cache = TTLCache(ttl=300, maxsize=200)
_spot_cache = TTLCache(ttl=60, maxsize=200)


# ── row accessors ────────────────────────────────────────────────────────────

def option_multiplier(row: Mapping[str, object]) -> float:
    """Contract size. Column-driven — index and mini contracts are not 100."""
    try:
        m = float(row.get("multiplier") or 0)
    except (TypeError, ValueError):
        m = 0.0
    return m if m > 0 else DEFAULT_MULTIPLIER


def option_currency(row: Mapping[str, object]) -> str:
    return normalize_currency(row.get("currency"), DEFAULT_CURRENCY) or DEFAULT_CURRENCY


def _f(v, default: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _day(v) -> Optional[str]:
    s = str(v or "")[:10]
    return s or None


def _is_expired(expiry: str, on: Optional[date] = None) -> bool:
    ref = on or date.today()
    try:
        return datetime.strptime(str(expiry)[:10], "%Y-%m-%d").date() < ref
    except ValueError:
        return False


# ── market data ──────────────────────────────────────────────────────────────

def underlying_spot(symbol: str) -> Optional[float]:
    sym = str(symbol or "").strip().upper()
    if not sym:
        return None
    cached = _spot_cache.get(sym)
    if cached is not None:
        return cached
    try:
        info = market_data.get_fast_info(sym)
        price = getattr(info, "last_price", None) or getattr(info, "regular_market_price", None)
    except Exception:
        logger.debug("spot lookup failed for %s", sym, exc_info=True)
        price = None
    if not price or price <= 0:
        return None
    price = float(price)
    _spot_cache.set(sym, price)
    return price


def _chain_rows(underlying: str, expiry: str) -> dict:
    """`{(option_type, strike): {last, bid, ask, iv}}` for one expiry."""
    key = f"{underlying}|{expiry}"
    cached = _chain_cache.get(key)
    if cached is not None:
        return cached

    table: dict = {}
    try:
        ticker = market_data.get_ticker(underlying)
        if expiry in (ticker.options or []):
            chain = ticker.option_chain(expiry)
            for opt_type, df in (("call", chain.calls), ("put", chain.puts)):
                for rec in df.to_dict("records"):
                    strike = rec.get("strike")
                    if strike is None:
                        continue
                    table[(opt_type, round(float(strike), 4))] = {
                        "last": rec.get("lastPrice"),
                        "bid": rec.get("bid"),
                        "ask": rec.get("ask"),
                        "iv": rec.get("impliedVolatility"),
                    }
    except Exception:
        logger.debug("option chain fetch failed for %s %s", underlying, expiry, exc_info=True)

    _chain_cache.set(key, table)
    return table


def _intrinsic(option_type: str, strike: float, spot: Optional[float]) -> float:
    if not spot:
        return 0.0
    return max(spot - strike, 0.0) if option_type == "call" else max(strike - spot, 0.0)


def _mark_for(row: Mapping[str, object], quote: Optional[dict], spot: Optional[float]) -> tuple[float, str]:
    """Price per contract-share, plus where it came from.

    Falls back down a ladder rather than dropping the lot: a position with no
    quote still has to appear in NAV, and silently valuing it at zero would
    read as a total loss.
    """
    opt_type = str(row.get("option_type") or "call")
    strike = _f(row.get("strike"))
    if _is_expired(str(row.get("expiry") or "")):
        return _intrinsic(opt_type, strike, spot), "intrinsic_expired"
    if quote:
        last = quote.get("last")
        if last is not None and _f(last) > 0:
            return _f(last), "last"
        bid, ask = _f(quote.get("bid")), _f(quote.get("ask"))
        if bid > 0 and ask > 0:
            return (bid + ask) / 2.0, "mid"
        if ask > 0:
            return ask, "ask"
    return _f(row.get("entry_price")), "entry_cost"


# ── valuation ────────────────────────────────────────────────────────────────

def value_option_rows(
    rows: Iterable[Mapping[str, object]],
    base_currency: str = "THB",
    *,
    with_greeks: bool = True,
) -> list[dict]:
    """Enrich open option lots with mark, cost, market value and exposure."""
    base = report_currency(base_currency)
    positions = [dict(r) for r in rows]
    if not positions:
        return []

    chains: dict[tuple[str, str], dict] = {}
    spots: dict[str, Optional[float]] = {}
    for p in positions:
        u = str(p.get("underlying") or "").upper()
        e = str(p.get("expiry") or "")[:10]
        if u and e and (u, e) not in chains:
            chains[(u, e)] = _chain_rows(u, e)
        if u and u not in spots:
            spots[u] = underlying_spot(u)

    out: list[dict] = []
    for p in positions:
        u = str(p.get("underlying") or "").upper()
        e = str(p.get("expiry") or "")[:10]
        opt_type = str(p.get("option_type") or "call")
        strike = _f(p.get("strike"))
        qty = _f(p.get("quantity"))
        mult = option_multiplier(p)
        ccy = option_currency(p)
        spot = spots.get(u)

        quote = chains.get((u, e), {}).get((opt_type, round(strike, 4)))
        mark, mark_source = _mark_for(p, quote, spot)

        cost_native = _f(p.get("entry_price")) * qty * mult
        mv_native = mark * qty * mult
        unreal_native = mv_native - cost_native

        entry_day = _day(p.get("entry_date"))
        cost_base = convert_amount(cost_native, ccy, base, date=entry_day)
        mv_base = convert_amount(mv_native, ccy, base)
        unreal_base = mv_base - cost_base

        delta = gamma = theta = vega = None
        delta_notional_native = None
        iv = quote.get("iv") if quote else None
        if with_greeks and spot and iv and _f(iv) > 0 and not _is_expired(e):
            g = compute_greeks(
                spot=spot, strike=strike, expiry=e,
                option_type=opt_type, implied_vol=_f(iv),
            )
            if "error" not in g:
                delta = g.get("delta")
                gamma = g.get("gamma")
                theta = g.get("theta")
                vega = g.get("vega")
        if delta is None and _is_expired(e):
            # An expired lot is either exercised stock or nothing; its residual
            # exposure is binary, not a Black-Scholes number. Gamma/theta/vega
            # are genuinely undefined past expiry and stay None.
            intrinsic = _intrinsic(opt_type, strike, spot)
            delta = (1.0 if opt_type == "call" else -1.0) if intrinsic > 0 else 0.0
        if delta is not None and spot:
            delta_notional_native = delta * qty * mult * spot

        # Dollar greeks, always reported in USD: they answer "how many dollars
        # does this move", which is a question about the contract's own market,
        # not about the report currency the rest of PORT rolls up in.
        size = qty * mult

        def _to_usd(v: Optional[float]) -> Optional[float]:
            return None if v is None else round(convert_amount(v, ccy, "USD"), 2)

        delta_exp = None if (delta is None or not spot) else delta * size * spot
        gamma_exp = None if (gamma is None or not spot) else gamma * size * spot * spot * 0.01
        theta_exp = None if theta is None else theta * size
        vega_exp = None if vega is None else vega * size
        mv_usd = convert_amount(mv_native, ccy, "USD")
        cost_usd = convert_amount(cost_native, ccy, "USD", date=entry_day)

        p.update({
            "instrument": "option",
            "symbol": f"{u} {e} {strike:g}{'C' if opt_type == 'call' else 'P'}",
            "currency": ccy,
            "multiplier": mult,
            "spot": spot,
            "mark": round(mark, 4),
            "mark_source": mark_source,
            "mark_stale": mark_source == "entry_cost",
            "expired": _is_expired(e),
            "implied_volatility": _f(iv) if iv is not None else None,
            # Raw per-contract greeks, straight from greeks.py in its own units:
            # theta per calendar day, vega per 1pp IV, gamma per $1 of spot.
            "delta": round(delta, 4) if delta is not None else None,
            "gamma": round(gamma, 6) if gamma is not None else None,
            "theta": round(theta, 4) if theta is not None else None,
            "vega": round(vega, 4) if vega is not None else None,
            "cost_basis_native": round(cost_native, 2),
            "market_value_native": round(mv_native, 2),
            "unrealized_pnl": round(unreal_native, 2),
            "unrealized_pct": (
                round(unreal_native / abs(cost_native) * 100, 2) if cost_native else None
            ),
            "cost_basis_base": round(cost_base, 2),
            "market_value_base": round(mv_base, 2),
            "unrealized_pnl_base": round(unreal_base, 2),
            # The base-currency return is NOT the native one: cost converts at
            # the entry-date rate and market value at the live rate, so an
            # unmoved premium still shows a base P&L when FX moved. Pairing the
            # base amount with the native percentage prints "-161 (+0.0%)".
            "unrealized_pct_base": (
                round(unreal_base / abs(cost_base) * 100, 2) if cost_base else None
            ),
            "delta_notional_native": (
                round(delta_notional_native, 2) if delta_notional_native is not None else None
            ),
            "delta_notional_base": (
                round(convert_amount(delta_notional_native, ccy, base), 2)
                if delta_notional_native is not None else None
            ),
            # Position-scaled dollar greeks (USD). See the module docstring for
            # what each one answers; `gamma_exp_usd` is dollar delta per 1% move.
            "delta_exp_usd": _to_usd(delta_exp),
            "gamma_exp_usd": _to_usd(gamma_exp),
            "theta_exp_usd": _to_usd(theta_exp),
            "vega_exp_usd": _to_usd(vega_exp),
            "cost_basis_usd": round(cost_usd, 2),
            "market_value_usd": round(mv_usd, 2),
            "unrealized_pnl_usd": round(mv_usd - cost_usd, 2),
            "unrealized_pct_usd": (
                round((mv_usd - cost_usd) / abs(cost_usd) * 100, 2) if cost_usd else None
            ),
        })
        out.append(p)

    return out


def open_option_positions(
    account_id: Optional[str] = None,
    base_currency: str = "THB",
    *,
    with_greeks: bool = True,
) -> list[dict]:
    """Open lots, read from `v_option_open_lots`.

    A lot is an OPEN trade that is not yet fully matched by closes, so the
    remaining size is computed from the trades rather than stored — there is no
    second copy of it to fall out of step. `lot_id` is aliased to `id` because
    the frontend addresses a lot by that name and the close endpoint takes it.
    """
    where = ["1=1"]
    params: list = []
    if account_id and account_id != "all":
        where.append("v.account_id = ?")
        params.append(account_id)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT v.*, v.lot_id AS id, a.currency acc_currency, a.name acc_name "
            "FROM v_option_open_lots v "
            "LEFT JOIN portfolio_accounts a ON v.account_id = a.id "
            f"WHERE {' AND '.join(where)} ORDER BY v.expiry, v.underlying",
            params,
        ).fetchall()
    return value_option_rows(rows, base_currency, with_greeks=with_greeks)


def closed_option_positions(account_id: Optional[str] = None) -> list[dict]:
    """One row per close↔open match — the unit realized P&L is actually about.

    A partial close produces several rows against the same open lot, which is
    the whole point of matching: "which lot did this close consume, and at what
    price did that lot go on".
    """
    where = ["1=1"]
    params: list = []
    if account_id and account_id != "all":
        where.append("v.account_id = ?")
        params.append(account_id)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT v.*, a.currency acc_currency, a.name acc_name "
            "FROM v_option_realized v "
            "LEFT JOIN portfolio_accounts a ON v.account_id = a.id "
            f"WHERE {' AND '.join(where)} ORDER BY v.exit_date DESC",
            params,
        ).fetchall()
    return [dict(r) for r in rows]


def realized_option_pnl(row: Mapping[str, object], base_currency: str = "THB") -> float:
    """A match's realized P&L in the report currency, at the exit-date FX rate.

    `realized_pnl` was materialized when the match was made. NULL means the
    closing price is genuinely unknown (a lot closed by the pre-2026-09-09
    endpoint, which recorded none) — that contributes 0 here because unknown is
    not a result, and reporting it as break-even would invent one.
    """
    pnl_native = row.get("realized_pnl")
    if pnl_native is None:
        return 0.0
    return convert_amount(
        _f(pnl_native),
        option_currency(row),
        report_currency(base_currency),
        date=_day(row.get("exit_date")) or _day(row.get("expiry")),
    )


def has_realized_price(row: Mapping[str, object]) -> bool:
    return row.get("realized_pnl") is not None


def option_cost_base(row: Mapping[str, object], base_currency: str = "THB") -> float:
    """Entry cost of a match or lot in report currency, at the entry-date rate.

    Signed: a short lot's cost is negative because the premium was received.
    """
    qty = _f(row.get("quantity"))
    direction = _f(row.get("direction"), 1.0) or 1.0
    # v_option_realized carries an unsigned matched quantity plus `direction`;
    # v_option_open_lots already signs `quantity`. Signing twice would flip a
    # short lot's cost back to positive.
    if row.get("direction") is not None and qty >= 0:
        qty = qty * direction
    native = _f(row.get("entry_price")) * qty * option_multiplier(row)
    return convert_amount(
        native, option_currency(row), report_currency(base_currency),
        date=_day(row.get("entry_date")),
    )


# ── Daily greeks snapshots ───────────────────────────────────────────────────
# Attribution needs the state at the START of a period. Yahoo serves only the
# current chain, so — exactly like `iv_snapshots` — this history can only be
# accumulated going forward, never reconstructed. Capture is once per day and
# fail-soft: a missed day widens the next period rather than breaking it.

def capture_daily_greeks(force: bool = False) -> int:
    """Store today's greeks for every open lot. Returns rows written."""
    today = date.today().isoformat()
    try:
        with get_db() as conn:
            if not force and conn.execute(
                "SELECT 1 FROM option_greeks_snapshots WHERE snapshot_date = ? LIMIT 1",
                (today,),
            ).fetchone():
                return 0

        lots = open_option_positions(None, "USD")
        if not lots:
            return 0

        rows = [
            (
                # position_id is the lot id, i.e. the OPEN trade this lot is.
                lot["id"], today, lot.get("account_id"), lot.get("underlying"),
                str(lot.get("expiry") or "")[:10], _f(lot.get("strike")),
                lot.get("option_type"), _f(lot.get("quantity")), option_multiplier(lot),
                option_currency(lot), lot.get("spot"), lot.get("implied_volatility"),
                lot.get("mark"), lot.get("delta"), lot.get("gamma"), lot.get("theta"),
                lot.get("vega"), lot.get("market_value_usd"),
            )
            for lot in lots
        ]
        with get_db() as conn:
            conn.executemany(
                """INSERT INTO option_greeks_snapshots
                   (position_id, snapshot_date, account_id, underlying, expiry, strike,
                    option_type, quantity, multiplier, currency, spot, iv, mark,
                    delta, gamma, theta, vega, market_value_usd)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(position_id, snapshot_date) DO UPDATE SET
                       spot = excluded.spot, iv = excluded.iv, mark = excluded.mark,
                       delta = excluded.delta, gamma = excluded.gamma,
                       theta = excluded.theta, vega = excluded.vega,
                       quantity = excluded.quantity,
                       market_value_usd = excluded.market_value_usd""",
                rows,
            )
        return len(rows)
    except Exception:
        logger.exception("option greeks snapshot capture failed")
        return 0


def _days_between(a: str, b: str) -> float:
    try:
        d1 = datetime.strptime(a[:10], "%Y-%m-%d").date()
        d2 = datetime.strptime(b[:10], "%Y-%m-%d").date()
        return float((d2 - d1).days)
    except ValueError:
        return 1.0


def _attribute_step(prev: Mapping, cur: Mapping) -> Optional[dict]:
    """Taylor decomposition of one lot's P&L between two consecutive snapshots.

    Greeks come from the START of the period (`prev`) — using the end-of-period
    greeks would be explaining the move with information that only existed after
    it happened.
    """
    for k in ("spot", "mark", "delta", "gamma", "theta", "vega", "iv"):
        if prev.get(k) is None:
            return None
    if cur.get("spot") is None or cur.get("mark") is None:
        return None

    qty = _f(prev.get("quantity"))
    mult = _f(prev.get("multiplier")) or DEFAULT_MULTIPLIER
    size = qty * mult

    d_spot = _f(cur["spot"]) - _f(prev["spot"])
    d_iv_pp = ((_f(cur.get("iv")) - _f(prev["iv"])) * 100.0) if cur.get("iv") is not None else 0.0
    d_days = _days_between(prev["snapshot_date"], cur["snapshot_date"])

    delta_pnl = _f(prev["delta"]) * d_spot * size
    gamma_pnl = 0.5 * _f(prev["gamma"]) * d_spot * d_spot * size
    theta_pnl = _f(prev["theta"]) * d_days * size
    vega_pnl = _f(prev["vega"]) * d_iv_pp * size
    actual = (_f(cur["mark"]) - _f(prev["mark"])) * size

    return {
        "date": cur["snapshot_date"],
        "prev_date": prev["snapshot_date"],
        "days": d_days,
        "spot_from": round(_f(prev["spot"]), 4),
        "spot_to": round(_f(cur["spot"]), 4),
        "iv_from": prev.get("iv"),
        "iv_to": cur.get("iv"),
        "delta_pnl": delta_pnl,
        "gamma_pnl": gamma_pnl,
        "theta_pnl": theta_pnl,
        "vega_pnl": vega_pnl,
        "residual": actual - (delta_pnl + gamma_pnl + theta_pnl + vega_pnl),
        "actual": actual,
    }


_PNL_KEYS = ("delta_pnl", "gamma_pnl", "theta_pnl", "vega_pnl", "residual", "actual")


def _blank_bucket() -> dict:
    return {k: 0.0 for k in _PNL_KEYS}


def _explained_pct(bucket: Mapping) -> Optional[float]:
    """How much of the actual move the greeks account for.

    `residual` is defined as the leftover, so the split always adds up — that is
    arithmetic, not evidence. This ratio is the honest quality signal: a large
    residual means the linearisation did not describe what happened.
    """
    actual = abs(_f(bucket.get("actual")))
    if actual < 1e-9:
        return None
    return round((1.0 - abs(_f(bucket.get("residual"))) / actual) * 100.0, 1)


def option_pnl_attribution(account_id: Optional[str] = None, days: int = 30) -> dict:
    """Greeks-based P&L attribution over the stored snapshot history (USD)."""
    since = (date.today() - timedelta(days=max(1, days))).isoformat()
    where = ["snapshot_date >= ?"]
    params: list = [since]
    if account_id and account_id != "all":
        where.append("account_id = ?")
        params.append(account_id)

    with get_db() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM option_greeks_snapshots "
            f"WHERE {' AND '.join(where)} ORDER BY position_id, snapshot_date",
            params,
        ).fetchall()]

    by_position: dict[str, list[dict]] = {}
    for r in rows:
        by_position.setdefault(r["position_id"], []).append(r)

    dates = sorted({r["snapshot_date"] for r in rows})
    portfolio = _blank_bucket()
    per_day: dict[str, dict] = {}
    positions: list[dict] = []
    skipped = 0

    for pos_id, snaps in by_position.items():
        bucket = _blank_bucket()
        steps = 0
        for prev, cur in zip(snaps, snaps[1:]):
            step = _attribute_step(prev, cur)
            if step is None:
                skipped += 1
                continue
            steps += 1
            for k in _PNL_KEYS:
                bucket[k] += step[k]
                portfolio[k] += step[k]
            day = per_day.setdefault(step["date"], _blank_bucket())
            for k in _PNL_KEYS:
                day[k] += step[k]

        if steps == 0:
            continue
        last, first = snaps[-1], snaps[0]
        positions.append({
            "position_id": pos_id,
            "account_id": last.get("account_id"),
            "underlying": last.get("underlying"),
            "expiry": last.get("expiry"),
            "strike": last.get("strike"),
            "option_type": last.get("option_type"),
            "quantity": last.get("quantity"),
            "symbol": (
                f"{last.get('underlying')} {last.get('expiry')} "
                f"{_f(last.get('strike')):g}{'C' if last.get('option_type') == 'call' else 'P'}"
            ),
            "steps": steps,
            "spot_from": first.get("spot"),
            "spot_to": last.get("spot"),
            "iv_from": first.get("iv"),
            "iv_to": last.get("iv"),
            **{k: round(bucket[k], 2) for k in _PNL_KEYS},
            "explained_pct": _explained_pct(bucket),
        })

    positions.sort(key=lambda r: -abs(r["actual"]))
    series = [
        {"date": d, **{k: round(per_day[d][k], 2) for k in _PNL_KEYS}}
        for d in sorted(per_day)
    ]

    note = None
    if len(dates) < 2:
        note = (
            f"{len(dates)} snapshot day(s) stored. Attribution compares consecutive days, so the "
            "first chart appears once a second day is captured — this history accumulates and "
            "cannot be back-filled."
        )

    return {
        "currency": "USD",
        "period": {
            "from": dates[0] if dates else None,
            "to": dates[-1] if dates else None,
            "snapshot_days": len(dates),
            "requested_days": days,
        },
        "portfolio": {
            **{k: round(portfolio[k], 2) for k in _PNL_KEYS},
            "explained_pct": _explained_pct(portfolio),
        },
        "positions": positions,
        "series": series,
        "steps_skipped": skipped,
        "note": note,
    }
