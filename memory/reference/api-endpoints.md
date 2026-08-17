# API Endpoints Reference

> All Python FastAPI routes. Next.js proxies all requests — browser never hits :8000 directly.
> **See also:** [data-shapes.md](data-shapes.md) — response JSON shapes | [architecture.md](architecture.md) — router table + analytics folder | [frontend-structure.md](frontend-structure.md) — proxy route file locations | [gotchas.md](gotchas.md) — error dictionary + anti-patterns

---

## Market / Heatmap (`routers/market.py`)
- `GET /api/market-data` — 19 global indices (Americas/EMEA/Asia), 60s cache
- `GET /api/heatmap` — sectors, commodities, bonds, indicators heatmap groups

## Stock (`routers/stock.py`)
- `GET /api/stock/search` — ticker autocomplete
- `GET /api/stock/quote/{symbol}` — real-time quote
- `GET /api/stock/history/{symbol}` — OHLCV history (1d/1w/1m/3m/ytd/1y/5y/max)
- `GET /api/stock/financials/{symbol}` — income statement + cash flow
- `GET /api/stock/analyst/{symbol}` — analyst ratings
- `GET /api/stock/earnings-calendar/{symbol}` — earnings dates + EPS estimate/reported/surprise%
- `GET /api/stock/pe-history/{symbol}` — trailing (TTM) P/E weekly series (adj-EPS) + percentile stats + earnings list; cache 1h. Next.js proxy: `type=pe-history`

## Options (`routers/options.py`)
- `GET /api/options` — options chain (calls + puts)
- `GET /api/options/surface` — implied volatility surface
- `GET /api/options/positions/list` — list option positions
- `POST /api/options/positions` — add position (underlying, expiry, strike, type, qty, entry_price)
- `POST /api/options/positions/seed-demo` — insert 6 demo positions
- `DELETE /api/options/positions/demo/clear` — delete demo positions
- `DELETE /api/options/positions/{id}` — delete one position
- `PATCH /api/options/positions/{id}/close` — mark closed
- `GET /api/options/positions/{id}/quote` — live price
- `GET /api/options/positions/{id}/greeks` — BS + Adj Greeks (delta/gamma/theta/vega/rho + GC fat-tail)
- `GET /api/options/greeks/portfolio` — portfolio-level aggregates

**DataFreshness:** Yahoo Finance ~15min delay. All delayed values show yellow `⏱ ~15m delay` badge.  
**Provider swap:** Change 1 line in `routers/options.py:26` to swap data source.  
**Greeks engine:** `backend/greeks.py` — Black-Scholes + Gram-Charlier (Corrado-Su 1996). See `memory/reports/options-greeks-math-report.md`.

## Pins / Watchlist (`routers/pins.py`)
- `GET/POST /api/pins/groups` — list / create pin groups
- `GET/PATCH/DELETE /api/pins/groups/{id}` — manage a group
- `GET/POST /api/pins/assets` — list / add pinned asset
- `PATCH/DELETE /api/pins/assets/{id}` — update / remove
- `GET/POST /api/pins/tags` — list / create tags
- `POST /api/pins/assets/{id}/tags/{tagId}` — tag an asset
- `DELETE /api/pins/assets/{id}/tags/{tagId}` — untag
- `DELETE /api/pins/tags/{tagId}` — delete tag
- `POST /api/pins/import` — bulk import

## Clippings + AI (`routers/clippings.py`)
- `GET /api/clippings` — list .md files with YAML frontmatter
- `GET /api/clippings/content` — full content of one file
- `POST /api/clippings/ai` — Ollama SSE stream (summarize/translate/custom)
- `GET /api/clippings/ai/models` — list Ollama models

## News (`routers/news.py`)
- `GET /api/news/facebook` — posts from Facebook pages (RSSHub or Graph API)
- `GET /api/news/feed?topics=&limit=` — topic newswire (yfinance Search + 5 curated RSS)

## Watchlist News (`routers/news_watchlist.py`)
- `GET /api/news/watchlist?symbols=&per_symbol=6&per_source=6&sources=all&polymarket=1`
  - per-symbol headlines from 7 free sources: `yahoo` (ticker RSS) · `yfinance` (yf.Search) ·
    `google` (News RSS) · `bing` (News RSS) · `seekingalpha` · `nasdaq` · `sec` (EDGAR 8-K atom)
  - sector/company resolved from SQLite `sector_classifications` → yfinance info (24h cache;
    unresolved retried after 10 min). Crypto/FX → "Crypto / FX", `^` → "Index", else "Unclassified"
  - keyword sources are filtered to headlines that actually name the ticker/company;
    every article carries `relevance: direct|feed` so the UI can hide wire noise
  - cross-tags other watchlist names found in a headline (`symbols[]`), keyword sentiment,
    plus Polymarket markets matched on the **question text only** (word-boundary)
  - caches: meta 24h · per-symbol news 5 min · polymarket match 15 min
- `GET /api/news/sources` — source registry (id/label/kind) for the UI toggles

## Polymarket — single-name equity markets (`routers/polymarket_stock.py`)
- `GET /api/polymarket/stock/{symbol}?company=` — live price ladders for one ticker
  - discovery via Gamma **`/public-search?q=`** (真 server-side search; `/markets?q=` still ignores params)
  - keeps only `closed=false && endDate>now` events whose **title contains the ticker**
  - event types: `ladder` (touch: "What will MU hit in August") · `above` (CDF: "close above ___")
    · `updown` (daily) · `earnings` · `other`
  - summary: `prob_up` (updown → CDF interpolation at spot → nearest up rung), `prob_above_spot`,
    `nearest_up`/`nearest_down` (each tagged `basis: close|touch`), `implied_high`/`implied_low`,
    `skew`, `horizon_days`
  - caches: events 90s (prices move) · spot 60s · **miss 15 min** (most tickers have no markets)
- `GET /api/polymarket/stocks?symbols=A,B` — summary-only per symbol (MKT watchlist PM column)

## Company filings — SEC EDGAR (`routers/company_filings.py`)
US listings only (EDGAR ไม่มี `.BK`/`.KS` → ใช้ `routers/sec_v2.py` + `SEC_*` key แทน). ไม่ต้องมี key
แต่ต้องส่ง UA แบบ `App/1.0 email` (มีวงเล็บ = 403) และไม่เกิน 10 req/s
- `GET /api/company/filings/{symbol}?forms=10-K,10-Q,8-K&limit=20` — จาก `data.sec.gov/submissions/CIK…json`
- `GET /api/company/outlook/{symbol}` — **guidance + วิสัยทัศน์ CEO**
  - หา 8-K item **2.02** ล่าสุด → เลือกไฟล์ใน folder ที่ "อ่านแล้วเหมือน press release" ที่สุด
    (ชื่อไฟล์ต่างกันทุกบริษัท: `a2026q3ex991-pressrelease.htm`, `q1fy27pr.htm`) ด้วย `_release_score`
  - `guidance.metrics` = revenue / gross_margin / operating_expenses / eps / operating_margin
    (flatten ตาราง HTML ก่อน regex; heading เข้ม "Business Outlook" ก่อน ไม่งั้นไปแมตช์ประโยค CEO)
  - `ceo_quotes[]` = คำพูดที่ attribute ถึง CEO ทั้งสองรูปแบบประโยค
  - `mdna.statements[]` = ประโยค forward-looking จาก 10-Q/10-K (ตัด safe-harbour + ASU/FASB ทิ้ง)
- `GET /api/company/xbrl/{symbol}?period=quarterly|annual&limit=12` — as-reported จาก
  `data.sec.gov/api/xbrl/companyconcept`; margin คำนวณเอง; กรองช่วงเวลา 3 เดือน/12 เดือน
  (cash-flow tag บางบริษัทเป็น YTD → บางไตรมาสจะว่าง)
- cache: CIK map 24h · filings 6h · outlook 6h · xbrl 24h
- Next proxy: `app/api/company/[...path]/route.ts` (allowlist: outlook/filings/xbrl)

## Macro (`routers/macro.py`)
- `GET /api/macro` — FRED series (GDP, CPI, unemployment, yields, etc.) + AV fallback
  - 2-layer cache: in-memory (5 min) + disk JSON per series (release-frequency TTL: 1d–30d)
- `DELETE /api/macro/cache` — force refresh

## Crisis / Stress Indicators (`routers/crisis.py`)
- `GET /api/crisis` — credit/stress indicators → crisis level 0-3 (uses FRED)
  - Signals: HY spreads, IG spreads, VIX, yield curve, TED spread

## Sovereign Data (`routers/sovereign.py`)
- `GET /api/sovereign/list` — list tracked countries
- `GET /api/sovereign/{code}` — World Bank indicators (GDP, inflation, debt, etc.)

## Portfolio v1 (`routers/portfolio.py`)
- `GET /api/portfolio/theses` — list investment theses (.md from THESES_DIR)
- `GET /api/portfolio/thesis` — content of one thesis
- `GET /api/portfolio/research` — research articles from SOURCES_DIR
- `GET/POST /api/portfolio/db/transactions` — list / add transactions
- `PATCH/DELETE /api/portfolio/db/transactions/{id}` — update / delete
- `GET /api/portfolio/db/holdings` — computed holdings (avg cost method)
- `POST /api/portfolio/db/import` — bulk import CSV

## Portfolio v2 (`routers/portfolio_v2.py`)
- `GET /api/v2/portfolio/resolve-symbol?q=X&account_id=Y` — resolve bare ticker → canonical provider symbols, filtered to account's markets (`markets` JSON col; default US+TH, crypto→CRYPTO); returns `{query, markets, matches:[{resolved_symbol, market, currency, name, exchange}]}`; TTLCache 1h, home-country ranked first (`plans/port-redesign.md` Step 1)
- `GET /api/v2/portfolio/accounts` — list accounts (no default seed; users create their own)
- `POST /api/v2/portfolio/accounts` — create account (id, name, country, currency, account_type)
- `PATCH /api/v2/portfolio/accounts/{id}` — update name/broker/is_active
- `DELETE /api/v2/portfolio/accounts/{id}` — delete account (409 if it has trades; also clears its cash/dividends)
- `GET /api/v2/portfolio/trades` — trade log (filter by account/symbol/`is_reinvest`); optional `base_currency=THB|USD` adds historical `amount_base`, `price_entry_base`, `price_exit_base`, `pnl_base`
- `POST /api/v2/portfolio/trades` — add trade; accepts resolver `resolved_symbol`/`market`/`currency`; persists authoritative instrument currency plus entry `exchange_rate` (THB per native unit)
- `PATCH /api/v2/portfolio/trades/{id}` — edit trade (optional `adjustment_reason` field → audit log only, not stored in trades table)
- `DELETE /api/v2/portfolio/trades/{id}` — delete trade (auto-logs to audit before delete)
- `GET /api/v2/portfolio/trades/{id}/audit-log` — immutable change history for one trade
- `GET /api/v2/portfolio/audit-log` — recent changes across all trades (filter: account_id)
- `PATCH /api/v2/portfolio/trades/bulk-patch-sector` — bulk sector override
- `GET /api/v2/portfolio/premarket?account_id=X` — pre-/post-market session quotes for open positions, keyed by bare symbol. Uses `.info` (heavier than fast_info) so it's a SEPARATE background fetch, NOT part of open-positions. Returns `{quotes: {SYM: {market_state, regular_price, pre_price, pre_change, pre_change_pct, post_price, post_change, post_change_pct}}}`. `*_change_pct` derived from change/reference (scaling-agnostic). US concept — .BK rows return empty. 30s TTLCache. Frontend: OpenPositionsTab **auto** PRE/POST column — injected after CURRENT only while ≥1 position is in a live PRE/POST session, collapses on its own when session ends. NOT a user-toggled col (excluded from ALL_COLS/COLS picker; type `DisplayCol = ColName | "PRE/POST"`).
- `GET /api/v2/portfolio/open-positions` — open positions with live prices; `base_currency` adds `cost_basis_base`, `market_value_base`, `unrealized_pnl_base`, `day_pnl_base`; `currency`/`pos_currency` are instrument currency
- `GET /api/v2/portfolio/summary` — account/global summary; `total_pnl_base` remains broker-style realized trading P&L, while `total_economic_pnl_base` adds principal FX attribution as a separate FX-inclusive estimate
- `GET /api/v2/portfolio/analytics` — P&L breakdowns; aggregate rows include `pnl` (broker-style realized) plus `economic_pnl` (entry/exit FX two-leg economic attribution); also returns `trade_stats` + `trade_stats_by_account` (win rate, W/L ratio, avg win/loss, payoff, expectancy — closed trades, in `base_currency`)
- `POST /api/v2/portfolio/sell` — sell (partial or full); captures `exit_exchange_rate` at exit date
- `GET /api/v2/portfolio/dividends` — dividend history; optional `base_currency` adds dated `amount_per_unit_base`, `total_received_base`, `reinvested_amount_base`
- `POST /api/v2/portfolio/dividends` — add dividend with record-level `currency`
- `DELETE /api/v2/portfolio/dividends/{id}` — delete dividend
- `POST /api/v2/portfolio/import` — bulk import Excel
- `GET /api/v2/portfolio/returns` — cost-based annualized returns: CAGR (time-weighted growth of deployed cost) + XIRR (money-weighted IRR from dated cashflows: buys−/sells+/divs+/mark-to-market+). Per-account + total. Params: `account_id`, `base_currency`. NOT the same as CAPM RET ANN (which is market-price, cost-agnostic).
- `GET /api/v2/portfolio/cash` — cash ledger entries (filter `account_id`); rows include `entry_type` (`CASH`|`TRANSFER`), `linked_id`
- `POST /api/v2/portfolio/cash` — add manual cash entry (`entry_type` defaults `'CASH'`)
- `PUT /api/v2/portfolio/cash/{id}` — edit cash entry
- `DELETE /api/v2/portfolio/cash/{id}` — delete cash entry; if `entry_type='TRANSFER'`, cascades to delete the linked pair (matched by `linked_id`)
- `GET /api/v2/portfolio/allocation-detail?account_id&base_currency` — ALLOCATION (OPEN) on two bases: per symbol + per sector `cost_base` (entry FX) vs `market_value` (live FX), `growth_pct`, `unrealized`, `weight_cost_pct`/`weight_mv_pct`/`drift_pp`, `contrib_growth_pct`, `share_of_gain_pct`, plus rebalance sizing (`target_pct`, `target_source` explicit|cost_weight, `delta_value`, `delta_shares` lot-rounded TH=100/US=1, `est_value`, `est_realized`, `in_band`, `action`). Applies `position_cost_overrides` so growth matches the positions table. Reuses `_open_positions_enriched()` (shared with `/open-positions`)
- `GET /api/v2/portfolio/allocation-targets?account_id` — target weights (account-specific row beats the `all` default)
- `PUT /api/v2/portfolio/allocation-targets` — bulk upsert `[{account_id, scope sector|symbol, key, target_pct, band_pct}]`; `target_pct<=0` deletes the row; 400 if a scope's targets sum >100
- `POST /api/v2/portfolio/cash/transfer` — atomic linked-pair transfer between own accounts: inserts 2 `TRANSFER` rows (source `investment=-amount`, dest `investment=+amount`), nets to 0 on `account_id='all'`, fixes per-account `invested_capital` without touching NAV (`plans/completed/cash-transfer-feature.md`)

## Theses (`routers/theses.py`) — prefix `/api/v2/theses`
DB-backed investment theses. `theses` = materialised head (field-level LWW merge); `thesis_events` = append-only history (never UPDATEd → no merge conflicts). Cloud-synced via `SYNC_TABLES`.
- `GET /api/v2/theses?symbol&category&status&account_id&include_deleted` — list + `event_count`
- `GET /api/v2/theses/{id}` — `{thesis, events, links}` (links join `trades`)
- `GET /api/v2/theses/by-symbol/{symbol}` — theses for one ticker
- `GET /api/v2/theses/summary/by-symbol` — `{by_symbol: {SYM: {count, status, conviction, id}}}`, one query for the whole book (positions-table badge)
- `POST /api/v2/theses` — create → event `CREATED`
- `PATCH /api/v2/theses/{id}` — update; diffs first, logs `EDITED`/`STATUS_CHANGED`/`TARGET_CHANGED`/`INVALIDATED` with `{field:{from,to}}`; body-only `note` logs `NOTE` without touching the head
- `DELETE /api/v2/theses/{id}?purge=false&note=` — soft delete (UPDATE → **no tombstone**, restorable on both devices); `purge=true` is the real DELETE and does emit one
- `POST /api/v2/theses/{id}/restore`
- `GET|POST /api/v2/theses/{id}/events` — timeline; POST adds a manual `NOTE` (`occurred_at` may be back-dated)
- `DELETE /api/v2/theses/{id}/events/{event_id}` — NOTE events only (400 otherwise — edits are the record)
- `POST /api/v2/theses/{id}/links` / `DELETE .../links/{trade_id}` — link a thesis to a trade
- `POST /api/v2/theses/import-md?dry_run` — import `THESES_DIR/*.md`; keyed on `source_file` so re-running never duplicates
- `POST /api/v2/theses/{id}/export-md` — write markdown back to `THESES_DIR` (Obsidian); DB stays authoritative

## Portfolio Risk (`routers/risk.py`)
- `GET /api/v2/portfolio/risk/metrics` — VaR/CVaR 1D–6M with √T scaling (Basel)
- `GET /api/v2/portfolio/risk/capm` — `α = Rp − [rf + β(Rm − rf)]` โดย `Rp` = CAGR/XIRR จาก `/returns` (ช่วงของบัญชีเอง), `Rm` = benchmark ช่วงเดียวกัน (`_index_return`, แปลงเป็นสกุลรายงาน), `β` = Σwᵢβᵢ ของที่ถือวันนี้ — **ไม่มีตัวไหนอ่าน `date_entry`/`date_exit`**. Fields: `beta`/`beta_local`/`hedge_notional`/`market_value` · `return_annual_pct`/`return_xirr_pct`/`holding_days`/`first_date` · `index_annual_pct`/`index_cumulative_pct` · `expected_annual_pct` · `alpha_annual_pct`/`alpha_xirr_annual_pct`/`excess_vs_index_pct` · `r_squared`/`benchmark_fit` (WEAK เมื่อ R²<0.10) · `excluded_symbols` (ประวัติ <60 แท่ง). Params: `benchmark`, `lookback`, `account_id`, `base_currency`, `rf_annual` (optional — ไม่ส่ง = ดึงสด: THB → BOT policy rate, USD → FRED `DGS3MO`, cache 12 ชม.; response มี `rf_source`/`rf_series`/`rf_as_of`/`rf_currency`).
- `GET /api/v2/portfolio/risk/correlation` — correlation matrix (Ledoit-Wolf shrinkage)
- `GET /api/v2/portfolio/risk/stress` — stress test scenarios
- `GET /api/v2/portfolio/risk/position-size` — Kelly criterion position sizing
- `GET /api/v2/portfolio/risk/parity` — Equal Risk Contribution (ERC) rebalance actions
- `GET /api/v2/portfolio/risk/risk-free?base_currency=` — อัตรา risk-free สดของทุกสกุลที่รองรับ (THB → BOT policy rate; USD → FRED `DGS3MO` แล้ว fallback `^IRX` ผ่าน yfinance ซึ่งไม่ต้องใช้ API key) + `alternatives[]` คืนทุกแหล่งที่ตอบเพื่อให้เทียบกันได้ พร้อม `source`/`series`/`as_of` + `fallback`; ใช้ป้อนแผงตั้งค่า rf ใน ANALYTICS (override เก็บที่ `localStorage["bloomberg_capm_rf"]` แยกตามสกุล)
- `DELETE /api/v2/portfolio/risk/cache` — clear caches

## Rates (`routers/rates.py`)
- `GET /api/rates/curve` — full US Treasury + JGB curves as flat tick rows for the MKT TICK DATA board.
  Returns `{us: Row[], jp: Row[], usError, jpSource: "mof"|"fred", jpStale, asOf}`; TTLCache 1h (MOF
  history file 24h). Proxy: `app/api/rates/route.ts` (45s timeout — cold cache = 11 FRED calls + 1.2 MB CSV).
  - **US** = FRED daily constant-maturity, 11 tenors `DGS1MO/3MO/6MO/1/2/3/5/7/10/20/30`.
    Needs `FRED_API_KEY`; without it `us: []` and `usError` carries the message.
  - **JP** = MOF CSV, 15 tenors 1Y–40Y. Two files: `.../interest_rate/jgbcme.csv` (current month, live
    values) + `.../interest_rate/historical/jgbcme_all.csv` (1974→, YTD baseline + sparkline). **The
    `/english/` path is required** — the Japanese path 404s with a 20 KB HTML page, so the parser
    rejects anything whose first line isn't `Interest Rate`. On failure it falls back to FRED
    `IRLTLT01JPM156N` (OECD monthly 10Y, one row) and sets `jpStale: true`.
  - Deliberately separate from `/api/macro/global-yields`, which owns the `table/curves/series` shape
    that MACRO [6] → YIELD renders. Do not merge them.
- `DELETE /api/rates/curve` — clear the cache

## FX (`routers/fx.py`)
- `GET /api/fx` — 20 major FX pairs overview (rate, day change)
- `GET /api/fx/history/{symbol}` — FX pair history

## Crypto (`routers/crypto.py`)
- `GET /api/crypto` — 20 crypto coins overview
- `GET /api/crypto/history/{symbol}` — coin history

## ETF (`routers/etf.py`)
- `GET /api/etf/{symbol}` — ETF info, top holdings, sector weights, country weights

## Order Footprint (`routers/footprint.py`)
- `GET /api/crypto/footprint` — Binance aggTrades → buy/sell volume per price level per candle

## Central Banks (`routers/central_banks.py`)
- `GET /api/central-banks/list` — list supported banks
- `GET /api/central-banks/rates` — policy rates from all banks (concurrent fetch)
- `GET /api/central-banks/{bank_id}/rate` — rate for one bank
- `GET /api/central-banks/ecb/hicp` — Euro Area CPI
- `GET /api/central-banks/ecb/yield-curve` — Euro Area yield curve
- `GET /api/central-banks/bundesbank/inflation` — Germany CPI
- `GET /api/central-banks/eurostat/energy-prices` — EU electricity prices
- `DELETE /api/central-banks/cache` — clear cache

## Polymarket (`routers/polymarket.py`)
- `GET /api/polymarket/signals` — all 8 signal types with implied probabilities (5-min cache)
- `GET /api/polymarket/signals/{type}` — single type: fed_rate, inflation, recession, global_rates, trade, economy, crypto, election
- `GET /api/polymarket/search?q=X` — free-text search on market pool
- `GET /api/polymarket/market/{slug}` — full detail for one market
- `GET /api/polymarket/latest` — most recent stored signal per type (DB read)
- `GET /api/polymarket/history` — historical signal readings
- `GET /api/polymarket/mcp` — structured agent output: prob, status, direction, implied_odds, regime_flag, delta_24h + schema field
- `POST /api/polymarket/refresh` — force refresh (bypass cache)
- `DELETE /api/polymarket/cache` — clear memory + pool cache

**Discovery:** Fetch up to 3,000 active markets (30 pages × 100) → client-side keyword phrase match.  
**CRITICAL:** `tag_slug`/`q`/`search`/`order` params silently ignored by Gamma API — filter client-side only.  
**Cold start:** ~15s (30 HTTP requests). Pool cached 10min.  
**Signal enrichment fields:** `delta_24h`, `direction` (UP/DOWN/STABLE ±2pp), `status` (LIKELY≥65%/UNCERTAIN/UNLIKELY≤35%), `implied_odds` (1/prob), `regime_flag` (HIGH_CONVICTION if |p-0.5|≥0.30), `event_slug` (for correct URL), `description` (300 chars).  
**URL pattern:** `https://polymarket.com/event/{event_slug}` — NOT market slug.  
**Δ24h:** null until backend runs ≥24h (needs SQLite history).

## Bank of Thailand (`routers/bot.py`)
Auth: static token in `Authorization` header (no "Bearer" prefix — IBM API Connect format). 4 separate tokens.

**Bond Auction** (`BOT_API_TOKEN`) — max 31 days per request:
- `GET /api/bot/auctions` — bond auction results (params: start_period, end_period yyyy-mm-dd)
- `GET /api/bot/auctions/raw` — raw response for debugging
- `DELETE /api/bot/cache` — clear all BOT caches

**Interest Rates** (`BOT_IR_TOKEN`):
- `GET /api/bot/rates` — summary all rate data
- `GET /api/bot/rates/policy` — Policy Rate + MPC decision text
- `GET /api/bot/rates/interbank` — O/N, T/N, Call rates
- `GET /api/bot/rates/thb-implied` — THB Implied Interest Rates (multiple tenors)
- `GET /api/bot/rates/swap-point` — FX Swap Points bid/offer

**Exchange Rates** (`BOT_FX_TOKEN`) — ⚠️ 403 until Stat-ExchangeRate/v2 activated in portal:
- `GET /api/bot/fx/daily` — daily average THB rates
- `GET /api/bot/fx/monthly` — monthly average THB rates

**Statistics** (`BOT_STATS_TOKEN`):
- `GET /api/bot/statistics/categories` — 389 statistical categories
- `GET /api/bot/statistics/series?category=CODE` — series in a category
- `GET /api/bot/statistics/search?keyword=TERM`
- `GET /api/bot/statistics/observations?series_code=CODE&start_period=DATE&end_period=DATE`

## Sector Classification (`routers/sectors.py`)
- `POST /api/sectors/fetch` — fetch Wikipedia constituents + classify via yfinance
- `GET /api/sectors/status` — coverage summary per country
- `GET /api/sectors/search?q=X&country=TH&limit=20`
- `GET /api/sectors/{country}` — all sectors ranked by market cap
- `GET /api/sectors/{country}/{sector}` — stocks in sector ranked by market cap
- `PUT /api/sectors/{symbol}/override` — manual sector override
- `DELETE /api/sectors/{country}` — clear classifications for a country

## SEC Thailand — Legacy (`routers/sec.py`) ⚠️ expires 2026-06-30
- `GET /api/sec/common/asset-types` / `alert-action-types`
- `GET /api/sec/fund/amc` — list all AMCs (บลจ)
- `GET /api/sec/fund/amc/{unique_id}` — funds under AMC
- `POST /api/sec/fund/search` — search fund by name
- `GET /api/sec/fund/{proj_id}/policy|investment|ipo|suitability|performance|dividend|fee|port/{period}|manager-history|history`
- `GET /api/sec/fund-daily/amc` / `GET /api/sec/fund-daily/{proj_id}/nav/{nav_date}`
- `GET /api/sec/health` — key status + expiry warnings

## SEC Thailand — New Portal (`routers/sec_v2.py`) — `SEC2_API_KEY`
52 routes total. Auth: `Ocp-Apim-Subscription-Key` header. Pagination: cursor-based (`page_size` max 100 + `next_cursor`).

**Bond v2:**
- `/api/sec/v2/bond/issuers|features|credit-ratings|outstanding-values|involve-parties|investor-holdings`

**Fund v2:**
- General info: `/api/sec/v2/fund/general-info/amcs|profiles|specifications|mutual-fund-fees|involve-parties`
- Factsheet: `/api/sec/v2/fund/factsheet/urls|ipos|benchmarks|subscription-redemption-minimums|periods|risk-spectrum|statistics|dividend-policy|fees|performance|asset-allocation|top5-holdings`
- Outstanding: `/api/sec/v2/fund/outstanding/portfolio|portfolio-asset-type`
- Daily: `/api/sec/v2/fund/daily-info/nav|dividend-history`

**One Report v1** (Gregorian year, language=T|E, unique_id from sbo/info):
- SBO: `sbo/{year}/info|rd|product-income|export-income|risk`
- Sustainability: `sustainability/{year}/detail|environment-issue|humanrights-issue`
- SCP: `scp/{year}/employee-info|employee-development|labor-dispute|csr-activity`
- CGP: `cgp/{year}/governance|director|code-of-conduct`
- FS: `fs/{year}/financial-statement`
- CGS: `cgs/{year}/board|employee|auditor-company|director-performance|bods|executives|committees/.../others`
- `GET /api/sec/v2/health`

**Key rules:** `report_year` = Gregorian (2023 not 2566). `language` = `T`/`E` (NOT `1`/`2`). Returns 204 = no data for section (not error). Data: 2021 (178 cos), 2022 (770 cos), 2023 (814 cos).

## Equity Allocation Signal (`routers/allocation.py`)
- `GET /api/allocation/signal` — 3-layer confluence (A=sentiment, B=flow, C=structural) → equity/bond recommendation
- `GET /api/allocation/layers` — raw scores per layer (debug)
- `GET /api/allocation/history?days=90` — historical signals (SQLite `allocation_signals`)
- `DELETE /api/allocation/cache`

## Country Equity Rotation (`routers/country_rotation.py`)
- `GET /api/country-rotation/scores` — 3-layer rotation (M=momentum, Q=macro quality, C=carry) → 14 country ETFs ranked
- `GET /api/country-rotation/history?days=90&ticker=SPY`
- `GET /api/country-rotation/universe` — 14 ETF universe
- `DELETE /api/country-rotation/cache`

## Sector Selection Signal (`routers/sector.py`)
- `GET /api/sector/signal` — 4-layer (BC=cycle, MOM=momentum, VAL=valuation, F=macro factor APT) → 11 US SPDR sector ETFs ranked
- `GET /api/sector/history?days=60`
- `GET /api/sector/factors` — raw macro factor z-scores (yield, CPI, credit spread, DXY, oil)
- `DELETE /api/sector/cache`

## Regime Detection (`routers/regime.py`)
- `GET /api/regime/correlation` — sector regime detection, 5min cache
  - Returns: mode (RISK_ON/RISK_OFF/NEUTRAL), correlation_matrix, sector_returns, regime_confidence
  - Used by: MKT view Regime Detection panel (CORR mode = correlation, GEOM mode = geometric)
  - Calibration math: `backend/analytics/regime_calibration.py`
- `GET /api/regime/calibrated?period=3m|6m|1y|1m` — CORR + GEOM both, with conflict detection

## Theme/Sector Rotation (`routers/rotation.py`)
- `GET /api/rotation/table?market=US|TH&bench=SPY` — momentum table; US: 24 theme ETF proxies (ARKG, IBB, CIBR, SMH, MAGS…) + 11 SPDR sectors vs SPY; TH: 13 equal-weight sector baskets (Banking, Energy, ICT, Commerce…) vs ^SET.BK; per row: d1/w1/m1/m3 %, m1_vs_bench, RRG quadrant + mom_dir; 15min cache, one batch yf.download 9mo
- `GET /api/rotation/constituents?market=US|TH&id=X` — drill-down stocks in a group with same return columns; US id=ETF symbol → yf funds_data top-10 holdings (1d cache); TH id=group name → basket members
  - Used by: MKT view REGIME panel → ROT mode (`rotation-table.tsx`) — US|TH toggle, click row to expand constituents

## Stop Loss Engine (`routers/stoploss.py`)
- `GET /api/stoploss/regime` — exceedance correlation regime (CRISIS/RISK-OFF/TRENDING/DIVERGENT), 5min cache
- `GET /api/stoploss/atr?symbols=X,Y&account_id=dime` — adaptive ATR + vol percentile + trend factor
- `GET /api/stoploss/compute?symbols=X,Y&account_id=dime&entry_prices=100,200` — final stop prices
  - Returns: `{regime_label, vix_percentile, stops: {sym: {current_price, stop_dynamic, dist_pct, ...}}}`

## Analytics / Terminal Functions (`routers/analytics.py`)
- `GET /api/analytics/corr?a=A&b=B&period=3m` — Pearson correlation + p-value
- `GET /api/analytics/beta?asset=A&benchmark=^GSPC&period=1y` — OLS beta + alpha + R²
- `GET /api/analytics/vol?symbol=A&period=1y` — annualised volatility (log-returns × √252)
- `GET /api/analytics/return?symbol=A&period=1y` — total return (adjusted close)
- `GET /api/analytics/drawdown?symbol=A&period=1y` — max drawdown + trough date
- `GET /api/analytics/sharpe?symbol=A&period=1y` — Sharpe ratio (rf=4.3% hardcode)
- `GET /api/analytics/zscore?symbol=A&period=1y` — price z-score vs rolling mean
- `GET /api/analytics/rsi?symbol=A&window=14` — RSI with Wilder smoothing (6mo lookback)
- `GET /api/analytics/compare?symbols=A,B,C&period=1y` — side-by-side return/vol/sharpe/dd table
- `GET /api/analytics/rank?symbols=A,B,C&metric=RETURN&period=1y` — sorted ranking table

**Cache:** TTLCache 300s per (symbol/pair, period). Stampede prevention via per-key `threading.Event`.  
**Data:** yfinance daily adjusted closes. All endpoints use `def` (not `async`) — runs in ThreadPoolExecutor.  
**Next.js proxy:** `app/api/analytics/route.ts` (GET, 20s timeout)  
**Frontend consumer:** `components/bloomberg/terminal/registry.ts` — analysis function handlers

## Fear & Greed Index (`routers/fear_greed.py`)
- `GET /api/fear-greed` — current F&G value + zone + label (5-min cache)
- `GET /api/fear-greed/history?period=1y` — historical series `[{time, value, zone}]` (60-min cache)
  - 5 components: VIX (25%) + SPY momentum (25%) + SPY/TLT safe-haven (20%) + HYG/LQD junk bonds (15%) + RSP/SPY breadth (15%)
  - Zones: extreme_fear (0-25) / fear (25-45) / neutral (45-55) / greed (55-75) / extreme_greed (75-100)
  - Downloads: `^VIX`, `SPY`, `TLT`, `HYG`, `LQD`, `RSP` from yfinance
- **Next.js proxy:** `app/api/fear-greed/route.ts` + `app/api/fear-greed/history/route.ts`

## Tail Risk Monitor v2 (`routers/tail_risk.py`) — prefix `/api/tail-risk`

| Endpoint | Returns |
|----------|---------|
| `GET /signals` | 6 risk dimensions + tri-state signals + vol board + 90d history + `data_health` |
| `GET /vix-term` | VIX9D / VIX / VIX3M / VIX6M + backwardation flags + freshness |

**Data sources (v2, 2026-08-16):**
- Vol indices → `backend/vol_indices.py`, **CBOE daily CSVs** (`cdn.cboe.com/api/global/us_indices/daily_prices/{NAME}_History.csv`, keyless): VIX, VIX9D, VIX3M, VIX6M, VVIX, SKEW, OVX, GVZ, VXN. yfinance is a fallback for the five non-term-structure names only — its term-structure feed froze on 2026-07-17 and is what v1 was silently reading.
- SPY/AGG (2y) + 7 DCC assets (600d) → yfinance
- Credit / sentiment / regime → **in-process calls** to `crisis.get_crisis()`, `fear_greed.get_current()`, `ticker.get_ticker()` — no self-HTTP (v1 looped back through localhost:8000 and timed out on cold caches)

**Contracts worth knowing:**
- Every signal is `state: "on" | "off" | "unknown"`. `unknown` carries `reason` and must never be rendered as safe.
- A vol series lagging VIX by > `MAX_STALE_DAYS` (4) is unusable — `VolFrame.value()` returns `None` rather than the last good print.
- Risk level counts **dimensions in ALERT**, not signals: ≥3 → HIGH, ≥2 → ELEVATED, ≥1 alert or ≥2 watch → CAUTION.
- Failure returns `{ok: false, error, detail, signals: [], ...}` — never a bare `{}` (that used to crash the view).

## Alert Ticker (`routers/alerts.py`)
- `GET /api/alerts?account_id=all` — all active alerts (stop loss + regime change), 60s cache
  - Stop loss: persistent, state-based — fires when `current_price < stop_dynamic`
  - Regime change: event-based — stored in `regime_alerts` table, expires 15 min after detection
  - Returns: `{alerts: [{type, severity, symbol, message, persistent, expires_at?}], count, has_critical, timestamp}`
- `DELETE /api/alerts/regime/clear` — remove expired rows from `regime_alerts` table

**Next.js proxy:** `app/api/alerts/route.ts` (GET + DELETE)
**Frontend:** `components/bloomberg/layout/alert-ticker.tsx` — polls every 60s, renders 24px strip at bottom

---

## Quote Providers (`routers/providers.py`)
Controls the live-quote registry (manual switch + auto-failover, capability-scoped).
- `GET /api/providers` — `{active, providers: [{name, label, healthy, active, auto_failover, last_served}]}`
- `POST /api/providers/active` — body `{name}` — pin active provider (404 if unknown)
- `POST /api/providers/auto-failover` — body `{enabled}` — toggle failover to next healthy

**Next.js proxy:** `app/api/providers/{route,active/route,auto-failover/route}.ts`
**Frontend:** `layout/provider-switch.tsx` (header chip), `hooks/useProviders.ts`, `hooks/useLiveQuery.ts` (cadence seam)
**Providers:** `YFQuoteProvider` (default) → `StooqQuoteProvider` (keyless fallback). Add via `registry.register()` in `sources/__init__.py`.

---

## Watchlist Signals (`routers/watchlist_signals.py`)

| Endpoint | Params | Returns |
|----------|--------|---------|
| `GET /api/watchlist/signals` | `symbols` (comma-separated, max 60) | `{signals: {SYM: {...}}, errors: [], count}` |

One yfinance batch download (`period=2y, interval=1d`) for the whole list, cached 900s.
Per symbol: `trend` (EMA20/50/200 stack), `rsi` (Wilder 14), `rvol` (vs 20d avg),
`macd` (12/26/9 histogram sign + barsSinceCross), `breakout` (20d Donchian),
`range52w` (position 0..1), `atrPct`, `score` (composite ≈ -6..+6), `flags` (string list).
`asOf` is the last bar's date — equal to today while the session is open, in which case
`rvol` only counts partial volume.

## Caching Strategy

| Data | Cache | Where |
|------|-------|-------|
| Market indices | 60s | Python in-memory |
| Market indices | 55s | Next.js in-memory |
| Heatmap | 60s | Python in-memory |
| Stock quote | 5min | Python in-memory |
| Stock history | 5min (12hr for max/5y) | Python in-memory |
| Stock financials | 1hr | Python in-memory |
| FB posts | 5min | Python in-memory |
| Clippings list | 60s | Python in-memory |
| Macro series | 5min mem + per-series disk (1d–30d TTL) | Python |
| Crisis indicators | 5min (reuses macro cache) | Python in-memory |
| Sovereign data | disk JSON | persistent `sovereign_cache.json` |
| ETF size | 1hr | Python in-memory |
| YTD prices | 1hr | Python in-memory |
| Crypto overview | 60s | Python in-memory |
| FX overview | 60s | Python in-memory |
| Central banks | 5min mem + disk (4hr) | `central_banks_cache.json` |
| Polymarket signals | 5min | Python in-memory |
| Alerts (stop loss + regime) | 60s | Python TTLCache |
| Polymarket market pool | 10min | Python in-memory (3,000 markets) |
| Polymarket slugs + history | SQLite | persistent |
| BOT Bond Auction | 5min mem + disk (1hr) | `bot_cache.json` |
| BOT Interest Rates | 5min mem + disk (4hr) | `bot_cache.json` |
| BOT Exchange Rates | 5min mem + disk (4hr) | `bot_cache.json` |
| SEC legacy | 5min | Python in-memory |
| SEC v2 | 5min | Python in-memory |
| Allocation signal | 5min | Python in-memory |
| Country rotation | 5min | Python in-memory |
| Sector selection | 5min | Python in-memory |
| Regime detection | 5min | Python in-memory |

---

## Next.js Proxy Routes (`app/api/`)

```
app/api/
├── market-data/route.ts
├── stock/route.ts
├── news/facebook/route.ts
├── clippings/route.ts / content / ai / ai/models
├── heatmap/route.ts
├── options/route.ts / surface
├── options/positions/route.ts (POST)
├── options/positions/list/route.ts
├── options/positions/seed-demo/route.ts
├── options/positions/demo/clear/route.ts
├── options/positions/[id]/route.ts (DELETE)
├── options/positions/[id]/close/route.ts (PATCH)
├── options/positions/[id]/quote/route.ts
├── options/positions/[id]/greeks/route.ts
├── options/greeks/portfolio/route.ts
├── macro/route.ts
├── crisis/route.ts
├── sovereign/list + [code]/route.ts
├── portfolio/theses|thesis|research|export|sources
├── portfolio/db/transactions + [id]
├── portfolio/db/holdings|import|backtest
├── v2/portfolio/accounts|trades|open-positions|sell
├── v2/portfolio/trades/[id] + bulk-patch-sector
├── v2/portfolio/dividends + [id]
├── v2/portfolio/import
├── v2/portfolio/allocation-detail (GET) + allocation-targets (GET, PUT)
├── v2/theses/[[...path]]/route.ts — one catch-all for the whole thesis CRUD surface (GET/POST/PATCH/DELETE)
├── v2/portfolio/risk/metrics|correlation|stress|position-size|parity
├── pins/groups + [id]
├── pins/assets + [id] + [id]/tags/[tagId]
├── pins/tags + [tagId]
├── pins/import
├── fx/route.ts
├── crypto/route.ts
├── crypto/footprint/route.ts
├── polymarket/route.ts  ← GET/?type=, GET/?q=, GET/?mcp, POST, DELETE
├── bot/auctions/route.ts
├── bot/rates/route.ts  ← ?type=policy|interbank|thb-implied|swap-point
├── bot/fx/route.ts  ← ?type=daily|monthly
├── bot/statistics/route.ts
├── sectors/ (multiple routes)
├── sec/ (legacy routes)
├── sec/v2/ (52 routes)
├── allocation/route.ts
├── country-rotation/route.ts
├── sector/route.ts
├── ai/route.ts
└── watchlist/signals/route.ts
```
