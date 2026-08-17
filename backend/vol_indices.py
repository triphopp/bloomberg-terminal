"""
Volatility index loader — CBOE daily-price CSVs.

Why not yfinance: as of 2026-08 Yahoo's feed for the CBOE term-structure family
(^VIX9D, ^VIX3M, ^VIX6M, ^VXD) stopped updating on 2026-07-17 while ^VIX kept
going. Code that did `series.dropna().iloc[-1]` therefore compared a month-old
VIX9D print against a current VIX and reported a term-structure inversion that
did not exist. CBOE publishes the same series itself, free and keyless, and it
is current — so that is the source of record here.

Every load carries freshness metadata. A stale series is never silently
forward-filled into a comparison: callers get `ok=False` for it and are expected
to report the signal as *unknown* rather than *off*.

    from vol_indices import load_vol_indices
    frame = load_vol_indices()
    frame.value("VIX")        # latest close, or None when unusable
    frame.zscore("OVX", 63)   # rolling z of the latest print
    frame.health              # per-index freshness for the API payload
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from datetime import datetime

import numpy as np
import pandas as pd
import requests

from cache import TTLCache

_CBOE_URL = "https://cdn.cboe.com/api/global/us_indices/daily_prices/{name}_History.csv"

# Yahoo tickers, used only if CBOE is unreachable. Deliberately incomplete:
# the term-structure names are the ones Yahoo gets wrong, so a fallback that
# served them would reintroduce the exact bug this module exists to fix.
_YF_FALLBACK = {"VIX": "^VIX", "VVIX": "^VVIX", "OVX": "^OVX", "GVZ": "^GVZ", "VXN": "^VXN"}

INDEX_NAMES = ("VIX", "VIX9D", "VIX3M", "VIX6M", "VVIX", "SKEW", "OVX", "GVZ", "VXN")

#: Series older than this many calendar days relative to the reference index
#: (VIX) is treated as unusable. Three days covers a normal weekend gap plus a
#: holiday; the 28-day gap that caused the original bug is far outside it.
MAX_STALE_DAYS = 4

#: How much history to keep for z-scores and percentiles.
_HISTORY_YEARS = 5

_cache = TTLCache(ttl=1800)  # 30 min — these series print once a day


def _parse_cboe_csv(text: str, name: str) -> pd.Series:
    """CBOE CSVs are either DATE,OPEN,HIGH,LOW,CLOSE or DATE,<NAME>.

    Both put the close last, so take the final column either way rather than
    guessing at header names that differ per index."""
    df = pd.read_csv(io.StringIO(text))
    if df.empty or df.shape[1] < 2:
        return pd.Series(dtype=float, name=name)
    dates = pd.to_datetime(df.iloc[:, 0], errors="coerce")
    values = pd.to_numeric(df.iloc[:, -1], errors="coerce")
    s = pd.Series(values.values, index=dates, name=name).dropna()
    s = s[~s.index.isna()].sort_index()
    cutoff = pd.Timestamp.now().normalize() - pd.DateOffset(years=_HISTORY_YEARS)
    return s[s.index >= cutoff]


def _fetch_cboe(name: str) -> pd.Series:
    r = requests.get(_CBOE_URL.format(name=name), timeout=20)
    r.raise_for_status()
    return _parse_cboe_csv(r.text, name)


def _fetch_yf(name: str) -> pd.Series:
    ticker = _YF_FALLBACK.get(name)
    if not ticker:
        return pd.Series(dtype=float, name=name)
    import yfinance as yf

    df = yf.download(ticker, period="2y", auto_adjust=True, progress=False)
    if df is None or df.empty:
        return pd.Series(dtype=float, name=name)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    return df["Close"].dropna().rename(name)


def _load_one(name: str) -> tuple[pd.Series, str]:
    """Returns (series, source). Empty series means the index is unavailable."""

    def compute() -> tuple[pd.Series, str]:
        try:
            s = _fetch_cboe(name)
            if not s.empty:
                return s, "cboe"
        except Exception as exc:  # network / parse / HTTP
            print(f"[vol_indices] CBOE {name} failed: {exc}")
        try:
            s = _fetch_yf(name)
            if not s.empty:
                return s, "yfinance"
        except Exception as exc:
            print(f"[vol_indices] yfinance {name} failed: {exc}")
        return pd.Series(dtype=float, name=name), "none"

    return _cache.get_or_set(f"idx:{name}", compute)


@dataclass
class IndexHealth:
    name: str
    ok: bool
    source: str
    last_date: str | None
    stale_days: int | None
    reason: str | None = None

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "ok": self.ok,
            "source": self.source,
            "last_date": self.last_date,
            "stale_days": self.stale_days,
            "reason": self.reason,
        }


@dataclass
class VolFrame:
    """Loaded volatility indices plus their freshness verdicts.

    Accessors return None for any index that failed the freshness check, so a
    caller cannot accidentally read a stale print.
    """

    series: dict[str, pd.Series] = field(default_factory=dict)
    health: dict[str, IndexHealth] = field(default_factory=dict)
    reference_date: str | None = None

    def usable(self, name: str) -> bool:
        h = self.health.get(name)
        return bool(h and h.ok)

    def get(self, name: str) -> pd.Series | None:
        if not self.usable(name):
            return None
        return self.series.get(name)

    def value(self, name: str) -> float | None:
        s = self.get(name)
        if s is None or s.empty:
            return None
        return round(float(s.iloc[-1]), 2)

    def change_1d(self, name: str) -> float | None:
        s = self.get(name)
        if s is None or len(s) < 2:
            return None
        return round(float(s.iloc[-1] - s.iloc[-2]), 2)

    def zscore(self, name: str, window: int = 63) -> float | None:
        s = self.get(name)
        if s is None or len(s) < window:
            return None
        tail = s.tail(window)
        sd = float(tail.std())
        if sd <= 0:
            return None
        return round((float(s.iloc[-1]) - float(tail.mean())) / sd, 2)

    def percentile(self, name: str, window: int = 252) -> float | None:
        s = self.get(name)
        if s is None or len(s) < 20:
            return None
        tail = s.tail(window)
        return round(float((tail <= float(s.iloc[-1])).mean() * 100), 1)

    def series_zscore(self, name: str, window: int = 63) -> pd.Series | None:
        """Full rolling z-score series — for history reconstruction."""
        s = self.get(name)
        if s is None or len(s) < window:
            return None
        mu = s.rolling(window, min_periods=window).mean()
        sd = s.rolling(window, min_periods=window).std()
        return (s - mu) / sd.replace(0, np.nan)

    def health_payload(self) -> dict:
        entries = [h.as_dict() for h in self.health.values()]
        degraded = [h["name"] for h in entries if not h["ok"]]
        return {
            "reference_date": self.reference_date,
            "indices": entries,
            "degraded": degraded,
            "ok": not degraded,
        }


def load_vol_indices(names: tuple[str, ...] = INDEX_NAMES) -> VolFrame:
    """Load every requested index and mark each fresh-or-not against VIX.

    VIX is the reference: it is the most reliably published of the set, so
    "current" means "as current as VIX". An index that lags VIX by more than
    MAX_STALE_DAYS is marked unusable rather than dropped, so the API can say
    *why* a signal is unknown.
    """
    series: dict[str, pd.Series] = {}
    sources: dict[str, str] = {}
    for name in names:
        s, source = _load_one(name)
        series[name] = s
        sources[name] = source

    ref = series.get("VIX")
    ref_last: pd.Timestamp | None = None
    if ref is not None and not ref.empty:
        ref_last = ref.index[-1]
    elif any(not s.empty for s in series.values()):
        # No VIX at all — fall back to the most recent bar anywhere so the
        # other indices can still be judged relative to each other.
        ref_last = max(s.index[-1] for s in series.values() if not s.empty)

    health: dict[str, IndexHealth] = {}
    for name in names:
        s = series[name]
        if s.empty:
            health[name] = IndexHealth(name, False, sources[name], None, None, "no data")
            continue
        last = s.index[-1]
        stale = int((ref_last - last).days) if ref_last is not None else 0
        if stale > MAX_STALE_DAYS:
            health[name] = IndexHealth(
                name, False, sources[name], last.strftime("%Y-%m-%d"), stale,
                f"stale {stale}d behind VIX",
            )
        else:
            health[name] = IndexHealth(
                name, True, sources[name], last.strftime("%Y-%m-%d"), stale, None
            )

    return VolFrame(
        series=series,
        health=health,
        reference_date=ref_last.strftime("%Y-%m-%d") if ref_last is not None else None,
    )


def clear_cache() -> None:
    """Test hook — drops every cached series."""
    _cache.clear()


if __name__ == "__main__":  # manual smoke check
    frame = load_vol_indices()
    print("reference:", frame.reference_date, datetime.now().isoformat(timespec="seconds"))
    for name in INDEX_NAMES:
        h = frame.health[name]
        print(
            f"{name:6} ok={str(h.ok):5} src={h.source:8} last={h.last_date} "
            f"stale={h.stale_days} val={frame.value(name)} z63={frame.zscore(name)} "
            f"pctile={frame.percentile(name)}"
        )
