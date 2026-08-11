# Gotchas, Error Dictionary & Anti-Patterns

> Read this before investigating any bug. Most errors have been seen before.
> **See also:** [api-endpoints.md](api-endpoints.md) | [data-shapes.md](data-shapes.md) | [architecture.md](architecture.md) | [frontend-structure.md](frontend-structure.md)

---

## Error Dictionary — Symptoms → Root Cause → Fix

### Frontend / React

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| localStorage setting not saved after refresh | `useEffect([dep])` fires on mount → overwrites loaded value with DEFAULT | Read in `useState` initializer, write in `useEffect([val])`. See pattern in CLAUDE.md |
| Portfolio COST column (per-row) doesn't sum to the COST badge/ANALYTICS total for accounts holding non-THB positions bought a while ago | `OpenPositionsTab.tsx` row-level `costVal` computed `entryNative × volume` using `toBase()` = **today's live FX**, while backend `cost_basis_base` (used by the badge + ANALYTICS OPEN COST BASIS) uses **entry-date FX** — the two diverge as USD/THB moves after purchase | **FIXED 2026-07-14** — row `costVal` now prefers `p.cost_basis_base` (entry-date FX), only falls back to live-FX `entryNative × volume` when backend didn't supply it or a manual cost override is set. See `sessions/2026-07-14-cash-transfer-followup.md` |
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
