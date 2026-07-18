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

**Correct pattern (see `backend/sync/`):** keep the `.db` local (working copy); exchange only validated **JSON snapshots** through the cloud folder. Snapshot writes are atomic (temp + `os.replace`) and hash-validated on read so a half-synced Drive file is skipped, not loaded. Merge is row-level last-write-wins on `updated_at`; deletes use `sync_tombstones` (trigger-recorded) so a deleted row does not resurrect on the next merge.

## Bug: RISK tab blank — `float() argument must be ... not 'dict'` (fixed 2026-07-12)

**Symptom:** PORT → RISK shows nothing (blank). `GET /api/v2/portfolio/risk/metrics` returns HTTP 500 `{"detail":"Internal server error"}`. RiskTab silently swallowed the error → blank.

**Root cause:** `risk.py get_risk_metrics` set `pos["current_price"] = prices.get(pos_yf[i])`, but `_batch_fetch_prices` (portfolio_v2.py) returns `{sym: {"price":..., "prev_close":...}}` — a **dict**, not a number. `_compute_portfolio_risk` line ~315 then did `float(price) * vol` → `TypeError: float() argument must be a string or a real number, not 'dict'`.

**Fix:** extract `.get("price")` from the snapshot dict:
```python
snap = prices.get(pos_yf[i])
pos["current_price"] = snap.get("price") if isinstance(snap, dict) else snap
```
Same pattern used in the new `/risk/capm` endpoint. Also added an error state + RETRY button to `RiskTab.tsx` so a future backend 500 shows a message instead of a blank pane.
