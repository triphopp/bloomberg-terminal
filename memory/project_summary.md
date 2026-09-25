# Bloomberg Terminal — Project Summary

**Repo:** `bloomberg-terminal` — macOS `~/bloomberg-terminal`, Windows `D:\Agents\Claude\bloomberg-terminal-main`
**Last updated:** 2026-09-26 — full rewrite after the 2026-09-25/26 changes (BOND/HMAP views, COT, dev status, portfolio takeover, TWR start-of-day flows, 2024-25 history review)

> Slim core reference. Navigate via [memory/INDEX.md](INDEX.md).
> - [reference/architecture.md](reference/architecture.md) — data flow, routers, key files, accounting layer
> - [reference/api-endpoints.md](reference/api-endpoints.md) — every endpoint, caching table, Next.js proxy routes
> - [reference/frontend-structure.md](reference/frontend-structure.md) — component tree, exports, keyboard shortcuts
> - [reference/data-shapes.md](reference/data-shapes.md) — API response shapes + TypeScript interfaces
> - [reference/gotchas.md](reference/gotchas.md) — error dictionary, anti-patterns, "Where is X?", env var map
> - [reference/terminal-commands.md](reference/terminal-commands.md) — command mode (`heatmap(US)`, ALERT …)
> - [reference/data-catalog.md](reference/data-catalog.md) — data categories available for analysis

---

## How to Run

| Way | Command | Notes |
|-----|---------|-------|
| Windows tray launcher | `BloombergTerminal.exe` (repo root) | starts both servers hidden, logs to `logs\`, restarts a dead server (3 tries), backend `--reload` by default (`--no-reload`, `--prod`). Build: `tools\launcher\build.bat`; details `tools/launcher/README.md`. Log-on start: `scripts\win\install-startup-task.ps1` |
| One command | `npm run dev:all` / `npm run dev:no-ollama` | `BACKEND_PORT` / `FRONTEND_PORT` override |
| Two terminals | `cd backend && python -m uvicorn main:app --port 9317 --reload` + `npm run dev` | |

- Ports: backend **9317**, frontend **9318**, UI at `http://bloomberg.localhost:9318`. Changing them touches `.env.local` (`PYTHON_API_URL`), `backend/.env` (`CORS_ORIGINS`) and whatever starts the servers — see `CLAUDE.md` → Ports.
- **Dev status strip** (2026-09-25): in `next dev` the top of the page says RUNNING OLD CODE (+ RESTART) or BACKEND DOWN. `GET /api/dev/status` = files changed since the backend started; `POST /api/dev/restart` asks the supervisor to restart (`backend/dev_status.py`, `routers/dev.py`, `core/backend-status-banner.tsx`).
- **env-doctor**: `npm run doctor` / `doctor:fix` / `doctor:ci` — gitignored env files drift between machines; runs as `predev` and from `.husky/post-merge` / `post-checkout`.
- **Upstream log**: every outbound call → `logs/upstream.jsonl`; read it first when data is missing/stale (`python backend/scripts/upstream_report.py`, `GET /api/health/upstream`).

## Tests (verified 2026-09-26)

```bash
cd backend && python -m pytest -q -p no:cacheprovider --basetemp=<scratch dir> tests/   # 1012 pass, 1 fail (test_iv_scheduler — see Known Issues)
npm run typecheck      # tsc --noEmit — clean
npm run test:chart     # 264 pass
npm run test:session   # 73 pass
npm run test:views     # 20 pass
npm run test:alerts    # 44 pass
npm run test:watchlist # 13 pass
node --test components/bloomberg/core/__tests__/*.test.ts   # 3 pass (navigation + Thai-layout shortcuts)
npm run lint           # biome
```

This Windows box denies the system temp dir to pytest — pass `--basetemp` to a writable folder. `.husky/pre-commit` runs Biome `check --write` + `tsc` on staged TS/JS and then **re-adds the whole file** (partial staging of a TS file is not possible).

---

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 16 App Router, React 19, TypeScript |
| State | Jotai (atoms) + TanStack React Query |
| Charts | lightweight-charts v5 via our `chartkit/` + `chart/` (ModularChart, panes, event rail, regression channels), Recharts for dashboards |
| Styling | Tailwind CSS, `bloombergColors` theme; text-only controls (`styles/globals.css`) |
| Backend | Python FastAPI (port 9317) — 61 routers, `main.py` mounts them |
| Data | yfinance through a provider registry (`sources/`) + app-wide Yahoo gate (`yahoo_gate.py`, 6 concurrent) + shared request coordinator (`market_requests.py`) |
| Macro / rates | FRED (+ Alpha Vantage fallback), Japan MOF JGB CSV, CBOE vol CSVs, Treasury fiscaldata |
| Filings / positioning | SEC EDGAR (submissions, 8-K EX-99.1, XBRL, EFTS 424B2/424B5), CFTC Socrata (TFF + Disaggregated) |
| Other | Polymarket Gamma, Binance aggTrades, World Bank, BOT API, SEC Thailand, SDMX central banks, dramexchange |
| AI | Claude API (portfolio AI), Ollama (optional, clippings endpoints only), MCP server `backend/mcp_server.py` |
| Database | SQLite `backend/portfolio.db`; Google Drive JSON sync (`backend/sync/`) |
| Options | Black-Scholes + Gram-Charlier (`greeks.py`), Raw SVI (`analytics/svi.py`), payoff (`analytics/option_payoff.py`) |

---

## Environment Variables

### Python backend (`backend/.env`, template `backend/.env.example`)
```
FRED_API_KEY          — required: macro, rates, crisis, TAIL, BOND
ALPHA_VANTAGE_API_KEY — macro fallback
ANTHROPIC_API_KEY     — portfolio AI; CLAUDE_MODEL / CLAUDE_MAX_TOKENS optional
BINANCE_API_KEY       — crypto order footprint
THESES_DIR / SOURCES_DIR / OBSIDIAN_WIKI_DIR / GRAPHS_DIR — thesis md, sources, Zettelkasten export, analysis pages
CLIPPINGS_DIR / OLLAMA_URL — backend clippings router (no UI since 2026-09-25)
RSSHUB_URL / FACEBOOK_ACCESS_TOKEN — social feed
BOT_API_TOKEN / BOT_IR_TOKEN / BOT_FX_TOKEN / BOT_STATS_TOKEN — Bank of Thailand
SEC2_API_KEY          — SEC Thailand new portal (Fund v2, Bond v2, One Report v1)
SEC_*_PRIMARY / SEC_BASE_URL — SEC Thailand old portal (legacy, closed 2026-06-30)
PORTFOLIO_DB          — default portfolio.db (scripts honour it: e.g. run backfill_nav on a copy)
CORS_ORIGINS          — must include the frontend origin (port 9318)
YAHOO_MAX_CONCURRENT  — default 6
QUOTE_PROVIDER_DEFAULT / QUOTE_AUTO_FAILOVER — quote registry
IV_SNAPSHOT_INTERVAL (default 10800, 0 = off) / IV_SNAPSHOT_SYMBOLS — ATM IV recorder
SERIES_REFRESH_INTERVAL — indicator series collectors
ALERT_SCAN_INTERVAL   — alert rule scanner
UPSTREAM_LOG          — override logs/upstream.jsonl
ALLOW_DANGEROUS_OPS   — gate for destructive maintenance endpoints
SYNC_ENABLED / SYNC_DIR (no quotes) / SYNC_DEVICE_ID / SYNC_FOLDER_NAME / SYNC_AUTODETECT
SYNC_PUSH_INTERVAL (60) / SYNC_PULL_INTERVAL (20) / SYNC_PUSH_DEBOUNCE (2)
MCP_AGENT_NAME / MCP_TRANSPORT / MCP_HOST / MCP_PORT — MCP server
BT_BACKEND_RELOAD / BT_SUPERVISOR — set by the launcher (dev status + restart)
```

### Next.js (`.env.local`)
```
PYTHON_API_URL=http://localhost:9317   — imported ONLY via lib/constants.ts (PYTHON_API)
```

---

## Backend Architecture — Modular Routers

`main.py` = app init + CORS + schema init + router mounting (61 routers). All logic in `backend/routers/`.
Import order matters: `dev_status` (source mtimes), `upstream_health` and `yahoo_gate` load before any router.

| Router file | Prefix | Source |
|-------------|--------|--------|
| `dev.py` | `/api/dev/{status,restart}` — dev-only stale-backend check | `dev_status.py` mtimes + launcher supervisor |
| `health.py` | `/api/health/upstream` — live upstream state (no outbound call) | `upstream_health.py` |
| `market.py` | `/api/market-data`, `/api/heatmap*` (no UI consumer since GMOV removal) | yfinance |
| `stock.py` | `/api/stock/*` — quote, history, financials, earnings (+ `Ticker.calendar`, SET filing deadlines via `earnings_deadlines.py`) | yfinance |
| `dcf.py` | `/api/dcf/*` (adaptive valuation + sensitivity + audit lineage) | yfinance + `analytics/dcf.py` |
| `ir_stress.py` | `/api/ir-stress/{curve,scenarios,{symbol}/exposure|duration|scenario,screen/rank}` (CIRST, stock RATE STRESS tab) | XBRL + FRED |
| `market_heatmap.py` | `/api/market-heatmap?market=US&per=25` (HMAP view) | yfinance `screen()` × 11 sectors in parallel; 90s, fail 60s, last-good 6h |
| `cot.py` | `/api/cot/{snapshot,history,basis,factor,portfolio,status}` | CFTC Socrata, 17 contracts, background refresh → `cot_*` tables; endpoints read SQLite only |
| `discover.py` | `/api/search-stats/{hit,top,{symbol}}`, `/api/most-active` (MKT FREQ / ACTIVE) | SQLite `search_hits` + yfinance `screen("most_actives")` |
| `bonds.py` | `/api/bonds/{overview,supply,issuance}` (BOND view) | FRED + Treasury fiscaldata + SEC EFTS |
| `rates.py` | `/api/rates/curve` (UST 11 + JGB 15 tenors, tick-row shape) | FRED daily + MOF CSV |
| `crisis.py` | `/api/crisis`, `/api/crisis/composite` (BOND → CONDITIONS, TAIL) | FRED |
| `macro.py` | `/api/macro`, `/api/macro/calendar` (event rail: FOMC/CPI/NFP/PCE/GDP, back 3y) | FRED + AV; `event_calendar.py` |
| `global_yields.py` | `/api/macro/global-yields` (no UI consumer) | FRED |
| `tail_risk.py` | `/api/tail-risk/*` — events, 6 dimensions, macro context, rotation, `cot_crowding` (context only) | CBOE CSV + yfinance + in-process crisis/fear_greed/ticker/cot |
| `options.py` | `/api/options/*` — chains, positions + Greeks, `POST smile-fit`, `POST payoff`, IV snapshots / SD bands | yfinance + greeks.py + SciPy SVI |
| `pins.py` | `/api/pins/*` (watchlist groups, assets, tags) | SQLite |
| `watchlist_signals.py` | `/api/watchlist/{quotes,signals,sparklines}` | shared `market_snapshots.py` / `market_requests.py` |
| `news.py` / `news_watchlist.py` / `social.py` | `/api/news/*`, `/api/social/feed` | 7 news sources, RSS, RSSHub/Graph API |
| `polymarket.py` / `polymarket_stock.py` | `/api/polymarket/*` | Gamma API (client-side filtering, see gotchas) |
| `company_filings.py` | `/api/company/{filings,outlook,xbrl}/{symbol}` | SEC EDGAR (US only) |
| `series.py` | `/api/v2/series/*` (generic indicator series; dramexchange DRAM/NAND) | SQLite + `series_sources/` |
| `portfolio_v2.py` | `/api/v2/portfolio/*` — accounts, trades, sell (AVCO), cash/transfer/reconcile, dividends, fees, open-positions, summary, returns, nav-history, **nav-index** (TWR, start-of-day for capital dated before the snapshot day), **takeover**, **history-review**, ledger check/stock-card/statements/evidence, import | SQLite |
| `risk.py` | `/api/v2/portfolio/risk/*` (VaR/CVaR/Parity/Stress/Sizing) | Ledoit-Wolf |
| `backtest_v2.py` | `/api/v2/portfolio/backtest/*` | SQLite trades + yfinance |
| `portfolio.py` | `/api/portfolio/*` (legacy research: thesis files, transactions, backtest) | filesystem + SQLite |
| `theses.py` / `zettel.py` / `graphs.py` | `/api/v2/theses/*`, `/api/v2/zettel/*`, `/api/v2/graphs/*` | SQLite + `THESES_DIR` / `OBSIDIAN_WIKI_DIR` / `GRAPHS_DIR` |
| `paper_trading.py` | `/api/paper/*` | yfinance + SQLite |
| `alerts.py` / `alert_rules.py` / `ticker.py` | `/api/alerts*`, `/api/ticker` | regime + SQLite rule engine |
| `regime.py` / `market_state.py` / `rotation.py` / `analytics.py` / `fear_greed.py` | regime correlation, per-symbol HMM state, RRG rotation (`/api/rotation/{table,map,tilt}`), analytics, F&G | yfinance |
| `allocation.py` / `country_rotation.py` / `sector.py` / `sectors.py` / `screener.py` | signal engines + sector classification + S&P screener (no MACRO view; kept for TAIL/API) | FRED + yfinance + SQLite |
| `fx.py` / `crypto.py` / `footprint.py` / `etf.py` | FX, crypto (footprint powers Order Footprint), ETF | yfinance / Binance |
| `central_banks.py` / `sovereign.py` / `bot.py` / `sec.py` / `sec_v2.py` | central banks, World Bank, BOT, SEC Thailand | SDMX, World Bank, BOT, SEC TH |
| `circuit_breaker.py` / `listing_gate.py` / `config_router.py` / `providers.py` / `sync_router.py` | market circuit breaker, IPO gate, symbol lists, quote providers, cloud sync | mixed |
| `clippings.py` | `/api/clippings/*` — kept, **no UI** since CLIP removal 2026-09-25 | filesystem + Ollama |

### Quote Provider Registry (live-quote path)
`market_data` singleton = `FailoverSource` facade. Quote path (`download_quotes`/`get_fast_info`/`download`/`get_history`) → `ProviderRegistry` (manual switch + auto-failover, capability-scoped, gap-fill merge per symbol). Only `YFQuoteProvider` is registered (Stooq removed 2026-09-24). Add a vendor: implement `QuoteProvider` + `registry.register()` in `sources/__init__.py`. FE seam: `useLiveQuery` + header `ProviderSwitch`. Roadmap: `plans/scaling/`.

---

### SQLite Database Schema (`portfolio.db`, 66 tables + 2 views, 2026-09-26)

Core portfolio tables first; the full per-table notes follow.

```sql
portfolio_accounts  (id, name, broker, country, currency, account_type, is_active, markets JSON, created_at, updated_at)
                    -- finansia (THB, sub-accounts 0153717 / 6065151 / 6065157 live in trades.note), dime (USD), innovestx (THB crypto)
trades              (id, account_id, symbol, sector, date_entry, date_exit, price_entry, price_exit,
                     price_stoploss, price_target, volume, amount, pnl_amount, win_loss W|L|P, pnl_percent,
                     currency, exchange_rate, exit_exchange_rate, resolved_symbol, market, is_reinvest,
                     fee_entry, fee_exit, fee_detail JSON,
                     acquisition_type, original_price_entry, transfer_price_entry,
                     strategy_name, entry_trigger, exit_trigger, market_trend, news_sentiment,
                     expectation_based, factor_based, fear_greed_index, vix_index, note, created_at, updated_at)
-- one row per lot; win_loss='P' = open. AVCO: a sell rebases every open lot of the symbol (_rebase_open_lots_to_avco);
--   a partial sell splits the lot (SELL_PARTIAL / SELL_PARTIAL_CREATED in trade_audit_log).
-- 2026-09-26 fees: fee_entry / fee_exit in instrument ccy, never inside price_entry (broker cost = qty × price);
--   fee_exit is inside pnl_amount, fee_entry is charged to realized on the buy date.
-- 2026-09-26 takeover: acquisition_type='TRANSFER_IN' = lot received in kind when a portfolio was taken over for
--   management. price_entry/amount/date_entry = fair value on the transfer date; original_price_entry = previous
--   owner's cost (memo); transfer_price_entry = the fair value. Both memo prices are copied on splits and never
--   rebased → inherited P&L = (transfer − original) × volume is fixed. GET /api/v2/portfolio/takeover.
trade_audit_log     (id, trade_id, action PATCH|SELL_FULL|SELL_PARTIAL|SELL_PARTIAL_CREATED|AVCO_REPAIR|DELETE|OPTION_EDIT,
                     fields_changed, reason, snapshot, created_at, event_id, updated_at)
position_cost_overrides (account_id, symbol, avg_cost, reason, updated_at)  -- display override of broker avg cost
portfolio_nav_snapshots (account_id all|<id>, snapshot_date, total_value, open_cost_basis, unrealized_pnl,
                     realized_pnl, invested_capital, dividends, source live|backfill, created_at)
-- live rows = captured when PORT is viewed (first 2026-07-03); backfill rows = scripts/backfill_nav.py rebuild
--   (2026-01-01 → day before first live). /nav-history re-derives invested_capital + dividends by date from TODAY's
--   ledgers and adds cash_balance / nav_with_cash / invested_before_day; cash = invested + realized + dividends
--   − open_cost_basis(stored) + adjustments → changing lot cost basis requires re-basing stored snapshots.
ledger_events       (id, account_id, trade_date, settle_date, trade_time, type, symbol, qty, price, gross, fee, vat, tax,
                     net_cash, currency, fx_rate, broker_ref, link_id, reverses_id, source, source_ref, note, created_at)
                     -- append-only journal (plans/port-accounting-ledger.md); 0 posted rows yet; _ledger_guard blocks UPDATE/DELETE
risk_snapshots      (account_id, snapshot_date, portfolio_value, breach_count, ensemble_signal, vol_regime, risk_score, ews, regime_label, …)
alert_rules / alert_rule_state / alert_events   -- boolean-AST alert engine (routers/alert_rules.py)
pm_slug_registry    -- Polymarket slug cache
paper_option_positions -- paper trading options
symbol_lists        -- indices / FX / crypto lists seeded from config.py
```

#### All tables (notes)
```sql
transactions        (id, symbol, type buy/sell, shares, price, date, commission, notes, created_at)
-- 2026-07-04 (port-redesign Step 1): trades += resolved_symbol TEXT, market TEXT (canonical provider ticker,
--   set at write time by /resolve-symbol); portfolio_accounts += markets TEXT (JSON e.g. ["US","TH"])
-- 2026-07-14 (multi-currency): trades.currency = authoritative instrument currency;
--   trades.exchange_rate = entry THB/native FX; trades.exit_exchange_rate = exit THB/native FX
-- 2026-07-16 (reinvest tag): trades += is_reinvest INTEGER DEFAULT 0 — ticked via "REINVEST?" in ENTRY,
--   listed in CASH → REINVEST alongside dividend-sourced rows. Label only: no cash/positions effect.
cash_ledger         (id, account_id, date, income, investment, exchange_rate, note, entry_type CASH|TRANSFER, linked_id)
-- 2026-07-14 (cash-transfer-feature): entry_type/linked_id additive; TRANSFER rows come in linked
--   pairs (same linked_id, opposite investment sign) via POST /cash/transfer; DELETE cascades pair
cash_adjustments    (id, account_id, date, amount, currency, target_balance, derived_before, category, note, created_at)
-- 2026-09-16: cash EDIT offsets. cash_base = derived + Σamount. Not capital (no XIRR/invested effect).
--   Synced (SYNC_TABLES + MONEY_TABLES). Deleted with its account.
-- 2026-09-25: category defaults UNKNOWN for old/API legacy rows; CASH EDIT UI requires selecting a reason.
broker_statements   (id uuid, account_id FK, as_of, currency, cash TEXT, market_value TEXT,
                     holdings_json, source_ref, source_note, supersedes_id FK, created_at, updated_at)
-- 2026-09-25: cited broker evidence, append revisions (API), sync + audit; R3 compares cash before EDIT and day-end quantities.
--   Source reference is user supplied, not verified file; no real statement loaded yet.
broker_executions   (id uuid, account_id FK, broker, symbol, side, executed_at_local, display_timezone,
                     quantity TEXT, unit_price TEXT, instrument_ccy, order_amount TEXT?, order_ccy?,
                     source_image, source_sha256, source_note, created_at, updated_at)
-- 2026-09-25: 29 Dime Activity fills from 10 hash-verified user images; sync + audit.
--   Evidence only: no trades/cash/lot/ledger posting. Screen time zone and sale settlement remain unknown.
portfolio_history_review (id uuid, source_sha256, record_type TRADE|CASH, source_sheet, source_row,
                          account_id, recorded_date, recorded_exit_date, symbol, source values,
                          market date/low/high, price checks, review_status, matched_cash_id,
                          lot_match_status, matched_source_rows, unmatched_quantity, source_weighted_cost,
                          review_decision, review_note, created_at)
-- 2026-09-26: local Excel evidence staging, 303 trade rows + 43 cash rows for 2024-25.
--   Review rows remain local evidence; GET /api/v2/portfolio/history-review reads them.
-- 2026-09-26: 20 independently checked closed trades posted to `trades` from a second
--   reconciliation workbook; 145 proposals marked REVIEW_REQUIRED. Two DATA_FIX offsets
--   release historical P&L from prior cash reconciliation, preserving current broker cash.
audit_events        (event_id uuid PK, table_name, row_id, account_id, action INSERT|UPDATE|DELETE, old_data JSON, new_data JSON, reason, created_at ms)
-- 2026-09-16: written ONLY by SQLite triggers (db.init_audit_layer, rebuilt every start) on db.AUDITED_TABLES.
--   Sync-guarded (peer imports not re-logged; the log itself syncs as a union). updated_at-only UPDATEs skipped.
--   Reason: `with audit_reason(conn, "...")` around the write (one-row `_audit_context`).
dividends           (..., currency)  -- record-level instrument currency; never assume account currency
fx_rates            (date, base, quote, rate, source, updated_at) PK(date,base,quote)
-- dated FX lookup uses same day or nearest prior trading day; open MTM uses live FX
pin_groups          (id, name, color, sort_order, created_at)
pinned_assets       (id, symbol, group_id, comment, buy_target, sell_target, price_at_pin, priority 1-3, added_at, updated_at)
pin_tags            (id, name, color)
pinned_asset_tags   (asset_id, tag_id)   -- many-to-many
sector_classifications (id, symbol, country, exchange, sector_gics, industry_gics, sector_local,
                        sector_display, company_name, market_cap, index_tags, source,
                        last_fetched, fetch_error, created_at, updated_at) UNIQUE(symbol, country)
option_contracts    (contract_id, occ_symbol UNIQUE, underlying, expiry, strike,
                     option_type call|put, multiplier, currency, created_at)
                     UNIQUE(underlying, expiry, strike, option_type)
option_trades       (trade_id, contract_id FK, account_id, trade_date, action OPEN|CLOSE,
                     side BUY|SELL, quantity>0, price, fees, exchange_rate,
                     close_reason TRADE|EXPIRED|EXERCISED|ASSIGNED|UNKNOWN, note, created_at)
option_trade_greeks (trade_id PK/FK CASCADE, spot, iv, delta, gamma, theta, vega, rho,
                     source live|manual|unavailable, captured_at)
option_trade_matches(close_trade_id FK, open_trade_id FK, quantity, fees_alloc, realized_pnl,
                     matched_at) PK(close_trade_id, open_trade_id)
-- 2026-09-10 (option-schema-normalization): แทนที่ `option_positions` เดิมที่ยัด instrument +
--   execution + lot lifecycle ไว้แถวเดียว (ปิดบางส่วนไม่ได้, ไม่มีสภาพตลาดตอนเข้า, แก้ราคาแล้ว
--   realized ที่รายงานไปแล้วเปลี่ยนตามเงียบๆ)
--   * ทิศทางอยู่ที่ action+side ไม่ใช่เครื่องหมายของ quantity — quantity บวกเสมอ
--   * lot = OPEN trade ที่ยัง match ไม่ครบ → view `v_option_open_lots` ไม่มีตาราง lot
--     ดังนั้นไม่มีคอลัมน์ status: หมดอายุ/ใช้สิทธิ์ = CLOSE trade เหมือนกันหมด
--   * realized_pnl materialize ตอน match ไม่ derive — แก้ราคาย้อนหลังจึงไม่รีไรต์ประวัติเงียบๆ
--   * price/realized_pnl เป็น NULL ได้เมื่อ close_reason='UNKNOWN' = "ไม่รู้ราคา" ≠ 0
--   * join หุ้น: option_contracts.underlying ↔ trades.symbol/resolved_symbol,
--     account_id ↔ portfolio_accounts.id
-- VIEW v_option_open_lots   — lot ที่ยังเปิด + entry greeks (alias lot_id → id ให้ frontend)
-- VIEW v_option_realized    — 1 แถวต่อ match: entry/exit/direction/realized
option_greeks_snapshots (position_id, snapshot_date, account_id, underlying, expiry, strike,
                     option_type, quantity, multiplier, currency, spot, iv, mark,
                     delta, gamma, theta, vega, market_value_usd, created_at)
                     PK(position_id, snapshot_date)
-- 2026-09-09 (option-greeks-and-attribution): state at the START of each day, which is what
--   P&L attribution needs and what cannot be reconstructed later. Captured once per day
--   off-thread from /open-positions and /analytics. `iv` here is the CONTRACT's IV — not the
--   ATM iv_mid in iv_snapshots. Accumulate-only, same as iv_snapshots.
iv_snapshots        (symbol, snapshot_date, expiry, dte, spot, atm_strike, iv_call, iv_put,
                     iv_mid, source, created_at) PK(symbol, snapshot_date, expiry)
-- 2026-08-17 (IV SD heatmap): ATM implied-vol history. Yahoo reports only the CURRENT
--   IV of a chain, so this can never be back-filled — only ACCUMULATED. Written as a
--   side effect of GET /api/options/{symbol} (and by POST .../iv-snapshot for a cron).
--   One row per (symbol, day, expiry); /sd-bands picks MIN(dte) per day.
bond_issuance_filings (adsh PK, file_date, form, issuer, cik, sic, category BANK|ABS|SOV|FIN|CORP, captured_at)
bond_issuance_days    (date PK, filings, complete, fetched_at)
cot_reports           (dataset, code, report_date PK; oi, conc4_long/short, conc8_long/short, fetched_at)
cot_positions         (dataset, code, report_date, grp PK; long, short, spread, traders_long, traders_short)
search_hits           (symbol PK, count, last_at)  -- symbols opened from a search box; local, NOT in SYNC_TABLES
-- 2026-09-25 (COT): cache ของ CFTC long-form, key = contract CODE (ชื่อตลาดเปลี่ยน 2022-02-01), ไม่ sync
-- 2026-09-25 (BOND view): cache ของ SEC EFTS 424B2/424B5 — re-derivable, ไม่ sync. วันจะ complete เมื่อเก่า ≥2 วัน
etf_aum_snapshots   (as_of, symbol, total_assets, nav, close, implied_shares, source,
                     captured_at) PK(as_of, symbol)
-- 2026-09-23 (sector rotation in TAIL): AUM ของ 11 SPDR sector ETF เก็บเอง วันละครั้ง.
--   Yahoo คืน get_shares_full() = None สำหรับ ETF และให้ totalAssets/navPrice เฉพาะวันนี้ →
--   ประวัติสร้างได้ทางเดียวคือบันทึกไว้เอง (เหตุผลเดียวกับ iv_snapshots/series_points).
--   เขียนแบบ side effect ของ GET /api/rotation/tilt ผ่าน thread (etf_aum.capture_async),
--   กันซ้ำด้วยแถวของวันนั้น. flow จริง = Δimplied_shares × nav (ต้องมี ≥2 วัน). อยู่ใน SYNC_TABLES.
pm_signals          (signal_type, probability, timestamp)  -- Polymarket history for Δ24h
allocation_signals  (id, equity_score, bond_score, recommendation, timestamp)
country_rotation_scores (id, ticker, score, rank, timestamp)
sector_signals      (id, sector_etf, score, rank, timestamp)
regime_alerts       (id, from_label, to_label, regime_type CORR, detected_at, expires_at)  -- 15-min event alerts
paper_accounts      (id, name, currency, initial_balance, created_at)
paper_orders        (id, account_id, symbol, side buy/sell, order_type market/limit/stop/stop_limit,
                     quantity, limit_price, stop_price, status pending/filled/cancelled/expired,
                     filled_qty, filled_price, filled_at, expires_at, created_at)
paper_fills         (id, order_id, quantity, price, commission, filled_at)
paper_positions     (id, account_id, symbol, quantity, avg_cost, realized_pnl) UNIQUE(account_id, symbol)
paper_snapshots     (id, account_id, date, equity, cash, positions_value) UNIQUE(account_id, date)
zettel              (id TEXT uuid PK, ref 'Z-0042' (indexed, NOT unique — two offline devices can
                     mint the same one; resolve-ref-collisions renames the later), kind, title,
                     body, stance, confidence, status, tags, actor, occurred_at (date of the FACT),
                     deleted_at, device_id, created_at, updated_at)
zettel_edges        (id PK, src_id, dst_id, rel, note, resolved_at, resolution, actor, …)
                     append-only; UNIQUE(src_id,dst_id,rel). CONTRADICTS with resolved_at NULL
                     = an open question the book is carrying
zettel_sources      (id PK, zettel_id, url, publisher, title, published_at, quote, reliability, …)
zettel_refs         (zettel_id, target_type thesis|trade|symbol, target_id, role) — PK all three
graphs              (id TEXT uuid PK, slug UNIQUE (natural key + URL segment), title, description,
                     kind 'html', symbol, thesis_id, zettel_refs 'Z-0019,Z-0021', tags, as_of,
                     sources JSON, version, bytes, actor, deleted_at, created_at, updated_at)
                     — page itself lives at GRAPHS_DIR/<slug>/index.html; NOT cloud-synced (git carries it)
zettel_fts          FTS5 trigram over (title, body, tags) — derived, NOT synced
theses              (id TEXT uuid PK, symbol, resolved_symbol, market, account_id, sub_portfolio,
                     title, category, strategy, status draft|active|watch|invalidated|closed,
                     conviction 1-5, time_horizon, target_price, stop_price, currency, body,
                     source_file, deleted_at, created_at, updated_at)
-- 2026-08-15 (thesis system): materialised head, edited in place → field-level LWW merge.
--   Soft delete = UPDATE deleted_at (NO tombstone, restorable on both devices); purge = real DELETE.
thesis_events       (id TEXT uuid PK, thesis_id, event_type, payload JSON diff, note, occurred_at,
                     device_id, created_at)  -- APPEND-ONLY: never UPDATEd, so LWW merge is a union
thesis_links        (thesis_id, trade_id, role, created_at) PK(thesis_id,trade_id)
thesis_notes        (id TEXT uuid PK, thesis_id, kind NOTE|SCENARIO|RISK|CATALYST|QUESTION|EVIDENCE,
                     title, body, impact bull|bear|mixed, likelihood 1-5, severity 1-5,
                     status open|watching|confirmed|dismissed, watch_date, pinned, sort_order,
                     deleted_at, device_id, created_at, updated_at)
-- 2026-08-31: standing notes (scenarios/risks/catalysts). EDITED IN PLACE, unlike thesis_events —
--   an event is a fact about the past, a note is a live object until the scenario resolves.
--   Resolving one (confirmed|dismissed) writes ONE NOTE_RESOLVED event; body edits write none.
allocation_targets  (id TEXT uuid PK, account_id, scope sector|symbol, key, target_pct, band_pct,
                     updated_at) UNIQUE(account_id, scope, key)
sync_tombstones     (table_name, row_id, deleted_at) PK(table_name,row_id)  -- cloud-sync delete log
_sync_guard         (active)  -- flag; raised during restore to silence sync triggers
```
Holdings computed via **average-cost method** in `db.compute_holdings()`.

series_meta         (id TEXT PK 'dx.spot.dram.<item>', group_key ('memory' — the board in the UI),
                     section, label, unit, source, source_url, freq, symbol, tags, sort_order,
                     first_seen, last_value, last_date, updated_at)   ← head row, LWW on merge
series_points       (series_id, date, value, high, low, change_pct, captured_at,
                     PK(series_id, date))   ← one published number on one day; merge = union.
                     `date` is the PUBLISHER's stamp, never the reader's clock

**Cloud sync (`backend/sync/`):** `init_sync_layer()` adds `updated_at` (millisecond stamps) + AFTER INSERT/UPDATE/DELETE triggers to synced tables (tombstones, all gated by `_sync_guard`). Local `.db` stays working copy; JSON snapshots (user tables only — excludes sector/risk/regime caches) exchanged via `SYNC_DIR`. **Never put `.db` on the cloud drive** (Drive byte-sync + WAL → corruption).

Merge is **three-way, field-level** (`merge.py`) against `.sync_base_<db>.json`, written after every pull and never pushed. That file holds **two kinds of ancestor** — `tables` (merged result → local side) and `peers[device]` (that peer's snapshot as last seen → that peer's side). ⚠️ One shared ancestor reverts data on every pull; see gotchas.md. Only same-field concurrent edits count as conflicts; losers go to `<SYNC_DIR>/conflicts/`. `paper_positions` is **not** synced (running aggregate → LWW drops fills); rebuilt from `paper_fills` by `derived.py` after each merge.

Cadence: startup `sync.sync_startup()` = pull→merge→push, then one worker (`_bg_loop`) that auto-pulls when `manifest.json` shows a peer hash change (`SYNC_PULL_INTERVAL`, 20s) and pushes every `SYNC_PUSH_INTERVAL`s. Writes to synced paths also schedule a debounced push (main.py middleware → `sync.request_push`, `sync/gate.py:is_synced_write`). Plan: `plans/completed/portfolio-cloud-sync.md`.

---

## Frontend Views — 6 views (since 2026-09-26)

| Key | Button | View | Component |
|-----|--------|------|-----------|
| `1` | MKT | Market (default, eager-loaded) | `market-view.tsx` — left panel WATCH / FREQ / ACTIVE (`discover-lists.tsx`, watchlist `pinned-assets.tsx` compact/table/cards) · main chart (`chart/ModularChart`, indicators, multiple regression channels, event rail: dividends/earnings/SET deadlines/FOMC/CPI/NFP/PCE/GDP) · REGIME panel CORR / GEOM / ROT (table + RRG map) / IV (smile, SVI, OI, 25Δ) / COT (PC1 + extremes) · TICK DATA board — 7 foldable, drag-reorderable sections (AMERICAS / EMEA / ASIA PACIFIC / RATES·US / RATES·JP / VOLATILITY / FX) in 4 columns NAME · LAST · CHG · YTD, ▼p/▲p CFTC crowding marks, `UsMarketClock` on top |
| `2` | NEWS | News | `views/news/` — WATCHLIST (per-ticker, 7 sources, by sector; HEADLINES / RATE STRESS / DCF / REGIME panels) · NEWSFEED · SOCIAL · DATA (indicator series board) + Polymarket column |
| `3` / `b` | BOND | Bond Monitor | `views/bonds/` — MARKET: KPI strip, TREASURY LEG, CREDIT LEG (IG/HY trigger lines 2%/5%), CORPORATE ISSUANCE/WEEK (SEC 424B2/424B5 ex-bank) + EVENT STUDY + RECENT DEALS, TREASURY AUCTIONS, DEBT STOCK, CFTC Treasury futures + basis trade · CONDITIONS (ex-CRDT, `useCreditData(isActive)` → `/api/crisis`): crisis level L0–3 (also in the status bar), STL FSI / NFCI, breakevens, 30Y mortgage, delinquencies, dealer balance sheet. `Alt+1/2` tabs |
| `4` / `p` | PORT | Portfolio | `portfolio-view.tsx` → `views/portfolio/` — PORTFOLIO (POSITIONS incl. TAKEOVER strip · OPTIONS · TRADES · CASH · ENTRY) · ANALYTICS (P&L dashboard: KPI strip, flagged XIRR, period returns, PORTFOLIO GROWTH (TWR, deposit ▲ / withdrawal ▼ / EDIT ◆, estimated span shaded, monthly table) · ROTATION · BACKTEST) · RISK (VaR/CVaR/stress/parity/sizing + FUTURES POSITIONING vs BOOK) · TOOLS (THESES: THESIS / NOTES / KB Zettelkasten / GRAPHS / HISTORY / LINKED TRADES / AI · IMPORT · AUDIT incl. ACCOUNTING CHECK) · PAPER (DASHBOARD / TRADE / POSITIONS / OPTIONS / HISTORY) |
| `5` / `t` | TAIL | Tail Risk Monitor | `tail-risk-view.tsx` + `views/tail/` — MARKET EVENTS (named cross-asset shocks; SEVERE raises the composite) · 6 risk dimensions → composite · MACRO CONTEXT (not in composite: event strip, Fed, curve, regime, latest prints, MACRO READ) · SECTOR ROTATION (turnover tilt + self-recorded ETF AUM) · POSITIONING (CFTC crowding flags; `cot_crowding` shown with CTX tag, `counted: False`) |
| `h` | — | HMAP (no nav button) | `heatmap-view.tsx` — one market as a sector treemap (~275 names); command `heatmap(TH)`, `heatmap(US, 52w)`; metrics 1D · 52W · 50D · 200D · HIGH · RVOL switch without a request; click → stock view, shift-click → floating chart |

- **Stock view** (not a nav button): global search `/` / `Ctrl+K`, heatmap or watchlist click → `stock-view.tsx`, 15 tabs (FINANCIALS, OUTLOOK, KEY METRICS, ANALYST, ESTIMATES, OWNERSHIP, CALENDAR, QUANTITATIVE, OPTIONS, EARNINGS QUALITY, GRID TRADING, STRATEGY FIT, DCF, RATE STRESS, REGIME) + COT when the symbol maps to a CFTC contract.
- **Floating chart windows** (`chart/ChartWindowLayer`) float over every view, cap 10, persisted.
- **URL = view**: header and mobile nav are `<a href="?view=…">` (`layout/view-navigation.ts`); new tab and Back/Forward restore the view. Shortcuts match the physical key (`core/shortcut-key-match.ts`), so they work on a Thai layout; IME composition, dead keys and Meta combos are ignored.

**Removed views** (backend routers kept unless noted): CLIP `4` (2026-09-25 — `clippings-view.tsx` + `app/api/clippings/*` deleted, `clippings.py` stays), CRDT `6` (2026-09-25 — merged into BOND → CONDITIONS; `crisis.py` stays), GMOV `3` (2026-09-25 — replaced by HMAP; `/api/heatmap*` stays without UI), MACRO `5` (2026-09-17 — folded into TAIL; `/api/macro`, `/api/sovereign/*`, `/api/country-rotation`, `/api/sector`, `/api/allocation` stay), CRYP `C` + FX `E` (2026-08-01 — FX in TICK DATA, crypto via search; `crypto.py`/`fx.py` stay), GVOL, EQTY, RMI. `views/volatility-view.tsx` is still exported from `views/index.ts` but not routed.

### Global keyboard shortcuts (`layout/bloomberg-terminal.tsx`)

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| `1`–`5` | MKT · NEWS · BOND · PORT · TAIL | `b` `p` `t` `h` | BOND · PORT · TAIL · HMAP |
| `/`, `Ctrl+K` | global search | `i` | focus MKT symbol search |
| `y` | %Chg YTD ↔ daily (THB ↔ USD in PORT) | `Ctrl+R` | refresh data |
| `Esc` | back / close overlay | `?` | shortcut help |
| `Ctrl+Shift+T` | toggle chart type | `Alt+1…9` | tab inside the view (`useTabShortcuts`) |

---

---

## Known Issues / Limitations

### Portfolio data (2026-09-26)
1. **Finansia 0153717 cash gap ≈ −฿33,360** — replaying the 2024-25 workbook (deposits + trades + 0.1678% commission) leaves the account ~฿33K short between 2025-01-20 and 2025-05-13; most likely an unrecorded deposit or a reconstructed re-buy that did not happen. Needs the broker statement. Workbooks: `Downloads/Portfolio Reconciliation 2024-2025 v2.xlsx`.
2. **2024-25 history mostly not in `trades`** — 20 of 165 reconciled closed trades were imported (`backend/scripts/apply_portfolio_reconciliation_2024_2025.py`); 145 are `REVIEW_REQUIRED` in `portfolio_history_review`. Until more are imported, a NAV backfill before 2026 would be a near-flat line, so `portfolio_nav_snapshots` starts 2026-01-01 and GROWTH shows 2026 only.
3. **Takeover cash is derived** — the 2026-02-08 takeover booked ฿585,453 in-kind (closes of 2026-02-06) + ฿426,112.06 cash = recorded ฿1,883,714.06 − previous owner's cost ฿1,457,602. Replace with the statement figure when available. Finansia statements still show the previous owner's average cost for those lots.
4. **Ledger check** (`/api/v2/portfolio/ledger/check`): H2 negative pre-offset cash remains (Finansia −฿37,185 on 2025-01-20 = item 1; Dime −$5,078), I4 reconstructed cash ≠ recorded broker cash for both accounts, C1/N1 not evaluated. No posted journal, no broker statements → read switch blocked.
5. **Dime row typos in the source workbook** — EXEL buy 22 @373.118 (2025-10-09, traded 38.27–39.47) and a duplicate of the 2025-10-08 EXEL sale; InnovestX alt-coins bought 2024-12-08 never sold while the account ends holding BTC only.

### Code / data sources
6. **`test_iv_scheduler::test_run_once_skips_without_touching_the_network`** fails (`KeyError: 'skipped'`); untouched by the 2026-09-25/26 work, looks date-dependent — not yet investigated.
7. **Pane indicator heights don't persist** 🔴 — lightweight-charts v5 converts `setHeight` px → stretch factor against a stale total (`plans/pane-height-persistence-fix.md`).
8. **TAIL Layer-A z-score units mismatch** 🟡 — 20-day cumulative return vs daily std inflates |z| ≈ √20; left as-is because the 2026-06-07 backtest used it. Fix = rescale + re-backtest together.
9. **VT (dime) cost basis unknown** — sells 3.8755 against an empty pool; `repair_avco_history.py` skips it.
10. **FRED key**: without it macro, crisis, BOND and TAIL fail. **Polymarket** Gamma ignores `tag_slug`/`q`/`order` — filter client-side on the 3,000-market pool; Δ24h null until the backend has run 24h. **RSSHub** public instance may rate-limit.
11. **BOT**: Stat-ExchangeRate returns 403 until activated in the portal; every series has a 31-day max per request.
12. **SEC Thailand**: old portal closed 2026-06-30 (`sec.py` legacy); use `sec_v2.py`. Digital Asset API under maintenance. One Report needs Gregorian `report_year` and `language` T/E.
13. **Options** data is ~15 min delayed (⏱ badge). **Volume Profile** is disabled for zero-volume symbols (yields, FX, VIX) — data-driven gate.
14. **Heatmap/GMOV leftovers**: `/api/heatmap*` endpoints and `app/api/heatmap/*` proxies have no UI consumer; `clippings.py` has no UI.
15. **Doc drift fixed 2026-09-26**: `CLAUDE.md` Views table had `3` = HMAP and `4` = BOND; code is `3` BOND · `4` PORT · `5` TAIL · `h` HMAP.

---

## What Could Be Built Next

Rule (memory/AGENTS.md §6b): a new plan adds a `- [ ]` line here; a finished plan becomes `- [x] … done YYYY-MM-DD` only with a Completion Evidence section.

### Open

- [ ] **PORT Evidence Match** — broker fills ↔ reconstructed trades, AUDIT → EVIDENCE (`plans/port-evidence-match.md`)
- [ ] **THESES readability + GRAPHS format + graph sync** — 7/7 steps coded 2026-09-19 (counts บนแท็บมากับ payload, markdown renderer เต็ม, rail พับได้, ปุ่ม READ โหมดเอกสาร, GRAPHS render shell + เทมเพลต + lint, `graphs` เข้า SYNC_TABLES + ไฟล์ HTML ไป Drive); เหลือฝังไฟล์ฟอนต์ Laksaman (`plans/theses-readability-and-sync.md`)
- [ ] **PORT Accounting Subsystems (S0–S7)** — audit + AVCO/FIFO preview + preflight + statement revisions/R3 + cash EDIT categories/R1/R2 + 29 image-cited Dime fills staged separately. 11 offsets เก่ายัง UNKNOWN; ไม่ migrate/activate, C1/H2/N1 ค้าง (`plans/port-accounting-subsystems.md`, `sessions/2026-09-25-dime-broker-execution-evidence.md`)
- [ ] **PORT Accounting Ledger** — Step 1 done; Step 2 verified SQLite backup + apply gate; Step 3 stock-card AVCO/FIFO + CHECK UI/API reconstructed; Step 6 statement intake/diff code prepared. ยังไม่มี posted events, dual-write/read switch (`plans/port-accounting-ledger.md`)
- [ ] **Mobile Responsive** — shell bottom nav + MKT single-panel switcher first; PORT, NEWS, rest follow (`plans/mobile-responsive.md`)
- [ ] **Migrate Fund legacy → v2** — ⚠️ overdue: the SEC old portal closed 2026-06-30; `/api/sec/*` legacy fund endpoints are dead
- [ ] Seed sector data: POST /api/sectors/fetch for TH/KR/HK/EU/US
- [ ] **Corporate Interest Rate Stress Testing (CIRST)** — วัดผลกระทบ shock ดอกเบี้ยระดับบริษัท (QERM): repricing ladder + fixed/float จาก XBRL → Earnings-at-Risk + breaking-point bp → Merton PD → spread → ΔWACC/ΔEV/equity duration → ES + Euler contribution → IR-Stress Score 0–100; tab ใหม่ใน stock-view + screener ใน BOND → CONDITIONS (CRDT merged 2026-09-25) (`plans/corporate-ir-stress-testing.md`)
- [ ] **CIRST Validation Harness** — backtest 5 ปี point-in-time (20 as-of, XBRL first-filed revision + FRED daily curve), เทียบ predicted vs realized 5 tier, บังคับชนะ null models (persist / full-reprice / debt×Δy) ด้วย Diebold-Mariano ก่อนเปิด Score; ได้ implied float-share ต่อบริษัทเป็นผลพลอยได้ (`plans/cirst-validation-harness.md`)
- [ ] **CIRST RATE STRESS tab** — แท็บที่ 13 ใน stock-view (เข้าจาก NEWS → คลิกหุ้น) 5 sub-tab: EXPOSURE (ladder+refi gap) · SCENARIO (ตาราง ΔI bound / ICR / DDM vs empirical) · DURATION (Gordon inverted + θ) · HISTORY (20 as-of ย้อน 5 ปี + error summary + attribution) · DIAGNOSTICS; 4 แท็บแรก ship ได้ทันที HISTORY รอ harness (`plans/cirst-stock-rate-tab.md`)
- [ ] **Floating Chart Windows** — เปิดกราฟหลายตัวพร้อมกันเป็น popup ลอยอิสระ (ลาก/ย่อขยาย/ย่อเก็บ/z-order, cap 10, persist localStorage, ลอยข้ามทุก view) — เฟส 1 done 2026-08-24; เหลือเฟส 2: TILE + edge snap, indicator แยกต่อหน้าต่าง (`plans/floating-chart-windows.md`)
- [ ] **IV SD Heatmap** — BS lognormal σ-band pane (5 buckets −2σ…+2σ) จาก `σ_mid=(IV_call+IV_put)/2`; 2 โหมด occupancy/cheapness, ตาราง `iv_snapshots` สะสม IV เอง, `/api/options/{sym}/sd-bands`; ยัง verify pixel ไม่ได้ (`plans/iv-sd-heatmap.md`)
- [ ] **System Audit 2026-07 — Bug Fixes & Refactor** — 9 fix items + 6 refactor items; F01 done 2026-07-03, F06 done 2026-07-04 (via port-redesign resolver); เหลือ F02 AVCO drift 🔴, F03 async blocking 🔴, F04/F05/F07/F08/F09 + R01–R06 (`plans/system-audit-2026-07/README.md`)
- [ ] **Port Redesign** — symbol resolver (resolve-at-write), sub_portfolios table จริง, currency module, ลบ `_get_yf_symbol`/ปิด F06 (`plans/port-redesign.md`)
- [ ] **VP Indicator Upgrade** — แก้ session timezone bug (B1 🔴) + visible-range VP + delta profile + naked POC + HVN/LVN + config UI; audit: `reports/vp-indicator-risk-report.md` (`plans/vp-indicator-upgrade.md`)
- [ ] **P/E History Pane + EPS Surprise Labels** — endpoint `/api/stock/pe-history` (TTM EPS × weekly close, 13–20yr), `PEPane.tsx` recharts sub-pane + valuation percentile bands, earnings marker สี beat/miss; code-complete, backend HTTP verified, frontend visual pending (`plans/pe-earnings-visualization.md`)
- [ ] **Pane Height Persistence Fix** — pane indicator ยุบเป็น 0 ตอน rebuild (lw v5 setHeight→stretch แปลงบนฐานว่าง) + drag จับเฉพาะ teardown ทำให้ reload แล้วหาย + wrapper h=0; แผนแก้ 3 ชั้น: defer setHeight 2-frame, capturePaneDrags 4 จุดเรียก, ซ่อม height chain (`plans/pane-height-persistence-fix.md`)
- [ ] **RSI Scale Modes** — คลิกขวาบน RSI pane เลือกสเกล 6 แบบ (standard / autofit / price projection / distance % / distance in avg moves / log RS) + modal ตั้งค่า; Step 1–2 done 2026-08-05 (`calcRSIState` export Wilder state + แก้ seed divergence 99.0099→100, `rsiInverse.ts`), Step 1–5 done 2026-08-05 — คลิกขวาบน RSI pane → เมนู 6 โหมด + เส้น projection บน price pane (Step 6 modal ยกเลิก ยุบลง context menu แทน) ยังไม่ verify ตัวเลขบนแกนด้วยตาเพราะ ModularChart ไม่วาด price series ในโปรไฟล์ที่ทดสอบ; audit: `sessions/reports/rsi-seed-divergence-risk-report.md` (`plans/rsi-scale-modes.md`)
- [ ] Polymarket: dashboard view in frontend
- [ ] BOT: frontend view for Bond Auction + yield trend chart
- [ ] BOT: activate Stat-ExchangeRate → add THB FX view
- [ ] Central banks: comparison chart across banks
- [ ] Clippings: auto-reload (file watcher)
- [ ] Alerts: price alert when stock hits threshold (price target, separate from stop loss)
- [ ] Sovereign: map visualization
- [ ] Bloomberg CLI + MCP server (`plans/bloomberg-cli-mcp.md`) — **MCP part started 2026-09-18**: `backend/mcp_server.py` (theses workspace + portfolio/market research, 15 tools; Claude Code via `.mcp.json`, Claude Desktop via `claude_desktop_config.json` — setup in `docs/mcp-server.md`); CLI still not built
- [ ] SEC One Report: frontend view (data available 2021–2023)

### Done (newest first)

- [x] **Portfolio takeover as in-kind transfer** — done 2026-09-26 (no plan file): Finansia 6065151/6065157 lots re-booked at fair value on 2026-02-08 (`acquisition_type='TRANSFER_IN'`, previous owner's cost as memo, `/api/v2/portfolio/takeover`, TAKEOVER strip in POSITIONS); script `backend/scripts/apply_portfolio_takeover.py`; commit `20b4294`
- [x] **NAV index start-of-day flows** — done 2026-09-26 (no plan file): capital dated before the snapshot day counts in that day's base (`invested_before_day`); commit `840ecaa`
- [x] **2024-25 history reconciliation** — done 2026-09-26 (partial import by design): workbook v2 with price-checked dates, AVCO replay, missing buys, cash books; 20/165 trades imported, 145 `REVIEW_REQUIRED` (`sessions/2026-09-26-portfolio-history-db-backfill.md`)
- [x] **Terminal Navigation Accessibility** — done 2026-09-26: เรียงคีย์เมนู, รองรับผังแป้นพิมพ์ไทย, เปิดเมนูด้วย Ctrl+click (`plans/completed/terminal-navigation-accessibility.md`)
- [x] **BOND view** — done 2026-09-25; key `B`: yields/spreads/term premium vs SEC corporate-deal proxy + Treasury auctions + Z.1, event study (`plans/completed/bond-view.md`)
- [x] **Sector Rotation Map (RRG)** — done 2026-09-25; ROT tab MAP view, `/api/rotation/map`, TH bench fallback TDEX.BK (`plans/completed/sector-rotation-map.md`)
- [x] **PORT ANALYTICS redesign** — done 2026-09-25; dashboard grid, KPI strip, GROWTH view (signals-style TWR + monthly table), PORTFOLIO ROTATION card, ledger, accounts table (`plans/completed/port-analytics-redesign.md`)
- [x] **Upstream event log (no UI)** — done 2026-09-24; alert bar ลบ → `logs/upstream.jsonl` + `backend/scripts/upstream_report.py` + ขั้นตอนใน CLAUDE.md; ลบ EM HY OAS (FRED ลบ series) (`plans/completed/upstream-event-log.md`)
- [x] **FRED timeout hardening** — done 2026-09-24; cap 3 + GET retry 2 ครั้ง + fail-fast + redact api_key; alert เหลืองต้อง ≥2 final failures (`plans/completed/fred-timeout-hardening.md`)
- [x] **Upstream health alerts** — done 2026-09-24; bar แจ้งเตือนใต้ header เมื่อแหล่งข้อมูล/เน็ตมีปัญหา (429, DNS, timeout) + ข้อมูลไหนเก่า; `/api/health/upstream` (`plans/completed/upstream-health-alerts.md`)
- [x] **TAIL readability + Yahoo request gate** — done 2026-09-24; UI TAIL ตัวใหญ่ขึ้น/คำสั้น/รายละเอียดเป็น click-tooltip; `backend/yahoo_gate.py` จำกัด Yahoo 6 requests พร้อมกันทั้ง backend (page load 228→86 connections ใน 10 วิแรก) (`plans/completed/tail-readability-yahoo-gate.md`)
- [x] **TAIL Real Yields + Energy Crack Spreads** — done 2026-09-24; TIPS real yield (DFII5/10 + same-day EST) แยก nominal = real + breakeven, crack ดีเซล/เบนซิน/3-2-1 + Brent−WTI, events ใหม่ 4 ตัว, mask วัน roll สัญญาฟิวเจอร์ส (`plans/completed/tail-real-yield-energy-spreads.md`)
- [x] **TAIL Market Event Classifier** — done 2026-09-24; ตั้งชื่อเหตุการณ์ทางการจากช็อกข้ามสินทรัพย์ + SEVERE ยก composite + fix MOVE ถูกทิ้งเพราะ align เข้าปฏิทิน VIX (`plans/completed/tail-event-classifier.md`)
- [x] **Latest Daily Candle Recovery** — done 2026-09-23; กู้แท่งวันล่าสุดเมื่อ Yahoo daily close ว่างแต่ quote ปิดวันเดียวกันพร้อม raw OHLC ใช้ได้ (`plans/completed/latest-daily-candle-recovery.md`)
- [x] **Extended-Hours Candle Price Line** — done 2026-09-23; PRE/AH quote เป็นเส้นแนวนอนบนกราฟแท่งเทียนใน MKT, stock-view และ floating chart (`plans/completed/extended-hours-candle-price-line.md`)
- [x] **TICK DATA Section Order** — done 2026-09-23: drag/ปุ่มขึ้นลงจัดลำดับหมวดทั้งเจ็ดและจำไว้หลัง reload (`plans/completed/tickdata-section-order.md`, `sessions/2026-09-23-tickdata-section-order.md`)
- [x] **WATCHLIST Shared Data Optimization** — done 2026-09-23: shared Yahoo/Gamma API coordination, full-list batching/statuses, retained query cache and paged rendering;1000-symbol browserfixture verified (`plans/completed/watchlist-shared-data-optimization.md`, `sessions/2026-09-23-watchlist-shared-data-optimization.md`)
- [x] **WATCHLIST API Management Study** — done 2026-09-23: study only; list เดียวขนาดใหญ่, signals, shared market-data service/queues/retry; mockยืนยัน Retry-Afterหายที่proxy, registryไม่มีcooldownในquote path, PM503กลายเป็นnegativecache และ historyซ้ำระหว่างscan/alerts (`plans/completed/watchlist-api-management-study.md`, `reports/watchlist-api-management-study-2026-09-23.md`)
- [x] **WATCHLIST Optimization Study** — done 2026-09-23: ศึกษาเสร็จ (ยังไม่ implement); eager history + `3mo`→1y, per-symbol fan-out/remount cache, silent 60/30 caps; roadmap รองรับหุ้นจำนวนมากและหลาย lists พร้อม API/mock evidence (`plans/completed/watchlist-optimization-study.md`, `reports/watchlist-optimization-study-2026-09-23.md`)
- [x] **Neocloud three-year accounting review** — done 2026-09-19; รายงานไทย 34 โปรไฟล์พร้อมช่องว่างหลักฐานและ MCP readback (`plans/completed/neocloud-three-year-accounting-review.md`)
- [x] **Zettelkasten Knowledge Base (THESES)** — คลังความรู้อะตอมที่ใช้ซ้ำข้าม thesis: `zettel`/`zettel_edges`/`zettel_sources`/`zettel_refs` + FTS5, edge ชนิด SUPPORTS/CONTRADICTS/REFINES/SUPERSEDES, พาเนล OPEN CONFLICTS, MCP 11 tools, export ทางเดียว → Obsidian `[[wikilink]]` — done 2026-09-18 (`plans/completed/zettelkasten-knowledge-base.md`)
- [x] **Indicator Series Board** — done 2026-09-19 — generic series store (`series_meta`/`series_points`) + collector registry `series_sources/`; dramexchange = ชุดแรก (31 series: DRAM/NAND/module/memcard spot + DRAM/NAND/SSD contract), แท็บ DATA ใน NEWS, scheduler วันละจุด, เข้า cloud sync (`plans/completed/indicator-series-board.md`)
- [x] **CFTC COT Positioning** — done 2026-09-25 — `routers/cot.py` (`/api/cot/{snapshot,history,basis,factor,portfolio,status}`, 17 contracts, SQLite `cot_*`) → TAIL POSITIONING (`cot_crowding` counted=False, backtest WEAK) · BOND basis trade + dealer · MKT chips + REGIME COT · stock COT tab · PORT RISK crowding (`plans/completed/cot-positioning.md`, backtest `D:/Agents/Claude/backtest-idea/06_cot_crowding/results/2026-09-25/report.md`)
- [x] **MKT Compact Chart Toolbar** — done 2026-09-25: รวมช่วงเวลาและ indicator controls ในแถบเดียวเมื่อแผงกว้าง; แผงแคบจัดสองแถวและเลื่อนรายการ indicator ได้ (`plans/completed/mkt-compact-chart-toolbar.md`)
- [x] **Multiple Regression Channels** — done 2026-09-25: REG หลายชุดพร้อมกัน แยกตาม symbol/interval เลือก ปรับ mode และลบรายชุด (`plans/completed/multi-regression-channels.md`)
- [x] **TAIL Macro Read (MOVE + core inflation + ISM proxy)** — MOVE เข้า `vol_indices` (yfinance-only) + สัญญาณ `move_spike` ใน CROSS-ASSET VOL; `/api/macro` เพิ่ม `cpi_core` `pce` `pce_core` `ism_proxy` (regional Fed composite — FRED ถอด ISM ออกปี 2022); บล็อก MACRO READ 3 แกน (INFLATION / GROWTH / RATES VOL) พร้อมกฎที่ใช้ตัดสิน — done 2026-09-20 (`plans/completed/tail-macro-read.md`)
- [x] **TAIL Macro Context** — FOMC/CPI/NFP/PCE/GDP calendar + Fed/curve/regime context in TAIL; MACRO view removed; FOMC off-by-one fixed — done 2026-09-17 (`plans/completed/tail-macro-context.md`)
- [x] **Windows NEWS API recovery** — done 2026-09-13 — restarted stale Windows backend; DCF/REGIME/SVI live HTTP checks OK, 61 tests passed (`plans/completed/windows-news-api-reload.md`)
- [x] **MKT IV Open Interest** — done 2026-09-13 — optional Call/Put OI bars on IV/SVI, separate contracts axis, one selected actual expiry, range totals/P-C and source availability (`plans/completed/mkt-iv-open-interest.md`)
- [x] **MKT SVI Fit and Tenors** — done 2026-09-13 — optional Raw SVI, observed points/RMSE/parameters, actual expiries near1/3/5/7/9 months and Call/Put/OTM selection (`plans/completed/mkt-svi-fit-tenors.md`)
- [x] **MKT IV Smile** — done 2026-09-13 — Yahoo chain smile in REGIME IV tab, numeric K vs IV%, follows main chart symbol with expiry and quote filters (`plans/completed/mkt-iv-smile.md`)
- [x] **MKT IV 25Δ metrics** — done 2026-09-23 — observed skew and curvature/butterfly under the smile, per expiry, using filtered quotes and no wing extrapolation (`sessions/2026-09-23-iv-smile-wing-metrics.md`)
- [x] **ATR Accumulation Pane** — done 2026-09-13 — optional Wilder ATR/ATR% pane with low-volatility + rising EMA green/red filter and persistent settings (`plans/completed/atr-accumulation-pane.md`)
- [x] **Bollinger Sharpe Fit** — done 2026-09-13 — optional Breakout %B grid search (209 n/k pairs), max net per-bar Sharpe, separate holdout and preserved Manual settings (`plans/completed/bollinger-sharpe-fit.md`)
- [x] **Adaptive DCF Valuation Lab** — done 2026-09-13 — multi-model valuation engine (3-stage FCFF default; growth/FCFE/excess-return/AFFO/normalized-cycle adapters), quant assumptions+sensitivity+audit UI, shared NEWS/stock panel (`plans/completed/dcf-valuation-lab.md`)
- [x] **BBW Squeeze Hazard Study** — done 2026-09-09 — ตอบว่า BB Width ต้องบีบเท่าไหร่ถึงยก P(volatility expansion ภายใน h วัน) เหนือ base rate และโมเดล rank+duration+RV-term ชนะกฎ `BBW ≤ 1.05×min125` เดิมหรือไม่; S&P500 500 ตัว, purged walk-forward, holdout แตะครั้งเดียว (`plans/completed/bbw-squeeze-hazard.md`, ผล: `D:/Agents/Claude/backtest-idea/05_bbw_squeeze/results/2026-09-09/report.md`)
- [x] **Quant Market State (per-symbol REGIME)** — done 2026-09-13 — latent-state framework ต่อหุ้น: OHLCV → feature + redundancy check → Gaussian HMM → `MarketState_t = [RegimeProbability, Trend, Momentum, Volatility]` + ประโยคสรุป + strategy compatibility ที่คำนวณจากสถิติ conditional ของ symbol เอง; panel REGIME ใน NEWS (ข้าง RATE STRESS) + tab ใน stock-view; แยก market interpretation ออกจาก trading decision และแยก dashboard mode (fit in-sample, label causal) ออกจาก validation mode (walk-forward) (`plans/completed/market-state-regime.md`)
- [x] **Volume Z-Score + Volume Event Classifier** — done 2026-09-13 — volume ดิบไม่ให้ข้อมูลเพราะเป็น level ที่ไม่มีสเกลอ้างอิงและไม่มีผลลัพธ์ติดมา; แก้ baseline RVOL จาก mean → median/MAD บน ln(V) (spike เดิมไม่ดัน baseline ค้าง 20 แท่ง) + cumulative-session mode แก้แท่งที่ยังเปิดอ่านเป็น quiet + classifier 6 event types (climax/absorption/vacuum/breakout/noDemand/dryUp) เป็น chip บน price pane + ตาราง event ที่มีคอลัมน์ forward return (`plans/completed/volume-zscore-events.md`)
- [x] **Dynamic Chart History** — ซูมออกจนสุดข้อมูลแล้วกราฟโหลดช่วงถัดไปเอง (3M→YTD→1Y→5Y→MAX) โดยไม่เสียมุมมอง; lib ของเราเอง `components/bloomberg/chartkit/` (pure core + engine adapter) เตรียมไว้เขียน candle engine เอง — done 2026-08-25 (`plans/completed/dynamic-chart-history.md`)
- [x] **TAIL Risk Monitor v2** — CBOE vol data (VIX/VIX9D/VIX3M/VIX6M/VVIX/SKEW/OVX/GVZ/VXN) แทน yfinance ที่ค้าง 28 วัน, tri-state signals, 6 risk dimensions, composite นับมิติไม่ใช่นับ signal — done 2026-08-16 (`plans/completed/tail-risk-v2.md`)
- [x] **Company OUTLOOK (SEC EDGAR)** — guidance ที่บริษัทยื่นใน 8-K EX-99.1 + คำพูด CEO + MD&A forward-looking + งบ as-reported จาก XBRL; แท็บ OUTLOOK ใน stock-view + แถบใน NEWS — done 2026-08-15 (`plans/completed/company-outlook-edgar.md`)
- [x] **Thesis Notes** — sub-tab NOTES ในหน้า THESES: standing scenario/risk/catalyst/question ที่แก้ในที่ได้ (kind, impact bull/bear, likelihood×severity, watch date, pin, resolve/reopen) + `thesis_notes` table + sync + `/notes/due` cross-thesis feed — done 2026-08-31 (`plans/completed/thesis-notes.md`)
- [x] **Polymarket stock price ladders** — `/api/polymarket/stock/{sym}` แปลง touch ladder + "close above" CDF เป็น P(up)/skew/implied range; panel ใน NEWS + คอลัมน์ PM ใน MKT watchlist — done 2026-08-15 (`plans/completed/polymarket-stock-ladder.md`)
- [x] **NEWS watchlist redesign** — ข่าวรายหุ้นจาก 7 แหล่ง (Yahoo/yfinance/Google/Bing/Seeking Alpha/Nasdaq/SEC), แบ่งกลุ่มตาม SECTOR อัตโนมัติ, ticker badge ทุกหัวข้อ, Polymarket จับคู่รายหุ้น — done 2026-08-15 (`plans/completed/news-watchlist-redesign.md`)
- [x] **Analytics Cash Card** — CASH tile + MARKET VALUE split (excl./incl. idle cash) in ANALYTICS Capital Breakdown — done 2026-07-14 (`plans/completed/analytics-cash-card.md`)
- [x] **Cash Transfer** — linked-pair TRANSFER entry_type in `cash_ledger` so inter-account cash moves (e.g. FINANSIA→DIME) fix per-account `invested_capital` bookkeeping with atomic insert + cascade delete — done 2026-07-14 (`plans/completed/cash-transfer-feature.md`)
- [x] **Portfolio Cloud Sync** — PC↔Mac sync via Google Drive JSON snapshots, startup pull, row-LWW merge + tombstones, no login done 2026-06-26 (`plans/completed/portfolio-cloud-sync.md`)
- [x] **Option Payoff Simulator** — done 2026-09-10: `backend/analytics/option_payoff.py` (payoff at expiry = เลขคณิต, T+0 = BS ผ่าน greeks.py, POP = lognormal risk-neutral) + `POST /api/options/payoff`; พรีวิวสดในฟอร์ม ADD (expiry คำนวณที่ client, T+0/POP debounce 400ms) + ปุ่ม PAYOFF ในแถว lot รวมทุก lot ของ underlying; breakeven จาก sign change + bisection, max P/L จาก slope ที่ปลายไม่ใช่ขอบกริด (`plans/completed/option-payoff-simulator.md`)
- [x] **Audit log for every money edit** — done 2026-09-16: trigger-written `audit_events` on trades/options/cash/cash_adjustments/dividends/avg-cost/accounts/targets; `GET /api/v2/portfolio/audit-events`; PORT → TOOLS → AUDIT tab. Evidence: `backend/tests/test_audit_events.py` 6 pass, full backend suite 699 pass, 30 triggers live on real DB
- [x] **Cash Reconcile (EDIT) + NAV incl. cash** — done 2026-09-16: `cash_adjustments` offsets + `POST /cash/reconcile` / `GET /cash/adjustments` / `DELETE /cash/adjustments/{id}`; CASH chip always visible in SummaryBar, click → `CashReconcileModal`; `/nav-history` adds `cash_balance`/`nav_with_cash` so sells no longer dent PORTFOLIO VALUE. Evidence: `backend/tests/test_cash_reconcile.py` 4 pass + live API check
- [x] **Option Edit + Portfolio Cash** — done 2026-09-10: `cash_base`/`open_cost_base` คำนวณที่ `/summary` (invested + realized ทั้ง equity และ option + dividends − open cost ทั้งสองประเภท) แสดงที่ SummaryBar + CASH tab + ANALYTICS ทั้งสามอ่านตัวเลขเดียวกัน — เป็นค่าประมาณ ไม่โพสต์ `cash_ledger`; `PATCH /api/options/trades/{id}` แก้ trade ที่กรอกผิด + re-match realized + `trade_audit_log` + EDIT modal (`plans/completed/option-edit-and-portfolio-cash.md`)
- [x] **Option Schema Normalization** — done 2026-09-10: `option_contracts` (instrument, dedupe ด้วย occ_symbol) + `option_trades` (execution, immutable, ทิศทางอยู่ที่ action+side) + `option_trade_greeks` (5 greeks + spot/IV ณ จุดเทรด, 1:1) + `option_trade_matches` (FIFO partial close, realized materialized); lot = OPEN trade ที่ยัง match ไม่ครบ → `v_option_open_lots` ไม่ใช่ตาราง; หมดอายุ/ใช้สิทธิ์ = CLOSE trade; migrate + DROP `option_positions` (`plans/completed/option-schema-normalization.md`)
- [x] **Option Greeks + PnL Attribution** — done 2026-09-09: PORT · OPTIONS แสดง Δ/Γ/Θ ต่อสัญญา + dollar greeks (DELTA/GAMMA-1%/THETA-day/VEGA-1pp) หน่วย USD, ตาราง derivatives เป็น USD ล้วน; ตาราง `option_greeks_snapshots` เก็บ spot/IV/greeks รายวัน (accumulate เท่านั้น back-fill ไม่ได้); `/api/v2/portfolio/options/attribution` แยก Δ/Γ/Θ/ν/residual ด้วย greeks ต้นงวด; ANALYTICS section DERIVATIVES ทั้งพอร์ต + ราย option + stacked bar รายวัน (`plans/completed/option-greeks-and-attribution.md`)
- [x] **Options in Portfolio** — done 2026-09-09: `backend/portfolio_options.py` เป็นจุดเดียวที่ ตีราคา option lot; premium MV เข้า NAV/unrealized/realized ของ `/summary` `/open-positions` `/returns` `/nav-history` `/analytics`, delta-adjusted notional ถ่วงน้ำหนัก `/allocation-detail`; schema +`exit_price`/`exit_date`/`currency`/`multiplier`/`sector`; close endpoint รับราคาปิด; รวม fix greeks spot bug 🔴 (`plans/completed/options-in-portfolio.md`)
- [x] **Multi-Currency Sub-Portfolio** — done 2026-07-14: `trades.currency` เป็น instrument ccy authoritative, rollup ต่อ trade, mixed-ccy account, realized trading P&L ใช้ exit-date FX (ไม่รวม principal FX attribution), แสดง `ECON` FX-inclusive attribution แยก, live MTM และ daily `fx_rates` (`plans/completed/multi-currency-portfolio.md`)
- [x] **TICK DATA Consolidation** done 2026-08-01 — เพิ่ม RATES·US (UST 11 tenor, FRED daily) + RATES·JP (JGB 1Y–40Y, MOF CSV) + FX เข้า TICK DATA panel ใน MKT, section ยุบได้; ลบ CRYP [C] + FX [E] views (backend crypto/fx router คงไว้) (`plans/completed/tickdata-rates-fx-consolidation.md`)
- [x] **Thesis System (DB) + Allocation Basis** — theses/thesis_events/thesis_links ใน SQLite + sync ผ่าน Google Drive, edit/soft-delete/restore, event log เก็บ diff, import/export .md; ALLOCATION (OPEN) ใหม่: cost vs market value, growth%, drift, share of gain, rebalance sizing (หุ้น + กำไรที่จะรับรู้) — done 2026-08-15 (`plans/completed/thesis-db-and-allocation-basis.md`)
- [x] **Alert Ticker** — Bloomberg-style scrolling bar: regime change (15-min event) done 2026-06-05 (`plans/completed/alert-ticker.md`); the stop-loss breach pill was removed with the stop engine 2026-09-15
- [x] **Fear & Greed Index** — chart pane indicator + FEAR-GREED searchable symbol + F&G/VIX prominent pills in alert ticker done 2026-06-06 (`plans/completed/fear-greed-index.md`)
- [x] **Analysis Graphs** — หน้าวิเคราะห์ HTML ที่ agent สร้างผ่าน MCP `graph_create` เก็บใน `research/graphs/<slug>/` + ตาราง `graphs`, เปิดจาก PORT → TOOLS → THESES → GRAPHS หรือลิงก์ `/api/v2/graphs/<slug>/render`; render ใต้ CSP เข้ม + iframe sandbox ไม่มี allow-same-origin — done 2026-09-18 (`plans/completed/analysis-graphs.md`)
- [x] PORT Analytics: Allocation stacked bar + Dividend M/Q/Y + currency fix (done 2026-06-05, `plans/completed/analytics-charts-enhancement.md`)
- [x] Polymarket: Δ24h + MCP endpoint (2026-06-05)
- [x] Portfolio Risk System: VaR/CVaR/Stress/Parity/Sizing (2026-06-02)
- [x] Options: position tracking + BS+GC Greeks (2026-06-03)
- [x] Regime Detection panel in MKT view (2026-06-03)
- [x] **DCC v1+v3 live signals** — backtest IS/OOS/FWD, wired into tail ribbon + alert ticker (g13_dcc_v1, g14_dcc_hmm) done 2026-06-07
- [x] **Portfolio: Trade DELETE button** — confirm banner, irreversible delete done 2026-06-07
- [x] **Portfolio: Import + Edit modal bug fixes** — price_exit auto-sets win_loss W/L; symbol blur → sector auto-fill via `/api/stock/sector/{symbol}` done 2026-06-07
- [x] **Strategy Builder** — 19 templates (inc. Calendar/Diagonal multi-expiry), BS payoff, PoP/E[P&L]/Kelly ranking table done 2026-06-08 (`plans/completed/strategy-builder.md`)
- [x] **Paper Trading** — virtual accounts, market/limit/stop orders, execution engine, positions + P&L, equity curve done 2026-06-08 (`plans/paper-trading.md`)
