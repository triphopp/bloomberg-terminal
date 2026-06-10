"""
Paper Trading — Simulated order execution with virtual accounts.
Separate from real portfolio. Uses same yfinance price cache.
"""
import uuid
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from cache import TTLCache
from db import get_db
from sources import market_data
from providers.base_options import OptionContract
from providers.yahoo_options import YahooOptionsProvider

router = APIRouter(prefix="/api/paper")

_price_cache: TTLCache = TTLCache(ttl=60, maxsize=300)
_options_provider = YahooOptionsProvider()

SLIPPAGE = 0.0005  # 0.05%
OPTION_COMMISSION = 0.65  # per contract
DEFAULT_COMMISSION_RATE = 0.001  # 0.1%
DEFAULT_COMMISSION_MIN = 1.0


# ── Pydantic models ────────────────────────────────────────────────────────

class AccountCreate(BaseModel):
    name: str
    currency: str = "USD"
    initial_balance: float = 100000.0

class OrderCreate(BaseModel):
    account_id: str
    symbol: str
    side: str  # buy | sell
    order_type: str = "market"  # market | limit | stop | stop_limit
    quantity: float
    limit_price: Optional[float] = None
    stop_price: Optional[float] = None
    expires_at: Optional[str] = None

class OptionOrderCreate(BaseModel):
    account_id: str
    underlying: str
    expiry: str          # YYYY-MM-DD
    strike: float
    option_type: str     # call | put
    side: str            # buy | sell (sell = write/short)
    quantity: int        # number of contracts
    limit_price: Optional[float] = None  # None = market order
    notes: str = ""


# ── Price helpers ───────────────────────────────────────────────────────────

def _get_price(symbol: str) -> Optional[float]:
    sym = symbol.strip().upper()
    cached = _price_cache.get(sym)
    if cached is not None:
        return cached
    try:
        info = market_data.get_fast_info(sym)
        price = getattr(info, "last_price", None) or getattr(info, "regular_market_price", None)
        result = float(price) if price else None
        if result:
            _price_cache.set(sym, result)
        return result
    except Exception:
        return None


def _batch_prices(symbols: list[str]) -> dict[str, Optional[float]]:
    result: dict[str, Optional[float]] = {}
    to_fetch = []
    for sym in symbols:
        cached = _price_cache.get(sym)
        if cached is not None:
            result[sym] = cached
        else:
            to_fetch.append(sym)
    if not to_fetch:
        return result
    try:
        batch = market_data.download(to_fetch, period="1d", interval="1d")
        for sym in to_fetch:
            price = batch.prices.get(sym)
            if price is not None:
                result[sym] = price
                _price_cache.set(sym, price)
            else:
                result[sym] = None
    except Exception:
        pass
    for sym in to_fetch:
        if sym not in result or result[sym] is None:
            try:
                info = market_data.get_fast_info(sym)
                price = getattr(info, "last_price", None) or getattr(info, "regular_market_price", None)
                p = float(price) if price else None
                result[sym] = p
                if p:
                    _price_cache.set(sym, p)
            except Exception:
                result[sym] = None
    return result


# ── Account helpers ─────────────────────────────────────────────────────────

def _get_cash(conn, account_id: str) -> float:
    acc = conn.execute(
        "SELECT initial_balance FROM paper_accounts WHERE id = ?", (account_id,)
    ).fetchone()
    if not acc:
        return 0.0
    cash = acc["initial_balance"]
    fills = conn.execute("""
        SELECT pf.quantity, pf.price, pf.commission, po.side
        FROM paper_fills pf
        JOIN paper_orders po ON pf.order_id = po.id
        WHERE po.account_id = ?
    """, (account_id,)).fetchall()
    for f in fills:
        cost = f["quantity"] * f["price"] + f["commission"]
        if f["side"] == "buy":
            cash -= cost
        else:
            cash += f["quantity"] * f["price"] - f["commission"]
    return round(cash, 2)


def _get_positions_from_db(conn, account_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM paper_positions WHERE account_id = ? AND abs(quantity) > 1e-8",
        (account_id,)
    ).fetchall()
    return [dict(r) for r in rows]


# ── Order execution ─────────────────────────────────────────────────────────

def _apply_slippage(price: float, side: str) -> float:
    if side == "buy":
        return round(price * (1 + SLIPPAGE), 6)
    return round(price * (1 - SLIPPAGE), 6)


def _compute_commission(quantity: float, price: float) -> float:
    comm = quantity * price * DEFAULT_COMMISSION_RATE
    return round(max(comm, DEFAULT_COMMISSION_MIN), 2)


def _execute_fill(conn, order_id: str, account_id: str, symbol: str,
                  side: str, quantity: float, fill_price: float) -> None:
    commission = _compute_commission(quantity, fill_price)
    fill_id = uuid.uuid4().hex[:12]
    now = datetime.utcnow().isoformat()

    conn.execute(
        "INSERT INTO paper_fills (id, order_id, quantity, price, commission, filled_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (fill_id, order_id, quantity, fill_price, commission, now)
    )
    conn.execute(
        "UPDATE paper_orders SET status='filled', filled_qty=?, filled_price=?, filled_at=? WHERE id=?",
        (quantity, fill_price, now, order_id)
    )

    pos = conn.execute(
        "SELECT * FROM paper_positions WHERE account_id=? AND symbol=?",
        (account_id, symbol)
    ).fetchone()

    if side == "buy":
        if pos:
            old_qty = pos["quantity"]
            old_cost = pos["avg_cost"]
            new_qty = old_qty + quantity
            new_avg = ((old_qty * old_cost) + (quantity * fill_price)) / new_qty if new_qty != 0 else 0
            conn.execute(
                "UPDATE paper_positions SET quantity=?, avg_cost=? WHERE id=?",
                (round(new_qty, 8), round(new_avg, 6), pos["id"])
            )
        else:
            conn.execute(
                "INSERT INTO paper_positions (id, account_id, symbol, quantity, avg_cost) "
                "VALUES (?, ?, ?, ?, ?)",
                (uuid.uuid4().hex[:12], account_id, symbol, quantity, fill_price)
            )
    else:  # sell
        if not pos or pos["quantity"] < quantity - 1e-8:
            raise ValueError("Insufficient position to sell")
        realized = (fill_price - pos["avg_cost"]) * quantity
        new_qty = pos["quantity"] - quantity
        new_realized = pos["realized_pnl"] + realized
        if new_qty < 1e-8:
            conn.execute("DELETE FROM paper_positions WHERE id=?", (pos["id"],))
        else:
            conn.execute(
                "UPDATE paper_positions SET quantity=?, realized_pnl=? WHERE id=?",
                (round(new_qty, 8), round(new_realized, 2), pos["id"])
            )


def _check_pending_orders(conn, account_id: Optional[str] = None) -> int:
    where = "WHERE status = 'pending'"
    params: list = []
    if account_id:
        where += " AND account_id = ?"
        params.append(account_id)

    orders = conn.execute(f"SELECT * FROM paper_orders {where}", params).fetchall()
    filled_count = 0

    for order in orders:
        sym = order["symbol"]
        current = _get_price(sym)
        if current is None:
            continue

        should_fill = False
        fill_price = current

        if order["order_type"] == "limit":
            if order["side"] == "buy" and current <= order["limit_price"]:
                should_fill = True
                fill_price = order["limit_price"]
            elif order["side"] == "sell" and current >= order["limit_price"]:
                should_fill = True
                fill_price = order["limit_price"]

        elif order["order_type"] == "stop":
            if order["side"] == "buy" and current >= order["stop_price"]:
                should_fill = True
                fill_price = _apply_slippage(current, "buy")
            elif order["side"] == "sell" and current <= order["stop_price"]:
                should_fill = True
                fill_price = _apply_slippage(current, "sell")

        elif order["order_type"] == "stop_limit":
            if order["side"] == "buy" and current >= order["stop_price"]:
                if current <= order["limit_price"]:
                    should_fill = True
                    fill_price = order["limit_price"]
            elif order["side"] == "sell" and current <= order["stop_price"]:
                if current >= order["limit_price"]:
                    should_fill = True
                    fill_price = order["limit_price"]

        if order["expires_at"]:
            if datetime.utcnow().isoformat() > order["expires_at"]:
                conn.execute("UPDATE paper_orders SET status='expired' WHERE id=?", (order["id"],))
                continue

        if should_fill:
            try:
                remaining = order["quantity"] - order["filled_qty"]
                _execute_fill(conn, order["id"], order["account_id"],
                              sym, order["side"], remaining, fill_price)
                filled_count += 1
            except ValueError:
                conn.execute("UPDATE paper_orders SET status='cancelled' WHERE id=?", (order["id"],))

    return filled_count


def _ensure_daily_snapshot(conn, account_id: str) -> None:
    today = date.today().isoformat()
    exists = conn.execute(
        "SELECT 1 FROM paper_snapshots WHERE account_id=? AND date=?",
        (account_id, today)
    ).fetchone()
    if exists:
        return

    positions = _get_positions_from_db(conn, account_id)
    cash = _get_cash(conn, account_id)

    if positions:
        symbols = [p["symbol"] for p in positions]
        prices = _batch_prices(symbols)
        pos_value = sum(p["quantity"] * (prices.get(p["symbol"]) or 0) for p in positions)
    else:
        pos_value = 0.0

    conn.execute(
        "INSERT OR REPLACE INTO paper_snapshots (id, account_id, date, equity, cash, positions_value) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (uuid.uuid4().hex[:12], account_id, today,
         round(cash + pos_value, 2), round(cash, 2), round(pos_value, 2))
    )


# ── Routes ──────────────────────────────────────────────────────────────────

@router.get("/accounts")
async def list_accounts():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM paper_accounts ORDER BY created_at DESC").fetchall()
    return [dict(r) for r in rows]


@router.post("/accounts")
async def create_account(body: AccountCreate):
    acc_id = uuid.uuid4().hex[:12]
    now = datetime.utcnow().isoformat()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO paper_accounts (id, name, currency, initial_balance, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (acc_id, body.name, body.currency, body.initial_balance, now)
        )
        conn.execute(
            "INSERT INTO paper_snapshots (id, account_id, date, equity, cash, positions_value) "
            "VALUES (?, ?, ?, ?, ?, 0)",
            (uuid.uuid4().hex[:12], acc_id, date.today().isoformat(),
             body.initial_balance, body.initial_balance)
        )
    return {"id": acc_id, "name": body.name, "initial_balance": body.initial_balance}


@router.delete("/accounts/{account_id}")
async def delete_account(account_id: str):
    with get_db() as conn:
        cur = conn.execute("DELETE FROM paper_accounts WHERE id = ?", (account_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Account not found")
    return {"deleted": account_id}


@router.get("/accounts/{account_id}/summary")
async def account_summary(account_id: str):
    with get_db() as conn:
        acc = conn.execute("SELECT * FROM paper_accounts WHERE id=?", (account_id,)).fetchone()
        if not acc:
            raise HTTPException(404, "Account not found")

        _check_pending_orders(conn, account_id)
        _ensure_daily_snapshot(conn, account_id)

        positions = _get_positions_from_db(conn, account_id)
        cash = _get_cash(conn, account_id)

    if positions:
        symbols = [p["symbol"] for p in positions]
        prices = _batch_prices(symbols)
        pos_value = sum(p["quantity"] * (prices.get(p["symbol"]) or 0) for p in positions)
        unrealized = sum(
            (prices.get(p["symbol"]) or p["avg_cost"]) * p["quantity"] - p["avg_cost"] * p["quantity"]
            for p in positions
        )
        total_realized = sum(p["realized_pnl"] for p in positions)
    else:
        pos_value = 0.0
        unrealized = 0.0
        total_realized = 0.0

    equity = cash + pos_value
    initial = acc["initial_balance"]
    total_return = equity - initial
    total_return_pct = (total_return / initial * 100) if initial else 0

    return {
        "account_id": account_id,
        "name": acc["name"],
        "currency": acc["currency"],
        "initial_balance": initial,
        "cash": round(cash, 2),
        "positions_value": round(pos_value, 2),
        "equity": round(equity, 2),
        "unrealized_pnl": round(unrealized, 2),
        "realized_pnl": round(total_realized, 2),
        "total_return": round(total_return, 2),
        "total_return_pct": round(total_return_pct, 2),
        "positions_count": len(positions),
    }


@router.post("/orders")
async def place_order(body: OrderCreate):
    if body.side not in ("buy", "sell"):
        raise HTTPException(400, "side must be buy or sell")
    if body.order_type not in ("market", "limit", "stop", "stop_limit"):
        raise HTTPException(400, "Invalid order_type")
    if body.quantity <= 0:
        raise HTTPException(400, "quantity must be positive")
    if body.order_type in ("limit", "stop_limit") and body.limit_price is None:
        raise HTTPException(400, "limit_price required for limit/stop_limit orders")
    if body.order_type in ("stop", "stop_limit") and body.stop_price is None:
        raise HTTPException(400, "stop_price required for stop/stop_limit orders")

    order_id = uuid.uuid4().hex[:12]
    symbol = body.symbol.strip().upper()

    with get_db() as conn:
        acc = conn.execute("SELECT 1 FROM paper_accounts WHERE id=?", (body.account_id,)).fetchone()
        if not acc:
            raise HTTPException(404, "Account not found")

        conn.execute(
            "INSERT INTO paper_orders (id, account_id, symbol, side, order_type, quantity, "
            "limit_price, stop_price, status, expires_at, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
            (order_id, body.account_id, symbol, body.side, body.order_type,
             body.quantity, body.limit_price, body.stop_price,
             body.expires_at, datetime.utcnow().isoformat())
        )

        if body.order_type == "market":
            current = _get_price(symbol)
            if current is None:
                raise HTTPException(400, f"Cannot get price for {symbol}")

            fill_price = _apply_slippage(current, body.side)

            if body.side == "buy":
                cash = _get_cash(conn, body.account_id)
                cost = body.quantity * fill_price + _compute_commission(body.quantity, fill_price)
                if cost > cash:
                    conn.execute("UPDATE paper_orders SET status='cancelled' WHERE id=?", (order_id,))
                    raise HTTPException(400, f"Insufficient cash. Need {cost:.2f}, have {cash:.2f}")

            if body.side == "sell":
                pos = conn.execute(
                    "SELECT quantity FROM paper_positions WHERE account_id=? AND symbol=?",
                    (body.account_id, symbol)
                ).fetchone()
                if not pos or pos["quantity"] < body.quantity - 1e-8:
                    conn.execute("UPDATE paper_orders SET status='cancelled' WHERE id=?", (order_id,))
                    raise HTTPException(400, f"Insufficient position for {symbol}")

            _execute_fill(conn, order_id, body.account_id, symbol,
                          body.side, body.quantity, fill_price)

            return {
                "order_id": order_id,
                "status": "filled",
                "filled_price": fill_price,
                "commission": _compute_commission(body.quantity, fill_price),
            }

    return {"order_id": order_id, "status": "pending"}


@router.post("/orders/{order_id}/cancel")
async def cancel_order(order_id: str):
    with get_db() as conn:
        order = conn.execute("SELECT status FROM paper_orders WHERE id=?", (order_id,)).fetchone()
        if not order:
            raise HTTPException(404, "Order not found")
        if order["status"] != "pending":
            raise HTTPException(400, f"Cannot cancel order with status '{order['status']}'")
        conn.execute("UPDATE paper_orders SET status='cancelled' WHERE id=?", (order_id,))
    return {"order_id": order_id, "status": "cancelled"}


@router.get("/accounts/{account_id}/orders")
async def list_orders(account_id: str, status: Optional[str] = None,
                      limit: int = Query(100, le=500)):
    with get_db() as conn:
        if status:
            rows = conn.execute(
                "SELECT * FROM paper_orders WHERE account_id=? AND status=? "
                "ORDER BY created_at DESC LIMIT ?",
                (account_id, status, limit)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM paper_orders WHERE account_id=? ORDER BY created_at DESC LIMIT ?",
                (account_id, limit)
            ).fetchall()
    return [dict(r) for r in rows]


@router.get("/accounts/{account_id}/positions")
async def list_positions(account_id: str):
    with get_db() as conn:
        _check_pending_orders(conn, account_id)
        positions = _get_positions_from_db(conn, account_id)

    if not positions:
        return []

    symbols = [p["symbol"] for p in positions]
    prices = _batch_prices(symbols)

    result = []
    for p in positions:
        current = prices.get(p["symbol"])
        market_value = p["quantity"] * current if current else None
        unrealized = (current - p["avg_cost"]) * p["quantity"] if current else None
        unrealized_pct = ((current / p["avg_cost"] - 1) * 100) if current and p["avg_cost"] else None
        result.append({
            **p,
            "current_price": current,
            "market_value": round(market_value, 2) if market_value else None,
            "unrealized_pnl": round(unrealized, 2) if unrealized is not None else None,
            "unrealized_pnl_pct": round(unrealized_pct, 2) if unrealized_pct is not None else None,
        })

    result.sort(key=lambda x: abs(x.get("market_value") or 0), reverse=True)
    return result


@router.get("/accounts/{account_id}/fills")
async def list_fills(account_id: str, limit: int = Query(100, le=500)):
    with get_db() as conn:
        rows = conn.execute("""
            SELECT pf.*, po.symbol, po.side, po.order_type, po.account_id
            FROM paper_fills pf
            JOIN paper_orders po ON pf.order_id = po.id
            WHERE po.account_id = ?
            ORDER BY pf.filled_at DESC
            LIMIT ?
        """, (account_id, limit)).fetchall()
    return [dict(r) for r in rows]


@router.get("/accounts/{account_id}/equity-curve")
async def equity_curve(account_id: str):
    with get_db() as conn:
        acc = conn.execute("SELECT 1 FROM paper_accounts WHERE id=?", (account_id,)).fetchone()
        if not acc:
            raise HTTPException(404, "Account not found")
        _ensure_daily_snapshot(conn, account_id)
        rows = conn.execute(
            "SELECT date, equity, cash, positions_value FROM paper_snapshots "
            "WHERE account_id=? ORDER BY date ASC",
            (account_id,)
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("/execute-pending")
async def execute_pending(account_id: Optional[str] = None):
    with get_db() as conn:
        count = _check_pending_orders(conn, account_id)
    return {"filled": count}


# ── Options Trading ─────────────────────────────────────────────────────────

async def _get_option_market_price(underlying: str, expiry: str,
                                    strike: float, option_type: str) -> Optional[float]:
    contract = OptionContract(
        underlying=underlying.upper(), expiry=expiry,
        strike=strike, option_type=option_type,
    )
    try:
        data = await _options_provider.get_market_data(contract)
        if data and data.last_price:
            return data.last_price
        if data and data.bid and data.ask:
            return round((data.bid + data.ask) / 2, 4)
    except Exception:
        pass
    return None


@router.post("/options/order")
async def place_option_order(body: OptionOrderCreate):
    if body.option_type not in ("call", "put"):
        raise HTTPException(400, "option_type must be call or put")
    if body.side not in ("buy", "sell"):
        raise HTTPException(400, "side must be buy or sell")
    if body.quantity <= 0:
        raise HTTPException(400, "quantity must be positive")

    underlying = body.underlying.strip().upper()
    now = datetime.utcnow().isoformat()

    with get_db() as conn:
        acc = conn.execute("SELECT * FROM paper_accounts WHERE id=?", (body.account_id,)).fetchone()
        if not acc:
            raise HTTPException(404, "Account not found")

    market_price = await _get_option_market_price(
        underlying, body.expiry, body.strike, body.option_type
    )

    if body.limit_price is not None:
        fill_price = body.limit_price
    elif market_price is not None:
        fill_price = _apply_slippage(market_price, body.side)
    else:
        raise HTTPException(400, f"Cannot get market price for {underlying} {body.option_type} {body.strike} {body.expiry}. Provide limit_price.")

    # quantity: positive for long, negative for short
    signed_qty = body.quantity if body.side == "buy" else -body.quantity
    # cost per contract = price × 100 shares/contract
    notional = abs(signed_qty) * fill_price * 100
    commission = abs(signed_qty) * OPTION_COMMISSION

    if body.side == "buy":
        cash = _get_cash_from_db(body.account_id)
        total_cost = notional + commission
        if total_cost > cash:
            raise HTTPException(400, f"Insufficient cash. Need {total_cost:.2f}, have {cash:.2f}")

    pos_id = uuid.uuid4().hex[:12]
    with get_db() as conn:
        # Check if there's an existing open position to net against
        existing = conn.execute(
            "SELECT * FROM paper_option_positions WHERE account_id=? AND underlying=? "
            "AND expiry=? AND strike=? AND option_type=? AND status='open'",
            (body.account_id, underlying, body.expiry, body.strike, body.option_type)
        ).fetchone()

        if existing:
            old_qty = existing["quantity"]
            new_qty = old_qty + signed_qty

            if new_qty == 0:
                # Fully closed
                pnl = (fill_price - existing["entry_price"]) * old_qty * 100 - commission
                conn.execute(
                    "UPDATE paper_option_positions SET status='closed', exit_price=?, "
                    "exit_date=?, realized_pnl=?, commission=commission+? WHERE id=?",
                    (fill_price, now, round(pnl, 2), commission, existing["id"])
                )
                return {
                    "position_id": existing["id"], "action": "closed",
                    "fill_price": fill_price, "realized_pnl": round(pnl, 2),
                    "commission": commission,
                }
            elif (old_qty > 0 and new_qty < 0) or (old_qty < 0 and new_qty > 0):
                # Flipped direction — close old, open new
                close_pnl = (fill_price - existing["entry_price"]) * old_qty * 100 - commission
                conn.execute(
                    "UPDATE paper_option_positions SET status='closed', exit_price=?, "
                    "exit_date=?, realized_pnl=?, commission=commission+? WHERE id=?",
                    (fill_price, now, round(close_pnl, 2), commission, existing["id"])
                )
                # Open new position with remaining qty
                conn.execute(
                    "INSERT INTO paper_option_positions "
                    "(id, account_id, underlying, expiry, strike, option_type, "
                    "quantity, entry_price, entry_date, commission, notes) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (pos_id, body.account_id, underlying, body.expiry,
                     body.strike, body.option_type, new_qty, fill_price, now,
                     commission, body.notes)
                )
                return {
                    "position_id": pos_id, "action": "flipped",
                    "closed_pnl": round(close_pnl, 2),
                    "new_quantity": new_qty, "fill_price": fill_price,
                }
            else:
                # Same direction — average in
                total_cost_old = abs(old_qty) * existing["entry_price"]
                total_cost_new = abs(signed_qty) * fill_price
                new_avg = (total_cost_old + total_cost_new) / abs(new_qty)
                conn.execute(
                    "UPDATE paper_option_positions SET quantity=?, entry_price=?, "
                    "commission=commission+? WHERE id=?",
                    (new_qty, round(new_avg, 4), commission, existing["id"])
                )
                return {
                    "position_id": existing["id"], "action": "averaged",
                    "new_quantity": new_qty, "avg_price": round(new_avg, 4),
                    "fill_price": fill_price, "commission": commission,
                }
        else:
            # New position
            conn.execute(
                "INSERT INTO paper_option_positions "
                "(id, account_id, underlying, expiry, strike, option_type, "
                "quantity, entry_price, entry_date, commission, notes) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (pos_id, body.account_id, underlying, body.expiry,
                 body.strike, body.option_type, signed_qty, fill_price, now,
                 commission, body.notes)
            )
            return {
                "position_id": pos_id, "action": "opened",
                "quantity": signed_qty, "fill_price": fill_price,
                "commission": commission,
                "market_price": market_price,
            }


def _get_cash_from_db(account_id: str) -> float:
    with get_db() as conn:
        return _get_cash(conn, account_id)


@router.get("/accounts/{account_id}/options")
async def list_option_positions(account_id: str, status: str = "open"):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM paper_option_positions WHERE account_id=? AND status=? "
            "ORDER BY expiry ASC, underlying ASC, strike ASC",
            (account_id, status)
        ).fetchall()

    positions = [dict(r) for r in rows]
    if not positions:
        return []

    # Batch fetch underlying prices for delta/value calc
    underlyings = list({p["underlying"] for p in positions})
    spot_prices = _batch_prices(underlyings)

    result = []
    for p in positions:
        spot = spot_prices.get(p["underlying"])
        qty = p["quantity"]
        entry = p["entry_price"]

        # Try get live option price
        live_price = await _get_option_market_price(
            p["underlying"], p["expiry"], p["strike"], p["option_type"]
        )

        market_value = qty * (live_price or entry) * 100 if live_price else None
        unrealized = (live_price - entry) * qty * 100 if live_price else None
        unrealized_pct = ((live_price / entry - 1) * 100) if live_price and entry else None

        # Days to expiry
        try:
            exp_date = datetime.strptime(p["expiry"], "%Y-%m-%d").date()
            dte = (exp_date - date.today()).days
        except Exception:
            dte = None

        result.append({
            **p,
            "spot_price": spot,
            "live_price": live_price,
            "market_value": round(market_value, 2) if market_value is not None else None,
            "unrealized_pnl": round(unrealized, 2) if unrealized is not None else None,
            "unrealized_pnl_pct": round(unrealized_pct, 2) if unrealized_pct is not None else None,
            "dte": dte,
            "direction": "LONG" if qty > 0 else "SHORT",
        })

    return result


@router.get("/accounts/{account_id}/options/closed")
async def list_closed_options(account_id: str, limit: int = Query(100, le=500)):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM paper_option_positions WHERE account_id=? AND status != 'open' "
            "ORDER BY exit_date DESC LIMIT ?",
            (account_id, limit)
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("/options/{position_id}/close")
async def close_option_position(position_id: str, price: Optional[float] = None):
    """Close an option position at market or specified price."""
    with get_db() as conn:
        pos = conn.execute(
            "SELECT * FROM paper_option_positions WHERE id=? AND status='open'",
            (position_id,)
        ).fetchone()
        if not pos:
            raise HTTPException(404, "Open position not found")

    if price is not None:
        exit_price = price
    else:
        exit_price = await _get_option_market_price(
            pos["underlying"], pos["expiry"], pos["strike"], pos["option_type"]
        )
        if exit_price is None:
            raise HTTPException(400, "Cannot get market price. Provide price parameter.")
        exit_price = _apply_slippage(exit_price, "sell" if pos["quantity"] > 0 else "buy")

    commission = abs(pos["quantity"]) * OPTION_COMMISSION
    pnl = (exit_price - pos["entry_price"]) * pos["quantity"] * 100 - commission
    now = datetime.utcnow().isoformat()

    with get_db() as conn:
        conn.execute(
            "UPDATE paper_option_positions SET status='closed', exit_price=?, "
            "exit_date=?, realized_pnl=?, commission=commission+? WHERE id=?",
            (exit_price, now, round(pnl, 2), commission, position_id)
        )

    return {
        "position_id": position_id, "status": "closed",
        "exit_price": exit_price, "realized_pnl": round(pnl, 2),
        "commission": commission,
    }


@router.post("/options/{position_id}/expire")
async def expire_option_position(position_id: str):
    """Mark option as expired worthless (or exercised ITM)."""
    with get_db() as conn:
        pos = conn.execute(
            "SELECT * FROM paper_option_positions WHERE id=? AND status='open'",
            (position_id,)
        ).fetchone()
        if not pos:
            raise HTTPException(404, "Open position not found")

        spot = _get_price(pos["underlying"])
        strike = pos["strike"]
        is_call = pos["option_type"] == "call"

        itm = (spot > strike) if is_call else (spot < strike) if spot else False
        intrinsic = max(0, (spot - strike) if is_call else (strike - spot)) if spot else 0

        if itm and intrinsic > 0:
            # Auto-exercise: P&L = intrinsic value per share × contracts × 100
            pnl = (intrinsic - pos["entry_price"]) * pos["quantity"] * 100
            status = "exercised"
        else:
            # Expire worthless: lose premium paid (long) or keep premium (short)
            pnl = -pos["entry_price"] * pos["quantity"] * 100
            status = "expired"

        now = datetime.utcnow().isoformat()
        conn.execute(
            "UPDATE paper_option_positions SET status=?, exit_price=?, "
            "exit_date=?, realized_pnl=? WHERE id=?",
            (status, intrinsic if itm else 0, now, round(pnl, 2), position_id)
        )

    return {
        "position_id": position_id, "status": status,
        "intrinsic": intrinsic, "realized_pnl": round(pnl, 2),
        "was_itm": itm,
    }
