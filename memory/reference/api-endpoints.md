# API Endpoints Reference

> All Python FastAPI routes. Next.js proxies all requests — browser never hits :8000 directly.
> **See also:** [data-shapes.md](data-shapes.md) — response JSON shapes | [architecture.md](architecture.md) — router table + analytics folder | [frontend-structure.md](frontend-structure.md) — proxy route file locations | [gotchas.md](gotchas.md) — error dictionary + anti-patterns

---

## Portfolio accounting preparation (2026-09-25)

Mounted in `routers/portfolio_v2.py`; matching Next proxies under `app/api/v2/portfolio/ledger/`. The first four routes below are read-only and uncached. Statement POST writes cited evidence only; it does not post trades, cash offsets, or journal events. Invalid inputs return 422.

| Method/path (prefix `/api/v2/portfolio/ledger`) | Inputs | Result |
|---|---|---|
| GET `/check` | optional `account_id`, comma-separated `codes` | Registry findings, evidence, coverage, reconstructed/posted event counts. C1/N1 skipped without external samples; D1 partial without market declarations. |
| GET `/stock-card` | `account_id`, `symbol`, `method=AVCO\|FIFO`, `sub_port?` (one sub-port's pool; ignored on an account that does not split; empty = combined) | Reconstructed stock card, cost/quantity/P&L totals and sell allocations. Oversell/incomplete replay rejected. |
| POST `/prepare-dividend` | `account_id`, `symbol`, `ex_date`, `amount_per_unit`, explicit `tax_rate` (fraction) | Sub-account entitlements and gross/withholding/net; `recorded:false`. Future XD rejected. |
| POST `/check-opening` | `account_id`, `as_of`, `cash`, `market_value`, `positions[{symbol,qty,cost_basis,market_price}]` | O1 market-value arithmetic and O2 quantities vs recorded history; `recorded:false`. Amounts in account currency. |
| GET `/statements` | optional `account_id` | Latest statement revision per account/date plus comparison: cash before EDIT offsets, dated quantities, missing FX; conflicting current versions are flagged by R3. |
| POST `/statements` | account/date/currency, cash, total market value, complete positions, `source_ref`, optional `supersedes_id` | Append a broker statement revision (201). O1 arithmetic and source reference required; duplicate date needs current id to supersede. `broker_source_verified:false`. |

`POST /api/v2/portfolio/cash/reconcile` now accepts `category` (`FX_REVALUATION|FEE|TAX|INTEREST|MISSING_DEPOSIT|MISSING_WITHDRAWAL|MISSING_TRADE|DATA_FIX|UNKNOWN`). UI requires selection and a note for UNKNOWN; legacy API calls default UNKNOWN and are audited by R2. GET `/cash/adjustments` returns `category`.

Audit CLI: `python scripts/accounting_audit.py --api-url http://localhost:9317 --nav-validation <samples.json> --json <report.json>` from `backend/`; exit 1 on findings with severity error, 2 on invalid arguments. HTTP `/check` does not fetch market/API samples itself. Details: [session](../sessions/2026-09-25-accounting-foundation.md).

## Market / Heatmap (`routers/market.py`)
- `GET /api/market-data` — 20 global indices (Americas/EMEA/Asia, incl. KOSPI), 60s cache
- `GET /api/tick-custom?symbols=IXG,PTT.BK,EURUSD=X` — quotes for the rows a user added to the TICK DATA board (custom sections, 2026-10-07). Same row shape as a market-data index row with `id` = the symbol (the label a user gave lives in the browser) → `{ items: [...], missing: ["BADSYM"], lastUpdated, dataSource }`. ≤ 80 symbols, each must match `^[A-Z0-9.^=\-&]{1,20}$`; the whole answer — misses included — is cached per symbol set for the quote TTL (60 s). Proxy `app/api/tick-custom` (no cache, no static fallback).
- `GET /api/volatility` — 20 VIX-family "fear" indices (MOVE added 2026-10-07 — `^MOVE` IS the ICE MOVE index although Yahoo's shortName says "Northern Trust iBoxx…") for the TICK DATA VOLATILITY section, 60s cache. Rows are the SAME shape as a market-data index row plus `group` (`S&P TERM` / `VOL OF VOL` / `EQUITY` / `GLOBAL` / `COMMOD/RATES`) → `{ items: [...], lastUpdated, dataSource }`. Symbol list lives in `config.VOL_INDICES` (table `symbol_lists`, list_id `volatility`)
- `GET /api/heatmap` — sectors, commodities, bonds, indicators heatmap groups

## Stock (`routers/stock.py`)
- `GET /api/stock/resolve?q=` — typed bare ticker → Yahoo symbol `{input, symbol}` (`CPALL`→`CPALL.BK`; `.BK` wins on collisions like BH/TU/SCC — also first in search results; US line = pick it from the dropdown; anything with `. = ^ -` untouched). Rides the search cache. Proxy `/api/stock?type=resolve`. Frontend `lib/resolve-symbol.ts` (2026-09-30)
- `GET /api/stock/search` — ticker autocomplete. Cost order (2026-09-29): case-insensitive cache 6h (hits + confirmed empty, per-key coalescing) → one `yf.Search` → one query1 REST call only if that failed/empty; `.BK` probe cached per ticker 24h; outage = last-good or `[]` with 30s down-mark, never the 6h cache. Frontend (`global-search.tsx`) keeps a 200-entry/10-min session cache and aborts superseded requests. Test: `tests/test_stock_search_cache.py`
- `GET /api/stock/sector/{symbol}` — classification for the ENTRY form. Returns the raw provider fields (`sector`, `industry`, `sector_raw`, `industry_raw`, `quote_type`) **plus** `asset_class` (`equity`/`etf`/`fund`/`crypto`/`fx`/`index`/`future`/`option`/`dw`/`warrant`) and the sector in BOTH vocabularies: `set_sector` (SET codes — BANK, COMM, ENERG…) and `us_sector` (GICS labels — Financials, Consumer Staples…). Mapping lives in `backend/sector_map.py`, never a string match: "Healthcare" does not contain "Health Care" and "Consumer Defensive" matches "Consumer Discretionary" on its first word. Unknown resolves to `"Other"`, never `null`. ETFs also get `etf_kind` and `us_sector` `ETF - Leveraged` / `ETF - Inverse` (2026-09-28). No cache (one `.info` call)
- `GET /api/stock/quote/{symbol}` — real-time quote
- `GET /api/stock/history/{symbol}` — OHLCV history (1d/1w/1m/3m/ytd/1y/5y/max). For a daily final row whose Yahoo `Close` is null, the router checks the same-day regular quote and a separate raw-history frame; it restores the bar only when raw O/H/L/volume are finite and the quote close falls within that day's high/low. An incomplete response is not stored in the router cache, so a later request can recover when vendor data arrives. Response `{quotes, yf_symbol, interval, utc_offset_min}` (last three added 2026-09-26 for the live stream).
- `GET /api/stock/financials/{symbol}` — income statement + cash flow
- `GET /api/stock/analyst/{symbol}` — analyst ratings
- `GET /api/stock/dividends/{symbol}` — `{dividends, splits, upcomingDividends}`; cache 1h. `dividends` is paid history only (yfinance `ticker.dividends` can never hold a future date) — the next **declared** ex-date comes from `ticker.calendar` as `upcomingDividends: [{date, payDate, dividend, estimated}]`, empty when Yahoo's calendar date is already in the past. Next.js proxy: `type=dividends`
- `GET /api/stock/earnings-calendar/{symbol}` — earnings dates + EPS estimate/reported/surprise%; **includes the next scheduled report** (reportedEPS `null`)
  - (2026-09-25) when `earnings_dates` has no row dated today or later, ONE next report is appended: `Ticker.calendar` first (`source: yahoo_calendar`, `estimated` + `windowEnd` when Yahoo gives a from/to window), else for `.BK` only the SET filing deadline (`backend/earnings_deadlines.py`: Q ≤45d, FY ≤60d after period end; `source: set_rule`, `deadline: true`, `period`, `periodEnd`) — a deadline, not a scheduled date
- `GET /api/macro/calendar?back_days=730&ahead_days=120` (2026-09-25) — `{events[{date,kind,label,sep,impact,source}], releases_ok, fomc_calendar_through, fomc_calendar_stale}` oldest first; same `event_calendar.calendar_payload` as TAIL (FOMC hardcoded 2023→2027 from federalreserve.gov, CPI/NFP/PCE/GDP + PPI 46 / Retail Sales 9 / JOLTS 192 / Jobless Claims 180 from FRED release dates; since 2026-10-02 also rule dates with `source: "rule"` — OPEX, VIXEXP, ISM, MINUTES, EIA weekly). Used by the price chart event rail (which shows FOMC/CPI/NFP only)
- `GET /api/stock/pe-history/{symbol}` — trailing (TTM) P/E weekly series (adj-EPS) + percentile stats + earnings list; cache 1h. Next.js proxy: `type=pe-history`

## Market heatmap (`routers/market_heatmap.py`) — HMAP view

- `GET /api/market-heatmap?market=US&per=25` → `{market, tiles:[{s,n,sec,cap,px,d1,w52,d50,d200,hi,rv,pe,cur,ms,pre,post}], currency, asOf, partial, ms, stale?, error?}`.
  `market` = alias (US SET TH JP HK CN KR TW IN UK DE FR SG AU CA BR …) or any Yahoo screener region
  code; unknown → 400. One `yf.screen` per Yahoo sector (11, parallel), sorted by `intradaymarketcap`,
  over-fetched ×4 then filtered: non-EQUITY, Thai `-R/-F/-P/NN.BK` (NVDR/foreign/preferred/DR), share
  classes deduped by long name. Units: `d50 d200 hi` converted fraction→%, `w52` already %. `rv` is
  partial-day while trading. Cache 90s; failure negative-cached 60s and answered with the last good
  map (6h) flagged `stale`. Cold ~1.4 s (US) – 4 s (TH).
- Next proxy: `app/api/market-heatmap`.

## Discover feeds (`routers/discover.py`) — MKT left panel FREQ / ACTIVE

- `POST /api/search-stats/hit` `{symbol}` → `{ok, symbol}` — upsert `search_hits` count+1. Called by
  `lib/search-stats.ts#recordSearchHit` from global search (`openEquity`, `<TICKER> <GO>`) and the MKT
  SYMBOL box. Symbols failing `^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$` are rejected (`ok:false`).
- `GET /api/search-stats/top?limit=30` (max 50) → `{items:[{symbol,count,last_at}]}` — count desc, ties → most recent.
- `DELETE /api/search-stats/{symbol}` → `{ok}` — the × on a FREQ row.
- `GET /api/most-active?count=30` (max 50) → `{items:[{symbol,name,price,pctChange,volume,avgVolume,rvol,marketState,time,pre/postMarket{Price,Change,ChangePercent}}], asOf, error?}`
  — Yahoo predefined screener; 2 min cache, failures negative-cached 60s (`items:[]`, `error`).
  Before the open it still ranks the previous session (`marketState != REGULAR`).
- Next proxies: `app/api/search-stats/{hit,top,[symbol]}`, `app/api/most-active`.

## Adaptive DCF (`routers/dcf.py`)

- `GET /api/dcf/{symbol}?model=auto|fcff|growth|fcfe|excess_return|affo|normalized_cycle&scenario=bear|base|bull` — normalizes Yahoo statements/market inputs, selects an industry-aware model when `model=auto`, and returns the forecast, valuation bridge, 5×5 rate/g sensitivity, warnings and input lineage. Normalized inputs cache 1h; default/query runs cache 15min.
- `POST /api/dcf/{symbol}` — uncached analyst run. Body `{model, scenario, assumptions}`; assumption rates are decimal fractions. Model/scenario inputs are validated by the pure engine and invalid combinations return 422.
- `DELETE /api/dcf/cache/{symbol}` — clears that symbol's normalized-input and result caches.
- Next.js catch-all proxy: `app/api/dcf/[...path]/route.ts`, 90s timeout, preserves backend status. Browser code never calls Yahoo directly.
- `AUTO` routes banks/insurers to excess-return, REIT/real estate to AFFO, volatile energy/material issuers to normalized-cycle, high-growth or non-positive-FCFF issuers to revenue→FCFF, and ordinary corporates to 3-stage FCFF. It is a recommendation only; the UI always permits an override.
- Statement currency is the valuation currency. If it differs from quote currency, market price/market cap/upside are intentionally omitted rather than compared without FX conversion. Statement lineage is `STATEMENT`, not an assertion that the value came directly from a filing.

## Options (`routers/options.py`)
- `GET /api/options?symbol=&expiry=` (Next.js) → Python `GET /api/options/{symbol}?expiry=` — options chain (calls + puts). Also returns `ivCall`/`ivPut`/`ivMid`/`atmStrike` (median ATM IV within 3% of spot, per side) and **upserts today's `iv_snapshots` row as a side effect** — `ivCurrent` stays call-only for back-compat
- MKT REGIME IV Smile reuses the chain endpoint for discovery then one selected expiry or deduplicated actual expiries nearest 1/3/5/7/9 calendar months (within ±45 days, at least 7 DTE). No full-surface request. The chain handler is synchronous so blocking Yahoo fetches use FastAPI's threadpool when multiple expiries load. Next.js preserves backend errors as `{error: string}` with original status, including404 for no options; transport failures remain502. Chain row IV field is `impliedVolatility` (fraction).
- OI overlay reuses the same chain response, no new endpoint/fetch: row `openInterest` is contract count. `clean_df` now adds `openInterestAvailable:boolean` before legacy numeric filling: false for missing/invalid/negative/fractional/unsafe integer OI, true for reported0. Existing numeric `openInterest` and aggregate fields remain compatible. OI chart consumes one explicitly selected expiry in MULTI, independent of IV/quoted filters, and shows latest reported OI rather than daily OI history.
- `POST /api/options/smile-fit` — optional Raw SVI calibration from supplied observations; no market fetch. Body `{referencePrice, timeYears, series:[{name:"call"|"put"|"otm",points:[{strike,ivPercent}]}]}`. IV input is **percent**, T is ACT/365 years. At most 2 unique series and 2000 points each; finite positive S/K/IV/T, T<=10, S/K<=1e12, IV<=10000. Invalid schema or duplicate names →422. A series with <8 distinct usable strikes, log-strike span<0.05 or failed convergence returns200 with `status:"unavailable"`, reason and no parameters. Successful series returns Raw SVI parameters, IV RMSE in percentage points and observed strike span. Synchronous SciPy optimizer, robust soft-L1 total-variance residuals, positive global minimum variance, six deterministic starts; no cross-expiry arbitrage constraints. Payload SHA-256 TTL cache300s/max200. Next proxy `app/api/options/smile-fit/route.ts` preserves status,30s timeout,502 transport errors. See `data-shapes.md` for exact result.
- `GET /api/options/surface` — implied volatility surface
- `POST /api/options/{symbol}/iv-snapshot?expiry=&targetDte=30` — record today's ATM IV explicitly (for a daily cron; the chain endpoint already does it on read). Picks the expiry nearest `targetDte` and **skips anything under 7 DTE** — `expirations[0]` is often 0DTE, whose ATM call/put pair can disagree by 40 vol points (see gotchas). 422 if no usable ATM IV
- `GET /api/options/{symbol}/sd-bands?period=&mode=&horizonDays=&rvWindow=&occWindow=` — Black-Scholes lognormal σ-bands per day for the SD heatmap pane. `mode=occupancy` (default) = realized bucket frequency vs the band projected `horizonDays` earlier; `mode=cheapness` = `P_rv − P_iv` on the same price edges. History depth is bounded by `iv_snapshots`, NOT by `period` — a fresh symbol returns `snapshotCount: 0` + a `note`, never an error (plus `rawSnapshotCount` when rows exist but are all under 7 DTE and therefore excluded). Per day it picks the expiry closest to `horizonDays`, not the nearest one. **`cheapness` works from the FIRST snapshot** (realized vol comes from price history); `occupancy` cannot draw until outcomes exist ~`horizonDays` later — hence `cheapness` is the default mode. Math: `backend/analytics/sd_bands.py`
- `POST /api/options/fills` (2026-09-26) — **the one write path PORT → ENTRY uses for an option fill** (`backend/option_fills.py`). Body `{account_id, underlying, expiry, strike, option_type, multiplier=100, currency=USD, action OPEN|CLOSE, side BUY|SELL, quantity (contracts, >0), price (per-share premium; null only for EXPIRED→0 or UNKNOWN), trade_date (US date), executed_at?/submitted_at? (ISO **with offset**), settle_date?, broker_order_ref?, close_reason?, fee_items[{component, amount}], allocations[{open_trade_id, quantity}] (empty = FIFO by fill time → trade date → entry time), slip_sha256s[], note, dry_run}`. Writes option_trades + trade_fee_items (ESTIMATED, source SLIP/MANUAL) + broker_executions OPTION (only with slip + fill time) + matches via `match_realized` (both legs' fees). `dry_run` returns the same `{matches[{open_trade_id,entry_date,entry_price,quantity,fees_alloc,realized_pnl}], gross, fees, cash_effect, realized_total}` without writing. 422 with a person-readable `detail`: order ref already booked, no open lot on that side, more contracts than open, premium 0 without EXPIRED, timestamp without offset, fill before its lot. Greeks captured only when trade_date is within 1 day of today. Proxy `app/api/options/fills/route.ts`. The older `POST /positions`, `/close`, `/close-fifo` stay for compatibility; no UI calls them
- `GET /api/options/positions/list` — list option positions
- `POST /api/options/positions` — add position (underlying, expiry, strike, type, qty, entry_price)
- `POST /api/options/positions/seed-demo` — insert 6 demo positions
- `DELETE /api/options/positions/demo/clear` — delete demo positions
- `DELETE /api/options/positions/{id}` — delete one position
- `PATCH /api/options/positions/{id}/close` — body `{quantity?, exit_price?, exit_date?, fees?, close_reason?}`. Writes a CLOSE trade plus the match against that lot. `quantity` omitted closes what is left; closing more than the lot holds returns 400 rather than opening a short by accident. `exit_price` omitted records `close_reason='UNKNOWN'` with `realized_pnl=NULL` — unknown, not break-even
- `POST /api/options/close-fifo` — body `{account_id, underlying, expiry, strike, option_type, quantity?, exit_price?, exit_date?, fees?, close_reason?}`. Closes across every open lot of one contract oldest-first (ordered by trade_date then created_at), allocating fees by matched quantity. Returns the per-lot matches it made
- `POST /api/options/payoff` — payoff geometry for a set of legs, hypothetical or held. Body `{legs: [{underlying, expiry, strike, option_type, quantity (SIGNED), entry_price, multiplier, fees, iv?}], spot?, points?, range_pct?, days_forward?, iv_shift?, moves?}` (`iv` overrides the chain IV; `days_forward` + `iv_shift` (decimal, 0.05 = +5 vol pts) define a SCENARIO; `moves` = underlying % rows for the grid, default ±20). Returns `curve[{s, expiry, t0, sim?}]`, `breakevens[{price, move_pct}]`, `max_profit`/`max_loss` (each with `unbounded`), `current{pnl_if_expired_now, pnl_today, pnl_sim}`, `pop`, `dte_days`, `max_dte_days`, `scenario{days_forward, iv_shift, active, horizons[{label, days, expiry}], grid[{move_pct, price, values[]}]}`, `ivs[]`, `iv_used`, `legs_missing_iv`, `model_note`. **The `expiry` line is arithmetic; `t0` is Black-Scholes through `greeks.py`; `pop` adds a lognormal terminal price at today's IV with a risk-neutral drift.** A leg with no quoted IV drops `t0` and `pop` for the WHOLE set — a curve drawn from only the quoted legs would describe a different position. Implemented in `backend/analytics/option_payoff.py`
- `GET /api/options/trades?account_id&limit` — every execution, newest first, joined to its contract and to the greeks captured at that trade. **Declared BEFORE `/api/options/{symbol}`** — that route matches any single segment, so a literal one-segment GET registered after it is never reached (the symptom is a 404 reading "No options available for TRADES")
- `PATCH /api/options/trades/{id}` — correct a mis-entered trade: `trade_date`, `price`, `quantity`, `fees`, `note`, `close_reason`, `clear_price`, plus contract terms (`underlying`/`expiry`/`strike`/`option_type`/`multiplier`/`currency`) and a `reason` for the log. **Re-matches every match touching the trade** — `realized_pnl` is materialized, so a corrected price that was not re-matched would keep reporting the old profit; `fees_alloc` is re-apportioned at the same time. Refuses: reducing quantity below what is already matched (400), moving a matched trade to a different contract (409). Changing `multiplier`/`currency` edits the CONTRACT, so it revalues every trade on it — the response reports `contract_siblings_affected` and a `warning`. Writes `trade_audit_log` with action `OPTION_EDIT`
- `GET /api/options/trades/{id}/audit-log` — the edit history of one option trade (`trade_audit_log` has no FK on `trade_id`, so option and equity trades share it)
- `DELETE /api/options/trades/{id}` — deleting a CLOSE cascades its matches and reopens the quantity; deleting a matched OPEN returns 409, because the realized P&L its closes produced would lose its other half
- `GET /api/options/positions/list?status=open|closed` — open lots from `v_option_open_lots` (`lot_id` aliased to `id`), or realized matches from `v_option_realized`
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
- `PUT /api/pins/by-symbol/{symbol}` — upsert the symbol's single pin (2026-09-30). Body: `group_id` XOR `new_group{name,color?}`, `comment?`, `buy_target?`, `sell_target?`, `price_at_pin?`, `priority?`, `tags?`. Omitted = keep; null target = clear. Group + pin in one transaction. Returns `{action: created|moved|updated|unchanged, pin, group}`. New pin id `pin:<SYMBOL>`. No groups at all → creates `watchlist`. 422 both/blank, 404 unknown group_id. Proxy `app/api/pins/by-symbol/[symbol]/route.ts`
- `POST /api/pins/assets` → 409 if the symbol is already pinned (use PUT by-symbol to move); `POST /api/pins/import` skips already-pinned symbols (`skipped` in response)

## Clippings + AI (`routers/clippings.py`)
- `GET /api/clippings` — list .md files with YAML frontmatter
- `GET /api/clippings/content` — full content of one file
- `POST /api/clippings/ai` — Ollama SSE stream (summarize/translate/custom)
- `GET /api/clippings/ai/models` — list Ollama models

## News (`routers/news.py`)
- `GET /api/news/facebook` — posts from Facebook pages (RSSHub or Graph API)
- `GET /api/news/feed?topics=&limit=&fresh=0&swr=0` — topic newswire (yfinance Search + 3 curated RSS: Yahoo, CNBC, MarketWatch; Reuters/Investopedia dropped 2026-09-30). `fresh=1` skips the 5-min cache (REFRESH button)
  - two cache layers (2026-10-05): the assembled feed (fresh 5 min) and each piece — one topic search, one RSS feed — 5 min on its own, so adding or removing a topic re-reads only the new piece. Topic pulls are sized in buckets (30 / 80 / 150); a bigger cached pull answers a smaller need
  - `swr=1` (NEWSFEED tab only): a copy 5–30 min old comes back at once with `refreshing: true` while the new one is built; the hook asks again in 2 s. Without it (ASK, one-shot readers) an expired feed is rebuilt before answering

## Watchlist News (`routers/news_watchlist.py`)
- `GET /api/news/watchlist?symbols=&per_symbol=6&per_source=6&sources=all&polymarket=1&fresh=0&wait=&settle=0`
  - **one stored pull per (symbol, source)** (2026-10-05), `backend/cache/news_watchlist.json` via `persist_cache.PersistentStore` — survives a restart. Fresh 5 min; older (≤72 h) it is served at once and refreshed behind the answer; a failed refresh keeps the last good pull and is retried after 90 s; HTTP 404 = "source does not cover this symbol", cached as empty
  - `wait=<s>` — answer after at most this long with what has arrived; pulls still running are counted in `pending`. `settle=1` — also hold for the refreshes behind stored copies. The NEWS view sends `wait=1.5`, then `wait=4&settle=1` while `pending > 0`. **No `wait` = hold until everything has answered and nothing is older than 5 min** (ASK tool, MCP `get_news`)
  - `fresh=1` re-pulls every source not pulled in the last 10 s (REFRESH button); combine with `wait`
  - one thread pool per source = the concurrency that host sees: yahoo 8 · google 6 · seekingalpha 6 · sec 4 · bing 4 · yfinance 3 (shares the app-wide Yahoo gate) · nasdaq 2 (see gotchas — Nasdaq stalls every new connection)
  - Polymarket matching runs alongside the pulls; on a cold market pool it does not hold the headlines (counted in `pending`). All RSS via `backend/rss.py` `fetch_items` (ElementTree, timeout 4/8 s)
  - per-symbol headlines from 7 free sources: `yahoo` (ticker RSS) · `yfinance` (yf.Search) ·
    `google` (News RSS) · `bing` (News RSS) · `seekingalpha` · `nasdaq` · `sec` (EDGAR 8-K atom)
  - sector/company resolved from SQLite `sector_classifications` → yfinance info (24h cache;
    unresolved retried after 10 min). Crypto/FX → "Crypto / FX", `^` → "Index", else "Unclassified"
  - keyword sources are filtered to headlines that actually name the ticker/company;
    every article carries `relevance: direct|feed` so the UI can hide wire noise
  - cross-tags other watchlist names found in a headline (`symbols[]`), keyword sentiment,
    plus Polymarket markets matched on the **question text only** (word-boundary)
  - caches: meta 24h (symbols Yahoo has no sector for — ETF, future, index — kept 7 days in `backend/cache/news_watchlist_meta.json`, not asked again per restart) · per (symbol, source) news 5 min fresh / 72 h stored · polymarket match 15 min
- `GET /api/news/sources` — source registry (id/label/kind) for the UI toggles

## News ASK (`routers/news_ai.py`, 2026-10-05)
- `GET /api/news/ask/status` — `{configured, provider, model, web_search, search_provider, tools[]}`; answered locally, keys are never returned
- `POST /api/news/ask` `{question, history[{role, content}], symbols[], page?, focus[]?, context?}` → SSE. `page` = terminal view the question came from (known names only), `focus` = tickers on screen (≤10), `context` = a line from the page (≤2,000 chars) — all three go into the `<context>` note with the time and the watchlist; sent by `components/bloomberg/ask` (2026-10-06). `images[]?` — up to 4 `data:image/(png|jpeg|webp|gif);base64,…` URLs, ≤4,000,000 chars each (422 otherwise; never a link); with pictures the user turn goes out as OpenAI content parts (`text` + `image_url`), without them as a plain string. Only the current question's pictures are sent — history is text. A 400/404/415/422 from the provider on a question with pictures is reported as "model does not take pictures — MODEL ▸". `deepseek-chat` read a test picture correctly on 2026-10-06. `screen?` — text of the view on screen (≤60,000 chars accepted, 24,000 kept), captured by the browser at send time; it is **not** put in the prompt — the model gets it only by calling the `read_screen` tool (offered only when `screen` was sent). `get_page_data {page, section, points}` reads one section of a view from the endpoint the view uses (`backend/ask_pages.py` `PAGES`: bonds · tail · market · portfolio), long series cut to the latest `points` (5–260, default 20; halved until the result fits one tool answer), empty fields dropped. The prompt tells the model: screen first, one section only when the screen lacks it. **Research and accounts (`backend/ask_research.py`, read-only):** `get_company_data {symbol, kind, points}` → `/api/stock/{kind}/{symbol}` (financials · balance-sheet · ratios · estimates · analyst · earnings-calendar · ownership · quality · dividends · pe-history · management) or `/api/company/xbrl/{symbol}`; `list_theses` (no bodies) → `get_thesis {thesis: id or ticker, part: body | notes | events}`; `list_questions {thesis}` (empty = queue across theses, else that thesis' tree) → `get_question {question_id}`. `list_tracked {thesis, due_days}` (`/api/v2/tracking`, or `/due?days=` when `due_days` > 0; retired metrics dropped) → `get_tracked {metric: id or ref}`; `search_zettel {query, thesis}` (`/api/v2/zettel/search`, or a thesis' notes when the query is empty; titles only) → `get_zettel {zettel: id or ref}`; `list_conflicts {thesis}` (unresolved only). ASK cannot write a thesis, a note, a reading or an answer — that stays with the MCP (`question_answer`, `track_record`, `zettel_create`) and its evidence rules. **Limits per question (2026-10-06):** tool results share `NEWS_AI_TOOL_BUDGET` characters (default 100,000) — past it a result is cut, then refused, so four full results cannot overflow the model; history is made to alternate user / assistant and end on an assistant turn (`_history`), each turn cut at 20,000 chars instead of the request being refused; provider errors are mapped (`_http_failure`: context too long → "CLEAR", model without tool calling, picture refused — each followed by what the provider said). **Private data and the web:** once a private tool has run in the conversation (`_PRIVATE_TOOLS`, `_is_private_call`; request `private`, event `done.private`), `read_page` opens only a link that a tool result or a user message contained (`_Links`; text of an opened page never counts) — an address the model composed is refused, because it is the one way out for what it has read. `NEWS_AI_READ_ANY_URL=1` turns the limit off. **Next proxy POSTs** (`/api/news/ask`, `/api/news/ask/key`) go through `lib/ask-proxy.ts` `crossSiteReason`: JSON content-type required (415), foreign `Origin` / `Sec-Fetch-Site` refused (403), page host must be a local name or address or be listed in `DEV_ORIGINS` — and **`proxy.ts` applies the origin part to every non-GET request under `/api/**`** (`lib/request-origin.ts` `crossOriginReason`; the ASK routes add the JSON rule); `backendError` passes the backend's reason on instead of "Backend 422". **Saved conversations (`backend/ask_sessions.py`, router included by `news_ai`, 2026-10-06):** `GET /api/news/ask/sessions` → `{store, choice, dir, reason, drive_dir, local_dir, device, sessions[]}` (newest 80; an unusable folder is a `reason`, not an error) · `GET|PUT|DELETE /api/news/ask/sessions/{id}` (id = `YYYYMMDD-HHMMSS-xxxxxx`; PUT `{messages, page?, model?}` writes `<root>/<YYYY-MM>/<id>.json` + pictures as files beside it, atomically, and leaves an unchanged conversation alone; DELETE moves the files to `<root>/_deleted/`; PATCH `{pinned}` pins/unpins without touching `updated_at`; trash: `GET /api/news/ask/sessions/trash` → `{sessions:[…meta, deleted_at]}` (most recently deleted first), `POST …/trash/{id}/restore` (409 if that id is back in the list), `DELETE …/trash/{id}` erases for good — only from the trash, so the list can never erase in one step; the list = newest 80 plus pinned ones found in the next 240 files) · `GET|POST /api/news/ask/sessions/config` (`{store}` or `{dir}` → `ASK_SESSIONS_STORE` / `ASK_SESSIONS_DIR` in `backend/.env`; a folder inside the repository is refused). Root: explicit dir → `<sync.config.sync_dir()>/ask-sessions` (Google Drive) → app-data folder. Next proxies: `app/api/news/ask/sessions/{route,config/route,[id]/route}.ts`. CLI: `python scripts/ask_sessions.py`. `get_page_data` covers all seven views since 2026-10-06 — added `stock` (overview · options · sd-bands · market-state · rate-stress · dcf; `key` = ticker, default the one on screen), `heatmap` (market; `key` = market code, summarised by `_heatmap`: breadth, sectors, movers, largest) and `news` (watchlist · feed · polymarket · data). A long table is shaped (`ask_pages._SHAPES`) instead of cut as if it were a series. `history[].images` — a user turn may carry its pictures again (the page sends the latest set for 3 exchanges). **Old conversations (2026-10-06):** `history[].at` stamps each earlier question (`[asked …]`); `session` names the saved file. `_conversation_note` adds to `<context>`: a RESUMED line when the last question is ≥6 h old (earlier figures are as of then — fetch again), and one line per exchange older than the 12-turn window (≤20, Q 200 + A 280 chars) instead of dropping them; the page sends those older answers cut to 600 chars (`history.ts` `HISTORY_PAIRS`/`DIGEST_CHARS`). Tools `search_sessions {query, days}` (every word, newest first, ≤400 files scanned, 12 hits) and `read_session {session, start}` (`ask_sessions.search` / `transcript`) read saved conversations — both in `_PRIVATE_TOOLS`, and their results add no link to `_Links` (`_UNVOUCHED_TOOLS`: an earlier answer is model text, not a link the user gave). 26 tools (25 without a web-search key); `test_every_tool_has_a_label_and_is_only_a_read` fails on a tool whose name is not a read verb. DeepSeek (`NEWS_AI_MODEL`, default `deepseek-chat`; OpenAI chat-completions format, called with `requests` → upstream source `DeepSeek`) in a tool loop of at most 12 turns. Read-only tools:
  - 9 terminal tools, GET this backend over loopback: `get_watchlist_news`, `get_topic_news`, `get_quote`, `get_price_history`, `get_market_overview`, `get_macro_snapshot`, `get_macro_calendar`, `search_prediction_markets`, `get_filings`
  - `search_web_news` — Google News + Bing News RSS for any query (keyless; Bing click links resolved to the publisher URL)
  - `read_page` — one public URL → main text, 8,000 chars, at most 6 pages per question (`backend/web_reader.py`: direct fetch + lxml, then Jina Reader `r.jina.ai` for JS pages / PDFs / refusals; Google News links decoded first; private, loopback and non-default-port URLs refused; upstream source `ASK web read`, target = host, HTTP 4xx is not a failure)
  - `web_search` — general web search, exposed only when `TAVILY_API_KEY` (first) or `BRAVE_API_KEY` is set
  - `NEWS_AI_WEB_SEARCH=0` removes the three web tools; `NEWS_AI_READER=0` stops URLs going to Jina. No write tool. No cache — every question is a live call, billed to the DeepSeek key.
- Next proxy: `app/api/news/ask/route.ts` — `GET` = status, `POST` = stream passed through unbuffered; aborting the browser request aborts the model call
- **Providers and models (2026-10-06)** — `_PROVIDERS` in `news_ai.py`: `deepseek` · `openai` · `anthropic` · `gemini` · `openrouter` · `groq` · `custom` (any OpenAI-compatible address, e.g. Ollama). All are called through one loop at `<base>/chat/completions`. To add one: a `_PROVIDERS` entry (label, base, key env name, optional `tokens` = name of its output-cap parameter) — nothing else.
  - `POST /api/news/ask` also takes `provider`, `model` (both optional → `NEWS_AI_PROVIDER` / `NEWS_AI_MODEL`). The panel sends the browser's choice (localStorage `bloomberg_news_ask_model`)
  - `GET /api/news/ask/status?provider=&model=` — status of that choice + `providers[]` (`has_key`, `configured`, `models`, never a key)
  - `GET /api/news/ask/models?provider=&fresh=0` — ids from the provider's own `/models` with the saved key (10 min cache; 424 without a key). This is where modes come from (DeepSeek: chat / reasoner / …), not a hard-coded list
  - `POST /api/news/ask/key` `{provider, api_key?, base_url?}` — writes `NAME=value` into `backend/.env` (other lines untouched) and into the process environment; loopback callers only; write-only. Proxies: `app/api/news/ask/{models,key}/route.ts`

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
  - **no `/events?slug=` call per event** (2026-10-05): a search result already carries each event's markets and prices (same Cloudflare snapshot, `max-age=300`). Ticker and company name are searched together. MSFT ladder 3.5 s → 0.5 s. `/events` is only the fallback for a search event that came without `markets`. Gamma leaf pool 2 → 4 workers (`market_requests.py`)
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
- ~~`GET /api/portfolio/theses`, `GET /api/portfolio/thesis/{symbol}`~~ — **removed 2026-09-18** (read .md straight from THESES_DIR; the THESES tab uses `/api/v2/theses`)
- `POST /api/portfolio/research` — SSE condition-killer analysis (Ollama/Claude); reads the latest non-deleted thesis for `symbol` **from the DB** (`body` → `## Condition Killers` / `## Claim`, falls back to the whole body) + SOURCES_DIR notes
- `GET/POST /api/portfolio/db/transactions` — list / add transactions
- `PATCH/DELETE /api/portfolio/db/transactions/{id}` — update / delete
- `GET /api/portfolio/db/holdings` — computed holdings (avg cost method)
- `POST /api/portfolio/db/import` — bulk import CSV

## Ledger v2 (`routers/ledger.py`, core `backend/ledger.py`) — 2026-09-29

Proxy: `app/api/v2/ledger/[[...path]]/route.ts` (GET/POST/PUT). Errors: `{code, detail, evidence}` — 409 `LEDGER_PERIOD_CLOSED` / `LEDGER_CLOSE_MISMATCH`, 422 otherwise. Header `X-Ledger-Correction: <url-encoded reason>` (middleware `LedgerCorrectionMiddleware`) lets a write into a closed period book today; every money-write proxy forwards it (`lib/ledger-proxy.ts`), PORT retries with a prompt (`lib/ledger-correction.ts`).

- `GET /accounts` — `{accounts:[{id,name,currency,ledger_mode,ledger_cutover,wallets[],balances[],rules[],matched?,agreed?}]}` (`matched`/`agreed` only for non-LEGACY)
- `PUT /accounts/{id}/mode` `{mode: LEGACY|SHADOW, reason, cutover?, cutover_at?}` (`cutover_at` = statement moment, e.g. `2026-09-30T00:54+07:00`) — SHADOW runs the first projection; `cutover` (YYYY-MM-DD) = journal starts there: legacy rows dated ≤ cutover are not projected (post OPENING from a statement instead); a fingerprint baseline of that history is stored for L10
- `PUT /wallets` `{account_id,wallet,currency,is_default,note,broker_label?}` — `broker_label` = name the broker prints on slips ("Dime! FCD")
- `GET /wallet-rules?account_id` · `PUT /wallet-rules` `{account_id,symbol_pattern,wallet,note}` (fnmatch, e.g. `GC=F`) · `DELETE /wallet-rules/{id}`
- `GET /route?account_id&currency&symbol?&label?&wallet?` — `{mode, wallet, reason, choices[]}`; order: typed → slip label (broker_label, same currency) → rule → currency default; LEGACY → `wallet: null`
- Legacy writes carry the wallet (SHADOW accounts; fixed at entry): `POST /api/v2/portfolio/trades` `wallet_entry?/wallet_exit?/settlement_label?` · `PATCH /trades/{id}` `wallet_entry/wallet_exit` (validated vs trade currency) · `POST /sell` + `/sell-all-lots` `wallet?/settlement_label?` → `trades.wallet_exit` · `POST /cash` `wallet?` (THB) · `POST /dividends` `wallet?`
- `GET /events?account_id&wallet&date_from&date_to&limit` — rows + `reversed`
- `GET /balances?account_id&as_of` — `[{account_id,wallet,currency,balance,events,closed_through}]`
- `GET /positions/{account_id}?as_of`
- `GET /check?account_id&stale_fee_days` — L1 FX unpaired · L2 negative wallet · L3 late in closed · L4 fee estimated · L5 adjust/opening unexplained · L6 projection pending · L7 option effect · L8 duplicate order · L9 bad reversal
- `GET /pilot/{account_id}?as_of` — per wallet vs the later of latest `broker_statements` (same currency) or latest CLOSE (`statement_kind: statement|period_close`); `matched`, `adjust_events`
- `GET /closes?account_id`
- `POST /events/trade` (refused in SHADOW) · `/events/position` · `/events/cash` · `/events/dividend` (+WHT) · `/events/transfer` (pair) · `/events/fx-convert` (two legs + fee) · `/events/opening` (needs evidence_ref) · `/events/adjust` (category ≠ UNKNOWN + reason)
- `POST /events/move` `{account_id, from_wallet, to_wallet, amount, trade_date, to_amount?, fee?, evidence_ref?}` — same currency → TRANSFER pair; different → FX_CONVERT pair (`to_amount` from the slip required)
- `POST /events/{id}/reverse` `{reason}` — reverses the whole link group · `POST /events/{id}/fee-trueup` `{posted_fee}`
- `POST /close` `{account_id,wallet,as_of,statement_balance|statement_id,source_ref}` — exact match at minor unit or 409 with `difference` · `POST /reopen` `{reason, reopen_to?}`
- `POST /project/{account_id}` `{correction_reason?, dry_run?}`

## Portfolio v2 (`routers/portfolio_v2.py`)
- `GET /api/v2/portfolio/resolve-symbol?q=X&account_id=Y` — resolve bare ticker → canonical provider symbols, filtered to account's markets (`markets` JSON col; default US+TH, crypto→CRYPTO); returns `{query, markets, matches:[{resolved_symbol, market, currency, name, exchange}]}`; TTLCache 1h, home-country ranked first (`plans/port-redesign.md` Step 1)
- `GET /api/v2/portfolio/accounts` — list accounts (no default seed; users create their own)
- `POST /api/v2/portfolio/accounts` — create account (id, name, country, currency, account_type)
- `PATCH /api/v2/portfolio/accounts/{id}` — update name/broker/is_active
- `DELETE /api/v2/portfolio/accounts/{id}` — delete account (409 if it has trades; also clears its cash/dividends)
- `GET /api/v2/portfolio/trades` — trade log (filter by account/symbol/`is_reinvest`); optional `base_currency=THB|USD` adds historical `amount_base`, `price_entry_base`, `price_exit_base`, `pnl_base`
- `POST /api/v2/portfolio/trades` — add trade; accepts resolver `resolved_symbol`/`market`/`currency`; persists authoritative instrument currency plus entry `exchange_rate` (THB per native unit); `sector` is fitted to the account's list (2026-10-01, `_fit_trade_sector` → `sector_map.fit_sector`: a label from the other list is replaced by the provider classification in this list, GICS fallback, else blank)
- `PATCH /api/v2/portfolio/trades/{id}` — edit trade (optional `adjustment_reason` field → audit log only, not stored in trades table); a changed `sector` or `account_id` re-fits the sector to the account's list (2026-10-01)
- `DELETE /api/v2/portfolio/trades/{id}` — delete trade (auto-logs to audit before delete)
- **AVCO replay (2026-09-28):** POST/PATCH/DELETE `/trades`, `/sell`, `/sell-all-lots` re-derive the touched (account, symbol) by date — **per sub-port** since 2026-09-30 (`backend/sub_port.py`: an account whose trades carry ≥2 sub-port tags pools each apart; PATCH of a note that changes the tag replays too; result has `pools{sub:{skipped,avg,rows_changed}}` when >1) (`backend/avco_replay.py`): sale `pnl_amount`/`price_entry`/`pnl_percent`/`win_loss` and open-lot average are rewritten, `AVCO_REPAIR` audit per row. Skipped (logged) on a cost override, oversold history (I6) or exit-before-entry (I7). `/sell` returns the replayed P&L.
- `GET /api/v2/portfolio/trades/{id}/audit-log` — immutable change history for one trade
- `GET /api/v2/portfolio/audit-log` — recent changes across all trades (filter: account_id)
- `PATCH /api/v2/portfolio/trades/bulk-patch-sector` — bulk sector override
- `GET /api/v2/portfolio/premarket?account_id=X` — pre-/post-market session quotes for open positions, keyed by bare symbol. Uses `.info` (heavier than fast_info) so it's a SEPARATE background fetch, NOT part of open-positions. Returns `{quotes: {SYM: {market_state, regular_price, pre_price, pre_change, pre_change_pct, post_price, post_change, post_change_pct}}}`. `*_change_pct` derived from change/reference (scaling-agnostic). US concept — .BK rows return empty. 30s TTLCache. Frontend: OpenPositionsTab **auto** PRE/POST column — injected after CURRENT only while ≥1 position is in a live PRE/POST session, collapses on its own when session ends. NOT a user-toggled col (excluded from ALL_COLS/COLS picker; type `DisplayCol = ColName | "PRE/POST"`).
- `GET /api/v2/portfolio/open-positions` — open positions with live prices; `base_currency` adds `cost_basis_base`, `market_value_base`, `unrealized_pnl_base`, `day_pnl_base`; `currency`/`pos_currency` are instrument currency. Also returns **`options[]`** — open option lots valued by `backend/portfolio_options.py` (separate array, not merged into `positions`: different shape, and the table components index trade rows by field name)
- `GET /api/v2/portfolio/options/attribution?account_id&days=30` — greeks-based P&L attribution for the option book, **always USD**. Splits each day into `delta_pnl` / `gamma_pnl` / `theta_pnl` / `vega_pnl` / `residual` using the greeks from the START of the day (`Δ·ΔS + ½Γ·ΔS² + Θ·Δt + ν·ΔIV_pp`, scaled by `qty × multiplier`). Returns `portfolio` (rolled up), `positions[]` (per contract), `series[]` (per day, for the stacked bar). `residual` is defined as the leftover so the legs ALWAYS sum to `actual` — read `explained_pct` (`1 − |residual|/|actual|`) to judge whether the split described what happened. Reads only `option_greeks_snapshots`, which accumulates and cannot be back-filled: <2 snapshot days returns `series: []` plus a `note`, not an error. `steps_skipped` counts day-pairs whose earlier snapshot had no IV
- `GET /api/v2/portfolio/summary` — account/global summary; `total_pnl_base` remains broker-style realized trading P&L, while `total_economic_pnl_base` adds principal FX attribution as a separate FX-inclusive estimate. **Since 2026-09-10 `pnl_base`/`pnl_native`, `wins`, `losses`, `win_rate`, the YTD figures and `global_win_rate` INCLUDE closed options** — a closed option is a realized result like any other, and keeping it out meant the headline numbers silently excluded a whole instrument class while ANALYTICS (which did count them) showed a different win rate on the same screen. ⚠️ `options_realized_base` is therefore a BREAKDOWN of what is already inside `pnl_base`, NOT another term to add — adding it counts every closed option twice. A match whose closing price was never recorded (`close_reason='UNKNOWN'`) counts as neither win nor loss and contributes 0. Per account also `options_open_count`, `options_mv_base`, `options_cost_base`, `options_unrealized_base`, `options_realized_base`, `options_delta_notional_base`; totals `total_options_mv_base`, `total_options_unrealized_base`, `total_options_realized_base`, `total_options_delta_notional_base`. Also `open_cost_base` and **`cash_base`** per account plus `total_open_cost_base`, `total_cash_base`, `cash_is_estimate` — DERIVED idle cash (`invested + realized(equity+option) + dividends − open cost(equity+option)`), NOT a ledger balance. Nothing posts to `cash_ledger` automatically; that table stays hand-entered. Open cost is read straight from `trades`/`v_option_open_lots` without live prices, so this costs no extra network calls. Blind to commissions, taxes and margin interest that were never recorded — every surface showing it must say `est`
- `GET /api/v2/portfolio/analytics` — P&L breakdowns; aggregate rows include `pnl` (broker-style realized) plus `economic_pnl` (entry/exit FX two-leg economic attribution); also returns `trade_stats` + `trade_stats_by_account` (win rate, W/L ratio, avg win/loss, payoff, expectancy — closed trades, in `base_currency`)
- `POST /api/v2/portfolio/sell` — sell (partial or full); captures `exit_exchange_rate` at exit date. Prices the sale off the AVCO of every open lot **of the lot's sub-port** (2026-09-30; a `position_cost_overrides` row beats the lot math, and is still per account+symbol) and **writes that average back**: the closed row gets `price_entry = avg_cost`, and so does every lot still open for that account+symbol+sub-port. A partial sale's new closed row keeps the sub-port tag as its note (was `""`) (`_rebase_open_lots_to_avco`, audit action `AVCO_REBASE`). Without that rebase, selling a cheap lot re-priced the remainder upward — SNDK ENTRY jumped 1616.2403 → 1648.8074 (fixed 2026-09-22). Response carries `avg_cost`.
- `POST /api/v2/portfolio/sell-all-lots` — close every open lot of one account+symbol, each sub-port at its own AVCO (`sub_port?` limits it to one); also writes `price_entry = avg_cost` per row and logs `SELL_ALL_LOTS`
- `GET /api/v2/portfolio/dividends` — dividend history; optional `base_currency` adds dated `amount_per_unit_base`, `total_received_base`, `reinvested_amount_base`
- `POST /api/v2/portfolio/dividends` — add dividend with record-level `currency`
- `DELETE /api/v2/portfolio/dividends/{id}` — delete dividend
- `POST /api/v2/portfolio/import` — bulk import Excel
- `GET /api/tail-risk/macro-context` — **+ `macro_read` (2026-09-20)**: three axes read from the latest prints, each carrying the `rule` that produced it — `inflation` (core PCE YoY vs the 2% target, ±0.15pp over 3m sets DISINFLATION / STICKY / REFLATION / AT TARGET, with core CPI as the stand-in when PCE has not printed), `growth` (the ISM **proxy**, EXPANDING / STALLING / CONTRACTING) and `rates_vol` (MOVE: CALM / ELEVATED ≥110 or z>0.5 / STRESSED ≥140 or z>1.5). Also `ism_proxy_components` (the three regional prints + their dates). `counted_in_composite: false`, `validated: false` — it describes the backdrop, it does not forecast. Indicators gained `cpi_core`, `pce`, `pce_core`, `ism_proxy`
- `GET /api/v2/portfolio/nav-index?account_id&days=365&benchmark=SPY&base_currency=THB` — **time-weighted** equity curve vs an index, both rebased to 100 (added 2026-09-20). Raw NAV cannot be compared with an index (a deposit lifts it), so each day is `r = (NAV − flow − NAV₋₁)/(NAV₋₁ + before)` (`before` = capital dated before the snapshot day with no snapshot in between — weekend deposit or in-kind transfer valued at the prior close — counted start-of-day; `/nav-history` rows carry `invested_before_day`; added 2026-09-26) with `flow` = Δ`invested_capital` + Δ`cash_adjustment` from `/nav-history`, linked geometrically. **Since 2026-09-25 `/nav-history` re-derives `invested_capital` by date from the current `cash_ledger`** (snapshot value kept as `invested_stored`) — a withdrawal recorded after the day's capture used to be invisible. Snapshots are THB; each row is converted at ITS OWN date, and the benchmark is translated into `base_currency` before rebasing. Returns `points[{date, nav, flow, capital_flow, adjustment_flow, return_pct, port_index, bench_index, suspect}]` (`flow = capital_flow + adjustment_flow`; capital = CASH deposits/withdrawals, adjustment = cash EDIT offsets — added 2026-09-25) + `net_capital_flow` / `net_adjustment_flow`; each point also has `estimated` (snapshot `source='backfill'`) and the response `estimated_until` (last rebuilt date, or null) + `port_twr_pct` / `bench_pct` / `excess_pct` / `net_flow` / `suspect_days` / `benchmark_available`. `suspect` = |r| > 50% in a day — almost always an unrecorded flow, kept in the curve and flagged, never clipped. <2 snapshots returns a `note`, not an error.
  - (2026-10-01) `benchmark` is trimmed/upper-cased and may be any Yahoo ticker (UI offers SPY QQQ IWM ACWI ^SET.BK SOXX + 11 SPDR sectors). **Empty `benchmark=` skips the index download** (`bench_index` stays null, `benchmark_available: false`) — GROWTH sends it empty because it draws no index line.
  - (2026-09-25) `/nav-history` rows now re-derive `dividends` from TODAY's `dividends` table by pay_date (THB, same conversion as capture) instead of the snapshot's stored cumulative; stored value kept as `dividends_stored`. Stops dividend restatements/backfills landing as a one-day return in VALUE/INDEX/GROWTH. ANALYTICS NAV card default mode = GROWTH (`NavGrowthChart`, fetches nav-index days=3650)
- `GET /api/v2/portfolio/rotation?account_id&base_currency=USD&group=theme|sector|account` (2026-09-24) — the book's own rotation map: entry cost (entry FX, same as `/trades?base_currency`) of lots open at each W-FRI week-end (last = today), per bucket. Theme taxonomy in `backend/portfolio_rotation.py` (`THEMES`; symbol → theme, else TH market → TH LEGACY, crypto → CRYPTO, else OTHER). Leading flat run ≥8 weeks (placeholder 2025-01-01 imports) trimmed → `flat_since`. `markers`: `cut` only (total −20%+ in a week; per-bucket "เข้า …" labels removed 2026-09-25). Lots W/L with no `date_exit` → `excluded`. Options not included. Used by ANALYTICS → PORTFOLIO ROTATION
- `GET /api/v2/portfolio/returns` — cost-based annualized returns: CAGR (time-weighted growth of deployed cost) + XIRR (money-weighted IRR from dated cashflows: buys−/sells+/divs+/mark-to-market+). Per-account + total. Params: `account_id`, `base_currency`. NOT the same as CAPM RET ANN (which is market-price, cost-agnostic). **Since 2026-09-25** every row also has `xirr_flag` (`inflow_before_outflow` | `extreme` | null — raw `xirr_pct` kept, UI shows — when flagged) and capital-based `xirr_capital_pct` / `xirr_capital_flag` (`opening_balance_at_cost` | `inflow_before_outflow` | `extreme` | `no_ledger` | null) / `net_deposited` / `nav_now` (deposits/withdrawals in cash_ledger − , latest `/nav-history` nav_with_cash +). Also `periods[{period: 'YYYY', ytd, start, end, days, start_nav, end_nav, net_flow, xirr_pct (annualised; null < 30d), period_pct, flag, estimated}]` per row — money-weighted per calendar year from NAV snapshots: start = last snapshot of the previous year (or first of this one) as the money in, flows = Δ(invested_capital + cash_adjustment) exactly like GROWTH, end = last NAV. UI uses the ytd period as the headline XIRR (`_period_returns`, 2026-09-25).
- `GET /api/v2/portfolio/cash` — cash ledger entries (filter `account_id`, newest first); rows include `entry_type` (`CASH`|`DEPOSIT`|`WITHDRAW`|`TRANSFER`), `linked_id`, and derived **`flow_type`** (`DEPOSIT`|`WITHDRAW`|`TRANSFER_IN`|`TRANSFER_OUT`) — legacy `CASH` rows get it from the sign of `investment`
- `POST /api/v2/portfolio/cash` — preferred body `{account_id, date, flow_type: DEPOSIT|WITHDRAW, amount>0, note, income?}` → stores `investment = ±amount`, `entry_type = flow_type` (2026-09-25). Legacy `{income, investment}` body still accepted (`entry_type='CASH'`). 404 unknown account, 400 bad type / amount ≤ 0
- `PUT /api/v2/portfolio/cash/{id}` — edit cash entry (same body); **409 on a TRANSFER leg** (editing one leg unbalances the pair — delete and re-enter)
- `DELETE /api/v2/portfolio/cash/{id}` — delete cash entry; if `entry_type='TRANSFER'`, cascades to delete the linked pair (matched by `linked_id`)
- `GET /api/v2/portfolio/allocation-detail?account_id&base_currency` — ALLOCATION (OPEN) on two bases: per symbol + per sector `cost_base` (entry FX) vs `market_value` (live FX), `growth_pct`, `unrealized`, `weight_cost_pct`/`weight_mv_pct`/`drift_pp`, `contrib_growth_pct`, `share_of_gain_pct`, plus rebalance sizing (`target_pct`, `target_source` explicit|cost_weight, `delta_value`, `delta_shares` lot-rounded TH=100/US=1, `est_value`, `est_realized`, `in_band`, `action`). Applies `position_cost_overrides` so growth matches the positions table. Reuses `_open_positions_enriched()` (shared with `/open-positions`). Option lots enter as their own rows (`SYM OPT`, `instrument: "option"`): money columns stay premium-based, but weighting runs off **`exposure_base`** (delta notional) via `weight_exposure_pct`, with `exposure_source` = `delta` | `market_value` | `mixed` saying which basis the row's weight actually came from. Totals gain `exposure_base`, `options_exposure_base`, `options_exposure_pct`. Option rows get `delta_shares: null` — sizing contracts back to a premium-weighted target is not a share count
- `GET /api/v2/portfolio/allocation-targets?account_id` — target weights (account-specific row beats the `all` default)
- `PUT /api/v2/portfolio/allocation-targets` — bulk upsert `[{account_id, scope sector|symbol, key, target_pct, band_pct}]`; `target_pct<=0` deletes the row; 400 if a scope's targets sum >100
- `GET /api/v2/portfolio/audit-events` — row-level change log of every money table (trigger-written). Params `account_id` (also matches the account row itself), `table_name`, `row_id`, `action`, `before` (created_at cursor), `limit` ≤1000. Returns `{events: [{event_id, table_name, row_id, account_id, action, reason, created_at, old, new, changed?}], next_before}`; `changed` only on UPDATE. Distinct from `trade_audit_log` (semantic app-level events like SELL_PARTIAL, still written)
- `GET /api/v2/portfolio/cash/adjustments` — cash reconciliation offsets (filter `account_id`), newest first
- `POST /api/v2/portfolio/cash/reconcile` — body `{account_id, actual_balance, currency THB|USD, date?, note}`; computes current `cash_base` via `/summary` in that currency and stores `actual − current` in `cash_adjustments`. Returns `{id, amount, cash_before, cash_after, currency}`; `id=null` when already equal. Slow-ish (runs the summary incl. option valuation) → proxy timeout 60s
- `DELETE /api/v2/portfolio/cash/adjustments/{id}` — undo one offset
- `POST /api/v2/portfolio/cash/transfer` — atomic linked-pair transfer between own accounts: inserts 2 `TRANSFER` rows (source `investment=-amount`, dest `investment=+amount`), nets to 0 on `account_id='all'`, fixes per-account `invested_capital` without touching NAV (`plans/completed/cash-transfer-feature.md`)

## Theses (`routers/theses.py`) — prefix `/api/v2/theses`
DB-backed investment theses. `theses` = materialised head (field-level LWW merge); `thesis_events` = append-only history (never UPDATEd → no merge conflicts). Cloud-synced via `SYNC_TABLES`.
- `GET /api/v2/theses?symbol&category&status&account_id&include_deleted&q&kind&sector&tag` — `{theses, facets}`. `q` = LIKE over symbol / title / tags / strategy / sector / kind / body; `kind` / `sector` / `tag` filter the derived `kind_eff` / `sector_eff` and the tag list; `facets` = `{kind, sector, tags: {value: n}, default_kinds}` (2026-10-02). list + `event_count` + `open_note_count` (open|watching only — a badge counting dismissed scenarios never goes down) + `zettel_count` / `conflict_count` / `graph_count` (attachments, so a tab label is right before its panel has ever been opened)
- `GET /api/v2/theses/{id}` — `{thesis, events, links, notes, counts}` (links join `trades`; `counts` = `{zettel, conflicts, graphs}`)
- `GET /api/v2/theses/by-symbol/{symbol}` — theses for one ticker
- `GET /api/v2/theses/summary/by-symbol` — `{by_symbol: {SYM: {count, status, conviction, id}}}`, one query for the whole book (positions-table badge)
- `POST /api/v2/theses` — create → event `CREATED`
- `PATCH /api/v2/theses/{id}` — update; diffs first, logs `EDITED`/`STATUS_CHANGED`/`TARGET_CHANGED`/`INVALIDATED` with `{field:{from,to}}`; body-only `note` logs `NOTE` without touching the head
- `DELETE /api/v2/theses/{id}?purge=false&note=` — soft delete (UPDATE → **no tombstone**, restorable on both devices); `purge=true` is the real DELETE and does emit one
- `POST /api/v2/theses/{id}/restore`
- `GET|POST /api/v2/theses/{id}/events` — timeline; POST adds a manual `NOTE` (`occurred_at` may be back-dated)
- `DELETE /api/v2/theses/{id}/events/{event_id}` — NOTE events only (400 otherwise — edits are the record)
- `POST /api/v2/theses/{id}/links` / `DELETE .../links/{trade_id}` — link a thesis to a trade
- `GET|POST /api/v2/theses/{id}/notes?include_deleted` — standing notes (scenarios/risks/catalysts); POST logs `NOTE_ADDED`. Order: pinned → soonest `watch_date` → undated
- `PATCH /api/v2/theses/{id}/notes/{note_id}` — edit in place; `""` clears `impact`/`watch_date`; a status flip to `confirmed`/`dismissed` logs ONE `NOTE_RESOLVED`, body edits log nothing
- `DELETE /api/v2/theses/{id}/notes/{note_id}?purge=false` — soft by default (same tombstone reasoning as the thesis delete)
- `GET /api/v2/theses/notes/due?days=14&include_undated=false` — cross-thesis: unresolved notes whose `watch_date` falls inside the window, joined to their thesis (`symbol`, `thesis_title`)
- `POST /api/v2/theses/import-md?dry_run` — import `THESES_DIR/*.md`; keyed on `source_file` so re-running never duplicates
- `POST /api/v2/theses/{id}/export-md` — write markdown back to `THESES_DIR` (Obsidian); DB stays authoritative
- **`X-Thesis-Actor` header** (every route, router-level dependency) — when set (MCP server sends `agent:<name>`), `_log_event` adds `payload.actor`; no header = user, payload unchanged. Timeline shows an `AGENT·NAME` tag.

## Zettel (`routers/zettel.py`) — prefix `/api/v2/zettel`
Zettelkasten knowledge base: atomic notes reusable across theses, typed links, sources as
their own rows. Schema in `db.init_zettel_schema()`. All four tables are cloud-synced.
- `GET /api/v2/zettel?kind&status&stance&tag&thesis_id&symbol&actor&include_deleted&limit` — list + `source_count` + `open_conflicts`
- `GET /api/v2/zettel/{id|ref}` — `{zettel, sources, edges:{out,in}, refs}` (`ref` = the Z-0042 label)
- `POST /api/v2/zettel` — create; 409 when the title already exists (message carries the existing id); EVIDENCE without a source is 400
- `PATCH /api/v2/zettel/{id}` — edit; a change of `status`/`stance`/`title`/`confidence` logs `ZETTEL_CHANGED` on every thesis it is attached to
- `DELETE /api/v2/zettel/{id}` — soft only; **edges are kept** ("what did this once contradict")
- `POST /api/v2/zettel/edges` — `{src_id,dst_id,rel,note}`; rel ∈ SUPPORTS/CONTRADICTS/REFINES/SUPERSEDES/FOLLOWS_FROM/CONTEXT. SUPERSEDES flips the target to `superseded` (still readable). CONTRADICTS logs `CONFLICT_OPENED`
- `PATCH /api/v2/zettel/edges/{id}` — resolve a contradiction: `resolution` required, optional `superseded_id` draws the SUPERSEDES edge in the same call
- `DELETE /api/v2/zettel/edges/{id}` — unresolved edges only (a settled disagreement is the record)
- `GET /api/v2/zettel/conflicts?thesis_id&include_resolved` — both sides in full + `open_count`
- `GET /api/v2/zettel/search?q` — FTS5 **trigram** (matches inside Thai text); falls back to LIKE on a malformed MATCH or an SQLite built without FTS5
- `GET /api/v2/zettel/graph?thesis_id|root_id&depth=1..4` — nodes + edges, BFS from the seed set
- `POST /api/v2/zettel/{id}/sources` · `DELETE /api/v2/zettel/sources/{sid}` · `GET /api/v2/zettel/sources/by-url?url=` (what else rests on this story)
- `POST /api/v2/zettel/{id}/refs` · `DELETE /api/v2/zettel/{id}/refs/{type}/{id}` — attach to thesis/trade/symbol
- `POST /api/v2/zettel/export-md` — mirror the base into `OBSIDIAN_WIKI_DIR/zettel/` with `[[wikilinks]]` + `INDEX.md`; returns `stale` files the DB no longer knows about
- `POST /api/v2/zettel/resolve-ref-collisions` — post-merge: two offline devices can mint the same `Z-00NN`; the older row keeps it (`ref` is indexed, NOT unique — a UNIQUE index would abort the sync import)

## Questions (`routers/questions.py`) — prefix `/api/v2/questions` (2026-10-01)

`GET /api/v2/questions` also takes `q` (LIKE over title / thought / ref / symbol, every thesis) — the QUESTIONS search box (2026-10-02).
Open questions a thesis is carrying. Schema in `db.init_questions_schema()`; six tables, all synced. Status is
derived on read, never stored. Agent writes carry `X-Thesis-Actor: agent:<name>`; an agent cannot review, drop,
reopen or delete (403). Next.js proxy: `app/api/v2/questions/[[...path]]/route.ts`.
- `GET /api/v2/questions?thesis_id&symbol&status` — `{questions:[QNode], counts}`
- `GET /api/v2/questions/counts` — `{pending, watch, clear, dropped, due, by_thesis}` (PORT badge, polled every 60 s)
- `GET /api/v2/questions/queue?limit&thesis_id` — for agents: OPEN (not awaiting review) + due WATCH, not claimed by another actor; sorted by `blocks` desc
- `GET /api/v2/questions/tree?thesis_id` — `{nodes, edges, counts, leaves:{total, clear}}`
- `GET /api/v2/questions/{id|ref}` — `{question, state, parents, children, answers[…signals, assumptions, review]}`
- `POST /api/v2/questions` — create; only `title` + (`thesis_id` or a parent) required — rows carry `gaps` (`parent` / `effect` / `thought`) for what is still missing; 422 when `if_a` == `if_b`; 409 on a second root or a duplicate title in the thesis
- `POST /api/v2/questions/import` — `{thesis_id?, questions:[{key, …QuestionIn, answer?}]}`; a parent may name an earlier item's `key`; one transaction — any refusal → `{code:"IMPORT_REFUSED", key, index, reason, written:0}` and nothing is written (MCP `question_import`)
- `PATCH /api/v2/questions/{id}` — `title`, `thought`, `priority`, `next_check`
- `POST /api/v2/questions/{id}/parents` — first parent for an unplaced question, or a second one (convergence); loops refused · `PATCH /api/v2/questions/edges/{edge_id}` `{if_a, if_b}` · `DELETE /api/v2/questions/edges/{edge_id}` (user only; removing the last one leaves the question unplaced)
- `POST /api/v2/questions/{id}/claim` (409 while another actor holds it, 2 h TTL) · `/release`
- `POST /api/v2/questions/{id}/answers` — 422 `{code:"ANSWER_REFUSED", level, missing:[…], hint}` when the level's shape is not met (rules in `memory/reference/question-research.md` §3)
- `POST /api/v2/questions/answers/{answer_id}/review` — `{decision: ACCEPTED|REJECTED, note}`; user only; REJECTED needs a note
- `POST /api/v2/questions/assumptions/{id}/check` — `{result: HELD|BROKEN, note, zettel}`; evidence zettel required
- `POST /api/v2/questions/{id}/drop` (reason required) · `/reopen` · `DELETE /api/v2/questions/{id}` (soft; refused while children hang under it) — user only
- `POST /api/v2/questions/resolve-ref-collisions`

## Tracking (`routers/tracking.py`) — prefix `/api/v2/tracking` (2026-10-02)
The numbers a thesis stands or falls on. Schema in `db.init_tracking_schema()`; three tables, all synced. Status is
derived on read, never stored. Agents (`X-Thesis-Actor: agent:*`) cannot move a kill line that is set, change a role,
retire, reopen or delete (403). Next.js proxy: `app/api/v2/tracking/[[...path]]/route.ts`. Protocol for agents:
`memory/reference/thesis-tracking.md`.
- `GET /api/v2/tracking?thesis_id&symbol&status` — `{metrics:[TMetric], counts}`, most urgent first (KILL → DUE → OFF → SETUP → WAITING → RETIRED, then by date)
- `GET /api/v2/tracking/counts` — `{kill, due, off, setup, waiting, retired, alert, by_thesis}`; `alert` = kill + due + off (PORT badge, polled every 60 s)
- `GET /api/v2/tracking/due?days=14&thesis_id` — for agents: KILL / DUE / OFF plus forecasts due within `days`; every row carries its source block
- `GET /api/v2/tracking/{id|ref}` — `{metric, state, periods[{period, expectation, reading, revisions, corrections}], question, series}`
- `POST /api/v2/tracking` — create; only `title` + `thesis_id` required — the row carries `state.gaps` (`source` / `kill_rule` / `expectation`); optional `expectation` written in the same transaction; 409 on a duplicate title in the thesis; 422 `{code:"METRIC_REFUSED", missing}` (kill_op without kill_value or kill_rule, unknown `series_id`, non-http `source_url`)
- `PATCH /api/v2/tracking/{id}` — any metric field + `reason`; changing a kill field that was already set, or `role`, is user-only and needs `reason` → thesis event `METRIC_RULE_CHANGED`
- `POST /api/v2/tracking/{id}/expectations` — `{period, expected, basis, low?, high?, evidence?[Z-ref], release_time?}` + one of `date` (D-ref) / `new_date` (a `DateIn`, inserted into `question_dates` in the same transaction) / `due_date`; 422 `{code:"EXPECTATION_REFUSED", missing}`; same period again = revision (new row); 409 once the period has a reading
- `POST /api/v2/tracking/{id}/readings` — `{value?, value_text?, as_of, zettel? | source_url + quote, verdict?, kill?, period?, expectation_id?, note?}`; 422 `{code:"READING_REFUSED", missing}`; verdict computed when the forecast has a band and `value` is numeric (a contradicting `verdict` is refused); a miss or a crossed kill line opens a question → reply carries `opened_question`; thesis event `METRIC_READ` or `KILLER_HIT`
- `POST /api/v2/tracking/{id}/retire` (reason required) · `/reopen` · `DELETE /api/v2/tracking/{id}` (soft) — user only
- `POST /api/v2/tracking/resolve-ref-collisions`

## Calendar (`routers/calendar_feed.py`) — 2026-10-08

The one calendar (the CAL view, key `6`). Read-only; logic in `backend/calendar_feed.py`. Next.js proxy:
`app/api/calendar/route.ts`. Writes from the calendar go through `POST /api/v2/theses/{id}/notes` (a dated note) or
`POST /api/v2/questions/calendar` (a date with no thesis) — there is no calendar table.
- `GET /api/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD&refresh=false` — default a week back → 45 days ahead; 422 on a bad
  date, `end < start`, or a window over 400 days. → `{as_of, start, end, events:[CalEvent], sources, theses}` (shape in
  `data-shapes.md`), soonest first. `refresh=true` queues a new Yahoo pull for every company symbol.
- Sources: MACRO = `event_calendar` (FOMC hardcoded, FRED `release/dates` asked a calendar year at a time so a month
  move hits its 12 h cache, rule dates); COMPANY = `stock_earnings_calendar` + `stock_dividends` per symbol, pulled on
  daemon threads and kept in `backend/cache/calendar_company.json` (fresh 6 h · failed 30 min, 6 h after three in a row
  · last good shown up to 30 d) — the request never waits, `sources.company.pending` lists what is still out; THESIS =
  `thesis_notes.watch_date`, `question_dates` (+ linked questions, tracked numbers), forecasts with only a `due_date`;
  PORT = `v_option_open_lots` expiries, `risk_decisions` HOLD `review_on`.
- Reminders are not a route: `calendar_scheduler.py` (every `CALENDAR_SCAN_INTERVAL`, default 1800 s) writes
  `alert_events` `rule_id = "cal:<KIND>"`, `bar_time = "<date>#<hash>"`; `GET /api/alerts/events` names them
  `CALENDAR · <KIND>` and gives `notify = ["ticker","toast"]` when the snapshot has a `thesis_id`, else `["ticker"]`.

## Anti-thesis (`routers/antithesis.py`) — prefix `/api/v2/antithesis` (2026-10-08)
Step back from a thesis: claims (what it believes) → objections (why each could be false) → verdicts. Status is derived
on read. Writes carry `X-Thesis-Actor`; an agent's verdict is a proposal, and an agent cannot review, withdraw, revise,
retire, delete or change a stake (403). Next.js proxy: `app/api/v2/antithesis/[[...path]]/route.ts`. Protocol for
agents: `memory/reference/anti-thesis.md`.
- `GET /api/v2/antithesis?thesis_id&include_closed=true` — `{claims:[AClaim], counts, summary{verdict, live, challenged_at}, angles, required_angles}`, most urgent first (FALLEN → BROKEN → CONTESTED → UNTESTED → STANDS → REVISED → RETIRED; KEY before SUPPORT)
- `GET /api/v2/antithesis/counts` — `{fallen, broken, contested, untested, stands, revised, retired, pending, due, settled, key_fallen, key_open, open, alert, by_thesis{…, verdict}}`; `open` = untested + contested + broken, `alert` = key_fallen + broken + pending + due (tab label, polled every 60 s)
- `GET /api/v2/antithesis/queue?thesis_id&limit=20` — for agents: `objections` (OPEN, or UNDECIDED past `next_check`) then `claims` with `gaps` / `untried` angles
- `GET /api/v2/antithesis/{id|ref}` — `{claim: AClaim}`
- `POST /api/v2/antithesis` — `{statement, thesis_id, negation?, basis?, stake?}`; 422 `{code:"CLAIM_REFUSED", missing}`; 409 when the belief is already on the board
- `PATCH /api/v2/antithesis/{id}` — `negation` / `basis` by anyone; `stake` user-only; `statement` only while no objection row exists (409 after) and, for a user-written claim, user-only
- `POST /api/v2/antithesis/{id}/revise` — `{statement, negation?, reason}` user-only → new claim with `revises_id`, thesis event `ANTI_REVISED`
- `POST /api/v2/antithesis/{id}/retire` (reason required) · `/reopen` · `DELETE /api/v2/antithesis/{id}` (soft) — user only
- `POST /api/v2/antithesis/{id}/objections` — `{argument, angle?, would_see?, look_where?, parent?}` → `{claim, objection_id, objection_ref}`; 409 on a duplicate or a REVISED / RETIRED claim
- `POST /api/v2/antithesis/{id}/sweeps` — `{angle, searched}`: the angle was searched and gave no objection; 409 when the angle already has one
- `PATCH /api/v2/antithesis/objections/{id}` — `angle` / `would_see` / `look_where` only
- `POST /api/v2/antithesis/objections/{id}/verdicts` — `{result REBUTTED|CONCEDED|UNDECIDED, reasoning, evidence?[Z-ref], consequence? REVISE|FALLS, revised_statement?, revised_negation?, searched?, next_check?}`; 422 `{code:"VERDICT_REFUSED", missing}`; reply `{claim, verdict_id, proposal, revised_to?}`
- `POST /api/v2/antithesis/verdicts/{id}/review` — `{decision ACCEPTED|REJECTED, note}` user-only (REJECTED needs a note); ACCEPTED on CONCEDED + REVISE writes the new claim (`revised_to`)
- `POST /api/v2/antithesis/objections/{id}/withdraw` (reason required, user only) · `POST …/objections/{id}/question` — opens (or reuses) a `questions` row, idempotent
- `POST /api/v2/antithesis/import` — `{thesis_id, claims:[{statement, negation, stake, basis, objections[], none_found[]}]}`, one transaction; 422 `{code:"IMPORT_REFUSED", item, statement, missing}`
- `POST /api/v2/antithesis/resolve-ref-collisions`

## Series (`routers/series.py`) — prefix `/api/v2/series`
Generic indicator series: any number a publisher puts out over time that is **not** a tradable instrument (industry spot prices, freight rates, survey indices). Two tables — `series_meta` (head row) + `series_points` (one number on one day, PK `(series_id, date)`), both in `SYNC_TABLES`. Collectors live in `backend/series_sources/`; adding a source is one file + `register()`, no endpoint or UI change. First collector: `dramexchange` (DRAM/NAND/module/memory-card spot from the public home page + DRAM/NAND/SSD contract prices from its own `/Home/HomePrice` JSON).
**The history is ours.** DRAMeXchange's charts are members-only, so there is no back-fill: `series_scheduler.py` records a point a day (same design as `iv_snapshots`) and a day nobody recorded stays a hole.
- `GET /api/v2/series/groups` — boards that exist + series count + freshness. The UI builds its selector from this
- `GET /api/v2/series?group=&section=&source=&days=60` — every series on a board with inlined points for a sparkline, `change_pct` (publisher's own), `window_change_pct`, `point_count`, `stale_days`
- `GET /api/v2/series/{id}?days=365` — one series' recorded history (the big chart)
- `POST /api/v2/series/refresh?source=` — pull now; failures come back per source, never as a 500
- `DELETE /api/v2/series/{id}?purge_points=` — drop a series from the board; points are kept unless purged
Scheduler: `series_scheduler.start_background_recorder()` from `main.py`, pass every 4h (`SERIES_REFRESH_INTERVAL`, 0 disables), self-gating on "did we read today (Taipei)" + one re-read after 19:00 GMT+8 when the publisher updates spot.

## Chart drawings (`routers/chart_drawings.py`) — prefix `/api/v2/chart-drawings` (2026-09-27)
Trend lines + REG channels the user draws on a chart. SQLite `chart_drawings`, in `SYNC_TABLES` (key `id`, client uuid) → reaches the other machine. Write prefix in `SYNCED_WRITE_PREFIXES` (push), not gated.
- `GET /api/v2/chart-drawings?symbol=` — `{drawings:[{id,kind,symbol,barInterval,data,createdAt}]}`, oldest first
- `PUT /api/v2/chart-drawings/{id}` — create or replace (UPDATE-then-INSERT, never REPLACE → no stray tombstone)
- `DELETE /api/v2/chart-drawings/{id}` — `{deleted: n}`
- `POST /api/v2/chart-drawings/import` — `{drawings:[{id,...}]}` insert-if-absent → `{imported, received}` (localStorage migration)
Proxy: `app/api/v2/chart-drawings/[[...path]]/route.ts`. Frontend: `chart/useChartDrawings.ts`.

## Reads (`routers/reads.py`) — prefix `/api/v2/reads` (2026-10-02)

Read marks for PORT → TOOLS. Types: `thesis` · `note` · `zettel` · `answer` · `graph` · `reading`. Proxy `app/api/v2/reads/[[...path]]/route.ts`. No cache.

- `GET /api/v2/reads/unread?thesis_id=` — `{items: [{type, id, thesis_id, parent_id}], by_thesis: {id: {total, thesis, note, zettel, answer, graph, reading}}, total}`. `parent_id` = question of an answer / metric of a reading. `by_thesis[""]` = items attached to no thesis.
- `POST /api/v2/reads` `{items: [{type, id}]}` and/or `{thesis_id, types?}` (everything unread under that thesis) → `{marked}`. Agent actor → 403; unknown type → 422.
- `POST /api/v2/reads/unmark` `{items}` — back to unread (row kept with `seen_at = ''`, so it syncs as an update).
- Unread = no mark and `actor != 'user'`, or the item's stamp (`updated_at`; `created_at` for answers / readings) is later than `seen_at`. Thesis and note writes by the user mark themselves (`mark_if_user`); accepting or rejecting an answer marks that answer.

## Graphs (`routers/graphs.py`) — prefix `/api/v2/graphs` (UI label: RESEARCH since 2026-10-02)
Rendered analysis pages. The HTML is a file (`GRAPHS_DIR/<slug>/index.html`, older versions `v<N>.html`, `meta.json` beside it); SQLite only indexes it. Schema in `db.init_graphs_schema()`. Cloud-synced since 2026-09-19: the row via `SYNC_TABLES` (key `slug`), the FILE via `sync/files.py` (`<sync>/research/<slug>/index.html` + `manifest.json` — the cloud folder was `graphs/` until 2026-10-02; `adopt_legacy` renames it, or copies newer pages across when an old-code peer recreates it, sha256 compare, a locally-changed page is never clobbered). `v<N>.html` stays local.
- `GET /api/v2/graphs?symbol&thesis_id&q&limit` — index, newest first, never includes the HTML
- `GET /api/v2/graphs/{slug}?include_html` — metadata (+ `render_url`, `file`); `include_html=true` adds the source
- `GET /api/v2/graphs/{slug}/render?v=&shell=` — the page itself as `text/html` under a strict CSP (`default-src 'none'`, inline style/script only, `img-src data:`, `font-src data:`) + `nosniff`. `backend/graph_shell.py` wraps the stored content at render time: masthead, academic typography, Laksaman (`@font-face` from `research/graphs/_assets/*.woff2` as a data: URI — the CSP blocks Google Fonts) and a contents rail down the LEFT built from the page's `<h2>`/`<h3>` (2026-09-20 — it used to be a sticky tab strip across the top; under 1040px wide it collapses back into a `☰ Contents` dropdown). `shell=0` returns the raw file. The Next proxy passes the response through untouched instead of parsing it as JSON
- `POST /api/v2/graphs` — `{title, html, slug?, symbol?, thesis_id?, zettel_refs?, tags?, as_of?, sources[]}`; 409 on a duplicate slug, 413 over 4MB. `html` is the CONTENT, not a document (`research/graphs/_template.html`): 400 when it loads a network resource (the CSP blocks it → a hole in the page), `warnings[]` in the response when it has no `<h2>` or ships its own `<html>`. With `thesis_id` logs `GRAPH_ADDED`
- `PATCH /api/v2/graphs/{slug}` — new `html` bumps `version` and copies the old page to `v<N>.html`; logs `GRAPH_UPDATED`
- `DELETE /api/v2/graphs/{slug}` — soft only, files stay on disk. No MCP tool for this on purpose
- Slug is resolved under `GRAPHS_DIR` and anything escaping it is refused — it arrives from a URL path segment

### MCP server (`backend/mcp_server.py`, stdio; setup → `docs/mcp-server.md`)
Claude Code: `/.mcp.json` (repo root). Claude Desktop: `%APPDATA%\Claude\claude_desktop_config.json` — absolute interpreter path + `PYTHONIOENCODING=utf-8`, does NOT read `.mcp.json`. Any other MCP client takes the same command/args/env. `MCP_AGENT_NAME` distinguishes clients in the timeline (`AGENT·<NAME>` + zettel `actor`). `MCP_TRANSPORT=streamable-http MCP_PORT=9319` serves the same tools at `http://127.0.0.1:9319/mcp` for agents that cannot spawn a process (loopback only — no auth of its own).
HTTP client over the running backend (`PYTHON_API_URL`, default :9317) — never opens the DB. 30 tools: theses `list_theses` `get_thesis` `notes_due` `create_thesis` (always draft) `update_thesis` (reason required) `log_event` (NOTE/REVIEW/EVIDENCE/CHECKPOINT) `add_note` `update_note` `link_trade` · context `get_positions` · trade history `get_trade_coverage` `get_trades` `get_trade` `get_trade_stats` `get_option_trades` (router `trade_history.py`; a list over the 40k cap is cut on a row boundary by `_out_rows` and marked `complete: false`, never mid-JSON) · research `get_stock_data(kind)` `get_price_history` `get_news` `get_filings` · knowledge base `zettel_search` `zettel_list` `zettel_get` `zettel_create` `zettel_update` `zettel_link` `zettel_add_source` `zettel_attach` `open_conflicts` `resolve_conflict` `zettel_by_source` · analysis graphs `graph_list` `graph_get` `graph_create` `graph_update`. Prompts `review_thesis`, `triage_conflicts`. **No delete tool** by design. Output capped at 40k chars.

## Portfolio Risk (`routers/risk.py`)
- `GET /api/v2/portfolio/risk/metrics` — VaR/CVaR 1D–6M with √T scaling (Basel). **2026-09-29:** weights on a NAV basis — cash in the denominator, short lots as negative weights (were dropped), open options as delta-equivalent underlying exposure (`_option_exposure`); + `nav_value`, `cash_value`, `gross_exposure_pct`, `net_exposure_pct`, `short_value`, `option_delta_value`. `var_backtest_*` / `kupiec_*` are now ROLLING OUT-OF-SAMPLE (`_var_backtest_oos`, each day vs the VaR of the prior ≤126 days; `var_backtest_obs`, `var_backtest_method`) — the old in-sample count could not fail
- `GET /api/v2/portfolio/risk/var-backtest?account_id=all` — live VaR test: `var_forecasts` rows (one per day, written by the guard notifier via `_record_var_forecast`) scored against the NEXT trading day's base-currency return of the same holdings. `{rows[{forecast_date, return_date, realized_pct, coverage_pct, hist, hist_exception, cvar…, cf…, ensemble…}], summary{hist|cvar|cf|ensemble: {n, exceptions, rate_pct, expected_pct, kupiec_p, signal}}, pending, first_forecast}`; signal INSUFFICIENT_DATA until n ≥ 30
- `GET /api/v2/portfolio/risk/stop-sim?account_id=&horizon=20&n_paths=1000&fresh=` — stop-discipline simulator (`backend/stop_sim.py`): book NAV over H days if every home-market factor (S&P 500 `^GSPC`, SET50 `TDEX.BK` [^SET.BK has 1 bar on Yahoo; fallback THD], BTC, gold) moves +1/0/−1/−2 SD (Brownian bridge), stocks = β·factor + t(4) noise; DISCIPLINED (exit at stop, gap → close, already-below sold day 0) vs HOLD, same draws. Per scenario & rule: p10/p50/p90 index path, median/p90 drawdown path, final percentiles, max-DD p50/p90, P(loss>10%), `stop_prob` per holding, `avg_stops`; plus `factors`, `holdings` (β, resid vol), `thin_history`. Cached 10 min. No UI consumer since 2026-09-29 (proxy removed) — the UI uses `what-if-sim`.
- `POST /api/v2/portfolio/risk/what-if-sim` — body `{account_id?, horizon=20, n_paths=1000, target_volume: {"<account>|<yf_symbol>": shares_after}, follow_stops=true, fresh=false}`. The real book two ways over the same paths: `disciplined` = DO (trades filled today at today's price, no fees; sold money → cash 0%, bought money out of cash — may go negative; then stops if `follow_stops`) vs `hold` = DON'T (book as is). Same shape as `stop-sim` plus `follow_stops`, `do_cash`, `do_turnover`, `holdings[].key/scale/do_value`, `positions[]` (guard rows: key, account_id, symbol, volume, price, stop, to_stop_pct, market_value, weight_pct, flags, override) and `suggestions[]` `{key, code STOP_HIT|OVERWEIGHT, target_volume, text, overridden}` (STOP_HIT → 0; OVERWEIGHT → back to `trade_guard.MAX_WEIGHT` of invested value). `stop_prob` is keyed by `key`. Slow inputs (guard snapshot, β/vol, factor cov) cached 10 min in `_sim_inputs`; each what-if ≈ 1 s. Proxy `app/api/v2/portfolio/risk/what-if-sim`.
  - 2026-10-02: body `market: "sd"|"random"` (default `sd`). `random` = ONE scenario with `k: null` where the factors are NOT pinned (zero drift, historical cov) — the band then includes market risk, so `p_loss` reads as a (model) probability; scenario also has `market_move_range {factor: [p10,p50,p90]}`. Every scenario now has `diff_value {p10,p50,p90}` = per-path DO − DON'T at the horizon in THB (same draws both sides) and `p_do_better` (% of paths DO ends > DON'T + 0.005); per rule `p_loss`, `p_loss_gt_5`. The UI's "ทำ − ไม่ทำ" reads `diff_value.p50` (it used to difference two medians rounded to 0.01 % → quantised to 0.01 % of NAV).
- `GET /api/v2/portfolio/risk/monte-carlo?account_id=&horizon=63&n_paths=20000&vol=current|longrun&drift_annual_pct=0&base_currency=THB&fresh=` — Monte Carlo of the book AS HELD, nothing traded (2026-10-02, `backend/port_mc.py`, PORT → RISK → MONTE CARLO). Bounds: `horizon` 5–252 trading days, `n_paths` 1,000–50,000, `drift_annual_pct` −50…100. Scope: no `account_id` / `all` = every account as ONE book (a symbol held in two accounts is one row; `groups` = each account's share of the worst-5% loss); an account id = that account's holdings + cash only (`groups: []`). Model = filtered historical simulation: each step draws one WHOLE historical day of standardized residuals for all holdings (no correlation matrix, no bell curve), scaled by a per-holding GARCH(1,1) variance (α 0.06 / β 0.92 fixed, variance-targeted, capped at 16× long-run); SIMPLE returns with mean-0 residuals → every price is an exact martingale + `drift`. `vol=current` starts from today's filtered variance, `longrun` from the 3y average (≈ a plain bootstrap). Returns are in `base_currency` (FX moves are inside the residual days). Options = delta-equivalent exposure, not in NAV. `_mc_inputs` (positions, cash, option deltas, 750 aligned days via `_aligned_returns(common_only=False)`, residuals, new listings back-filled from their home-market factor by `port_mc.backfill`) is cached 10 min per (scope, base, **book stamp**) — `_mc_book_stamp` = hash of the open stock + option lots, so a buy/sell is in the very next call; prices, cash and history wait for the 10 min or `fresh=true`. Each result is cached 10 min per (scope, base, horizon, paths, vol, drift) and tied to its inputs' stamp. Nothing runs in the background — it is computed when asked. A holding lost by the joint download is fetched once more on its own; one with < 60 bars is listed in `excluded` and its exposure spread over the rest. Speed: 20k × 63 d × 16 holdings ≈ 0.07 s (4 threads), 50k × 252 ≈ 0.55 s; a cold call adds the history download (~3 s). Shape: `data-shapes.md`. Proxy `app/api/v2/portfolio/risk/monte-carlo`.
- `GET /api/v2/portfolio/risk/rebalance?account_id=&fresh=` — take-profit rebalance (2026-10-02, `backend/rebalance.py`). Weights + targets from `/allocation-detail` (target = explicit `allocation_targets` symbol row, else COST weight); TRIM when gain ≥ `min_gain_pct` AND weight − target > band (5/25 rule: min(`band_abs_pp`, `band_rel_pct`% × target); explicit `band_pct` wins) AND timing passes (`min_hold_days` since first open lot, `min_gap_days` since last closed sell, earnings blackout `earn_before_days`/`earn_after_days` via `/api/stock/earnings-calendar` for candidates only). Size by `rebal_to` half|band|target, board lot SET 100 / crypto fractional / else 1 (rounded DOWN). Statuses TRIM · HOLD (a TRIM declined for now — live `risk_decisions` REBALANCE HOLD on that symbol; row keeps its numbers but leaves `counts.TRIM`, `sell_value`, `trades` and the weekly alert; past `review_on` it is a TRIM again with `hold_ended`, 2026-10-07) · WAIT (`ready_on`) · SMALL · WATCH · OK · SKIP. Cached 5 min per (account, rules); a decision write clears the cache. Shape in data-shapes.md. Proxy `app/api/v2/portfolio/risk/rebalance`.
- **`/risk/balance` targets (2026-10-08):** `level=symbol|sector|thesis|account` says what a "part" is; `target=auto|equal`. Targets are the user's risk budgets at that level (`PUT /risk/budget` with `scope` = level — `account` is accepted there too and stored in the same `risk_budgets` row as `budget.account`; the budget table itself stays symbol / sector / thesis). A part with no target takes an equal piece of what is left of 100%, a group's share is split equally among its holdings, no target at all = 1/n per part. Keys: symbol = yf symbol (same as the BUDGET page), sector = sector label, thesis = thesis id, account = account id. `level=account` needs the all-accounts view (a symbol held in two accounts is two rows with `account`); otherwise `rows: []` + `note`. Response adds `level`, `n_groups`, `target_mode`, `budgets`, `budgets_all`; each plan adds `groups[{key, label, n, target_pct, source, weight/risk now → after, trade_value}]`; rows add `key`, `account`, `group`, `group_label`, `target_risk_pct`, `target_source` (budget | remainder | equal).
- `GET /api/v2/portfolio/risk/balance?account_id=&cash=&lookback=252&base_currency=THB` — what to trade so that no holding carries more than its share of the risk (2026-10-07, `backend/risk_balance.py`, PORT → RISK → สรุป → "ทำให้ความเสี่ยงสมดุล"). Balance = Equal Risk Contribution. `rebalance` = sell + buy, money in the book unchanged, reaches 1/n each. `add` = buy only: `cash_to_balance` is the new money that reaches balance without selling (T = max value_i / w*_i); `cash` smaller than that scales the same buys down (`fraction_pct`), omitted = full. Each plan: `rows[{symbol, yf_symbol, currency, price, weight_now_pct, weight_after_pct, risk_now_pct, risk_after_pct, trade_value (+ buy / − sell, base ccy), shares}]`, `buy_value`, `sell_value`, `vol_now_pct` / `vol_after_pct` (annualised, invested book), `top2` + `top2_risk_now_pct` / `_after_pct`, `max_risk_after_pct`. Stock positions only; cached 5 min per book stamp. Proxy `app/api/v2/portfolio/risk/balance`.
- `GET /api/v2/portfolio/risk/bear-paths?account_id=&p_down=0.6&n_paths=10000&vol=current|longrun&base_currency=THB&fresh=` — down-tilted paths (2026-10-07, `backend/bear_paths.py`, PORT → RISK → สรุป strip + MONTE CARLO · ขาลง). The book AS HELD through random paths that hold MORE losing days than winning ones, at 3 / 5 / 7 / 21 / 42 trading days. Down day = a window day on which today's book (today's weights, long-run σ) lost money; per path k ~ Binomial(H, `p_down`) kept only when k > H/2, positions random; whole historical days drawn (FHS + GARCH, same inputs as Monte Carlo — `_mc_inputs`). Each horizon is its own run with a neutral run beside it (`base`). `p_down` 0.5–0.95. A stress, not a forecast; stops / trades not modelled. Cached with the Monte Carlo (10 min, book stamp in the key). Proxy `app/api/v2/portfolio/risk/bear-paths`.
- `GET /api/v2/portfolio/risk/decisions?account_id=&kind=&symbol=&limit=200` — risk decision journal, newest first (2026-10-07, `backend/risk_journal.py`, table `risk_decisions`): why a stop or a rebalance was held, followed or changed. `kind` STOP | REBALANCE | BUDGET | OTHER; `decision` HOLD | FOLLOW | CHANGE | NOTE; `active` = HOLD not ended and inside `review_on`. An account filter also returns book-wide rows (no account).
- `POST /api/v2/portfolio/risk/decisions` `{kind, decision, reason, account_id?, symbol?, yf_symbol?, snapshot?, review_days?}` — 400 without a reason, on an unknown kind / decision, a HOLD without a symbol, `review_days` outside 1–365, or kind STOP + HOLD (that one is written by `POST /guard/override`, which mirrors every stop HOLD into the journal with `source='guard'`, `ref_id` = override id). A REBALANCE HOLD ends the previous live hold on the symbol (`cleared_at`) and clears the rebalance cache. `PATCH /trades/{id}` that moves `price_stoploss` on an open lot writes STOP · CHANGE (`source='trade_edit'`, reason = `adjustment_reason`).
- `DELETE /api/v2/portfolio/risk/decisions/{id}` — end a live HOLD now; the row stays (`cleared_at`). 400 for a guard hold (ended from TRADE GUARD; `DELETE /guard/override/{id}` removes its mirror row) or a row that is not a live HOLD. Rows are never edited or deleted otherwise. Proxies `app/api/v2/portfolio/risk/decisions[/[id]]`.
- `PUT /api/v2/portfolio/risk/rebalance/rules` — merge partial rules (400 on invalid); `DELETE …/rebalance/rules` → defaults. Stored in `rebalance_rules` (machine-local, not synced). Proxy `app/api/v2/portfolio/risk/rebalance/rules`. The guard notifier uses the same rules: `guard:REBALANCE` alert once per holding per ISO week while it stays a TRIM.
- `GET /api/v2/portfolio/risk/factors?account_id=&lookback=252&base_currency=THB&fresh=` — factor exposure (2026-10-07, `backend/factor_exposure.py`, PORT → RISK → FACTOR). The book's returns regressed on market-wide factors, each a Yahoo ETF or a spread of two: `MKT_US` SPY · `MKT_TH` TDEX.BK (only with `.BK` holdings) · `SIZE` IWM−SPY · `VALUE` IWD−IWF · `MOM` MTUM−SPY · `RATES` IEF · `CREDIT` HYG−IEF · `USDTHB` THB=X · `OIL` USO · `GOLD` GLD · `CRYPTO` BTC-USD (only with crypto holdings). One multiple OLS on **5-day overlapping sums of simple returns** (a Thai stock closes before New York opens, so daily betas to US factors read near zero), Newey-West t (Bartlett, 8 lags); book beta = Σ weight × holding beta exactly. Per factor: `beta`, `t_stat`, `significant` (|t| ≥ 2), `risk_share_pct` (β·cov(f, fitted)/var — the shares sum to R², the rest is `specific_pct`), `vif`/`collinear` (≥ 5), `sd_1m_pct` and `impact_1sd_pct`/`impact_1sd_amount` (a one-SD month of the factor → the book), `top` (3 holdings by weight × beta). Holdings are in `base_currency` (FX inside), factors in their own currency — the currency bet lands on `USDTHB`. NAV weights as `/metrics` (cash, shorts, option delta). `lookback` 120–1260; a holding needs ≥ 120 bars (`excluded`), a factor leg with no data drops its factor (`missing_factors`); < 60 observations → `error: "not enough history"`. Cached 5 min per (account, lookback, base), errors included. Shape: `data-shapes.md`. Proxy `app/api/v2/portfolio/risk/factors`.
- `GET /api/v2/portfolio/risk/budget?account_id=&scope=symbol|sector|thesis&lookback=252&base_currency=THB` — risk budget (2026-10-07, `backend/risk_budget.py`, PORT → RISK → BUDGET). Risk in use = Euler contribution to volatility (`w·(Σw)/σ`), the **same weights and Ledoit-Wolf covariance as `/metrics`** (`risk_pct` equals its `risk_contribution_pct`). Buckets: holding (key = yf symbol) · sector (`trades.sector`, `Other`, `Options`) · thesis (explicit `thesis_links` row, else the newest live thesis on the symbol, else `_none`). Status with `band_pp` tolerance: `OVER` (+ `trim_value`/`trim_pct`) · `UNDER` (+ `add_value`) · `OK` · `UNSET` (holdings, no budget) · `EMPTY` (budget, no holdings). `trim_value` is solved by bisection with the other buckets held still — a pro-rata cut is too small, because selling lowers the book's volatility too. `vol` = the book's annual volatility against `vol_cap_pct` (`derisk_pct` of every holding to cash when over). 400 on an unknown scope. Not cached (a saved budget must show at once; prices come from the 5-min close-frame cache).
- `PUT /api/v2/portfolio/risk/budget` `{account_id?, scope?, budgets?{key: pct}, vol_cap_pct?, band_pp?}` — `budgets` REPLACES the whole set of `scope`; `vol_cap_pct` changes only when the key is sent (`null` clears it); 400 when a scope's budgets exceed 100% or a value is out of range. `DELETE …/budget?account_id=` forgets every scope, the cap and the band of that book view. Stored in `risk_budgets` (one row per book view, machine-local, not synced). Nothing sets a budget but the user; nothing here trades. Proxy `app/api/v2/portfolio/risk/budget` (GET · PUT · DELETE).
- `GET /api/v2/portfolio/risk/capm` — `α = Rp − [rf + β(Rm − rf)]` โดย `Rp` = CAGR/XIRR จาก `/returns` (ช่วงของบัญชีเอง), `Rm` = benchmark ช่วงเดียวกัน (`_index_return`, แปลงเป็นสกุลรายงาน), `β` = Σwᵢβᵢ ของที่ถือวันนี้ — **ไม่มีตัวไหนอ่าน `date_entry`/`date_exit`**. Fields: `beta`/`beta_local`/`hedge_notional`/`market_value` · `return_annual_pct`/`return_xirr_pct`/`holding_days`/`first_date` · `index_annual_pct`/`index_cumulative_pct` · `expected_annual_pct` · `alpha_annual_pct`/`alpha_xirr_annual_pct`/`excess_vs_index_pct` · `r_squared`/`benchmark_fit` (WEAK เมื่อ R²<0.10) · `excluded_symbols` (ประวัติ <60 แท่ง). Params: `benchmark`, `lookback`, `account_id`, `base_currency`, `rf_annual` (optional — ไม่ส่ง = ดึงสด: THB → BOT policy rate, USD → FRED `DGS3MO`, cache 12 ชม.; response มี `rf_source`/`rf_series`/`rf_as_of`/`rf_currency`).
- `GET /api/v2/portfolio/risk/correlation` — correlation matrix (Ledoit-Wolf shrinkage)
- `GET /api/v2/portfolio/risk/stress` — stress test scenarios
- `GET /api/v2/portfolio/risk/position-size` — Kelly criterion position sizing
- `GET /api/v2/portfolio/risk/parity` — Equal Risk Contribution (ERC) rebalance actions
- `GET /api/v2/portfolio/risk/risk-free?base_currency=` — อัตรา risk-free สดของทุกสกุลที่รองรับ (THB → BOT policy rate; USD → FRED `DGS3MO` แล้ว fallback `^IRX` ผ่าน yfinance ซึ่งไม่ต้องใช้ API key) + `alternatives[]` คืนทุกแหล่งที่ตอบเพื่อให้เทียบกันได้ พร้อม `source`/`series`/`as_of` + `fallback`; ใช้ป้อนแผงตั้งค่า rf ใน ANALYTICS (override เก็บที่ `localStorage["bloomberg_capm_rf"]` แยกตามสกุล)
- `DELETE /api/v2/portfolio/risk/cache` — clear caches
- `GET /api/v2/portfolio/risk/guard?account_id=&base_currency=` — **TRADE GUARD (2026-09-28)**: traffic light GREEN/YELLOW/RED + Thai action lines for a fast-turnover book. Stop per open long = manual `price_stoploss` else entry × (1 − 2×ATR14 at the first lot's date, clamped 5–12%), no history → 8%. Per holding: STOP_HIT (RED) · NEAR_STOP (last ⅓ of entry→stop) · TIME (≥28d and < +2%, strategy Value/Core exempt) · OVERWEIGHT (>10% of invested) · SECTOR (>25%). Book: DAY_LOSS (≤ −2% vs prev close, RED) · DD_HALF/DD_STOP (REAL NAV index drawdown from 1y peak ≤ −5% / −10%, via `get_nav_index`) · STREAK (≥4 consecutive losing closes). `size_multiplier` 1 / 0.5 / 0. HOLD overrides turn a holding's codes into INFO lines (not counted in the light) until their review date / floor. Missing data → DATA action (fail-closed). Response carries `scan` (notifier heartbeat). Notifier: STOP_HIT and DD_STOP re-fire once per day while they stand (2026-09-30). Alerts only — never places orders. Rules in `backend/trade_guard.py` (pure; `tests/test_trade_guard.py`, `tests/test_trade_guard_api.py`); history via `market_snapshots.history_future(…, "2y")`.
- `POST /api/v2/portfolio/risk/guard/override` body `{account_id, yf_symbol, first_entry, symbol?, codes[], reason, review_days?=14 (1–365), floor_price?}` — record HOLD for one holding period; `reason` required (`{ok:false, error:"reason required"}`); returns `review_on`. The HOLD ends by itself on `review_on` or when price ≤ `floor_price`; a newer HOLD on the same holding sets `cleared_at` on the old row. `DELETE /api/v2/portfolio/risk/guard/override/{id}` — undo (hard delete). Table `guard_overrides` (synced).
- `GET /api/v2/portfolio/risk/guard/size?symbol=&price=&currency=&account_id=&base_currency=&stop=` — S/M/L = 3/6/10% of NAV (invested + cash of the account) × `size_multiplier`; volume, notional, risk if the auto stop fills; `.BK` floors to 100-share lots. Used by ENTRY (`GuardSizePicker`). **+ `risk=` / `notional=` / `risk_stop=` (base ccy, 2026-10-01; `risk_stop` = the form's stop → row `STOP`)** → `risk_plan` (`trade_guard.risk_size`): volume per stop distance (1/1.5/2/3/4×ATR unclamped; 5/8/12/20% without history; + manual stop) that loses exactly `risk`, buy+sell fees included via `broker_fees` when the account has a profile (Dime US); `notional` → the stop that amount implies. Guard multiplier NOT applied (reported beside).
- `GET /api/v2/portfolio/risk/guard/report?account_id=` — closed trades in R-multiples (1R = guard stop distance at entry): summary / followed / broke / overridden, `capped_expectancy_r` (breaks cut at −1R, upper bound), `break_counts` (LOSS_PAST_STOP = loss past 1.5R, HELD_LOSER = loser held ≥28d), monthly, by_strategy, worst 10. Cached 15 min. **2026-09-29:** replays each closed lot on RAW daily bars (`history_future(..., auto_adjust=False)`): per trade `mae_pct`, `mfe_pct`, `cf_return_pct` (with the guard stop; open ≤ stop → open fill), `entry_mismatch` (price_entry outside ±10% of the entry-day range = AVCO carried from an earlier holding → not replayed); `counterfactual` {actual vs stop avg/sum/win/worst, stopped_pct, winners_cut, losses_saved, coverage_pct, entry_mismatch[]}; `sweep` over −3…−20% and 1…4×ATR (no clamp).
- `POST /api/v2/portfolio/risk/guard/apply-stops` body `{account_id?, dry_run=true}` — writes the guard's ATR auto stop into `price_stoploss` of OPEN lots that have none (DEFAULT-8% holdings skipped, existing stops untouched); a real run first backs up to `backend/backups/portfolio.db.bak-<ts>-pre-guard-stops`. Returns `{dry_run, lots, plan[{symbol, stop, stop_distance_pct, below_stop, lot_ids}], skipped, backup?}`. UI: TRADE GUARD → WRITE STOPS → CONFIRM WRITE.
- Notifier `backend/guard_scheduler.py` (every `TRADE_GUARD_SCAN_INTERVAL`, default 900s): flag TRANSITIONS → `alert_events` rows `rule_id = guard:<CODE>` (ticker + toast; named in `alert_rules.list_events`). First run seeds `guard_state` silently.

## Margin — IBKR Reg T (`routers/margin.py`, model `backend/margin.py`) — 2026-09-29
Proxy: `app/api/v2/portfolio/margin/[[...path]]` (GET + PUT, 60 s timeout). No cache — each call values the account.
- `GET /api/v2/portfolio/margin/status?scope=port|paper&account_id=X` → full status (see data-shapes "Margin"); `{enabled:false,…}` when off
- `GET /api/v2/portfolio/margin/overview` → `{accounts:[…], worst}` every enabled account, worst level first (status-row ribbon)
- `GET|PUT /api/v2/portfolio/margin/settings` — body `{scope, account_id, enabled, maint_long, maint_short, initial, overrides:{SYM: rate}, thresholds:{WATCH,WARNING,DANGER}}`. PUT on a `port` account also sets `portfolio_accounts.account_type='margin'`.
- PORT book = `_open_positions_enriched` + `get_summary().cash_base` (derived cash → `cash_is_estimate` until reconciled). PAPER book = `paper_positions` @ live + `_get_cash` (now incl. option premium) + open options valued by `portfolio_options.value_option_rows`.
- PAPER with margin on: market/pending buys and option orders must keep Reg T Available Funds ≥ 0 (`paper_check`), else 400 "Insufficient margin (Reg T)…".
- Notifier `backend/margin_scheduler.py` (`MARGIN_SCAN_INTERVAL`, default 300 s): level worsens → `alert_events` `rule_id = margin:<LEVEL>`, symbol = account name; first sight fires for WARNING+.
- Proxies `app/api/v2/portfolio/risk/guard/{route,override/route,override/[id]/route,size/route,report/route}.ts`

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

## Bonds (`routers/bonds.py`) — BOND view `B` (2026-09-25)
- `GET /api/bonds/overview` — 10 FRED daily series (DGS2/10/30, THREEFYTP10 [KW 10Y-zero TP; was THREEFFTP10 = forward TP until 2026-09-26], DFII10, BAMLC0A0CM,
  BAMLH0A0HYM2, BAMLC0A4CBBBEY, DAAA, DBAA) + derived 2s10s, Baa−Aaa → KPIs (1d/5d/20d bp, 1Y pctile)
  + aligned ~2y history. Cache 1h (10 min when any series failed).
- `GET /api/bonds/decomposition` (2026-09-26) — 10Y = expected real + breakeven + term premium.
  FRED DGS10/DFII10/T10YIE (since 2003) + NY Fed ACM daily `.xls` (ACMY10/ACMTP10/ACMRNY10, ~10 MB,
  needs `xlrd`); ACM down → Kim-Wright THREEFY10/THREEFYTP10 fallback (`model: "KW"`). Pure math in
  `backend/bond_decomposition.py`: snapshot of both lenses + double-count overshoot, attribution
  1/5/20/60d (driver REAL/BE/TP = largest piece in direction of Δ, |Δ|≥10bp), tripwires (TP > prior
  10y high, BE ≥2.5 → 20y high, 10Y 5.5%; TP+BE both breached = `flip`), 20y/10y context, 520d history.
  Cache 3h (20 min on any error).
- `GET /api/bonds/supply` — Treasury auctions (fiscaldata `auctions_query`, no key, last 190d + announced):
  high yield (bills = `high_investment_rate`), bid-to-cover, dealer/indirect % of competitive; weekly
  bills vs coupons $bn; slow FRED `NCBDBIQ027S` (Z.1, $M→$bn), `BUSLOANS`, `DRTSCILM`, `GFDEBTN`. Cache 6h.
- `GET /api/bonds/issuance` — corporate-deal proxy from SEC EFTS (`q="aggregate principal amount"`,
  forms 424B2/424B5, one query per day, paged 100). Rows keyed on `adsh`; classified by SIC:
  BANK (6021/6022/6029/6035/6036/6199/6211 = structured notes, excluded) · ABS 6189 · SOV 8888 · FIN
  other 6xxx · CORP. Deal = distinct issuer per day. Lazy background backfill of 365 days
  (newest first, ~4 req/s, 3 failures → 10 min cooldown) into `bond_issuance_*` tables. Returns daily,
  weekly (+10Y/IG OAS week close), recent deals, event study (top-decile days vs rest, Δ from t−1 to
  t/t+1/t+3, Welch t), backfill status. Cache 30 min (30 s while backfill runs).
- `DELETE /api/bonds/cache`
- Proxy: `app/api/bonds/[section]/route.ts` (overview|supply|issuance, 60s timeout)

### Live quote stream (`routers/stream.py` + `backend/quote_stream.py`) — 2026-09-26
- `GET /api/stream/quotes?symbols=AAPL,PTT.BK,BTC-USD` — `text/event-stream`. At most one `data:` per second:
  `{"AAPL":{"price":231.4,"change":1.2,"change_pct":0.52,"ts":<exchange ms>}}`, only symbols that ticked since
  the last frame (first frame = cache). `: ping` every 15s when quiet. Optional `focus=` (must stay live: open chart, held position) and `mounted=` (out of view, first evicted); `symbols=` = on screen. A symbol keeps the best tier any client gives it. Per request ≤ `QUOTE_STREAM_MAX_SYMBOLS`, kept in the order sent (no longer cut at 200 alphabetically).
  `event: coverage` `{"live": N, "denied": [sym…]}` when it changes — denied = no slot, budget full (REST poll only). Unnamed `message` listeners ignore it.
- `GET /api/stream/status` — `{connected, symbols, live, denied, max_symbols, shards:[{id, symbols, connected}], shard_cap, last_message_age_s, cached}`; `connected` = every shard connected.
- Budget (2026-09-26): process-wide `QUOTE_STREAM_MAX_SYMBOLS` (900). Over it: best tier first, then already-streaming, then oldest ask; a newcomer takes a slot only from a strictly lower tier, on the same socket.
- Source: Yahoo pricing WebSocket (unofficial, no key) via `websockets` + `yfinance.pricing_pb2`. Yahoo serves 100 symbols per socket, so symbols are sharded ≤ `SHARD_CAP` (90) per socket on one asyncio loop in its own thread (sharded 2026-09-26); subscriptions
  ref-counted across clients, dropped on disconnect. Regular-session ticks only (`market_hours == 1`).
  .BK quotes are Yahoo-delayed (~15m) like everywhere else.
- Proxy: `app/api/stream/quotes/route.ts` (forwards `symbols`/`focus`/`mounted`, passes `request.signal` so a closed tab closes the backend stream).
- **Sessions (2026-09-28, `backend/stream_sessions.py`):** `&session=<8–64 [A-Za-z0-9-]>` makes the stream resumable; first frame `event: ready {session, resumed}`. `POST /api/stream/interest {session, symbols[], focus?[], mounted?[]}` → `{ok, symbols}` replaces the session's set by diff (acquire before release; new symbols get the hub's cached tick next frame); 404 = unknown/expired session → client reopens. Disconnected sessions are kept 30 s (reconnect resumes, `resumed: true` → client resends), then released. Proxy `app/api/stream/interest/route.ts`. `/api/stream/status` adds `sessions {sessions, attached, grace_s}`.
- `event: coverage` carries `connected` (all Yahoo shards up) since 2026-09-28 — the frontend backs off REST polls only while it is true (`lib/stream-cadence.ts`).

**Conditional GET (ETag/304, 2026-09-28):** `lib/etag.ts` (`etagJson` / `etagResponse`) tags 200s of the polled proxies — `market-data`, `volatility`, `fx`, `rates`, `alerts/events`, `ticker`, `crisis`, `macro`, `bonds/[section]`, `tail-risk/*`, and everything through `marketDataProxy` (`stock`, `watchlist/{quotes,sparklines,signals}`, `polymarket/stocks`). `Cache-Control: private, no-cache` → the browser revalidates with `If-None-Match` and an unchanged payload costs a bodiless 304. Client fetches of these must not use `cache: "no-store"`.
- Consumers (one shared EventSource per page, `hooks/useQuoteStream.ts`): PORT positions (`live-patch.ts` `applyTicks`, price deltas) · every chart via `useStockHistory` (`chartkit/live-bars.ts` `applyTickToBars`: moves last candle, opens a new one past it) · chart header via `useStockQuote` · watchlist via `useWatchlistQuotes` · TICK DATA board: indices (`useMarketDataQuery`), FX (`useFxTicks`), volatility (market-view) — all through `lib/live-quotes.ts`.

### Trade history for agents (`routers/trade_history.py`) — read-only (2026-10-08)
- `GET /api/v2/trade-history/coverage` — what the book holds: `book` (lots, open/closed, first/last dates), `accounts[]` (+ `sub_ports`, `currencies_traded`), `symbols[]` (every symbol ever traded, per account), `strategies[]`, `sectors[]`, `options`, `not_in_this_data[]`, `fields` (what each column means) and `rules` (how to read it). The first call an agent makes.
- `GET /api/v2/trade-history/trades?symbol&account_id&status=all|open|closed&result=W|L&date_from&date_to&date_field=any|entry|exit&strategy&sector&sub_port&market&limit=50&offset=0&order=newest|oldest&detail=brief|full` — one row per lot. `symbol` is exact on `symbol` or `resolved_symbol` (case-insensitive), dates are inclusive `YYYY-MM-DD`; `(none)` selects an empty strategy / sector / sub-port. 422 on a malformed date, `date_from` after `date_to`, an unknown `account_id` (the message lists the accounts) or a value outside an enum. `limit` ≤ 500.
- `GET /api/v2/trade-history/trades/{id}` — the lot in full + `audit_log[]` (`trade_audit_log`, oldest first) + `broker_slips[]` (`broker_executions`) + `theses[]` + `same_order_lots[]`. A unique id prefix of ≥ 6 characters works; 404 when unknown (says so when the trade was deleted), 409 when a prefix fits several ids.
- `GET /api/v2/trade-history/stats?group_by=none|symbol|month|year|strategy|sector|account|sub_port|market|instrument&…same filters…&include_options=true&base_currency=THB|USD` — realized results of closed lots (+ closed option round trips unless a stock-only filter is set). `date_field` defaults to `exit`. `totals[]` per currency, `groups[]` per group × currency, `combined` only with `base_currency` (converted at each lot's exit-date rate — the same conversion PORT → ANALYTICS uses).
- `GET /api/v2/trade-history/options?underlying&account_id&date_from&date_to&limit&offset` — `round_trips[]` (`v_option_realized`, one close ↔ one open) and `open_lots[]` (`v_option_open_lots`, no valuation); dates filter round trips by exit date.
- Every response: `as_of` (UTC), `source` (table, row count, last write), `query` (the filters as applied), `notes[]`. Lists add `total_matching`, `returned`, `complete`, `next_offset`, `totals[]`. Shapes: `data-shapes.md` → Trade history.
- No Next.js proxy / UI: the consumer is the MCP. No cache (reads SQLite directly), no outbound call except the FX history lookup `base_currency` may trigger. `/api/v2/portfolio/trades` stays the PORT table's endpoint — not for agents (substring match, no dates, no count).

### Google Trends (`routers/google_trends.py`) — free/public (2026-09-28)
- `GET /api/trends/daily?geo=US` — daily trending searches from `trends.google.com/trending/rss?geo=`: `items[] {query, approx_traffic ("2000+" bucket), published_at (UTC ISO), news[] {title,url,source}}`. Cache 30 min, failure negative-cached 5 min.
- `GET /api/trends/interest?keywords=Visa,Mastercard&geo=US&timeframe=today 12-m` — ≤5 keywords; timeframe ∈ `now 7-d | today 1-m | today 3-m | today 12-m | today 5-y`; `geo=''` = worldwide. `series[] {date, values{kw: 0–100}, partial}`. **0–100 index relative to the peak in that window and keyword set — not search volume.** Unofficial endpoints (explore → widgetdata/multiline); Google 429s them often → **429** (Retry-After 1800) with the explore URL, negative-cached 30 min, never retried around. Cache 6 h. One pull at a time (lock).
- Both return `source {name, url, retrieved_at, tier, note}` — agents must cite `source.url`.
- No Next.js proxy / UI yet; consumers are MCP `get_trending_searches`, `get_google_trends`. Official Trends API = application-gated alpha (developers.google.com/search/apis/trends) — swap in if access is granted.

### Webull depth (`routers/webull.py` + `webull_client.py`) — L2 bid/offer, US stocks + ETFs (2026-10-08)
- `GET /api/webull/status` — `{configured, host, environment: production|test|custom, token: {status, expires_at, checked_at}|null}`. Never a key, secret or token.
  - `verify_lock: {since, until, reason}|null` (unix s) — Webull locked SMS verification; `POST /api/webull/token` and `/token/check` answer `423 {code: verify_locked}` with no call out until `until`.
- `POST /api/webull/token` — asks Webull for an access token (`/auth/tokens/create`). Production: comes back `PENDING`, Webull texts a code, the owner enters it in the Webull app (Menu → Messages → OpenAPI Notifications) within 5 min. Test host: `NORMAL` at once. **Only this endpoint requests a token** — a read never does (it would send an SMS).
- `POST /api/webull/token/check` — re-reads the status (`/auth/tokens/check`).
- `GET /api/webull/depth?symbol=AAPL&depth=10&overnight=false` — upstream `GET /market-data/stocks/depths/list`. `depth` 1–50. Tries `US_STOCK` then `US_ETF`, remembers which answered (24 h). Symbols outside the feed (index, future, FX, crypto, `.BK`) → 422 without an upstream call.
- Errors: `detail = {message, code}`, code ∈ `keys` (424) · `token_missing` / `token_pending` (409) · `subscription` (403) · `unsupported` (422) · `empty` (404) · `rate_limit` (429) · `upstream` (424 — never 5xx, `main.py` would blank the reason).
- Cache: success 1 s (panel polls every 2 s; Webull limit 300 / 60 s), refusals 20 s (negative cache). A token in `PENDING` is re-checked at most every 10 s (Webull answered 429 on `/auth/tokens/check` at one call / 3 s, 2026-10-08); a failed check keeps it pending.
- Token file: `<app-data>/BloombergTerminal/webull/token-<hash of host+key>.json` or `WEBULL_TOKEN_DIR`; a folder inside the repo is refused. Invalid after 15 days without a call.
- Levels returned = what the account is entitled to: Nasdaq Basic (free) → 1 level; more needs the **OpenAPI** TotalView subscription (the in-app one does not count). `levels` < `depth_requested` says so.
- Proxy: `app/api/webull/[...path]/route.ts` (GET status/depth, POST token, token/check).
- **Live book (2026-10-08)** — `GET /api/webull/depth/stream?symbol=&depth=&overnight=` → `text/event-stream`: `data:` = a depth answer (same shape, `source.endpoint` = `stream: quote`), `event: state` = `{live, state, error}` when it changes, `: ping` every 15 s. Proxy `app/api/webull/depth/stream/route.ts` (pass-through, closes upstream with the tab).
  - `webull_stream.py` — `DepthHub`: ONE MQTT session for the process (`data-api.webull.co.th:1883`, MQTT 3.1.1 inside TLS, user = app key), started by the first listener, hung up 20 s after the last. What it receives is set over HTTP (`POST /market-data/streaming/subscribe|unsubscribe`, body `{session_id, symbols, category, sub_types:["QUOTE"], depth}`), keyed on the MQTT client id, and is **not kept across a reconnect** — re-sent after every CONNACK. Never requests a token. ≤20 books at once.
  - `webull_wire.py` — the MQTT packets and the proto3 `Quote` decoder, hand-written: no `paho-mqtt`, no `protobuf` dependency.
  - `GET /api/webull/status` now carries `stream: {state: idle|connecting|live|waiting|error, error, symbols, subscribed, messages, connected_for_s}`.
- **Time and sales (2026-10-08)** — free with Nasdaq Basic - Non Display. `GET /api/webull/ticks?symbol=&count=100` → `{symbol, trades:[{t (ms), price, size, side: B|S|N, session}] newest first, source}`; upstream `GET /market-data/stocks/ticks/list`, **count ≤ 1000 and no start time** — 1000 prints of INTC is ~90 s, so there is no fetching a day. Cache 2 s. The stream carries the same prints as `event: trades` (oldest first within a frame): the hub subscribes `["QUOTE","TICK"]`, keeps 400 per symbol, and falls back to `["QUOTE"]` for good only when the book alone is accepted after a refusal. `side`: B = buyer lifted the offer, S = seller hit the bid, N = neither (most prints from the HTTP call come back N; the stream marks B/S). Tick payload field 6 (not in the published proto) = the trade's own time in ms. Nasdaq prints only, not the consolidated tape. Not checked: whether the stream drops prints on a busy stock (server cap is quoted as 3 messages a second per connection).
- **The two trade feeds are not the same list (measured 2026-10-08, INTC + MU, market open).** Over one window the stream printed 28% of the prints the HTTP call returned (86% of the volume — it leaves out most odd lots), and ~30% of the stream's prints had no exact (time, price, size) match in the HTTP list. ~62–82% of the volume carries side `N` on either feed. Consequences kept in the code: the tape is the stream's (the HTTP pull only seeds it, or feeds it while the stream is down); volume by price is built from HTTP pulls only (`count=1000` every 15 s, deduplicated pull against pull) — never mix the feeds in one sum; and a footprint (volume by price AND side) from these prints would rest on a third of the volume, so none is built. A day has ~450–650 k prints per busy stock and no start-time parameter: there is no back-filling a session that was not recorded.
  - Measured live 2026-10-08 (Level 1): TLS + CONNACK ~0.1 s, first quote ~0.5 s after subscribe, ~2.6 msg/s for INTC (server cap 3/s), QoS 0, subscribe answers 200 with an empty body; depth above the entitlement → 417 `depth not more than 1` exactly like the HTTP call. Limits (docs): 5 connections per app key, a closed session is held ~1 min (CONNACK 105).
- **Verified live 2026-10-08** (production, Nasdaq Basic - Non Display): real bid/ask for INTC and SPY. Learned: asking for more levels than the entitlement is refused with 417 `ILLEGAL_PARAMETER: depth not more than 1` — the router reads the number, remembers it 10 min per session (`_entitled`) and asks for that; an ETF answers under `US_STOCK`; L1 levels carry no `order[]` (`count` null); no entitlement at all = 403 `MARKET_DATA_NOT_SUBSCRIBED … STOCK QUOTES` (overnight: `NIGHT TRADING STOCK QUOTES`); `BRK.B` → 417 `INVALID_SYMBOL` (share-class form still unknown); `/auth/tokens/create` handed an EXPIRED token returns that same dead token with 200 and sends no SMS — only a NORMAL token is handed back. Subscriptions that count are the ones named "… - Non Display" on the Webull website; a new one took ~3 min to apply and needed no new token. Not yet seen: an L2 answer (TotalView - Non Display).

### Fiscal.ai (`routers/fiscal_ai.py`) — secondary fundamentals (2026-09-28)
- `GET /api/fiscal/status` → `{key_set, date_utc, calls_used, daily_limit}` (no upstream call).
- `GET /api/fiscal/{kind}/{symbol}?period=annual&exchange=` — kind ∈ profile · income · balance · cashflow (standardized) · ratios · adjusted · segments-kpis · earnings-summary · ir-events · fund-letters · news-summary. `period` (periodic kinds) ∈ annual, quarterly, semi-annual, ltm, ytd, latest (comma list). `symbol` = ticker (`V`) or companyKey (`NYSE_V`).
- `GET /api/fiscal/transcript/{symbol}/{event_key}` — `event_key` = `q{1-4}-{year}` from `ir-events`.
- Response `{data, source{name, endpoint, params, docs, retrieved_at, tier, calls_used_today}}`.
- Key sent as `X-Api-Key` header (never `?apiKey=`). Daily budget `FISCAL_AI_DAILY_LIMIT` persisted in `logs/fiscal_ai_usage.json` → 429 when spent; cache 12 h (hits spend nothing), failures 10 min. No key → **424** (not 503: `main.py` masks every 5xx detail as "Internal server error"). Free trial = 100 fixed companies (docs.fiscal.ai free-trial); others → upstream 4xx passed through.

### COT (`routers/cot.py`) — CFTC Commitments of Traders (2026-09-25)
- `GET /api/cot/snapshot?window=156` (52–1040 weeks) — per contract (17: UST 2Y/5Y/10Y/Ultra10Y/Bond/UltraBond,
  SOFR 3M, ES/NQ/RTY, VIX, JPY/EUR, BTC [TFF] · WTI/Gold/Copper [Disaggregated]): OI, Δ1w, top-4/8 gross
  concentration, per group long/short/net, net/OI %, Δnet 1w, trader counts, z + percentile of net/OI over window
  (None below 52 obs). `focus` = lev (financial) | mm (commodity). `dv01` = approx 10Y-eq ratio (UST only).
- `GET /api/cot/history?code=<cftc code|key>&weeks=156` — oldest-first weekly rows with all groups; 404 unknown.
- `GET /api/cot/basis?window=156&weeks=260` — UST basis trade: AM / lev / dealer net summed over 2Y/5Y/10Y/Ultra10Y/Bond/UltraBond
  in 10Y-note equivalents (approx DV01 weights), only weeks where every tenor reported; stats z/pct of net/OI; per-tenor table
  (`dv01_net`). BOND → MARKET `BasisTradePanel` + CONDITIONS `DealerBalanceSheetPanel`.
- `GET /api/cot/factor?window=156&weeks=260` — PC1 of every contract's causal rolling z (focus group net/OI), loadings,
  explained share; weekly. No UI consumer since 2026-10-08 (was MKT REGIME → COT). Display only (not an HMM input). In-process cache keyed on latest report dates.
- `GET /api/cot/portfolio?account_id=&base_currency=THB` — open positions (`portfolio_v2._open_positions_enriched`) mapped to
  contracts (explicit SYMBOL_MAP; US single stock → ES proxy; TH etc. unmapped; SVXY inverse) × crowding flags →
  WITH_CROWD / AGAINST_CROWD, weights, `unpriced` (no live price → not sized). PORT → RISK `CotCrowdingPanel`.
- `GET /api/cot/status` — running, last_error, cooldown, stored/contracts, expected_as_of.
- Snapshot also returns `as_of`, `released`, `flags[]` (9 rules in `FLAG_RULES`: |z| ≥ 2 or pct ≤ 5 / ≥ 95 on the rule's group+side).
- TAIL: `tail_risk.py` signal `cot_crowding` (flow_positioning) = any flag; `counted: False` → never moves the dimension or
  composite; `_BACKTEST` verdict WEAK (2026-09-25, `backtest-idea/06_cot_crowding`).
- All three answer from SQLite and call `_refresher.ensure()`: background thread pulls stale contracts
  (full history first, `> max(report_date)` after). Stale = behind the latest Tuesday whose Fri 15:30 ET release
  passed; late CFTC (holiday) → retry every 6h; 3 consecutive fails → 15 min cooldown. Observed as source `CFTC`.
- Proxy: `app/api/cot/[section]/route.ts` (snapshot|history|basis|factor|portfolio|status, query string forwarded, 20s timeout)

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
- **Market pool** (all active markets, ~2,100 / 13 MB, 30 Gamma pages): TTL 10 min. Past that and up to 30 min it is handed back at once while one background thread downloads the new one (2026-10-05); only a cold start or a pool older than 30 min makes a caller wait. `signals` / `signals/{type}` / `search` answers carry `pool_ts`, `as_of` (when the pool was read) and `refreshing` (true = computed from an expired pool, ask again in a few seconds); a cached answer is dropped as soon as the pool it came from is replaced. Slug registry + signal history rows are written by one thread after the answer has gone out. A failed pool download is not retried for 60 s. The last `signals` answer is kept in `backend/cache/polymarket_signals.json` (≤ 30 min) and served with `refreshing: true` by a new process while its pool loads
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

## Market State — per-symbol regime (`routers/market_state.py`)

Two endpoints because they answer two different questions and only one is cheap.

- `GET /api/market-state/{symbol}?period=10y&n_states=4&history=504` — the dashboard payload
  - OHLCV → 5 features → Gaussian HMM (full covariance) → filtered posterior + Trend/Momentum/Volatility scores + summary sentence + strategy compatibility + redundancy report
  - **Labels are causal** (filtered posterior — no bar uses data after itself); **parameters are in-sample** (one fit on the whole history). The payload carries this in `basis` and the UI prints it. Do NOT quote numbers from here as evidence that a state predicts anything
  - ~1s cold for 10y of daily bars; TTL 1h, and a failed fit is deliberately NOT cached
  - Used by: NEWS → WATCHLIST → REGIME panel · stock-view → REGIME tab (same component)
- `GET /api/market-state/{symbol}/validation?period=max&n_states=4` — walk-forward refit
  - Refits every `step` bars (default 126) on data ending `EMBARGO`=21 sessions before each block, labels only that block → out-of-sample forward return per state (horizons 5/10/21), Welch t **and an overlap-adjusted t = t/√h**, plus the best-scoring strategy per state
  - Tens of fits (3-10s typical, capped at `MAX_REFITS`=40); TTL 24h; the UI only calls it when the user presses RUN
  - This is the ONLY endpoint allowed to claim what follows a state

## Theme/Sector Rotation (`routers/rotation.py`)
- `GET /api/rotation/table?market=US|TH&bench=SPY` — momentum table; US: 24 theme ETF proxies (ARKG, IBB, CIBR, SMH, MAGS…) + 11 SPDR sectors vs SPY; TH: 13 equal-weight sector baskets (Banking, Energy, ICT, Commerce…) vs ^SET.BK (fallback `TDEX.BK` SET50 ETF when Yahoo serves ^SET.BK with <70 bars — `bench` field says which); per row: d1/w1/m1/m3 %, m1_vs_bench, RRG quadrant + mom_dir; 15min cache, one batch yf.download 9mo
- `GET /api/rotation/tilt?window=20` (2026-09-23) — US sector rotation ที่ TAIL ใช้: ส่วนแบ่ง **มูลค่าซื้อขาย** (close×volume) ของ 11 SPDR ต่อทั้งกลุ่ม, rolling `window` วัน, Δ เทียบหน้าต่างก่อนหน้าเป็น bp + z ของ **การเปลี่ยนแปลง** (ไม่ใช่ z ของระดับ) เทียบ 1 ปี; `tilt` = defensive share − cyclical share เป็น series ของตัวเอง; RRG quadrant tally + breadth vs SPY; `aum` = flow จริงจาก `etf_aum_snapshots` (ยังไม่พร้อมจนกว่าจะมี ≥2 วัน) และการอ่าน endpoint นี้คือสิ่งที่ trigger การบันทึก AUM ของวันนั้น. 15min cache. **ไม่ใช่ fund flow** — ทุกการซื้อมีการขาย, turnover บอกแค่ความสนใจกระจุกที่ไหน
- `GET /api/rotation/map?market=US|TH&tail=8&bench=SPY` (2026-09-24) — Relative Rotation Graph data, **sectors only** (11 SPDR vs SPY / 13 TH baskets vs SET→TDEX fallback). Per row: last `tail` (2–20) weekly `{date, ratio, mom}` oldest first + head `quadrant`; `expected` = universe size. Same `_rrg_frame` as the table's quadrant, so the two never disagree. Week label = last real session (not the W-FRI bin date). 15min cache; partial result (rows < expected) cached 2 min
  - Used by: MKT REGIME → ROT → MAP (`rotation-map.tsx`)
- `GET /api/rotation/constituents?market=US|TH&id=X` — drill-down stocks in a group with same return columns; US id=ETF symbol → yf funds_data top-10 holdings (1d cache); TH id=group name → basket members
  - Used by: MKT view REGIME panel → ROT mode (`rotation-table.tsx`) — US|TH toggle, click row to expand constituents

## Stop Loss Engine — REMOVED 2026-09-15
`routers/stoploss.py`, the `/api/stoploss/*` endpoints and the `app/api/stoploss/` proxy
are gone. The ATR engine was never used for a trading decision but sat on the cold path of
**every** page load: `/api/ticker` scanned every open position for breaches on each cold
build (15 symbols × one sequential `yf.download` each = 6.8s measured). Removing it took the
cold ticker build 17.2s → 7.2s. Math + audit kept for reference in
`memory/reports/stoploss_math.md` and `memory/reports/stoploss-verification-2026-06-10-report.md`.
The manually entered `trades.price_stoploss` column (PORT "S/L" column, ENTRY form, CSV
import) is a different thing and still exists.

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

## Upstream health (`routers/health.py`) — prefix `/api/health` (2026-09-24)

| Endpoint | Returns |
|----------|---------|
| `GET /upstream` | `upstream_health.snapshot()` + `yahoo_gate` — answered from memory, **no outbound call**. Backend only (no Next proxy, no UI — removed 2026-09-24); history is in `logs/upstream.jsonl` |
| `GET /latency` | (2026-09-30) per-route p50/p95/max, thread-queue p95, DB p95, live thread-pool usage (busy/waiting/peak), local-lane usage, last 20 slow requests, long background DB holds. From memory, async (answers while every thread is busy). Source `backend/request_latency.py`; slow requests (>200 ms) in `logs/latency.jsonl` |

Fed by `backend/upstream_health.py` (wraps `requests.Session.send`) and `backend/yahoo_gate.py` (wraps `YfData._make_request`). Both imported in `main.py` before any router. Stale serves come from `backend/last_good.py`.

## Business Cycle (`routers/cycle.py`) — 2026-10-07

| Endpoint | Returns |
|----------|---------|
| `GET /api/cycle` | Official cycle indicators, each read by its publisher's definition (`backend/cycle.py`): `headline` (NBER state, months since trough, recession rules on / known, curve, 12-month probit probability, OECD CLI phase, output gap, PCE gap to 2%, policy, NFCI) · `groups[]` (RECESSION NOW: NBER, Sahm, Chauvet–Piger, CFNAI-MA3 + Diffusion, GDP-based index · RECESSION AHEAD: yield-curve probit, OECD CLI · SLACK: output gap, unemployment gap, CFNAI inflation line · INFLATION: PCE vs 2% · POLICY: target midpoint vs SEP longer-run median, Taylor 1993 · FINANCIAL CONDITIONS: NFCI, ANFCI · MARKET TREND: SPY 10-month, verdict WEAK) · `implications[]` (`know` / `do` / `dont`, basis `definition` / `track record` / `backtest`) · `missing[]` · `stale_hours`. **No composite score** (`composite: null`) |
| _(cache)_ | 21 FRED series + ^GSPC / SPY daily, 6 h; payload 10 min (1 min while a series is missing); last good pull ≤36 h in `backend/cache/cycle_*.pkl`; a failed pull is not retried for 10 min |
| _(proxy)_ | `app/api/cycle/route.ts`, timeout 90 s |

## Tail Risk Monitor v2 (`routers/tail_risk.py`) — prefix `/api/tail-risk`

| Endpoint | Returns |
|----------|---------|
| `GET /signals` | 6 risk dimensions + tri-state signals + vol board + 90d history + `data_health`. **+2026-09-24:** `events` (named market events from `backend/tail_events.py`), `event_log` (last 20 sessions with ≥1 event), `event_asof`, `event_inputs` / `event_inputs_missing`, `events_ok`, `risk_level_dimensions` (the old dimension-gate level), `risk_basis` — `risk_level` is now `max(dimension gate, event floor)` |
| _(proxy)_ | `app/api/tail-risk/[...path]/route.ts` timeout **180s** (cold `/signals` queues behind `yahoo_gate`) |
| `GET /vix-term` | VIX9D / VIX / VIX3M / VIX6M + backwardation flags + freshness |
| `GET /macro-context` | **Context only, `counted_in_composite: false`** (2026-09-17). `calendar` (from `backend/event_calendar.py`: FOMC decisions hardcoded 2026–2027 from federalreserve.gov + FRED `release/dates` for CPI 10 / NFP 50 / PCE 54 / GDP 53, 12h cache, parallel + 1 retry, fail-soft `releases_ok`; **2026-10-02** + FRED PPI 46 / RETAIL 9 / JOLTS 192 / CLAIMS 180 and computed `rule_events`: OPEX third Friday (triple witching Mar/Jun/Sep/Dec), VIXEXP = next month's expiry − 30d, ISM 1st / 3rd business day, MINUTES = decision + 21d, EIA weekly Wed → Thu after a Mon–Wed federal holiday; `impact` high/medium/low; strip shows high ≤21d, medium ≤10d, low ≤3d; `event_window` limited to `WINDOW_KINDS` = the original five) with `upcoming`, `past` (135d, chart markers), `event_window` (±1 business day), `next_fomc` (days_until 0 on decision day), `fomc_calendar_stale/expiring`; plus `fed {rate, stance}`, `yield_curve` (+`inverted_10y_2y/3m`), `regime` (growth/inflation/labor/policy `{state, tone}` — thresholds from the retired MACRO dashboard), `indicators` (latest value/prev/date, no series), `event_sensitive_signals` (`vix_level`, `vix_momentum`, `vix_term_inversion`). Cache 10 min when complete, 60 s when degraded |
| `GET /oil` | (2026-10-02) `{oil, energy}` — US petroleum balance from the EIA Weekly Petroleum Status Report (`backend/oil_inventory.py`): EIA API v2 `petroleum/sum/sndw`, 9 series × 6y in ONE call, key in `X-Api-Key` header (`EIA_API_KEY`, else public `DEMO_KEY` = 10 calls/h), 6h cache, failure negative-cached 15 min, last-good `oil_eia_weekly`; retail gasoline/diesel + WTI from FRED (GASREGW, GASDESW, DCOILWTICO, 1h). The same `oil` object rides in `/macro-context`, and `macro_read.axes` gained `energy` (ENERGY → CPI: gasoline YoY/13w ±10% = impulse, crude+gasoline+distillate ±5% vs 5y same-week avg = cushion, tone worse when the inflation axis is STICKY/REFLATION; `cpi_pp_est` = YoY × 3% basket weight, approximate). Context only, never in the composite. UI: TAIL → MACRO & ROTATION → OIL · EIA WEEKLY |

**Data sources (v2, 2026-08-16):**
- Vol indices → `backend/vol_indices.py`, **CBOE daily CSVs** (`cdn.cboe.com/api/global/us_indices/daily_prices/{NAME}_History.csv`, keyless): VIX, VIX9D, VIX3M, VIX6M, VVIX, SKEW, OVX, GVZ, VXN. yfinance is a fallback for the five non-term-structure names only — its term-structure feed froze on 2026-07-17 and is what v1 was silently reading.
- SPY/AGG (2y) + 7 DCC assets (600d) → yfinance
- Credit / sentiment / regime → **in-process calls** to `crisis.get_crisis()`, `fear_greed.get_current()`, `ticker.get_ticker()` — no self-HTTP (v1 looped back through localhost:8000 and timed out on cold caches)

**Contracts worth knowing:**
- Every signal is `state: "on" | "off" | "unknown"`. `unknown` carries `reason` and must never be rendered as safe.
- A vol series lagging VIX by > `MAX_STALE_DAYS` (4) is unusable — `VolFrame.value()` returns `None` rather than the last good print.
- Risk level counts **dimensions in ALERT**, not signals: ≥3 → HIGH, ≥2 → ELEVATED, ≥1 alert or ≥2 watch → CAUTION.
- **Event floor (2026-09-24)**, per *channel* (rates / equity_vol / equity / cross_asset / credit / fx / commodities): one SEVERE channel → CAUTION, SEVERE + ACTIVE in another → ELEVATED, SEVERE in 3 → HIGH, ACTIVE in 2 → CAUTION. Final `risk_level` = the higher of the two; `risk_basis.driver` says which.
- Event inputs = one daily cross-asset panel: yfinance (SPY QQQ TLT GLD HYG DX-Y.NYB JPY=X CL=F ^IRX ^FVX ^TNX ^TYX ^VIX ^MOVE ^VVIX ^SKEW ^OVX ^GVZ ^VXN ^VIX3M, 2y, 280s cache) + CBOE series from `vol_indices` (Yahoo only fills ≤2 bars CBOE has not published) + FRED 420 obs HY/IG OAS + T5YIE/T10YIE + DFII5/DFII10 TIPS real yields (1h cache; real yield carried to same day as `real_L + Δnominal − Δbreakeven`, flagged `estimated`) + energy futures BZ=F/HO=F/RB=F → crack spreads (diesel HO×42−WTI, gasoline RB×42−WTI, 3-2-1, Brent−WTI). Changes spanning a futures roll session are blanked (WTI ~3 bdays before the 25th; HO/RB/Brent first bday of month) + STL FSI/NFCI from crisis. Evaluation calendar = SPY's bars.
- Failure returns `{ok: false, error, detail, signals: [], ...}` — never a bare `{}` (that used to crash the view).

## Alert Ticker (`routers/alerts.py`)
- `GET /api/alerts?account_id=all` — all active alerts (regime change), 60s cache. `account_id` only splits the cache; nothing in the payload is account-scoped since the stop engine was removed
  - Regime change: event-based — stored in `regime_alerts` table, expires 15 min after detection
  - Returns: `{alerts: [{type, severity, symbol, message, persistent, expires_at?}], count, has_critical, timestamp}`
- `DELETE /api/alerts/regime/clear` — remove expired rows from `regime_alerts` table

**Next.js proxy:** `app/api/alerts/route.ts` (GET + DELETE)
**Frontend:** `components/bloomberg/layout/alert-ticker.tsx` — polls every 60s, renders 24px strip at bottom

## Alert Rule Engine (`routers/alert_rules.py`) — user-defined rules
Design: `memory/plans/alert-rule-engine.md`. Scanned every 15 min by
`backend/alerts/scheduler.py` (`ALERT_SCAN_INTERVAL=0` disables).

- `GET /api/alerts/rules` · `POST` · `PATCH /rules/{id}` · `DELETE /rules/{id}`
- `POST /api/alerts/rules/preview` — dry-run, saves nothing
- `POST /api/alerts/scan` — evaluate now. Returns `{events, count, delivery, skipped}`
- `GET /api/alerts/events` · `POST /api/alerts/events/ack`

**Rule shape adds 2 fields (2026-09-15):** `lastError` / `lastErrorAt` — why the
last scan skipped this rule, or null. `enabled: false` **with** a `lastError` means
the scanner disabled it, not the user. Rendered as ⚠ beside the rule name by
`components/bloomberg/alerts/RuleErrorMark.tsx`.

⚠️ **Fault-isolation contract — do not undo:** one rule failing must never end the
scan. `run_scan` parses rules per row, `engine.scan` wraps each rule's evaluation.
A rule that does not parse is disabled (permanent); one that raises at runtime keeps
`enabled` (may be transient) and only records the error. Wrapping the batch in one
try/except instead is what killed the scanner for three weeks —
`memory/sessions/reports/alert-scan-dead-since-2026-08-25-risk-report.md`.

---

## Quote Providers (`routers/providers.py`)
Controls the live-quote registry (manual switch + auto-failover, capability-scoped).
- `GET /api/providers` — `{active, providers: [{name, label, healthy, active, auto_failover, last_served}]}` (UI reads it through `/api/heartbeat` since 2026-09-28)
- `POST /api/providers/active` — body `{name}` — pin active provider (404 if unknown)
- `POST /api/providers/auto-failover` — body `{enabled}` — toggle failover to next healthy

**Next.js proxy:** `app/api/providers/{route,active/route,auto-failover/route}.ts`
**Frontend:** `layout/provider-switch.tsx` (header chip), `hooks/useProviders.ts`, `hooks/useLiveQuery.ts` (cadence seam)
**Providers:** `YFQuoteProvider` only (Stooq fallback removed 2026-09-24 — it timed out on every call and was never able to fill a gap). Add via `registry.register()` in `sources/__init__.py`.

---

## Watchlist Market Data (`routers/watchlist_signals.py`)

| Endpoint | Params | Returns |
|----------|--------|---------|
| `GET /api/watchlist/quotes` | `symbols` (1–60 unique symbols per request) | `{quotes, statuses, requestedCount, count}` — same quote payload as single-symbol route |
| `GET /api/watchlist/signals` | `symbols` (1–60 per request) | `{signals, statuses, errors, requestedCount, count}` |
| `GET /api/watchlist/sparklines` | `symbols` (1–60 per request) | `{sparklines: {SYM: number[]}, statuses, requestedCount}` — adjusted daily closes, 3 months |

Updated 2026-09-23: client chunks the entire unique symbol set (20 per request), never truncates the list. Oversized/empty batches return 422. Every accepted symbol has `ready`, `pending`, or `error` status; partial responses are 200 with per-item HTTP status and retry delay. Backend shares per-symbol adjusted `2y/1d` histories with alerts and compatible chart/provider reads; computed scans cache for 900s. Quotes cache 60s. Pending work continues in a bounded coordinator and repeated readers join it.

`/api/polymarket/stocks` uses the same status envelope (limit30, client chunks10); a ready symbol missing from `summaries` means a successful search found no markets. An outage is an error, never a negative-cache hit. Quotes/stock/history/signals/sparklines/PM batch proxies forward HTTP status and Retry-After using `lib/market-data-proxy.ts` (30s deadline, no proxy retry). `PATCH /api/pins/assets/{id}` also accepts `price_at_pin` to finish capturing the entry price after membership has been saved. `GET /api/pins/assets` reads assets/tags in two SELECTs.
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
| Stock quote / raw Yahoo info / fast-info | 60s, per-symbol single-flight | `market_requests.py` + `market_snapshots.py` |
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
| Alerts (regime) | 60s | Python TTLCache |
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
├── boot-diag/route.ts (POST, dev-only — sendBeacon sink for the boot watchdog; logs "[boot-diag] {...}" into logs/frontend.log. 404 in production. NOT a backend proxy)
├── market-data/route.ts
├── volatility/route.ts (55s in-memory cache; NO static fallback — a stale VIX is worse than an empty section)
├── stock/route.ts
├── news/facebook/route.ts
├── clippings/route.ts / content / ai / ai/models
├── heatmap/route.ts
├── options/route.ts / surface / sd-bands (?symbol= + period/mode/horizonDays/rvWindow/occWindow)
├── options/iv-snapshot/route.ts (POST ?symbol=&targetDte= — passes 404/422 through so the caller can tell "never will work" from "retry")
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
├── portfolio/research|export|sources
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
└── watchlist/{quotes,signals,sparklines}/route.ts
```

## Dev (`routers/dev.py`, 2026-09-25)
- `GET /api/dev/status` — `{pid, started_at, reload, supervised, stale, changed[{file,change,at}], changed_count, restart: "reload"|"launcher"|null}`. Compares backend `.py` mtimes (minus `tests/`, `scripts/`) to the snapshot `dev_status.py` took at import; in reload mode a file saved <5s ago is not stale yet. Next proxy `app/api/dev/status` returns `{state: ok|stale|down}` + the above; a backend without this route (404) → `{state:"stale", legacy:true}`.
- `POST /api/dev/restart` — needs header `X-BT-Dev: 1` (403 otherwise; forces a CORS preflight). reload → touches `main.py`; launcher-supervised → `os._exit(0)` after 0.5s, watchdog restarts in ~5s; started by hand → 409. Proxy `app/api/dev/restart` adds the header.

## Dev (`routers/dev.py`, 2026-09-25)
- `GET /api/dev/status` — `{pid, started_at, reload, supervised, stale, changed[{file,change,at}], changed_count, restart: "reload"|"launcher"|null}`. Compares backend `.py` mtimes (minus `tests/`, `scripts/`) with the snapshot `dev_status.py` took at import; in reload mode a file saved <5s ago is not stale yet. Next proxy `app/api/dev/status` adds `state: ok|stale|down`; a backend without this route (404) → `{state:"stale", legacy:true}`.
- `POST /api/dev/restart` — needs header `X-BT-Dev: 1` (403 otherwise; forces a CORS preflight). reload → touches `main.py`; launcher-supervised → `os._exit(0)` after 0.5s, watchdog restarts in ~5s; started by hand → 409. Proxy `app/api/dev/restart` adds the header.

## Dividend units (2026-09-25)
- `POST /api/v2/portfolio/dividends/check` — body = DividendIn; never writes. Returns `{asset, instrument_currency, entered_currency, expected_per_unit, expected_ex_date, ratio, held_units, gross_expected, issues[{level: error|warn|info, code, message, fix?{currency, amount_per_unit, total_received, label}, alt_fix?{currency, label}}]}`. Codes: `looks_thb_as_usd`, `looks_usd_as_thb` (error), `per_unit_mismatch`, `no_market_dividend`, `not_held`, `total_vs_holding`, `matches_one_lot` (warn), `no_trades` (info). Proxy: `app/api/v2/portfolio/dividends/check/route.ts` (own file — `[id]` has no POST).
- `POST /dividends` and `PUT /dividends/{id}` now run the same check: **422** `{detail: {message, check}}` on an error-level issue unless body `force: true`; success responses include `currency` + `check`. Currency rule: sent currency ≠ account currency → kept; = account currency → the asset's currency wins (stale form default).

### Broker evidence match (2026-09-26, `routers/portfolio_v2.py` → `backend/evidence_match.py`)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/v2/portfolio/ledger/evidence?account_id=` | read-only; `broker_executions` vs reconstructed BUY/SELL; statuses MATCHED / CONSOLIDATED / NETTED / MISSING_IN_DB / NO_EVIDENCE / OUT_OF_COVERAGE |
| GET | `/api/v2/portfolio/ledger/evidence/image?fill_id=` | serves the cited screenshot from `backend/backups/*/` only if its SHA-256 still matches, else 404 |
Proxies: `app/api/v2/portfolio/ledger/evidence/route.ts`, `…/evidence/image/route.ts` (binary pass-through). Check `E1` in `/ledger/check` = one finding per unverified symbol.

### Excel history review (2026-09-26)
| GET | `/api/v2/portfolio/history-review?account_id=&review_status=&review_decision=&limit=100&offset=0` | `{total,summary,rows}` from local `portfolio_history_review`. `review_decision=REVIEW_REQUIRED` lists the 145 uncertain 2024–25 reconciliation proposals; `IMPORTED` lists the 20 rows posted to `trades`. The review table itself has no balance effect. Proxy: `app/api/v2/portfolio/history-review/route.ts`. |
`backend/scripts/stage_portfolio_history.py` checks the source workbook SHA-256 and audited CSV rows; `--apply` takes a SQLite online backup before idempotent staging. The legacy `/import/excel` route is not suitable for this ambiguous workbook; see risk report.

### Broker fees (2026-09-26, `backend/broker_fees.py`)
| GET | `/api/v2/portfolio/fees/estimate?account_id&side=BUY|SELL&qty&price[&symbol&market&currency]` | `{profile, basis, currency, side, value, commission, vat, sec_fee, taf_fee, total, source}`; `profile: null` = no schedule for this account/currency |
`POST /trades` takes `fee_entry` / `fee_exit` (None = estimate, number = as typed); `/sell` and `/sell-all-lots` `commission` None = estimate (split by volume across lots). Proxy `app/api/v2/portfolio/fees/estimate/route.ts`.
`POST /trades` also takes `slip_sha256` (from `/slip/read`: order ref + fill time come from the saved slip, not the form; writes/relinks a `broker_executions` row, returns `evidence_id`; 422 if the slip file is gone), `broker_order_ref` / `executed_at` (typed by hand). **409** when the account already has a trade with that order ref. `DELETE /trades/{id}` sets the evidence row's `trade_id` NULL (the fill stays). It also takes `fee_entry_breakdown` / `fee_exit_breakdown` (`{commission, vat, sec_fee?, taf_fee?}` from a slip) → stored in `fee_detail` beside the typed total with `source: "slip"`; ignored when the fee is an estimate.

| Method | Path | Returns |
|---|---|---|
| POST | `/api/v2/portfolio/slip/read` (multipart `file`, or `files` ×1–4 = screenshots of ONE order top→bottom (2026-09-26), ≤12 MB each) | `{engine, broker, status: ok\|review\|fail, slip{fields{side,symbol,exchange,order_amount,price,quantity,gross_value,commission,vat,sec_fee,taf_fee,order_type,submitted_at,executed_at,order_ref,settlement}, derived{exact_price,fee_total,fee_breakdown,trade_date,executed_at_utc}}, checks[{id,level,message}], form{side,account_hint,symbol,volume,date_entry\|exit,price_entry\|exit,fee_entry\|exit,fee_breakdown,note,broker_order_ref,executed_at}, warnings[], duplicates[trades whose note holds the order ref], image_sha256, ocr}` — reads only, never writes a trade. 422 = not an image, 503 = OCR unavailable |
| GET | `/api/v2/portfolio/slip/status` | `{engine, ocr_loaded, backend}` — backend `rapidocr:PP-OCRv5-th` (~1.5 s/slip) or `easyocr:th+en` fallback (12–25 s) |
| POST | `/api/v2/portfolio/slip/warm` | `{ok, backend}` — starts the OCR worker + loads the model (SlipReader calls it on mount) |

**Option slips (2026-09-26):** `slip.kind` = `stock` | `option`; an option slip (`parsers/dime_option.py`, asked before the stock parser) returns `form{instrument:'option', side, underlying, option_type, strike, expiry, contracts, multiplier, price, limit_price, trade_date, executed_at/submitted_at (ISO +07:00), settle_date, broker_order_ref, order_type, fee_items[{component,amount}], fee_total, note}` with checks `value` (contracts×mult×premium), `total` (BUY value+fees = payable, SELL value−fees = receivable), `ref_date`, `expiry`. Response adds `image_sha256s[]` + `ocr.pages`; `duplicates` also lists option_trades with that order ref.

Router `backend/routers/slip_ocr.py` (adds `form.account_hint` from its `ACCOUNT_HINT`, passes `slip_evidence.fee_schedule`); engine `backend/slip_ocr/` — split-ready: imports nothing from the backend, own `pyproject.toml` (`slip-ocr`, extras `rapid`/`easy`/`test`), own `tests/` + fixtures, `README.md`. Split with `git subtree split --prefix=backend/slip_ocr`. Proxies `app/api/v2/portfolio/slip/{read,status,warm}/route.ts` (read: 180 s timeout).
| GET | `/api/v2/portfolio/takeover?account_id&base_currency` | in-kind takeover lots (fair-value basis) + previous owner's cost memo; see data-shapes. Proxy `app/api/v2/portfolio/takeover/route.ts`; shown as the TAKEOVER strip in PORT → POSITIONS (2026-09-26) |

## Cloud sync (`routers/sync_router.py`)

Two engines. Legacy snapshot merge (`sync/manager.py`, `SYNC_ENABLED`) or the **op log** (`sync/oplog.py`, `OPLOG_ENABLED=true`, 2026-09-27) — the op log switches the snapshot merge off.
- `GET /api/changes` (`routers/changes.py`, 2026-09-28) — `{tables: {chart_drawings: <seq>}}` from `table_versions`, bumped by DB triggers on every write (`backend/change_feed.py`). Read through the heartbeat.
- `GET /api/heartbeat` (Next-only, `app/api/heartbeat/route.ts`, 2026-09-28) — the header's background state in ONE browser poll (15s): `{dev, sync, providers, changes, errors}` = `/api/dev/status` (dev only, else `null`) + `/api/sync/status` + `/api/providers`, fetched in parallel over loopback; a failed part is `null` + `errors.<part>`, never a failed heartbeat. Read by `useHeartbeat` (`useSync`, `useProviders`, `BackendStatusBanner`). The three proxies stay for curl/diagnostics.
- `GET /api/sync/status` — snapshot engine: `{enabled, device, sync_dir, reachable, last_pull, last_push, last_conflicts}`. Op log adds `{mode:"oplog", root, pending, ops, open_conflicts, peers:[{device, at, state: in_sync|catching_up|DIVERGED}], diverged, last_sync, last_error, last_result}` and maps `last_pull/last_push = last_sync`, `last_conflicts = open_conflicts` for the header chip.
- `POST /api/sync/pull` · `POST /api/sync/push` — snapshot engine; with the op log both run one full round (`sync_once`).
- `POST /api/sync/now` — op log only: flush → export → pull/apply → publish state. 409 when the op log is off.
- `GET /api/sync/conflicts?all=` — op-log conflicts (open only unless `all=true`): `{conflicts:[{id, table_name, row_key, kept_op, kept_device, kept_row, other_op, other_device, other_row, reason, detected_at, resolved_at, resolution}]}`. `other_*` is always the losing side.
- `POST /api/sync/conflicts/{id}/resolve` body `{choice:"kept"|"other"}` — writes a new op carrying `resolves=id`, so every device closes the same conflict and ends on the same row. 404 unknown id, 400 bad choice.
- Next.js proxies: `app/api/sync/{status,pull,push}/route.ts`, `app/api/sync/conflicts/route.ts`, `app/api/sync/conflicts/[id]/resolve/route.ts`.
