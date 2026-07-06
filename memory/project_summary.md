# Bloomberg Terminal — Project Summary

**Working directory:** `D:\Agents\Claude\bloomberg-terminal-main`
**Last updated:** 2026-06-08 (Paper Trading system, Strategy Builder)

> Slim core reference. Navigate via [memory/INDEX.md](INDEX.md).
> - [reference/api-endpoints.md](reference/api-endpoints.md) — all endpoints, caching table, Next.js proxy routes
> - [reference/frontend-structure.md](reference/frontend-structure.md) — component tree + exports + keyboard shortcuts
> - [reference/data-shapes.md](reference/data-shapes.md) — API response JSON shapes + TypeScript interfaces
> - [reference/architecture.md](reference/architecture.md) — stack, data flow, 26 routers, analytics folder, key files
> - [reference/gotchas.md](reference/gotchas.md) — error dict + anti-patterns + "Where is X?" + env var map

---

## How to Run (2 terminals)

```powershell
# Terminal 1 — Python backend
cd backend
# Set env vars in backend/.env (copy from .env.example)
python -m uvicorn main:app --port 8000 --reload

# Terminal 2 — Next.js frontend
npm run dev  # → http://localhost:3000
```

```powershell
# Tests
cd backend && python -m pytest tests/ -v   # 58 unit tests (Greeks, SEC)
npx tsc --noEmit                            # TypeScript check
```

---

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 14 App Router, React, TypeScript |
| State | Jotai (atoms) + TanStack React Query |
| Charts | Recharts + custom CandlestickChart |
| Styling | Tailwind CSS, bloombergColors theme |
| Backend | Python FastAPI (port 8000) — modular routers |
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
SYNC_DIR            — shared cloud folder, e.g. "G:\My Drive\Investment Portfolio" (Win) / "/Users/you/Google Drive/Investment Portfolio" (Mac)
SYNC_DEVICE_ID      — blank → auto from hostname
SYNC_PUSH_INTERVAL  — background push cadence sec (default 60)

# SEC Thailand — OLD portal (expires 2026-06-30)
SEC_COMMON_PRIMARY / SEC_FUND_FACTSHEET_PRIMARY / SEC_FUND_DAILY_PRIMARY
SEC_BOND_PRIMARY (dead) / SEC_DIGITAL_ASSET_PRIMARY / SEC_ONE_REPORT_PRIMARY

# SEC Thailand — NEW portal (secopendata.sec.or.th)
SEC2_API_KEY        — single key: Fund v2 + Bond v2 + One Report v1
```

### Next.js (`.env.local`)
```
PYTHON_API_URL=http://localhost:8000
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
| `options.py` | `/api/options/*`, positions + Greeks | yfinance + greeks.py |
| `pins.py` | `/api/pins/*` (groups, assets, tags CRUD) | SQLite |
| `clippings.py` | `/api/clippings/*` | filesystem + Ollama |
| `news.py` | `/api/news/facebook` | RSSHub / Graph API |
| `macro.py` | `/api/macro` | FRED + Alpha Vantage (2-layer cache) |
| `crisis.py` | `/api/crisis` | FRED |
| `sovereign.py` | `/api/sovereign/*` | World Bank |
| `portfolio.py` | `/api/portfolio/*` (theses, research, transactions, backtest) | filesystem + SQLite |
| `portfolio_v2.py` | `/api/v2/portfolio/*` (accounts, trades CRUD, open-positions, sell, dividends, import) | SQLite |
| `risk.py` | `/api/v2/portfolio/risk/*` (VaR/CVaR/Parity/Stress/Position-size) | Ledoit-Wolf |
| `fx.py` | `/api/fx/*` | yfinance |
| `crypto.py` | `/api/crypto/*` | yfinance |
| `etf.py` | `/api/etf/{symbol}` | yfinance |
| `footprint.py` | `/api/crypto/footprint` | Binance aggTrades |
| `central_banks.py` | `/api/central-banks/*` | SDMX/REST (no key) |
| `polymarket.py` | `/api/polymarket/*` (signals, search, MCP endpoint) | Gamma API |
| `bot.py` | `/api/bot/*` (auctions, rates, fx, statistics) | BOT API |
| `sectors.py` | `/api/sectors/*` (classification, search, override) | Wikipedia + yfinance + SQLite |
| `sec.py` | `/api/sec/*` (legacy, expires 2026-06-30) | api.sec.or.th (old portal) |
| `sec_v2.py` | `/api/sec/v2/*` (52 routes: Bond v2 + Fund v2 + One Report v1) | api.sec.or.th (new portal) |
| `allocation.py` | `/api/allocation/*` (signal, layers, history) | FRED + ETF data |
| `country_rotation.py` | `/api/country-rotation/*` (scores, history, universe) | yfinance + World Bank |
| `sector.py` (sector selection) | `/api/sector/*` (signal, factors, history) | FRED + yfinance |
| `regime.py` | `/api/regime/correlation` | yfinance (5min cache) |
| `rotation.py` | `/api/rotation/table` (theme/sector momentum + RRG quadrant vs SPY) | yfinance batch (15min cache) |
| `stoploss.py` | `/api/stoploss/{regime,atr,compute}` | yfinance (5min cache) |
| `fear_greed.py` | `/api/fear-greed`, `/api/fear-greed/history` | yfinance ^VIX/SPY/TLT/HYG/LQD/RSP (5min/60min cache) |
| `alerts.py` | `/api/alerts` | stoploss + regime + SQLite (60s cache) |
| `analytics.py` | `/api/analytics/{corr,beta,vol,return,drawdown,sharpe,zscore,rsi,compare,rank}` | yfinance + TTLCache 300s |
| `paper_trading.py` | `/api/paper/*` (accounts, orders, positions, fills, equity-curve) | yfinance + SQLite |
| `providers.py` | `/api/providers` (list+health), `/api/providers/active` (switch), `/api/providers/auto-failover` | quote registry |
| `sync_router.py` | `/api/sync/status`, `/api/sync/pull`, `/api/sync/push` | cloud-sync (`backend/sync/`) |

### Quote Provider Registry (live-quote path)
`market_data` singleton = `FailoverSource` facade. Quote path (`download_quotes`/`get_fast_info`/`download`/`get_history`) → `ProviderRegistry` (manual switch + auto-failover, capability-scoped). Batch quote/download use **gap-fill merge** — per-symbol routing across providers so mixed portfolios (TH `.BK` + US) get priced by whichever provider supports each symbol. Heavy methods (options/financials/etf/news) → primary yfinance. Providers: `YFQuoteProvider` (default) → `StooqQuoteProvider` (keyless fallback). Add provider: implement `QuoteProvider` + `registry.register()` in `sources/__init__.py`. Env: `QUOTE_PROVIDER_DEFAULT`, `QUOTE_AUTO_FAILOVER`. FE seam: `useLiveQuery` (cadence) + header `ProviderSwitch`. Scaling roadmap: `plans/scaling/`.

### SQLite Database Schema (`portfolio.db`)
```sql
transactions        (id, symbol, type buy/sell, shares, price, date, commission, notes, created_at)
-- 2026-07-04 (port-redesign Step 1): trades += resolved_symbol TEXT, market TEXT (canonical provider ticker,
--   set at write time by /resolve-symbol); portfolio_accounts += markets TEXT (JSON e.g. ["US","TH"])
pin_groups          (id, name, color, sort_order, created_at)
pinned_assets       (id, symbol, group_id, comment, buy_target, sell_target, price_at_pin, priority 1-3, added_at, updated_at)
pin_tags            (id, name, color)
pinned_asset_tags   (asset_id, tag_id)   -- many-to-many
sector_classifications (id, symbol, country, exchange, sector_gics, industry_gics, sector_local,
                        sector_display, company_name, market_cap, index_tags, source,
                        last_fetched, fetch_error, created_at, updated_at) UNIQUE(symbol, country)
option_positions    (id, account_id, underlying, expiry, strike, option_type call|put,
                     quantity, entry_price, entry_date, status open|closed|expired, notes)
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
sync_tombstones     (table_name, row_id, deleted_at) PK(table_name,row_id)  -- cloud-sync delete log
_sync_guard         (active)  -- flag; raised during restore to silence sync triggers
```
Holdings computed via **average-cost method** in `db.compute_holdings()`.

**Cloud sync (`backend/sync/`):** `init_sync_layer()` adds `updated_at` + AFTER INSERT/UPDATE/DELETE triggers to synced tables (LWW + tombstones, all gated by `_sync_guard`). Local `.db` stays working copy; JSON snapshots (user tables only — excludes sector/risk/regime caches) exchanged via `SYNC_DIR`. **Never put `.db` on the cloud drive** (Drive byte-sync + WAL → corruption). Startup `sync.sync_startup()` = pull→merge→push; background pusher every `SYNC_PUSH_INTERVAL`s. Plan: `plans/completed/portfolio-cloud-sync.md`.

---

## Frontend Views — 9 views (post-RMI removal 2026-05-24)

| Key | Button | View | Component |
|-----|--------|------|-----------|
| `1` | MKT | Market View (default) | `market-view.tsx` — watchlist + chart + Regime Detection panel |
| `2` | NEWS | News | `news-view.tsx` — NEWSFEED / SOCIAL tabs + Polymarket right column (256px fixed) |
| `3` | GMOV | Market Movers | `market-movers-view.tsx` — indices table + heatmap treemap |
| `4` | CLIP | Clippings + AI | `clippings-view.tsx` |
| `5` | MACRO | Macro Economics | `macro-view.tsx` — 7 tabs: dashboard, yield, indicators, fed, country, compare, **signals** |
| `6` | CRDT | Credit / Stress | `credit-view.tsx` — 4 tabs: overview, spreads, stress, consumer |
| `P` | PORT | Portfolio | `portfolio-view.tsx` (barrel → `portfolio/`) — 5 top-level tabs: PORTFOLIO (sub: POSITIONS\|OPTIONS\|TRADES\|CASH) · ANALYTICS (sub: P&L\|BACKTEST) · RISK (standalone) · TOOLS (sub: THESES\|IMPORT) · PAPER (sub: DASHBOARD\|TRADE\|POSITIONS\|OPTIONS\|HISTORY) |
| `C` | CRYP | Crypto | `crypto-view.tsx` |
| `E` | FX | FX / Forex | `fx-view.tsx` |

Removed: GVOL (fake data), EQTY (dup), RMI (2026-05-24). Stock analysis (9 tabs) accessible via global search / heatmap click.

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

---

## What Could Be Built Next

### Urgent
- [ ] **Migrate Fund legacy → v2** before **2026-06-30** (SEC old portal closes)
- [ ] Seed sector data: POST /api/sectors/fetch for TH/KR/HK/EU/US

### Features
- [ ] **System Audit 2026-07 — Bug Fixes & Refactor** — 9 fix items + 6 refactor items; F01 done 2026-07-03, F06 done 2026-07-04 (via port-redesign resolver); เหลือ F02 AVCO drift 🔴, F03 async blocking 🔴, F04/F05/F07/F08/F09 + R01–R06 (`plans/system-audit-2026-07/README.md`)
- [x] **Portfolio Cloud Sync** — PC↔Mac sync via Google Drive JSON snapshots, startup pull, row-LWW merge + tombstones, no login done 2026-06-26 (`plans/completed/portfolio-cloud-sync.md`)
- [ ] **Port Redesign** — symbol resolver (resolve-at-write), sub_portfolios table จริง, currency module, ลบ `_get_yf_symbol`/ปิด F06 (`plans/port-redesign.md`)
- [ ] **VP Indicator Upgrade** — แก้ session timezone bug (B1 🔴) + visible-range VP + delta profile + naked POC + HVN/LVN + config UI; audit: `reports/vp-indicator-risk-report.md` (`plans/vp-indicator-upgrade.md`)
- [ ] **P/E History Pane + EPS Surprise Labels** — endpoint `/api/stock/pe-history` (TTM EPS × weekly close, 13–20yr), `PEPane.tsx` recharts sub-pane + valuation percentile bands, earnings marker สี beat/miss; code-complete, backend HTTP verified, frontend visual pending (`plans/pe-earnings-visualization.md`)
- [ ] Polymarket: dashboard view in frontend
- [ ] BOT: frontend view for Bond Auction + yield trend chart
- [ ] BOT: activate Stat-ExchangeRate → add THB FX view
- [ ] Central banks: comparison chart across banks
- [ ] Clippings: auto-reload (file watcher)
- [x] **Alert Ticker** — Bloomberg-style scrolling bar: stop loss breach (persistent) + regime change (15-min event) done 2026-06-05 (`plans/completed/alert-ticker.md`)
- [x] **Fear & Greed Index** — chart pane indicator + FEAR-GREED searchable symbol + F&G/VIX prominent pills in alert ticker done 2026-06-06 (`plans/completed/fear-greed-index.md`)
- [ ] Alerts: price alert when stock hits threshold (price target, separate from stop loss)
- [ ] Sovereign: map visualization
- [ ] Bloomberg CLI + MCP server (`plans/bloomberg-cli-mcp.md`)
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
