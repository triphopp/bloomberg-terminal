# Project Architecture

Python backend serves yfinance + FRED + Alpha Vantage + Ollama + BOT data to Next.js frontend.

**Why yfinance in Python:** Yahoo Finance blocks direct server-side fetch (returns HTML consent page). yfinance in Python works reliably.

**Why SSE for AI:** Ollama streams tokens — proxying SSE through FastAPI → Next.js → React gives real-time output without polling.

**Why FRED for macro:** Free CSV endpoint, no API key, covers all major US macro series. AV (Alpha Vantage) is the fallback when FRED is unreachable (e.g. firewall).

**Why BOT API token (no Bearer):** IBM API Connect format — raw base64 JSON token goes directly in `Authorization` header, no prefix.

## Running (2 terminals always required)

```powershell
# Terminal 1 — Python backend
cd D:\Agents\Claude\bloomberg-terminal-main\backend
$env:CLIPPINGS_DIR = "G:/My Drive/Obsidian Vault/Obsidian Vault GoogleDrive/Clippings"
$env:THESES_DIR    = "G:/My Drive/Obsidian Vault/wiki/theses"
$env:SOURCES_DIR   = "G:/My Drive/Obsidian Vault/wiki/sources"
$env:OLLAMA_URL    = "http://localhost:11434"
python -m uvicorn main:app --port 8000 --reload

# Terminal 2 — Next.js
cd D:\Agents\Claude\bloomberg-terminal-main
npm run dev
```

## Data flow
```
Browser → Next.js (/api/*) → Python (localhost:8000) → yfinance / FRED / AV / Ollama / BOT API / filesystem
                ↓ fallback if Python is down
           static marketData.ts  (market data only)

Macro data path:
  /api/macro → memory cache (5min)
             → macro_series.json disk cache (per-series TTL: 1d–30d)
             → FRED JSON API concurrent (primary)
             → Alpha Vantage sequential (fallback, 350ms apart)
             → yfinance (real-time yield curve only, 1hr TTL)

BOT data path:
  /api/bot/* → memory cache (5min)
             → bot_cache.json disk cache (1–4hr TTL)
             → BOT API (gateway.api.bot.or.th) — each category has its own token
```

## 26 Backend Routers (all in `backend/routers/`)

| Router | Prefix | Source |
|--------|--------|--------|
| market.py | /api/market-data, /api/heatmap | yfinance |
| stock.py | /api/stock/* | yfinance |
| options.py | /api/options/*, positions + Greeks | yfinance + greeks.py |
| pins.py | /api/pins/* | SQLite |
| clippings.py | /api/clippings/* | filesystem + Ollama |
| news.py | /api/news/facebook | RSSHub / Graph API |
| macro.py | /api/macro | FRED + Alpha Vantage (2-layer cache) |
| crisis.py | /api/crisis | FRED |
| sovereign.py | /api/sovereign/* | World Bank |
| portfolio.py | /api/portfolio/* | filesystem + SQLite |
| portfolio_v2.py | /api/v2/portfolio/* (accounts, trades, sell, dividends) | SQLite |
| risk.py | /api/v2/portfolio/risk/* (VaR/CVaR/Parity/Stress/Sizing) | Ledoit-Wolf |
| fx.py | /api/fx/* | yfinance |
| crypto.py | /api/crypto/* | yfinance |
| etf.py | /api/etf/* | yfinance |
| footprint.py | /api/crypto/footprint | Binance |
| central_banks.py | /api/central-banks/* | SDMX/REST (no key) |
| polymarket.py | /api/polymarket/* (signals, search, MCP) | Gamma API + SQLite |
| bot.py | /api/bot/* (auctions, rates, fx, statistics) | BOT API (4 tokens) |
| sectors.py | /api/sectors/* (classification, search, override) | Wikipedia + yfinance + SQLite |
| sec.py | /api/sec/* (legacy, expires 2026-06-30) | api.sec.or.th old portal |
| sec_v2.py | /api/sec/v2/* (52 routes: Bond v2 + Fund v2 + One Report v1) | api.sec.or.th new portal |
| allocation.py | /api/allocation/* (signal, layers, history) | FRED + ETF |
| country_rotation.py | /api/country-rotation/* (scores, history, universe) | yfinance + World Bank |
| sector.py | /api/sector/* (sector selection signal, factors, history) | FRED + yfinance |
| regime.py | /api/regime/correlation | yfinance (5min cache) |
| paper_trading.py | /api/paper/* (accounts, orders, positions, fills, equity-curve) | yfinance + SQLite |

## 9 Frontend Views (post-RMI removal 2026-05-24)

| Key | Atom value | Button | View file |
|-----|------------|--------|-----------|
| `1` | market (default) | MKT | market-view.tsx |
| `2` | news | NEWS | news-view.tsx |
| `3` | movers | GMOV | market-movers-view.tsx |
| `4` | clippings | CLIP | clippings-view.tsx |
| `5` | macro | MACRO | macro-view.tsx |
| `6` | credit | CRDT | credit-view.tsx |
| `P` | portfolio | PORT | portfolio-view.tsx (barrel → portfolio/) |
| `C` | crypto | CRYP | crypto-view.tsx |
| `E` | fx | FX | fx-view.tsx |

**Not routed (no nav button):** stock-view.tsx — accessible via global search / market view click  
**Deleted:** rmi-view.tsx + rmi-chart.tsx (2026-05-24), volatility-view.tsx (2026-05-21)

## Key files

### Backend
- `backend/main.py` — App init, CORS, mounts all 26 routers
- `backend/config.py` — All env vars + BOT tokens (BOT_API_TOKEN, BOT_IR_TOKEN, BOT_FX_TOKEN, BOT_STATS_TOKEN) + SEC_KEYS (old portal) + SEC2_KEYS (new portal, falls back to SEC2_API_KEY)
- `backend/db.py` — SQLite connection manager + schema init + compute_holdings() + sector_classifications helpers
- `backend/greeks.py` — Black-Scholes + Gram-Charlier fat-tail Greeks (added 2026-06-03); see memory/reports/options-greeks-math-report.md
- `backend/providers/` — OptionsProvider abstraction: `base_options.py` (abstract class + DataFreshness + OptionContract), `yahoo_options.py`. Swap by changing 1 line in options.py:26
- `backend/analytics/` — Signal computation modules (imported by routers, NOT mounted directly):
  - `layer_a.py`, `layer_b.py`, `layer_c.py`, `confluence.py` — Equity Allocation Signal (3-layer)
  - `country_rotation.py` — Country Equity Rotation scoring (14 ETFs)
  - `sector_bc.py` (business cycle), `sector_mom.py` (momentum), `sector_val.py` (valuation), `sector_factor.py` (macro APT), `sector_confluence.py` — Sector Selection Signal (11 SPDR ETFs)
  - `regime_calibration.py` — Regime Detection calibration math
- `backend/tests/` — 58 unit tests (pytest): `test_greeks.py` (BS price/GC correction/Greeks/moments), `test_sec_api.py` (10 SEC legacy endpoints), `conftest.py` (sys.path setup)
- `.github/workflows/tests.yml` — CI/CD on push/PR to main: `backend-tests` (Python 3.11 → pytest) + `frontend-typecheck` (Node 20 → tsc --noEmit)
- `backend/routers/bot.py` — BOT API: bond auctions + interest rates + FX + statistics; uses `_bot_get()` + `_cached()` helpers
- `backend/routers/central_banks.py` — 10 central banks via SDMX/REST (ECB, BOE, BOC, Norges, Bundesbank, SNB, BOJ, SARB, CBR, RBA, Eurostat)
- `backend/routers/macro.py` — FRED primary + AV fallback + yfinance yields; 3-layer cache
- `backend/.env` — all API keys including 4 BOT tokens + SEC2_API_KEY

### Disk caches (backend root)
- `macro_series.json` — per FRED series (per-TTL based on release frequency)
- `credit_series.json` — crisis/stress indicators
- `central_banks_cache.json` — central bank rates + FX
- `sovereign_cache.json` — World Bank country data
- `bot_cache.json` — BOT API (auctions, rates, fx)

### Frontend
- `components/bloomberg/layout/bloomberg-terminal.tsx` — view router (9 views)
- `components/bloomberg/layout/terminal-header.tsx` — nav buttons
- `components/bloomberg/atoms/index.ts` — Jotai atoms (currentViewAtom)
- `components/bloomberg/hooks/useTerminalUI.ts` — view navigation handlers
- `components/bloomberg/views/market-view.tsx` — MKT default view (eager-loaded); exports `MarketView` + `KeyIndicatorsBar`

### Next.js proxies (app/api/)
- `bot/auctions/route.ts` — GET + DELETE (cache clear)
- `bot/rates/route.ts` — GET `?type=policy|interbank|thb-implied|swap-point`
- `bot/fx/route.ts` — GET `?type=daily|monthly`
- `polymarket/route.ts` — GET/?type=, GET/?q=, POST, DELETE

## CPU/RAM issues resolved (do not reintroduce)
- `@upstash/redis` at module top-level → retry loops → removed
- `.next` cache with old heavy bundles → cleared
- `yahoo-finance2` npm → 200+ JSON schemas on import → removed
- Scheduler singleton with `setInterval` on import → removed

## See also
→ [project_summary.md](../project_summary.md) — slim core: stack, env vars, routers table, DB schema, known issues  
→ [api-endpoints.md](api-endpoints.md) — all endpoints per router + caching + Next.js proxy routes  
→ [data-shapes.md](data-shapes.md) — API response JSON shapes + TypeScript interfaces  
→ [frontend-structure.md](frontend-structure.md) — component tree + key exports + keyboard shortcuts  
→ [gotchas.md](gotchas.md) — error dictionary + anti-patterns + "Where is X?" lookup + env var map  
→ [data-catalog.md](data-catalog.md) — 17 data categories available for analysis  
→ `memory/plans/` — feature plans + completed work  
→ `memory/reports/` — math derivations, risk assessments
