# Gotchas, Error Dictionary & Anti-Patterns

> Read this before investigating any bug. Most errors have been seen before.
> **See also:** [api-endpoints.md](api-endpoints.md) | [data-shapes.md](data-shapes.md) | [architecture.md](architecture.md) | [frontend-structure.md](frontend-structure.md)

---

## Error Dictionary — Symptoms → Root Cause → Fix

### Frontend / React

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| localStorage setting not saved after refresh | `useEffect([dep])` fires on mount → overwrites loaded value with DEFAULT | Read in `useState` initializer, write in `useEffect([val])`. See pattern in CLAUDE.md |
| Polymarket URL → "Page not found" | Using market `slug` (has trailing `-789-924-249`) instead of `event_slug` | Use `events[0].slug` from Gamma API pool → stored as `event_slug` in signal |
| Section content clipped, can't scroll | Root div missing `h-full` → `overflow-hidden` on parent clips content | Root: `flex flex-col h-full`, header: `shrink-0`, scroll zone: `flex-1 overflow-y-auto` |
| Jotai `atomWithStorage` wrong default on load | Next.js SSR hydrates with server value (undefined window) before client localStorage read | Use `useState` initializer with `typeof window === "undefined"` guard instead |
| React Query stale data after mutation | Missing `queryClient.invalidateQueries()` after POST/PATCH/DELETE | Call invalidate with matching queryKey after mutation |
| Chart labels truncated | Missing `interval={0}` on Recharts XAxis | Add `interval={0}` to all bar chart XAxis |

### Backend / FastAPI

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| Whole server freezes during one request | `async def` endpoint calls blocking `requests`/yfinance → blocks event loop | Use plain `def` (FastAPI runs in threadpool). Fixed: tail_risk, sectors 2026-06-10. ⚠️ options.py/paper_trading.py still mix `await`+blocking → need `run_in_executor` |
| N concurrent requests all hit yfinance on cache miss (stampede) | router does `get`→compute→`set` (no coalescing) | Use `_cache.get_or_set(key, fn)` from `cache.py` (per-key Event coalescing, already built) |
| `YFDataException: Yahoo API requires curl_cffi session not <requests.Session>` | Injected a plain `requests.Session` into `yf.Ticker(session=...)` | DON'T inject a session — yfinance already pools internally (singleton YfData) + requires curl_cffi. `_ticker()` = plain `yf.Ticker(symbol)`. (tried+reverted 2026-06-10) |
| market-data slow | `fetch_one` over-fetches `.info` per symbol (heaviest yfinance call) just for `regularMarketChange` | Batch via `download()` from one OHLC frame (pending — needs backend verify CHG%/YTD) |
| Arbitrary file read via API (LFI) | user-supplied `dir`/path param used as base for file resolve → traversal guard useless | Whitelist allowed roots (`clippings.py _is_allowed_dir`). Never resolve user filename against user-supplied base |
| 500 response leaks server path/internals | `raise HTTPException(500, str(exc))` | Global handler in `main.py` logs detail server-side, returns generic `"Internal server error"` for ≥500 |
| CORS error from browser | New router not added to `main.py` `include_router()` | Add `app.include_router(x_router, tags=["X"])` in main.py |
| BOT API 403 on FX endpoints | `Stat-ExchangeRate/v2` subscription not activated in BOT portal | Activate at gateway.api.bot.or.th — separate subscription from other BOT products |
| BOT API empty data (THB Implied IR / Swap Point) | BOT may have discontinued these series | Expected — endpoints respond 200 but return empty arrays |
| BOT request returns partial data | Exceeded 31-day max date range per request | Split into multiple requests ≤31 days each |
| SEC returns 204 | Company has no data for that specific One Report section | Expected behaviour — not an error. Check another section or year |
| SEC 401/403 | Wrong auth header format | Use `Ocp-Apim-Subscription-Key` header (Azure APIM), NOT `X-API-KEY` |
| Gamma API search returns wrong markets | `tag_slug`/`q`/`search`/`order` params silently ignored | All filtering must be client-side on 3,000-market pool fetched upfront |
| Polymarket Δ24h is null | Backend hasn't run ≥24h — no history row in `pm_signals` table yet | Expected on first run. Wait ≥24h |
| yfinance data not updating | In-memory cache still warm | DELETE `/api/stock/cache` or restart backend |
| Macro/Crisis view shows nothing | `FRED_API_KEY` not set | Set env var — without it FRED calls fail silently |
| Backend startup error: missing module | numpy/scipy not installed (required for greeks.py) | `pip install numpy>=1.26 scipy>=1.12` |

### Next.js / Proxy

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| Next.js proxy 502 | Python backend not running on port 8000 | Start backend: `python -m uvicorn main:app --port 8000 --reload` |
| SSE stream cuts off | Vercel Edge Runtime needed for streaming in production | Add `export const runtime = "edge"` to SSE proxy route |
| `PYTHON_API` undefined | `.env.local` missing `PYTHON_API_URL` | Default is `http://localhost:8000` — set in `lib/constants.ts` |

---

## Anti-Patterns — Things That Look Fine But Break Everything

| Anti-pattern | Why it breaks | What to do instead |
|-------------|--------------|-------------------|
| `import { createClient } from "@upstash/redis"` at module top-level | Starts retry loops on every import → CPU spike | Removed permanently. Use Python in-memory cache via `cache.py` |
| `import yahooFinance from "yahoo-finance2"` in Next.js | Loads 200+ JSON schemas on import → RAM spike + slow cold start | Always go through Python backend `/api/stock/*` |
| `setInterval(...)` at module top-level in Next.js | Runs on every hot-reload + every Vercel function cold start | Never use top-level schedulers in Next.js |
| Calling Gamma API with `?q=` or `?tag_slug=` filter | Params silently ignored — returns full 3,000-market pool anyway | Always filter client-side after fetching pool |
| Changing API response field names/shapes | No versioning — frontend hardcodes field names, breaks immediately | Add new fields, never rename/remove existing ones |
| Renaming Jotai atom string values | Every `useAtom` subscriber breaks + localStorage keys mismatch | Atom values are stable contracts — add new, never rename |
| Renaming cache JSON files (`macro_series.json` etc.) | Backend disk cache read path hardcoded in each router | Keep filenames stable |
| `ALTER TABLE ... DROP COLUMN` on portfolio.db | No migration system — existing data lost | Only `ADD COLUMN IF NOT EXISTS` with safe defaults |
| `useEffect([dense])` to sync columns from dense toggle | Effect fires on mount → overwrites localStorage-loaded cols | Call `setShowCols()` directly in click handler |
| Using `language=1` or `language=2` for SEC One Report | API silently returns empty / wrong data | Use `language=T` (Thai) or `language=E` (English) |
| Using Buddhist Era year for SEC One Report (`report_year=2566`) | API returns no data | Use Gregorian year (`report_year=2023`) |

---

## Where Is X? — Quick File Lookup

| "I need to change..." | File | Location hint |
|----------------------|------|---------------|
| Polymarket signal enrichment (status/direction/delta) | `backend/routers/polymarket.py` | `_classify_signal()` + `_get_24h_delta()` |
| Portfolio column persistence | `components/bloomberg/views/portfolio/tabs/OpenPositionsTab.tsx` | `useState` initializer + `useEffect([showCols])` |
| MACRO tab list | `components/bloomberg/views/macro-view.tsx` | line ~55: `MacroTab` type + tab array |
| SIGNALS tab content (rotation + sector) | `views/rotation-tab.tsx`, `views/sector-tab.tsx` | imported in macro-view.tsx |
| Portfolio tab list | `components/bloomberg/views/portfolio/index.tsx` | `tabList` array, lines 27–35 |
| Polymarket NEWS column | `components/bloomberg/views/news-view.tsx` | `PolymarketColumn` component |
| View routing (which component renders) | `components/bloomberg/layout/bloomberg-terminal.tsx` | switch/conditional blocks |
| Nav buttons | `components/bloomberg/layout/terminal-header.tsx` | button array |
| Keyboard shortcuts | `components/bloomberg/layout/terminal-layout.tsx` | `handleKeyDown` |
| Global search | `components/bloomberg/core/global-search.tsx` | — |
| Jotai atoms | `components/bloomberg/atoms/index.ts` | all atom definitions |
| React Query hooks | `components/bloomberg/hooks/` | `useMarketData.ts`, `useStockData.ts`, etc. |
| Backend env vars | `backend/config.py` | all constants loaded here |
| SQLite schema | `backend/db.py` | `init_db()` function |
| Options Greeks math | `backend/greeks.py` | `compute_greeks()`, `_gc_correction()` |
| Equity Allocation Signal layers | `backend/analytics/layer_a.py`, `layer_b.py`, `layer_c.py`, `confluence.py` | — |
| Sector Selection Signal layers | `backend/analytics/sector_bc.py`, `sector_mom.py`, `sector_val.py`, `sector_factor.py`, `sector_confluence.py` | — |
| Country Rotation scoring | `backend/analytics/country_rotation.py` | — |
| Regime Detection calibration | `backend/analytics/regime_calibration.py` | — |
| BOT API calls | `backend/routers/bot.py` | `_bot_get()` helper |
| SEC old portal routes | `backend/routers/sec.py` | — |
| SEC new portal routes | `backend/routers/sec_v2.py` | 52 routes |
| Portfolio v2 trade CRUD | `backend/routers/portfolio_v2.py` | — |
| Risk metrics (VaR/CVaR) | `backend/routers/risk.py` | — |
| CI/CD workflow | `.github/workflows/tests.yml` | — |

---

## Env Var → Feature Map

| Missing env var | What breaks |
|----------------|-------------|
| `FRED_API_KEY` | MACRO view + CRDT (crisis) fail silently — no data shown |
| `ANTHROPIC_API_KEY` | Portfolio AI analysis tab fails |
| `OLLAMA_URL` (wrong) | Clippings AI panel fails (default: `http://localhost:11434`) |
| `BOT_API_TOKEN` | `/api/bot/auctions` → 401 |
| `BOT_IR_TOKEN` | `/api/bot/rates/*` → 401 |
| `BOT_FX_TOKEN` | `/api/bot/fx/*` → 401 (also needs portal activation for FX) |
| `BOT_STATS_TOKEN` | `/api/bot/statistics/*` → 401 |
| `SEC2_API_KEY` | All `/api/sec/v2/*` routes fail |
| `BINANCE_API_KEY` | `/api/crypto/footprint` fails |
| `FACEBOOK_ACCESS_TOKEN` | FB social feed falls back to RSSHub (may be rate-limited) |
| `CLIPPINGS_DIR` | Clippings view empty (default: `G:/My Drive/...`) |
