"""
Stooq QuoteProvider — keyless free fallback for the live-quote path.

Stooq exposes plain CSV endpoints (no API key, no SDK):
  - quote:   https://stooq.com/q/l/?s=<syms>&f=sd2t2ohlcv&h&e=csv
  - history: https://stooq.com/q/d/l/?s=<sym>&i=d

Coverage is narrower than yfinance (good for US equities + major indices;
weak for crypto / some non-US exchanges) and data is end-of-day / delayed.
That is acceptable: this provider exists as a *safety net* for when the
primary (yfinance) is unreachable, not as a feature-parity replacement.

Symbol mapping is best-effort.  Unsupported symbols return empty snapshots
rather than raising, so the registry's failover stays predictable.
"""
import csv
import io
from typing import Optional

import pandas as pd
import requests

from ..models import BatchPriceResult, BatchQuoteResult, OHLCVFrame, QuoteSnapshot
from ..quote_provider import QuoteProvider

_QUOTE_URL = "https://stooq.com/q/l/"
_HIST_URL = "https://stooq.com/q/d/l/"
_TIMEOUT = 6  # seconds — keep the failover probe snappy


def _to_stooq(symbol: str) -> str:
    """Map an app/yfinance symbol to Stooq's symbol convention (best-effort)."""
    s = symbol.strip().lower()
    if not s:
        return s
    if s.startswith("^"):          # index, e.g. ^spx, ^dji
        return s
    if "-" in s:                   # crypto/fx like btc-usd → btcusd (often unsupported)
        return s.replace("-", "")
    if "." in s:                   # already has an exchange suffix — pass through
        return s
    return f"{s}.us"               # bare ticker → assume US listing


def _num(v) -> Optional[float]:
    try:
        if v is None or str(v).strip().upper() in ("", "N/D", "NAN"):
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


class StooqQuoteProvider(QuoteProvider):
    name = "stooq"
    label = "Stooq (fallback)"

    def healthy(self) -> bool:
        try:
            r = requests.get(
                _QUOTE_URL,
                params={"s": "aapl.us", "f": "sd2t2ohlcv", "h": "", "e": "csv"},
                timeout=_TIMEOUT,
            )
            if r.status_code != 200:
                return False
            rows = list(csv.DictReader(io.StringIO(r.text)))
            return bool(rows) and _num(rows[0].get("Close")) is not None
        except Exception:
            return False

    def get_quotes(self, symbols: list[str]) -> BatchQuoteResult:
        if not symbols:
            return BatchQuoteResult(quotes={})
        # Stooq → app symbol reverse map so we can key results back correctly.
        rev = {_to_stooq(s): s for s in symbols}
        out: dict[str, QuoteSnapshot] = {s: QuoteSnapshot(symbol=s) for s in symbols}
        try:
            r = requests.get(
                _QUOTE_URL,
                params={"s": ",".join(rev.keys()), "f": "sd2t2ohlcv", "h": "", "e": "csv"},
                timeout=_TIMEOUT,
            )
            if r.status_code != 200:
                return BatchQuoteResult(quotes=out)
            for row in csv.DictReader(io.StringIO(r.text)):
                stq = str(row.get("Symbol", "")).strip().lower()
                app_sym = rev.get(stq)
                if not app_sym:
                    continue
                close = _num(row.get("Close"))
                out[app_sym] = QuoteSnapshot(
                    symbol=app_sym,
                    last_price=close,
                    previous_close=_num(row.get("Open")),  # Stooq quote has no prev-close; Open is closest free proxy
                    day_high=_num(row.get("High")),
                    day_low=_num(row.get("Low")),
                    regular_market_volume=int(_num(row.get("Volume")) or 0) or None,
                    regular_market_price=close,
                )
        except Exception:
            pass
        return BatchQuoteResult(quotes=out)

    def get_quote(self, symbol: str) -> QuoteSnapshot:
        return self.get_quotes([symbol]).quotes.get(symbol, QuoteSnapshot(symbol=symbol))

    def get_history(self, symbol: str, period: str = "1mo",
                    interval: str = "1d") -> OHLCVFrame:
        empty = OHLCVFrame(symbol=symbol, df=pd.DataFrame())
        try:
            r = requests.get(
                _HIST_URL,
                params={"s": _to_stooq(symbol), "i": "d"},
                timeout=_TIMEOUT,
            )
            if r.status_code != 200 or not r.text.strip().lower().startswith("date"):
                return empty
            df = pd.read_csv(io.StringIO(r.text))
            if df.empty or "Date" not in df.columns:
                return empty
            df["Date"] = pd.to_datetime(df["Date"])
            df = df.set_index("Date")
            wanted = [c for c in ["Open", "High", "Low", "Close", "Volume"] if c in df.columns]
            return OHLCVFrame(symbol=symbol, df=df[wanted].copy())
        except Exception:
            return empty

    def download(self, symbols: list[str], period: str = "1y",
                 interval: str = "1d") -> BatchPriceResult:
        quotes = self.get_quotes(symbols).quotes
        return BatchPriceResult(
            prices={s: (q.last_price if q else None) for s, q in quotes.items()}
        )
