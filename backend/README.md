# Backend API Documentation

Market Data API built with **FastAPI + yfinance**. Provides real-time market data, portfolio management, macro economics, and more.

## Quick Start

```powershell
cd backend

# Set environment variables (or use backend/.env)
$env:CLIPPINGS_DIR = "C:/path/to/your/notes/clippings"
$env:THESES_DIR    = "C:/path/to/your/notes/theses"
$env:SOURCES_DIR   = "C:/path/to/your/notes/sources"
$env:OLLAMA_URL    = "http://localhost:11434"

# Run server
python -m uvicorn main:app --port 8000 --reload
```

Server runs at `http://localhost:8000`. API docs at `/docs` (Swagger) or `/redoc`.

## Project Structure

```
backend/
├── main.py                  ← App init, middleware, router mounting
├── config.py                ← All constants, env vars, static data
├── db.py                    ← SQLite connection manager + schema init
├── routers/
│   ├── __init__.py
│   ├── market.py            ← World indices + heatmap
│   ├── stock.py             ← Stock search, quote, history, fundamentals
│   ├── options.py           ← Options chain + volatility surface
│   ├── pins.py              ← Watchlist/pin assets CRUD
│   ├── clippings.py         ← Obsidian clippings + Ollama AI
│   ├── news.py              ← Facebook page news feed
│   ├── macro.py             ← FRED/Alpha Vantage macro indicators
│   ├── crisis.py            ← Credit risk + stress indicators
│   ├── sovereign.py         ← World Bank country data
│   ├── portfolio.py         ← Theses, research, transactions, backtest
│   ├── fx.py                ← Forex pairs
│   ├── crypto.py            ← Cryptocurrency
│   ├── etf.py               ← ETF analytics
│   ├── footprint.py         ← Crypto order footprint (Binance aggTrades)
│   ├── central_banks.py     ← Central bank rates + balance sheets (no key needed)
│   └── polymarket.py        ← Prediction market signals (Gamma API)
├── portfolio.db             ← SQLite database (auto-created)
├── macro_series.json        ← Macro indicator cache (auto-created)
├── credit_series.json       ← Credit risk cache (auto-created)
├── central_banks_cache.json ← Central bank cache (auto-created)
├── sovereign_cache.json     ← Sovereign data cache (auto-created)
├── requirements.txt
└── .env                     ← Environment variables (optional)
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLIPPINGS_DIR` | No | `./data/clippings` | Path to markdown notes folder |
| `THESES_DIR` | No | `./data/theses` | Path to investment theses folder |
| `SOURCES_DIR` | No | `./data/sources` | Path to research sources folder |
| `OBSIDIAN_WIKI_DIR` | No | `./data/wiki` | Wiki root folder |
| `OLLAMA_URL` | No | `http://localhost:11434` | Local Ollama instance URL |
| `PORTFOLIO_DB` | No | `portfolio.db` | SQLite database path |
| `FRED_API_KEY` | No | — | FRED JSON API key (faster than CSV) |
| `ALPHA_VANTAGE_API_KEY` | No | — | Alpha Vantage fallback for macro |
| `ANTHROPIC_API_KEY` | No | — | Claude API for portfolio research |
| `BINANCE_API_KEY` | No | — | Binance API key for order footprint (higher rate limits) |
| `FACEBOOK_ACCESS_TOKEN` | No | — | Facebook Graph API token |
| `RSSHUB_URL` | No | `https://rsshub.app` | RSSHub instance for FB fallback |

## API Endpoints Reference

### Health Check

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server health status |

---

### Market Data (`routers/market.py`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/market-data` | All world indices grouped by region (americas, emea, asiaPacific) |
| GET | `/api/heatmap?group=sectors` | Heatmap tiles. Groups: `sectors`, `commodities`, `bonds`, `indicators` |

**Cache:** 60s TTL for both endpoints.

**Response (`/api/market-data`):**
```json
{
  "americas": [{ "id": "S&P 500", "value": 5200.5, "change": 12.3, "pctChange": 0.24, "ytd": 8.5, "size": 500, "avat": 4.2 }],
  "emea": [...],
  "asiaPacific": [...],
  "lastUpdated": "2024-01-15T10:30:00Z",
  "dataSource": "yfinance"
}
```

---

### Stock (`routers/stock.py`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stock/search?q=AAPL` | Ticker search (yfinance + Yahoo REST fallback) |
| GET | `/api/stock/{symbol}?period=6mo` | Quote + chart data. Periods: 1mo, 3mo, 6mo, 1y, ytd |
| GET | `/api/stock/quote/{symbol}` | Real-time detailed quote (60s cache) |
| GET | `/api/stock/history/{symbol}?period=1y&interval=1d` | OHLCV history. Intervals: 5m, 15m, 30m, 1h, 2h, 4h, 1d, 1wk |
| GET | `/api/stock/financials/{symbol}` | Income statement + cash flow (annual + quarterly) |
| GET | `/api/stock/balance-sheet/{symbol}` | Balance sheet (annual + quarterly) |
| GET | `/api/stock/dividends/{symbol}` | Dividend history + stock splits |
| GET | `/api/stock/analyst/{symbol}` | Price targets, recommendations, upgrades/downgrades |
| GET | `/api/stock/estimates/{symbol}` | Earnings/revenue estimates, EPS trend, growth |
| GET | `/api/stock/ownership/{symbol}` | Insider transactions, institutional/mutual fund holders |
| GET | `/api/stock/earnings-calendar/{symbol}` | Upcoming and past earnings dates with surprises |
| GET | `/api/stock/sec-filings/{symbol}` | Recent SEC filings (10-K, 10-Q, 8-K, etc.) |
| GET | `/api/stock/ratios/{symbol}` | Financial ratios (profitability, leverage, valuation, growth) |
| GET | `/api/stock/management/{symbol}` | Company officers and management team |

**Cache:** 5min for quote/analyst/estimates, 1h for fundamentals, 5min for stock overview.

---

### Options (`routers/options.py`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/options/{symbol}?expiry=2024-03-15` | Options chain for one expiry + summary stats |
| GET | `/api/options/{symbol}/surface` | IV surface across all expirations (max 10) |

**Chain response includes:** calls, puts, spot price, ATM IV, put/call ratio, open interest, volume.

**Surface filters:** moneyness within ±40%, IV > 1%.

---

### Pin Assets / Watchlists (`routers/pins.py`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/pins/groups` | List all watchlist groups |
| POST | `/api/pins/groups` | Create a group |
| PATCH | `/api/pins/groups/{id}` | Update group name/color/order |
| DELETE | `/api/pins/groups/{id}` | Delete group (reassigns assets) |
| GET | `/api/pins/assets` | List all pinned assets with tags |
| POST | `/api/pins/assets` | Pin a new asset |
| PATCH | `/api/pins/assets/{id}` | Update asset (target prices, priority, etc.) |
| DELETE | `/api/pins/assets/{id}` | Remove pinned asset |
| GET | `/api/pins/tags` | List all tags |
| POST | `/api/pins/tags` | Create a tag |
| DELETE | `/api/pins/tags/{id}` | Delete a tag |
| POST | `/api/pins/assets/{id}/tags/{tag_id}` | Assign tag to asset |
| DELETE | `/api/pins/assets/{id}/tags/{tag_id}` | Remove tag from asset |
| POST | `/api/pins/import` | Bulk import groups + assets |

**Storage:** SQLite with foreign keys. Deleting a group reassigns its assets to the oldest remaining group.

---

### Obsidian Clippings (`routers/clippings.py`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/clippings?q=search&dir=` | List markdown files with frontmatter metadata |
| GET | `/api/clippings/content?file=name.md` | Full content of a single clipping |
| POST | `/api/clippings/ai` | Stream AI response (SSE) — summarize, translate, custom prompt |
| GET | `/api/clippings/ai/models` | List available Ollama models |

**AI actions:** `summarize`, `translate_th`, `custom` (requires `custom_prompt` field).

**Streaming:** Server-Sent Events (SSE) format: `data: {"token": "...", "done": false}\n\n`

---

### News (`routers/news.py`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/news/facebook?pages=page1,page2&limit=8` | Facebook page posts (RSSHub or Graph API) |

**Sources:** Uses Facebook Graph API if `FACEBOOK_ACCESS_TOKEN` is set, otherwise falls back to RSSHub RSS feeds.

---

### Macro Economics (`routers/macro.py`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/macro` | All macro indicators + yield curve + Fed stance |
| DELETE | `/api/macro/cache` | Force full refresh of all series |

**Indicators provided:**
- CPI (YoY %), GDP Growth, Unemployment Rate, Non-Farm Payrolls (MoM change)
- Fed Funds Rate, Retail Sales (MoM %), Consumer Sentiment
- Yield Curve: 3M, 2Y, 5Y, 10Y, 30Y rates + spreads
- Fed stance detection (HIKING / CUTTING / HOLD)
- Next FOMC meeting date

**Data sources:** FRED (primary, JSON API + CSV fallback) → Alpha Vantage (secondary). Real-time yields via yfinance.

**Cache:** 3-layer system — memory (5min) → per-series disk (variable: 4h–30d based on release frequency) → network fetch.

---

### Crisis / Credit Risk (`routers/crisis.py`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/crisis` | Credit stress dashboard with crisis level (0–3) |
| DELETE | `/api/crisis/cache` | Reset all credit series TTLs |

**Signals monitored (15 indicators):**
- **Spreads:** US HY OAS, US IG OAS, EM HY OAS, TED Spread
- **Stress indices:** STL Financial Stress, Chicago NFCI, VIX
- **Yield curves:** 10Y−2Y, 10Y−3M (inversion detection)
- **Consumer:** 5Y/10Y Breakeven Inflation, 30Y Mortgage Rate, CC Delinquency, Mortgage Delinquency

**Crisis levels:** 0 (calm) → 1 (≥1 triggered) → 2 (≥3 triggered) → 3 (≥5 triggered)

---

### Sovereign Data (`routers/sovereign.py`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sovereign/list?q=search` | List 37 supported countries with risk scores |
| GET | `/api/sovereign/{country_code}` | Full World Bank macro data for one country |
| DELETE | `/api/sovereign/cache` | Reset sovereign cache |

**Coverage:** 37 countries across ASEAN, East Asia, South Asia, Americas, Europe, Middle East, Africa, CIS.

**30 World Bank indicators** across categories: economic output, prices/labour, fiscal, external, trade, monetary, real economy, social/governance.

**Risk score:** 0–100 (higher = healthier). Based on GDP growth, CPI, unemployment, debt/GDP, current account, FX reserves.

---

### Portfolio (`routers/portfolio.py`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/portfolio/theses` | List all investment thesis files |
| GET | `/api/portfolio/thesis/{symbol}` | Parsed thesis with sections and KO cards |
| POST | `/api/portfolio/research` | Stream AI research analysis (Ollama/Claude SSE) |
| GET | `/api/portfolio/sources/{symbol}` | List relevant Obsidian source notes |
| POST | `/api/portfolio/export` | Export holdings to Obsidian markdown |
| GET | `/api/portfolio/db/transactions` | List all transactions |
| POST | `/api/portfolio/db/transactions` | Add buy/sell transaction |
| DELETE | `/api/portfolio/db/transactions/{id}` | Delete transaction |
| GET | `/api/portfolio/db/holdings` | Computed current holdings (average-cost) |
| POST | `/api/portfolio/db/import` | Import holdings from localStorage |
| GET | `/api/portfolio/db/backtest?benchmark=SPY` | Full portfolio backtest with metrics |

**Research streaming:** Analyzes condition-killers from thesis using Ollama or Claude API. Injects relevant Obsidian source notes as primary evidence. Saves results to Obsidian vault.

**Backtest metrics:** Total return, CAGR, Sharpe ratio, max drawdown, volatility, beta, alpha, per-symbol attribution.

**Transaction model:**
```json
{
  "symbol": "AAPL",
  "type": "buy",
  "shares": 10,
  "price": 150.00,
  "date": "2024-01-15",
  "commission": 0,
  "notes": ""
}
```

---

### Forex (`routers/fx.py`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/fx` | All 20 major FX pairs with current rates |
| GET | `/api/fx/history/{pair}?period=3mo` | Historical FX rate (e.g., `EURUSD` or `EURUSD=X`) |

**Pairs:** EUR/USD, GBP/USD, USD/JPY, USD/CHF, AUD/USD, USD/CAD, NZD/USD, EUR/GBP, EUR/JPY, GBP/JPY, USD/CNY, USD/THB, USD/SGD, USD/HKD, USD/KRW, USD/INR, USD/MXN, USD/BRL, USD/ZAR, USD/TRY.

---

### Crypto (`routers/crypto.py`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/crypto` | Top 20 crypto assets with prices and 24h changes |
| GET | `/api/crypto/history/{coin}?period=3mo` | Historical price (e.g., `BTC` or `BTC-USD`) |

**Coins:** BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, DOT, LINK, MATIC, UNI, ATOM, LTC, NEAR, SUI, APT, ARB, OP, PEPE.

---

### Order Footprint (`routers/footprint.py`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/crypto/footprint/{symbol}?interval=5m&limit=20&buckets=12` | Buy/sell volume per price level per candle (Binance aggTrades) |

**Parameters:**
- `interval`: Candle interval — `1m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`
- `limit`: Number of candles (5–60, default 20)
- `buckets`: Price levels per candle (6–30, default 12)

**Data source:** Binance aggTrades API. Requires `BINANCE_API_KEY` env var for higher rate limits.

**Cache:** 30s TTL per symbol/interval/limit combination.

---

### ETF (`routers/etf.py`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/etf/{symbol}` | ETF overview, top holdings, sector weights |

**Response includes:** fund family, category, total assets, expense ratio, YTD/3Y/5Y returns, beta, dividend yield, top 10 holdings with weights, sector weightings.

---

### Central Banks (`routers/central_banks.py`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/central-banks` | Policy rates + balance sheet sizes for major central banks |

**No API key required.** Data is fetched from public SDMX and REST endpoints.

**Banks covered:**
- **Group A (SDMX):** ECB, Bundesbank, Norges Bank
- **Group B (REST/JSON):** Bank of Canada, SNB, BOJ, SARB, Bank of Russia
- **Group C (CSV/HTML):** Bank of England, RBA
- **Group D (Supranational):** Eurostat

**Cache:** 5-minute in-memory + persistent disk JSON (`central_banks_cache.json`). Survives server restarts.

---

### Polymarket (`routers/polymarket.py`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/polymarket/signals` | All 8 signal types with implied probabilities |
| GET | `/api/polymarket/signals/{type}` | Single signal type |
| GET | `/api/polymarket/search?q=X` | Free-text market search |
| GET | `/api/polymarket/market/{slug}` | Full detail for one market by slug |
| GET | `/api/polymarket/discover/{type}` | Debug — show what keyword search finds for a type |
| GET | `/api/polymarket/registry` | Slug registry (SQLite) |
| GET | `/api/polymarket/history` | Historical signal readings |
| GET | `/api/polymarket/latest` | Most recent stored signal per type (DB read, no live fetch) |
| GET | `/api/polymarket/types` | List signal types with keywords |
| POST | `/api/polymarket/refresh` | Force refresh all signals (bypass cache) |
| DELETE | `/api/polymarket/cache` | Clear in-memory cache + pool cache |

**Signal types (8):** `fed_rate`, `inflation`, `recession`, `global_rates`, `trade`, `economy`, `crypto`, `election`

**Architecture — two-layer pipeline:**
1. **Market discovery:** Fetch up to 3,000 active markets from Gamma API (paginated) → client-side phrase keyword match
2. **Signal extraction:** `outcomePrices[0]` = implied Yes-probability (0–1). Fallback: `tokens[0].price` → `(bestBid + bestAsk) / 2`

**Important — Gamma API limitation:**  
`tag_slug`, `q`, `search`, `order`, and other filter params are **silently ignored** by the API.  
All filtering is done client-side on the cached pool. First cold fetch takes ~15s (30 pages × 100 markets).

**Cache:** 5-min in-memory for signals. 10-min in-memory for market pool. Slugs + signal history persist in SQLite.

---

## Architecture Notes

### Data Flow
```
Frontend (Next.js :3000) → Backend (FastAPI :8000) → yfinance / FRED / World Bank / Ollama
```

### Caching Strategy
- **In-memory:** Fast, module-level dicts with TTL checks
- **Disk cache:** JSON files for expensive series (macro, credit, sovereign) — survives restarts
- **Per-series TTL:** Each indicator has its own refresh interval based on release frequency

### Adding a New Data Source (Plug-and-Play)

To swap yfinance for another provider:

1. Create `providers/new_provider.py` implementing the same function signatures
2. Update the relevant router's import to use the new provider
3. No other files need to change

Example: if Yahoo blocks requests, create `providers/polygon.py` with the same `get_quote()`, `get_history()` functions and swap the import in `routers/stock.py`.

### Adding a New Endpoint

1. Create or edit a file in `routers/`
2. Add `router = APIRouter()` if new file
3. Mount in `main.py`: `app.include_router(new_router.router)`

### Database

SQLite with WAL mode. Tables:
- `transactions` — buy/sell history
- `pin_groups` — watchlist groups
- `pinned_assets` — pinned stocks with targets
- `pin_tags` — tag definitions
- `pinned_asset_tags` — many-to-many junction

Auto-created on first run via `db.init_db()`.
