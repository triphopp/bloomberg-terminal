# Gotchas, Error Dictionary & Anti-Patterns

> Read this before investigating any bug. Most errors have been seen before.
> **See also:** [api-endpoints.md](api-endpoints.md) | [data-shapes.md](data-shapes.md) | [architecture.md](architecture.md) | [frontend-structure.md](frontend-structure.md)

---

## Error Dictionary — Symptoms → Root Cause → Fix

### ALERT crawl stuck on "MARKET DATA LOADING..." / slowest thing on the page (fixed 2026-09-13)

| Symptom | Root Cause | Fix |
|---|---|---|
| Bottom crawl shows `MARKET DATA LOADING...` for ~25s on every boot | Nothing warmed the market/heatmap/FX caches at startup, so the first reader paid the whole cold fan-out. Measured `/api/ticker`: **23.5s cold, 0.21s warm** | `ticker.prewarm()` in `backend/main.py`, on a worker thread (must not delay the port bind) |
| Crawl goes BACK to `MARKET DATA LOADING...` mid-session, for about a minute | Every fetcher in `routers/ticker.py` catches its own errors and returns `[]`; the assembled empty result was then `_cache.set()` like any other. One upstream 429 blanked the bar for the full TTL | A degraded build (no index/commodity/FX row at all) never replaces a payload that still has rows. Plus stale-while-revalidate: past `FRESH_TTL` the old payload goes out flagged `stale` while a thread refreshes behind it |
| Nearly every 60s poll is slow, not just the first | Ticker TTL 60s == frontend `refetchInterval` 60s == `CACHE_TTL` 60s on market+heatmap. The whole chain expired at the instant the next request arrived | `FRESH_TTL = 45` against a 90s poll. **Keep the server window strictly under the client interval** |
| Any `download_quotes()` call is ~0.9s per symbol | `yf.Tickers(...)` *looks* batched, but `fast_info` is lazy — each symbol is its own HTTP round-trip. 20 FX pairs = 18.7s, almost the entire cold cost of the endpoint | `ThreadPoolExecutor` over the symbols in `sources/yfinance_source.py:download_quotes`. 18.7s → 3.5s. Benefits `fx.py` and `crypto.py` alike |

**Anti-pattern — negative caching.** A fetcher that returns `[]` on error makes
"upstream failed" indistinguishable from "there is nothing". Caching that result
turns a one-second blip into a full-TTL outage. Either do not store the empty
result, or refuse to let it overwrite a good one.

**Anti-pattern — one loading state for three situations.** The old bar used
`content.length === 0` for first-load, outright failure, and an empty market
alike. A reader could not tell "not here yet" from "broken". It now keeps the
last payload that had rows and renders it dimmed under a `STALE` badge rather
than blanking.

**`TTLCache.get()` DELETES anything past the ttl it is handed** — so you cannot
ask for a short "fresh" view first and fall back to a long "stale" view: the
first call evicts the entry the second one wanted. `routers/ticker.py` keeps the
timestamp inside the cached value (`(fetched_at, payload)`) and compares ages
itself, asking the cache only for the outer `STALE_TTL` window.

Tests: `backend/tests/test_ticker_cache.py` (5). Related:
[heatmap tile silent-drop report](../reports/heatmap-tile-silent-drop-risk-report.md).

### Windows NEWS DCF/REGIME 404 and Raw SVI 405 after a pull (2026-09-13)

| Symptom | Root Cause | Fix |
|---|---|---|
| New NEWS DCF/REGIME panels say `Not Found`; IV Raw SVI says `FIT ERROR`, while Mac works | Windows tray launcher defaults to Python without `--reload`; Next.js loads new UI but the older Python process has no new routes. Verified backend PID 20596 started 18:22, before source updates at 19:39. Running OpenAPI omitted all three routes. | Tray → **Restart servers**, then refresh the browser after pulling backend changes. Starting another copy of the exe only opens the browser. For development, quit the launcher and start it with `--reload`. |
| SVI returns `405 Method Not Allowed` before calibration | In the stale runtime, `/api/options/smile-fit` matches the older GET-only `/api/options/{symbol}` path; the POST endpoint exists only on disk | Check `/openapi.json` for `POST /api/options/smile-fit`, `GET /api/dcf/{symbol}` and `GET /api/market-state/{symbol}`. `/health` being OK does not prove current code is loaded. Restart before diagnosing SciPy or quote validation. |

Recovery verified through Next.js port 9318: DCF SNDK and REGIME AAPL returned
HTTP 200 / `status: ok`; live SNDK 2026-10-16 SVI returned `ok` for 56 call and
56 put points. Related tests: 61 passed. See
[runtime risk report](../reports/windows-news-stale-backend-risk-report.md) and
[launcher instructions](../../tools/launcher/README.md#after-pulling-backend-changes).

### Adaptive DCF currency and terminal-value guards (2026-09-13)

| Symptom | Root Cause | Fix |
|---|---|---|
| Intrinsic value and market price look comparable but use different currencies | Yahoo `financialCurrency` and quote `currency` can differ for ADR/cross-listed instruments | Do not compare without FX. The DCF normalizer omits price/market cap/upside and emits an AUDIT warning. See [DCF risk report](../reports/dcf-valuation-risk-report.md). |
| WACC collapses toward after-tax debt cost when market cap is missing | Debt/equity weighting was attempted with only one valid side | Fall back to cost of equity unless both market cap and debt are positive; never manufacture a debt-only capital structure from missing data. |
| Gordon terminal value is negative or explodes | Terminal growth is at/above the applicable discount rate | Cap `g` 50bp below rate, report the adjustment, and return null for invalid sensitivity cells. |
| Custom assumptions from the previous symbol briefly run on a newly selected symbol | React effect reset runs after the first render of the new symbol | Include symbol in request state and use AUTO/Base until request symbol matches the selected symbol. |

### IV + OI overlay (2026-09-13)

| Symptom | Root Cause | Fix |
|---|---|---|
| OI bars vanish when SVI is enabled | Recharts bar width follows the smallest spacing of the dense fitted K grid (live0.129px) | Center fixed3px/5px rectangles on actual OI observations; do not widen the X spacing or create extra OI points. See [OI risk report](../reports/mkt-iv-oi-risk-report.md). |
| OI changes when switching IV quote quality, or missing OI looks like0 | OI derived from IV samples; cleaner loses source availability | Build OI directly from chain with K-range only. `openInterestAvailable` preserves missingness before legacy zero-fill; valid0 remains known. |
| Large OI flattens IV, or values carry the wrong units | Series assigned the same Y axis / tooltip formatter | Explicit `iv` left and `oi` right axes, contract-count tooltip for OI, percentage for IV. |

### Multi-expiry SVI calibration (2026-09-13)

| Symptom | Root Cause | Fix |
|---|---|---|
| `QueriesObserver: Duplicate Queries found` during symbol switches / missing tenors | Multiple disabled fit queries share `expiry:null` and otherwise identical keys before discovery | Include missing-tenor months in disabled query keys too. Deduplicate actual expiries separately. Verified AAPL→AMD→^DJI with MULTI enabled. See [SVI risk report](../reports/mkt-svi-fit-risk-report.md). |
| SVI IV scale changes incorrectly with expiry | Fitting IV directly to a total-variance formula, or treating percent as fraction | Fit `w=(IV%/100)^2*T`; render `100*sqrt(w/T)`. Test reference translation and time scaling. |
| A five-parameter line appears despite insufficient quotes | Duplicate strikes counted as independent points or unsuccessful optimizer results rendered | Median duplicate strikes, require 8 distinct strikes and log-span>=0.05; only render converged, positive fits inside observed K span. Keep actual points on failure. |
| Smooth curve mistaken for an arbitrage-free surface | Independent positive SVI slices lack butterfly/calendar constraints | State the limitation in SVI DETAILS; a may be negative if total-variance minimum stays positive. |

### IV smile strike geometry and symbol identity (2026-09-13)

| Symptom | Root Cause | Fix |
|---|---|---|
| Put-only strikes disappear; spot line is absent; unequal K spacing looks uniform | Call-only join plus categorical strike X axis | Build numeric union of call/put strikes and use numeric K axis with exact S reference. New MKT IV uses this; old stock SurfaceView remains outside scope. See [risk report](../reports/mkt-iv-smile-risk-report.md). |
| No-options stock looks like a backend outage | Next.js proxy converts404 to502 | Preserve backend status/detail; distinguish no options from fetch failure. |
| IV from another symbol or expiry remains visible | Previous-query data reused without matching identity, or backend silently selects a fallback expiry | Key query by symbol+expiry and verify both before drawing; never substitute prior symbol's curve while loading. |
| Heatmap dimensions stale after returning from IV/ROT | ResizeObserver remained on the unmounted matrix element | Reattach whenever matrix mode remounts. |

### ATR pane line colors and missing history (2026-09-13)

| Symptom | Root Cause | Fix |
|---|---|---|
| A regime line bridges a missing candle, or missing history receives a trading color | Native line rendering connects valued points even across whitespace; treating missing inputs as false mislabels unknown history | Emit native `{time}` whitespace points and make the preceding valued point's outgoing segment transparent; keep classification unknown/gray until all windows exist. ATR resets recursive state after invalid HLC. See [ATR risk report](../reports/atr-regime-rendering-risk-report.md). |
| A low-ATR downtrend looks like an accumulation zone | ATR measures range without price direction | Require both close above EMA and EMA rising over the configured slope span. Threshold uses prior ATR% values only; zero baseline remains unknown. |

### Chart fit vs persisted alert parameters (2026-09-13)

| Symptom | Root Cause | Fix |
|---|---|---|
| A “From chart” alert disagrees with fitted BB/%B bands | Persisted n/k are the manual fallback; chart-local fitted n/k depend on loaded bars, unlike the daily alert evaluator | Fitted BB/%B are omitted from active-chart quick alerts. Fixed catalog/custom rules remain available; never pass `fitCostBps` as a signal parameter. See [integration risk report](../reports/bollinger-fit-integration-risk-report.md). |
| Turning Fit off restores the wrong manual window in DAYS mode | Factory config already contains scaled bar counts | Reopen from `config.inputParams` (original spec) and keep raw manual n/k independent of the fitted grid, which always counts bars. |

### Backtest / Statistical Evaluation

| Symptom | Root Cause | Fix |
|---|---|---|
| Last h outcomes counted as failures despite unknown future; parity test passes | Numeric NaN compared with threshold becomes boolean False; test checks intermediate excursion only | Never let a threshold comparison be the label. `(m >= k).where(m.notna())` keeps it float64 1.0/0.0/NaN so `.dropna()` can still find the unknowns; assert on the *label* column per horizon, not on the float measure beside it. **FIXED 2026-09-09** — `D:/Agents/Claude/backtest-idea/05_bbw_squeeze/features.py::_label` + `test_parity.py` check 5. Found by [BBW audit](../reports/bbw-squeeze-2026-09-09-risk-report.md) |
| Model claims to beat production but budget/benchmark changes after parameter search | Benchmark flag is rebuilt from selected model feature config; final evaluation lacks CV purge and common eligibility | Benchmark against the rule production actually runs, rebuilt from its own frozen params, and score both on the same `.dropna()` row set at the same alert rate. **FIXED 2026-09-09** — `D:/Agents/Claude/backtest-idea/05_bbw_squeeze/run.py::stage_d`. Found by [BBW audit](../reports/bbw-squeeze-2026-09-09-risk-report.md) |
| Reported median wait is shorter than time where half the population experienced event | Median calculated only among observed hits, excluding right-censored cases | Give never-crossed rows `inf`, not NaN, so they stay in the cohort and push the median right; give `NaN` only to rows whose future was never observable, and drop those. **FIXED 2026-09-09** — report §9.2 (medians moved 7→9 / 8→10 days). Found by [BBW audit](../reports/bbw-squeeze-2026-09-09-risk-report.md) |

### Frontend / React

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| localStorage setting not saved after refresh | `useEffect([dep])` fires on mount → overwrites loaded value with DEFAULT | Read in `useState` initializer, write in `useEffect([val])`. See pattern in CLAUDE.md |
| Portfolio COST column (per-row) doesn't sum to the COST badge/ANALYTICS total for accounts holding non-THB positions bought a while ago | `OpenPositionsTab.tsx` row-level `costVal` computed `entryNative × volume` using `toBase()` = **today's live FX**, while backend `cost_basis_base` (used by the badge + ANALYTICS OPEN COST BASIS) uses **entry-date FX** — the two diverge as USD/THB moves after purchase | **FIXED 2026-07-14** — row `costVal` now prefers `p.cost_basis_base` (entry-date FX), only falls back to live-FX `entryNative × volume` when backend didn't supply it or a manual cost override is set. See `sessions/2026-07-14-cash-transfer-followup.md` |
| Changing an indicator's params in IndicatorPicker does nothing (pane keeps the old numbers) | `useChartIndicators.toggleIndicator` decided "is this the same pane?" from the **instance id the factory returns**. Ids are only as specific as the factory makes them — `rsi-30` encodes its period, but `createSdHeatmap` returns a constant `"sd-heatmap"`, so every settings change compared equal to what was mounted and hit `return prev` | **FIXED 2026-08-23** — compare `specParamsKey(spec, entry, ctx)` (`chart/windowUnits.ts`): sorted keys + defaults merged + compared AFTER the days→bars conversion. Both branches of `addIndicator` were affected — panes (sd-heatmap, and `hotThreshold` on flow-toxicity) and overlays (VWAP's `bands`; its id carries no params either). Overlays still STACK when the derived id differs (sma-20 + sma-50), and now REPLACE when it matches but the settings differ. Note the picker also needs the indicator name clicked again to confirm a dropdown change |
| Polymarket URL → "Page not found" | Using market `slug` (has trailing `-789-924-249`) instead of `event_slug` | Use `events[0].slug` from Gamma API pool → stored as `event_slug` in signal |
| Section content clipped, can't scroll | Root div missing `h-full` → `overflow-hidden` on parent clips content | Root: `flex flex-col h-full`, header: `shrink-0`, scroll zone: `flex-1 overflow-y-auto` |
| Jotai `atomWithStorage` wrong default on load | Next.js SSR hydrates with server value (undefined window) before client localStorage read | Use `useState` initializer with `typeof window === "undefined"` guard instead |
| React Query stale data after mutation | Missing `queryClient.invalidateQueries()` after POST/PATCH/DELETE | Call invalidate with matching queryKey after mutation |
| Manual `useEffect` fetch guard causes infinite abort/retry loop (network tab floods with `net::ERR_ABORTED`) | Effect fetches data and is guarded by the *same state it sets* (e.g. `if (data || loading) return;` inside an effect with `[data, loading, ...]` deps) — any code path that leaves `data` null after a fetch attempt (error, or a valid-but-empty response not treated as "fetched") never satisfies the guard, so the effect refires forever | Don't gate a fetch effect on state it writes. Use a `useRef` to track "already fetched for key X" — refs never appear in dependency arrays so they structurally cannot retrigger the effect. Fixed 2026-07-15 in `RiskTab.tsx` ERC PARITY fetch (`parityFetchedFor` ref pattern) |
| Chart labels truncated | Missing `interval={0}` on Recharts XAxis | Add `interval={0}` to all bar chart XAxis |
| `<ModularChart>` tears down and rebuilds the entire chart on every parent render (candles flash, pane drags lost) while EVT is on | `useStockEvents` built its `markers` array fresh on each call, so the `useMemo` in `useChartIndicators` that wraps it saw a new identity every render — and ModularChart's build effect lists `eventMarkers` in its deps | ✅ FIXED 2026-08-04 — `markers` is now `useMemo`'d on the two query payloads inside `useStockEvents`, with a shared `EMPTY` constant for the no-data case. **Any array/object passed to `<ModularChart>` must be referentially stable** — the same trap applies to `indicators`, `overlays`, `data` |
| A field is computed in a hook, typed on the interface, and never appears anywhere in the UI | Nothing consumes it. `ChartEventMarker.detail` was built in `useStockEvents` for years but `ModularChart` only forwarded `time/position/shape/color/text/id` to `createSeriesMarkers`, and lightweight-charts markers have no tooltip or click API at all | Before adding a display field to a chart marker, check that a component actually renders it. Marker interactivity has to be built separately — see `chart/EventDetailPopover.tsx` (opened from `subscribeClick`, not from the marker itself) |

### Backend / FastAPI

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| Whole server freezes during one request | `async def` endpoint calls blocking `requests`/yfinance → blocks event loop | Use plain `def` (FastAPI runs in threadpool). Fixed: tail_risk, sectors 2026-06-10. ⚠️ options.py/paper_trading.py still mix `await`+blocking → need `run_in_executor` |
| N concurrent requests all hit yfinance on cache miss (stampede) | router does `get`→compute→`set` (no coalescing) | Use `_cache.get_or_set(key, fn)` from `cache.py` (per-key Event coalescing, already built) |
| สัญญาณเทียบ 2 series แล้วยิงผิด (เช่น VIX backwardation) | `s.dropna().iloc[-1]` หยิบค่าล่าสุด**ที่ไม่ใช่ NaN** — ถ้า series นั้นค้าง (yfinance `^VIX9D`/`^VIX3M` หยุดที่ 2026-07-17 ขณะ `^VIX` ถึง 08-14) จะเอาค่าคนละวันมาเทียบกัน | เช็ค staleness ก่อนเทียบ: ถ้า last bar เก่ากว่า reference series > 1-2 วัน ให้คืน `None` และ **ไม่ตัดสิน** signal นั้น ดู `reports/tail-risk-debt-report.md` A1 |
| rolling window ไม่เคยให้ค่า signal ไม่เคยยิง | `rolling(252, min_periods=60)` แต่ fetch แค่ 70 วันปฏิทิน = 48 trading days → NaN ทั้งคอลัมน์ เงียบๆ (`tail_risk.py` g8_layer_a) | นับเป็น **trading days** ไม่ใช่ calendar days: lookback ต้อง ≥ `min_periods × 1.45` และ log/assert เมื่อ series ออกมาเป็น NaN ล้วน |
| หน้าจอ risk ขึ้น "ALL CLEAR" ทั้งที่ backend ล่ม | helper แบบ `except: return {}` ทำให้ signal ที่ดึงจาก router อื่นไม่ถูก set → นับเป็น False = ปลอดภัย (fail-open) | risk monitor ต้อง fail-closed: แยก `unknown` ออกจาก `false` และส่ง `data_health` ขึ้นหน้าจอ |
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
| NAV chart empty / `portfolio_nav_snapshots` 0 rows | `_batch_fetch_prices` return shape changed float→dict (aeb4ee4) but `_maybe_capture_nav` still does `(price - entry)` → TypeError swallowed by `except Exception: pass` | **FIXED 2026-07-03** — unpacked `quote.get("price")`, `except` now `logger.exception`. Pattern stays: never `except: pass` around DB writes. ⚠️ Synthetic backfill (`backend/scripts/backfill_nav.py`) was tried and **reverted same day** — `trades.date_exit`/`date_entry` contain placeholders (21 exits on Sat 2026-06-06, 22 entries 2025-01-01) so reconstruction inflates NAV with long-sold positions. NAV history accrues from live capture-on-view only, starting 2026-07-03. See `memory/reports/analytics-db-nav-risk-report.md` |
| Dividend/trade total looks ~30x inflated in ANALYTICS (THB) but correct-looking in native-currency views | Row's `currency` column mislabeled (e.g. `USD` on a value the user actually entered in THB) — `total_*_base` multiplies by FX on top of an already-converted number | Sanity-check `amount_per_unit` against the ticker's real dividend/share (or price) history before trusting a currency tag; a value 30-35x too big for its labeled currency in THB/USD terms is the tell. Fixed 2026-07-14 for 7 Dime dividend rows (JEPQ/UNH/META/ABBV/VT/MSFT) — see `sessions/2026-07-14-cash-transfer-followup.md` |
| Open-position `cost_basis_base` changes between two reads seconds apart with no new trade | Cloud Sync (`backend/sync/`) pulled a fresher `trades` row from another device mid-session, changing the weighted-avg `price_entry` — **not benign**, confirmed inflated vs real broker cost by ~12-15% on 3/7 Dime positions (GOOGL/NFLX/MSFT) | Do not treat as "just FX drift" — verify against broker statement before trusting `OPEN COST BASIS`/`MARKET VALUE`/CASH tile for accounts with sync active. See `reports/dime-sync-cost-basis-risk-report.md` (2026-07-14) |
| NAV / PORTFOLIO VALUE steps up sharply overnight with no market move | NAV = `open_cost + unrealized` only, **cash is never counted** ([portfolio_v2.py:2105](../../backend/routers/portfolio_v2.py)). Buying with untracked idle cash converts invisible cash → counted holdings, so NAV jumps by the purchase cost. Snapshot is once/day capture-on-view, so a buy made after that day's snapshot lands on the *next* day → the step looks like an overnight gain | Expected by design — read the chart as "market value of what's held", not total wealth. `invested_capital` staying flat across the step proves no deposit happened. Verified 2026-07-16: 07-15→07-16 +฿395,653 = ฿371,000 BH cost injection + ฿24,653 real MTM |
| `open_cost_basis` drifts ±0.3%/day on days with **no** trade writes at all | USD trades with `exchange_rate = 1.0` sentinel fail the `stored > 1` test in `convert_amount` → fall through to dated `fx_rate` lookup → if `fx_rates` lacks that date it fail-softs to **live** FX, re-marking held positions' cost every day | Dormant since 2026-07-14 (fx_rates backfilled 2016→2026). Returns for any USD trade dated **after** `MAX(fx_rates.date)`. THB-account cost is immune (`src == dst` early return) — a THB-only account staying flat while a USD one wobbles is the tell. See `reports/nav-entry-fx-sentinel-risk-report.md` |

### Next.js / Proxy

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| Next.js proxy 502 | Python backend not running on port 8000 | Start backend: `python -m uvicorn main:app --port 8000 --reload` |
| `POST /api/v2/portfolio/X/subpath` returns 405 | Parent `route.ts` (e.g. `cash/route.ts`) only forwards to a hardcoded backend path (`/cash`), no passthrough for sub-paths | Add a dedicated `X/subpath/route.ts` file (Next.js file-based routing, same pattern as `cash/[id]/route.ts`) — one file per distinct backend path, not just per resource. Hit 2026-07-14 adding `cash/transfer` |
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
| Converting a trade/dividend with `portfolio_accounts.currency` | Mixed-market accounts (e.g. Dime holding `BH.BK` + US stocks) scale THB instruments as USD | Use stored `trades.currency` / `dividends.currency`; convert each row via `portfolio_currency.py`, then sum. Symbol inference is migration/NULL fallback only |
| `useEffect([dense])` to sync columns from dense toggle | Effect fires on mount → overwrites localStorage-loaded cols | Call `setShowCols()` directly in click handler |
| Using `language=1` or `language=2` for SEC One Report | API silently returns empty / wrong data | Use `language=T` (Thai) or `language=E` (English) |
| Using Buddhist Era year for SEC One Report (`report_year=2566`) | API returns no data | Use Gregorian year (`report_year=2023`) |
| Want the grid behind the candles but not behind RSI / volume | lightweight-charts has ONE grid option for the whole chart (`grid.vertLines` / `horzLines`) — `IPaneApi` (v5.2) exposes height, index, series and an element, but no per-pane grid | Built-in grid off, price pane draws its own bottom-layer overlay (`price-grid-overlay.ts`). Masking the grid inside each sub-pane with a background fill also works, but leaves the grid drawn under every indicator and only hidden by z-order — don't go back to it |
| Looking for the EVT / EVENTS toggle in the indicator bar and not finding it | Removed 2026-08-31 — the rail is on for every equity candle chart. It was a toggle-off trap: an ex-dividend gap reads as a sell-off when the rail is hidden, and the state persisted in `localStorage["chart:show-events"]`, so one accidental click hid events on every chart forever | `useChartIndicators` derives `showEvents = supportsEvents && chartType === "candle"` — there is no atom and no button. `chartShowEventsAtom` is gone; the stale localStorage key is harmless |
| EVT rail always looks a quarter behind — the next dividend/earnings never shows, only the last one | Two causes stacked: `/api/stock/dividends` returned `ticker.dividends`, which is **paid** history and by definition has no future date; and `placeEvents()` dropped any marker with no bar at or after its date, which is every future event | ✅ FIXED 2026-08-31 — endpoint adds `upcomingDividends` from `ticker.calendar` (guarding the stale case: between ex-date and the next declaration Yahoo still reports the one that just paid), and `placeEvents()` keeps future markers with `future: true`, drawn as dashed chips queued past the right edge. Verified KO ex-div 2026-09-15 |
| Every historical event piles onto the first candle of a short chart (one giant `···120` chip at the left edge) | Resolving an event forward to "the first bar at or after its date" is right for a holiday, but unbounded it drags 20 years of dividends onto bar 0 of a 3M window. The old `createSeriesMarkers` path hid this because it matched bar dates exactly | ✅ FIXED 2026-08-04 — `findEventBarIndex()` drops anything more than `MAX_BACKFILL_DAYS` (4) before the first bar, so a long weekend still resolves but pre-history does not. Verified on COST 3M: 122 markers → 3 placed |
| Canvas drawing cannot be observed from the Browser pane's `javascript_tool` | It evaluates in an **isolated world** — the DOM is shared but prototype patches are not, so hooking `CanvasRenderingContext2D.prototype.fillText` records nothing from the page's own canvases (a full chart rebuild registers zero `beginPath` calls). Synthetic `MouseEvent`s dispatched from there also never reach lightweight-charts | Don't try to verify canvas output this way. Test the pure geometry/labelling functions with `node --test`, drive real clicks with `computer` against a `pointer-events:none` probe element placed at a computed coordinate, and fall back to a screenshot for anything genuinely visual |
| Measuring an earnings reaction from the report day's own bar | Yahoo stamps most US reports `16:00` — after the close. That day's bar priced nothing; the move lands on the next one. Anchoring on the report bar reports the *previous* day's unrelated move as the earnings reaction | Read the hour off `ChartEventMarker.reportedAt` (`earningsSession()` in `chart/event-reaction.ts`): `AMC` shifts the whole window one bar right and takes the report day's close as the baseline. `BMO`/unknown stay on the report bar |
| Grouping intraday bars into sessions by browser-local date (`new Date(t*1000)` → `getFullYear()-...`) | US session (21:30–04:00 ICT) splits across two Thai dates → wrong per-session aggregates (VP POC/VA) | ✅ FIXED 2026-07-05 — `volume-profile.ts` `groupBySession()` ใช้ time-gap (`SESSION_GAP_SEC = 4h`) แทน date-key; crypto 24/7 ใช้ `MAX_SESSION_SPAN_SEC` guard. ดู `plans/vp-indicator-upgrade.md` |

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
| `CLIPPINGS_DIR` | Clippings view empty (default: `./data/clippings`) |
| `SYNC_DIR` (unset/unreachable) | Cloud sync silent no-op — app runs local-only (fail-soft, never blocks startup); SYNC chip shows OFFLINE |
| `IV_SNAPSHOT_INTERVAL=0` | ATM IV recorder off → SD heatmap stops gaining columns. **The gap is permanent**: the provider exposes only the CURRENT IV of a chain, so a day nobody recorded can never be back-filled |

## Anti-pattern: SQLite `.db` on a cloud drive

**Never put `portfolio.db` (or any SQLite file) directly inside a Google Drive / Dropbox / OneDrive folder.** Cloud clients sync raw bytes and do not understand SQLite's WAL (`-wal`/`-shm`) sidecar files or file locks. Two machines touching the same synced `.db` → corruption.

**Correct pattern (see `backend/sync/`):** keep the `.db` local (working copy); exchange only validated **JSON snapshots** through the cloud folder. Snapshot writes are atomic (temp + `os.replace`) and hash-validated on read so a half-synced Drive file is skipped, not loaded. Merge is **three-way, field-level** against `.sync_base_<db>.json` (the merged state this device last agreed on); deletes use `sync_tombstones` (trigger-recorded) so a deleted row does not resurrect on the next merge.

## Cloud sync: four failure modes fixed 2026-08-11

**1. SYNC chip permanently red.** `os.getenv("SYNC_DIR")` returned the path **with literal quotes** (`'G:\My Drive\...'`) because the value was exported by the shell, and `load_dotenv()` does not override an existing env var — so the clean `.env` line was never used. The quoted path never exists → `reachable=false` → red dot, and `pull()`/`push()` returned `{"status":"offline"}` silently for 4 days. `sync/config.py:sync_dir()` now strips quotes. **Any env var holding a Windows path is suspect: check the running process's value, not the `.env` line.**

**2. Remote edits never arrived.** The background worker only pushed. `pull()` ran once at startup, so another device's changes needed a restart or a manual PULL. `_bg_loop()` now watches the peer hashes in `manifest.json` (cheap read, `SYNC_PULL_INTERVAL`, default 20s) and merges only when a peer actually pushed. Frontend `useSync` watches `last_pull` and invalidates portfolio queries when it moves on its own — an auto-pull changes the DB underneath React Query, which otherwise shows stale rows.

**3. Every merge reported dozens of false conflicts.** Two-way LWW called any differing row a conflict, so a device that had merely been offline for a week produced a conflict per stale row, forever (16/pull here), and the row-level winner discarded whichever fields the loser had legitimately edited. Fixed with the base snapshot: `changed_local`/`changed_remote` are now separable, so only same-field concurrent edits count. **A merge without a common ancestor cannot tell "stale" from "concurrent" — this is not tunable, it needs the third leg.**

**4. `paper_positions` lost fills.** It is a running total that `_execute_fill()` mutates incrementally, and LWW on a running total drops one device's fills (base 100, A→150, B→130, winner keeps one). Removed from `SYNC_TABLES`; rebuilt from `paper_fills` after every merge (`sync/derived.py`). **Rule: sync append-only base tables, recompute derived aggregates locally.** `paper_snapshots` stays synced — it marks each day at that day's prices and cannot be recomputed later.

**5. 🔴 DATA LOSS — closed trades reverted to open on every restart (same day, caused by fix 3).** The first cut of the 3-way merge used **one shared ancestor** for both sides. After a merge the base holds the merged (new) value while an offline peer's snapshot still holds the old one, so the peer read as "changed" on rows it never touched, local read as "unchanged" (it now equalled the base), and the stale value won. Six trades lost their exit data; the user re-entered one sale twice before the cause was found (`trade_audit_log` shows the same `SELL_FULL` at 08:49 and 14:56).

Fix: **per-peer ancestors** — `base["tables"]` for the local side, `base["peers"][device]` (that peer's snapshot as we last saw it) for each peer. An untouched peer then compares equal to itself and contributes nothing. No ancestor for a peer/row → fall back to row-level LWW; never guess one. Plus: "neither side changed but the values differ" means the two ancestors are from different eras — keep the merged side, it is not a conflict (that hole alone kept 16 false conflicts alive).

**Recovery, if this class of bug ever bites again:** `trade_audit_log` (never synced, local-only, append-only) stores `fields_changed` old→new plus a full row `snapshot` per action — it recovered the one row that no cloud snapshot had, because the daily backup had already been overwritten with the corrupted state. Cross-check `<SYNC_DIR>/snapshots/<other-device>.json` first (a peer that has not synced still holds pre-corruption data), then `backups/`, then the audit log.

**Rule that would have caught it: after any merge change, pull TWICE and diff.** A merge bug that reverts is invisible on the first pull — the answer looks right — and only shows on the second. `test_repeated_pull_does_not_revert` pulls three times.

Related: `updated_at` stamps are now millisecond (`strftime('%Y-%m-%d %H:%M:%f')`, space separator kept so old second-resolution rows still sort correctly). At second resolution two same-second edits compared equal and the winner fell out of file iteration order — which two machines can resolve differently and stay diverged. Ties now break on `str(value)`, identically everywhere.

## Bug: RISK tab blank — `float() argument must be ... not 'dict'` (fixed 2026-07-12)

**Symptom:** PORT → RISK shows nothing (blank). `GET /api/v2/portfolio/risk/metrics` returns HTTP 500 `{"detail":"Internal server error"}`. RiskTab silently swallowed the error → blank.

**Root cause:** `risk.py get_risk_metrics` set `pos["current_price"] = prices.get(pos_yf[i])`, but `_batch_fetch_prices` (portfolio_v2.py) returns `{sym: {"price":..., "prev_close":...}}` — a **dict**, not a number. `_compute_portfolio_risk` line ~315 then did `float(price) * vol` → `TypeError: float() argument must be a string or a real number, not 'dict'`.

**Fix:** extract `.get("price")` from the snapshot dict:
```python
snap = prices.get(pos_yf[i])
pos["current_price"] = snap.get("price") if isinstance(snap, dict) else snap
```
Same pattern used in the new `/risk/capm` endpoint. Also added an error state + RETRY button to `RiskTab.tsx` so a future backend 500 shows a message instead of a blank pane.

## Bug: chart indicators reset on every mount — `atomWithStorage` + `getOnInit` (fixed 2026-07-27)

**Symptom:** picked indicators (and the VP toggle) came back as the defaults after switching views or reloading. Custom periods were also lost — `rsi-30` came back as `rsi-14`.

**Root cause (two stacked bugs):**
1. jotai's `atomWithStorage` defaults to `getOnInit: false`, so the atom's value on the *first* render is the DEFAULT; the stored value only arrives on a later subscription tick. `useChartIndicators` read the atom inside a `useState` initializer, capturing the defaults forever.
2. Only instance ids (`"rsi-30"`) were persisted, and `buildIndicatorsFromIds` rebuilt everything except `volume`/`ema-N` via `entry.factory()` — i.e. with registry defaults, dropping the params the id encoded.

**Fix:**
- Every `chart:*` atom now passes `{ getOnInit: true }` (4th arg; pass `undefined` for the storage arg).
- Persist `IndicatorSpec[]` (`{ id, params }`) in `chart:indicator-specs`, and derive `indicators` with `useMemo` instead of copying into `useState`. Transient config (fear-greed's `preloadedData`) lives in a separate non-persisted `runtimeConfig` map.

**Rule:** any `atomWithStorage` whose value is read in a `useState`/`useMemo` initializer MUST set `getOnInit: true`, otherwise it silently serves defaults on mount.

## Bug: stacked indicator panes overlap the volume pane (fixed 2026-07-27)

**Symptom:** with several pane indicators active the sub-panes appeared to bleed into each other / into volume, and the chart didn't respond to the panel being resized.

**Root cause:** `ModularChart` sized itself as `height + paneCount * 80` and never measured its parent. Inside `flex-1 min-h-0` (every chart view) that total height overflowed the parent's `overflow-hidden` and got clipped.

**Fix:** `computePaneLayout()` fits panes to the measured parent height (`SUB_PANE_MIN 44` … `SUB_PANE_MAX 80`, `MAIN_PANE_MIN 140`), a `ResizeObserver` on the wrapper feeds it (floored to an 8px step so a 1px reflow doesn't rebuild the chart), and the wrapper is `overflowY: auto` so the minimums scroll instead of clipping.

## Bug: Volume Profile labels get a white background in light theme (fixed 2026-07-27)

**Symptom:** in light mode the V-POC / VA-H / VA-L labels drew a white box on the (black) chart. Switching the app to dark mode "fixed" it.

**Root cause:** canvas overlays received the theme flag `isDark`, but every chart panel hardcodes `background: #050505` regardless of theme — so the surface is always dark while `isDark` said otherwise.

**Fix:** `ModularChart` derives `surfaceDark` by walking up from the chart container to the first non-transparent background and comparing its luminance, and passes THAT to `overlay.draw(...)`. Canvas overlays must never take their colors from the theme flag.

## Bug: Volume Profile drawn *under* the candles (fixed 2026-07-27)

**Symptom:** after the label-background fix, the VP bars and the V-POC / VA-H / VA-L labels were still unreadable — the candlesticks painted over them.

**Root cause:** lightweight-charts positions its own canvases at `z-index: 1` (series) and `z-index: 2` (crosshair + price labels). `ModularChart`'s overlay canvases are later siblings in the DOM but had `z-index: auto`, and a later sibling with `auto` still loses to any positioned sibling with an explicit z-index.

**Fix:** both overlay canvases (full-chart session VP + right-side composite strip) now set `zIndex: OVERLAY_Z` (= 3) in `chart/ModularChart.tsx`. Any new canvas overlay must do the same — DOM order alone is not enough.

## Bug: indicator params silently ignored — picker config dropped at the call site (fixed 2026-07-27)

**Symptom:** editing a param in the indicator picker (SMA 20 → 50, RSI 14 → 30) did nothing. No new indicator, no change to the existing one, no error.

**Root cause (two stacked bugs):**
1. All four views wired the picker as `onAdd={(entry) => addChartIndicator(entry)}` — the arrow function **dropped the second argument**, the `config` object the picker had just collected. Every indicator was therefore built with registry defaults, which for an already-active indicator produced the same instance id and hit the duplicate guard → no-op.
2. Even with the config forwarded, `addIndicator` treated "a pane of this type already exists" as a hard no-op, so a param change on RSI/MACD/Stochastic stayed invisible.

**Fix:**
- `onAdd={addChartIndicator}` (pass the handler itself) in market-view, stock-view, crypto-view, fx-view.
- `addIndicator` now REPLACES the existing spec when a pane indicator is re-added with different params; overlays still stack (SMA 20 + SMA 50 is a legitimate setup).

**Rule:** when a callback prop takes optional extra arguments, forward the handler directly instead of wrapping it in an arrow that names only the first parameter.

## Bug: `npm run dev:all` / `dev:no-ollama` dumps a scary traceback on Ctrl+C (fixed 2026-08-01)

**Symptom:** hitting Ctrl+C on `npm run dev:all` prints a full Python `KeyboardInterrupt` → `asyncio.exceptions.CancelledError` traceback under `[BACKEND]` and looks like the backend crashed.

**It is cosmetic — verified with repeated real signal tests (2026-08-01):** every process exits 0, the reloader stops, and ports 8000/3000 are freed every single time, with or without the fix. Nothing was ever hung, leaked, or corrupted.

**Root cause (isolated by testing `--reload` on/off + solo uvicorn vs. full `concurrently` stack):**
Only reproduces with `uvicorn --reload`, and only reliably when `next dev` is running alongside it (timing-dependent — a bare `python -m uvicorn --reload` with no sibling process rarely triggers it, the full stack triggers it ~100% of the time). Sequence: the reloader's parent supervisor and the worker child are in the same process group, so a terminal Ctrl+C delivers SIGINT to both. The child's own SIGINT-triggered shutdown is already clean — but the parent, seeing the child not yet exited, sends an explicit SIGTERM (`uvicorn/supervisors/multiprocess.py: Process.terminate()`) that lands mid-shutdown. Uvicorn's `capture_signals()` (`uvicorn/server.py`) then re-raises the captured signal into `asyncio.Runner`'s own default SIGINT handler, which raises `KeyboardInterrupt` inside whatever coroutine happens to be resuming at that instant — usually the lifespan's `await receive()` — and asyncio logs the orphaned `CancelledError` via the `uvicorn.error` logger as a pre-formatted traceback **string with no `exc_info`** (not a real unhandled exception object).

**Fix:** `backend/main.py` adds `_SuppressReloadShutdownRace`, a `logging.Filter` on the `uvicorn.error` logger that drops only records where `exc_info` is `None` (so it can never hide a real logged exception) **and** the message text contains both `KeyboardInterrupt` and `asyncio.exceptions.CancelledError`. Verified with 4 back-to-back full-stack SIGINT tests (0/4 tracebacks) plus 3 unit cases (benign message dropped, a real `exc_info` error kept, an unrelated traceback-shaped message kept).

**Rule:** don't try to "fix" this via `concurrently` flags (`--kill-signal`, `--kill-timeout`, etc.) — the race is entirely inside uvicorn's own signal handling and reproduces even with a raw `kill -INT` to the process group, no `concurrently` involved. Any future noisy-shutdown report should first check whether it matches this exact pattern before assuming a new bug.

## Bug: DAY P&L showed the PREVIOUS session's move (fixed 2026-08-03)

**Symptom:** on a Bangkok morning, PORT → OPEN POSITIONS showed a day P&L for every US holding even though the US market had not opened. The figures were the *last completed session's* move (AAPL -7.35%, Friday's), presented as today's.

**Root cause (two independent bugs):**

1. **Stale session.** Yahoo keeps serving the last completed session's `regularMarketPrice` / `regularMarketPreviousClose` after a market closes. `marketState` was `PREPRE` and `regularMarketTime` pointed at Friday 16:00 ET, but nothing in the *numbers* reveals that — they are internally consistent, just from the wrong day. The existing `_stale_quotes` day-guard did not help: it guards OUR cache, not the upstream data.
2. **Wrong reference price.** The code used `fast_info.previous_close`, which yfinance derives from its own price history and which disagrees with the real prior close (AAPL 2026-07-31: `previous_close` 312.33 vs the actual 333.43 = `regular_market_previous_close`). Day P&L was therefore wrong *even during live sessions*.

**Fix:**
- `backend/market_session.py` — `is_current_session()` compares the exchange-local date of `regularMarketTime` against the exchange-local today. Fails OPEN (probe error / unknown tz / crypto+FX ⇒ "current") so a data hiccup never blanks the book.
- `_pick_prev_close()` in portfolio_v2 prefers `regular_market_previous_close`, falling back to `previous_close` (indices often report NaN — note `NaN != NaN` is the NaN check used).
- `/open-positions` nulls `day_pnl*` when the session is not current and adds `day_stale` + `day_session_date`; the UI renders `· ·` with a tooltip and tags the Today total with "(N pending)".

**Gotcha inside the gotcha:** cache the session probe by **exchange code** (NMS, SET, CMX), never by timezone. COMEX gold and Nasdaq equities are both `America/New_York`, but gold trades through the night the equities are shut — a timezone-keyed cache handed live gold the equities' "stale" verdict.

**Rule:** any day-change figure needs a freshness check against the exchange's own clock. Server-local dates get Asia/US pairs wrong by a whole day.

## Bug: stale pre/post-market quotes leak through `marketState` (fixed 2026-08-03)

**Symptom (latent):** the PRE/POST column gated on `marketState`, allowing `CLOSED` to display `postMarketPrice`. All weekend Yahoo reports `CLOSED` while still serving Friday's after-hours quote, so the column would have shown a two-day-old price as if it were live. Same family as the DAY P&L staleness bug above.

**Root cause:** `marketState` says which session type is *notionally* current, not whether the quote attached to it is from today. At 03:00 ET Monday, `marketState=PREPRE` yet `postMarketPrice` is still Friday 19:59's.

**Fix:** Yahoo ships `preMarketTime` / `postMarketTime` alongside the prices, in the same `.info` payload already fetched — no extra call. `_fetch_session_quote` nulls each side whose timestamp is not today's exchange-local date (`market_session.is_today_at`), and keeps `pre_date` / `post_date` in the payload so the UI can explain the gap.

**Related improvement:** when the regular session has not opened but an extended-hours session IS live, the DAY P&L cell now renders that move (`PRE +฿682 (+1.50%)`) instead of a blank — it is the only live number for that position. The "Today" total still sums regular-session P&L only, tagged "(N pending)".

**Rule:** never gate an extended-hours price on `marketState` alone — check the price's own timestamp.

## Bug: `regularMarketTime` overwritten with `datetime.now()` (fixed 2026-08-03)

**Symptom:** WATCHLIST showed `AMD $476.15 ▼-1.90%` badged **PRE-MARKET** at 14:20 Bangkok. Both parts were wrong: the numbers were Friday's regular-session move, and the US market was not pre-trading.

**Root cause (three layers):**
1. `stock.py` stamped `"regularMarketTime": int(datetime.now().timestamp())` — destroying the ONE field that reveals staleness. Every quote looked live by construction.
2. `SESSION_CONFIG` mapped `PREPRE` → label "PRE-MARKET". Yahoo separates trading from non-trading states: `PRE` is the 04:00–09:30 ET session, `PREPRE` is the dead overnight stretch before it. Same for `POST` vs `POSTPOST`.
3. `extendedSessionMove` / `ExtendedHoursPrice` accepted `PREPRE`/`POSTPOST`, so a last print from an ended session could render as a live extended-hours quote.

**Fix:**
- `stock.py` and `market.py` publish Yahoo's real `regularMarketTime` plus `quoteDate` / `isCurrentSession` / `marketState`; pre/post prices are nulled when their own timestamps are not today's.
- `PREPRE` / `POSTPOST` now label as CLOSED, and only `PRE` / `POST` produce an extended-hours price.
- `staleMoveStyle()` gives WATCHLIST and TICK DATA a dimmed (0.45) change with a weekday tag (`Fri`) and a tooltip, instead of hiding the row — the last close is still the most recent fact, it just is not today's move.

**Rule:** never overwrite a vendor timestamp with server time "for convenience" — it is the only evidence a consumer has about freshness.

## SEC EDGAR: 403 "Undeclared Automated Tool" (learned 2026-08-15)

**Symptom:** every EDGAR request returns 403 with an HTML page titled "SEC.gov | Your Request Originates from an Undeclared Automated Tool", so `feedparser`/`json` parsing silently yields zero entries.

**Root cause:** EDGAR rejects browser-style agents AND any User-Agent containing a parenthesised comment. `Mozilla/5.0 (compatible; BloombergTerminal/1.0)` → 403; `BloombergTerminal/1.0 (local research; admin@localhost)` → 403 as well.

**Fix:** plain `"<App>/<version> <contact-email>"` with no parentheses, plus `Accept-Encoding: gzip, deflate`:
```python
{"User-Agent": "BloombergTerminal/1.0 admin@localhost.com", "Accept-Encoding": "gzip, deflate"}
```
Used by `routers/news_watchlist.py` (`_SEC_UA`) and `routers/company_filings.py`. Stay under 10 req/s.

**Related:** `data.sec.gov` calls also want `Host: data.sec.gov` when the session sets its own default headers.

## Polymarket Gamma: `/markets?q=` ignores the query, `/public-search` does not (learned 2026-08-15)

**Symptom:** searching the 3,000-market pool client-side to find single-name equity markets missed most of them — low-volume ticker ladders never make the first 3,000 rows.

**Fix:** `https://gamma-api.polymarket.com/public-search?q=MU&limit_per_type=5` filters server-side and returns `events[]` with `closed` flags. Keep the pool scan only for the macro signal types. Match ticker/company against the event **title** — the search itself is fuzzy, and matching against `description` drags in every market whose blurb mentions a big-cap ("Costco" ↔ "…da Costa").

## yfinance `market_data.get_news()` returns blank NewsItems (open, seen 2026-08-15)

**Symptom:** `market_data.get_news("TSLA")` yields 5 `NewsItem(title='', url='', ...)` — every field empty, so callers drop all of them.

**Cause:** newer yfinance nests the payload under `entry["content"]` (`canonicalUrl.url`, `provider.displayName`, `pubDate`); the typed wrapper still reads the flat pre-2025 shape.

**Workaround in use:** `routers/news_watchlist.py::_src_yfinance` calls `yf.Search(symbol).news` first and falls back to `yf.Ticker().news` with the `content` shape. The contract wrapper in `sources/` still needs fixing.

## CAPM β/α ใน PORT → ANALYTICS (2026-08-15) — engine แก้แล้ว 🟢 / benchmark ไทยยังค้าง 🟡

`GET /api/v2/portfolio/risk/capm` — 3 บั๊กซ้อนกัน (`reports/capm-beta-alpha-risk-report.md`):
1. `risk.py:355` `min_len` ตัดอนุกรมทั้งพอร์ตให้สั้นเท่าหุ้นที่ประวัติสั้นสุด — SKHU (19 แท่ง) ทำให้พอร์ต 15 ตัวเหลือ n=23 ทั้งที่ lookback=252
2. `_fetch_returns` คืน `.values` (ทิ้ง DatetimeIndex) แล้วจับคู่ด้วย `[-n:]` = จับคู่ตามตำแหน่งแถว ไม่ใช่วันที่ — BTC-USD (365 แท่ง/ปี) vs SPY (251) ทำให้ InnovestX ได้ β = −0.269 ทั้งที่ค่าจริง +1.682
3. weight แปลงเป็น THB แต่ **return ไม่แปลง** → พอร์ตหลายสกุลได้ β/α ที่ไม่รวมผลค่าเงิน

อาการที่มองเห็น: `n_days` น้อยผิดปกติ, α เป็นหลักร้อย %, β ติดลบทั้งที่ถือ risk asset
ก่อนเชื่อเลข CAPM ให้ดู `n_days` และ `r_squared` เสมอ — R² < 0.1 แปลว่า benchmark ผิดตลาด (Finansia vs SPY = 0.010)

**แก้แล้ว 2026-08-15** (`risk.py`): `_fetch_close_frame` คืน DataFrame มี DatetimeIndex, `_aligned_returns` reindex บนปฏิทินเดียว + คัดหุ้นประวัติ <60 แท่งออก (ไม่ตัดคนอื่น) + บวก FX log-return, `_regress_capm` join ตามวันที่และปฏิเสธ ndarray, เกณฑ์ขั้นต่ำ `max(20, lookback×0.6)`. UI แสดง `β` (สกุลรายงาน) + `β USD` (สกุลเดิม) + ⚠ เมื่อ R²<0.10 (หรี่ α ทิ้ง) + รายชื่อหุ้นที่ถูกคัด
**ยังค้าง:** benchmark ของขาไทย — `^SET.BK` บน Yahoo ค้างตั้งแต่ 2026-07-17 ต้องใช้ `THD` (หัก FX ก่อน) เป็น fallback

**รอบที่ 2 (RET ANN / α)** — `port_returns = R @ w` ถ่วงน้ำหนัก **log return** ซึ่งผิด (log บวกข้ามเวลาได้ ไม่ใช่ข้ามสินทรัพย์) ทำให้ RET ANN ต่ำไป 53pp และ α ต่ำไป 16pp → แก้เป็น `log1p(expm1(R) @ w)`
และที่ใหญ่กว่า: RET ANN/α แบบ holdings-based คือ **look-ahead** (น้ำหนักวันนี้ × ผลตอบแทนอดีต — SNDK 40.7% × +3585% ทั้งที่เพิ่งซื้อ ได้จริง +17.7%) → เพิ่ม `_realized_twr()` สร้างน้ำหนักรายวันจาก trade log (`date_entry`…`date_exit`, น้ำหนักจากราคาปิดวันก่อน, รวม closed lots, ไม่รวมเงินสด) แล้วรายงาน `beta_realized`/`alpha_realized_annual_pct`/`twr_annual_pct` แทน; **เลิกแสดง α แบบ holdings-based**
⚠️ TWR ≠ P&L จากต้นทุน — TWR +86.6%/1Y อยู่คู่กับพอร์ต −31.5% จากต้นทุนได้ เพราะ AJ.BK ร่วงจาก ฿21 ก่อนหน้าต่าง 1 ปี (1 ปีล่าสุด +57%). "เงินเราทำได้เท่าไหร่" ให้ดู XIRR ในการ์ด RETURNS
⚠️ ล็อตหุ้นไทยหลายตัวมี `date_entry = 2025-01-01` (placeholder ตอน import) — ถ้าวันที่แบบนี้ตกอยู่ในหน้าต่างที่วิเคราะห์ TWR จะระบุช่วงถือผิด

**รอบที่ 3 (α)** — α เดิม `alpha_daily × 252` เป็น arithmetic ในหน่วย **log** แต่วางข้างคอลัมน์ผลตอบแทนแบบ geometric ใต้ป้าย `%` เดียวกัน → อ่านได้ +52.6% ทั้งที่ excess จริง +94.4% แก้เป็น `port_ann − [rf + β(bench_ann − rf)]` (geometric ทั้งสองฝั่ง) และเพิ่ม `excess_vs_benchmark_annual_pct` (ชนะดัชนีดิบ)
เพิ่ม `alpha_t_stat` + `alpha_significant` (|t| ≥ 2) — พอร์ตกระจุกให้ α ใหญ่ที่ error bar กว้างกว่าตัวมันเอง (Dime +96.8% แต่ t=1.87, 95% CI ครอบ 0) UI หรี่ α เมื่อไม่ significant
ตาราง CAPM ตอนนี้: `β HEDGE` (ของที่ถือวันนี้ — ใช้ sizing hedge) · `HEDGE` (β × MV = notional ดัชนีที่ต้อง short) · `β REAL` · `vs IDX` · `α CAPM` · `t` · `R²` · `N`. TWR ANN ถอดออกจากจอแล้ว (ยังคำนวณอยู่เบื้องหลังเพราะ α ต้องใช้)

**รอบที่ 4 (rf)** — rf ใน CAPM ต้อง (1) **สกุลเดียวกับผลตอบแทน** และ (2) **อายุสั้นตรงกับความถี่รายวัน** ใส่ US Treasury กับอนุกรม THB = บันทึกส่วนต่างดอกเบี้ย THB–USD (1.00% vs 3.87%) เป็น α ติดลบ; ใช้ yield 10 ปีกับผลตอบแทนรายวัน = คิดค่า duration ที่พอร์ตไม่ได้ถือ
`_risk_free()` ดึงสด: THB → BOT policy rate, USD → FRED `DGS3MO`, cache 12 ชม., ล้มเหลว → `RF_FALLBACK` และ **ระบุว่าเป็น fallback**. `rf_annual` เป็น optional param (ไม่ส่ง = auto), response มี `rf_source`/`rf_series`/`rf_as_of`/`rf_currency` และแสดงบนหัวการ์ด
⚠️ ตาราง Damodaran ctryprem = **ERP + country default spread** สำหรับ cost-of-equity มองไปข้างหน้า **ไม่ใช่ rf** และอัปเดตปีละ 2 ครั้ง

**รอบที่ 5 (2026-08-16) — ยุบเหลือ identity เดียว** `α = Rp − [rf + β(Rm − rf)]`
`Rp` = CAGR/XIRR จาก `/returns` · `Rm` = benchmark ช่วงเดียวกันผ่าน `_index_return()` · `β` = Σwᵢβᵢ ของที่ถือวันนี้ · **ไม่มีตัวไหนใช้ `date_entry`/`date_exit` เลย**
ลบ `_realized_twr()` และ field realized/twr/t-stat ทั้งหมดออก (~4.5k อักขระ)
⚠️ **ต้นเหตุจริงคือข้อมูล**: 20/79 ล็อตมีวันที่ที่ราคาไม่ตรงตลาดวันนั้น (AJ.BK บันทึก 21.03 ตลาด 3.58 = ผิด 487%), closed lots 10/53 ราคาปิดไม่ตรงวันปิด → สถิติใดก็ตามที่พึ่งวันที่จะผิดเงียบ ๆ **ตรวจได้ด้วยการเทียบราคาที่บันทึกกับราคาตลาด ณ วันที่นั้น**
⚠️ สัมประสิทธิ์ของ rf ใน α คือ **(1−β)** — β>1 การขึ้น rf ทำให้ α **สูงขึ้น** ไม่ใช่ลดลง

**CAGR ใน `/api/v2/portfolio/returns` มีตัวส่วนบวม (2026-08-16)** 🟡 open — `portfolio_v2.py:2411` `a.invested += cost` บวกทุกครั้งที่ซื้อ รวมเงินที่ขายแล้วหมุนกลับมาซื้อใหม่ → บัญชีที่เทรดบ่อยถูกกดต่ำตามจำนวนรอบ (Dime ซื้อรวม 4.70M บนเงินจริง 763K = บวม 6.2 เท่า → CAGR 3.33% ขณะที่ XIRR 13.06%)
อาการ: การ์ดบนโชว์ `Total Return +34.0%` (P&L ÷ เงินที่ใส่จริง, สะสม) แต่ CAGR โชว์ +3.3% — ตัวเลขคนละตัวส่วนคนละหน่วย
CAPM `RET` เปลี่ยนไปใช้ **XIRR** แล้ว (กระแสเงินสดมีวันที่ เงินคืนไม่ถูกนับซ้ำ) แต่การ์ด RETURNS ยังใช้ CAGR ตัวเดิมอยู่

## Bug: `events.filter is not a function` — white screen เมื่อ backend สะดุด (open, พบ 2026-08-17)

**Symptom:** panel ที่ไม่เกี่ยวกันหายไปทั้งแถบ + console `TypeError: events.filter is not a function` หลัง `502 (Bad Gateway)`

**Cause:** `useAlertEvents` ([useAlertRules.ts:166](../../components/bloomberg/hooks/useAlertRules.ts)) ใช้ `.then(r => r.json())` โดยไม่เช็ค `r.ok`. Next proxy ตอบ `{ "error": "..." }` เมื่อ backend timeout → React Query เก็บ **object** เป็น success data → `query.data ?? []` ไม่ช่วย (object เป็น truthy) → `events.filter(...)` throw ที่ระดับ layout ซึ่งไม่มี error boundary

**Pattern ที่ต้องระวังทั่วโปรเจกต์:** ทุก `queryFn` ที่เขียน `.then((r) => r.json())` แล้วผู้เรียกคาดว่าได้ array — `?? []` กันได้แค่ `undefined` ไม่ได้กัน error object. ต้อง `if (!res.ok) throw` + `Array.isArray(data) ? data : []`

ไม่ต้องดับ backend ก็เกิดได้ — endpoint ที่ 502/503 เป็นช่วง (yfinance rate limit) พอแล้ว
รายละเอียด + จุดที่ throw ทั้งหมด: `reports/alert-events-shape-risk-report.md`

## ATM IV: `expirations[0]` มักเป็น 0DTE และ mid ของมันไม่มีความหมาย (แก้แล้ว 2026-08-17)

**Symptom:** `σ_mid = (IV_call + IV_put)/2` ได้ค่าเพี้ยน — วัดสดวันที่ 17 ส.ค. 2026 ได้
SPY call 12.3% / put 15.8%, AMD call 19.5% / **put 59.7%** (ต่างกัน 40 vol points)

**Cause:** `ticker.options[0]` = expiry ที่ใกล้สุด ซึ่งบนดัชนี/หุ้นใหญ่มี expiry รายวัน/รายสัปดาห์
→ ได้ 0DTE ที่ ATM IV สะท้อน pin risk + gamma ไม่ใช่มุมมองต่อ vol 30 วัน
call กับ put ฝั่งเดียวกันจึงแยกกันคนละทาง และ mid ไม่มีความหมาย

**Fix:** `routers/options.py::pick_snapshot_expiry()` — เลือก expiry ที่ `|dte − target|` น้อยสุด
โดยตัด `dte < IV_SNAPSHOT_MIN_DTE` (7) ออกก่อน, tie แตกไปทาง expiry ยาวกว่า
`/sd-bands` ก็เลือกด้วย `MIN(ABS(dte − horizon_days))` ต่อวัน (ไม่ใช่ `MIN(dte)`) + กรอง `dte >= 7`

**หลังแก้:** SPY 13.3/12.3, AMD 53.4/54.1 — call/put ตรงกันแล้ว

**ใช้ซ้ำได้:** ทุกที่ที่จะอ่าน IV/Greeks จาก chain ต้องเลือก expiry ตามเทเนอร์ที่ต้องการ
ห้ามหยิบ `expirations[0]` — เว้นแต่ต้องการ 0DTE จริงๆ

## FastAPI: เรียก endpoint coroutine ตรงๆ จาก background job = `Query` object หลุดเข้าโค้ด (แก้แล้ว 2026-08-18)

**Symptom:** `TypeError: unsupported operand type(s) for -: 'int' and 'Query'` — และเพราะ caller
จับ exception ต่อ symbol แล้ว log เป็น "failed" เฉยๆ จึงเงียบสนิท: scheduler รันทุกรอบ
บันทึกไม่สำเร็จสักตัว โดยไม่มีอะไรพัง

**Cause:** default ของพารามิเตอร์ FastAPI (`target_dte: int = Query(30, ...)`) เป็น **marker object**
จะกลายเป็นค่าจริงก็ต่อเมื่อ framework resolve ให้ตอนมี HTTP request. background thread ที่เรียก
`await endpoint(symbol)` ตรงๆ จึงได้ `Query` แทน `int`

**Fix:** แยก core ออกเป็นฟังก์ชันธรรมดา (`record_snapshot_now`) แล้วให้ endpoint เป็น wrapper บางๆ
background job เรียก core ตรง

**ทำไมเทสต์ไม่จับ:** เทสต์ scheduler ทั้งหมด mock ตัว recorder ทิ้ง → ทดสอบ "loop เรียกอะไรบ้าง"
ไม่ได้ทดสอบ "เรียกแล้วทำงานไหม". เพิ่ม `test_the_whole_path_records_with_the_provider_stubbed`
ที่ stub เฉพาะ provider แล้วปล่อยให้ผ่าน recorder จริง + guard ว่า default ไม่ใช่ Query

**Pattern:** ทุกครั้งที่ logic ถูกเรียกทั้งจาก HTTP และจาก job/CLI — core ต้องเป็นฟังก์ชันธรรมดา
และต้องมีเทสต์อย่างน้อย 1 ตัวที่วิ่งผ่าน seam จริงไม่ใช่ mock

## ATM IV ต่ำผิดปกติ (<3%) = chain ไม่มี quote จริง ไม่ใช่ vol ต่ำ (แก้แล้ว 2026-08-18)

**Symptom:** SKHY บันทึกได้ `iv_mid = 1.56%` เทียบ realized vol 111% → σ-band กว้าง ±0.45%
→ heatmap ขึ้น tail "ถูกสุดขีด" (+0.488/+0.362) ทั้งที่เป็นขยะ

**Cause:** chain บาง (ADR/GDR, IPO ใหม่) ตั้งราคา option ที่ intrinsic เพราะไม่มีคนเสนอราคา
→ solve implied vol ย้อนกลับได้ค่าใกล้ 0 ซึ่งไม่ใช่ vol

**Fix:** `IV_SANITY_MIN = 0.03` / `IV_SANITY_MAX = 5.0` ใน `routers/options.py` — ปฏิเสธตั้งแต่ตอนเขียน
และกรองตอนอ่านด้วย (แถวเก่าที่บันทึกไว้ก่อนมีเกณฑ์จะได้ไม่ทำ pane เพี้ยนตลอดไป)
เกณฑ์ล่างต่ำกว่า vol จริงของ bond ETF (~10%) มาก จึงไม่ตัดของจริง

## snapshot ที่ตกวันไม่มีแท่งราคา (วันหยุด) ทำ pane ว่างทั้งอัน (แก้แล้ว 2026-08-18)

**Symptom:** `snapshotCount: 1` แต่ `series: []` — และ `sigmaRv: null`

**Cause:** `/sd-bands` หา anchor ด้วย **exact date match** กับ price history. snapshot ที่บันทึกวันหยุด
(หรือก่อนตลาดเปิด) ไม่มีแท่งของตัวเอง → ไม่มี realized vol → cheapness mode `continue` ทิ้งทั้งแถว
ตัวอย่างจริง: 2026-08-17 ตลาดสหรัฐปิด (history ข้าม 08-14 → 08-18)

**Fix:** ใช้ `_bar_at_or_before()` (bisect) แทน exact match — ทั้ง anchor spot และ RV
และ **stamp คอลัมน์ที่แท่งจริง** (`row["time"] = dates[anchor_idx]`, เก็บ `snapshotDate` ไว้ต่างหาก)
เพราะ frontend จับคู่คอลัมน์กับแท่งด้วยวันที่ — คอลัมน์ที่ stamp วันไม่มีแท่งจะถูก renderer ทิ้งเงียบๆ
แม้ backend คำนวณถูกทุกอย่าง

## Pane indicator ที่ซ้อนหลายแถว: 80px default เตี้ยเกินไป (แก้แล้ว 2026-08-18)

**Symptom:** ตัวเลขใน SD heatmap ไปกองซ้อนกันที่มุมขวา อ่านไม่ออก

**Cause:** `computePaneLayout` cap ทุก sub-pane ที่ `SUB_PANE_MAX = 80` (floor 44) ซึ่งพอดีสำหรับ
เส้นเดียว/histogram แต่ pane ที่ซ้อน N แถวต้องหารความสูงนั้น — heatmap 5 แถวได้แถวละ **9–16px**
ซึ่งเท่าหรือน้อยกว่าขนาดตัวอักษร 9px เอง → ข้อความจากแถวติดกันทับกันหมด

**Fix 2 ชั้น:**
1. `IndicatorRegistryEntry.preferredPaneHeight` (optional) — indicator บอกความสูงที่ต้องการเอง
   (`sd-heatmap: 130` → แถวละ 26px). เป็นเพดานที่ "ขอ" ไม่ใช่ "ยึด": layout ยังจำกัดด้วยพื้นที่จริง
   และ user drag ยังชนะเสมอ
2. overlay ลดระดับการแสดงผลตามความสูง **ก่อน** ที่ตัวอักษรจะทับกัน — ไม่ใช่ปล่อยให้ทับ:
   `rowH < 13` ไม่แสดง rail เลย · `< 18` แสดงเฉพาะ ±2σ กับ 0 · `< 22` ตัดบรรทัด prob · `< 26` ตัด title

**บทเรียนสำหรับ pane indicator ใหม่:** ถ้าจะซ้อนแถว ให้คำนวณ `paneHeight / rowCount` เทียบกับ
font size ก่อน แล้วประกาศ `preferredPaneHeight` — และ **font ต้อง scale ตาม rowH** ไม่ใช่ fix

**⚠️ กับดักตอนแก้: "ซ่อนเมื่อที่ไม่พอ" ทำให้กลายเป็นจอว่าง**
รอบแรกผมแก้ด้วยการซ่อนข้อความเมื่อ `rowH` ต่ำกว่าเกณฑ์ → ผู้ใช้รายงานทันทีว่า "ไม่ขึ้นอะไรเลย"
ซึ่งแย่กว่าตัวเลขทับกัน. หลักที่ถูก: **ย่อก่อน ซ่อนทีหลัง** และสิ่งที่เป็นแก่นของ pane
(ในที่นี้คือราคา) ต้องไม่ถูกซ่อนเลย — ให้เล็กลงถึงพื้น 6px แทน

## Heatmap cell ผูกความกว้างกับ `barSpacing` = ซีรีส์สั้นมองไม่เห็น (แก้แล้ว 2026-08-18)

**Symptom:** heatmap "ไม่ขึ้นอะไรเลย" ทั้งที่ endpoint คืนข้อมูลถูกต้อง

**Cause:** `cellW = barSpacing * 0.9` เหมาะกับ heatmap หนาแน่น แต่พังกับซีรีส์ที่เพิ่งเริ่ม —
2 คอลัมน์บนชาร์ต 1 ปี ห่างกัน ~250 แท่ง → `barSpacing ≈ 2px` → กล่องกว้าง **1.8px**
มองแทบไม่เห็นบนจอ และไม่มีทางใส่ตัวเลขลงไปได้เลย

**Fix:** ความกว้างมาจาก **ระยะห่างระหว่างคอลัมน์จริง** ไม่ใช่ bar pitch:
`cellW = clamp(max(barSpacing*0.9, 52), 1, minGap*0.95)` — ซีรีส์สั้นได้กล่องกว้าง 52px อ่านออก,
ซีรีส์หนาแน่นยังชิดแท่งเป๊ะเหมือนเดิม (เพราะ `minGap` เป็นเพดาน)
ข้อความที่กว้างเกินกล่องถูก **ข้าม** ไม่ใช่ล้น — ล้นแล้วจะอ่านเป็นค่าของคอลัมน์ข้างๆ

**ใช้ซ้ำได้:** overlay ใดๆ ที่วาดเป็น "บล็อกต่อจุดข้อมูล" ต้องคิดความกว้างจากความหนาแน่นของ
*ข้อมูลตัวเอง* ไม่ใช่ของ price series ที่มันวางทับอยู่

**เทสต์ที่ควรมี:** stub 2D context ต้องบันทึก `textBaseline` + font size ด้วย ไม่ใช่แค่ `y` —
ไม่งั้นเทสต์ overlap จะ false positive (baseline `bottom` กับ `top` ที่ y ห่างกัน 1 ไม่ได้ทับกันจริง)
ดู `__tests__/heatmap-overlay.test.ts::textBox`

## SD band: สูตร BS ถูก แต่ input มีข้อจำกัด 3 ข้อ (ตรวจแล้ว 2026-08-18)

**ตรวจอะไรไปบ้าง** (`tests/test_sd_bands.py`): `P(S_T ≥ K)` ของเราตรงกับ `N(d2)` ถึงหลัก 12,
bucket probs ตรงกับ Monte Carlo 2 ล้าน path (z < 1), martingale `E[S_T] = forward` ผ่าน,
cross-sigma (cheapness) ก็ตรงกับ MC → **สูตรไม่มีปัญหา**

**ข้อจำกัดอยู่ที่ input ไม่ใช่สูตร:**

| # | สมมติฐาน | ขนาดความคลาดเคลื่อน (AMD 30d) |
|---|---|---|
| 1 | ใช้ ATM IV ตัวเดียวทั้ง band | 🔴 **~3%** ที่หาง — market IV ที่ ±2σ = 60% เทียบ ATM 54.6% → **band แคบเกินจริง** |
| 2 | `q = 0` (ไม่คิดปันผล) | <0.1% ที่ 30 วัน (สำคัญที่ horizon 1 ปี) |
| 3 | σ จาก expiry 32 วัน แต่ T = 30 วัน | ~1% |

ข้อ 1 สำคัญสุดและมีทิศทางชัด: **ประเมินความเสี่ยงหางต่ำกว่าจริง** ไม่ใช่สูงเกิน
แก้ให้ถูกต้องต้องเก็บ smile ทั้งเส้น (ไม่ใช่ค่าเดียว) แล้ว solve แต่ละ level ด้วย IV ของ strike ตัวเอง

**บทเรียนทั่วไป:** เวลาตรวจโมเดลการเงิน ให้แยก "สูตรถูกไหม" (cross-check กับ closed form + MC)
ออกจาก "input สมเหตุผลไหม" (เทียบกับราคาตลาดจริง) — ผ่านข้อแรกไม่ได้แปลว่าผ่านข้อสอง

## Yahoo `impliedVolatility` มาจากไหน และเชื่อได้แค่ไหน (ตรวจ 2026-08-18)

**สายข้อมูล:** `yf.Ticker().option_chain(exp).calls/.puts` → คอลัมน์ `impliedVolatility` —
**เราไม่ได้ solve เอง** รับค่าที่ Yahoo คำนวณมาแล้ว

**ตรวจแล้วว่า Yahoo ใช้ mid ของ bid/ask ไม่ใช่ lastPrice** (SNDK 2026-09-18, solve เองด้วย BS):
- `IV(mid)` ที่ solve เอง = yahooIV ของ call เป๊ะทุก strike (92.0 vs 92.0, 92.9 vs 93.0…)
- `IV(last)` เพี้ยนหนัก (116%, 155%) เพราะ last stale/thin → **อย่าใช้ lastPrice คำนวณ IV เอง**

**แต่ Yahoo คำนวณเทียบ SPOT และสมมติ q=0** ไม่ได้ปรับเป็น forward:
- SNDK put-call parity ให้ implied forward 1639.20 ขณะที่ spot 1619.33 (+1.23% ใน 31 วัน)
  → implied carry **q = −10.5%/ปี** = hard-to-borrow (ยืมหุ้นชอร์ตแพง)
- ผลคือ call IV (89%) กับ put IV (81%) **ห่างกัน 8pp ทั้งที่ vol เดียวกัน**
- solve ใหม่เทียบ forward จริง (Black-76): gap เหลือ **−0.9pp** → ยืนยันว่า 8pp นั้นคือ carry ไม่ใช่ vol

**เหตุผลที่ `σ_mid = (IV_call + IV_put)/2` เป็นสูตรที่ดีกว่าที่คิด:** carry ดัน call IV ขึ้นและ put IV
ลงในปริมาณใกล้เคียงกัน การเฉลี่ยจึงตัดกันเอง —
`σ_mid` = 84.8% เทียบ forward-implied จริง 86.0% ต่างแค่ **1.4%** สำหรับหุ้นที่ carry เพี้ยนถึง −10.5%
(หุ้นปกติที่ carry ≈ 0 จะไม่ต่างเลย). ไม่ใช่การเฉลี่ยมั่ว แต่ชดเชย bias ได้เกือบหมด

**ถ้าจะให้แม่นกว่านี้:** solve IV เองด้วย Black-76 เทียบ forward ที่ได้จาก put-call parity
(bid/ask มีอยู่ใน chain แล้ว) — ได้ความแม่นเพิ่ม ~1.4% เฉพาะกรณี hard-to-borrow

**ตรวจ carry ผิดปกติได้เร็วๆ:** `C_mid − P_mid` ที่ ATM ควรใกล้ `S − K·e^{−rT}`
ถ้าห่างมากแปลว่ามี q/borrow cost ที่โมเดลไม่รู้

## Overlay strip ที่ขอบขวา = บังคอลัมน์ล่าสุดเสมอ (แก้แล้ว 2026-08-18)

**Symptom:** heatmap "ไม่ขึ้นอะไรเลย" — ป้ายกำกับซ้าย/ขวายังวาด แต่ **กล่องสีหายทั้งหมด**
(diagnostic: `cells painted: 0` ขณะที่ `gutter labels: 5, rail entries: 9`)

**Cause:** เคยมี rail กว้าง 72px ตรึงขอบขวาเพื่อแสดงราคาต่อแถว → `plotR = width − 72`
แต่ข้อมูลใหม่สุดอยู่ **ขอบขวาของชาร์ตเสมอโดยนิยาม** → คอลัมน์ล่าสุดถูก clip จนกว้างติดลบ →
`drawR <= drawL` → `continue` → ไม่วาดสักกล่อง

**Fix:** ย้าย reference ทั้งหมดไป gutter ซ้าย (level + odds + value 3 คอลัมน์ในแถวเดียว)
plot กินพื้นที่ถึงขอบขวาเต็ม ไม่มีอะไรทับคอลัมน์ล่าสุด

**หลักทั่วไป:** chrome ที่ตรึงตำแหน่งใน time-series pane **ต้องอยู่ซ้าย** — ขวาคือที่อยู่ของ
ข้อมูลล่าสุดซึ่งเป็นสิ่งที่ผู้ใช้มองก่อนเสมอ (price axis ของ lightweight-charts อยู่ขวาได้เพราะ
chart reserve พื้นที่ให้จริง; overlay ทำแบบนั้นไม่ได้ มันวาดทับบนพื้นที่ที่ chart แจกไปแล้ว)

**วิธีจับบั๊กแบบนี้:** นับสิ่งที่วาดจริง ไม่ใช่ดูว่ามีข้อความไหม —
`cells painted: 0` คือคำตอบทันที ส่วน "ตัวอักษรหาย" เป็นอาการที่ทำให้เข้าใจผิด

## "ย่อก่อน ซ่อนทีหลัง" — ผมพลาดซ้ำแม้บันทึกไว้แล้ว (2026-08-18)

บันทึกหลักนี้ไว้ตอนแก้ rail แล้วเขียน `showValue = rowH >= 20` ในรอบถัดมา ซึ่งเป็นความผิดเดิม:
**ซ่อนข้อมูลเมื่อพื้นที่ไม่พอ** ผลคือราคาหายทั้งคอลัมน์บนชาร์ตที่มี 3 sub-panes
(400px chart → sd-heatmap ได้ 87px → rowH 17.4 → ต่ำกว่าเกณฑ์ 20)

**กฎที่ถูก แยก 2 มิติ:**
- **ความสูงไม่พอ → ย่อ font** (7–14px) ไม่เคยลบอะไรทิ้ง
- **ความกว้างไม่พอ → ตัดคอลัมน์ตามลำดับความสำคัญย้อนกลับ**
  (`level` > `value` > `odds` — odds เป็นค่าคงที่ที่จำได้ครั้งเดียว ตัดก่อน)

**เทสต์ที่กันการถอยหลัง:** วนทุกความสูง `[190,130,87,60,44]` แล้ว assert ว่าทั้ง 3 ค่ายังอยู่ครบ
ไม่ใช่เทสต์ที่ความสูงเดียว

## ตัวเลขในกล่อง heatmap ขึ้นกับ timeframe ไม่ใช่บั๊ก

กล่องกว้างเท่าระยะห่างระหว่างคอลัมน์ ซึ่ง snapshot รายวัน = **1 แท่ง** เสมอ:

| timeframe | barSpacing | cellW | ตัวเลขในกล่อง |
|---|---|---|---|
| 5D | 148px | 133px | ✓ |
| 1M | 34px | 32px | ✓ |
| 3M | 12px | 11px | ✗ |
| 1Y | 3px | 3px | ✗ |

ต้องเห็น ≤ ~27 แท่งบนจอถึงจะใส่ตัวเลขลงกล่องได้ (ต้องการ `cellW >= 26px`)
บน timeframe ยาว ราคาอ่านจาก **gutter ซ้าย** แทน ซึ่งแสดงเสมอทุกความกว้าง/ความสูง

## ModularChart สร้างใหม่ทั้ง instance เมื่อความสูงเปลี่ยน — ต้อง freeze ระหว่างลาก resize

`ModularChart` มี effect ที่ dep `chartHeight` (ความสูงที่วัดได้ quantize ทีละ 8px) และ teardown เรียก
`chart.remove()` แล้วสร้างใหม่ทั้งหมด ดังนั้น**ทุกครั้งที่ container สูงเปลี่ยน = รื้อ chart ใหม่ 1 รอบ**

ลากย่อ/ขยาย floating chart window 8 ก้าว = canvas ถูกถอด **18 ครั้ง** (วัดด้วย MutationObserver)

**วิธีแก้ (ใช้ใน `FloatingChartWindow.tsx`):** ระหว่าง gesture ตรึงความสูงของ div ที่ครอบ chart ไว้ที่ค่าตอน
เริ่มลาก (`frozenBodyHeight`) ให้กล่องนอกโตตามเมาส์แต่ chart ไม่รู้ตัว แล้วปล่อยให้วัดใหม่ครั้งเดียวตอน pointerup
→ 0 rebuild ระหว่างลาก

การ**ลากย้ายตำแหน่ง** ไม่เกิดปัญหานี้ (0 rebuild) เพราะความสูงไม่เปลี่ยน — props อื่น (`data`/`indicators`/
`overlays`) memo ไว้แล้ว

## ref guard ต่อ instance ยิง POST ซ้ำเมื่อมี chart หลายตัวบน symbol เดียวกัน

`useSdBands` เดิมกัน self-heal POST (`/api/options/iv-snapshot`) ด้วย `useRef(new Set())` = กันได้แค่ภายใน
instance เดียว พอมี MKT chart + floating window บน symbol เดียวกัน ต่างคนต่าง POST

**กฎ:** guard ที่ต้อง "ครั้งเดียวต่อ symbol ทั้งแอป" ต้องเป็น **module-level Set** ไม่ใช่ `useRef`
React Query dedupe ให้เฉพาะ `useQuery` ตาม queryKey — **mutation ไม่ถูก dedupe**

## `geometry` object ใหม่ทุก render = effect ผูก/ถอด listener ทุก render

`useWindowDrag({ geometry: { x: win.x, ... } })` — caller สร้าง object ใหม่ทุกครั้ง ถ้า effect dep เป็น object นั้น
listener ระดับ `window` จะถูก add/remove ทุก quote tick

**วิธีแก้:** เก็บ object ลง ref (`geometryRef.current = geometry`) แล้วให้ effect dep เป็น `[]` หรือ boolean
(`gesturing`) — handler อ่านค่าจาก ref

## clamp ต้องเป็น "display-only" ห้ามเขียนทับค่าที่ผู้ใช้ตั้งไว้

เดิม `useWindowDrag` เรียก `clampWindow` ตอน mount + ทุก `resize` event แล้ว **commit ค่าที่ clamp แล้วกลับเข้า store**
ผลคือย่อหน้าต่างเบราว์เซอร์ / ลากเบราว์เซอร์ข้ามจอ (คนละความละเอียด) = ตำแหน่ง/ขนาดที่ผู้ใช้จัดไว้ถูกเขียนทับถาวร
ผู้ใช้เห็นเป็น "popup reset ตำแหน่งเอง"

**กฎ:** เก็บ **intent** (ค่าที่ผู้ใช้ตั้ง) ไว้เสมอ → clamp เฉพาะตอน render
```
const current = live ?? clampWindow(geometry, viewport);   // viewport = state, update ตอน resize
```
ย่อจอ = หน้าต่างขยับเข้ามาในจอชั่วคราว, ขยายจอกลับ = กลับไปตำแหน่งเดิมเป๊ะ

## `window.open` — ชื่อหน้าต่างซ้ำ = Chrome จำ geometry เดิม (รวม maximized)

Chrome จำขนาด/ตำแหน่งของ popup **ตามชื่อ (`windowName`)** และ restore ทับ feature string
ถ้าครั้งก่อนถูก maximize ไว้ → เปิดใหม่ maximize เสมอ และ **`resizeTo()/moveTo()` บนหน้าต่าง maximized ถูก ignore ทั้งหมด**

**วิธีแก้ (ใช้ใน `DetachedChartWindow.tsx`):**
1. ตั้งชื่อหน้าต่าง **unique ต่อการ detach** (`chart-${win.id}`) ไม่ใช่ `chart-${symbol}`
2. `popup=yes` ใน features (Chrome จะสน left/top เฉพาะโหมด popup)
3. ยิง `resizeTo + moveTo` ซ้ำที่ 0/60/300/800/1500ms — popup ที่เพิ่งเปิดยัง ignore resize จนกว่าจะ settle
   (แต่ละครั้ง no-op ถ้าขนาดตรงแล้ว)

อีกข้อ: `window.open` ต้องมี **transient user activation** → detach ต้องมาจาก click เท่านั้น
reload หน้าแล้วเปิดหน้าต่างเดิมอัตโนมัติไม่ได้ — ต้อง dock กลับเป็น in-page popup แล้วให้ผู้ใช้กด detach เอง

## `seed_symbol_lists()` รันแค่ตอนตารางว่าง — เพิ่ม symbol ใน config.py แล้วของเก่าไม่เห็น

`backend/db.py:seed_symbol_lists()` มี guard `if count > 0: return` → เครื่องที่ seed ไปแล้ว **ไม่มีวันได้ symbol ใหม่**
KOSPI อยู่ใน `config.INDICES` มานานแต่ไม่เคยขึ้นบน ASIA PACIFIC ด้วยเหตุนี้ (API คืนแค่ 5 ตัว)

**วิธีแก้:** `sync_symbol_lists()` (db.py) รันทุก startup — insert เฉพาะ symbol ที่ขาด key ด้วย `(list_id, symbol)`
ต่อท้าย `sort_order` เดิม ไม่ยุ่งกับแถวที่ user ปิด/เรียงเอง

**เพิ่ม symbol ใหม่ใน config.py ต้องเช็ค:** ถ้าไม่ได้อยู่ในลิสต์ที่ `sync_symbol_lists()` รู้จัก (`indices`, `volatility`)
ต้องเพิ่ม list นั้นเข้าไปใน `groups` ของฟังก์ชันด้วย ไม่งั้นเงียบเหมือนเดิม

## symbol volatility ที่ Yahoo คืนค่าผิด/ไม่มีค่า

เช็คแล้ว 2026-08-24 ก่อนใส่ `config.VOL_INDICES`:
- `^RVX` (Russell 2000 vol) — Yahoo มี ticker แต่ **ไม่คืนราคา** → ตัดออก
- `^MOVE` — resolve ไปเป็น "Northern Trust iBoxx 5-Year Target ETF" **ไม่ใช่ ICE MOVE index** → ตัดออก
- `^VXXLE` — ไม่มีข้อมูล
ที่ใช้ได้: `^VIX1D ^VIX9D ^VIX ^VIX3M ^VIX6M ^VVIX ^SKEW ^VXN ^VXD ^VXSMH ^VXAPL ^VXEEM ^VXFXI ^VXEWZ ^OVX ^GVZ ^VXSLV ^VXGDX ^VXTLT`

## lightweight-charts: `minBarSpacing` 0.5 = เพดานซูมออก ~1,000 แท่ง

ค่า default คือ 0.5px ต่อแท่ง → chart กว้าง 500px ซูมออกได้มากสุด ~1,000 แท่ง
กราฟ 5Y daily (~1,250 แท่ง) จึงหมุนล้อแล้ว **ไม่มีอะไรเกิดขึ้น** และ `getVisibleLogicalRange().from` ค้างอยู่ที่เลขบวก
ทำให้ตรรกะที่รอ "ขอบซ้ายถึงแท่งแรก" (auto-extend history) ไม่มีวันทำงาน

**แก้:** `timeScale: { minBarSpacing: 0.05 }` ใน `ModularChart.tsx`
อาการที่ควรสงสัยข้อนี้: ซูมออกแล้วนิ่งสนิท ไม่ใช่ event ไม่ยิง — subscription ยิงปกติแต่ range ค่าเดิม

## chart rebuild ทำให้ canvas เดิมหลุด DOM — event ที่ยิงใส่ element เก่าเงียบหาย

`ModularChart` สร้าง chart ใหม่ทั้งก้อนเมื่อ `data` เปลี่ยน (canvas ชุดเก่าถูกทิ้ง)
โค้ดทดสอบ/automation ที่เก็บ `canvas` ไว้ในตัวแปรแล้วยิง wheel/pointer ซ้ำหลัง data เปลี่ยน จะยิงใส่ element ที่ detach แล้ว — ดูเหมือนฟีเจอร์พัง ทั้งที่ปกติ
**ต้อง query element ใหม่ทุกครั้งหลังข้อมูลเปลี่ยน**


## `X.filter is not a function` — proxy 503 ไหลเข้า React Query แทน array

`/api/*` proxy ของ Next คืน `{"error":"Backend unavailable"}` + HTTP 503 เมื่อ backend :8000 ตาย
`queryFn: () => fetch(url).then(r => r.json())` **ไม่เช็ค `res.ok`** → `query.data` กลายเป็น object
`query.data ?? []` ไม่ช่วย (object ไม่ใช่ null) → caller เรียก `.filter()` แล้ว throw ทั้ง terminal ล่ม

เจอครั้งแรกที่ `useAlertNotifications.ts:145` (2026-08-25) ต้นทางคือ `useAlertRules.ts`
**แก้:** ใช้ `listOrThrow<T>(res)` — throw ถ้า `!res.ok` หรือผลลัพธ์ไม่ใช่ array
React Query จะเก็บ data ก้อนล่าสุดไว้แล้ว degrade เป็น "ไม่มี alert" แทนที่จะ crash
list endpoint ใหม่ทุกตัวต้องผ่าน helper นี้ อย่าใช้ `.then(r => r.json())` เปล่าๆ

## localStorage ใน `useState` initializer + SSR = hydration mismatch เสมอ

pattern ใน CLAUDE.md (`useState(() => loadDefaults())`) ถูกต้องสำหรับ client
แต่ Next **SSR client component ด้วย** — บน server ไม่มี `localStorage` → ได้ค่า default
ส่วน render แรกฝั่ง client ได้ค่าที่ save ไว้ → tree ไม่ตรง React ทิ้ง SSR output

อาการ: overlay ชี้ไป element ที่ conditional ตาม state นั้น เช่น `{isRot && <div/>}`
(`sector-regime-heatmap.tsx:803`) หรือค่า inline style ไม่ตรง (`height:509` vs `height:"220px"`)

**แก้ที่ราก:** `app/page.tsx` โหลด `BloombergTerminal` ด้วย `dynamic(..., { ssr: false })`
ทั้ง terminal เป็น client-only อยู่แล้ว (ข้อมูลมาจาก React Query หลัง mount) SSR ไม่ได้อะไรเลย
ผลพลอยได้: hydration mismatch จาก browser extension (Dark Reader ฉีด `--darkreader-inline-*`) หายไปด้วย


## panel `flexGrow: 1` ทุกอัน = พับ panel หนึ่ง แล้วอีก panel โตผิดสัดส่วน

MKT layout เดิมให้ทุก panel ที่เปิดอยู่เป็น `width: <stored>%` + `flexGrow: 1`
พอพับ TICK DATA (36px rail) พื้นที่ที่ว่าง **ถูกแบ่งเท่าๆ กัน** ไม่ใช่ตามสัดส่วน
→ WATCHLIST เด้งจาก 30% เป็น ~45% และลาก divider ดึงกลับไม่ได้ เพราะ stored width ชนพื้น 15% ไปแล้ว
แต่ส่วนแบ่งที่ได้เปล่ายังอยู่

**วิธีแก้ (market-view.tsx):** เลือก **filler panel** หนึ่งตัว (chart ถ้าเปิดอยู่ ไม่งั้น panel เปิดตัวสุดท้าย)
- filler → `flexGrow: 1, flexBasis: 0, minWidth: 0`
- panel อื่น → `flex: 0 0 <stored>%` (คงขนาดที่ผู้ใช้ตั้งไว้ ไม่ว่าจะพับกี่ตัว)
- divider วาดเฉพาะระหว่าง panel ที่เปิดทั้งคู่ (คั่นกับ rail ที่พับแล้ว ลากไปก็ไม่มีอะไรเปลี่ยน)

**ห้ามลืม `minWidth: 0` บน filler** — flex item ไม่ยอมหดต่ำกว่า min-content โดยดีฟอลต์
ตาราง chart/tick กว้างพอที่จะแย่งพื้นที่คืนจากค่าที่ตั้งไว้ (เทสจริง: 30/40/30 กลายเป็น 274/663/343)

## ส่ง `array.filter(...)` เป็น prop ให้ ModularChart = rebuild ทั้ง chart ทุก render

`ModularChart` อ่าน identity ของ `indicators` / `overlays` / `eventMarkers` เป็น **โครงสร้าง** (อยู่ใน deps ของ build effect)
`indicators={list.filter(i => i.id !== "fear-greed")}` สร้าง array ใหม่ทุก render → teardown + `createChart` + สร้าง series/pane ใหม่ทั้งหมด
ทุกครั้งที่ view re-render (พิมพ์ในช่อง search ก็นับ)

**กฎ:** ทุก array/object ที่ส่งเข้า `ModularChart` ต้อง `useMemo` เสมอ — ไฟล์ `useChartIndicators.ts` มีคอมเมนต์เตือนไว้แล้วสำหรับ `eventMarkers` แต่ call site ยัง filter สดๆ อยู่ (แก้แล้ว 2026-08-25 ใน market-view + ChartPanel)

## query key ใหม่ = `isLoading` true = view สลับไป spinner = chart unmount

pattern `historyQuery.isLoading ? <Spinner/> : <ModularChart/>` ทำให้การเปลี่ยน period/interval **ทำลาย chart ทิ้ง** แล้วสร้างใหม่ (เสีย viewport, เสีย pane height, เห็นกระพริบ)
React Query ให้ `isLoading` = ไม่มีข้อมูลใน cache สำหรับ key นั้น ซึ่งเป็นจริงเสมอสำหรับ key ใหม่

**แก้:** `placeholderData: (prev, prevQuery) => prevQuery?.queryKey[2] === symbol ? prev : undefined` ใน `useStockHistory`
คงบาร์ชุดเดิมไว้จนของใหม่มา (เช็ค symbol ด้วย ไม่งั้นจะเอาราคาหุ้นตัวเก่าไปแสดงใต้ชื่อหุ้นตัวใหม่)

## dev มี React StrictMode — effect/refill รันซ้ำ 2 ครั้ง

log ที่เห็นซ้ำเป๊ะๆ ตอน debug (`refill true` สองบรรทัดต่อ data ชุดเดียว) เป็นพฤติกรรม StrictMode ของ dev ไม่ใช่บั๊ก
อย่าเพิ่ง "แก้" การรันซ้ำก่อนเช็ค production build — และเวลาวัด rebuild ให้ใช้ MutationObserver นับ canvas ที่ถูกถอดจริง ไม่ใช่นับ log


## ALERT ค้างแม้ลบ rule ไปแล้ว — orphan event ไม่เคยถูก ack

`alert_events` **ไม่มี FK** ไป `alert_rules` โดยตั้งใจ (เก็บ audit trail ตาม plan §5)
แต่ `list_events` ทำ LEFT JOIN แล้ว **fallback `notify: ["ticker"]`** เมื่อ rule หายไป
→ event ที่ยัง `acked=0` ของ rule ที่ลบทิ้งแล้ว จะขึ้น ticker + badge ตลอดกาล

เจอ 2026-08-25: unacked 10 รายการ เป็น orphan ของ rule SNDK ที่ลบไปตั้งแต่ 2026-08-02 ทั้งหมด

**แก้ 2 ชั้น:**
1. `delete_rule` — `UPDATE alert_events SET acked=1 WHERE rule_id=? AND acked=0` ก่อน DELETE rule
   (แถวยังอยู่ = audit ยังครบ แต่หยุดเตือน)
2. `alerts/schema.py` — sweep ตอน startup: ack orphan ที่ค้างจากก่อนมี fix

ถ้าเพิ่ม channel/notify ใหม่ อย่าลืมว่า orphan จะได้ default channel เสมอ

## quote ของ chart header ไม่ขยับ ต้อง refresh เอง (แต่ WATCHLIST ขยับ)

`useStockQuote` ตั้ง `refetchInterval: false` + `staleTime: 5min` มาแต่แรก (คอมเมนต์เดิมว่า "fetch only when user searches")
ผลคือแถบราคาบนหัว chart — รวม pre/after-hours ที่ `ExtendedHoursPrice` อ่านจาก quote เดียวกัน — ค้างที่ค่าตอนเลือก symbol
ส่วน watchlist มี `setInterval(fetchQuotes, 60_000)` ของตัวเอง เลยขยับ → ดูเหมือนบั๊กเฉพาะ pre-market

**แก้:** `refetchInterval: isRealTimeEnabled ? 60_000 : 300_000`, `staleTime: 30s`, `refetchOnWindowFocus: true`
ผูกกับ `isRealTimeEnabledAtom` ตัวเดียวกับ `useMarketData` — ปุ่ม realtime ใน header คุมทั้งหมดจากที่เดียว

## ล้าง BUY/SELL target ของ pin ไม่ติด — badge "price target hit" ค้างตลอด

badge สีแดงใน WATCHLIST header **ไม่ใช่ระบบ alert rule** — มันนับ pin ที่ราคาแตะ `buyTarget`/`sellTarget`
(`pinned-assets.tsx` `totalAlerts`) และเป็น **level condition** ไม่ใช่ edge → ตราบใดที่ target ยังอยู่ มันเตือนไม่หยุด

ลบ target ผ่าน UI แล้วไม่หาย เพราะพังทั้ง 2 ฝั่ง:
1. **frontend** — edit form ส่ง `buyTarget: undefined` เมื่อช่องว่าง แต่ `handleSaveEdit` มี guard
   `if (updates.buyTarget !== undefined)` → PATCH ไม่เคยถูกส่ง (local หาย แต่ DB ยังอยู่ → โหลดใหม่กลับมา)
2. **backend** — `patch_asset` ใช้ `body.model_dump(exclude_none=True)` → **ทิ้ง null ทุกตัว** ล้างไม่ได้อยู่ดี

**แก้:** ฝั่ง frontend ส่ง `null` (type เป็น `number | null`), ฝั่ง backend ใช้ `exclude_unset=True`
แล้วกรอง None เฉพาะคอลัมน์ที่ไม่ nullable (`NULLABLE = {"buy_target","sell_target"}`)

`null` = ล้าง, `undefined` = ไม่แตะ — PATCH ที่ partial ต้องแยกสองอย่างนี้ให้ออกเสมอ

## optimistic write + `catch (console.error)` = ของหายเงียบตอน reload (PIN GROUP)

อาการ: สร้าง PIN GROUP ใหม่ได้ กลุ่มโผล่ในจอ แต่ refresh แล้วหาย → ผู้ใช้สรุปว่า "สร้างไม่ได้"

`handleAddGroup` เขียน state + localStorage ก่อน แล้ว POST ทีหลัง โดยจับ error แค่ `console.error`
พอ backend ล่ม/POST fail state ยังค้างว่าเพิ่มสำเร็จ → bootstrap ครั้งถัดไป `setGroups(dbGroups)` ทับทิ้งทันที
ไม่มี error ให้เห็นสักจุด (console อยู่หลัง devtools)

**แก้:** optimistic ได้ แต่ต้องมี rollback — เก็บ `prevGroups/prevPins` ไว้ก่อน, fail แล้ว `setGroups(prev)` +
`saveToLS(prev)` + ตั้ง `mutError` ที่แสดงเป็น badge แดงใน header (`rollbackGroups()` ใน `pinned-assets.tsx`)

ประเด็นซ้อน 2 ข้อที่เจอพร้อมกัน:
- **rename ไม่มี UI เลย** — backend `PATCH /api/pins/groups/{id}` + proxy มีครบตั้งแต่แรก แต่ frontend ไม่เคยเรียก
  (ตอนนี้อยู่ใน `GroupManagerPanel` แบบ dropdown เหมือน TagManagerPanel — คลิกชื่อ/ดินสอเพื่อ rename, ColorPicker เปลี่ยนสี)
- **ghost group `watchlist`** — `DEFAULT_WATCHLIST_GROUP` ถูกใส่ใน state ตอน DB ว่าง แต่ไม่เคย INSERT ลง DB
  ขณะที่ `db.py` เปิด `PRAGMA foreign_keys = ON` + `pinned_assets.group_id REFERENCES pin_groups(id)`
  → pin แรกที่ add จะ FK fail เงียบ หายตอน reload เหมือนกัน แก้โดย seed ผ่าน `/api/pins/import` ตอน bootstrap เจอ DB ว่าง

บทเรียน: ฟอร์มที่ render ใต้ `{!collapsed && ...}` แต่ปุ่มเปิดอยู่นอก block นั้น = กดแล้วไม่มีอะไรเกิดขึ้นเมื่อ panel ถูกพับ
panel แบบ dropdown (`absolute`) เลี่ยงกับดักนี้ได้ทั้งหมด

## Option quote `last_price` is the PREMIUM, not the underlying spot

**อาการ:** greeks ทุกตัวออกมาใกล้ 0 — delta ~0, theta ~0 — โดยไม่มี error ไม่มี log
ตัวเลขดูสมเหตุสมผลพอที่จะไม่มีใครสงสัย ซึ่งอันตรายกว่าพัง

**สาเหตุ:** `OptionMarketData.last_price` มาจาก `lastPrice` ของแถวใน option chain
(`backend/providers/yahoo_options.py:59`) = ราคา **สัญญา option** ไม่ใช่ราคาหุ้นอ้างอิง
ป้อนเข้า `compute_greeks(spot=...)` เท่ากับบอกว่าหุ้น AAPL ราคา $5.80 เทียบ strike $200

**Fix:** ดึง spot แยกด้วย `underlying_spot(symbol)` (`backend/routers/options.py`) —
`market_data.get_fast_info(sym).last_price` ของ **underlying**; IV ยังเอาจากสัญญาได้ ถูกแล้ว
ถ้าเคยมี cache ของค่าผิด ต้องเปลี่ยน cache key prefix ด้วย ไม่งั้นยังเสิร์ฟค่าเก่า

**กฎทั่วไป:** เวลาโมเดลรับทั้ง "ราคาของ instrument" และ "ราคาของ underlying"
อย่าให้ตัวแปรทั้งสองมาจาก response ก้อนเดียวกันโดยไม่ตรวจ — ชื่อ field เหมือนกันได้ ความหมายคนละอย่าง

---

## Base-currency amount คู่กับ native percentage = เครื่องหมายขัดกัน

**อาการ:** UI แสดง `-161 (+0.0%)` — เงินติดลบแต่เปอร์เซ็นต์เป็นบวก/ศูนย์

**สาเหตุ:** cost แปลงที่เรตวันเข้า (`when="entry"`) ส่วน market value แปลงที่เรต live
พอ FX ขยับ base P&L จึงไม่เป็นศูนย์ ทั้งที่ราคา native ไม่ขยับเลย (native % = 0.0)
การเอาจำนวนเงิน base มาคู่กับ % native จึงเป็นคนละฐาน

**Fix:** คำนวณ percentage บนฐานเดียวกับจำนวนเงินที่แสดง — เพิ่ม `unrealized_pct_base`
(`unrealized_pnl_base / |cost_basis_base|`) แล้วให้ UI ใช้ค่านั้นคู่กับยอด base
เห็นครั้งแรกที่ `backend/portfolio_options.py`; ใช้ได้กับทุกจุดที่รายงาน 2 สกุลพร้อมกัน

---

## `next/dynamic` ไม่มี timeout — chunk ที่ไม่มาถึง = ค้างที่ loading ตลอดกาล (2026-09-10)

**อาการ:** เปิด `http://bloomberg.localhost:9318/` แล้วค้างที่หน้าดำคำว่า BLOOMBERG
ต้องกด refresh เองจึงจะเข้าเทอร์มินัลได้

**สาเหตุ:** `app/page.tsx` โหลด terminal ด้วย `dynamic(..., { ssr: false })`
ถ้า import() promise ไม่ resolve และไม่ reject (dev-server compile ค้าง, `ChunkLoadError`
หลัง rebuild เปลี่ยน hash, request ค้าง) `next/dynamic` ไม่มี timeout ให้ตั้ง —
มันจะโชว์ `loading` fallback ไปเรื่อยๆ ไม่มี error boundary ไหนจับได้ เพราะไม่มี error

**Fix:** fallback ต้องเฝ้าตัวเอง — `components/bloomberg/core/boot-screen.tsx`
นับเวลา, ยังไม่ mount ภายใน 12s → `location.reload()` หนึ่งครั้ง (แทน refresh ที่คนกดเอง),
กัน loop ด้วย `sessionStorage["bloomberg_boot_retry_at"]` ในกรอบ 60s → รอบสองโชว์ปุ่ม RETRY
และดัก `window.error` ที่เป็น `ChunkLoadError` เพื่อ reload ทันที

**สำคัญ — watchdog ฝั่ง React ไม่พอ:** อาการจริงที่เจอคือหน้าค้างแบบ **ไม่มีตัวนับเวลา**
= BootScreen ไม่เคย mount, สิ่งที่เห็นคือ HTML ที่ server render ของ fallback เอง
(`dynamic(ssr:false)` ยัง render `loading` ฝั่ง server) แปลว่า client bundle ไม่โหลด/ไม่ execute
ตัวจับเวลาที่อยู่ใน bundle จึงตายไปด้วย

**Fix ชั้นสอง:** inline `<script>` ใน `app/layout.tsx` → `app/boot-watchdog.tsx`
รันจาก HTML ตรงๆ ไม่พึ่ง chunk ใดเลย → 12s ถ้า `window.__BT_MOUNTED__` ยังไม่ถูกเซ็ต
(เซ็ตใน `bloomberg-terminal.tsx` useEffect) → reload หนึ่งครั้ง, รอบสองโชว์แถบแดง
`#boot-stalled` แทนการ reload ซ้ำ

**เบาะแสเพิ่ม (2026-09-10):** พิมพ์ URL ในช่อง address bar → ค้าง / เปิดผ่าน shortcut → ไม่ค้าง
ต่างกันที่ Chrome **prerender ระหว่างพิมพ์** (omnibox preloading) — เอกสารที่ prerender
ยังไม่ถูกแสดงและอาจนิ่งได้นาน ไม่ใช่อาการค้าง watchdog ทั้งสองตัวจึงเช็ค `document.prerendering`
และเริ่มจับเวลาที่ event `prerenderingchange` (= ตอน activate) เท่านั้น

**อย่าใช้ `next/script strategy="beforeInteractive"` กับ watchdog ตัวนี้:** มัน block hydration
วัดได้ ~150ms (first `/api/` request 558ms → 379ms หลังเปลี่ยนกลับเป็น raw `<script>` ใน layout)
raw tag ก็อยู่ใน server HTML และรันก่อน bundle เหมือนกัน แต่ไม่ถ่วง hydration
(แลกกับ warning ของ React "Encountered a script tag while rendering React component" ใน dev — cosmetic)

**หลักฐานรอบหน้า:** watchdog ยิง `navigator.sendBeacon("/api/boot-diag", …)` ก่อน reload
→ บรรทัด `[boot-diag] {...}` ใน `logs/frontend.log` บอก `prerendered`, `visibility`,
`readyState`, `sinceNav`, script ที่ช้าที่สุด — ไม่ต้องเปิด DevTools ทัน
(route ต้องชื่อ `app/api/boot-diag/` — โฟลเดอร์ที่ขึ้นต้นด้วย `_` ใน App Router เป็น private
ไม่ถูก route ให้ ตอนแรกวางเป็น `__boot-diag` แล้วได้ 404)

**กฎทั่วไป:** ทุก `dynamic()` ที่กั้นหน้าจอทั้งหน้า ต้องมี watchdog **นอก bundle** —
promise ที่ค้างเงียบไม่ใช่ error, และถ้า bundle ไม่รัน โค้ด React ทุกบรรทัดก็ไม่รันเหมือนกัน

---

## PORT ใช้เวลา ~10s ทุกครั้งที่เปิด — fetch ใน useEffect ไม่มี cache (fixed 2026-09-10)

**อาการ:** กด P แล้วตารางว่างค้างหลายวินาที ทุกครั้งที่เข้า ไม่ว่าจะเพิ่งเข้าไปมาก่อนหน้าหรือไม่

**วัดได้ (ก่อนแก้):** 33 requests, settle ที่ 9.7s — `stoploss/compute` 8.4s,
`v2/portfolio/premarket` 3.7s (ทั้งคู่ต้องรอ `open-positions` ก่อนเพราะต้องใช้ list symbol),
`theses/summary` 0.8s, `summary` 0.6s

**สาเหตุ:** ทุก tab ใน `views/portfolio/` ใช้ `useEffect` + `fetch` เก็บลง `useState`
= ไม่มี cache ข้าม mount เลย ออกจาก view แล้วกลับเข้ามา = เริ่มนับหนึ่งใหม่ทั้งชุด
(backend มี TTLCache อยู่แล้ว — stoploss 300s, premarket 30s — แต่ฝั่ง client ทิ้งทุกอย่าง)

**Fix 2 ชั้น:**
1. `views/portfolio/queries.ts` — ย้าย 7 endpoint ไป React Query, `staleTime` ตรงกับ TTL ฝั่ง backend
   (`OpenPositionsTab` + `portfolio/index.tsx` ใช้ผ่าน `useQuery` แทน effect เดิม)
2. `hooks/usePortfolioPrewarm.ts` — terminal shell warm cache ให้ล่วงหน้า 4s หลัง mount ตอน idle
   (positions ก่อน แล้วค่อย stoploss/premarket ที่ต้องใช้ symbol list) + เพิ่ม `portfolio` เข้า
   `prefetchTier1` เพื่อโหลด chunk ไว้ก่อน

**ผลวัดหลังแก้:** กด PORT → ตารางเต็มภายใน ~1s, request ใน 1 วินาทีแรก = 1 (จาก 33)

**กฎทั่วไป:** view ที่ช้าเพราะ request chain (A → ต้องได้ผลก่อนถึงยิง B ที่ช้า)
แก้ด้วยการ prewarm ตอน idle ได้ผลกว่าการ optimize ตัว request — ผู้ใช้ไม่ได้อยู่หน้านั้นตอนมันโหลด

> **ภาคต่อ 2026-09-15:** `stoploss/compute` ที่เป็นตัวช้าที่สุดในหัวข้อนี้ **ถูกลบทิ้งทั้งระบบ**
> (ไม่เคยใช้ตัดสินใจเทรดจริง) — ดูหัวข้อถัดไป

---

## Feature ที่ไม่ได้ใช้ ซ่อนตัวอยู่บน cold path ของ *ทุก* หน้า (removed 2026-09-15)

**อาการ:** ทั้งเว็บ boot ช้า ~17s ก่อน crawl bar ล่างจะมีตัวเลข — ดูเผินๆ เหมือนตลาดข้อมูลช้า

**สาเหตุ:** stop-loss ATR engine (`routers/stoploss.py`) ถูกมองว่าเป็น "ฟีเจอร์ของหน้า PORT"
แต่จริงๆ `routers/ticker.py::_fetch_alerts` เรียก `_get_stoploss_breaches()` ทุกครั้งที่ build
ticker payload → สแกนทุก position ที่เปิดอยู่ → `get_atr()` วน `yf.download()` **ทีละ symbol
แบบ sequential** (15 symbol = 6.8s วัดจริง). `alert-ticker.tsx` อยู่ใน layout ไม่ใช่ใน PORT
→ ทุก view จ่ายค่านี้ ไม่ว่าจะเปิด PORT หรือไม่

**วัดจริง (เครื่องเดียวกัน รันติดกัน):**

| | cold ticker build |
|---|---|
| ก่อนลบ | **17.2s** |
| หลังลบ | **7.2s** (ซ้ำ 2 ครั้งได้เท่ากัน) |

หลังลบแล้ว longest pole กลายเป็น `indices=7.2s` — `alerts` เหลือ 2.0s (เช็ค regime change อย่างเดียว)

**กฎทั่วไป:**
1. ก่อนจะ optimize อะไร ให้ log **เวลาแยกราย job** ก่อน — job ที่รันขนานกัน มีแค่ตัวช้าที่สุดที่สำคัญ
   (`_build_ticker` มี `[ticker] build Xs — name=Ys …` ให้แล้ว, log เฉพาะตอน build ≥ 1s)
2. "ฟีเจอร์นี้อยู่หน้าไหน" ตอบจาก UI ไม่ได้ — ต้อง grep ว่าใครเรียก backend function นั้นบ้าง
   ตัวที่แพงที่สุดมักถูกเรียกจาก layout-level component ที่ mount ตลอดเวลา
3. ลบฟีเจอร์ต้องแยกให้ออกระหว่าง **engine** กับ **ข้อมูลที่ผู้ใช้กรอกเอง** — `trades.price_stoploss`
   (คอลัมน์ S/L ใน PORT + ฟอร์ม ENTRY + CSV import) ไม่ได้ยิง network เลย จึงเก็บไว้;
   ที่ลบคือ `DYN SL` / `SL DIST%` ที่คำนวณจาก ATR

**Bonus:** `ticker._cache` เคยแยก key ตาม `account_id` เพราะ payload มี breach ของ account นั้น
พอลบ stop engine แล้ว payload ไม่ขึ้นกับ account อีก → ยุบเหลือ key เดียว (`_CACHE_KEY`)
คนที่ยิง `?account_id=X` เลยได้ cache ที่ prewarm ตอน startup แทนที่จะ build ใหม่เอง

## Batch job ที่ครอบ try/except ทั้งก้อน = แถวเดียวเสียก็ดับทั้งระบบเงียบๆ

**เคส:** `backend/alerts/scheduler.py:81-87` ครอบ `run_once()` ทั้งตัวด้วย try/except
เดียว. แถว `alert_rules` ที่ `expr_json` ผิด format แถวเดียว (`{"kind":"const"}` ไม่มี key
`op` → `ast.py:166` โยน `AstValidationError`) ทำให้ scan รอบนั้นตายทั้งรอบ →
**rule อื่นทุกตัวไม่ถูก evaluate** ตั้งแต่ 2026-08-25 (479 warning ใน log) โดย UI ไม่มีสัญญาณ
อะไรเลย — ticker ว่าง ดูเหมือน "ไม่มี alert" ไม่ใช่ "engine พัง"

**กฎทั่วไป:** loop ที่วนของหลายชิ้น ต้อง try/except **รายชิ้น** ไม่ใช่รอบนอกสุด และต้อง log
id ของชิ้นที่พังด้วย. ถ้าชิ้นนั้นพังซ้ำๆ ให้ปิดมันเอง (`enabled = 0`) แทนที่จะลากทั้ง batch ลงไป

**แก้แล้ว 2026-09-15 (`ddf313d`)** — `run_scan` build rule ทีละแถว, `engine.scan` ครอบ
try/except รายกฎ (callback `on_rule_error`), เก็บเหตุผลลง `alert_rules.last_error`
แล้วโชว์ ⚠ ข้างชื่อกฎใน bell menu + context menu

**นโยบายแยก 2 แบบ — สำคัญ:**
- **parse ไม่ผ่าน** = พังถาวร → `enabled = 0` เลย จะได้เลิก retry ทุก 15 นาที
- **พังตอน evaluate** (bars เพี้ยน, indicator throw) = อาจหายเอง → คง enabled ไว้ บันทึกแค่ error

`last_error` ล้างเองเมื่อ scan ผ่าน หรือเมื่อผู้ใช้แก้กฎ (PATCH)

**บทเรียนที่แพงกว่าตัวบั๊ก:** "ไม่มี alert" กับ "engine พัง" หน้าตาเหมือนกันเป๊ะบน UI
ทุก background job ที่ข้ามงานไป ต้องมีที่ให้ผู้ใช้เห็นว่าข้ามเพราะอะไร ไม่ใช่แค่ log

> รายละเอียด + วิธี reproduce → `memory/sessions/reports/alert-scan-dead-since-2026-08-25-risk-report.md`

## FastAPI: literal path ถูก `{param}` route จับก่อน ถ้าประกาศทีหลัง

**อาการ:** `GET /api/options/trades` ตอบ `{"detail":"No options available for TRADES"}`
— เป็น 404 จาก handler อื่น ไม่ใช่ routing error จึงหาสาเหตุยาก

**สาเหตุ:** FastAPI match ตาม **ลำดับที่ประกาศ** `/api/options/{symbol}` (ประกาศไว้บรรทัด ~123)
รับ segment เดียวอะไรก็ได้ → `trades` กลายเป็น `symbol="trades"`

**Fix:** ประกาศ literal path **ก่อน** catch-all เสมอ ใน `backend/routers/options.py` มีคอมเมนต์
กำกับไว้เหนือ `/api/options/{symbol}` แล้วว่าห้ามเพิ่ม literal one-segment GET ใต้บรรทัดนั้น

**กฎทั่วไป:** route ที่มี **2 segment ขึ้นไป** ไม่ชน (`/api/options/positions/list` จึงรอด)
และ method ต่างกันก็ไม่ชน (`POST /api/options/close-fifo` รอดเพราะ `{symbol}` เป็น GET อย่างเดียว)
เวลาเพิ่ม endpoint ใหม่ใต้ prefix ที่มี catch-all ให้เช็ค 3 อย่าง: ลำดับ · จำนวน segment · method

---

## `hidden` ไม่ทำงานบน element ที่มี class `flex` / `grid`

**อาการ:** `<div hidden={cond} className="flex …">` ยังแสดงผลทั้งที่ `cond` เป็น true

**สาเหตุ:** attribute `hidden` พึ่ง UA stylesheet `[hidden]{display:none}` ซึ่ง specificity ต่ำ
`display:flex` จาก class ทับได้ตรงๆ

**Fix:** ใช้ conditional render (`{cond && <div…>}`) หรือประกาศ `[hidden]{display:none!important}`
ใน global CSS — ในโปรเจกต์นี้เลือกอย่างแรก เพราะ element ที่ซ่อนแล้วไม่ต้อง mount

---

## Headline metric เงียบๆ ไม่นับ instrument class ใหม่ → หน้าจอเดียวมีสองตัวเลข

**อาการ:** SummaryBar โชว์ `WIN RATE 71.6%` แต่ ANALYTICS โชว์ `69.7%` — หน้าจอเดียวกัน
และ `TOTAL P&L` ไม่มีผลขาดทุนของ option อยู่ในนั้น

**สาเหตุ:** ตอนเอา option เข้า PORT ผมใส่ผลลัพธ์ไว้ใน field **แยก** (`options_realized_base`)
เพราะดูปลอดภัยกว่า แต่ `/summary` คำนวณ `pnl_base`/`wins`/`losses` จากตาราง `trades` อย่างเดียว
→ headline number จึงไม่นับ option เลย ส่วน `/analytics` ที่ append synthetic option row เข้า
`closed_rows` กลับนับ → **สองหน้าคำนวณคนละฐาน**

**Fix:** fold เข้า field หลักไปเลย (`pnl_base`, `wins`, `losses`, ytd, `global_win_rate`)
แล้วให้ field แยกเป็น **breakdown** ไม่ใช่ addend

⚠️ **ตอน fold ต้องไล่ลบการบวกซ้ำทุกที่** — `AnalyticsTab` เคยบวก `options_realized_base`
เองอีกรอบ และ `cash_base` ก็มี term `opt_realized` แยก ถ้าไม่ลบจะกลายเป็นนับสองเท่าทันที

**กฎทั่วไป:** เพิ่ม instrument class ใหม่เข้าระบบ ให้ไล่ทุก aggregate ที่มีคำว่า *total* /
*win rate* / *count* ว่ามันอ่านจากตารางเดิมตารางเดียวหรือเปล่า — field แยกที่ "ปลอดภัย"
คือการเลื่อนปัญหาไปให้คนอ่านตัวเลขแทน

**Sentinel ที่ควรมี:** ผลลัพธ์ที่ไม่รู้ (เช่น ปิด position โดยไม่บันทึกราคา) ต้อง**ไม่นับ**
ทั้ง W และ L — ไม่ใช่นับเป็น L เพราะ P&L เป็น 0

---

## useEffect ที่มี array/object ใน deps → debounce ยิงแล้ว abort ตัวเองไม่รู้จบ

**อาการ:** กราฟไม่ขึ้นเลยทั้งที่กรอกข้อมูลครบ ไม่มี error ใน console
`read_network_requests` เห็น **491 requests ทั้งหมดเป็น `ERR_ABORTED`**

**สาเหตุ:** hook รับ `legs` ที่ caller สร้าง inline (`const legs = [...]` ในตัว component)
identity จึงเปลี่ยน**ทุก render** พอใส่ไว้ใน dependency ของ `useEffect` ที่ทำ debounce:

```ts
useEffect(() => {
  const t = setTimeout(fetchIt, 400);
  const c = new AbortController();
  return () => { clearTimeout(t); c.abort(); };
}, [key, legs]);        // ← legs เปลี่ยน identity ทุก render
```

→ effect re-run ทุก render → cleanup ยิง `clearTimeout` + `abort()` ทุกครั้ง → **ไม่มีวันครบ 400ms**

**Fix:** ใช้ค่า serialize เป็น dependency ตัวเดียว แล้ว parse กลับข้างใน

```ts
const key = legs?.length ? JSON.stringify(legs) : "";
useEffect(() => {
  const payload = JSON.parse(key);
  ...
}, [key]);              // ← เสถียรตามเนื้อหา ไม่ใช่ตาม identity
```

`useMemo` ที่ caller ช่วยได้อีกชั้น แต่ต้องแก้ที่ hook เป็นหลัก เพราะ caller ตัวถัดไปจะพลาดซ้ำ

**วิธีจับ:** `read_network_requests` แล้วดูจำนวน request — ถ้าเห็นหลักร้อยของ endpoint เดียว
ที่ควรถูกเรียกไม่กี่ครั้ง แปลว่า effect กำลัง re-run เป็นลูป

---

## POP ของ OTM option **ลดลง** เมื่อ vol สูงขึ้น — ไม่ใช่บั๊ก

**อาการ:** เพิ่ม IV จาก 30% → 90% แล้ว probability of profit ลดจาก 44.5% → 32.8%
ดูขัดสามัญสำนึกเพราะ "ผันผวนมากขึ้นน่าจะมีโอกาสถึง strike มากขึ้น"

**เหตุผล:** ภายใต้ risk-neutral lognormal `mean` คงที่ที่ forward แต่
`median = S·exp((r − σ²/2)T)` ซึ่ง**ตกลง**เมื่อ σ โต — σ=0.30 median 100.75, σ=0.90 median 70.29
การกระจายเบ้ขวามากขึ้น หางขวายาวขึ้นจริง แต่มวลส่วนใหญ่เลื่อนลง

ตรวจกับสูตรปิด `N(d₂)` แล้วตรงทุกหลัก (diff 0.00e+00) — engine ถูก **assertion ในเทสต์ผิดเอง**

**บทเรียน:** เทสต์ที่เขียนจากสัญชาตญาณเรื่อง distribution มีโอกาสผิดสูง
ควรตรวจกับสูตรปิดที่คำนวณแยกอิสระ ไม่ใช่กับความรู้สึกว่า "ควรจะมากขึ้น/น้อยลง"

---

## เพิ่มตารางใหม่แล้วลืม sync — หรือใส่ผิดลำดับจน FK พัง

**เช็กลิสต์เวลาเพิ่มตารางที่ผู้ใช้กรอกข้อมูลเอง:**

1. ใส่ใน `backend/sync/config.py::SYNC_TABLES` พร้อม **natural key** (ห้ามใช้ auto-increment id —
   ชนกันข้ามเครื่อง เหมือน `symbol_lists` / `trade_audit_log` ที่ถูกกันออกด้วยเหตุผลนี้)
2. **ลำดับในลิสต์ = ลำดับ INSERT ตอน restore** และ `get_db()` เปิด `foreign_keys` ไว้
   → ตารางที่ถูกอ้างถึงต้องมาก่อนตารางที่อ้าง ไม่งั้น restore พังด้วย `IntegrityError`
3. ถ้าเป็นแถวที่ถือเงิน ใส่ `MONEY_TABLES` ด้วย (delete ชนะเฉพาะเมื่อ timestamp ใหม่กว่าจริง)
4. `updated_at` + trigger 3 ตัว **ระบบใส่ให้เอง** ผ่าน `init_sync_layer()` — แต่ต้องรันใหม่
   หลังแก้ config (`main.py` เรียกตอน startup) ตรวจด้วย:
   `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_<table>_sync_%'`
   ต้องได้ 3 อัน
5. ไม่ต้องบั๊มพ์ `SCHEMA_VER` — peer เก่าข้ามตารางที่มันไม่รู้จักเอง

**กับดักที่เจอจริง:** ตาราง *market state* ที่ดูเหมือน "derived" มักเป็นตาราง**ที่ห้ามไม่ sync ที่สุด**
IV/greeks/spot ณ อดีต **rebuild ไม่ได้** เพราะ provider รายงานแต่ปัจจุบัน — ถ้าไม่ sync
เครื่องที่สองจะเสียข้อมูลนั้นถาวร (`iv_snapshots` มีคอมเมนต์อธิบายเรื่องนี้ไว้อยู่แล้ว
แต่ผมยังเขียน `option_trade_greeks` ว่า "rebuilt on demand" ซึ่งผิด)

**วิธี verify โดยไม่ต้องมี 2 เครื่อง:** `export_snapshot()` จาก DB ที่มีข้อมูล แล้ว `restore()`
ลง DB เปล่า — เท่ากับ Drive pull ทุกประการ ตรวจว่าจำนวนแถวตรง ไม่มี FK error และ view ที่ derive
มา rebuild ถูก

---

## Mean baseline ทำให้ indicator "ไม่ให้ข้อมูล" — เหตุการณ์สำคัญถูกกลบด้วยเหตุการณ์สำคัญ (2026-09-13)

**อาการ:** เปิด volume pane / RVOL แล้วรู้สึกว่าดูไม่ได้ข้อมูลอะไร spike ที่รู้ว่าใหญ่กลับอ่านได้แค่ ~1.3×

**สาเหตุ:** `rvol.ts` เดิม (และ `watchlist_signals._scan`, `alerts/operands._rvol_series`) ใช้
**mean** เป็น baseline — mean มี breakdown point = 0% → earnings spike ครั้งเดียวดัน baseline ค้างไว้
ทั้ง lookback แล้ว spike ครั้งถัดไปอ่านเป็นเรื่องธรรมดา

**Pattern ที่ใช้ซ้ำได้ (ไม่ใช่แค่ volume):**

| ปัญหา | ทางแก้ | เหตุผล |
|-------|--------|--------|
| baseline ถูก outlier ดึง | median + MAD×1.4826 | breakdown point 50% เทียบ 0% |
| distribution เบ้ขวา (volume, turnover, dollar vol) | คิดบน `ln(x)` | z บน x ดิบทำให้ทุก spike อยู่แถว 4-8 เสมอ แยกแยะไม่ได้ |
| ratio เทียบข้าม symbol ไม่ได้ | z-score | variance ต่างกัน → threshold เดียวหมายถึงคนละเรื่อง |
| MAD = 0 (ค่าซ้ำเกินครึ่ง) | fallback เป็น σ แล้วถ้ายัง 0 → คืน null | float error ทิ้ง σ ไว้ ~1e-16 → หารแล้ว z ระเบิดเป็น 1e15 (`MIN_SIGMA` 1e-6) |

**ที่อยู่:** `components/bloomberg/lib/volume-stats.ts` (frontend) + `backend/alerts/operands._vol_z_series`
(daily bars, mirror กันเป๊ะ — มี pinned vector ใน `tests/test_alerts_operands.py` กันไม่ให้ drift)

---

## RVOL: ค่าบนชาร์ตกับค่าที่ alert ใช้ **ต่างกันโดยเจตนา** (2026-09-13)

`operands.py` docstring ประกาศไว้ว่า math ต้อง mirror สิ่งที่ชาร์ตแสดง — ข้อยกเว้นเดียวคือ RVOL:

| อ่านจาก | baseline | เหตุผล |
|---------|----------|--------|
| pane บนชาร์ต (`scale: ratio`) | **median** (default ใหม่) | เป็นค่าที่ถูก ไม่ถูก spike ก่อนหน้าดึง |
| alert operand `output: "rvol"` | **mean** (frozen) | rule ที่ผู้ใช้เก็บไว้แล้วไม่มี key `baseline` — ถ้าเปลี่ยน default ทุก rule "RVOL ≥ 2" จะยิงบ่อยขึ้นทันทีโดยไม่มีใครสั่ง (median < mean → ratio สูงขึ้น) |
| alert operand `output: "z"` | median/MAD บน ln V | สิ่งที่ `RVOL_LABELS` สร้างให้ rule ใหม่ทุกอัน — ตรงกับชาร์ตเป๊ะบน daily bars |

⚠️ ห้ามเปลี่ยน default ของ `_rvol_series` เป็น median และห้ามลบ output `rvol` — มันคือสัญญาที่ให้ไว้กับ
rule ที่เก็บอยู่ใน DB แล้ว การเพิ่ม output ใหม่ปลอดภัย การเปลี่ยนความหมายของ output เดิมไม่ปลอดภัย

**ถ้าเพิ่ม output ใหม่:** ต้องใส่ใน `BACKEND_SUPPORTED` ที่ `lib/alerts/__tests__/labels.test.ts` ด้วย
— มี guard test คอยจับ label ที่อ้าง output ที่ backend resolve ไม่ได้ (เจอจริงตอนเพิ่ม `z`)

---

## Volume z-score บน index พุ่งถึง +9…+13 — ไม่ใช่บั๊ก แต่ทำให้ threshold ใช้ไม่ได้ (2026-09-13)

**อาการ:** เปิด VEVT บน `^DJI` → z ของ event อยู่ที่ +7 ถึง +12.8 และเกือบทุกแท่งที่ volume สูงกลายเป็น event
ขณะที่หุ้นเดี่ยว (AMD) ให้ z อยู่ในช่วง +2.4…+4.0 ตามที่ควรเป็น

**สาเหตุ:** volume ของ index = ผลรวมของ component หลายร้อยตัว → dispersion ของ `ln V` แคบมาก
(MAD เล็ก) → z = (ln V − median) / σ ระเบิดขึ้นเพราะตัวหารเล็ก ไม่ใช่เพราะตัวตั้งใหญ่
ทางสถิติถูกต้อง ("เทียบกับ dispersion ของตัวเองแล้วนี่คือ extreme จริง") แต่ threshold ที่ตั้งไว้สำหรับหุ้นเดี่ยว
(`climaxZ` 2.5 / `notableZ` 1.5) ใช้กับซีรีส์ dispersion แคบไม่ได้

**ข้อสรุปการใช้งาน:** อ่าน VEVT / VOL Z กับ **หุ้นเดี่ยวหรือ ETF** เป็นหลัก บน index ให้ถือว่า ranking
(อันไหน z สูงกว่า) ยังใช้ได้ แต่ระดับสัมบูรณ์ใช้ไม่ได้ ถ้าจะใช้บน index จริงต้อง calibrate threshold
ต่อ instrument class — ยังไม่ได้ทำ

---

## 🔴 sync pull ตายเงียบ 2 วัน — surrogate `id` ข้ามเครื่อง (fixed 2026-09-13)

**อาการ:** pull ข้อมูลจากอีกเครื่องไม่เข้าเลย แต่ **push ออกได้ปกติ** ข้อมูลไหลทางเดียว
เปิด PORT → OPTIONS แล้วว่างเปล่าทั้งที่อีกเครื่องกรอกไว้แล้ว และ `git pull` ก็ครบ

```
WARNING sync: sync_startup failed (continuing local-only):
              UNIQUE constraint failed: trade_audit_log.id
GET /api/sync/status → last_pull: 2026-09-11 · last_push: 2026-09-13   ← ห่างกัน 2 วัน
```

**สาเหตุ:** `trade_audit_log` ใช้ `id INTEGER PRIMARY KEY AUTOINCREMENT` เป็น PK แต่ประกาศ
natural key ใน `SYNC_TABLES` เป็น `event_id` (uuid) — `restore._upsert` ส่ง **`id` ของเครื่องอื่น**
เข้ามาใน INSERT ด้วย → ชนกับ `id` ของ **แถวคนละแถว** ในเครื่องปลายทาง และ `ON CONFLICT(event_id)`
ดักไม่ได้เพราะมันคนละคอลัมน์

ส่วนที่ทำให้เป็นหายนะ: `except` ดักแค่ `sqlite3.OperationalError` → `IntegrityError` หลุดออกจาก
`with _guarded(conn)` ซึ่งครอบ **ทั้ง `SYNC_TABLES` ไว้ใน transaction เดียว** → **rollback ทั้งก้อน**
option ที่ upsert สำเร็จไปแล้ว (บรรทัด 45-60 ของลิสต์) หายไปพร้อมกัน เพราะ `trade_audit_log`
อยู่บรรทัด 106 คือพังทีหลัง

**Fix** (`backend/sync/restore.py`):

```python
# 1. surrogate id ห้ามข้ามเครื่อง — ปล่อยให้ SQLite แจก id ใหม่
cols = [c for c in row.keys() if not (c == "id" and "id" not in pk)]

# 2. แถวเดียววางไม่ได้ ต้องเสียแค่แถวนั้น ไม่ใช่ทั้ง snapshot
except (sqlite3.OperationalError, sqlite3.IntegrityError):
    continue
```

เงื่อนไข `"id" not in pk` ทำให้ตารางที่ใช้ `id` เป็น natural key จริง (`trades`, `transactions`,
`paper_option_positions`) ไม่กระทบ

**กฎทั่วไป:** ถ้าเพิ่มตารางเข้า `SYNC_TABLES` ด้วย natural key ที่ **ไม่ใช่ `id`** ต้องแน่ใจว่า
`id` เดิมเป็น surrogate ที่ไม่ถูกส่งข้ามเครื่อง — comment ใน `sync/config.py:27` เตือนเรื่อง
"auto-increment ids collide across devices" ไว้แล้ว แต่ `_upsert` ไม่ได้ทำตาม

**วิธีตรวจว่า sync ยังดีอยู่ไหม (ทำเป็นนิสัยหลัง pull):**

```bash
curl -s localhost:9317/api/sync/status | python3 -m json.tool | grep -E "last_pull|last_push"
```

`last_pull` ที่เก่ากว่า `last_push` มากๆ = pull พังอยู่ ไม่ใช่ "ไม่มีอะไรใหม่" — เพราะ pull
ตรวจ manifest ทุก 20 วินาทีและอัปเดต timestamp ทุกครั้งที่สำเร็จ

Regression test: `backend/tests/test_sync_surrogate_id.py` (5 เคส)

## `.claude/launch.json` ไม่ถูก env-doctor ตรวจ — port ค้างที่ 3000 (fixed 2026-09-13)

`npm run doctor` อ่าน port จาก `package.json`, `.env.local`, `backend/.env`, `lib/constants.ts`,
`backend/config.py` — **ไม่รวม `.claude/launch.json`** ตอนย้าย 3000/8000 → 9317/9318 ไฟล์นี้จึงค้างที่
`"port": 3000` เงียบๆ ผลคือ preview/browser tool เปิดพอร์ตผิด (แก้เป็น 9318 แล้ว)

ถ้าย้าย port อีกครั้ง: `.claude/launch.json` เป็นที่ที่ **4** ที่ต้องแก้ นอกเหนือจาก 3 ที่ที่ `CLAUDE.md` ระบุ

---

## `?? []` ใน render body = identity ใหม่ทุกครั้ง → effect วน (NEWS WATCHLIST, 2026-09-13)

**อาการ:** console ยิง `Maximum update depth exceeded` ~50-67 ครั้งทุกครั้งที่เปิดแท็บ NEWS
(React หยุดเองที่ depth 50 จึงไม่ค้าง แต่กลบ error จริงทั้งหมดใน console)

**สาเหตุ:** `components/bloomberg/views/news/watchlist-tab.tsx:269-286`

```tsx
const sectors = data?.sectors ?? [];   // data ยังไม่มา → [] ใหม่ทุก render
useEffect(() => { onMarketsChange(...); }, [..., sectors, symbolMeta, ...]);
```

effect ส่งค่าขึ้น parent → parent `setState` → re-render → `[]` ใหม่ → effect วนอีก
หยุดเองเมื่อ data มาถึงเพราะ identity นิ่ง อาการจึงเป็น **burst ตอนเข้าแท็บ** ไม่ใช่ค้างถาวร

**กฎ:** `?? []` / `?? {}` ใน render body ห้ามเข้า dependency array เด็ดขาด ใช้ค่าคงที่นอก component
(`const EMPTY: T[] = []`) หรือ `useMemo` — เหมือนกับที่ `useChartIndicators` ทำกับ `EMPTY_MARKERS`

**วิธีจับว่าใครเป็นต้นเหตุ** (console buffer ไม่เคลียร์ตอน navigate จึงนับจาก log ตรงๆ ไม่ได้):

```js
window.__loopCount = 0;
const orig = console.error;
console.error = (...a) => { if (String(a[0]).includes("Maximum update depth")) window.__loopCount++; return orig(...a); };
```

แล้วกดทีละ view / เปิดทีละ panel แล้วอ่าน `window.__loopCount` — ตัวเลขกระโดดตรงไหน ต้นเหตุอยู่ตรงนั้น

รายละเอียด + วิธีแก้: `memory/reports/news-watchlist-render-loop-risk-report.md` (ยังไม่แก้ — นอก scope)

---

## Rate limit ของ vendor ถูกรายงานเป็น "Internal server error" (fixed 2026-09-13)

**อาการ:** UI ขึ้น `Could not load MSFT IV. Internal server error` เหมือนโค้ดพัง ทั้งที่ไม่มีอะไรพัง

**สาเหตุ:** สองชั้นที่ทำงานถูกต้องทั้งคู่ แต่รวมกันแล้วให้ผลผิด

1. `routers/*.py` จับ `except Exception` แล้วโยนเป็น **500** — รวมถึง `YFRateLimitError`
2. `main.py` handler เห็น ≥500 เลยแทนข้อความด้วย `"Internal server error"` (ถูกต้อง — กัน internal path รั่ว)

ผลคือ **เรื่องชั่วคราวของ upstream ถูกรายงานว่าเป็นความผิดพลาดภายในระบบเรา** ข้อความจริงอยู่แค่ใน log
ฝั่งผู้ใช้จึงไม่มีทางรู้ว่าต้องแค่รอ ไม่ใช่ไปหาบั๊ก

**Fix:** `sources/errors.py` — `UpstreamRateLimited(HTTPException)` status **429** + `Retry-After`
429 อยู่ต่ำกว่า 500 ข้อความจึงผ่าน handler กลางไปถึง client ได้

จุดแปลง 3 ชั้น:
- `sources/yfinance_source._RateLimitAwareTicker` — Ticker เป็น lazy (`.info` / `.options` /
  `.option_chain` ยิงตอนเข้าถึง) error จึงโผล่ใน router ไม่ใช่ใน source layer proxy จึงเป็นที่เดียว
  ที่เห็นทุก access
- `main.py::_rate_limited_response` — ตาข่ายรับสำหรับ path ที่ไม่ผ่าน Ticker (`yf.download` ตรงๆ)
- guard `except HTTPException: raise` ก่อน `except Exception` ใน 7 router (19 จุด) —
  ไม่งั้น 429 จะถูก relabel เป็น 500/422/404

**กับดักที่สอง — throttled into silence:** yfinance บางครั้งตอบ **list ว่าง** แทนที่จะ raise
ทำให้ `if not expirations → 404 "No options available for MSFT"` ซึ่งผิดพอๆ กัน (MSFT มี option แน่นอน)
แก้ด้วย `note_rate_limit()` / `recently_rate_limited()` — ถ้าเพิ่งโดน throttle ภายใน 45 วิ
ให้ตีความ "ว่าง" เป็น 429 แทน 404 heuristic นี้**อัปเกรดเฉพาะผลลัพธ์ที่ว่าง** ไม่แตะผลที่มีข้อมูล
จึงบังข้อมูลจริงไม่ได้ และ window (45s) สั้นกว่า `Retry-After` (60s) เพื่อให้หุ้นที่ไม่มี option จริง
กลับไปเป็น 404 ก่อนที่ client จะ retry

**กฎ:** error ของ upstream ที่ retry ได้ ห้ามเป็น 5xx — 5xx แปลว่า "ระบบเราพัง" ซึ่งสื่อสารผิด
และทำให้ข้อความที่ช่วยได้ถูกกรองทิ้ง

Tests: `backend/tests/test_upstream_rate_limit.py` (12 เคส)

---

## Raw SVI ขึ้น "FIT ERROR" เพราะ validation สองชั้นขัดกันเอง (fixed 2026-09-13)

**อาการ:** IV smile panel ขึ้น `FIT ERROR` ทั้งที่ chain โหลดมาปกติและ smile ดูฟิตได้สบาย

**สาเหตุ:** สองชั้นในโค้ดเดียวกัน "ตกลงสัญญา" ไม่ตรงกัน และชั้นที่เข้มกว่าชนะ

| ชั้น | ทำอะไรกับ point ที่ใช้ไม่ได้ |
|------|------------------------------|
| `SviSampleIn` (pydantic, `routers/options.py`) | `ivPercent: Field(gt=0, le=10000)` → **422 ทั้ง request** |
| `analytics/svi.fit_raw_svi` | **ข้ามทิ้ง** (`iv_pct > 0.01`, `math.isfinite`) — มี test ยืนยันอยู่แล้ว |

option chain จริงมีแถวตายเสมอ — strike ที่ไม่มี quote Yahoo คืน `impliedVolatility = 0` แถวเดียวจาก 60
ทำให้ทั้ง request ถูกปฏิเสธก่อนที่ fitter จะได้ทำงาน ทั้งที่ fitter จัดการเคสนี้ได้อยู่แล้ว

**Fix:** ให้ pydantic คุมแค่ **โครงสร้าง** (จำนวน series, จำนวน point, ขอบบนกัน payload ระเบิด)
ส่วนความถูกต้องของ *ค่า* เป็นหน้าที่ fitter ซึ่งทำได้ดีกว่าและถูกทดสอบไว้แล้ว
ผลคือ slice ที่ฟิตไม่ได้จะคืน `status: "unavailable"` + `reason` (คำตอบจริงเกี่ยวกับข้อมูล)
แทน 422 (คำตอบเกี่ยวกับ API ของเรา)

**หลักการ:** ถ้ามีสองชั้นตรวจเรื่องเดียวกัน ให้ชั้นที่ **รู้บริบทมากที่สุด** เป็นเจ้าของ แล้วอีกชั้นถอยออก —
การตรวจซ้ำที่เข้มกว่าจะกลายเป็นตัวปิดกั้นไม่ให้ตัวที่เก่งกว่าได้ทำงาน

`test_svi.py::test_endpoint_rejects_invalid_or_unbounded_requests[override7]` (strike=0)
เคยยืนยันพฤติกรรมเดิมไว้ — ย้ายออกมาเป็น test ของพฤติกรรมใหม่พร้อมเหตุผล ไม่ได้ลบทิ้งเงียบๆ

**ยังไม่ได้แก้:** IV สูงผิดปกติ (เช่น 15000%) ผ่าน filter ของ fitter ได้ (finite และ > 0.01)
แล้วทำให้ optimizer ไม่ converge → ทั้ง expiry เป็น `unavailable` repo มี `IV_SANITY_MAX = 5.0` (500%)
ใช้อยู่แล้วกับ IV snapshot ถ้าจะปิดช่องนี้ควรใช้ค่าเดียวกันเพื่อความสม่ำเสมอ

---

## ⚠️ ตาราง "เงิน" ใหม่ต้องเข้า `AUDITED_TABLES` ไม่งั้น edit ไม่ถูกบันทึก (2026-09-16)

`audit_events` เขียนด้วย SQLite trigger เท่านั้น (`db.init_audit_layer`) ครอบคลุมเฉพาะตารางใน
`db.AUDITED_TABLES`. เพิ่มตารางที่เก็บเงิน/เทรดใหม่ → ต้องเพิ่มชื่อใน tuple นั้น (และใน `SYNC_TABLES`
ถ้าต้อง sync). คอลัมน์ใหม่จาก `_ensure_column` ไม่ต้องทำอะไร — trigger ถูก DROP/CREATE ใหม่ทุก start.
- `init_audit_layer()` ต้องรัน **หลัง** `init_sync_layer()` (ต้องมี `_sync_guard`); test fixture ที่อยากได้ log ต้องเรียกเองด้วย
- UPDATE ที่เปลี่ยนแค่ `updated_at` ไม่ log (sync trigger stamp ซ้ำทุก write → จะได้ event ซ้อน)
- ใส่เหตุผล: `with audit_reason(conn, reason):` บน connection เดียวกับ write — อย่าเปิด `get_db()` ใหม่
- **ห้าม** รัน `python -c "import main"` เพื่อ smoke test — init รันกับ DB จริงและ start sync thread

## 🟡 FRED release 101 "FOMC Press Release" มีวันที่ทุกวัน — ใช้หาวันประชุมไม่ได้ (2026-09-16)

`fred/releases/dates` คืน release 101 ทุกวัน (series รายวันอย่าง DFEDTAR). วันประชุมที่เชื่อได้จาก FRED
มีแค่ release 326 (Summary of Economic Projections) = 4 ครั้ง/ปี. ส่วน CPI (10), Employment Situation (50),
PCE (54), GDP (53) ใช้ได้ตรง. `_FOMC_2026` ใน `macro.py` เคยช้าไป 1 วัน — **fixed 2026-09-17**: วันประชุมย้ายไป
`backend/event_calendar.py` (`FOMC_DECISIONS` = วันที่ 2 ของการประชุม ตาม federalreserve.gov, ถึง 2027-12-08; UI เตือนเองเมื่อ <60 วัน).
ปีใหม่ → เพิ่มวันใน tuple นั้น ที่เดียว. `api.stlouisfed.org` read-timeout เป็นพักๆ → fetch มี retry 1 ครั้ง + cache ผลที่ degraded แค่ 60 s

