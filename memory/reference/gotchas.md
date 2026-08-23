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
