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

## Adaptive DCF (`GET|POST /api/dcf/{symbol}`)

```json
{
  "status": "ok", "symbol": "AAPL", "currency": "USD", "as_of": "2025-09-27",
  "scenario": "base", "model": "fcff", "model_label": "3-STAGE FCFF",
  "model_router": {
    "model": "fcff", "label": "3-STAGE FCFF", "reason": "...",
    "overrideable": true, "alternatives": ["growth", "fcfe", "excess_return", "affo", "normalized_cycle"]
  },
  "summary": {
    "market_price": 332.27, "enterprise_value": 2800000000000,
    "equity_value": 2850000000000, "intrinsic_value_per_share": 190.0,
    "upside_downside": -0.428, "pv_explicit": 700000000000,
    "pv_terminal": 2100000000000, "terminal_value_share": 0.75
  },
  "bridge": {"cash": 50000000000, "debt": 0, "minority_interest": 0, "preferred_stock": 0, "shares": 15000000000},
  "assumptions": {
    "forecast_years": 7, "high_growth_years": 5, "revenue_growth": 0.08,
    "target_margin": 0.30, "tax_rate": 0.16, "sales_to_capital": 2.0,
    "wacc": 0.09, "cost_of_equity": 0.095, "terminal_growth": 0.025,
    "terminal_roic": 0.10, "equity_model": false
  },
  "forecast": [{
    "year": 1, "stage": "HIGH GROWTH", "revenue": 420000000000,
    "growth": 0.08, "ebit_margin": 0.30, "nopat": 105000000000,
    "reinvestment": 15500000000, "cash_flow": 89500000000,
    "discount_rate": 0.09, "present_value": 82110000000
  }],
  "terminal": {"cash_flow": 120000000000, "undiscounted_value": 1846153846154, "method": "Gordon growth"},
  "sensitivity": {
    "discount_rate_key": "wacc", "discount_rates": [0.07, 0.08, 0.09, 0.10, 0.11],
    "terminal_growth_rates": [0.015, 0.02, 0.025, 0.03, 0.035],
    "values_per_share": [[250.0, 270.0, 295.0, 330.0, 380.0]]
  },
  "data_quality": {
    "completeness": 0.93, "warnings": [],
    "lineage": [{"key": "revenue", "value": 391035000000, "source": "yfinance statement", "tag": "Total Revenue", "period": "2025-09-27", "status": "STATEMENT"}]
  }
}
```

- Rates and growth assumptions are decimal fractions. Statement/valuation figures stay in `currency`; values in this example are illustrative.
- Corporate forecast rows carry revenue/margin/NOPAT/reinvestment. FCFE/AFFO rows omit unavailable corporate fields; excess-return rows use `roe`, `book_equity`, and `earnings`.
- `values_per_share` is a 5×5 matrix indexed by `discount_rates` then `terminal_growth_rates`; invalid cells where `g >= rate` are `null`.
- If statement and quote currencies differ, `summary.market_price` and `summary.upside_downside` are `null`. Never restore an unconverted quote in the frontend.
- POST body: `{ "model": "growth", "scenario": "bull", "assumptions": { "target_margin": 0.25, "wacc": 0.09 } }`.

## Options Chain (`GET /api/options?symbol=AAPL&expiry=2026-10-16`)

Next.js proxies the existing Python `GET /api/options/{symbol}?expiry=`. IV is a decimal fraction (0.28 = 28%); field names are `lastPrice` and **`impliedVolatility`**, not `last` / `impliedVol`.

```json
{
  "symbol": "AAPL", "spot": 332.27, "expiry": "2026-10-16",
  "expirations": ["2026-10-09", "2026-10-16", "2026-11-20"],
  "freshness": { "source": "yahoo_finance", "delay_minutes": 15, "is_realtime": false, "fetched_at": "2026-09-12T18:36:30Z" },
  "calls": [{ "contractSymbol": "AAPL261016C00330000", "strike": 330, "bid": 15, "ask": 16, "lastPrice": 15.5, "volume": 1200, "openInterest": 8000, "impliedVolatility": 0.28, "inTheMoney": true, "change": 1, "percentChange": 6.9 }],
  "puts": [],
  "ivCurrent": 0.28, "ivCall": 0.28, "ivPut": 0.27, "ivMid": 0.275,
  "atmStrike": 330, "pcRatio": 0.8, "callOI": 8000, "putOI": 6400,
  "callVolume": 1200, "putVolume": 1000
}
```

Illustrative values; `calls`/`puts` rows do not include Greeks. Backend `clean_df` rounds IV to4 decimals and fills missing numeric quotes with0, so chart consumers must validate positive/finite IV and usable bid/ask. No chain schema changed for MKT IV Smile. The Next.js proxy now preserves backend status and string detail as `{error: string}`:404 means no options, transport failures remain502.

## SD Bands (`GET /api/options/{sym}/sd-bands?mode=occupancy&horizonDays=30`)
```json
{
  "symbol": "SPY", "mode": "occupancy",
  "horizonDays": 30, "rvWindow": 21, "occWindow": 63,
  "r": 0.0387,
  "levels": [-2, -1, 0, 1, 2],
  "refProbs": [0.066807, 0.24173, 0.382925, 0.24173, 0.066807],
  "exceedProbs": [0.97725, 0.84134, 0.5, 0.15866, 0.02275],
  "snapshotCount": 357,
  "series": [{
    "time": "2026-08-17", "anchorTime": "2026-07-18",
    "spot": 762.1, "terminal": 775.51,
    "sigmaIv": 0.1938, "sigmaRv": 0.1304, "dteAtSnapshot": 30, "T": 0.082192,
    "prices": [694.1, 727.6, 762.6, 799.3, 837.8],
    "edges": [null, 710.6, 744.8, 780.6, 818.1, null],
    "cells": [0.0, 0.015873, 0.666667, 0.31746, 0.0],
    "hitRow": 3, "hitZ": 0.8, "sampleSize": 63
  }],
  "current": { "time": "2026-08-17", "targetDate": "2026-09-16", "spot": 775.51,
               "sigmaIv": 0.164, "sigmaRv": 0.1304, "dteAtSnapshot": 30, "T": 0.082192,
               "prices": [707.4, 741.4, 777.1, 814.5, 853.7],
               "edges": [null, 724.2, 759.1, 795.6, 833.9, null] },
  "note": "present ONLY when series is empty — never an error"
}
```
⚠️ Field notes the frontend depends on:
- `levels`/`refProbs`/`cells`/`prices` are aligned, index 0 = **−2σ = bottom row** of the pane
- `edges` has **6** entries; the two open ends are `null` (JSON has no infinity), not 0
- `exceedProbs[k]` = `P(S_T ≥ prices[k])` = `1 − Φ(k)` — a DIFFERENT question from `refProbs`: the odds of finishing at or above that line (15.9% at +1σ) vs the odds of finishing inside that band (24.2%). Both are constants in z; the pane prints them, never colours by them
- `refProbs` are CONSTANTS (6.7/24.2/38.3/24.2/6.7%) — the reference the colors are measured against, never the colors themselves
- `prices[2]` is the lognormal **median**, below the forward by `exp(σ²T/2)` — not spot, not the forward
- `cells` meaning switches with `mode`: occupancy = trailing bucket frequency (sums to 1); cheapness = `P_rv − P_iv` (sums to 0, and adds a `rvProbs` field)
- every column is stamped on a **real bar**, never on the raw snapshot date (`snapshotDate` keeps that) — a snapshot taken on a holiday anchors to the last bar on or before it, because the chart matches columns to bars by date
- occupancy columns are stamped at the TERMINAL bar and deduped (weekend gaps collapse several anchors onto one bar); `current` holds the still-open projection

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

## Portfolio Cash (`/summary` → `cash_base`, `total_cash_base`)

```
cash = invested + realized + dividends − open_cost(equity) − open_cost(options)
```

`realized` here is `pnl_base`, which **already includes closed options** (since 2026-09-10).
Adding `options_realized_base` on top double-counts them — that field is a breakdown of what is
already in the total, not a second term.

**This is an ESTIMATE, not a balance.** Nothing posts to `cash_ledger` when a position closes —
that table is hand-entered deposits and withdrawals, and NAV is deliberately independent of it
(`_maybe_capture_nav`: "cash_ledger deposits are often incomplete"). The figure cannot see
commissions, taxes or margin interest that were never recorded.

Computed in `/summary` rather than in the browser, because ANALYTICS, the header chip and the CASH
tab all need it and three copies of the formula would drift. Open cost comes from `trades` and
`v_option_open_lots` directly — cost basis does not depend on today's price, so this adds no
network calls.

**Options belong on BOTH sides**: their realized P&L is cash in, their open premium is cash still
deployed. The pre-2026-09-10 client-side version counted NEITHER, and the two omissions partly
cancelled — which made the number look plausible while being wrong.

On the CASH tab this deliberately does NOT equal `IN − INV`: that pair is what was typed into the
ledger, while `CASH~` also folds in every closed position. Both are labelled so the difference does
not read as a bug.

### Reconciliation — cash EDIT (2026-09-16)

`cash_base = cash_derived_base + cash_adjustment_base`. The user states the broker balance in
`CashReconcileModal` (header CASH chip or CASH tab → EDIT); `POST /cash/reconcile` stores
`actual − current cash_base` as a row in `cash_adjustments` — the **difference**, not the balance —
so later buys/sells keep moving the derived part and the correction rides along. Stacking: a second
reconcile compares against cash that already includes earlier offsets. Undo = delete the row.

Offsets are NOT `cash_ledger` rows on purpose: they are not capital paid in, so they do not move
invested capital, XIRR or CAGR. `/summary` converts them at live FX; `/nav-history` at the
snapshot's dated FX and only for rows with `date <= snapshot_date` (effective date).

New fields: per account `cash_derived_base`, `cash_adjustment_base`, `cash_reconciled_at`
(latest effective date | null); totals `total_cash_derived_base`, `total_cash_adjustment_base`.
`cash_is_estimate` is now `false` once every active account has ≥1 offset.

```ts
interface CashAdjustment { id: string; account_id: string; date: string; amount: number;
  currency: "THB"|"USD"; target_balance: number|null; derived_before: number|null; note: string; created_at: string; }
```

### `/nav-history` rows gain `cash_balance` + `nav_with_cash` (2026-09-16)

`total_value` in `portfolio_nav_snapshots` is **holdings only**, so a sale made NAV dip and the
next buy made it recover. Each row now also carries
`cash_balance = invested_capital + realized_pnl + dividends − open_cost_basis + offsets(date ≤ day)`
and `nav_with_cash = total_value + cash_balance`, computed at read time from existing snapshot
columns (no schema change, old rows get it too). ANALYTICS → PORTFOLIO VALUE plots `nav_with_cash`
with holdings and cash as thin lines. Real data 2026-09-11: holdings 1.84M→1.55M after a sale,
NAV+cash 2.08M→2.06M.

---

## Option Payoff (`POST /api/options/payoff`)

Three kinds of number, and conflating them is how a payoff screen misleads:

| | what it is | rests on |
|---|---|---|
| `curve[].expiry`, `breakevens`, `max_profit`, `max_loss` | **arithmetic** | nothing — `max(S−K,0)` and a subtraction |
| `curve[].t0`, `current.pnl_today` | **model** | Black-Scholes at today's IV (via `greeks.py`) |
| `pop` | **model estimate** | + lognormal terminal price, IV held constant, risk-neutral drift |

```
payoff(S) = Σ legs [ (intrinsic(S) − entry_price) × qty × multiplier ] − Σ fees
```

`quantity` is SIGNED — shorts come out right with no branch, which is exactly why the sign is kept.

**Max profit/loss come from the tail slope, never from the sampled grid.** Only calls still have
exposure as S→∞, so `Σ(qty×mult)` over the call legs decides it: positive → profit unbounded,
negative → loss unbounded. Reading the grid's edge would report a number describing the chart's
width instead of the position. The S→0 side is always finite.

**Breakevens come from a sign-change scan plus bisection**, not `K ± premium`. That closed form
covers one leg; a spread has one crossing at a different place, a straddle has two, and some
positions have none.

⚠️ **POP falls as vol rises for an out-of-the-money option.** Under a risk-neutral lognormal the
mean stays at the forward but the median is `S·exp((r−σ²/2)T)`, which drops as σ grows — at σ=0.30
the median is 100.75, at σ=0.90 it is 70.29. Verified against closed-form `N(d₂)` to machine
precision. Counterintuitive, correct, and worth leaving in the tooltip.

---

## Portfolio Option Lots (`GET /api/v2/portfolio/open-positions` → `options[]`)

Produced by `backend/portfolio_options.py::value_option_rows` — the single place an option row
becomes money. `/summary`, `/allocation-detail`, `/returns`, `/nav-history` and `/analytics` all
call into it, so none of them can drift from this shape.

```json
{
  "id": "uuid", "account_id": "dime", "acc_name": "Dime",
  "underlying": "AAPL", "expiry": "2027-01-15", "strike": 200.0,
  "option_type": "call", "quantity": 2, "entry_price": 5.80, "entry_date": "2026-08-01",
  "symbol": "AAPL 2027-01-15 200C",
  "currency": "USD", "multiplier": 100,
  "spot": 314.63, "mark": 125.21, "mark_source": "last", "mark_stale": false,
  "expired": false, "implied_volatility": 0.2841, "delta": 0.9247,
  "cost_basis_native": 1160.0, "market_value_native": 25042.0,
  "unrealized_pnl": 23882.0, "unrealized_pct": 2058.79,
  "cost_basis_base": 38871.6, "market_value_base": 822379.28,
  "unrealized_pnl_base": 783507.68, "unrealized_pct_base": 2015.63,
  "delta_notional_native": 58197.0, "delta_notional_base": 1910852.79,

  "gamma": 0.003147, "theta": -0.0312, "vega": 0.0126,
  "delta_exp_usd": 1276.91, "gamma_exp_usd": 172.37,
  "theta_exp_usd": -15.60, "vega_exp_usd": 6.30,
  "cost_basis_usd": 100.0, "market_value_usd": 85.0,
  "unrealized_pnl_usd": -15.0, "unrealized_pct_usd": -15.0
}
```

**Raw greeks are in `greeks.py`'s own units** ([greeks.py:99-107](../../backend/greeks.py)):
`theta` per CALENDAR DAY · `vega` per 1pp of IV · `gamma` per $1 of spot. They are `null`, never 0,
when the chain gave no IV — a lot with no greeks must be skipped by aggregates, not counted as
having no exposure.

**Dollar greeks are always USD** — they answer "how many dollars does this move", a question about
the contract's own market, not about the report currency:

| field | formula | reads as |
|---|---|---|
| `delta_exp_usd` | Δ × qty × mult × S | USD moved per 100% move in the underlying |
| `gamma_exp_usd` | Γ × qty × mult × S² × 0.01 | dollar delta gained per **1%** move |
| `theta_exp_usd` | Θ × qty × mult | USD per calendar day (negative while long) |
| `vega_exp_usd` | ν × qty × mult | USD per 1pp of implied vol |

`gamma_exp_usd` is the desk convention, NOT the exact derivative — the true d(dollar delta)/dS also
carries a `Δ × qty × mult` term. Label it "dollar delta per 1% move", never "gamma".

**Sign convention:** `quantity` is signed and nothing is `abs()`-ed. A short lot has a NEGATIVE
`cost_basis_*` (the credit received) and a NEGATIVE `market_value_*` (the liability) — which is
exactly what makes `market_value - cost` the right unrealized P&L on both sides. A short put's
`delta_notional_*` comes out POSITIVE (long exposure), as it should.

**Two numbers, not interchangeable:**
- `market_value_base` → NAV and unrealized P&L
- `delta_notional_base` → allocation and sector weight. Three SPY calls worth $1,200 of premium can
  carry $150k of exposure; weighting a book by premium hides that.

**`unrealized_pct` vs `unrealized_pct_base`:** cost converts at the entry-date FX rate and market
value at the live one, so when FX moves the base P&L is non-zero even with an unmoved premium.
Always pair the base amount with `unrealized_pct_base` — pairing it with the native percentage
prints `-161 (+0.0%)`.

**`mark_source` ladder:** `last` → `mid` (bid/ask) → `ask` → `entry_cost` (`mark_stale: true`),
or `intrinsic_expired` past expiry. A lot with no quote is held at cost, never at zero — zero would
render as a total loss.

---

## Option PnL Attribution (`GET /api/v2/portfolio/options/attribution?days=30`)

```json
{
  "currency": "USD",
  "period": {"from": "2026-09-05", "to": "2026-09-09", "snapshot_days": 4, "requested_days": 30},
  "portfolio": {
    "delta_pnl": 47.03, "gamma_pnl": 5.34, "theta_pnl": -58.0, "vega_pnl": 29.11,
    "residual": 16.52, "actual": 40.0, "explained_pct": 58.7
  },
  "positions": [{
    "position_id": "uuid", "symbol": "INTC 2026-09-25 150C", "quantity": 5, "steps": 3,
    "spot_from": 100.0, "spot_to": 104.685, "iv_from": 0.78, "iv_to": 0.829,
    "delta_pnl": 47.03, "gamma_pnl": 5.34, "theta_pnl": -58.0, "vega_pnl": 29.11,
    "residual": 16.52, "actual": 40.0, "explained_pct": 58.7
  }],
  "series": [{"date": "2026-09-06", "delta_pnl": 13.5, "...": 0, "actual": 10.0}],
  "steps_skipped": 0,
  "note": null
}
```

Per day-step, using the greeks from the **start** of the step (`t−1`):

```
delta_pnl = Δ × ΔS      × qty × mult
gamma_pnl = ½Γ × ΔS²    × qty × mult
theta_pnl = Θ  × Δdays  × qty × mult      ← Δdays is the REAL gap between snapshots
vega_pnl  = ν  × ΔIV_pp × qty × mult      ← ΔIV_pp = (iv_t − iv_{t−1}) × 100
actual    = (mark_t − mark_{t−1}) × qty × mult
residual  = actual − (delta + gamma + theta + vega)
```

**`residual` is defined as the leftover, so the five legs always sum to `actual`.** That is
arithmetic, not evidence — `explained_pct` = `1 − |residual|/|actual|` is the quality signal. Using
end-of-period greeks instead would explain a move with information that only existed after it.

`Δdays` is the actual calendar gap between two stored snapshots, not 1. A weekend gap must charge
two days of theta or the decay reads low every Monday.

Backed by `option_greeks_snapshots` (spot/IV/mark/Δ/Γ/Θ/ν per position per day), captured
once-per-day off-thread from `/open-positions` and `/analytics`. Like `iv_snapshots` it can only be
ACCUMULATED — Yahoo serves only the current chain, so no back-fill is possible.

---

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

## Allocation Detail (`GET /api/v2/portfolio/allocation-detail?base_currency=THB`)

Two bases at once — the ALLOCATION (OPEN) card used to weight sectors by cost alone, which is frozen at entry.

```json
{ "base_currency": "THB", "thb_per_usd": 33.09,
  "totals": {"cost_base": 2542919.79, "market_value": 1741759.59, "unrealized": -801160.2,
             "growth_pct": -31.51, "gain_concentration_pct": 69.08,
             "gain_concentration_symbol": "SNDK", "positions": 15},
  "sectors": [{"sector": "Information Technology", "cost_base": 463370, "market_value": 533529,
               "growth_pct": 15.14, "weight_cost_pct": 18.22, "weight_mv_pct": 30.63,
               "drift_pp": 12.41, "contrib_growth_pct": 2.76, "share_of_gain_pct": 0,
               "target_pct": 18.22, "target_source": "cost_weight", "band_pct": 0,
               "target_value": 317348, "delta_value": -216180, "in_band": false,
               "action": "SELL", "priced": true, "symbols": [ /* same shape */ ]}],
  "symbols": [{"symbol": "SNDK", "sector": "...", "volume": 7.02, "price": 54304.33,
               "avg_cost": 46140.93, "lots": 2, "has_override": false, "priced": true,
               "delta_shares": -3, "lot_size": 1, "est_value": 162913, "est_realized": 22733.24}]}
```

- `cost_base` uses **entry** FX, `market_value` uses **live** FX (`trade_value_in_report` when=entry/live) — one rate on both sides cancels the currency move out of `growth_pct`.
- `drift_pp` = `weight_mv_pct − weight_cost_pct` — how far a winner grew past the slice originally deployed.
- `share_of_gain_pct` splits the gross (positive-only) gain; losers are 0 so they cannot dilute it.
- `market_value` is `null` and `priced:false` when any lot has no live quote — never silently short.
- `delta_shares` rounds DOWN to the board lot (TH 100), to nearest for single-share markets, and a SELL never exceeds shares held. `est_realized` = the same fraction of unrealised P&L (average-cost method).
- With no explicit target, `target_pct = weight_cost_pct` (`target_source: "cost_weight"`).

## Thesis (`GET /api/v2/theses/{id}`)

```json
{ "thesis": {"id": "uuid", "symbol": "PLTR", "title": "...", "category": "CORE",
             "sub_portfolio": "0153717", "strategy": "growth", "status": "active",
             "conviction": 4, "time_horizon": "3Y+", "target_price": 45, "stop_price": 18,
             "body": "## Claim
…", "source_file": "PLTR-ai-thesis.md",
             "deleted_at": null, "created_at": "...", "updated_at": "..."},
  "events": [{"id": "uuid", "event_type": "EDITED",
              "payload": {"title": {"from": "old", "to": "new"}},
              "note": "sharpened it", "occurred_at": "...", "device_id": "PC"}],
  "links":  [{"trade_id": "uuid", "role": "entry", "symbol": "PLTR", "date_entry": "2026-01-02"}],
  "notes":  [{"id": "uuid", "thesis_id": "uuid", "kind": "SCENARIO", "title": "China supply lands early",
              "body": "...", "impact": "bear", "likelihood": 3, "severity": 4,
              "status": "open", "watch_date": "2026-11-30", "pinned": 0,
              "deleted_at": null, "device_id": "PC", "created_at": "...", "updated_at": "..."}] }
```

`status`: `draft|active|watch|invalidated|closed`. `event_type`: `CREATED|EDITED|STATUS_CHANGED|TARGET_CHANGED|INVALIDATED|NOTE|NOTE_ADDED|NOTE_RESOLVED|TRADE_LINKED|TRADE_UNLINKED|DELETED|RESTORED|EXPORTED`. `payload` is a `{field: {from, to}}` diff on edits, free JSON otherwise.

**Note** (`GET /api/v2/theses/{id}/notes`, same row shape as above): `kind` `NOTE|SCENARIO|RISK|CATALYST|QUESTION|EVIDENCE` · `status` `open|watching|confirmed|dismissed` · `impact` `bull|bear|mixed|null` · `likelihood`/`severity` 1–5, clamped server-side (the UI shows L×S only when both are set). `GET /api/v2/theses/notes/due` returns the same rows plus `symbol` + `thesis_title` from the join.

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

## Watchlist News (`GET /api/news/watchlist?symbols=AAPL,XOM`)
```json
{
  "as_of": "2026-08-15T06:31:00Z",
  "sources_used": ["yahoo","yfinance","google","bing","seekingalpha","nasdaq","sec"],
  "symbols": [{ "symbol": "AAPL", "company": "Apple Inc.", "sector": "Technology",
                "industry": "Consumer Electronics", "country": "US", "article_count": 6 }],
  "sectors": [{ "sector": "Technology", "symbols": ["AAPL"], "article_count": 6 }],
  "articles": [{
    "title": "...", "url": "...", "source": "Nasdaq", "source_kind": "company",
    "published_at": "2026-08-15T04:10:00Z", "summary": "...",
    "symbols": ["AAPL","MSFT"], "primary_symbol": "AAPL", "sector": "Technology",
    "company": "Apple Inc.", "sentiment": "POS|NEG|NEU", "relevance": "direct|feed"
  }],
  "markets": [{ "symbol": "AAPL", "sector": "Technology", "question": "...", "slug": "...",
                "event_slug": "...", "probability": 0.14, "volume": 803010.5,
                "end_date": "2026-12-31T00:00:00Z" }],
  "errors": []
}
```
`source_kind`: wire | aggregator | analysis | filing | company.
`relevance`: `direct` = headline names the ticker/company · `feed` = came off that symbol's wire
without naming it (UI default hides these). Frontend hardcodes every field name above.

## Company Outlook (`GET /api/company/outlook/MU`)
```json
{
  "symbol": "MU", "cik": "0000723125", "has_guidance": true,
  "release": {
    "filed": "2026-06-24", "period": "2026-06-24",
    "url": "https://www.sec.gov/Archives/edgar/data/723125/.../a2026q3ex991-pressrelease.htm",
    "index_url": "…-index.html",
    "guidance": {
      "heading": "Business Outlook",
      "metrics": { "revenue": "$50.0 billion ± $1.0 billion", "gross_margin": "Approximately 86%",
                   "operating_expenses": "$1.86 billion", "eps": "$30.73 ± $1.00" },
      "excerpt": "Business Outlook The following table presents…"
    },
    "ceo_quotes": [{ "speaker": "Sanjay Mehrotra",
                     "title": "Chairman, President and CEO of Micron Technology",
                     "quote": "Micron's record fiscal Q3 …" }]
  },
  "mdna": { "form": "10-Q", "filed": "2026-06-25", "period": "2026-05-28", "url": "…",
            "statements": ["We plan to begin construction of the second Idaho fab in 2026…"] }
}
```
`GET /api/company/xbrl/MU` → `{ symbol, cik, period, tags: {metric: usGaapTag},
series: { revenue|gross_profit|operating_income|net_income|eps_diluted|rnd|operating_cash_flow|
capex|gross_margin|operating_margin: [{ start, end, val, form, fy, fp, filed }] } }` —
`gross_margin`/`operating_margin` เป็น % ที่คำนวณเอง ไม่ใช่ tag ที่ยื่น.
`GET /api/company/filings/MU` → `{ symbol, cik, filings: [{ form, filed, period, items,
accession, url, index_url }] }`.

## Stock Prediction Markets (`GET /api/polymarket/stock/MU`)
```json
{
  "symbol": "MU", "spot": 971.66, "as_of": "2026-08-15T06:55:00Z",
  "events": [{
    "slug": "mu-above-in-august-2026", "title": "Will Micron (MU) close above ___ end of August?",
    "type": "above", "end_date": "2026-09-01T03:59:59Z", "days_left": 16.5,
    "volume": 8123.4, "liquidity": 4792.5, "prob_up": null,
    "url": "https://polymarket.com/event/mu-above-in-august-2026",
    "strikes": [{ "label": "$940", "strike": 940, "direction": "up", "prob": 0.57,
                  "volume": 0, "slug": "mu-above-940-on-august-31-2026" }]
  }],
  "summary": {
    "spot": 971.66, "prob_up": 0.69, "prob_up_source": "touch", "prob_above_spot": null,
    "nearest_up":   { "strike": 1020, "prob": 0.69, "basis": "touch" },
    "nearest_down": { "strike": 940,  "prob": 0.57, "basis": "close" },
    "implied_high": 1020, "implied_low": null, "skew": 0.26, "horizon_days": 16.5,
    "event_slug": "...", "event_title": "...", "url": "..."
  }
}
```
`type`: `ladder` (touch) · `above` (CDF) · `updown` · `earnings` · `other`.
`basis`: `close` rungs are P(close ≥ K) — flip to `1 - prob` for a downside tail; `touch` rungs are
P(trades through K) and below spot are often already resolved. `/api/polymarket/stocks?symbols=`
returns `{ "summaries": { "MU": { ...summary, "event_count": 2 } }, "as_of": "…" }`.

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

## Tail Macro Context (`GET /api/tail-risk/macro-context`)

```json
{
  "counted_in_composite": false,
  "event_sensitive_signals": ["vix_level", "vix_momentum", "vix_term_inversion"],
  "calendar": {
    "as_of": "2026-09-16",
    "upcoming": [{"date": "2026-09-16", "kind": "FOMC", "label": "FOMC decision + SEP", "sep": true,
                  "impact": "high", "source": "federalreserve.gov", "days_until": 0, "bdays_until": 0}],
    "past": [/* same shape, days_until < 0 */],
    "event_window": {"active": true, "bdays": 1, "events": [/* MacroEvent */]},
    "next_fomc": {"date": "2026-09-16", "days_until": 0, "sep": true},
    "fomc_calendar_through": "2027-12-08", "fomc_calendar_stale": false, "fomc_calendar_expiring": false,
    "releases_ok": true
  },
  "fed": {"rate": 3.63, "stance": "HOLD"},
  "yield_curve": {"3m": 3.94, "2y": 4.65, "5y": 4.777, "10y": 4.959, "30y": 5.341,
                  "spread_10y_2y": 0.309, "spread_10y_3m": 1.019, "inverted_10y_2y": false, "inverted_10y_3m": false},
  "regime": {"growth": {"state": "SLOWING", "tone": "watch"}, "inflation": {...}, "labor": {...}, "policy": {...}},
  "indicators": {"cpi": {"value": 3.71, "prev": 3.54, "date": "2026-08-01"}, "...": null},
  "macro_ok": true
}
```
`kind` ∈ FOMC|CPI|NFP|PCE|GDP. Spreads are percentage points (UI ×100 → bp). `calendar`/`regime`/`fed`/`yield_curve`/`indicators` may be `null` on failure — render NO DATA, never calm.

## Tail Risk Signals (`GET /api/tail-risk/signals`)

```json
{
  "ok": true,
  "data_date": "2026-08-14",
  "risk_level": "NORMAL",
  "alert_dimensions": [], "watch_dimensions": ["tail_pricing"],
  "dimensions": [
    { "id": "equity_vol", "label": "EQUITY VOL", "question": "Is equity volatility abnormal right now?",
      "status": "NORMAL", "on_count": 0, "total": 3, "unknown_count": 0, "degraded": false,
      "active_signals": [], "unknown_signals": [] }
  ],
  "signals": [
    { "id": "vix_term_inversion", "label": "VIX Term Inversion", "dimension": "equity_vol",
      "rule": "VIX9D > VIX (front) or VIX > VIX3M (back)", "why": "...",
      "state": "off", "active": false, "value": null,
      "detail": "9D 10.61 / 30D 14.25 / 3M 18.46", "reason": null,
      "validated": true, "verdict": "USEFUL",
      "stats": { "prec_is": 0.168, "rec_is": 0.875, "fires_is": 0.254, "fires_oos": 0.278,
                 "prec_oos": null, "prec_fwd": null, "edge_fwd_pp": null, "note": null } }
  ],
  "vol_table": [
    { "name": "VIX", "description": "S&P 500 30d implied vol", "value": 14.25, "change_1d": -0.38,
      "z63": -1.65, "pctile_1y": 2.4, "ok": true, "last_date": "2026-08-14", "source": "cboe", "reason": null }
  ],
  "vix_term": { "vix9d": 10.61, "vix": 14.25, "vix3m": 18.46, "vix6m": 20.8,
                "backwardation_front": false, "backwardation_back": false },
  "fear_greed": 65.0, "spy_rsi": 65.8, "sector_regime": "DIVERGENT", "sector_corr": 0.283,
  "crisis_level": 0, "dcc_v1_signal": "NORMAL", "dcc_v3_signal": "NORMAL",
  "history": [ { "date": "2026-08-14", "signals_on": 1, "alert_dimensions": 0 } ],
  "data_health": {
    "ok": true, "reference_date": "2026-08-14", "degraded": [], "degraded_count": 0,
    "unknown_signals": [],
    "indices": [ { "name": "VIX9D", "ok": true, "source": "cboe", "last_date": "2026-08-14",
                   "stale_days": 0, "reason": null } ],
    "sources": { "cboe_vol_indices": true, "crisis_router": true, "fear_greed_router": true,
                 "ticker_router": true, "spy_agg_prices": true, "dcc_assets": true }
  }
}
```

⚠️ `state` is **tri-state**. `"unknown"` means the input could not be verified — render it as NO DATA, not as
"off". `value`/`z63`/`pctile_1y` are `null` for any index whose `ok` is false; the last good print is
deliberately withheld so it cannot be compared against a current one.
`verdict` is `"UNVALIDATED"` for the VVIX/SKEW/OVX/GVZ/VXN signals — they have no backtest, and `stats` is `null`.

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

### `ChartEventMarker` / `EventPriceReaction` (`chart/types.ts`)
```ts
type ChartEventType = "dividend" | "earnings" | "split";
interface ChartEventMarker { time: string|number; type: ChartEventType; label: string; value?: number; detail?: string; color?: string;
  // raw, unformatted — the detail popover lays these out; the chart itself only reads type/color
  epsEstimate?: number|null; reportedEPS?: number|null; surprise?: number|null; eventType?: string;
  reportedAt?: string;   // "YYYY-MM-DD HH:MM" — hour ≥16 means AMC, so the reaction is on the NEXT bar
  dividend?: number; splitRatio?: number;
  upcoming?: boolean;    // declared/scheduled but not reached — drawn past the last bar, no reaction
  estimated?: boolean;   // amount carried over from the last payment, not announced
  payDate?: string|null; // dividend pay date, when known }
interface EventPriceReaction { gapPct: number|null; sameDayPct: number|null; nextDayPct: number|null; fiveDayPct: number|null; closeOnEvent: number|null; }
```
- Built by `hooks/useStockEvents.ts` from `/api/stock?type=dividends` + `type=earnings-calendar`. `time` is always sliced to `YYYY-MM-DD`.
- `EventPriceReaction` is **derived client-side** from the OHLCV already on the chart (`chart/event-reaction.ts`) — no endpoint. Fields go `null` rather than wrong when the window runs off either edge of the loaded period.
- **Upcoming events** (`upcoming: true`) have no bar to sit on. `placeEvents()` anchors them on the last bar with `future: true` + `daysAhead` (dropped past `MAX_FUTURE_DAYS` = 200); the rail queues them past the right edge with a dashed chip (`$?` / `E?`), and the popover shows "Scheduled — no price reaction yet".
- `label` (`$` / `$?` / `E+` / `E-` / `E?` / `x10`) is no longer drawn on the rail — since 2026-08-31 chips carry a `lucide` icon (`EventChipStyle.icon`, see `chart/event-icons.ts`) and `label` survives as the accessible name for it.

## Market State (`GET /api/market-state/AMD`)

```jsonc
{
  "symbol": "AMD", "status": "ok", "as_of": "2026-09-11", "bars": 4118, "period": "10y",
  "basis": {                       // ⚠️ read this before quoting any number below
    "labels": "causal — filtered posterior, no bar uses data after itself",
    "parameters": "in-sample — the model is fitted on the whole history",
    "claim": "Describes what state the symbol is in. For what FOLLOWS a state, use the validation endpoint"
  },
  "regime": {
    "key": "quiet", "label": "QUIET RANGE", "color": "#5c9ead",
    "probability": 0.9892, "confidence": "clear",   // clear ≥0.75 · leaning ≥0.50 · unclear below
    "bars_in_state": 8, "expected_duration": 28.4,  // 1/(1−p_ii) from the transition matrix
    "states": [ { "key", "label", "color", "blurb", "probability", "expected_duration", "share" } ],
    "transition_note": "Quiet Range gaining (19% → 99% over 10 bars), Turbulent giving way (73% → 0%)"
  },
  "scores": {
    "trend":      { "score": -0.415, "change": 0.142, "word": "Bearish", "direction": "Rising" },
    "momentum":   { "score": 0.182, "change": 0.525, "sign": "Positive", "word": "Accelerating" },
    "volatility": { "sigma": -0.68, "change": 0.615, "level": "Normal", "direction": "Expanding" }
  },
  "summary": "Quiet Range 99% — Bearish Trend Rising — Positive Momentum and Accelerating — Volatility Expanding",
  "vector": { "regime_probability": {"bull":0.0,"sideway":0.011,"quiet":0.989,"turbulent":0.0},
              "trend": -0.415, "momentum": 0.182, "volatility": -0.68 },
  "history": { "times": [...], "close": [...], "state": [2,2,3,...],   // int index into regime.states
               "posterior": [[0.0,0.01,0.99,0.0], ...],                 // n × k, never smoothed
               "trend": [...], "momentum": [...], "volatility": [...],
               "trend_change": [...], "momentum_change": [...], "volatility_change": [...] },
  "strategy": { "horizon": 10, "state_bars": 565, "state": "quiet", "state_label": "QUIET RANGE",
                "basis": "in-sample state labels — descriptive, not a backtest",
                "items": [ { "id": "trend_following", "name", "metric", "value", "baseline": 0.5,
                             "detail", "score": 53.0, "edge": 0.0072, "n": 556, "z": 0.34,
                             "reliable": true } ] },
  "diagnostics": { "redundancy": { /* see below */ }, "model": { "family": "gaussian_hmm", "n_states": 4,
                   "covariance": "full", "features": [...], "dropped_features": [],
                   "hysteresis": 3, "state_labels": [...], "expected_durations": [...],
                   "transition_matrix": [[...]] } }
}
```

- `history.state` indexes `regime.states`; `history.posterior[i][k]` is the probability of
  `regime.states[k]` at bar i. The two are in **canonical archetype order**
  (bull → sideway → quiet → bear → turbulent), never in hmmlearn's arbitrary state order.
- `status` is `"insufficient"` with a `detail` string (and nothing else) for a symbol with under
  300 usable bars — SKHY returns exactly that. The panel renders `detail`; a component that assumes
  the other fields exist crashes instead of explaining.
- `vol_z` is dropped from `features` for a symbol that reports no volume (an index, a yield, an FX
  cross). Four features remain; `diagnostics.model.dropped_features` names it.

### Redundancy report (`diagnostics.redundancy`)

```jsonc
{
  "status": "ok", "bars": 2106, "threshold": 0.80, "max_model_abs_corr": 0.491,
  "model_features": ["ret_z","slope_z","mom_delta","rvol_z","vol_z"],
  "vif": { "ret_z": 2.17, "slope_z": 1.76, "mom_delta": 1.91, "rvol_z": 1.04, "vol_z": 1.07 },
  "matrix": { "names": [...12 candidates...], "values": [[...]] },
  "model_matrix": { "names": [...5...], "values": [[...]] },
  "redundant_pairs": [ { "a": "ret_z", "b": "rsi", "r": 0.877, "both_in_model": false } ],
  "rejected_vs_model": [ { "feature": "rsi", "closest_model_feature": "ret_z", "r": 0.877,
                           "verdict": "redundant", "reason": "..." } ]
}
```

⚠️ `verdict` has exactly two values and they mean different things: **`"redundant"`** is measured
(|r| ≥ 0.80 with a feature already in the model — RSI↔ret_z 0.88, MACD-hist↔mom_delta 0.82,
vol_chg↔vol_z 0.85), while **`"same axis, kept out for parsimony"`** is a judgement — ATR%, Bollinger
width, high-low range and ADX correlate 0.35-0.75 and are *not* duplicates; they are excluded because
a 4-state full-covariance fit already estimates 60 covariance parameters on 5 features. The
DIAGNOSTICS tab prints both so the choice can be argued with.

## Market State validation (`GET /api/market-state/AMD/validation`)

```jsonc
{
  "status": "ok",
  "method": { "refits": 25, "failed_fits": 0, "step": 126, "embargo": 21, "min_train": 500,
              "labelled_bars": 3093, "total_bars": 3614, "n_states": 4, "min_state_bars": 100,
              "overlap_note": "...raw Welch t is inflated by roughly √horizon...",
              "note": "...a residual input overlap remains inside that embargo..." },
  "forward_returns": [ { "state": "turbulent", "label": "TURBULENT", "horizon": 10, "n": 666,
                         "mean_pct": 0.317, "median_pct": 0.432, "hit_rate": 0.518, "vol_pct": 11.06,
                         "baseline_pct": 1.565,
                         "t_vs_rest": -3.39,   // raw Welch t — INFLATED by overlapping windows
                         "t_adj": -1.07,       // ÷√horizon — the one the verdict uses
                         "counts": true } ],   // false when n < min_state_bars
  "separation_pct": { "5": 3.6, "10": 3.97, "21": 8.69 },
  "strategy_by_state": [ { "state", "label", "bars", "best", "best_score", "best_z", "items": [...] } ],
  "verdict": { "states_separate": false, "separating_states": [],
               "strategy_choice_varies": true, "strategy_edge_significant": false,
               "reading": "Forward returns do not separate, yet the best-scoring strategy differs..." }
}
```

⚠️ **`t_adj`, not `t_vs_rest`, is the number that means anything.** Forward returns measured every
bar over an h-bar horizon share h−1 bars with their neighbours, so the raw Welch t is inflated by
≈√h. Measured on AMD, TURBULENT at h=10 goes from t=−3.39 (looks significant) to t_adj=−1.07 (is
not). The verdict ignores raw t entirely and also ignores any state with fewer than
`min_state_bars`=100 labelled bars.

### `VolumeEvent` (`lib/volume-events.ts`)
```ts
type VolumeEventType = "climax" | "absorption" | "vacuum" | "breakout" | "noDemand" | "dryUp";
interface VolumeEvent {
  index: number;            // bar index in the array that was classified
  time: string | number;    // same shape as OhlcvBar.time
  type: VolumeEventType;
  dir: 1 | -1 | 0;          // which side OWNED the bar — never a forecast. climax/vacuum/breakout: sign
                            // of the bar's return. absorption: +1 = close held the upper half (selling
                            // absorbed). noDemand/dryUp: 0, nothing was decided
  z: number;                // robust log-volume z-score (lib/volume-stats.ts)
  retSigma: number;         // the bar's log return in units of its trailing return σ (centred on ZERO,
                            // not on the sample mean — a drifting mean re-bases "big" inside a trend)
  retPct: number;           // the bar's return, %
  closePos: number;         // 0 at the low, 1 at the high; 0.5 for a zero-range bar
  close: number;
  runLength?: number;       // dryUp only — bars in the run
}
```
- **Derived entirely client-side** from the OHLCV already on the chart — no endpoint, nothing cached.
  `classifyVolumeEvents(bars)` with defaults is called in two places (the overlay and the panel) and
  they agree because both use the same defaults, not because anything is passed between them.
- One label per bar. Priority `climax > vacuum > breakout > absorption > noDemand`; `dryUp` is
  run-based, emitted at the run's **end** and only onto a bar nothing else claimed.
- `forwardReturnPct(bars, i, h)` returns **null** past the loaded data, deliberately — the newest
  events have no outcome yet, and a 0 there would bias every eye that read the table.
- No reading exists for the first ~8 bars (`MIN_SAMPLES`) or for a symbol whose volume is 0 on every
  bar (VIX, yields, FX): `volumeZ` is null there and the classifier emits nothing.

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


## Bollinger chart fitting — frontend only (2026-09-13)

No endpoint or backend response changes. Existing `IndicatorSpec` persists these optional scalar params in `chart:indicator-specs`:

```ts
{ id: "bollinger" | "bollinger-b", params: {
  period: 20, stdDev: 2,        // preserved manual settings, period follows BARS/DAYS
  fitMode: "manual" | "sharpe", // absent means manual
  fitCostBps: 5                 // per-side proportional cost, 0..100 bps
} }
```

Runtime-only types from `components/bloomberg/chart/bollinger-fit.ts`:

```ts
interface BollingerStats {
  middle: (number | null)[]; deviation: (number | null)[];
}
interface BollingerBacktest {
  sharpe: number | null; // per bar, sample SD, rf=0; null if undefined
  totalReturn: number;   // fractional compounded net price return
  trades: number;        // completed exits, including forced end-of-window liquidation
  bars: number; returns: number[]; // includes flat/cash bars
}
interface BollingerFitCandidate {
  period: number; stdDev: number; train: BollingerBacktest;
}
interface BollingerFitResult {
  status: "ok" | "unavailable"; reason?: string;
  best: BollingerFitCandidate | null; holdout: BollingerBacktest | null;
  candidates: number; eligible: number;
  trainStart: number; split: number; end: number; // indices; end is exclusive
}
```

`ChartIndicator.config.inputParams` is transient raw user input injected during instantiation, for reopening settings without treating DAYS-scaled bar counts as user-entered days. The effective fitted period is always raw bars. UI falls back to saved manual settings with an explicit unavailable status; no fit result is persisted or transferred into alert rules.


## ATR accumulation pane — frontend only (2026-09-13)

No API/DB shape changes. Optional persisted `IndicatorSpec` uses existing `chart:indicator-specs` storage:

```ts
{ id: "atr-regime", params: {
  period: 14, lookback: 50, maxRatio: 1,
  trendPeriod: 50, slopeBars: 5, display: "percent"
} }
```

`display` is `percent` or `absolute`. Window params use the global BARS/DAYS input unit and are converted to bars before computation; `maxRatio` never scales. Transient `ChartIndicator.config.inputParams` preserves raw settings for gear edits. Runtime types from `components/bloomberg/chart/indicators/atr.ts`:

```ts
interface AtrRegimeConfig {
  period: number; lookback: number; maxRatio: number;
  trendPeriod: number; slopeBars: number;
  display: "percent" | "absolute";
}
interface AtrRegimePoint {
  time: string | number;
  atr: number | null; atrPercent: number | null;
  baselinePercent: number | null; thresholdPercent: number | null;
  thresholdAbsolute: number | null; ema: number | null;
  lowVolatility: boolean | null; uptrend: boolean | null;
  state: "accumulate" | "avoid" | "unknown";
}
```

Percent values are percentage points (1 = 1%), not fractions. `baselinePercent` excludes the current bar. `thresholdPercent = baselinePercent × maxRatio`; `thresholdAbsolute = thresholdPercent × close / 100`. Null means unavailable; complete zero-baseline history also yields unknown classification. These diagnostics are derived locally and not persisted.

`components/bloomberg/chart/types.ts` additionally defines native line point colors and explicit missing points:

```ts
interface SeriesDataPoint { time: string | number; value: number; color?: string }
interface WhitespaceDataPoint { time: string | number; value?: never }
// IndicatorSeriesOutput.data:
// (SeriesDataPoint | HistogramDataPoint | WhitespaceDataPoint)[]
```

The ATR factory returns `atr-regime-line` and `atr-regime-threshold` line series on the same pane/scale. A missing value is `{time}`, never zero. Native lines still connect valued points across whitespace, so the last valued point before a gap gets `color: "transparent"` to suppress its outgoing segment on both lines.


## MKT IV Smile runtime types — 2026-09-13

`components/bloomberg/lib/iv-smile.ts` describes the consumed chain subset, chart rows and optional fit response. No new persisted schema:

```ts
interface IvSmileOption {
  contractSymbol?: string;
  strike: number; impliedVolatility: number; // fractional IV
  openInterest?: number | null;
  openInterestAvailable?: boolean;
  bid?: number | null; ask?: number | null;
}
interface IvSmileChain {
  symbol: string; spot: number; expiry: string; expirations: string[];
  calls: IvSmileOption[]; puts: IvSmileOption[];
  freshness?: { source: string; fetched_at?: string; delay_minutes?: number; is_realtime?: boolean };
}
interface IvSmilePoint {
  strike: number; callIV: number | null; putIV: number | null; // percentage points
}
interface IvSmileOiPoint {
  strike: number; callOI: number | null; putOI: number | null; // contract counts
}
```

`buildIvSmile` returns `{points, callCount, putCount, strikeCount, excluded, sufficient}`; numeric ascending union of strikes preserves put-only contracts and missing IV in either side. `excluded` counts rows inside the selected strike range rejected for unusable IV or the active quote filter. `sufficient` requires >=3 distinct valid strikes.

`buildIvSmileOi(chain,rangePercent=25)` returns `{points:IvSmileOiPoint[],callTotal:number|null,putTotal:number|null,missing:number,available:boolean,putCallRatio:number|null}`. Independent of IV and bid/ask filters; only selected K range applies. Deduplicate contractSymbol per side (fallback side+strike), sum distinct contracts at same strike. A known0 stays0; unknown/invalid OI staysnull; partial totals are labeled and P/C suppressed if missing or callTotal<=0. P/C is Put OI / Call OI across the selected strike range for one expiry, not a directional signal. `smilePlotRows(series,fitted,oiPoints?)` adds exact-strike `callOI`/`putOI` fields and unions known OI-only strikes; interpolated SVI grid rows have null OI.

Backend chain rows now add `openInterestAvailable:boolean` without changing legacy numeric `openInterest`/aggregate fields. Cleaner flags source missing/invalid before zero-fill; valid finite nonnegative safe integers include0. New frontend can still read older rows without the flag by validating `openInterest` (prior cached zero-fill cannot reconstruct missingness; cache refresh supplies the flag). OI as-of date is not supplied: fetched-at is retrieval time, and OI is latest reported, not live flow or stored daily history.

`IvSmilePanelProps` in `views/iv-smile-panel.tsx` contains `model: ReturnType<typeof useIvSmile>`, terminal `colors` and optional `compact`. `SectorRegimeHeatmapProps` now accepts optional `symbol: string|null` from the main MKT chart. Existing `bloomberg_regime_defaults.mode` additionally accepts `iv`; expiry/range/quote selection is component state shared with the expanded panel, not a new storage key.

### Raw SVI fit / tenor types and API

`POST /api/options/smile-fit` (Next.js and Python path) accepts `{referencePrice:number, timeYears:number, series:Array<{name:"call"|"put"|"otm", points:SviSample[]}>}`. Input IV is percentage units (30 means30%, not0.30); each fit models total variance `w=(ivPercent/100)^2*timeYears`. Payload limits and errors are in `api-endpoints.md`.

```ts
type SmileSide = "both" | "otm" | "call" | "put";
type SmileFitMode = "observed" | "raw_svi";
interface SviSample { strike: number; ivPercent: number }
interface RawSviParameters { a: number; b: number; rho: number; m: number; sigma: number }
interface RawSviFit {
  status: "ok" | "unavailable";
  reason: string | null;
  parameters: RawSviParameters | null;
  rmseIvPct: number | null; // Root mean squared IV error, percentage points
  usedPoints: number; // distinct usable strikes after duplicate medians
  minStrike: number | null; maxStrike: number | null;
  referencePrice: number; timeYears: number;
}
interface SviFitResponse {
  model: "raw_svi"; coordinate: "log(K/S)"; objective: "soft_l1_total_variance";
  series: Partial<Record<"call" | "put" | "otm", RawSviFit>>;
}
interface SmileTenor { months: number[]; expiry: string | null; days: number | null }
```

Successful HTTP200 can contain unavailable series (too few strikes, narrow coverage, no convergence), always with `parameters:null` and `reason`. `a` may be negative: the constrained minimum is `a+b*sigma*sqrt(1-rho²)>0`. These are independent slices, not an arbitrage-free surface. `smileTenorDate` uses calendar months; `selectSmileTenors` merges months sharing one expiry, or returns null expiry/DTE for an unavailable target. `smileSamples` returns named observed series by side. `smilePlotRows` returns shared numeric strike rows with dynamic `<id>_observed` and `<id>_fit` fields (missing/null, never zero-filled); `sviIvAtStrike` returns percent IV only within each fit's observed K span.

## Symbol classification (`GET /api/stock/sector/{symbol}`) — 2026-09-22

```jsonc
{
  "symbol": "CPALL.BK",
  "sector": "Consumer Defensive",       // raw provider sector (kept for back-compat)
  "industry": "Grocery Stores",
  "sector_raw": "Consumer Defensive",   // same values, named so the mapping is legible
  "industry_raw": "Grocery Stores",
  "quote_type": "EQUITY",
  "asset_class": "equity",  // equity|etf|fund|crypto|fx|index|future|option|dw|warrant
  "set_sector": "COMM",     // SET code   — TH accounts (TH_SECTORS)
  "us_sector": "Consumer Staples"  // GICS label — USD accounts (US_SECTORS)
}
```

`set_sector` / `us_sector` are **never null** — undecidable resolves to `"Other"`. The two lists
overlap only on `ETF` and `Other`, so a caller can take the first of `[set_sector, us_sector]`
that its own list contains and be unambiguous. `asset_class` is what settles the rows that have
no sector at all: an ETF, a coin, a Thai DW (`BBL13C2512A`) or warrant (`PTT-W1`).
Source: `backend/sector_map.py` (`classify()`), tests in `tests/test_sector_map.py`.

## `POST /api/v2/portfolio/sell` response — 2026-09-22

```jsonc
// partial
{ "ok": true, "action": "partial_sell", "avg_cost": 1616.2403,
  "sold_trade_id": "...", "remaining_trade_id": "...",
  "sold_volume": 1.5923943, "remaining_volume": 4.4628775,
  "pnl_amount": 217.15, "pnl_percent": 8.44, "win_loss": "W" }
// full
{ "ok": true, "action": "full_sell", "avg_cost": 1616.2403, "trade_id": "...",
  "pnl_amount": 185.82, "pnl_percent": 8.44, "win_loss": "W" }
```

`avg_cost` is the pooled average the sale was priced at **and** the value written into
`price_entry` on the closed row and on every lot still open for that account+symbol. Read it when
you need to show the user what the position's ENTRY became.
