# API Response Shapes

> Read this before opening any router file. Covers key response shapes so you don't need to read source.
> **See also:** [api-endpoints.md](api-endpoints.md) — endpoint docs + params | [frontend-structure.md](frontend-structure.md) — full TS interface list per file | [architecture.md](architecture.md) — analytics folder + backend structure | [gotchas.md](gotchas.md) — "don't change response shape" rules

---

## Market Data (`GET /api/market-data`)
```json
{
  "americas": [{ "symbol": "SPY", "name": "S&P 500", "price": 500.0, "change": 1.2, "changePercent": 0.24, "volume": 50000000 }],
  "emea": [...],
  "asia": [...]
}
```

## Stock Quote (`GET /api/stock/quote/{symbol}`)
```json
{
  "symbol": "AAPL", "name": "Apple Inc.", "price": 190.0,
  "change": 1.5, "changePercent": 0.79,
  "open": 188.0, "high": 191.0, "low": 187.5, "previousClose": 188.5,
  "volume": 60000000, "marketCap": 2900000000000,
  "pe": 28.5, "eps": 6.67, "dividend": 0.96, "beta": 1.21,
  "52weekHigh": 200.0, "52weekLow": 150.0
}
```

## Stock History (`GET /api/stock/history/{symbol}?period=3m`)
```json
{
  "symbol": "AAPL", "period": "3m",
  "data": [{ "date": "2026-03-01", "open": 180.0, "high": 185.0, "low": 179.0, "close": 184.0, "volume": 55000000 }]
}
```

## Stock P/E History (`GET /api/stock/pe-history/{symbol}`)
```json
{
  "history": [{ "time": "2026-06-29", "pe": 28.97, "eps": 3.67, "close": 106.32 }],
  "stats": { "current": 28.97, "min": 23.65, "max": 788.9, "median": 96.52,
             "p10": 58.27, "p90": 133.76, "currentPct": 2.3 },
  "earnings": [{ "date": "2026-04-22", "reportedEPS": 0.97, "epsEstimate": 0.97, "surprise": 0.39 }]
}
```
- `pe` = weekly close ÷ TTM (rolling 4Q) Reported EPS; `null` เมื่อ TTM EPS ≤ 0 (gap ในเส้น)
- `stats.currentPct` = percentile rank ของ P/E ล่าสุดในประวัติตัวเอง (0–100) → ใช้ label CHEAP/FAIR/EXPENSIVE
- EPS = adjusted/street (Yahoo) ไม่ใช่ GAAP → absolute P/E ต่ำกว่า TrendSpider, trend เหมือน
- `PEPane.tsx` consume shape นี้; frontend clip Y domain กัน early-stage spike (max 788x)

## Options Chain (`GET /api/options?symbol=AAPL&expiry=2026-07-18`)
```json
{
  "symbol": "AAPL", "expiry": "2026-07-18",
  "freshness": { "source": "yahoo_finance", "delay_minutes": 15, "is_realtime": false },
  "calls": [{ "strike": 190.0, "bid": 5.0, "ask": 5.2, "last": 5.1, "volume": 1200, "openInterest": 8000, "impliedVol": 0.28, "delta": 0.52 }],
  "puts": [...]
}
```

## Options Greeks (`GET /api/options/positions/{id}/greeks`)
```json
{
  "bs": { "delta": 0.52, "gamma": 0.04, "theta": -0.08, "vega": 0.15, "rho": 0.06 },
  "adj": { "delta": 0.51, "gamma": 0.04, "theta": -0.09, "vega": 0.15, "rho": 0.06 },
  "moments": { "skew": -0.4, "kurt": 1.2 },
  "freshness": { "source": "yahoo_finance", "delay_minutes": 15, "is_realtime": false }
}
```

## Portfolio Open Positions (`GET /api/v2/portfolio/open-positions`)
```json
{
  "thb_per_usd": 32.5,
  "positions": [{
    "symbol": "BH", "resolved_symbol": "BH.BK", "market": "TH",
    "account_id": "dime", "acc_currency": "USD",
    "currency": "THB", "pos_currency": "THB",
    "price_entry": 183.0, "volume": 200.0, "current_price": 185.0,
    "unrealized_pnl": 400.0, "unrealized_pct": 1.09,
    "unrealized_pnl_thb": 400.0, "unrealized_pnl_base": 400.0,
    "cost_basis_base": 36600.0, "market_value_base": 37000.0,
    "day_pnl": 200.0, "day_pnl_base": 200.0
  }]
}
```
`currency`/`pos_currency` = native instrument currency (authoritative). `acc_currency` is only the account's default report currency. Every `*_base` field is already normalized to the requested `base_currency`; the frontend must not convert it again.

## Portfolio Trades / Dividends — additive report fields

- `GET /api/v2/portfolio/trades?base_currency=THB|USD` adds `amount_base`, `price_entry_base`, `price_exit_base`, `pnl_base`. Closed `pnl_base` = native `pnl_amount` converted at exit-date FX; principal FX gain/loss is intentionally excluded from REALIZED P&L.
- `GET /api/v2/portfolio/dividends?base_currency=THB|USD` adds `amount_per_unit_base`, `total_received_base`, `reinvested_amount_base`, using pay-date (or ex-date) FX.
- `trades.exchange_rate` / `exit_exchange_rate` mean **THB per one native-currency unit**. Existing values such as `32.65` are transaction evidence and must not be overwritten.

## Portfolio Summary / Analytics — realized P&L semantics

- `GET /api/v2/portfolio/summary?base_currency=THB|USD` keeps `total_pnl_base` / `pnl_base` as broker-style realized trading P&L: `native pnl_amount × exit-date FX`.
- Summary also adds `total_economic_pnl_base`, `pnl_economic_base`, and YTD economic fields. These are FX-inclusive economic attribution: `(entry cost + native P&L) × exit FX − entry cost × entry FX`.
- `GET /api/v2/portfolio/analytics?base_currency=THB|USD` monthly/sector/strategy/symbol rows add `economic_pnl` next to `pnl`.
- Economic fields use stored trade FX when present; otherwise nearest-prior daily market FX. Treat them as an attribution estimate, not broker-exact realized P&L.
- `analytics.trade_stats` (+ `trade_stats_by_account`, keyed by account id) — closed-trade skill metrics, values already in `base_currency`:
  ```ts
  interface TradeStats { closed: number; wins: number; losses: number; win_rate: number|null; wl_ratio: number|null; avg_win: number|null; avg_loss: number|null; payoff: number|null; expectancy: number|null; total_win: number; total_loss: number; }
  ```
  W/L classification follows the stored `win_loss` flag, not the sign of base P&L (a trade can win natively, lose in base after FX). `payoff` is `null` when there are no losses — never infinite. HIT RATE is **not** here: it mixes in live open positions, so `AnalyticsTab` computes it from `trade_stats.wins` + `/open-positions` rows with `unrealized_pnl_base > 0`.

## Risk Metrics (`GET /api/v2/portfolio/risk/metrics`)
```json
{
  "var": { "1d": 0.018, "1w": 0.042, "1m": 0.088, "3m": 0.151, "6m": 0.214 },
  "cvar": { "1d": 0.024, "1w": 0.057, "1m": 0.119, "3m": 0.205, "6m": 0.290 },
  "confidence": 0.95,
  "risk_score": 62,
  "risk_label": "MODERATE-HIGH"
}
```

## Allocation Signal (`GET /api/allocation/signal`)
```json
{
  "recommendation": "OVERWEIGHT_EQUITY",
  "equity_score": 0.68, "bond_score": 0.32,
  "layers": {
    "A_sentiment": { "score": 0.7, "components": { "vix": 0.6, "put_call": 0.8 } },
    "B_flow": { "score": 0.65, "components": { "etf_flow": 0.7, "fund_flow": 0.6 } },
    "C_structural": { "score": 0.69, "components": { "yield_curve": 0.5, "momentum": 0.9 } }
  },
  "timestamp": "2026-06-05T10:00:00"
}
```

## Country Rotation Scores (`GET /api/country-rotation/scores`)
```json
{
  "rankings": [{
    "ticker": "EWJ", "country": "Japan", "rank": 1,
    "total_score": 0.72,
    "momentum_score": 0.8, "macro_score": 0.65, "carry_score": 0.7
  }],
  "timestamp": "2026-06-05T10:00:00"
}
```

## Sector Selection Signal (`GET /api/sector/signal`)
```json
{
  "rankings": [{
    "etf": "XLK", "sector": "Technology", "rank": 1,
    "total_score": 0.75,
    "bc_score": 0.8, "mom_score": 0.7, "val_score": 0.65, "factor_score": 0.85
  }],
  "factors": { "yield_curve_z": 0.5, "cpi_z": -0.3, "credit_z": -0.8, "dxy_z": 0.2, "oil_z": 0.4 },
  "timestamp": "2026-06-05T10:00:00"
}
```

## Polymarket Signals (`GET /api/polymarket/signals`)
```json
{
  "signals": [{
    "type": "fed_rate", "label": "Fed Rate Cut", "color": "#22c55e",
    "question": "Will the Fed cut rates before July 2026?",
    "probability": 0.68, "volume": 5200000,
    "status": "LIKELY",
    "direction": "UP", "delta_24h": 0.03,
    "implied_odds": 1.47, "regime_flag": "HIGH_CONVICTION",
    "event_slug": "will-the-fed-cut-rates-before-july-2026",
    "slug": "will-the-fed-cut-rates-before-july-2026-abc123",
    "description": "Market tracking probability of Federal Reserve rate cut...",
    "end_date": "2026-07-01T00:00:00Z",
    "is_open": true
  }],
  "fetched_at": "2026-06-05T10:00:00"
}
```
Signal types: `fed_rate`, `inflation`, `recession`, `global_rates`, `trade`, `economy`, `crypto`, `election`  
URL: `https://polymarket.com/event/{event_slug}` — use `event_slug` NOT `slug`

## Polymarket MCP (`GET /api/polymarket/mcp`)
```json
{
  "generated_at": "2026-06-05T10:00:00",
  "schema": { "probability": "float 0-1", "status": "LIKELY≥0.65 | UNCERTAIN | UNLIKELY≤0.35", ... },
  "signals": [{ /* same as above + all enriched fields */ }]
}
```

## Macro (`GET /api/macro`)
```json
{
  "series": {
    "GDP": { "value": 2.1, "date": "2026-03-01", "unit": "%", "name": "Real GDP Growth" },
    "CPIAUCSL": { "value": 3.2, "date": "2026-05-01", "unit": "%", "name": "CPI" }
  },
  "yield_curve": [{ "maturity": "3M", "yield": 5.25 }, { "maturity": "2Y", "yield": 4.85 }, ...]
}
```

## Crisis Level (`GET /api/crisis`)
```json
{
  "level": 1,
  "label": "ELEVATED",
  "indicators": {
    "hy_spread": { "value": 420, "threshold": 500, "signal": "NORMAL" },
    "vix": { "value": 22, "threshold": 30, "signal": "ELEVATED" },
    "yield_curve": { "value": -0.3, "threshold": -0.5, "signal": "NORMAL" }
  }
}
```

## FX Overview (`GET /api/fx`)
```json
{
  "pairs": [{ "symbol": "EURUSD=X", "name": "EUR/USD", "rate": 1.085, "change": 0.002, "changePercent": 0.18 }]
}
```

## Crypto Overview (`GET /api/crypto`)
```json
{
  "coins": [{ "symbol": "BTC-USD", "name": "Bitcoin", "price": 65000, "change": 1200, "changePercent": 1.88, "volume": 28000000000, "marketCap": 1280000000000 }]
}
```

## BOT Policy Rate (`GET /api/bot/rates/policy`)
```json
{
  "rate": 2.5, "unit": "percent_per_annum",
  "effective_date": "2024-02-07",
  "decision": "The MPC voted 6 to 1 to maintain the policy rate at 2.5 percent...",
  "next_meeting": "2024-04-10"
}
```

## BOT Bond Auctions (`GET /api/bot/auctions?start_period=2026-05-01&end_period=2026-05-31`)
```json
{
  "auctions": [{
    "auction_date": "2026-05-15", "instrument": "LB31DA", "tenor": "5Y",
    "amount_offered": 20000, "amount_allotted": 20000,
    "avg_yield": 2.45, "high_yield": 2.48, "low_yield": 2.42,
    "bid_cover_ratio": 3.2
  }]
}
```

## SEC Fund NAV (`GET /api/sec/v2/fund/daily-info/nav?proj_id=X`)
```json
{
  "items": [{
    "proj_id": "123456", "fund_class_name": "Fund A",
    "nav_date": "2026-06-04", "net_asset": 5000000000,
    "last_val": 10.25, "sell_price": 10.30, "buy_price": 10.20
  }],
  "next_cursor": "abc123"
}
```

## Regime Correlation (`GET /api/regime/correlation`)
```json
{
  "mode": "RISK_ON",
  "correlation_matrix": { "XLK": { "XLF": 0.82, "XLE": 0.45 } },
  "sector_returns": { "XLK": 0.024, "XLF": 0.018 },
  "regime_confidence": 0.74
}
```

## Watchlist Signals (`GET /api/watchlist/signals?symbols=A,B`)
```json
{
  "signals": {
    "AAPL": {
      "asOf": "2026-07-27",
      "trend":    { "state": "UP|DOWN|FLAT", "ema20": 319.78, "ema50": 306.52, "ema200": 276.89 },
      "rsi":      { "value": 68.37, "state": "OB|OS|NEUTRAL" },
      "rvol":     0.27,
      "macd":     { "state": "BULL|BEAR|NONE", "barsSinceCross": 16, "hist": 1.2516 },
      "breakout": { "state": "UP|DOWN|NONE", "high": 334.98, "low": 274.21 },
      "range52w": { "pct": 1.0, "high": 339.15, "low": 201.58 },
      "atrPct":   2.4,
      "score":    5,
      "flags":    ["TREND_UP", "GOLDEN_CROSS", "BREAKOUT_UP", "VOL_QUIET", "NEAR_52W_HIGH"]
    }
  },
  "errors": [],
  "count": 1
}
```
Flags: `TREND_UP`/`TREND_DOWN`, `GOLDEN_CROSS`/`DEATH_CROSS`, `RSI_OVERBOUGHT`/`RSI_OVERSOLD`,
`MACD_CROSS_FRESH` (≤3 bars), `BREAKOUT_UP`/`BREAKDOWN`, `VOL_SPIKE`/`VOL_QUIET`,
`NEAR_52W_HIGH`/`NEAR_52W_LOW`. Frontend type: `WatchlistSignal` in `hooks/useWatchlistSignals.ts`.

---

## TypeScript Interfaces (key frontend types)

### `portfolio/types.ts`
```ts
interface Trade { id: string; account_id: string; symbol: string; date_entry: string; price_entry: number; volume: number; currency: string; is_reinvest?: number; // 0|1 — label only, ticked in ENTRY, listed in CASH→REINVEST; no effect on cash/positions exchange_rate: number; exit_exchange_rate?: number; amount_base?: number; pnl_base?: number; pos_currency?: string; acc_currency?: string; unrealized_pnl_base?: number; cost_basis_base?: number; market_value_base?: number; day_pnl_base?: number; }
interface AccountStat { pnl_base: number; pnl_economic_base?: number; ytd_realized_base?: number; ytd_economic_realized_base?: number; }
interface Summary { total_pnl_base: number; total_economic_pnl_base?: number; total_ytd_realized_base?: number; total_ytd_economic_realized_base?: number; }
interface Account { id: string; name: string; broker: string; country: string; currency: string; account_type: string; }
interface CashEntry { id: string; account_id: string; date: string; income: number; investment: number; exchange_rate: number; note: string; entry_type?: "CASH" | "TRANSFER"; linked_id?: string; }  // TRANSFER rows come in linked pairs (same linked_id, opposite investment sign) — see plans/completed/cash-transfer-feature.md
interface Dividend { id: string; account_id: string; asset: string; pay_date: string; amount_per_unit: number; total_received: number; currency: string; amount_per_unit_base?: number; total_received_base?: number; reinvested_amount_base?: number; }
```

### `PolySignal` (news-view.tsx)
```ts
interface PolySignal { type: string; label: string; color: string; question: string; probability: number; volume: number; status: "LIKELY"|"UNCERTAIN"|"UNLIKELY"; direction: "UP"|"DOWN"|"STABLE"; delta_24h: number|null; implied_odds: number; regime_flag: "HIGH_CONVICTION"|"UNCERTAIN"; event_slug: string; slug: string; description: string; end_date: string; is_open: boolean; }
```


---

## `/api/rates/curve` — bond curve tick rows (`routers/rates.py`)

```jsonc
{
  "us": [ /* Row[] — 11 UST tenors, ordered 1M → 30Y */ ],
  "jp": [ /* Row[] — 15 JGB tenors, ordered 1Y → 40Y */ ],
  "usError": null,        // string when FRED_API_KEY is unset
  "jpSource": "mof",      // "fred" when the MOF fallback kicked in
  "jpStale": false,       // true = single OECD monthly 10Y row only
  "asOf": "2026-08-01T05:12:33.101Z"
}
```

Row:
```jsonc
{
  "id": "US 10Y",         // country + tenor; also the TICK DATA highlight key
  "country": "US",        // "US" | "JP"
  "tenor": "10Y",
  "value": 4.68,          // PERCENT, not a price
  "changeBp": 1.0,        // BASIS POINTS vs previous observation; null if only one obs
  "ytdBp": 49.0,          // BASIS POINTS vs first observation of the current year
  "sparkline1": [4.21, /* … up to 30 obs */],
  "chartSymbol": "^TNX",  // null unless the tenor is 3M/5Y/10Y/30Y
  "asOf": "2026-07-30"
}
```

⚠️ `changeBp`/`ytdBp` are **basis points**, deliberately not `change`/`pctChange`: a percent-change on a
yield is meaningless (0.05% → 0.10% is not a "+100%" event). The frontend `RateRow` therefore renders
`—` in the %CHG column and colours yield-up red (bond price down), matching MACRO's convention.
TS interface: `RateRowData` in `hooks/useRatesCurve.ts`.
