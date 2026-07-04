"""
Portfolio v2 — Multi-account, multi-currency trade tracking.
Supports TH equity, US equity, and crypto accounts.
"""
import io
import json
import logging
import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Optional

import pandas as pd
from fastapi import APIRouter, HTTPException, Query, UploadFile, File
from pydantic import BaseModel

from sources import market_data

from cache import TTLCache
from db import get_db
from sources import market_data

# ── Price cache — TTL 60s per symbol, THB rate TTL 120s ──────────────────────
_price_cache: TTLCache = TTLCache(ttl=60,  maxsize=300)
_rate_cache:  TTLCache = TTLCache(ttl=120, maxsize=5)

router = APIRouter(prefix="/api/v2/portfolio")

logger = logging.getLogger("api.portfolio_v2")


# ── Helpers ──────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.utcnow().isoformat()


def _map_account_name(name: str) -> str:
    """Map spreadsheet account names to DB IDs."""
    n = str(name).lower().strip()
    if "finansia" in n:
        return "finansia"
    if "dime" in n:
        return "dime"
    if "innov" in n:
        return "innovestx"
    return "finansia"


def _to_float(v) -> Optional[float]:
    try:
        f = float(v)
        return f if f != 0 else None
    except (TypeError, ValueError):
        return None


def _to_float_or_zero(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _fmt_date(v) -> Optional[str]:
    if v is None:
        return None
    if hasattr(v, "strftime"):
        return v.strftime("%Y-%m-%d")
    s = str(v).strip()
    return s[:10] if len(s) >= 10 else s


def _get_yf_symbol(symbol: str, account_id: str) -> Optional[str]:
    """Convert trade symbol to yfinance-compatible format."""
    if not symbol:
        return None
    sym = symbol.strip().upper()
    # Skip options (PUT_INTC, CALL_INTC etc.)
    if sym.startswith(("PUT_", "CALL_")):
        return None
    if account_id == "finansia":
        return f"{sym}.BK"
    if account_id == "innovestx":
        # Already yf-compatible: BTC-USD, BTC-THB, SOL-USD etc.
        if "-" in sym:
            return sym
        # BTCTHB → BTC-THB, SOLTHB → SOL-THB
        if sym.endswith("THB") and len(sym) > 3:
            base = sym[:-3]
            return f"{base}-THB"
        return None
    return sym  # Dime: US symbols as-is


def _get_live_price(symbol: str, account_id: str) -> Optional[float]:
    yf_sym = _get_yf_symbol(symbol, account_id)
    if not yf_sym:
        return None
    cached = _price_cache.get(yf_sym)
    if cached is not None:
        return cached
    try:
        info = market_data.get_fast_info(yf_sym)
        price = getattr(info, "last_price", None) or getattr(info, "regular_market_price", None)
        result = float(price) if price else None
        if result:
            _price_cache.set(yf_sym, result)
        return result
    except Exception:
        return None


_prev_cache: TTLCache = TTLCache(ttl=300, maxsize=300)


def _batch_fetch_prices(symbols: list[str]) -> dict[str, dict]:
    """Batch-fetch current prices + prev_close for multiple yfinance symbols.
    Returns dict[sym] = {"price": float|None, "prev_close": float|None}.
    """
    result: dict[str, dict] = {}
    to_fetch = []

    for sym in symbols:
        cached_price = _price_cache.get(sym)
        cached_prev  = _prev_cache.get(sym)
        if cached_price is not None:
            result[sym] = {"price": cached_price, "prev_close": cached_prev}
        else:
            to_fetch.append(sym)

    if not to_fetch:
        return result

    try:
        batch = market_data.download_quotes(to_fetch)
        for sym in to_fetch:
            snap = batch.quotes.get(sym) if hasattr(batch, "quotes") else None
            price = snap.last_price if snap else None
            prev  = snap.previous_close if snap else None
            result[sym] = {"price": price, "prev_close": prev}
            if price:
                _price_cache.set(sym, price)
            if prev:
                _prev_cache.set(sym, prev)
    except Exception:
        pass

    # Fill missing with individual fallback
    for sym in to_fetch:
        if sym not in result or result[sym].get("price") is None:
            try:
                info  = market_data.get_fast_info(sym)
                price = getattr(info, "last_price", None) or getattr(info, "regular_market_price", None)
                prev  = getattr(info, "previous_close", None)
                p = float(price) if price else None
                pv = float(prev) if prev else None
                result[sym] = {"price": p, "prev_close": pv}
                if p:
                    _price_cache.set(sym, p)
                if pv:
                    _prev_cache.set(sym, pv)
            except Exception:
                result[sym] = {"price": None, "prev_close": None}

    return result


def _get_thb_per_usd() -> float:
    """Get live USD→THB rate, fallback to 33.5. Cached 120s."""
    cached = _rate_cache.get("THBUSD")
    if cached is not None:
        return cached
    try:
        info = market_data.get_fast_info("THBUSD=X")
        rate = getattr(info, "last_price", None)
        if rate and float(rate) > 0:
            result = round(1 / float(rate), 4)
            _rate_cache.set("THBUSD", result)
            return result
    except Exception:
        pass
    return 33.5


# ── Audit helpers ────────────────────────────────────────────────────────────

def _write_audit_log(
    conn,
    trade_id: str,
    action: str,
    old_row: dict,
    new_values: dict | None = None,
    reason: str = "",
) -> None:
    """Append one immutable event to trade_audit_log."""
    fields_changed: dict = {}
    if new_values:
        for k, v in new_values.items():
            old_v = old_row.get(k)
            if old_v != v:
                fields_changed[k] = {"old": old_v, "new": v}

    conn.execute(
        """INSERT INTO trade_audit_log
               (trade_id, action, fields_changed, reason, snapshot)
           VALUES (?, ?, ?, ?, ?)""",
        (
            trade_id,
            action,
            json.dumps(fields_changed),
            reason or "",
            json.dumps({k: old_row.get(k) for k in [
                "symbol", "price_entry", "volume", "date_entry",
                "price_exit", "date_exit", "win_loss", "pnl_amount",
                "price_stoploss", "price_target", "note",
            ]}),
        ),
    )


# ── Pydantic Models ──────────────────────────────────────────────────────────

class AccountIn(BaseModel):
    id: str
    name: str
    broker: str = ""
    country: str = "TH"
    currency: str = "THB"
    account_type: str = "equity"


class AccountPatch(BaseModel):
    name: Optional[str] = None
    broker: Optional[str] = None
    is_active: Optional[int] = None


class TradeIn(BaseModel):
    account_id: str
    symbol: str
    resolved_symbol: Optional[str] = None
    market: Optional[str] = None
    sector: str = ""
    date_entry: str
    date_exit: Optional[str] = None
    price_entry: float = 0
    price_exit: Optional[float] = None
    price_stoploss: Optional[float] = None
    price_target: Optional[float] = None
    volume: float = 0
    amount: Optional[float] = None
    pnl_amount: Optional[float] = None
    win_loss: str = "P"
    pnl_percent: Optional[float] = None
    exchange_rate: float = 1
    strategy_name: str = ""
    entry_trigger: str = ""
    exit_trigger: str = ""
    market_trend: str = ""
    news_sentiment: str = ""
    expectation_based: str = ""
    factor_based: str = ""
    fear_greed_index: str = ""
    vix_index: str = ""
    note: str = ""


class TradePatch(BaseModel):
    # Entry fields (แก้ไขข้อมูลที่กรอกผิด)
    symbol:          Optional[str]   = None
    sector:          Optional[str]   = None
    date_entry:      Optional[str]   = None
    price_entry:     Optional[float] = None
    price_stoploss:  Optional[float] = None
    price_target:    Optional[float] = None
    volume:          Optional[float] = None
    strategy_name:   Optional[str]   = None
    entry_trigger:   Optional[str]   = None
    market_trend:    Optional[str]   = None
    note:            Optional[str]   = None
    # Exit fields
    date_exit:       Optional[str]   = None
    price_exit:      Optional[float] = None
    pnl_amount:      Optional[float] = None
    win_loss:        Optional[str]   = None
    pnl_percent:     Optional[float] = None
    exit_trigger:    Optional[str]   = None
    # Audit meta — NOT persisted to trades table, only to audit log
    adjustment_reason: Optional[str] = None


class CashIn(BaseModel):
    account_id: str
    date: str
    income: float = 0
    investment: float = 0
    exchange_rate: float = 1
    note: str = ""


class DividendIn(BaseModel):
    account_id: str
    asset: str
    ex_date: Optional[str] = None
    pay_date: Optional[str] = None
    amount_per_unit: float = 0
    total_received: float = 0
    reinvested_amount: float = 0
    reinvest_asset: str = ""
    reinvest_price: float = 0
    reinvest_units: float = 0


# ── Symbol Resolver (plans/port-redesign.md Step 1) ──────────────────────────
# Resolve once at write time: user types a bare ticker, we search only the
# markets the account trades and return canonical provider symbols.  The
# chosen resolved_symbol is persisted on the trade so no read path ever has
# to guess exchange suffixes again (root cause of F06).

_MARKET_SUFFIX = {"TH": ".BK", "US": ""}
_MARKET_CURRENCY = {"TH": "THB", "US": "USD"}
_resolve_cache: TTLCache = TTLCache(ttl=3600, maxsize=500)


def _classify_market(sym: str, quote_type: str = "") -> Optional[str]:
    s = sym.upper()
    qt = (quote_type or "").upper()
    if s.endswith(".BK"):
        return "TH"
    if "CRYPTO" in qt or ("-" in s and s.rsplit("-", 1)[-1] in ("USD", "THB", "USDT")):
        return "CRYPTO"
    if "." not in s:
        return "US"
    return None  # other exchange suffixes — unsupported for now


def _account_markets(acc: dict) -> list[str]:
    raw = acc.get("markets")
    if raw:
        try:
            parsed = [str(m).upper() for m in json.loads(raw)]
            if parsed:
                return parsed
        except Exception:
            pass
    return ["CRYPTO"] if acc.get("account_type") == "crypto" else ["US", "TH"]


@router.get("/resolve-symbol")
def resolve_symbol(q: str = Query(..., min_length=1), account_id: str = Query(...)):
    query = q.strip().upper()
    if not query:
        raise HTTPException(status_code=400, detail="Empty query")
    with get_db() as conn:
        row = conn.execute("SELECT * FROM portfolio_accounts WHERE id = ?",
                           (account_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Unknown account")
    acc = dict(row)
    markets = _account_markets(acc)

    cache_key = f"{query}|{','.join(markets)}"
    cached = _resolve_cache.get(cache_key)
    if cached is not None:
        return cached

    matches: list[dict] = []
    seen: set[str] = set()

    def _add(sym: str, market: str, name: str, exchange: str) -> None:
        if sym in seen or market not in markets:
            return
        seen.add(sym)
        matches.append({
            "resolved_symbol": sym,
            "market": market,
            "currency": _MARKET_CURRENCY.get(market)
                        or (sym.rsplit("-", 1)[-1] if "-" in sym else None),
            "name": name,
            "exchange": exchange,
        })

    def _add_from_result(r, market_hint: Optional[str] = None) -> None:
        sym = str(getattr(r, "symbol", "") or "").upper()
        if not sym:
            return
        market = market_hint or _classify_market(sym, str(getattr(r, "quote_type", "") or ""))
        if not market:
            return
        name = str(getattr(r, "long_name", "") or getattr(r, "short_name", "") or "")
        _add(sym, market, name, str(getattr(r, "exchange", "") or ""))

    # 1) free-text search (catches cross-market listings).  Keep only results
    # whose ticker starts with the query — this is a ticker field, and Yahoo's
    # name-relevance matches (e.g. "TU" → APPS "Digital Turbine") are noise.
    try:
        for r in market_data.search(query, max_results=10):
            sym = str(getattr(r, "symbol", "") or "").upper()
            if sym.split(".")[0].split("-")[0].startswith(query):
                _add_from_result(r)
    except Exception:
        logger.warning("resolve-symbol search failed for %r", query, exc_info=True)

    # 2) direct suffix probes — exact tickers the free-text search often misses
    probes: list[tuple[str, str]] = []  # (candidate, market)
    for m in markets:
        if m == "CRYPTO":
            if "-" in query:
                probes.append((query, m))
            elif query.endswith(("THB", "USD")) and len(query) > 3:
                base = query[:-3]
                # THB pairs are mostly delisted on Yahoo — offer USD too
                probes.append((f"{base}-{query[-3:]}", m))
                probes.append((f"{base}-USD", m))
            else:
                probes.append((f"{query}-USD", m))
        else:
            suffix = _MARKET_SUFFIX.get(m)
            if suffix is not None:
                probes.append((f"{query}{suffix}", m))
    for cand, m in probes:
        if cand in seen:
            continue
        found = False
        try:
            for r in market_data.search(cand, max_results=3):
                if str(getattr(r, "symbol", "") or "").upper() == cand:
                    _add_from_result(r, market_hint=m)
                    found = True
                    break
        except Exception:
            pass
        if not found:
            # Yahoo Search doesn't index some symbols (e.g. BTC-THB) that the
            # quote API prices fine — validate via a live quote instead.
            try:
                snap = market_data.get_fast_info(cand)
                if snap is not None and snap.last_price is not None:
                    _add(cand, m, "", "")
            except Exception:
                continue

    # rank: account home country first, then declared markets order
    home = str(acc.get("country") or "").upper()
    order = {mk: i for i, mk in enumerate(markets)}
    matches.sort(key=lambda x: (x["market"] != home, order.get(x["market"], 99)))
    result = {"query": query, "markets": markets, "matches": matches}
    if matches:  # don't cache misses — provider hiccup would stick for an hour
        _resolve_cache.set(cache_key, result)
    return result


# ── Accounts ─────────────────────────────────────────────────────────────────

@router.get("/accounts")
def list_accounts():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM portfolio_accounts WHERE is_active = 1 ORDER BY created_at"
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("/accounts", status_code=201)
def create_account(body: AccountIn):
    with get_db() as conn:
        conn.execute("""
            INSERT INTO portfolio_accounts (id, name, broker, country, currency, account_type)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (body.id, body.name, body.broker, body.country, body.currency, body.account_type))
    return {"ok": True, "id": body.id}


@router.patch("/accounts/{account_id}")
def patch_account(account_id: str, body: AccountPatch):
    updates = body.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    with get_db() as conn:
        conn.execute(f"UPDATE portfolio_accounts SET {set_clause} WHERE id = ?",
                     list(updates.values()) + [account_id])
    return {"ok": True}


@router.delete("/accounts/{account_id}")
def delete_account(account_id: str):
    with get_db() as conn:
        n_trades = conn.execute(
            "SELECT COUNT(*) FROM trades WHERE account_id = ?", (account_id,)
        ).fetchone()[0]
        if n_trades > 0:
            raise HTTPException(
                status_code=409,
                detail=f"Account has {n_trades} trade(s). Delete or move them first.",
            )
        cur = conn.execute("DELETE FROM portfolio_accounts WHERE id = ?", (account_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Account not found")
        conn.execute("DELETE FROM cash_ledger WHERE account_id = ?", (account_id,))
        conn.execute("DELETE FROM dividends   WHERE account_id = ?", (account_id,))
    return {"ok": True}


# ── Trades ───────────────────────────────────────────────────────────────────

@router.get("/trades")
def list_trades(
    account_id: Optional[str] = Query(None),
    win_loss: Optional[str] = Query(None),
    symbol: Optional[str] = Query(None),
    limit: int = Query(500),
    offset: int = Query(0),
):
    where, params = [], []
    if account_id and account_id != "all":
        where.append("account_id = ?")
        params.append(account_id)
    if win_loss:
        where.append("win_loss = ?")
        params.append(win_loss.upper())
    if symbol:
        where.append("symbol LIKE ?")
        params.append(f"%{symbol.upper()}%")
    sql = "SELECT * FROM trades"
    if where:
        sql += " WHERE " + " AND ".join(where)
    # Order by most-recent activity: a freshly-closed trade keeps its old
    # date_entry, so sort by exit date when present (else entry) to surface
    # recent sells at the top instead of burying them by entry date.
    sql += " ORDER BY COALESCE(date_exit, date_entry) DESC, created_at DESC LIMIT ? OFFSET ?"
    params += [limit, offset]
    with get_db() as conn:
        rows = conn.execute(sql, params).fetchall()
    return {"trades": [dict(r) for r in rows], "thb_per_usd": _get_thb_per_usd()}


@router.post("/trades", status_code=201)
def create_trade(body: TradeIn):
    trade_id = str(uuid.uuid4())
    with get_db() as conn:
        acc = conn.execute("SELECT currency FROM portfolio_accounts WHERE id = ?",
                           (body.account_id,)).fetchone()
        currency = acc["currency"] if acc else "THB"
        conn.execute("""
            INSERT INTO trades (id, account_id, symbol, resolved_symbol, market,
                sector, date_entry, date_exit,
                price_entry, price_exit, price_stoploss, price_target, volume, amount,
                pnl_amount, win_loss, pnl_percent, currency, exchange_rate,
                strategy_name, entry_trigger, exit_trigger, market_trend,
                news_sentiment, expectation_based, factor_based,
                fear_greed_index, vix_index, note)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (trade_id, body.account_id, body.symbol.upper(),
              (body.resolved_symbol or "").upper() or None,
              (body.market or "").upper() or None, body.sector,
              body.date_entry, body.date_exit,
              body.price_entry, body.price_exit, body.price_stoploss, body.price_target,
              body.volume, body.amount, body.pnl_amount, body.win_loss.upper(),
              body.pnl_percent, currency, body.exchange_rate,
              body.strategy_name, body.entry_trigger, body.exit_trigger,
              body.market_trend, body.news_sentiment, body.expectation_based,
              body.factor_based, body.fear_greed_index, body.vix_index, body.note))
    return {"ok": True, "id": trade_id}


@router.patch("/trades/{trade_id}")
def patch_trade(trade_id: str, body: TradePatch):
    updates = body.model_dump(exclude_none=True)
    reason = updates.pop("adjustment_reason", "") or ""
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    if "symbol" in updates and updates["symbol"]:
        updates["symbol"] = updates["symbol"].upper()
    if "win_loss" in updates and updates["win_loss"]:
        updates["win_loss"] = updates["win_loss"].upper()
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    with get_db() as conn:
        old = conn.execute("SELECT * FROM trades WHERE id = ?", (trade_id,)).fetchone()
        if not old:
            raise HTTPException(status_code=404, detail="Trade not found")
        old_dict = dict(old)
        cur = conn.execute(f"UPDATE trades SET {set_clause} WHERE id = ?",
                           list(updates.values()) + [trade_id])
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Trade not found")
        _write_audit_log(conn, trade_id, "PATCH", old_dict, updates, reason)
    return {"ok": True}


@router.delete("/trades/{trade_id}")
def delete_trade(trade_id: str):
    with get_db() as conn:
        old = conn.execute("SELECT * FROM trades WHERE id = ?", (trade_id,)).fetchone()
        if not old:
            raise HTTPException(status_code=404, detail="Trade not found")
        _write_audit_log(conn, trade_id, "DELETE", dict(old), None, "")
        conn.execute("DELETE FROM trades WHERE id = ?", (trade_id,))
    return {"ok": True}


# ── Trade Audit Log ─────────────────────────────────────────────────────────

@router.get("/trades/{trade_id}/audit-log")
def get_trade_audit_log(trade_id: str, limit: int = Query(50)):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM trade_audit_log WHERE trade_id = ? ORDER BY created_at DESC LIMIT ?",
            (trade_id, limit),
        ).fetchall()
    entries = []
    for r in rows:
        d = dict(r)
        try:
            d["fields_changed"] = json.loads(d["fields_changed"] or "{}")
        except Exception:
            d["fields_changed"] = {}
        try:
            d["snapshot"] = json.loads(d["snapshot"] or "{}")
        except Exception:
            d["snapshot"] = {}
        entries.append(d)
    return {"audit_log": entries}


@router.get("/audit-log")
def get_recent_audit_log(limit: int = Query(100), account_id: Optional[str] = Query(None)):
    with get_db() as conn:
        if account_id and account_id != "all":
            rows = conn.execute(
                """SELECT l.* FROM trade_audit_log l
                   JOIN trades t ON l.trade_id = t.id
                   WHERE t.account_id = ?
                   ORDER BY l.created_at DESC LIMIT ?""",
                (account_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM trade_audit_log ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
    entries = []
    for r in rows:
        d = dict(r)
        try:
            d["fields_changed"] = json.loads(d["fields_changed"] or "{}")
        except Exception:
            d["fields_changed"] = {}
        try:
            d["snapshot"] = json.loads(d["snapshot"] or "{}")
        except Exception:
            d["snapshot"] = {}
        entries.append(d)
    return {"audit_log": entries}


# ── Position Cost Overrides (manual avg cost correction) ────────────────────

class CostOverrideIn(BaseModel):
    account_id: str
    symbol: str
    avg_cost: float
    reason: Optional[str] = ""

@router.get("/cost-overrides")
def get_cost_overrides(account_id: Optional[str] = Query(None)):
    with get_db() as conn:
        if account_id and account_id != "all":
            rows = conn.execute(
                "SELECT * FROM position_cost_overrides WHERE account_id = ?",
                (account_id,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM position_cost_overrides").fetchall()
    return [dict(r) for r in rows]

@router.post("/cost-overrides")
def set_cost_override(body: CostOverrideIn):
    with get_db() as conn:
        conn.execute(
            """INSERT INTO position_cost_overrides (account_id, symbol, avg_cost, reason, updated_at)
               VALUES (?, ?, ?, ?, datetime('now'))
               ON CONFLICT(account_id, symbol) DO UPDATE SET
               avg_cost = excluded.avg_cost, reason = excluded.reason, updated_at = excluded.updated_at""",
            (body.account_id, body.symbol, body.avg_cost, body.reason or "")
        )
    return {"ok": True}

@router.delete("/cost-overrides/{account_id}/{symbol}")
def delete_cost_override(account_id: str, symbol: str):
    with get_db() as conn:
        conn.execute(
            "DELETE FROM position_cost_overrides WHERE account_id = ? AND symbol = ?",
            (account_id, symbol)
        )
    return {"ok": True}


# ── Sell / Partial Sell ──────────────────────────────────────────────────────

# ── Bulk Sector Re-normalize (one-time migration tool) ─────────────────────

@router.post("/trades/bulk-patch-sector")
def bulk_patch_sector(body: dict):
    """
    body = {"mappings": {"GOLD": "Materials", ...}, "account_id": "dime"}  # optional filter
    """
    import os
    if os.getenv("ALLOW_DANGEROUS_OPS", "") != "1":
        raise HTTPException(status_code=403, detail="Set ALLOW_DANGEROUS_OPS=1 env var to enable")

    mappings: dict = body.get("mappings", {})
    account_id: str | None = body.get("account_id")
    if not mappings:
        raise HTTPException(status_code=400, detail="No mappings provided")
    updated = 0
    with get_db() as conn:
        for old_val, new_val in mappings.items():
            where = "sector = ?"
            params: list = [old_val]
            if account_id:
                where += " AND account_id = ?"
                params.append(account_id)
            cur = conn.execute(f"UPDATE trades SET sector = ? WHERE {where}",
                               [new_val] + params)
            updated += cur.rowcount
    return {"ok": True, "updated": updated}


class SellIn(BaseModel):
    trade_id: str                        # ID of the open position being sold
    sell_volume: float = 0               # How many shares/units to sell (0 = all)
    sell_price: float = 0                # Exit price
    sell_date: str                       # Date of sale (YYYY-MM-DD)
    commission: float = 0                # Optional commission


@router.post("/sell", status_code=201)
def sell_position(body: SellIn):
    """Close or partially reduce an open position.

    Full sell (sell_volume = 0 or >= position volume):
        Updates the trade: sets date_exit, price_exit, pnl_amount, win_loss

    Partial sell (sell_volume < position volume):
        1. Creates a new CLOSED trade for the sold portion
        2. Reduces the original trade's volume (remaining shares stay open)
    """
    with get_db() as conn:
        # Find the open position
        row = conn.execute(
            "SELECT * FROM trades WHERE id = ? AND win_loss = 'P'",
            (body.trade_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Open position not found")

        pos = dict(row)
        total_volume = float(pos["volume"])
        sell_vol = float(body.sell_volume) if body.sell_volume > 0 else total_volume

        if sell_vol > total_volume:
            raise HTTPException(status_code=400, detail=f"Sell volume ({sell_vol}) exceeds position volume ({total_volume})")

        # Cost override takes priority; fall back to AVCO across all open lots
        override_row = conn.execute(
            "SELECT avg_cost FROM position_cost_overrides WHERE account_id = ? AND symbol = ?",
            (pos["account_id"], pos["symbol"])
        ).fetchone()
        if override_row:
            avg_cost = float(override_row["avg_cost"])
        else:
            all_lots = conn.execute(
                "SELECT price_entry, volume FROM trades WHERE account_id = ? AND symbol = ? AND win_loss = 'P'",
                (pos["account_id"], pos["symbol"])
            ).fetchall()
            total_vol_all = sum(float(l["volume"]) for l in all_lots)
            if total_vol_all > 0:
                avg_cost = sum(float(l["price_entry"]) * float(l["volume"]) for l in all_lots) / total_vol_all
            else:
                avg_cost = float(pos["price_entry"])

        entry_price = avg_cost
        exit_price  = float(body.sell_price)
        remaining   = round(total_volume - sell_vol, 8)

        if remaining <= 1e-8:
            # ── Full sell: close the position ────────────────────────────────
            pnl = round((exit_price - entry_price) * total_volume, 2)
            pnl_pct = round(((exit_price / entry_price) - 1) * 100, 2) if entry_price > 0 else 0
            pnl_net = round(pnl - float(body.commission), 2)
            wl = "W" if pnl_net >= 0 else "L"

            new_vals = {
                "date_exit": body.sell_date, "price_exit": exit_price,
                "pnl_amount": pnl_net, "win_loss": wl, "pnl_percent": pnl_pct,
            }
            conn.execute(
                """UPDATE trades SET date_exit = ?, price_exit = ?,
                   pnl_amount = ?, win_loss = ?, pnl_percent = ?, note = note || ?
                   WHERE id = ?""",
                (body.sell_date, exit_price, pnl_net, wl, pnl_pct,
                 f"\n[SOLD {body.sell_date}] @ {exit_price} | P&L: {pnl_net}",
                 body.trade_id),
            )
            _write_audit_log(conn, body.trade_id, "SELL_FULL", pos, new_vals,
                             f"full sell {total_volume} @ {exit_price}")

            return {
                "ok": True,
                "action": "full_sell",
                "trade_id": body.trade_id,
                "pnl_amount": pnl_net,
                "pnl_percent": pnl_pct,
                "win_loss": wl,
            }
        else:
            # ── Partial sell: split into sold + remaining ────────────────────
            sold_volume = sell_vol
            sold_pnl = round((exit_price - entry_price) * sold_volume, 2)
            sold_pnl_pct = round(((exit_price / entry_price) - 1) * 100, 2) if entry_price > 0 else 0
            sold_pnl_net = round(sold_pnl - float(body.commission), 2)
            sold_wl = "W" if sold_pnl_net >= 0 else "L"

            import uuid as _uuid
            sold_id = str(_uuid.uuid4())
            conn.execute(
                """INSERT INTO trades (id, account_id, symbol, sector, date_entry, date_exit,
                   price_entry, price_exit, volume, pnl_amount, win_loss, pnl_percent,
                   currency, exchange_rate, strategy_name, note)
                   SELECT ?, account_id, symbol, sector, date_entry, ?,
                   ?, ?, ?, ?, ?, ?,
                   currency, exchange_rate, strategy_name, ?
                   FROM trades WHERE id = ?""",
                (sold_id, body.sell_date, avg_cost, exit_price, sold_volume,
                 sold_pnl_net, sold_wl, sold_pnl_pct,
                 "",
                 body.trade_id),
            )

            # Reduce the remaining open lot. The partial sell is captured in the
            # audit log (below) — no auto-note appended to keep notes user-owned.
            conn.execute(
                "UPDATE trades SET volume = ? WHERE id = ?",
                (remaining, body.trade_id),
            )

            # Log on BOTH the original lot (volume reduced) and the new sold record
            _write_audit_log(conn, body.trade_id, "SELL_PARTIAL", pos,
                             {"volume": remaining},
                             f"partial sell {sold_volume} @ {exit_price}, avg_cost={round(avg_cost,4)}, remaining={remaining}")
            sold_snap = {k: pos.get(k) for k in ["symbol", "price_entry", "date_entry"]}
            _write_audit_log(conn, sold_id, "SELL_PARTIAL_CREATED", sold_snap,
                             {"volume": sold_volume, "price_entry": avg_cost,
                              "price_exit": exit_price,
                              "win_loss": sold_wl, "pnl_amount": sold_pnl_net},
                             f"created from partial sell of {body.trade_id}")

            return {
                "ok": True,
                "action": "partial_sell",
                "sold_trade_id": sold_id,
                "remaining_trade_id": body.trade_id,
                "sold_volume": sold_volume,
                "remaining_volume": remaining,
                "pnl_amount": sold_pnl_net,
                "pnl_percent": sold_pnl_pct,
                "win_loss": sold_wl,
            }


class SellAllLotsIn(BaseModel):
    account_id: str
    symbol: str
    sell_price: float
    sell_date: str
    commission: float = 0


@router.post("/sell-all-lots", status_code=201)
def sell_all_lots(body: SellAllLotsIn):
    """Close ALL open lots for a given account+symbol in one call.
    Uses AVCO across all lots. Calls the same full-sell logic per lot.
    """
    with get_db() as conn:
        lots = conn.execute(
            "SELECT * FROM trades WHERE account_id = ? AND symbol = ? AND win_loss = 'P'",
            (body.account_id, body.symbol),
        ).fetchall()
        if not lots:
            raise HTTPException(status_code=404, detail="No open positions found")

        lots = [dict(r) for r in lots]
        total_vol = sum(float(l["volume"]) for l in lots)
        avg_cost  = sum(float(l["price_entry"]) * float(l["volume"]) for l in lots) / total_vol
        exit_price = float(body.sell_price)
        closed_ids = []

        for pos in lots:
            vol = float(pos["volume"])
            pnl = round((exit_price - avg_cost) * vol, 2)
            pnl_pct = round(((exit_price / avg_cost) - 1) * 100, 2) if avg_cost > 0 else 0
            pnl_net = round(pnl - float(body.commission) / len(lots), 2)
            wl = "W" if pnl_net >= 0 else "L"
            conn.execute(
                """UPDATE trades SET date_exit = ?, price_exit = ?,
                   pnl_amount = ?, win_loss = ?, pnl_percent = ?, note = note || ?
                   WHERE id = ?""",
                (body.sell_date, exit_price, pnl_net, wl, pnl_pct,
                 f"\n[SOLD {body.sell_date}] @ {exit_price} | P&L: {pnl_net}",
                 pos["id"]),
            )
            closed_ids.append(pos["id"])

        return {"ok": True, "action": "sell_all_lots", "closed_ids": closed_ids, "lots_closed": len(closed_ids)}


# ── Cash Ledger ───────────────────────────────────────────────────────────────

@router.get("/cash")
def list_cash(account_id: Optional[str] = Query(None)):
    where, params = [], []
    if account_id and account_id != "all":
        where.append("account_id = ?")
        params.append(account_id)
    sql = "SELECT * FROM cash_ledger"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY date DESC"
    with get_db() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


@router.post("/cash", status_code=201)
def add_cash(body: CashIn):
    entry_id = str(uuid.uuid4())
    with get_db() as conn:
        conn.execute("""
            INSERT INTO cash_ledger (id, account_id, date, income, investment, exchange_rate, note)
            VALUES (?,?,?,?,?,?,?)
        """, (entry_id, body.account_id, body.date, body.income, body.investment,
              body.exchange_rate, body.note))
    return {"ok": True, "id": entry_id}


@router.put("/cash/{entry_id}")
def update_cash(entry_id: str, body: CashIn):
    with get_db() as conn:
        cur = conn.execute("""
            UPDATE cash_ledger SET account_id=?, date=?, income=?, investment=?,
                exchange_rate=?, note=?
            WHERE id = ?
        """, (body.account_id, body.date, body.income, body.investment,
              body.exchange_rate, body.note, entry_id))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Cash entry not found")
    return {"ok": True}


@router.delete("/cash/{entry_id}")
def delete_cash(entry_id: str):
    with get_db() as conn:
        cur = conn.execute("DELETE FROM cash_ledger WHERE id = ?", (entry_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Cash entry not found")
    return {"ok": True}


# ── Dividends ─────────────────────────────────────────────────────────────────

@router.get("/dividends")
def list_dividends(account_id: Optional[str] = Query(None)):
    where, params = [], []
    if account_id and account_id != "all":
        where.append("account_id = ?")
        params.append(account_id)
    sql = "SELECT * FROM dividends"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY pay_date DESC"
    with get_db() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


@router.post("/dividends", status_code=201)
def add_dividend(body: DividendIn):
    div_id = str(uuid.uuid4())
    with get_db() as conn:
        conn.execute("""
            INSERT INTO dividends (id, account_id, asset, ex_date, pay_date,
                amount_per_unit, total_received, reinvested_amount,
                reinvest_asset, reinvest_price, reinvest_units)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
        """, (div_id, body.account_id, body.asset, body.ex_date, body.pay_date,
              body.amount_per_unit, body.total_received, body.reinvested_amount,
              body.reinvest_asset, body.reinvest_price, body.reinvest_units))
    return {"ok": True, "id": div_id}


@router.put("/dividends/{div_id}")
def update_dividend(div_id: str, body: DividendIn):
    with get_db() as conn:
        cur = conn.execute("""
            UPDATE dividends SET account_id=?, asset=?, ex_date=?, pay_date=?,
                amount_per_unit=?, total_received=?, reinvested_amount=?,
                reinvest_asset=?, reinvest_price=?, reinvest_units=?
            WHERE id = ?
        """, (body.account_id, body.asset, body.ex_date, body.pay_date,
              body.amount_per_unit, body.total_received, body.reinvested_amount,
              body.reinvest_asset, body.reinvest_price, body.reinvest_units, div_id))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Dividend entry not found")
    return {"ok": True}


@router.delete("/dividends/{div_id}")
def delete_dividend(div_id: str):
    with get_db() as conn:
        cur = conn.execute("DELETE FROM dividends WHERE id = ?", (div_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Dividend entry not found")
    return {"ok": True}


# ── Dividend Suggestions (from yfinance) ─────────────────────────────────────

@router.get("/dividend-suggestions")
def get_dividend_suggestions(account_id: Optional[str] = Query(None)):
    """Fetch dividend data from yfinance for open positions, from the date each
    position was entered onward — never dividends predating the purchase.

    Returns one suggestion per symbol with: asset, amount_per_unit, ex_date, pay_date.
    Skips ex-dates already recorded in the dividends table (no duplicate suggestions).
    """
    where = ["win_loss = 'P'"]
    params = []
    if account_id and account_id != "all":
        where.append("account_id = ?")
        params.append(account_id)

    with get_db() as conn:
        rows = conn.execute(
            "SELECT symbol, account_id, MIN(date_entry) date_entry FROM trades t "
            f"WHERE {' AND '.join(where)} GROUP BY symbol, account_id ORDER BY symbol",
            params,
        ).fetchall()

        existing = {
            (r["asset"], r["account_id"], r["ex_date"])
            for r in conn.execute("SELECT asset, account_id, ex_date FROM dividends").fetchall()
        }

    if not rows:
        return {"suggestions": []}

    suggestions = []
    for r in rows:
        symbol = r["symbol"]
        acct = r["account_id"]
        held_since = r["date_entry"]
        try:
            yf_sym = _get_yf_symbol(symbol, acct)
            if not yf_sym:
                continue
            # Typed dividend access via market_data contract
            div_records = market_data.get_dividends(yf_sym)
            if not div_records:
                continue
            # Only dividends paid while the position was actually held
            eligible = [d for d in div_records if d.ex_date >= held_since]
            eligible = [d for d in eligible if (symbol, acct, d.ex_date) not in existing]
            if not eligible:
                continue
            for d in sorted(eligible, key=lambda d: d.ex_date):
                if d.amount > 0:
                    suggestions.append({
                        "asset": symbol,
                        "account_id": acct,
                        "amount_per_unit": round(d.amount, 6),
                        "ex_date": d.ex_date,
                        "pay_date": d.ex_date,  # ex-date used for pay_date
                        "source": "yfinance",
                    })
        except Exception:
            continue

    return {"suggestions": suggestions}


# ── Open Positions (with live prices) ────────────────────────────────────────

@router.get("/open-positions")
def get_open_positions(
    account_id: Optional[str] = Query(None),
    base_currency: str = Query("THB"),
):
    where = ["win_loss = 'P'"]
    params = []
    if account_id and account_id != "all":
        where.append("account_id = ?")
        params.append(account_id)

    with get_db() as conn:
        rows = conn.execute(
            "SELECT t.*, a.currency acc_currency, a.name acc_name "
            "FROM trades t JOIN portfolio_accounts a ON t.account_id = a.id "
            f"WHERE {' AND '.join(where)} ORDER BY t.date_entry DESC",
            params,
        ).fetchall()

    positions = [dict(r) for r in rows]
    if not positions:
        return {"positions": [], "thb_per_usd": _get_thb_per_usd()}

    thb_per_usd = _get_thb_per_usd()

    # ── Batch-fetch all prices in one yfinance call ───────────────────────────
    yf_sym_map: dict[str, str] = {}   # yf_symbol → original position symbol+acct key
    pos_yf_map: dict[int, str] = {}   # position index → yf_symbol

    for i, pos in enumerate(positions):
        yf_sym = _get_yf_symbol(pos["symbol"], pos["account_id"])
        if yf_sym:
            yf_sym_map[yf_sym] = yf_sym
            pos_yf_map[i] = yf_sym

    price_lookup = _batch_fetch_prices(list(yf_sym_map.keys()))

    # ── Enrich positions with prices ─────────────────────────────────────────
    enriched = []
    for i, pos in enumerate(positions):
        yf_sym = pos_yf_map.get(i)
        quote   = price_lookup.get(yf_sym) if yf_sym else {}
        price   = quote.get("price") if quote else None
        prev_close = quote.get("prev_close") if quote else None
        pos["current_price"] = price
        pos["prev_close"] = prev_close
        if price and pos["price_entry"] and pos["price_entry"] > 0:
            vol = _to_float_or_zero(pos["volume"])
            entry = _to_float_or_zero(pos["price_entry"])
            pnl = (price - entry) * vol
            pos["unrealized_pnl"] = round(pnl, 4)
            pos["unrealized_pct"] = round((price - entry) / entry * 100, 2)
            if pos["acc_currency"] == "USD":
                pos["unrealized_pnl_thb"] = round(pnl * thb_per_usd, 2)
            else:
                pos["unrealized_pnl_thb"] = round(pnl, 2)
        else:
            pos["unrealized_pnl"] = None
            pos["unrealized_pct"] = None
            pos["unrealized_pnl_thb"] = None
        # ── Day P&L (today's move vs previous close) ──────────────────────────
        if price and prev_close and prev_close > 0:
            vol = _to_float_or_zero(pos["volume"])
            day_pnl = (price - prev_close) * vol
            pos["day_pnl"] = round(day_pnl, 4)
            pos["day_pct"] = round((price - prev_close) / prev_close * 100, 2)
            if pos["acc_currency"] == "USD":
                pos["day_pnl_thb"] = round(day_pnl * thb_per_usd, 2)
            else:
                pos["day_pnl_thb"] = round(day_pnl, 2)
        else:
            pos["day_pnl"] = None
            pos["day_pnl_thb"] = None
            pos["day_pct"] = None
        enriched.append(pos)

    return {"positions": enriched, "thb_per_usd": thb_per_usd}


# ── Summary ───────────────────────────────────────────────────────────────────

@router.get("/summary")
def get_summary(base_currency: str = Query("THB")):
    with get_db() as conn:
        accounts = [dict(r) for r in conn.execute(
            "SELECT * FROM portfolio_accounts WHERE is_active = 1"
        ).fetchall()]

        trade_stats = conn.execute("""
            SELECT account_id,
                   COUNT(*) total_trades,
                   SUM(CASE WHEN win_loss = 'W' THEN 1 ELSE 0 END) wins,
                   SUM(CASE WHEN win_loss = 'L' THEN 1 ELSE 0 END) losses,
                   SUM(CASE WHEN win_loss = 'P' THEN 1 ELSE 0 END) open_count,
                   SUM(COALESCE(pnl_amount, 0)) total_pnl_native
            FROM trades
            GROUP BY account_id
        """).fetchall()

        cash_stats = conn.execute("""
            SELECT account_id,
                   SUM(income) total_income,
                   SUM(investment) total_invested
            FROM cash_ledger GROUP BY account_id
        """).fetchall()

        div_stats = conn.execute("""
            SELECT account_id, SUM(total_received) total_dividends
            FROM dividends GROUP BY account_id
        """).fetchall()

    thb_per_usd = _get_thb_per_usd()

    stats_map = {r["account_id"]: dict(r) for r in trade_stats}
    cash_map  = {r["account_id"]: dict(r) for r in cash_stats}
    div_map   = {r["account_id"]: dict(r) for r in div_stats}

    result = []
    total_pnl_base = 0.0
    total_wins = total_closed = 0

    for acc in accounts:
        aid = acc["id"]
        s   = stats_map.get(aid, {})
        c   = cash_map.get(aid, {})
        d   = div_map.get(aid, {})

        wins   = int(s.get("wins", 0) or 0)
        losses = int(s.get("losses", 0) or 0)
        closed = wins + losses
        total  = int(s.get("total_trades", 0) or 0)
        open_n = int(s.get("open_count", 0) or 0)
        win_rate = round(wins / closed * 100, 1) if closed > 0 else 0.0

        pnl_native = float(s.get("total_pnl_native") or 0)
        if acc["currency"] == "USD" and base_currency == "THB":
            pnl_base = pnl_native * thb_per_usd
        elif acc["currency"] == "THB" and base_currency == "USD":
            pnl_base = pnl_native / thb_per_usd
        else:
            pnl_base = pnl_native

        total_pnl_base += pnl_base
        total_wins  += wins
        total_closed += closed

        result.append({
            "account":        acc,
            "total_trades":   total,
            "open_count":     open_n,
            "wins":           wins,
            "losses":         losses,
            "win_rate":       win_rate,
            "pnl_native":     round(pnl_native, 2),
            "pnl_base":       round(pnl_base, 2),
            "total_income":   float(c.get("total_income") or 0),
            "total_invested": float(c.get("total_invested") or 0),
            "total_dividends": float(d.get("total_dividends") or 0),
        })

    return {
        "accounts":       result,
        "total_pnl_base": round(total_pnl_base, 2),
        "global_win_rate": round(total_wins / total_closed * 100, 1) if total_closed > 0 else 0,
        "base_currency":  base_currency,
        "thb_per_usd":    thb_per_usd,
    }


# ── NAV snapshots (daily mark-to-market history) ────────────────────────────────

def _maybe_capture_nav() -> None:
    """Capture today's portfolio NAV once per day (capture-on-view).

    Writes one row per active account plus a global 'all' row, all in THB base.
    Cheap no-op if today's snapshot already exists. Never raises into callers.
    """
    try:
        today = datetime.now().strftime("%Y-%m-%d")
        with get_db() as conn:
            if conn.execute(
                "SELECT 1 FROM portfolio_nav_snapshots WHERE snapshot_date = ? LIMIT 1",
                (today,),
            ).fetchone():
                return

            accounts = {
                a["id"]: dict(a)
                for a in conn.execute(
                    "SELECT id, currency FROM portfolio_accounts WHERE is_active = 1"
                ).fetchall()
            }
            if not accounts:
                return

            realized_map = {
                r["account_id"]: float(r["realized"] or 0)
                for r in conn.execute(
                    "SELECT account_id, SUM(COALESCE(pnl_amount,0)) realized "
                    "FROM trades WHERE win_loss != 'P' GROUP BY account_id"
                ).fetchall()
            }
            invested_map = {
                r["account_id"]: float(r["invested"] or 0)
                for r in conn.execute(
                    "SELECT account_id, SUM(COALESCE(investment,0)) invested "
                    "FROM cash_ledger GROUP BY account_id"
                ).fetchall()
            }
            div_map = {
                r["account_id"]: float(r["div"] or 0)
                for r in conn.execute(
                    "SELECT account_id, SUM(COALESCE(total_received,0)) div "
                    "FROM dividends GROUP BY account_id"
                ).fetchall()
            }
            open_rows = [
                dict(r)
                for r in conn.execute(
                    "SELECT account_id, symbol, price_entry, volume, amount "
                    "FROM trades WHERE win_loss = 'P'"
                ).fetchall()
            ]

        thb_per_usd = _get_thb_per_usd()

        # Live prices for all open symbols, in one batch
        yf_map: dict[int, Optional[str]] = {}
        wanted: set[str] = set()
        for i, p in enumerate(open_rows):
            ys = _get_yf_symbol(p["symbol"], p["account_id"])
            yf_map[i] = ys
            if ys:
                wanted.add(ys)
        price_lookup = _batch_fetch_prices(list(wanted))

        from collections import defaultdict as _dd
        unreal: dict = _dd(float)
        cost: dict = _dd(float)
        for i, p in enumerate(open_rows):
            acc = accounts.get(p["account_id"])
            if not acc:
                continue
            fx = thb_per_usd if acc["currency"] == "USD" else 1.0
            vol = _to_float_or_zero(p["volume"])
            entry = _to_float_or_zero(p["price_entry"])
            cost_native = _to_float_or_zero(p["amount"]) or entry * vol
            cost[p["account_id"]] += cost_native * fx
            quote = price_lookup.get(yf_map.get(i)) if yf_map.get(i) else None
            price = quote.get("price") if quote else None
            if price and entry > 0:
                unreal[p["account_id"]] += (price - entry) * vol * fx

        rows: list[tuple] = []
        g = {"total": 0.0, "cost": 0.0, "unreal": 0.0, "real": 0.0, "inv": 0.0, "div": 0.0}
        for aid, acc in accounts.items():
            fx = thb_per_usd if acc["currency"] == "USD" else 1.0
            realized = realized_map.get(aid, 0.0) * fx     # native → THB
            invested = invested_map.get(aid, 0.0)          # already THB
            dividends = div_map.get(aid, 0.0)              # already THB
            c = cost.get(aid, 0.0)
            u = unreal.get(aid, 0.0)
            # NAV = mark-to-market value of current holdings. Deposit-independent
            # (cash_ledger deposits are often incomplete); realized/invested/dividends
            # are stored alongside for context but do not inflate the asset value.
            total = c + u
            rows.append((aid, today, total, c, u, realized, invested, dividends))
            g["total"] += total; g["cost"] += c; g["unreal"] += u
            g["real"] += realized; g["inv"] += invested; g["div"] += dividends
        rows.append(("all", today, g["total"], g["cost"], g["unreal"],
                     g["real"], g["inv"], g["div"]))

        with get_db() as conn:
            conn.executemany("""
                INSERT INTO portfolio_nav_snapshots
                    (account_id, snapshot_date, total_value, open_cost_basis,
                     unrealized_pnl, realized_pnl, invested_capital, dividends)
                VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(account_id, snapshot_date) DO UPDATE SET
                    total_value      = excluded.total_value,
                    open_cost_basis  = excluded.open_cost_basis,
                    unrealized_pnl   = excluded.unrealized_pnl,
                    realized_pnl     = excluded.realized_pnl,
                    invested_capital = excluded.invested_capital,
                    dividends        = excluded.dividends
            """, rows)
    except Exception:
        logger.exception("NAV snapshot capture failed")


@router.get("/nav-history")
def get_nav_history(account_id: Optional[str] = Query(None), days: int = Query(365)):
    """Daily NAV time series (THB base) for charting total asset value."""
    aid = account_id if (account_id and account_id != "all") else "all"
    with get_db() as conn:
        rows = conn.execute(
            """SELECT snapshot_date, total_value, open_cost_basis, unrealized_pnl,
                      realized_pnl, invested_capital, dividends
               FROM portfolio_nav_snapshots
               WHERE account_id = ?
               ORDER BY snapshot_date DESC LIMIT ?""",
            (aid, max(1, days)),
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


# ── Analytics ─────────────────────────────────────────────────────────────────

@router.get("/analytics")
def get_analytics(account_id: Optional[str] = Query(None), base_currency: str = Query("THB")):
    _maybe_capture_nav()
    where, params = ["t.win_loss != 'P'"], []
    if account_id and account_id != "all":
        where.append("t.account_id = ?")
        params.append(account_id)
    cond = " AND ".join(where)

    open_where = ["t.win_loss = 'P'"]
    open_params: list = []
    if account_id and account_id != "all":
        open_where.append("t.account_id = ?")
        open_params.append(account_id)
    open_cond = " AND ".join(open_where)

    thb_per_usd = _get_thb_per_usd()

    # SQL expression to convert each trade's pnl_amount to base_currency
    # Uses COALESCE(a.currency,'THB') so LEFT JOIN nulls fall back to THB
    if base_currency == "USD":
        pnl_expr = f"CASE WHEN COALESCE(a.currency,'THB')='THB' THEN COALESCE(t.pnl_amount,0) / {thb_per_usd} ELSE COALESCE(t.pnl_amount,0) END"
        cost_expr = f"CASE WHEN COALESCE(a.currency,'THB')='USD' THEN COALESCE(t.amount, t.price_entry * t.volume) ELSE COALESCE(t.amount, t.price_entry * t.volume) / {thb_per_usd} END"
    else:
        pnl_expr = f"CASE WHEN COALESCE(a.currency,'THB')='USD' THEN COALESCE(t.pnl_amount,0) * {thb_per_usd} ELSE COALESCE(t.pnl_amount,0) END"
        cost_expr = f"CASE WHEN COALESCE(a.currency,'THB')='USD' THEN COALESCE(t.amount, t.price_entry * t.volume) * {thb_per_usd} ELSE COALESCE(t.amount, t.price_entry * t.volume) END"

    with get_db() as conn:
        by_sector = conn.execute(f"""
            SELECT t.sector sector, COUNT(*) cnt,
                   SUM(CASE WHEN t.win_loss='W' THEN 1 ELSE 0 END) wins,
                   SUM({pnl_expr}) pnl
            FROM trades t LEFT JOIN portfolio_accounts a ON t.account_id = a.id
            WHERE {cond} AND t.sector != ''
            GROUP BY t.sector ORDER BY pnl DESC
        """, params).fetchall()

        by_strategy = conn.execute(f"""
            SELECT t.strategy_name strategy_name, COUNT(*) cnt,
                   SUM(CASE WHEN t.win_loss='W' THEN 1 ELSE 0 END) wins,
                   SUM({pnl_expr}) pnl
            FROM trades t LEFT JOIN portfolio_accounts a ON t.account_id = a.id
            WHERE {cond} AND t.strategy_name != ''
            GROUP BY t.strategy_name ORDER BY pnl DESC
        """, params).fetchall()

        by_month = conn.execute(f"""
            SELECT substr(COALESCE(t.date_exit, t.date_entry),1,7) month,
                   COUNT(*) cnt,
                   SUM(CASE WHEN t.win_loss='W' THEN 1 ELSE 0 END) wins,
                   SUM({pnl_expr}) pnl
            FROM trades t LEFT JOIN portfolio_accounts a ON t.account_id = a.id
            WHERE {cond}
            GROUP BY substr(COALESCE(t.date_exit, t.date_entry),1,7)
            ORDER BY substr(COALESCE(t.date_exit, t.date_entry),1,7)
        """, params).fetchall()

        top_symbols = conn.execute(f"""
            SELECT t.symbol symbol, COUNT(*) cnt,
                   SUM(CASE WHEN t.win_loss='W' THEN 1 ELSE 0 END) wins,
                   SUM({pnl_expr}) pnl
            FROM trades t LEFT JOIN portfolio_accounts a ON t.account_id = a.id
            WHERE {cond}
            GROUP BY t.symbol ORDER BY pnl DESC LIMIT 15
        """, params).fetchall()

        subport_rows = conn.execute(f"""
            SELECT t.note note, t.win_loss win_loss, COALESCE(a.name, t.account_id) acc_name,
                   {pnl_expr} pnl
            FROM trades t LEFT JOIN portfolio_accounts a ON t.account_id = a.id
            WHERE {cond}
        """, params).fetchall()

        open_by_sector = conn.execute(f"""
            SELECT
                COALESCE(NULLIF(t.sector,''), 'Other') sector,
                SUM({cost_expr}) cost_base
            FROM trades t
            LEFT JOIN portfolio_accounts a ON t.account_id = a.id
            WHERE {open_cond}
            GROUP BY sector ORDER BY cost_base DESC
        """, open_params).fetchall()

        open_symbols = conn.execute(f"""
            SELECT
                COALESCE(NULLIF(t.sector,''), 'Other') sector,
                t.symbol,
                t.volume,
                {cost_expr} cost_base
            FROM trades t
            LEFT JOIN portfolio_accounts a ON t.account_id = a.id
            WHERE {open_cond}
            ORDER BY sector, cost_base DESC
        """, open_params).fetchall()

    # group symbols by sector
    from collections import defaultdict as _dd
    syms_by_sector: dict = _dd(list)
    for r in open_symbols:
        cost = round(r["cost_base"] or 0, 0)
        syms_by_sector[r["sector"]].append({
            "symbol": r["symbol"],
            "volume": r["volume"],
            "value":  cost,
        })

    # Sub-port breakdown. New trades store "AccName (subport-id) | freeform | VAT: x"
    # (see helpers.ts splitNote). Sold trades additionally get "\n[SOLD ...]"
    # appended directly (see /sell, /sell-all-lots) — so the sub-port tag is only
    # ever guaranteed to be the leading segment of the note. Match from the start.
    def _extract_subport(note: Optional[str]) -> Optional[str]:
        if not note:
            return None
        m = re.match(r"^[^(\n|]*\(([^)]+)\)", note.strip())
        return m.group(1) if m else None

    subport_agg: dict = _dd(lambda: {"cnt": 0, "wins": 0, "pnl": 0.0})
    for r in subport_rows:
        sub = _extract_subport(r["note"])
        label = f"{r['acc_name']} ({sub})" if sub else r["acc_name"]
        agg = subport_agg[label]
        agg["cnt"] += 1
        agg["wins"] += 1 if r["win_loss"] == "W" else 0
        agg["pnl"] += r["pnl"] or 0
    by_subport = sorted(
        (
            {"subport": k, "cnt": v["cnt"], "wins": v["wins"], "pnl": round(v["pnl"], 2)}
            for k, v in subport_agg.items()
        ),
        key=lambda d: -d["pnl"],
    )

    def _fmt(rows) -> list[dict]:
        result = []
        for r in rows:
            d = dict(r)
            cnt = d.get("cnt", 1) or 1
            d["win_rate"] = round(d.get("wins", 0) / cnt * 100, 1)
            result.append(d)
        return result

    return {
        "by_sector":     _fmt(by_sector),
        "by_strategy":   _fmt(by_strategy),
        "by_month":      _fmt(by_month),
        "top_symbols":   _fmt(top_symbols),
        "by_subport":    _fmt(by_subport),
        "open_by_sector": [
            {
                "sector":  r["sector"],
                "value":   round(r["cost_base"] or 0, 2),
                "symbols": syms_by_sector[r["sector"]],
            }
            for r in open_by_sector if (r["cost_base"] or 0) > 0
        ],
    }


# ── Allocation History ────────────────────────────────────────────────────────

@router.get("/analytics/allocation-history")
def get_allocation_history(
    period: str = Query("Q"),
    account_id: Optional[str] = Query(None),
):
    """
    Return cost basis (THB) deployed per sector per time period.
    Groups by date_entry so each period shows capital actually invested that period.
    period: "M" = monthly (YYYY-MM), "Q" = quarterly (YYYY-QN)
    """
    if period not in ("M", "Q"):
        raise HTTPException(status_code=400, detail="period must be M or Q")

    where_parts: list[str] = []
    params: list = []
    if account_id and account_id != "all":
        where_parts.append("t.account_id = ?")
        params.append(account_id)
    cond = f" AND {' AND '.join(where_parts)}" if where_parts else ""

    thb_per_usd = _get_thb_per_usd()

    if period == "M":
        period_expr = "substr(t.date_entry, 1, 7)"
    else:  # Q
        period_expr = (
            "substr(t.date_entry, 1, 4) || '-Q' || "
            "CASE "
            "  WHEN CAST(substr(t.date_entry, 6, 2) AS INTEGER) <= 3 THEN '1' "
            "  WHEN CAST(substr(t.date_entry, 6, 2) AS INTEGER) <= 6 THEN '2' "
            "  WHEN CAST(substr(t.date_entry, 6, 2) AS INTEGER) <= 9 THEN '3' "
            "  ELSE '4' "
            "END"
        )

    with get_db() as conn:
        rows = conn.execute(f"""
            SELECT
                {period_expr} period,
                COALESCE(NULLIF(t.sector, ''), 'Other') sector,
                SUM(
                    CASE WHEN a.currency = 'USD'
                         THEN COALESCE(t.amount, t.price_entry * t.volume) * ?
                         ELSE COALESCE(t.amount, t.price_entry * t.volume)
                    END
                ) value
            FROM trades t
            JOIN portfolio_accounts a ON t.account_id = a.id
            WHERE t.date_entry IS NOT NULL AND t.date_entry != ''{cond}
            GROUP BY period, sector
            ORDER BY period, sector
        """, [thb_per_usd] + params).fetchall()

    # pivot: {period → {sector → value}}
    from collections import defaultdict
    data: dict[str, dict[str, float]] = defaultdict(dict)
    sectors: set[str] = set()
    for r in rows:
        v = r["value"] or 0
        if v > 0:
            data[r["period"]][r["sector"]] = round(v, 0)
            sectors.add(r["sector"])

    # normalize — every period must have every sector key (0 if absent)
    # recharts stacked area requires consistent keys across all data points
    all_sectors = sorted(sectors)
    periods_out = [
        {"period": p, **{s: data[p].get(s, 0) for s in all_sectors}}
        for p in sorted(data.keys())
    ]
    return {"periods": periods_out, "sectors": all_sectors}


# ── Import from Excel ─────────────────────────────────────────────────────────

@router.post("/import/excel")
async def import_excel(file: UploadFile = File(...)):
    """
    Parse xlsx file with sheets: Finansia, Dime, InnovestX, Income&expenses.
    Idempotent: uses a stable ID based on account+symbol+date_entry+volume.
    """
    try:
        import openpyxl
    except ImportError:
        raise HTTPException(status_code=500, detail="openpyxl not installed. Run: pip install openpyxl")

    contents = await file.read()
    wb = openpyxl.load_workbook(io.BytesIO(contents), read_only=True, data_only=True)

    # Map sheet name → (account_id, currency)
    sheet_map = {
        "Finansia":  ("finansia",  "THB"),
        "Finansia ": ("finansia",  "THB"),
        "Dime":      ("dime",      "USD"),
        "InnovestX": ("innovestx", "THB"),
        "InnovestX ":("innovestx", "THB"),
    }

    all_trades: list[dict] = []
    all_cash:   list[dict] = []
    all_divs:   list[dict] = []
    now = _now()

    # ── Parse trade sheets ────────────────────────────────────────────────────
    for sheet_name, (account_id, currency) in sheet_map.items():
        if sheet_name not in wb.sheetnames:
            continue
        ws = wb[sheet_name]
        header_idx: dict[str, int] = {}

        for row_vals in ws.iter_rows(values_only=True):
            # Skip empty rows
            if not any(v is not None for v in row_vals):
                continue

            # Detect header row
            if not header_idx:
                row0 = str(row_vals[0] or "").strip().lower()
                if "date" in row0:
                    for i, h in enumerate(row_vals):
                        if h is not None:
                            header_idx[str(h).strip().lower()] = i
                continue

            def _get(*keys):
                for k in keys:
                    for hk, hi in header_idx.items():
                        if k in hk and hi < len(row_vals):
                            v = row_vals[hi]
                            if v is not None:
                                return v
                return None

            symbol = _get("stock")
            if not symbol:
                continue
            date_entry = _fmt_date(_get("date (entry)"))
            if not date_entry:
                continue

            vol = _to_float_or_zero(_get("volume"))
            price_e = _to_float_or_zero(_get("price_entry"))

            # Stable ID: hash of key fields to avoid duplicate imports
            stable_key = f"{account_id}|{str(symbol).upper()}|{date_entry}|{vol:.4f}|{price_e:.4f}"
            trade_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, stable_key))

            win_loss_raw = str(_get("win/loss") or "P").strip().upper()
            win_loss = win_loss_raw if win_loss_raw in ("W", "L", "P") else "P"

            all_trades.append({
                "id":               trade_id,
                "account_id":       account_id,
                "symbol":           str(symbol).strip().upper(),
                "sector":           str(_get("sector") or "").strip(),
                "date_entry":       date_entry,
                "date_exit":        _fmt_date(_get("date (exit)")),
                "price_entry":      price_e,
                "price_exit":       _to_float(_get("price_exit")),
                "price_stoploss":   _to_float(_get("price_stoploss")),
                "price_target":     _to_float(_get("price_target")),
                "volume":           vol,
                "amount":           _to_float(_get("amount")),
                "pnl_amount":       _to_float(_get("pnl_amount")),
                "win_loss":         win_loss,
                "pnl_percent":      _to_float(_get("pnl_percent")),
                "currency":         currency,
                "exchange_rate":    1.0,
                "strategy_name":    str(_get("strategy name", "strategy_name") or ""),
                "entry_trigger":    str(_get("entry trigger") or ""),
                "exit_trigger":     str(_get("exit trigger") or ""),
                "market_trend":     str(_get("market_trend") or ""),
                "news_sentiment":   str(_get("news_sentiment") or ""),
                "expectation_based":str(_get("expectation_based") or ""),
                "factor_based":     str(_get("factor_based") or ""),
                "fear_greed_index": str(_get("fear & greed index") or ""),
                "vix_index":        str(_get("vix index") or ""),
                "note":             str(_get("note") or ""),
                "created_at":       now,
            })

    # ── Parse Income&expenses sheet ───────────────────────────────────────────
    ie_names = [n for n in wb.sheetnames if "income" in n.lower() or "expense" in n.lower()]
    if ie_names:
        ws_ie = wb[ie_names[0]]
        header_found = False
        for row_vals in ws_ie.iter_rows(values_only=True):
            if not any(v is not None for v in row_vals):
                continue
            # Detect header: contains วัน/เดือน/ปี or date-like Thai text
            if not header_found:
                r0 = str(row_vals[0] or "").strip()
                if "วัน" in r0 or "date" in r0.lower():
                    header_found = True
                continue

            # Cash section: cols 0–4
            date_val    = row_vals[0] if len(row_vals) > 0 else None
            income_val  = row_vals[1] if len(row_vals) > 1 else None
            invest_val  = row_vals[2] if len(row_vals) > 2 else None
            account_val = row_vals[3] if len(row_vals) > 3 else None
            fx_val      = row_vals[4] if len(row_vals) > 4 else None

            date_str = _fmt_date(date_val)
            if date_str and (income_val is not None or invest_val is not None):
                acc_id = _map_account_name(str(account_val or ""))
                income   = _to_float_or_zero(income_val)
                invested = _to_float_or_zero(invest_val)
                if income != 0 or invested != 0:
                    stable_key = f"cash|{acc_id}|{date_str}|{income:.2f}|{invested:.2f}"
                    all_cash.append({
                        "id":           str(uuid.uuid5(uuid.NAMESPACE_DNS, stable_key)),
                        "account_id":   acc_id,
                        "date":         date_str,
                        "income":       income,
                        "investment":   invested,
                        "exchange_rate": _to_float_or_zero(fx_val) or 1.0,
                        "note":         "",
                        "created_at":   now,
                    })

            # Dividend section: cols 6–10 (ex_date, pay_date, amount/unit, net_received, account)
            ex_date_val  = row_vals[6]  if len(row_vals) > 6  else None
            pay_date_val = row_vals[7]  if len(row_vals) > 7  else None
            amt_unit_val = row_vals[8]  if len(row_vals) > 8  else None
            net_recv_val = row_vals[9]  if len(row_vals) > 9  else None
            div_acc_val  = row_vals[10] if len(row_vals) > 10 else None
            asset_val    = row_vals[5]  if len(row_vals) > 5  else None

            ex_str  = _fmt_date(ex_date_val)
            pay_str = _fmt_date(pay_date_val)
            if ex_str and net_recv_val is not None:
                net_recv = _to_float_or_zero(net_recv_val)
                if net_recv != 0:
                    div_acc = _map_account_name(str(div_acc_val or ""))
                    asset   = str(asset_val or "").strip()
                    stable_key = f"div|{div_acc}|{asset}|{ex_str}|{net_recv:.4f}"
                    all_divs.append({
                        "id":               str(uuid.uuid5(uuid.NAMESPACE_DNS, stable_key)),
                        "account_id":       div_acc,
                        "asset":            asset,
                        "ex_date":          ex_str,
                        "pay_date":         pay_str,
                        "amount_per_unit":  _to_float_or_zero(amt_unit_val),
                        "total_received":   net_recv,
                        "reinvested_amount": 0,
                        "reinvest_asset":   "",
                        "reinvest_price":   0,
                        "reinvest_units":   0,
                        "created_at":       now,
                    })

    # ── Upsert into DB ────────────────────────────────────────────────────────
    inserted = {"trades": 0, "cash": 0, "dividends": 0}
    with get_db() as conn:
        for t in all_trades:
            existing = conn.execute("SELECT 1 FROM trades WHERE id = ?", (t["id"],)).fetchone()
            if not existing:
                conn.execute("""
                    INSERT INTO trades (id, account_id, symbol, sector, date_entry, date_exit,
                        price_entry, price_exit, price_stoploss, price_target, volume, amount,
                        pnl_amount, win_loss, pnl_percent, currency, exchange_rate,
                        strategy_name, entry_trigger, exit_trigger, market_trend,
                        news_sentiment, expectation_based, factor_based,
                        fear_greed_index, vix_index, note, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (t["id"], t["account_id"], t["symbol"], t["sector"],
                      t["date_entry"], t["date_exit"],
                      t["price_entry"], t["price_exit"], t["price_stoploss"], t["price_target"],
                      t["volume"], t["amount"], t["pnl_amount"], t["win_loss"],
                      t["pnl_percent"], t["currency"], t["exchange_rate"],
                      t["strategy_name"], t["entry_trigger"], t["exit_trigger"],
                      t["market_trend"], t["news_sentiment"], t["expectation_based"],
                      t["factor_based"], t["fear_greed_index"], t["vix_index"],
                      t["note"], t["created_at"]))
                inserted["trades"] += 1

        for c in all_cash:
            cur = conn.execute("""
                INSERT OR IGNORE INTO cash_ledger
                    (id, account_id, date, income, investment, exchange_rate, note, created_at)
                VALUES (?,?,?,?,?,?,?,?)
            """, (c["id"], c["account_id"], c["date"], c["income"], c["investment"],
                  c["exchange_rate"], c["note"], c["created_at"]))
            inserted["cash"] += cur.rowcount

        for d in all_divs:
            cur = conn.execute("""
                INSERT OR IGNORE INTO dividends
                    (id, account_id, asset, ex_date, pay_date, amount_per_unit,
                     total_received, reinvested_amount, reinvest_asset,
                     reinvest_price, reinvest_units, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            """, (d["id"], d["account_id"], d["asset"], d["ex_date"], d["pay_date"],
                  d["amount_per_unit"], d["total_received"], d["reinvested_amount"],
                  d["reinvest_asset"], d["reinvest_price"], d["reinvest_units"],
                  d["created_at"]))
            inserted["dividends"] += cur.rowcount

    return {
        "ok": True,
        "inserted": inserted,
        "parsed": {"trades": len(all_trades), "cash": len(all_cash), "dividends": len(all_divs)},
    }
