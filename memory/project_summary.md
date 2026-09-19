# Bloomberg Terminal — Project Summary

> **BBW study audit 2026-09-09:** ข้อสรุป study เดิมต้องอ่านคู่กับ [audit](reports/bbw-squeeze-2026-09-09-risk-report.md): พบ unknown labels, benchmark drift, final purge gap และการตีความ coefficient/survival median ผิด ผล E2 ranking ยังอยู่ในการคำนวณตรวจซ้ำ แต่ยังไม่มี trading validation

**Repo:** `bloomberg-terminal` — macOS `~/bloomberg-terminal`, Windows `D:\Agents\Claude\bloomberg-terminal-main`
**Last updated:** 2026-09-13 (Adaptive DCF Valuation Lab)

> Slim core reference. Navigate via [memory/INDEX.md](INDEX.md).
> - [reference/api-endpoints.md](reference/api-endpoints.md) — all endpoints, caching table, Next.js proxy routes
> - [reference/frontend-structure.md](reference/frontend-structure.md) — component tree + exports + keyboard shortcuts
> - [reference/data-shapes.md](reference/data-shapes.md) — API response JSON shapes + TypeScript interfaces
> - [reference/architecture.md](reference/architecture.md) — stack, data flow, routers, analytics folder, key files
> - [reference/gotchas.md](reference/gotchas.md) — error dict + anti-patterns + "Where is X?" + env var map

---

## How to Run (2 terminals)

```powershell
# Terminal 1 — Python backend
cd backend
# Set env vars in backend/.env (copy from .env.example)
python -m uvicorn main:app --port 9317 --reload

# Terminal 2 — Next.js frontend
npm run dev  # → http://localhost:9318
```

```bash
# Tests — verified 2026-08-01
cd backend && python -m pytest tests/ -q   # 321 passed (greeks, alerts, sync, portfolio, SEC, DCC)
npm run test:alerts                        # 44 passed (node:test)
npm run test:chart                         # 13 passed (pane-layout)
npx tsc --noEmit                           # TypeScript check
```

---

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 14 App Router, React, TypeScript |
| State | Jotai (atoms) + TanStack React Query |
| Charts | Recharts + custom CandlestickChart |
| Styling | Tailwind CSS, bloombergColors theme |
| Backend | Python FastAPI (port 9317) — modular routers |
| Data | yfinance (market/stock/crypto/fx) |
| Macro data | FRED API + Alpha Vantage fallback |
| AI | Ollama (local, port 11434) + Claude API (Anthropic) |
| Prediction markets | Polymarket Gamma API |
| Crypto footprint | Binance aggTrades API |
| Sovereign data | World Bank Development Indicators |
| RSS | feedparser + rsshub.app (Facebook) |
| Database | SQLite (`backend/portfolio.db`) |
| Notes | Obsidian Vault on Google Drive (G:) |
| Thailand data | Bank of Thailand (BOT) API |
| Thailand capital market | SEC Thailand Open API (api.sec.or.th) |
| Options Greeks | Black-Scholes + Gram-Charlier (backend/greeks.py) |

---

## Environment Variables

### Python backend (`backend/.env`)
```
CLIPPINGS_DIR / THESES_DIR / SOURCES_DIR / OBSIDIAN_WIKI_DIR
OLLAMA_URL          — default http://localhost:11434
RSSHUB_URL          — default https://rsshub.app
FACEBOOK_ACCESS_TOKEN
FRED_API_KEY        — macro + crisis indicators
ALPHA_VANTAGE_API_KEY
ANTHROPIC_API_KEY   — Claude API for portfolio AI
BINANCE_API_KEY     — order footprint (crypto)
BOT_API_TOKEN       — BOT Bond Auction
BOT_IR_TOKEN        — BOT Interest Rates
BOT_FX_TOKEN        — BOT Exchange Rates
BOT_STATS_TOKEN     — BOT Statistics
PORTFOLIO_DB        — default portfolio.db

# Portfolio Cloud Sync (PC ↔ MacOS via Google Drive) — backend/sync/
SYNC_ENABLED        — "true" to activate (default off)
SYNC_DIR            — shared cloud folder, e.g. G:\My Drive\Investment Portfolio (Win) / /Users/you/Google Drive/Investment Portfolio (Mac)
                      ⚠️ NO quotes — a shell-exported value keeps them literally and the path never resolves (stripped since 2026-08-11)
SYNC_DEVICE_ID      — blank → auto from hostname
SYNC_PUSH_INTERVAL  — background push cadence sec (default 60)
SYNC_PULL_INTERVAL  — manifest peer-change check sec (default 20) → auto-pull
SYNC_PUSH_DEBOUNCE  — sec to coalesce writes before pushing (default 2)

# ATM IV snapshot recorder — backend/iv_scheduler.py (feeds the SD heatmap)
IV_SNAPSHOT_INTERVAL — pass cadence sec (default 10800 = 3h; 0 disables entirely).
                       Sub-daily on purpose: a pass is free once the day is covered,
                       and several chances a day is what lets the series survive a
                       machine that is only on for part of it.
IV_SNAPSHOT_SYMBOLS  — comma list overriding the universe. Default = pinned_assets
                       ∪ symbols that already have iv_snapshots rows (a series must
                       not stop just because a symbol left the watchlist — the gap
                       cannot be back-filled).

# SEC Thailand — OLD portal (expires 2026-06-30)
SEC_COMMON_PRIMARY / SEC_FUND_FACTSHEET_PRIMARY / SEC_FUND_DAILY_PRIMARY
SEC_BOND_PRIMARY (dead) / SEC_DIGITAL_ASSET_PRIMARY / SEC_ONE_REPORT_PRIMARY

# SEC Thailand — NEW portal (secopendata.sec.or.th)
SEC2_API_KEY        — single key: Fund v2 + Bond v2 + One Report v1
```

### Next.js (`.env.local`)
```
PYTHON_API_URL=http://localhost:9317
ALPHA_VANTAGE_API_KEY
OPENAI_API_KEY      — optional
```

---

## Backend Architecture — Modular Routers

`main.py` = thin app init + CORS + router mounter. All logic in `backend/routers/`.

| Router file | Prefix | Source |
|-------------|--------|--------|
| `market.py` | `/api/market-data`, `/api/heatmap` | yfinance |
| `stock.py` | `/api/stock/*` | yfinance |
| `dcf.py` | `/api/dcf/*` (adaptive valuation + sensitivity + audit lineage) | yfinance + `analytics/dcf.py` |
| `options.py` | `/api/options/*`, positions + Greeks + `POST smile-fit` | yfinance + greeks.py + SciPy Raw SVI |
| `pins.py` | `/api/pins/*` (groups, assets, tags CRUD) | SQLite |
| `clippings.py` | `/api/clippings/*` | filesystem + Ollama |
| `news.py` | `/api/news/facebook`, `/api/news/feed` | RSSHub / Graph API + yfinance + RSS |
| `news_watchlist.py` | `/api/news/watchlist`, `/api/news/sources` | 7 free news sources + sector DB + Polymarket pool |
| `polymarket_stock.py` | `/api/polymarket/stock/{symbol}`, `/api/polymarket/stocks` | Gamma `/public-search` + `/events` (single-name price ladders) |
| `company_filings.py` | `/api/company/filings|outlook|xbrl/{symbol}` | SEC EDGAR (submissions + 8-K EX-99.1 + XBRL companyconcept) — US only |
| `social.py` | `/api/social/feed` | RSSHub / Graph API |
| `macro.py` | `/api/macro` | FRED + Alpha Vantage (2-layer cache). Read in-process by `/api/tail-risk/macro-context`; `next_fomc` from `event_calendar.py` |
| `crisis.py` | `/api/crisis` | FRED |
| `sovereign.py` | `/api/sovereign/*` | World Bank |
| `portfolio.py` | `/api/portfolio/*` (research — thesis from DB, transactions, backtest) | filesystem + SQLite |
| `portfolio_v2.py` | `/api/v2/portfolio/*` (accounts, trades CRUD, open-positions, sell, dividends, import) | SQLite |
| `risk.py` | `/api/v2/portfolio/risk/*` (VaR/CVaR/Parity/Stress/Position-size) | Ledoit-Wolf |
| `backtest_v2.py` | `/api/v2/portfolio/backtest/*` (equity, holdings-timeline, distribution) | SQLite trades + yfinance |
| `fx.py` | `/api/fx/*` | yfinance |
| `rates.py` | `/api/rates/curve` (UST 11 tenors + JGB 15 tenors, tick-row shape) | FRED daily + MOF CSV |
| `global_yields.py` | `/api/macro/global-yields` (was MACRO YIELD tab — no UI consumer since 2026-09-17) | FRED (US daily + OECD monthly) |
| `crypto.py` | `/api/crypto/*` | yfinance |
| `etf.py` | `/api/etf/{symbol}` | yfinance |
| `footprint.py` | `/api/crypto/footprint` | Binance aggTrades |
| `central_banks.py` | `/api/central-banks/*` | SDMX/REST (no key) |
| `polymarket.py` | `/api/polymarket/*` (signals, search, MCP endpoint) | Gamma API |
| `bot.py` | `/api/bot/*` (auctions, rates, fx, statistics) | BOT API |
| `sectors.py` | `/api/sectors/*` (classification, search, override) | Wikipedia + yfinance + SQLite |
| `screener.py` | `/api/screener/sp500*` (by sector) | yfinance |
| `config_router.py` | `/api/config/symbols/*` (symbol_lists CRUD) | SQLite |
| `circuit_breaker.py` | `/api/circuit-breaker/{check,market,margin}` | yfinance |
| `listing_gate.py` | `/api/listing-gate/screen` (IPO quality gate: hard filters + weighted score) | yfinance |
| `sec.py` | `/api/sec/*` (legacy, expires 2026-06-30) | api.sec.or.th (old portal) |
| `sec_v2.py` | `/api/sec/v2/*` (52 routes: Bond v2 + Fund v2 + One Report v1) | api.sec.or.th (new portal) |
| `allocation.py` | `/api/allocation/*` (signal, layers, history) | FRED + ETF data |
| `country_rotation.py` | `/api/country-rotation/*` (scores, history, universe) | yfinance + World Bank |
| `sector.py` (sector selection) | `/api/sector/*` (signal, factors, history) | FRED + yfinance |
| `regime.py` | `/api/regime/correlation` | yfinance (5min cache) |
| `market_state.py` | `/api/market-state/{sym}` (dashboard, 1h) · `/{sym}/validation` (walk-forward, 24h) | yfinance + hmmlearn |
| `rotation.py` | `/api/rotation/table` (theme/sector momentum + RRG quadrant vs SPY) | yfinance batch (15min cache) |
| `fear_greed.py` | `/api/fear-greed`, `/api/fear-greed/history` | yfinance ^VIX/SPY/TLT/HYG/LQD/RSP (5min/60min cache) |
| `alerts.py` | `/api/alerts` | regime + SQLite (60s cache) |
| `alert_rules.py` | `/api/alerts/rules*` (CRUD, preview, scan, events) | SQLite + boolean-AST engine |
| `ticker.py` | `/api/ticker` (crawl-strip items + alerts) | reuses existing caches, TTL 60s |
| `tail_risk.py` | `/api/tail-risk/{signals,vix-term}` | **v2 (2026-08-16)**: `vol_indices.py` (CBOE CSV) + yfinance SPY/AGG/DCC + in-process calls to crisis/fear_greed/ticker. 6 risk dimensions, tri-state signals |
| `analytics.py` | `/api/analytics/{corr,beta,vol,return,drawdown,sharpe,zscore,rsi,compare,rank}` | yfinance + TTLCache 300s |
| `paper_trading.py` | `/api/paper/*` (accounts, orders, positions, fills, equity-curve) | yfinance + SQLite |
| `providers.py` | `/api/providers` (list+health), `/api/providers/active` (switch), `/api/providers/auto-failover` | quote registry |
| `zettel.py` | `/api/v2/zettel/*` (Zettelkasten: atomic notes + typed edges + sources + FTS5 trigram + Obsidian export) | SQLite + `OBSIDIAN_WIKI_DIR` |
| `graphs.py` | `/api/v2/graphs/*` (rendered analysis pages: index in SQLite, HTML on disk, `/render` under a strict CSP) | SQLite + `GRAPHS_DIR` |
| `series.py` | `/api/v2/series/*` (generic indicator series: any published number over time that is not an instrument; collectors in `series_sources/`, first one = dramexchange DRAM/NAND) | SQLite |
| `theses.py` | `/api/v2/theses/*` (CRUD + append-only event log + trade links + md import/export; `X-Thesis-Actor` → `payload.actor`) | SQLite + `THESES_DIR` |
| `sync_router.py` | `/api/sync/status`, `/api/sync/pull`, `/api/sync/push` | cloud-sync (`backend/sync/`) |
| `watchlist_signals.py` | `/api/watchlist/signals` (batch daily technical scan) | yfinance batch (TTLCache 900s) |

### Quote Provider Registry (live-quote path)
`market_data` singleton = `FailoverSource` facade. Quote path (`download_quotes`/`get_fast_info`/`download`/`get_history`) → `ProviderRegistry` (manual switch + auto-failover, capability-scoped). Batch quote/download use **gap-fill merge** — per-symbol routing across providers so mixed portfolios (TH `.BK` + US) get priced by whichever provider supports each symbol. Heavy methods (options/financials/etf/news) → primary yfinance. Providers: `YFQuoteProvider` (default) → `StooqQuoteProvider` (keyless fallback). Add provider: implement `QuoteProvider` + `registry.register()` in `sources/__init__.py`. Env: `QUOTE_PROVIDER_DEFAULT`, `QUOTE_AUTO_FAILOVER`. FE seam: `useLiveQuery` (cadence) + header `ProviderSwitch`. Scaling roadmap: `plans/scaling/`.

### SQLite Database Schema (`portfolio.db`)
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
cash_adjustments    (id, account_id, date, amount, currency, target_balance, derived_before, note, created_at)
-- 2026-09-16: cash EDIT offsets. cash_base = derived + Σamount. Not capital (no XIRR/invested effect).
--   Synced (SYNC_TABLES + MONEY_TABLES). Deleted with its account.
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

## Frontend Views — 7 views (post-CRYP/FX removal 2026-08-01)

| Key | Button | View | Component |
|-----|--------|------|-----------|
| `1` | MKT | Market View (default) | `market-view.tsx` — watchlist + chart + Regime Detection + TICK DATA board (7 collapsible sections: AMERICAS/EMEA/ASIA PACIFIC + RATES·US + RATES·JP + VOLATILITY + FX) |
| `2` | NEWS | News | `news-view.tsx` → barrel for `views/news/` — WATCHLIST (default, sector rail + per-ticker stream; HEADLINES/RATE STRESS/DCF/REGIME panels) / NEWSFEED / SOCIAL tabs + Polymarket right column |
| `3` | GMOV | Market Movers | `market-movers-view.tsx` — indices table + heatmap treemap |
| `4` | CLIP | Clippings + AI | `clippings-view.tsx` |
| `T` | TAIL | Tail Risk Monitor | `tail-risk-view.tsx` — 6 risk dimensions + **MACRO CONTEXT** (not in composite, 2026-09-17): event strip FOMC/SEP/CPI/NFP/PCE/GDP, EVENT tag on VIX signals inside ±1 bday window, Fed/curve/regime/latest prints panel, event markers on 90D chart |
| `6` | CRDT | Credit / Stress | `credit-view.tsx` — 4 tabs: overview, spreads, stress, consumer |
| `P` | PORT | Portfolio | `portfolio-view.tsx` (barrel → `portfolio/`) — 5 top-level tabs: PORTFOLIO (sub: POSITIONS\|OPTIONS\|TRADES\|CASH\|ENTRY=manual trade form; POSITIONS + OPTIONS show `% PORT` of NAV incl. cash, options also `Δ % NAV`) · ANALYTICS (sub: P&L incl. Total Return per port + CAPM β/α table\|BACKTEST) · RISK (standalone) · TOOLS (sub: THESES — sub-tabs THESIS\|NOTES\|KB (Zettelkasten: notes·conflicts·graph)\|HISTORY\|LINKED TRADES\|AI\|IMPORT) · PAPER (sub: DASHBOARD\|TRADE\|POSITIONS\|OPTIONS\|HISTORY) |

Removed: MACRO `5` (2026-09-17 — US macro + FOMC calendar folded into TAIL as context; COUNTRY + SIGNALS tabs deleted with it, backend routers kept; key `5` free), GVOL (fake data), EQTY (dup), RMI (2026-05-24), CRYP `C` + FX `E` (2026-08-01 — FX merged into the MKT TICK DATA board; crypto via global search `BTC-USD` → stock-view). Backend `crypto.py`/`fx.py` routers kept: `/api/crypto/footprint` feeds the Order Footprint indicator. Keys `C`/`E` are free. Stock analysis (9 tabs) accessible via global search / heatmap click.

---

## Known Issues / Limitations

1. **RSSHub + Facebook**: Public instance may be rate-limited.
2. **FRED API key**: Without it, macro and crisis views fail silently.
3. **Ollama models**: llama3.1:8b or gemma2:9b recommended for Thai translation.
4. **Polymarket**: Gamma API ignores `tag_slug`/`q`/`order` params — all filtering client-side on 3,000-market pool. Cold start ~15s. Δ24h null until backend runs ≥24h.
5. **BOT FX (Stat-ExchangeRate)**: Returns 403 — subscription must be activated in BOT portal.
6. **BOT max date range**: All time-series endpoints have 31-day max per request.
7. **SEC Fund legacy expiry**: `/FundFactsheet/fund/*` and `/FundDailyInfo/*` expire **2026-06-30** — migrate to `/api/sec/v2/fund/*`.
8. **SEC Bond v1 dead**: Shutdown 2026-04-30. Use `/api/sec/v2/bond/*`.
9. **SEC Digital Asset**: Under maintenance — paths registered, API not responding.
10. **SEC One Report**: `report_year` must be Gregorian (2023 not 2566); `language` must be `T`/`E` not `1`/`2`. Returns 204 when no data for section.
11. **Options DataFreshness**: Yahoo Finance ~15min delay — yellow `⏱` badge shown on all delayed values.
12. **Options Greeks Q3 bug**: Fixed 2026-06-03 — was using d₂ instead of d₁, overestimating ~50-100%.
13. **`npm run dev:all` Ctrl+C traceback**: Fixed 2026-08-01 — cosmetic only (every process always exited 0 and freed its port). `uvicorn --reload`'s supervisor SIGTERMs the worker mid-shutdown; `main.py` now filters that one benign `KeyboardInterrupt`/`CancelledError` record. Details in `reference/gotchas.md`.
14. **Pane indicator heights don't persist** 🔴 open — dragging an RSI/MACD pane is lost on reload and panes can collapse to 0px on rebuild. Root-caused 2026-08-01 (lightweight-charts v5 converts `setHeight` px → stretch factor against a stale total). Plan: `plans/pane-height-persistence-fix.md`.
15. **TAIL Layer-A z-score has a units mismatch** 🟡 open — `layer_a_bearish` compares a **20-day cumulative** SPY−AGG return against the mean/std of **daily** SPY−AGG returns, inflating |z| by roughly √20 (live reading 6.39). Threshold −0.5 is therefore far looser than it looks, which matches the backtest verdict SENSITIVE (fires 49% of days IS). Left as-is deliberately in tail-risk v2: changing the formula would invalidate the 2026-06-07 backtest it was measured with. Fix = rescale + re-backtest together.
16. **Volume Profile unavailable on rates/FX/VIX**: `^TNX`, `*=X`, `^VIX`, `^OVX` report `volume: 0` from Yahoo (calculated indices and yields have nothing trading behind them), so the VP button renders disabled with a tooltip. Cash indices (`^GSPC`/`^DJI`) DO carry volume — the gate is data-driven, not symbol-class-driven.

---

## What Could Be Built Next

- [x] **Neocloud three-year accounting review** — done 2026-09-19; รายงานไทย 34 โปรไฟล์พร้อมช่องว่างหลักฐานและ MCP readback (`plans/completed/neocloud-three-year-accounting-review.md`)

- [x] **Zettelkasten Knowledge Base (THESES)** — คลังความรู้อะตอมที่ใช้ซ้ำข้าม thesis: `zettel`/`zettel_edges`/`zettel_sources`/`zettel_refs` + FTS5, edge ชนิด SUPPORTS/CONTRADICTS/REFINES/SUPERSEDES, พาเนล OPEN CONFLICTS, MCP 11 tools, export ทางเดียว → Obsidian `[[wikilink]]` — done 2026-09-18 (`plans/completed/zettelkasten-knowledge-base.md`)
- [ ] **THESES readability + GRAPHS format + graph sync** — 7/7 steps coded 2026-09-19 (counts บนแท็บมากับ payload, markdown renderer เต็ม, rail พับได้, ปุ่ม READ โหมดเอกสาร, GRAPHS render shell + เทมเพลต + lint, `graphs` เข้า SYNC_TABLES + ไฟล์ HTML ไป Drive); เหลือฝังไฟล์ฟอนต์ Laksaman (`plans/theses-readability-and-sync.md`)
- [x] **Indicator Series Board** — done 2026-09-19 — generic series store (`series_meta`/`series_points`) + collector registry `series_sources/`; dramexchange = ชุดแรก (31 series: DRAM/NAND/module/memcard spot + DRAM/NAND/SSD contract), แท็บ DATA ใน NEWS, scheduler วันละจุด, เข้า cloud sync (`plans/completed/indicator-series-board.md`)
- [ ] **Mobile Responsive** — shell bottom nav + MKT single-panel switcher first; PORT, NEWS, rest follow (`plans/mobile-responsive.md`)

- [x] **TAIL Macro Context** — FOMC/CPI/NFP/PCE/GDP calendar + Fed/curve/regime context in TAIL; MACRO view removed; FOMC off-by-one fixed — done 2026-09-17 (`plans/completed/tail-macro-context.md`)

- [x] **Windows NEWS API recovery** — done 2026-09-13 — restarted stale Windows backend; DCF/REGIME/SVI live HTTP checks OK, 61 tests passed (`plans/completed/windows-news-api-reload.md`)

- [x] **MKT IV Open Interest** — done 2026-09-13 — optional Call/Put OI bars on IV/SVI, separate contracts axis, one selected actual expiry, range totals/P-C and source availability (`plans/completed/mkt-iv-open-interest.md`)

- [x] **MKT SVI Fit and Tenors** — done 2026-09-13 — optional Raw SVI, observed points/RMSE/parameters, actual expiries near1/3/5/7/9 months and Call/Put/OTM selection (`plans/completed/mkt-svi-fit-tenors.md`)

- [x] **MKT IV Smile** — done 2026-09-13 — Yahoo chain smile in REGIME IV tab, numeric K vs IV%, follows main chart symbol with expiry and quote filters (`plans/completed/mkt-iv-smile.md`)

- [x] **ATR Accumulation Pane** — done 2026-09-13 — optional Wilder ATR/ATR% pane with low-volatility + rising EMA green/red filter and persistent settings (`plans/completed/atr-accumulation-pane.md`)

- [x] **Bollinger Sharpe Fit** — done 2026-09-13 — optional Breakout %B grid search (209 n/k pairs), max net per-bar Sharpe, separate holdout and preserved Manual settings (`plans/completed/bollinger-sharpe-fit.md`)

### Urgent
- [ ] **Migrate Fund legacy → v2** before **2026-06-30** (SEC old portal closes)
- [ ] Seed sector data: POST /api/sectors/fetch for TH/KR/HK/EU/US

### Features
- [x] **Adaptive DCF Valuation Lab** — done 2026-09-13 — multi-model valuation engine (3-stage FCFF default; growth/FCFE/excess-return/AFFO/normalized-cycle adapters), quant assumptions+sensitivity+audit UI, shared NEWS/stock panel (`plans/completed/dcf-valuation-lab.md`)
- [x] **BBW Squeeze Hazard Study** — done 2026-09-09 — ตอบว่า BB Width ต้องบีบเท่าไหร่ถึงยก P(volatility expansion ภายใน h วัน) เหนือ base rate และโมเดล rank+duration+RV-term ชนะกฎ `BBW ≤ 1.05×min125` เดิมหรือไม่; S&P500 500 ตัว, purged walk-forward, holdout แตะครั้งเดียว (`plans/completed/bbw-squeeze-hazard.md`, ผล: `D:/Agents/Claude/backtest-idea/05_bbw_squeeze/results/2026-09-09/report.md`)
- [x] **Quant Market State (per-symbol REGIME)** — done 2026-09-13 — latent-state framework ต่อหุ้น: OHLCV → feature + redundancy check → Gaussian HMM → `MarketState_t = [RegimeProbability, Trend, Momentum, Volatility]` + ประโยคสรุป + strategy compatibility ที่คำนวณจากสถิติ conditional ของ symbol เอง; panel REGIME ใน NEWS (ข้าง RATE STRESS) + tab ใน stock-view; แยก market interpretation ออกจาก trading decision และแยก dashboard mode (fit in-sample, label causal) ออกจาก validation mode (walk-forward) (`plans/completed/market-state-regime.md`)
- [x] **Volume Z-Score + Volume Event Classifier** — done 2026-09-13 — volume ดิบไม่ให้ข้อมูลเพราะเป็น level ที่ไม่มีสเกลอ้างอิงและไม่มีผลลัพธ์ติดมา; แก้ baseline RVOL จาก mean → median/MAD บน ln(V) (spike เดิมไม่ดัน baseline ค้าง 20 แท่ง) + cumulative-session mode แก้แท่งที่ยังเปิดอ่านเป็น quiet + classifier 6 event types (climax/absorption/vacuum/breakout/noDemand/dryUp) เป็น chip บน price pane + ตาราง event ที่มีคอลัมน์ forward return (`plans/completed/volume-zscore-events.md`)
- [ ] **Corporate Interest Rate Stress Testing (CIRST)** — วัดผลกระทบ shock ดอกเบี้ยระดับบริษัท (QERM): repricing ladder + fixed/float จาก XBRL → Earnings-at-Risk + breaking-point bp → Merton PD → spread → ΔWACC/ΔEV/equity duration → ES + Euler contribution → IR-Stress Score 0–100; tab ใหม่ใน stock-view + screener ใน CRDT (`plans/corporate-ir-stress-testing.md`)
- [ ] **CIRST Validation Harness** — backtest 5 ปี point-in-time (20 as-of, XBRL first-filed revision + FRED daily curve), เทียบ predicted vs realized 5 tier, บังคับชนะ null models (persist / full-reprice / debt×Δy) ด้วย Diebold-Mariano ก่อนเปิด Score; ได้ implied float-share ต่อบริษัทเป็นผลพลอยได้ (`plans/cirst-validation-harness.md`)
- [ ] **CIRST RATE STRESS tab** — แท็บที่ 13 ใน stock-view (เข้าจาก NEWS → คลิกหุ้น) 5 sub-tab: EXPOSURE (ladder+refi gap) · SCENARIO (ตาราง ΔI bound / ICR / DDM vs empirical) · DURATION (Gordon inverted + θ) · HISTORY (20 as-of ย้อน 5 ปี + error summary + attribution) · DIAGNOSTICS; 4 แท็บแรก ship ได้ทันที HISTORY รอ harness (`plans/cirst-stock-rate-tab.md`)
- [x] **Dynamic Chart History** — ซูมออกจนสุดข้อมูลแล้วกราฟโหลดช่วงถัดไปเอง (3M→YTD→1Y→5Y→MAX) โดยไม่เสียมุมมอง; lib ของเราเอง `components/bloomberg/chartkit/` (pure core + engine adapter) เตรียมไว้เขียน candle engine เอง — done 2026-08-25 (`plans/completed/dynamic-chart-history.md`)
- [ ] **Floating Chart Windows** — เปิดกราฟหลายตัวพร้อมกันเป็น popup ลอยอิสระ (ลาก/ย่อขยาย/ย่อเก็บ/z-order, cap 10, persist localStorage, ลอยข้ามทุก view) — เฟส 1 done 2026-08-24; เหลือเฟส 2: TILE + edge snap, indicator แยกต่อหน้าต่าง (`plans/floating-chart-windows.md`)
- [ ] **IV SD Heatmap** — BS lognormal σ-band pane (5 buckets −2σ…+2σ) จาก `σ_mid=(IV_call+IV_put)/2`; 2 โหมด occupancy/cheapness, ตาราง `iv_snapshots` สะสม IV เอง, `/api/options/{sym}/sd-bands`; ยัง verify pixel ไม่ได้ (`plans/iv-sd-heatmap.md`)
- [x] **TAIL Risk Monitor v2** — CBOE vol data (VIX/VIX9D/VIX3M/VIX6M/VVIX/SKEW/OVX/GVZ/VXN) แทน yfinance ที่ค้าง 28 วัน, tri-state signals, 6 risk dimensions, composite นับมิติไม่ใช่นับ signal — done 2026-08-16 (`plans/completed/tail-risk-v2.md`)
- [x] **Company OUTLOOK (SEC EDGAR)** — guidance ที่บริษัทยื่นใน 8-K EX-99.1 + คำพูด CEO + MD&A forward-looking + งบ as-reported จาก XBRL; แท็บ OUTLOOK ใน stock-view + แถบใน NEWS — done 2026-08-15 (`plans/completed/company-outlook-edgar.md`)
- [x] **Thesis Notes** — sub-tab NOTES ในหน้า THESES: standing scenario/risk/catalyst/question ที่แก้ในที่ได้ (kind, impact bull/bear, likelihood×severity, watch date, pin, resolve/reopen) + `thesis_notes` table + sync + `/notes/due` cross-thesis feed — done 2026-08-31 (`plans/completed/thesis-notes.md`)
- [x] **Polymarket stock price ladders** — `/api/polymarket/stock/{sym}` แปลง touch ladder + "close above" CDF เป็น P(up)/skew/implied range; panel ใน NEWS + คอลัมน์ PM ใน MKT watchlist — done 2026-08-15 (`plans/completed/polymarket-stock-ladder.md`)
- [x] **NEWS watchlist redesign** — ข่าวรายหุ้นจาก 7 แหล่ง (Yahoo/yfinance/Google/Bing/Seeking Alpha/Nasdaq/SEC), แบ่งกลุ่มตาม SECTOR อัตโนมัติ, ticker badge ทุกหัวข้อ, Polymarket จับคู่รายหุ้น — done 2026-08-15 (`plans/completed/news-watchlist-redesign.md`)
- [x] **Analytics Cash Card** — CASH tile + MARKET VALUE split (excl./incl. idle cash) in ANALYTICS Capital Breakdown — done 2026-07-14 (`plans/completed/analytics-cash-card.md`)
- [x] **Cash Transfer** — linked-pair TRANSFER entry_type in `cash_ledger` so inter-account cash moves (e.g. FINANSIA→DIME) fix per-account `invested_capital` bookkeeping with atomic insert + cascade delete — done 2026-07-14 (`plans/completed/cash-transfer-feature.md`)
- [ ] **System Audit 2026-07 — Bug Fixes & Refactor** — 9 fix items + 6 refactor items; F01 done 2026-07-03, F06 done 2026-07-04 (via port-redesign resolver); เหลือ F02 AVCO drift 🔴, F03 async blocking 🔴, F04/F05/F07/F08/F09 + R01–R06 (`plans/system-audit-2026-07/README.md`)
- [x] **Portfolio Cloud Sync** — PC↔Mac sync via Google Drive JSON snapshots, startup pull, row-LWW merge + tombstones, no login done 2026-06-26 (`plans/completed/portfolio-cloud-sync.md`)
- [x] **Option Payoff Simulator** — done 2026-09-10: `backend/analytics/option_payoff.py` (payoff at expiry = เลขคณิต, T+0 = BS ผ่าน greeks.py, POP = lognormal risk-neutral) + `POST /api/options/payoff`; พรีวิวสดในฟอร์ม ADD (expiry คำนวณที่ client, T+0/POP debounce 400ms) + ปุ่ม PAYOFF ในแถว lot รวมทุก lot ของ underlying; breakeven จาก sign change + bisection, max P/L จาก slope ที่ปลายไม่ใช่ขอบกริด (`plans/completed/option-payoff-simulator.md`)
- [x] **Audit log for every money edit** — done 2026-09-16: trigger-written `audit_events` on trades/options/cash/cash_adjustments/dividends/avg-cost/accounts/targets; `GET /api/v2/portfolio/audit-events`; PORT → TOOLS → AUDIT tab. Evidence: `backend/tests/test_audit_events.py` 6 pass, full backend suite 699 pass, 30 triggers live on real DB
- [x] **Cash Reconcile (EDIT) + NAV incl. cash** — done 2026-09-16: `cash_adjustments` offsets + `POST /cash/reconcile` / `GET /cash/adjustments` / `DELETE /cash/adjustments/{id}`; CASH chip always visible in SummaryBar, click → `CashReconcileModal`; `/nav-history` adds `cash_balance`/`nav_with_cash` so sells no longer dent PORTFOLIO VALUE. Evidence: `backend/tests/test_cash_reconcile.py` 4 pass + live API check
- [x] **Option Edit + Portfolio Cash** — done 2026-09-10: `cash_base`/`open_cost_base` คำนวณที่ `/summary` (invested + realized ทั้ง equity และ option + dividends − open cost ทั้งสองประเภท) แสดงที่ SummaryBar + CASH tab + ANALYTICS ทั้งสามอ่านตัวเลขเดียวกัน — เป็นค่าประมาณ ไม่โพสต์ `cash_ledger`; `PATCH /api/options/trades/{id}` แก้ trade ที่กรอกผิด + re-match realized + `trade_audit_log` + EDIT modal (`plans/completed/option-edit-and-portfolio-cash.md`)
- [x] **Option Schema Normalization** — done 2026-09-10: `option_contracts` (instrument, dedupe ด้วย occ_symbol) + `option_trades` (execution, immutable, ทิศทางอยู่ที่ action+side) + `option_trade_greeks` (5 greeks + spot/IV ณ จุดเทรด, 1:1) + `option_trade_matches` (FIFO partial close, realized materialized); lot = OPEN trade ที่ยัง match ไม่ครบ → `v_option_open_lots` ไม่ใช่ตาราง; หมดอายุ/ใช้สิทธิ์ = CLOSE trade; migrate + DROP `option_positions` (`plans/completed/option-schema-normalization.md`)
- [x] **Option Greeks + PnL Attribution** — done 2026-09-09: PORT · OPTIONS แสดง Δ/Γ/Θ ต่อสัญญา + dollar greeks (DELTA/GAMMA-1%/THETA-day/VEGA-1pp) หน่วย USD, ตาราง derivatives เป็น USD ล้วน; ตาราง `option_greeks_snapshots` เก็บ spot/IV/greeks รายวัน (accumulate เท่านั้น back-fill ไม่ได้); `/api/v2/portfolio/options/attribution` แยก Δ/Γ/Θ/ν/residual ด้วย greeks ต้นงวด; ANALYTICS section DERIVATIVES ทั้งพอร์ต + ราย option + stacked bar รายวัน (`plans/completed/option-greeks-and-attribution.md`)
- [x] **Options in Portfolio** — done 2026-09-09: `backend/portfolio_options.py` เป็นจุดเดียวที่ ตีราคา option lot; premium MV เข้า NAV/unrealized/realized ของ `/summary` `/open-positions` `/returns` `/nav-history` `/analytics`, delta-adjusted notional ถ่วงน้ำหนัก `/allocation-detail`; schema +`exit_price`/`exit_date`/`currency`/`multiplier`/`sector`; close endpoint รับราคาปิด; รวม fix greeks spot bug 🔴 (`plans/completed/options-in-portfolio.md`)
- [ ] **Port Redesign** — symbol resolver (resolve-at-write), sub_portfolios table จริง, currency module, ลบ `_get_yf_symbol`/ปิด F06 (`plans/port-redesign.md`)
- [x] **Multi-Currency Sub-Portfolio** — done 2026-07-14: `trades.currency` เป็น instrument ccy authoritative, rollup ต่อ trade, mixed-ccy account, realized trading P&L ใช้ exit-date FX (ไม่รวม principal FX attribution), แสดง `ECON` FX-inclusive attribution แยก, live MTM และ daily `fx_rates` (`plans/completed/multi-currency-portfolio.md`)
- [ ] **VP Indicator Upgrade** — แก้ session timezone bug (B1 🔴) + visible-range VP + delta profile + naked POC + HVN/LVN + config UI; audit: `reports/vp-indicator-risk-report.md` (`plans/vp-indicator-upgrade.md`)
- [ ] **P/E History Pane + EPS Surprise Labels** — endpoint `/api/stock/pe-history` (TTM EPS × weekly close, 13–20yr), `PEPane.tsx` recharts sub-pane + valuation percentile bands, earnings marker สี beat/miss; code-complete, backend HTTP verified, frontend visual pending (`plans/pe-earnings-visualization.md`)
- [x] **TICK DATA Consolidation** done 2026-08-01 — เพิ่ม RATES·US (UST 11 tenor, FRED daily) + RATES·JP (JGB 1Y–40Y, MOF CSV) + FX เข้า TICK DATA panel ใน MKT, section ยุบได้; ลบ CRYP [C] + FX [E] views (backend crypto/fx router คงไว้) (`plans/completed/tickdata-rates-fx-consolidation.md`)
- [ ] **Pane Height Persistence Fix** — pane indicator ยุบเป็น 0 ตอน rebuild (lw v5 setHeight→stretch แปลงบนฐานว่าง) + drag จับเฉพาะ teardown ทำให้ reload แล้วหาย + wrapper h=0; แผนแก้ 3 ชั้น: defer setHeight 2-frame, capturePaneDrags 4 จุดเรียก, ซ่อม height chain (`plans/pane-height-persistence-fix.md`)
- [ ] **RSI Scale Modes** — คลิกขวาบน RSI pane เลือกสเกล 6 แบบ (standard / autofit / price projection / distance % / distance in avg moves / log RS) + modal ตั้งค่า; Step 1–2 done 2026-08-05 (`calcRSIState` export Wilder state + แก้ seed divergence 99.0099→100, `rsiInverse.ts`), Step 1–5 done 2026-08-05 — คลิกขวาบน RSI pane → เมนู 6 โหมด + เส้น projection บน price pane (Step 6 modal ยกเลิก ยุบลง context menu แทน) ยังไม่ verify ตัวเลขบนแกนด้วยตาเพราะ ModularChart ไม่วาด price series ในโปรไฟล์ที่ทดสอบ; audit: `sessions/reports/rsi-seed-divergence-risk-report.md` (`plans/rsi-scale-modes.md`)
- [x] **Thesis System (DB) + Allocation Basis** — theses/thesis_events/thesis_links ใน SQLite + sync ผ่าน Google Drive, edit/soft-delete/restore, event log เก็บ diff, import/export .md; ALLOCATION (OPEN) ใหม่: cost vs market value, growth%, drift, share of gain, rebalance sizing (หุ้น + กำไรที่จะรับรู้) — done 2026-08-15 (`plans/completed/thesis-db-and-allocation-basis.md`)
- [ ] Polymarket: dashboard view in frontend
- [ ] BOT: frontend view for Bond Auction + yield trend chart
- [ ] BOT: activate Stat-ExchangeRate → add THB FX view
- [ ] Central banks: comparison chart across banks
- [ ] Clippings: auto-reload (file watcher)
- [x] **Alert Ticker** — Bloomberg-style scrolling bar: regime change (15-min event) done 2026-06-05 (`plans/completed/alert-ticker.md`); the stop-loss breach pill was removed with the stop engine 2026-09-15
- [x] **Fear & Greed Index** — chart pane indicator + FEAR-GREED searchable symbol + F&G/VIX prominent pills in alert ticker done 2026-06-06 (`plans/completed/fear-greed-index.md`)
- [ ] Alerts: price alert when stock hits threshold (price target, separate from stop loss)
- [ ] Sovereign: map visualization
- [x] **Analysis Graphs** — หน้าวิเคราะห์ HTML ที่ agent สร้างผ่าน MCP `graph_create` เก็บใน `research/graphs/<slug>/` + ตาราง `graphs`, เปิดจาก PORT → TOOLS → THESES → GRAPHS หรือลิงก์ `/api/v2/graphs/<slug>/render`; render ใต้ CSP เข้ม + iframe sandbox ไม่มี allow-same-origin — done 2026-09-18 (`plans/completed/analysis-graphs.md`)
- [ ] Bloomberg CLI + MCP server (`plans/bloomberg-cli-mcp.md`) — **MCP part started 2026-09-18**: `backend/mcp_server.py` (theses workspace + portfolio/market research, 15 tools; Claude Code via `.mcp.json`, Claude Desktop via `claude_desktop_config.json` — setup in `docs/mcp-server.md`); CLI still not built
- [x] PORT Analytics: Allocation stacked bar + Dividend M/Q/Y + currency fix (done 2026-06-05, `plans/completed/analytics-charts-enhancement.md`)
- [ ] SEC One Report: frontend view (data available 2021–2023)
- [x] Polymarket: Δ24h + MCP endpoint (2026-06-05)
- [x] Portfolio Risk System: VaR/CVaR/Stress/Parity/Sizing (2026-06-02)
- [x] Options: position tracking + BS+GC Greeks (2026-06-03)
- [x] Regime Detection panel in MKT view (2026-06-03)
- [x] **DCC v1+v3 live signals** — backtest IS/OOS/FWD, wired into tail ribbon + alert ticker (g13_dcc_v1, g14_dcc_hmm) done 2026-06-07
- [x] **Portfolio: Trade DELETE button** — confirm banner, irreversible delete done 2026-06-07
- [x] **Portfolio: Import + Edit modal bug fixes** — price_exit auto-sets win_loss W/L; symbol blur → sector auto-fill via `/api/stock/sector/{symbol}` done 2026-06-07
- [x] **Strategy Builder** — 19 templates (inc. Calendar/Diagonal multi-expiry), BS payoff, PoP/E[P&L]/Kelly ranking table done 2026-06-08 (`plans/completed/strategy-builder.md`)
- [x] **Paper Trading** — virtual accounts, market/limit/stop orders, execution engine, positions + P&L, equity curve done 2026-06-08 (`plans/paper-trading.md`)
