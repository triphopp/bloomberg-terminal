"""Canonical instrument-currency and FX helpers for portfolio features.

``trades.currency`` is the authoritative native quote currency.  Symbol/market
inference exists only for legacy migration and NULL-row fallback.  FX rates use
the conventional ``base -> quote`` meaning (for example USD/THB = 32.50).
"""
from __future__ import annotations

import logging
import threading
from typing import Mapping, Optional

from cache import TTLCache
from db import get_db
from sources import market_data

logger = logging.getLogger("portfolio.currency")

SUPPORTED_REPORT_CURRENCIES = {"THB", "USD"}
USD_EQUIVALENTS = {"USD", "USDT"}

_live_fx_cache: TTLCache = TTLCache(ttl=120, maxsize=8)
_dated_fx_cache: TTLCache = TTLCache(ttl=3600, maxsize=2048)
_history_lock = threading.Lock()
_history_attempted = False


def normalize_currency(value: object, default: Optional[str] = None) -> Optional[str]:
    ccy = str(value or "").strip().upper()
    if ccy in {"THB", "USD", "USDT"}:
        return ccy
    return default


def report_currency(value: object) -> str:
    ccy = str(value or "THB").strip().upper()
    return ccy if ccy in SUPPORTED_REPORT_CURRENCIES else "THB"


def infer_instrument_currency(
    market: object = None,
    resolved_symbol: object = None,
    symbol: object = None,
    fallback: object = None,
) -> Optional[str]:
    """Infer legacy currency only from deterministic market/symbol evidence."""
    mk = str(market or "").strip().upper()
    rs = str(resolved_symbol or symbol or "").strip().upper()

    if mk == "TH":
        return "THB"
    if mk == "US":
        return "USD"
    if rs.endswith(".BK"):
        return "THB"
    if "-" in rs:
        quote = normalize_currency(rs.rsplit("-", 1)[-1])
        if quote:
            return quote
    return normalize_currency(fallback)


def trade_currency(row: Mapping[str, object]) -> str:
    """Return stored instrument currency; infer only when the column is absent."""
    stored = normalize_currency(row.get("currency"))
    if stored:
        return stored
    return infer_instrument_currency(
        row.get("market"),
        row.get("resolved_symbol"),
        row.get("symbol"),
        row.get("acc_currency"),
    ) or "THB"


def _rate_from_snapshot(snapshot: object) -> Optional[float]:
    if snapshot is None:
        return None
    if isinstance(snapshot, dict):
        raw = snapshot.get("last_price") or snapshot.get("regularMarketPrice")
    else:
        raw = getattr(snapshot, "last_price", None) or getattr(snapshot, "regular_market_price", None)
    try:
        value = float(raw)
        return value if value > 0 else None
    except (TypeError, ValueError):
        return None


def live_usd_thb() -> float:
    """Live THB per USD, with the existing 33.5 fail-soft fallback."""
    cached = _live_fx_cache.get("USD/THB")
    if cached is not None:
        return float(cached)

    rate: Optional[float] = None
    try:
        rate = _rate_from_snapshot(market_data.get_fast_info("THB=X"))
    except Exception:
        logger.warning("live USD/THB fetch via THB=X failed", exc_info=True)

    if not rate:
        try:
            inverse = _rate_from_snapshot(market_data.get_fast_info("THBUSD=X"))
            rate = (1.0 / inverse) if inverse else None
        except Exception:
            logger.warning("live USD/THB inverse fetch failed", exc_info=True)

    result = round(rate, 6) if rate else 33.5
    _live_fx_cache.set("USD/THB", result)
    return result


def _upsert_fx_rows(conn, rows: list[tuple[str, str, str, float, str]]) -> int:
    if not rows:
        return 0
    before = conn.total_changes
    conn.executemany(
        """
        INSERT INTO fx_rates(date, base, quote, rate, source, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(date, base, quote) DO UPDATE SET
            rate = excluded.rate,
            source = excluded.source,
            updated_at = datetime('now')
        """,
        rows,
    )
    return conn.total_changes - before


def backfill_fx_rates(period: str = "10y", conn=None) -> int:
    """Fetch daily USD/THB history through the provider registry and UPSERT it."""
    frame = market_data.get_history("THB=X", period=period, interval="1d")
    df = frame.df
    if df is None or df.empty or "Close" not in df.columns:
        return 0

    rows: list[tuple[str, str, str, float, str]] = []
    for idx, raw in df["Close"].items():
        try:
            rate = float(raw)
        except (TypeError, ValueError):
            continue
        if rate <= 0:
            continue
        date = idx.strftime("%Y-%m-%d") if hasattr(idx, "strftime") else str(idx)[:10]
        rows.append((date, "USD", "THB", rate, "market_data:THB=X"))
        rows.append((date, "THB", "USD", 1.0 / rate, "market_data:THB=X"))

    if conn is not None:
        return _upsert_fx_rows(conn, rows)
    with get_db() as owned:
        return _upsert_fx_rows(owned, rows)


def _lookup_dated_rate(conn, from_ccy: str, to_ccy: str, date: str) -> Optional[float]:
    row = conn.execute(
        """
        SELECT rate FROM fx_rates
        WHERE base = ? AND quote = ? AND date <= ?
        ORDER BY date DESC LIMIT 1
        """,
        (from_ccy, to_ccy, str(date)[:10]),
    ).fetchone()
    if not row:
        return None
    try:
        rate = float(row["rate"])
        return rate if rate > 0 else None
    except (TypeError, ValueError):
        return None


def _ensure_history_once(conn=None) -> None:
    global _history_attempted
    if _history_attempted:
        return
    with _history_lock:
        if _history_attempted:
            return
        try:
            backfill_fx_rates(conn=conn)
        except Exception:
            logger.warning("historical FX backfill failed", exc_info=True)
        finally:
            _history_attempted = True


def fx_rate(from_ccy: object, to_ccy: object, date: Optional[str] = None, conn=None) -> float:
    """Return quote units per one base unit.

    Dated lookups use the requested day or the nearest prior trading day.  If a
    local history row is missing, history is fetched once lazily; live FX is the
    final fail-soft fallback.
    """
    src = normalize_currency(from_ccy, "THB") or "THB"
    dst = normalize_currency(to_ccy, "THB") or "THB"
    if src == dst or (src in USD_EQUIVALENTS and dst in USD_EQUIVALENTS):
        return 1.0

    src_db = "USD" if src in USD_EQUIVALENTS else src
    dst_db = "USD" if dst in USD_EQUIVALENTS else dst
    if {src_db, dst_db} != {"USD", "THB"}:
        raise ValueError(f"Unsupported FX pair: {src}/{dst}")

    if date:
        key = f"{src_db}/{dst_db}/{str(date)[:10]}"
        cached = _dated_fx_cache.get(key)
        if cached is not None:
            return float(cached)

        if conn is not None:
            rate = _lookup_dated_rate(conn, src_db, dst_db, str(date))
            if rate is None:
                _ensure_history_once(conn)
                rate = _lookup_dated_rate(conn, src_db, dst_db, str(date))
        else:
            with get_db() as owned:
                rate = _lookup_dated_rate(owned, src_db, dst_db, str(date))
            if rate is None:
                _ensure_history_once()
                with get_db() as owned:
                    rate = _lookup_dated_rate(owned, src_db, dst_db, str(date))
        if rate is not None:
            _dated_fx_cache.set(key, rate)
            return rate

    usd_thb = live_usd_thb()
    return usd_thb if (src_db, dst_db) == ("USD", "THB") else 1.0 / usd_thb


def convert_amount(
    amount: float,
    from_ccy: object,
    to_ccy: object,
    *,
    date: Optional[str] = None,
    stored_thb_rate: Optional[float] = None,
    conn=None,
) -> float:
    src = normalize_currency(from_ccy, "THB") or "THB"
    dst = normalize_currency(to_ccy, "THB") or "THB"
    if src == dst or (src in USD_EQUIVALENTS and dst in USD_EQUIVALENTS):
        return float(amount)

    # Existing trades may carry an exact THB-per-native rate.  It is valid only
    # for the native-USD -> THB direction; reciprocal use is safe for THB -> USD.
    try:
        stored = float(stored_thb_rate or 0)
    except (TypeError, ValueError):
        stored = 0.0
    if stored > 1 and {src, dst} <= {"THB", "USD"}:
        return float(amount) * stored if src == "USD" else float(amount) / stored

    return float(amount) * fx_rate(src, dst, date=date, conn=conn)


def trade_value_in_report(
    row: Mapping[str, object],
    amount: float,
    report_ccy: object,
    *,
    when: str,
    conn=None,
) -> float:
    ccy = trade_currency(row)
    if when == "entry":
        date = str(row.get("date_entry") or "")[:10] or None
        stored = row.get("exchange_rate")
    elif when == "exit":
        date = str(row.get("date_exit") or "")[:10] or None
        stored = row.get("exit_exchange_rate")
    else:  # live mark-to-market
        date = None
        stored = None
    return convert_amount(
        amount,
        ccy,
        report_currency(report_ccy),
        date=date,
        stored_thb_rate=stored,
        conn=conn,
    )


def realized_pnl_in_report(
    row: Mapping[str, object],
    report_ccy: object,
    *,
    conn=None,
) -> float:
    """Convert realized trading P&L at the exit-date FX rate.

    ``pnl_amount`` is already the instrument's native trading profit/loss.
    Applying entry/exit FX to the full principal would add currency movement
    on invested capital and materially overstate the portfolio's REALIZED P&L.
    Principal FX attribution belongs in a separate metric.
    """
    pnl_native = float(row.get("pnl_amount") or 0)
    return trade_value_in_report(
        row, pnl_native, report_ccy, when="exit", conn=conn
    )


def realized_economic_pnl_in_report(
    row: Mapping[str, object],
    report_ccy: object,
    *,
    conn=None,
) -> float:
    """Return closed-trade P&L including principal FX attribution.

    This is the two-leg base-currency view:

    ``(entry cost + native P&L) at exit FX - entry cost at entry FX``.

    It is useful as an economic attribution metric, but it is deliberately
    separate from broker-style REALIZED P&L because it includes FX movement on
    the original principal.
    """
    cost_native = float(row.get("amount") or 0)
    if not cost_native:
        try:
            cost_native = float(row.get("price_entry") or 0) * float(row.get("volume") or 0)
        except (TypeError, ValueError):
            cost_native = 0.0

    pnl_native = float(row.get("pnl_amount") or 0)
    exit_value_native = cost_native + pnl_native
    exit_value = trade_value_in_report(
        row, exit_value_native, report_ccy, when="exit", conn=conn
    )
    entry_value = trade_value_in_report(
        row, cost_native, report_ccy, when="entry", conn=conn
    )
    return exit_value - entry_value


def backfill_currency_columns(conn) -> dict[str, int]:
    """Idempotently correct deterministic trade currencies and seed dividends."""
    trade_updates = 0
    rows = conn.execute(
        """
        SELECT t.id, t.currency, t.market, t.resolved_symbol, t.symbol,
               a.currency acc_currency
        FROM trades t LEFT JOIN portfolio_accounts a ON a.id = t.account_id
        """
    ).fetchall()
    for raw in rows:
        row = dict(raw)
        inferred = infer_instrument_currency(
            row.get("market"), row.get("resolved_symbol"), row.get("symbol"), None
        )
        if inferred and normalize_currency(row.get("currency")) != inferred:
            conn.execute("UPDATE trades SET currency = ? WHERE id = ?", (inferred, row["id"]))
            trade_updates += 1

    dividend_updates = 0
    divs = conn.execute(
        """
        SELECT d.id, d.currency, d.account_id, d.asset, a.currency acc_currency
        FROM dividends d LEFT JOIN portfolio_accounts a ON a.id = d.account_id
        """
    ).fetchall()
    for raw in divs:
        row = dict(raw)
        if normalize_currency(row.get("currency")):
            continue
        trade = conn.execute(
            """
            SELECT currency, market, resolved_symbol, symbol
            FROM trades
            WHERE account_id = ? AND upper(symbol) = upper(?)
            ORDER BY date_entry DESC LIMIT 1
            """,
            (row["account_id"], row["asset"]),
        ).fetchone()
        if trade:
            ccy = trade_currency({**dict(trade), "acc_currency": row.get("acc_currency")})
        else:
            ccy = normalize_currency(row.get("acc_currency"), "THB") or "THB"
        conn.execute("UPDATE dividends SET currency = ? WHERE id = ?", (ccy, row["id"]))
        dividend_updates += 1

    return {"trades": trade_updates, "dividends": dividend_updates}
