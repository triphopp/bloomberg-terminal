# Project Architecture

Python backend serves yfinance + FRED + Alpha Vantage + Ollama + BOT data to Next.js frontend.

**Why yfinance in Python:** Yahoo Finance blocks direct server-side fetch (returns HTML consent page). yfinance in Python works reliably.

**Why SSE for AI:** Ollama streams tokens — proxying SSE through FastAPI → Next.js → React gives real-time output without polling.

**Why FRED for macro:** Free CSV endpoint, no API key, covers all major US macro series. AV (Alpha Vantage) is the fallback when FRED is unreachable (e.g. firewall).

**Why BOT API token (no Bearer):** IBM API Connect format — raw base64 JSON token goes directly in `Authorization` header, no prefix.

## Accounting preparation layer (2026-09-25)

`ledger_backfill.build_events` reconstructs legacy transactions → `ledger_engine.replay` calculates deterministic Decimal AVCO/FIFO cards → `accounting_checks` registry supplies read-only API/CLI findings. Legacy `stock_card` AVCO diagnostics remain tolerant so damaged histories can still be reported; strict preview rejects impossible sales. The live sell/summary/read paths have not switched.

**Ledger v2 (2026-09-29, `backend/ledger.py`)** — posting service over `ledger_events`: Decimal strings, wallets, `book_date` vs `trade_date`, period close against a broker figure (DB trigger lock), reversal groups, fee true-up. SHADOW accounts: triggers on legacy money tables queue `ledger_dirty`; `db.get_db()` calls `ledger.flush_dirty` before commit → `ledger.project` (desired = `ledger_backfill.build_events`, keyed `source_key`, fingerprint diff → reverse + repost). A closed-period hit raises `PeriodClosed` → the whole legacy write rolls back (409) unless `X-Ledger-Correction`. Screens still read legacy (`PRIMARY` locked).

- `backend/accounting_io.py`: read-only consistent SQLite transaction + `.backup()` (includes WAL) + integrity check.
- `backend/accounting_preflight.py`: explicit dividend tax arithmetic, XD eligibility/sub-accounts, validated trade dates, opening market value vs cost, wallet FX coverage, transfer in-transit calculator. No persistence/scheduler.
- `backend/scripts/accounting_audit.py`: local audit; optional localhost endpoint samples C1 and live NAV samples N1. Missing evidence never counts as pass.
- `backend/scripts/preview_cost_methods.py`: both-method historical comparison without restatement.
- `backend/scripts/backfill_ledger.py`: backup before apply, refuse audit errors/unacknowledged warnings, recompare reconstruction under a write lock, atomic/idempotent insert; changed posted content requires reviewed reversal.
- `backend/scripts/backfill_nav.py --validate --validation-json ...`: compare only `source='live'`, never validation against generated backfill itself.

Still pending: broker cost-method confirmation, actual opening statements, remaining S1–S7 persistence/migrations, shadow dual-write, append-only cloud sync, and read switch. [Plans/evidence](../sessions/2026-09-25-accounting-foundation.md).

**Evidence phase extension:** `backend/accounting_statements.py` stores API append revisions of manually referenced broker statements and compares each with reconstructed pre-offset cash and day-end holdings. `broker_statements` is synced (UUID PK; `updated_at`) and audited; concurrent current revisions are an R3 conflict. `cash_adjustments.category` is additive with legacy `UNKNOWN`; R1/R2 track missing reasons. The statement reference itself is not authenticated and no user's actual statement has been entered. See [follow-up session](../sessions/2026-09-25-accounting-evidence.md).

**Dime Activity fills:** `backend/broker_executions.py` validates each manifest row against an image SHA-256 before `backend/scripts/import_broker_executions.py` imports it. `broker_executions` is synced and audited, with deterministic IDs and idempotent insert. It records broker execution evidence only; live `trades`, cash and journal calculations do not read it. Images and the private manifest remain under ignored `backend/backups/accounting-evidence-20260925/`. See [import session](../sessions/2026-09-25-dime-broker-execution-evidence.md).

**2024-25 Excel history review:** `backend/scripts/stage_portfolio_history.py` stages source rows and market-price checks in local `portfolio_history_review`; `routers/portfolio_v2.py` exposes read-only `/history-review` through the Next proxy. This table is deliberately outside live trades/cash/NAV and cloud sync until ambiguous execution dates, cost lots and Dime funding currency are resolved. Audit CSVs and the online DB backup live under ignored `backend/backups/portfolio-history-20260926/`.

**Portfolio takeover (2026-09-26):** lots received in kind are `trades.acquisition_type='TRANSFER_IN'` at fair value on the transfer date, previous owner's cost in `original_price_entry` (memo, fixed through AVCO rebases and splits). `GET /takeover` reports prior cost / value at transfer / inherited P&L / realized since. `backend/scripts/apply_portfolio_takeover.py` performed the one-off re-booking (also re-based live NAV snapshots and dropped backfill rows for `backfill_nav.py`). `/nav-index` now puts capital dated before a snapshot day into that day's base (`invested_before_day`).

**2024-25 import:** `backend/scripts/apply_portfolio_reconciliation_2024_2025.py` imported the 20 independently verified closed trades from the reconciliation workbook and released the matching cash offsets (`cash_adjustments` DATA_FIX), so today's cash did not move; the other 145 rows stay `REVIEW_REQUIRED`.

`GET /ledger/check` also returns `read_switch_gates`: posted journal coverage, source-cited statement coverage for active accounts, broker cost policy, shadow comparison and the current read path. These gates remain separate from a filtered finding count, so a zero-error `codes=` query cannot imply activation readiness.

## Running

See `project_summary.md` → How to Run (tray launcher `BloombergTerminal.exe`, `npm run dev:all`, or two terminals on ports **9317** backend / **9318** frontend).

## Data flow
```
Browser → Next.js (app/api/* proxies, PYTHON_API from lib/constants.ts) → FastAPI (localhost:9317)
        → yfinance (provider registry + yahoo_gate 6 concurrent + market_requests coordinator)
        / FRED / MOF / CBOE / CFTC / SEC EDGAR / Treasury fiscaldata / Gamma / BOT / World Bank / filesystem
Every outbound requests/yfinance call → upstream_health.record → logs/upstream.jsonl (+ /api/health/upstream)

Macro data path:
  /api/macro → memory cache (5min) → macro_series.json disk cache (per-series TTL 1d–30d)
             → FRED JSON API (primary, 2 retries) → Alpha Vantage (fallback) → yfinance (yield curve only)

BOT data path:
  /api/bot/* → memory cache (5min) → bot_cache.json (1–4h) → BOT API (one token per category)

Background work: main.py calls alert_scheduler.start_background_scan(), iv_scheduler.start_background_recorder()
and series_scheduler.start_background_recorder() at startup (explicit calls — never a scheduler started by an import);
COT refreshes in its own background thread (`cot-refresh`) when its cache is stale; the sync worker runs when SYNC_ENABLED.
```

## Backend Routers

65 routers in `backend/routers/`, all mounted in `main.py`. The maintained table (prefix + source per router) is
`project_summary.md` → "Backend Architecture — Modular Routers"; every endpoint is in `api-endpoints.md`.
Added 2026-09-25/26: `bonds.py`, `cot.py`, `discover.py`, `market_heatmap.py`, `dev.py`; `macro.py` gained
`/api/macro/calendar`; `portfolio_v2.py` gained `/takeover`, `/history-review` and the `/nav-index`
start-of-day flow rule.
Added 2026-09-28: `google_trends.py` (`/api/trends/{daily,interest}`, free public Google Trends; MCP-only consumer) and `fiscal_ai.py` (`/api/fiscal/*`, Fiscal.ai free trial; MCP-only consumer).

## Frontend Views (6, since 2026-09-26)

| Key | Atom value | Button | View file |
|-----|------------|--------|-----------|
| `1` | market (default) | MKT | `views/market-view.tsx` (eager) |
| `2` | news | NEWS | `views/news-view.tsx` → `views/news/` |
| `3` / `b` | bonds | BOND | `views/bonds/` (MARKET · CONDITIONS) |
| `4` / `p` | portfolio | PORT | `views/portfolio-view.tsx` → `views/portfolio/` |
| `5` / `t` | tail | TAIL | `views/tail-risk-view.tsx` + `views/tail/` |
| `h` | heatmap | — (command `heatmap(MARKET)`) | `views/heatmap-view.tsx` |

**Not routed:** `stock-view.tsx` (global search / heatmap / watchlist click), `volatility-view.tsx` (exported, unused).
**Deleted:** `market-movers-view.tsx`, `credit-view.tsx`, `clippings-view.tsx` (2026-09-25), `macro-view.tsx` (2026-09-17), crypto/fx views (2026-08-01), `rmi-view.tsx` (2026-05-24).
URL carries the view (`?view=bonds`, `layout/view-navigation.ts`).

## Key files

### Backend
- `backend/main.py` — app init, CORS, schema init, mounts all 61 routers; imports `dev_status`, `upstream_health`, `yahoo_gate` before any router
- `backend/mcp_server.py` — MCP stdio server (not mounted; separate process spawned by the MCP client via `/.mcp.json`). HTTP client of the backend, writes tagged `X-Thesis-Actor: agent:<name>`
- `backend/config.py` — All env vars + BOT tokens (BOT_API_TOKEN, BOT_IR_TOKEN, BOT_FX_TOKEN, BOT_STATS_TOKEN) + SEC_KEYS (old portal) + SEC2_KEYS (new portal, falls back to SEC2_API_KEY)
- `backend/db.py` — SQLite connection manager + schema init + compute_holdings() + sector_classifications helpers
- `backend/portfolio_options.py` — canonical option-lot valuation (2026-09-09; reads the
  normalized schema since 2026-09-10). The ONLY place an
  `option_positions` row becomes money: mark (chain `last` → mid → ask → entry cost → intrinsic if
  expired), cost/market value/unrealized in native AND base currency, and delta notional for
  exposure weighting. Batches one `option_chain()` per (underlying, expiry) and one spot per
  underlying. `portfolio_v2.py` imports it — never the reverse of `routers/options.py` (that would
  cycle through the provider + scheduler imports)
- `backend/analytics/option_payoff.py` — payoff geometry (2026-09-10): expiry curve, breakevens by sign-change + bisection, max profit/loss from the tail slope, T+0 curve through `greeks.py`'s Black-Scholes, and POP by integrating a lognormal over the profitable ranges. Black-Scholes is NOT duplicated in TypeScript — the browser computes only the expiry line, which is arithmetic
- **Option sync** — all five option tables are in `sync/config.py::SYNC_TABLES`, listed in FK
  order (`option_contracts` → `option_trades` → `option_trade_greeks` /
  `option_trade_matches` / `option_greeks_snapshots`) because `restore._upsert` walks the list
  in sequence with `foreign_keys` ON. The greeks tables sync for the same reason
  `iv_snapshots` does: a chain only reports NOW, so market state at a past trade cannot be
  re-derived on the other machine. There is NO lot state to sync — a lot is a view over
  trades and matches, so the peer rebuilds it
- **Option schema (2026-09-10)** — `option_contracts` / `option_trades` /
  `option_trade_greeks` / `option_trade_matches`, created in `db.py::init_portfolio_v2`.
  A lot is NOT a table: it is an OPEN trade that closes have not fully matched, computed by
  `v_option_open_lots`. Direction lives in `action`+`side`, never in the sign of `quantity`.
  `db.py::occ_symbol()` builds the contract's natural key. FIFO matching and greeks capture
  live in `routers/options.py`; `_migrate_option_positions()` in `db.py` is the one-way move
  off the old flat table and is a no-op once it has run
- `backend/portfolio_currency.py` — canonical instrument-currency + FX boundary: stored `trades.currency` first, dated USD/THB lookup, exit-date conversion for realized trading P&L, live MTM conversion, idempotent legacy backfill
- `backend/greeks.py` — Black-Scholes + Gram-Charlier fat-tail Greeks (added 2026-06-03); see memory/reports/options-greeks-math-report.md
- `backend/providers/` — OptionsProvider abstraction: `base_options.py` (abstract class + DataFreshness + OptionContract), `yahoo_options.py`. Swap by changing 1 line in options.py:26
- `backend/analytics/` — Signal computation modules (imported by routers, NOT mounted directly):
  - `dcf.py` — deterministic adaptive valuation engine (2026-09-13): 3-stage FCFF, revenue→FCFF, FCFE, excess-return, AFFO and normalized-cycle adapters; Bear/Base/Bull transforms, terminal-growth guard, valuation bridge and 5×5 sensitivity. It receives normalized inputs only and performs no provider/network work.
  - `layer_a.py`, `layer_b.py`, `layer_c.py`, `confluence.py` — Equity Allocation Signal (3-layer)
  - `country_rotation.py` — Country Equity Rotation scoring (14 ETFs)
  - `sector_bc.py` (business cycle), `sector_mom.py` (momentum), `sector_val.py` (valuation), `sector_factor.py` (macro APT), `sector_confluence.py` — Sector Selection Signal (11 SPDR ETFs)
  - `regime_calibration.py` — Regime Detection calibration math
  - `market_state/` — **per-symbol** latent-state model (2026-09-13), distinct from `regime_v2.py` which is market-wide. `features.py` (5 model features + 7 candidates kept only for the redundancy report) · `hmm.py` (Gaussian HMM + `filtered_posterior`, a ONE-PASS forward recursion that equals hmmlearn's prefix `predict_proba` to 1e-9 — same causal quantity `regime_v2` gets from O(n) forward-backward passes, verified in `tests/test_market_state.py`; archetype naming via Hungarian assignment so two states can never share a name) · `scores.py` (Trend/Momentum/Volatility + derivatives, tanh not clip) · `interpret.py` (the sentence; knows nothing about trading) · `strategy.py` (the decision layer; knows nothing about phrasing) · `validate.py` (walk-forward refit, overlap-adjusted t). **Interpretation and decision are separate modules on purpose** — see the package docstring
  - `svi.py` — optional Raw SVI smile slices: supplied percentage IV → total variance, deterministic multistart SciPy soft-L1 fit with positive minimum variance; parameters + IV RMSE and explicit unavailable states. `POST /api/options/smile-fit` runs in FastAPI's threadpool with a bounded payload cache. `GET /api/options/{symbol}` also uses the threadpool for independent multi-expiry Yahoo calls. No new provider, package or database schema.
- `backend/tests/` — ~1,013 pytest tests (portfolio, accounting, sync, options, COT, bonds, events, dev status …); pass `--basetemp` to a writable folder on Windows
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
- `components/bloomberg/layout/bloomberg-terminal.tsx` — view router (6 views), shortcuts, URL ↔ view sync, dev `BackendStatusBanner`
- `components/bloomberg/layout/terminal-header.tsx` / `mobile-nav.tsx` — nav links (`<a href>` via `view-navigation.ts`)
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


## Shared Watchlist market data (2026-09-23)

`browser per-symbol TanStack cache → SymbolBatcher/RequestQueue → Next marketDataProxy → watchlist/stock routers → market_snapshots → market_requests → Yahoo/Gamma`.

`backend/market_requests.py` is a process-local bounded coordinator, with lazy executors (no scheduler). Defaults: Yahoo leaf operations6 concurrent, Gamma2; separate quote assembly4 and PM assembly3 join the leaf work without occupying leaf slots. At most256 total in-flight/queued keys, max8192 cached keys and8192 short-lived failure entries. Identity includes provider, resource, normalized symbol and history period/interval/adjustment policy. Fresh hits and in-flight joins avoid duplicate provider work. A429 stops new/queued work for that provider until Retry-After; other failures briefly cache for5s. Timed-out consumers do not cancel running vendor calls or release their slots early. Single-read deadline22s; batch collect18s returns explicit pending/error statuses; Next deadline30s.

`market_snapshots.py` owns the existing rich quote contract (regular/pre/post fields preserved), shared raw info/fast-info (60s), adjusted history (TTL based on caller), and daily frames for alerts. Yahoo adapter `get_info`, `get_fast_info`, `download_quotes`, `get_history` use these shared leaves, so Portfolio/FX and Watchlist can reuse compatible requests. Raw Ticker methods elsewhere, bulk historical `download`, option chains, other providers and NEWS source fetches are not all migrated; this is not a universal limiter for every external API. Registry provider selection remains intact; rich quotes retain their pre-existing Yahoo source.

Signals cache per symbol900s; alert closed-bar trimming remains after the shared raw-history layer. Known absent history404 is skipped by alert frame conversion; transient failures do not become a cached successful scan. PM search/event-detail leaf requests share the coordinator, and confirmed no-market results alone get a900s negative cache. Instances are per Python process; multiple workers do not share memory/limits. No Redis dependency, DB migration or new background scheduler.

**2026-10-05:** Gamma leaf pool 2 → 4. A ticker's Polymarket ladder is built from the `/public-search` answer alone (it carries each event's markets); `/events?slug=` is only a fallback, so the "event-detail leaf requests" above are now rare.

## NEWS data path (2026-10-05)

`NEWS tab → React Query (first answer wait=1.5, then settle polls while pending) → Next proxy → routers/news_watchlist.py → one pull per (symbol, source) → rss.fetch_items / yf.Search`.

- `backend/rss.py` — pooled `requests.Session` (timeout 4/8 s). `fetch_items` / `parse_items`: ElementTree headline parser (title, link, summary, published ISO-UTC, thumbnail, video_id), feedparser fallback for malformed XML. `fetch_feed`: full feedparser object (social, Facebook).
- `backend/persist_cache.py` — `PersistentStore(name, max_age, maxsize)`: keyed dict of JSON-able entries (each with `ts`), written to `backend/cache/<name>.json` at most once per 5 s and read back at import. Used for the NEWS pulls and for symbol metadata Yahoo has no sector for. In-memory only with `name=None` (tests).
- `routers/news_watchlist.py` — `_pull_source` (one source, one symbol → store; a failure keeps the last good items and sets a 90 s retry), `_source_job` (single-flight per key, one executor per source), `_gather_news` (store + deadline → items per symbol, pulls still running, oldest pull time), `_resolve_metas` (memory → one SQLite query → persisted no-sector answers → yfinance).
- `routers/news.py` — `/api/news/feed`: assembled feed cache + per-piece cache (`_topic_piece`, `_rss_piece`), `swr=1` for the tab.
- `routers/polymarket.py` — market pool refreshed by one background thread while the expired pool is still served (≤ 30 min); answers are tagged with the pool they came from (`_pool_stamp`, `_cached_answer`); DB writes go through `_write_behind`.

## Request path & fan-out (2026-09-28)

- **Vendor calls once:** `market_snapshots.v7_quotes` batches Yahoo quotes (≤50/request, 30 s, in-flight sharing, no lock across I/O); `fast_info` / rich quote / heatmap / FX / portfolio read it first. Rich quote = v7 row + `info` fundamentals reused 30 min.
- **Push:** one SSE session per page (`stream_sessions.py`, `lib/quote-stream-client.ts`), interest by diff. REST polls back off while the stream carries every open symbol (`lib/stream-cadence.ts`).
- **Polls that stay:** heartbeat (15 s: dev · sync · providers · change-feed versions), price-only quote polls (`fields=price`), slow panels with ETag/304 (`lib/etag.ts`).
- **Edit-driven data:** DB-trigger change feed (`change_feed.py`) → heartbeat → `useChangeFeed` invalidation.
- **CPU:** I/O-bound work stays on threads. `http_tls.py` shares one TLS context (no per-connection CA load); `cpu_pool.py` (spawn ProcessPool, 2 workers, inline fallback) runs pure-Python parses that would hold the GIL for seconds — today the NY Fed ACM `.xls` (`cpu_tasks.parse_acm_xls`).
- **Multi-instance / Postgres:** design in `plans/completed/stream-sessions-change-feed.md` — feed leader via advisory lock, `NOTIFY market_ticks` fan-out, `stream_interest` table, per-instance sessions, change feed → plpgsql / `change_seq`.

### Margin (IBKR Reg T) — 2026-09-29
`backend/margin.py` is pure (Book → evaluate/analyse, shock search for distance to liquidation). `routers/margin.py` builds the Book from the same valuation PORT/PAPER already use and exposes status/overview/settings; `margin_scheduler.py` turns worsening levels into `alert_events` (`margin:<LEVEL>`). PAPER order paths call `routers.margin.paper_check` when margin is enabled for the account. UI: `MarginCard`, `MarginRibbon`, MGN column.


## Request latency + DB pool (2026-09-30)

- `backend/request_latency.py` — outermost ASGI middleware + `anyio.to_thread.run_sync` wrapper: per-request thread-queue / handler / DB timing → `logs/latency.jsonl` (>200 ms, route pattern only) and `/api/health/latency`. Also the "local lane": DB-only routers run on their own 16-thread limiter so upstream-bound routes cannot starve them.
- `db.get_db()` — pooled connections (see gotchas "DB read sometimes slow"); `db.connect()` is still the only opener; `db.close_pool()` for tests / before swapping the DB file.

## Thesis questions (2026-10-01)

`routers/questions.py` tracks what a thesis does not know yet. A question hangs under a parent with `if_a` / `if_b`
(how each answer would move the parent); a thesis has one root. Answers are checked by `_check_answer` and refused
with 422 unless they carry evidence — a zettel with url + quote — at the level claimed; INFERRED needs a testable
assumption, a circumstantial CONFIRMED needs two diagnostic signals from different origins. Agent answers are
proposals until the user accepts them. Status is never stored: `_derive` computes it from `question_answers`,
`question_assumptions` and `question_checks`, all of which are only ever inserted, so the op-log merge is a union
and two devices cannot hold different statuses for one history. Only `questions` (small head row) is edited.
MCP: `question_queue` / `question_claim` / `question_get` / `question_answer` / `assumption_check` +
`get_question_spec` (serves `memory/reference/question-research.md`). UI: PORT → TOOLS → QUESTIONS, badge counts from
`/api/v2/questions/counts`.

## Thesis tracking (2026-10-02)

`routers/tracking.py` tracks what WILL be known on a date — the kill conditions and watch numbers of a thesis — where
a question tracks what is not known. One metric keeps three things in three tables: `track_metrics` (what it is, the
kill line, and WHERE TO READ IT: source name / url / locator / tool, optional `series_id`), `track_expectations` (the
forecast for a period, its reason, and the release date) and `track_readings` (what came out, its evidence, the
verdict). It reuses rather than rebuilds: the release date is a `question_dates` row (`questions._insert_date` is
shared, so a forecast and its calendar event are one transaction and a moved date moves the metric); a reading that
is not in line or crosses the kill line calls `questions._create` in the same transaction, so the "why" lands in the
agent queue and closes by the question rules; evidence is a zettel or url + quote. The numbers decide the verdict
when the forecast is a band. Forecasts and readings are insert-only (a revision or correction is a new row, newest
stands), a forecast is refused once its period has a reading, and status (KILL / DUE / OFF / SETUP / WAITING) is
derived by `_derive` — same sync reasoning as the questions. Crossing a kill line never changes the thesis: it is
shown and logged (`KILLER_HIT`). MCP: `track_due` / `track_list` / `track_get` / `track_add` / `track_update` /
`track_expect` / `track_record` + `get_tracking_spec` (serves `memory/reference/thesis-tracking.md`). UI: PORT →
TOOLS → TRACK, badge from `/api/v2/tracking/counts`; QUESTIONS → calendar lists the metrics read on each date.
